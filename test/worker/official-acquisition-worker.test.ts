/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createOfficialAcquisitionWorkerApp,
  type WorkerAcquireRequest as AcquireRequestBody,
  type WorkerAcquireResponse as AcquireResponsePayload,
} from '../../src/worker/official-acquisition-worker.ts';
import { HttpRemoteAcquisitionRunner } from '../../src/backend/ingestion/discovery/acquisition-runner.ts';
import { getDiscoveryExecutor } from '../../src/backend/ingestion/discovery/discovery-executor.ts';
import { runRealLiveVerification } from '../../src/backend/ingestion/discovery/discovery-service.ts';
import { buildMachineReadableLiveReport } from '../../src/backend/ingestion/discovery/live-check.ts';
import { runRemoteProductionVerification } from '../../src/backend/ingestion/discovery/verify-remote-production.ts';
import {
  verifyWorkerPackageFiles,
  runContainerSmokeTest,
} from '../../src/worker/container-smoke-test.ts';
import { initDatabase, getRepositories } from '../../src/backend/database/index.ts';
import {
  BPSC_SNAPSHOTS,
  BSSC_SNAPSHOTS,
  SSC_SNAPSHOTS,
  UPSC_SNAPSHOTS,
  UPPSC_SNAPSHOTS,
  UPSSSC_SNAPSHOTS,
  RRB_SNAPSHOTS,
} from '../discovery/fixtures/source-snapshots.ts';

function createValidTestPdfBuffer(titleText = 'Official Government Recruitment Notification 2026'): Buffer {
  const safeText = titleText.replace(/[()\\]/g, '');
  const streamContent = `BT /F1 12 Tf 72 720 Td (${safeText}) Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(streamContent, 'utf8')} >> stream`,
    streamContent,
    'endstream endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000229 00000 n ',
    '0000000330 00000 n ',
    'trailer << /Size 6 /Root 1 0 R >>',
    'startxref',
    '400',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'utf8');
}

