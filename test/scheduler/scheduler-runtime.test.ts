/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDatabase,
  closeDatabase,
  isDatabaseInitialized,
} from '../../src/backend/database/index.ts';
import {
  SqliteAuditLogRepository,
  SqliteProcessingJobRepository,
} from '../../src/backend/database/repositories/sqlite-repositories.ts';
import { AuditService } from '../../src/backend/audit/audit-service.ts';
import { JobService } from '../../src/backend/jobs/job-service.ts';
import { PipelineEngine } from '../../src/backend/pipeline/engine.ts';
import { logger } from '../../src/backend/config/logger.ts';
import {
  initializeSchedulerRuntime,
  getSchedulerRuntimeHealth,
  stopScheduler,
  resetSchedulerRuntimeState,
  type SchedulerServiceDependencies,
} from '../../src/backend/scheduler/index.ts';
import {
  startServerRuntime,
  type ServerRuntimeHandle,
} from '../../src/backend/runtime/server-runtime.ts';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

describe('Scheduler Production Startup & Runtime Integration Tests', () => {
  const activeHandles: ServerRuntimeHandle[] = [];
  const tempDirs: string[] = [];

  function createTempDbPath(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return path.join(dir, 'runtime-test.db');
  }

  afterEach(async () => {
    while (activeHandles.length > 0) {
      const handle = activeHandles.pop()!;
      await handle.shutdown('TEST_AFTER_EACH').catch(() => undefined);
    }
    await stopScheduler(false).catch(() => undefined);
    resetSchedulerRuntimeState();
    closeDatabase();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('should auto-start scheduler in scheduled mode after DB init, poll, claim job via PipelineEngine, expose health/status, and shut down cleanly', async () => {
    const dbPath = createTempDbPath('omnihub-rt-scheduled-');
    const lifecycleOrder: string[] = [];
    const executedStages: string[] = [];

    let jobService!: JobService;
    let engine!: PipelineEngine;

    const rawEnv: Record<string, string> = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: dbPath,
      LOG_LEVEL: 'info',
      AUTOMATION_MODE: 'scheduled',
      POLL_INTERVAL_SECONDS: '1',
      MAX_CONCURRENT_JOBS: '2',
      MAX_RETRIES: '1',
      RETRY_BACKOFF_MS: '50',
      JOB_LEASE_MS: '5000',
      HEARTBEAT_INTERVAL_MS: '1000',
    };

    const runtime = await startServerRuntime({
      rawEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        assert.equal(isDatabaseInitialized(), true);
        assert.equal(getSchedulerRuntimeHealth(rawEnv).running, false);
        lifecycleOrder.push('DATABASE_INITIALIZED');

        const db = getDatabase();
        const auditService = new AuditService(new SqliteAuditLogRepository(db));
        jobService = new JobService(new SqliteProcessingJobRepository(db), auditService);
        engine = new PipelineEngine(jobService, auditService, logger);
        engine.registerStageHandler({
          stageName: 'PUBLISHING_GATE',
          async execute() {
            executedStages.push('PUBLISHING_GATE');
            return { success: true, output: { gatePassed: true } };
          },
        });
        engine.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute(input) {
            executedStages.push('WORDPRESS_PUBLISH');
            assert.equal((input as Record<string, unknown>).gatePassed, true);
            return { success: true, output: { published: true } };
          },
        });
      },
      schedulerDeps: {
        get jobService() {
          return jobService;
        },
        get pipelineEngine() {
          return engine;
        },
      } as SchedulerServiceDependencies,
    });
    activeHandles.push(runtime);
    lifecycleOrder.push('SERVER_STARTED');

    assert.equal(lifecycleOrder[0], 'DATABASE_INITIALIZED');
    assert.equal(runtime.schedulerInit.started, true);
    assert.equal(runtime.schedulerInit.health.running, true);
    assert.equal(runtime.schedulerInit.health.readiness, 'READY');
    assert.equal(runtime.schedulerInit.health.automationMode, 'scheduled');

    const { url } = runtime.getAddress();

    // Enqueue a PENDING job — scheduled poll must claim & complete it automatically
    const job = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'scheduled-runtime-01',
      initialStage: 'PUBLISHING_GATE',
    });

    await waitForCondition(
      () => jobService.getJob(job.job_id)?.status === 'COMPLETED',
      5000,
      'scheduled runtime to claim and complete job'
    );

    assert.deepEqual(executedStages, ['PUBLISHING_GATE', 'WORDPRESS_PUBLISH']);
    const persisted = jobService.getJob(job.job_id)!;
    assert.equal(persisted.status, 'COMPLETED');
    assert.equal(persisted.stage, 'WORDPRESS_PUBLISH');
    assert.equal(persisted.attempts, 1);

    // Check /api/health and /api/status real metrics
    const healthRes = await fetch(`${url}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      status: string;
      scheduler: Record<string, unknown>;
    };
    assert.equal(healthJson.status, 'healthy');
    assert.equal(healthJson.scheduler.running, true);
    assert.equal(healthJson.scheduler.automationMode, 'scheduled');
    // Public (unauthenticated) probes must not expose the scheduler worker identity.
    assert.equal(healthJson.scheduler.workerId, undefined);
    assert.equal(healthJson.scheduler.activeCount, 0);
    assert.equal(healthJson.scheduler.dbRunningCount, 0);
    assert.ok(healthJson.scheduler.lastPollAt);
    assert.equal(healthJson.scheduler.totalClaimedCount, 1);
    assert.equal(healthJson.scheduler.totalRetriedCount, 0);
    assert.equal(healthJson.scheduler.totalRecoveredCount, 0);

    const statusRes = await fetch(`${url}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      system_status: string;
      overall_readiness: string;
      scheduler: Record<string, unknown>;
    };
    assert.equal(statusJson.overall_readiness, 'NOT_READY');
    assert.equal(statusJson.system_status, 'NOT_READY');
    assert.equal(statusJson.scheduler.running, true);
    assert.equal(statusJson.scheduler.totalClaimedCount, 1);

    // Clean shutdown
    await runtime.shutdown('TEST_DONE');
    assert.equal(runtime.server.listening, false);
    assert.equal(isDatabaseInitialized(), false);
    assert.equal(getSchedulerRuntimeHealth(rawEnv).running, false);
  });

  it('should auto-start scheduler in continuous mode and NOT auto-start in manual mode', async () => {
    // 1. Manual mode check
    const manualDbPath = createTempDbPath('omnihub-rt-manual-');
    let manualJobService!: JobService;
    const manualEnv = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: manualDbPath,
      AUTOMATION_MODE: 'manual',
      POLL_INTERVAL_SECONDS: '1',
      MAX_CONCURRENT_JOBS: '1',
    };

    const manualRuntime = await startServerRuntime({
      rawEnv: manualEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        const db = getDatabase();
        const audit = new AuditService(new SqliteAuditLogRepository(db));
        manualJobService = new JobService(new SqliteProcessingJobRepository(db), audit);
      },
    });
    activeHandles.push(manualRuntime);

    assert.equal(manualRuntime.schedulerInit.started, false);
    assert.equal(manualRuntime.schedulerInit.health.running, false);
    assert.equal(manualRuntime.schedulerInit.health.readiness, 'MANUAL');

    const pendingJob = manualJobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'manual-stay-pending',
      initialStage: 'SOURCE_DISCOVERY',
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(manualJobService.getJob(pendingJob.job_id)!.status, 'PENDING');

    const manualHealthRes = await fetch(`${manualRuntime.getAddress().url}/api/health`);
    assert.equal(manualHealthRes.status, 200);
    const manualHealth = (await manualHealthRes.json()) as {
      scheduler: { running: boolean; readiness: string; automationMode: string };
    };
    assert.equal(manualHealth.scheduler.running, false);
    assert.equal(manualHealth.scheduler.readiness, 'MANUAL');
    assert.equal(manualHealth.scheduler.automationMode, 'manual');

    await manualRuntime.shutdown('MANUAL_DONE');

    // 2. Continuous mode check
    const contDbPath = createTempDbPath('omnihub-rt-continuous-');
    let contJobService!: JobService;
    let contEngine!: PipelineEngine;
    const contEnv = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: contDbPath,
      AUTOMATION_MODE: 'continuous',
      POLL_INTERVAL_SECONDS: '1',
      MAX_CONCURRENT_JOBS: '1',
    };

    const contRuntime = await startServerRuntime({
      rawEnv: contEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        const db = getDatabase();
        const audit = new AuditService(new SqliteAuditLogRepository(db));
        contJobService = new JobService(new SqliteProcessingJobRepository(db), audit);
        contEngine = new PipelineEngine(contJobService, audit, logger);
        contEngine.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute() {
            return { success: true, output: { mode: 'continuous' } };
          },
        });
      },
      schedulerDeps: {
        get jobService() {
          return contJobService;
        },
        get pipelineEngine() {
          return contEngine;
        },
      } as SchedulerServiceDependencies,
    });
    activeHandles.push(contRuntime);

    assert.equal(contRuntime.schedulerInit.started, true);
    assert.equal(contRuntime.schedulerInit.health.automationMode, 'continuous');
    assert.equal(contRuntime.schedulerInit.health.running, true);

    const contJob = contJobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'continuous-job-01',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    await waitForCondition(
      () => contJobService.getJob(contJob.job_id)?.status === 'COMPLETED',
      4000,
      'continuous scheduler loop to process pending job'
    );
  });

  it('should expose NOT_READY/FAILED status and refuse to report fake OPERATIONAL status if scheduler initialization fails or DB is missing', async () => {
    // 1. Direct DB-order check: initializeSchedulerRuntime before DB init must fail safely
    closeDatabase();
    resetSchedulerRuntimeState();
    const noDbResult = initializeSchedulerRuntime({
      rawEnv: { AUTOMATION_MODE: 'scheduled', POLL_INTERVAL_SECONDS: '1' },
    });
    assert.equal(noDbResult.started, false);
    assert.ok(noDbResult.error?.includes('Database must be initialized'));
    assert.equal(noDbResult.health.status, 'FAILED');
    assert.equal(noDbResult.health.readiness, 'NOT_READY');
    assert.equal(noDbResult.health.running, false);
    resetSchedulerRuntimeState();

    // 2. Server runtime with failing scheduler initialization (invalid scheduler config in deps)
    const failDbPath = createTempDbPath('omnihub-rt-fail-');
    const serverEnv = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: failDbPath,
      AUTOMATION_MODE: 'scheduled',
      POLL_INTERVAL_SECONDS: '5',
    };

    const failRuntime = await startServerRuntime({
      rawEnv: serverEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      schedulerDeps: {
        rawEnv: {
          AUTOMATION_MODE: 'scheduled',
          POLL_INTERVAL_SECONDS: 'invalid-non-numeric-interval',
        },
      },
    });
    activeHandles.push(failRuntime);

    assert.equal(failRuntime.schedulerInit.started, false);
    assert.ok(failRuntime.schedulerInit.error);
    assert.equal(failRuntime.schedulerInit.health.status, 'FAILED');
    assert.equal(failRuntime.schedulerInit.health.readiness, 'NOT_READY');
    assert.equal(failRuntime.schedulerInit.health.running, false);

    const { url } = failRuntime.getAddress();
    const healthRes = await fetch(`${url}/api/health`);
    assert.equal(healthRes.status, 503);
    const healthJson = (await healthRes.json()) as {
      status: string;
      scheduler: { status: string; readiness: string; running: boolean; error: string | null };
    };
    assert.equal(healthJson.status, 'unhealthy');
    assert.equal(healthJson.scheduler.status, 'FAILED');
    assert.equal(healthJson.scheduler.readiness, 'NOT_READY');
    assert.equal(healthJson.scheduler.running, false);
    assert.ok(healthJson.scheduler.error);

    const statusRes = await fetch(`${url}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      system_status: string;
      scheduler: { status: string; readiness: string; running: boolean };
    };
    assert.equal(statusJson.system_status, 'DEGRADED');
    assert.equal(statusJson.scheduler.status, 'FAILED');
    assert.equal(statusJson.scheduler.readiness, 'NOT_READY');
    assert.equal(statusJson.scheduler.running, false);
  });

  it('should handle SIGTERM cleanly once, stop accepting work, await in-flight job, and close database without duplicate handlers', async () => {
    const dbPath = createTempDbPath('omnihub-rt-sigterm-');
    const startedGate = createDeferred();
    const releaseGate = createDeferred();
    let jobService!: JobService;
    let engine!: PipelineEngine;

    const rawEnv = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_PATH: dbPath,
      AUTOMATION_MODE: 'scheduled',
      POLL_INTERVAL_SECONDS: '1',
      MAX_CONCURRENT_JOBS: '1',
      JOB_LEASE_MS: '5000',
      HEARTBEAT_INTERVAL_MS: '50',
    };

    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const runtime = await startServerRuntime({
      rawEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: true,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        const db = getDatabase();
        const audit = new AuditService(new SqliteAuditLogRepository(db));
        jobService = new JobService(new SqliteProcessingJobRepository(db), audit);
        engine = new PipelineEngine(jobService, audit, logger);
        engine.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute() {
            startedGate.resolve();
            await releaseGate.promise;
            return { success: true, output: { graceful: true } };
          },
        });
      },
      schedulerDeps: {
        get jobService() {
          return jobService;
        },
        get pipelineEngine() {
          return engine;
        },
      } as SchedulerServiceDependencies,
    });
    activeHandles.push(runtime);

    // Exactly one handler added per signal
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
    assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1);

    const inFlightJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'sigterm-inflight-01',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    await startedGate.promise;

    // Trigger SIGTERM; listener fires idempotent shutdown once
    process.emit('SIGTERM', 'SIGTERM');
    // Immediately check that scheduler is stopping and handlers are cleaned up
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
    assert.equal(process.listenerCount('SIGINT'), sigintBefore);
    assert.equal(runtime.server.listening, true);

    // Second job created after shutdown started must NOT be claimed
    const postShutdownJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'sigterm-rejected-02',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    // Release in-flight job and allow graceful shutdown to finish
    releaseGate.resolve();

    await waitForCondition(
      () => !runtime.server.listening && !isDatabaseInitialized(),
      5000,
      'SIGTERM graceful shutdown to close HTTP server and database'
    );

    // Verify in-flight job completed and second job was never claimed by opening DB briefly
    const { DatabaseSync } = await import('node:sqlite');
    const verifyDb = new DatabaseSync(dbPath);
    try {
      const verifyRepo = new SqliteProcessingJobRepository(verifyDb);
      assert.equal(verifyRepo.findById(inFlightJob.job_id)!.status, 'COMPLETED');
      assert.equal(verifyRepo.findById(postShutdownJob.job_id)!.status, 'PENDING');
    } finally {
      verifyDb.close();
    }
  });
});
