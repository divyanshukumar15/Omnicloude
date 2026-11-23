/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { normalizeCanonicalUrl, runInSqliteTransaction } from '../connection.ts';
import type {
  SourceEntity,
  SourceDocumentEntity,
  DocumentEntity,
  DocumentPageEntity,
  RecruitmentEntity,
  JobEntity,
  EvidenceEntity,
  ProcessingJobEntity,
  DeduplicationRecordEntity,
  PublishingRecordEntity,
  AuditLogEntity,
  ExtractionAuditEntity,
  CorrigendumAssociationEntity,
  DeduplicationEvaluationEntity,
  PublishingGateEvaluationEntity,
  SourceDiscoveryRunEntity,
  OcrPageCacheEntity,
  PipelineStageName,
  ProcessingJobStatus,
} from '../types.ts';
import type {
  CreateProcessingJobRecord,
  IProcessingJobRepository,
  JobClaimOptions,
  ScheduleRetryInput,
  RecoverStaleJobsOptions,
  RecoveredStaleJobRecord,
  IAuditLogRepository,
  ISourceRepository,
  ISourceDocumentRepository,
  IDocumentRepository,
  IRecruitmentRepository,
  IJobRepository,
  IEvidenceRepository,
  IDeduplicationRecordRepository,
  IDeduplicationEvaluationRepository,
  IPublishingGateEvaluationRepository,
  IPublishingRecordRepository,
  IExtractionAuditRepository,
  ICorrigendumAssociationRepository,
  ISourceDiscoveryRunRepository,
  IOcrCacheRepository,
} from './contracts.ts';

