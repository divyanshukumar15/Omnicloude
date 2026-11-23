/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { URL } from 'node:url';
import { validateTargetUrl, SecurityViolationError } from '../../security/url-security.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';
import {
  classifyNetworkOrHttpError,
  type NetworkErrorClassification,
  type StructuredFetchDiagnostic,
} from '../discovery/network-error-classifier.ts';
import {
  configureGlobalFetchDispatcher,
  resolveConnectionTimeoutMs,
} from '../discovery/http-dispatcher.ts';
import type { RetryDiagnosticEntry } from '../discovery/types.ts';
import {
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
  validateRunnerResultSecurity,
  type AcquisitionExecutionOrigin,
  type OfficialAcquisitionRunner,
  type RunnerAccessOutcome,
  type RunnerKind,
  type RunnerMode,
} from '../discovery/acquisition-runner.ts';

export interface DownloaderConfig {
  maxDownloadBytes?: number;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRedirectHops?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  sourceId?: string;
  allowedOfficialDomains?: string[];
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  preferRemote?: boolean;
  headers?: Record<string, string>;
}

export interface DownloadedDocumentPayload {
  sourceUrl: string;
  canonicalUrl: string;
  sourceDomain: string;
  buffer: Buffer;
  byteLength: number;
  mimeType: string;
  downloadedAt: string;
  attemptsUsed: number;
  retriesUsed: number;
  retryReasons: string[];
  retryDiagnostics: RetryDiagnosticEntry[];
  attemptDiagnostics?: StructuredFetchDiagnostic[];
  runner?: RunnerKind;
  runnerUsed?: RunnerKind;
  workerId?: string | null;
  executionTimestamp?: string;
  httpStatus?: number | null;
  finalUrl?: string;
  contentType?: string;
  contentLength?: number;
  checksumSha256?: string;
  executionOrigin?: AcquisitionExecutionOrigin;
  localAccess?: RunnerAccessOutcome | string;
  remoteAccess?: RunnerAccessOutcome | string;
  selectedRunner?: RunnerKind;
  selectionReason?: string;
}

export class DocumentDownloader {
  private maxBytes: number;
  private timeoutMs: number;
  private maxRedirects: number;
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(config: DownloaderConfig = {}) {
    this.maxBytes = config.maxDownloadBytes ?? 26214400; // 25 MB
    this.timeoutMs = config.requestTimeoutMs ?? 15000;
    this.maxRedirects = config.maxRedirectHops ?? 3;
    this.maxRetries = config.maxRetries ?? 2;
    this.baseDelayMs = config.baseRetryDelayMs ?? 500;
  }

