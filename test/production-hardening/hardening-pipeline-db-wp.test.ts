/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  getRepositories,
  bootstrapOfficialSources,
  normalizeCanonicalUrl,
  CURRENT_SCHEMA_VERSION,
} from '../../src/backend/database/index.ts';
import { createApiApp } from '../../src/backend/api/app.ts';
import { OfficialDocumentIngestionPipeline } from '../../src/backend/ingestion/ingestion-pipeline.ts';
import {
  StructuredExtractionService,
  RecruitmentPersistenceError,
  classifyPersistenceError,
} from '../../src/backend/extraction/index.ts';
import type { NormalizedDocument } from '../../src/backend/ingestion/types.ts';
import { classifyJobFailure } from '../../src/backend/scheduler/retry-policy.ts';
import { getPipelineEngine, type PipelineContext } from '../../src/backend/pipeline/index.ts';
import { getJobService } from '../../src/backend/jobs/index.ts';
import { getAuditService } from '../../src/backend/audit/index.ts';
import { logger } from '../../src/backend/config/logger.ts';
import { SourceDiscoveryStageHandler, DocumentDiscoveryStageHandler } from '../../src/backend/pipeline/ingestion-handlers.ts';
import { DuplicateCheckStageHandler } from '../../src/backend/pipeline/duplicate-check-handler.ts';
import { WordPressPublishStageHandler } from '../../src/backend/pipeline/wordpress-publish-handler.ts';
import { sourceRegistry } from '../../src/backend/ingestion/adapters/registry.ts';
import { evaluateLiveVerificationGate } from '../../src/backend/ingestion/discovery/verification-gate.ts';

function makeContext(jobId: string, correlationId: string, metadata: Record<string, unknown> = {}): PipelineContext {
  return {
    jobId,
    correlationId,
    targetEntityType: 'TEST',
    targetEntityId: jobId,
    metadata,
    logger: logger.withContext({ jobId, correlationId }),
    auditService: getAuditService(),
  };
}

function makeValidDoc(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
  const docId = overrides.id ?? `doc-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const pageText =
    overrides.pages?.[0]?.extractedText ??
    [
      'STAFF SELECTION COMMISSION',
      'Notice No. 09/2026-HARDENING',
      'Combined Graduate Level Examination 2026',
      'Dates for submission of online applications: 01/06/2026',
      'Last date for submission of online applications: 01/07/2026',
      'Total Vacancies: 1500',
      'Age Limit: 18 to 30 years',
      "Essential Educational Qualification: Bachelor's Degree from a recognized University",
      'Selection Process: Tier-I Exam, Tier-II Exam',
      'Apply Online: https://ssc.gov.in/portal/apply-09',
    ].join('\n');

  return {
    id: docId,
    sourceId: overrides.sourceId ?? 'IN-CENTRAL-SSC',
    sourceUrl: overrides.sourceUrl ?? `https://ssc.gov.in/notices/${docId}.pdf`,
    canonicalUrl: overrides.canonicalUrl ?? `https://ssc.gov.in/notices/${docId}.pdf`,
    sourceDomain: overrides.sourceDomain ?? 'ssc.gov.in',
    checksumSha256: overrides.checksumSha256 ?? crypto.createHash('sha256').update(docId).digest('hex'),
    fileSize: overrides.fileSize ?? 4096,
    pageCount: 1,
    discoveryTimestamp: now,
    downloadTimestamp: now,
    documentType: overrides.documentType ?? 'NOTIFICATION_PDF',
    extractionStatus: 'EXTRACTED',
    extractionMethod: 'DIRECT_TEXT',
    isScanned: false,
    pages: overrides.pages ?? [
      {
        documentId: docId,
        pageNumber: 1,
        extractedText: pageText,
        charCount: pageText.length,
        extractionMethod: 'DIRECT_TEXT',
        isScanned: false,
        qualityScore: 0.99,
      },
    ],
    qualityMetadata: {
      totalCharacters: pageText.length,
      avgCharsPerPage: pageText.length,
      scannedPageCount: 0,
      textPageCount: 1,
      isScannedDocument: false,
      extractionMethod: 'DIRECT_TEXT',
    },
  };
}

