/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type {
  IProcessingJobRepository,
  JobClaimOptions,
  RecoverStaleJobsOptions,
  RecoveredStaleJobRecord,
} from '../database/repositories/contracts.ts';
import type {
  ProcessingJobEntity,
  PipelineStageName,
  ProcessingJobStatus,
} from '../database/types.ts';
import type { AuditService } from '../audit/audit-service.ts';
import { logger } from '../config/logger.ts';

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export function normalizeOfficialIdentityUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Deterministic idempotency key for a notice DOCUMENT_DISCOVERY child job.
 * Stable across retries and repeated scheduler discovery runs.
 */
export function buildNoticeDedupeKey(sourceId: string, noticeUrl: string): string {
  const canonicalInput = `${sourceId.trim().toUpperCase()}::${normalizeOfficialIdentityUrl(noticeUrl)}`;
  const digest = crypto.createHash('sha256').update(canonicalInput).digest('hex');
  return `notice:${digest}`;
}

/**
 * Deterministic idempotency key for an official document DOCUMENT_DOWNLOAD child job.
 * Based on stable official identity: sourceId + canonicalDocumentUrl.
 */
export function buildDocumentDedupeKey(sourceId: string, canonicalDocumentUrl: string): string {
  const canonicalInput = `${sourceId.trim().toUpperCase()}::${normalizeOfficialIdentityUrl(canonicalDocumentUrl)}`;
  const digest = crypto.createHash('sha256').update(canonicalInput).digest('hex');
  return `doc:${digest}`;
}

/**
 * Deterministic idempotency key for a scheduled SOURCE_DISCOVERY job.
 * Uses source identity + authoritative check_interval_minutes + time-window bucket
 * so concurrent seeders in the same cycle deduplicate atomically while future cycles remain eligible.
 */
export function buildSourceDiscoveryDedupeKey(
  sourceId: string,
  checkIntervalMinutes: number,
  nowMs: number = Date.now()
): string {
  const safeIntervalMinutes = Math.max(1, Math.floor(checkIntervalMinutes || 60));
  const intervalMs = safeIntervalMinutes * 60_000;
  const windowBucket = Math.floor(nowMs / intervalMs);
  const normalizedSourceId = sourceId.trim().toUpperCase();
  const canonicalInput = `${normalizedSourceId}::interval=${safeIntervalMinutes}m::window=${windowBucket}`;
  const digest = crypto.createHash('sha256').update(canonicalInput).digest('hex').slice(0, 24);
  return `source-discovery:${normalizedSourceId}:w${windowBucket}:${digest}`;
}

function sanitizeMetadataPatch(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMetadataPatch(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'buffer' || k === 'binaryContent' || typeof v === 'function') {
        continue;
      }
      const nextVal = sanitizeMetadataPatch(v);
      if (nextVal !== undefined) {
        sanitized[k] = nextVal;
      }
    }
    return sanitized;
  }
  if (typeof value === 'function') {
    return undefined;
  }
  return value;
}

export interface CreateProcessingJobParams {
  jobId?: string;
  parentJobId?: string | null;
  dedupeKey?: string | null;
  targetEntityType: string;
  targetEntityId: string;
  initialStage?: PipelineStageName;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  actor?: string;
}

export interface CreateProcessingJobResult {
  job: ProcessingJobEntity;
  created: boolean;
}

export class JobService {
  private jobRepo: IProcessingJobRepository;
  private auditService: AuditService;

  constructor(jobRepo: IProcessingJobRepository, auditService: AuditService) {
    this.jobRepo = jobRepo;
    this.auditService = auditService;
  }

