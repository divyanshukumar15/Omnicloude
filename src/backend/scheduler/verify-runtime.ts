/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../config/logger.ts';
import { isDatabaseInitialized } from '../database/index.ts';
import { AuditService } from '../audit/audit-service.ts';
import { SqliteAuditLogRepository, SqliteProcessingJobRepository } from '../database/repositories/sqlite-repositories.ts';
import { getDatabase } from '../database/index.ts';
import { JobService } from '../jobs/job-service.ts';
import { PipelineEngine } from '../pipeline/engine.ts';
import {
  getSchedulerRuntimeHealth,
  resetSchedulerRuntimeState,
  type SchedulerServiceDependencies,
} from './index.ts';
import { startServerRuntime, type ServerRuntimeHandle } from '../runtime/server-runtime.ts';

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
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

export async function verifySchedulerRuntime(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-verify-scheduler-'));
  const dbPath = path.join(tmpDir, 'scheduler-runtime-verify.db');

  let runtime: ServerRuntimeHandle | null = null;
  let dbReadyBeforeScheduler = false;
  const executedStages: Array<{ jobId: string; stage: string }> = [];

  try {
    let fixtureJobService!: JobService;
    let fixtureEngine!: PipelineEngine;

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
      JOB_LEASE_MS: '10000',
      HEARTBEAT_INTERVAL_MS: '2000',
    };

    // Build controlled fixture PipelineEngine once database is ready
    runtime = await startServerRuntime({
      rawEnv,
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      exitOnShutdown: false,
      onDatabaseInitialized: () => {
        dbReadyBeforeScheduler = isDatabaseInitialized();
        assert.equal(
          getSchedulerRuntimeHealth(rawEnv).running,
          false,
          'Scheduler must not be running before database initialization completes'
        );

        const db = getDatabase();
        const auditService = new AuditService(new SqliteAuditLogRepository(db));
        fixtureJobService = new JobService(new SqliteProcessingJobRepository(db), auditService);
        fixtureEngine = new PipelineEngine(fixtureJobService, auditService, logger);
        fixtureEngine.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute(_input, context) {
            executedStages.push({ jobId: context.jobId, stage: 'WORDPRESS_PUBLISH' });
            return {
              success: true,
              output: { verifiedByRuntimeScript: true },
            };
          },
        });
      },
      schedulerDeps: {
        get jobService() {
          return fixtureJobService;
        },
        get pipelineEngine() {
          return fixtureEngine;
        },
      } as SchedulerServiceDependencies,
    });

    assert.equal(dbReadyBeforeScheduler, true, 'Database must be initialized before scheduler');
    assert.equal(
      runtime.schedulerInit.started,
      true,
      'Scheduler must start automatically when AUTOMATION_MODE=scheduled'
    );

    const { url } = runtime.getAddress();

    // 1. Verify runtime health & status endpoints expose live scheduler state
    const healthRes = await fetch(`${url}/api/health`);
    assert.equal(healthRes.status, 200, 'Expected /api/health to return 200');
    const healthBody = (await healthRes.json()) as {
      status: string;
      scheduler: Record<string, unknown>;
    };
    assert.equal(healthBody.status, 'healthy');
    assert.equal(healthBody.scheduler.running, true);
    assert.equal(healthBody.scheduler.readiness, 'READY');
    assert.equal(healthBody.scheduler.automationMode, 'scheduled');
    assert.ok(typeof healthBody.scheduler.workerId === 'string' && healthBody.scheduler.workerId.length > 0);

    // 2. Insert a PENDING processing job and wait for automatic scheduled poll (no manual pollOnce)
    const createdJob = fixtureJobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'runtime-verify-job-01',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    await waitForCondition(
      () => fixtureJobService.getJob(createdJob.job_id)?.status === 'COMPLETED',
      6000,
      'scheduled poll to claim and complete pending job via PipelineEngine'
    );

    const completedJob = fixtureJobService.getJob(createdJob.job_id)!;
    assert.equal(completedJob.status, 'COMPLETED');
    assert.equal(completedJob.attempts, 1);
    assert.equal(completedJob.claimed_by, healthBody.scheduler.workerId);
    assert.ok(
      executedStages.some((e) => e.jobId === createdJob.job_id && e.stage === 'WORDPRESS_PUBLISH'),
      'PipelineEngine handler must be invoked for claimed job'
    );

    // 3. Re-query /api/status to confirm real runtime counters updated
    const statusRes = await fetch(`${url}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as {
      system_status: string;
      scheduler: {
        running: boolean;
        automationMode: string;
        workerId: string;
        activeCount: number;
        dbRunningCount: number;
        lastPollAt: string | null;
        totalClaimedCount: number;
        totalRetriedCount: number;
        totalRecoveredCount: number;
      };
    };
    assert.equal(statusBody.system_status, 'OPERATIONAL');
    assert.equal(statusBody.scheduler.running, true);
    assert.equal(statusBody.scheduler.automationMode, 'scheduled');
    assert.ok(statusBody.scheduler.lastPollAt !== null, 'lastPollAt must be populated after poll');
    assert.ok(statusBody.scheduler.totalClaimedCount >= 1, 'totalClaimedCount must be >= 1');
    assert.equal(statusBody.scheduler.activeCount, 0);
    assert.equal(statusBody.scheduler.dbRunningCount, 0);

    // 4. Verify graceful shutdown stops scheduler, closes server, and closes database
    await runtime.shutdown('VERIFY_SHUTDOWN');
    const postShutdownHealth = getSchedulerRuntimeHealth(rawEnv);
    assert.equal(postShutdownHealth.running, false, 'Scheduler must be stopped after shutdown');
    assert.equal(runtime.server.listening, false, 'HTTP server must be closed after shutdown');
    assert.equal(isDatabaseInitialized(), false, 'Database must be closed after shutdown');
    runtime = null;

    console.log(
      JSON.stringify({
        verify_scheduler_runtime: 'PASS',
        db_init_before_scheduler: true,
        auto_started: true,
        job_claimed_and_completed: true,
        pipeline_invoked: true,
        shutdown_clean: true,
        workerId: healthBody.scheduler.workerId,
        totalClaimedCount: statusBody.scheduler.totalClaimedCount,
      })
    );
  } finally {
    if (runtime) {
      await runtime.shutdown('CLEANUP').catch(() => undefined);
    }
    resetSchedulerRuntimeState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedScript.endsWith(path.join('src', 'backend', 'scheduler', 'verify-runtime.ts'))) {
  verifySchedulerRuntime().catch((err) => {
    logger.error('Scheduler runtime verification FAILED', err);
    process.exit(1);
  });
}