export class SqliteProcessingJobRepository implements IProcessingJobRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(job: CreateProcessingJobRecord): ProcessingJobEntity {
    return this.createIdempotent(job).job;
  }

  /**
   * Atomically creates a processing job or resolves an existing job with the same dedupe_key.
   * Uses SQLite's partial unique index (idx_processing_jobs_dedupe_key) with ON CONFLICT DO NOTHING
   * inside an IMMEDIATE transaction so concurrent workers never create duplicate child jobs.
   */
  createIdempotent(job: CreateProcessingJobRecord): {
    job: ProcessingJobEntity;
    created: boolean;
  } {
    const id = job.job_id || crypto.randomUUID();
    const now = new Date().toISOString();
    const status = job.status || 'PENDING';
    const maxAttempts = job.max_attempts ?? 3;
    const metadata = job.metadata_json ?? null;
    const parentJobId = job.parent_job_id ?? null;
    const dedupeKey = job.dedupe_key && job.dedupe_key.trim().length > 0 ? job.dedupe_key.trim() : null;

    if (!dedupeKey) {
      const stmt = this.db.prepare(`
        INSERT INTO processing_jobs (
          job_id, parent_job_id, dedupe_key, target_entity_type, target_entity_id, stage, status,
          attempts, max_attempts, error_code, error_message, metadata_json,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, NULL, NULL)
      `);

      stmt.run(
        id,
        parentJobId,
        job.target_entity_type,
        job.target_entity_id,
        job.stage,
        status,
        maxAttempts,
        metadata,
        now,
        now
      );

      const created = this.findById(id);
      if (!created) {
        throw new Error(`Failed to retrieve newly created processing job: ${id}`);
      }
      return { job: created, created: true };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO processing_jobs (
          job_id, parent_job_id, dedupe_key, target_entity_type, target_entity_id, stage, status,
          attempts, max_attempts, error_code, error_message, metadata_json,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, NULL, NULL)
        ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      `);

      const runResult = stmt.run(
        id,
        parentJobId,
        dedupeKey,
        job.target_entity_type,
        job.target_entity_id,
        job.stage,
        status,
        maxAttempts,
        metadata,
        now,
        now
      );

      const inserted = Number(runResult.changes ?? 0) > 0;
      const resolved = inserted ? this.findById(id) : this.findByDedupeKey(dedupeKey);
      this.db.exec('COMMIT;');

      if (!resolved) {
        throw new Error(`Failed to resolve processing job for dedupe_key: ${dedupeKey}`);
      }
      return { job: resolved, created: inserted };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error
      }
      throw err;
    }
  }

  findById(jobId: string): ProcessingJobEntity | null {
    const stmt = this.db.prepare('SELECT * FROM processing_jobs WHERE job_id = ?');
    const row = stmt.get(jobId);
    return (row as unknown as ProcessingJobEntity) || null;
  }

  findByDedupeKey(dedupeKey: string): ProcessingJobEntity | null {
    const stmt = this.db.prepare('SELECT * FROM processing_jobs WHERE dedupe_key = ? LIMIT 1');
    const row = stmt.get(dedupeKey);
    return (row as unknown as ProcessingJobEntity) || null;
  }

  listByParentJobId(parentJobId: string): ProcessingJobEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM processing_jobs WHERE parent_job_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(parentJobId) as unknown as ProcessingJobEntity[];
  }

  listByTarget(
    targetEntityType: string,
    targetEntityId: string,
    stage?: PipelineStageName,
    limit = 50
  ): ProcessingJobEntity[] {
    if (stage) {
      const stmt = this.db.prepare(
        `SELECT * FROM processing_jobs
         WHERE target_entity_type = ?
           AND target_entity_id = ?
           AND stage = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      );
      return stmt.all(targetEntityType, targetEntityId, stage, limit) as unknown as ProcessingJobEntity[];
    }

    const stmt = this.db.prepare(
      `SELECT * FROM processing_jobs
       WHERE target_entity_type = ?
         AND target_entity_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    );
    return stmt.all(targetEntityType, targetEntityId, limit) as unknown as ProcessingJobEntity[];
  }

  listPausedAwaitingChildren(): ProcessingJobEntity[] {
    const stmt = this.db.prepare(
      "SELECT * FROM processing_jobs WHERE status = 'PAUSED' AND metadata_json LIKE '%AWAITING_CHILDREN%' ORDER BY created_at ASC"
    );
    return stmt.all() as unknown as ProcessingJobEntity[];
  }

  listReconcilableParents(): ProcessingJobEntity[] {
    const stmt = this.db.prepare(
      "SELECT * FROM processing_jobs WHERE status IN ('PAUSED', 'FAILED', 'PARTIAL_FAILED', 'CANCELLED') AND metadata_json LIKE '%\"fanOut\"%' ORDER BY created_at ASC"
    );
    return stmt.all() as unknown as ProcessingJobEntity[];
  }

  updateMetadata(jobId: string, metadataJson: string | null): ProcessingJobEntity {
    const current = this.findById(jobId);
    if (!current) {
      throw new Error(`Processing job ${jobId} not found`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE processing_jobs SET metadata_json = ?, updated_at = ? WHERE job_id = ?')
      .run(metadataJson, now, jobId);
    return this.findById(jobId)!;
  }

  updateStatus(
    jobId: string,
    update: {
      status: ProcessingJobStatus;
      stage?: PipelineStageName;
      attemptsIncrement?: boolean;
      error_code?: string | null;
      error_message?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      clearLease?: boolean;
    }
  ): ProcessingJobEntity {
    const current = this.findById(jobId);
    if (!current) {
      throw new Error(`Processing job ${jobId} not found`);
    }

    const now = new Date().toISOString();
    const stage = update.stage ?? current.stage;
    const attempts = update.attemptsIncrement ? current.attempts + 1 : current.attempts;
    const errorCode = update.error_code !== undefined ? update.error_code : current.error_code;
    const errorMessage = update.error_message !== undefined ? update.error_message : current.error_message;
    const startedAt = update.started_at !== undefined ? update.started_at : current.started_at;
    const completedAt = update.completed_at !== undefined ? update.completed_at : current.completed_at;
    const clearLease = Boolean(update.clearLease);

    if (clearLease) {
      const stmt = this.db.prepare(`
        UPDATE processing_jobs
        SET status = ?,
            stage = ?,
            attempts = ?,
            error_code = ?,
            error_message = ?,
            started_at = ?,
            completed_at = ?,
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE job_id = ?
      `);

      stmt.run(
        update.status,
        stage,
        attempts,
        errorCode,
        errorMessage,
        startedAt,
        completedAt,
        now,
        jobId
      );
    } else {
      const stmt = this.db.prepare(`
        UPDATE processing_jobs
        SET status = ?,
            stage = ?,
            attempts = ?,
            error_code = ?,
            error_message = ?,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE job_id = ?
      `);

      stmt.run(
        update.status,
        stage,
        attempts,
        errorCode,
        errorMessage,
        startedAt,
        completedAt,
        now,
        jobId
      );
    }

    return this.findById(jobId)!;
  }

  listRecent(limit = 50, status?: ProcessingJobStatus): ProcessingJobEntity[] {
    if (status) {
      const stmt = this.db.prepare(
        'SELECT * FROM processing_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      );
      return stmt.all(status, limit) as unknown as ProcessingJobEntity[];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM processing_jobs ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(limit) as unknown as ProcessingJobEntity[];
  }

  countByStatus(): Record<ProcessingJobStatus, number> {
    const counts: Record<ProcessingJobStatus, number> = {
      PENDING: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      PARTIAL_FAILED: 0,
      PAUSED: 0,
      CANCELLED: 0,
    };

    const stmt = this.db.prepare(
      'SELECT status, COUNT(*) as count FROM processing_jobs GROUP BY status'
    );
    const rows = stmt.all() as unknown as { status: ProcessingJobStatus; count: number }[];

    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status] = Number(row.count);
      }
    }
    return counts;
  }

  countRunning(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM processing_jobs WHERE status = 'RUNNING'")
      .get() as unknown as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listStaleRunning(referenceIso = new Date().toISOString()): ProcessingJobEntity[] {
    const stmt = this.db.prepare(`
      SELECT * FROM processing_jobs
      WHERE status = 'RUNNING'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY claimed_at ASC, created_at ASC
    `);
    return stmt.all(referenceIso) as unknown as ProcessingJobEntity[];
  }

  claimJob(
    jobId: string,
    workerId: string,
    options: JobClaimOptions = {}
  ): ProcessingJobEntity | null {
    if (!workerId || !workerId.trim()) {
      throw new Error('workerId is required to claim a processing job');
    }

    const leaseDurationMs = options.leaseDurationMs ?? 300_000;
    const nowMs = options.nowIso ? Date.parse(options.nowIso) : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (options.maxConcurrentJobs !== undefined) {
        const runningRow = this.db
          .prepare("SELECT COUNT(*) as count FROM processing_jobs WHERE status = 'RUNNING'")
          .get() as unknown as { count: number } | undefined;
        if (Number(runningRow?.count ?? 0) >= options.maxConcurrentJobs) {
          this.db.exec('COMMIT;');
          return null;
        }
      }

      const stmt = this.db.prepare(`
        UPDATE processing_jobs
        SET status = 'RUNNING',
            attempts = attempts + 1,
            claimed_by = ?,
            claimed_at = ?,
            lease_expires_at = ?,
            next_retry_at = NULL,
            started_at = ?,
            updated_at = ?,
            error_code = NULL,
            error_message = NULL
        WHERE job_id = ?
          AND status = 'PENDING'
          AND claimed_by IS NULL
          AND attempts < max_attempts
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        RETURNING *
      `);

      const claimed = stmt.get(
        workerId.trim(),
        nowIso,
        leaseExpiresIso,
        nowIso,
        nowIso,
        jobId,
        nowIso
      ) as unknown as ProcessingJobEntity | undefined;

      this.db.exec('COMMIT;');
      return claimed ?? null;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }

  claimNextPendingJob(
    workerId: string,
    options: JobClaimOptions = {}
  ): ProcessingJobEntity | null {
    if (!workerId || !workerId.trim()) {
      throw new Error('workerId is required to claim a processing job');
    }

    const leaseDurationMs = options.leaseDurationMs ?? 300_000;
    const nowMs = options.nowIso ? Date.parse(options.nowIso) : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (options.maxConcurrentJobs !== undefined) {
        const runningRow = this.db
          .prepare("SELECT COUNT(*) as count FROM processing_jobs WHERE status = 'RUNNING'")
          .get() as unknown as { count: number } | undefined;
        if (Number(runningRow?.count ?? 0) >= options.maxConcurrentJobs) {
          this.db.exec('COMMIT;');
          return null;
        }
      }

      const candidate = this.db
        .prepare(`
          SELECT job_id FROM processing_jobs
          WHERE status = 'PENDING'
            AND claimed_by IS NULL
            AND attempts < max_attempts
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        `)
        .get(nowIso) as unknown as { job_id: string } | undefined;

      if (!candidate) {
        this.db.exec('COMMIT;');
        return null;
      }

      const claimed = this.db
        .prepare(`
          UPDATE processing_jobs
          SET status = 'RUNNING',
              attempts = attempts + 1,
              claimed_by = ?,
              claimed_at = ?,
              lease_expires_at = ?,
              next_retry_at = NULL,
              started_at = ?,
              updated_at = ?,
              error_code = NULL,
              error_message = NULL
          WHERE job_id = ?
            AND status = 'PENDING'
            AND claimed_by IS NULL
            AND attempts < max_attempts
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
          RETURNING *
        `)
        .get(
          workerId.trim(),
          nowIso,
          leaseExpiresIso,
          nowIso,
          nowIso,
          candidate.job_id,
          nowIso
        ) as unknown as ProcessingJobEntity | undefined;

      this.db.exec('COMMIT;');
      return claimed ?? null;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }

  scheduleRetry(jobId: string, input: ScheduleRetryInput): ProcessingJobEntity | null {
    const nowIso = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.findById(jobId);
      if (!current) {
        this.db.exec('COMMIT;');
        return null;
      }

      const effectiveMaxAttempts =
        input.maxAttempts !== undefined
          ? Math.min(current.max_attempts, input.maxAttempts)
          : current.max_attempts;

      if (current.attempts >= effectiveMaxAttempts) {
        this.db.exec('COMMIT;');
        return null;
      }

      const updated = this.db
        .prepare(`
          UPDATE processing_jobs
          SET status = 'PENDING',
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              next_retry_at = ?,
              error_code = ?,
              error_message = ?,
              completed_at = NULL,
              updated_at = ?
          WHERE job_id = ?
            AND status IN ('RUNNING', 'FAILED')
            AND (claimed_by = ? OR claimed_by IS NULL)
            AND attempts < ?
          RETURNING *
        `)
        .get(
          input.nextRetryAt,
          input.errorCode,
          input.errorMessage,
          nowIso,
          jobId,
          input.workerId,
          effectiveMaxAttempts
        ) as unknown as ProcessingJobEntity | undefined;

      this.db.exec('COMMIT;');
      return updated ?? null;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }

  recoverStaleJobs(options: RecoverStaleJobsOptions = {}): RecoveredStaleJobRecord[] {
    const nowMs = options.nowIso ? Date.parse(options.nowIso) : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const recovered: RecoveredStaleJobRecord[] = [];

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const staleCandidates = this.db
        .prepare(`
          SELECT * FROM processing_jobs
          WHERE status = 'RUNNING'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY lease_expires_at ASC, created_at ASC
        `)
        .all(nowIso) as unknown as ProcessingJobEntity[];

      for (const candidate of staleCandidates) {
        const effectiveMaxAttempts =
          options.maxAttempts !== undefined
            ? Math.min(candidate.max_attempts, options.maxAttempts)
            : candidate.max_attempts;

        const canRetry = candidate.attempts < effectiveMaxAttempts;

        if (canRetry) {
          const reason = `Lease expired at ${candidate.lease_expires_at} while claimed by ${candidate.claimed_by ?? 'unknown'}; requeued as PENDING for retry`;
          const backoffMs = options.retryBackoffMs ?? 0;
          const nextRetryAt = new Date(nowMs + Math.max(0, backoffMs)).toISOString();

          const updated = this.db
            .prepare(`
              UPDATE processing_jobs
              SET status = 'PENDING',
                  claimed_by = NULL,
                  claimed_at = NULL,
                  lease_expires_at = NULL,
                  next_retry_at = ?,
                  recovery_count = COALESCE(recovery_count, 0) + 1,
                  last_recovery_reason = ?,
                  error_code = 'LEASE_EXPIRED_RECOVERED',
                  error_message = ?,
                  completed_at = NULL,
                  updated_at = ?
              WHERE job_id = ?
                AND status = 'RUNNING'
                AND lease_expires_at = ?
              RETURNING *
            `)
            .get(
              nextRetryAt,
              reason,
              reason,
              nowIso,
              candidate.job_id,
              candidate.lease_expires_at ?? null
            ) as unknown as ProcessingJobEntity | undefined;

          if (updated) {
            recovered.push({
              job: updated,
              previousOwner: candidate.claimed_by ?? null,
              previousClaimedAt: candidate.claimed_at ?? null,
              expiredLeaseAt: candidate.lease_expires_at ?? null,
              outcome: 'REQUEUED_PENDING',
              reason,
            });
          }
        } else {
          const reason = `Lease expired at ${candidate.lease_expires_at} while claimed by ${candidate.claimed_by ?? 'unknown'}; max attempts (${effectiveMaxAttempts}) exhausted`;

          const updated = this.db
            .prepare(`
              UPDATE processing_jobs
              SET status = 'FAILED',
                  claimed_by = NULL,
                  claimed_at = NULL,
                  lease_expires_at = NULL,
                  next_retry_at = NULL,
                  recovery_count = COALESCE(recovery_count, 0) + 1,
                  last_recovery_reason = ?,
                  error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
                  error_message = ?,
                  completed_at = ?,
                  updated_at = ?
              WHERE job_id = ?
                AND status = 'RUNNING'
                AND lease_expires_at = ?
              RETURNING *
            `)
            .get(
              reason,
              reason,
              nowIso,
              nowIso,
              candidate.job_id,
              candidate.lease_expires_at ?? null
            ) as unknown as ProcessingJobEntity | undefined;

          if (updated) {
            recovered.push({
              job: updated,
              previousOwner: candidate.claimed_by ?? null,
              previousClaimedAt: candidate.claimed_at ?? null,
              expiredLeaseAt: candidate.lease_expires_at ?? null,
              outcome: 'MARKED_FAILED',
              reason,
            });
          }
        }
      }

      this.db.exec('COMMIT;');
      return recovered;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }

  renewLease(
    jobId: string,
    workerId: string,
    leaseDurationMs: number,
    nowIso?: string
  ): ProcessingJobEntity | null {
    if (!workerId || !workerId.trim()) {
      return null;
    }
    const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    const currentIso = new Date(nowMs).toISOString();
    const extendedLeaseIso = new Date(nowMs + leaseDurationMs).toISOString();

    const updated = this.db
      .prepare(`
        UPDATE processing_jobs
        SET lease_expires_at = ?,
            last_heartbeat_at = ?,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'RUNNING'
          AND claimed_by = ?
          AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        RETURNING *
      `)
      .get(
        extendedLeaseIso,
        currentIso,
        currentIso,
        jobId,
        workerId.trim(),
        currentIso
      ) as unknown as ProcessingJobEntity | undefined;

    return updated ?? null;
  }

  requeueJob(jobId: string, nowIso = new Date().toISOString()): ProcessingJobEntity | null {
    const updated = this.db
      .prepare(`
        UPDATE processing_jobs
        SET status = 'PENDING',
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            next_retry_at = NULL,
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            max_attempts = CASE
              WHEN attempts >= max_attempts THEN attempts + 1
              ELSE max_attempts
            END,
            updated_at = ?
        WHERE job_id = ?
          AND status IN ('FAILED', 'PARTIAL_FAILED', 'PAUSED')
        RETURNING *
      `)
      .get(nowIso, jobId) as unknown as ProcessingJobEntity | undefined;

    return updated ?? null;
  }
}

export class SqliteAuditLogRepository implements IAuditLogRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(log: {
    id?: string;
    correlation_id: string;
    actor: string;
    action: string;
    entity_type: string;
    entity_id: string;
    stage?: string | null;
    status: string;
    details_json?: string | null;
  }): AuditLogEntity {
    const id = log.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const stage = log.stage || null;
    const details = log.details_json || null;

    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (
        id, correlation_id, actor, action, entity_type, entity_id,
        stage, status, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      log.correlation_id,
      log.actor,
      log.action,
      log.entity_type,
      log.entity_id,
      stage,
      log.status,
      details,
      now
    );

    return {
      id,
      correlation_id: log.correlation_id,
      actor: log.actor,
      action: log.action,
      entity_type: log.entity_type,
      entity_id: log.entity_id,
      stage,
      status: log.status,
      details_json: details,
      created_at: now,
    };
  }

  listByCorrelationId(correlationId: string): AuditLogEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM audit_logs WHERE correlation_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(correlationId) as unknown as AuditLogEntity[];
  }

  listByEntity(entityType: string, entityId: string): AuditLogEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(entityType, entityId) as unknown as AuditLogEntity[];
  }

  listRecent(limit = 100): AuditLogEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(limit) as unknown as AuditLogEntity[];
  }
}

export class SqliteSourceRepository implements ISourceRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(source: Omit<SourceEntity, 'created_at' | 'updated_at'>): SourceEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sources (id, name, type, base_url, is_active, check_interval_minutes, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      source.id,
      source.name,
      source.type,
      source.base_url,
      source.is_active,
      source.check_interval_minutes,
      source.config_json,
      now,
      now
    );
    return this.findById(source.id)!;
  }

  findById(id: string): SourceEntity | null {
    const stmt = this.db.prepare('SELECT * FROM sources WHERE id = ?');
    return (stmt.get(id) as unknown as SourceEntity) || null;
  }

  listActive(): SourceEntity[] {
    const stmt = this.db.prepare('SELECT * FROM sources WHERE is_active = 1 ORDER BY id ASC');
    return stmt.all() as unknown as SourceEntity[];
  }

  listAll(): SourceEntity[] {
    const stmt = this.db.prepare('SELECT * FROM sources ORDER BY id ASC');
    return stmt.all() as unknown as SourceEntity[];
  }

  setActive(id: string, isActive: boolean): SourceEntity | null {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sources SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(isActive ? 1 : 0, now, id);
    return this.findById(id);
  }
}

export class SqliteSourceDocumentRepository implements ISourceDocumentRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(doc: Omit<SourceDocumentEntity, 'discovered_at' | 'updated_at'>): SourceDocumentEntity {
    return this.upsertCanonical(doc).entity;
  }

  upsertCanonical(
    doc: Omit<SourceDocumentEntity, 'discovered_at' | 'updated_at'>
  ): { entity: SourceDocumentEntity; created: boolean } {
    const now = new Date().toISOString();
    const canonicalUrl = normalizeCanonicalUrl(doc.canonical_url ?? doc.url) || doc.url;

    return runInSqliteTransaction(this.db, () => {
      const stmt = this.db.prepare(`
        INSERT INTO source_documents (
          id, source_id, url, canonical_url, title, document_type, raw_hash, status, metadata_json, discovered_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, canonical_url)
        WHERE canonical_url IS NOT NULL AND TRIM(canonical_url) != ''
        DO NOTHING
      `);
      const res = stmt.run(
        doc.id,
        doc.source_id,
        doc.url,
        canonicalUrl,
        doc.title,
        doc.document_type,
        doc.raw_hash,
        doc.status,
        doc.metadata_json,
        now,
        now
      );
      const inserted = Number(res.changes ?? 0) > 0;
      if (inserted) {
        return { entity: this.findById(doc.id)!, created: true };
      }

      const existing = this.findBySourceAndCanonicalUrl(doc.source_id, canonicalUrl);
      if (!existing) {
        throw new Error(
          `Failed to converge source_document for source_id=${doc.source_id} canonical_url=${canonicalUrl}`
        );
      }

      const nextHash = doc.raw_hash ?? existing.raw_hash;
      const nextTitle = existing.title || doc.title;
      const nextStatus =
        doc.status === 'DOWNLOADED' || existing.status === 'DOWNLOADED'
          ? 'DOWNLOADED'
          : doc.status || existing.status;

      this.db
        .prepare(
          'UPDATE source_documents SET raw_hash = ?, title = ?, status = ?, updated_at = ? WHERE id = ?'
        )
        .run(nextHash, nextTitle, nextStatus, now, existing.id);

      return { entity: this.findById(existing.id)!, created: false };
    });
  }

  findById(id: string): SourceDocumentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM source_documents WHERE id = ?');
    return (stmt.get(id) as unknown as SourceDocumentEntity) || null;
  }

  findBySourceAndCanonicalUrl(sourceId: string, url: string): SourceDocumentEntity | null {
    const canonicalUrl = normalizeCanonicalUrl(url) || url;
    const stmt = this.db.prepare(
      'SELECT * FROM source_documents WHERE source_id = ? AND (canonical_url = ? OR url = ?) LIMIT 1'
    );
    return (stmt.get(sourceId, canonicalUrl, url) as unknown as SourceDocumentEntity) || null;
  }

  listBySource(sourceId: string): SourceDocumentEntity[] {
    const stmt = this.db.prepare('SELECT * FROM source_documents WHERE source_id = ?');
    return stmt.all(sourceId) as unknown as SourceDocumentEntity[];
  }

  updateStatus(id: string, status: SourceDocumentEntity['status']): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE source_documents SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, now, id);
  }
}

export class SqliteDocumentRepository implements IDocumentRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(doc: Omit<DocumentEntity, 'downloaded_at'>): DocumentEntity {
    return this.upsertByHash(doc).entity;
  }

  upsertByHash(
    doc: Omit<DocumentEntity, 'downloaded_at'>
  ): { entity: DocumentEntity; created: boolean } {
    const now = new Date().toISOString();
    const trimmedHash = doc.sha256_hash && doc.sha256_hash.trim().length > 0 ? doc.sha256_hash.trim() : null;
    const normalizedCanonicalUrl = doc.canonical_url
      ? normalizeCanonicalUrl(doc.canonical_url) || doc.canonical_url
      : null;

    return runInSqliteTransaction(this.db, () => {
      if (!trimmedHash) {
        const stmt = this.db.prepare(`
          INSERT INTO documents (
            id, source_document_id, source_url, canonical_url, source_domain,
            file_path, file_size, page_count, mime_type, sha256_hash, storage_uri,
            downloaded_at, validation_status, validation_notes, extraction_status,
            extraction_method, is_scanned
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          doc.id,
          doc.source_document_id,
          doc.source_url ?? null,
          normalizedCanonicalUrl,
          doc.source_domain ?? null,
          doc.file_path ?? null,
          doc.file_size ?? null,
          doc.page_count ?? null,
          doc.mime_type ?? null,
          doc.storage_uri ?? null,
          now,
          doc.validation_status,
          doc.validation_notes ?? null,
          doc.extraction_status ?? 'PENDING',
          doc.extraction_method ?? null,
          doc.is_scanned ?? 0
        );
        return { entity: this.findById(doc.id)!, created: true };
      }

      const stmt = this.db.prepare(`
        INSERT INTO documents (
          id, source_document_id, source_url, canonical_url, source_domain,
          file_path, file_size, page_count, mime_type, sha256_hash, storage_uri,
          downloaded_at, validation_status, validation_notes, extraction_status,
          extraction_method, is_scanned
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha256_hash)
        WHERE sha256_hash IS NOT NULL AND TRIM(sha256_hash) != ''
        DO NOTHING
      `);
      const res = stmt.run(
        doc.id,
        doc.source_document_id,
        doc.source_url ?? null,
        normalizedCanonicalUrl,
        doc.source_domain ?? null,
        doc.file_path ?? null,
        doc.file_size ?? null,
        doc.page_count ?? null,
        doc.mime_type ?? null,
        trimmedHash,
        doc.storage_uri ?? null,
        now,
        doc.validation_status,
        doc.validation_notes ?? null,
        doc.extraction_status ?? 'PENDING',
        doc.extraction_method ?? null,
        doc.is_scanned ?? 0
      );

      const inserted = Number(res.changes ?? 0) > 0;
      if (inserted) {
        return { entity: this.findById(doc.id)!, created: true };
      }

      const existing = this.findByHash(trimmedHash);
      if (!existing) {
        throw new Error(`Failed to converge document for sha256_hash=${trimmedHash}`);
      }
      return { entity: existing, created: false };
    });
  }

  findById(id: string): DocumentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    return (stmt.get(id) as unknown as DocumentEntity) || null;
  }

  findByHash(sha256Hash: string): DocumentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE sha256_hash = ? LIMIT 1');
    return (stmt.get(sha256Hash) as unknown as DocumentEntity) || null;
  }

  findByCanonicalUrl(url: string): DocumentEntity | null {
    const normalized = normalizeCanonicalUrl(url) || url;
    const stmt = this.db.prepare(
      'SELECT * FROM documents WHERE canonical_url = ? OR canonical_url = ? OR source_url = ? LIMIT 1'
    );
    return (stmt.get(normalized, url, url) as unknown as DocumentEntity) || null;
  }

  listAll(): DocumentEntity[] {
    const stmt = this.db.prepare('SELECT * FROM documents ORDER BY downloaded_at DESC');
    return stmt.all() as unknown as DocumentEntity[];
  }

  updateExtractionStatus(
    id: string,
    update: {
      status: DocumentEntity['extraction_status'];
      method?: string | null;
      isScanned?: number;
      pageCount?: number;
      validationNotes?: string | null;
    }
  ): void {
    const doc = this.findById(id);
    if (!doc) return;

    const method = update.method !== undefined ? update.method : doc.extraction_method;
    const isScanned = update.isScanned !== undefined ? update.isScanned : doc.is_scanned;
    const pageCount = update.pageCount !== undefined ? update.pageCount : doc.page_count;
    const notes = update.validationNotes !== undefined ? update.validationNotes : doc.validation_notes;

    const stmt = this.db.prepare(`
      UPDATE documents
      SET extraction_status = ?,
          extraction_method = ?,
          is_scanned = ?,
          page_count = ?,
          validation_notes = ?
      WHERE id = ?
    `);
    stmt.run(
      update.status ?? 'PENDING',
      method ?? null,
      isScanned ?? null,
      pageCount ?? null,
      notes ?? null,
      id
    );
  }

  updateValidation(
    id: string,
    update: {
      validationStatus: DocumentEntity['validation_status'];
      sha256Hash?: string | null;
      fileSize?: number | null;
      pageCount?: number | null;
      filePath?: string | null;
      validationNotes?: string | null;
    }
  ): void {
    const doc = this.findById(id);
    if (!doc) return;

    const stmt = this.db.prepare(`
      UPDATE documents
      SET validation_status = ?,
          sha256_hash = ?,
          file_size = ?,
          page_count = ?,
          file_path = ?,
          validation_notes = ?
      WHERE id = ?
    `);
    stmt.run(
      update.validationStatus,
      (update.sha256Hash !== undefined ? update.sha256Hash : doc.sha256_hash) ?? null,
      (update.fileSize !== undefined ? update.fileSize : doc.file_size) ?? null,
      (update.pageCount !== undefined ? update.pageCount : doc.page_count) ?? null,
      (update.filePath !== undefined ? update.filePath : doc.file_path) ?? null,
      (update.validationNotes !== undefined ? update.validationNotes : doc.validation_notes) ?? null,
      id
    );
  }

  savePages(pages: Omit<DocumentPageEntity, 'created_at'>[]): void {
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(`
      INSERT INTO document_pages (
        id, document_id, page_number, char_count, extracted_text,
        extraction_method, is_scanned, quality_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const page of pages) {
      insertStmt.run(
        page.id,
        page.document_id,
        page.page_number,
        page.char_count,
        page.extracted_text,
        page.extraction_method,
        page.is_scanned,
        page.quality_score,
        now
      );
    }
  }

  replacePages(documentId: string, pages: Omit<DocumentPageEntity, 'created_at'>[]): void {
    this.db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(documentId);
    if (pages.length > 0) {
      this.savePages(pages);
    }
  }

  getPages(documentId: string): DocumentPageEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM document_pages WHERE document_id = ? ORDER BY page_number ASC'
    );
    return stmt.all(documentId) as unknown as DocumentPageEntity[];
  }
}

export class SqliteRecruitmentRepository implements IRecruitmentRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(recruitment: Omit<RecruitmentEntity, 'created_at' | 'updated_at'> & { status?: import('../types.ts').RecruitmentPublishingState }): RecruitmentEntity {
    const now = new Date().toISOString();
    const status = recruitment.status || 'DRAFT';
    const stmt = this.db.prepare(`
      INSERT INTO recruitments (id, source_id, document_id, title, department, notification_number, total_vacancies, application_start_date, application_end_date, raw_payload_json, canonical_identity_key, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      recruitment.id,
      recruitment.source_id,
      recruitment.document_id,
      recruitment.title,
      recruitment.department,
      recruitment.notification_number,
      recruitment.total_vacancies,
      recruitment.application_start_date,
      recruitment.application_end_date,
      recruitment.raw_payload_json,
      recruitment.canonical_identity_key ?? null,
      status,
      now,
      now
    );
    return this.findById(recruitment.id)!;
  }

  findById(id: string): RecruitmentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM recruitments WHERE id = ?');
    return (stmt.get(id) as unknown as RecruitmentEntity) || null;
  }

  findByCanonicalIdentity(canonicalIdentityKey: string): RecruitmentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM recruitments WHERE canonical_identity_key = ? LIMIT 1');
    return (stmt.get(canonicalIdentityKey) as unknown as RecruitmentEntity) || null;
  }

  findByAdvertisementNumber(advtNumber: string): RecruitmentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM recruitments WHERE notification_number = ? LIMIT 1');
    return (stmt.get(advtNumber) as unknown as RecruitmentEntity) || null;
  }

  findByDocument(documentId: string): RecruitmentEntity | null {
    const stmt = this.db.prepare('SELECT * FROM recruitments WHERE document_id = ? LIMIT 1');
    return (stmt.get(documentId) as unknown as RecruitmentEntity) || null;
  }

  listRecent(limit = 50): RecruitmentEntity[] {
    const stmt = this.db.prepare('SELECT * FROM recruitments ORDER BY created_at DESC LIMIT ?');
    return stmt.all(limit) as unknown as RecruitmentEntity[];
  }

  listAll(): RecruitmentEntity[] {
    const stmt = this.db.prepare('SELECT * FROM recruitments ORDER BY created_at DESC');
    return stmt.all() as unknown as RecruitmentEntity[];
  }

  update(id: string, update: Partial<Omit<RecruitmentEntity, 'id' | 'created_at'>>): RecruitmentEntity | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...update,
      updated_at: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      UPDATE recruitments
      SET title = ?,
          department = ?,
          notification_number = ?,
          total_vacancies = ?,
          application_start_date = ?,
          application_end_date = ?,
          raw_payload_json = ?,
          canonical_identity_key = ?,
          status = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.title,
      updated.department ?? null,
      updated.notification_number ?? null,
      updated.total_vacancies ?? null,
      updated.application_start_date ?? null,
      updated.application_end_date ?? null,
      updated.raw_payload_json ?? null,
      updated.canonical_identity_key ?? null,
      updated.status ?? 'DRAFT',
      updated.updated_at,
      id
    );

    return this.findById(id);
  }

  updateStatus(id: string, status: import('../types.ts').RecruitmentPublishingState): RecruitmentEntity | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE recruitments
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, now, id);
    return this.findById(id);
  }
}

