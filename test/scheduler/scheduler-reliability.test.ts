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
import { logger } from '../../src/backend/config/logger.ts';
import {
  SchedulerService,
  classifyJobFailure,
  computeRetryBackoffMs,
} from '../../src/backend/scheduler/index.ts';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Scheduler Reliability (Retry, Backoff, Stale Recovery & Heartbeat) Tests', () => {
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

  it('should classify transient vs permanent failures and compute exponential backoff with jitter', () => {
    assert.equal(classifyJobFailure('TIMEOUT', 'Request timed out'), 'TRANSIENT');
    assert.equal(classifyJobFailure('NETWORK_ERROR', 'ECONNRESET'), 'TRANSIENT');
    assert.equal(classifyJobFailure('WP_RATE_LIMITED', 'HTTP 429'), 'TRANSIENT');

    assert.equal(classifyJobFailure('SSRF_BLOCKED', 'Private IP blocked'), 'PERMANENT');
    assert.equal(classifyJobFailure('PUBLISHING_GATE_BLOCKED', 'Missing fields'), 'PERMANENT');
    assert.equal(classifyJobFailure('VALIDATION_ERROR', 'Schema mismatch'), 'PERMANENT');
    assert.equal(classifyJobFailure('STAGE_NOT_IMPLEMENTED', 'No handler'), 'PERMANENT');

    // Exponential progression with bounded equal jitter [0.5 * exp, exp]
    const minJitter1 = computeRetryBackoffMs(1, 100, 5000, () => 0);
    const maxJitter1 = computeRetryBackoffMs(1, 100, 5000, () => 1);
    assert.equal(minJitter1, 50);
    assert.equal(maxJitter1, 100);

    const minJitter2 = computeRetryBackoffMs(2, 100, 5000, () => 0);
    const maxJitter2 = computeRetryBackoffMs(2, 100, 5000, () => 1);
    assert.equal(minJitter2, 100);
    assert.equal(maxJitter2, 200);

    const minJitter3 = computeRetryBackoffMs(3, 100, 5000, () => 0);
    const maxJitter3 = computeRetryBackoffMs(3, 100, 5000, () => 1);
    assert.equal(minJitter3, 200);
    assert.equal(maxJitter3, 400);

    // Cap enforcement
    const capped = computeRetryBackoffMs(10, 100, 500, () => 1);
    assert.equal(capped, 500);
  });

  it('should retry transient failure after backoff and complete on subsequent attempt', async () => {
    let callCount = 0;
    const engine = new PipelineEngine(jobService, auditService, logger);
    engine.registerStageHandler({
      stageName: 'WORDPRESS_PUBLISH',
      async execute() {
        callCount += 1;
        if (callCount === 1) {
          return {
            success: false,
            errorCode: 'TIMEOUT',
            errorMessage: 'Upstream WordPress request timed out',
          };
        }
        return { success: true, output: { wpPostId: 42 } };
      },
    });

    const job = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-transient-retry-01',
      initialStage: 'WORDPRESS_PUBLISH',
      maxAttempts: 3,
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      auditService,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '1',
        MAX_RETRIES: '2',
        RETRY_BACKOFF_MS: '60',
      },
      randomFn: () => 1, // deterministic 60ms backoff for attempt 1
    });

    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const afterAttempt1 = jobService.getJob(job.job_id)!;
    assert.equal(afterAttempt1.status, 'PENDING');
    assert.equal(afterAttempt1.attempts, 1);
    assert.equal(afterAttempt1.claimed_by, null);
    assert.ok(afterAttempt1.next_retry_at);
    assert.equal(afterAttempt1.error_code, 'TIMEOUT');

    // Immediate poll before backoff expires must NOT re-claim prematurely
    const prematurePoll = await scheduler.pollOnce();
    assert.equal(prematurePoll.claimedJobIds.length, 0);

    // Wait for backoff window to pass, then poll again
    await new Promise((r) => setTimeout(r, 80));
    const retryPoll = await scheduler.pollOnce();
    assert.deepEqual(retryPoll.claimedJobIds, [job.job_id]);
    await scheduler.waitForIdle();

    const finalJob = jobService.getJob(job.job_id)!;
    assert.equal(finalJob.status, 'COMPLETED');
    assert.equal(finalJob.attempts, 2);
    assert.equal(callCount, 2);

    const logs = auditService.getByEntity('PROCESSING_JOB', job.job_id);
    assert.ok(logs.some((l) => l.action === 'JOB_RETRY_SCHEDULED'));
    assert.ok(logs.some((l) => l.action === 'JOB_COMPLETED'));
  });

  it('should stop retrying after max_attempts and remain FAILED', async () => {
    let callCount = 0;
    const engine = new PipelineEngine(jobService, auditService, logger);
    engine.registerStageHandler({
      stageName: 'WORDPRESS_PUBLISH',
      async execute() {
        callCount += 1;
        return {
          success: false,
          errorCode: 'NETWORK_ERROR',
          errorMessage: 'ECONNRESET transient error',
        };
      },
    });

    const job = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-max-attempts-01',
      initialStage: 'WORDPRESS_PUBLISH',
      maxAttempts: 2,
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      auditService,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '1',
        MAX_RETRIES: '2',
        RETRY_BACKOFF_MS: '15',
      },
      randomFn: () => 0,
    });

    // Attempt 1 -> transient failure -> requeued as PENDING
    await scheduler.pollOnce();
    await scheduler.waitForIdle();
    assert.equal(jobService.getJob(job.job_id)!.status, 'PENDING');
    assert.equal(jobService.getJob(job.job_id)!.attempts, 1);

    await new Promise((r) => setTimeout(r, 30));

    // Attempt 2 (max_attempts = 2 reached) -> must stay FAILED
    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const exhausted = jobService.getJob(job.job_id)!;
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.attempts, 2);
    assert.equal(callCount, 2);

    // Further polls must NOT re-run exhausted job
    const afterExhaustedPoll = await scheduler.pollOnce();
    assert.equal(afterExhaustedPoll.claimedJobIds.length, 0);
    assert.equal(callCount, 2);

    const logs = auditService.getByEntity('PROCESSING_JOB', job.job_id);
    assert.ok(logs.some((l) => l.action === 'JOB_RETRY_SKIPPED'));
  });

  it('should never retry permanent validation or security failures', async () => {
    let callCount = 0;
    const engine = new PipelineEngine(jobService, auditService, logger);
    engine.registerStageHandler({
      stageName: 'DOCUMENT_DOWNLOAD',
      async execute() {
        callCount += 1;
        return {
          success: false,
          errorCode: 'SSRF_BLOCKED',
          errorMessage: 'Security violation: private IP redirect blocked',
        };
      },
    });

    const job = jobService.createJob({
      targetEntityType: 'SOURCE_DOCUMENT',
      targetEntityId: 'doc-ssrf-01',
      initialStage: 'DOCUMENT_DOWNLOAD',
      maxAttempts: 5,
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      auditService,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '1',
        MAX_RETRIES: '4',
        RETRY_BACKOFF_MS: '10',
      },
    });

    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const failed = jobService.getJob(job.job_id)!;
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.error_code, 'SSRF_BLOCKED');
    assert.equal(failed.next_retry_at ?? null, null);
    assert.equal(callCount, 1);
  });

  it('should atomically recover expired leases and never recover currently valid leases', () => {
    const expiredJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'stale-expired-src',
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: 3,
    });
    const exhaustedExpiredJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'stale-exhausted-src',
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: 1,
    });
    const activeValidJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'valid-lease-src',
      initialStage: 'SOURCE_DISCOVERY',
      maxAttempts: 3,
    });

    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const claimedExpired = jobService.claimJob(expiredJob.job_id, 'dead-worker-1', {
      leaseDurationMs: 1_000,
      nowIso: pastTime,
    });
    const claimedExhausted = jobService.claimJob(exhaustedExpiredJob.job_id, 'dead-worker-2', {
      leaseDurationMs: 1_000,
      nowIso: pastTime,
    });
    const claimedValid = jobService.claimJob(activeValidJob.job_id, 'healthy-worker-1', {
      leaseDurationMs: 300_000,
    });

    assert.ok(claimedExpired && claimedExhausted && claimedValid);

    const recovered = jobService.recoverStaleJobs();
    assert.equal(recovered.length, 2);

    const reQueued = jobService.getJob(expiredJob.job_id)!;
    assert.equal(reQueued.status, 'PENDING');
    assert.equal(reQueued.claimed_by, null);
    assert.equal(reQueued.claimed_at, null);
    assert.equal(reQueued.lease_expires_at, null);
    assert.equal(reQueued.recovery_count, 1);
    assert.ok(reQueued.last_recovery_reason?.includes('dead-worker-1'));

    const failedExhausted = jobService.getJob(exhaustedExpiredJob.job_id)!;
    assert.equal(failedExhausted.status, 'FAILED');
    assert.equal(failedExhausted.error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
    assert.equal(failedExhausted.recovery_count, 1);
    assert.ok(failedExhausted.completed_at);

    // Valid active lease MUST NOT be recovered
    const untouchedValid = jobService.getJob(activeValidJob.job_id)!;
    assert.equal(untouchedValid.status, 'RUNNING');
    assert.equal(untouchedValid.claimed_by, 'healthy-worker-1');
    assert.equal(untouchedValid.recovery_count ?? 0, 0);

    // Audit history preserved
    const staleLogs = auditService.getByEntity('PROCESSING_JOB', expiredJob.job_id);
    assert.ok(staleLogs.some((l) => l.action === 'JOB_STALE_RECOVERED'));
    assert.ok(staleLogs.some((l) => l.action === 'JOB_CLAIMED'));
  });

  it('should extend lease via heartbeat, reject wrong worker renewal, and stop heartbeat after completion', async () => {
    // 1. Direct ownership & expired-lease renewal checks
    const authCheckJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'lease-ownership-check',
      initialStage: 'SOURCE_DISCOVERY',
    });
    const claimed = jobService.claimJob(authCheckJob.job_id, 'owner-worker', {
      leaseDurationMs: 5000,
    })!;
    const initialLeaseMs = Date.parse(claimed.lease_expires_at!);

    // Wrong worker cannot renew
    const wrongWorkerRenew = jobService.renewLease(authCheckJob.job_id, 'wrong-worker', 10_000);
    assert.equal(wrongWorkerRenew, null);
    const afterWrongRenew = jobService.getJob(authCheckJob.job_id)!;
    assert.equal(afterWrongRenew.lease_expires_at, claimed.lease_expires_at);
    assert.equal(afterWrongRenew.last_heartbeat_at ?? null, null);

    // Audit log recorded lease renewal failure
    const failAudit = auditService.getByEntity('PROCESSING_JOB', authCheckJob.job_id);
    assert.ok(failAudit.some((l) => l.action === 'JOB_LEASE_RENEWAL_FAILED'));

    // Cannot renew after lease already expired
    const expiredRenew = jobService.renewLease(authCheckJob.job_id, 'owner-worker', 10_000, {
      nowIso: new Date(initialLeaseMs + 1000).toISOString(),
    });
    assert.equal(expiredRenew, null);

    // Release concurrency slot before running single-slot heartbeat scheduler subtest
    jobService.completeJob(authCheckJob.job_id);

    // 2. Active scheduler heartbeat during long-running stage & clean stop on completion
    const gate = createDeferred();
    const engine = new PipelineEngine(jobService, auditService, logger);
    engine.registerStageHandler({
      stageName: 'WORDPRESS_PUBLISH',
      async execute() {
        await gate.promise;
        return { success: true, output: { ok: true } };
      },
    });

    const longJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'long-running-heartbeat',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      auditService,
      rawEnv: {
        AUTOMATION_MODE: 'manual',
        POLL_INTERVAL_SECONDS: '10',
        MAX_CONCURRENT_JOBS: '1',
        JOB_LEASE_MS: '500',
        HEARTBEAT_INTERVAL_MS: '25',
      },
      config: { workerId: 'heartbeat-worker' },
    });

    await scheduler.pollOnce();
    const claimedLong = jobService.getJob(longJob.job_id)!;
    const firstLeaseExpiry = Date.parse(claimedLong.lease_expires_at!);

    // Wait long enough for multiple heartbeats to extend lease
    await new Promise((r) => setTimeout(r, 90));
    const duringRun = jobService.getJob(longJob.job_id)!;
    assert.equal(duringRun.status, 'RUNNING');
    assert.ok(duringRun.last_heartbeat_at);
    assert.ok(Date.parse(duringRun.lease_expires_at!) > firstLeaseExpiry);

    // Complete job and verify heartbeat stops cleanly
    gate.resolve();
    await scheduler.waitForIdle();

    const completedJob = jobService.getJob(longJob.job_id)!;
    assert.equal(completedJob.status, 'COMPLETED');
    const heartbeatAtCompletion = completedJob.last_heartbeat_at;
    const updatedAtCompletion = completedJob.updated_at;

    await new Promise((r) => setTimeout(r, 90));
    const afterWait = jobService.getJob(longJob.job_id)!;
    assert.equal(afterWait.last_heartbeat_at, heartbeatAtCompletion);
    assert.equal(afterWait.updated_at, updatedAtCompletion);

    const longJobLogs = auditService.getByEntity('PROCESSING_JOB', longJob.job_id);
    assert.equal(
      longJobLogs.some((l) => l.action === 'JOB_LEASE_RENEWAL_FAILED'),
      false
    );
  });

  it('should not create duplicate execution across concurrent stale recovery and scheduler polling', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-recovery-dup-'));
    const dbFile = path.join(tmpDir, 'recovery.db');

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
      const audit1 = new AuditService(new SqliteAuditLogRepository(db1));
      const audit2 = new AuditService(new SqliteAuditLogRepository(db2));
      const svc1 = new JobService(repo1, audit1);
      const svc2 = new JobService(repo2, audit2);

      const job = svc1.createJob({
        targetEntityType: 'RECRUITMENT',
        targetEntityId: 'rec-recovery-no-dup',
        initialStage: 'WORDPRESS_PUBLISH',
        maxAttempts: 3,
      });

      // Simulate crashed owner with expired lease
      const expiredClaim = svc1.claimJob(job.job_id, 'crashed-worker', {
        leaseDurationMs: 100,
        nowIso: new Date(Date.now() - 10_000).toISOString(),
      });
      assert.ok(expiredClaim);

      // Two concurrent recovery attempts on the same DB file
      const [rec1, rec2] = await Promise.all([
        Promise.resolve().then(() => svc1.recoverStaleJobs()),
        Promise.resolve().then(() => svc2.recoverStaleJobs()),
      ]);

      const totalRecovered = rec1.length + rec2.length;
      assert.equal(totalRecovered, 1);

      let executionCount = 0;
      const makeEngine = (svc: JobService, aud: AuditService) => {
        const eng = new PipelineEngine(svc, aud, logger);
        eng.registerStageHandler({
          stageName: 'WORDPRESS_PUBLISH',
          async execute() {
            executionCount += 1;
            return { success: true, output: { ok: true } };
          },
        });
        return eng;
      };

      const sched1 = new SchedulerService({
        jobService: svc1,
        pipelineEngine: makeEngine(svc1, audit1),
        auditService: audit1,
        rawEnv: {
          AUTOMATION_MODE: 'manual',
          POLL_INTERVAL_SECONDS: '10',
          MAX_CONCURRENT_JOBS: '2',
        },
        config: { workerId: 'recovery-runner-1' },
      });
      const sched2 = new SchedulerService({
        jobService: svc2,
        pipelineEngine: makeEngine(svc2, audit2),
        auditService: audit2,
        rawEnv: {
          AUTOMATION_MODE: 'manual',
          POLL_INTERVAL_SECONDS: '10',
          MAX_CONCURRENT_JOBS: '2',
        },
        config: { workerId: 'recovery-runner-2' },
      });

      const [poll1, poll2] = await Promise.all([sched1.pollOnce(), sched2.pollOnce()]);
      await Promise.all([sched1.waitForIdle(), sched2.waitForIdle()]);

      assert.equal(poll1.claimedJobIds.length + poll2.claimedJobIds.length, 1);
      assert.equal(executionCount, 1);

      const finalJob = svc1.getJob(job.job_id)!;
      assert.equal(finalJob.status, 'COMPLETED');
      assert.equal(finalJob.recovery_count, 1);
      assert.equal(finalJob.attempts, 2);

      db1.close();
      db2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