describe('Official Acquisition Worker — Real HTTP Integration & Security Suite', () => {
  const WORKER_TOKEN = 'test-official-worker-secret-token-2026';
  const validPdfBuffer = createValidTestPdfBuffer('BPSC 71st Combined Competitive Examination Notification');

  let upstreamServer: http.Server;
  let upstreamBaseUrl = '';
  let workerServer: http.Server;
  let workerBaseUrl = '';

  let retryCounter = 0;
  let idempotencyUpstreamCounter = 0;
  let simulateDnsRebinding = false;

  before(async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    // 1. Start real local HTTP upstream server simulating official government portals
    upstreamServer = http.createServer((req, res) => {
      const reqUrl = req.url || '/';

      if (reqUrl === '/connection-reset') {
        req.socket.destroy();
        return;
      }

      if (reqUrl === '/slow-timeout') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>Too late</body></html>');
          }
        }, 1200);
        return;
      }

      if (reqUrl === '/flaky-503') {
        retryCounter += 1;
        if (retryCounter < 3) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>Service Temporarily Unavailable</body></html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BPSC_SNAPSHOTS.normalListing);
        return;
      }

      if (reqUrl === '/idempotent-listing') {
        idempotencyUpstreamCounter += 1;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BPSC_SNAPSHOTS.normalListing);
        return;
      }

      if (reqUrl === '/redirect-official') {
        res.writeHead(302, { Location: 'https://bpsc.bihar.gov.in/NoticeBoard.htm' });
        res.end();
        return;
      }

      if (reqUrl === '/redirect-external') {
        res.writeHead(302, { Location: 'https://www.sarkariresult.com/phishing.pdf' });
        res.end();
        return;
      }

      if (reqUrl === '/redirect-ssrf') {
        res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }

      if (reqUrl === '/invalid-content-type') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
        return;
      }

      if (reqUrl === '/oversized-response') {
        const bigBuf = Buffer.alloc(2 * 1024 * 1024, 'A'); // 2 MB
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(bigBuf.length),
        });
        res.end(bigBuf);
        return;
      }

      if (reqUrl === '/disguised-html.pdf') {
        const htmlErr = '<!DOCTYPE html><html><body>404 File Not Found</body></html>';
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(htmlErr);
        return;
      }

      if (reqUrl.toLowerCase().endsWith('.pdf')) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(validPdfBuffer.length),
        });
        res.end(validPdfBuffer);
        return;
      }

      // Default official HTML/JSON listing based on referer/path
      const referer = String(req.headers.referer || '').toLowerCase();
      if (reqUrl.includes('/api/general-website/portal/records') || referer.includes('ssc.gov.in')) {
        if (!reqUrl.includes('upsssc')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(SSC_SNAPSHOTS.normalListing);
          return;
        }
      }
      if (referer.includes('bssc.bihar.gov.in')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BSSC_SNAPSHOTS.normalListing);
        return;
      }
      if (referer.includes('upsssc.gov.in')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UPSSSC_SNAPSHOTS.normalListing);
        return;
      }
      if (reqUrl.includes('AllNotifications.aspx') || referer.includes('uppsc.up.nic.in')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UPPSC_SNAPSHOTS.normalListing);
        return;
      }
      if (reqUrl.includes('whats-new') || reqUrl.includes('recruitment') || referer.includes('upsc.gov.in')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UPSC_SNAPSHOTS.normalListing);
        return;
      }
      if (referer.includes('rrb')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(RRB_SNAPSHOTS.normalListing);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BPSC_SNAPSHOTS.normalListing);
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve());
    });
    const upstreamAddr = upstreamServer.address() as AddressInfo;
    upstreamBaseUrl = `http://127.0.0.1:${upstreamAddr.port}`;

    // 2. Start real Official Acquisition Worker HTTP Server
    const { app } = createOfficialAcquisitionWorkerApp({
      token: WORKER_TOKEN,
      maxResponseMb: 1, // 1 MB max to test MAX_SIZE_EXCEEDED cleanly
      requestTimeoutMs: 5000,
      connectTimeoutMs: 3000,
      maxRetries: 2,
      maxConcurrency: 10,
      testUpstreamOriginMap: {
        'bpsc.bihar.gov.in': upstreamBaseUrl,
        'bpsc.bih.nic.in': upstreamBaseUrl,
        'onlinebpsc.bihar.gov.in': upstreamBaseUrl,
        'bssc.bihar.gov.in': upstreamBaseUrl,
        'upsssc.gov.in': upstreamBaseUrl,
        'ssc.gov.in': upstreamBaseUrl,
        'www.upsc.gov.in': upstreamBaseUrl,
        'upsc.gov.in': upstreamBaseUrl,
        'uppsc.up.nic.in': upstreamBaseUrl,
        'www.rrbcdg.gov.in': upstreamBaseUrl,
        'rrb.gov.in': upstreamBaseUrl,
        'www.rrbchennai.gov.in': upstreamBaseUrl,
        'www.rrbmumbai.gov.in': upstreamBaseUrl,
        'rrbkolkata.gov.in': upstreamBaseUrl,
        'rrbsecunderabad.gov.in': upstreamBaseUrl,
      },
      dnsLookup: async (hostname: string) => {
        if (simulateDnsRebinding || hostname.includes('rebind')) {
          return [{ address: '10.0.0.1', family: 4 }];
        }
        return [{ address: '164.100.251.54', family: 4 }];
      },
    });

    workerServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      workerServer.listen(0, '127.0.0.1', () => resolve());
    });
    const workerAddr = workerServer.address() as AddressInfo;
    workerBaseUrl = `http://127.0.0.1:${workerAddr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => workerServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('1. GET /health and GET /capabilities return structured operational and allowlist metadata', async () => {
    const healthRes = await fetch(`${workerBaseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.status, 'HEALTHY');
    assert.equal(healthJson.service, 'OfficialAcquisitionWorker');
    assert.equal(healthJson.authConfigured, true);
    assert.equal(typeof healthJson.runnerIdentity, 'object');

    const capRes = await fetch(`${workerBaseUrl}/capabilities`);
    assert.equal(capRes.status, 200);
    const capRaw = await capRes.text();
    assert.ok(!capRaw.includes(WORKER_TOKEN), 'Capabilities response must never expose worker token');
    const capJson = JSON.parse(capRaw) as {
      service: string;
      version: string;
      executionEnvironment: string;
      supportedMethods: string[];
      supportedAcquisitionTypes: string[];
      securityFeatures: string[];
      maxResponseSize: { maxResponseMb: number; maxResponseBytes: number };
      timeoutConfiguration: { requestTimeoutMs: number; connectTimeoutMs: number; maxRetries: number };
      supportedSources: Array<{ sourceId: string }>;
      rrbRegionalBoardsCount: number;
      securityPolicies: Record<string, unknown>;
    };
    assert.equal(capJson.service, 'OfficialAcquisitionWorker');
    assert.equal(typeof capJson.version, 'string');
    assert.equal(capJson.executionEnvironment, 'LOCAL_WORKER');
    assert.deepEqual(capJson.supportedMethods, ['GET', 'POST']);
    assert.deepEqual(capJson.supportedAcquisitionTypes, ['LISTING', 'DETAIL', 'DOCUMENT_PDF', 'PROBE']);
    assert.ok(Array.isArray(capJson.securityFeatures) && capJson.securityFeatures.length >= 6);
    assert.equal(typeof capJson.maxResponseSize.maxResponseBytes, 'number');
    assert.equal(typeof capJson.timeoutConfiguration.requestTimeoutMs, 'number');
    assert.equal(capJson.supportedSources.length, 7);
    assert.ok(capJson.rrbRegionalBoardsCount >= 21);
    assert.equal(capJson.securityPolicies.httpsOnly, true);
    assert.equal(capJson.securityPolicies.officialDomainAllowlistEnforced, true);
    assert.equal(capJson.securityPolicies.ssrfProtectionEnforced, true);
    assert.equal(capJson.securityPolicies.dnsRebindingProtectionEnforced, true);
  });

  it('2. Unauthenticated or invalid-token POST /acquire fails with ACCESS_BLOCKED (401/403)', async () => {
    const reqPayload: AcquireRequestBody = {
      requestId: 'req-unauth-1',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      purpose: 'LISTING',
    };

    // Missing auth header -> 401
    const unauthRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload),
    });
    assert.equal(unauthRes.status, 401);
    const unauthBody = (await unauthRes.json()) as AcquireResponsePayload;
    assert.equal(unauthBody.status, 'FAILED');
    assert.equal(unauthBody.failureClass, 'ACCESS_BLOCKED');

    // Wrong Bearer token -> 403
    const badTokenRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-value',
      },
      body: JSON.stringify(reqPayload),
    });
    assert.equal(badTokenRes.status, 403);
    const badTokenBody = (await badTokenRes.json()) as AcquireResponsePayload;
    assert.equal(badTokenBody.status, 'FAILED');
    assert.equal(badTokenBody.failureClass, 'ACCESS_BLOCKED');

    // Wrong HMAC signature -> 403
    const badHmacRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Timestamp': String(Date.now()),
        'X-Worker-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: JSON.stringify(reqPayload),
    });
    assert.equal(badHmacRes.status, 403);
  });

  it('3. Authenticated POST /acquire succeeds with Bearer token and HMAC-SHA256 signature', async () => {
    const body1: AcquireRequestBody = {
      requestId: 'req-auth-bearer-1',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      purpose: 'LISTING',
    };

    const bearerRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify(body1),
    });
    assert.equal(bearerRes.status, 200);
    const bearerJson = (await bearerRes.json()) as AcquireResponsePayload;
    assert.equal(bearerJson.status, 'SUCCESS');
    assert.equal(bearerJson.failureClass, 'SUCCESS');
    assert.equal(bearerJson.httpStatus, 200);
    assert.ok((bearerJson.bytesReceived ?? 0) > 100);

    // HMAC-only authentication
    const body2: AcquireRequestBody = {
      requestId: 'req-auth-hmac-1',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      purpose: 'LISTING',
    };
    const serialized = JSON.stringify(body2);
    const timestamp = String(Date.now());
    const hmac = crypto
      .createHmac('sha256', WORKER_TOKEN)
      .update(`${timestamp}.${serialized}`)
      .digest('hex');

    const hmacRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Timestamp': timestamp,
        'X-Worker-Signature': `sha256=${hmac}`,
      },
      body: serialized,
    });
    assert.equal(hmacRes.status, 200);
    const hmacJson = (await hmacRes.json()) as AcquireResponsePayload;
    assert.equal(hmacJson.status, 'SUCCESS');
    assert.equal(hmacJson.failureClass, 'SUCCESS');
  });

  it('4. Rejects non-official domains, cross-source domain mismatches, and non-HTTPS schemes', async () => {
    const sendAcquire = async (payload: Partial<AcquireRequestBody>) => {
      const res = await fetch(`${workerBaseUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: `req-sec-${crypto.randomUUID()}`,
          sourceId: 'IN-BIHAR-BPSC',
          endpoint: 'https://bpsc.bihar.gov.in/',
          purpose: 'LISTING',
          ...payload,
        }),
      });
      return { httpStatus: res.status, body: (await res.json()) as AcquireResponsePayload };
    };

    // Third-party portal rejected
    const thirdParty = await sendAcquire({
      endpoint: 'https://www.sarkariresult.com/bihar-bpsc.php',
    });
    assert.equal(thirdParty.body.status, 'FAILED');
    assert.equal(thirdParty.body.failureClass, 'ACCESS_BLOCKED');

    // Cross-source domain mismatch (SSC domain requested under BPSC sourceId)
    const crossSource = await sendAcquire({
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://ssc.gov.in/api/general-website/portal/records',
    });
    assert.equal(crossSource.body.status, 'FAILED');
    assert.equal(crossSource.body.failureClass, 'ACCESS_BLOCKED');

    // Plain HTTP rejected
    const plainHttp = await sendAcquire({
      endpoint: 'http://bpsc.bihar.gov.in/NoticeBoard.htm',
    });
    assert.equal(plainHttp.body.status, 'FAILED');
    assert.equal(plainHttp.body.failureClass, 'SSRF_BLOCKED');
  });

  it('5. Rejects SSRF targets (localhost, loopback, private IP, metadata IP) and DNS rebinding', async () => {
    const sendAcquire = async (endpoint: string) => {
      const res = await fetch(`${workerBaseUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: `req-ssrf-${crypto.randomUUID()}`,
          sourceId: 'IN-BIHAR-BPSC',
          endpoint,
          purpose: 'LISTING',
        }),
      });
      return (await res.json()) as AcquireResponsePayload;
    };

    for (const ssrfUrl of [
      'https://127.0.0.1/secret',
      'https://localhost/admin',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.1/internal',
      'https://192.168.1.1/router',
    ]) {
      const res = await sendAcquire(ssrfUrl);
      assert.equal(res.status, 'FAILED', `Expected SSRF failure for ${ssrfUrl}`);
      assert.equal(res.failureClass, 'SSRF_BLOCKED', `Expected SSRF_BLOCKED for ${ssrfUrl}`);
    }

    // DNS rebinding simulation: official domain resolving to 10.0.0.1
    simulateDnsRebinding = true;
    try {
      const rebindRes = await sendAcquire('https://bpsc.bihar.gov.in/NoticeBoard.htm');
      assert.equal(rebindRes.status, 'FAILED');
      assert.equal(rebindRes.failureClass, 'SSRF_BLOCKED');
      assert.ok(rebindRes.failureDetails?.toLowerCase().includes('private') || rebindRes.failureDetails?.toLowerCase().includes('ip'));
    } finally {
      simulateDnsRebinding = false;
    }
  });

  it('6. Validates redirects per hop: allows official redirects and blocks external or SSRF redirects', async () => {
    const sendAcquire = async (endpoint: string) => {
      const res = await fetch(`${workerBaseUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: `req-redir-${crypto.randomUUID()}`,
          sourceId: 'IN-BIHAR-BPSC',
          endpoint,
          purpose: 'LISTING',
        }),
      });
      return (await res.json()) as AcquireResponsePayload;
    };

    // Valid official redirect
    const okRedir = await sendAcquire('https://bpsc.bihar.gov.in/redirect-official');
    assert.equal(okRedir.status, 'SUCCESS');
    assert.deepEqual(okRedir.redirectChain, [
      'https://bpsc.bihar.gov.in/redirect-official',
      'https://bpsc.bihar.gov.in/NoticeBoard.htm',
    ]);

    // Redirect to non-official domain -> REDIRECT_BLOCKED
    const extRedir = await sendAcquire('https://bpsc.bihar.gov.in/redirect-external');
    assert.equal(extRedir.status, 'FAILED');
    assert.equal(extRedir.failureClass, 'REDIRECT_BLOCKED');

    // Redirect to cloud metadata IP -> SSRF_BLOCKED or REDIRECT_BLOCKED
    const ssrfRedir = await sendAcquire('https://bpsc.bihar.gov.in/redirect-ssrf');
    assert.equal(ssrfRedir.status, 'FAILED');
    assert.ok(
      ssrfRedir.failureClass === 'SSRF_BLOCKED' || ssrfRedir.failureClass === 'REDIRECT_BLOCKED',
      `Expected SSRF_BLOCKED or REDIRECT_BLOCKED, got ${ssrfRedir.failureClass}`
    );
  });

  it('7. Executes measurable retries on transient 503s and classifies TIMEOUT, CONNECTION_RESET, CONTENT_TYPE_INVALID, and MAX_SIZE_EXCEEDED', async () => {
    retryCounter = 0;
    const flakyRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-retry-flaky-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/flaky-503',
        purpose: 'LISTING',
        retryPolicy: { maxRetries: 2, retryBackoffMs: 20 },
      } satisfies AcquireRequestBody),
    });
    const flakyBody = (await flakyRes.json()) as AcquireResponsePayload;
    assert.equal(flakyBody.status, 'SUCCESS');
    assert.equal(flakyBody.attempts, 3);
    assert.equal(flakyBody.retriesUsed, 2);
    assert.equal(flakyBody.retryDiagnostics.length, 2);

    // Timeout classification
    const timeoutRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-timeout-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/slow-timeout',
        purpose: 'LISTING',
        timeout: 150,
        retryPolicy: { maxRetries: 0, retryBackoffMs: 20 },
      } satisfies AcquireRequestBody),
    });
    const timeoutBody = (await timeoutRes.json()) as AcquireResponsePayload;
    assert.equal(timeoutBody.status, 'FAILED');
    assert.equal(timeoutBody.failureClass, 'TIMEOUT');

    // Connection reset classification
    const resetRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-reset-1',
        sourceId: 'IN-BIHAR-BSSC',
        endpoint: 'https://bssc.bihar.gov.in/connection-reset',
        purpose: 'LISTING',
        retryPolicy: { maxRetries: 0, retryBackoffMs: 20 },
      } satisfies AcquireRequestBody),
    });
    const resetBody = (await resetRes.json()) as AcquireResponsePayload;
    assert.equal(resetBody.status, 'FAILED');
    assert.equal(resetBody.failureClass, 'CONNECTION_RESET');

    // Invalid content-type for LISTING
    const mimeRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-mime-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/invalid-content-type',
        purpose: 'LISTING',
        retryPolicy: { maxRetries: 0, retryBackoffMs: 20 },
      } satisfies AcquireRequestBody),
    });
    const mimeBody = (await mimeRes.json()) as AcquireResponsePayload;
    assert.equal(mimeBody.status, 'FAILED');
    assert.equal(mimeBody.failureClass, 'CONTENT_TYPE_INVALID');

    // Max response size exceeded
    const sizeRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-size-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/oversized-response',
        purpose: 'LISTING',
        retryPolicy: { maxRetries: 0, retryBackoffMs: 20 },
      } satisfies AcquireRequestBody),
    });
    const sizeBody = (await sizeRes.json()) as AcquireResponsePayload;
    assert.equal(sizeBody.status, 'FAILED');
    assert.equal(sizeBody.failureClass, 'MAX_SIZE_EXCEEDED');
  });

  it('8. Enforces idempotency / replay protection so duplicate idempotencyKey requests do not re-fetch upstream', async () => {
    idempotencyUpstreamCounter = 0;
    const idemKey = `idem-key-${crypto.randomUUID()}`;

    const firstRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-idem-1',
        idempotencyKey: idemKey,
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/idempotent-listing',
        purpose: 'LISTING',
      } satisfies AcquireRequestBody),
    });
    const firstBody = (await firstRes.json()) as AcquireResponsePayload;
    assert.equal(firstBody.status, 'SUCCESS');
    assert.equal(firstBody.deduplicatedReplay, false);
    assert.equal(idempotencyUpstreamCounter, 1);

    const secondRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-idem-2',
        idempotencyKey: idemKey,
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/idempotent-listing',
        purpose: 'LISTING',
      } satisfies AcquireRequestBody),
    });
    const secondBody = (await secondRes.json()) as AcquireResponsePayload;
    assert.equal(secondBody.status, 'SUCCESS');
    assert.equal(secondBody.deduplicatedReplay, true);
    assert.equal(secondBody.requestId, 'req-idem-2');
    assert.equal(idempotencyUpstreamCounter, 1, 'Upstream must not be called a second time');
  });

  it('9. Validates PDF magic bytes + SHA-256 in worker, rejects disguised HTML as INVALID_PDF, and integrates E2E with central pipeline across LOCAL / REMOTE / AUTO modes', async () => {
    // A. Worker rejects HTML disguised as PDF
    const badPdfRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-bad-pdf-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/disguised-html.pdf',
        purpose: 'DOCUMENT_PDF',
        retryPolicy: { maxRetries: 0 },
      } satisfies AcquireRequestBody),
    });
    const badPdfBody = (await badPdfRes.json()) as AcquireResponsePayload;
    assert.equal(badPdfBody.status, 'FAILED');
    assert.equal(badPdfBody.failureClass, 'INVALID_PDF');
    assert.equal(badPdfBody.isPdf, false);

    // B. Worker acquires valid PDF with %PDF- magic bytes and SHA-256
    const goodPdfRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: 'req-good-pdf-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/Notices/2026/Advt-71-CCE-Notification.pdf',
        purpose: 'DOCUMENT_PDF',
      } satisfies AcquireRequestBody),
    });
    const goodPdfBody = (await goodPdfRes.json()) as AcquireResponsePayload;
    assert.equal(goodPdfBody.status, 'SUCCESS');
    assert.equal(goodPdfBody.failureClass, 'SUCCESS');
    assert.equal(goodPdfBody.isPdf, true);
    assert.equal(
      goodPdfBody.sha256,
      crypto.createHash('sha256').update(validPdfBuffer).digest('hex')
    );

    // C. Real HTTP Remote Runner E2E integration with DiscoveryExecutor (REMOTE & AUTO modes)
    const realHttpWorkerRunner = new HttpRemoteAcquisitionRunner({
      workerEndpoint: workerBaseUrl,
      authToken: WORKER_TOKEN,
    });

    const healthCheck = await realHttpWorkerRunner.checkHealth(3000);
    assert.equal(healthCheck.reachable, true);
    assert.equal(healthCheck.healthy, true);

    const capabilitiesCheck = await realHttpWorkerRunner.getCapabilities(3000);
    assert.equal(capabilitiesCheck.reachable, true);
    assert.equal(capabilitiesCheck.supportedSourcesCount, 7);

    const executor = getDiscoveryExecutor();
    const remoteExec = await executor.execute('IN-BIHAR-BPSC', {
      verificationMode: 'LIVE',
      runnerMode: 'REMOTE',
      remoteRunner: realHttpWorkerRunner,
      downloadAndValidatePdfs: true,
      noCache: true,
    });

    assert.equal(remoteExec.outcome, 'PASS');
    assert.equal(remoteExec.selectedRunner, 'REMOTE');
    assert.equal(remoteExec.actualRunner, 'REMOTE');
    assert.equal(remoteExec.runner, 'REMOTE');
    assert.equal(remoteExec.remoteStatus, 'REMOTE_EXECUTED');
    assert.equal(remoteExec.executionOrigin, 'REAL_REMOTE_LOCAL_WORKER');
    assert.equal(remoteExec.verifiedLive, true);
    assert.ok((remoteExec.metrics.validPdfs ?? 0) >= 1);
    assert.ok(remoteExec.evidence?.documentSha256);

    // D. AUTO mode with healthy real HTTP worker selects REMOTE and reports REAL_REMOTE_LOCAL_WORKER
    const autoHealthyExec = await executor.execute('IN-BIHAR-BSSC', {
      verificationMode: 'LIVE',
      runnerMode: 'AUTO',
      remoteRunner: realHttpWorkerRunner,
      downloadAndValidatePdfs: true,
      noCache: true,
    });
    assert.equal(autoHealthyExec.outcome, 'PASS');
    assert.equal(autoHealthyExec.selectedRunner, 'REMOTE');
    assert.equal(autoHealthyExec.actualRunner, 'REMOTE');
    assert.equal(autoHealthyExec.remoteStatus, 'REMOTE_EXECUTED');
    assert.equal(autoHealthyExec.executionOrigin, 'REAL_REMOTE_LOCAL_WORKER');

    // E. AUTO mode when remote worker is unreachable falls back to LOCAL and reports remoteStatus=REMOTE_UNAVAILABLE + actualRunner=LOCAL
    const deadWorkerRunner = new HttpRemoteAcquisitionRunner({
      workerEndpoint: 'http://127.0.0.1:1', // Unreachable port
      authToken: WORKER_TOKEN,
    });

    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith('http://127.0.0.1:1')) {
        return prevFetch(input, init);
      }
      if (urlStr.toLowerCase().endsWith('.pdf')) {
        return new Response(new Uint8Array(validPdfBuffer), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response(BPSC_SNAPSHOTS.normalListing, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    try {
      const autoFallbackExec = await executor.execute('IN-BIHAR-BPSC', {
        verificationMode: 'LIVE',
        runnerMode: 'AUTO',
        remoteRunner: deadWorkerRunner,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      assert.equal(autoFallbackExec.outcome, 'PASS');
      assert.equal(autoFallbackExec.selectedRunner, 'REMOTE');
      assert.equal(autoFallbackExec.actualRunner, 'LOCAL');
      assert.equal(autoFallbackExec.runner, 'LOCAL');
      assert.equal(autoFallbackExec.remoteStatus, 'REMOTE_UNAVAILABLE');
      assert.equal(autoFallbackExec.localAccess, 'SUCCESS');
      assert.equal(autoFallbackExec.executionOrigin, 'REAL_LIVE_LOCAL');
    } finally {
      globalThis.fetch = prevFetch;
    }

    // F. Machine-readable live report distinguishes REAL_REMOTE_LOCAL_WORKER: PROVEN vs REAL_REMOTE_PRODUCTION: NOT_PROVEN
    const summary = await runRealLiveVerification({
      verificationMode: 'LIVE',
      runnerMode: 'REMOTE',
      remoteRunner: realHttpWorkerRunner,
      connectivityProbe: false,
      timeoutMs: 3000,
      maxRetries: 0,
      noCache: true,
    });
    const report = buildMachineReadableLiveReport(summary);
    assert.equal(report.REAL_REMOTE_LOCAL_WORKER, 'PROVEN');
    assert.equal(report.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.ok(report.realRemoteLocalWorkerPassCount >= 1);
    assert.equal(report.realRemoteProductionPassCount, 0);
  });

  it('10. Enforces production health contract, request ID propagation, malformed request rejection, concurrency limit, and graceful shutdown', async () => {
    // A. Health contract includes version, uptime, timestamp, capabilities, and X-Request-Id without exposing token
    const healthRes = await fetch(`${workerBaseUrl}/health`, {
      headers: { 'X-Request-Id': 'req-health-check-42' },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-request-id'), 'req-health-check-42');
    const healthRaw = await healthRes.text();
    assert.ok(!healthRaw.includes(WORKER_TOKEN), 'Health response must never expose worker token');
    const healthData = JSON.parse(healthRaw) as Record<string, unknown>;
    assert.equal(healthData.status, 'HEALTHY');
    assert.equal(healthData.service, 'OfficialAcquisitionWorker');
    assert.equal(typeof healthData.version, 'string');
    assert.equal(typeof healthData.uptime, 'number');
    assert.equal(typeof healthData.timestamp, 'string');
    assert.equal(typeof healthData.capabilities, 'object');

    // B. Malformed JSON request returns 400 MALFORMED_ACQUIRE_REQUEST cleanly
    const malformedJsonRes = await fetch(`${workerBaseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: '{"requestId": "broken-json", ',
    });
    assert.equal(malformedJsonRes.status, 400);
    const malformedBody = (await malformedJsonRes.json()) as AcquireResponsePayload;
    assert.equal(malformedBody.status, 'FAILED');
    assert.equal(malformedBody.errorCode, 'MALFORMED_ACQUIRE_REQUEST');

    // C. Concurrency limit enforcement and graceful shutdown draining
    const {
      app: boundedApp,
      worker: boundedWorker,
    } = createOfficialAcquisitionWorkerApp({
      token: WORKER_TOKEN,
      maxConcurrency: 1,
      requestTimeoutMs: 3000,
      connectTimeoutMs: 2000,
      executionEnvironment: 'PRODUCTION_REMOTE',
      remoteWorkerId: 'prod-worker-node-01',
      version: '1.1.0',
      testUpstreamOriginMap: {
        'bpsc.bihar.gov.in': upstreamBaseUrl,
      },
      dnsLookup: async () => [{ address: '164.100.251.54', family: 4 }],
    });
    const boundedServer = http.createServer(boundedApp);
    await new Promise<void>((resolve) => boundedServer.listen(0, '127.0.0.1', () => resolve()));
    const boundedPort = (boundedServer.address() as AddressInfo).port;
    const boundedUrl = `http://127.0.0.1:${boundedPort}`;

    try {
      // Trigger one slow in-flight request to occupy concurrency slot 1
      const slowPromise = fetch(`${boundedUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: 'req-concurrency-slow',
          sourceId: 'IN-BIHAR-BPSC',
          endpoint: 'https://bpsc.bihar.gov.in/slow-timeout',
          purpose: 'LISTING',
          timeout: 1500,
          retryPolicy: { maxRetries: 0 },
        } satisfies AcquireRequestBody),
      });

      await new Promise((r) => setTimeout(r, 60));

      // Second concurrent request should be rejected with 429 WORKER_CONCURRENCY_LIMIT_EXCEEDED
      const secondRes = await fetch(`${boundedUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: 'req-concurrency-overflow',
          sourceId: 'IN-BIHAR-BPSC',
          endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
          purpose: 'LISTING',
        } satisfies AcquireRequestBody),
      });
      assert.equal(secondRes.status, 429);
      const secondBody = (await secondRes.json()) as AcquireResponsePayload;
      assert.equal(secondBody.errorCode, 'WORKER_CONCURRENCY_LIMIT_EXCEEDED');

      await slowPromise;

      // Initiate graceful shutdown -> new /acquire gets 503 WORKER_SHUTTING_DOWN and /health gets 503 DRAINING
      boundedWorker.beginGracefulShutdown();
      const drainHealth = await fetch(`${boundedUrl}/health`);
      assert.equal(drainHealth.status, 503);

      const shuttingDownRes = await fetch(`${boundedUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          requestId: 'req-after-shutdown',
          sourceId: 'IN-BIHAR-BPSC',
          endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
          purpose: 'LISTING',
        } satisfies AcquireRequestBody),
      });
      assert.equal(shuttingDownRes.status, 503);
      const shuttingDownBody = (await shuttingDownRes.json()) as AcquireResponsePayload;
      assert.equal(shuttingDownBody.errorCode, 'WORKER_SHUTTING_DOWN');
    } finally {
      await new Promise<void>((resolve) => boundedServer.close(() => resolve()));
    }
  });

  it('11. Rejects malformed worker responses with REMOTE_PROTOCOL_ERROR in HttpRemoteAcquisitionRunner', async () => {
    const malformedWorkerServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'HEALTHY', service: 'OfficialAcquisitionWorker', version: '1.1.0' }));
        return;
      }
      // Return 200 OK with missing actualRunner / runnerIdentity contract
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'SUCCESS', unexpectedShape: true }));
    });
    await new Promise<void>((resolve) => malformedWorkerServer.listen(0, '127.0.0.1', () => resolve()));
    const malformedPort = (malformedWorkerServer.address() as AddressInfo).port;

    try {
      const runner = new HttpRemoteAcquisitionRunner({
        workerEndpoint: `http://127.0.0.1:${malformedPort}`,
        authToken: WORKER_TOKEN,
      });
      const res = await runner.acquire({
        requestId: 'req-proto-err-1',
        sourceId: 'IN-BIHAR-BPSC',
        endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
        methodType: 'LISTING',
        timeoutPolicy: { timeoutMs: 2000 },
        retryPolicy: { maxRetries: 0 },
      });
      assert.equal(res.errorCode, 'REMOTE_PROTOCOL_ERROR');
      assert.equal(res.remoteStatus, 'REMOTE_FAILED');
    } finally {
      await new Promise<void>((resolve) => malformedWorkerServer.close(() => resolve()));
    }
  });

  it('12. Verifies runRemoteProductionVerification across failure classifications and proves REAL_REMOTE_PRODUCTION only on genuine external HTTPS production worker execution', async () => {
    // 1. Unconfigured worker -> REMOTE_NOT_CONFIGURED, REAL_REMOTE_PRODUCTION = NOT_PROVEN, realRemoteProduction = NOT_CONFIGURED
    const unconfiguredReport = await runRemoteProductionVerification({
      workerUrl: '',
      authToken: '',
      artifactPath: null,
    });
    assert.equal(unconfiguredReport.failureClassification, 'REMOTE_NOT_CONFIGURED');
    assert.equal(unconfiguredReport.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(unconfiguredReport.realRemoteProduction, 'NOT_CONFIGURED');
    assert.equal(unconfiguredReport.dockerfileExists, true);
    assert.equal(unconfiguredReport.remoteConfigured, false);
    assert.equal(unconfiguredReport.remoteReachable, false);
    assert.equal(unconfiguredReport.remoteIdentityVerified, false);
    assert.equal(unconfiguredReport.remoteAcquisitionExecuted, false);
    assert.equal(Object.keys(unconfiguredReport.governmentSources).length, 7);

    // 2. Invalid token -> REMOTE_AUTH_FAILED, REAL_REMOTE_PRODUCTION = NOT_PROVEN
    const authFailedReport = await runRemoteProductionVerification({
      workerUrl: workerBaseUrl,
      authToken: 'invalid-secret-token',
      sourceIds: ['IN-CENTRAL-SSC'],
      timeoutMs: 3000,
      maxRetries: 0,
      artifactPath: null,
    });
    assert.equal(authFailedReport.failureClassification, 'REMOTE_AUTH_FAILED');
    assert.equal(authFailedReport.stages.WORKER_CONNECTIVITY, 'PASS');
    assert.equal(authFailedReport.stages.REMOTE_AUTH, 'FAIL');
    assert.equal(authFailedReport.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(authFailedReport.remoteConfigured, true);
    assert.equal(authFailedReport.remoteReachable, true);
    assert.equal(authFailedReport.remoteIdentityVerified, false);

    // 3. Loopback local worker -> proves REAL_REMOTE_LOCAL_WORKER = PROVEN, but REAL_REMOTE_PRODUCTION = NOT_PROVEN
    const localWorkerReport = await runRemoteProductionVerification({
      workerUrl: workerBaseUrl,
      authToken: WORKER_TOKEN,
      sourceIds: ['IN-BIHAR-BPSC'],
      timeoutMs: 3000,
      maxRetries: 0,
      artifactPath: null,
    });
    assert.equal(localWorkerReport.REAL_REMOTE_LOCAL_WORKER, 'PROVEN');
    assert.equal(localWorkerReport.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(localWorkerReport.realRemoteProduction, 'NOT_PROVEN');
    assert.equal(localWorkerReport.runnerClassification, 'REMOTE_LOCAL_WORKER');
    assert.equal(localWorkerReport.executionEnvironment, 'LOCAL_WORKER');
    assert.equal(localWorkerReport.stages.PDF_VALIDATION, 'PASS');

    // 4. Genuine external HTTPS production worker (`https://worker.omnihub-prod.example`) -> REAL_REMOTE_PRODUCTION = PROVEN
    const { app: prodWorkerApp } = createOfficialAcquisitionWorkerApp({
      token: WORKER_TOKEN,
      executionEnvironment: 'PRODUCTION_REMOTE',
      remoteWorkerId: 'ext-prod-worker-eu-west-1',
      version: '1.1.0',
      testUpstreamOriginMap: {
        'bpsc.bihar.gov.in': upstreamBaseUrl,
        'bpsc.bih.nic.in': upstreamBaseUrl,
        'onlinebpsc.bihar.gov.in': upstreamBaseUrl,
        'ssc.gov.in': upstreamBaseUrl,
      },
      dnsLookup: async () => [{ address: '164.100.251.54', family: 4 }],
    });
    const prodWorkerServer = http.createServer(prodWorkerApp);
    await new Promise<void>((resolve) => prodWorkerServer.listen(0, '127.0.0.1', () => resolve()));
    const prodWorkerPort = (prodWorkerServer.address() as AddressInfo).port;
    const prodInternalUrl = `http://127.0.0.1:${prodWorkerPort}`;

    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith('https://worker.omnihub-prod.example')) {
        const mapped = urlStr.replace('https://worker.omnihub-prod.example', prodInternalUrl);
        return prevFetch(mapped, init);
      }
      return prevFetch(input, init);
    };

    try {
      const prodReport = await runRemoteProductionVerification({
        workerUrl: 'https://worker.omnihub-prod.example',
        authToken: WORKER_TOKEN,
        sourceIds: ['IN-BIHAR-BPSC'],
        timeoutMs: 4000,
        maxRetries: 1,
        skipWorkerUrlIpValidation: true,
        artifactPath: null,
      });

      assert.equal(prodReport.failureClassification, 'NONE');
      assert.equal(prodReport.REAL_REMOTE_PRODUCTION, 'PROVEN');
      assert.equal(prodReport.realRemoteProduction, 'PROVEN');
      assert.equal(prodReport.remoteConfigured, true);
      assert.equal(prodReport.remoteReachable, true);
      assert.equal(prodReport.remoteIdentityVerified, true);
      assert.equal(prodReport.remoteAcquisitionExecuted, true);
      assert.equal(prodReport.actualRunner, 'REMOTE');
      assert.equal(prodReport.executionEnvironment, 'PRODUCTION_REMOTE');
      assert.equal(prodReport.runnerClassification, 'REMOTE_PRODUCTION');
      assert.equal(prodReport.workerId, 'ext-prod-worker-eu-west-1');
      assert.equal(prodReport.remoteWorkerId, 'ext-prod-worker-eu-west-1');
      assert.equal(prodReport.workerVersion, '1.1.0');
      assert.equal(prodReport.workerIdentity.workerId, 'ext-prod-worker-eu-west-1');
      assert.equal(prodReport.workerIdentity.executionEnvironment, 'PRODUCTION_REMOTE');
      assert.equal(prodReport.stages.WORKER_URL_CONFIGURATION, 'PASS');
      assert.equal(prodReport.stages.WORKER_HEALTH, 'PASS');
      assert.equal(prodReport.stages.WORKER_CONNECTIVITY, 'PASS');
      assert.equal(prodReport.stages.REMOTE_AUTH, 'PASS');
      assert.equal(prodReport.stages.REMOTE_HTTP_EXECUTION, 'PASS');
      assert.equal(prodReport.stages.REMOTE_EXECUTION_IDENTITY, 'PASS');
      assert.equal(prodReport.stages.REMOTE_EXECUTION, 'PASS');
      assert.equal(prodReport.stages.OFFICIAL_SOURCE_ACCESS, 'PASS');
      assert.equal(prodReport.stages.DOCUMENT_ACQUISITION, 'PASS');
      assert.equal(prodReport.stages.PDF_VALIDATION, 'PASS');
      assert.equal(prodReport.stages.AUDIT_EVIDENCE, 'PASS');
      assert.equal(prodReport.documentResult.downloaded, true);
      assert.equal(prodReport.pdfResult.validated, true);
      assert.equal(prodReport.evidence.auditPersisted, true);
      assert.ok(prodReport.evidence.documentSha256);
      assert.ok((prodReport.evidence.pdfPageCount ?? 0) >= 1);

      const recentLogs = getRepositories().auditLogs.listRecent(10);
      assert.ok(
        recentLogs.some((l) => l.action === 'REMOTE_PRODUCTION_VERIFIED_PROVEN'),
        'Expected REMOTE_PRODUCTION_VERIFIED_PROVEN audit log entry'
      );
    } finally {
      globalThis.fetch = prevFetch;
      await new Promise<void>((resolve) => prodWorkerServer.close(() => resolve()));
    }
  });

  it('13. Rejects invalid request contracts (unsupported methods, unsafe headers, invalid timeouts, excessive retries, security limit overrides) and enforces local vs production identity rules', async () => {
    const postAcquire = async (body: Record<string, unknown>) => {
      const res = await fetch(`${workerBaseUrl}/acquire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, payload: (await res.json()) as AcquireResponsePayload };
    };

    // Unsupported HTTP method -> 400 UNSUPPORTED_HTTP_METHOD
    const badMethod = await postAcquire({
      requestId: 'req-bad-method',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      method: 'DELETE',
    });
    assert.equal(badMethod.status, 400);
    assert.equal(badMethod.payload.errorCode, 'UNSUPPORTED_HTTP_METHOD');

    // Unsafe request headers -> 400 UNSAFE_REQUEST_HEADERS
    const unsafeHeaders = await postAcquire({
      requestId: 'req-unsafe-hdr',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      headers: {
        Cookie: 'session=admin',
        'X-Forwarded-For': '127.0.0.1',
      },
    });
    assert.equal(unsafeHeaders.status, 400);
    assert.equal(unsafeHeaders.payload.errorCode, 'UNSAFE_REQUEST_HEADERS');

    // Invalid timeout (> 30000ms) -> 400 INVALID_TIMEOUT_CONFIGURATION
    const badTimeout = await postAcquire({
      requestId: 'req-bad-timeout',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      timeout: 60000,
    });
    assert.equal(badTimeout.status, 400);
    assert.equal(badTimeout.payload.errorCode, 'INVALID_TIMEOUT_CONFIGURATION');

    // Excessive retries (maxRetries: 10) -> 400 EXCESSIVE_RETRY_CONFIGURATION
    const badRetries = await postAcquire({
      requestId: 'req-bad-retries',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      retryPolicy: { maxRetries: 10 },
    });
    assert.equal(badRetries.status, 400);
    assert.equal(badRetries.payload.errorCode, 'EXCESSIVE_RETRY_CONFIGURATION');

    // Security limit override attempt (allowHttp: true) -> 400 SECURITY_LIMIT_OVERRIDE_REJECTED
    const overrideHttp = await postAcquire({
      requestId: 'req-override-http',
      sourceId: 'IN-BIHAR-BPSC',
      endpoint: 'https://bpsc.bihar.gov.in/NoticeBoard.htm',
      requestPolicy: { allowHttp: true },
    });
    assert.equal(overrideHttp.status, 400);
    assert.equal(overrideHttp.payload.errorCode, 'SECURITY_LIMIT_OVERRIDE_REJECTED');

    // Production identity enforcement: local loopback bind (127.0.0.1) or missing token cannot claim PRODUCTION_REMOTE
    const { worker: loopbackBoundWorker } = createOfficialAcquisitionWorkerApp({
      token: WORKER_TOKEN,
      host: '127.0.0.1',
      executionEnvironment: 'PRODUCTION_REMOTE',
    });
    assert.equal(
      loopbackBoundWorker.getIdentity().executionEnvironment,
      'LOCAL_WORKER',
      'Worker bound to 127.0.0.1 must never claim PRODUCTION_REMOTE'
    );

    const { worker: unauthenticatedWorker } = createOfficialAcquisitionWorkerApp({
      token: '',
      host: '0.0.0.0',
      executionEnvironment: 'PRODUCTION_REMOTE',
    });
    assert.equal(
      unauthenticatedWorker.getIdentity().executionEnvironment,
      'LOCAL_WORKER',
      'Worker without authentication token must never claim PRODUCTION_REMOTE'
    );

    // Container & package smoke test verification
    const pkgVerification = verifyWorkerPackageFiles();
    assert.equal(pkgVerification.valid, true);
    assert.equal(pkgVerification.missingFiles.length, 0);
    assert.equal(pkgVerification.emptyFiles.length, 0);
    assert.equal(pkgVerification.dockerfileStructure.exists, true);
    assert.equal(pkgVerification.dockerfileStructure.nonEmpty, true);
    assert.equal(pkgVerification.dockerfileStructure.node20PlusRuntime, true);
    assert.equal(pkgVerification.dockerfileStructure.includesSharedBackendModules, true);
    assert.equal(pkgVerification.dockerfileStructure.exposesPort8080, true);
    assert.equal(pkgVerification.dockerfileStructure.bindsAllInterfaces, true);
    assert.equal(pkgVerification.dockerfileStructure.startsWorkerEntrypoint, true);
    assert.equal(pkgVerification.dockerfileStructure.noHardcodedSecrets, true);
    assert.equal(pkgVerification.dockerfileStructure.valid, true);

    const containerSmoke = await runContainerSmokeTest();
    assert.equal(containerSmoke.verificationScope, 'CONTAINER_SMOKE_TEST');
    assert.equal(containerSmoke.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(containerSmoke.dockerfileVerified, true);
    assert.ok(
      containerSmoke.status === 'PASS' || containerSmoke.status === 'DOCKER_RUNTIME_NOT_AVAILABLE'
    );
  });
});

