/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { IPipelineStageHandler, PipelineContext, StageExecutionResult } from './contracts.ts';
import type { PipelineStageName } from '../database/types.ts';
import { getRepositories } from '../database/index.ts';
import { PublishingGate } from '../publishing-gate/publishing-gate.ts';
import type { PublishingEvaluationTarget } from '../publishing-gate/types.ts';
import type { StructuredRecruitmentData } from '../extraction/types.ts';
import { createDefaultStructuredFields } from '../extraction/index.ts';
import {
  WordPressClientError,
  WordPressRestClient,
  buildWordPressJobContent,
  computeDeterministicExternalIdentity,
  type VerifiedWordPressPost,
  type WordPressClientConfig,
  type WordPressMediaUploadInput,
  type WordPressPublishStatus,
} from '../wordpress/index.ts';

export interface WordPressPublishStageInput {
  recruitmentId?: string;
  jobId?: string;
  target?: PublishingEvaluationTarget;
  status?: WordPressPublishStatus;
  categories?: string[];
  noticeCategory?: string;
  canonicalSourceUrl?: string;
  officialNotificationUrl?: string;
  featuredMediaId?: number;
  featuredMedia?: WordPressMediaUploadInput;
  forceUpdate?: boolean;
  clientConfig?: WordPressClientConfig;
}

/**
 * Per-external-identity async mutex queue ensuring concurrent workers in the same process
 * cannot race between findPostByExternalIdentity() and createPost() for the same recruitment.
 * Different identities execute concurrently without blocking one another.
 */
const activePublishLocks = new Map<string, Promise<void>>();

async function withExternalIdentityLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = activePublishLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  activePublishLocks.set(lockKey, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (activePublishLocks.get(lockKey) === chained) {
      activePublishLocks.delete(lockKey);
    }
  }
}

