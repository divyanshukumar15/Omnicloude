/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { URL } from 'node:url';
import type {
  ISourceAdapter,
  Jurisdiction,
  SourceHealthResult,
  SourceHealthCheckOptions,
  OfficialUrlValidationResult,
  SourceHealthState,
  AdapterDiscoveryPathMode,
  NoticeDetailStrategyEvaluation,
  DetailPageFollowResult,
} from './source-adapter.interface.ts';
import type {
  DiscoveredNotice,
  DiscoveredDocument,
  NormalizedDocument,
} from '../types.ts';
import type {
  DiscoveryExecutionResult,
  DiscoveredDocumentLink,
  NoticeCategory,
  NormalizedNotice,
  DiscoveryOptions,
  DiscoveryExecutionMetrics,
  DiscoveryEvidence,
  NetworkErrorClassification,
  RetryDiagnosticEntry,
  StructuredFetchDiagnostic,
} from '../discovery/types.ts';
import { classifyNetworkOrHttpError } from '../discovery/network-error-classifier.ts';
import {
  configureGlobalFetchDispatcher,
  resolveConnectionTimeoutMs,
} from '../discovery/http-dispatcher.ts';
import type { AdapterExecutionStatus } from '../../database/types.ts';
import { validateTargetUrl, SecurityViolationError } from '../../security/url-security.ts';
import {
  isOfficialDomain,
  classifyDomainTrust,
  getAllowedDomainsForSource,
} from '../discovery/official-domains.ts';
import {
  classifyNotice,
  classifyNoticeExplainable,
  extractAdvertisementNumber,
  classifyDocumentLink,
  classifyRecruitmentType,
  isRecruitmentRelated,
} from '../discovery/classifier.ts';
import { generateRecruitmentIdentity } from '../discovery/recruitment-identity.ts';
import { DiscoveryCache } from '../discovery/discovery-cache.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';

import { sourceEndpointRegistry } from '../discovery/endpoint-registry.ts';
import { getDiscoveryExecutor } from '../discovery/discovery-executor.ts';
import {
  type OfficialAcquisitionRunner,
  type RunnerMode,
  type RunnerKind,
  type AcquisitionExecutionOrigin,
  type AcquisitionRequest,
  type AcquisitionMethodType,
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
  validateRunnerResultSecurity,
} from '../discovery/acquisition-runner.ts';

export abstract class BaseSourceAdapter implements ISourceAdapter {
  abstract readonly sourceId: string;
  abstract readonly name: string;
  abstract readonly jurisdiction: Jurisdiction;
  abstract readonly baseUrl: string;

  readonly adapterVersion: string = '1.3.0';
  readonly defaultDiscoveryPath: AdapterDiscoveryPathMode = 'DIRECT_PDF';

  protected lastStatus: AdapterExecutionStatus = 'SUCCESS_NO_RELEVANT_NOTICES';
  protected lastSuccessfulDiscovery: string | null = null;
  protected lastAttemptedDiscovery: string | null = null;
  protected lastError: string | null = null;
  protected lastDiscoveredCount = 0;
  protected lastDurationMs = 0;

  get authorityName(): string {
    return this.name;
  }

  get officialDomains(): string[] {
    return getAllowedDomainsForSource(this.sourceId);
  }

  /**
   * Returns current execution status of this adapter.
   */
  getSourceStatus(): AdapterExecutionStatus {
    return this.lastStatus;
  }

  /**
   * Validates whether a target URL belongs to an official trusted government domain.
   */
  async validateOfficialUrl(url: string): Promise<OfficialUrlValidationResult> {
    try {
      const parsed = new URL(url);
      const trust = classifyDomainTrust(url, this.sourceId);
      return {
        url,
        canonicalUrl: parsed.origin + parsed.pathname,
        trustCategory: trust.category,
        isOfficial: trust.isOfficial,
        hostname: trust.domain,
        reason: trust.reason,
      };
    } catch (err) {
      return {
        url,
        canonicalUrl: url,
        trustCategory: 'UNKNOWN_DOMAIN',
        isOfficial: false,
        hostname: '',
        reason: (err as Error).message,
      };
    }
  }

  /**
   * Standardized SourceAdapter contract health check accessor.
   */
  async getSourceHealth(
    timeoutMs = 1500,
    options?: SourceHealthCheckOptions
  ): Promise<SourceHealthResult> {
    return this.healthCheck(timeoutMs, options);
  }

