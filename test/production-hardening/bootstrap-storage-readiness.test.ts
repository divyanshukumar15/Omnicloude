/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  getRepositories,
  bootstrapOfficialSources,
  OFFICIAL_BOOTSTRAP_SOURCES,
} from '../../src/backend/database/index.ts';
import { SourceDiscoverySeeder } from '../../src/backend/scheduler/source-discovery-seeder.ts';
import {
  DocumentStorageService,
  DocumentStorageError,
  resetDocumentStorageService,
} from '../../src/backend/storage/index.ts';
import {
  buildTruthfulVerificationReport,
  isHistoricalArchiveReport,
  normalizeTruthfulStatus,
  normalizeVerificationRunner,
} from '../../src/backend/ingestion/discovery/verification-model.ts';
import { runRemoteProductionVerification } from '../../src/backend/ingestion/discovery/verify-remote-production.ts';
import { evaluateSystemReadiness } from '../../src/backend/runtime/readiness-service.ts';
import { createApiApp } from '../../src/backend/api/app.ts';
import { loadConfig } from '../../src/backend/config/index.ts';

describe('Production Hardening: Bootstrap (BUG 1), Durable Storage (BUG 3), Truthful Verification (BUG 7), Identity/Hygiene (BUG 10/11), Readiness (BUG 13)', () => {
  const createdDirs: string[] = [];

  function makeLocalDurableDir(label: string): string {
    const dir = path.resolve(
      process.cwd(),
      '.test-durable-storage',
      `${label}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    );
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
    return dir;
  }

  after(() => {
    resetDocumentStorageService();
    loadConfig();
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
    const parentRoot = path.resolve(process.cwd(), '.test-durable-storage');
    try {
      if (fs.existsSync(parentRoot) && fs.readdirSync(parentRoot).length === 0) {
        fs.rmdirSync(parentRoot);
      }
    } catch {
      // ignore
    }
  });

  // =========================================================================
  // BUG 1 — Fresh DB Source Bootstrap
  // =========================================================================
  it('[BUG 1] bootstraps all 7 official sources on fresh DB, is idempotent, preserves custom/disabled sources, and feeds SourceDiscoverySeeder', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();
    const db = getDatabase();

    assert.equal(repos.sources.listAll().length, 0, 'Fresh DB starts with empty sources table');

    const first = bootstrapOfficialSources();
    assert.equal(first.insertedCount, OFFICIAL_BOOTSTRAP_SOURCES.length);
    assert.equal(first.totalSourceCount, 7);
    assert.equal(first.activeSourceCount, 7);

    // Customize one source interval and disable another source
    db.prepare('UPDATE sources SET check_interval_minutes = ?, name = ? WHERE id = ?').run(
      15,
      'Custom SSC Portal',
      'IN-CENTRAL-SSC'
    );
    db.prepare('UPDATE sources SET is_active = 0 WHERE id = ?').run('IN-UP-UPSSSC');

    // Re-running bootstrap must be strictly idempotent and NEVER overwrite custom config or re-enable disabled sources
    const second = bootstrapOfficialSources();
    assert.equal(second.insertedCount, 0);
    assert.equal(second.preservedCount, 7);
    assert.equal(second.activeSourceCount, 6);

    const ssc = repos.sources.findById('IN-CENTRAL-SSC');
    assert.equal(ssc?.check_interval_minutes, 15);
    assert.equal(ssc?.name, 'Custom SSC Portal');

    const upsssc = repos.sources.findById('IN-UP-UPSSSC');
    assert.equal(upsssc?.is_active, 0, 'Disabled source must stay disabled across bootstrap runs');

    // Verify SourceDiscoverySeeder immediately schedules active sources on fresh bootstrapped DB
    const seeder = new SourceDiscoverySeeder({
      config: { enabled: true, seedIntervalMs: 60_000, maxAttempts: 3, actor: 'TEST_SEEDER' },
    });
    const seedResult = await seeder.seedDueSources();
    assert.equal(seedResult.evaluatedSources, 6);
    assert.equal(seedResult.queuedCount, 6);
    assert.ok(
      !seedResult.decisions.some((d) => d.sourceId === 'IN-UP-UPSSSC'),
      'Inactive source must not be seeded'
    );

    closeDatabase();
  });

  // =========================================================================
  // BUG 3 — Durable Document Storage
  // =========================================================================
  it('[BUG 3] saves, retrieves, verifies checksums, survives service restart, detects corruption, and enforces fail-closed in production', () => {
    const durableDir = makeLocalDurableDir('bug3-durable');
    const samplePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
      'utf8'
    );
    const expectedSha = crypto.createHash('sha256').update(samplePdf).digest('hex');

    const storage1 = new DocumentStorageService({
      storageDir: durableDir,
      env: { NODE_ENV: 'production', DOCUMENT_STORAGE_DIR: durableDir },
    });
    const health1 = storage1.getHealth();
    assert.equal(health1.status, 'DURABLE_READY');
    assert.equal(health1.ready, true);
    assert.equal(health1.durable, true);
    assert.equal(health1.usingTempFallback, false);

    // Save document atomically
    const saved = storage1.saveDocument({
      buffer: samplePdf,
      expectedSha256: expectedSha,
      sourceId: 'IN-CENTRAL-SSC',
      documentId: 'doc-bug3-01',
      sourceUrl: 'https://ssc.gov.in/notice.pdf',
      canonicalUrl: 'https://ssc.gov.in/notice.pdf',
    });
    assert.equal(saved.sha256Hash, expectedSha);
    assert.equal(saved.deduplicated, false);
    assert.ok(saved.filePath.startsWith(durableDir));

    // Confirm no leftover .tmp files in shard directory
    const shardDir = path.dirname(saved.filePath);
    const dirEntries = fs.readdirSync(shardDir);
    assert.ok(!dirEntries.some((f) => f.includes('.tmp-')), 'Atomic write must leave zero .tmp files');

    // Reject save with wrong expected checksum
    assert.throws(
      () =>
        storage1.saveDocument({
          buffer: samplePdf,
          expectedSha256: '0'.repeat(64),
        }),
      (err: unknown) => err instanceof DocumentStorageError && err.code === 'DOCUMENT_STORAGE_CHECKSUM_MISMATCH'
    );

    // Simulate process restart with a brand new DocumentStorageService instance
    const storage2 = new DocumentStorageService({
      storageDir: durableDir,
      env: { NODE_ENV: 'production', DOCUMENT_STORAGE_DIR: durableDir },
    });
    assert.equal(storage2.exists(expectedSha), true);
    const readBack = storage2.readDocument(expectedSha, expectedSha);
    assert.equal(readBack.checksumVerified, true);
    assert.equal(readBack.sha256Hash, expectedSha);
    assert.equal(readBack.buffer.equals(samplePdf), true);
    assert.equal(readBack.metadata?.sourceId, 'IN-CENTRAL-SSC');

    // Corrupt stored file on disk and verify checksum verification fails closed
    fs.writeFileSync(saved.filePath, Buffer.from('%PDF-1.4\nCORRUPTED_BYTES\n%%EOF\n', 'utf8'));
    const check = storage2.verifyChecksum(saved.filePath, expectedSha);
    assert.equal(check.valid, false);
    assert.throws(
      () => storage2.readDocument(saved.filePath, expectedSha),
      (err: unknown) => err instanceof DocumentStorageError && err.code === 'DOCUMENT_STORAGE_CHECKSUM_MISMATCH'
    );

    // Production fail-closed when DOCUMENT_STORAGE_DIR is unset
    const unconfiguredProd = new DocumentStorageService({
      env: { NODE_ENV: 'production' },
    });
    const unconfiguredHealth = unconfiguredProd.getHealth();
    assert.equal(unconfiguredHealth.status, 'NOT_CONFIGURED');
    assert.equal(unconfiguredHealth.ready, false);
    assert.throws(
      () => unconfiguredProd.saveDocument({ buffer: samplePdf }),
      (err: unknown) => err instanceof DocumentStorageError && err.code === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
    );

    // Production fail-closed when DOCUMENT_STORAGE_DIR points to /tmp or os.tmpdir()
    const ephemeralProd = new DocumentStorageService({
      env: { NODE_ENV: 'production', DOCUMENT_STORAGE_DIR: path.join(os.tmpdir(), 'omnihub-ephemeral-test') },
    });
    const ephemeralHealth = ephemeralProd.getHealth();
    assert.equal(ephemeralHealth.status, 'NOT_DURABLE');
    assert.equal(ephemeralHealth.ready, false);
    assert.throws(
      () => ephemeralProd.saveDocument({ buffer: samplePdf }),
      (err: unknown) => err instanceof DocumentStorageError && err.code === 'DOCUMENT_STORAGE_NOT_DURABLE'
    );
  });

  // =========================================================================
  // BUG 7 — Truthful Live / Remote Verification
  // =========================================================================
  it('[BUG 7] enforces canonical verification statuses, never labels MOCK/LOCAL as REMOTE, detects historical archives, and never hardcodes PASS', async () => {
    assert.equal(normalizeTruthfulStatus('PASS'), 'PASS');
    assert.equal(normalizeTruthfulStatus('FAIL'), 'FAIL');
    assert.equal(normalizeTruthfulStatus('INCONCLUSIVE'), 'INCONCLUSIVE');
    assert.equal(normalizeTruthfulStatus('NOT_CONFIGURED'), 'NOT_CONFIGURED');
    assert.equal(normalizeTruthfulStatus('NOT_RUN'), 'NOT_RUN');
    assert.equal(normalizeTruthfulStatus('UNKNOWN_VALUE'), 'NOT_RUN');

    assert.equal(normalizeVerificationRunner({ isMock: true, actualRunner: 'REMOTE' }), 'MOCK');
    assert.equal(normalizeVerificationRunner({ executionOrigin: 'MOCK_REMOTE', actualRunner: 'REMOTE' }), 'MOCK');
    assert.equal(normalizeVerificationRunner({ executionOrigin: 'LOCAL', actualRunner: 'LOCAL' }), 'LOCAL');
    assert.equal(
      normalizeVerificationRunner({ executionOrigin: 'REAL_REMOTE_PRODUCTION', actualRunner: 'REMOTE' }),
      'REMOTE'
    );

    // Any MOCK entry prevents REAL_REMOTE_PRODUCTION from ever becoming PROVEN
    const mockReport = buildTruthfulVerificationReport({
      mode: 'REAL_REMOTE_PRODUCTION',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      realRemoteProduction: 'PROVEN',
      entries: [
        {
          source: 'SSC',
          sourceId: 'IN-CENTRAL-SSC',
          adapter: 'SscSourceAdapter',
          runner: 'MOCK',
          checkType: 'REMOTE_PRODUCTION',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          executionId: 'exec-mock-1',
          status: 'PASS',
          errorCategory: null,
          httpStatus: 200,
          finalUrl: 'https://ssc.gov.in',
          evidence: {},
        },
      ],
    });
    assert.equal(mockReport.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');

    assert.equal(
      isHistoricalArchiveReport({ artifactType: 'HISTORICAL_ARCHIVE', isCurrentRun: false }),
      true
    );
    assert.equal(isHistoricalArchiveReport({ artifactType: 'CURRENT_RUN', isCurrentRun: true }), false);

    // Unconfigured remote verification MUST report NOT_CONFIGURED and NEVER hardcode PASS for SSC/UPSC/UPPSC
    const prevWorkerUrl = process.env.OFFICIAL_ACQUISITION_WORKER_URL;
    const prevWorkerToken = process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
    delete process.env.OFFICIAL_ACQUISITION_WORKER_URL;
    delete process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
    try {
      const report = await runRemoteProductionVerification({
        workerUrl: '',
        authToken: '',
        artifactPath: null,
      });
      assert.equal(report.artifactType, 'CURRENT_RUN');
      assert.equal(report.isCurrentRun, true);
      assert.ok(report.executionId.length > 0);
      assert.equal(report.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
      assert.equal(report.stages.WORKER_URL_CONFIGURATION, 'NOT_CONFIGURED');

      const entries = Object.values(report.governmentSources);
      assert.equal(entries.length, 7);
      for (const entry of entries) {
        assert.notEqual(
          entry.outcome,
          'PASS',
          `Unconfigured verification must NEVER hardcode PASS for ${entry.source}`
        );
        assert.ok(['NOT_CONFIGURED', 'NOT_RUN'].includes(entry.outcome));
      }
    } finally {
      if (prevWorkerUrl !== undefined) process.env.OFFICIAL_ACQUISITION_WORKER_URL = prevWorkerUrl;
      if (prevWorkerToken !== undefined) process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN = prevWorkerToken;
    }
  });

  // =========================================================================
  // BUG 10 & BUG 11 — Project Identity & Diagnostic / Historical Artifact Hygiene
  // =========================================================================
  it('[BUG 10 & 11] verifies package identity, removed diagnostic-test.txt, and marked historical artifacts', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name: string };
    assert.equal(pkg.name, 'omnihub-govjobs-automation-ai');

    const diagPath = path.resolve(process.cwd(), 'diagnostic-test.txt');
    assert.equal(fs.existsSync(diagPath), false, 'diagnostic-test.txt must be deleted');

    const liveArtifactPath = path.resolve(process.cwd(), 'artifacts', 'live-verification-report.json');
    if (fs.existsSync(liveArtifactPath)) {
      const parsed = JSON.parse(fs.readFileSync(liveArtifactPath, 'utf8'));
      assert.equal(isHistoricalArchiveReport(parsed), true);
    }

    const remoteArtifactPath = path.resolve(
      process.cwd(),
      'artifacts',
      'remote-production-verification-report.json'
    );
    if (fs.existsSync(remoteArtifactPath)) {
      const parsed = JSON.parse(fs.readFileSync(remoteArtifactPath, 'utf8'));
      assert.equal(isHistoricalArchiveReport(parsed), true);
    }
  });

  // =========================================================================
  // BUG 13 — Truthful Production Readiness Across /api/health, /api/status, /api/operations
  // =========================================================================
  it('[BUG 13] reports consistent separated readiness flags across evaluateSystemReadiness, /api/health, /api/status, and /api/operations', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();

    const adminToken = 'bug13-readiness-admin-token-123456';
    const app = createApiApp({
      auth: { authToken: adminToken },
      rateLimit: { windowMs: 60_000, maxPerIp: 1000, maxPerToken: 1000 },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const directReport = await evaluateSystemReadiness({
        remoteTimeoutMs: 500,
        skipDockerCliCheck: true,
      });

      assert.equal(directReport.CODE_READY, true);
      assert.equal(
        directReport.PRODUCTION_PROVEN,
        false,
        'Without external HTTPS WP + worker + OCR, PRODUCTION_PROVEN must be false'
      );
      assert.equal(directReport.dependencies.sourceRegistry.status, 'READY');
      assert.equal(directReport.dependencies.sourceAdapters.status, 'READY');
      assert.ok(directReport.blockers.length > 0, 'Unconfigured external dependencies must appear in blockers');

      const [healthRes, statusRes, opsRes] = await Promise.all([
        fetch(`${baseUrl}/api/health`),
        fetch(`${baseUrl}/api/status`),
        fetch(`${baseUrl}/api/operations`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      ]);

      assert.equal(healthRes.status, 200);
      assert.equal(statusRes.status, 200);
      assert.equal(opsRes.status, 200);

      const health = (await healthRes.json()) as Record<string, unknown>;
      const status = (await statusRes.json()) as Record<string, unknown>;
      const ops = (await opsRes.json()) as Record<string, unknown>;

      assert.equal(health.CODE_READY, status.CODE_READY);
      assert.equal(status.CODE_READY, ops.CODE_READY);
      assert.equal(health.RUNTIME_READY, status.RUNTIME_READY);
      assert.equal(status.RUNTIME_READY, ops.RUNTIME_READY);
      assert.equal(health.EXTERNAL_SERVICES_READY, status.EXTERNAL_SERVICES_READY);
      assert.equal(status.EXTERNAL_SERVICES_READY, ops.EXTERNAL_SERVICES_READY);
      assert.equal(health.PRODUCTION_PROVEN, false);
      assert.equal(status.PRODUCTION_PROVEN, false);
      assert.equal(ops.PRODUCTION_PROVEN, false);
      assert.equal(health.overall_readiness, status.readiness);
      assert.equal(status.readiness, ops.readiness);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
    }
  });
});