  /**
   * Atomically creates a processing job or returns the existing job matching dedupeKey.
   * Returns `{ job, created }` so callers can distinguish new vs deduped child jobs.
   */
  createJobWithStatus(params: CreateProcessingJobParams): CreateProcessingJobResult {
    const jobId = params.jobId || crypto.randomUUID();
    const correlationId = params.correlationId || crypto.randomUUID();
    const stage = params.initialStage || 'SOURCE_DISCOVERY';
    const actor = params.actor || 'SYSTEM_API';
    const dedupeKey = params.dedupeKey?.trim() || null;
    const sanitizedMetadata = params.metadata
      ? (sanitizeMetadataPatch(params.metadata) as Record<string, unknown>)
      : undefined;

    const { job: entity, created } = this.jobRepo.createIdempotent({
      job_id: jobId,
      parent_job_id: params.parentJobId ?? null,
      dedupe_key: dedupeKey,
      target_entity_type: params.targetEntityType,
      target_entity_id: params.targetEntityId,
      stage,
      status: 'PENDING',
      max_attempts: params.maxAttempts ?? 3,
      metadata_json: sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
    });

    if (created) {
      this.auditService.record({
        correlationId,
        actor,
        action: 'JOB_CREATED',
        entityType: 'PROCESSING_JOB',
        entityId: entity.job_id,
        stage,
        status: 'SUCCESS',
        details: {
          targetEntityType: params.targetEntityType,
          targetEntityId: params.targetEntityId,
          parentJobId: params.parentJobId ?? null,
          dedupeKey,
          stage,
        },
      });

      logger.info('Created new processing job', {
        jobId: entity.job_id,
        parentJobId: entity.parent_job_id ?? undefined,
        stage,
        targetEntity: params.targetEntityId,
      });
    } else {
      this.auditService.record({
        correlationId,
        actor,
        action: 'JOB_DEDUPED',
        entityType: 'PROCESSING_JOB',
        entityId: entity.job_id,
        stage: entity.stage,
        status: 'INFO',
        details: {
          existingJobId: entity.job_id,
          existingStatus: entity.status,
          existingStage: entity.stage,
          requestedParentJobId: params.parentJobId ?? null,
          dedupeKey,
        },
      });

      logger.info('Resolved existing processing job via deterministic dedupe key', {
        existingJobId: entity.job_id,
        dedupeKey,
        stage: entity.stage,
        status: entity.status,
      });
    }

    return { job: entity, created };
  }

  /**
   * Creates and persists a new processing job with PENDING status and audit record
   * (or atomically resolves an existing job when dedupeKey matches).
   */
  createJob(params: CreateProcessingJobParams): ProcessingJobEntity {
    return this.createJobWithStatus(params).job;
  }

  /**
   * Persists durable non-binary stage metadata onto processing_jobs.metadata_json
   * so recovered/retried jobs can reconstruct stage input after restarts.
   */
  updateJobMetadata(jobId: string, patch: Record<string, unknown>): ProcessingJobEntity {
    const existing = this.jobRepo.findById(jobId);
    if (!existing) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    let currentMeta: Record<string, unknown> = {};
    if (existing.metadata_json) {
      try {
        const parsed = JSON.parse(existing.metadata_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          currentMeta = parsed as Record<string, unknown>;
        }
      } catch {
        currentMeta = {};
      }
    }

    const sanitizedPatch = sanitizeMetadataPatch(patch) as Record<string, unknown>;
    const merged = { ...currentMeta, ...sanitizedPatch };
    return this.jobRepo.updateMetadata(jobId, JSON.stringify(merged));
  }

  /**
   * Parks a parent discovery job in PAUSED (AWAITING_CHILDREN) state rather than falsely
   * marking it COMPLETED immediately after discovery fan-out.
   * Only reconciles to COMPLETED if all referenced child jobs have genuinely reached COMPLETED.
   */
  awaitChildJobs(
    jobId: string,
    params: {
      childJobIds: string[];
      createdChildJobIds: string[];
      dedupedChildJobIds: string[];
      fanOutStage: PipelineStageName;
      childInitialStage: PipelineStageName;
    },
    correlationId?: string
  ): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    const corrId = correlationId || crypto.randomUUID();
    const fanOutMeta = {
      fanOut: {
        state: 'AWAITING_CHILDREN',
        fanOutStage: params.fanOutStage,
        childInitialStage: params.childInitialStage,
        childJobIds: params.childJobIds,
        createdChildJobIds: params.createdChildJobIds,
        dedupedChildJobIds: params.dedupedChildJobIds,
        updatedAt: new Date().toISOString(),
      },
    };

    this.updateJobMetadata(jobId, fanOutMeta);

    const paused = this.jobRepo.updateStatus(jobId, {
      status: 'PAUSED',
      error_code: null,
      error_message: null,
      clearLease: true,
    });

