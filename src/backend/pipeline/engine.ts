/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JobService } from '../jobs/job-service.ts';
import type { AuditService } from '../audit/audit-service.ts';
import type { StructuredLogger } from '../config/logger.ts';
import type { PipelineStageName, ProcessingJobEntity } from '../database/types.ts';
import type { IPipelineStageHandler, PipelineContext, StageExecutionResult } from './contracts.ts';
import { ORDERED_PIPELINE_STAGES, getNextStage } from './stages.ts';

export class PipelineEngine {
  private handlers = new Map<PipelineStageName, IPipelineStageHandler>();
  private jobService: JobService;
  private auditService: AuditService;
  private logger: StructuredLogger;

  constructor(
    jobService: JobService,
    auditService: AuditService,
    logger: StructuredLogger
  ) {
    this.jobService = jobService;
    this.auditService = auditService;
    this.logger = logger;
  }

  /**
   * Registers a concrete stage handler into the pipeline engine.
   */
  registerStageHandler(handler: IPipelineStageHandler): void {
    this.handlers.set(handler.stageName, handler);
  }

  /**
   * Returns a registered stage handler by stage name.
   */
  getHandler(stage: PipelineStageName): IPipelineStageHandler | undefined {
    return this.handlers.get(stage);
  }

  /**
   * Returns list of configured stage names.
   */
  getRegisteredStages(): PipelineStageName[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Executes the next pending stage for a given job.
   * If a stage has no implementation, it halts safely without fabricating fake completion.
   */
  async executeCurrentStage(
    jobId: string,
    correlationId: string,
    stageInput: unknown = {},
    options?: { deferParentReconciliationOnFailure?: boolean }
  ): Promise<{ job: ProcessingJobEntity; result: StageExecutionResult }> {
    const job = this.jobService.getJob(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    if (job.status === 'COMPLETED') {
      throw new Error(`Job ${jobId} is already marked COMPLETED`);
    }

    if (job.status === 'FAILED' && job.attempts >= job.max_attempts) {
      throw new Error(`Job ${jobId} has exceeded maximum allowed attempts (${job.max_attempts})`);
    }

    // Mark job as RUNNING if it was PENDING or retrying
    const activeJob = job.status === 'RUNNING'
      ? job
      : this.jobService.startJob(jobId, correlationId);

    const currentStage = activeJob.stage;
    const stageHandler = this.handlers.get(currentStage);

    const context: PipelineContext = {
      jobId,
      correlationId,
      targetEntityType: activeJob.target_entity_type,
      targetEntityId: activeJob.target_entity_id,
      metadata: activeJob.metadata_json ? JSON.parse(activeJob.metadata_json) : {},
      logger: this.logger.withContext({ jobId, stage: currentStage, correlationId }),
      auditService: this.auditService,
    };

    // If stage handler is not registered yet (Phase 1 boundary)
    if (!stageHandler) {
      const errorCode = 'STAGE_NOT_IMPLEMENTED';
      const errorMessage = `Stage "${currentStage}" is not implemented in Phase 1 foundation. Execution halted safely without fake completion.`;

      this.jobService.failJob(jobId, errorCode, errorMessage, correlationId, {
        deferParentReconciliation: options?.deferParentReconciliationOnFailure,
      });

      return {
        job: this.jobService.getJob(jobId)!,
        result: {
          success: false,
          errorCode,
          errorMessage,
        },
      };
    }

    try {
      this.auditService.record({
        correlationId,
        actor: 'PIPELINE_ENGINE',
        action: 'STAGE_STARTED',
        entityType: 'PROCESSING_JOB',
        entityId: jobId,
        stage: currentStage,
        status: 'INFO',
      });

      const result = await stageHandler.execute(stageInput, context);

      if (result.persistMetadata && Object.keys(result.persistMetadata).length > 0) {
        this.jobService.updateJobMetadata(jobId, result.persistMetadata);
      }

      if (!result.success) {
        const errorCode = result.errorCode || 'STAGE_EXECUTION_FAILED';
        const errorMessage = result.errorMessage || `Execution failed at stage ${currentStage}`;
        this.jobService.failJob(jobId, errorCode, errorMessage, correlationId, {
          deferParentReconciliation: options?.deferParentReconciliationOnFailure,
        });

        return {
          job: this.jobService.getJob(jobId)!,
          result,
        };
      }

      if (result.terminateAsNoOp) {
        const terminalReason = result.terminalReason || 'TERMINATED_NOOP';
        this.jobService.updateJobMetadata(jobId, {
          terminalOutcome: terminalReason,
          terminatedAtStage: currentStage,
          noOp: true,
        });

        this.auditService.record({
          correlationId,
          actor: 'PIPELINE_ENGINE',
          action: 'STAGE_TERMINATED_NOOP',
          entityType: 'PROCESSING_JOB',
          entityId: jobId,
          stage: currentStage,
          status: 'INFO',
          details: {
            terminalReason,
            ...(result.auditDetails || {}),
          },
        });

        const completedNoOpJob = this.jobService.completeJob(jobId, correlationId);
        return { job: completedNoOpJob, result };
      }

      // Handle deterministic multi-entity fan-out (e.g. SOURCE_DISCOVERY -> notices, DOCUMENT_DISCOVERY -> documents)
      if (result.fanOutJobs && result.fanOutJobs.length > 0) {
        const childJobIds: string[] = [];
        const createdChildJobIds: string[] = [];
        const dedupedChildJobIds: string[] = [];

        for (const descriptor of result.fanOutJobs) {
          const { job: childJob, created } = this.jobService.createJobWithStatus({
            parentJobId: jobId,
            dedupeKey: descriptor.dedupeKey,
            targetEntityType: descriptor.targetEntityType,
            targetEntityId: descriptor.targetEntityId,
            initialStage: descriptor.initialStage,
            maxAttempts: descriptor.maxAttempts ?? activeJob.max_attempts,
            metadata: descriptor.metadata,
            correlationId,
            actor: 'PIPELINE_FANOUT',
          });

          childJobIds.push(childJob.job_id);
          if (created) {
            createdChildJobIds.push(childJob.job_id);
          } else {
            dedupedChildJobIds.push(childJob.job_id);
          }
        }

        if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
          const outputObj = result.output as Record<string, unknown>;
          outputObj.childJobIds = childJobIds;
          outputObj.createdChildJobIds = createdChildJobIds;
          outputObj.dedupedChildJobIds = dedupedChildJobIds;
          if (
            outputObj.discoveryMetadata &&
            typeof outputObj.discoveryMetadata === 'object' &&
            !Array.isArray(outputObj.discoveryMetadata)
          ) {
            const discMeta = outputObj.discoveryMetadata as Record<string, unknown>;
            discMeta.childJobIds = childJobIds;
            discMeta.createdChildJobIds = createdChildJobIds;
            discMeta.dedupedChildJobIds = dedupedChildJobIds;
          }
        }

        this.auditService.record({
          correlationId,
          actor: 'PIPELINE_ENGINE',
          action: 'STAGE_FANOUT_COMPLETED',
          entityType: 'PROCESSING_JOB',
          entityId: jobId,
          stage: currentStage,
          status: 'SUCCESS',
          details: {
            totalChildren: childJobIds.length,
            createdCount: createdChildJobIds.length,
            dedupedCount: dedupedChildJobIds.length,
            childJobIds,
            createdChildJobIds,
            dedupedChildJobIds,
          },
        });

        // Do NOT mark a discovery parent COMPLETED merely because discovery succeeded;
        // park in PAUSED (AWAITING_CHILDREN) and reconcile only once every child completes WORDPRESS_PUBLISH.
        if (result.awaitChildren) {
          const childInitialStage = result.fanOutJobs[0].initialStage;
          const updatedParent = this.jobService.awaitChildJobs(
            jobId,
            {
              childJobIds,
              createdChildJobIds,
              dedupedChildJobIds,
              fanOutStage: currentStage,
              childInitialStage,
            },
            correlationId
          );
          return { job: updatedParent, result };
        }
      }

      // If stage succeeded, advance to next stage or complete job ONLY when final stage (WORDPRESS_PUBLISH) passed
      const nextStage = getNextStage(currentStage);
      if (nextStage) {
        const updatedJob = this.jobService.advanceStage(jobId, nextStage, correlationId);
        return { job: updatedJob, result };
      } else {
        // Final stage (WORDPRESS_PUBLISH) reached and passed!
        const completedJob = this.jobService.completeJob(jobId, correlationId);
        return { job: completedJob, result };
      }
    } catch (err) {
      const errorCode = 'UNEXPECTED_STAGE_EXCEPTION';
      const errorMessage = (err as Error).message || String(err);
      this.jobService.failJob(jobId, errorCode, errorMessage, correlationId, {
        deferParentReconciliation: options?.deferParentReconciliationOnFailure,
      });

      return {
        job: this.jobService.getJob(jobId)!,
        result: {
          success: false,
          errorCode,
          errorMessage,
        },
      };
    }
  }

  /**
   * Helper to inspect the ordered pipeline definition and verify boundaries.
   */
  getPipelineDefinition() {
    return ORDERED_PIPELINE_STAGES.map((stage, index) => ({
      order: index + 1,
      stage,
      hasHandler: this.handlers.has(stage),
      status: this.handlers.has(stage) ? 'REGISTERED' : 'CONTRACT_DEFINED_ONLY',
    }));
  }
}
