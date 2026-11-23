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
import { timingSafeTokenEqual } from '../../src/backend/api/middleware/auth.ts';
import { resolveAllowedOrigins } from '../../src/backend/api/middleware/security.ts';
import { sanitizeLogData } from '../../src/backend/config/logger.ts';

describe('Production API Security Layer Tests', () => {
  const ADMIN_TOKEN = 'test-admin-control-token-9f8e7d6c5b4a';
  const READONLY_TOKEN = 'test-readonly-client-token-1a2b3c4d';
  const INTERNAL_TOKEN = 'test-internal-trusted-token-xyz789';

  let server: http.Server;
  let baseUrl = '';

  before(async () => {
    initDatabase({ path: ':memory:', forceNew: true });

    const app = createApiApp({
      auth: {
        authToken: ADMIN_TOKEN,
        readOnlyToken: READONLY_TOKEN,
        internalTrustedToken: INTERNAL_TOKEN,
      },
      cors: {
        allowedOrigins: ['https://control.omnihub.gov.in'],
        nodeEnv: 'production',
      },
      rateLimit: {
        windowMs: 60000,
        maxPerIp: 1000,
        maxPerToken: 1000,
      },
      bodyLimit: '16kb',
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

  it('[PASS] should verify timing-safe token comparison and secret redaction', () => {
    assert.equal(timingSafeTokenEqual(ADMIN_TOKEN, ADMIN_TOKEN), true);
    assert.equal(timingSafeTokenEqual('short', ADMIN_TOKEN), false);
    assert.equal(timingSafeTokenEqual('', ADMIN_TOKEN), false);

    const scrubbed = sanitizeLogData({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      message: `Attempted header Authorization: Bearer ${ADMIN_TOKEN}`,
      CONTROL_APP_AUTH_TOKEN: ADMIN_TOKEN,
    }) as Record<string, unknown>;

    assert.equal(scrubbed.authorization, '[REDACTED]');
    assert.equal(scrubbed.CONTROL_APP_AUTH_TOKEN, '[REDACTED]');
    assert.equal(String(scrubbed.message).includes(ADMIN_TOKEN), false);
  });

  it('[PASS] should reject all protected routes with 401 when no Bearer token is provided', async () => {
    const protectedRequests: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: '/api/jobs', body: { targetEntityType: 'SOURCE', targetEntityId: 'ssc' } },
      { method: 'POST', path: '/api/jobs/job-123/run-stage', body: {} },
      { method: 'POST', path: '/api/ingest', body: { sourceId: 'IN-CENTRAL-SSC' } },
      { method: 'GET', path: '/api/jobs' },
      { method: 'GET', path: '/api/jobs/job-123' },
      { method: 'GET', path: '/api/adapters' },
      { method: 'GET', path: '/api/audit' },
      {
        method: 'POST',
        path: '/api/audit',
        body: { action: 'MANUAL_TEST', entityType: 'SYSTEM', entityId: '1' },
      },
    ];

    for (const reqSpec of protectedRequests) {
      const res = await fetch(`${baseUrl}${reqSpec.path}`, {
        method: reqSpec.method,
        headers: reqSpec.body ? { 'Content-Type': 'application/json' } : {},
        body: reqSpec.body ? JSON.stringify(reqSpec.body) : undefined,
      });
      assert.equal(res.status, 401, `Expected 401 for ${reqSpec.method} ${reqSpec.path}`);
      const payload = (await res.json()) as { success: boolean; error: { code: string } };
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('[PASS] should reject wrong or malformed Bearer tokens with 401', async () => {
    const wrongHeaders = [
      'Bearer wrong-token-value',
      'Basic dXNlcjpwYXNz',
      'Bearer ',
      ADMIN_TOKEN, // missing Bearer scheme
    ];

    for (const authHeader of wrongHeaders) {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({ targetEntityType: 'SOURCE', targetEntityId: 'ssc' }),
      });
      assert.equal(res.status, 401, `Expected 401 for Authorization header "${authHeader}"`);
    }
  });

  it('[PASS] should reject insufficient permission with 403 for read-only token on mutating/admin routes', async () => {
    const readRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${READONLY_TOKEN}` },
    });
    assert.equal(readRes.status, 200);

    const forbiddenSpecs = [
      { method: 'POST', path: '/api/jobs', body: { targetEntityType: 'SOURCE', targetEntityId: 'ssc' } },
      { method: 'POST', path: '/api/ingest', body: { sourceId: 'IN-CENTRAL-SSC' } },
      {
        method: 'POST',
        path: '/api/audit',
        body: { action: 'TEST', entityType: 'SYSTEM', entityId: '1' },
      },
    ];

    for (const spec of forbiddenSpecs) {
      const res = await fetch(`${baseUrl}${spec.path}`, {
        method: spec.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${READONLY_TOKEN}`,
        },
        body: JSON.stringify(spec.body),
      });
      assert.equal(res.status, 403, `Expected 403 on ${spec.method} ${spec.path}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'INSUFFICIENT_PERMISSION');
    }
  });

  it('[PASS] should allow authenticated requests with valid CONTROL_APP_AUTH_TOKEN and enforce fail-closed even when unconfigured', async () => {
    const createRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        targetEntityType: 'SOURCE_PORTAL',
        targetEntityId: 'ssc-sec-test-01',
        initialStage: 'SOURCE_DISCOVERY',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { success: boolean; data: { job_id: string } };
    assert.equal(created.success, true);
    assert.ok(created.data.job_id);

    const unconfiguredApp = createApiApp({
      auth: { authToken: '', readOnlyToken: '', internalTrustedToken: '' },
    });
    const unconfiguredServer = http.createServer(unconfiguredApp);
    await new Promise<void>((r) => unconfiguredServer.listen(0, '127.0.0.1', () => r()));
    const unconfPort = (unconfiguredServer.address() as AddressInfo).port;

    try {
      const bypassRes = await fetch(`http://127.0.0.1:${unconfPort}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ targetEntityType: 'SOURCE', targetEntityId: 'bypass-attempt' }),
      });
      assert.equal(bypassRes.status, 401);
    } finally {
      await new Promise<void>((r) => unconfiguredServer.close(() => r()));
    }
  });

  it('[PASS] should enforce per-IP and per-token rate limits with 429 while exempting verified internal trusted operations', async () => {
    const tightApp = createApiApp({
      auth: {
        authToken: ADMIN_TOKEN,
        internalTrustedToken: INTERNAL_TOKEN,
      },
      rateLimit: {
        windowMs: 60000,
        maxPerIp: 3,
        maxPerToken: 2,
      },
    });
    const tightServer = http.createServer(tightApp);
    await new Promise<void>((r) => tightServer.listen(0, '127.0.0.1', () => r()));
    const tightPort = (tightServer.address() as AddressInfo).port;
    const tightUrl = `http://127.0.0.1:${tightPort}`;

    try {
      const r1 = await fetch(`${tightUrl}/api/audit`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(r1.status, 200);

      const r2 = await fetch(`${tightUrl}/api/audit`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(r2.status, 200);

      const r3 = await fetch(`${tightUrl}/api/audit`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(r3.status, 429);
      assert.ok(r3.headers.get('retry-after'));
      const errBody = (await r3.json()) as { error: { code: string } };
      assert.equal(errBody.error.code, 'RATE_LIMIT_EXCEEDED');

      for (let i = 0; i < 5; i++) {
        const internalRes = await fetch(`${tightUrl}/api/audit`, {
          headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        });
        assert.equal(internalRes.status, 200);
      }
    } finally {
      await new Promise<void>((r) => tightServer.close(() => r()));
    }
  });

  it('[PASS] should allow public /api/health and /api/status without auth and emit security headers', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(healthRes.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(healthRes.headers.get('x-powered-by'), null);

    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200);
  });

  it('[PASS] should enforce strict CORS allowlist (never wildcard in production) and reject untrusted origins', async () => {
    const resolved = resolveAllowedOrigins({
      allowedOrigins: ['*', 'https://control.omnihub.gov.in'],
      nodeEnv: 'production',
    });
    assert.equal(resolved.has('*'), false);
    assert.equal(resolved.has('https://control.omnihub.gov.in'), true);

    const allowedPreflight = await fetch(`${baseUrl}/api/jobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://control.omnihub.gov.in',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(
      allowedPreflight.headers.get('access-control-allow-origin'),
      'https://control.omnihub.gov.in'
    );
    assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), 'true');

    const deniedRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil-attacker.example.com' },
    });
    assert.equal(deniedRes.status, 403);
    assert.equal(deniedRes.headers.get('access-control-allow-origin'), null);
  });

  it('[PASS] should enforce body size limits, malformed JSON checks, Content-Type rules, and record security audit logs without secrets', async () => {
    const largePayload = JSON.stringify({
      targetEntityType: 'SOURCE',
      targetEntityId: 'ssc',
      metadata: { blob: 'x'.repeat(24 * 1024) },
    });
    const largeRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: largePayload,
    });
    assert.equal(largeRes.status, 413);

    const badJsonRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: '{"brokenJson": ',
    });
    assert.equal(badJsonRes.status, 400);

    const wrongTypeRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: 'plain text body',
    });
    assert.equal(wrongTypeRes.status, 415);

    const repos = getRepositories();
    const recentLogs = repos.auditLogs.listRecent(50);
    const securityLogs = recentLogs.filter((l) => l.stage === 'API_SECURITY_LAYER');
    assert.ok(securityLogs.length >= 2);

    for (const log of securityLogs) {
      const serialized = JSON.stringify(log);
      assert.equal(serialized.includes(ADMIN_TOKEN), false);
      assert.equal(serialized.includes(READONLY_TOKEN), false);
      assert.equal(serialized.includes(INTERNAL_TOKEN), false);
    }
  });
});