  /**
   * Verifies if a buffer begins with the standard PDF magic bytes: %PDF-
   */
  public static hasPdfMagicBytes(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 5) return false;
    // %PDF- is 0x25 0x50 0x44 0x46 0x2D
    return (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d
    );
  }

  /**
   * Detects HTML payload masquerading as PDF or error landing pages.
   */
  public static isHtmlDisguised(buffer: Buffer): boolean {
    if (!buffer || buffer.length === 0) return false;
    const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf-8').trim().toLowerCase();
    return (
      prefix.startsWith('<!doctype html') ||
      prefix.startsWith('<html') ||
      prefix.startsWith('<?xml') ||
      prefix.includes('<head>') ||
      prefix.includes('<body>')
    );
  }

  /**
   * Centralized validation and payload construction for bytes acquired via an OfficialAcquisitionRunner.
   * Ensures remote/custom runners NEVER bypass empty-check, HTML-disguise check, or PDF magic-byte validation.
   */
  private validateRunnerAcquiredPdf(
    rawUrl: string,
    canonicalUrl: string,
    buffer: Buffer,
    mimeType: string,
    attemptsUsed: number,
    retriesUsed: number,
    retryReasons: string[],
    retryDiagnostics: RetryDiagnosticEntry[],
    attemptDiagnostics: StructuredFetchDiagnostic[],
    runnerUsed: RunnerKind,
    executionOrigin: AcquisitionExecutionOrigin,
    localAccess?: RunnerAccessOutcome,
    remoteAccess?: RunnerAccessOutcome
  ): DownloadedDocumentPayload {
    if (buffer.length > this.maxBytes) {
      throw new IngestionError(
        `Downloaded payload exceeded size limit of ${this.maxBytes} bytes`,
        'DOWNLOAD_FAILED',
        {
          total: buffer.length,
          max: this.maxBytes,
          attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          runnerUsed,
          executionOrigin,
        },
        false
      );
    }

    if (buffer.length === 0) {
      throw new IngestionError(
        'Downloaded document is 0 bytes (empty response)',
        'NOT_PDF',
        {
          attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          runnerUsed,
          executionOrigin,
        },
        false
      );
    }

    if (DocumentDownloader.isHtmlDisguised(buffer)) {
      throw new IngestionError(
        'Downloaded file contains HTML markup instead of binary PDF',
        'NOT_PDF',
        {
          snippet: buffer.subarray(0, 120).toString('utf-8'),
          attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          runnerUsed,
          executionOrigin,
        },
        false
      );
    }

    if (!DocumentDownloader.hasPdfMagicBytes(buffer)) {
      throw new IngestionError(
        'File lacks valid PDF magic-byte header (%PDF-)',
        'NOT_PDF',
        {
          headerHex: buffer.subarray(0, 8).toString('hex'),
          attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          runnerUsed,
          executionOrigin,
        },
        false
      );
    }

    const parsedUrl = new URL(canonicalUrl);
    return {
      sourceUrl: rawUrl,
      canonicalUrl,
      sourceDomain: parsedUrl.hostname,
      buffer,
      byteLength: buffer.length,
      mimeType: mimeType || 'application/pdf',
      downloadedAt: new Date().toISOString(),
      attemptsUsed,
      retriesUsed,
      retryReasons,
      retryDiagnostics,
      attemptDiagnostics,
      runnerUsed,
      executionOrigin,
      localAccess,
      remoteAccess,
    };
  }

  private async executeViaRunner(
    runner: OfficialAcquisitionRunner,
    rawUrl: string,
    sourceId: string,
    timeoutMs: number,
    connectionTimeoutMs: number,
    maxRetries: number,
    retryBackoffMs: number,
    headers?: Record<string, string>
  ): Promise<DownloadedDocumentPayload> {
    const req = {
      sourceId,
      endpoint: rawUrl,
      methodType: 'DOCUMENT_PDF' as const,
      requestPolicy: {
        method: 'GET' as const,
        maxDownloadBytes: this.maxBytes,
        maxRedirectHops: this.maxRedirects,
        responseType: 'BINARY' as const,
        allowHttp: false,
        ...(headers ? { headers } : {}),
      },
      timeoutPolicy: {
        timeoutMs,
        connectionTimeoutMs,
      },
      retryPolicy: {
        maxRetries,
        retryBackoffMs,
      },
    };

    const rawRes = await runner.acquire(req);
    const res = await validateRunnerResultSecurity(req, rawRes, runner);
    const workerId =
      res.remoteWorkerId ??
      res.runnerIdentity?.remoteWorkerId ??
      res.runnerIdentity?.runnerId ??
      null;
    const executionTimestamp = res.timestamp || new Date().toISOString();

    if (res.errorType || !res.httpStatus || res.httpStatus < 200 || res.httpStatus >= 400) {
      const code =
        res.errorType === 'SSRF_BLOCKED' || res.errorType === 'DOMAIN_NOT_ALLOWED'
          ? 'SSRF_BLOCKED'
          : res.errorCode === 'INVALID_PDF' || res.failureClass === 'INVALID_PDF'
          ? 'NOT_PDF'
          : res.errorType === 'TIMEOUT'
          ? 'TIMEOUT'
          : res.httpStatus === 404
          ? 'NO_NOTICE_FOUND'
          : 'DOWNLOAD_FAILED';
      const lastDiag = res.attemptDiagnostics?.[res.attemptDiagnostics.length - 1] ?? null;
      throw new IngestionError(
        res.failureDetails || `Document download failed via ${runner.runnerKind} runner`,
        code,
        {
          url: rawUrl,
          status: res.httpStatus,
          httpStatus: res.httpStatus,
          attemptsUsed: res.attempts || 1,
          retriesUsed: res.retriesUsed || 0,
          retryReasons: res.retryReasons || [],
          retryDiagnostics: res.retryDiagnostics || [],
          attemptDiagnostics: res.attemptDiagnostics || [],
          lastDiagnostic: lastDiag,
          errorType: res.errorType,
          errorCode: res.errorCode,
          errorName: res.errorName,
          errorMessage: res.failureDetails,
          retryable: false,
          runner: res.runnerUsed,
          runnerUsed: res.runnerUsed,
          workerId,
          executionTimestamp,
          executionOrigin: res.executionOrigin,
          localAccess: res.localAccess,
          remoteAccess: res.remoteAccess,
          selectedRunner: res.selectedRunner || res.runnerUsed,
          selectionReason: res.selectionReason,
        },
        false
      );
    }

    const buf =
      res.binaryContent ??
      (res.content !== null && res.content !== undefined
        ? Buffer.from(res.content, 'binary')
        : Buffer.alloc(0));

    // Verify local computed SHA-256 against worker-reported checksum if provided
    const computedSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (
      typeof res.sha256 === 'string' &&
      res.sha256.trim().length > 0 &&
      res.sha256.trim().toLowerCase() !== computedSha256
    ) {
      throw new IngestionError(
        `Remote document checksum mismatch: worker reported ${res.sha256}, computed ${computedSha256}`,
        'CORRUPT_PDF',
        {
          url: rawUrl,
          expectedSha256: res.sha256,
          actualSha256: computedSha256,
          runner: res.runnerUsed,
          runnerUsed: res.runnerUsed,
          workerId,
          executionTimestamp,
        },
        false
      );
    }

    // Always validate remotely downloaded PDF locally (size, non-empty, non-HTML, %PDF- magic bytes)
    const payload = this.validateRunnerAcquiredPdf(
      rawUrl,
      res.finalUrl || rawUrl,
      buf,
      res.contentType || 'application/pdf',
      res.attempts || 1,
      res.retriesUsed || 0,
      res.retryReasons || [],
      res.retryDiagnostics || [],
      res.attemptDiagnostics || [],
      res.runnerUsed,
      res.executionOrigin,
      res.localAccess,
      res.remoteAccess
    );
    return {
      ...payload,
      runner: res.runnerUsed,
      workerId,
      executionTimestamp,
      httpStatus: res.httpStatus,
      finalUrl: res.finalUrl || rawUrl,
      contentType: res.contentType || 'application/pdf',
      contentLength: buf.length,
      checksumSha256: computedSha256,
      selectedRunner: res.selectedRunner || res.runnerUsed,
      selectionReason: res.selectionReason,
    };
  }

  /**
   * Downloads an official document with SSRF protection, redirect verification,
   * size limiting, and exponential backoff.
   * Retries ONLY transient failures (timeout, network error, 429, 5xx).
   * Never retries permanent failures (401/403, 404, invalid PDF, HTML disguised, SSRF block).
   */
  async download(rawUrl: string, overrideConfig: DownloaderConfig = {}): Promise<DownloadedDocumentPayload> {
    let lastError: unknown = null;
    let lastDiagnostic: StructuredFetchDiagnostic | null = null;
    const effectiveMaxAttempts = Math.min(
      Math.max(1, overrideConfig.maxRetries ?? this.maxRetries + 1),
      4
    );
    const effectiveTimeoutMs = Math.min(
      Math.max(50, overrideConfig.requestTimeoutMs ?? this.timeoutMs),
      30000
    );
    const effectiveConnectionTimeoutMs = resolveConnectionTimeoutMs(
      effectiveTimeoutMs,
      overrideConfig.connectionTimeoutMs
    );
    const effectiveBaseDelayMs = Math.min(
      Math.max(10, overrideConfig.baseRetryDelayMs ?? this.baseDelayMs),
      5000
    );

    const effectiveRunnerMode: RunnerMode = resolveRunnerMode(overrideConfig.runnerMode);
    const resolvedSourceId = overrideConfig.sourceId || '';

    const directRunner =
      (overrideConfig.acquisitionRunner && effectiveRunnerMode !== 'AUTO'
        ? overrideConfig.acquisitionRunner
        : undefined) ||
      ((effectiveRunnerMode === 'REMOTE' || overrideConfig.preferRemote)
        ? overrideConfig.remoteRunner ?? new HttpRemoteAcquisitionRunner()
        : undefined);

    if (effectiveRunnerMode === 'REMOTE' || overrideConfig.preferRemote) {
      if (!directRunner || !directRunner.isConfigured()) {
        throw new IngestionError(
          'Remote acquisition runner is not configured for RUNNER_MODE=REMOTE (OFFICIAL_ACQUISITION_WORKER_URL / OMNIHUB_REMOTE_WORKER_URL missing)',
          'SOURCE_UNAVAILABLE',
          {
            url: rawUrl,
            runner: 'REMOTE',
            runnerUsed: 'REMOTE',
            remoteAccess: 'NOT_CONFIGURED',
            localAccess: 'NOT_ATTEMPTED',
          },
          false
        );
      }
      return this.executeViaRunner(
        directRunner,
        rawUrl,
        resolvedSourceId || 'UNKNOWN_SOURCE',
        effectiveTimeoutMs,
        effectiveConnectionTimeoutMs,
        Math.max(0, effectiveMaxAttempts - 1),
        effectiveBaseDelayMs,
        overrideConfig.headers
      );
    }

    if (directRunner && resolvedSourceId) {
      return this.executeViaRunner(
        directRunner,
        rawUrl,
        resolvedSourceId,
        effectiveTimeoutMs,
        effectiveConnectionTimeoutMs,
        Math.max(0, effectiveMaxAttempts - 1),
        effectiveBaseDelayMs,
        overrideConfig.headers
      );
    }

    let autoRemoteFailureAccess: string | null = null;
    const autoCandidateRunner =
      overrideConfig.acquisitionRunner ||
      overrideConfig.remoteRunner ||
      (effectiveRunnerMode === 'AUTO' ? new HttpRemoteAcquisitionRunner() : undefined);
    if (
      effectiveRunnerMode === 'AUTO' &&
      autoCandidateRunner?.isConfigured() &&
      resolvedSourceId
    ) {
      try {
        return await this.executeViaRunner(
          autoCandidateRunner,
          rawUrl,
          resolvedSourceId,
          effectiveTimeoutMs,
          effectiveConnectionTimeoutMs,
          Math.max(0, effectiveMaxAttempts - 1),
          effectiveBaseDelayMs,
          overrideConfig.headers
        );
      } catch (remoteErr) {
        if (
          remoteErr instanceof IngestionError &&
          (remoteErr.code === 'SSRF_BLOCKED' ||
            remoteErr.code === 'NOT_PDF' ||
            remoteErr.code === 'CORRUPT_PDF')
        ) {
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

    let retriesUsed = 0;
    const retryReasons: string[] = [];
    const retryDiagnostics: RetryDiagnosticEntry[] = [];
    const attemptDiagnostics: StructuredFetchDiagnostic[] = [];

    for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
      try {
        const payload = await this.executeSingleDownload(
          rawUrl,
          attempt,
          effectiveTimeoutMs,
          effectiveConnectionTimeoutMs
        );
        const computedLocalSha = crypto.createHash('sha256').update(payload.buffer).digest('hex');
        return {
          ...payload,
          attemptsUsed: attempt,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          runner: 'LOCAL',
          runnerUsed: 'LOCAL',
          workerId: null,
          executionTimestamp: payload.downloadedAt,
          httpStatus: 200,
          finalUrl: payload.canonicalUrl,
          contentType: payload.mimeType,
          contentLength: payload.byteLength,
          checksumSha256: computedLocalSha,
          executionOrigin: 'REAL_LIVE_LOCAL',
          localAccess: 'SUCCESS',
          remoteAccess: autoRemoteFailureAccess ?? 'NOT_ATTEMPTED',
          selectedRunner: autoRemoteFailureAccess ? 'REMOTE' : 'LOCAL',
          selectionReason: autoRemoteFailureAccess
            ? `Remote runner failed (${autoRemoteFailureAccess}) in RUNNER_MODE=AUTO; fell back to LOCAL runner`
            : 'Local runner selected',
        };

      } catch (err) {
        lastError = err;

        // Content validation errors (NOT_PDF, CORRUPT_PDF) are non-retryable
        if (
          err instanceof IngestionError &&
          (err.code === 'NOT_PDF' || err.code === 'CORRUPT_PDF')
        ) {
          const prevDetails =
            typeof err.details === 'object' && err.details !== null
              ? (err.details as Record<string, unknown>)
              : {};
          throw new IngestionError(
            err.message,
            err.code,
            {
              ...prevDetails,
              attemptsUsed: attempt,
              retriesUsed,
              retryReasons,
              retryDiagnostics,
              attemptDiagnostics,
            },
            false
          );
        }

        const errDetailsObj =
          err instanceof IngestionError && typeof err.details === 'object' && err.details !== null
            ? (err.details as Record<string, unknown>)
            : null;
        const errStatus =
          errDetailsObj && typeof errDetailsObj.status === 'number'
            ? errDetailsObj.status
            : null;

        const diag = classifyNetworkOrHttpError({
          error: err,
          httpStatus: errStatus,
          requestUrl: rawUrl,
          timeoutMs: effectiveTimeoutMs,
          connectionTimeoutMs: effectiveConnectionTimeoutMs,
          attempt,
          maxAttempts: effectiveMaxAttempts,
          retryDelayMs: 0,
        });
        lastDiagnostic = diag;

        // Non-retryable errors must fail immediately without retry
        const isExplicitNonRetryable =
          (err instanceof IngestionError && !err.isRetryable) || !diag.retryable;

        if (isExplicitNonRetryable) {
          attemptDiagnostics.push(diag);
          if (err instanceof IngestionError) {
            const prevDetails =
              typeof err.details === 'object' && err.details !== null
                ? (err.details as Record<string, unknown>)
                : {};
            throw new IngestionError(
              err.message,
              err.code,
              {
                ...prevDetails,
                attemptsUsed: attempt,
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

          if (err instanceof SecurityViolationError) {
            throw new IngestionError(
              `Security validation failed: ${err.message}`,
              diag.errorType === 'SSRF_BLOCKED' || diag.errorType === 'DOMAIN_NOT_ALLOWED'
                ? 'SSRF_BLOCKED'
                : 'DOWNLOAD_FAILED',
              {
                url: rawUrl,
                code: err.code,
                attemptsUsed: attempt,
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

          break;
        }

        // Check if final attempt reached
        if (attempt === effectiveMaxAttempts) {
          attemptDiagnostics.push(diag);
          break;
        }

        const reason =
          errStatus !== null
            ? `HTTP_${errStatus}`
            : diag.errorType;

        // Exponential backoff delay
        const delay = Math.min(effectiveBaseDelayMs * Math.pow(2, attempt - 1), 5000);
        diag.retryDelayMs = delay;
        diag.delayMs = delay;
        diag.reason = reason;
        retriesUsed++;
        retryReasons.push(reason);
        retryDiagnostics.push(diag);
        attemptDiagnostics.push(diag);
        logger.warn(
          `Download attempt ${attempt}/${effectiveMaxAttempts} ${diag.errorType} Retrying after ${delay}ms`,
          {
            url: rawUrl,
            attempt,
            maxAttempts: effectiveMaxAttempts,
            errorType: diag.errorType,
            errorCode: diag.errorCode,
            retryable: diag.retryable,
            retryDelayMs: delay,
            reason,
            statusCode: errStatus,
            delayMs: delay,
            error: diag.errorMessage,
            cause: diag.cause,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Classify exhausted attempts error
    if (lastError instanceof IngestionError) {
      const prevDetails =
        typeof lastError.details === 'object' && lastError.details !== null
          ? (lastError.details as Record<string, unknown>)
          : {};
      throw new IngestionError(
        lastError.message,
        lastError.code,
        {
          ...prevDetails,
          attemptsUsed: attemptDiagnostics.length || effectiveMaxAttempts,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          lastDiagnostic,
          errorType: lastDiagnostic?.errorType ?? null,
          errorCode: lastDiagnostic?.errorCode ?? null,
          errorName: lastDiagnostic?.errorName ?? null,
          errorMessage: lastDiagnostic?.errorMessage ?? lastError.message,
          cause: lastDiagnostic?.cause ?? null,
          retryable: lastDiagnostic?.retryable ?? false,
          runnerUsed: 'LOCAL',
          executionOrigin: 'REAL_LIVE_LOCAL',
          localAccess: lastDiagnostic?.errorType || 'LOCAL_FAILED',
          remoteAccess: autoRemoteFailureAccess ?? 'NOT_ATTEMPTED',
          selectedRunner: autoRemoteFailureAccess ? 'REMOTE' : 'LOCAL',
        },
        false
      );
    }

    const message =
      lastDiagnostic?.errorMessage ||
      (lastError as Error)?.message ||
      'Download failed after max attempts';
    const isTimeout = lastDiagnostic?.errorType === 'TIMEOUT';

    throw new IngestionError(
      message,
      isTimeout ? 'TIMEOUT' : 'DOWNLOAD_FAILED',
      {
        url: rawUrl,
        retries: attemptDiagnostics.length || effectiveMaxAttempts,
        attemptsUsed: attemptDiagnostics.length || effectiveMaxAttempts,
        retriesUsed,
        retryReasons,
        retryDiagnostics,
        attemptDiagnostics,
        lastDiagnostic,
        errorType: lastDiagnostic?.errorType ?? null,
        errorCode: lastDiagnostic?.errorCode ?? null,
        errorName: lastDiagnostic?.errorName ?? null,
        errorMessage: message,
        cause: lastDiagnostic?.cause ?? null,
        retryable: lastDiagnostic?.retryable ?? false,
        runnerUsed: 'LOCAL',
        executionOrigin: 'REAL_LIVE_LOCAL',
        localAccess: lastDiagnostic?.errorType || 'LOCAL_FAILED',
        remoteAccess: autoRemoteFailureAccess ?? 'NOT_ATTEMPTED',
        selectedRunner: autoRemoteFailureAccess ? 'REMOTE' : 'LOCAL',
      },
      false
    );
  }

  private async executeSingleDownload(
    targetUrl: string,
    attempt: number,
    timeoutMs: number = this.timeoutMs,
    connectionTimeoutMs?: number
  ): Promise<Omit<DownloadedDocumentPayload, 'retriesUsed' | 'retryReasons' | 'retryDiagnostics'>> {
    let currentUrl = targetUrl;
    let hops = 0;
    const effectiveConnectionTimeoutMs = resolveConnectionTimeoutMs(timeoutMs, connectionTimeoutMs);
    const dispatcher = await configureGlobalFetchDispatcher(timeoutMs, effectiveConnectionTimeoutMs);

    while (hops <= this.maxRedirects) {
      // 1. Foundational URL and SSRF check on current hop (HTTPS enforced by default)
      try {
        await validateTargetUrl(currentUrl, { allowHttp: false });
      } catch (secErr) {
        if (secErr instanceof SecurityViolationError) {
          const isSsrf = [
            'SSRF_PRIVATE_IP',
            'SSRF_BLOCKED_HOST',
            'SSRF_DNS_REBINDING',
            'INSECURE_PROTOCOL',
            'FORBIDDEN_PROTOCOL',
          ].includes(secErr.code);
          const isDnsTransient =
            secErr.code === 'DNS_RESOLUTION_FAILED' || secErr.code === 'DNS_RESOLUTION_EMPTY';
          throw new IngestionError(
            `URL security violation: ${secErr.message}`,
            isSsrf ? 'SSRF_BLOCKED' : 'DOWNLOAD_FAILED',
            { url: currentUrl, secCode: secErr.code, cause: secErr.cause },
            isDnsTransient
          );
        }
        throw secErr;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(
          Object.assign(new Error(`Download timeout after ${timeoutMs}ms`), {
            name: 'TimeoutError',
            code: 'ETIMEDOUT',
          })
        );
      }, timeoutMs);

      try {
        const originReferer = (() => {
          try {
            return `${new URL(currentUrl).origin}/`;
          } catch {
            return undefined;
          }
        })();
        const response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual', // Manual redirect inspection for SSRF
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
            Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
            ...(originReferer ? { Referer: originReferer } : {}),
          },
        } as RequestInit);

        // Handle Redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          hops++;
          if (hops > this.maxRedirects) {
            throw new IngestionError(
              `Exceeded redirect limit of ${this.maxRedirects}`,
              'DOWNLOAD_FAILED',
              { hops },
              false
            );
          }

          const location = response.headers.get('location');
          if (!location) {
            throw new IngestionError('Redirect missing location header', 'DOWNLOAD_FAILED', {}, false);
          }

          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (!response.ok) {
          const isTransientHttp =
            (response.status >= 500 && response.status <= 599) || response.status === 429;
          throw new IngestionError(
            `HTTP download error: ${response.status} ${response.statusText}`,
            response.status === 404 ? 'NO_NOTICE_FOUND' : 'DOWNLOAD_FAILED',
            { status: response.status },
            isTransientHttp // Retryable ONLY if 5xx or 429 (401/403/404 are permanent)
          );
        }

        // Validate Content-Length header against max limit
        const declaredSizeHeader = response.headers.get('content-length');
        if (declaredSizeHeader) {
          const declared = parseInt(declaredSizeHeader, 10);
          if (!isNaN(declared) && declared > this.maxBytes) {
            throw new IngestionError(
              `Declared content size (${declared} bytes) exceeds limit (${this.maxBytes} bytes)`,
              'DOWNLOAD_FAILED',
              { declared, max: this.maxBytes },
              false
            );
          }
        }

        // Stream and cap response body
        if (!response.body) {
          throw new IngestionError('Server returned empty response body', 'NOT_PDF', {}, false);
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          total += value.length;
          if (total > this.maxBytes) {
            await reader.cancel();
            throw new IngestionError(
              `Downloaded payload exceeded size limit of ${this.maxBytes} bytes`,
              'DOWNLOAD_FAILED',
              { total, max: this.maxBytes },
              false
            );
          }
          chunks.push(value);
        }

        const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

        // 2. Reject empty responses
        if (buffer.length === 0) {
          throw new IngestionError('Downloaded document is 0 bytes (empty response)', 'NOT_PDF', {}, false);
        }

        // 3. Reject HTML disguised as PDF
        if (DocumentDownloader.isHtmlDisguised(buffer)) {
          throw new IngestionError(
            'Downloaded file contains HTML markup instead of binary PDF',
            'NOT_PDF',
            { snippet: buffer.subarray(0, 120).toString('utf-8') },
            false
          );
        }

        // 4. Validate PDF magic bytes (%PDF-)
        if (!DocumentDownloader.hasPdfMagicBytes(buffer)) {
          throw new IngestionError(
            'File lacks valid PDF magic-byte header (%PDF-)',
            'NOT_PDF',
            { headerHex: buffer.subarray(0, 8).toString('hex') },
            false
          );
        }

        const mime = response.headers.get('content-type') || 'application/pdf';
        const parsedUrl = new URL(currentUrl);

        return {
          sourceUrl: targetUrl,
          canonicalUrl: currentUrl,
          sourceDomain: parsedUrl.hostname,
          buffer,
          byteLength: total,
          mimeType: mime,
          downloadedAt: new Date().toISOString(),
          attemptsUsed: attempt,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new IngestionError('Max redirects exceeded', 'DOWNLOAD_FAILED', { hops }, false);
  }
}
