/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  initDatabase,
  closeDatabase,
  getRepositories,
  bootstrapOfficialSources,
} from '../../src/backend/database/index.ts';
import { getJobService } from '../../src/backend/jobs/index.ts';
import { HttpRemoteAcquisitionRunner } from '../../src/backend/ingestion/discovery/acquisition-runner.ts';
import { DocumentDownloader } from '../../src/backend/ingestion/downloader/document-downloader.ts';
import { sourceRegistry } from '../../src/backend/ingestion/adapters/registry.ts';
import {
  DocumentDownloadStageHandler,
  SourceDiscoveryStageHandler,
} from '../../src/backend/pipeline/ingestion-handlers.ts';
import { WordPressPublishStageHandler } from '../../src/backend/pipeline/wordpress-publish-handler.ts';
import { resetDocumentStorageService } from '../../src/backend/storage/index.ts';
import { loadConfig } from '../../src/backend/config/index.ts';
import { logger } from '../../src/backend/config/logger.ts';
import { getAuditService } from '../../src/backend/audit/index.ts';
import type { PipelineContext } from '../../src/backend/pipeline/contracts.ts';
import type { StructuredRecruitmentData, StructuredRecruitmentRecord } from '../../src/backend/extraction/types.ts';
import type { NormalizedDocument } from '../../src/backend/ingestion/types.ts';
import type { PublishingEvaluationTarget } from '../../src/backend/publishing-gate/types.ts';

const VALID_PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF\n' +
    ' '.repeat(1200),
  'utf8'
);

function makeContext(jobId: string, metadata: Record<string, unknown> = {}): PipelineContext {
  return {
    jobId,
    correlationId: `corr-${jobId}`,
    targetEntityType: 'SOURCE',
    targetEntityId: jobId,
    metadata,
    logger,
    auditService: getAuditService(),
  };
}

