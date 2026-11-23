/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { initDatabase, closeDatabase, getRepositories } from '../src/backend/database/index.ts';
import { getAuditService } from '../src/backend/audit/index.ts';
import {
  getJobService,
  buildDocumentDedupeKey,
  buildNoticeDedupeKey,
} from '../src/backend/jobs/index.ts';
import {
  PipelineEngine,
  SourceDiscoveryStageHandler,
  DocumentDiscoveryStageHandler,
  DocumentDownloadStageHandler,
  DocumentValidationStageHandler,
  TextExtractionStageHandler,
  StructuredExtractionStageHandler,
  EvidenceValidationStageHandler,
  DuplicateCheckStageHandler,
  PublishingGateStageHandler,
  WordPressPublishStageHandler,
} from '../src/backend/pipeline/index.ts';
import { SchedulerService } from '../src/backend/scheduler/scheduler-service.ts';
import { sourceRegistry } from '../src/backend/ingestion/adapters/registry.ts';
import { BaseSourceAdapter } from '../src/backend/ingestion/adapters/base-adapter.ts';
import type { ISourceAdapter, SourceHealthResult } from '../src/backend/ingestion/adapters/source-adapter.interface.ts';
import type {
  DiscoveredDocument,
  DiscoveredNotice,
  NormalizedDocument,
} from '../src/backend/ingestion/types.ts';
import type {
  OfficialAcquisitionRunner,
  AcquisitionRequest,
  AcquisitionResult,
} from '../src/backend/ingestion/discovery/acquisition-runner.ts';
import { DocumentDownloader } from '../src/backend/ingestion/downloader/document-downloader.ts';
import type { OCRProvider, OcrDocumentResult, OcrPageResult } from '../src/backend/ingestion/ocr/types.ts';
import { UnconfiguredOCRProvider } from '../src/backend/ingestion/ocr/providers/unconfigured-ocr-provider.ts';
import { logger } from '../src/backend/config/logger.ts';
import {
  createValidSamplePdf,
  createScannedSamplePdf,
  createMixedSamplePdf,
} from './ingestion/fixtures.ts';

interface MockWpPost {
  id: number;
  title: { raw: string; rendered: string };
  content: { raw: string; rendered: string };
  excerpt: { raw: string; rendered: string };
  status: string;
  slug: string;
  link: string;
  categories: number[];
  featured_media: number;
  meta: Record<string, unknown>;
  modified_gmt: string;
}

interface OfficialNoticeParams {
  org: string;
  title: string;
  advtNo: string;
  vacancies: number;
  startDate: string;
  lastDate: string;
  qualification: string;
  ageRange: string;
  selectionProcess: string;
  applyUrl: string;
}

function buildOfficialNoticeLines(params: OfficialNoticeParams): string[] {
  return [
    params.org,
    params.title,
    `Advt. No.: ${params.advtNo}`,
    `Total Vacancies: ${params.vacancies}`,
    `Online Application Starts: ${params.startDate}`,
    `Application Last Date: ${params.lastDate}`,
    `Age Limit: ${params.ageRange}`,
    `Educational Qualification: ${params.qualification}`,
    `Selection Process: ${params.selectionProcess}`,
    `Official Application URL: ${params.applyUrl}`,
  ];
}

function buildOfficialNoticeText(params: OfficialNoticeParams): string {
  return buildOfficialNoticeLines(params).join('\n');
}

function escapePdfLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function createOfficialNoticePdf(params: OfficialNoticeParams): Buffer {
  const lines = buildOfficialNoticeLines(params);
  const textOps = lines
    .map((line, index) => `${index === 0 ? '40 740 Td' : '0 -18 Td'}\n(${escapePdfLiteral(line)}) Tj`)
    .join('\n');
  const contentStream = `BT\n/F1 11 Tf\n${textOps}\nET`;
  const streamLength = Buffer.byteLength(contentStream, 'latin1');

  const objects: Array<{ num: number; body: string }> = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    },
    { num: 4, body: `<< /Length ${streamLength} >>\nstream\n${contentStream}\nendstream` },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets[obj.num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const startXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function createMockWordPressServer(): Promise<{
  server: http.Server;
  baseUrl: string;
  username: string;
  appPassword: string;
  posts: Map<number, MockWpPost>;
  reset: () => void;
}> {
  const username = 'omnihub_test_publisher';
  const appPassword = 'test pass word 1234 5678';
  const expectedAuth = `Basic ${Buffer.from(`${username}:${appPassword}`, 'utf-8').toString('base64')}`;

  const posts = new Map<number, MockWpPost>();
  let categories = [{ id: 10, name: 'Government Jobs', slug: 'government-jobs' }];
  let nextPostId = 1001;
  let nextCatId = 11;

  const reset = () => {
    posts.clear();
    categories = [{ id: 10, name: 'Government Jobs', slug: 'government-jobs' }];
    nextPostId = 1001;
    nextCatId = 11;
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'rest_cannot_access', message: 'Unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    const jsonBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

    if (reqUrl.pathname === '/wp-json/wp/v2/categories' && req.method === 'GET') {
      const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
      const matched = search
        ? categories.filter((c) => c.name.toLowerCase().includes(search))
        : categories;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matched));
      return;
    }

    if (reqUrl.pathname === '/wp-json/wp/v2/categories' && req.method === 'POST') {
      const name = String(jsonBody.name || 'Category');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const created = { id: nextCatId++, name, slug };
      categories.push(created);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
      return;
    }

    if (reqUrl.pathname === '/wp-json/wp/v2/posts' && req.method === 'GET') {
      const search = (reqUrl.searchParams.get('search') || '').toLowerCase();
      const allPosts = Array.from(posts.values());
      const matched = search
        ? allPosts.filter(
            (p) =>
              p.content.raw.toLowerCase().includes(search) ||
              String(p.meta?.omnihub_external_identity_key || '').toLowerCase().includes(search)
          )
        : allPosts;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matched));
      return;
    }

    if (reqUrl.pathname === '/wp-json/wp/v2/posts' && req.method === 'POST') {
      const id = nextPostId++;
      const title = String(jsonBody.title || 'Untitled');
      const content = String(jsonBody.content || '');
      const excerpt = String(jsonBody.excerpt || '');
      const slug = String(jsonBody.slug || `post-${id}`);
      const status = String(jsonBody.status || 'draft');
      const postCategories = Array.isArray(jsonBody.categories)
        ? (jsonBody.categories as number[])
        : [10];
      const meta = (jsonBody.meta as Record<string, unknown>) || {};
      const record: MockWpPost = {
        id,
        title: { raw: title, rendered: title },
        content: { raw: content, rendered: content },
        excerpt: { raw: excerpt, rendered: excerpt },
        status,
        slug,
        link: `http://127.0.0.1/posts/${slug}/`,
        categories: postCategories,
        featured_media: Number(jsonBody.featured_media || 0),
        meta,
        modified_gmt: new Date().toISOString(),
      };
      posts.set(id, record);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record));
      return;
    }

    const updateMatch = reqUrl.pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
    if (updateMatch && req.method === 'GET') {
      const id = Number(updateMatch[1]);
      const existing = posts.get(id);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'rest_post_invalid_id', message: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(existing));
      return;
    }

    if (updateMatch && req.method === 'POST') {
      const id = Number(updateMatch[1]);
      const existing = posts.get(id);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'rest_post_invalid_id', message: 'Not found' }));
        return;
      }
      const title = String(jsonBody.title ?? existing.title.raw);
      const content = String(jsonBody.content ?? existing.content.raw);
      const excerpt = String(jsonBody.excerpt ?? existing.excerpt.raw);
      const updated: MockWpPost = {
        ...existing,
        title: { raw: title, rendered: title },
        content: { raw: content, rendered: content },
        excerpt: { raw: excerpt, rendered: excerpt },
        status: String(jsonBody.status ?? existing.status),
        slug: String(jsonBody.slug ?? existing.slug),
        categories: Array.isArray(jsonBody.categories)
          ? (jsonBody.categories as number[])
          : existing.categories,
        meta: { ...existing.meta, ...((jsonBody.meta as Record<string, unknown>) || {}) },
        modified_gmt: new Date().toISOString(),
      };
      posts.set(id, updated);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        username,
        appPassword,
        posts,
        reset,
      });
    });
  });
}

function createFixtureRunner(pdfMap: Map<string, Buffer>): OfficialAcquisitionRunner {
  return {
    runnerKind: 'LOCAL',
    isMock: true,
    isConfigured: () => true,
    async acquire(request: AcquisitionRequest): Promise<AcquisitionResult> {
      const buf = pdfMap.get(request.endpoint);
      if (!buf) {
        return {
          sourceId: request.sourceId,
          methodType: request.methodType,
          endpoint: request.endpoint,
          finalUrl: request.endpoint,
          httpStatus: 404,
          contentType: 'text/plain',
          content: null,
          binaryContent: null,
          responseBytes: 0,
          redirectChain: [request.endpoint],
          durationMs: 5,
          attempts: 1,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          failureClassification: 'HTTP_404',
          failureClass: 'HTTP_404',
          failureDetails: `Fixture PDF not found for ${request.endpoint}`,
          errorType: 'HTTP_404',
          errorCode: 'HTTP_404',
          errorName: 'NotFound',
          retryable: false,
          runnerUsed: 'LOCAL',
          executionOrigin: 'FIXTURE',
          localAccess: 'HTTP_ERROR',
          remoteAccess: 'NOT_ATTEMPTED',
          selectedRunner: 'LOCAL',
          selectionReason: 'Test fixture runner',
        };
      }
      return {
        sourceId: request.sourceId,
        methodType: request.methodType,
        endpoint: request.endpoint,
        finalUrl: request.endpoint,
        httpStatus: 200,
        contentType: 'application/pdf',
        content: null,
        binaryContent: buf,
        responseBytes: buf.length,
        isPdf: true,
        redirectChain: [request.endpoint],
        durationMs: 5,
        attempts: 1,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        failureClassification: 'NONE',
        failureDetails: null,
        errorType: null,
        errorCode: null,
        errorName: null,
        retryable: false,
        runnerUsed: 'LOCAL',
        executionOrigin: 'FIXTURE',
        localAccess: 'SUCCESS',
        remoteAccess: 'NOT_ATTEMPTED',
        selectedRunner: 'LOCAL',
        selectionReason: 'Test fixture runner',
      };
    },
  };
}

class FixtureSourceAdapter extends BaseSourceAdapter {
  readonly sourceId: string;
  readonly name: string;
  readonly jurisdiction = 'CENTRAL' as const;
  readonly baseUrl: string;
  private readonly notices: DiscoveredNotice[];
  private readonly docsByNoticeId: Map<string, DiscoveredDocument[]>;

  constructor(params: {
    sourceId: string;
    name: string;
    baseUrl: string;
    notices: DiscoveredNotice[];
    docsByNoticeId: Map<string, DiscoveredDocument[]>;
  }) {
    super();
    this.sourceId = params.sourceId;
    this.name = params.name;
    this.baseUrl = params.baseUrl;
    this.notices = params.notices;
    this.docsByNoticeId = params.docsByNoticeId;
  }

