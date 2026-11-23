/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { logger } from '../config/logger.ts';
import { getRepositories, isDatabaseInitialized } from '../database/index.ts';
import type {
  ISourceDiscoveryRunRepository,
  ISourceRepository,
} from '../database/repositories/contracts.ts';
import type { ProcessingJobEntity, SourceEntity } from '../database/types.ts';
import {
  buildSourceDiscoveryDedupeKey,
  getJobService,
  type JobService,
} from '../jobs/index.ts';
import { getAuditService, type AuditService } from '../audit/index.ts';
import {
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
} from '../ingestion/discovery/acquisition-runner.ts';
import { classifyJobFailure } from './retry-policy.ts';
import type {
  NextDueSourceSummary,
  SourceDiscoverySeederStatus,
} from './types.ts';

export interface SourceDiscoverySeederConfig {
  enabled: boolean;
  seedIntervalMs: number;
  maxAttempts: number;
  actor: string;
}

export interface SourceDiscoverySeederDependencies {
  jobService?: JobService;
  sourceRepo?: ISourceRepository;
  discoveryRunRepo?: ISourceDiscoveryRunRepository;
  auditService?: AuditService;
  config?: Partial<SourceDiscoverySeederConfig>;
  nowFn?: () => number;
  onJobsQueued?: (queuedCount: number) => void;
}

export type SourceDiscoverySeedOutcome =
  | 'QUEUED'
  | 'SKIPPED_ACTIVE_JOB'
  | 'SKIPPED_RETRYABLE_FAILED_JOB'
  | 'SKIPPED_INTERVAL_NOT_ELAPSED'
  | 'SKIPPED_DEDUPED';

export interface SourceDiscoverySeedDecision {
  sourceId: string;
  sourceName: string;
  checkIntervalMinutes: number;
  outcome: SourceDiscoverySeedOutcome;
  jobId: string | null;
  dedupeKey: string | null;
  nextDueAt: string | null;
  reason: string;
}

export interface SourceDiscoverySeedPassResult {
  seededAt: string;
  evaluatedSources: number;
  queuedCount: number;
  duplicatePreventedCount: number;
  decisions: SourceDiscoverySeedDecision[];
  error: string | null;
}

const ACTIVE_JOB_STATUSES = new Set(['PENDING', 'RUNNING', 'PAUSED']);
const TERMINAL_JOB_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function parseIsoTimestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveIntervalMinutes(source: SourceEntity): number {
  const raw = Number(source.check_interval_minutes);
  if (!Number.isFinite(raw) || raw < 1) {
    return 60;
  }
  return Math.floor(raw);
}

/**
 * Production-safe automatic source discovery seeder.
 *
 * Responsibilities:
 * - Reads active sources from the existing `sources` table (`is_active = 1`).
 * - Evaluates durable due state from `source_discovery_runs` and `processing_jobs`
 *   using per-source `sources.check_interval_minutes`.
 * - Enqueues `SOURCE_DISCOVERY` jobs via existing `JobService` with deterministic
 *   source + scheduling-window idempotency keys.
 * - Never executes source discovery directly; `SchedulerService` remains the sole
 *   execution engine.
 */
export class SourceDiscoverySeeder {
  private readonly explicitJobService?: JobService;
  private readonly explicitSourceRepo?: ISourceRepository;
  private readonly explicitDiscoveryRunRepo?: ISourceDiscoveryRunRepository;
  private readonly explicitAuditService?: AuditService;
  private readonly config: SourceDiscoverySeederConfig;
  private readonly nowFn: () => number;
  private readonly onJobsQueued?: (queuedCount: number) => void;

  private running = false;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightSeedPromise: Promise<SourceDiscoverySeedPassResult> | null = null;

  private lastSeedAt: string | null = null;
  private queuedCount = 0;
  private duplicatePreventedCount = 0;
  private lastError: string | null = null;

