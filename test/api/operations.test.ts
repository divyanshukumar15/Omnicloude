/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';
import { createApiApp } from '../../src/backend/api/app.ts';
import { getJobService } from '../../src/backend/jobs/index.ts';

describe('Operations API, Manual Retry & Dependency Readiness Tests', () => {
  const ADMIN_TOKEN = 'ops-admin-token-9876543210';
  const READONLY_TOKEN = 'ops-readonly-token-1234567890';

  let server: http.Server;
  let baseUrl = '';

  before(async () => {
    initDatabase({ path: ':memory:', forceNew: true });

    const app = createApiApp({
      auth: {
        authToken: ADMIN_TOKEN,
        readOnlyToken: READONLY_TOKEN,
      },
      rateLimit: {
        windowMs: 60000,
        maxPerIp: 1000,
        maxPerToken: 1000,
      },
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  it('[PASS] should expose structured dependency readiness on /api/health while preserving status contract', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      readiness: string;
      checks: {
        database: { status: string };
        remote_worker: { mode: string; configured: boolean };
        wordpress: { status: string };
        ocr: { provider: string; model: string; configured: boolean };
      };
    };

    assert.equal(body.status, 'healthy');
    assert.ok(['HEALTHY', 'DEGRADED'].includes(body.readiness));
    assert.equal(body.checks.database.status, 'up');
    assert.ok(body.checks.remote_worker);
    assert.ok(body.checks.wordpress);
    assert.ok(body.checks.ocr.provider);
  });

  it('[PASS] should enforce auth on GET /api/operations and return sources, jobs, publishing, and audit data', async () => {
    const unauth = await fetch(`${baseUrl}/api/operations`);
    assert.equal(unauth.status, 401);

    const roRes = await fetch(`${baseUrl}/api/operations`, {
      headers: { Authorization: `Bearer ${READONLY_TOKEN}` },
    });
    assert.equal(roRes.status, 200);
    const data = (await roRes.json()) as {
      success: boolean;
      sources: Array<{ sourceId: string; endpointCount: number }>;
      jobs: { counts: Record<string, number>; recent: unknown[] };
      dependencies: Record<string, unknown>;
      publishing: unknown[];
      auditLogs: unknown[];
    };

    assert.equal(data.success, true);
    assert.equal(data.sources.length, 7);
    assert.ok(data.dependencies.remoteWorker);
    assert.ok(data.dependencies.wordPress);
    assert.ok(data.dependencies.ocr);
    assert.ok(Array.isArray(data.jobs.recent));
    assert.ok(Array.isArray(data.publishing));
    assert.ok(Array.isArray(data.auditLogs));
  });

  it('[PASS] should require jobs:write for POST /api/jobs/:id/retry and safely requeue FAILED jobs only', async () => {
    const jobService = getJobService();
    const repos = getRepositories();

    const failedJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-retry-api-01',
      initialStage: 'PUBLISHING_GATE',
      maxAttempts: 1,
    });
    jobService.startJob(failedJob.job_id, 'corr-retry-api-1');
    jobService.failJob(failedJob.job_id, 'TRANSIENT_TIMEOUT', 'Upstream timed out', 'corr-retry-api-1');

    // Unauthenticated rejected with 401
    const unauth = await fetch(`${baseUrl}/api/jobs/${failedJob.job_id}/retry`, {
      method: 'POST',
    });
    assert.equal(unauth.status, 401);

    // Read-only token rejected with 403
    const forbidden = await fetch(`${baseUrl}/api/jobs/${failedJob.job_id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${READONLY_TOKEN}` },
    });
    assert.equal(forbidden.status, 403);

    // Admin retry succeeds and requeues job as PENDING with incremented max_attempts
    const retryRes = await fetch(`${baseUrl}/api/jobs/${failedJob.job_id}/retry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(retryRes.status, 200);
    const retryJson = (await retryRes.json()) as {
      success: boolean;
      data: { status: string; attempts: number; max_attempts: number; error_code: string | null };
    };
    assert.equal(retryJson.success, true);
    assert.equal(retryJson.data.status, 'PENDING');
    assert.equal(retryJson.data.error_code, null);
    assert.ok(retryJson.data.max_attempts > retryJson.data.attempts);

    // Completed job cannot be retried -> 409 Conflict
    const completedJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-completed-01',
    });
    jobService.startJob(completedJob.job_id, 'corr-comp-1');
    jobService.completeJob(completedJob.job_id, 'corr-comp-1');

    const conflictRes = await fetch(`${baseUrl}/api/jobs/${completedJob.job_id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(conflictRes.status, 409);

    // Audit log recorded JOB_MANUAL_RETRY
    const auditEntries = repos.auditLogs.listByEntity('PROCESSING_JOB', failedJob.job_id);
    assert.ok(auditEntries.some((entry) => entry.action === 'JOB_MANUAL_RETRY'));
  });
});
