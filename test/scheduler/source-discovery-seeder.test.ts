/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDatabase,
  getDatabase,
  getRepositories,
  closeDatabase,
} from '../../src/backend/database/index.ts';
import {
  SqliteAuditLogRepository,
  SqliteProcessingJobRepository,
} from '../../src/backend/database/repositories/sqlite-repositories.ts';
import { AuditService } from '../../src/backend/audit/audit-service.ts';
import {
  JobService,
  getJobService,
  buildSourceDiscoveryDedupeKey,
} from '../../src/backend/jobs/index.ts';
import { PipelineEngine } from '../../src/backend/pipeline/engine.ts';
import { SourceDiscoveryStageHandler } from '../../src/backend/pipeline/ingestion-handlers.ts';
import { sourceRegistry } from '../../src/backend/ingestion/adapters/registry.ts';
import { BaseSourceAdapter } from '../../src/backend/ingestion/adapters/base-adapter.ts';
import type { SourceHealthResult } from '../../src/backend/ingestion/adapters/source-adapter.interface.ts';
import type {
  DiscoveredDocument,
  DiscoveredNotice,
  NormalizedDocument,
} from '../../src/backend/ingestion/types.ts';
import { logger } from '../../src/backend/config/logger.ts';
import {
  SourceDiscoverySeeder,
  stopScheduler,
  resetSchedulerRuntimeState,
  getSchedulerRuntimeHealth,
  type SchedulerRuntimeDependencies,
} from '../../src/backend/scheduler/index.ts';
import {
  startServerRuntime,
  type ServerRuntimeHandle,
} from '../../src/backend/runtime/server-runtime.ts';

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

class SeederFixtureAdapter extends BaseSourceAdapter {
  readonly sourceId: string;
  readonly name: string;
  readonly jurisdiction = 'CENTRAL' as const;
  readonly baseUrl: string;
  private readonly notices: DiscoveredNotice[];

  constructor(sourceId: string, name: string, baseUrl: string, notices: DiscoveredNotice[]) {
    super();
    this.sourceId = sourceId;
    this.name = name;
    this.baseUrl = baseUrl;
    this.notices = notices;
  }

  async healthCheck(): Promise<SourceHealthResult> {
    return {
      sourceId: this.sourceId,
      authorityName: this.name,
      jurisdiction: this.jurisdiction,
      baseUrl: this.baseUrl,
      officialDomains: this.officialDomains,
      status: 'HEALTHY',
      healthState: 'UP',
      verifiedLive: true,
      httpStatus: 200,
      latencyMs: 1,
      message: 'Fixture official portal reachable',
      checkedAt: new Date().toISOString(),
    };
  }

  async discoverNotices(): Promise<DiscoveredNotice[]> {
    return this.notices;
  }

  async discoverDocuments(): Promise<DiscoveredDocument[]> {
    return [];
  }

  async normalizeDocument(doc: NormalizedDocument): Promise<NormalizedDocument> {
    return doc;
  }

  parseNotices() {
    return { notices: [], structureIntact: true };
  }
}