  constructor(deps: SourceDiscoverySeederDependencies = {}) {
    this.explicitJobService = deps.jobService;
    this.explicitSourceRepo = deps.sourceRepo;
    this.explicitDiscoveryRunRepo = deps.discoveryRunRepo;
    this.explicitAuditService = deps.auditService;
    this.nowFn = deps.nowFn ?? (() => Date.now());
    this.onJobsQueued = deps.onJobsQueued;

    const rawIntervalMs = deps.config?.seedIntervalMs ?? 30_000;
    const safeIntervalMs = Math.max(25, Math.floor(rawIntervalMs));

    this.config = {
      enabled: deps.config?.enabled ?? true,
      seedIntervalMs: safeIntervalMs,
      maxAttempts: Math.max(1, Math.floor(deps.config?.maxAttempts ?? 3)),
      actor: deps.config?.actor ?? 'SOURCE_DISCOVERY_SEEDER',
    };
  }

  private getJobServiceInstance(): JobService {
    return this.explicitJobService ?? getJobService();
  }

  private getSourceRepoInstance(): ISourceRepository {
    return this.explicitSourceRepo ?? getRepositories().sources;
  }

  private getDiscoveryRunRepoInstance(): ISourceDiscoveryRunRepository {
    return this.explicitDiscoveryRunRepo ?? getRepositories().sourceDiscoveryRuns;
  }

  private getAuditServiceInstance(): AuditService {
    return this.explicitAuditService ?? getAuditService();
  }

  private canAccessDatabase(): boolean {
    if (this.explicitSourceRepo && this.explicitDiscoveryRunRepo && this.explicitJobService) {
      return true;
    }
    return isDatabaseInitialized();
  }

  /**
   * Starts the periodic discovery seeder idempotently.
   * Does nothing if disabled (e.g. AUTOMATION_MODE=manual) or already running.
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Source discovery seeder start skipped because seeder is disabled (manual mode)');
      return;
    }

    if (this.running || this.timer !== null) {
      return;
    }

    this.stopping = false;
    this.running = true;

    logger.info('Starting automatic source discovery seeder', {
      seedIntervalMs: this.config.seedIntervalMs,
      maxAttempts: this.config.maxAttempts,
    });

    // Run an immediate initial pass so due sources are queued without waiting a full interval
    void this.seedDueSources();

    this.timer = setInterval(() => {
      if (this.stopping || !this.running) {
        return;
      }
      void this.seedDueSources();
    }, this.config.seedIntervalMs);
  }

  /**
   * Stops the seeder timer idempotently and prevents any further job creation.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlightSeedPromise) {
      try {
        await this.inFlightSeedPromise;
      } catch {
        // Errors are already captured in lastError
      }
    }

    logger.info('Automatic source discovery seeder stopped', {
      queuedCount: this.queuedCount,
      duplicatePreventedCount: this.duplicatePreventedCount,
    });
  }

  /**
   * Evaluates all active sources and queues SOURCE_DISCOVERY jobs for due sources.
   * Safe under concurrent calls thanks to active-job checks and atomic SQLite dedupe_key.
   */
  async seedDueSources(nowOverride?: Date | number): Promise<SourceDiscoverySeedPassResult> {
    const nowMs =
      nowOverride instanceof Date
        ? nowOverride.getTime()
        : typeof nowOverride === 'number'
          ? nowOverride
          : this.nowFn();
    const nowIso = new Date(nowMs).toISOString();

    if (this.stopping) {
      return {
        seededAt: nowIso,
        evaluatedSources: 0,
        queuedCount: 0,
        duplicatePreventedCount: 0,
        decisions: [],
        error: null,
      };
    }

    const passPromise = this.executeSeedPass(nowMs, nowIso);
    this.inFlightSeedPromise = passPromise;

    try {
      return await passPromise;
    } finally {
      if (this.inFlightSeedPromise === passPromise) {
        this.inFlightSeedPromise = null;
      }
    }
  }