function seedDocInDb(doc: NormalizedDocument): void {
  const repos = getRepositories();
  const sdoc = repos.sourceDocuments.upsertCanonical({
    id: `sdoc-${doc.id}`,
    source_id: doc.sourceId,
    url: doc.sourceUrl,
    canonical_url: doc.canonicalUrl,
    title: 'Seeded Notice',
    document_type: doc.documentType,
    raw_hash: doc.checksumSha256,
    status: 'DOWNLOADED',
    metadata_json: null,
  });
  repos.documents.upsertByHash({
    id: doc.id,
    source_document_id: sdoc.entity.id,
    source_url: doc.sourceUrl,
    canonical_url: doc.canonicalUrl,
    source_domain: doc.sourceDomain,
    file_path: `/tmp/${doc.id}.pdf`,
    file_size: doc.fileSize,
    page_count: doc.pageCount,
    mime_type: 'application/pdf',
    sha256_hash: doc.checksumSha256,
    storage_uri: null,
    validation_status: 'VALID',
    validation_notes: null,
    extraction_status: 'EXTRACTED',
    extraction_method: 'DIRECT_TEXT',
    is_scanned: 0,
  });
  repos.documents.replacePages(
    doc.id,
    doc.pages.map((p) => ({
      id: `page-${doc.id}-${p.pageNumber}`,
      document_id: doc.id,
      page_number: p.pageNumber,
      char_count: p.charCount,
      extracted_text: p.extractedText,
      extraction_method: p.extractionMethod,
      is_scanned: p.isScanned ? 1 : 0,
      quality_score: p.qualityScore ?? 1.0,
    }))
  );
}