describe('Automatic Source Discovery Seeder & Scheduler Lifecycle Tests', () => {
  const activeHandles: ServerRuntimeHandle[] = [];
  const tempDirs: string[] = [];
  const registeredAdapters: string[] = [];

  function createTempDbPath(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return path.join(dir, 'seeder-test.db');
  }

  function createSource(params: {
    id: string;
    name?: string;
    isActive?: number;
    checkIntervalMinutes?: number;
    baseUrl?: string;
  }) {
    return getRepositories().sources.create({
      id: params.id,
      name: params.name ?? params.id,
      type: 'PORTAL',
      base_url: params.baseUrl ?? 'https://ssc.gov.in',
      is_active: params.isActive ?? 1,
      check_interval_minutes: params.checkIntervalMinutes ?? 60,
      config_json: '{}',
    });
  }

  function recordDiscoveryRun(sourceId: string, completedAtIso: string) {
    return getRepositories().sourceDiscoveryRuns.create({
      id: crypto.randomUUID(),
      source_id: sourceId,
      started_at: completedAtIso,
      completed_at: completedAtIso,
      http_status: 200,
      final_url: 'https://ssc.gov.in/notices',
      records_found: 2,
      documents_found: 2,
      adapter_status: 'SUCCESS_WITH_NOTICES',
      error_code: null,
      error_message: null,
      metrics_json: '{}',
    });
  }

  afterEach(async () => {
    while (activeHandles.length > 0) {
      const handle = activeHandles.pop()!;
      await handle.shutdown('TEST_AFTER_EACH').catch(() => undefined);
    }
    while (registeredAdapters.length > 0) {
      sourceRegistry.unregister(registeredAdapters.pop()!);
    }
    await stopScheduler(false).catch(() => undefined);
    resetSchedulerRuntimeState();
    closeDatabase();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('[PASS] active source with no previous run creates SOURCE_DISCOVERY job and ignores inactive sources', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-ACTIVE-1', name: 'SSC Official', isActive: 1, checkIntervalMinutes: 30 });
    createSource({ id: 'SRC-INACTIVE-1', name: 'Inactive Source', isActive: 0, checkIntervalMinutes: 15 });

    const nowMs = Date.parse('2026-11-20T10:00:00.000Z');
    const seeder = new SourceDiscoverySeeder({
      nowFn: () => nowMs,
      config: { enabled: true, maxAttempts: 3 },
    });

    const result = await seeder.seedDueSources();
    assert.equal(result.evaluatedSources, 1);
    assert.equal(result.queuedCount, 1);
    assert.equal(result.duplicatePreventedCount, 0);
    assert.equal(result.decisions[0].outcome, 'QUEUED');
    assert.equal(result.decisions[0].sourceId, 'SRC-ACTIVE-1');

    const jobs = getJobService().listJobsByTarget('SOURCE', 'SRC-ACTIVE-1', 'SOURCE_DISCOVERY');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'PENDING');
    assert.equal(jobs[0].stage, 'SOURCE_DISCOVERY');
    assert.equal(jobs[0].dedupe_key, buildSourceDiscoveryDedupeKey('SRC-ACTIVE-1', 30, nowMs));

    // Inactive source must never be queued
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-INACTIVE-1').length, 0);

    const status = seeder.getStatus();
    assert.equal(status.queuedCount, 1);
    assert.equal(status.duplicatePreventedCount, 0);
    assert.equal(status.lastSeedAt, new Date(nowMs).toISOString());
    assert.equal(status.lastError, null);
  });

  it('[PASS] active source with recent successful run creates no job and exposes truthful nextDueSource', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-RECENT', name: 'UPSC Official', checkIntervalMinutes: 45 });

    const runAtMs = Date.parse('2026-11-20T10:00:00.000Z');
    const nowMs = Date.parse('2026-11-20T10:20:00.000Z'); // Only 20m elapsed < 45m
    recordDiscoveryRun('SRC-RECENT', new Date(runAtMs).toISOString());

    const seeder = new SourceDiscoverySeeder({ nowFn: () => nowMs });
    const result = await seeder.seedDueSources();

    assert.equal(result.queuedCount, 0);
    assert.equal(result.decisions[0].outcome, 'SKIPPED_INTERVAL_NOT_ELAPSED');
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-RECENT').length, 0);

    const status = seeder.getStatus();
    assert.ok(status.nextDueSource);
    assert.equal(status.nextDueSource.sourceId, 'SRC-RECENT');
    assert.equal(status.nextDueSource.checkIntervalMinutes, 45);
    assert.equal(status.nextDueSource.nextDueAt, '2026-11-20T10:45:00.000Z');
  });

  it('[PASS] interval elapsed creates a new discovery job for the next scheduling window respecting per-source check_interval_minutes', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    // Non-60m interval (15 minutes) proves check_interval_minutes is authoritative
    createSource({ id: 'SRC-CUSTOM-15M', name: 'RRB Fast Interval', checkIntervalMinutes: 15 });

    const t0 = Date.parse('2026-11-20T10:00:00.000Z');
    let currentNow = t0;
    const seeder = new SourceDiscoverySeeder({ nowFn: () => currentNow });

    // Cycle 1 at 10:00
    const pass1 = await seeder.seedDueSources();
    assert.equal(pass1.queuedCount, 1);
    const job1Id = pass1.decisions[0].jobId!;
    const job1Key = pass1.decisions[0].dedupeKey!;

    // Complete job1 and record durable source_discovery_runs history at 10:01
    const jobService = getJobService();
    jobService.startJob(job1Id);
    jobService.completeJob(job1Id);
    const run1CompletedAt = '2026-11-20T10:01:00.000Z';
    getDatabase()
      .prepare('UPDATE processing_jobs SET completed_at = ?, updated_at = ? WHERE job_id = ?')
      .run(run1CompletedAt, run1CompletedAt, job1Id);
    recordDiscoveryRun('SRC-CUSTOM-15M', run1CompletedAt);

    // At 10:10 (only 9m elapsed < 15m) -> must NOT queue
    currentNow = Date.parse('2026-11-20T10:10:00.000Z');
    const passTooEarly = await seeder.seedDueSources();
    assert.equal(passTooEarly.queuedCount, 0);
    assert.equal(passTooEarly.decisions[0].outcome, 'SKIPPED_INTERVAL_NOT_ELAPSED');

    // At 10:16:01 (15m+ elapsed) -> MUST queue a brand new job with new deterministic window key
    currentNow = Date.parse('2026-11-20T10:16:01.000Z');
    const pass2 = await seeder.seedDueSources();
    assert.equal(pass2.queuedCount, 1);
    const job2Id = pass2.decisions[0].jobId!;
    const job2Key = pass2.decisions[0].dedupeKey!;

    assert.notEqual(job2Id, job1Id);
    assert.notEqual(job2Key, job1Key);
    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-CUSTOM-15M', 'SOURCE_DISCOVERY').length, 2);
  });

  it('[PASS] existing PENDING, RUNNING, and PAUSED discovery jobs prevent duplicate seeding', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-PENDING', checkIntervalMinutes: 10 });
    createSource({ id: 'SRC-RUNNING', checkIntervalMinutes: 10 });
    createSource({ id: 'SRC-PAUSED', checkIntervalMinutes: 10 });

    const jobService = getJobService();

    // PENDING job
    jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'SRC-PENDING',
      initialStage: 'SOURCE_DISCOVERY',
    });

    // RUNNING job
    const runningJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'SRC-RUNNING',
      initialStage: 'SOURCE_DISCOVERY',
    });
    jobService.startJob(runningJob.job_id);

    // PAUSED job (e.g. AWAITING_CHILDREN after fan-out)
    const pausedJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'SRC-PAUSED',
      initialStage: 'SOURCE_DISCOVERY',
    });
    jobService.startJob(pausedJob.job_id);
    jobService.awaitChildJobs(pausedJob.job_id, {
      childJobIds: ['child-notice-job-1'],
      createdChildJobIds: ['child-notice-job-1'],
      dedupedChildJobIds: [],
      fanOutStage: 'SOURCE_DISCOVERY',
      childInitialStage: 'DOCUMENT_DISCOVERY',
    });

    const seeder = new SourceDiscoverySeeder({
      nowFn: () => Date.parse('2026-11-20T12:00:00.000Z'),
    });
    const pass = await seeder.seedDueSources();

    assert.equal(pass.evaluatedSources, 3);
    assert.equal(pass.queuedCount, 0);
    assert.equal(pass.duplicatePreventedCount, 3);
    for (const d of pass.decisions) {
      assert.equal(d.outcome, 'SKIPPED_ACTIVE_JOB');
    }

    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-PENDING').length, 1);
    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-RUNNING').length, 1);
    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-PAUSED').length, 1);
  });

  it('[PASS] failed retryable job preserves existing retry policy without creating a duplicate job', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-RETRYABLE', checkIntervalMinutes: 10 });
    createSource({ id: 'SRC-TERMINAL-PERM', checkIntervalMinutes: 10 });

    const jobService = getJobService();

    // 1. Transient failure with attempts (1) < maxAttempts (3) -> retryable, MUST NOT be bypassed
    const transientJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'SRC-RETRYABLE',
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: 3,
    });
    jobService.startJob(transientJob.job_id);
    jobService.failJob(transientJob.job_id, 'SOURCE_UNAVAILABLE', 'Upstream 503 temporary outage');
    // Even if completed_at is old, retryable failed job must still block duplicate seeding
    getDatabase()
      .prepare('UPDATE processing_jobs SET completed_at = ?, updated_at = ? WHERE job_id = ?')
      .run('2026-11-20T08:00:00.000Z', '2026-11-20T08:00:00.000Z', transientJob.job_id);

    // 2. Permanent terminal failure whose interval HAS elapsed -> eligible for next scheduled cycle
    const permJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'SRC-TERMINAL-PERM',
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: 3,
    });
    jobService.startJob(permJob.job_id);
    jobService.failJob(permJob.job_id, 'INVALID_INPUT', 'Permanent failure from prior cycle');
    getDatabase()
      .prepare('UPDATE processing_jobs SET completed_at = ?, updated_at = ? WHERE job_id = ?')
      .run('2026-11-20T08:00:00.000Z', '2026-11-20T08:00:00.000Z', permJob.job_id);

    const seeder = new SourceDiscoverySeeder({
      nowFn: () => Date.parse('2026-11-20T12:00:00.000Z'),
      config: { maxAttempts: 3 },
    });
    const pass = await seeder.seedDueSources();

    const retryDecision = pass.decisions.find((d) => d.sourceId === 'SRC-RETRYABLE')!;
    const permDecision = pass.decisions.find((d) => d.sourceId === 'SRC-TERMINAL-PERM')!;

    assert.equal(retryDecision.outcome, 'SKIPPED_RETRYABLE_FAILED_JOB');
    assert.equal(permDecision.outcome, 'QUEUED');
    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-RETRYABLE').length, 1);
    assert.equal(jobService.listJobsByTarget('SOURCE', 'SRC-TERMINAL-PERM').length, 2);
  });

  it('[PASS] two concurrent seeder calls create only one job via deterministic window idempotency', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-CONCURRENT', checkIntervalMinutes: 30 });

    const nowMs = Date.parse('2026-11-20T11:00:00.000Z');
    const seederA = new SourceDiscoverySeeder({ nowFn: () => nowMs });
    const seederB = new SourceDiscoverySeeder({ nowFn: () => nowMs });

    const [resA, resB] = await Promise.all([
      seederA.seedDueSources(),
      seederB.seedDueSources(),
    ]);

    assert.equal(resA.queuedCount + resB.queuedCount, 1);
    assert.equal(resA.duplicatePreventedCount + resB.duplicatePreventedCount, 1);

    const jobs = getJobService().listJobsByTarget('SOURCE', 'SRC-CONCURRENT', 'SOURCE_DISCOVERY');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupe_key, buildSourceDiscoveryDedupeKey('SRC-CONCURRENT', 30, nowMs));
  });

  it('[PASS] different active sources receive independent discovery jobs', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-ALPHA', name: 'SSC', checkIntervalMinutes: 20 });
    createSource({ id: 'SRC-BETA', name: 'UPSC', checkIntervalMinutes: 60 });
    createSource({ id: 'SRC-GAMMA', name: 'BPSC', checkIntervalMinutes: 120 });

    const nowMs = Date.parse('2026-11-20T12:00:00.000Z');
    const seeder = new SourceDiscoverySeeder({ nowFn: () => nowMs });
    const pass = await seeder.seedDueSources();

    assert.equal(pass.evaluatedSources, 3);
    assert.equal(pass.queuedCount, 3);

    const jobService = getJobService();
    const alphaJobs = jobService.listJobsByTarget('SOURCE', 'SRC-ALPHA', 'SOURCE_DISCOVERY');
    const betaJobs = jobService.listJobsByTarget('SOURCE', 'SRC-BETA', 'SOURCE_DISCOVERY');
    const gammaJobs = jobService.listJobsByTarget('SOURCE', 'SRC-GAMMA', 'SOURCE_DISCOVERY');

    assert.equal(alphaJobs.length, 1);
    assert.equal(betaJobs.length, 1);
    assert.equal(gammaJobs.length, 1);
    assert.notEqual(alphaJobs[0].job_id, betaJobs[0].job_id);
    assert.notEqual(betaJobs[0].job_id, gammaJobs[0].job_id);
    assert.notEqual(alphaJobs[0].dedupe_key, betaJobs[0].dedupe_key);
  });

  it('[PASS] manual mode does NOT automatically seed jobs while scheduled and continuous modes seed and execute automatically', async () => {
    // 1. MANUAL MODE: must NOT automatically seed jobs
    const manualDbPath = createTempDbPath('omnihub-seeder-manual-');
    const manualRuntime = await startServerRuntime({
      rawEnv: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '3000',
        DATABASE_PATH: manualDbPath,
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '1',
        MAX_CONCURRENT_JOBS: '1',
      },
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        createSource({ id: 'SRC-MANUAL-ONLY', checkIntervalMinutes: 5 });
      },
    });
    activeHandles.push(manualRuntime);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(manualRuntime.schedulerInit.seeder, null);
    assert.equal(manualRuntime.schedulerInit.health.seeder.enabled, false);
    assert.equal(manualRuntime.schedulerInit.health.seeder.running, false);
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-MANUAL-ONLY').length, 0);

    await manualRuntime.shutdown('MANUAL_CHECK_DONE');

    // 2. SCHEDULED MODE: automatically seeds due source -> SchedulerService claims -> SourceDiscoveryStageHandler runs & records source_discovery_runs
    const scheduledDbPath = createTempDbPath('omnihub-seeder-scheduled-');
    const scheduledSourceId = 'IN-CENTRAL-SSC-AUTO-SCHED';
    let schedJobService!: JobService;
    let schedEngine!: PipelineEngine;

    sourceRegistry.register(
      new SeederFixtureAdapter(scheduledSourceId, 'SSC Scheduled Fixture', 'https://ssc.gov.in', [
        {
          id: 'notice-auto-sched-1',
          sourceId: scheduledSourceId,
          title: 'Auto Scheduled Notice 2026',
          noticeUrl: 'https://ssc.gov.in/notices/auto-sched-1',
        },
      ])
    );
    registeredAdapters.push(scheduledSourceId);

    const scheduledRuntime = await startServerRuntime({
      rawEnv: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        DATABASE_PATH: scheduledDbPath,
        AUTOMATION_MODE: 'scheduled',
        POLL_INTERVAL_SECONDS: '1',
        MAX_CONCURRENT_JOBS: '2',
      },
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        getDatabase().prepare('UPDATE sources SET is_active = 0').run();
        createSource({ id: scheduledSourceId, name: 'SSC Scheduled Fixture', checkIntervalMinutes: 30 });
        const db = getDatabase();
        const audit = new AuditService(new SqliteAuditLogRepository(db));
        schedJobService = new JobService(new SqliteProcessingJobRepository(db), audit);
        schedEngine = new PipelineEngine(schedJobService, audit, logger);
        schedEngine.registerStageHandler(new SourceDiscoveryStageHandler());
        // Lightweight downstream handlers so child job completes cleanly in this scheduler test
        schedEngine.registerStageHandler({
          stageName: 'DOCUMENT_DISCOVERY',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'DOCUMENT_DOWNLOAD',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'DOCUMENT_VALIDATION',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'TEXT_EXTRACTION',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'STRUCTURED_EXTRACTION',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'EVIDENCE_VALIDATION',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'DUPLICATE_CHECK',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'PUBLISHING_GATE',
          async execute() {
            return { success: true, output: {} };
          },
        });
        schedEngine.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute() {
            return { success: true, output: { published: true } };
          },
        });
      },
      schedulerDeps: {
        get jobService() {
          return schedJobService;
        },
        get pipelineEngine() {
          return schedEngine;
        },
        seederConfig: { seedIntervalMs: 100 },
      } as SchedulerRuntimeDependencies,
    });
    activeHandles.push(scheduledRuntime);

    // Wait for automatic seeding + SchedulerService execution with ZERO manual enqueue!
    await waitForCondition(
      () => {
        const srcJobs = schedJobService.listJobsByTarget('SOURCE', scheduledSourceId, 'SOURCE_DISCOVERY');
        return srcJobs.length === 1 && srcJobs[0].status === 'COMPLETED';
      },
      5000,
      'scheduled mode automatic source discovery seeding and completion'
    );

    // Verify durable source_discovery_runs history was recorded
    const latestRun = getRepositories().sourceDiscoveryRuns.findLatestBySource(scheduledSourceId);
    assert.ok(latestRun, 'SOURCE_DISCOVERY must persist durable source_discovery_runs history');
    assert.equal(latestRun.adapter_status, 'SUCCESS_WITH_NOTICES');
    assert.equal(latestRun.records_found, 1);

    // Verify no duplicate discovery job created on subsequent seeder ticks
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      schedJobService.listJobsByTarget('SOURCE', scheduledSourceId, 'SOURCE_DISCOVERY').length,
      1
    );

    // Verify truthful seeder status exposed on /api/health and /api/status
    const { url } = scheduledRuntime.getAddress();
    const healthRes = await fetch(`${url}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      scheduler: {
        seeder: {
          enabled: boolean;
          running: boolean;
          lastSeedAt: string | null;
          queuedCount: number;
          duplicatePreventedCount: number;
          lastError: string | null;
          nextDueSource: { sourceId: string; nextDueAt: string } | null;
        };
      };
    };
    assert.equal(healthJson.scheduler.seeder.enabled, true);
    assert.equal(healthJson.scheduler.seeder.running, true);
    assert.ok(healthJson.scheduler.seeder.lastSeedAt);
    assert.equal(healthJson.scheduler.seeder.queuedCount, 1);
    assert.equal(healthJson.scheduler.seeder.lastError, null);
    assert.equal(healthJson.scheduler.seeder.nextDueSource?.sourceId, scheduledSourceId);

    const statusRes = await fetch(`${url}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      scheduler: { seeder: { enabled: boolean; queuedCount: number } };
    };
    assert.equal(statusJson.scheduler.seeder.enabled, true);
    assert.equal(statusJson.scheduler.seeder.queuedCount, 1);

    await scheduledRuntime.shutdown('SCHEDULED_CHECK_DONE');

    // 3. CONTINUOUS MODE: automatically seeds and executes without manual enqueue
    const contDbPath = createTempDbPath('omnihub-seeder-continuous-');
    const contSourceId = 'IN-CENTRAL-UPSC-AUTO-CONT';
    let contJobService!: JobService;
    let contEngine!: PipelineEngine;
    const executedSources: string[] = [];

    const contRuntime = await startServerRuntime({
      rawEnv: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        DATABASE_PATH: contDbPath,
        AUTOMATION_MODE: 'continuous',
        POLL_INTERVAL_SECONDS: '1',
        MAX_CONCURRENT_JOBS: '1',
      },
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        getDatabase().prepare('UPDATE sources SET is_active = 0').run();
        createSource({ id: contSourceId, name: 'UPSC Continuous', checkIntervalMinutes: 60 });
        const db = getDatabase();
        const audit = new AuditService(new SqliteAuditLogRepository(db));
        contJobService = new JobService(new SqliteProcessingJobRepository(db), audit);
        contEngine = new PipelineEngine(contJobService, audit, logger);
        contEngine.registerStageHandler({
          stageName: 'SOURCE_DISCOVERY',
          async execute(input) {
            executedSources.push(String((input as { sourceId?: string }).sourceId));
            return { success: true, output: { discovered: true } };
          },
        });
        for (const stage of [
          'DOCUMENT_DISCOVERY',
          'DOCUMENT_DOWNLOAD',
          'DOCUMENT_VALIDATION',
          'TEXT_EXTRACTION',
          'STRUCTURED_EXTRACTION',
          'EVIDENCE_VALIDATION',
          'DUPLICATE_CHECK',
          'PUBLISHING_GATE',
          'WORDPRESS_PUBLISH',
        ] as const) {
          contEngine.registerStageHandler({
            stageName: stage,
            async execute() {
              return { success: true, output: {} };
            },
          });
        }
      },
      schedulerDeps: {
        get jobService() {
          return contJobService;
        },
        get pipelineEngine() {
          return contEngine;
        },
        seederConfig: { seedIntervalMs: 100 },
      } as SchedulerRuntimeDependencies,
    });
    activeHandles.push(contRuntime);

    await waitForCondition(
      () =>
        executedSources.includes(contSourceId) &&
        contJobService.listJobsByTarget('SOURCE', contSourceId)[0]?.status === 'COMPLETED',
      5000,
      'continuous mode automatic source discovery seeding and execution'
    );

    assert.equal(contRuntime.schedulerInit.health.seeder.enabled, true);
    assert.equal(contRuntime.schedulerInit.health.seeder.running, true);
    assert.equal(contJobService.listJobsByTarget('SOURCE', contSourceId).length, 1);
  });

  it('[PASS] graceful shutdown stops seeder idempotently and prevents job creation after shutdown begins', async () => {
    // 1. Direct idempotent start/stop and post-shutdown guard
    initDatabase({ path: ':memory:', forceNew: true });
    createSource({ id: 'SRC-SHUTDOWN-DIRECT', checkIntervalMinutes: 5 });

    const seeder = new SourceDiscoverySeeder({
      config: { enabled: true, seedIntervalMs: 40 },
    });

    // Idempotent start (must not create duplicate timers or duplicate jobs)
    seeder.start();
    seeder.start();
    assert.equal(seeder.getStatus().running, true);
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-SHUTDOWN-DIRECT').length, 1);

    // Stop idempotently
    await seeder.stop();
    await seeder.stop();
    assert.equal(seeder.getStatus().running, false);
    assert.equal(seeder.getStatus().stopping, true);

    // Add a second active source AFTER shutdown began -> seeder must NOT create jobs
    createSource({ id: 'SRC-AFTER-SHUTDOWN', checkIntervalMinutes: 5 });
    const postStopPass = await seeder.seedDueSources();
    assert.equal(postStopPass.queuedCount, 0);
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-AFTER-SHUTDOWN').length, 0);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(getJobService().listJobsByTarget('SOURCE', 'SRC-AFTER-SHUTDOWN').length, 0);
    closeDatabase();

    // 2. Runtime SIGTERM graceful shutdown stops seeder cleanly
    const dbPath = createTempDbPath('omnihub-seeder-sigterm-');
    const rawEnv = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: dbPath,
      AUTOMATION_MODE: 'scheduled',
      POLL_INTERVAL_SECONDS: '1',
      MAX_CONCURRENT_JOBS: '1',
    };

    const runtime = await startServerRuntime({
      rawEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: true,
      exitOnShutdown: false,
      schedulerDeps: {
        seederConfig: { seedIntervalMs: 50 },
      },
    });
    activeHandles.push(runtime);

    assert.equal(runtime.schedulerInit.seeder?.getStatus().running, true);

    process.emit('SIGTERM', 'SIGTERM');

    await waitForCondition(
      () => !runtime.server.listening && getSchedulerRuntimeHealth(rawEnv).seeder.running === false,
      5000,
      'SIGTERM graceful shutdown to stop source discovery seeder'
    );

    assert.equal(getSchedulerRuntimeHealth(rawEnv).running, false);
    assert.equal(getSchedulerRuntimeHealth(rawEnv).seeder.running, false);
  });
});