describe('Production Hardening: Remote Acquisition E2E (BUG 2), WordPress Readback Verification (BUG 8), Parent/Child Reconciliation (BUG 12)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const tempDirs: string[] = [];

  function setEnv(key: string, val: string | undefined): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  beforeEach(() => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
  });

  afterEach(() => {
    closeDatabase();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
    loadConfig();
    resetDocumentStorageService();
    for (const d of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // =========================================================================
  // BUG 2 — Remote Acquisition E2E (RUNNER_MODE=REMOTE, zero local fallback, checksum & PDF validation)
  // =========================================================================
  it('[BUG 2] executes discovery and download via REMOTE worker without calling local fetch, verifies checksum & PDF locally, and rejects corrupted/HTML payloads', async () => {
    const validSha = crypto.createHash('sha256').update(VALID_PDF_BYTES).digest('hex');
    const storageDir = path.resolve(
      process.cwd(),
      '.test-durable-storage',
      `bug2-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    );
    fs.mkdirSync(storageDir, { recursive: true });
    tempDirs.push(storageDir);

    let workerMode: 'VALID_PDF' | 'BAD_CHECKSUM' | 'HTML_PAYLOAD' = 'VALID_PDF';

    const mockWorker = http.createServer((req, res) => {
      const urlPath = req.url || '/';
      if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            workerId: 'remote-worker-test-01',
            executionEnvironment: 'LOCAL_WORKER',
          })
        );
        return;
      }

      if (urlPath === '/acquire' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (c) => (rawBody += c));
        req.on('end', () => {
          const body = JSON.parse(rawBody || '{}') as {
            endpoint?: string;
            targetUrl?: string;
            url?: string;
            responseType?: string;
            methodType?: string;
            requestPolicy?: { responseType?: string };
          };
          const targetUrl =
            body.endpoint || body.targetUrl || body.url || 'https://ssc.gov.in/api/general-website/portal/notice-boards';
          const isPdfRequest =
            body.requestPolicy?.responseType === 'BINARY' ||
            body.responseType === 'BINARY' ||
            body.methodType === 'DOCUMENT_PDF' ||
            targetUrl.toLowerCase().endsWith('.pdf');

          if (isPdfRequest) {
            if (workerMode === 'BAD_CHECKSUM') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'SUCCESS',
                  actualRunner: 'REMOTE',
                  executionEnvironment: 'LOCAL_WORKER',
                  remoteWorkerId: 'remote-worker-test-01',
                  httpStatus: 200,
                  finalUrl: targetUrl,
                  redirectChain: [targetUrl],
                  contentType: 'application/pdf',
                  contentLength: VALID_PDF_BYTES.length,
                  bytesReceived: VALID_PDF_BYTES.length,
                  isPdf: true,
                  sha256: 'f'.repeat(64),
                  contentBase64: VALID_PDF_BYTES.toString('base64'),
                  timestamp: new Date().toISOString(),
                })
              );
              return;
            }
            if (workerMode === 'HTML_PAYLOAD') {
              const htmlBuf = Buffer.from('<html><body>Blocked Portal Page</body></html>', 'utf8');
              const htmlSha = crypto.createHash('sha256').update(htmlBuf).digest('hex');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'SUCCESS',
                  actualRunner: 'REMOTE',
                  executionEnvironment: 'LOCAL_WORKER',
                  remoteWorkerId: 'remote-worker-test-01',
                  httpStatus: 200,
                  finalUrl: targetUrl,
                  redirectChain: [targetUrl],
                  contentType: 'text/html',
                  contentLength: htmlBuf.length,
                  bytesReceived: htmlBuf.length,
                  isPdf: false,
                  sha256: htmlSha,
                  contentBase64: htmlBuf.toString('base64'),
                  timestamp: new Date().toISOString(),
                })
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'SUCCESS',
                actualRunner: 'REMOTE',
                executionEnvironment: 'LOCAL_WORKER',
                remoteWorkerId: 'remote-worker-test-01',
                httpStatus: 200,
                finalUrl: targetUrl,
                redirectChain: [targetUrl],
                contentType: 'application/pdf',
                contentLength: VALID_PDF_BYTES.length,
                bytesReceived: VALID_PDF_BYTES.length,
                isPdf: true,
                sha256: validSha,
                contentBase64: VALID_PDF_BYTES.toString('base64'),
                timestamp: new Date().toISOString(),
              })
            );
            return;
          }

          const sscPayload = JSON.stringify({
            statusCode: 200,
            data: [
              {
                id: '901',
                headline: 'Combined Graduate Level Examination 2026 Notice',
                createdAt: '2026-08-01T00:00:00Z',
                redirectUrl: 'https://ssc.gov.in/api/attachment/uploads/masterData/NoticeBoards/cgl2026.pdf',
              },
            ],
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'SUCCESS',
              actualRunner: 'REMOTE',
              executionEnvironment: 'LOCAL_WORKER',
              remoteWorkerId: 'remote-worker-test-01',
              httpStatus: 200,
              finalUrl: targetUrl,
              redirectChain: [targetUrl],
              contentType: 'application/json',
              contentLength: Buffer.byteLength(sscPayload),
              bytesReceived: Buffer.byteLength(sscPayload),
              content: sscPayload,
              timestamp: new Date().toISOString(),
            })
          );
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockWorker.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockWorker.address() as AddressInfo;
    const workerUrl = `http://127.0.0.1:${addr.port}`;

    setEnv('RUNNER_MODE', 'REMOTE');
    setEnv('OFFICIAL_ACQUISITION_RUNNER_MODE', 'REMOTE');
    setEnv('OFFICIAL_ACQUISITION_WORKER_URL', workerUrl);
    setEnv('OFFICIAL_ACQUISITION_WORKER_TOKEN', 'test-worker-token-123');
    setEnv('DOCUMENT_STORAGE_DIR', storageDir);
    loadConfig();
    resetDocumentStorageService();

    // Spy on global fetch to guarantee NO direct local government fetch occurs in REMOTE mode
    const originalFetch = globalThis.fetch;
    const directGovCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (reqUrl.includes('ssc.gov.in')) {
        directGovCalls.push(reqUrl);
        throw new Error(`Direct local fetch to ${reqUrl} is forbidden in RUNNER_MODE=REMOTE!`);
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const remoteRunner = new HttpRemoteAcquisitionRunner({
        workerUrl,
        authToken: 'test-worker-token-123',
        allowLocalWorkerHttp: true,
        skipWorkerUrlIpValidation: true,
      });

      // 1. Adapter healthCheck in REMOTE mode must route via remote worker, NEVER direct local fetch
      const sscAdapter = sourceRegistry.get('IN-CENTRAL-SSC');
      assert.ok(sscAdapter, 'SSC adapter must be registered');
      const health = await sscAdapter.healthCheck(5000, {
        runnerMode: 'REMOTE',
        remoteRunner,
      });
      assert.equal(health.status, 'HEALTHY');
      assert.equal(health.runnerUsed, 'REMOTE');
      assert.equal(directGovCalls.length, 0, 'Adapter healthCheck in REMOTE mode must never call ssc.gov.in directly');

      // 2. SourceDiscoveryStageHandler propagates runnerMode and metadata
      const discoveryHandler = new SourceDiscoveryStageHandler();
      const discRes = await discoveryHandler.execute(
        { sourceId: 'IN-CENTRAL-SSC', runnerMode: 'REMOTE', remoteRunner },
        makeContext('job-bug2-disc', { sourceId: 'IN-CENTRAL-SSC', runnerMode: 'REMOTE' })
      );
      assert.equal(discRes.success, true);
      assert.equal(discRes.output?.discoveryMetadata.runner, 'REMOTE');
      assert.equal(discRes.output?.discoveryMetadata.runnerMode, 'REMOTE');
      assert.ok((discRes.output?.notices.length ?? 0) >= 1);
      assert.equal(directGovCalls.length, 0);

      // 3. DocumentDownloadStageHandler downloads via remote worker, verifies SHA-256 & PDF locally, stores durably
      const downloadHandler = new DocumentDownloadStageHandler();
      const pdfUrl = 'https://ssc.gov.in/api/attachment/uploads/masterData/NoticeBoards/cgl2026.pdf';
      const dlRes = await downloadHandler.execute(
        { documentUrl: pdfUrl, sourceId: 'IN-CENTRAL-SSC', runnerMode: 'REMOTE', remoteRunner },
        makeContext('job-bug2-dl', { sourceId: 'IN-CENTRAL-SSC', runnerMode: 'REMOTE' })
      );
      assert.equal(dlRes.success, true);
      assert.equal(dlRes.output?.runner, 'REMOTE');
      assert.equal(dlRes.output?.workerId, 'remote-worker-test-01');
      assert.equal(dlRes.output?.checksumSha256, validSha);
      assert.equal(dlRes.output?.httpStatus, 200);
      assert.ok(
        dlRes.output?.filePath && dlRes.output.filePath.startsWith(storageDir),
        'Downloaded PDF must be stored in durable DocumentStorageService'
      );
      assert.equal(directGovCalls.length, 0);

      // 4. Remote checksum mismatch MUST fail closed with CORRUPT_PDF
      workerMode = 'BAD_CHECKSUM';
      const downloader = new DocumentDownloader({
        runnerMode: 'REMOTE',
        remoteRunner,
      });
      await assert.rejects(
        () => downloader.download(pdfUrl),
        (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'CORRUPT_PDF'
      );

      // 5. Remote HTML error page disguised as PDF download MUST be rejected locally
      workerMode = 'HTML_PAYLOAD';
      await assert.rejects(
        () => downloader.download(pdfUrl),
        (err: unknown) =>
          err instanceof Error &&
          ['NOT_PDF', 'CORRUPT_PDF', 'DOWNLOAD_FAILED'].includes(String((err as { code?: string }).code))
      );

      // 6. SSRF / non-official domain rejected even in REMOTE mode
      workerMode = 'VALID_PDF';
      await assert.rejects(
        () => downloader.download('http://127.0.0.1:8080/internal-secret.pdf'),
        (err: unknown) => err instanceof Error
      );
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => mockWorker.close(() => resolve()));
    }
  });

  // =========================================================================
  // BUG 8 — WordPress Post-Write Readback Verification
  // =========================================================================
  it('[BUG 8] verifies published WordPress post via GET readback and fails closed on readback/category mismatch', async () => {
    let readbackMode: 'VALID' | 'MISSING_CATEGORY' = 'VALID';
    let readbackGetCount = 0;
    const storedPosts = new Map<number, Record<string, unknown>>();
    let nextId = 700;

    const mockWp = http.createServer((req, res) => {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath === '/wp-json/wp/v2/users/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 1, name: 'Admin' }));
        return;
      }
      if (urlPath === '/wp-json/wp/v2/categories') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 11, name: 'Latest Jobs', slug: 'latest-jobs' }]));
        return;
      }
      if (urlPath === '/wp-json/wp/v2/posts' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      if (urlPath === '/wp-json/wp/v2/posts' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          const id = nextId++;
          const post = {
            id,
            status: payload.status || 'draft',
            slug: payload.slug || `post-${id}`,
            link: `http://127.0.0.1/jobs/${payload.slug || id}/`,
            categories: payload.categories || [11],
            content: { rendered: String(payload.content || ''), raw: String(payload.content || '') },
            title: { rendered: String(payload.title || '') },
            date_gmt: new Date().toISOString(),
            modified_gmt: new Date().toISOString(),
          };
          storedPosts.set(id, post);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(post));
        });
        return;
      }
      const getByIdMatch = urlPath.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
      if (getByIdMatch && req.method === 'GET') {
        readbackGetCount += 1;
        const id = Number(getByIdMatch[1]);
        const post = storedPosts.get(id);
        if (!post) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'rest_post_invalid_id' }));
          return;
        }
        const responsePost = { ...post };
        if (readbackMode === 'MISSING_CATEGORY') {
          responsePost.categories = [];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responsePost));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockWp.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockWp.address() as AddressInfo;
    const wpUrl = `http://127.0.0.1:${addr.port}`;

    setEnv('OMNIHUB_WP_URL', wpUrl);
    setEnv('OMNIHUB_WP_USERNAME', 'wp_admin');
    setEnv('OMNIHUB_WP_APP_PASSWORD', 'app-pass-1234-5678');
    setEnv('OMNIHUB_WP_DEFAULT_STATUS', 'draft');
    loadConfig();

    const docId = 'doc-bug8-wp-01';
    const pageText = [
      'Staff Selection Commission',
      'SSC Combined Graduate Level Examination 2026',
      'Advertisement No: SSC/WP/2026',
      'Total Vacancies: 500',
      'Application Start Date: 05/07/2026',
      'Last Date: 15/08/2026',
      'Educational Qualification: Bachelor Degree',
      'Age Limit: 20 to 30 years',
      'Selection Process: Written Exam',
      'Apply Online: https://ssc.gov.in/apply/cgl',
    ].join('\n');

    const makeField = <T>(fieldName: string, value: T, snippet: string) => ({
      value,
      state: 'VERIFIED' as const,
      confidence: 0.96,
      evidence: {
        document_id: docId,
        page_number: 1,
        field_name: fieldName,
        evidence_text: snippet,
        extraction_method: 'DIRECT_TEXT' as const,
        verified_in_document: true,
        documentId: docId,
        pageNumber: 1,
        snippet,
        verifiedInDocument: true,
      },
      validationNotes: 'Verified',
    });

    const missingField = () => ({
      value: null,
      state: 'MISSING' as const,
      confidence: 0,
      evidence: null,
      validationNotes: 'Missing',
    });

    const fields: StructuredRecruitmentData = {
      organization: makeField('organization', 'Staff Selection Commission', 'Staff Selection Commission'),
      recruitment_title: makeField(
        'recruitment_title',
        'SSC Combined Graduate Level Examination 2026',
        'SSC Combined Graduate Level Examination 2026'
      ),
      advertisement_number: makeField('advertisement_number', 'SSC/WP/2026', 'Advertisement No: SSC/WP/2026'),
      recruitment_type: makeField('recruitment_type', 'DIRECT', 'SSC Combined Graduate Level Examination 2026'),
      total_vacancies: makeField('total_vacancies', 500, 'Total Vacancies: 500'),
      category_wise_vacancies: missingField(),
      application_start_date: makeField('application_start_date', '2026-07-05', 'Application Start Date: 05/07/2026'),
      application_last_date: makeField('application_last_date', '2026-08-15', 'Last Date: 15/08/2026'),
      correction_last_date: missingField(),
      exam_date: missingField(),
      admit_card_date: missingField(),
      result_date: missingField(),
      application_fee: missingField(),
      age_min: makeField('age_min', 20, 'Age Limit: 20 to 30 years'),
      age_max: makeField('age_max', 30, 'Age Limit: 20 to 30 years'),
      age_relaxation: missingField(),
      educational_qualification: makeField(
        'educational_qualification',
        'Bachelor Degree',
        'Educational Qualification: Bachelor Degree'
      ),
      experience: missingField(),
      salary_pay_level: missingField(),
      selection_process: makeField('selection_process', ['Written Exam'], 'Selection Process: Written Exam'),
      exam_pattern: missingField(),
      negative_marking: missingField(),
      syllabus: missingField(),
      required_documents: missingField(),
      important_instructions: missingField(),
      official_notification_url: {
        value: 'https://ssc.gov.in/notice.pdf',
        state: 'VERIFIED',
        confidence: 1.0,
        evidence: {
          document_id: docId,
          page_number: 0,
          field_name: 'official_notification_url',
          evidence_text: 'https://ssc.gov.in/notice.pdf',
          extraction_method: 'DOCUMENT_METADATA',
          provenance_type: 'DOCUMENT_METADATA',
          verified_in_document: false,
          metadata_verified: true,
        },
      },
      official_application_url: makeField(
        'official_application_url',
        'https://ssc.gov.in/apply/cgl',
        'Apply Online: https://ssc.gov.in/apply/cgl'
      ),
    };

    const now = new Date().toISOString();
    const doc: NormalizedDocument = {
      id: docId,
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notice.pdf',
      canonicalUrl: 'https://ssc.gov.in/notice.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'a'.repeat(64),
      fileSize: 2048,
      pageCount: 1,
      discoveryTimestamp: now,
      downloadTimestamp: now,
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: docId,
          pageNumber: 1,
          extractedText: pageText,
          charCount: pageText.length,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
          qualityScore: 0.98,
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

    const buildTarget = (recruitmentId: string): PublishingEvaluationTarget => {
      const structuredRecord: StructuredRecruitmentRecord = {
        id: recruitmentId,
        canonicalIdentityKey: `recruitment::IN-CENTRAL-SSC::advt::${recruitmentId}`,
        persisted: true,
        sourceId: 'IN-CENTRAL-SSC',
        documentId: docId,
        overallStatus: 'VERIFIED',
        isCorrigendum: false,
        languageDetected: 'ENGLISH',
        fields,
        extractionTimestamp: now,
        auditTrail: [],
      };
      return {
        recruitmentId,
        sourceId: 'IN-CENTRAL-SSC',
        documentId: docId,
        title: 'SSC Combined Graduate Level Examination 2026',
        department: 'Staff Selection Commission',
        notificationNumber: 'SSC/WP/2026',
        totalVacancies: 500,
        applicationStartDate: '2026-07-05',
        applicationEndDate: '2026-08-15',
        status: 'VERIFIED',
        fields,
        structuredRecord,
        document: doc,
        pages: [{ pageNumber: 1, extractedText: pageText }],
      };
    };

    try {
      const repos = getRepositories();
      repos.sourceDocuments.create({
        id: 'srcdoc-bug8-01',
        source_id: 'IN-CENTRAL-SSC',
        url: doc.canonicalUrl,
        title: 'SSC CGL 2026',
        document_type: 'NOTIFICATION_PDF',
        raw_hash: doc.checksumSha256,
        status: 'DOWNLOADED',
        metadata_json: null,
      });
      repos.documents.create({
        id: doc.id,
        source_document_id: 'srcdoc-bug8-01',
        source_url: doc.sourceUrl,
        canonical_url: doc.canonicalUrl,
        source_domain: doc.sourceDomain,
        file_path: '/tmp/doc-bug8-wp-01.pdf',
        file_size: 2048,
        page_count: 1,
        mime_type: 'application/pdf',
        sha256_hash: doc.checksumSha256,
        storage_uri: 'file:///tmp/doc-bug8-wp-01.pdf',
        validation_status: 'VALID',
        validation_notes: 'Valid',
        extraction_status: 'EXTRACTED',
        extraction_method: 'DIRECT_TEXT',
        is_scanned: 0,
      });

      const handler = new WordPressPublishStageHandler();
      const jobService = getJobService();

      // 1. Valid publish must run explicit GET readback verification and return postVerified=true
      const jobOk = jobService.createJob({
        targetEntityType: 'RECRUITMENT',
        targetEntityId: 'rec-bug8-wp-01',
        initialStage: 'WORDPRESS_PUBLISH',
      });
      const resOk = await handler.execute(
        { target: buildTarget('rec-bug8-wp-01'), categories: ['Latest Jobs'] },
        makeContext(jobOk.job_id)
      );
      assert.equal(resOk.success, true, `Expected publish success, got ${resOk.errorCode}: ${resOk.errorMessage}`);
      const okOutput = resOk.output as { postVerified?: boolean; wpPostId?: number };
      assert.equal(okOutput.postVerified, true);
      assert.equal(okOutput.wpPostId, 700);
      assert.equal(readbackGetCount, 1, 'WordPress publisher MUST execute GET /posts/:id readback verification');

      // 2. If GET readback reveals missing category assignment, fail closed with WP_POST_VERIFICATION_FAILED
      readbackMode = 'MISSING_CATEGORY';
      const jobFail = jobService.createJob({
        targetEntityType: 'RECRUITMENT',
        targetEntityId: 'rec-bug8-wp-02',
        initialStage: 'WORDPRESS_PUBLISH',
      });
      const resFail = await handler.execute(
        { target: buildTarget('rec-bug8-wp-02'), categories: ['Latest Jobs'] },
        makeContext(jobFail.job_id)
      );
      assert.equal(resFail.success, false);
      assert.equal(resFail.errorCode, 'WP_POST_VERIFICATION_FAILED');
      const failedPubRecords = repos.publishing.findByJob('rec-bug8-wp-02');
      assert.ok(failedPubRecords.some((r) => r.publish_status === 'FAILED'));
    } finally {
      await new Promise<void>((resolve) => mockWp.close(() => resolve()));
    }
  });

  // =========================================================================
  // BUG 12 — Parent / Child Failure Reconciliation
  // =========================================================================
  it('[BUG 12] reconciles PAUSED parents to FAILED, PARTIAL_FAILED, CANCELLED, keeps PAUSED on retryable failure, recovers on child retry, and avoids duplicate reconciliation', () => {
    const jobService = getJobService();
    const repos = getRepositories();

    const createParentWithChildren = (prefix: string) => {
      const parent = jobService.createJob({
        targetEntityType: 'SOURCE',
        targetEntityId: `source-${prefix}`,
        initialStage: 'SOURCE_DISCOVERY',
      });
      jobService.startJob(parent.job_id, `corr-${prefix}-p`);

      const child1 = jobService.createJob({
        parentJobId: parent.job_id,
        targetEntityType: 'NOTICE',
        targetEntityId: `notice-${prefix}-1`,
        initialStage: 'DOCUMENT_DISCOVERY',
        maxAttempts: 2,
      });
      const child2 = jobService.createJob({
        parentJobId: parent.job_id,
        targetEntityType: 'NOTICE',
        targetEntityId: `notice-${prefix}-2`,
        initialStage: 'DOCUMENT_DISCOVERY',
        maxAttempts: 2,
      });

      jobService.awaitChildJobs(parent.job_id, {
        fanOutStage: 'SOURCE_DISCOVERY',
        childInitialStage: 'DOCUMENT_DISCOVERY',
        childJobIds: [child1.job_id, child2.job_id],
        createdChildJobIds: [child1.job_id, child2.job_id],
        dedupedChildJobIds: [],
      });

      return { parent, child1, child2 };
    };

    // Case 1: Retryable child failure keeps parent PAUSED; once all children fail permanently -> FAILED
    const c1 = createParentWithChildren('all-fail');
    jobService.startJob(c1.child1.job_id, 'corr-c1-1');
    jobService.failJob(c1.child1.job_id, 'NETWORK_TIMEOUT', 'Transient timeout', 'corr-c1-1', {
      deferParentReconciliation: true,
    });
    assert.equal(
      jobService.getJob(c1.parent.job_id)?.status,
      'PAUSED',
      'Parent must stay PAUSED while child has retryable transient failure'
    );

    // Permanently fail second child
    jobService.startJob(c1.child2.job_id, 'corr-c1-2');
    jobService.failJob(c1.child2.job_id, 'PERMANENT_404', 'Not found', 'corr-c1-2');
    const p1After = jobService.reconcileParentCompletion(c1.parent.job_id, 'corr-c1-reconcile');
    assert.equal(p1After?.status, 'FAILED');
    assert.equal(p1After?.error_code, 'CHILD_JOBS_FAILED');

    // Duplicate reconciliation call must NOT emit a duplicate audit entry
    const auditBeforeDup = repos.auditLogs
      .listByEntity('PROCESSING_JOB', c1.parent.job_id)
      .filter((a) => a.action === 'PARENT_JOB_FAILED_AFTER_CHILDREN').length;
    jobService.reconcileParentCompletion(c1.parent.job_id, 'corr-c1-reconcile-dup');
    const auditAfterDup = repos.auditLogs
      .listByEntity('PROCESSING_JOB', c1.parent.job_id)
      .filter((a) => a.action === 'PARENT_JOB_FAILED_AFTER_CHILDREN').length;
    assert.equal(auditAfterDup, auditBeforeDup, 'Duplicate reconciliation must be strictly idempotent');

    // Case 2: Mixed success + failure -> PARTIAL_FAILED; manual retry of failed child recovers parent -> COMPLETED
    const c2 = createParentWithChildren('partial');
    jobService.startJob(c2.child1.job_id, 'corr-c2-1');
    jobService.completeJob(c2.child1.job_id, 'corr-c2-1');
    assert.equal(
      jobService.getJob(c2.parent.job_id)?.status,
      'PAUSED',
      'Parent stays PAUSED while child2 is PENDING'
    );

    jobService.startJob(c2.child2.job_id, 'corr-c2-2');
    jobService.failJob(c2.child2.job_id, 'PDF_CORRUPT', 'Corrupt PDF', 'corr-c2-2');
    const p2Partial = jobService.getJob(c2.parent.job_id);
    assert.equal(p2Partial?.status, 'PARTIAL_FAILED');
    assert.equal(p2Partial?.error_code, 'CHILD_JOBS_PARTIAL_FAILED');

    // Operator manually retries failed child2 -> parent transitions back to PAUSED awaiting retry
    jobService.retryJob(c2.child2.job_id, 'ADMIN_TEST', 'corr-c2-retry');
    assert.equal(
      jobService.getJob(c2.parent.job_id)?.status,
      'PAUSED',
      'Parent must recover from PARTIAL_FAILED back to PAUSED when a failed child is retried'
    );

    // Retried child2 succeeds -> parent completes cleanly
    jobService.startJob(c2.child2.job_id, 'corr-c2-2-retry');
    jobService.completeJob(c2.child2.job_id, 'corr-c2-2-retry');
    assert.equal(jobService.getJob(c2.parent.job_id)?.status, 'COMPLETED');

    // Case 3: All children cancelled -> parent CANCELLED
    const c3 = createParentWithChildren('cancel');
    jobService.cancelJob(c3.child1.job_id, 'corr-c3-1');
    assert.equal(jobService.getJob(c3.parent.job_id)?.status, 'PAUSED');
    jobService.cancelJob(c3.child2.job_id, 'corr-c3-2');
    assert.equal(jobService.getJob(c3.parent.job_id)?.status, 'CANCELLED');
  });
});