    this.auditService.record({
      correlationId: corrId,
      actor: 'PIPELINE_ENGINE',
      action: 'JOB_AWAITING_CHILDREN',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: paused.stage,
      status: 'INFO',
      details: {
        fanOutStage: params.fanOutStage,
        childInitialStage: params.childInitialStage,
        totalChildren: params.childJobIds.length,
        createdChildren: params.createdChildJobIds.length,
        dedupedChildren: params.dedupedChildJobIds.length,
        childJobIds: params.childJobIds,
      },
    });

    return this.reconcileParentCompletion(jobId, corrId) ?? paused;
  }

  /**
   * Reconciles a parent job with fan-out children cleanly into COMPLETED, PARTIAL_FAILED,
   * FAILED, CANCELLED, or back to PAUSED (AWAITING_CHILDREN) if a failed child is retried.
   *
   * Rules:
   * - If ANY child is still active (PENDING, RUNNING, PAUSED), parent remains PAUSED waiting
   *   (and if parent was previously FAILED/PARTIAL_FAILED/CANCELLED before a child retry, it
   *   recovers back to PAUSED).
   * - When ALL children are terminal:
   *   - All COMPLETED -> parent COMPLETED
   *   - All CANCELLED -> parent CANCELLED
   *   - Mix of COMPLETED and FAILED/PARTIAL_FAILED/CANCELLED -> parent PARTIAL_FAILED
   *   - Zero COMPLETED and >= 1 FAILED/PARTIAL_FAILED -> parent FAILED
   * - Prevents duplicate reconciliation when parent is already in the exact target state.
   */
  reconcileParentCompletion(
    parentJobId: string,
    correlationId?: string,
    visited: Set<string> = new Set()
  ): ProcessingJobEntity | null {
    if (visited.has(parentJobId)) {
      return null;
    }
    visited.add(parentJobId);

    const parent = this.jobRepo.findById(parentJobId);
    if (!parent) {
      return null;
    }

    let parsedMeta: Record<string, unknown> = {};
    let fanOutMeta: Record<string, unknown> | null = null;
    let referencedChildIds: string[] = [];

    if (parent.metadata_json) {
      try {
        const parsed = JSON.parse(parent.metadata_json) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedMeta = parsed;
          if (parsed.fanOut && typeof parsed.fanOut === 'object' && !Array.isArray(parsed.fanOut)) {
            fanOutMeta = parsed.fanOut as Record<string, unknown>;
            if (Array.isArray(fanOutMeta.childJobIds)) {
              referencedChildIds = fanOutMeta.childJobIds.filter(
                (id): id is string => typeof id === 'string' && id.length > 0
              );
            }
          }
        }
      } catch {
        return parent;
      }
    }

    if (!fanOutMeta) {
      return parent;
    }

    const directChildren = this.jobRepo.listByParentJobId(parentJobId);
    const allChildIds = Array.from(
      new Set([...referencedChildIds, ...directChildren.map((c) => c.job_id)])
    );

    if (allChildIds.length === 0) {
      return parent;
    }

    const childJobs = allChildIds
      .map((id) => this.jobRepo.findById(id))
      .filter((c): c is ProcessingJobEntity => c !== null);

    if (childJobs.length !== allChildIds.length) {
      return parent;
    }

    const activeChildren = childJobs.filter(
      (c) => c.status === 'PENDING' || c.status === 'RUNNING' || c.status === 'PAUSED'
    );
    const completedChildren = childJobs.filter((c) => c.status === 'COMPLETED');
    const failedChildren = childJobs.filter(
      (c) => c.status === 'FAILED' || c.status === 'PARTIAL_FAILED'
    );
    const cancelledChildren = childJobs.filter((c) => c.status === 'CANCELLED');

    const corrId = correlationId || crypto.randomUUID();
    const now = new Date().toISOString();

    // If any child is still active (including scheduled retries in PENDING or nested PAUSED parents),
    // parent MUST stay PAUSED (or recover back to PAUSED if previously failed and a child was retried).
    if (activeChildren.length > 0) {
      if (parent.status === 'PAUSED' && fanOutMeta.state === 'AWAITING_CHILDREN') {
        return parent;
      }

      if (
        parent.status === 'FAILED' ||
        parent.status === 'PARTIAL_FAILED' ||
        parent.status === 'CANCELLED'
      ) {
        this.updateJobMetadata(parentJobId, {
          fanOut: {
            ...fanOutMeta,
            state: 'AWAITING_CHILDREN',
            childJobIds: allChildIds,
            activeChildIds: activeChildren.map((c) => c.job_id),
            completedChildIds: completedChildren.map((c) => c.job_id),
            failedChildIds: failedChildren.map((c) => c.job_id),
            cancelledChildIds: cancelledChildren.map((c) => c.job_id),
            recoveredForRetryAt: now,
            updatedAt: now,
          },
        });

        const recoveredParent = this.jobRepo.updateStatus(parentJobId, {
          status: 'PAUSED',
          error_code: null,
          error_message: null,
          completed_at: null,
          clearLease: true,
        });

        this.auditService.record({
          correlationId: corrId,
          actor: 'PIPELINE_ENGINE',
          action: 'PARENT_JOB_RECOVERED_AWAITING_RETRY',
          entityType: 'PROCESSING_JOB',
          entityId: parentJobId,
          stage: recoveredParent.stage,
          status: 'INFO',
          details: {
            previousStatus: parent.status,
            activeChildIds: activeChildren.map((c) => c.job_id),
            completedChildIds: completedChildren.map((c) => c.job_id),
            failedChildIds: failedChildren.map((c) => c.job_id),
          },
        });

        this.reconcileWaitingParents(parentJobId, corrId, visited);
        return recoveredParent;
      }

      return parent;
    }

    // All children are terminal. Determine authoritative parent terminal status.
    let targetStatus: ProcessingJobStatus;
    let fanOutState: string;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let auditAction: string;
    let auditStatus: 'SUCCESS' | 'FAILURE' | 'INFO';

    const failedDetails = failedChildren.map((c) => ({
      jobId: c.job_id,
      status: c.status,
      stage: c.stage,
      errorCode: c.error_code ?? 'CHILD_FAILED',
      errorMessage: c.error_message ?? 'Child job failed',
    }));
    const cancelledDetails = cancelledChildren.map((c) => ({
      jobId: c.job_id,
      status: c.status,
      stage: c.stage,
      errorCode: c.error_code ?? 'CANCELLED_BY_USER',
      errorMessage: c.error_message ?? 'Child job cancelled',
    }));

    if (completedChildren.length === childJobs.length) {
      targetStatus = 'COMPLETED';
      fanOutState = 'ALL_CHILDREN_COMPLETED';
      auditAction = 'PARENT_JOB_COMPLETED_AFTER_CHILDREN';
      auditStatus = 'SUCCESS';
    } else if (cancelledChildren.length === childJobs.length) {
      targetStatus = 'CANCELLED';
      fanOutState = 'ALL_CHILDREN_CANCELLED';
      errorCode = 'ALL_CHILDREN_CANCELLED';
      errorMessage = `All ${cancelledChildren.length} child job(s) were cancelled`;
      auditAction = 'PARENT_JOB_CANCELLED_AFTER_CHILDREN';
      auditStatus = 'INFO';
    } else if (completedChildren.length > 0 && (failedChildren.length > 0 || cancelledChildren.length > 0)) {
      targetStatus = 'PARTIAL_FAILED';
      fanOutState = 'CHILDREN_PARTIAL_FAILED';
      errorCode = 'CHILD_JOBS_PARTIAL_FAILED';
      errorMessage = `${completedChildren.length}/${childJobs.length} child job(s) completed, ${failedChildren.length} failed, ${cancelledChildren.length} cancelled`;
      auditAction = 'PARENT_JOB_PARTIAL_FAILED_AFTER_CHILDREN';
      auditStatus = 'FAILURE';
    } else {
      targetStatus = 'FAILED';
      fanOutState = 'ALL_CHILDREN_FAILED';
      errorCode = 'CHILD_JOBS_FAILED';
      errorMessage = `${failedChildren.length}/${childJobs.length} child job(s) failed (${failedDetails.map((d) => `${d.jobId}:${d.errorCode}`).join(', ')})`;
      auditAction = 'PARENT_JOB_FAILED_AFTER_CHILDREN';
      auditStatus = 'FAILURE';
    }

    // Prevent duplicate reconciliation if parent is already in the exact reconciled state
    const existingFingerprint =
      typeof fanOutMeta.reconciliationFingerprint === 'string'
        ? fanOutMeta.reconciliationFingerprint
        : null;
    const nextFingerprint = `${targetStatus}:${completedChildren.map((c) => c.job_id).sort().join(',')}|${failedChildren.map((c) => `${c.job_id}:${c.status}`).sort().join(',')}|${cancelledChildren.map((c) => c.job_id).sort().join(',')}`;

    if (parent.status === targetStatus && existingFingerprint === nextFingerprint) {
      return parent;
    }

    this.updateJobMetadata(parentJobId, {
      ...parsedMeta,
      fanOut: {
        ...fanOutMeta,
        state: fanOutState,
        childJobIds: allChildIds,
        completedChildIds: completedChildren.map((c) => c.job_id),
        failedChildIds: failedChildren.map((c) => c.job_id),
        cancelledChildIds: cancelledChildren.map((c) => c.job_id),
        failedChildren: failedDetails,
        cancelledChildren: cancelledDetails,
        reconciliationFingerprint: nextFingerprint,
        reconciledAt: now,
        completedAt: targetStatus === 'COMPLETED' ? now : undefined,
        updatedAt: now,
      },
    });

    const reconciledParent = this.jobRepo.updateStatus(parentJobId, {
      status: targetStatus,
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: now,
      clearLease: true,
    });

    this.auditService.record({
      correlationId: corrId,
      actor: 'PIPELINE_ENGINE',
      action: auditAction,
      entityType: 'PROCESSING_JOB',
      entityId: parentJobId,
      stage: reconciledParent.stage,
      status: auditStatus,
      details: {
        previousStatus: parent.status,
        reconciledStatus: targetStatus,
        totalChildren: allChildIds.length,
        completedCount: completedChildren.length,
        failedCount: failedChildren.length,
        cancelledCount: cancelledChildren.length,
        childJobIds: allChildIds,
        failedChildIds: failedChildren.map((c) => c.job_id),
        cancelledChildIds: cancelledChildren.map((c) => c.job_id),
        failedChildren: failedDetails,
      },
    });

    this.reconcileWaitingParents(parentJobId, corrId, visited);
    return reconciledParent;
  }

  /**
   * Finds any reconcilable parent jobs referencing `childJobId` (in PAUSED, FAILED,
   * PARTIAL_FAILED, or CANCELLED state) and reconciles them cleanly.
   */
  reconcileWaitingParents(
    childJobId: string,
    correlationId?: string,
    visited: Set<string> = new Set()
  ): void {
    const child = this.jobRepo.findById(childJobId);
    const candidateParentIds = new Set<string>();

    if (child?.parent_job_id) {
      candidateParentIds.add(child.parent_job_id);
    }

    const reconcilableParents = this.jobRepo.listReconcilableParents();
    for (const parent of reconcilableParents) {
      if (!parent.metadata_json) continue;
      try {
        const parsed = JSON.parse(parent.metadata_json) as {
          fanOut?: { childJobIds?: unknown };
        };
        if (
          Array.isArray(parsed?.fanOut?.childJobIds) &&
          parsed.fanOut.childJobIds.includes(childJobId)
        ) {
          candidateParentIds.add(parent.job_id);
        }
      } catch {
        // Ignore malformed metadata
      }
    }

    for (const parentId of candidateParentIds) {
      this.reconcileParentCompletion(parentId, correlationId, visited);
    }
  }

  /**
   * Transitions a PENDING or retried job into RUNNING state.
   */
  startJob(jobId: string, correlationId?: string): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    if (job.status !== 'PENDING' && job.status !== 'PAUSED') {
      throw new InvalidStateTransitionError(
        `Cannot start job ${jobId} in status "${job.status}". Must be PENDING or PAUSED.`
      );
    }

    const now = new Date().toISOString();
    const updated = this.jobRepo.updateStatus(jobId, {
      status: 'RUNNING',
      attemptsIncrement: true,
      started_at: now,
      error_code: null,
      error_message: null,
    });

    this.auditService.record({
      correlationId: correlationId || crypto.randomUUID(),
      actor: 'PIPELINE_RUNNER',
      action: 'JOB_STARTED',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: updated.stage,
      status: 'SUCCESS',
      details: { attempt: updated.attempts },
    });

    return updated;
  }

  /**
   * Advances the stage of an active job.
   */
  advanceStage(
    jobId: string,
    nextStage: PipelineStageName,
    correlationId?: string
  ): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    if (job.status !== 'RUNNING') {
      throw new InvalidStateTransitionError(
        `Cannot advance stage for job ${jobId} in status "${job.status}". Must be RUNNING.`
      );
    }

    const previousStage = job.stage;
    const updated = this.jobRepo.updateStatus(jobId, {
      status: 'RUNNING',
      stage: nextStage,
    });

    this.auditService.record({
      correlationId: correlationId || crypto.randomUUID(),
      actor: 'PIPELINE_ENGINE',
      action: 'STAGE_TRANSITION',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: nextStage,
      status: 'SUCCESS',
      details: { fromStage: previousStage, toStage: nextStage },
    });

    return updated;
  }

  /**
   * Marks a job as FAILED with deterministic error codes.
   * Reconciles waiting parent jobs immediately unless `deferParentReconciliation` is true
   * (used by SchedulerService when a transient failure is about to be rescheduled for retry).
   */
  failJob(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    correlationId?: string,
    options?: { deferParentReconciliation?: boolean }
  ): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    const now = new Date().toISOString();
    const corrId = correlationId || crypto.randomUUID();
    const updated = this.jobRepo.updateStatus(jobId, {
      status: 'FAILED',
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: now,
    });

    this.auditService.record({
      correlationId: corrId,
      actor: 'PIPELINE_ENGINE',
      action: 'JOB_FAILED',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: job.stage,
      status: 'FAILURE',
      details: { errorCode, errorMessage },
    });

    logger.error(`Job ${jobId} failed at stage ${job.stage}`, undefined, {
      jobId,
      stage: job.stage,
      errorCode,
      errorMessage,
    });

    if (!options?.deferParentReconciliation) {
      this.reconcileWaitingParents(jobId, corrId);
    }

    return updated;
  }

  /**
   * Marks a job as COMPLETED upon verified pipeline completion.
   */
  completeJob(jobId: string, correlationId?: string): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    if (job.status !== 'RUNNING') {
      throw new InvalidStateTransitionError(
        `Cannot complete job ${jobId} in status "${job.status}". Must be RUNNING.`
      );
    }

    const now = new Date().toISOString();
    const corrId = correlationId || crypto.randomUUID();
    const updated = this.jobRepo.updateStatus(jobId, {
      status: 'COMPLETED',
      completed_at: now,
      clearLease: true,
    });

    this.auditService.record({
      correlationId: corrId,
      actor: 'PIPELINE_ENGINE',
      action: 'JOB_COMPLETED',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: job.stage,
      status: 'SUCCESS',
    });

    // Reconcile any parent discovery jobs waiting on this completed job
    this.reconcileWaitingParents(jobId, corrId);

    return updated;
  }

  /**
   * Cancels a job and reconciles any parent job waiting on it.
   */
  cancelJob(jobId: string, reason: string, correlationId?: string): ProcessingJobEntity {
    const job = this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    const now = new Date().toISOString();
    const corrId = correlationId || crypto.randomUUID();
    const updated = this.jobRepo.updateStatus(jobId, {
      status: 'CANCELLED',
      error_code: 'CANCELLED_BY_USER',
      error_message: reason,
      completed_at: now,
      clearLease: true,
    });

    this.auditService.record({
      correlationId: corrId,
      actor: 'OPERATOR',
      action: 'JOB_CANCELLED',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: job.stage,
      status: 'INFO',
      details: { reason },
    });

    this.reconcileWaitingParents(jobId, corrId);

    return updated;
  }

  /**
   * Atomically claims a specific PENDING job for execution by workerId.
   * Returns null if already claimed, not PENDING, max_attempts reached, or concurrency limit hit.
   */
  claimJob(
    jobId: string,
    workerId: string,
    options: JobClaimOptions & { correlationId?: string } = {}
  ): ProcessingJobEntity | null {
    const claimed = this.jobRepo.claimJob(jobId, workerId, {
      maxConcurrentJobs: options.maxConcurrentJobs,
      leaseDurationMs: options.leaseDurationMs,
      nowIso: options.nowIso,
    });

    if (claimed) {
      this.auditService.record({
        correlationId: options.correlationId || crypto.randomUUID(),
        actor: workerId,
        action: 'JOB_CLAIMED',
        entityType: 'PROCESSING_JOB',
        entityId: claimed.job_id,
        stage: claimed.stage,
        status: 'SUCCESS',
        details: {
          claimedBy: claimed.claimed_by,
          claimedAt: claimed.claimed_at,
          attempt: claimed.attempts,
        },
      });
    }

    return claimed;
  }

  /**
   * Atomically claims the next eligible PENDING job while respecting maxConcurrentJobs.
   */
  claimNextPendingJob(
    workerId: string,
    options: JobClaimOptions & { correlationId?: string } = {}
  ): ProcessingJobEntity | null {
    const claimed = this.jobRepo.claimNextPendingJob(workerId, {
      maxConcurrentJobs: options.maxConcurrentJobs,
      leaseDurationMs: options.leaseDurationMs,
      nowIso: options.nowIso,
    });

    if (claimed) {
      this.auditService.record({
        correlationId: options.correlationId || crypto.randomUUID(),
        actor: workerId,
        action: 'JOB_CLAIMED',
        entityType: 'PROCESSING_JOB',
        entityId: claimed.job_id,
        stage: claimed.stage,
        status: 'SUCCESS',
        details: {
          claimedBy: claimed.claimed_by,
          claimedAt: claimed.claimed_at,
          attempt: claimed.attempts,
        },
      });
    }

    return claimed;
  }

  /**
   * Schedules a transiently failed job back to PENDING with backoff delay.
   */
  scheduleRetry(
    jobId: string,
    workerId: string,
    params: {
      errorCode: string;
      errorMessage: string;
      backoffMs: number;
      maxAttempts?: number;
      correlationId?: string;
    }
  ): ProcessingJobEntity | null {
    const nextRetryAt = new Date(Date.now() + Math.max(0, params.backoffMs)).toISOString();
    const retried = this.jobRepo.scheduleRetry(jobId, {
      workerId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      nextRetryAt,
      maxAttempts: params.maxAttempts,
    });

    if (retried) {
      this.auditService.record({
        correlationId: params.correlationId || crypto.randomUUID(),
        actor: workerId,
        action: 'JOB_RETRY_SCHEDULED',
        entityType: 'PROCESSING_JOB',
        entityId: retried.job_id,
        stage: retried.stage,
        status: 'INFO',
        details: {
          attempt: retried.attempts,
          maxAttempts: retried.max_attempts,
          backoffMs: params.backoffMs,
          nextRetryAt: retried.next_retry_at,
          errorCode: params.errorCode,
        },
      });
    }

    return retried;
  }

  /**
   * Atomically detects and recovers stale RUNNING jobs whose leases have expired.
   */
  recoverStaleJobs(
    options: RecoverStaleJobsOptions & { correlationId?: string; actor?: string } = {}
  ): RecoveredStaleJobRecord[] {
    const recovered = this.jobRepo.recoverStaleJobs({
      nowIso: options.nowIso,
      maxAttempts: options.maxAttempts,
      retryBackoffMs: options.retryBackoffMs,
    });

    const correlationId = options.correlationId || crypto.randomUUID();
    const actor = options.actor || 'STALE_JOB_RECOVERY';

    for (const item of recovered) {
      this.auditService.record({
        correlationId,
        actor,
        action: 'JOB_STALE_RECOVERED',
        entityType: 'PROCESSING_JOB',
        entityId: item.job.job_id,
        stage: item.job.stage,
        status: item.outcome === 'REQUEUED_PENDING' ? 'INFO' : 'FAILURE',
        details: {
          outcome: item.outcome,
          reason: item.reason,
          previousOwner: item.previousOwner,
          previousClaimedAt: item.previousClaimedAt,
          expiredLeaseAt: item.expiredLeaseAt,
          recoveryCount: item.job.recovery_count ?? 1,
          attempts: item.job.attempts,
          maxAttempts: item.job.max_attempts,
        },
      });

      logger.warn(`Recovered stale processing job ${item.job.job_id}`, {
        jobId: item.job.job_id,
        outcome: item.outcome,
        previousOwner: item.previousOwner,
        reason: item.reason,
      });

      if (item.outcome === 'MARKED_FAILED') {
        this.reconcileWaitingParents(item.job.job_id, correlationId);
      }
    }

    return recovered;
  }

  /**
   * Renews lease expiration for an active job owned by workerId.
   * Logs and audits lease renewal failures when ownership/lease was lost.
   */
  renewLease(
    jobId: string,
    workerId: string,
    leaseDurationMs: number,
    options: { nowIso?: string; correlationId?: string } = {}
  ): ProcessingJobEntity | null {
    const renewed = this.jobRepo.renewLease(jobId, workerId, leaseDurationMs, options.nowIso);

    if (!renewed) {
      const current = this.jobRepo.findById(jobId);
      const failureReason = !current
        ? 'JOB_NOT_FOUND'
        : current.status !== 'RUNNING'
          ? `JOB_NOT_RUNNING (${current.status})`
          : current.claimed_by !== workerId
            ? `OWNERSHIP_MISMATCH (owner=${current.claimed_by ?? 'none'})`
            : 'LEASE_ALREADY_EXPIRED';

      logger.warn(`Lease renewal failed for job ${jobId}`, {
        jobId,
        workerId,
        reason: failureReason,
      });

      this.auditService.record({
        correlationId: options.correlationId || crypto.randomUUID(),
        actor: workerId,
        action: 'JOB_LEASE_RENEWAL_FAILED',
        entityType: 'PROCESSING_JOB',
        entityId: jobId,
        stage: current?.stage ?? null,
        status: 'FAILURE',
        details: {
          workerId,
          reason: failureReason,
        },
      });
    }

    return renewed;
  }

  countRunningJobs(): number {
    return this.jobRepo.countRunning();
  }

  listStaleRunningJobs(referenceIso?: string): ProcessingJobEntity[] {
    return this.jobRepo.listStaleRunning(referenceIso);
  }

  getJob(jobId: string): ProcessingJobEntity | null {
    return this.jobRepo.findById(jobId);
  }

  findByDedupeKey(dedupeKey: string): ProcessingJobEntity | null {
    return this.jobRepo.findByDedupeKey(dedupeKey);
  }

  getChildJobs(parentJobId: string): ProcessingJobEntity[] {
    return this.jobRepo.listByParentJobId(parentJobId);
  }

  listJobsByTarget(
    targetEntityType: string,
    targetEntityId: string,
    stage?: PipelineStageName,
    limit = 50
  ): ProcessingJobEntity[] {
    return this.jobRepo.listByTarget(targetEntityType, targetEntityId, stage, limit);
  }

  listJobs(limit = 50, status?: ProcessingJobStatus): ProcessingJobEntity[] {
    return this.jobRepo.listRecent(limit, status);
  }

  /**
   * Manually re-queues a FAILED or PAUSED job back to PENDING for scheduler/pipeline execution.
   * Never bypasses PublishingGate, EvidenceValidator, or deduplication.
   */
  retryJob(jobId: string, actor = 'OPERATOR', correlationId?: string): ProcessingJobEntity {
    const existing = this.jobRepo.findById(jobId);
    if (!existing) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    if (
      existing.status !== 'FAILED' &&
      existing.status !== 'PARTIAL_FAILED' &&
      existing.status !== 'PAUSED'
    ) {
      throw new InvalidStateTransitionError(
        `Cannot retry job ${jobId} in status "${existing.status}". Only FAILED, PARTIAL_FAILED, or PAUSED jobs can be manually retried.`
      );
    }

    const retried = this.jobRepo.requeueJob(jobId);
    if (!retried) {
      throw new InvalidStateTransitionError(
        `Job ${jobId} state changed concurrently and could not be requeued.`
      );
    }

    const corrId = correlationId || crypto.randomUUID();
    this.auditService.record({
      correlationId: corrId,
      actor,
      action: 'JOB_MANUAL_RETRY',
      entityType: 'PROCESSING_JOB',
      entityId: jobId,
      stage: retried.stage,
      status: 'INFO',
      details: {
        previousStatus: existing.status,
        previousErrorCode: existing.error_code,
        attempts: retried.attempts,
        maxAttempts: retried.max_attempts,
      },
    });

    logger.info('Requeued failed/paused processing job for manual retry', {
      jobId,
      stage: retried.stage,
      attempts: retried.attempts,
      maxAttempts: retried.max_attempts,
    });

    // If a parent job had previously transitioned to FAILED or PARTIAL_FAILED because of this child,
    // move the parent back to PAUSED (AWAITING_CHILDREN) so completion of this retry recovers the parent.
    this.reconcileWaitingParents(jobId, corrId);

    return retried;
  }

  getStatusCounts(): Record<ProcessingJobStatus, number> {
    return this.jobRepo.countByStatus();
  }
}