  private async executeSeedPass(
    nowMs: number,
    nowIso: string
  ): Promise<SourceDiscoverySeedPassResult> {
    if (this.stopping) {
      return {
        seededAt: nowIso,
        evaluatedSources: 0,
        queuedCount: 0,
        duplicatePreventedCount: 0,
        decisions: [],
        error: null,
      };
    }

    if (!this.canAccessDatabase()) {
      return {
        seededAt: nowIso,
        evaluatedSources: 0,
        queuedCount: 0,
        duplicatePreventedCount: 0,
        decisions: [],
        error: null,
      };
    }

    const decisions: SourceDiscoverySeedDecision[] = [];
    let passQueued = 0;
    let passDuplicatePrevented = 0;

    try {
      const sourceRepo = this.getSourceRepoInstance();
      const discoveryRunRepo = this.getDiscoveryRunRepoInstance();
      const jobService = this.getJobServiceInstance();
      const activeSources = sourceRepo.listActive().filter((src) => src.is_active === 1);

      this.lastSeedAt = nowIso;

      for (const source of activeSources) {
        if (this.stopping) {
          break;
        }

        const decision = this.evaluateAndSeedSource(
          source,
          nowMs,
          nowIso,
          jobService,
          discoveryRunRepo
        );
        decisions.push(decision);

        if (decision.outcome === 'QUEUED') {
          passQueued += 1;
          this.queuedCount += 1;
        } else if (
          decision.outcome === 'SKIPPED_ACTIVE_JOB' ||
          decision.outcome === 'SKIPPED_RETRYABLE_FAILED_JOB' ||
          decision.outcome === 'SKIPPED_DEDUPED'
        ) {
          passDuplicatePrevented += 1;
          this.duplicatePreventedCount += 1;
        }
      }

      this.lastError = null;

      if (passQueued > 0 && !this.stopping) {
        this.onJobsQueued?.(passQueued);
      }

      return {
        seededAt: nowIso,
        evaluatedSources: activeSources.length,
        queuedCount: passQueued,
        duplicatePreventedCount: passDuplicatePrevented,
        decisions,
        error: null,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.lastError = errorMessage;
      this.lastSeedAt = nowIso;
      logger.error('Source discovery seeding pass failed', err);
      return {
        seededAt: nowIso,
        evaluatedSources: decisions.length,
        queuedCount: passQueued,
        duplicatePreventedCount: passDuplicatePrevented,
        decisions,
        error: errorMessage,
      };
    }
  }

  private evaluateAndSeedSource(
    source: SourceEntity,
    nowMs: number,
    nowIso: string,
    jobService: JobService,
    discoveryRunRepo: ISourceDiscoveryRunRepository
  ): SourceDiscoverySeedDecision {
    const intervalMinutes = resolveIntervalMinutes(source);
    const intervalMs = intervalMinutes * 60_000;

    // 1. Durable active-job & retryable-job protection for this source
    const sourceJobs = jobService.listJobsByTarget('SOURCE', source.id, undefined, 50);

    const activeJob = sourceJobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status));
    if (activeJob) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        outcome: 'SKIPPED_ACTIVE_JOB',
        jobId: activeJob.job_id,
        dedupeKey: activeJob.dedupe_key ?? null,
        nextDueAt: null,
        reason: `Active SOURCE_DISCOVERY job ${activeJob.job_id} already exists with status ${activeJob.status}`,
      };
    }

    // Preserve authoritative retry policy if latest SOURCE job is FAILED and retryable
    const latestSourceJob = sourceJobs[0] ?? null;
    if (latestSourceJob && this.isRetryableFailedJob(latestSourceJob)) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        outcome: 'SKIPPED_RETRYABLE_FAILED_JOB',
        jobId: latestSourceJob.job_id,
        dedupeKey: latestSourceJob.dedupe_key ?? null,
        nextDueAt: latestSourceJob.next_retry_at ?? null,
        reason: `Failed job ${latestSourceJob.job_id} is retryable under retry policy (attempt ${latestSourceJob.attempts}/${Math.min(latestSourceJob.max_attempts, this.config.maxAttempts)})`,
      };
    }

    // 2. Compute durable due time from source_discovery_runs and terminal SOURCE jobs
    const nextDueMs = this.computeSourceNextDueMs(
      source.id,
      intervalMs,
      nowMs,
      sourceJobs,
      discoveryRunRepo
    );

    if (nowMs < nextDueMs) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        outcome: 'SKIPPED_INTERVAL_NOT_ELAPSED',
        jobId: null,
        dedupeKey: null,
        nextDueAt: new Date(nextDueMs).toISOString(),
        reason: `Source discovery interval (${intervalMinutes}m) has not elapsed yet`,
      };
    }

    // 3. Guard against shutdown race immediately before creating job
    if (this.stopping) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        outcome: 'SKIPPED_INTERVAL_NOT_ELAPSED',
        jobId: null,
        dedupeKey: null,
        nextDueAt: new Date(nextDueMs).toISOString(),
        reason: 'Seeder shutdown in progress',
      };
    }

    // 4. Deterministic source + scheduling-window idempotency key and runtime runner intent
    const dedupeKey = buildSourceDiscoveryDedupeKey(source.id, intervalMinutes, nowMs);
    const correlationId = crypto.randomUUID();
    const requestedRunnerMode = resolveRunnerMode();
    const remoteRunnerConfigured = new HttpRemoteAcquisitionRunner().isConfigured();

    const { job, created } = jobService.createJobWithStatus({
      dedupeKey,
      targetEntityType: 'SOURCE',
      targetEntityId: source.id,
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: this.config.maxAttempts,
      actor: this.config.actor,
      correlationId,
      metadata: {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        scheduledBy: this.config.actor,
        scheduledAutomatically: true,
        scheduledWindowKey: dedupeKey,
        seededAt: nowIso,
        runnerMode: requestedRunnerMode,
        runnerIntent: requestedRunnerMode,
        remoteRunnerConfigured,
      },
    });

    if (!created) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        checkIntervalMinutes: intervalMinutes,
        outcome: 'SKIPPED_DEDUPED',
        jobId: job.job_id,
        dedupeKey,
        nextDueAt: new Date(nowMs + intervalMs).toISOString(),
        reason: `Deterministic discovery window already seeded (${dedupeKey})`,
      };
    }

    try {
      this.getAuditServiceInstance().record({
        correlationId,
        actor: this.config.actor,
        action: 'SOURCE_DISCOVERY_SEEDED',
        entityType: 'SOURCE',
        entityId: source.id,
        stage: 'SOURCE_DISCOVERY',
        status: 'SUCCESS',
        details: {
          jobId: job.job_id,
          sourceId: source.id,
          dedupeKey,
          scheduledBy: this.config.actor,
          scheduledAutomatically: true,
          scheduledWindowKey: dedupeKey,
          checkIntervalMinutes: intervalMinutes,
          seededAt: nowIso,
          runnerMode: requestedRunnerMode,
          runnerIntent: requestedRunnerMode,
          remoteRunnerConfigured,
        },
      });
    } catch {
      // Non-fatal audit failure
    }

    return {
      sourceId: source.id,
      sourceName: source.name,
      checkIntervalMinutes: intervalMinutes,
      outcome: 'QUEUED',
      jobId: job.job_id,
      dedupeKey,
      nextDueAt: new Date(nowMs + intervalMs).toISOString(),
      reason: 'Source discovery due; queued SOURCE_DISCOVERY processing job',
    };
  }

  private isRetryableFailedJob(job: ProcessingJobEntity): boolean {
    if (job.status !== 'FAILED') {
      return false;
    }
    const classification = classifyJobFailure(job.error_code, job.error_message);
    if (classification !== 'TRANSIENT') {
      return false;
    }
    const effectiveMaxAttempts = Math.min(job.max_attempts, this.config.maxAttempts);
    return job.attempts < effectiveMaxAttempts;
  }

  private computeSourceNextDueMs(
    sourceId: string,
    intervalMs: number,
    nowMs: number,
    sourceJobs: ProcessingJobEntity[],
    discoveryRunRepo: ISourceDiscoveryRunRepository
  ): number {
    const latestRun = discoveryRunRepo.findLatestBySource(sourceId);
    const lastRunMs = parseIsoTimestampMs(latestRun?.completed_at || latestRun?.started_at);

    const latestTerminalJob = sourceJobs.find((job) => TERMINAL_JOB_STATUSES.has(job.status));
    const lastTerminalJobMs = parseIsoTimestampMs(
      latestTerminalJob?.completed_at || latestTerminalJob?.updated_at
    );

    let lastActivityMs: number | null = null;
    if (lastRunMs !== null && lastTerminalJobMs !== null) {
      lastActivityMs = Math.max(lastRunMs, lastTerminalJobMs);
    } else if (lastRunMs !== null) {
      lastActivityMs = lastRunMs;
    } else if (lastTerminalJobMs !== null) {
      lastActivityMs = lastTerminalJobMs;
    }

    if (lastActivityMs === null) {
      return nowMs;
    }

    return lastActivityMs + intervalMs;
  }

  private computeNextDueSource(nowMs: number): NextDueSourceSummary | null {
    if (!this.canAccessDatabase()) {
      return null;
    }

    try {
      const sourceRepo = this.getSourceRepoInstance();
      const discoveryRunRepo = this.getDiscoveryRunRepoInstance();
      const jobService = this.getJobServiceInstance();
      const activeSources = sourceRepo.listActive().filter((src) => src.is_active === 1);

      let earliest: {
        sourceId: string;
        sourceName: string;
        checkIntervalMinutes: number;
        dueMs: number;
      } | null = null;

      for (const source of activeSources) {
        const intervalMinutes = resolveIntervalMinutes(source);
        const intervalMs = intervalMinutes * 60_000;
        const sourceJobs = jobService.listJobsByTarget('SOURCE', source.id, undefined, 20);

        // Sources with an active or retryable job already in flight aren't waiting to be seeded
        const hasActiveOrRetryable =
          sourceJobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status)) ||
          (sourceJobs[0] ? this.isRetryableFailedJob(sourceJobs[0]) : false);
        if (hasActiveOrRetryable) {
          continue;
        }

        const dueMs = this.computeSourceNextDueMs(
          source.id,
          intervalMs,
          nowMs,
          sourceJobs,
          discoveryRunRepo
        );

        if (!earliest || dueMs < earliest.dueMs) {
          earliest = {
            sourceId: source.id,
            sourceName: source.name,
            checkIntervalMinutes: intervalMinutes,
            dueMs,
          };
        }
      }

      if (!earliest) {
        return null;
      }

      return {
        sourceId: earliest.sourceId,
        sourceName: earliest.sourceName,
        checkIntervalMinutes: earliest.checkIntervalMinutes,
        nextDueAt: new Date(earliest.dueMs).toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns live, truthful seeder status with real counters and DB-derived next due source.
   */
  getStatus(nowOverride?: Date | number): SourceDiscoverySeederStatus {
    const nowMs =
      nowOverride instanceof Date
        ? nowOverride.getTime()
        : typeof nowOverride === 'number'
          ? nowOverride
          : this.nowFn();

    return {
      enabled: this.config.enabled,
      running: this.running,
      stopping: this.stopping,
      seedIntervalMs: this.config.seedIntervalMs,
      lastSeedAt: this.lastSeedAt,
      nextDueSource: this.computeNextDueSource(nowMs),
      queuedCount: this.queuedCount,
      duplicatePreventedCount: this.duplicatePreventedCount,
      lastError: this.lastError,
    };
  }
}
