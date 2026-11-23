/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../../src/backend/database/index.ts';
import {
  SqliteAuditLogRepository,
  SqliteProcessingJobRepository,
} from '../../src/backend/database/repositories/sqlite-repositories.ts';
import { AuditService } from '../../src/backend/audit/audit-service.ts';
import { JobService } from '../../src/backend/jobs/job-service.ts';
import { PipelineEngine } from '../../src/backend/pipeline/engine.ts';
import { ORDERED_PIPELINE_STAGES } from '../../src/backend/pipeline/stages.ts';
import { logger } from '../../src/backend/config/logger.ts';
import {
  SchedulerService,
  resolveSchedulerConfig,
} from '../../src/backend/scheduler/index.ts';
import type { IPipelineStageHandler } from '../../src/backend/pipeline/contracts.ts';
import type { PipelineStageName } from '../../src/backend/database/types.ts';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Scheduler Core & Durable Job Claiming Tests', () => {
  let db: DatabaseSync;
  let jobRepo: SqliteProcessingJobRepository;
  let auditService: AuditService;
  let jobService: JobService;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:', forceNew: true });
    jobRepo = new SqliteProcessingJobRepository(db);
    auditService = new AuditService(new SqliteAuditLogRepository(db));
    jobService = new JobService(jobRepo, auditService);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('should resolve scheduler configuration from environment variables without hard-coded production values', () => {
    const cfg = resolveSchedulerConfig({
      AUTOMATION_MODE: 'scheduled',
      POLL_INTERVAL_SECONDS: '45',
      MAX_CONCURRENT_JOBS: '5',
    });

    assert.equal(cfg.automationMode, 'scheduled');
    assert.equal(cfg.pollIntervalSeconds, 45);
    assert.equal(cfg.maxConcurrentJobs, 5);
    assert.ok(cfg.workerId.startsWith('scheduler-'));

    const continuousCfg = resolveSchedulerConfig({
      AUTOMATION_MODE: 'continuous',
      POLL_INTERVAL_SECONDS: '15',
      MAX_CONCURRENT_JOBS: '3',
    });
    assert.equal(continuousCfg.automationMode, 'continuous');
    assert.equal(continuousCfg.pollIntervalSeconds, 15);
    assert.equal(continuousCfg.maxConcurrentJobs, 3);
  });

  it('should atomically claim a PENDING job, transition to RUNNING, and record worker & claim time', () => {
    const created = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'upsc-portal',
      initialStage: 'SOURCE_DISCOVERY',
    });

    assert.equal(created.status, 'PENDING');
    assert.equal(created.claimed_by ?? null, null);
    assert.equal(created.claimed_at ?? null, null);

    const claimed = jobService.claimJob(created.job_id, 'worker-alpha');
    assert.ok(claimed);
    assert.equal(claimed.job_id, created.job_id);
    assert.equal(claimed.status, 'RUNNING');
    assert.equal(claimed.claimed_by, 'worker-alpha');
    assert.ok(claimed.claimed_at);
    assert.ok(claimed.started_at);
    assert.ok(claimed.lease_expires_at);
    assert.equal(claimed.attempts, 1);

    const logs = auditService.getByEntity('PROCESSING_JOB', created.job_id);
    assert.ok(logs.some((l) => l.action === 'JOB_CLAIMED' && l.actor === 'worker-alpha'));
  });

  it('should never allow the same job to be claimed twice', () => {
    const created = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'ssc-portal',
      initialStage: 'SOURCE_DISCOVERY',
    });

    const firstClaim = jobService.claimJob(created.job_id, 'worker-1');
    const secondClaim = jobService.claimJob(created.job_id, 'worker-2');

    assert.ok(firstClaim);
    assert.equal(secondClaim, null);

    const persisted = jobService.getJob(created.job_id)!;
    assert.equal(persisted.status, 'RUNNING');
    assert.equal(persisted.claimed_by, 'worker-1');
    assert.equal(persisted.attempts, 1);
  });

  it('should allow only one winner across two concurrent claim attempts (in-process & multi-connection file DB)', async () => {
    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'bpsc-portal',
      initialStage: 'SOURCE_DISCOVERY',
    });

    const [a, b] = await Promise.all([
      Promise.resolve().then(() => jobService.claimJob(job.job_id, 'concurrent-worker-A')),
      Promise.resolve().then(() => jobService.claimJob(job.job_id, 'concurrent-worker-B')),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]!.status, 'RUNNING');

    // Multi-connection file-backed SQLite concurrency verification
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-claim-test-'));
    const dbFile = path.join(tmpDir, 'concurrent-claim.db');
    try {
      const schemaSql = fs.readFileSync(
        path.resolve('src/backend/database/schema.sql'),
        'utf-8'
      );
      const db1 = new DatabaseSync(dbFile);
      db1.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      db1.exec(schemaSql);

      const db2 = new DatabaseSync(dbFile);
      db2.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

      const repo1 = new SqliteProcessingJobRepository(db1);
      const repo2 = new SqliteProcessingJobRepository(db2);

      const sharedJob = repo1.create({
        target_entity_type: 'SOURCE',
        target_entity_id: 'rrb-portal',
        stage: 'SOURCE_DISCOVERY',
      });

      const [c1, c2] = await Promise.all([
        Promise.resolve().then(() => repo1.claimJob(sharedJob.job_id, 'conn-worker-1')),
        Promise.resolve().then(() => repo2.claimJob(sharedJob.job_id, 'conn-worker-2')),
      ]);

      const connWinners = [c1, c2].filter((r) => r !== null);
      assert.equal(connWinners.length, 1);
      assert.equal(connWinners[0]!.status, 'RUNNING');

      db1.close();
      db2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should strictly respect MAX_CONCURRENT_JOBS at both scheduler and database claim levels', async () => {
    const gate = createDeferred();
    let maxObservedConcurrent = 0;
    let currentConcurrent = 0;

    const engine = new PipelineEngine(jobService, auditService, logger);
    const blockingHandler: IPipelineStageHandler = {
      stageName: 'WORDPRESS_PUBLISH',
      async execute() {
        currentConcurrent += 1;
        if (currentConcurrent > maxObservedConcurrent) {
          maxObservedConcurrent = currentConcurrent;
        }
        await gate.promise;
        currentConcurrent -= 1;
        return { success: true, output: { ok: true } };
      },
    };
    engine.registerStageHandler(blockingHandler);

    const createdIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = jobService.createJob({
        targetEntityType: 'RECRUITMENT',
        targetEntityId: `rec-${i}`,
        initialStage: 'WORDPRESS_PUBLISH',
      });
      createdIds.push(job.job_id);
    }

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '30',
        MAX_CONCURRENT_JOBS: '2',
      },
      config: { workerId: 'worker-concurrency-test' },
    });

    const firstPoll = await scheduler.pollOnce();
    assert.equal(firstPoll.claimedJobIds.length, 2);
    assert.equal(firstPoll.activeCount, 2);
    assert.equal(jobService.countRunningJobs(), 2);

    // Second poll while 2 jobs are still running must NOT exceed MAX_CONCURRENT_JOBS
    const secondPoll = await scheduler.pollOnce();
    assert.equal(secondPoll.claimedJobIds.length, 0);
    assert.equal(secondPoll.activeCount, 2);

    // Independent worker claiming with maxConcurrentJobs=2 must also be blocked
    const extraClaim = jobService.claimNextPendingJob('worker-other', { maxConcurrentJobs: 2 });
    assert.equal(extraClaim, null);

    // Release blocking jobs and drain remaining jobs
    gate.resolve();
    await scheduler.waitForIdle();
    assert.equal(maxObservedConcurrent, 2);

    const thirdPoll = await scheduler.pollOnce();
    assert.equal(thirdPoll.claimedJobIds.length, 2);
    await scheduler.waitForIdle();

    const fourthPoll = await scheduler.pollOnce();
    assert.equal(fourthPoll.claimedJobIds.length, 1);
    await scheduler.waitForIdle();

    for (const id of createdIds) {
      assert.equal(jobService.getJob(id)!.status, 'COMPLETED');
    }
  });

  it('should invoke existing PipelineEngine after claim without bypassing stages or fake-completing', async () => {
    const executedStages: PipelineStageName[] = [];
    const engine = new PipelineEngine(jobService, auditService, logger);

    // Register handlers for PUBLISHING_GATE and WORDPRESS_PUBLISH only
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

    const multiStageJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-pipeline-order-01',
      initialStage: 'PUBLISHING_GATE',
      metadata: { recruitmentId: 'rec-pipeline-order-01' },
    });

    // Unhandled earlier stage must fail safely instead of bypassing or fake-completing
    const unhandledJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'src-unhandled-01',
      initialStage: 'SOURCE_DISCOVERY',
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '4',
      },
    });

    const poll = await scheduler.pollOnce();
    assert.equal(poll.claimedJobIds.length, 2);
    await scheduler.waitForIdle();

    assert.deepEqual(executedStages, ['PUBLISHING_GATE', 'WORDPRESS_PUBLISH']);

    const finishedMulti = jobService.getJob(multiStageJob.job_id)!;
    assert.equal(finishedMulti.status, 'COMPLETED');
    assert.equal(finishedMulti.stage, 'WORDPRESS_PUBLISH');

    const failedUnhandled = jobService.getJob(unhandledJob.job_id)!;
    assert.equal(failedUnhandled.status, 'FAILED');
    assert.equal(failedUnhandled.error_code, 'STAGE_NOT_IMPLEMENTED');
    assert.notEqual(failedUnhandled.status, 'COMPLETED');
    assert.equal(ORDERED_PIPELINE_STAGES.length, 10);
  });

  it('should leave claimed job in RUNNING/stale state (never falsely COMPLETED) if process stops mid-execution', async () => {
    const startedGate = createDeferred();
    const neverFinishingGate = createDeferred();

    const engine = new PipelineEngine(jobService, auditService, logger);
    engine.registerStageHandler({
      stageName: 'SOURCE_DISCOVERY',
      async execute() {
        startedGate.resolve();
        await neverFinishingGate.promise;
        return { success: true };
      },
    });

    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'crash-safety-source',
      initialStage: 'SOURCE_DISCOVERY',
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '1',
      },
      config: {
        workerId: 'worker-crash-sim',
        leaseDurationMs: 1000,
      },
    });

    await scheduler.pollOnce();
    await startedGate.promise;

    // Simulate abrupt process stop (do not wait for in-flight handler)
    await scheduler.stop(false);

    const persisted = jobService.getJob(job.job_id)!;
    assert.equal(persisted.status, 'RUNNING');
    assert.equal(persisted.claimed_by, 'worker-crash-sim');
    assert.ok(persisted.claimed_at);
    assert.equal(persisted.completed_at, null);

    // Identifiable as stale once lease expiry timestamp has passed
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const staleJobs = jobService.listStaleRunningJobs(futureIso);
    assert.equal(staleJobs.length, 1);
    assert.equal(staleJobs[0].job_id, job.job_id);

    // Clean up background promise after assertions
    neverFinishingGate.resolve();
    await scheduler.waitForIdle();
  });

  it('should remain idle in manual mode when start() is called', async () => {
    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'manual-mode-source',
      initialStage: 'SOURCE_DISCOVERY',
    });

    const engine = new PipelineEngine(jobService, auditService, logger);
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '1',
        MAX_CONCURRENT_JOBS: '1',
      },
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));

    // In manual mode, start() must not auto-claim jobs
    assert.equal(jobService.getJob(job.job_id)!.status, 'PENDING');
    await scheduler.stop(true);
  });
});