  /**
   * Runner-aware health verification check against the official portal.
   * Reports PASS, FAIL, or INCONCLUSIVE depending on network reachability.
   * NEVER marks verifiedLive: true unless an HTTP response is actually received.
   * When RUNNER_MODE=REMOTE (or an explicit remote runner is selected), NEVER falls back
   * to a direct local fetch().
   */
  async healthCheck(
    timeoutMs = 1500,
    options: SourceHealthCheckOptions = {}
  ): Promise<SourceHealthResult> {
    const checkedAt = new Date().toISOString();
    const startTime = Date.now();
    const effectiveRunnerMode: RunnerMode = resolveRunnerMode(options.runnerMode);
    const useRunnerPath =
      effectiveRunnerMode === 'REMOTE' ||
      Boolean(options.preferRemote) ||
      Boolean(options.acquisitionRunner) ||
      Boolean(options.remoteRunner) ||
      (effectiveRunnerMode === 'AUTO' && new HttpRemoteAcquisitionRunner().isConfigured());

    try {
      // 1. Official domain validation check (always enforced regardless of runner)
      const domainValidation = isOfficialDomain(this.baseUrl, this.sourceId);
      if (!domainValidation.allowed) {
        return {
          sourceId: this.sourceId,
          authorityName: this.name,
          jurisdiction: this.jurisdiction,
          baseUrl: this.baseUrl,
          officialDomains: this.officialDomains,
          status: 'UNHEALTHY',
          healthState: 'UNAVAILABLE',
          verifiedLive: false,
          testOutcome: 'FAIL',
          latencyMs: Date.now() - startTime,
          durationMs: Date.now() - startTime,
          message: `Official domain validation rejected: ${domainValidation.reason}`,
          checkedAt,
          lastAttemptedDiscovery: this.lastAttemptedDiscovery,
          lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
          adapterVersion: this.adapterVersion,
          runnerUsed: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'REMOTE' : 'LOCAL',
          executionTimestamp: checkedAt,
          finalUrl: null,
          contentType: null,
          contentLength: null,
        };
      }

      if (useRunnerPath) {
        // Runner-aware health probe: strictly respects RUNNER_MODE=REMOTE (no local fetch!)
        try {
          const res = await this.fetchWithRetry(this.baseUrl, {
            timeoutMs,
            maxRetries: 0,
            methodType: 'PROBE',
            runnerMode: effectiveRunnerMode,
            acquisitionRunner: options.acquisitionRunner,
            remoteRunner: options.remoteRunner,
            preferRemote: options.preferRemote,
          });
          const latencyMs = Date.now() - startTime;
          const parseResult = this.parseNotices(res.text, res.finalUrl || this.baseUrl);
          const healthState: SourceHealthState = parseResult.structureIntact
            ? 'UP'
            : 'STRUCTURE_CHANGED';
          const status: 'HEALTHY' | 'UNHEALTHY' = parseResult.structureIntact
            ? 'HEALTHY'
            : 'UNHEALTHY';
          const discoveredCount = parseResult.structureIntact ? parseResult.notices.length : 0;
          const outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = parseResult.structureIntact
            ? 'INCONCLUSIVE'
            : 'FAIL';
          const message = !parseResult.structureIntact
            ? `HTTP ${res.status} returned via ${res.runnerUsed || 'REMOTE'} runner but official portal structure changed`
            : discoveredCount > 0
              ? `Official source responded with HTTP ${res.status} via ${res.runnerUsed || 'REMOTE'} runner (${discoveredCount} notices found; awaiting E2E PDF verification)`
              : `Official source responded with HTTP ${res.status} via ${res.runnerUsed || 'REMOTE'} runner, 0 relevant notices found`;

          return {
            sourceId: this.sourceId,
            authorityName: this.name,
            jurisdiction: this.jurisdiction,
            baseUrl: this.baseUrl,
            officialDomains: this.officialDomains,
            status,
            healthState,
            verifiedLive: true,
            statusCode: res.status,
            httpStatus: res.status,
            latencyMs,
            durationMs: latencyMs,
            testOutcome: outcome,
            message,
            discoveredCount,
            checkedAt,
            lastAttemptedDiscovery: this.lastAttemptedDiscovery,
            lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
            adapterVersion: this.adapterVersion,
            runnerUsed: res.runnerUsed ?? 'REMOTE',
            executionOrigin: res.executionOrigin,
            workerId: res.workerId ?? null,
            executionTimestamp: res.executionTimestamp ?? checkedAt,
            finalUrl: res.finalUrl || this.baseUrl,
            contentType: res.contentType ?? null,
            contentLength: res.responseBytes ?? Buffer.byteLength(res.text, 'utf8'),
          };
        } catch (runnerErr) {
          const latencyMs = Date.now() - startTime;
          const details =
            runnerErr instanceof IngestionError &&
            typeof runnerErr.details === 'object' &&
            runnerErr.details !== null
              ? (runnerErr.details as Record<string, unknown>)
              : {};
          const httpStatus =
            typeof details.httpStatus === 'number'
              ? details.httpStatus
              : typeof details.status === 'number'
                ? details.status
                : null;
          const errMessage = (runnerErr as Error).message || String(runnerErr);
          const isConfigOrSecurity =
            details.errorCode === 'REMOTE_RUNNER_NOT_CONFIGURED' ||
            (runnerErr instanceof IngestionError && runnerErr.code === 'SSRF_BLOCKED');

          return {
            sourceId: this.sourceId,
            authorityName: this.name,
            jurisdiction: this.jurisdiction,
            baseUrl: this.baseUrl,
            officialDomains: this.officialDomains,
            status: isConfigOrSecurity ? 'UNHEALTHY' : 'UNVERIFIED',
            healthState: httpStatus === 401 || httpStatus === 403 ? 'BLOCKED' : 'UNAVAILABLE',
            verifiedLive: false,
            statusCode: httpStatus ?? undefined,
            httpStatus,
            testOutcome: isConfigOrSecurity ? 'FAIL' : 'INCONCLUSIVE',
            latencyMs,
            durationMs: latencyMs,
            message: `Remote runner health probe failed: ${errMessage}`,
            checkedAt,
            lastAttemptedDiscovery: this.lastAttemptedDiscovery,
            lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
            lastError: errMessage,
            adapterVersion: this.adapterVersion,
            runnerUsed:
              details.runnerUsed === 'LOCAL' || details.runnerUsed === 'REMOTE'
                ? (details.runnerUsed as RunnerKind)
                : 'REMOTE',
            executionOrigin:
              typeof details.executionOrigin === 'string'
                ? (details.executionOrigin as AcquisitionExecutionOrigin)
                : 'REAL_LIVE_REMOTE',
            workerId: typeof details.workerId === 'string' ? details.workerId : null,
            executionTimestamp: checkedAt,
            finalUrl: null,
            contentType: null,
            contentLength: null,
          };
        }
      }

      // 2. Local mode: SSRF and DNS verification check
      await validateTargetUrl(this.baseUrl);

      // 3. Perform local network probe with AbortController timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(this.baseUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        const latencyMs = Date.now() - startTime;
        let healthState: SourceHealthState = 'UP';
        let status: 'HEALTHY' | 'UNHEALTHY' = 'HEALTHY';
        let outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'INCONCLUSIVE';
        let message = `Official source responded with HTTP ${res.status}`;
        let discoveredCount = 0;
        let contentLength: number | null = null;
        const contentType = res.headers.get('content-type');

        if (res.ok) {
          const bodyText = await res.text();
          contentLength = Buffer.byteLength(bodyText, 'utf8');
          const parseResult = this.parseNotices(bodyText, this.baseUrl);
          if (!parseResult.structureIntact) {
            healthState = 'STRUCTURE_CHANGED';
            status = 'UNHEALTHY';
            outcome = 'FAIL';
            message = `HTTP ${res.status} returned but official portal structure changed or expected recruitment structure missing`;
          } else {
            healthState = 'UP';
            status = 'HEALTHY';
            discoveredCount = parseResult.notices.length;
            outcome = 'INCONCLUSIVE';
            message =
              discoveredCount > 0
                ? `Official source responded with HTTP ${res.status} and valid notice structure (${discoveredCount} notices found; awaiting E2E PDF verification)`
                : `Official source responded with HTTP ${res.status} and valid structure, but 0 relevant notices found`;
          }
        } else if (res.status === 429) {
          healthState = 'DEGRADED';
          status = 'UNHEALTHY';
          outcome = 'INCONCLUSIVE';
        } else if (res.status === 403 || res.status === 401) {
          healthState = 'BLOCKED';
          status = 'UNHEALTHY';
          outcome = 'FAIL';
        } else if (res.status >= 500) {
          healthState = 'UNAVAILABLE';
          status = 'UNHEALTHY';
          outcome = 'FAIL';
        } else {
          healthState = 'DEGRADED';
          status = 'UNHEALTHY';
          outcome = 'FAIL';
        }

        return {
          sourceId: this.sourceId,
          authorityName: this.name,
          jurisdiction: this.jurisdiction,
          baseUrl: this.baseUrl,
          officialDomains: this.officialDomains,
          status,
          healthState,
          verifiedLive: true,
          statusCode: res.status,
          httpStatus: res.status,
          latencyMs,
          durationMs: latencyMs,
          testOutcome: outcome,
          message,
          discoveredCount,
          checkedAt,
          lastAttemptedDiscovery: this.lastAttemptedDiscovery,
          lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
          adapterVersion: this.adapterVersion,
          runnerUsed: 'LOCAL',
          executionOrigin: 'REAL_LIVE_LOCAL',
          workerId: null,
          executionTimestamp: checkedAt,
          finalUrl: res.url || this.baseUrl,
          contentType,
          contentLength,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = (err as Error).message || String(err);

      logger.warn(`Source health check network probe failed for ${this.sourceId}`, {
        sourceId: this.sourceId,
        baseUrl: this.baseUrl,
        error: errorMessage,
      });

      return {
        sourceId: this.sourceId,
        authorityName: this.name,
        jurisdiction: this.jurisdiction,
        baseUrl: this.baseUrl,
        officialDomains: this.officialDomains,
        status: 'UNVERIFIED',
        healthState: 'UNAVAILABLE',
        verifiedLive: false,
        testOutcome: 'INCONCLUSIVE', // Sandbox environment network restriction
        latencyMs,
        durationMs: latencyMs,
        message: `Live access unverified: ${errorMessage}`,
        checkedAt,
        lastAttemptedDiscovery: this.lastAttemptedDiscovery,
        lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
        lastError: errorMessage,
        adapterVersion: this.adapterVersion,
        runnerUsed: 'LOCAL',
        executionOrigin: 'REAL_LIVE_LOCAL',
        workerId: null,
        executionTimestamp: checkedAt,
        finalUrl: null,
        contentType: null,
        contentLength: null,
      };
    }
  }

  /**
   * Determines whether an HTTP status code is retryable.
   * Only retry transient failures: 408, 429, 500, 502, 503, 504.
   * Non-transient (400, 401, 403, 404, SSRF) MUST NOT be retried.
   */
  protected isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  /**
   * Determines whether a network error is retryable by unwrapping nested causes
   * (including Node/Undici TypeError: fetch failed causes) and classifying the failure.
   */
  protected isRetryableError(err: Error): boolean {
    if (err instanceof IngestionError && err.code === 'SSRF_BLOCKED') {
      return false;
    }
    const diag = classifyNetworkOrHttpError({
      error: err,
      requestUrl: this.baseUrl,
      timeoutMs: 15000,
      attempt: 1,
      maxAttempts: 3,
    });
    return diag.retryable;
  }

  /**
   * Safely fetches HTML or JSON with bounded retries, exponential backoff, and domain security checks.
   * Retries ONLY transient network failures (5xx, 429, timeout, DNS temporary error, connection reset/refused).
   * Enforces:
   * - HTTPS (unless allowHttp is explicitly set)
   * - Official domain allowlist
   * - SSRF protection & manual redirect validation
   * - Bounded timeout & response-size limit
   * - Content-Type validation
   */
  private async executeListingOrDetailViaRunner(
    runner: OfficialAcquisitionRunner,
    targetUrl: string,
    options: {
      timeoutMs: number;
      connectionTimeoutMs: number;
      maxRetries: number;
      maxDownloadBytes: number;
      maxRedirectHops: number;
      allowHttp: boolean;
      methodType: AcquisitionMethodType;
      expectedContentType?: string;
      localAccess: string;
      selectionReason: string;
    }
  ): Promise<{
    status: number;
    text: string;
    finalUrl: string;
    attemptsUsed: number;
    retriesUsed: number;
    retryReasons: string[];
    retryDiagnostics: RetryDiagnosticEntry[];
    attemptDiagnostics: StructuredFetchDiagnostic[];
    contentType: string;
    redirectChain: string[];
    responseBytes: number;
    responseTimeMs: number;
    runnerUsed: RunnerKind;
    executionOrigin: AcquisitionExecutionOrigin;
    workerId: string | null;
    executionTimestamp: string;
    localAccess: string;
    remoteAccess: string;
    selectedRunner: RunnerKind;
    selectionReason: string;
  }> {
    const req: AcquisitionRequest = {
      sourceId: this.sourceId,
      endpoint: targetUrl,
      methodType: options.methodType,
      requestPolicy: {
        method: 'GET',
        maxDownloadBytes: options.maxDownloadBytes,
        maxRedirectHops: options.maxRedirectHops,
        expectedContentType: options.expectedContentType ?? 'text/html',
        responseType: 'TEXT',
        allowHttp: options.allowHttp,
      },
      timeoutPolicy: {
        timeoutMs: options.timeoutMs,
        connectionTimeoutMs: options.connectionTimeoutMs,
      },
      retryPolicy: {
        maxRetries: options.maxRetries,
        retryBackoffMs: 500,
      },
    };

    const rawRes = await runner.acquire(req);
    const res = await validateRunnerResultSecurity(req, rawRes, runner);

    const runnerKind: RunnerKind = res.runnerUsed ?? runner.runnerKind;
    const origin: AcquisitionExecutionOrigin =
      res.executionOrigin ??
      (runner.isMock
        ? 'MOCK_REMOTE'
        : runnerKind === 'REMOTE'
        ? 'REAL_LIVE_REMOTE'
        : 'REAL_LIVE_LOCAL');

    if (res.errorType || res.httpStatus === null || res.httpStatus < 200 || res.httpStatus >= 300) {
      const errorType: NetworkErrorClassification =
        (res.errorType as NetworkErrorClassification) ||
        (res.httpStatus === 401 || res.httpStatus === 403
          ? 'HTTP_403'
          : res.httpStatus === 404
          ? 'HTTP_404'
          : res.httpStatus === 429
          ? 'HTTP_429'
          : res.httpStatus && res.httpStatus >= 500
          ? 'HTTP_5XX'
          : res.httpStatus && res.httpStatus >= 400
          ? 'HTTP_4XX'
          : 'UNKNOWN_NETWORK_ERROR');

      const diag: StructuredFetchDiagnostic =
        res.attemptDiagnostics?.[res.attemptDiagnostics.length - 1] ?? {
          errorType,
          errorCode: res.errorCode || null,
          errorName: res.errorName || res.errorType || 'RunnerError',
          errorMessage:
            res.failureDetails || `Runner (${runnerKind}) failed for ${targetUrl}`,
          cause: null,
          requestUrl: targetUrl,
          hostname: (() => {
            try {
              return new URL(targetUrl).hostname;
            } catch {
              return '';
            }
          })(),
          httpStatus: res.httpStatus,
          timeoutMs: options.timeoutMs,
          connectionTimeoutMs: options.connectionTimeoutMs,
          attempt: res.attempts || 1,
          maxAttempts: options.maxRetries + 1,
          retryable: false,
          retryDelayMs: 0,
        };

      const remoteAccessStatus =
        runnerKind === 'REMOTE'
          ? res.remoteAccess && res.remoteAccess !== 'NOT_ATTEMPTED'
            ? res.remoteAccess
            : res.errorType || (res.httpStatus ? `HTTP_${res.httpStatus}` : 'REMOTE_FAILED')
          : 'NOT_ATTEMPTED';
      const localAccessStatus =
        runnerKind === 'LOCAL'
          ? res.localAccess && res.localAccess !== 'NOT_ATTEMPTED'
            ? res.localAccess
            : res.errorType || (res.httpStatus ? `HTTP_${res.httpStatus}` : 'LOCAL_FAILED')
          : options.localAccess;

      const isSsrfErr =
        errorType === 'SSRF_BLOCKED' ||
        errorType === 'DOMAIN_NOT_ALLOWED' ||
        res.errorCode === 'DOMAIN_NOT_ALLOWED';
      const errCode = isSsrfErr
        ? 'SSRF_BLOCKED'
        : res.httpStatus === 404 || errorType === 'HTTP_404'
        ? 'DOWNLOAD_FAILED'
        : 'SOURCE_UNAVAILABLE';

      if (res.httpStatus === 401 || res.httpStatus === 403) {
        this.lastStatus = 'ACCESS_BLOCKED';
      } else {
        this.lastStatus = 'SOURCE_UNAVAILABLE';
      }

      throw new IngestionError(
        `Failed to fetch from ${this.sourceId} [${diag.errorType}${diag.errorCode ? ` (${diag.errorCode})` : ''}: ${diag.errorMessage}]`,
        errCode,
        {
          url: targetUrl,
          status: res.httpStatus ?? undefined,
          httpStatus: res.httpStatus ?? null,
          timeoutMs: options.timeoutMs,
          connectionTimeoutMs: options.connectionTimeoutMs,
          attemptsUsed: res.attempts || 1,
          retriesUsed: res.retriesUsed || 0,
          retryReasons: res.retryReasons || [],
          retryDiagnostics: res.retryDiagnostics || [],
          attemptDiagnostics:
            res.attemptDiagnostics && res.attemptDiagnostics.length > 0
              ? res.attemptDiagnostics
              : [diag],
          lastDiagnostic: diag,
          errorType: diag.errorType,
          errorCode: diag.errorCode,
          errorName: diag.errorName,
          errorMessage: diag.errorMessage,
          cause: diag.cause,
          retryable: false,
          runnerUsed: runnerKind,
          executionOrigin: origin,
          localAccess: localAccessStatus,
          remoteAccess: remoteAccessStatus,
          selectedRunner: runnerKind,
          selectionReason: options.selectionReason,
        },
        false
      );
    }

    const contentTypeHeader = res.contentType;
    const cleanMime = contentTypeHeader
      ? contentTypeHeader.split(';')[0].trim().toLowerCase()
      : 'text/html';
    const allowedListingMimes = [
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/xml',
      'text/xml',
      'application/json',
    ];
    if (contentTypeHeader && !allowedListingMimes.includes(cleanMime)) {
      throw new IngestionError(
        `Unexpected Content-Type "${cleanMime}" from listing endpoint ${res.finalUrl || targetUrl}`,
        'EXTRACTION_FAILED',
        {
          contentType: cleanMime,
          attemptsUsed: res.attempts || 1,
          retriesUsed: res.retriesUsed || 0,
          retryReasons: res.retryReasons || [],
          retryDiagnostics: res.retryDiagnostics || [],
          attemptDiagnostics: res.attemptDiagnostics || [],
          runnerUsed: runnerKind,
          executionOrigin: origin,
          localAccess: runnerKind === 'LOCAL' ? 'SUCCESS' : options.localAccess,
          remoteAccess: runnerKind === 'REMOTE' ? 'SUCCESS' : 'NOT_ATTEMPTED',
          selectedRunner: runnerKind,
          selectionReason: options.selectionReason,
        },
        false
      );
    }

    const text = res.content ?? (res.binaryContent ? res.binaryContent.toString('utf8') : '');
    const responseBytes = res.responseBytes || Buffer.byteLength(text, 'utf8');
    if (responseBytes > options.maxDownloadBytes) {
      throw new IngestionError(
        `Listing response body exceeds limit (${options.maxDownloadBytes} bytes)`,
        'DOWNLOAD_FAILED',
        {
          maxDownloadBytes: options.maxDownloadBytes,
          attemptsUsed: res.attempts || 1,
          retriesUsed: res.retriesUsed || 0,
          retryReasons: res.retryReasons || [],
          retryDiagnostics: res.retryDiagnostics || [],
          attemptDiagnostics: res.attemptDiagnostics || [],
          runnerUsed: runnerKind,
          executionOrigin: origin,
          localAccess: runnerKind === 'LOCAL' ? 'SUCCESS' : options.localAccess,
          remoteAccess: runnerKind === 'REMOTE' ? 'SUCCESS' : 'NOT_ATTEMPTED',
          selectedRunner: runnerKind,
          selectionReason: options.selectionReason,
        },
        false
      );
    }

    return {
      status: res.httpStatus,
      text,
      finalUrl: res.finalUrl || targetUrl,
      attemptsUsed: res.attempts || 1,
      retriesUsed: res.retriesUsed || 0,
      retryReasons: res.retryReasons || [],
      retryDiagnostics: res.retryDiagnostics || [],
      attemptDiagnostics: res.attemptDiagnostics || [],
      contentType: cleanMime,
      redirectChain: res.redirectChain || [targetUrl],
      responseBytes,
      responseTimeMs: res.durationMs || 0,
      runnerUsed: runnerKind,
      executionOrigin: origin,
      workerId:
        res.remoteWorkerId ??
        res.runnerIdentity?.remoteWorkerId ??
        res.runnerIdentity?.runnerId ??
        null,
      executionTimestamp: res.timestamp || new Date().toISOString(),
      localAccess: runnerKind === 'LOCAL' ? 'SUCCESS' : options.localAccess,
      remoteAccess: runnerKind === 'REMOTE' ? 'SUCCESS' : 'NOT_ATTEMPTED',
      selectedRunner: runnerKind,
      selectionReason: options.selectionReason,
    };
  }

  public async fetchWithRetry(
    targetUrl: string,
    options: {
      timeoutMs?: number;
      connectionTimeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      maxDownloadBytes?: number;
      maxRedirectHops?: number;
      allowHttp?: boolean;
      expectedContentType?: string;
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
      methodType?: AcquisitionMethodType;
    } = {}
  ): Promise<{
    status: number;
    text: string;
    finalUrl: string;
    attemptsUsed: number;
    retriesUsed: number;
    retryReasons: string[];
    retryDiagnostics: RetryDiagnosticEntry[];
    attemptDiagnostics?: StructuredFetchDiagnostic[];
    contentType?: string;
    redirectChain?: string[];
    responseBytes?: number;
    responseTimeMs?: number;
    runnerUsed?: RunnerKind;
    executionOrigin?: AcquisitionExecutionOrigin;
    workerId?: string | null;
    executionTimestamp?: string;
    localAccess?: string;
    remoteAccess?: string;
    selectedRunner?: RunnerKind;
    selectionReason?: string;
  }> {
    const fetchStartedAt = Date.now();
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(Math.max(50, Math.floor(options.timeoutMs)), 30000)
        : 15000;
    const connectionTimeoutMs = resolveConnectionTimeoutMs(timeoutMs, options.connectionTimeoutMs);
    const maxRetries =
      options.maxRetries !== undefined &&
      Number.isFinite(options.maxRetries) &&
      Number.isInteger(options.maxRetries) &&
      options.maxRetries >= 0
        ? Math.min(Math.max(0, options.maxRetries), 3)
        : 2;
    const retryBackoffMs =
      options.retryBackoffMs !== undefined &&
      Number.isFinite(options.retryBackoffMs) &&
      options.retryBackoffMs > 0
        ? Math.min(Math.max(10, Math.floor(options.retryBackoffMs)), 5000)
        : 500;
    const maxAttempts = maxRetries + 1;
    const maxDownloadBytes = options.maxDownloadBytes ?? 10 * 1024 * 1024; // 10 MB listing HTML limit
    const maxRedirectHops = options.maxRedirectHops ?? 3;
    const allowHttp = options.allowHttp ?? false;
    const effectiveRunnerMode: RunnerMode = resolveRunnerMode(options.runnerMode);
    const methodType: AcquisitionMethodType = options.methodType ?? 'LISTING';
    const remoteRunner: OfficialAcquisitionRunner | null =
      options.acquisitionRunner ??
      options.remoteRunner ??
      (effectiveRunnerMode === 'REMOTE' || effectiveRunnerMode === 'AUTO' || options.preferRemote
        ? new HttpRemoteAcquisitionRunner()
        : null);

    // 1. Validate Official Domain before attempting network requests (Permanent failure: never retried)
    const domainCheck = isOfficialDomain(targetUrl, this.sourceId);
    if (!domainCheck.allowed) {
      const domainErr = new IngestionError(
        `Disallowed non-official domain for ${this.sourceId}: ${domainCheck.reason}`,
        'SSRF_BLOCKED',
        { errorCode: 'DOMAIN_NOT_ALLOWED' },
        false
      );
      const diag = classifyNetworkOrHttpError({
        error: domainErr,
        requestUrl: targetUrl,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts,
        retryDelayMs: 0,
      });
      throw new IngestionError(
        domainErr.message,
        'SSRF_BLOCKED',
        {
          url: targetUrl,
          timeoutMs,
          connectionTimeoutMs,
          attemptsUsed: 0,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [diag],
          lastDiagnostic: diag,
          errorType: diag.errorType,
          errorCode: diag.errorCode,
          errorName: diag.errorName,
          errorMessage: diag.errorMessage,
          cause: diag.cause,
          retryable: false,
          runnerUsed: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'REMOTE' : 'LOCAL',
          executionOrigin: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'REAL_LIVE_REMOTE' : 'REAL_LIVE_LOCAL',
          localAccess: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'NOT_ATTEMPTED' : 'DOMAIN_NOT_ALLOWED',
          remoteAccess: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'DOMAIN_NOT_ALLOWED' : 'NOT_ATTEMPTED',
          selectedRunner: effectiveRunnerMode === 'REMOTE' || options.preferRemote ? 'REMOTE' : 'LOCAL',
          selectionReason: 'Rejected by official domain allowlist before network dispatch',
        },
        false
      );
    }

    // 1b. Direct remote execution when RUNNER_MODE=REMOTE, preferRemote=true, or explicit acquisitionRunner provided (unless AUTO mode)
    if (
      effectiveRunnerMode === 'REMOTE' ||
      options.preferRemote ||
      (options.acquisitionRunner && effectiveRunnerMode !== 'AUTO')
    ) {
      if (!remoteRunner || !remoteRunner.isConfigured()) {
        const notConfiguredDiag: StructuredFetchDiagnostic = {
          errorType: 'NETWORK_UNAVAILABLE',
          errorCode: 'REMOTE_RUNNER_NOT_CONFIGURED',
          errorName: 'RemoteRunnerNotConfiguredError',
          errorMessage:
            'Remote acquisition runner is not configured (OFFICIAL_ACQUISITION_WORKER_URL / OMNIHUB_REMOTE_WORKER_URL missing)',
          cause: null,
          requestUrl: targetUrl,
          hostname: (() => {
            try {
              return new URL(targetUrl).hostname;
            } catch {
              return '';
            }
          })(),
          httpStatus: null,
          timeoutMs,
          connectionTimeoutMs,
          attempt: 1,
          maxAttempts: 1,
          retryable: false,
          retryDelayMs: 0,
          reason: 'NETWORK_UNAVAILABLE',
          statusCode: null,
          delayMs: 0,
        };
        this.lastStatus = 'SOURCE_UNAVAILABLE';
        throw new IngestionError(
          `Failed to fetch from ${this.sourceId} [NETWORK_UNAVAILABLE (REMOTE_RUNNER_NOT_CONFIGURED): ${notConfiguredDiag.errorMessage}]`,
          'SOURCE_UNAVAILABLE',
          {
            url: targetUrl,
            timeoutMs,
            connectionTimeoutMs,
            attemptsUsed: 0,
            retriesUsed: 0,
            retryReasons: [],
            retryDiagnostics: [],
            attemptDiagnostics: [notConfiguredDiag],
            lastDiagnostic: notConfiguredDiag,
            errorType: 'NETWORK_UNAVAILABLE',
            errorCode: 'REMOTE_RUNNER_NOT_CONFIGURED',
            errorName: notConfiguredDiag.errorName,
            errorMessage: notConfiguredDiag.errorMessage,
            cause: null,
            httpStatus: null,
            retryable: false,
            runnerUsed: 'REMOTE',
            executionOrigin: 'REAL_LIVE_REMOTE',
            localAccess: 'NOT_ATTEMPTED',
            remoteAccess: 'NOT_CONFIGURED',
            selectedRunner: 'REMOTE',
            selectionReason:
              'RUNNER_MODE=REMOTE requested, but remote acquisition worker is not configured',
          },
          false
        );
      }

      return this.executeListingOrDetailViaRunner(remoteRunner, targetUrl, {
        timeoutMs,
        connectionTimeoutMs,
        maxRetries,
        maxDownloadBytes,
        maxRedirectHops,
        allowHttp,
        methodType,
        expectedContentType: options.expectedContentType,
        localAccess: options.preferRemote ? 'FAILED_FALLBACK_TO_REMOTE' : 'NOT_ATTEMPTED',
        selectionReason: options.preferRemote
          ? 'Continuing on remote runner after earlier local transport failure'
          : effectiveRunnerMode === 'REMOTE'
          ? 'Remote runner selected (RUNNER_MODE=REMOTE)'
          : `Explicit acquisition runner (${remoteRunner.runnerKind}) selected`,
      });
    }

    // 1c. In RUNNER_MODE=AUTO, prefer REMOTE when configured and healthy; fall back to LOCAL when REMOTE is unavailable or fails
    let autoRemoteFailureAccess: string | null = null;
    if (effectiveRunnerMode === 'AUTO' && remoteRunner && remoteRunner.isConfigured()) {
      try {
        return await this.executeListingOrDetailViaRunner(remoteRunner, targetUrl, {
          timeoutMs,
          connectionTimeoutMs,
          maxRetries,
          maxDownloadBytes,
          maxRedirectHops,
          allowHttp,
          methodType,
          expectedContentType: options.expectedContentType,
          localAccess: 'NOT_ATTEMPTED',
          selectionReason: 'Remote runner preferred in RUNNER_MODE=AUTO (worker configured)',
        });
      } catch (remoteErr) {
        if (remoteErr instanceof IngestionError && remoteErr.code === 'SSRF_BLOCKED') {
          throw remoteErr;
        }
        const remDetails =
          remoteErr instanceof IngestionError &&
          typeof remoteErr.details === 'object' &&
          remoteErr.details !== null
            ? (remoteErr.details as Record<string, unknown>)
            : {};
        autoRemoteFailureAccess =
          (typeof remDetails.remoteAccess === 'string' && remDetails.remoteAccess) ||
          (typeof remDetails.errorType === 'string' && remDetails.errorType) ||
          'REMOTE_UNAVAILABLE';
      }
    }

    // Configure Undici Agent dispatcher with explicit connectionTimeoutMs so Node's default 10000ms connectTimeout is overridden
    const dispatcher = await configureGlobalFetchDispatcher(timeoutMs, connectionTimeoutMs);

    let attempt = 0;
    let attemptsUsed = 0;
    let lastError: Error | null = null;
    let lastDiagnostic: StructuredFetchDiagnostic | null = null;
    let retriesUsed = 0;
    const retryReasons: string[] = [];
    const retryDiagnostics: RetryDiagnosticEntry[] = [];
    const attemptDiagnostics: StructuredFetchDiagnostic[] = [];
    let lastRedirectChain: string[] = [targetUrl];

    while (attempt <= maxRetries) {
      attemptsUsed++;
      const currentAttemptNum = attempt + 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () =>
          controller.abort(
            Object.assign(new Error(`Request timeout after ${timeoutMs}ms`), {
              name: 'TimeoutError',
              code: 'ETIMEDOUT',
            })
          ),
        timeoutMs
      );

      try {
        let currentUrl = targetUrl;
        let hops = 0;
        let response: Response | null = null;
        const redirectChain: string[] = [targetUrl];
        lastRedirectChain = redirectChain;

        while (hops <= maxRedirectHops) {
          // Validate URL format, HTTPS protocol, and SSRF/DNS on every attempt & redirect hop
          await validateTargetUrl(currentUrl, { allowHttp });
          if (hops > 0) {
            const hopDomainCheck = isOfficialDomain(currentUrl, this.sourceId);
            if (!hopDomainCheck.allowed) {
              throw new IngestionError(
                `Redirected to unapproved domain: ${currentUrl}`,
                'SSRF_BLOCKED',
                {
                  url: currentUrl,
                  errorCode: 'DOMAIN_NOT_ALLOWED',
                  attemptsUsed,
                  retriesUsed,
                  retryReasons,
                  retryDiagnostics,
                  attemptDiagnostics,
                },
                false
              );
            }
          }

          logger.debug('source_request', {
            sourceId: this.sourceId,
            url: currentUrl,
            attempt: currentAttemptNum,
            maxAttempts,
            hop: hops,
          });

          const originReferer = (() => {
            try {
              return `${new URL(currentUrl).origin}/`;
            } catch {
              return undefined;
            }
          })();

          response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
              Accept: 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
              ...(originReferer ? { Referer: originReferer } : {}),
            },
          } as RequestInit);

          if ([301, 302, 303, 307, 308].includes(response.status)) {
            hops++;
            if (hops > maxRedirectHops) {
              throw new IngestionError(
                `Exceeded redirect limit of ${maxRedirectHops}`,
                'SSRF_BLOCKED',
                {
                  url: currentUrl,
                  attemptsUsed,
                  retriesUsed,
                  retryReasons,
                  retryDiagnostics,
                  attemptDiagnostics,
                },
                false
              );
            }
            const location = response.headers.get('location');
            if (!location) {
              throw new IngestionError(
                'Redirect response missing Location header',
                'DOWNLOAD_FAILED',
                {
                  url: currentUrl,
                  attemptsUsed,
                  retriesUsed,
                  retryReasons,
                  retryDiagnostics,
                  attemptDiagnostics,
                },
                false
              );
            }
            currentUrl = new URL(location, currentUrl).toString();
            redirectChain.push(currentUrl);
            continue;
          }

          break;
        }