export class SqliteJobRepository implements IJobRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(job: Omit<JobEntity, 'created_at' | 'updated_at'>): JobEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, recruitment_id, title, post_code, vacancies, pay_scale, age_limit_min, age_limit_max, qualification_summary, state, category, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.id,
      job.recruitment_id,
      job.title,
      job.post_code,
      job.vacancies,
      job.pay_scale,
      job.age_limit_min,
      job.age_limit_max,
      job.qualification_summary,
      job.state,
      job.category,
      job.status,
      now,
      now
    );
    return this.findById(job.id)!;
  }

  findById(id: string): JobEntity | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    return (stmt.get(id) as unknown as JobEntity) || null;
  }

  listByRecruitment(recruitmentId: string): JobEntity[] {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE recruitment_id = ?');
    return stmt.all(recruitmentId) as unknown as JobEntity[];
  }
}

export class SqliteEvidenceRepository implements IEvidenceRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(evidence: Omit<EvidenceEntity, 'extracted_at'>): EvidenceEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO evidence (id, entity_type, entity_id, field_name, source_document_id, snippet, page_number, confidence_score, bounding_box_json, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      evidence.id,
      evidence.entity_type,
      evidence.entity_id,
      evidence.field_name,
      evidence.source_document_id,
      evidence.snippet,
      evidence.page_number,
      evidence.confidence_score,
      evidence.bounding_box_json,
      now
    );
    return { ...evidence, extracted_at: now };
  }

  listByEntity(entityType: 'RECRUITMENT' | 'JOB', entityId: string): EvidenceEntity[] {
    const stmt = this.db.prepare('SELECT * FROM evidence WHERE entity_type = ? AND entity_id = ?');
    return stmt.all(entityType, entityId) as unknown as EvidenceEntity[];
  }
}

