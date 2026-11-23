/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';
import { getPipelineEngine } from '../../src/backend/pipeline/index.ts';
import { getJobService } from '../../src/backend/jobs/index.ts';
import { createDefaultStructuredFields } from '../../src/backend/extraction/index.ts';
import type { StructuredRecruitmentData } from '../../src/backend/extraction/types.ts';
import type { PublishingEvaluationTarget } from '../../src/backend/publishing-gate/types.ts';
import {
  WordPressClientError,
  WordPressRestClient,
  buildWordPressJobContent,
  computeDeterministicExternalIdentity,
  resolveWordPressSectionCategory,
} from '../../src/backend/wordpress/index.ts';
import { sanitizeLogData } from '../../src/backend/config/logger.ts';

const SEEDED_DOC_ID = 'doc-wp-ssc-cgl-2026';

const SAMPLE_PAGE_1 = `
STAFF SELECTION COMMISSION
Notice No. 04/2026-CGL
COMBINED GRADUATE LEVEL EXAMINATION 2026
Online applications start: 01/06/2026
Last date for online application: 01/07/2026
Tentative Vacancies: 14582
Revised Vacancies: 16000
Essential Qualification: Bachelor's Degree from a recognized University or equivalent
Minimum Age: 18 years
Maximum Age: 32 years
Scheme of Examination: Tier-I and Tier-II
Official website: https://ssc.gov.in
Apply Online: https://ssc.gov.in/portal/apply-cgl-2026
`;

function createPublishReadyFields(docId: string = SEEDED_DOC_ID): StructuredRecruitmentData {
  const f = createDefaultStructuredFields('IN-CENTRAL-SSC', docId);

  f.organization.value = 'Staff Selection Commission';
  f.organization.state = 'VERIFIED';
  f.organization.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'organization',
    evidence_text: 'STAFF SELECTION COMMISSION',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.recruitment_title.value = 'Combined Graduate Level Examination 2026';
  f.recruitment_title.state = 'VERIFIED';
  f.recruitment_title.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'recruitment_title',
    evidence_text: 'COMBINED GRADUATE LEVEL EXAMINATION 2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.advertisement_number.value = '04/2026-CGL';
  f.advertisement_number.state = 'VERIFIED';
  f.advertisement_number.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'advertisement_number',
    evidence_text: 'Notice No. 04/2026-CGL',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.total_vacancies.value = 14582;
  f.total_vacancies.state = 'VERIFIED';
  f.total_vacancies.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'total_vacancies',
    evidence_text: 'Tentative Vacancies: 14582',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.application_start_date.value = '2026-06-01';
  f.application_start_date.state = 'VERIFIED';
  f.application_start_date.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'application_start_date',
    evidence_text: 'Online applications start: 01/06/2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.application_last_date.value = '2026-07-01';
  f.application_last_date.state = 'VERIFIED';
  f.application_last_date.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'application_last_date',
    evidence_text: 'Last date for online application: 01/07/2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.educational_qualification.value = "Bachelor's Degree from a recognized University or equivalent";
  f.educational_qualification.state = 'VERIFIED';
  f.educational_qualification.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'educational_qualification',
    evidence_text: "Essential Qualification: Bachelor's Degree from a recognized University",
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.age_min.value = 18;
  f.age_min.state = 'VERIFIED';
  f.age_min.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'age_min',
    evidence_text: 'Minimum Age: 18 years',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.age_max.value = 32;
  f.age_max.state = 'VERIFIED';
  f.age_max.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'age_max',
    evidence_text: 'Maximum Age: 32 years',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.selection_process.value = ['Tier-I Computer Based Examination', 'Tier-II Examination'];
  f.selection_process.state = 'VERIFIED';
  f.selection_process.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'selection_process',
    evidence_text: 'Scheme of Examination: Tier-I and Tier-II',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.official_notification_url.value = 'https://ssc.gov.in/notices/cgl-2026-official.pdf';
  f.official_notification_url.state = 'VERIFIED';
  f.official_notification_url.evidence = {
    document_id: docId,
    page_number: 0,
    field_name: 'official_notification_url',
    evidence_text: 'https://ssc.gov.in/notices/cgl-2026-official.pdf',
    extraction_method: 'DOCUMENT_METADATA',
    provenance_type: 'DOCUMENT_METADATA',
    verified_in_document: false,
    metadata_verified: true,
  };

  f.official_application_url.value = 'https://ssc.gov.in/portal/apply-cgl-2026';
  f.official_application_url.state = 'VERIFIED';
  f.official_application_url.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'official_application_url',
    evidence_text: 'Apply Online: https://ssc.gov.in/portal/apply-cgl-2026',
    extraction_method: 'DIRECT_TEXT',
    provenance_type: 'PAGE_EVIDENCE',
    verified_in_document: true,
  };

  return f;
}