        clearTimeout(timeoutId);

        if (!response) {
          throw new IngestionError('No HTTP response received', 'SOURCE_UNAVAILABLE');
        }

        const resolvedUrl = response.url || currentUrl;
        if (resolvedUrl !== targetUrl) {
          await validateTargetUrl(resolvedUrl, { allowHttp });
          const redirectDomainCheck = isOfficialDomain(resolvedUrl, this.sourceId);
          if (!redirectDomainCheck.allowed) {
            throw new IngestionError(
              `Redirected to unapproved domain: ${resolvedUrl}`,
              'SSRF_BLOCKED',
              {
                url: resolvedUrl,
                errorCode: 'DOMAIN_NOT_ALLOWED',
                attemptsUsed,
                retriesUsed,
                retryReasons,
                retryDiagnostics,
                attemptDiagnostics,
              },
              false
            );
          }
        }

        // Handle blocked access (401/403: permanent, non-retryable)
        if (response.status === 403 || response.status === 401) {
          this.lastStatus = 'ACCESS_BLOCKED';
          const diag = classifyNetworkOrHttpError({
            httpStatus: response.status,
            requestUrl: resolvedUrl,
            timeoutMs,
            attempt: currentAttemptNum,
            maxAttempts,
            retryDelayMs: 0,
          });
          diag.errorMessage = `Access blocked by official portal (HTTP ${response.status})`;
          attemptDiagnostics.push(diag);
          lastDiagnostic = diag;
          throw new IngestionError(
            `Access blocked by official portal (HTTP ${response.status})`,
            'SOURCE_UNAVAILABLE',
            {
              status: response.status,
              httpStatus: response.status,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
              lastDiagnostic: diag,
              errorType: diag.errorType,
              errorCode: diag.errorCode,
              errorName: diag.errorName,
              errorMessage: diag.errorMessage,
              cause: diag.cause,
              retryable: false,
            },
            false
          );
        }