describe('Production Hardening Part 1: BUG 1, BUG 2, BUG 3, BUG 4, BUG 10, BUG 12', () => {
  after(() => {
    closeDatabase();
  });

  // =========================================================================
  // BUG 1 — Legacy /api/ingest routes strictly through canonical PipelineEngine
  // =========================================================================
  it('[BUG 1] routes POST /api/ingest through canonical JobService/PipelineEngine, enforces auth & allowlist, and blocks legacy pipeline in production', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();

    const adminToken = 'bug1-ingest-admin-token-987654321';
    const readonlyToken = 'bug1-ingest-readonly-token-123456';
    const app = createApiApp({
      auth: { authToken: adminToken, readOnlyToken: readonlyToken },
      rateLimit: { windowMs: 60_000, maxPerIp: 1000, maxPerToken: 1000 },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // 1. Unauthenticated -> 401
      const unauth = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: 'IN-CENTRAL-SSC' }),
      });
      assert.equal(unauth.status, 401);

      // 2. Readonly token -> 403
      const forbidden = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readonlyToken}`,
        },
        body: JSON.stringify({ sourceId: 'IN-CENTRAL-SSC' }),
      });
      assert.equal(forbidden.status, 403);

      // 3. Unknown sourceId -> 400
      const unknownSrc = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ sourceId: 'IN-FAKE-SOURCE' }),
      });
      assert.equal(unknownSrc.status, 400);

      // 4. Non-official / SSRF documentUrl -> 400
      const badDomain = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          sourceId: 'IN-CENTRAL-SSC',
          documentUrl: 'http://127.0.0.1/evil.pdf',
        }),
      });
      assert.equal(badDomain.status, 400);

      const unapprovedDomain = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          sourceId: 'IN-CENTRAL-SSC',
          documentUrl: 'https://unapproved.example.com/notice.pdf',
        }),
      });
      assert.equal(unapprovedDomain.status, 400);

      // 5. Valid sourceId only -> enqueues SOURCE_DISCOVERY in canonical pipeline (idempotent on repeat)
      const srcReq1 = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ sourceId: 'IN-CENTRAL-SSC' }),
      });
      assert.equal(srcReq1.status, 202);
      const srcBody1 = (await srcReq1.json()) as {
        success: boolean;
        pipeline: string;
        deduplicated: boolean;
        stage: string;
        jobId: string;
      };
      assert.equal(srcBody1.success, true);
      assert.equal(srcBody1.pipeline, 'CANONICAL_PIPELINE_ENGINE');
      assert.equal(srcBody1.deduplicated, false);
      assert.equal(srcBody1.stage, 'SOURCE_DISCOVERY');

      const srcReq2 = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ sourceId: 'IN-CENTRAL-SSC' }),
      });
      assert.equal(srcReq2.status, 200);
      const srcBody2 = (await srcReq2.json()) as { deduplicated: boolean; jobId: string };
      assert.equal(srcBody2.deduplicated, true);
      assert.equal(srcBody2.jobId, srcBody1.jobId);

      // 6. Valid sourceId + official documentUrl -> enqueues DOCUMENT_DOWNLOAD deterministically
      const docReq1 = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          sourceId: 'IN-CENTRAL-SSC',
          documentUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
        }),
      });
      assert.equal(docReq1.status, 202);
      const docBody1 = (await docReq1.json()) as {
        success: boolean;
        stage: string;
        jobId: string;
      };
      assert.equal(docBody1.success, true);
      assert.equal(docBody1.stage, 'DOCUMENT_DOWNLOAD');

      const storedJob = getJobService().getJob(docBody1.jobId);
      assert.ok(storedJob);
      assert.equal(storedJob.stage, 'DOCUMENT_DOWNLOAD');

      // 7. Legacy OfficialDocumentIngestionPipeline blocked in NODE_ENV=production unless opted in
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const legacy = new OfficialDocumentIngestionPipeline();
        await assert.rejects(
          () =>
            legacy.processOfficialDocument({
              sourceId: 'IN-CENTRAL-SSC',
              documentUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
            }),
          (err: unknown) =>
            err instanceof Error &&
            (err as { code?: string }).code === 'LEGACY_PIPELINE_BYPASS_BLOCKED'
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
    }
  });

  // =========================================================================
  // BUG 2 — DB-level document deduplication + schema v5 legacy reconciliation
  // =========================================================================
  it('[BUG 2] enforces unique partial indexes, atomic upsert convergence, revised PDFs at same URL, and v5 legacy-duplicate migration', () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const db = getDatabase();
    const repos = getRepositories();

    // Schema version must be 5
    const ver = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number };
    assert.equal(ver.v, CURRENT_SCHEMA_VERSION);
    assert.equal(ver.v, 5);

    // 1. Atomic source_documents canonical URL convergence (ignores trailing slash/fragment/host case)
    const sd1 = repos.sourceDocuments.upsertCanonical({
      id: 'sdoc-race-1',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://SSC.GOV.IN/notices/cgl-2026.pdf#page=1',
      title: 'SSC CGL 2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DISCOVERED',
      metadata_json: null,
    });
    const sd2 = repos.sourceDocuments.upsertCanonical({
      id: 'sdoc-race-2',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notices/cgl-2026.pdf/',
      title: 'SSC CGL 2026 Duplicate',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DISCOVERED',
      metadata_json: null,
    });
    assert.equal(sd1.created, true);
    assert.equal(sd2.created, false);
    assert.equal(sd2.entity.id, sd1.entity.id);

    // Raw SQL duplicate insert into source_documents MUST violate unique index
    const canon = normalizeCanonicalUrl('https://ssc.gov.in/notices/cgl-2026.pdf');
    assert.throws(() => {
      db.prepare(
        `INSERT INTO source_documents (id, source_id, url, canonical_url, document_type, status, discovered_at, updated_at)
         VALUES ('sdoc-raw-dup', 'IN-CENTRAL-SSC', 'https://ssc.gov.in/notices/cgl-2026.pdf', ?, 'NOTIFICATION_PDF', 'DISCOVERED', datetime('now'), datetime('now'))`
      ).run(canon);
    }, /UNIQUE constraint failed/);

    // 2. Atomic documents sha256_hash convergence
    const hashV1 = '1'.repeat(64);
    const hashV2 = '2'.repeat(64);
    const doc1 = repos.documents.upsertByHash({
      id: 'doc-v1-a',
      source_document_id: sd1.entity.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/v1.pdf',
      file_size: 1000,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: hashV1,
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'PENDING',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });
    const doc1Dup = repos.documents.upsertByHash({
      id: 'doc-v1-b',
      source_document_id: sd1.entity.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/v1-dup.pdf',
      file_size: 1000,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: hashV1,
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'PENDING',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });
    assert.equal(doc1.created, true);
    assert.equal(doc1Dup.created, false);
    assert.equal(doc1Dup.entity.id, doc1.entity.id);

    // Raw SQL duplicate sha256_hash MUST violate unique index
    assert.throws(() => {
      db.prepare(
        `INSERT INTO documents (id, source_document_id, sha256_hash, downloaded_at, validation_status, extraction_status)
         VALUES ('doc-raw-dup', ?, ?, datetime('now'), 'VALID', 'PENDING')`
      ).run(sd1.entity.id, hashV1);
    }, /UNIQUE constraint failed/);

    // 3. Revised PDF at the SAME URL with a DIFFERENT sha256_hash MUST SUCCEED
    const docRevised = repos.documents.upsertByHash({
      id: 'doc-v2-revised',
      source_document_id: sd1.entity.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/v2.pdf',
      file_size: 1200,
      page_count: 2,
      mime_type: 'application/pdf',
      sha256_hash: hashV2,
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'PENDING',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });
    assert.equal(docRevised.created, true);
    assert.notEqual(docRevised.entity.id, doc1.entity.id);

    closeDatabase();

    // 4. Schema v4 -> v5 legacy duplicate reconciliation migration test on a real SQLite file
    const tmpDbPath = `/tmp/omnihub-v4-migration-test-${process.pid}-${Date.now()}.db`;
    try {
      const legacyDb = new DatabaseSync(tmpDbPath);
      legacyDb.exec('PRAGMA foreign_keys = ON;');
      legacyDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_migrations (version, name) VALUES (4, 'legacy v4');
        PRAGMA user_version = 4;
        CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, check_interval_minutes INTEGER NOT NULL DEFAULT 60, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE source_documents (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), url TEXT NOT NULL, title TEXT, document_type TEXT NOT NULL DEFAULT 'NOTIFICATION_PDF', raw_hash TEXT, status TEXT NOT NULL DEFAULT 'DISCOVERED', metadata_json TEXT, discovered_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE documents (id TEXT PRIMARY KEY, source_document_id TEXT NOT NULL REFERENCES source_documents(id), source_url TEXT, canonical_url TEXT, source_domain TEXT, file_path TEXT, file_size INTEGER, page_count INTEGER, mime_type TEXT, sha256_hash TEXT, storage_uri TEXT, validation_status TEXT NOT NULL DEFAULT 'PENDING', validation_notes TEXT, extraction_status TEXT NOT NULL DEFAULT 'PENDING', extraction_method TEXT, is_scanned INTEGER NOT NULL DEFAULT 0, downloaded_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE document_pages (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page_number INTEGER NOT NULL, char_count INTEGER NOT NULL DEFAULT 0, extracted_text TEXT, extraction_method TEXT, is_scanned INTEGER NOT NULL DEFAULT 0, quality_score REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE recruitments (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), document_id TEXT REFERENCES documents(id), title TEXT NOT NULL, department TEXT, notification_number TEXT, total_vacancies INTEGER, application_start_date TEXT, application_end_date TEXT, status TEXT NOT NULL DEFAULT 'EXTRACTION_PENDING', canonical_identity_key TEXT, raw_payload_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE jobs (id TEXT PRIMARY KEY, recruitment_id TEXT NOT NULL REFERENCES recruitments(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE publishing_records (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), recruitment_id TEXT, platform TEXT NOT NULL DEFAULT 'WORDPRESS', external_post_id TEXT, external_identity_key TEXT, permalink TEXT, post_status TEXT, publish_status TEXT NOT NULL DEFAULT 'PENDING', payload_hash TEXT, published_at TEXT, updated_at TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE audit_logs (id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'SYSTEM', action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, stage TEXT, status TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO sources (id, name, type, base_url) VALUES ('IN-CENTRAL-SSC', 'SSC', 'PORTAL', 'https://ssc.gov.in');
        INSERT INTO source_documents (id, source_id, url, title, discovered_at) VALUES ('sdoc-old-1', 'IN-CENTRAL-SSC', 'https://ssc.gov.in/dup.pdf', 'Dup 1', '2026-01-01 00:00:00');
        INSERT INTO source_documents (id, source_id, url, title, discovered_at) VALUES ('sdoc-old-2', 'IN-CENTRAL-SSC', 'https://SSC.GOV.IN/dup.pdf/', 'Dup 2', '2026-01-02 00:00:00');
        INSERT INTO documents (id, source_document_id, sha256_hash, created_at) VALUES ('doc-old-1', 'sdoc-old-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-01-01 00:00:00');
        INSERT INTO documents (id, source_document_id, sha256_hash, created_at) VALUES ('doc-old-2', 'sdoc-old-2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-01-02 00:00:00');
        INSERT INTO recruitments (id, source_id, document_id, title) VALUES ('rec-old-1', 'IN-CENTRAL-SSC', 'doc-old-2', 'Legacy Rec');
        INSERT INTO jobs (id, recruitment_id, title) VALUES ('job-old-1', 'rec-old-1', 'Legacy Job');
        INSERT INTO publishing_records (id, job_id, recruitment_id, platform, external_post_id, external_identity_key, publish_status, created_at) VALUES ('pub-old-1', 'job-old-1', 'rec-old-1', 'WORDPRESS', NULL, 'wp-key-dup', 'FAILED', '2026-01-01 00:00:00');
        INSERT INTO publishing_records (id, job_id, recruitment_id, platform, external_post_id, external_identity_key, publish_status, created_at) VALUES ('pub-old-2', 'job-old-1', 'rec-old-1', 'WORDPRESS', '999', 'wp-key-dup', 'PUBLISHED', '2026-01-02 00:00:00');
      `);
      legacyDb.close();

      initDatabase({ path: tmpDbPath, forceNew: true });
      const migratedDb = getDatabase();

      const sdocRows = migratedDb.prepare('SELECT id FROM source_documents').all() as Array<{ id: string }>;
      assert.equal(sdocRows.length, 1, 'Duplicate source_documents must be reconciled to 1 row');
      assert.equal(sdocRows[0].id, 'sdoc-old-1');

      const docRows = migratedDb.prepare('SELECT id, source_document_id FROM documents').all() as Array<{
        id: string;
        source_document_id: string;
      }>;
      assert.equal(docRows.length, 1, 'Duplicate documents must be reconciled to 1 row');
      assert.equal(docRows[0].id, 'doc-old-1');
      assert.equal(docRows[0].source_document_id, 'sdoc-old-1');

      const recRow = migratedDb.prepare('SELECT document_id FROM recruitments WHERE id = ?').get('rec-old-1') as {
        document_id: string;
      };
      assert.equal(recRow.document_id, 'doc-old-1', 'FK in recruitments must be re-pointed to surviving document');

      const pubRows = migratedDb.prepare('SELECT id, external_post_id FROM publishing_records').all() as Array<{
        id: string;
        external_post_id: string;
      }>;
      assert.equal(pubRows.length, 1, 'Duplicate publishing_records must be reconciled to 1 row');
      assert.equal(pubRows[0].id, 'pub-old-2', 'Published record with external_post_id must survive');

      const auditRows = migratedDb
        .prepare("SELECT action FROM audit_logs WHERE actor = 'SCHEMA_MIGRATION_V5'")
        .all() as Array<{ action: string }>;
      assert.ok(auditRows.length >= 3, 'Migration must record reconciliation audit logs');
    } finally {
      closeDatabase();
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(tmpDbPath + suffix)) fs.unlinkSync(tmpDbPath + suffix);
        }
      } catch {
        // ignore cleanup
      }
    }
  });

  // =========================================================================
  // BUG 3 — Persistence errors must never be swallowed; atomic rollback + classification
  // =========================================================================
  it('[BUG 3] throws RecruitmentPersistenceError on DB failure, rolls back partial writes, and classifies transient vs permanent errors', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const db = getDatabase();
    const repos = getRepositories();
    const extractionService = new StructuredExtractionService();

    // Error classification checks
    const busyClass = classifyPersistenceError(new Error('SQLITE_BUSY: database is locked'));
    assert.equal(busyClass.code, 'DB_PERSISTENCE_TRANSIENT');
    assert.equal(busyClass.retryable, true);

    const fkClass = classifyPersistenceError(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'));
    assert.equal(fkClass.code, 'DB_PERSISTENCE_PERMANENT');
    assert.equal(fkClass.retryable, false);

    // Retry policy integration checks
    const transientErr = new RecruitmentPersistenceError('database is locked', {
      code: 'DB_PERSISTENCE_TRANSIENT',
      retryable: true,
    });
    const retryTransient = classifyJobFailure(transientErr.code, transientErr.message);
    assert.equal(retryTransient, 'TRANSIENT');

    const permanentErr = new RecruitmentPersistenceError('FOREIGN KEY constraint failed', {
      code: 'DB_PERSISTENCE_PERMANENT',
      retryable: false,
    });
    const retryPermanent = classifyJobFailure(permanentErr.code, permanentErr.message);
    assert.equal(retryPermanent, 'PERMANENT');

    // Force jobs insert failure via SQLite trigger AFTER recruitments insert inside the same transaction
    const doc = makeValidDoc({ id: 'doc-bug3-rollback' });
    seedDocInDb(doc);

    const candidate = await extractionService.extractRecruitment(doc, 'corr-bug3', { persist: false });
    assert.equal(candidate.persisted, false);

    db.exec(`
      CREATE TRIGGER fail_jobs_insert_for_bug3
      BEFORE INSERT ON jobs
      BEGIN
        SELECT RAISE(ABORT, 'SQLITE_BUSY: simulated jobs table lock');
      END;
    `);

    let caughtErr: unknown = null;
    try {
      extractionService.persistRecruitmentCandidate(candidate, doc, 'corr-bug3');
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof RecruitmentPersistenceError, 'Must throw RecruitmentPersistenceError (never swallow)');
    assert.equal((caughtErr as RecruitmentPersistenceError).code, 'DB_PERSISTENCE_TRANSIENT');
    assert.equal((caughtErr as RecruitmentPersistenceError).retryable, true);
    assert.equal(candidate.persisted, false, 'Candidate must NOT be marked persisted on rollback');

    // Verify full atomic rollback: zero recruitment rows AND zero job rows committed!
    assert.equal(repos.recruitments.findById(candidate.id), null, 'Recruitments insert must be rolled back');
    assert.equal(repos.jobs.findById(`job-${candidate.id}`), null, 'Jobs insert must be rolled back');

    // Verify DuplicateCheckStageHandler surfaces persistence error cleanly with retryable metadata
    const dupHandler = new DuplicateCheckStageHandler();
    const stageRes = await dupHandler.execute(
      {
        documentId: doc.id,
        document: doc,
        structuredRecruitment: candidate,
      },
      makeContext('job-stage-bug3', 'corr-bug3-stage')
    );
    assert.equal(stageRes.success, false);
    assert.equal(stageRes.errorCode, 'DB_PERSISTENCE_TRANSIENT');
    assert.equal(stageRes.auditDetails?.retryable, true);

    db.exec('DROP TRIGGER fail_jobs_insert_for_bug3;');
    closeDatabase();
  });

  // =========================================================================
  // BUG 4 — DUPLICATE_DOCUMENT / DUPLICATE_RECRUITMENT terminate cleanly as NO-OP
  // =========================================================================
  it('[BUG 4] terminates duplicate jobs cleanly at DUPLICATE_CHECK as COMPLETED NO-OP without entering PUBLISHING_GATE or WORDPRESS_PUBLISH', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const extractionService = new StructuredExtractionService();

    // Seed and persist an initial canonical recruitment
    const doc1 = makeValidDoc({
      id: 'doc-bug4-orig',
      checksumSha256: '4'.repeat(64),
    });
    seedDocInDb(doc1);
    const rec1 = await extractionService.extractRecruitment(doc1, 'corr-bug4-1', { persist: true });
    assert.equal(rec1.persisted, true);

    // Create a second job carrying a duplicate document (same SHA-256 & recruitment identity, distinct doc id)
    const doc2 = makeValidDoc({
      id: 'doc-bug4-dup',
      checksumSha256: '4'.repeat(64),
    });
    const rec2 = await extractionService.extractRecruitment(doc2, 'corr-bug4-2', { persist: false });
    const dupInput = {
      documentId: doc2.id,
      document: doc2,
      structuredRecruitment: rec2,
    };
    const dupJob = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: doc2.id,
      initialStage: 'DUPLICATE_CHECK',
      dedupeKey: `bug4-dup-${crypto.randomUUID()}`,
      metadata: { documentId: doc2.id },
    });

    const { result: execResult } = await engine.executeCurrentStage(
      dupJob.job_id,
      'corr-bug4-dup',
      dupInput
    );
    assert.equal(execResult.success, true);
    assert.equal(execResult.terminateAsNoOp, true);
    assert.equal(execResult.terminalReason, 'DUPLICATE_SUPPRESSED');

    const finalJob = jobService.getJob(dupJob.job_id);
    assert.ok(finalJob);
    assert.equal(finalJob.status, 'COMPLETED', 'Duplicate job must terminate safely as COMPLETED');
    assert.equal(finalJob.stage, 'DUPLICATE_CHECK', 'Duplicate job must NEVER advance to PUBLISHING_GATE');
    assert.equal(finalJob.attempts, 1, 'Duplicate suppression must complete on first attempt without retries');

    const finalMeta = JSON.parse(finalJob.metadata_json || '{}') as Record<string, unknown>;
    assert.equal(finalMeta.duplicateSuppressed, true);
    assert.equal(finalMeta.terminalOutcome, 'DUPLICATE_SUPPRESSED');

    closeDatabase();
  });

  // =========================================================================
  // BUG 10 — Zero-notice / zero-document operational NO-OP vs strict live gate
  // =========================================================================
  it('[BUG 10] terminates zero-notice and zero-document runs cleanly as operational NO-OP while keeping live verification gate strict', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const engine = getPipelineEngine();
    const jobService = getJobService();

    const originalAdapter = sourceRegistry.get('IN-CENTRAL-SSC');
    assert.ok(originalAdapter);

    // Mock adapter returning valid live HTTP 200 with 0 relevant recruitment notices
    const zeroNoticeAdapter = Object.assign(Object.create(Object.getPrototypeOf(originalAdapter)), originalAdapter, {
      healthCheck: async () => ({
        healthy: true,
        verifiedLive: true,
        httpStatus: 200,
        finalUrl: 'https://ssc.gov.in',
        status: 'HEALTHY',
        message: 'Live HTTP 200 verified',
        runnerUsed: 'LOCAL' as const,
        latencyMs: 5,
        endpoint: 'https://ssc.gov.in',
      }),
      discoverNotices: async () => [],
      discoverDocuments: async () => [],
      getLastDiscoveryDiagnostics: () => ({
        sourceId: 'IN-CENTRAL-SSC',
        endpointsTried: ['https://ssc.gov.in'],
        httpStatus: 200,
        finalUrl: 'https://ssc.gov.in',
        liveVerified: true,
        recordsFound: 0,
        documentsFound: 0,
        durationMs: 12,
      }),
    });

    sourceRegistry.register(zeroNoticeAdapter);
    try {
      // 1. SOURCE_DISCOVERY with 0 notices -> COMPLETED NO-OP (SUCCESS_NO_RELEVANT_NOTICES)
      const sdHandler = new SourceDiscoveryStageHandler();
      const sdDirect = await sdHandler.execute(
        { sourceId: 'IN-CENTRAL-SSC' },
        makeContext('job-bug10-sd-direct', 'corr-bug10-sd', { sourceId: 'IN-CENTRAL-SSC' })
      );
      assert.equal(sdDirect.success, true);
      assert.equal(sdDirect.terminateAsNoOp, true);
      assert.equal(sdDirect.terminalReason, 'SUCCESS_NO_RELEVANT_NOTICES');

      const sdJob = jobService.createJob({
        targetEntityType: 'SOURCE',
        targetEntityId: 'IN-CENTRAL-SSC',
        initialStage: 'SOURCE_DISCOVERY',
        dedupeKey: `bug10-zero-notice-${crypto.randomUUID()}`,
        metadata: { sourceId: 'IN-CENTRAL-SSC' },
      });
      await engine.executeCurrentStage(sdJob.job_id, 'corr-bug10-sd-eng', { sourceId: 'IN-CENTRAL-SSC' });
      const sdStored = jobService.getJob(sdJob.job_id);
      assert.equal(sdStored?.status, 'COMPLETED');
      assert.equal(sdStored?.stage, 'SOURCE_DISCOVERY');

      // 2. DOCUMENT_DISCOVERY with 0 documents -> COMPLETED NO-OP (NO_DOCUMENT_AVAILABLE)
      const ddHandler = new DocumentDiscoveryStageHandler();
      const ddInput = {
        sourceId: 'IN-CENTRAL-SSC',
        notice: {
          id: 'n-bug10',
          sourceId: 'IN-CENTRAL-SSC',
          title: 'Informational Notice Without PDF',
          noticeUrl: 'https://ssc.gov.in/notice/1',
        },
      };
      const ddDirect = await ddHandler.execute(
        ddInput,
        makeContext('job-bug10-dd-direct', 'corr-bug10-dd', ddInput)
      );
      assert.equal(ddDirect.success, true);
      assert.equal(ddDirect.terminateAsNoOp, true);
      assert.equal(ddDirect.terminalReason, 'NO_DOCUMENT_AVAILABLE');

      // 3. Strict live verification gate MUST NEVER mark 0 notices / 0 documents as PASS
      const gateVerdict = evaluateLiveVerificationGate({
        endpointReached: true,
        listingValidated: true,
        relevantNoticeFound: false,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        httpStatus: 200,
        finalUrl: 'https://ssc.gov.in',
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
      });
      assert.notEqual(gateVerdict.outcome, 'PASS', 'Live verification gate must NEVER report PASS on 0 notices/docs');
    } finally {
      sourceRegistry.register(originalAdapter);
      closeDatabase();
    }
  });

  // =========================================================================
  // BUG 12 — WordPress concurrent publish idempotency + DB unique partial index
  // =========================================================================
  it('[BUG 12] guarantees only one WordPress post and one publishing_records row under concurrent publish workers and retry', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const repos = getRepositories();
    const db = getDatabase();
    const extractionService = new StructuredExtractionService();

    // Prepare a real publish-ready recruitment in DB
    const doc = makeValidDoc({
      id: 'doc-bug12-wp',
      checksumSha256: 'c'.repeat(64),
    });
    seedDocInDb(doc);
    const rec = await extractionService.extractRecruitment(doc, 'corr-bug12', { persist: true });
    assert.equal(rec.overallStatus, 'VERIFIED');
    repos.recruitments.updateStatus(rec.id, 'PUBLISH_READY');

    // Mock WordPress REST server tracking POST creates & GET identity lookups
    let createCalls = 0;
    let updateCalls = 0;
    const posts = new Map<number, { id: number; slug: string; title: string; content: string; status: string; metaKey: string }>();

    const wpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk.toString();
      }
      const sendJson = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/wp-json/wp/v2/users/me') {
        return sendJson(200, { id: 1, name: 'admin' });
      }
      if (url.pathname === '/wp-json/wp/v2/categories') {
        if (req.method === 'GET') return sendJson(200, [{ id: 10, name: 'Latest Jobs', slug: 'latest-jobs' }]);
        return sendJson(201, { id: 10, name: 'Latest Jobs', slug: 'latest-jobs' });
      }
      if (url.pathname === '/wp-json/wp/v2/tags') {
        return sendJson(200, []);
      }
      if (url.pathname === '/wp-json/wp/v2/posts' && req.method === 'GET') {
        const search = url.searchParams.get('search') || '';
        const slug = url.searchParams.get('slug') || '';
        const matched = Array.from(posts.values())
          .filter((p) => (search && (p.content.includes(search) || p.metaKey === search)) || (slug && p.slug === slug))
          .map((p) => ({
            id: p.id,
            slug: p.slug,
            link: `http://127.0.0.1/posts/${p.id}`,
            status: p.status,
            title: { rendered: p.title },
            content: { rendered: p.content },
            meta: { omnihub_external_identity_key: p.metaKey },
          }));
        return sendJson(200, matched);
      }
      if (url.pathname === '/wp-json/wp/v2/posts' && req.method === 'POST') {
        // Introduce slight artificial latency so concurrent callers genuinely race if unguarded
        await new Promise((r) => setTimeout(r, 40));
        createCalls++;
        const parsed = JSON.parse(bodyStr) as {
          title?: string;
          content?: string;
          slug?: string;
          status?: string;
          meta?: { omnihub_external_identity_key?: string };
        };
        const id = 500 + createCalls;
        posts.set(id, {
          id,
          slug: parsed.slug || `post-${id}`,
          title: parsed.title || 'Post',
          content: parsed.content || '',
          status: parsed.status || 'draft',
          metaKey: parsed.meta?.omnihub_external_identity_key || '',
        });
        return sendJson(201, {
          id,
          slug: parsed.slug || `post-${id}`,
          link: `http://127.0.0.1/posts/${id}`,
          status: parsed.status || 'draft',
          title: { rendered: parsed.title || 'Post' },
          content: { rendered: parsed.content || '' },
        });
      }
      const postByIdMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
      if (postByIdMatch && req.method === 'GET') {
        const id = parseInt(postByIdMatch[1], 10);
        const existing = posts.get(id);
        if (!existing) {
          return sendJson(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.' });
        }
        return sendJson(200, {
          id: existing.id,
          slug: existing.slug,
          link: `http://127.0.0.1/posts/${existing.id}`,
          status: existing.status,
          title: { rendered: existing.title },
          content: { rendered: existing.content },
          meta: { omnihub_external_identity_key: existing.metaKey },
          categories: [10],
        });
      }
      if (postByIdMatch && req.method === 'POST') {
        updateCalls++;
        const id = parseInt(postByIdMatch[1], 10);
        const existing = posts.get(id);
        const parsed = JSON.parse(bodyStr) as { title?: string; content?: string; status?: string };
        if (existing) {
          existing.title = parsed.title || existing.title;
          existing.content = parsed.content || existing.content;
          existing.status = parsed.status || existing.status;
        }
        return sendJson(200, {
          id,
          slug: existing?.slug || `post-${id}`,
          link: `http://127.0.0.1/posts/${id}`,
          status: existing?.status || 'draft',
          title: { rendered: existing?.title || 'Post' },
          content: { rendered: existing?.content || '' },
          categories: [10],
        });
      }
      return sendJson(404, { code: 'not_found' });
    });

    await new Promise<void>((resolve) => wpServer.listen(0, '127.0.0.1', () => resolve()));
    const wpUrl = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`;

    try {
      const handler = new WordPressPublishStageHandler({
        baseUrl: wpUrl,
        username: 'admin',
        appPassword: 'test-app-password-1234',
        defaultStatus: 'draft',
        timeoutMs: 5000,
        maxRetries: 0,
      });
      const baseInput = {
        recruitmentId: rec.id,
        jobId: `job-${rec.id}`,
        status: 'draft' as const,
      };

      // Launch 4 concurrent publish executions for the EXACT same recruitment
      const results = await Promise.all([
        handler.execute(baseInput, makeContext(`job-${rec.id}`, 'c1', baseInput)),
        handler.execute(baseInput, makeContext(`job-${rec.id}`, 'c2', baseInput)),
        handler.execute(baseInput, makeContext(`job-${rec.id}`, 'c3', baseInput)),
        handler.execute(baseInput, makeContext(`job-${rec.id}`, 'c4', baseInput)),
      ]);

      for (const r of results) {
        assert.equal(r.success, true, `Publish failed: ${r.errorCode} ${r.errorMessage}`);
      }

      assert.equal(createCalls, 1, 'Concurrent workers MUST create exactly ONE WordPress post');

      const pubRecords = db
        .prepare("SELECT * FROM publishing_records WHERE platform = 'WORDPRESS'")
        .all() as Array<{ id: string; external_post_id: string; external_identity_key: string }>;
      assert.equal(pubRecords.length, 1, 'Database MUST contain exactly ONE publishing_records row');
      assert.equal(pubRecords[0].external_post_id, '501');

      // Raw SQL duplicate (platform, external_identity_key) MUST violate unique partial index
      assert.throws(() => {
        db.prepare(
          `INSERT INTO publishing_records (id, job_id, recruitment_id, platform, external_post_id, external_identity_key, publish_status)
           VALUES ('pub-raw-dup', ?, ?, 'WORDPRESS', '999', ?, 'PUBLISHED')`
        ).run(`job-${rec.id}`, rec.id, pubRecords[0].external_identity_key);
      }, /UNIQUE constraint failed/);

      // Force update updates existing post instead of creating a second one
      const updateRes = await handler.execute(
        { ...baseInput, forceUpdate: true },
        makeContext(`job-${rec.id}`, 'c5', { ...baseInput, forceUpdate: true })
      );
      assert.equal(updateRes.success, true, `forceUpdate failed: ${updateRes.errorCode} ${updateRes.errorMessage}`);
      assert.equal(createCalls, 1, 'forceUpdate must never create a second WP post');
      assert.equal(updateCalls, 1, 'forceUpdate must update existing WP post');

      // Lost-response retry recovery: simulate local DB losing the publishing_records row
      // AFTER WordPress already created post 501; retry must discover post 501 via remote identity lookup
      // and NEVER create a duplicate post!
      db.prepare("DELETE FROM publishing_records WHERE platform = 'WORDPRESS'").run();
      assert.equal(
        (db.prepare("SELECT COUNT(*) as c FROM publishing_records").get() as { c: number }).c,
        0
      );
      const retryAfterLostResponse = await handler.execute(
        baseInput,
        makeContext(`job-${rec.id}`, 'c6-lost-response-retry', baseInput)
      );
      assert.equal(
        retryAfterLostResponse.success,
        true,
        `Lost-response retry failed: ${retryAfterLostResponse.errorCode} ${retryAfterLostResponse.errorMessage}`
      );
      assert.equal(
        createCalls,
        1,
        'Retry after lost create response MUST discover existing remote post and NEVER create a duplicate'
      );
      const recoveredRecords = db
        .prepare("SELECT external_post_id FROM publishing_records WHERE platform = 'WORDPRESS'")
        .all() as Array<{ external_post_id: string }>;
      assert.equal(recoveredRecords.length, 1);
      assert.equal(recoveredRecords[0].external_post_id, '501');
    } finally {
      await new Promise<void>((resolve) => wpServer.close(() => resolve()));
      closeDatabase();
    }
  });
});