export class WordPressPublishStageHandler
  implements IPipelineStageHandler<WordPressPublishStageInput>
{
  public readonly stageName: PipelineStageName = 'WORDPRESS_PUBLISH';
  private defaultClientConfig?: WordPressClientConfig;

  constructor(defaultClientConfig?: WordPressClientConfig) {
    this.defaultClientConfig = defaultClientConfig;
  }

  public async execute(
    input: WordPressPublishStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult> {
    const repos = getRepositories();

    // 1. Resolve evaluation target (either explicit input.target or loaded from DB)
    const resolved = this.resolveEvaluationTarget(input, context);
    if (!resolved.ok) {
      return {
        success: false,
        errorCode: resolved.errorCode,
        errorMessage: resolved.errorMessage,
      };
    }

    const {
      evalTarget,
      sourceId,
      resolvedFields,
      entityJobId,
      canonicalSourceUrl,
      officialNotificationUrl,
    } = resolved;

    context.logger.info('Starting WordPress publishing stage', {
      recruitmentId: evalTarget.recruitmentId,
      jobId: entityJobId,
      sourceId,
    });

    // 2. Enforce PUBLISHING_GATE pass before any WordPress API call
    const gateEvaluation = await PublishingGate.evaluate(evalTarget);
    if (!gateEvaluation.allowed) {
      const gateFailureText = `Publishing gate rejected recruitment "${evalTarget.recruitmentId}": [${gateEvaluation.critical_failures.join(', ')}]`;
      const { externalIdentityKey } = computeDeterministicExternalIdentity({
        sourceId,
        recruitmentId: evalTarget.recruitmentId,
        jobId: entityJobId,
        canonicalSourceUrl:
          canonicalSourceUrl ||
          String(resolvedFields.official_application_url?.value || ''),
        officialNotificationUrl:
          officialNotificationUrl ||
          String(resolvedFields.official_notification_url?.value || ''),
      });

      this.persistPublishingRecord({
        jobId: entityJobId,
        recruitmentId: evalTarget.recruitmentId,
        externalIdentityKey,
        externalPostId: null,
        permalink: null,
        postStatus: null,
        categoriesJson: null,
        canonicalSourceUrl,
        officialPdfUrl: officialNotificationUrl,
        publishStatus: 'GATE_REJECTED',
        validationCheckPassed: 0,
        payloadHash: null,
        errorMessage: gateFailureText,
      });

      context.auditService.record({
        correlationId: context.correlationId,
        actor: 'WORDPRESS_PUBLISH_HANDLER',
        action: 'WORDPRESS_PUBLISH_BLOCKED_BY_GATE',
        entityType: 'RECRUITMENT',
        entityId: evalTarget.recruitmentId,
        stage: this.stageName,
        status: 'FAILURE',
        details: {
          criticalFailures: gateEvaluation.critical_failures,
          reasons: gateEvaluation.reasons,
        },
      });

      return {
        success: false,
        errorCode: 'PUBLISHING_GATE_BLOCKED',
        errorMessage: gateFailureText,
        output: {
          gateEvaluation,
        },
        auditDetails: {
          decision: 'BLOCKED',
          critical_failures: gateEvaluation.critical_failures,
        },
      };
    }

    // 3. Build deterministic external identity & structured HTML content
    const formatted = buildWordPressJobContent({
      sourceId,
      recruitmentId: evalTarget.recruitmentId,
      jobId: entityJobId,
      canonicalSourceUrl,
      officialNotificationUrl,
      fields: resolvedFields,
      categoryNames: input.categories,
      noticeCategory: input.noticeCategory,
    });

    const resolvedClientConfig =
      input?.clientConfig ??
      (context.metadata.clientConfig as WordPressClientConfig | undefined) ??
      this.defaultClientConfig;
    const client = new WordPressRestClient(resolvedClientConfig);
    const rawDesiredStatus = input?.status ?? context.metadata.wpStatus;
    const desiredStatus: WordPressPublishStatus =
      rawDesiredStatus === 'draft' || rawDesiredStatus === 'publish'
        ? rawDesiredStatus
        : client.getDefaultStatus();

    const lockKey = `WORDPRESS:${formatted.externalIdentityKey}`;

    return withExternalIdentityLock(lockKey, async () => {
      try {
        // Validate URL & credentials before any network request
        client.validateConfiguration();

        // 4. Resolve WordPress categories
        const resolvedCategories = await client.ensureCategories(formatted.categoryNames);
        const categoryIds = resolvedCategories.map((c) => c.id);

        // 5. Optional featured media upload/attachment
        let featuredMediaId: number | undefined = input.featuredMediaId;
        if (input.featuredMedia) {
          const uploadedMedia = await client.uploadMedia(input.featuredMedia);
          featuredMediaId = uploadedMedia.id;
        }

        // 6. Re-check local DB and remote WordPress INSIDE the per-identity critical section
        // so concurrent workers or retries after a lost response converge onto the single remote post.
        const existingLocalRecord = repos.publishing.findByExternalIdentity(
          'WORDPRESS',
          formatted.externalIdentityKey
        );
        let existingRemotePost = await client.findPostByExternalIdentity(
          formatted.externalIdentityKey
        );

        // Fallback: if local DB already recorded an external_post_id (e.g. remote search index lag),
        // verify that post ID directly before ever calling createPost().
        if (!existingRemotePost && existingLocalRecord?.external_post_id) {
          const parsedLocalPostId = Number(existingLocalRecord.external_post_id);
          if (Number.isInteger(parsedLocalPostId) && parsedLocalPostId > 0) {
            try {
              existingRemotePost = await client.verifyPublishedPost({
                postId: parsedLocalPostId,
                expectedStatus: desiredStatus,
                expectedExternalIdentity: formatted.externalIdentityKey,
              });
            } catch {
              // If the recorded remote post was deleted or no longer matches identity, fall back to search/create
              existingRemotePost = null;
            }
          }
        }

        let writtenPost: VerifiedWordPressPost;
        let operation: 'CREATED' | 'UPDATED' | 'NOOP_IDEMPOTENT';

        if (
          existingRemotePost &&
          existingLocalRecord &&
          existingLocalRecord.publish_status === 'PUBLISHED' &&
          existingLocalRecord.payload_hash === formatted.payloadHash &&
          existingRemotePost.status === desiredStatus &&
          !input.forceUpdate
        ) {
          // Idempotent retry / concurrent duplicate of already-published identical payload:
          // verify via readback without duplicate creation
          writtenPost = existingRemotePost;
          operation = 'NOOP_IDEMPOTENT';
        } else if (existingRemotePost) {
          // Post exists on WordPress for this deterministic external identity -> update existing post
          writtenPost = await client.updatePost(existingRemotePost.postId, {
            title: formatted.title,
            content: formatted.htmlContent,
            excerpt: formatted.excerpt,
            status: desiredStatus,
            slug: formatted.slug,
            categories: categoryIds,
            featuredMediaId,
            externalIdentityKey: formatted.externalIdentityKey,
            canonicalSourceUrl: formatted.canonicalSourceUrl,
            officialNotificationUrl: formatted.officialNotificationUrl,
            sourceId,
            recruitmentId: evalTarget.recruitmentId,
            jobId: entityJobId,
            payloadHash: formatted.payloadHash,
          });
          operation = 'UPDATED';
        } else {
          // Create new post and strictly verify response
          writtenPost = await client.createPost({
            title: formatted.title,
            content: formatted.htmlContent,
            excerpt: formatted.excerpt,
            status: desiredStatus,
            slug: formatted.slug,
            categories: categoryIds,
            featuredMediaId,
            externalIdentityKey: formatted.externalIdentityKey,
            canonicalSourceUrl: formatted.canonicalSourceUrl,
            officialNotificationUrl: formatted.officialNotificationUrl,
            sourceId,
            recruitmentId: evalTarget.recruitmentId,
            jobId: entityJobId,
            payloadHash: formatted.payloadHash,
          });
          operation = 'CREATED';
        }

        // 6b. Explicit POST VERIFICATION step (GET /wp-json/wp/v2/posts/:id)
        // Never mark PUBLISHED until the persisted post is verified for ID, status, slug, permalink, categories, and identity.
        const verifiedPost = await client.verifyPublishedPost({
          postId: writtenPost.postId,
          expectedStatus: desiredStatus,
          expectedExternalIdentity: formatted.externalIdentityKey,
          expectedSlug: formatted.slug,
          expectedCategoryIds: categoryIds,
        });

        // 7. Atomically upsert verified publishing record (DB unique index on (platform, external_identity_key))
        const persistedRecord = this.persistPublishingRecord({
          existingRecordId: existingLocalRecord?.id,
          jobId: entityJobId,
          recruitmentId: evalTarget.recruitmentId,
          externalIdentityKey: verifiedPost.externalIdentityKey,
          externalPostId: String(verifiedPost.postId),
          permalink: verifiedPost.permalink,
          postStatus: verifiedPost.status,
          categoriesJson: JSON.stringify(resolvedCategories),
          canonicalSourceUrl: formatted.canonicalSourceUrl,
          officialPdfUrl: formatted.officialNotificationUrl,
          publishStatus: 'PUBLISHED',
          validationCheckPassed: 1,
          payloadHash: formatted.payloadHash,
          errorMessage: null,
        });

        // Transition recruitment status to PUBLISH_READY if it existed in DB
        const existingRecruitment = repos.recruitments.findById(evalTarget.recruitmentId);
        if (existingRecruitment) {
          repos.recruitments.updateStatus(evalTarget.recruitmentId, 'PUBLISH_READY');
        }

        context.auditService.record({
          correlationId: context.correlationId,
          actor: 'WORDPRESS_PUBLISH_HANDLER',
          action: `WORDPRESS_POST_${operation}`,
          entityType: 'RECRUITMENT',
          entityId: evalTarget.recruitmentId,
          stage: this.stageName,
          status: 'SUCCESS',
          details: {
            publishingRecordId: persistedRecord.id,
            wpPostId: verifiedPost.postId,
            wpStatus: verifiedPost.status,
            slug: verifiedPost.slug,
            permalink: verifiedPost.permalink,
            externalIdentityKey: verifiedPost.externalIdentityKey,
            categories: resolvedCategories,
            postVerified: Boolean(verifiedPost.verifiedViaReadback),
            verifiedAt: verifiedPost.verifiedAt ?? null,
            operation,
          },
        });

        return {
          success: true,
          output: {
            publishingRecordId: persistedRecord.id,
            wpPostId: verifiedPost.postId,
            wpStatus: verifiedPost.status,
            slug: verifiedPost.slug,
            permalink: verifiedPost.permalink,
            externalIdentityKey: verifiedPost.externalIdentityKey,
            categories: resolvedCategories,
            featuredMediaId: verifiedPost.featuredMediaId,
            canonicalSourceUrl: formatted.canonicalSourceUrl,
            officialNotificationUrl: formatted.officialNotificationUrl,
            payloadHash: formatted.payloadHash,
            postVerified: Boolean(verifiedPost.verifiedViaReadback),
            verifiedAt: verifiedPost.verifiedAt ?? null,
            operation,
          },
          auditDetails: {
            wpPostId: verifiedPost.postId,
            wpStatus: verifiedPost.status,
            slug: verifiedPost.slug,
            postVerified: Boolean(verifiedPost.verifiedViaReadback),
            operation,
          },
        };
      } catch (err) {
        const errorCode =
          err instanceof WordPressClientError ? err.code : 'WP_PUBLISH_FAILED';
        const errorMessage =
          err instanceof Error ? err.message : `Unexpected WordPress publish failure: ${String(err)}`;

        const existingLocalRecord = repos.publishing.findByExternalIdentity(
          'WORDPRESS',
          formatted.externalIdentityKey
        );

        this.persistPublishingRecord({
          existingRecordId: existingLocalRecord?.id,
          jobId: entityJobId,
          recruitmentId: evalTarget.recruitmentId,
          externalIdentityKey: formatted.externalIdentityKey,
          externalPostId: existingLocalRecord?.external_post_id ?? null,
          permalink: existingLocalRecord?.permalink ?? null,
          postStatus: desiredStatus,
          categoriesJson: existingLocalRecord?.categories_json ?? null,
          canonicalSourceUrl: formatted.canonicalSourceUrl,
          officialPdfUrl: formatted.officialNotificationUrl,
          publishStatus: 'FAILED',
          validationCheckPassed: 1,
          payloadHash: formatted.payloadHash,
          errorMessage: `[${errorCode}] ${errorMessage}`,
        });

        context.auditService.record({
          correlationId: context.correlationId,
          actor: 'WORDPRESS_PUBLISH_HANDLER',
          action: 'WORDPRESS_PUBLISH_FAILED',
          entityType: 'RECRUITMENT',
          entityId: evalTarget.recruitmentId,
          stage: this.stageName,
          status: 'FAILURE',
          details: {
            errorCode,
            errorMessage,
            externalIdentityKey: formatted.externalIdentityKey,
          },
        });

        return {
          success: false,
          errorCode,
          errorMessage,
          auditDetails: {
            errorCode,
            externalIdentityKey: formatted.externalIdentityKey,
          },
        };
      }
    });
  }

  private resolveEvaluationTarget(
    input: WordPressPublishStageInput,
    context: PipelineContext
  ):
    | {
        ok: true;
        evalTarget: PublishingEvaluationTarget;
        sourceId: string;
        resolvedFields: StructuredRecruitmentData;
        entityJobId: string;
        canonicalSourceUrl: string;
        officialNotificationUrl: string;
      }
    | { ok: false; errorCode: string; errorMessage: string } {
    const repos = getRepositories();

    if (input?.target) {
      const t = input.target;
      const sourceId = (t.sourceId || 'UNKNOWN_SOURCE').trim();
      const resolvedFields =
        t.fields ??
        createDefaultStructuredFields(sourceId, t.documentId || t.recruitmentId || 'DOC');
      const entityJobId = input.jobId || t.recruitmentId || context.jobId;
      const officialNotificationUrl = String(
        input.officialNotificationUrl || resolvedFields.official_notification_url?.value || ''
      ).trim();
      const canonicalSourceUrl = String(
        input.canonicalSourceUrl ||
          resolvedFields.official_application_url?.value ||
          officialNotificationUrl ||
          ''
      ).trim();

      return {
        ok: true,
        evalTarget: { ...t, sourceId, fields: resolvedFields },
        sourceId,
        resolvedFields,
        entityJobId,
        canonicalSourceUrl,
        officialNotificationUrl,
      };
    }

    const metadataRecruitmentId =
      typeof context.metadata.recruitmentId === 'string' && context.metadata.recruitmentId.trim().length > 0
        ? context.metadata.recruitmentId.trim()
        : undefined;
    const candidateId =
      input?.recruitmentId ||
      metadataRecruitmentId ||
      input?.jobId ||
      context.targetEntityId;
    if (!candidateId) {
      return {
        ok: false,
        errorCode: 'MISSING_RECRUITMENT_ID',
        errorMessage: 'WORDPRESS_PUBLISH stage requires recruitmentId, jobId, or target payload',
      };
    }

    let recruitment = repos.recruitments.findById(candidateId);
    let resolvedJobId = input?.jobId || candidateId;

    if (!recruitment) {
      const jobEntity = repos.jobs.findById(candidateId);
      if (jobEntity) {
        resolvedJobId = jobEntity.id;
        recruitment = repos.recruitments.findById(jobEntity.recruitment_id);
      }
    }

    if (!recruitment) {
      return {
        ok: false,
        errorCode: 'RECRUITMENT_NOT_FOUND',
        errorMessage: `Recruitment "${candidateId}" not found for WordPress publishing`,
      };
    }

    let parsedPayload: {
      fields?: StructuredRecruitmentData;
    } = {};

    if (recruitment.raw_payload_json) {
      try {
        parsedPayload = JSON.parse(recruitment.raw_payload_json);
      } catch {
        return {
          ok: false,
          errorCode: 'CORRUPTED_RECRUITMENT_PAYLOAD',
          errorMessage: `Recruitment "${recruitment.id}" has corrupted raw_payload_json`,
        };
      }
    }

    if (!parsedPayload.fields) {
      return {
        ok: false,
        errorCode: 'MISSING_STRUCTURED_FIELDS',
        errorMessage: `Recruitment "${recruitment.id}" has no structured extraction fields`,
      };
    }

    let pages: Array<{ pageNumber: number; extractedText: string }> | undefined;
    let docSourceUrl = '';
    let docCanonicalUrl = '';

    if (recruitment.document_id) {
      const doc = repos.documents.findById(recruitment.document_id);
      if (doc) {
        docSourceUrl = doc.source_url || '';
        docCanonicalUrl = doc.canonical_url || '';
        const dbPages = repos.documents.getPages(doc.id);
        if (dbPages.length > 0) {
          pages = dbPages.map((p) => ({
            pageNumber: p.page_number,
            extractedText: p.extracted_text,
          }));
        }
      }
    }

    const source = repos.sources.findById(recruitment.source_id);
    const officialNotificationUrl = String(
      input?.officialNotificationUrl ||
        parsedPayload.fields.official_notification_url?.value ||
        docCanonicalUrl ||
        docSourceUrl ||
        source?.base_url ||
        ''
    ).trim();

    const canonicalSourceUrl = String(
      input?.canonicalSourceUrl ||
        parsedPayload.fields.official_application_url?.value ||
        source?.base_url ||
        officialNotificationUrl ||
        ''
    ).trim();

    return {
      ok: true,
      evalTarget: {
        recruitmentId: recruitment.id,
        sourceId: recruitment.source_id,
        documentId: recruitment.document_id ?? undefined,
        title: recruitment.title,
        department: recruitment.department,
        notificationNumber: recruitment.notification_number,
        totalVacancies: recruitment.total_vacancies,
        applicationStartDate: recruitment.application_start_date,
        applicationEndDate: recruitment.application_end_date,
        rawPayloadJson: recruitment.raw_payload_json,
        status: recruitment.status,
        fields: parsedPayload.fields,
        pages,
      },
      sourceId: recruitment.source_id,
      resolvedFields: parsedPayload.fields,
      entityJobId: resolvedJobId,
      canonicalSourceUrl,
      officialNotificationUrl,
    };
  }

  private persistPublishingRecord(params: {
    existingRecordId?: string;
    jobId: string;
    recruitmentId: string;
    externalIdentityKey: string;
    externalPostId: string | null;
    permalink: string | null;
    postStatus: string | null;
    categoriesJson: string | null;
    canonicalSourceUrl: string;
    officialPdfUrl: string;
    publishStatus: 'PENDING' | 'GATE_PASSED' | 'GATE_REJECTED' | 'PUBLISHED' | 'FAILED';
    validationCheckPassed: number;
    payloadHash: string | null;
    errorMessage: string | null;
  }) {
    const repos = getRepositories();
    const now = new Date().toISOString();

    return repos.publishing.upsertByExternalIdentity({
      id: params.existingRecordId || `pub-${crypto.randomUUID()}`,
      job_id: params.jobId,
      recruitment_id: params.recruitmentId,
      platform: 'WORDPRESS',
      external_post_id: params.externalPostId,
      external_identity_key: params.externalIdentityKey,
      permalink: params.permalink,
      post_status: params.postStatus,
      categories_json: params.categoriesJson,
      canonical_source_url: params.canonicalSourceUrl || null,
      official_pdf_url: params.officialPdfUrl || null,
      publish_status: params.publishStatus,
      validation_check_passed: params.validationCheckPassed,
      published_at: params.publishStatus === 'PUBLISHED' ? now : null,
      updated_at: now,
      payload_hash: params.payloadHash,
      error_message: params.errorMessage,
    });
  }
}