        // Handle 404 (non-retryable)
        if (response.status === 404) {
          const diag = classifyNetworkOrHttpError({
            httpStatus: 404,
            requestUrl: resolvedUrl,
            timeoutMs,
            attempt: currentAttemptNum,
            maxAttempts,
            retryDelayMs: 0,
          });
          diag.errorMessage = `Official URL not found (HTTP 404): ${resolvedUrl}`;
          attemptDiagnostics.push(diag);
          lastDiagnostic = diag;
          throw new IngestionError(
            `Official URL not found (HTTP 404): ${resolvedUrl}`,
            'DOWNLOAD_FAILED',
            {
              status: 404,
              httpStatus: 404,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
              lastDiagnostic: diag,
              errorType: diag.errorType,
              errorCode: diag.errorCode,
              errorName: diag.errorName,
              errorMessage: diag.errorMessage,
              cause: diag.cause,
              retryable: false,
            },
            false
          );
        }

        // Transient server errors (500, 502, 503, 504) or rate limit (429) -> retry
        if (this.isRetryableStatus(response.status)) {
          const reason = `HTTP_${response.status}`;
          if (attempt < maxRetries) {
            const jitterMs = Math.floor(Math.random() * 100);
            const backoffMs = Math.min(retryBackoffMs * Math.pow(2, attempt) + jitterMs, 5000);
            const diag = classifyNetworkOrHttpError({
              httpStatus: response.status,
              requestUrl: resolvedUrl,
              timeoutMs,
              attempt: currentAttemptNum,
              maxAttempts,
              retryDelayMs: backoffMs,
            });
            diag.reason = reason;
            diag.errorMessage = `Official source returned transient HTTP ${response.status}`;
            retryReasons.push(reason);
            retryDiagnostics.push(diag);
            attemptDiagnostics.push(diag);
            lastDiagnostic = diag;
            attempt++;
            retriesUsed++;
            logger.warn(
              `${this.sourceId} Attempt ${currentAttemptNum}/${maxAttempts} ${diag.errorType} Retrying after ${backoffMs}ms`,
              {
                sourceId: this.sourceId,
                status: response.status,
                attempt: currentAttemptNum,
                maxAttempts,
                errorType: diag.errorType,
                errorCode: diag.errorCode,
                retryable: diag.retryable,
                retryDelayMs: backoffMs,
                reason,
                statusCode: response.status,
                delayMs: backoffMs,
              }
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          } else {
            const diag = classifyNetworkOrHttpError({
              httpStatus: response.status,
              requestUrl: resolvedUrl,
              timeoutMs,
              attempt: currentAttemptNum,
              maxAttempts,
              retryDelayMs: 0,
            });
            diag.reason = reason;
            diag.errorMessage = `Official source returned transient HTTP ${response.status} after ${maxRetries} retries`;
            attemptDiagnostics.push(diag);
            lastDiagnostic = diag;
            throw new IngestionError(
              `Official source returned transient HTTP ${response.status} after ${maxRetries} retries`,
              'SOURCE_UNAVAILABLE',
              {
                status: response.status,
                httpStatus: response.status,
                attemptsUsed,
                retriesUsed,
                retryReasons,
                retryDiagnostics,
                attemptDiagnostics,
                lastDiagnostic: diag,
                errorType: diag.errorType,
                errorCode: diag.errorCode,
                errorName: diag.errorName,
                errorMessage: diag.errorMessage,
                cause: diag.cause,
                retryable: true,
              },
              false
            );
          }
        }

        // Other non-2xx HTTP status codes (e.g. 400, 405) -> non-retryable
        if (!response.ok) {
          const diag = classifyNetworkOrHttpError({
            httpStatus: response.status,
            requestUrl: resolvedUrl,
            timeoutMs,
            attempt: currentAttemptNum,
            maxAttempts,
            retryDelayMs: 0,
          });
          diag.errorMessage = `Official URL returned HTTP ${response.status}: ${resolvedUrl}`;
          attemptDiagnostics.push(diag);
          lastDiagnostic = diag;
          throw new IngestionError(
            `Official URL returned HTTP ${response.status}: ${resolvedUrl}`,
            'DOWNLOAD_FAILED',
            {
              status: response.status,
              httpStatus: response.status,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
              lastDiagnostic: diag,
              errorType: diag.errorType,
              errorCode: diag.errorCode,
              errorName: diag.errorName,
              errorMessage: diag.errorMessage,
              cause: diag.cause,
              retryable: false,
            },
            false
          );
        }

        // Validate Content-Type header if present (non-retryable)
        const contentTypeHeader = response.headers.get('content-type');
        const cleanMime = contentTypeHeader ? contentTypeHeader.split(';')[0].trim().toLowerCase() : 'text/html';
        const allowedListingMimes = [
          'text/html',
          'application/xhtml+xml',
          'text/plain',
          'application/xml',
          'text/xml',
          'application/json',
        ];
        if (contentTypeHeader && !allowedListingMimes.includes(cleanMime)) {
          throw new IngestionError(
            `Unexpected Content-Type "${cleanMime}" from listing endpoint ${resolvedUrl}`,
            'EXTRACTION_FAILED',
            {
              contentType: cleanMime,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
            },
            false
          );
        }

        // Enforce response-size limit on Content-Length if declared (non-retryable)
        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
          const declaredBytes = parseInt(contentLengthHeader, 10);
          if (!isNaN(declaredBytes) && declaredBytes > maxDownloadBytes) {
            throw new IngestionError(
              `Listing response size (${declaredBytes} bytes) exceeds limit (${maxDownloadBytes} bytes)`,
              'DOWNLOAD_FAILED',
              {
                declaredBytes,
                maxDownloadBytes,
                attemptsUsed,
                retriesUsed,
                retryReasons,
                retryDiagnostics,
                attemptDiagnostics,
              },
              false
            );
          }
        }