  async healthCheck(): Promise<SourceHealthResult> {
    return {
      sourceId: this.sourceId,
      authorityName: this.name,
      jurisdiction: this.jurisdiction,
      baseUrl: this.baseUrl,
      officialDomains: this.officialDomains,
      status: 'HEALTHY',
      healthState: 'UP',
      verifiedLive: true,
      httpStatus: 200,
      latencyMs: 1,
      message: 'Fixture official source reachable',
      checkedAt: new Date().toISOString(),
    };
  }

  async discoverNotices(): Promise<DiscoveredNotice[]> {
    return this.notices;
  }

  async discoverDocuments(notice: DiscoveredNotice): Promise<DiscoveredDocument[]> {
    return this.docsByNoticeId.get(notice.id) || [];
  }

  async normalizeDocument(doc: NormalizedDocument): Promise<NormalizedDocument> {
    return doc;
  }

  parseNotices() {
    return { notices: [], structureIntact: true };
  }
}

function createFixtureAdapter(params: {
  sourceId: string;
  name: string;
  baseUrl: string;
  notices: DiscoveredNotice[];
  docsByNoticeId: Map<string, DiscoveredDocument[]>;
}): ISourceAdapter {
  return new FixtureSourceAdapter(params);
}

function buildWiredPipelineEngine(options: {
  pdfMap: Map<string, Buffer>;
  ocrProvider?: OCRProvider;
  wpClientConfig?: {
    baseUrl: string;
    username: string;
    appPassword: string;
    allowHttp?: boolean;
    defaultStatus?: 'draft' | 'publish';
  };
}): PipelineEngine {
  const jobService = getJobService();
  const auditService = getAuditService();
  const engine = new PipelineEngine(jobService, auditService, logger);
  const runner = createFixtureRunner(options.pdfMap);

  engine.registerStageHandler(new SourceDiscoveryStageHandler());
  engine.registerStageHandler(new DocumentDiscoveryStageHandler());
  engine.registerStageHandler(
    new DocumentDownloadStageHandler(new DocumentDownloader(), {
      acquisitionRunner: runner,
    })
  );
  engine.registerStageHandler(new DocumentValidationStageHandler());
  engine.registerStageHandler(
    new TextExtractionStageHandler({
      ocrProvider: options.ocrProvider ?? new UnconfiguredOCRProvider(),
    })
  );
  engine.registerStageHandler(new StructuredExtractionStageHandler());
  engine.registerStageHandler(new EvidenceValidationStageHandler());
  engine.registerStageHandler(new DuplicateCheckStageHandler());
  engine.registerStageHandler(new PublishingGateStageHandler());
  engine.registerStageHandler(new WordPressPublishStageHandler(options.wpClientConfig));

  return engine;
}

async function drainSchedulerUntilIdle(
  scheduler: SchedulerService,
  maxRounds = 20
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const res = await scheduler.pollOnce();
    await scheduler.waitForIdle();
    if (res.claimedJobIds.length === 0 && res.recoveredJobIds.length === 0) {
      break;
    }
  }
}

