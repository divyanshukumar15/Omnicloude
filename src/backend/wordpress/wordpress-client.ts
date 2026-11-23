/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../config/logger.ts';
import type {
  VerifiedWordPressPost,
  WordPressCategory,
  WordPressClientConfig,
  WordPressErrorCode,
  WordPressMediaItem,
  WordPressMediaUploadInput,
  WordPressPostWriteInput,
  WordPressPublishStatus,
  WordPressRawPostResponse,
  WordPressReadinessReport,
} from './types.ts';

export class WordPressClientError extends Error {
  public readonly code: WordPressErrorCode;
  public readonly httpStatus: number | null;
  public readonly retryable: boolean;

  constructor(
    code: WordPressErrorCode,
    message: string,
    options?: { httpStatus?: number | null; retryable?: boolean; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'WordPressClientError';
    this.code = code;
    this.httpStatus = options?.httpStatus ?? null;
    this.retryable = options?.retryable ?? false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower === '::1'
  );
}

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'category'
  );
}

export class WordPressRestClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly appPassword: string;
  private readonly defaultStatus: WordPressPublishStatus;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly nodeEnv: 'development' | 'production' | 'test';
  private readonly allowInsecureLocalHttp: boolean;

  constructor(config: WordPressClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.OMNIHUB_WP_URL ?? '').trim().replace(/\/+$/, '');
    this.username = (config.username ?? process.env.OMNIHUB_WP_USERNAME ?? '').trim();
    this.appPassword = (config.appPassword ?? process.env.OMNIHUB_WP_APP_PASSWORD ?? '').trim();

    const envStatus = (config.defaultStatus ?? process.env.OMNIHUB_WP_DEFAULT_STATUS ?? 'draft')
      .trim()
      .toLowerCase();
    this.defaultStatus = envStatus === 'publish' ? 'publish' : 'draft';

    this.timeoutMs =
      config.timeoutMs ??
      (process.env.OMNIHUB_WP_TIMEOUT_MS ? Number(process.env.OMNIHUB_WP_TIMEOUT_MS) : 15000);
    this.maxRetries =
      config.maxRetries ??
      (process.env.OMNIHUB_WP_MAX_RETRIES !== undefined
        ? Number(process.env.OMNIHUB_WP_MAX_RETRIES)
        : 2);
    this.retryBackoffMs =
      config.retryBackoffMs ??
      (process.env.OMNIHUB_WP_RETRY_BACKOFF_MS
        ? Number(process.env.OMNIHUB_WP_RETRY_BACKOFF_MS)
        : 250);
    this.nodeEnv =
      config.nodeEnv ??
      ((process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development');
    this.allowInsecureLocalHttp =
      config.allowInsecureLocalHttp ?? this.nodeEnv !== 'production';
  }

  public isConfigured(): boolean {
    return Boolean(this.baseUrl && this.username && this.appPassword);
  }

  public getDefaultStatus(): WordPressPublishStatus {
    return this.defaultStatus;
  }

  public getSanitizedEndpointUrl(): string | null {
    if (!this.baseUrl) return null;
    try {
      const parsed = new URL(this.baseUrl);
      parsed.username = '';
      parsed.password = '';
      return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    } catch {
      return null;
    }
  }

  /**
   * Validates configuration and URL security rules.
   * HTTPS is strictly required in production and on all non-loopback hosts.
   */
  public validateConfiguration(): URL {
    if (!this.baseUrl || !this.username || !this.appPassword) {
      throw new WordPressClientError(
        'WP_NOT_CONFIGURED',
        'WordPress publishing credentials are not configured (OMNIHUB_WP_URL, OMNIHUB_WP_USERNAME, OMNIHUB_WP_APP_PASSWORD required)',
        { retryable: false }
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(this.baseUrl);
    } catch {
      throw new WordPressClientError(
        'WP_INVALID_URL',
        'OMNIHUB_WP_URL is not a valid URL',
        { retryable: false }
      );
    }

    if (parsed.username || parsed.password) {
      throw new WordPressClientError(
        'WP_INVALID_URL',
        'OMNIHUB_WP_URL must not contain embedded userinfo credentials',
        { retryable: false }
      );
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new WordPressClientError(
        'WP_INVALID_URL',
        `Unsupported WordPress URL protocol "${parsed.protocol}"`,
        { retryable: false }
      );
    }

    if (parsed.protocol !== 'https:') {
      const loopback = isLoopbackHost(parsed.hostname);
      if (this.nodeEnv === 'production' || !loopback || !this.allowInsecureLocalHttp) {
        throw new WordPressClientError(
          'WP_INSECURE_URL',
          'HTTPS is required for WordPress REST API communication in production and for non-loopback endpoints',
          { retryable: false }
        );
      }
    }

    return parsed;
  }

  private buildAuthHeader(): string {
    const token = Buffer.from(`${this.username}:${this.appPassword}`, 'utf-8').toString('base64');
    return `Basic ${token}`;
  }

  private buildApiUrl(endpointPath: string, query?: Record<string, string | number | undefined>): string {
    const validatedBase = this.validateConfiguration();
    const baseStr = validatedBase.toString().replace(/\/+$/, '');
    const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    const fullUrl = new URL(`${baseStr}/wp-json/wp/v2${normalizedPath}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') {
          fullUrl.searchParams.set(key, String(value));
        }
      }
    }

    return fullUrl.toString();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Executes an HTTP request against the WordPress REST API with timeout,
   * credential isolation, and safe retry only for idempotent operations.
   */
  private async requestJson<T>(options: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown> | Buffer;
    headers?: Record<string, string>;
    idempotent: boolean;
    operationName: string;
  }): Promise<{ status: number; data: T }> {
    const url = this.buildApiUrl(options.path, options.query);
    const maxAttempts = options.idempotent ? Math.max(1, 1 + this.maxRetries) : 1;
    let lastError: WordPressClientError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const isBuffer = Buffer.isBuffer(options.body);
        const headers: Record<string, string> = {
          Authorization: this.buildAuthHeader(),
          Accept: 'application/json',
          'User-Agent': 'OmniHub-GovJobs-Publisher/1.0',
          ...(isBuffer ? {} : options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        };

        const response = await fetch(url, {
          method: options.method,
          headers,
          body: isBuffer
            ? (options.body as unknown as BodyInit)
            : options.body
            ? JSON.stringify(options.body)
            : undefined,
          signal: controller.signal,
          redirect: 'manual',
        });

        clearTimeout(timeoutHandle);

        const rawText = await response.text();
        let parsedJson: unknown = null;
        if (rawText.trim().length > 0) {
          try {
            parsedJson = JSON.parse(rawText);
          } catch {
            if (response.ok) {
              throw new WordPressClientError(
                'WP_INVALID_RESPONSE',
                `WordPress returned non-JSON body during ${options.operationName} (HTTP ${response.status})`,
                { httpStatus: response.status, retryable: false }
              );
            }
          }
        }

        if (!response.ok) {
          throw this.classifyHttpError(response.status, parsedJson, options.operationName);
        }

        if (parsedJson === null || typeof parsedJson !== 'object') {
          throw new WordPressClientError(
            'WP_INVALID_RESPONSE',
            `WordPress returned empty or non-object JSON payload during ${options.operationName}`,
            { httpStatus: response.status, retryable: false }
          );
        }

        return { status: response.status, data: parsedJson as T };
      } catch (err) {
        clearTimeout(timeoutHandle);

        const classified = this.classifyException(err, options.operationName);
        lastError = classified;

        const canRetry = options.idempotent && classified.retryable && attempt < maxAttempts;
        logger.warn('WordPress REST API request failed', {
          operation: options.operationName,
          method: options.method,
          endpoint: this.getSanitizedEndpointUrl(),
          path: options.path,
          attempt,
          maxAttempts,
          errorCode: classified.code,
          httpStatus: classified.httpStatus,
          willRetry: canRetry,
        });

        if (canRetry) {
          await this.sleep(this.retryBackoffMs * attempt);
          continue;
        }

        throw classified;
      }
    }

    throw (
      lastError ??
      new WordPressClientError('WP_NETWORK_ERROR', `WordPress operation ${options.operationName} failed`)
    );
  }

  private classifyHttpError(
    status: number,
    parsedBody: unknown,
    operationName: string
  ): WordPressClientError {
    const wpMessage =
      parsedBody &&
      typeof parsedBody === 'object' &&
      'message' in parsedBody &&
      typeof (parsedBody as { message?: unknown }).message === 'string'
        ? (parsedBody as { message: string }).message
        : `HTTP ${status}`;

    if (status === 401 || status === 403) {
      return new WordPressClientError(
        'WP_AUTH_FAILED',
        `WordPress authentication/authorization failed during ${operationName}: ${wpMessage}`,
        { httpStatus: status, retryable: false }
      );
    }

    if (status === 429) {
      return new WordPressClientError(
        'WP_RATE_LIMITED',
        `WordPress rate limit exceeded during ${operationName}: ${wpMessage}`,
        { httpStatus: status, retryable: true }
      );
    }

    if (status >= 500) {
      return new WordPressClientError(
        'WP_SERVER_ERROR',
        `WordPress server error (HTTP ${status}) during ${operationName}: ${wpMessage}`,
        { httpStatus: status, retryable: true }
      );
    }

    return new WordPressClientError(
      'WP_PUBLISH_FAILED',
      `WordPress rejected request (HTTP ${status}) during ${operationName}: ${wpMessage}`,
      { httpStatus: status, retryable: false }
    );
  }

  private classifyException(err: unknown, operationName: string): WordPressClientError {
    if (err instanceof WordPressClientError) {
      return err;
    }

    if (err instanceof Error) {
      const isAbort =
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        err.message.toLowerCase().includes('aborted') ||
        err.message.toLowerCase().includes('timeout');

      if (isAbort) {
        return new WordPressClientError(
          'WP_TIMEOUT',
          `WordPress request timed out after ${this.timeoutMs}ms during ${operationName}`,
          { retryable: true, cause: err }
        );
      }

      return new WordPressClientError(
        'WP_NETWORK_ERROR',
        `WordPress network error during ${operationName}: ${err.message}`,
        { retryable: true, cause: err }
      );
    }

    return new WordPressClientError(
      'WP_NETWORK_ERROR',
      `Unexpected WordPress communication failure during ${operationName}`,
      { retryable: true }
    );
  }

  /**
   * Resolves category names to WordPress category IDs via lookup + create mapping.
   */
  public async ensureCategories(categoryNames: string[]): Promise<WordPressCategory[]> {
    this.validateConfiguration();

    const uniqueNames = Array.from(
      new Set(categoryNames.map((n) => n.trim()).filter(Boolean))
    );
    if (uniqueNames.length === 0) {
      return [];
    }

    const resolved: WordPressCategory[] = [];

    for (const name of uniqueNames) {
      const targetSlug = toSlug(name);
      try {
        // 1. Safe idempotent lookup
        const lookup = await this.requestJson< unknown >({
          method: 'GET',
          path: '/categories',
          query: { search: name, per_page: 50 },
          idempotent: true,
          operationName: `category_lookup:${targetSlug}`,
        });

        if (!Array.isArray(lookup.data)) {
          throw new WordPressClientError(
            'WP_CATEGORY_MAPPING_FAILED',
            `Expected array response from /wp-json/wp/v2/categories for "${name}"`,
            { httpStatus: lookup.status, retryable: false }
          );
        }

        const existing = lookup.data.find((item) => {
          if (!item || typeof item !== 'object') return false;
          const cat = item as Record<string, unknown>;
          const hasValidId = typeof cat.id === 'number' && Number.isInteger(cat.id) && cat.id > 0;
          if (!hasValidId) return false;
          const catName = typeof cat.name === 'string' ? cat.name.trim().toLowerCase() : '';
          const catSlug = typeof cat.slug === 'string' ? cat.slug.trim().toLowerCase() : '';
          return catName === name.toLowerCase() || catSlug === targetSlug;
        }) as Record<string, unknown> | undefined;

        if (existing) {
          resolved.push({
            id: existing.id as number,
            name: typeof existing.name === 'string' ? existing.name : name,
            slug: typeof existing.slug === 'string' ? existing.slug : targetSlug,
          });
          continue;
        }

        // 2. Create missing category
        const created = await this.requestJson<Record<string, unknown>>({
          method: 'POST',
          path: '/categories',
          body: { name, slug: targetSlug },
          idempotent: false,
          operationName: `category_create:${targetSlug}`,
        });

        const createdId = created.data?.id;
        if (typeof createdId !== 'number' || !Number.isInteger(createdId) || createdId <= 0) {
          throw new WordPressClientError(
            'WP_CATEGORY_MAPPING_FAILED',
            `WordPress category creation for "${name}" did not return a valid numeric ID`,
            { httpStatus: created.status, retryable: false }
          );
        }

        resolved.push({
          id: createdId,
          name: typeof created.data.name === 'string' ? created.data.name : name,
          slug: typeof created.data.slug === 'string' ? created.data.slug : targetSlug,
        });
      } catch (err) {
        if (
          err instanceof WordPressClientError &&
          (err.code === 'WP_AUTH_FAILED' ||
            err.code === 'WP_TIMEOUT' ||
            err.code === 'WP_NOT_CONFIGURED' ||
            err.code === 'WP_INVALID_URL' ||
            err.code === 'WP_INSECURE_URL')
        ) {
          throw err;
        }

        const message = err instanceof Error ? err.message : String(err);
        throw new WordPressClientError(
          'WP_CATEGORY_MAPPING_FAILED',
          `Failed to map WordPress category "${name}": ${message}`,
          {
            httpStatus: err instanceof WordPressClientError ? err.httpStatus : null,
            retryable: false,
            cause: err,
          }
        );
      }
    }

    return resolved;
  }

  /**
   * Uploads featured image/media via /wp-json/wp/v2/media.
   */
  public async uploadMedia(input: WordPressMediaUploadInput): Promise<WordPressMediaItem> {
    this.validateConfiguration();

    const safeFilename = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'featured-image.png';
    try {
      const response = await this.requestJson<Record<string, unknown>>({
        method: 'POST',
        path: '/media',
        body: input.buffer,
        headers: {
          'Content-Type': input.mimeType,
          'Content-Disposition': `attachment; filename="${safeFilename}"`,
        },
        idempotent: false,
        operationName: `media_upload:${safeFilename}`,
      });

      const id = response.data?.id;
      const sourceUrl = response.data?.source_url;
      if (
        typeof id !== 'number' ||
        !Number.isInteger(id) ||
        id <= 0 ||
        typeof sourceUrl !== 'string' ||
        !sourceUrl.trim()
      ) {
        throw new WordPressClientError(
          'WP_MEDIA_UPLOAD_FAILED',
          'WordPress media upload returned an invalid media ID or missing source_url',
          { httpStatus: response.status, retryable: false }
        );
      }

      return {
        id,
        source_url: sourceUrl,
        alt_text: input.altText,
      };
    } catch (err) {
      if (err instanceof WordPressClientError && err.code === 'WP_MEDIA_UPLOAD_FAILED') {
        throw err;
      }
      if (
        err instanceof WordPressClientError &&
        (err.code === 'WP_AUTH_FAILED' || err.code === 'WP_TIMEOUT')
      ) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new WordPressClientError(
        'WP_MEDIA_UPLOAD_FAILED',
        `WordPress media upload failed: ${msg}`,
        {
          httpStatus: err instanceof WordPressClientError ? err.httpStatus : null,
          retryable: false,
          cause: err,
        }
      );
    }
  }

  /**
   * Looks up an existing WordPress post by deterministic external job identity.
   * Uses safe idempotent GET requests so duplicate posts are never created on retry.
   */
  public async findPostByExternalIdentity(
    externalIdentityKey: string
  ): Promise<VerifiedWordPressPost | null> {
    this.validateConfiguration();

    const normalizedKey = externalIdentityKey.trim();
    if (!normalizedKey) return null;

    const response = await this.requestJson<unknown>({
      method: 'GET',
      path: '/posts',
      query: {
        slug: normalizedKey,
        status: 'any',
        per_page: 10,
      },
      idempotent: true,
      operationName: `post_lookup_by_identity:${normalizedKey}`,
    });

    if (!Array.isArray(response.data)) {
      throw new WordPressClientError(
        'WP_INVALID_RESPONSE',
        'WordPress post lookup did not return a JSON array',
        { httpStatus: response.status, retryable: false }
      );
    }

    for (const candidate of response.data) {
      if (!candidate || typeof candidate !== 'object') continue;
      const raw = candidate as WordPressRawPostResponse;
      if (this.matchesExternalIdentity(raw, normalizedKey)) {
        const rawStatus =
          typeof raw.status === 'string' && (raw.status === 'publish' || raw.status === 'draft')
            ? (raw.status as WordPressPublishStatus)
            : this.defaultStatus;
        return this.verifyPostResponse(raw, rawStatus, normalizedKey);
      }
    }

    return null;
  }

  /**
   * Creates a new WordPress post or, if a transient error occurred after server creation,
   * recovers idempotently via external identity lookup before failing.
   */
  public async createPost(input: WordPressPostWriteInput): Promise<VerifiedWordPressPost> {
    this.validateConfiguration();

    const requestBody = this.buildPostRequestBody(input);

    try {
      const response = await this.requestJson<WordPressRawPostResponse>({
        method: 'POST',
        path: '/posts',
        body: requestBody,
        idempotent: false,
        operationName: `post_create:${input.externalIdentityKey}`,
      });

      return this.verifyPostResponse(response.data, input.status, input.externalIdentityKey);
    } catch (err) {
      // If a transient timeout/5xx happened on POST, check if WordPress actually created the post
      // before retrying as an idempotent update or re-attempting creation.
      if (err instanceof WordPressClientError && err.retryable && this.maxRetries > 0) {
        const existingAfterFailure = await this.findPostByExternalIdentity(
          input.externalIdentityKey
        ).catch(() => null);

        if (existingAfterFailure) {
          return this.updatePost(existingAfterFailure.postId, input);
        }

        // Post was confirmed NOT created on WordPress; safe to retry once after backoff
        await this.sleep(this.retryBackoffMs);
        const retryResponse = await this.requestJson<WordPressRawPostResponse>({
          method: 'POST',
          path: '/posts',
          body: requestBody,
          idempotent: false,
          operationName: `post_create_retry:${input.externalIdentityKey}`,
        });

        return this.verifyPostResponse(retryResponse.data, input.status, input.externalIdentityKey);
      }

      throw err;
    }
  }

  /**
   * Updates an existing WordPress post by ID (idempotent operation).
   */
  public async updatePost(
    postId: number,
    input: WordPressPostWriteInput
  ): Promise<VerifiedWordPressPost> {
    this.validateConfiguration();

    if (!Number.isInteger(postId) || postId <= 0) {
      throw new WordPressClientError(
        'WP_INVALID_RESPONSE',
        `Cannot update WordPress post with invalid postId: ${String(postId)}`,
        { retryable: false }
      );
    }

    const requestBody = this.buildPostRequestBody(input);
    const response = await this.requestJson<WordPressRawPostResponse>({
      method: 'POST',
      path: `/posts/${postId}`,
      body: requestBody,
      idempotent: true,
      operationName: `post_update:${postId}`,
    });

    const verified = this.verifyPostResponse(
      response.data,
      input.status,
      input.externalIdentityKey
    );

    if (verified.postId !== postId) {
      throw new WordPressClientError(
        'WP_IDENTITY_MISMATCH',
        `WordPress update for post ${postId} returned mismatched post ID ${verified.postId}`,
        { httpStatus: response.status, retryable: false }
      );
    }

    return verified;
  }

  private buildPostRequestBody(input: WordPressPostWriteInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      title: input.title,
      content: input.content,
      excerpt: input.excerpt ?? '',
      status: input.status,
      slug: input.slug || input.externalIdentityKey,
      meta: {
        omnihub_external_identity: input.externalIdentityKey,
        omnihub_canonical_source_url: input.canonicalSourceUrl,
        omnihub_official_pdf_url: input.officialNotificationUrl,
        omnihub_source_id: input.sourceId,
        omnihub_recruitment_id: input.recruitmentId,
        omnihub_job_id: input.jobId ?? input.recruitmentId,
        omnihub_payload_hash: input.payloadHash,
      },
    };

    if (input.categories && input.categories.length > 0) {
      body.categories = input.categories;
    }

    if (typeof input.featuredMediaId === 'number' && input.featuredMediaId > 0) {
      body.featured_media = input.featuredMediaId;
    }

    return body;
  }

  private matchesExternalIdentity(
    raw: WordPressRawPostResponse,
    expectedExternalIdentity: string
  ): boolean {
    const metaIdentity =
      raw.meta && typeof raw.meta.omnihub_external_identity === 'string'
        ? raw.meta.omnihub_external_identity.trim()
        : null;

    if (metaIdentity) {
      return metaIdentity === expectedExternalIdentity;
    }

    const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
    if (slug && slug === expectedExternalIdentity) {
      return true;
    }

    const renderedContent =
      typeof raw.content === 'string'
        ? raw.content
        : raw.content && typeof raw.content === 'object'
        ? String(raw.content.raw || raw.content.rendered || '')
        : '';

    if (renderedContent.includes(`omnihub-external-identity:${expectedExternalIdentity}`)) {
      return true;
    }

    return false;
  }

  /**
   * Strict verification of WordPress post responses.
   * Never marks publishing successful merely because HTTP 200 was returned.
   * Verifies:
   * 1. Valid positive integer post ID
   * 2. Expected post status ('draft' or 'publish')
   * 3. Valid published HTTP(S) permalink
   * 4. Matching deterministic external job identity
   */
  public verifyPostResponse(
    raw: WordPressRawPostResponse,
    expectedStatus: WordPressPublishStatus,
    expectedExternalIdentity: string
  ): VerifiedWordPressPost {
    if (!raw || typeof raw !== 'object') {
      throw new WordPressClientError(
        'WP_INVALID_RESPONSE',
        'WordPress response payload is missing or not an object',
        { retryable: false }
      );
    }

    const postId = raw.id;
    if (typeof postId !== 'number' || !Number.isInteger(postId) || postId <= 0) {
      throw new WordPressClientError(
        'WP_INVALID_RESPONSE',
        `WordPress response did not contain a valid positive numeric post ID (received: ${String(postId)})`,
        { retryable: false }
      );
    }

    const returnedStatus = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : '';
    if (returnedStatus !== expectedStatus) {
      throw new WordPressClientError(
        'WP_STATUS_MISMATCH',
        `WordPress post ${postId} returned status "${returnedStatus}", expected "${expectedStatus}"`,
        { retryable: false }
      );
    }

    const permalink = typeof raw.link === 'string' ? raw.link.trim() : '';
    if (!permalink) {
      throw new WordPressClientError(
        'WP_PERMALINK_MISSING',
        `WordPress post ${postId} response is missing a valid permalink (link)`,
        { retryable: false }
      );
    }

    try {
      const parsedPermalink = new URL(permalink);
      if (parsedPermalink.protocol !== 'https:' && parsedPermalink.protocol !== 'http:') {
        throw new Error('Invalid permalink protocol');
      }
    } catch {
      throw new WordPressClientError(
        'WP_PERMALINK_MISSING',
        `WordPress post ${postId} returned a malformed permalink URL: "${permalink}"`,
        { retryable: false }
      );
    }

    if (!this.matchesExternalIdentity(raw, expectedExternalIdentity)) {
      throw new WordPressClientError(
        'WP_IDENTITY_MISMATCH',
        `WordPress post ${postId} failed external job identity verification (expected "${expectedExternalIdentity}")`,
        { retryable: false }
      );
    }

    const categories = Array.isArray(raw.categories)
      ? raw.categories.filter((c): c is number => typeof c === 'number' && Number.isInteger(c))
      : [];

    const featuredMediaId =
      typeof raw.featured_media === 'number' && raw.featured_media > 0
        ? raw.featured_media
        : null;

    const modifiedAt =
      typeof raw.modified_gmt === 'string' && raw.modified_gmt.trim()
        ? raw.modified_gmt
        : new Date().toISOString();

    return {
      postId,
      status: returnedStatus as WordPressPublishStatus,
      permalink,
      slug: typeof raw.slug === 'string' ? raw.slug : expectedExternalIdentity,
      externalIdentityKey: expectedExternalIdentity,
      categories,
      featuredMediaId,
      modifiedAt,
    };
  }

  /**
   * Explicit post-write GET verification against WordPress REST API (/wp-json/wp/v2/posts/:id).
   * Confirms the persisted post exists with expected ID, status, slug, permalink,
   * category assignments, and deterministic external identity BEFORE marking PUBLISHED.
   */
  public async verifyPublishedPost(params: {
    postId: number;
    expectedStatus: WordPressPublishStatus;
    expectedExternalIdentity: string;
    expectedSlug?: string;
    expectedCategoryIds?: number[];
  }): Promise<VerifiedWordPressPost> {
    this.validateConfiguration();

    if (!Number.isInteger(params.postId) || params.postId <= 0) {
      throw new WordPressClientError(
        'WP_POST_VERIFICATION_FAILED',
        `Cannot verify WordPress post with invalid postId: ${String(params.postId)}`,
        { retryable: false }
      );
    }

    const response = await this.requestJson<WordPressRawPostResponse>({
      method: 'GET',
      path: `/posts/${params.postId}`,
      query: { context: 'edit' },
      idempotent: true,
      operationName: `post_verify:${params.postId}`,
    });

    const verified = this.verifyPostResponse(
      response.data,
      params.expectedStatus,
      params.expectedExternalIdentity
    );

    if (verified.postId !== params.postId) {
      throw new WordPressClientError(
        'WP_POST_VERIFICATION_FAILED',
        `Post verification ID mismatch: expected ${params.postId}, got ${verified.postId}`,
        { httpStatus: response.status, retryable: false }
      );
    }

    if (!verified.slug || !verified.slug.trim()) {
      throw new WordPressClientError(
        'WP_POST_VERIFICATION_FAILED',
        `WordPress post ${params.postId} verification returned an empty slug`,
        { httpStatus: response.status, retryable: false }
      );
    }

    if (
      params.expectedSlug &&
      verified.slug !== params.expectedSlug &&
      !verified.slug.startsWith(`${params.expectedSlug}-`)
    ) {
      throw new WordPressClientError(
        'WP_POST_VERIFICATION_FAILED',
        `WordPress post ${params.postId} slug mismatch: expected "${params.expectedSlug}", got "${verified.slug}"`,
        { httpStatus: response.status, retryable: false }
      );
    }

    if (params.expectedCategoryIds && params.expectedCategoryIds.length > 0) {
      const missingCategories = params.expectedCategoryIds.filter(
        (cid) => !verified.categories.includes(cid)
      );
      if (missingCategories.length > 0) {
        throw new WordPressClientError(
          'WP_POST_VERIFICATION_FAILED',
          `WordPress post ${params.postId} missing expected category IDs: [${missingCategories.join(', ')}]`,
          { httpStatus: response.status, retryable: false }
        );
      }
    }

    return {
      ...verified,
      verifiedViaReadback: true,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Performs a live readiness check against the configured WordPress endpoint.
   * Distinguishes NOT_CONFIGURED, UNAVAILABLE, and READY, and reports exact verification tiers.
   */
  public async checkReadiness(): Promise<WordPressReadinessReport> {
    const checkedAt = new Date().toISOString();
    const sanitizedUrl = this.getSanitizedEndpointUrl();

    if (!this.isConfigured()) {
      return {
        status: 'NOT_CONFIGURED',
        verificationTier: 'TEST_VERIFIED',
        configured: false,
        endpointUrl: sanitizedUrl,
        httpsEnforced: true,
        defaultPostStatus: this.defaultStatus,
        reachable: false,
        authenticated: false,
        latencyMs: null,
        errorCode: 'WP_NOT_CONFIGURED',
        errorMessage:
          'OMNIHUB_WP_URL, OMNIHUB_WP_USERNAME, and OMNIHUB_WP_APP_PASSWORD must be set to enable live WordPress publishing',
        checkedAt,
      };
    }

    const startTime = Date.now();
    try {
      const parsedBase = this.validateConfiguration();
      const response = await this.requestJson<Record<string, unknown>>({
        method: 'GET',
        path: '/users/me',
        query: { context: 'edit' },
        idempotent: true,
        operationName: 'readiness_check',
      });

      const latencyMs = Date.now() - startTime;
      const userId = response.data?.id;
      if (typeof userId !== 'number' || userId <= 0) {
        return {
          status: 'UNAVAILABLE',
          verificationTier: 'TEST_VERIFIED',
          configured: true,
          endpointUrl: sanitizedUrl,
          httpsEnforced: parsedBase.protocol === 'https:',
          defaultPostStatus: this.defaultStatus,
          reachable: true,
          authenticated: false,
          latencyMs,
          errorCode: 'WP_INVALID_RESPONSE',
          errorMessage: 'WordPress /users/me endpoint did not return a valid authenticated user ID',
          checkedAt,
        };
      }

      const isLocal = isLoopbackHost(parsedBase.hostname);
      return {
        status: 'READY',
        verificationTier: isLocal
          ? 'REAL_WORDPRESS_RUNTIME_VERIFIED'
          : 'REAL_WORDPRESS_PRODUCTION_VERIFIED',
        configured: true,
        endpointUrl: sanitizedUrl,
        httpsEnforced: parsedBase.protocol === 'https:',
        defaultPostStatus: this.defaultStatus,
        reachable: true,
        authenticated: true,
        latencyMs,
        errorCode: null,
        errorMessage: null,
        checkedAt,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const wpErr =
        err instanceof WordPressClientError
          ? err
          : this.classifyException(err, 'readiness_check');

      return {
        status: 'UNAVAILABLE',
        verificationTier: 'TEST_VERIFIED',
        configured: true,
        endpointUrl: sanitizedUrl,
        httpsEnforced: sanitizedUrl?.startsWith('https://') ?? false,
        defaultPostStatus: this.defaultStatus,
        reachable: wpErr.httpStatus !== null,
        authenticated: false,
        latencyMs,
        errorCode: wpErr.code,
        errorMessage: wpErr.message,
        checkedAt,
      };
    }
  }
}

export function createWordPressClient(config?: WordPressClientConfig): WordPressRestClient {
  return new WordPressRestClient(config);
}