        const text = await response.text();
        const responseBytes = Buffer.byteLength(text, 'utf8');
        if (responseBytes > maxDownloadBytes) {
          throw new IngestionError(
            `Listing response body exceeds limit (${maxDownloadBytes} bytes)`,
            'DOWNLOAD_FAILED',
            {
              maxDownloadBytes,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
            },
            false
          );
        }

        return {
          status: response.status,
          text,
          finalUrl: resolvedUrl,
          attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          contentType: cleanMime,
          redirectChain: lastRedirectChain,
          responseBytes,
          responseTimeMs: Date.now() - fetchStartedAt,
          runnerUsed: 'LOCAL',
          executionOrigin: 'REAL_LIVE_LOCAL',
          localAccess: 'SUCCESS',
          remoteAccess:
            autoRemoteFailureAccess !== null
              ? autoRemoteFailureAccess
              : remoteRunner?.isConfigured()
              ? 'NOT_ATTEMPTED'
              : effectiveRunnerMode === 'AUTO'
              ? 'NOT_CONFIGURED'
              : 'NOT_ATTEMPTED',
          selectedRunner: autoRemoteFailureAccess !== null ? 'REMOTE' : 'LOCAL',
          selectionReason:
            autoRemoteFailureAccess !== null
              ? `Remote runner failed (${autoRemoteFailureAccess}) in RUNNER_MODE=AUTO; fell back to LOCAL runner`
              : effectiveRunnerMode === 'AUTO'
              ? 'Remote runner not configured in RUNNER_MODE=AUTO; executed via LOCAL runner'
              : 'Local runner selected (RUNNER_MODE=LOCAL)',
        };
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err as Error;

        // If already classified above (e.g. HTTP 403/404/4xx/5xx exhausted or Content-Type/size error)
        if (err instanceof IngestionError && (!err.retryable || !err.isRetryable)) {
          const prevDetails =
            typeof err.details === 'object' && err.details !== null
              ? (err.details as Record<string, unknown>)
              : {};
          if (!prevDetails.lastDiagnostic) {
            const diag = classifyNetworkOrHttpError({
              error: err,
              httpStatus: typeof prevDetails.status === 'number' ? prevDetails.status : null,
              requestUrl: targetUrl,
              timeoutMs,
              attempt: currentAttemptNum,
              maxAttempts,
              retryDelayMs: 0,
            });
            attemptDiagnostics.push(diag);
            lastDiagnostic = diag;
            prevDetails.lastDiagnostic = diag;
            prevDetails.errorType = diag.errorType;
            prevDetails.errorCode = diag.errorCode;
            prevDetails.errorName = diag.errorName;
            prevDetails.errorMessage = diag.errorMessage;
            prevDetails.cause = diag.cause;
            prevDetails.retryable = diag.retryable;
          }
          throw new IngestionError(
            err.message,
            err.code,
            {
              ...prevDetails,
              attemptsUsed,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
            },
            err.isRetryable
          );
        }

        // Classify low-level network/DNS/TLS/SSRF error (including unwrapping TypeError: fetch failed .cause)
        const diag = classifyNetworkOrHttpError({
          error: lastError,
          requestUrl: targetUrl,
          timeoutMs,
          connectionTimeoutMs,
          attempt: currentAttemptNum,
          maxAttempts,
          retryDelayMs: 0,
        });
        lastDiagnostic = diag;

        // Permanent security / URL / TLS certificate errors must NOT be retried
        if (!diag.retryable) {
          attemptDiagnostics.push(diag);
          if (
            lastError instanceof SecurityViolationError &&
            diag.errorType !== 'DNS_ERROR'
          ) {
            throw Object.assign(lastError, {
              details: {
                attemptsUsed,
                retriesUsed,
                retryReasons,
                retryDiagnostics,
                attemptDiagnostics,
                lastDiagnostic: diag,
                errorType: diag.errorType,
                errorCode: diag.errorCode,
                errorName: diag.errorName,
                errorMessage: diag.errorMessage,
                cause: diag.cause,
                retryable: false,
              },
            });
          }
          break;
        }