export class SqliteDeduplicationRepository implements IDeduplicationRecordRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(record: Omit<DeduplicationRecordEntity, 'created_at'>): DeduplicationRecordEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO deduplication_records (id, primary_job_id, duplicate_job_id, similarity_score, strategy, resolution_status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.primary_job_id,
      record.duplicate_job_id,
      record.similarity_score,
      record.strategy,
      record.resolution_status,
      record.notes,
      now
    );
    return { ...record, created_at: now };
  }

  findByJob(jobId: string): DeduplicationRecordEntity[] {
    const stmt = this.db.prepare('SELECT * FROM deduplication_records WHERE primary_job_id = ? OR duplicate_job_id = ?');
    return stmt.all(jobId, jobId) as unknown as DeduplicationRecordEntity[];
  }
}

export class SqlitePublishingRepository implements IPublishingRecordRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(record: PublishingRecordEntity): PublishingRecordEntity {
    const now = record.updated_at ?? new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO publishing_records (
        id, job_id, recruitment_id, platform, external_post_id, external_identity_key,
        permalink, post_status, categories_json, canonical_source_url, official_pdf_url,
        publish_status, validation_check_passed, published_at, updated_at, payload_hash, error_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.job_id,
      record.recruitment_id ?? null,
      record.platform,
      record.external_post_id ?? null,
      record.external_identity_key ?? null,
      record.permalink ?? null,
      record.post_status ?? null,
      record.categories_json ?? null,
      record.canonical_source_url ?? null,
      record.official_pdf_url ?? null,
      record.publish_status,
      record.validation_check_passed,
      record.published_at ?? null,
      now,
      record.payload_hash ?? null,
      record.error_message ?? null
    );
    return { ...record, updated_at: now };
  }

  upsertByExternalIdentity(record: PublishingRecordEntity): PublishingRecordEntity {
    const identityKey = record.external_identity_key?.trim() || null;
    if (!identityKey) {
      return this.create(record);
    }

    const now = record.updated_at ?? new Date().toISOString();
    return runInSqliteTransaction(this.db, () => {
      const stmt = this.db.prepare(`
        INSERT INTO publishing_records (
          id, job_id, recruitment_id, platform, external_post_id, external_identity_key,
          permalink, post_status, categories_json, canonical_source_url, official_pdf_url,
          publish_status, validation_check_passed, published_at, updated_at, payload_hash, error_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, external_identity_key)
        WHERE external_identity_key IS NOT NULL AND TRIM(external_identity_key) != ''
        DO UPDATE SET
          job_id = excluded.job_id,
          recruitment_id = COALESCE(excluded.recruitment_id, publishing_records.recruitment_id),
          external_post_id = COALESCE(excluded.external_post_id, publishing_records.external_post_id),
          permalink = COALESCE(excluded.permalink, publishing_records.permalink),
          post_status = COALESCE(excluded.post_status, publishing_records.post_status),
          categories_json = COALESCE(excluded.categories_json, publishing_records.categories_json),
          canonical_source_url = COALESCE(excluded.canonical_source_url, publishing_records.canonical_source_url),
          official_pdf_url = COALESCE(excluded.official_pdf_url, publishing_records.official_pdf_url),
          publish_status = excluded.publish_status,
          validation_check_passed = excluded.validation_check_passed,
          published_at = COALESCE(excluded.published_at, publishing_records.published_at),
          updated_at = excluded.updated_at,
          payload_hash = COALESCE(excluded.payload_hash, publishing_records.payload_hash),
          error_message = excluded.error_message
      `);
      stmt.run(
        record.id,
        record.job_id,
        record.recruitment_id ?? null,
        record.platform,
        record.external_post_id ?? null,
        identityKey,
        record.permalink ?? null,
        record.post_status ?? null,
        record.categories_json ?? null,
        record.canonical_source_url ?? null,
        record.official_pdf_url ?? null,
        record.publish_status,
        record.validation_check_passed,
        record.published_at ?? null,
        now,
        record.payload_hash ?? null,
        record.error_message ?? null
      );

      const resolved = this.findByExternalIdentity(record.platform, identityKey);
      if (!resolved) {
        throw new Error(
          `Failed to resolve publishing_record for platform=${record.platform} identity=${identityKey}`
        );
      }
      return resolved;
    });
  }

  update(id: string, update: Partial<Omit<PublishingRecordEntity, 'id'>>): PublishingRecordEntity | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const now = update.updated_at ?? new Date().toISOString();
    const merged: PublishingRecordEntity = {
      ...existing,
      ...update,
      id,
      updated_at: now,
    };

    const stmt = this.db.prepare(`
      UPDATE publishing_records
      SET job_id = ?, recruitment_id = ?, platform = ?, external_post_id = ?,
          external_identity_key = ?, permalink = ?, post_status = ?, categories_json = ?,
          canonical_source_url = ?, official_pdf_url = ?, publish_status = ?,
          validation_check_passed = ?, published_at = ?, updated_at = ?, payload_hash = ?, error_message = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.job_id,
      merged.recruitment_id ?? null,
      merged.platform,
      merged.external_post_id ?? null,
      merged.external_identity_key ?? null,
      merged.permalink ?? null,
      merged.post_status ?? null,
      merged.categories_json ?? null,
      merged.canonical_source_url ?? null,
      merged.official_pdf_url ?? null,
      merged.publish_status,
      merged.validation_check_passed,
      merged.published_at ?? null,
      merged.updated_at ?? now,
      merged.payload_hash ?? null,
      merged.error_message ?? null,
      id
    );
    return merged;
  }

  findById(id: string): PublishingRecordEntity | null {
    const stmt = this.db.prepare('SELECT * FROM publishing_records WHERE id = ?');
    const row = stmt.get(id) as unknown as PublishingRecordEntity | undefined;
    return row ?? null;
  }

  findByJob(jobId: string): PublishingRecordEntity[] {
    const stmt = this.db.prepare('SELECT * FROM publishing_records WHERE job_id = ? ORDER BY updated_at DESC');
    return stmt.all(jobId) as unknown as PublishingRecordEntity[];
  }

  findByRecruitment(recruitmentId: string): PublishingRecordEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_records WHERE recruitment_id = ? OR job_id = ? ORDER BY updated_at DESC'
    );
    return stmt.all(recruitmentId, recruitmentId) as unknown as PublishingRecordEntity[];
  }

  findByExternalIdentity(platform: string, externalIdentityKey: string): PublishingRecordEntity | null {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_records WHERE platform = ? AND external_identity_key = ? ORDER BY updated_at DESC LIMIT 1'
    );
    const row = stmt.get(platform, externalIdentityKey) as unknown as PublishingRecordEntity | undefined;
    return row ?? null;
  }

  findByExternalPostId(platform: string, externalPostId: string): PublishingRecordEntity | null {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_records WHERE platform = ? AND external_post_id = ? ORDER BY updated_at DESC LIMIT 1'
    );
    const row = stmt.get(platform, externalPostId) as unknown as PublishingRecordEntity | undefined;
    return row ?? null;
  }

  listRecent(limit = 50): PublishingRecordEntity[] {
    const stmt = this.db.prepare('SELECT * FROM publishing_records ORDER BY updated_at DESC LIMIT ?');
    return stmt.all(limit) as unknown as PublishingRecordEntity[];
  }
}

export class SqliteExtractionAuditRepository implements IExtractionAuditRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(record: ExtractionAuditEntity): ExtractionAuditEntity {
    const stmt = this.db.prepare(`
      INSERT INTO extraction_audit_records (id, document_id, recruitment_id, field, old_value, new_value, evidence_id, validation_status, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.document_id,
      record.recruitment_id ?? null,
      record.field,
      record.old_value ?? null,
      record.new_value ?? null,
      record.evidence_id ?? null,
      record.validation_status,
      record.reason,
      record.timestamp
    );
    return record;
  }

  listByDocument(documentId: string): ExtractionAuditEntity[] {
    const stmt = this.db.prepare('SELECT * FROM extraction_audit_records WHERE document_id = ? ORDER BY timestamp ASC');
    return stmt.all(documentId) as unknown as ExtractionAuditEntity[];
  }

  listByRecruitment(recruitmentId: string): ExtractionAuditEntity[] {
    const stmt = this.db.prepare('SELECT * FROM extraction_audit_records WHERE recruitment_id = ? ORDER BY timestamp ASC');
    return stmt.all(recruitmentId) as unknown as ExtractionAuditEntity[];
  }
}