describe('End-to-End 10-Stage Pipeline Fan-Out, Contracts, OCR & Recovery Tests', () => {
  let wpMock: Awaited<ReturnType<typeof createMockWordPressServer>>;
  let tempStorageDir: string;
  const originalStorageDir = process.env.DOCUMENT_STORAGE_DIR;
  const originalWpUrl = process.env.OMNIHUB_WP_URL;
  const originalWpUser = process.env.OMNIHUB_WP_USER;
  const originalWpPass = process.env.OMNIHUB_WP_APP_PASSWORD;
  const registeredFixtureSources: string[] = [];

  before(async () => {
    wpMock = await createMockWordPressServer();
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-pipeline-docs-'));
    process.env.DOCUMENT_STORAGE_DIR = tempStorageDir;
    delete process.env.OMNIHUB_WP_URL;
    delete process.env.OMNIHUB_WP_USER;
    delete process.env.OMNIHUB_WP_APP_PASSWORD;
  });

  beforeEach(() => {
    wpMock.reset();
    initDatabase({ path: ':memory:', forceNew: true });
    while (registeredFixtureSources.length > 0) {
      const id = registeredFixtureSources.pop()!;
      sourceRegistry.unregister(id);
    }
  });

  after(async () => {
    while (registeredFixtureSources.length > 0) {
      const id = registeredFixtureSources.pop()!;
      sourceRegistry.unregister(id);
    }
    closeDatabase();
    if (originalStorageDir === undefined) delete process.env.DOCUMENT_STORAGE_DIR;
    else process.env.DOCUMENT_STORAGE_DIR = originalStorageDir;
    if (originalWpUrl === undefined) delete process.env.OMNIHUB_WP_URL;
    else process.env.OMNIHUB_WP_URL = originalWpUrl;
    if (originalWpUser === undefined) delete process.env.OMNIHUB_WP_USER;
    else process.env.OMNIHUB_WP_USER = originalWpUser;
    if (originalWpPass === undefined) delete process.env.OMNIHUB_WP_APP_PASSWORD;
    else process.env.OMNIHUB_WP_APP_PASSWORD = originalWpPass;
    fs.rmSync(tempStorageDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => wpMock.server.close(() => resolve()));
  });

  it('[PASS] executes 1 notice -> 1 document end-to-end across all 10 stages via SchedulerService', async () => {
    const sourceId = 'IN-CENTRAL-SSC-FIXTURE-1';
    const docUrl = 'https://ssc.gov.in/notices/cgl-2026-main.pdf';
    const pdfBuffer = createOfficialNoticePdf({
      org: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026',
      advtNo: '04/2026-CGL',
      vacancies: 14582,
      startDate: '01/06/2026',
      lastDate: '01/07/2026',
      ageRange: '18 to 32 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'Tier-I CBT and Tier-II Examination',
      applyUrl: 'https://ssc.gov.in/portal/apply-cgl-2026',
    });

    const pdfMap = new Map<string, Buffer>([[docUrl, pdfBuffer]]);
    const notice: DiscoveredNotice = {
      id: 'notice-cgl-2026',
      sourceId,
      title: 'Combined Graduate Level Examination 2026',
      noticeUrl: 'https://ssc.gov.in/notices/cgl-2026',
    };
    const doc: DiscoveredDocument = {
      id: 'doc-cgl-2026-pdf',
      noticeId: notice.id,
      sourceId,
      documentUrl: docUrl,
      canonicalUrl: docUrl,
      documentType: 'NOTIFICATION_PDF',
      title: 'CGL 2026 Official PDF',
      discoveredAt: new Date().toISOString(),
      sourceDomain: 'ssc.gov.in',
    };

    sourceRegistry.register(
      createFixtureAdapter({
        sourceId,
        name: 'SSC Fixture',
        baseUrl: 'https://ssc.gov.in',
        notices: [notice],
        docsByNoticeId: new Map([[notice.id, [doc]]]),
      })
    );
    registeredFixtureSources.push(sourceId);

    const engine = buildWiredPipelineEngine({
      pdfMap,
      wpClientConfig: {
        baseUrl: wpMock.baseUrl,
        username: wpMock.username,
        appPassword: wpMock.appPassword,
        allowHttp: true,
        defaultStatus: 'draft',
      },
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 2, heartbeatIntervalMs: 0 },
    });

    const sourceJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: sourceId,
      initialStage: 'SOURCE_DISCOVERY',
      metadata: { sourceId },
    });

    // Tick 1: SOURCE_DISCOVERY fans out notice child and parks parent in PAUSED (NOT premature COMPLETED!)
    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const sourceAfterTick1 = jobService.getJob(sourceJob.job_id)!;
    assert.equal(sourceAfterTick1.status, 'PAUSED', 'Discovery parent must NOT be COMPLETED while children are pending');

    const noticeChildren = jobService.getChildJobs(sourceJob.job_id);
    assert.equal(noticeChildren.length, 1);
    assert.equal(noticeChildren[0].stage, 'DOCUMENT_DISCOVERY');
    assert.equal(noticeChildren[0].parent_job_id, sourceJob.job_id);
    assert.equal(noticeChildren[0].dedupe_key, buildNoticeDedupeKey(sourceId, notice.noticeUrl));

    // Tick 2: DOCUMENT_DISCOVERY fans out document child and parks notice parent in PAUSED
    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const noticeAfterTick2 = jobService.getJob(noticeChildren[0].job_id)!;
    assert.equal(noticeAfterTick2.status, 'PAUSED', 'Notice discovery job must NOT be COMPLETED before document finishes publishing');

    const docChildren = jobService.getChildJobs(noticeChildren[0].job_id);
    assert.equal(docChildren.length, 1);
    assert.equal(docChildren[0].stage, 'DOCUMENT_DOWNLOAD');
    assert.equal(docChildren[0].parent_job_id, noticeChildren[0].job_id);
    assert.equal(docChildren[0].dedupe_key, buildDocumentDedupeKey(sourceId, docUrl));

    // Tick 3: Document child runs Stages 3 -> 10 to WORDPRESS_PUBLISH and reconciles parents
    await drainSchedulerUntilIdle(scheduler);

    const finalDocJob = jobService.getJob(docChildren[0].job_id)!;
    const finalNoticeJob = jobService.getJob(noticeChildren[0].job_id)!;
    const finalSourceJob = jobService.getJob(sourceJob.job_id)!;

    assert.equal(finalDocJob.stage, 'WORDPRESS_PUBLISH');
    assert.equal(finalDocJob.status, 'COMPLETED');
    assert.equal(finalNoticeJob.status, 'COMPLETED');
    assert.equal(finalSourceJob.status, 'COMPLETED');

    assert.equal(wpMock.posts.size, 1);
    const createdPost = Array.from(wpMock.posts.values())[0];
    assert.equal(createdPost.status, 'draft');
    assert.ok(createdPost.title.raw.includes('Combined Graduate Level Examination 2026'));

    // Ensure no raw PDF buffer was stored in processing_jobs.metadata_json
    assert.ok(finalDocJob.metadata_json);
    assert.ok(!finalDocJob.metadata_json!.includes('%PDF-'));
    assert.ok(!finalDocJob.metadata_json!.includes('"buffer"'));
  });

  it('[PASS] fans out 1 notice -> multiple documents with unique deterministic identities and zero duplicates on repeat discovery', async () => {
    const sourceId = 'IN-CENTRAL-UPSC-FIXTURE-MULTI';
    const docUrlA = 'https://www.upsc.gov.in/sites/default/files/cse-2026-notif.pdf';
    const docUrlB = 'https://www.upsc.gov.in/sites/default/files/ifos-2026-notif.pdf';

    const pdfA = createOfficialNoticePdf({
      org: 'Union Public Service Commission',
      title: 'Civil Services Examination 2026',
      advtNo: '05/2026-CSP',
      vacancies: 1056,
      startDate: '10/02/2026',
      lastDate: '05/03/2026',
      ageRange: '21 to 32 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'Preliminary Examination, Main Examination and Interview',
      applyUrl: 'https://upsconline.nic.in/apply/cse-2026',
    });
    const pdfB = createOfficialNoticePdf({
      org: 'Union Public Service Commission',
      title: 'Recruitment to the post of Indian Forest Service Officer 2026',
      advtNo: '06/2026-IFOS',
      vacancies: 150,
      startDate: '12/02/2026',
      lastDate: '08/03/2026',
      ageRange: '21 to 32 years',
      qualification: "Bachelor's Degree from a recognized University in Science",
      selectionProcess: 'Preliminary Examination, Main Examination and Personality Test',
      applyUrl: 'https://upsconline.nic.in/apply/ifos-2026',
    });

    const pdfMap = new Map<string, Buffer>([
      [docUrlA, pdfA],
      [docUrlB, pdfB],
    ]);

    const notice: DiscoveredNotice = {
      id: 'notice-upsc-2026-bundle',
      sourceId,
      title: 'UPSC 2026 Combined Notices',
      noticeUrl: 'https://www.upsc.gov.in/examinations/active-exams',
    };

    const docs: DiscoveredDocument[] = [
      {
        id: 'doc-upsc-cse',
        noticeId: notice.id,
        sourceId,
        documentUrl: docUrlA,
        canonicalUrl: docUrlA,
        documentType: 'NOTIFICATION_PDF',
        title: 'CSE 2026 PDF',
        discoveredAt: new Date().toISOString(),
        sourceDomain: 'www.upsc.gov.in',
      },
      {
        id: 'doc-upsc-ifos',
        noticeId: notice.id,
        sourceId,
        documentUrl: docUrlB,
        canonicalUrl: docUrlB,
        documentType: 'NOTIFICATION_PDF',
        title: 'IFoS 2026 PDF',
        discoveredAt: new Date().toISOString(),
        sourceDomain: 'www.upsc.gov.in',
      },
    ];

    sourceRegistry.register(
      createFixtureAdapter({
        sourceId,
        name: 'UPSC Multi-Doc Fixture',
        baseUrl: 'https://www.upsc.gov.in',
        notices: [notice],
        docsByNoticeId: new Map([[notice.id, docs]]),
      })
    );
    registeredFixtureSources.push(sourceId);

    const engine = buildWiredPipelineEngine({
      pdfMap,
      wpClientConfig: {
        baseUrl: wpMock.baseUrl,
        username: wpMock.username,
        appPassword: wpMock.appPassword,
        allowHttp: true,
        defaultStatus: 'draft',
      },
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'scheduled', pollIntervalSeconds: 1, maxConcurrentJobs: 2, heartbeatIntervalMs: 0 },
    });

    const sourceJob1 = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: sourceId,
      initialStage: 'SOURCE_DISCOVERY',
      metadata: { sourceId },
    });

    await drainSchedulerUntilIdle(scheduler);

    const noticeJobs1 = jobService.getChildJobs(sourceJob1.job_id);
    assert.equal(noticeJobs1.length, 1);
    const docJobs1 = jobService.getChildJobs(noticeJobs1[0].job_id);
    assert.equal(docJobs1.length, 2, 'Should fan out 2 independent document child jobs');
    assert.notEqual(docJobs1[0].job_id, docJobs1[1].job_id);
    assert.equal(docJobs1[0].dedupe_key, buildDocumentDedupeKey(sourceId, docUrlA));
    assert.equal(docJobs1[1].dedupe_key, buildDocumentDedupeKey(sourceId, docUrlB));
    assert.equal(docJobs1[0].status, 'COMPLETED');
    assert.equal(docJobs1[1].status, 'COMPLETED');
    assert.equal(wpMock.posts.size, 2, 'Both documents should publish independently to WordPress');

    const totalJobsAfterRun1 = jobService.listJobs(100).length;
    assert.equal(totalJobsAfterRun1, 4); // 1 source + 1 notice + 2 document jobs

    // Second discovery run for same source -> MUST create ZERO duplicate notice or document jobs and ZERO duplicate WP posts!
    const sourceJob2 = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: sourceId,
      initialStage: 'SOURCE_DISCOVERY',
      metadata: { sourceId },
    });

    await drainSchedulerUntilIdle(scheduler);

    const totalJobsAfterRun2 = jobService.listJobs(100).length;
    assert.equal(
      totalJobsAfterRun2,
      totalJobsAfterRun1 + 1,
      'Repeat discovery must NOT create duplicate child notice or document jobs'
    );
    assert.equal(jobService.getChildJobs(sourceJob2.job_id).length, 0);
    assert.equal(wpMock.posts.size, 2, 'Repeat discovery must NOT create duplicate WordPress posts');

    // Direct atomic dedupe check at repository/service layer
    const dedupedDocAttempt = jobService.createJobWithStatus({
      parentJobId: noticeJobs1[0].job_id,
      dedupeKey: buildDocumentDedupeKey(sourceId, docUrlA),
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-upsc-cse-duplicate-attempt',
      initialStage: 'DOCUMENT_DOWNLOAD',
    });
    assert.equal(dedupedDocAttempt.created, false);
    assert.equal(dedupedDocAttempt.job.job_id, docJobs1[0].job_id);
  });

  it('[PASS] enforces stage-to-stage contracts: DOWNLOAD -> VALIDATION -> TEXT_EXTRACTION (NormalizedDocument) -> STRUCTURED_EXTRACTION', async () => {
    const sourceId = 'IN-CENTRAL-RRB';
    const docUrl = 'https://rrbcdg.gov.in/uploads/cen-01-2026.pdf';
    const pdfBuf = createOfficialNoticePdf({
      org: 'Railway Recruitment Board',
      title: 'Centralized Employment Notice 01/2026',
      advtNo: '01/2026-RRB',
      vacancies: 5696,
      startDate: '15/04/2026',
      lastDate: '15/05/2026',
      ageRange: '18 to 30 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'CBT Stage-I, CBT Stage-II and Document Verification',
      applyUrl: 'https://www.rrbapply.gov.in/cen-01-2026',
    });

    const engine = buildWiredPipelineEngine({ pdfMap: new Map([[docUrl, pdfBuf]]) });
    const jobService = getJobService();
    const job = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-rrb-contract-check',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId, documentUrl: docUrl, canonicalUrl: docUrl },
    });

    // Stage 3: DOCUMENT_DOWNLOAD -> canonical DownloadedDocumentArtifact
    const step3 = await engine.executeCurrentStage(job.job_id, 'corr-contract-1', {
      sourceId,
      documentUrl: docUrl,
    });
    assert.equal(step3.result.success, true);
    const dlOut = step3.result.output as Record<string, unknown>;
    assert.ok(dlOut.downloadedDocument);
    assert.ok(Buffer.isBuffer(dlOut.buffer));
    assert.equal(typeof dlOut.checksumSha256, 'string');
    assert.equal(step3.job.stage, 'DOCUMENT_VALIDATION');

    // Stage 4: DOCUMENT_VALIDATION consumes canonical download output
    const step4 = await engine.executeCurrentStage(job.job_id, 'corr-contract-1', dlOut);
    assert.equal(step4.result.success, true);
    const valOut = step4.result.output as Record<string, unknown>;
    assert.ok(valOut.validatedDocument);
    assert.equal(valOut.isValidStructure, true);
    assert.equal(valOut.mimeValidationPassed, true);
    assert.equal(step4.job.stage, 'TEXT_EXTRACTION');

    // Stage 5: TEXT_EXTRACTION consumes validated output and produces NormalizedDocument
    const step5 = await engine.executeCurrentStage(job.job_id, 'corr-contract-1', {
      ...dlOut,
      ...valOut,
    });
    assert.equal(step5.result.success, true);
    const extOut = step5.result.output as { document?: NormalizedDocument };
    assert.ok(extOut.document, 'TEXT_EXTRACTION must produce NormalizedDocument');
    assert.equal(extOut.document.extractionStatus, 'EXTRACTED');
    assert.equal(extOut.document.pages.length, 1);
    assert.equal(step5.job.stage, 'STRUCTURED_EXTRACTION');

    // Stage 6: STRUCTURED_EXTRACTION receives NormalizedDocument and produces StructuredRecruitmentRecord
    const step6 = await engine.executeCurrentStage(job.job_id, 'corr-contract-1', extOut);
    assert.equal(step6.result.success, true);
    const structOut = step6.result.output as {
      record?: { id: string; fields: { organization: { value: string | null } } };
      recruitmentId?: string;
    };
    assert.ok(structOut.record);
    assert.equal(structOut.recruitmentId, structOut.record.id);
    assert.equal(structOut.record.fields.organization.value, 'Railway Recruitment Board');
    assert.equal(step6.job.stage, 'EVIDENCE_VALIDATION');
  });

  it('[PASS] invokes configured OCR provider for scanned PDFs and preserves direct + OCR pages for mixed PDFs', async () => {
    const ocrCalls: Array<{ pageNumber: number }> = [];
    const scannedOcrText = buildOfficialNoticeText({
      org: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026',
      advtNo: '09/2026-SCAN',
      vacancies: 3200,
      startDate: '01/08/2026',
      lastDate: '31/08/2026',
      ageRange: '18 to 30 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'Tier-I CBT and Tier-II Examination',
      applyUrl: 'https://ssc.gov.in/portal/apply-scan',
    });

    const mockOcrProvider: OCRProvider = {
      providerName: 'mock-gemini-ocr',
      modelVersion: 'gemini-ocr-test-v1',
      isAvailable: () => true,
      async extractPage(pageNumber: number): Promise<OcrPageResult> {
        ocrCalls.push({ pageNumber });
        return {
          document_id: 'doc-ocr',
          page_number: pageNumber,
          text: scannedOcrText,
          language: 'ENGLISH',
          model_confidence: 0.96,
          confidence: 0.96,
          quality_score: 0.95,
          confidence_source: 'MODEL',
          provider: 'mock-gemini-ocr',
          model_version: 'gemini-ocr-test-v1',
          processing_time_ms: 12,
          status: 'OCR_SUCCESS',
          char_count: scannedOcrText.length,
          word_count: scannedOcrText.split(/\s+/).length,
          ocr_result_id: `ocr-res-p${pageNumber}`,
          timestamp: new Date().toISOString(),
        };
      },
      async extractDocument(
        _documentBuffer: Buffer,
        options?: { documentId?: string; checksum?: string; scannedPageNumbers?: number[] }
      ): Promise<OcrDocumentResult> {
        const pageNumbers = options?.scannedPageNumbers?.length ? options.scannedPageNumbers : [1];
        const pages = await Promise.all(pageNumbers.map((p) => this.extractPage(p, _documentBuffer)));
        return {
          document_id: options?.documentId || 'doc-ocr',
          checksum_sha256: options?.checksum || 'mock-checksum',
          provider: 'mock-gemini-ocr',
          model_version: 'gemini-ocr-test-v1',
          totalPages: pages.length,
          scannedPages: pages.length,
          textPages: 0,
          isMixed: false,
          pages,
          failedPages: [],
          overallStatus: 'OCR_SUCCESS',
          cached: false,
        };
      },
    };

    // 1. Fully scanned PDF -> runs OCR -> flows through full pipeline to WordPress
    const scannedUrl = 'https://ssc.gov.in/notices/scanned-2026.pdf';
    const mixedUrl = 'https://ssc.gov.in/notices/mixed-2026.pdf';
    const pdfMap = new Map<string, Buffer>([
      [scannedUrl, createScannedSamplePdf()],
      [
        mixedUrl,
        createMixedSamplePdf(
          'Staff Selection Commission Official Notice Combined Graduate Level Examination 2026 Advt. No.: 10/2026-MIX'
        ),
      ],
    ]);

    const engine = buildWiredPipelineEngine({
      pdfMap,
      ocrProvider: mockOcrProvider,
      wpClientConfig: {
        baseUrl: wpMock.baseUrl,
        username: wpMock.username,
        appPassword: wpMock.appPassword,
        allowHttp: true,
        defaultStatus: 'draft',
      },
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 1, heartbeatIntervalMs: 0 },
    });

    const scannedJob = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-scanned-1',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId: 'IN-CENTRAL-SSC', documentUrl: scannedUrl, canonicalUrl: scannedUrl },
    });

    await drainSchedulerUntilIdle(scheduler);
    const doneScanned = jobService.getJob(scannedJob.job_id)!;
    assert.equal(doneScanned.status, 'COMPLETED');
    assert.equal(doneScanned.stage, 'WORDPRESS_PUBLISH');
    assert.ok(ocrCalls.length >= 1, 'Configured OCR provider must be invoked for scanned PDF');
    assert.equal(wpMock.posts.size, 1);

    // 2. Mixed PDF -> Page 1 direct text preserved, Page 2 OCR generated!
    ocrCalls.length = 0;
    const mixedJob = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-mixed-1',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId: 'IN-CENTRAL-SSC', documentUrl: mixedUrl, canonicalUrl: mixedUrl },
    });

    const dlRes = await engine.executeCurrentStage(mixedJob.job_id, 'corr-mixed', {
      sourceId: 'IN-CENTRAL-SSC',
      documentUrl: mixedUrl,
    });
    assert.equal(dlRes.result.success, true);
    const valRes = await engine.executeCurrentStage(mixedJob.job_id, 'corr-mixed', dlRes.result.output);
    assert.equal(valRes.result.success, true);
    const textRes = await engine.executeCurrentStage(mixedJob.job_id, 'corr-mixed', {
      ...(dlRes.result.output as Record<string, unknown>),
      ...(valRes.result.output as Record<string, unknown>),
    });
    assert.equal(textRes.result.success, true);

    const mixedDoc = (textRes.result.output as { document: NormalizedDocument }).document;
    assert.equal(mixedDoc.extractionMethod, 'MIXED');
    assert.equal(mixedDoc.pages.length, 2);
    assert.equal(mixedDoc.pages[0].extractionMethod, 'DIRECT_TEXT');
    assert.equal(mixedDoc.pages[1].extractionMethod, 'OCR');
    assert.deepEqual(
      ocrCalls.map((c) => c.pageNumber),
      [2],
      'Only scanned page 2 should be sent to OCR on a mixed PDF'
    );
  });

  it('[PASS] reports truthful OCR_UNAVAILABLE for scanned PDF when OCR provider is unconfigured', async () => {
    const scannedUrl = 'https://ssc.gov.in/notices/scanned-no-ocr.pdf';
    const engine = buildWiredPipelineEngine({
      pdfMap: new Map([[scannedUrl, createScannedSamplePdf()]]),
      ocrProvider: new UnconfiguredOCRProvider(),
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 1, heartbeatIntervalMs: 0 },
    });

    const job = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-scanned-unavail',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId: 'IN-CENTRAL-SSC', documentUrl: scannedUrl, canonicalUrl: scannedUrl },
    });

    await drainSchedulerUntilIdle(scheduler);

    const failedJob = jobService.getJob(job.job_id)!;
    assert.equal(failedJob.status, 'FAILED');
    assert.equal(failedJob.stage, 'TEXT_EXTRACTION');
    assert.equal(failedJob.error_code, 'OCR_UNAVAILABLE');
  });

  it('[PASS] recovers and resumes from persisted stage after process interruption without duplicating child jobs', async () => {
    const sourceId = 'IN-CENTRAL-SSC';
    const docUrl = 'https://ssc.gov.in/notices/resume-recovery-2026.pdf';
    const pdfBuf = createOfficialNoticePdf({
      org: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026',
      advtNo: '11/2026-REC',
      vacancies: 4200,
      startDate: '01/09/2026',
      lastDate: '30/09/2026',
      ageRange: '18 to 32 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'Tier-I CBT and Tier-II Examination',
      applyUrl: 'https://ssc.gov.in/portal/apply-rec',
    });

    const engine = buildWiredPipelineEngine({
      pdfMap: new Map([[docUrl, pdfBuf]]),
      wpClientConfig: {
        baseUrl: wpMock.baseUrl,
        username: wpMock.username,
        appPassword: wpMock.appPassword,
        allowHttp: true,
        defaultStatus: 'draft',
      },
    });
    const jobService = getJobService();

    const dedupeKey = buildDocumentDedupeKey(sourceId, docUrl);
    const job = jobService.createJob({
      dedupeKey,
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-recovery-1',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId, documentUrl: docUrl, canonicalUrl: docUrl },
    });

    // Execute Stage 3 (DOWNLOAD) -> advances to DOCUMENT_VALIDATION and persists durable filePath + metadata
    const s3 = await engine.executeCurrentStage(job.job_id, 'corr-rec-1', {
      sourceId,
      documentUrl: docUrl,
    });
    assert.equal(s3.result.success, true);
    assert.equal(s3.job.stage, 'DOCUMENT_VALIDATION');

    // Simulate process crash / lease expiry by failing job at DOCUMENT_VALIDATION and requeuing
    // (fresh scheduler will have ZERO in-memory stage outputs, only persisted DB/file state!)
    jobService.failJob(job.job_id, 'LEASE_EXPIRED_RECOVERED', 'Simulated worker crash after download');
    jobService.retryJob(job.job_id, 'RECOVERY_TEST');

    const freshScheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 1, heartbeatIntervalMs: 0 },
    });

    await drainSchedulerUntilIdle(freshScheduler);

    const resumedFinal = jobService.getJob(job.job_id)!;
    assert.equal(resumedFinal.status, 'COMPLETED');
    assert.equal(resumedFinal.stage, 'WORDPRESS_PUBLISH');
    assert.equal(wpMock.posts.size, 1);

    // Ensure no duplicate job exists for the same dedupe_key
    assert.equal(jobService.findByDedupeKey(dedupeKey)?.job_id, job.job_id);
    assert.equal(jobService.listJobs(50).length, 1);
  });

  it('[PASS] blocks WordPress publishing when PublishingGate requirements fail and never falsely completes parent or child', async () => {
    const sourceId = 'IN-CENTRAL-SSC-INCOMPLETE';
    const docUrl = 'https://ssc.gov.in/notices/incomplete-notice.pdf';
    // Missing selection_process, vacancies, dates, age -> PublishingGate MUST block!
    const incompletePdf = createValidSamplePdf(
      'Staff Selection Commission general notice about upcoming calendar schedule with no vacancies or dates'
    );

    const notice: DiscoveredNotice = {
      id: 'notice-incomplete-1',
      sourceId,
      title: 'Incomplete General Notice',
      noticeUrl: 'https://ssc.gov.in/notices/incomplete-1',
    };
    const doc: DiscoveredDocument = {
      id: 'doc-incomplete-1',
      noticeId: notice.id,
      sourceId,
      documentUrl: docUrl,
      canonicalUrl: docUrl,
      documentType: 'NOTIFICATION_PDF',
      title: 'Incomplete PDF',
      discoveredAt: new Date().toISOString(),
      sourceDomain: 'ssc.gov.in',
    };

    sourceRegistry.register(
      createFixtureAdapter({
        sourceId,
        name: 'Incomplete Notice Fixture',
        baseUrl: 'https://ssc.gov.in',
        notices: [notice],
        docsByNoticeId: new Map([[notice.id, [doc]]]),
      })
    );
    registeredFixtureSources.push(sourceId);

    const engine = buildWiredPipelineEngine({
      pdfMap: new Map([[docUrl, incompletePdf]]),
      wpClientConfig: {
        baseUrl: wpMock.baseUrl,
        username: wpMock.username,
        appPassword: wpMock.appPassword,
        allowHttp: true,
        defaultStatus: 'draft',
      },
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 2, heartbeatIntervalMs: 0 },
    });

    const sourceJob = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: sourceId,
      initialStage: 'SOURCE_DISCOVERY',
      metadata: { sourceId },
    });

    await drainSchedulerUntilIdle(scheduler);

    const noticeJob = jobService.getChildJobs(sourceJob.job_id)[0];
    const docJob = jobService.getChildJobs(noticeJob.job_id)[0];

    assert.equal(docJob.status, 'FAILED', 'Incomplete recruitment must FAIL at validation/gate, never COMPLETED');
    assert.ok(
      docJob.stage === 'PUBLISHING_GATE' || docJob.stage === 'EVIDENCE_VALIDATION',
      `Expected block at EVIDENCE_VALIDATION or PUBLISHING_GATE, got ${docJob.stage}`
    );
    assert.equal(wpMock.posts.size, 0, 'PublishingGate must block WordPress publishing');
    assert.notEqual(
      jobService.getJob(noticeJob.job_id)!.status,
      'COMPLETED',
      'Parent notice job must NOT be marked COMPLETED when child failed'
    );
    assert.notEqual(
      jobService.getJob(sourceJob.job_id)!.status,
      'COMPLETED',
      'Parent source job must NOT be marked COMPLETED when child failed'
    );
  });

  it('[PASS] fails truthfully with WP_NOT_CONFIGURED when WordPress is unconfigured instead of faking completion', async () => {
    const sourceId = 'IN-CENTRAL-SSC';
    const docUrl = 'https://ssc.gov.in/notices/no-wp-config.pdf';
    const pdfBuf = createOfficialNoticePdf({
      org: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026',
      advtNo: '12/2026-NOWP',
      vacancies: 2100,
      startDate: '01/10/2026',
      lastDate: '31/10/2026',
      ageRange: '18 to 32 years',
      qualification: "Bachelor's Degree from a recognized University",
      selectionProcess: 'Tier-I CBT and Tier-II Examination',
      applyUrl: 'https://ssc.gov.in/portal/apply-nowp',
    });

    // Explicitly NO wpClientConfig and NO OMNIHUB_WP_* env vars
    const engine = buildWiredPipelineEngine({
      pdfMap: new Map([[docUrl, pdfBuf]]),
    });
    const jobService = getJobService();
    const scheduler = new SchedulerService({
      jobService,
      pipelineEngine: engine,
      config: { automationMode: 'manual', maxConcurrentJobs: 1, heartbeatIntervalMs: 0 },
    });

    const job = jobService.createJob({
      targetEntityType: 'DOCUMENT',
      targetEntityId: 'doc-no-wp-1',
      initialStage: 'DOCUMENT_DOWNLOAD',
      metadata: { sourceId, documentUrl: docUrl, canonicalUrl: docUrl },
    });

    await drainSchedulerUntilIdle(scheduler);

    const finalJob = jobService.getJob(job.job_id)!;
    assert.equal(finalJob.stage, 'WORDPRESS_PUBLISH');
    assert.equal(finalJob.status, 'FAILED');
    assert.equal(finalJob.error_code, 'WP_NOT_CONFIGURED');
    assert.equal(wpMock.posts.size, 0);
  });
});