        if (attempt < maxRetries) {
          const jitterMs = Math.floor(Math.random() * 100);
          const backoffMs = Math.min(retryBackoffMs * Math.pow(2, attempt) + jitterMs, 5000);
          diag.retryDelayMs = backoffMs;
          diag.delayMs = backoffMs;
          const reason = diag.errorType;
          diag.reason = reason;
          retryReasons.push(reason);
          retryDiagnostics.push(diag);
          attemptDiagnostics.push(diag);
          attempt++;
          retriesUsed++;
          logger.warn(
            `${this.sourceId} Attempt ${currentAttemptNum}/${maxAttempts} ${diag.errorType}${diag.errorCode ? ` (${diag.errorCode})` : ''} Retrying after ${backoffMs}ms`,
            {
              sourceId: this.sourceId,
              error: diag.errorMessage,
              cause: diag.cause,
              attempt: currentAttemptNum,
              maxAttempts,
              errorType: diag.errorType,
              errorCode: diag.errorCode,
              retryable: diag.retryable,
              retryDelayMs: backoffMs,
              reason,
              statusCode: null,
              delayMs: backoffMs,
            }
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          attemptDiagnostics.push(diag);
          logger.warn(
            `${this.sourceId} Attempt ${currentAttemptNum}/${maxAttempts} ${diag.errorType}${diag.errorCode ? ` (${diag.errorCode})` : ''} Final failure`,
            {
              sourceId: this.sourceId,
              error: diag.errorMessage,
              cause: diag.cause,
              attempt: currentAttemptNum,
              maxAttempts,
              errorType: diag.errorType,
              errorCode: diag.errorCode,
              retryable: diag.retryable,
              retryDelayMs: 0,
            }
          );
          break;
        }
      }
    }

    this.lastStatus = 'SOURCE_UNAVAILABLE';
    const isSsrf =
      lastDiagnostic?.errorType === 'SSRF_BLOCKED' ||
      lastDiagnostic?.errorType === 'DOMAIN_NOT_ALLOWED' ||
      (lastError instanceof SecurityViolationError &&
        lastError.code !== 'DNS_RESOLUTION_FAILED' &&
        lastError.code !== 'DNS_RESOLUTION_EMPTY') ||
      (lastError instanceof IngestionError && lastError.code === 'SSRF_BLOCKED');

    const localFailureStatus = lastDiagnostic?.errorType || 'LOCAL_FAILED';

    const descriptiveDetail = lastDiagnostic
      ? `${lastDiagnostic.errorType}${lastDiagnostic.errorCode ? ` (${lastDiagnostic.errorCode})` : ''}: ${lastDiagnostic.errorMessage}`
      : lastError?.message || 'Network failure';

    throw new IngestionError(
      `Failed to fetch from ${this.sourceId} [${descriptiveDetail}]`,
      isSsrf ? 'SSRF_BLOCKED' : 'SOURCE_UNAVAILABLE',
      {
        originalError: lastError?.message,
        timeoutMs,
        connectionTimeoutMs,
        attemptsUsed,
        retriesUsed,
        retryReasons,
        retryDiagnostics,
        attemptDiagnostics,
        lastDiagnostic,
        errorType: lastDiagnostic?.errorType ?? null,
        errorCode: lastDiagnostic?.errorCode ?? null,
        errorName: lastDiagnostic?.errorName ?? null,
        errorMessage: lastDiagnostic?.errorMessage ?? (lastError?.message || null),
        cause: lastDiagnostic?.cause ?? null,
        httpStatus: lastDiagnostic?.httpStatus ?? null,
        retryable: lastDiagnostic?.retryable ?? false,
        runnerUsed: 'LOCAL',
        executionOrigin: 'REAL_LIVE_LOCAL',
        localAccess: localFailureStatus,
        remoteAccess:
          autoRemoteFailureAccess !== null
            ? autoRemoteFailureAccess
            : effectiveRunnerMode === 'AUTO'
            ? remoteRunner?.isConfigured()
              ? 'NOT_ATTEMPTED'
              : 'NOT_CONFIGURED'
            : 'NOT_ATTEMPTED',
        selectedRunner: autoRemoteFailureAccess !== null ? 'REMOTE' : 'LOCAL',
        selectionReason:
          autoRemoteFailureAccess !== null
            ? `Remote runner failed (${autoRemoteFailureAccess}) and LOCAL fallback failed (${localFailureStatus}) in RUNNER_MODE=AUTO`
            : effectiveRunnerMode === 'AUTO'
            ? `Local runner failed with ${localFailureStatus}; remote runner not configured`
            : 'Local runner selected (RUNNER_MODE=LOCAL)',
      },
      false
    );
  }

  /**
   * Standard document link extraction from HTML.
   */
  extractDocumentLinks(htmlOrContent: string, pageUrl: string): DiscoveredDocumentLink[] {
    const links: DiscoveredDocumentLink[] = [];
    const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(?:["']([^"']+)["']|([^\s>"']+))[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    const seenUrls = new Set<string>();

    while ((match = linkRegex.exec(htmlOrContent)) !== null) {
      const rawHref = (match[1] ?? match[2] ?? '').trim().replace(/&amp;/gi, '&');
      const rawText = (match[3] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
        continue;
      }

      try {
        const absoluteUrl = new URL(rawHref, pageUrl).toString();
        if (seenUrls.has(absoluteUrl)) {
          continue; // Deduplicate repeated link
        }
        seenUrls.add(absoluteUrl);

        const domainCheck = isOfficialDomain(absoluteUrl, this.sourceId);
        if (!domainCheck.allowed) {
          logger.debug('document_rejected', {
            sourceId: this.sourceId,
            url: absoluteUrl,
            reason: domainCheck.reason,
          });
          continue; // Skip third-party or untrusted links
        }

        const category = this.classifyNotice(rawText);
        const docLink = classifyDocumentLink(absoluteUrl, rawText, category);
        links.push(docLink);

        logger.debug('document_discovered', {
          sourceId: this.sourceId,
          url: absoluteUrl,
          title: docLink.title,
          category: docLink.documentCategory,
          isPrimary: docLink.isPrimaryNotification,
        });
      } catch {
        // Skip malformed URL
      }
    }

    return links;
  }

  /**
   * Classify notice text into standard categories.
   */
  classifyNotice(title: string, context = ''): NoticeCategory {
    return classifyNotice(title, context);
  }

  /**
   * Resolves relative or absolute URL to canonical absolute URL.
   */
  resolveCanonicalUrl(relativeOrAbsolute: string): string {
    try {
      return new URL(relativeOrAbsolute, this.baseUrl).toString();
    } catch {
      throw new IngestionError(
        `Invalid URL: ${relativeOrAbsolute}`,
        'DOWNLOAD_FAILED'
      );
    }
  }

  protected extractDomain(urlStr: string): string {
    try {
      return new URL(urlStr).hostname;
    } catch {
      return this.sourceId;
    }
  }

  async normalizeDocument(doc: NormalizedDocument): Promise<NormalizedDocument> {
    return {
      ...doc,
      sourceId: this.sourceId,
      sourceDomain: this.extractDomain(this.baseUrl),
    };
  }

  /**
   * Discover documents attached to a notice.
   * Runner-aware: when a notice points to a detail HTML page (not a direct PDF) and runner
   * options or detailRequired metadata are present, resolves attached PDF links via
   * followDetailPageWithStatus using the configured runner (LOCAL | REMOTE | AUTO).
   */
  async discoverDocuments(
    notice: DiscoveredNotice,
    options?: DiscoveryOptions
  ): Promise<DiscoveredDocument[]> {
    if (!notice.noticeUrl) {
      throw new IngestionError('Notice contains no target URL', 'NO_NOTICE_FOUND');
    }
    const canonical = this.resolveCanonicalUrl(notice.noticeUrl);

    // 1. Check if structured listing metadata already carried verified official document links
    const metaDocs = Array.isArray(notice.rawMetadata?.documents)
      ? (notice.rawMetadata?.documents as Array<{
          url?: string;
          title?: string;
          documentType?: string;
          documentCategory?: string;
        }>)
      : [];
    const directMetaDocs = metaDocs.filter((d) => {
      if (!d?.url) return false;
      const lower = d.url.toLowerCase();
      return (
        d.documentType === 'PDF' ||
        d.documentType === 'DOC' ||
        lower.endsWith('.pdf') ||
        lower.includes('open_pdf.aspx') ||
        lower.includes('download_pdf.aspx') ||
        lower.includes('viewpdf.aspx')
      );
    });
    if (directMetaDocs.length > 0) {
      const now = new Date().toISOString();
      return directMetaDocs
        .filter((d) => d.url && isOfficialDomain(this.resolveCanonicalUrl(d.url), this.sourceId).allowed)
        .map((d, idx) => {
          const docUrl = this.resolveCanonicalUrl(d.url!);
          return {
            id: `doc-${notice.id}-${idx + 1}`,
            noticeId: notice.id,
            sourceId: this.sourceId,
            documentUrl: docUrl,
            canonicalUrl: docUrl,
            documentType: d.documentCategory || d.documentType || 'NOTIFICATION_PDF',
            title: d.title || notice.title,
            discoveredAt: now,
            sourceDomain: this.extractDomain(docUrl),
          };
        });
    }

    // 2. If notice URL is an HTML detail page and detail resolution is requested/required,
    // follow it through the runner-aware detail resolver.
    const lowerUrl = canonical.toLowerCase();
    const isDirectPdf =
      lowerUrl.endsWith('.pdf') ||
      lowerUrl.includes('open_pdf.aspx') ||
      lowerUrl.includes('download_pdf.aspx') ||
      lowerUrl.includes('viewpdf.aspx');
    const detailRequired = notice.rawMetadata?.detailRequired === true;
    const isLikelyDetailHtml =
      !isDirectPdf &&
      (detailRequired ||
        lowerUrl.endsWith('.html') ||
        lowerUrl.endsWith('.htm') ||
        lowerUrl.endsWith('.aspx') ||
        lowerUrl.endsWith('.php') ||
        lowerUrl.includes('/detail/') ||
        lowerUrl.includes('/notice/') ||
        lowerUrl.includes('/whats-new/'));

    if (
      isLikelyDetailHtml &&
      (detailRequired ||
        options?.acquisitionRunner ||
        options?.remoteRunner ||
        options?.runnerMode === 'REMOTE')
    ) {
      const detailRes = await this.followDetailPageWithStatus(canonical, {
        timeoutMs: options?.timeoutMs,
        connectionTimeoutMs: options?.connectionTimeoutMs,
        maxRetries: options?.maxRetries,
        retryBackoffMs: options?.retryBackoffMs,
        runnerMode: options?.runnerMode,
        acquisitionRunner: options?.acquisitionRunner,
        remoteRunner: options?.remoteRunner,
        strictLiveMode: options?.strictLiveMode,
      });

      if (!detailRes.pageFetched) {
        throw new IngestionError(
          detailRes.lastErrorMessage || `Failed to resolve detail page ${canonical}`,
          detailRes.lastErrorCode === 'DOMAIN_NOT_ALLOWED' ? 'SSRF_BLOCKED' : 'SOURCE_UNAVAILABLE',
          {
            detailUrl: canonical,
            runnerUsed: detailRes.runnerUsed,
            executionOrigin: detailRes.executionOrigin,
            errorType: detailRes.lastErrorType,
          },
          false
        );
      }

      const pdfDocs = detailRes.documents.filter((d) => {
        const u = d.url.toLowerCase();
        return (
          d.documentType === 'PDF' ||
          u.endsWith('.pdf') ||
          u.includes('open_pdf.aspx') ||
          u.includes('download_pdf.aspx') ||
          u.includes('viewpdf.aspx')
        );
      });

      if (pdfDocs.length > 0) {
        const now = new Date().toISOString();
        return pdfDocs.map((d, idx) => {
          const docUrl = this.resolveCanonicalUrl(d.url);
          return {
            id: `doc-${notice.id}-${idx + 1}`,
            noticeId: notice.id,
            sourceId: this.sourceId,
            documentUrl: docUrl,
            canonicalUrl: docUrl,
            documentType: d.documentCategory || 'NOTIFICATION_PDF',
            title: d.title || notice.title,
            discoveredAt: now,
            sourceDomain: this.extractDomain(docUrl),
          };
        });
      }
    }

    return [
      {
        id: `doc-${notice.id}`,
        noticeId: notice.id,
        sourceId: this.sourceId,
        documentUrl: canonical,
        canonicalUrl: canonical,
        documentType: 'NOTIFICATION_PDF',
        title: notice.title,
        discoveredAt: new Date().toISOString(),
        sourceDomain: this.extractDomain(canonical),
      },
    ];
  }

  /**
   * Discover notices matching common SourceAdapter contract.
   */
  async discoverNotices(options?: DiscoveryOptions): Promise<DiscoveredNotice[]> {
    const result = await this.executeDiscovery(options);

    return result.notices.map((n) => ({
      id: n.externalId,
      sourceId: n.sourceId,
      title: n.title,
      noticeUrl: n.rawNoticeUrl,
      category: n.category,
      notificationNumber: n.advertisementNumber || undefined,
      publishedAt: n.publishedDate || undefined,
      rawMetadata: n.metadata,
    }));
  }

  /**
   * Returns candidate listing endpoints in fallback priority order directly from SourceEndpointRegistry.
   * Ensures the endpoint registry is the authoritative source of discovery configuration.
   */
  getFallbackEndpoints(): string[] {
    const endpoints = sourceEndpointRegistry.getEndpointsForSource(this.sourceId);
    if (endpoints && endpoints.length > 0) {
      return endpoints.map((ep) => ep.url);
    }
    return [this.baseUrl];
  }

  /**
   * Generates URL for a specific page number. Concrete adapters can customize this.
   * Default: query parameter `?page=${pageNumber}`.
   */
  getPageUrl(pageNumber: number, baseUrl: string): string | null {
    if (pageNumber <= 1) return baseUrl;
    try {
      const u = new URL(baseUrl);
      u.searchParams.set('page', String(pageNumber));
      return u.toString();
    } catch {
      return null;
    }
  }

  /**
   * Discovers a "Next Page" link in HTML if present.
   */
  extractPaginationNextUrl(htmlContent: string, currentUrl: string): string | null {
    // 1. Check rel="next"
    const relNext = htmlContent.match(/<a\s+(?:[^>]*?\s+)?rel=["']next["'][^>]*?href=["']([^"']+)["']/i);
    if (relNext) {
      try {
        return new URL(relNext[1].trim(), currentUrl).toString();
      } catch {
        // continue
      }
    }

    // 2. Check class="next" or class="pagination-next"
    const classNext = htmlContent.match(/<a\s+(?:[^>]*?\s+)?class=["'][^"']*(?:next|pagination-next)[^"']*["'][^>]*?href=["']([^"']+)["']/i);
    if (classNext) {
      try {
        return new URL(classNext[1].trim(), currentUrl).toString();
      } catch {
        // continue
      }
    }

    // 3. Check link text matching "Next", "Next >>", "अगला"
    const textNext = htmlContent.match(/<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
    if (textNext) {
      for (const link of textNext) {
        const text = link.replace(/<[^>]+>/g, '').trim().toLowerCase();
        if (text === 'next' || text === 'next »' || text === 'next >' || text === 'अगला' || text === 'next page') {
          const hrefMatch = link.match(/href=["']([^"']+)["']/i);
          if (hrefMatch) {
            try {
              return new URL(hrefMatch[1].trim(), currentUrl).toString();
            } catch {
              // continue
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Shared source-adapter helper that explicitly derives whether a notice row discovered on a listing
   * page follows `LISTING_TO_DOCUMENT` (`detailRequired = false`) or `LISTING_TO_DETAIL_TO_DOCUMENT` (`detailRequired = true`).
   */
  protected deriveNoticeDetailRequirement(
    docLinks: DiscoveredDocumentLink[],
    rawNoticeUrl?: string
  ): {
    documentFlow: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
    detailRequired: boolean;
    detailResolved: boolean | null;
    detailUrl: string | null;
  } {
    const directDocs = (docLinks || []).filter((d) => {
      const lower = d.url.toLowerCase();
      return (
        d.documentType === 'PDF' ||
        d.documentType === 'DOC' ||
        lower.endsWith('.pdf') ||
        lower.includes('open_pdf.aspx') ||
        lower.includes('download_pdf.aspx') ||
        lower.includes('viewpdf.aspx')
      );
    });

    const htmlLinks = (docLinks || []).filter((d) => {
      const lower = d.url.toLowerCase();
      return (
        d.documentType !== 'PDF' &&
        d.documentType !== 'DOC' &&
        !lower.endsWith('.pdf') &&
        !lower.includes('open_pdf.aspx') &&
        !lower.includes('download_pdf.aspx') &&
        !lower.includes('viewpdf.aspx')
      );
    });

    const primaryUrl = rawNoticeUrl || docLinks[0]?.url || '';
    const lowerPrimary = primaryUrl.toLowerCase();
    const rawUrlIsHtml =
      Boolean(primaryUrl) &&
      !lowerPrimary.endsWith('.pdf') &&
      !lowerPrimary.includes('open_pdf.aspx') &&
      !lowerPrimary.includes('download_pdf.aspx') &&
      !lowerPrimary.includes('viewpdf.aspx') &&
      (lowerPrimary.endsWith('.html') ||
        lowerPrimary.endsWith('.htm') ||
        lowerPrimary.endsWith('.aspx') ||
        lowerPrimary.endsWith('.php') ||
        lowerPrimary.includes('.aspx?') ||
        lowerPrimary.includes('.php?') ||
        lowerPrimary.includes('/whats-new/') ||
        lowerPrimary.includes('/recruitment/') ||
        lowerPrimary.includes('/notice/') ||
        lowerPrimary.includes('/detail/') ||
        lowerPrimary.includes('/examinations/'));

    const detailUrl =
      htmlLinks.length > 0
        ? htmlLinks[0].url
        : rawUrlIsHtml
        ? primaryUrl
        : null;

    if (directDocs.length > 0) {
      return {
        documentFlow: 'LISTING_TO_DOCUMENT',
        detailRequired: false,
        detailResolved: null,
        detailUrl,
      };
    }

    if (detailUrl || this.defaultDiscoveryPath === 'DETAIL_PAGE') {
      return {
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        detailRequired: true,
        detailResolved: false,
        detailUrl: detailUrl || primaryUrl || null,
      };
    }

    return {
      documentFlow: 'LISTING_TO_DOCUMENT',
      detailRequired: false,
      detailResolved: null,
      detailUrl: null,
    };
  }

  /**
   * Determines whether a notice discovered on a listing page requires resolving a detail page
   * vs exposing official PDF documents directly from the listing page.
   *
   * Rules:
   * - If the listing row directly exposes one or more official PDF/DOC links (`directDocuments.length > 0`),
   *   then `detailRequired = false` and `documentFlow = 'LISTING_TO_DOCUMENT'` (even if an optional detail URL such as `View_Advt.aspx` is also present).
   * - If the listing row exposes NO direct PDF/DOC links and instead links to an HTML detail page,
   *   then `detailRequired = true` and `documentFlow = 'LISTING_TO_DETAIL_TO_DOCUMENT'`.
   */
  evaluateNoticeDetailStrategy(notice: NormalizedNotice): NoticeDetailStrategyEvaluation {
    const directDocuments = (notice.documents || []).filter((d) => {
      const lower = d.url.toLowerCase();
      return (
        d.documentType === 'PDF' ||
        d.documentType === 'DOC' ||
        lower.endsWith('.pdf') ||
        lower.includes('open_pdf.aspx') ||
        lower.includes('download_pdf.aspx') ||
        lower.includes('viewpdf.aspx')
      );
    });

    const htmlLinks = (notice.documents || []).filter((d) => {
      const lower = d.url.toLowerCase();
      return (
        d.documentType !== 'PDF' &&
        d.documentType !== 'DOC' &&
        !lower.endsWith('.pdf') &&
        !lower.includes('open_pdf.aspx') &&
        !lower.includes('download_pdf.aspx') &&
        !lower.includes('viewpdf.aspx')
      );
    });

    const lowerRawNoticeUrl = (notice.rawNoticeUrl || '').toLowerCase();
    const rawUrlIsHtml =
      Boolean(notice.rawNoticeUrl) &&
      !lowerRawNoticeUrl.endsWith('.pdf') &&
      !lowerRawNoticeUrl.includes('open_pdf.aspx') &&
      !lowerRawNoticeUrl.includes('download_pdf.aspx') &&
      !lowerRawNoticeUrl.includes('viewpdf.aspx') &&
      (lowerRawNoticeUrl.endsWith('.html') ||
        lowerRawNoticeUrl.endsWith('.htm') ||
        lowerRawNoticeUrl.endsWith('.aspx') ||
        lowerRawNoticeUrl.endsWith('.php') ||
        lowerRawNoticeUrl.includes('.aspx?') ||
        lowerRawNoticeUrl.includes('.php?') ||
        lowerRawNoticeUrl.includes('/whats-new/') ||
        lowerRawNoticeUrl.includes('/recruitment/') ||
        lowerRawNoticeUrl.includes('/notice/') ||
        lowerRawNoticeUrl.includes('/detail/') ||
        lowerRawNoticeUrl.includes('/examinations/'));

    const candidateDetailUrl =
      notice.detailUrl ||
      (htmlLinks.length > 0 ? htmlLinks[0].url : null) ||
      (rawUrlIsHtml ? notice.rawNoticeUrl : null);

    if (notice.detailRequired === true) {
      return {
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        detailRequired: true,
        detailUrl: candidateDetailUrl || notice.rawNoticeUrl || null,
        directDocuments: [],
      };
    }

    if (notice.detailRequired === false && directDocuments.length > 0) {
      return {
        documentFlow: 'LISTING_TO_DOCUMENT',
        detailRequired: false,
        detailUrl: candidateDetailUrl,
        directDocuments,
      };
    }

    if (directDocuments.length > 0) {
      return {
        documentFlow: 'LISTING_TO_DOCUMENT',
        detailRequired: false,
        detailUrl: candidateDetailUrl,
        directDocuments,
      };
    }

    if (candidateDetailUrl || this.defaultDiscoveryPath === 'DETAIL_PAGE') {
      return {
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        detailRequired: true,
        detailUrl: candidateDetailUrl || notice.rawNoticeUrl || null,
        directDocuments: [],
      };
    }

    return {
      documentFlow: 'LISTING_TO_DOCUMENT',
      detailRequired: false,
      detailUrl: null,
      directDocuments: [],
    };
  }

  /**
   * Follows official detail page and reports both whether the page HTTP fetch succeeded
   * and the extracted documents.
   */
  async followDetailPageWithStatus(
    detailUrl: string,
    options: {
      timeoutMs?: number;
      connectionTimeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      detailFixtures?: Record<string, string | null>;
      strictLiveMode?: boolean;
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
    } = {}
  ): Promise<DetailPageFollowResult> {
    try {
      const domainCheck = isOfficialDomain(detailUrl, this.sourceId);
      if (!domainCheck.allowed) {
        logger.warn('Detail page rejected: non-official domain', { sourceId: this.sourceId, detailUrl });
        return {
          pageFetched: false,
          documents: [],
          attemptsUsed: 0,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          lastErrorType: 'DOMAIN_NOT_ALLOWED',
          lastErrorCode: 'DOMAIN_NOT_ALLOWED',
          lastErrorMessage: `Disallowed non-official domain for ${this.sourceId}: ${domainCheck.reason}`,
        };
      }

      let html = '';
      let attemptsUsed = 1;
      let retriesUsed = 0;
      let retryReasons: string[] = [];
      let retryDiagnostics: DetailPageFollowResult['retryDiagnostics'] = [];
      let attemptDiagnostics: DetailPageFollowResult['attemptDiagnostics'] = [];
      let runnerUsed: RunnerKind | undefined = undefined;
      let executionOrigin: AcquisitionExecutionOrigin | undefined = undefined;
      let localAccess: string | undefined = undefined;
      let remoteAccess: string | undefined = undefined;
      let selectedRunner: RunnerKind | undefined = undefined;
      let selectionReason: string | undefined = undefined;

      if (
        !options.strictLiveMode &&
        options.detailFixtures &&
        detailUrl in options.detailFixtures
      ) {
        await validateTargetUrl(detailUrl);
        const fixtureVal = options.detailFixtures[detailUrl];
        if (fixtureVal === null) {
          logger.warn('Detail page fixture simulated unreachable/failed resolution', {
            sourceId: this.sourceId,
            detailUrl,
          });
          return {
            pageFetched: false,
            documents: [],
            attemptsUsed: 1,
            retriesUsed: 0,
            retryReasons: [],
            retryDiagnostics: [],
            attemptDiagnostics: [],
            executionOrigin: 'FIXTURE',
          };
        }
        html = fixtureVal;
        executionOrigin = 'FIXTURE';
      } else {
        const res = await this.fetchWithRetry(detailUrl, {
          timeoutMs: options.timeoutMs ?? 15000,
          connectionTimeoutMs: options.connectionTimeoutMs,
          maxRetries: options.maxRetries ?? 2,
          retryBackoffMs: options.retryBackoffMs ?? 500,
          runnerMode: options.runnerMode,
          acquisitionRunner: options.acquisitionRunner,
          remoteRunner: options.remoteRunner,
          preferRemote: options.preferRemote,
          methodType: 'DETAIL',
        });
        html = res.text;
        attemptsUsed = res.attemptsUsed;
        retriesUsed = res.retriesUsed;
        retryReasons = res.retryReasons;
        retryDiagnostics = res.retryDiagnostics;
        attemptDiagnostics = res.attemptDiagnostics ?? [];
        runnerUsed = res.runnerUsed;
        executionOrigin = res.executionOrigin;
        localAccess = res.localAccess;
        remoteAccess = res.remoteAccess;
        selectedRunner = res.selectedRunner;
        selectionReason = res.selectionReason;
      }

      logger.info('DETAIL_PAGE_FETCHED', {
        sourceId: this.sourceId,
        detailUrl,
      });

      const links = this.extractDocumentLinks(html, detailUrl);
      const sorted = links.sort((a, b) => {
        if (a.isPrimaryNotification && !b.isPrimaryNotification) return -1;
        if (!a.isPrimaryNotification && b.isPrimaryNotification) return 1;
        return 0;
      });

      return {
        pageFetched: true,
        documents: sorted,
        attemptsUsed,
        retriesUsed,
        retryReasons,
        retryDiagnostics,
        attemptDiagnostics,
        lastErrorType: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        runnerUsed,
        executionOrigin,
        localAccess,
        remoteAccess,
        selectedRunner,
        selectionReason,
      };
    } catch (err) {
      const details = (err as IngestionError)?.details as
        | {
            attemptsUsed?: number;
            retriesUsed?: number;
            retryReasons?: string[];
            retryDiagnostics?: DetailPageFollowResult['retryDiagnostics'];
            attemptDiagnostics?: DetailPageFollowResult['attemptDiagnostics'];
            errorType?: NetworkErrorClassification | null;
            errorCode?: string | null;
            errorMessage?: string | null;
            runnerUsed?: RunnerKind;
            executionOrigin?: AcquisitionExecutionOrigin;
            localAccess?: string;
            remoteAccess?: string;
            selectedRunner?: RunnerKind;
            selectionReason?: string;
          }
        | undefined;
      logger.warn('Failed to follow detail page', {
        sourceId: this.sourceId,
        detailUrl,
        error: (err as Error).message,
      });
      return {
        pageFetched: false,
        documents: [],
        attemptsUsed: details?.attemptsUsed ?? 1,
        retriesUsed: details?.retriesUsed ?? 0,
        retryReasons: details?.retryReasons ?? [],
        retryDiagnostics: details?.retryDiagnostics ?? [],
        attemptDiagnostics: details?.attemptDiagnostics ?? [],
        lastErrorType: details?.errorType ?? null,
        lastErrorCode: details?.errorCode ?? null,
        lastErrorMessage: details?.errorMessage ?? (err as Error).message,
        runnerUsed: details?.runnerUsed,
        executionOrigin: details?.executionOrigin,
        localAccess: details?.localAccess,
        remoteAccess: details?.remoteAccess,
        selectedRunner: details?.selectedRunner,
        selectionReason: details?.selectionReason,
      };
    }
  }

  /**
   * Follows official detail page when a notice links to an HTML detail page rather than a PDF.
   * Extracts official PDF links and metadata directly from the detail page.
   */
  async followDetailPage(
    detailUrl: string,
    options: {
      timeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      detailFixtures?: Record<string, string | null>;
      strictLiveMode?: boolean;
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
    } = {}
  ): Promise<DiscoveredDocumentLink[]> {
    const res = await this.followDetailPageWithStatus(detailUrl, options);
    return res.documents;
  }

  /**
   * Abstract parser that concrete adapters implement to parse HTML / JSON from official notice boards.
   */
  abstract parseNotices(htmlContent: string, currentUrl: string): {
    notices: NormalizedNotice[];
    structureIntact: boolean;
    detailRequired?: boolean;
    documentFlow?: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
  };

  /**
   * Executes discovery pipeline by delegating to the unified registry-driven DiscoveryExecutor.
   */
  async executeDiscovery(options: DiscoveryOptions = {}): Promise<DiscoveryExecutionResult> {
    this.lastAttemptedDiscovery = new Date().toISOString();
    const executor = getDiscoveryExecutor();
    const result = await executor.execute(this.sourceId, options);
    this.lastStatus = result.status;
    if (
      result.status === 'PASS' ||
      result.status === 'SUCCESS_WITH_VALID_DOCUMENT' ||
      result.status === 'SUCCESS_WITH_NOTICES'
    ) {
      this.lastSuccessfulDiscovery = result.completedAt;
    } else if (result.errorMessage) {
      this.lastError = result.errorMessage;
    }
    this.lastDiscoveredCount = result.recordsFound;
    this.lastDurationMs = result.metrics.durationMs;
    return result;
  }
}