function buildValidTarget(recruitmentId: string, fieldsOverride?: StructuredRecruitmentData): PublishingEvaluationTarget {
  const fields = fieldsOverride ?? createPublishReadyFields(SEEDED_DOC_ID);
  return {
    recruitmentId,
    sourceId: 'IN-CENTRAL-SSC',
    documentId: SEEDED_DOC_ID,
    title: 'Combined Graduate Level Examination 2026',
    fields,
    pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
  };
}

interface MockWpPostRecord {
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

interface MockWpServerState {
  expectedAuthHeader: string;
  categories: Array<{ id: number; name: string; slug: string }>;
  posts: Map<number, MockWpPostRecord>;
  media: Array<{ id: number; source_url: string }>;
  nextPostId: number;
  nextCategoryId: number;
  nextMediaId: number;
  requestCounts: {
    total: number;
    categoriesGet: number;
    categoriesPost: number;
    postsGet: number;
    postsCreate: number;
    postsUpdate: number;
    mediaPost: number;
    usersMeGet: number;
  };
  behavior: {
    delayMs: number;
    failCategoryMapping: boolean;
    transientCategoryFailuresRemaining: number;
    transientPostLookupFailuresRemaining: number;
    overridePostResponse: ((post: MockWpPostRecord) => Record<string, unknown>) | null;
  };
}

describe('WordPress Publishing Layer End-to-End & Mocked REST Server Tests', () => {
  let mockWpServer: http.Server;
  let mockWpBaseUrl = '';
  const validUsername = 'omnihub_publisher';
  const validAppPassword = 'abcd efgh ijkl mnop qrst uvwx';
  let serverState: MockWpServerState;

  function resetServerState(): void {
    const token = Buffer.from(`${validUsername}:${validAppPassword}`, 'utf-8').toString('base64');
    serverState = {
      expectedAuthHeader: `Basic ${token}`,
      categories: [{ id: 10, name: 'Government Jobs', slug: 'government-jobs' }],
      posts: new Map(),
      media: [],
      nextPostId: 501,
      nextCategoryId: 11,
      nextMediaId: 901,
      requestCounts: {
        total: 0,
        categoriesGet: 0,
        categoriesPost: 0,
        postsGet: 0,
        postsCreate: 0,
        postsUpdate: 0,
        mediaPost: 0,
        usersMeGet: 0,
      },
      behavior: {
        delayMs: 0,
        failCategoryMapping: false,
        transientCategoryFailuresRemaining: 0,
        transientPostLookupFailuresRemaining: 0,
        overridePostResponse: null,
      },
    };
  }

  before(async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();

    // Seed official source, source_document, document, and page provenance for PublishingGate
    repos.sources.create({
      id: 'IN-CENTRAL-SSC',
      name: 'Staff Selection Commission',
      type: 'PORTAL',
      base_url: 'https://ssc.gov.in',
      is_active: 1,
      check_interval_minutes: 60,
      config_json: '{}',
    });

    const sdoc = repos.sourceDocuments.create({
      id: 'sdoc-wp-ssc-cgl-2026',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notices/cgl-2026-official.pdf',
      title: 'Combined Graduate Level Examination 2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADED',
      metadata_json: null,
    });

    repos.documents.create({
      id: SEEDED_DOC_ID,
      source_document_id: sdoc.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026-official.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026-official.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/ssc-cgl-2026-wp.pdf',
      file_size: 245000,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: 'cglwphash1111111111111111111111111111111111111111111111111111111111',
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    repos.documents.savePages([
      {
        id: 'page-wp-cgl-01',
        document_id: SEEDED_DOC_ID,
        page_number: 1,
        char_count: SAMPLE_PAGE_1.length,
        extracted_text: SAMPLE_PAGE_1,
        extraction_method: 'DIRECT_TEXT',
        is_scanned: 0,
        quality_score: 1.0,
      },
    ]);

    resetServerState();

    mockWpServer = http.createServer((req, res) => {
      req.on('error', () => {
        // Ignore client-aborted socket errors during timeout tests
      });
      res.on('error', () => {
        // Ignore response write errors on aborted sockets
      });

      void (async () => {
        try {
          serverState.requestCounts.total++;

          if (serverState.behavior.delayMs > 0) {
            await new Promise((r) => setTimeout(r, serverState.behavior.delayMs));
            if (req.destroyed || res.writableEnded) return;
          }

          const authHeader = req.headers.authorization || '';
          if (authHeader !== serverState.expectedAuthHeader) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                code: 'rest_cannot_access',
                message: 'Invalid username or application password.',
                data: { status: 401 },
              })
            );
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const rawBody = Buffer.concat(chunks);

          const parsedUrl = new URL(req.url || '/', mockWpBaseUrl);
          const pathname = parsedUrl.pathname;

          // 1. Readiness endpoint: GET /wp-json/wp/v2/users/me
          if (req.method === 'GET' && pathname === '/wp-json/wp/v2/users/me') {
            serverState.requestCounts.usersMeGet++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 1,
                name: 'OmniHub Publisher',
                slug: 'omnihub-publisher',
                roles: ['editor'],
              })
            );
            return;
          }

          // 2. Categories: GET /wp-json/wp/v2/categories
          if (req.method === 'GET' && pathname === '/wp-json/wp/v2/categories') {
            serverState.requestCounts.categoriesGet++;

            if (serverState.behavior.transientCategoryFailuresRemaining > 0) {
              serverState.behavior.transientCategoryFailuresRemaining--;
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  code: 'wp_service_unavailable',
                  message: 'Temporary maintenance',
                })
              );
              return;
            }

            if (serverState.behavior.failCategoryMapping) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  code: 'wp_term_error',
                  message: 'Database term table locked',
                })
              );
              return;
            }

            const search = (parsedUrl.searchParams.get('search') || '').trim().toLowerCase();
            const matches = serverState.categories.filter(
              (c) =>
                !search ||
                c.name.toLowerCase().includes(search) ||
                c.slug.toLowerCase().includes(search)
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(matches));
            return;
          }

          // 3. Categories: POST /wp-json/wp/v2/categories
          if (req.method === 'POST' && pathname === '/wp-json/wp/v2/categories') {
            serverState.requestCounts.categoriesPost++;

            if (serverState.behavior.failCategoryMapping) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  code: 'wp_term_create_failed',
                  message: 'Cannot create category',
                })
              );
              return;
            }

            const payload = JSON.parse(rawBody.toString('utf-8')) as {
              name: string;
              slug: string;
            };
            const created = {
              id: serverState.nextCategoryId++,
              name: payload.name,
              slug: payload.slug,
            };
            serverState.categories.push(created);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(created));
            return;
          }

          // 4. Media Upload: POST /wp-json/wp/v2/media
          if (req.method === 'POST' && pathname === '/wp-json/wp/v2/media') {
            serverState.requestCounts.mediaPost++;
            const mediaId = serverState.nextMediaId++;
            const mediaItem = {
              id: mediaId,
              source_url: `${mockWpBaseUrl}/wp-content/uploads/2026/06/media-${mediaId}.png`,
            };
            serverState.media.push(mediaItem);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mediaItem));
            return;
          }

          // 5. Posts Lookup: GET /wp-json/wp/v2/posts
          if (req.method === 'GET' && pathname === '/wp-json/wp/v2/posts') {
            serverState.requestCounts.postsGet++;

            if (serverState.behavior.transientPostLookupFailuresRemaining > 0) {
              serverState.behavior.transientPostLookupFailuresRemaining--;
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ code: 'wp_overloaded', message: 'Temporary overload' })
              );
              return;
            }

            const slugQuery = (parsedUrl.searchParams.get('slug') || '').trim();
            const allPosts = Array.from(serverState.posts.values());
            const filtered = slugQuery
              ? allPosts.filter(
                  (p) =>
                    p.slug === slugQuery ||
                    p.meta?.omnihub_external_identity === slugQuery
                )
              : allPosts;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(filtered));
            return;
          }

          // 6. Post Creation: POST /wp-json/wp/v2/posts
          if (req.method === 'POST' && pathname === '/wp-json/wp/v2/posts') {
            serverState.requestCounts.postsCreate++;
            const body = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
            const postId = serverState.nextPostId++;
            const slug = String(body.slug || `post-${postId}`);
            const status = String(body.status || 'draft');

            const postRecord: MockWpPostRecord = {
              id: postId,
              title: {
                raw: String(body.title || ''),
                rendered: String(body.title || ''),
              },
              content: {
                raw: String(body.content || ''),
                rendered: String(body.content || ''),
              },
              excerpt: {
                raw: String(body.excerpt || ''),
                rendered: String(body.excerpt || ''),
              },
              status,
              slug,
              link: `${mockWpBaseUrl}/jobs/${slug}/`,
              categories: Array.isArray(body.categories) ? (body.categories as number[]) : [],
              featured_media:
                typeof body.featured_media === 'number' ? body.featured_media : 0,
              meta:
                body.meta && typeof body.meta === 'object'
                  ? (body.meta as Record<string, unknown>)
                  : {},
              modified_gmt: new Date().toISOString(),
            };

            serverState.posts.set(postId, postRecord);

            const responsePayload = serverState.behavior.overridePostResponse
              ? serverState.behavior.overridePostResponse(postRecord)
              : postRecord;

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
            return;
          }

          // 7. Post Get by ID (post-write verification): GET /wp-json/wp/v2/posts/:id
          const postByIdMatch = pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
          if (req.method === 'GET' && postByIdMatch) {
            serverState.requestCounts.postsGet++;
            const postId = Number(postByIdMatch[1]);
            const existing = serverState.posts.get(postId);
            if (!existing) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  code: 'rest_post_invalid_id',
                  message: 'Invalid post ID.',
                })
              );
              return;
            }
            const responsePayload = serverState.behavior.overridePostResponse
              ? serverState.behavior.overridePostResponse(existing)
              : existing;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
            return;
          }

          // 8. Post Update: POST /wp-json/wp/v2/posts/:id
          const updateMatch = pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
          if (req.method === 'POST' && updateMatch) {
            serverState.requestCounts.postsUpdate++;
            const postId = Number(updateMatch[1]);
            const existing = serverState.posts.get(postId);
            if (!existing) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  code: 'rest_post_invalid_id',
                  message: 'Invalid post ID.',
                })
              );
              return;
            }

            const body = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
            const updatedSlug = String(body.slug || existing.slug);
            const updatedRecord: MockWpPostRecord = {
              ...existing,
              title: {
                raw: String(body.title ?? existing.title.raw),
                rendered: String(body.title ?? existing.title.rendered),
              },
              content: {
                raw: String(body.content ?? existing.content.raw),
                rendered: String(body.content ?? existing.content.rendered),
              },
              excerpt: {
                raw: String(body.excerpt ?? existing.excerpt.raw),
                rendered: String(body.excerpt ?? existing.excerpt.rendered),
              },
              status: String(body.status ?? existing.status),
              slug: updatedSlug,
              link: `${mockWpBaseUrl}/jobs/${updatedSlug}/`,
              categories: Array.isArray(body.categories)
                ? (body.categories as number[])
                : existing.categories,
              featured_media:
                typeof body.featured_media === 'number'
                  ? body.featured_media
                  : existing.featured_media,
              meta:
                body.meta && typeof body.meta === 'object'
                  ? { ...existing.meta, ...(body.meta as Record<string, unknown>) }
                  : existing.meta,
              modified_gmt: new Date().toISOString(),
            };

            serverState.posts.set(postId, updatedRecord);

            const responsePayload = serverState.behavior.overridePostResponse
              ? serverState.behavior.overridePostResponse(updatedRecord)
              : updatedRecord;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'rest_no_route', message: 'No route was found' }));
        } catch {
          // Safely ignore aborted socket reads during timeout tests
        }
      })();
    });

    await new Promise<void>((resolve) => {
      mockWpServer.listen(0, '127.0.0.1', () => {
        const addr = mockWpServer.address() as AddressInfo;
        mockWpBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    resetServerState();
  });

  after(async () => {
    await new Promise<void>((resolve) => mockWpServer.close(() => resolve()));
    closeDatabase();
  });

  // 1. SUCCESSFUL PUBLISH END-TO-END
  it('[PASS] should execute PUBLISHING_GATE -> WORDPRESS_PUBLISH, verify post ID/status/permalink/identity, and persist publishing record', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const repos = getRepositories();

    const recId = 'rec-wp-e2e-01';
    const target = buildValidTarget(recId);

    const procJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'PUBLISHING_GATE',
    });

    // Stage 1: PUBLISHING_GATE
    const gateStep = await engine.executeCurrentStage(procJob.job_id, 'corr-wp-e2e-01', {
      target,
    });
    assert.equal(gateStep.result.success, true);
    assert.equal(gateStep.job.stage, 'WORDPRESS_PUBLISH');
    assert.equal(gateStep.job.status, 'RUNNING');

    // Stage 2: WORDPRESS_PUBLISH
    const publishStep = await engine.executeCurrentStage(procJob.job_id, 'corr-wp-e2e-01', {
      target,
      status: 'publish',
      featuredMedia: {
        filename: 'ssc-cgl-2026-banner.png',
        mimeType: 'image/png',
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
        altText: 'SSC CGL 2026 Official Notification',
      },
      clientConfig: {
        baseUrl: mockWpBaseUrl,
        username: validUsername,
        appPassword: validAppPassword,
        allowInsecureLocalHttp: true,
      },
    });

    assert.equal(publishStep.result.success, true);
    assert.equal(publishStep.job.status, 'COMPLETED');

    const output = publishStep.result.output as Record<string, unknown>;
    assert.equal(output.wpPostId, 501);
    assert.equal(output.wpStatus, 'publish');
    assert.equal(output.featuredMediaId, 901);
    assert.equal(output.operation, 'CREATED');
    assert.ok(String(output.permalink).startsWith(`${mockWpBaseUrl}/jobs/omnihub-`));

    // Verify persisted publishing_records row in SQLite
    const records = repos.publishing.findByRecruitment(recId);
    assert.equal(records.length, 1);
    assert.equal(records[0].publish_status, 'PUBLISHED');
    assert.equal(records[0].external_post_id, '501');
    assert.equal(records[0].post_status, 'publish');
    assert.equal(records[0].validation_check_passed, 1);
    assert.equal(records[0].permalink, output.permalink);
    assert.equal(records[0].external_identity_key, output.externalIdentityKey);
    assert.equal(records[0].canonical_source_url, 'https://ssc.gov.in/portal/apply-cgl-2026');
    assert.equal(records[0].official_pdf_url, 'https://ssc.gov.in/notices/cgl-2026-official.pdf');
  });

  // 2. AUTHENTICATION FAILURE & CREDENTIAL REDACTION
  it('[PASS] should classify 401/403 as WP_AUTH_FAILED without retrying or leaking credentials', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const repos = getRepositories();

    const recId = 'rec-wp-auth-fail';
    const target = buildValidTarget(recId);

    const procJob = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });

    const wrongPassword = 'super-secret-wrong-app-password-9999';
    const step = await engine.executeCurrentStage(procJob.job_id, 'corr-wp-auth-01', {
      target,
      clientConfig: {
        baseUrl: mockWpBaseUrl,
        username: validUsername,
        appPassword: wrongPassword,
        maxRetries: 2,
        allowInsecureLocalHttp: true,
      },
    });

    assert.equal(step.result.success, false);
    assert.equal(step.result.errorCode, 'WP_AUTH_FAILED');
    assert.equal(step.job.status, 'FAILED');
    // Must NOT retry on authentication failure
    assert.equal(serverState.requestCounts.total, 1);
    // Error message must NEVER contain the application password
    assert.equal(step.result.errorMessage?.includes(wrongPassword), false);

    // Verify logger redaction for OMNIHUB_WP_APP_PASSWORD
    const sanitized = sanitizeLogData({
      OMNIHUB_WP_APP_PASSWORD: wrongPassword,
      appPassword: wrongPassword,
    }) as Record<string, unknown>;
    assert.equal(sanitized.OMNIHUB_WP_APP_PASSWORD, '[REDACTED]');
    assert.equal(sanitized.appPassword, '[REDACTED]');

    // Persisted record must reflect FAILED status
    const records = repos.publishing.findByRecruitment(recId);
    assert.equal(records.length, 1);
    assert.equal(records[0].publish_status, 'FAILED');
    assert.ok(records[0].error_message?.includes('WP_AUTH_FAILED'));
  });

  // 3. TIMEOUT CLASSIFICATION
  it('[PASS] should enforce request timeout and classify stalled WordPress requests as WP_TIMEOUT', async () => {
    serverState.behavior.delayMs = 150;

    const client = new WordPressRestClient({
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      timeoutMs: 40,
      maxRetries: 0,
      allowInsecureLocalHttp: true,
    });

    await assert.rejects(
      async () => {
        await client.ensureCategories(['Government Jobs']);
      },
      (err: unknown) => {
        assert.ok(err instanceof WordPressClientError);
        assert.equal(err.code, 'WP_TIMEOUT');
        return true;
      }
    );

    // Wait for server delay timer to finish cleanly before next test
    await new Promise((r) => setTimeout(r, 170));
  });

  // 4. DUPLICATE DETECTION & IDEMPOTENCY ON RETRY
  it('[PASS] should guarantee idempotency so retrying the same recruitment never creates duplicate WordPress posts', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const repos = getRepositories();

    const recId = 'rec-wp-idempotent-01';
    const target = buildValidTarget(recId);

    const clientConfig = {
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      allowInsecureLocalHttp: true,
    };

    // First publish run
    const job1 = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const run1 = await engine.executeCurrentStage(job1.job_id, 'corr-idem-1', {
      target,
      status: 'draft',
      clientConfig,
    });
    assert.equal(run1.result.success, true);
    assert.equal((run1.result.output as Record<string, unknown>).operation, 'CREATED');
    assert.equal(serverState.requestCounts.postsCreate, 1);
    assert.equal(serverState.posts.size, 1);

    // Second publish run with identical recruitment/job data
    const job2 = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const run2 = await engine.executeCurrentStage(job2.job_id, 'corr-idem-2', {
      target,
      status: 'draft',
      clientConfig,
    });
    assert.equal(run2.result.success, true);
    assert.equal((run2.result.output as Record<string, unknown>).operation, 'NOOP_IDEMPOTENT');
    assert.equal((run2.result.output as Record<string, unknown>).wpPostId, 501);
    // Must NOT have created a second post in WordPress
    assert.equal(serverState.requestCounts.postsCreate, 1);
    assert.equal(serverState.posts.size, 1);

    // Local DB must still have a single publishing record for this external identity
    const records = repos.publishing.findByRecruitment(recId);
    assert.equal(records.length, 1);
    assert.equal(records[0].external_post_id, '501');
  });

  // 5. RETRY ON TRANSIENT FAILURE FOR SAFE/IDEMPOTENT OPERATIONS
  it('[PASS] should retry safe idempotent operations when WordPress returns transient 503 errors', async () => {
    serverState.behavior.transientCategoryFailuresRemaining = 1;
    serverState.behavior.transientPostLookupFailuresRemaining = 1;

    const client = new WordPressRestClient({
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      maxRetries: 2,
      retryBackoffMs: 20,
      allowInsecureLocalHttp: true,
    });

    const categories = await client.ensureCategories(['Government Jobs']);
    assert.equal(categories.length, 1);
    assert.equal(categories[0].id, 10);
    assert.equal(serverState.requestCounts.categoriesGet, 2);

    const existing = await client.findPostByExternalIdentity('omnihub-in-central-ssc-rec-1');
    assert.equal(existing, null);
    assert.equal(serverState.requestCounts.postsGet, 2);
  });

  // 6. INVALID WP RESPONSE REJECTION (HTTP 200 ALONE IS NEVER ACCEPTED)
  it('[PASS] should reject HTTP 200/201 responses with missing post ID, missing permalink, mismatched status, or mismatched identity', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();

    const recId = 'rec-wp-invalid-resp';

    const clientConfig = {
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      maxRetries: 0,
      allowInsecureLocalHttp: true,
    };

    // Case A: HTTP 201 with missing permalink
    serverState.behavior.overridePostResponse = (post) => ({
      ...post,
      link: '',
    });

    const jobA = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: `${recId}-a`,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const resA = await engine.executeCurrentStage(jobA.job_id, 'corr-inv-a', {
      target: buildValidTarget(`${recId}-a`),
      clientConfig,
    });
    assert.equal(resA.result.success, false);
    assert.equal(resA.result.errorCode, 'WP_PERMALINK_MISSING');

    // Case B: HTTP 201 with mismatched external identity
    serverState.behavior.overridePostResponse = (post) => ({
      ...post,
      slug: 'wrong-unrelated-slug',
      content: { raw: '<p>Unrelated post</p>', rendered: '<p>Unrelated post</p>' },
      meta: { omnihub_external_identity: 'omnihub-tampered-identity-key' },
    });

    const jobB = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: `${recId}-b`,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const resB = await engine.executeCurrentStage(jobB.job_id, 'corr-inv-b', {
      target: buildValidTarget(`${recId}-b`),
      clientConfig,
    });
    assert.equal(resB.result.success, false);
    assert.equal(resB.result.errorCode, 'WP_IDENTITY_MISMATCH');

    // Case C: HTTP 201 with missing numeric post ID
    serverState.behavior.overridePostResponse = (post) => ({
      ...post,
      id: null,
    });

    const jobC = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: `${recId}-c`,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const resC = await engine.executeCurrentStage(jobC.job_id, 'corr-inv-c', {
      target: buildValidTarget(`${recId}-c`),
      clientConfig,
    });
    assert.equal(resC.result.success, false);
    assert.equal(resC.result.errorCode, 'WP_INVALID_RESPONSE');
  });

  // 7. UPDATE EXISTING POST WHEN PAYLOAD OR STATUS CHANGES
  it('[PASS] should update the existing WordPress post when recruitment content or status changes for the same external identity', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const repos = getRepositories();

    const recId = 'rec-wp-update-01';
    const fields1 = createPublishReadyFields(SEEDED_DOC_ID);

    const clientConfig = {
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      allowInsecureLocalHttp: true,
    };

    // Initial publish as 'draft' with 14582 vacancies
    const job1 = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const step1 = await engine.executeCurrentStage(job1.job_id, 'corr-upd-1', {
      target: buildValidTarget(recId, fields1),
      status: 'draft',
      clientConfig,
    });
    assert.equal(step1.result.success, true);
    assert.equal((step1.result.output as Record<string, unknown>).operation, 'CREATED');
    assert.equal((step1.result.output as Record<string, unknown>).wpPostId, 501);
    assert.equal((step1.result.output as Record<string, unknown>).wpStatus, 'draft');

    // Revised notification increases vacancies to 16000 (verified in SAMPLE_PAGE_1) and publishes live ('publish')
    const fields2 = createPublishReadyFields(SEEDED_DOC_ID);
    fields2.total_vacancies.value = 16000;
    fields2.total_vacancies.evidence = {
      document_id: SEEDED_DOC_ID,
      page_number: 1,
      field_name: 'total_vacancies',
      evidence_text: 'Revised Vacancies: 16000',
      extraction_method: 'DIRECT_TEXT',
      verified_in_document: true,
    };

    const job2 = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });
    const step2 = await engine.executeCurrentStage(job2.job_id, 'corr-upd-2', {
      target: buildValidTarget(recId, fields2),
      status: 'publish',
      clientConfig,
    });

    assert.equal(step2.result.success, true);
    const out2 = step2.result.output as Record<string, unknown>;
    assert.equal(out2.operation, 'UPDATED');
    assert.equal(out2.wpPostId, 501);
    assert.equal(out2.wpStatus, 'publish');
    assert.equal(serverState.requestCounts.postsCreate, 1);
    assert.equal(serverState.requestCounts.postsUpdate, 1);

    const wpPost = serverState.posts.get(501)!;
    assert.ok(wpPost.content.rendered.includes('16000'));
    assert.equal(wpPost.status, 'publish');

    const records = repos.publishing.findByRecruitment(recId);
    assert.equal(records.length, 1);
    assert.equal(records[0].post_status, 'publish');
  });

  // 8. CATEGORY MAPPING FAILURE
  it('[PASS] should fail with WP_CATEGORY_MAPPING_FAILED when category lookup or creation fails', async () => {
    serverState.behavior.failCategoryMapping = true;

    const engine = getPipelineEngine();
    const jobService = getJobService();

    const recId = 'rec-wp-cat-fail';
    const job = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });

    const step = await engine.executeCurrentStage(job.job_id, 'corr-cat-fail', {
      target: buildValidTarget(recId),
      clientConfig: {
        baseUrl: mockWpBaseUrl,
        username: validUsername,
        appPassword: validAppPassword,
        maxRetries: 0,
        allowInsecureLocalHttp: true,
      },
    });

    assert.equal(step.result.success, false);
    assert.equal(step.result.errorCode, 'WP_CATEGORY_MAPPING_FAILED');
    assert.equal(serverState.requestCounts.postsCreate, 0);
  });

  // 9. PUBLISH GATE REJECTION BEFORE WORDPRESS CALL
  it('[PASS] should block WORDPRESS_PUBLISH immediately if PublishingGate rejects unverified recruitment', async () => {
    const engine = getPipelineEngine();
    const jobService = getJobService();
    const repos = getRepositories();

    const recId = 'rec-wp-gate-reject';
    const flawedFields = createPublishReadyFields(SEEDED_DOC_ID);
    flawedFields.application_last_date.value = null;
    flawedFields.application_last_date.state = 'MISSING';
    flawedFields.application_last_date.evidence = null;

    const job = jobService.createJob({
      targetEntityType: 'RECRUITMENT',
      targetEntityId: recId,
      initialStage: 'WORDPRESS_PUBLISH',
    });

    const step = await engine.executeCurrentStage(job.job_id, 'corr-gate-reject', {
      target: buildValidTarget(recId, flawedFields),
      clientConfig: {
        baseUrl: mockWpBaseUrl,
        username: validUsername,
        appPassword: validAppPassword,
        allowInsecureLocalHttp: true,
      },
    });

    assert.equal(step.result.success, false);
    assert.equal(step.result.errorCode, 'PUBLISHING_GATE_BLOCKED');
    // Zero HTTP requests must be sent to WordPress when PublishingGate blocks
    assert.equal(serverState.requestCounts.total, 0);

    const records = repos.publishing.findByRecruitment(recId);
    assert.equal(records.length, 1);
    assert.equal(records[0].publish_status, 'GATE_REJECTED');
    assert.equal(records[0].validation_check_passed, 0);
  });

  // 10. HTTPS PRODUCTION ENFORCEMENT & READINESS STATES
  it('[PASS] should enforce HTTPS in production and report NOT_CONFIGURED / UNAVAILABLE / READY states accurately', async () => {
    // A. NOT_CONFIGURED when env vars are empty
    const unconfiguredClient = new WordPressRestClient({
      baseUrl: '',
      username: '',
      appPassword: '',
    });
    const readinessUnconfigured = await unconfiguredClient.checkReadiness();
    assert.equal(readinessUnconfigured.status, 'NOT_CONFIGURED');
    assert.equal(readinessUnconfigured.verificationTier, 'TEST_VERIFIED');

    // B. HTTPS required in production mode
    const prodHttpClient = new WordPressRestClient({
      baseUrl: 'http://wp.example.com',
      username: validUsername,
      appPassword: validAppPassword,
      nodeEnv: 'production',
    });
    assert.throws(
      () => prodHttpClient.validateConfiguration(),
      (err: unknown) =>
        err instanceof WordPressClientError && err.code === 'WP_INSECURE_URL'
    );

    // C. UNAVAILABLE when credentials fail
    const badAuthClient = new WordPressRestClient({
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: 'wrong-password',
      allowInsecureLocalHttp: true,
    });
    const readinessUnavailable = await badAuthClient.checkReadiness();
    assert.equal(readinessUnavailable.status, 'UNAVAILABLE');
    assert.equal(readinessUnavailable.errorCode, 'WP_AUTH_FAILED');

    // D. READY when connected to live runtime WordPress server
    const readyClient = new WordPressRestClient({
      baseUrl: mockWpBaseUrl,
      username: validUsername,
      appPassword: validAppPassword,
      allowInsecureLocalHttp: true,
    });
    const readinessReady = await readyClient.checkReadiness();
    assert.equal(readinessReady.status, 'READY');
    assert.equal(readinessReady.verificationTier, 'REAL_WORDPRESS_RUNTIME_VERIFIED');
    assert.equal(readinessReady.authenticated, true);

    // E. Deterministic external identity consistency check
    const id1 = computeDeterministicExternalIdentity({
      sourceId: 'IN-CENTRAL-SSC',
      recruitmentId: 'rec-100',
      canonicalSourceUrl: 'https://ssc.gov.in/portal/',
      officialNotificationUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
    });
    const id2 = computeDeterministicExternalIdentity({
      sourceId: 'IN-CENTRAL-SSC',
      recruitmentId: 'rec-100',
      canonicalSourceUrl: 'https://ssc.gov.in/portal',
      officialNotificationUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
    });
    assert.equal(id1.externalIdentityKey, id2.externalIdentityKey);

    // F. Section category mapping: Latest Jobs, Admit Card, Results
    assert.equal(resolveWordPressSectionCategory('NOTIFICATION'), 'Latest Jobs');
    assert.equal(resolveWordPressSectionCategory('ADMIT_CARD'), 'Admit Card');
    assert.equal(resolveWordPressSectionCategory('RESULT'), 'Results');

    const admitPost = buildWordPressJobContent({
      sourceId: 'IN-CENTRAL-SSC',
      recruitmentId: 'rec-admit-1',
      fields: createPublishReadyFields(SEEDED_DOC_ID),
      noticeCategory: 'ADMIT_CARD',
    });
    assert.ok(admitPost.categoryNames.includes('Admit Card'));
    assert.ok(admitPost.categoryNames.includes('Government Jobs'));

    // G. Env-gated real WordPress check (runs only when all OMNIHUB_WP_* creds are configured)
    const wpUrl = (process.env.OMNIHUB_WP_URL || '').trim();
    const wpUser = (process.env.OMNIHUB_WP_USERNAME || '').trim();
    const wpPass = (process.env.OMNIHUB_WP_APP_PASSWORD || '').trim();
    const liveWpClient = new WordPressRestClient({
      baseUrl: wpUrl,
      username: wpUser,
      appPassword: wpPass,
    });
    const liveReadiness = await liveWpClient.checkReadiness();
    if (wpUrl && wpUser && wpPass) {
      assert.equal(liveReadiness.configured, true);
    } else {
      assert.equal(liveReadiness.status, 'NOT_CONFIGURED');
    }
  });
});