export class SqliteCorrigendumAssociationRepository implements ICorrigendumAssociationRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(record: CorrigendumAssociationEntity): CorrigendumAssociationEntity {
    const stmt = this.db.prepare(`
      INSERT INTO corrigendum_associations (id, original_recruitment_id, corrigendum_document_id, related_document_id, amendment_type, updated_field, source_page, old_value, new_value, evidence_snippet, effective_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.original_recruitment_id ?? null,
      record.corrigendum_document_id,
      record.related_document_id ?? null,
      record.amendment_type,
      record.updated_field,
      record.source_page,
      record.old_value ?? null,
      record.new_value,
      record.evidence_snippet,
      record.effective_date ?? null,
      record.created_at
    );
    return record;
  }

  listByOriginalRecruitment(recruitmentId: string): CorrigendumAssociationEntity[] {
    const stmt = this.db.prepare('SELECT * FROM corrigendum_associations WHERE original_recruitment_id = ? ORDER BY created_at ASC');
    return stmt.all(recruitmentId) as unknown as CorrigendumAssociationEntity[];
  }

  listByCorrigendumDocument(documentId: string): CorrigendumAssociationEntity[] {
    const stmt = this.db.prepare('SELECT * FROM corrigendum_associations WHERE corrigendum_document_id = ? ORDER BY created_at ASC');
    return stmt.all(documentId) as unknown as CorrigendumAssociationEntity[];
  }
}

export class SqliteDeduplicationEvaluationRepository implements IDeduplicationEvaluationRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(record: Omit<DeduplicationEvaluationEntity, 'created_at'>): DeduplicationEvaluationEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO deduplication_evaluations (
        id, incoming_document_id, matched_document_id, matched_recruitment_id,
        decision, confidence, matched_fields_json, reason, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.incoming_document_id,
      record.matched_document_id ?? null,
      record.matched_recruitment_id ?? null,
      record.decision,
      record.confidence,
      record.matched_fields_json,
      record.reason,
      record.details_json ?? null,
      now
    );
    return { ...record, created_at: now };
  }

  findByIncomingDocument(documentId: string): DeduplicationEvaluationEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM deduplication_evaluations WHERE incoming_document_id = ? ORDER BY created_at DESC'
    );
    return stmt.all(documentId) as unknown as DeduplicationEvaluationEntity[];
  }

  findByMatchedRecruitment(recruitmentId: string): DeduplicationEvaluationEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM deduplication_evaluations WHERE matched_recruitment_id = ? ORDER BY created_at DESC'
    );
    return stmt.all(recruitmentId) as unknown as DeduplicationEvaluationEntity[];
  }

  listRecent(limit = 50): DeduplicationEvaluationEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM deduplication_evaluations ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(limit) as unknown as DeduplicationEvaluationEntity[];
  }
}

export class SqlitePublishingGateEvaluationRepository implements IPublishingGateEvaluationRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(evaluation: Omit<PublishingGateEvaluationEntity, 'evaluated_at'>): PublishingGateEvaluationEntity {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO publishing_gate_evaluations (
        id, recruitment_id, decision, gate_state, reasons_json,
        critical_failures_json, warnings_json, summary_json, validation_version, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      evaluation.id,
      evaluation.recruitment_id,
      evaluation.decision,
      evaluation.gate_state,
      evaluation.reasons_json,
      evaluation.critical_failures_json,
      evaluation.warnings_json,
      evaluation.summary_json,
      evaluation.validation_version,
      now
    );
    return { ...evaluation, evaluated_at: now };
  }

  findByRecruitment(recruitmentId: string): PublishingGateEvaluationEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_gate_evaluations WHERE recruitment_id = ? ORDER BY evaluated_at DESC'
    );
    return stmt.all(recruitmentId) as unknown as PublishingGateEvaluationEntity[];
  }

  findLatestByRecruitment(recruitmentId: string): PublishingGateEvaluationEntity | null {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_gate_evaluations WHERE recruitment_id = ? ORDER BY evaluated_at DESC LIMIT 1'
    );
    return (stmt.get(recruitmentId) as unknown as PublishingGateEvaluationEntity) || null;
  }

  listRecent(limit = 50): PublishingGateEvaluationEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM publishing_gate_evaluations ORDER BY evaluated_at DESC LIMIT ?'
    );
    return stmt.all(limit) as unknown as PublishingGateEvaluationEntity[];
  }
}

export class SqliteSourceDiscoveryRunRepository implements ISourceDiscoveryRunRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(run: SourceDiscoveryRunEntity): SourceDiscoveryRunEntity {
    const stmt = this.db.prepare(`
      INSERT INTO source_discovery_runs (
        id, source_id, started_at, completed_at, http_status,
        final_url, records_found, documents_found, adapter_status,
        error_code, error_message, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.id,
      run.source_id,
      run.started_at,
      run.completed_at,
      run.http_status ?? null,
      run.final_url ?? null,
      run.records_found,
      run.documents_found,
      run.adapter_status,
      run.error_code ?? null,
      run.error_message ?? null,
      run.metrics_json ?? null
    );
    return run;
  }

