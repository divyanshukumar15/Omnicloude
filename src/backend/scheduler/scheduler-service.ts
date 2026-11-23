/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { logger } from '../config/logger.ts';
import type { ProcessingJobEntity } from '../database/types.ts';
import type { RecoveredStaleJobRecord } from '../database/repositories/contracts.ts';
import { getJobService, type JobService } from '../jobs/index.ts';
import { getPipelineEngine, type PipelineEngine } from '../pipeline/index.ts';
import { getAuditService, type AuditService } from '../audit/index.ts';
import { classifyJobFailure, computeRetryBackoffMs } from './retry-policy.ts';
import type {
  AutomationMode,
  SchedulerConfig,
  SchedulerPollResult,
  SchedulerStatusSnapshot,
} from './types.ts';

const SchedulerEnvSchema = z.object({
  AUTOMATION_MODE: z.enum(['manual', 'scheduled', 'continuous']).default('manual'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(100).default(2),
  MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(2),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(21).optional(),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(3600000).default(1000),
  RETRY_MAX_BACKOFF_MS: z.coerce.number().int().min(10).max(86400000).default(300000),
  JOB_LEASE_MS: z.coerce.number().int().min(100).max(86400000).default(300000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(20).max(3600000).default(60000),
});

export function resolveSchedulerConfig(
  rawEnv: Record<string, unknown> = process.env,
  overrides: Partial<SchedulerConfig> = {}
): SchedulerConfig {
  const parsed = SchedulerEnvSchema.parse({
    AUTOMATION_MODE: rawEnv.AUTOMATION_MODE,
    POLL_INTERVAL_SECONDS: rawEnv.POLL_INTERVAL_SECONDS,
    MAX_CONCURRENT_JOBS: rawEnv.MAX_CONCURRENT_JOBS,
    MAX_RETRIES: rawEnv.MAX_RETRIES,
    MAX_ATTEMPTS: rawEnv.MAX_ATTEMPTS === '' ? undefined : rawEnv.MAX_ATTEMPTS,
    RETRY_BACKOFF_MS: rawEnv.RETRY_BACKOFF_MS,
    RETRY_MAX_BACKOFF_MS: rawEnv.RETRY_MAX_BACKOFF_MS,
    JOB_LEASE_MS: rawEnv.JOB_LEASE_MS,
    HEARTBEAT_INTERVAL_MS: rawEnv.HEARTBEAT_INTERVAL_MS,
  });

  const maxRetries = overrides.maxRetries ?? parsed.MAX_RETRIES;
  const maxAttempts =
    overrides.maxAttempts ?? parsed.MAX_ATTEMPTS ?? Math.max(1, maxRetries + 1);

  return {
    automationMode: overrides.automationMode ?? (parsed.AUTOMATION_MODE as AutomationMode),
    pollIntervalSeconds: overrides.pollIntervalSeconds ?? parsed.POLL_INTERVAL_SECONDS,
    maxConcurrentJobs: overrides.maxConcurrentJobs ?? parsed.MAX_CONCURRENT_JOBS,
    maxRetries,
    maxAttempts,
    retryBackoffMs: overrides.retryBackoffMs ?? parsed.RETRY_BACKOFF_MS,
    retryMaxBackoffMs: overrides.retryMaxBackoffMs ?? parsed.RETRY_MAX_BACKOFF_MS,
    leaseDurationMs: overrides.leaseDurationMs ?? parsed.JOB_LEASE_MS,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? parsed.HEARTBEAT_INTERVAL_MS,
    workerId:
      overrides.workerId ??
      `scheduler-${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  };
}

export interface SchedulerServiceDependencies {
  jobService?: JobService;
  pipelineEngine?: PipelineEngine;
  auditService?: AuditService;
  config?: Partial<SchedulerConfig>;
  rawEnv?: Record<string, unknown>;
  randomFn?: () => number;
}

export class SchedulerService {
  private readonly jobService: JobService;
  private readonly pipelineEngine: PipelineEngine;
  private readonly auditService: AuditService;
  private readonly config: SchedulerConfig;
  private readonly randomFn: () => number;

  private running = false;
  private stopping = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private continuousLoopPromise: Promise<void> | null = null;
  private pollInProgress = false;
  private readonly inFlightJobs = new Map<string, Promise<void>>();
  private totalClaimedCount = 0;
  private totalRetriedCount = 0;
  private totalRecoveredCount = 0;
  private lastPollAt: string | null = null;

  constructor(deps: SchedulerServiceDependencies = {}) {
    this.jobService = deps.jobService ?? getJobService();
    this.pipelineEngine = deps.pipelineEngine ?? getPipelineEngine();
    this.auditService = deps.auditService ?? getAuditService();
    this.config = resolveSchedulerConfig(deps.rawEnv ?? process.env, deps.config);
    this.randomFn = deps.randomFn ?? Math.random;
  }

  getConfig(): Readonly<SchedulerConfig> {
    return Object.freeze({ ...this.config });
  }

  getActiveCount(): number {
    return this.inFlightJobs.size;
  }

  getStatus(): SchedulerStatusSnapshot {
    return {
      running: this.running,
      stopping: this.stopping,
      automationMode: this.config.automationMode,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxRetries: this.config.maxRetries,
      maxAttempts: this.config.maxAttempts,
      retryBackoffMs: this.config.retryBackoffMs,
      leaseDurationMs: this.config.leaseDurationMs,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      workerId: this.config.workerId,
      activeJobIds: Array.from(this.inFlightJobs.keys()),
      activeCount: this.inFlightJobs.size,
      dbRunningCount: this.jobService.countRunningJobs(),
      totalClaimedCount: this.totalClaimedCount,
      totalRetriedCount: this.totalRetriedCount,
      totalRecoveredCount: this.totalRecoveredCount,
      lastPollAt: this.lastPollAt,
    };
  }

  /**
   * Starts the scheduler according to AUTOMATION_MODE:
   * - manual: remains idle until pollOnce() is explicitly invoked.
   * - scheduled: polls immediately and every POLL_INTERVAL_SECONDS.
   * - continuous: continuously polls and drains executable PENDING jobs within MAX_CONCURRENT_JOBS.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.stopping = false;
    this.running = true;

    logger.info('Starting scheduler core', {
      workerId: this.config.workerId,
      automationMode: this.config.automationMode,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxAttempts: this.config.maxAttempts,
      retryBackoffMs: this.config.retryBackoffMs,
      leaseDurationMs: this.config.leaseDurationMs,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
    });

    if (this.config.automationMode === 'manual') {
      return;
    }

    if (this.config.automationMode === 'scheduled') {
      void this.pollOnce();
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, this.config.pollIntervalSeconds * 1000);
      return;
    }

    if (this.config.automationMode === 'continuous') {
      this.continuousLoopPromise = this.runContinuousLoop();
    }
  }

  /**
   * Stops claiming new jobs and optionally awaits in-flight job promises.
   */
  async stop(waitForInFlight = true): Promise<void> {
    this.stopping = true;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (waitForInFlight) {
      if (this.continuousLoopPromise) {
        await this.continuousLoopPromise;
        this.continuousLoopPromise = null;
      }
      await this.waitForIdle();
    }

    logger.info('Scheduler core stopped', {
      workerId: this.config.workerId,
      remainingInFlight: this.inFlightJobs.size,
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlightJobs.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightJobs.values()));
    }
  }

  /**
   * Atomically recovers stale RUNNING jobs whose leases have expired.
   */
  recoverStaleJobs(nowIso?: string): RecoveredStaleJobRecord[] {
    const recovered = this.jobService.recoverStaleJobs({
      nowIso,
      maxAttempts: this.config.maxAttempts,
      retryBackoffMs: 0,
      actor: this.config.workerId,
    });
    if (recovered.length > 0) {
      this.totalRecoveredCount += recovered.length;
    }
    return recovered;
  }

  /**
   * Polls the database once:
   * 1. Recovers any stale RUNNING jobs whose lease has expired.
   * 2. Atomically claims eligible PENDING jobs up to MAX_CONCURRENT_JOBS.
   * 3. Dispatches each claimed job through PipelineEngine with lease heartbeats and retry handling.
   */
  async pollOnce(): Promise<SchedulerPollResult> {
    if (this.stopping || this.pollInProgress) {
      return {
        recoveredJobIds: [],
        claimedJobIds: [],
        activeCount: this.inFlightJobs.size,
      };
    }

    this.pollInProgress = true;
    this.lastPollAt = new Date().toISOString();
    const claimedJobIds: string[] = [];
    const recoveredJobIds: string[] = [];

    try {
      const recovered = this.recoverStaleJobs();
      for (const rec of recovered) {
        recoveredJobIds.push(rec.job.job_id);
      }

      while (!this.stopping && this.inFlightJobs.size < this.config.maxConcurrentJobs) {
        const claimed = this.jobService.claimNextPendingJob(this.config.workerId, {
          maxConcurrentJobs: this.config.maxConcurrentJobs,
          leaseDurationMs: this.config.leaseDurationMs,
        });

        if (!claimed) {
          break;
        }

        if (this.inFlightJobs.has(claimed.job_id)) {
          break;
        }

        this.totalClaimedCount += 1;
        claimedJobIds.push(claimed.job_id);

        const jobPromise = this.executeClaimedJob(claimed).finally(() => {
          this.inFlightJobs.delete(claimed.job_id);
        });
        this.inFlightJobs.set(claimed.job_id, jobPromise);
      }
    } finally {
      this.pollInProgress = false;
    }

    return {
      recoveredJobIds,
      claimedJobIds,
      activeCount: this.inFlightJobs.size,
    };
  }

  private async runContinuousLoop(): Promise<void> {
    const idleSleepMs = Math.min(this.config.pollIntervalSeconds * 1000, 1000);
    while (!this.stopping) {
      const result = await this.pollOnce();
      if (this.stopping) {
        break;
      }

      if (this.inFlightJobs.size >= this.config.maxConcurrentJobs) {
        await Promise.race(Array.from(this.inFlightJobs.values()));
      } else if (result.claimedJobIds.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, idleSleepMs));
      }
    }
  }

  private async executeClaimedJob(claimedJob: ProcessingJobEntity): Promise<void> {
    const correlationId = crypto.randomUUID();
    let currentJob = claimedJob;
    let currentInput = this.parseInitialInput(claimedJob);
    let leaseLost = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    if (this.config.heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (this.stopping || leaseLost) {
          stopHeartbeat();
          return;
        }
        const renewed = this.jobService.renewLease(
          claimedJob.job_id,
          this.config.workerId,
          this.config.leaseDurationMs,
          { correlationId }
        );
        if (!renewed) {
          leaseLost = true;
          stopHeartbeat();
        }
      }, this.config.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    logger.info('Executing claimed processing job via PipelineEngine', {
      jobId: claimedJob.job_id,
      workerId: this.config.workerId,
      stage: claimedJob.stage,
      attempt: claimedJob.attempts,
      scheduledBy:
        typeof currentInput.scheduledBy === 'string' ? currentInput.scheduledBy : 'MANUAL_OR_API',
      scheduledAutomatically: Boolean(
        currentInput.scheduledAutomatically ??
          currentInput.scheduledBy === 'SOURCE_DISCOVERY_SEEDER'
      ),
      requestedRunnerMode:
        typeof currentInput.runnerMode === 'string' ? currentInput.runnerMode : null,
      correlationId,
    });

    try {
      while (!this.stopping && !leaseLost) {
        const previousStage = currentJob.stage;
        const execution = await this.pipelineEngine.executeCurrentStage(
          currentJob.job_id,
          correlationId,
          currentInput,
          { deferParentReconciliationOnFailure: true }
        );

        currentJob = execution.job;

        if (!execution.result.success) {
          if (!leaseLost && !this.stopping) {
            this.handleFailedExecution(
              currentJob,
              execution.result.errorCode,
              execution.result.errorMessage,
              correlationId
            );
          }
          break;
        }

        if (currentJob.status !== 'RUNNING') {
          break;
        }

        // Guard against non-advancing handler implementations
        if (currentJob.stage === previousStage) {
          break;
        }

        currentInput = this.mergeStageOutput(currentInput, execution.result.output);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Unhandled exception during scheduled job execution', err, {
        jobId: currentJob.job_id,
        stage: currentJob.stage,
        workerId: this.config.workerId,
        correlationId,
      });

      if (!leaseLost && !this.stopping) {
        const latest = this.jobService.getJob(currentJob.job_id);
        if (latest && latest.status === 'RUNNING') {
          const failed = this.jobService.failJob(
            currentJob.job_id,
            'SCHEDULER_EXECUTION_ERROR',
            errorMessage,
            correlationId,
            { deferParentReconciliation: true }
          );
          this.handleFailedExecution(
            failed,
            'SCHEDULER_EXECUTION_ERROR',
            errorMessage,
            correlationId
          );
        }
      }
    } finally {
      stopHeartbeat();
    }
  }

  private handleFailedExecution(
    failedJob: ProcessingJobEntity,
    errorCode: string | undefined,
    errorMessage: string | undefined,
    correlationId: string
  ): void {
    const classification = classifyJobFailure(errorCode, errorMessage);
    const effectiveMaxAttempts = Math.min(failedJob.max_attempts, this.config.maxAttempts);

    if (classification === 'TRANSIENT' && failedJob.attempts < effectiveMaxAttempts) {
      const backoffMs = computeRetryBackoffMs(
        failedJob.attempts,
        this.config.retryBackoffMs,
        this.config.retryMaxBackoffMs,
        this.randomFn
      );
      const retried = this.jobService.scheduleRetry(failedJob.job_id, this.config.workerId, {
        errorCode: errorCode || 'TRANSIENT_FAILURE',
        errorMessage: errorMessage || 'Transient failure scheduled for retry',
        backoffMs,
        maxAttempts: effectiveMaxAttempts,
        correlationId,
      });
      if (retried) {
        this.totalRetriedCount += 1;
        logger.info('Scheduled transient failure for retry', {
          jobId: failedJob.job_id,
          attempt: failedJob.attempts,
          maxAttempts: effectiveMaxAttempts,
          backoffMs,
          nextRetryAt: retried.next_retry_at,
        });
        return;
      }
    }

    const reason =
      classification === 'PERMANENT' ? 'PERMANENT_FAILURE_NO_RETRY' : 'MAX_ATTEMPTS_EXHAUSTED';

    this.auditService.record({
      correlationId,
      actor: this.config.workerId,
      action: 'JOB_RETRY_SKIPPED',
      entityType: 'PROCESSING_JOB',
      entityId: failedJob.job_id,
      stage: failedJob.stage,
      status: 'FAILURE',
      details: {
        reason,
        classification,
        attempt: failedJob.attempts,
        maxAttempts: effectiveMaxAttempts,
        errorCode: errorCode ?? null,
      },
    });

    // Child failure is now terminal (permanent or retries exhausted) -> reconcile waiting parent(s)
    this.jobService.reconcileWaitingParents(failedJob.job_id, correlationId);
  }

  private parseInitialInput(job: ProcessingJobEntity): Record<string, unknown> {
    if (!job.metadata_json) {
      return {};
    }
    try {
      const parsed = JSON.parse(job.metadata_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore invalid metadata JSON and fall back to empty stage input
    }
    return {};
  }

  private mergeStageOutput(
    baseInput: Record<string, unknown>,
    output: unknown
  ): Record<string, unknown> {
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return { ...baseInput, ...(output as Record<string, unknown>) };
    }
    return baseInput;
  }
}