  findById(id: string): SourceDiscoveryRunEntity | null {
    const stmt = this.db.prepare('SELECT * FROM source_discovery_runs WHERE id = ?');
    return (stmt.get(id) as unknown as SourceDiscoveryRunEntity) || null;
  }

  listBySource(sourceId: string, limit = 50): SourceDiscoveryRunEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM source_discovery_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?'
    );
    return stmt.all(sourceId, limit) as unknown as SourceDiscoveryRunEntity[];
  }

  listRecent(limit = 50): SourceDiscoveryRunEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM source_discovery_runs ORDER BY started_at DESC LIMIT ?'
    );
    return stmt.all(limit) as unknown as SourceDiscoveryRunEntity[];
  }

  findLatestBySource(sourceId: string): SourceDiscoveryRunEntity | null {
    const stmt = this.db.prepare(
      'SELECT * FROM source_discovery_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1'
    );
    return (stmt.get(sourceId) as unknown as SourceDiscoveryRunEntity) || null;
  }
}

export class SqliteOcrCacheRepository implements IOcrCacheRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  save(entry: Omit<OcrPageCacheEntity, 'created_at'>): OcrPageCacheEntity {
    const now = new Date().toISOString();
    const id = entry.id || crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO ocr_page_cache (
        id, document_checksum, page_number, provider, model_version,
        extracted_text, language, model_confidence, quality_score,
        confidence_source, status, char_count, word_count, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_checksum, page_number, provider, model_version) DO UPDATE SET
        extracted_text = excluded.extracted_text,
        language = excluded.language,
        model_confidence = excluded.model_confidence,
        quality_score = excluded.quality_score,
        confidence_source = excluded.confidence_source,
        status = excluded.status,
        char_count = excluded.char_count,
        word_count = excluded.word_count,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at
    `);
    stmt.run(
      id,
      entry.document_checksum,
      entry.page_number,
      entry.provider,
      entry.model_version,
      entry.extracted_text,
      entry.language,
      entry.model_confidence ?? null,
      entry.quality_score,
      entry.confidence_source,
      entry.status,
      entry.char_count,
      entry.word_count,
      entry.metadata_json ?? null,
      now
    );
    return {
      ...entry,
      id,
      created_at: now,
    };
  }

  findByKey(
    documentChecksum: string,
    pageNumber: number,
    provider: string,
    modelVersion: string
  ): OcrPageCacheEntity | null {
    const stmt = this.db.prepare(
      'SELECT * FROM ocr_page_cache WHERE document_checksum = ? AND page_number = ? AND provider = ? AND model_version = ? LIMIT 1'
    );
    return (stmt.get(documentChecksum, pageNumber, provider, modelVersion) as unknown as OcrPageCacheEntity) || null;
  }

  listByDocument(documentChecksum: string): OcrPageCacheEntity[] {
    const stmt = this.db.prepare(
      'SELECT * FROM ocr_page_cache WHERE document_checksum = ? ORDER BY page_number ASC'
    );
    return stmt.all(documentChecksum) as unknown as OcrPageCacheEntity[];
  }

  clear(): void {
    this.db.exec('DELETE FROM ocr_page_cache;');
  }
}




