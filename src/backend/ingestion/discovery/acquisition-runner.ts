/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { URL } from 'node:url';
import { validateTargetUrl, SecurityViolationError } from '../../security/url-security.ts';
import { isOfficialDomain } from './official-domains.ts';
import {
  classifyNetworkOrHttpError,
  type NetworkErrorClassification,
  type StructuredFetchDiagnostic,
} from './network-error-classifier.ts';
import {
  configureGlobalFetchDispatcher,
  resolveConnectionTimeoutMs,
} from './http-dispatcher.ts';
import type { RetryDiagnosticEntry } from './types.ts';
import type {
  DnsProbeStatus,
  TcpProbeStatus,
  TlsProbeStatus,
  ConnectionProbeStatus,
  SourceFailureClassification,
} from './connectivity-diagnostics.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';
import { isLoopbackHostname } from '../../config/schema.ts';

export type RunnerMode = 'LOCAL' | 'REMOTE' | 'AUTO';

export type RunnerKind = 'LOCAL' | 'REMOTE';

export type AcquisitionMethodType = 'LISTING' | 'DETAIL' | 'DOCUMENT_PDF' | 'PROBE';

export type AcquisitionExecutionOrigin =
  | 'REAL_LIVE_LOCAL'
  | 'REAL_LIVE_REMOTE'
  | 'REAL_REMOTE_LOCAL_WORKER'
  | 'REAL_REMOTE_PRODUCTION'
  | 'MOCK_REMOTE'
  | 'FIXTURE'
  | 'CACHE';

export type RunnerClassification =
  | 'LOCAL'
  | 'REMOTE_LOCAL_WORKER'
  | 'REMOTE_PRODUCTION'
  | 'REMOTE_FALLBACK';

export type ExecutionEnvironmentKind =
  | 'LOCAL'
  | 'LOCAL_WORKER'
  | 'PRODUCTION_REMOTE';

export type RemoteExecutionState =
  | 'REMOTE_NOT_CONFIGURED'
  | 'REMOTE_UNAVAILABLE'
  | 'REMOTE_EXECUTED'
  | 'REMOTE_FAILED';

export type RuntimeAccessibilityState =
  | 'RUNTIME_ACCESSIBLE'
  | 'RUNTIME_INACCESSIBLE'
  | 'UNKNOWN';

export type OfficialEndpointVerificationState =
  | 'OFFICIAL_ENDPOINT_VERIFIED'
  | 'ENDPOINT_INVALID'
  | 'NOT_A_RECRUITMENT_ENDPOINT'
  | 'UNKNOWN';

export type RuntimeAccessDiagnosticState =
  | 'RUNTIME_ACCESSIBLE'
  | 'RUNTIME_ACCESS_BLOCKED_OR_UNREACHABLE'
  | 'UNKNOWN';

export type RunnerAccessOutcome =
  | 'SUCCESS'
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'HTTP_ERROR'
  | 'ACCESS_BLOCKED'
  | 'REDIRECT_BLOCKED'
  | 'SSRF_BLOCKED'
  | 'CONTENT_TYPE_INVALID'
  | 'MAX_SIZE_EXCEEDED'
  | 'INVALID_PDF'
  | 'UNREACHABLE'
  | 'NOT_CONFIGURED'
  | 'NOT_ATTEMPTED'
  | 'CACHED';

export interface SourceRuntimeCapabilities {
  dnsResolution: boolean;
  tcpConnection: boolean;
  tlsHandshake: boolean;
  httpAccess: boolean;
  redirectAccess: boolean;
  largeResponseAccess: boolean;
  pdfDownloadAccess: boolean;
}

export interface SourceAccessHealthRecord {
  sourceId: string;
  source: string;
  officialEndpointStatus: OfficialEndpointVerificationState;
  runtimeAccessibility: RuntimeAccessibilityState;
  runtimeAccessStatus: RuntimeAccessDiagnosticState;
  runtimeCapabilities: SourceRuntimeCapabilities;
  localAccess: RunnerAccessOutcome;
  remoteAccess: RunnerAccessOutcome;
  remoteStatus?: RemoteExecutionState;
  selectedRunner: RunnerKind;
  actualRunner?: RunnerKind;
  reason: string;
}

export interface RunnerHealthReport {
  runnerMode: RunnerMode;
  LOCAL_RUNNER: {
    status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
    details: string;
  };
  REMOTE_RUNNER: {
    status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'MOCK';
    remoteStatus?: RemoteExecutionState;
    configured: boolean;
    isMock: boolean;
    workerEndpoint: string | null;
    authConfigured: boolean;
    details: string;
  };
  SOURCE_ACCESS: Record<string, SourceAccessHealthRecord>;
}

export interface AcquisitionRequestPolicy {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  maxDownloadBytes?: number;
  maxRedirectHops?: number;
  expectedContentType?: string;
  responseType?: 'TEXT' | 'BINARY';
  allowHttp?: boolean;
}

export interface AcquisitionTimeoutPolicy {
  timeoutMs: number;
  connectionTimeoutMs?: number;
}

export interface AcquisitionRetryPolicy {
  maxRetries: number;
  retryBackoffMs?: number;
}

export interface AcquisitionRequest {
  requestId?: string;
  idempotencyKey?: string;
  sourceId: string;
  endpoint: string;
  methodType: AcquisitionMethodType;
  requestPolicy?: AcquisitionRequestPolicy;
  timeoutPolicy: AcquisitionTimeoutPolicy;
  retryPolicy: AcquisitionRetryPolicy;
}

export interface AcquisitionResult {
  requestId?: string;
  idempotencyKey?: string | null;
  deduplicatedReplay?: boolean;
  sourceId: string;
  methodType: AcquisitionMethodType;
  endpoint: string;
  finalUrl: string | null;
  httpStatus: number | null;
  redirectChain: string[];
  content: string | null;
  binaryContent?: Buffer | null;
  contentType: string | null;
  responseBytes: number;
  bytesReceived?: number;
  isPdf?: boolean;
  sha256?: string | null;
  durationMs: number;
  attempts: number;
  retriesUsed: number;
  retryReasons: string[];
  retryDiagnostics: RetryDiagnosticEntry[];
  attemptDiagnostics: StructuredFetchDiagnostic[];
  failureClassification: SourceFailureClassification | NetworkErrorClassification | string | 'NONE';
  failureClass?: string;
  failureDetails: string | null;
  errorType: NetworkErrorClassification | null;
  errorCode: string | null;
  errorName: string | null;
  retryable: boolean;
  runnerUsed: RunnerKind;
  runner?: RunnerKind;
  actualRunner?: RunnerKind;
  runnerClassification?: RunnerClassification;
  executionEnvironment?: ExecutionEnvironmentKind;
  remoteWorkerId?: string | null;
  workerVersion?: string | null;
  remoteStatus?: RemoteExecutionState;
  executionOrigin: AcquisitionExecutionOrigin;
  localAccess: RunnerAccessOutcome;
  remoteAccess: RunnerAccessOutcome;
  selectedRunner: RunnerKind;
  selectionReason: string;
  runnerIdentity?: {
    runnerId: string;
    remoteWorkerId?: string;
    runnerKind: RunnerKind;
    actualRunner?: RunnerKind;
    mode: string;
    executionEnvironment?: ExecutionEnvironmentKind | string;
    version?: string;
    workerVersion?: string;
    host?: string;
  };
  timestamp?: string;
}

/**
 * Provider-neutral Official Source Acquisition Runner interface.
 * Separates discovery/parsing/validation logic from the network execution environment.
 */
export interface OfficialAcquisitionRunner {
  readonly runnerKind: RunnerKind;
  readonly isMock: boolean;
  isConfigured(): boolean;
  acquire(request: AcquisitionRequest): Promise<AcquisitionResult>;
}

export type OfficialSourceRunner = OfficialAcquisitionRunner;
export type AcquisitionRunner = OfficialAcquisitionRunner;

const ALLOWED_LISTING_MIMES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/xml',
  'text/xml',
  'application/json',
];

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function mapErrorToRunnerAccessOutcome(
  errorType: NetworkErrorClassification | string | null,
  httpStatus: number | null
): RunnerAccessOutcome {
  if (!errorType && httpStatus !== null && httpStatus >= 200 && httpStatus < 400) {
    return 'SUCCESS';
  }
  if (errorType === 'TIMEOUT') return 'TIMEOUT';
  if (errorType === 'CONNECTION_RESET') return 'CONNECTION_RESET';
  if (errorType === 'CONNECTION_REFUSED') return 'CONNECTION_REFUSED';
  if (errorType === 'DNS_ERROR') return 'DNS_FAILURE';
  if (errorType === 'TLS_ERROR') return 'TLS_FAILURE';
  if (
    errorType === 'HTTP_403' ||
    errorType === 'SSRF_BLOCKED' ||
    errorType === 'DOMAIN_NOT_ALLOWED' ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return 'ACCESS_BLOCKED';
  }
  if (
    errorType === 'HTTP_404' ||
    errorType === 'HTTP_429' ||
    errorType === 'HTTP_4XX' ||
    errorType === 'HTTP_502' ||
    errorType === 'HTTP_503' ||
    errorType === 'HTTP_504' ||
    errorType === 'HTTP_5XX' ||
    (httpStatus !== null && httpStatus >= 400)
  ) {
    return 'HTTP_ERROR';
  }
  return 'UNREACHABLE';
}

/**
 * Enforces strict official-domain allowlist, HTTPS protocol, and SSRF validation
 * on both the initial target URL and any redirect hops.
 * Used identically by both LocalAcquisitionRunner and RemoteAcquisitionRunner.
 */
export async function enforceOfficialAcquisitionSecurity(
  url: string,
  sourceId: string,
  options: { allowHttp?: boolean; skipDnsLookup?: boolean } = {}
): Promise<void> {
  const allowHttp = options.allowHttp ?? false;
  const domainCheck = isOfficialDomain(url, sourceId);
  if (!domainCheck.allowed) {
    throw new IngestionError(
      `Disallowed non-official domain for ${sourceId}: ${domainCheck.reason}`,
      'SSRF_BLOCKED',
      { url, errorCode: 'DOMAIN_NOT_ALLOWED' },
      false
    );
  }
  await validateTargetUrl(url, { allowHttp, skipDnsLookup: options.skipDnsLookup });
}

/**
 * Resolves RUNNER_MODE from explicit override or process.env.RUNNER_MODE.
 * Defaults safely to 'LOCAL'.
 */
export function resolveRunnerMode(overrideMode?: RunnerMode | string): RunnerMode {
  const raw = (overrideMode ?? process.env.RUNNER_MODE ?? 'LOCAL').toString().trim().toUpperCase();
  if (raw === 'REMOTE') return 'REMOTE';
  if (raw === 'AUTO') return 'AUTO';
  return 'LOCAL';
}

/**
 * Computes runtime capabilities and separates official endpoint validity from current runtime accessibility.
 */
export function evaluateSourceRuntimeCapabilities(input: {
  officialDomainVerified: boolean;
  endpointClassification?: string;
  dnsStatus: DnsProbeStatus;
  tcpStatus: TcpProbeStatus;
  tlsStatus: TlsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  endpointReached: boolean;
  httpStatus: number | null;
  responseBytes?: number | null;
  redirectChain?: string[];
  documentDownloaded: boolean;
  pdfValidated: boolean;
  failureReasons?: string[];
}): {
  runtimeCapabilities: SourceRuntimeCapabilities;
  runtimeAccessibility: RuntimeAccessibilityState;
  officialEndpointStatus: OfficialEndpointVerificationState;
  runtimeAccessStatus: RuntimeAccessDiagnosticState;
} {
  const dnsResolution = input.dnsStatus === 'RESOLVED' || input.endpointReached;
  const tcpConnection = input.tcpStatus === 'CONNECTED' || input.endpointReached;
  const tlsHandshake = input.tlsStatus === 'CONNECTED' || input.endpointReached;
  const httpAccess =
    input.endpointReached &&
    input.httpStatus !== null &&
    input.httpStatus >= 200 &&
    input.httpStatus < 400;
  const redirectAccess =
    httpAccess && !(input.failureReasons || []).includes('ACCESS_BLOCKED');
  const largeResponseAccess = httpAccess && (input.responseBytes ?? 0) > 0;
  const pdfDownloadAccess = Boolean(input.documentDownloaded && input.pdfValidated);

  let runtimeAccessibility: RuntimeAccessibilityState = 'UNKNOWN';
  if (httpAccess) {
    runtimeAccessibility = 'RUNTIME_ACCESSIBLE';
  } else if (
    !input.endpointReached ||
    input.tcpStatus === 'TIMEOUT' ||
    input.tcpStatus === 'CONNECTION_REFUSED' ||
    input.tcpStatus === 'CONNECTION_RESET' ||
    input.tlsStatus === 'CONNECTION_RESET' ||
    input.tlsStatus === 'TLS_FAILURE' ||
    input.tlsStatus === 'TIMEOUT' ||
    input.dnsStatus === 'ENOTFOUND' ||
    input.dnsStatus === 'EAI_AGAIN' ||
    input.dnsStatus === 'DNS_FAILURE' ||
    input.httpStatus === 403 ||
    input.httpStatus === 429
  ) {
    runtimeAccessibility = 'RUNTIME_INACCESSIBLE';
  }

  let officialEndpointStatus: OfficialEndpointVerificationState = 'UNKNOWN';
  if (!input.officialDomainVerified || input.dnsStatus === 'SSRF_BLOCKED') {
    officialEndpointStatus = 'ENDPOINT_INVALID';
  } else if (
    input.httpStatus === 404 ||
    input.httpStatus === 410 ||
    input.endpointClassification === 'ENDPOINT_STALE_OR_WRONG'
  ) {
    officialEndpointStatus = 'ENDPOINT_INVALID';
  } else if (input.officialDomainVerified) {
    // Crucial rule: Local runtime timeout / ECONNRESET / NIC firewall drop does NOT invalidate a verified official endpoint
    officialEndpointStatus = 'OFFICIAL_ENDPOINT_VERIFIED';
  }

  const runtimeAccessStatus: RuntimeAccessDiagnosticState =
    runtimeAccessibility === 'RUNTIME_ACCESSIBLE'
      ? 'RUNTIME_ACCESSIBLE'
      : runtimeAccessibility === 'RUNTIME_INACCESSIBLE'
      ? 'RUNTIME_ACCESS_BLOCKED_OR_UNREACHABLE'
      : 'UNKNOWN';

  return {
    runtimeCapabilities: {
      dnsResolution,
      tcpConnection,
      tlsHandshake,
      httpAccess,
      redirectAccess,
      largeResponseAccess,
      pdfDownloadAccess,
    },
    runtimeAccessibility,
    officialEndpointStatus,
    runtimeAccessStatus,
  };
}

/**
 * Default Local Acquisition Runner executing directly inside the current Node runtime.
 * Enforces HTTPS, official-domain allowlist, SSRF protection, manual redirect validation,
 * bounded timeouts, bounded retries, and size limits.
 */
export class LocalAcquisitionRunner implements OfficialAcquisitionRunner {
  readonly runnerKind: RunnerKind = 'LOCAL';
  readonly isMock: boolean = false;

  isConfigured(): boolean {
    return true;
  }

  async acquire(request: AcquisitionRequest): Promise<AcquisitionResult> {
    const startedAt = Date.now();
    const { sourceId, endpoint, methodType } = request;
    const timeoutMs = Math.min(Math.max(50, Math.floor(request.timeoutPolicy.timeoutMs || 15000)), 30000);
    const connectionTimeoutMs = resolveConnectionTimeoutMs(
      timeoutMs,
      request.timeoutPolicy.connectionTimeoutMs
    );
    const maxRetries = Math.min(Math.max(0, Math.floor(request.retryPolicy.maxRetries ?? 2)), 3);
    const retryBackoffMs = Math.min(
      Math.max(10, Math.floor(request.retryPolicy.retryBackoffMs ?? 500)),
      5000
    );
    const maxAttempts = maxRetries + 1;
    const responseType =
      request.requestPolicy?.responseType ??
      (methodType === 'DOCUMENT_PDF' ? 'BINARY' : 'TEXT');
    const maxDownloadBytes =
      request.requestPolicy?.maxDownloadBytes ??
      (responseType === 'BINARY' ? 26214400 : 10 * 1024 * 1024);
    const maxRedirectHops = request.requestPolicy?.maxRedirectHops ?? 3;
    const allowHttp = request.requestPolicy?.allowHttp ?? false;

    // 1. Pre-flight official domain check (non-retryable)
    const domainCheck = isOfficialDomain(endpoint, sourceId);
    if (!domainCheck.allowed) {
      const domainErr = new IngestionError(
        `Disallowed non-official domain for ${sourceId}: ${domainCheck.reason}`,
        'SSRF_BLOCKED',
        { errorCode: 'DOMAIN_NOT_ALLOWED' },
        false
      );
      const diag = classifyNetworkOrHttpError({
        error: domainErr,
        requestUrl: endpoint,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts,
        retryDelayMs: 0,
      });
      return {
        sourceId,
        methodType,
        endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        failureClassification: 'ACCESS_BLOCKED',
        failureDetails: domainErr.message,
        errorType: diag.errorType,
        errorCode: diag.errorCode,
        errorName: diag.errorName,
        retryable: false,
        runnerUsed: 'LOCAL',
        executionOrigin: 'REAL_LIVE_LOCAL',
        localAccess: 'ACCESS_BLOCKED',
        remoteAccess: 'NOT_ATTEMPTED',
        selectedRunner: 'LOCAL',
        selectionReason: 'Blocked by official domain allowlist before network request',
      };
    }

    const dispatcher = await configureGlobalFetchDispatcher(timeoutMs, connectionTimeoutMs);

    let attempt = 0;
    let attemptsUsed = 0;
    let retriesUsed = 0;
    const retryReasons: string[] = [];
    const retryDiagnostics: RetryDiagnosticEntry[] = [];
    const attemptDiagnostics: StructuredFetchDiagnostic[] = [];
    let lastDiagnostic: StructuredFetchDiagnostic | null = null;
    let lastError: Error | null = null;
    let lastRedirectChain: string[] = [endpoint];

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
        let currentUrl = endpoint;
        let hops = 0;
        let response: Response | null = null;
        const redirectChain: string[] = [endpoint];
        lastRedirectChain = redirectChain;

        while (hops <= maxRedirectHops) {
          await validateTargetUrl(currentUrl, { allowHttp });
          if (hops > 0) {
            const hopDomainCheck = isOfficialDomain(currentUrl, sourceId);
            if (!hopDomainCheck.allowed) {
              throw new IngestionError(
                `Redirected to unapproved domain: ${currentUrl}`,
                'SSRF_BLOCKED',
                { url: currentUrl, errorCode: 'DOMAIN_NOT_ALLOWED' },
                false
              );
            }
          }

          const originReferer = (() => {
            try {
              return `${new URL(currentUrl).origin}/`;
            } catch {
              return undefined;
            }
          })();

          response = await fetch(currentUrl, {
            method: request.requestPolicy?.method || 'GET',
            redirect: 'manual',
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
              Accept:
                responseType === 'BINARY'
                  ? 'application/pdf,application/octet-stream,*/*;q=0.8'
                  : 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
              ...(originReferer ? { Referer: originReferer } : {}),
              ...(request.requestPolicy?.headers || {}),
            },
          } as RequestInit);

          if ([301, 302, 303, 307, 308].includes(response.status)) {
            hops++;
            if (hops > maxRedirectHops) {
              throw new IngestionError(
                `Exceeded redirect limit of ${maxRedirectHops}`,
                'SSRF_BLOCKED',
                { url: currentUrl },
                false
              );
            }
            const location = response.headers.get('location');
            if (!location) {
              throw new IngestionError(
                'Redirect response missing Location header',
                'DOWNLOAD_FAILED',
                { url: currentUrl },
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
        if (resolvedUrl !== endpoint) {
          await validateTargetUrl(resolvedUrl, { allowHttp });
          const redirectDomainCheck = isOfficialDomain(resolvedUrl, sourceId);
          if (!redirectDomainCheck.allowed) {
            throw new IngestionError(
              `Redirected to unapproved domain: ${resolvedUrl}`,
              'SSRF_BLOCKED',
              { url: resolvedUrl, errorCode: 'DOMAIN_NOT_ALLOWED' },
              false
            );
          }
        }

        if (response.status === 401 || response.status === 403) {
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
          throw new IngestionError(diag.errorMessage, 'SOURCE_UNAVAILABLE', { status: response.status }, false);
        }

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
          throw new IngestionError(diag.errorMessage, 'DOWNLOAD_FAILED', { status: 404 }, false);
        }

        if (isRetryableHttpStatus(response.status)) {
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
            throw new IngestionError(diag.errorMessage, 'SOURCE_UNAVAILABLE', { status: response.status }, false);
          }
        }

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
          throw new IngestionError(diag.errorMessage, 'DOWNLOAD_FAILED', { status: response.status }, false);
        }

        const contentTypeHeader = response.headers.get('content-type');
        const cleanMime = contentTypeHeader
          ? contentTypeHeader.split(';')[0].trim().toLowerCase()
          : responseType === 'BINARY'
          ? 'application/pdf'
          : 'text/html';

        if (responseType === 'TEXT' && contentTypeHeader && !ALLOWED_LISTING_MIMES.includes(cleanMime)) {
          throw new IngestionError(
            `Unexpected Content-Type "${cleanMime}" from listing endpoint ${resolvedUrl}`,
            'EXTRACTION_FAILED',
            { contentType: cleanMime },
            false
          );
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
          const declaredBytes = parseInt(contentLengthHeader, 10);
          if (!isNaN(declaredBytes) && declaredBytes > maxDownloadBytes) {
            throw new IngestionError(
              `Response size (${declaredBytes} bytes) exceeds limit (${maxDownloadBytes} bytes)`,
              'DOWNLOAD_FAILED',
              { declaredBytes, maxDownloadBytes },
              false
            );
          }
        }

        if (responseType === 'BINARY') {
          const arrayBuf = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          if (buffer.length > maxDownloadBytes) {
            throw new IngestionError(
              `Downloaded payload (${buffer.length} bytes) exceeded size limit (${maxDownloadBytes} bytes)`,
              'DOWNLOAD_FAILED',
              { total: buffer.length, maxDownloadBytes },
              false
            );
          }
          return {
            sourceId,
            methodType,
            endpoint,
            finalUrl: resolvedUrl,
            httpStatus: response.status,
            redirectChain: lastRedirectChain,
            content: null,
            binaryContent: buffer,
            contentType: cleanMime,
            responseBytes: buffer.length,
            durationMs: Date.now() - startedAt,
            attempts: attemptsUsed,
            retriesUsed,
            retryReasons,
            retryDiagnostics,
            attemptDiagnostics,
            failureClassification: 'NONE',
            failureDetails: null,
            errorType: null,
            errorCode: null,
            errorName: null,
            retryable: false,
            runnerUsed: 'LOCAL',
            executionOrigin: 'REAL_LIVE_LOCAL',
            localAccess: 'SUCCESS',
            remoteAccess: 'NOT_ATTEMPTED',
            selectedRunner: 'LOCAL',
            selectionReason: 'Local runtime reached official source directly',
          };
        } else {
          const text = await response.text();
          const responseBytes = Buffer.byteLength(text, 'utf8');
          if (responseBytes > maxDownloadBytes) {
            throw new IngestionError(
              `Listing response body exceeds limit (${maxDownloadBytes} bytes)`,
              'DOWNLOAD_FAILED',
              { maxDownloadBytes },
              false
            );
          }
          return {
            sourceId,
            methodType,
            endpoint,
            finalUrl: resolvedUrl,
            httpStatus: response.status,
            redirectChain: lastRedirectChain,
            content: text,
            binaryContent: null,
            contentType: cleanMime,
            responseBytes,
            durationMs: Date.now() - startedAt,
            attempts: attemptsUsed,
            retriesUsed,
            retryReasons,
            retryDiagnostics,
            attemptDiagnostics,
            failureClassification: 'NONE',
            failureDetails: null,
            errorType: null,
            errorCode: null,
            errorName: null,
            retryable: false,
            runnerUsed: 'LOCAL',
            executionOrigin: 'REAL_LIVE_LOCAL',
            localAccess: 'SUCCESS',
            remoteAccess: 'NOT_ATTEMPTED',
            selectedRunner: 'LOCAL',
            selectionReason: 'Local runtime reached official source directly',
          };
        }
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err as Error;

        if (err instanceof IngestionError && (!err.retryable || !err.isRetryable)) {
          const prevDetails =
            typeof err.details === 'object' && err.details !== null
              ? (err.details as Record<string, unknown>)
              : {};
          if (!lastDiagnostic) {
            const diag = classifyNetworkOrHttpError({
              error: err,
              httpStatus: typeof prevDetails.status === 'number' ? prevDetails.status : null,
              requestUrl: endpoint,
              timeoutMs,
              connectionTimeoutMs,
              attempt: currentAttemptNum,
              maxAttempts,
              retryDelayMs: 0,
            });
            attemptDiagnostics.push(diag);
            lastDiagnostic = diag;
          }
          break;
        }

        const diag = classifyNetworkOrHttpError({
          error: lastError,
          requestUrl: endpoint,
          timeoutMs,
          connectionTimeoutMs,
          attempt: currentAttemptNum,
          maxAttempts,
          retryDelayMs: 0,
        });
        lastDiagnostic = diag;

        if (!diag.retryable) {
          attemptDiagnostics.push(diag);
          break;
        }

        if (attempt < maxRetries) {
          const jitterMs = Math.floor(Math.random() * 100);
          const backoffMs = Math.min(retryBackoffMs * Math.pow(2, attempt) + jitterMs, 5000);
          diag.retryDelayMs = backoffMs;
          diag.delayMs = backoffMs;
          diag.reason = diag.errorType;
          retryReasons.push(diag.errorType);
          retryDiagnostics.push(diag);
          attemptDiagnostics.push(diag);
          attempt++;
          retriesUsed++;
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          attemptDiagnostics.push(diag);
          break;
        }
      }
    }

    const errType = lastDiagnostic?.errorType ?? 'UNKNOWN_NETWORK_ERROR';
    const httpStatus = lastDiagnostic?.httpStatus ?? null;
    const localAccess = mapErrorToRunnerAccessOutcome(errType, httpStatus);
    const failureDetails =
      lastDiagnostic?.errorMessage || lastError?.message || 'Official endpoint unreachable from local runtime';

    return {
      sourceId,
      methodType,
      endpoint,
      finalUrl: null,
      httpStatus,
      redirectChain: lastRedirectChain,
      content: null,
      binaryContent: null,
      contentType: null,
      responseBytes: 0,
      durationMs: Date.now() - startedAt,
      attempts: attemptsUsed,
      retriesUsed,
      retryReasons,
      retryDiagnostics,
      attemptDiagnostics,
      failureClassification: errType,
      failureDetails,
      errorType: errType,
      errorCode: lastDiagnostic?.errorCode ?? null,
      errorName: lastDiagnostic?.errorName ?? null,
      retryable: lastDiagnostic?.retryable ?? false,
      runnerUsed: 'LOCAL',
      executionOrigin: 'REAL_LIVE_LOCAL',
      localAccess,
      remoteAccess: 'NOT_ATTEMPTED',
      selectedRunner: 'LOCAL',
      selectionReason: `Local runtime failed with ${localAccess}`,
    };
  }
}

export interface RemoteWorkerConfig {
  workerUrl?: string;
  workerEndpoint?: string;
  authToken?: string;
  allowLocalWorkerHttp?: boolean;
  fetchFn?: typeof globalThis.fetch;
  skipWorkerUrlIpValidation?: boolean;
}

function mapWorkerFailureClassToErrorType(
  failureClass: string | undefined | null,
  httpStatus: number | null
): NetworkErrorClassification {
  switch (failureClass) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'DNS_FAILURE':
      return 'DNS_ERROR';
    case 'CONNECTION_RESET':
      return 'CONNECTION_RESET';
    case 'CONNECTION_REFUSED':
      return 'CONNECTION_REFUSED';
    case 'TLS_FAILURE':
      return 'TLS_ERROR';
    case 'REDIRECT_BLOCKED':
    case 'SSRF_BLOCKED':
      return 'SSRF_BLOCKED';
    case 'ACCESS_BLOCKED':
      return httpStatus === 403 || httpStatus === 401 ? 'HTTP_403' : 'SSRF_BLOCKED';
    case 'CONTENT_TYPE_INVALID':
    case 'MAX_SIZE_EXCEEDED':
    case 'INVALID_PDF':
    case 'RESPONSE_STRUCTURE_UNEXPECTED':
      return 'HTTP_4XX';
    case 'HTTP_ERROR':
      if (httpStatus === 404) return 'HTTP_404';
      if (httpStatus === 429) return 'HTTP_429';
      if (httpStatus === 502) return 'HTTP_502';
      if (httpStatus === 503) return 'HTTP_503';
      if (httpStatus === 504) return 'HTTP_504';
      if (httpStatus && httpStatus >= 500) return 'HTTP_5XX';
      return 'HTTP_4XX';
    default:
      return 'UNKNOWN_NETWORK_ERROR';
  }
}

/**
 * Provider-neutral Remote Acquisition Runner.
 * Communicates with the Official Acquisition Worker (`OFFICIAL_ACQUISITION_WORKER_URL` / `OMNIHUB_REMOTE_WORKER_URL`)
 * using Bearer token and HMAC-SHA256 authentication (`OFFICIAL_ACQUISITION_WORKER_TOKEN` / `OMNIHUB_REMOTE_WORKER_TOKEN`).
 *
 * Security invariants:
 * - Pre-validates requested target URL against official-domain allowlist, HTTPS, and SSRF before calling worker.
 * - Post-validates every URL in `redirectChain` and `finalUrl` returned by the worker against official-domain allowlist, HTTPS, and SSRF.
 * - Distinguishes `REAL_REMOTE_LOCAL_WORKER` (when talking to a local worker process) from `REAL_REMOTE_PRODUCTION` (deployed HTTPS worker).
 * - Never fabricates success when unconfigured or unreachable.
 */
export class HttpRemoteAcquisitionRunner implements OfficialAcquisitionRunner {
  readonly runnerKind: RunnerKind = 'REMOTE';
  readonly isMock: boolean = false;
  private workerUrl: string | null;
  private authToken: string | null;
  private allowLocalWorkerHttp: boolean;
  private fetchFn: typeof globalThis.fetch;
  private skipWorkerUrlIpValidation: boolean;

  constructor(config: RemoteWorkerConfig = {}) {
    const rawUrl = (
      config.workerUrl ??
      config.workerEndpoint ??
      process.env.OFFICIAL_ACQUISITION_WORKER_URL ??
      process.env.OMNIHUB_REMOTE_WORKER_URL ??
      ''
    ).trim();
    const rawToken = (
      config.authToken ??
      process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN ??
      process.env.OMNIHUB_REMOTE_WORKER_TOKEN ??
      ''
    ).trim();
    this.workerUrl = rawUrl.length > 0 ? rawUrl : null;
    this.authToken = rawToken.length > 0 ? rawToken : null;
    const isProductionRuntime =
      process.env.NODE_ENV === 'production' ||
      process.env.WORKER_EXECUTION_ENVIRONMENT === 'PRODUCTION_REMOTE';
    this.allowLocalWorkerHttp = config.allowLocalWorkerHttp ?? !isProductionRuntime;
    this.fetchFn = config.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.skipWorkerUrlIpValidation = Boolean(config.skipWorkerUrlIpValidation);
  }

  isConfigured(): boolean {
    return Boolean(this.workerUrl);
  }

  isLocalWorkerEndpoint(): boolean {
    if (!this.workerUrl) return false;
    try {
      const parsed = new URL(this.workerUrl);
      return isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  }

  resolveAcquireEndpoint(): string | null {
    if (!this.workerUrl) return null;
    try {
      const parsed = new URL(this.workerUrl);
      if (parsed.pathname === '/' || parsed.pathname === '') {
        parsed.pathname = '/acquire';
      }
      return parsed.toString();
    } catch {
      return this.workerUrl;
    }
  }

  resolveHealthEndpoint(): string | null {
    if (!this.workerUrl) return null;
    try {
      const parsed = new URL(this.workerUrl);
      if (parsed.pathname.endsWith('/acquire')) {
        parsed.pathname = parsed.pathname.replace(/\/acquire$/, '/health');
      } else {
        parsed.pathname = '/health';
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  resolveCapabilitiesEndpoint(): string | null {
    if (!this.workerUrl) return null;
    try {
      const parsed = new URL(this.workerUrl);
      if (parsed.pathname.endsWith('/acquire')) {
        parsed.pathname = parsed.pathname.replace(/\/acquire$/, '/capabilities');
      } else {
        parsed.pathname = '/capabilities';
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  getSanitizedConfig(): {
    configured: boolean;
    workerEndpoint: string | null;
    authConfigured: boolean;
    isLocalWorker: boolean;
    isHttps: boolean;
    isValidProductionRemoteConfig: boolean;
  } {
    if (!this.workerUrl) {
      return {
        configured: false,
        workerEndpoint: null,
        authConfigured: Boolean(this.authToken),
        isLocalWorker: false,
        isHttps: false,
        isValidProductionRemoteConfig: false,
      };
    }
    try {
      const parsed = new URL(this.workerUrl);
      const isLocalWorker = this.isLocalWorkerEndpoint();
      const isHttps = parsed.protocol === 'https:';
      const authConfigured = Boolean(this.authToken);
      return {
        configured: true,
        workerEndpoint: `${parsed.origin}${parsed.pathname}`,
        authConfigured,
        isLocalWorker,
        isHttps,
        isValidProductionRemoteConfig: isHttps && !isLocalWorker && authConfigured,
      };
    } catch {
      return {
        configured: false,
        workerEndpoint: 'INVALID_WORKER_URL',
        authConfigured: Boolean(this.authToken),
        isLocalWorker: false,
        isHttps: false,
        isValidProductionRemoteConfig: false,
      };
    }
  }

  async checkHealth(timeoutMs = 3000): Promise<{
    reachable: boolean;
    healthy: boolean;
    remoteStatus: RemoteExecutionState;
    workerMode?: 'LOCAL_WORKER' | 'PRODUCTION_WORKER';
    executionEnvironment?: ExecutionEnvironmentKind | string;
    remoteWorkerId?: string | null;
    workerVersion?: string | null;
    statusCode?: number | null;
    errorType?: NetworkErrorClassification | null;
    errorCode?: string | null;
    details: string;
    rawHealth?: Record<string, unknown>;
  }> {
    const healthUrl = this.resolveHealthEndpoint();
    if (!healthUrl) {
      return {
        reachable: false,
        healthy: false,
        remoteStatus: 'REMOTE_NOT_CONFIGURED',
        details: 'OFFICIAL_ACQUISITION_WORKER_URL is not configured',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          reachable: true,
          healthy: false,
          statusCode: res.status,
          remoteStatus: 'REMOTE_UNAVAILABLE',
          details: `Worker /health returned HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        status?: string;
        version?: string;
        runnerIdentity?: {
          runnerId?: string;
          remoteWorkerId?: string;
          mode?: 'LOCAL_WORKER' | 'PRODUCTION_WORKER';
          executionEnvironment?: ExecutionEnvironmentKind | string;
          version?: string;
          workerVersion?: string;
        };
      };
      if (data && data.status === 'HEALTHY') {
        return {
          reachable: true,
          healthy: true,
          statusCode: res.status,
          remoteStatus: 'REMOTE_EXECUTED',
          workerMode: data.runnerIdentity?.mode,
          executionEnvironment:
            data.runnerIdentity?.executionEnvironment ??
            (data.runnerIdentity?.mode === 'PRODUCTION_WORKER'
              ? 'PRODUCTION_REMOTE'
              : 'LOCAL_WORKER'),
          remoteWorkerId:
            data.runnerIdentity?.remoteWorkerId ?? data.runnerIdentity?.runnerId ?? null,
          workerVersion:
            data.runnerIdentity?.workerVersion ??
            data.runnerIdentity?.version ??
            data.version ??
            null,
          details: 'Official Acquisition Worker is healthy',
          rawHealth: data as unknown as Record<string, unknown>,
        };
      }
      return {
        reachable: true,
        healthy: false,
        statusCode: res.status,
        remoteStatus: 'REMOTE_UNAVAILABLE',
        details: `Worker /health returned status="${String(data?.status)}"`,
      };
    } catch (err) {
      clearTimeout(timer);
      const diag = classifyNetworkOrHttpError({
        error: err,
        requestUrl: healthUrl,
        timeoutMs,
        attempt: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
      });
      return {
        reachable: false,
        healthy: false,
        statusCode: null,
        errorType: diag.errorType,
        errorCode: diag.errorCode,
        remoteStatus: 'REMOTE_UNAVAILABLE',
        details: `Worker /health unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getCapabilities(timeoutMs = 3000): Promise<{
    reachable: boolean;
    supportedSourcesCount: number;
    rrbRegionalBoardsCount: number;
    details?: Record<string, unknown>;
  }> {
    const capUrl = this.resolveCapabilitiesEndpoint();
    if (!capUrl) {
      return {
        reachable: false,
        supportedSourcesCount: 0,
        rrbRegionalBoardsCount: 0,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(capUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          reachable: false,
          supportedSourcesCount: 0,
          rrbRegionalBoardsCount: 0,
        };
      }
      const data = (await res.json()) as {
        supportedSources?: unknown[];
        rrbRegionalBoardsCount?: number;
      };
      return {
        reachable: true,
        supportedSourcesCount: Array.isArray(data.supportedSources)
          ? data.supportedSources.length
          : 0,
        rrbRegionalBoardsCount:
          typeof data.rrbRegionalBoardsCount === 'number'
            ? data.rrbRegionalBoardsCount
            : 0,
        details: data as Record<string, unknown>,
      };
    } catch {
      clearTimeout(timer);
      return {
        reachable: false,
        supportedSourcesCount: 0,
        rrbRegionalBoardsCount: 0,
      };
    }
  }

  async acquire(request: AcquisitionRequest): Promise<AcquisitionResult> {
    const startedAt = Date.now();
    const requestId = request.requestId || crypto.randomUUID();
    const idempotencyKey = request.idempotencyKey || null;
    const { sourceId, endpoint, methodType } = request;
    const timeoutMs = Math.min(Math.max(50, Math.floor(request.timeoutPolicy?.timeoutMs || 15000)), 30000);
    const connectionTimeoutMs = resolveConnectionTimeoutMs(
      timeoutMs,
      request.timeoutPolicy?.connectionTimeoutMs
    );
    const maxRetries = Math.min(Math.max(0, Math.floor(request.retryPolicy?.maxRetries ?? 2)), 3);
    const responseType =
      request.requestPolicy?.responseType ??
      (methodType === 'DOCUMENT_PDF' ? 'BINARY' : 'TEXT');
    const maxDownloadBytes =
      request.requestPolicy?.maxDownloadBytes ??
      (responseType === 'BINARY' ? 26214400 : 10 * 1024 * 1024);
    const maxRedirectHops = request.requestPolicy?.maxRedirectHops ?? 3;
    const allowHttp = request.requestPolicy?.allowHttp ?? false;
    const defaultOrigin: AcquisitionExecutionOrigin = this.isLocalWorkerEndpoint()
      ? 'REAL_REMOTE_LOCAL_WORKER'
      : 'REAL_REMOTE_PRODUCTION';

    // 1. Enforce official domain & SSRF on the target government URL BEFORE contacting any remote worker
    // (The remote worker performs its own DNS resolution & DNS-rebinding check at execution time)
    try {
      await enforceOfficialAcquisitionSecurity(endpoint, sourceId, {
        allowHttp,
        skipDnsLookup: true,
      });
    } catch (secErr) {
      const diag = classifyNetworkOrHttpError({
        error: secErr,
        requestUrl: endpoint,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts: maxRetries + 1,
        retryDelayMs: 0,
      });
      return {
        requestId,
        idempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        methodType,
        endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        failureClassification: 'ACCESS_BLOCKED',
        failureClass: 'SSRF_BLOCKED',
        failureDetails: (secErr as Error).message,
        errorType: diag.errorType,
        errorCode: diag.errorCode,
        errorName: diag.errorName,
        retryable: false,
        runnerUsed: 'REMOTE',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: 'REMOTE_FAILED',
        executionOrigin: defaultOrigin,
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'ACCESS_BLOCKED',
        selectedRunner: 'REMOTE',
        selectionReason: 'Rejected by official domain / SSRF security policy prior to remote execution',
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Check if remote worker is configured
    const acquireUrl = this.resolveAcquireEndpoint();
    if (!this.workerUrl || !acquireUrl) {
      return {
        requestId,
        idempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        methodType,
        endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        failureClassification: 'NETWORK_UNREACHABLE',
        failureClass: 'UNKNOWN',
        failureDetails:
          'Remote acquisition worker is not configured (OFFICIAL_ACQUISITION_WORKER_URL / OMNIHUB_REMOTE_WORKER_URL is unset)',
        errorType: 'NETWORK_UNAVAILABLE',
        errorCode: 'REMOTE_RUNNER_NOT_CONFIGURED',
        errorName: 'ConfigurationError',
        retryable: false,
        runnerUsed: 'REMOTE',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: 'REMOTE_NOT_CONFIGURED',
        executionOrigin: defaultOrigin,
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'NOT_CONFIGURED',
        selectedRunner: 'REMOTE',
        selectionReason: 'Remote acquisition worker is not configured (REMOTE_NOT_CONFIGURED)',
        timestamp: new Date().toISOString(),
      };
    }

    // 3. Validate the worker URL itself
    // Allow local loopback HTTP worker ONLY when workerUrl explicitly targets 127.0.0.1 / localhost (REAL_REMOTE_LOCAL_WORKER);
    // block cloud metadata (169.254.169.254) and non-HTTPS external worker URLs.
    try {
      const parsedWorker = new URL(acquireUrl);
      if (parsedWorker.protocol !== 'https:' && parsedWorker.protocol !== 'http:') {
        throw new SecurityViolationError(
          `Forbidden worker URL scheme "${parsedWorker.protocol}"`,
          'FORBIDDEN_PROTOCOL'
        );
      }
      if (!this.isLocalWorkerEndpoint() || !this.allowLocalWorkerHttp) {
        if (!this.skipWorkerUrlIpValidation) {
          await validateTargetUrl(acquireUrl, { allowHttp: false });
        } else {
          const parsedAcquire = new URL(acquireUrl);
          if (parsedAcquire.protocol !== 'https:') {
            throw new SecurityViolationError(
              `Insecure HTTP protocol rejected for external worker "${acquireUrl}"`,
              'INSECURE_PROTOCOL'
            );
          }
        }
      }
      if (!this.allowLocalWorkerHttp && !this.authToken) {
        throw new SecurityViolationError(
          'OFFICIAL_ACQUISITION_WORKER_TOKEN is required for production remote acquisition requests',
          'FORBIDDEN_PROTOCOL'
        );
      }
    } catch (workerSecErr) {
      const diag = classifyNetworkOrHttpError({
        error: workerSecErr,
        requestUrl: acquireUrl,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
      });
      return {
        requestId,
        idempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        methodType,
        endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        failureClassification: 'ACCESS_BLOCKED',
        failureClass: 'SSRF_BLOCKED',
        failureDetails: `Remote worker URL failed security validation: ${(workerSecErr as Error).message}`,
        errorType: 'SSRF_BLOCKED',
        errorCode: 'INVALID_WORKER_URL',
        errorName: 'SecurityViolationError',
        retryable: false,
        runnerUsed: 'REMOTE',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: 'REMOTE_FAILED',
        executionOrigin: defaultOrigin,
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'ACCESS_BLOCKED',
        selectedRunner: 'REMOTE',
        selectionReason: 'Remote worker endpoint failed SSRF/HTTPS validation',
        timestamp: new Date().toISOString(),
      };
    }

    // 4. Execute provider-neutral remote acquisition POST /acquire request
    const workerTotalTimeoutMs = Math.min(timeoutMs * (maxRetries + 1) + 5000, 60000);
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error(`Remote worker timeout after ${workerTotalTimeoutMs}ms`), {
            name: 'TimeoutError',
            code: 'ETIMEDOUT',
          })
        ),
      workerTotalTimeoutMs
    );

    try {
      const bodyPayload = JSON.stringify({
        requestId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        sourceId,
        endpoint,
        purpose: methodType,
        methodType,
        method: request.requestPolicy?.method || 'GET',
        headers: request.requestPolicy?.headers,
        timeout: timeoutMs,
        requestPolicy: {
          method: request.requestPolicy?.method || 'GET',
          headers: request.requestPolicy?.headers,
          maxDownloadBytes,
          maxRedirectHops,
          responseType,
          allowHttp: false,
        },
        timeoutPolicy: {
          timeoutMs,
          connectionTimeoutMs,
        },
        retryPolicy: {
          maxRetries,
          retryBackoffMs: request.retryPolicy?.retryBackoffMs ?? 500,
        },
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Request-Id': requestId,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      };
      if (this.authToken) {
        const ts = String(Date.now());
        const hmac = crypto
          .createHmac('sha256', this.authToken)
          .update(`${ts}.${bodyPayload}`, 'utf8')
          .digest('hex');
        headers['Authorization'] = `Bearer ${this.authToken}`;
        headers['X-Worker-Timestamp'] = ts;
        headers['X-Worker-Signature'] = `sha256=${hmac}`;
      }

      const workerRes = await this.fetchFn(acquireUrl, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers,
        body: bodyPayload,
      });

      clearTimeout(timer);

      let payload: {
        requestId?: string;
        idempotencyKey?: string | null;
        deduplicatedReplay?: boolean;
        status?: 'SUCCESS' | 'FAILED';
        actualRunner?: RunnerKind | string;
        executionEnvironment?: ExecutionEnvironmentKind | string;
        remoteWorkerId?: string;
        workerVersion?: string;
        failureClass?: string;
        failureClassification?: SourceFailureClassification | NetworkErrorClassification | string | 'NONE';
        httpStatus?: number | null;
        finalUrl?: string | null;
        redirectChain?: string[];
        content?: string | null;
        contentBase64?: string | null;
        contentType?: string | null;
        contentLength?: number;
        bytesReceived?: number;
        isPdf?: boolean;
        sha256?: string | null;
        attempts?: number;
        retriesUsed?: number;
        retryReasons?: string[];
        retryDiagnostics?: RetryDiagnosticEntry[];
        attemptDiagnostics?: StructuredFetchDiagnostic[];
        failureDetails?: string | null;
        errorCode?: string | null;
        runnerIdentity?: {
          runnerId: string;
          remoteWorkerId?: string;
          runnerKind: RunnerKind;
          actualRunner?: RunnerKind;
          mode: 'LOCAL_WORKER' | 'PRODUCTION_WORKER' | string;
          executionEnvironment?: ExecutionEnvironmentKind | string;
          version?: string;
          workerVersion?: string;
          host?: string;
        };
        timestamp?: string;
      } | null = null;

      try {
        payload = await workerRes.json();
      } catch {
        payload = null;
      }

      const workerExecEnvRaw =
        payload?.executionEnvironment ??
        payload?.runnerIdentity?.executionEnvironment ??
        (payload?.runnerIdentity?.mode === 'PRODUCTION_WORKER'
          ? 'PRODUCTION_REMOTE'
          : 'LOCAL_WORKER');
      const isGenuineProductionRemote =
        !this.isLocalWorkerEndpoint() &&
        (payload?.actualRunner === 'REMOTE' || payload?.runnerIdentity?.runnerKind === 'REMOTE') &&
        workerExecEnvRaw === 'PRODUCTION_REMOTE';

      const executionOrigin: AcquisitionExecutionOrigin = isGenuineProductionRemote
        ? 'REAL_REMOTE_PRODUCTION'
        : 'REAL_REMOTE_LOCAL_WORKER';
      const runnerClassification: RunnerClassification = isGenuineProductionRemote
        ? 'REMOTE_PRODUCTION'
        : 'REMOTE_LOCAL_WORKER';
      const executionEnvironment: ExecutionEnvironmentKind = isGenuineProductionRemote
        ? 'PRODUCTION_REMOTE'
        : 'LOCAL_WORKER';
      const remoteWorkerId =
        payload?.remoteWorkerId ??
        payload?.runnerIdentity?.remoteWorkerId ??
        payload?.runnerIdentity?.runnerId ??
        null;
      const workerVersion =
        payload?.workerVersion ??
        payload?.runnerIdentity?.workerVersion ??
        payload?.runnerIdentity?.version ??
        null;

      if (!workerRes.ok && !payload) {
        const diag = classifyNetworkOrHttpError({
          httpStatus: workerRes.status,
          requestUrl: endpoint,
          timeoutMs,
          connectionTimeoutMs,
          attempt: 1,
          maxAttempts: 1,
          retryDelayMs: 0,
        });
        return {
          requestId,
          idempotencyKey,
          deduplicatedReplay: false,
          sourceId,
          methodType,
          endpoint,
          finalUrl: null,
          httpStatus: workerRes.status,
          redirectChain: [endpoint],
          content: null,
          binaryContent: null,
          contentType: null,
          responseBytes: 0,
          bytesReceived: 0,
          isPdf: false,
          sha256: null,
          durationMs: Date.now() - startedAt,
          attempts: 1,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [diag],
          failureClassification: diag.errorType,
          failureClass:
            workerRes.status === 401 || workerRes.status === 403 ? 'ACCESS_BLOCKED' : 'HTTP_ERROR',
          failureDetails: `Remote worker returned HTTP ${workerRes.status}`,
          errorType: diag.errorType,
          errorCode: diag.errorCode,
          errorName: diag.errorName,
          retryable: diag.retryable,
          runnerUsed: 'REMOTE',
          runner: 'REMOTE',
          actualRunner: 'REMOTE',
          runnerClassification,
          executionEnvironment,
          remoteWorkerId,
          workerVersion,
          remoteStatus: 'REMOTE_FAILED',
          executionOrigin,
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: mapErrorToRunnerAccessOutcome(diag.errorType, workerRes.status),
          selectedRunner: 'REMOTE',
          selectionReason: `Remote worker HTTP ${workerRes.status}`,
          timestamp: new Date().toISOString(),
        };
      }

      const hasRunnerIdentity =
        payload?.actualRunner === 'REMOTE' ||
        payload?.runnerIdentity?.runnerKind === 'REMOTE';
      const hasValidStatus = payload?.status === 'SUCCESS' || payload?.status === 'FAILED';
      const missingSuccessHttpStatus =
        payload?.status === 'SUCCESS' && typeof payload?.httpStatus !== 'number';

      if (
        !payload ||
        typeof payload !== 'object' ||
        !hasValidStatus ||
        missingSuccessHttpStatus ||
        (workerRes.ok && !hasRunnerIdentity)
      ) {
        const protoErr = Object.assign(
          new Error('Remote worker returned malformed or non-conforming JSON response'),
          { code: 'REMOTE_PROTOCOL_ERROR', name: 'ProtocolError' }
        );
        throw protoErr;
      }

      const redirectChain =
        Array.isArray(payload.redirectChain) && payload.redirectChain.length > 0
          ? payload.redirectChain
          : [endpoint];
      const finalUrl = payload.finalUrl || redirectChain[redirectChain.length - 1] || endpoint;
      const httpStatus = payload.httpStatus ?? (workerRes.ok ? null : workerRes.status);

      // Handle explicit worker failure response (e.g. auth failure, SSRF/redirect block, timeout, invalid PDF)
      if (
        payload.status === 'FAILED' ||
        !workerRes.ok ||
        httpStatus === null ||
        httpStatus < 200 ||
        httpStatus >= 400
      ) {
        const failureClass =
          payload.failureClass ||
          payload.failureClassification ||
          (workerRes.status === 401 || workerRes.status === 403 ? 'ACCESS_BLOCKED' : 'HTTP_ERROR');
        const errType = mapWorkerFailureClassToErrorType(failureClass, httpStatus);
        const diag: StructuredFetchDiagnostic =
          payload.attemptDiagnostics && payload.attemptDiagnostics.length > 0
            ? payload.attemptDiagnostics[payload.attemptDiagnostics.length - 1]
            : classifyNetworkOrHttpError({
                httpStatus,
                error: payload.failureDetails ? new Error(payload.failureDetails) : undefined,
                requestUrl: finalUrl,
                timeoutMs,
                connectionTimeoutMs,
                attempt: payload.attempts || 1,
                maxAttempts: maxRetries + 1,
                retryDelayMs: 0,
              });

        const remoteAccessOutcome: RunnerAccessOutcome =
          failureClass === 'REDIRECT_BLOCKED' ||
          failureClass === 'SSRF_BLOCKED' ||
          failureClass === 'ACCESS_BLOCKED'
            ? 'ACCESS_BLOCKED'
            : mapErrorToRunnerAccessOutcome(errType, httpStatus);

        const failedResult: AcquisitionResult = {
          requestId: payload.requestId || requestId,
          idempotencyKey: payload.idempotencyKey ?? idempotencyKey,
          deduplicatedReplay: Boolean(payload.deduplicatedReplay),
          sourceId,
          methodType,
          endpoint,
          finalUrl,
          httpStatus,
          redirectChain,
          content: null,
          binaryContent: null,
          contentType: payload.contentType ?? null,
          responseBytes: 0,
          bytesReceived: payload.bytesReceived ?? 0,
          isPdf: Boolean(payload.isPdf),
          sha256: payload.sha256 ?? null,
          durationMs: Date.now() - startedAt,
          attempts: payload.attempts ?? 1,
          retriesUsed: payload.retriesUsed ?? 0,
          retryReasons: payload.retryReasons ?? [],
          retryDiagnostics: payload.retryDiagnostics ?? [],
          attemptDiagnostics:
            payload.attemptDiagnostics && payload.attemptDiagnostics.length > 0
              ? payload.attemptDiagnostics
              : [diag],
          failureClassification: failureClass,
          failureClass,
          failureDetails: payload.failureDetails || diag.errorMessage,
          errorType: errType,
          errorCode: payload.errorCode || diag.errorCode || failureClass,
          errorName: diag.errorName,
          retryable: diag.retryable,
          runnerUsed: 'REMOTE',
          runner: 'REMOTE',
          actualRunner: 'REMOTE',
          runnerClassification,
          executionEnvironment,
          remoteWorkerId,
          workerVersion,
          remoteStatus: 'REMOTE_FAILED',
          executionOrigin,
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: remoteAccessOutcome,
          selectedRunner: 'REMOTE',
          selectionReason: `Remote worker reported failure (${failureClass})`,
          runnerIdentity: payload.runnerIdentity,
          timestamp: payload.timestamp || new Date().toISOString(),
        };

        logger.info('REMOTE_ACQUISITION_OBSERVABILITY', {
          requestId: failedResult.requestId,
          sourceId: failedResult.sourceId,
          endpoint: failedResult.endpoint,
          workerVersion: failedResult.workerVersion,
          executionEnvironment: failedResult.executionEnvironment,
          attempts: failedResult.attempts,
          durationMs: failedResult.durationMs,
          httpStatus: failedResult.httpStatus,
          failureClass: failedResult.failureClass,
          bytesReceived: failedResult.bytesReceived ?? 0,
          timestamp: failedResult.timestamp,
        });

        return failedResult;
      }

      // 5. Post-validate every redirect hop and finalUrl returned by the remote worker!
      if (redirectChain.length - 1 > maxRedirectHops) {
        throw new IngestionError(
          `Remote worker redirect chain (${redirectChain.length - 1} hops) exceeded limit (${maxRedirectHops})`,
          'SSRF_BLOCKED',
          { errorCode: 'REDIRECT_LIMIT_EXCEEDED' },
          false
        );
      }

      for (const hopUrl of [...redirectChain, finalUrl]) {
        await enforceOfficialAcquisitionSecurity(hopUrl, sourceId, {
          allowHttp: false,
          skipDnsLookup: true,
        });
      }

      let content: string | null = null;
      let binaryContent: Buffer | null = null;
      let responseBytes = 0;

      if (responseType === 'BINARY' || payload.isPdf || payload.contentBase64) {
        if (payload.contentBase64) {
          binaryContent = Buffer.from(payload.contentBase64, 'base64');
        } else if (payload.content) {
          binaryContent = Buffer.from(payload.content, 'binary');
        } else {
          binaryContent = Buffer.alloc(0);
        }
        responseBytes = binaryContent.length;
      } else {
        content = payload.content ?? '';
        responseBytes = Buffer.byteLength(content, 'utf8');
      }

      if (responseBytes > maxDownloadBytes) {
        throw new IngestionError(
          `Remote worker response size (${responseBytes} bytes) exceeds limit (${maxDownloadBytes} bytes)`,
          'DOWNLOAD_FAILED',
          { responseBytes, maxDownloadBytes, errorCode: 'MAX_SIZE_EXCEEDED' },
          false
        );
      }

      const cleanMime = payload.contentType
        ? payload.contentType.split(';')[0].trim().toLowerCase()
        : responseType === 'BINARY'
        ? 'application/pdf'
        : 'text/html';

      if (responseType === 'TEXT' && payload.contentType && !ALLOWED_LISTING_MIMES.includes(cleanMime)) {
        throw new IngestionError(
          `Unexpected Content-Type "${cleanMime}" from remote worker for listing endpoint ${finalUrl}`,
          'EXTRACTION_FAILED',
          { contentType: cleanMime, errorCode: 'CONTENT_TYPE_INVALID' },
          false
        );
      }

      const sha256 =
        payload.sha256 ||
        (binaryContent
          ? crypto.createHash('sha256').update(binaryContent).digest('hex')
          : content !== null
          ? crypto.createHash('sha256').update(content, 'utf8').digest('hex')
          : null);

      const successResult: AcquisitionResult = {
        requestId: payload.requestId || requestId,
        idempotencyKey: payload.idempotencyKey ?? idempotencyKey,
        deduplicatedReplay: Boolean(payload.deduplicatedReplay),
        sourceId,
        methodType,
        endpoint,
        finalUrl,
        httpStatus,
        redirectChain,
        content,
        binaryContent,
        contentType: cleanMime,
        responseBytes,
        bytesReceived: payload.bytesReceived ?? responseBytes,
        isPdf: Boolean(payload.isPdf ?? responseType === 'BINARY'),
        sha256,
        durationMs: Date.now() - startedAt,
        attempts: payload.attempts || 1,
        retriesUsed: payload.retriesUsed || 0,
        retryReasons: payload.retryReasons || [],
        retryDiagnostics: payload.retryDiagnostics || [],
        attemptDiagnostics: payload.attemptDiagnostics || [],
        failureClassification: 'NONE',
        failureClass: 'SUCCESS',
        failureDetails: null,
        errorType: null,
        errorCode: null,
        errorName: null,
        retryable: false,
        runnerUsed: 'REMOTE',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        runnerClassification,
        executionEnvironment,
        remoteWorkerId,
        workerVersion,
        remoteStatus: 'REMOTE_EXECUTED',
        executionOrigin,
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'SUCCESS',
        selectedRunner: 'REMOTE',
        selectionReason: `Remote official acquisition worker succeeded (${executionOrigin})`,
        runnerIdentity: payload.runnerIdentity,
        timestamp: payload.timestamp || new Date().toISOString(),
      };

      logger.info('REMOTE_ACQUISITION_OBSERVABILITY', {
        requestId: successResult.requestId,
        sourceId: successResult.sourceId,
        endpoint: successResult.endpoint,
        workerVersion: successResult.workerVersion,
        executionEnvironment: successResult.executionEnvironment,
        attempts: successResult.attempts,
        durationMs: successResult.durationMs,
        httpStatus: successResult.httpStatus,
        failureClass: successResult.failureClass,
        bytesReceived: successResult.bytesReceived ?? 0,
        timestamp: successResult.timestamp,
      });

      return successResult;
    } catch (err) {
      clearTimeout(timer);
      const isProtocolError = (err as { code?: string })?.code === 'REMOTE_PROTOCOL_ERROR';
      const diag = classifyNetworkOrHttpError({
        error: err,
        requestUrl: endpoint,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts: maxRetries + 1,
        retryDelayMs: 0,
      });
      const isSsrf =
        err instanceof SecurityViolationError ||
        (err instanceof IngestionError && err.code === 'SSRF_BLOCKED');
      return {
        requestId,
        idempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        methodType,
        endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        durationMs: Date.now() - startedAt,
        attempts: 1,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        failureClassification: isSsrf ? 'ACCESS_BLOCKED' : diag.errorType,
        failureClass: isSsrf ? 'SSRF_BLOCKED' : 'UNKNOWN',
        failureDetails: (err as Error).message,
        errorType: isSsrf ? 'SSRF_BLOCKED' : diag.errorType,
        errorCode: isProtocolError ? 'REMOTE_PROTOCOL_ERROR' : diag.errorCode,
        errorName: diag.errorName,
        retryable: false,
        runnerUsed: 'REMOTE',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: isSsrf || isProtocolError ? 'REMOTE_FAILED' : 'REMOTE_UNAVAILABLE',
        executionOrigin: defaultOrigin,
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: isSsrf ? 'ACCESS_BLOCKED' : 'UNREACHABLE',
        selectedRunner: 'REMOTE',
        selectionReason: `Remote acquisition worker unreachable or failed: ${(err as Error).message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

/**
 * Validates any custom/injected remote runner result against the exact same security invariants
 * (HTTPS only, official domain allowlist, SSRF protection on target URL and redirect chain,
 * max redirect hops, max response bytes, and listing Content-Type).
 */
export async function validateRunnerResultSecurity(
  request: AcquisitionRequest,
  result: AcquisitionResult,
  runner: OfficialAcquisitionRunner
): Promise<AcquisitionResult> {
  const { sourceId, endpoint, methodType } = request;
  const responseType =
    request.requestPolicy?.responseType ??
    (methodType === 'DOCUMENT_PDF' ? 'BINARY' : 'TEXT');
  const maxDownloadBytes =
    request.requestPolicy?.maxDownloadBytes ??
    (responseType === 'BINARY' ? 26214400 : 10 * 1024 * 1024);
  const maxRedirectHops = request.requestPolicy?.maxRedirectHops ?? 3;

  const computeHonestOrigin = (): AcquisitionExecutionOrigin => {
    if (runner.isMock) return 'MOCK_REMOTE';
    if (runner.runnerKind === 'REMOTE') {
      if (
        result.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
        result.executionOrigin === 'REAL_REMOTE_PRODUCTION'
      ) {
        return result.executionOrigin;
      }
      return 'REAL_LIVE_REMOTE';
    }
    return 'REAL_LIVE_LOCAL';
  };

  try {
    // 1. Validate requested endpoint
    await enforceOfficialAcquisitionSecurity(endpoint, sourceId, { allowHttp: false });

    // 2. Validate redirect chain & finalUrl
    const redirectChain =
      Array.isArray(result.redirectChain) && result.redirectChain.length > 0
        ? result.redirectChain
        : [endpoint];

    if (redirectChain.length - 1 > maxRedirectHops) {
      throw new IngestionError(
        `Exceeded redirect limit of ${maxRedirectHops}`,
        'SSRF_BLOCKED',
        { errorCode: 'REDIRECT_LIMIT_EXCEEDED' },
        false
      );
    }

    const urlsToVerify = [...redirectChain];
    if (result.finalUrl && !urlsToVerify.includes(result.finalUrl)) {
      urlsToVerify.push(result.finalUrl);
    }

    for (const hopUrl of urlsToVerify) {
      await enforceOfficialAcquisitionSecurity(hopUrl, sourceId, { allowHttp: false });
    }

    // 3. Enforce maxDownloadBytes on successful responses
    const actualBytes =
      result.binaryContent
        ? result.binaryContent.length
        : result.content
        ? Buffer.byteLength(result.content, 'utf8')
        : result.responseBytes || 0;

    if (actualBytes > maxDownloadBytes) {
      throw new IngestionError(
        `Response size (${actualBytes} bytes) exceeds limit (${maxDownloadBytes} bytes)`,
        'DOWNLOAD_FAILED',
        { actualBytes, maxDownloadBytes, errorCode: 'MAX_SIZE_EXCEEDED' },
        false
      );
    }

    // 4. Enforce listing Content-Type if TEXT
    if (
      responseType === 'TEXT' &&
      result.httpStatus &&
      result.httpStatus >= 200 &&
      result.httpStatus < 300 &&
      result.contentType
    ) {
      const cleanMime = result.contentType.split(';')[0].trim().toLowerCase();
      if (!ALLOWED_LISTING_MIMES.includes(cleanMime)) {
        throw new IngestionError(
          `Unexpected Content-Type "${cleanMime}" from endpoint ${result.finalUrl || endpoint}`,
          'EXTRACTION_FAILED',
          { contentType: cleanMime, errorCode: 'CONTENT_TYPE_INVALID' },
          false
        );
      }
    }

    const honestOrigin = computeHonestOrigin();
    const isSuccess =
      result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 400;
    const computedClassification: RunnerClassification =
      result.runnerClassification ??
      (runner.runnerKind === 'LOCAL'
        ? 'LOCAL'
        : honestOrigin === 'REAL_REMOTE_PRODUCTION'
        ? 'REMOTE_PRODUCTION'
        : 'REMOTE_LOCAL_WORKER');
    const computedExecEnv: ExecutionEnvironmentKind =
      result.executionEnvironment ??
      (runner.runnerKind === 'LOCAL'
        ? 'LOCAL'
        : honestOrigin === 'REAL_REMOTE_PRODUCTION'
        ? 'PRODUCTION_REMOTE'
        : 'LOCAL_WORKER');

    return {
      ...result,
      runnerUsed: runner.runnerKind,
      runner: runner.runnerKind,
      actualRunner: runner.runnerKind,
      runnerClassification: computedClassification,
      executionEnvironment: computedExecEnv,
      remoteStatus:
        result.remoteStatus ??
        (runner.runnerKind === 'REMOTE'
          ? isSuccess
            ? 'REMOTE_EXECUTED'
            : 'REMOTE_FAILED'
          : undefined),
      executionOrigin: honestOrigin,
    };
  } catch (secErr) {
    const isContentTypeErr =
      secErr instanceof IngestionError && secErr.code === 'EXTRACTION_FAILED';
    const isSizeErr =
      secErr instanceof IngestionError && secErr.code === 'DOWNLOAD_FAILED';
    const errType: NetworkErrorClassification = isContentTypeErr || isSizeErr
      ? 'HTTP_4XX'
      : 'SSRF_BLOCKED';
    const errCode =
      (secErr as IngestionError & { details?: { errorCode?: string } })?.details?.errorCode ||
      (secErr as IngestionError).code ||
      'SSRF_BLOCKED';
    const diag: StructuredFetchDiagnostic = {
      attempt: 1,
      maxAttempts: 1,
      errorType: errType,
      errorCode: errCode,
      errorName: (secErr as Error).name || 'SecurityViolationError',
      errorMessage: (secErr as Error).message,
      cause: null,
      requestUrl: endpoint,
      hostname: (() => {
        try {
          return new URL(endpoint).hostname;
        } catch {
          return null;
        }
      })(),
      httpStatus: null,
      timeoutMs: request.timeoutPolicy.timeoutMs,
      connectionTimeoutMs: request.timeoutPolicy.connectionTimeoutMs,
      timeoutStage: null,
      retryable: false,
      retryDelayMs: 0,
      reason: errType,
      statusCode: null,
      delayMs: 0,
    };

    const honestOrigin = computeHonestOrigin();

    return {
      sourceId,
      methodType,
      endpoint,
      finalUrl: null,
      httpStatus: null,
      redirectChain: result.redirectChain || [endpoint],
      content: null,
      binaryContent: null,
      contentType: null,
      responseBytes: 0,
      durationMs: result.durationMs || 0,
      attempts: Math.max(1, result.attempts || 1),
      retriesUsed: result.retriesUsed || 0,
      retryReasons: result.retryReasons || [],
      retryDiagnostics: result.retryDiagnostics || [],
      attemptDiagnostics: [diag],
      failureClassification: isContentTypeErr ? 'PARSER_FAILURE' : 'ACCESS_BLOCKED',
      failureClass: isSizeErr
        ? 'MAX_SIZE_EXCEEDED'
        : isContentTypeErr
        ? 'CONTENT_TYPE_INVALID'
        : 'SSRF_BLOCKED',
      failureDetails: (secErr as Error).message,
      errorType: errType,
      errorCode: errCode,
      errorName: diag.errorName,
      retryable: false,
      runnerUsed: runner.runnerKind,
      runner: runner.runnerKind,
      actualRunner: runner.runnerKind,
      remoteStatus: runner.runnerKind === 'REMOTE' ? 'REMOTE_FAILED' : result.remoteStatus,
      executionOrigin: honestOrigin,
      localAccess: runner.runnerKind === 'LOCAL' ? 'ACCESS_BLOCKED' : result.localAccess,
      remoteAccess: runner.runnerKind === 'REMOTE' ? 'ACCESS_BLOCKED' : result.remoteAccess,
      selectedRunner: runner.runnerKind,
      selectionReason: `Blocked by centralized acquisition security policy: ${(secErr as Error).message}`,
    };
  }
}

/**
 * Coordinates LOCAL, REMOTE, and AUTO runner modes with per-source access telemetry
 * and strict security validation.
 */
export class AcquisitionRunnerCoordinator {
  private mode: RunnerMode;
  private localRunner: OfficialAcquisitionRunner;
  private remoteRunner: OfficialAcquisitionRunner;
  private knownInaccessibleLocalSources: Set<string> = new Set();

  constructor(options: {
    mode?: RunnerMode;
    localRunner?: OfficialAcquisitionRunner;
    remoteRunner?: OfficialAcquisitionRunner;
  } = {}) {
    this.mode = options.mode ?? resolveRunnerMode();
    this.localRunner = options.localRunner ?? new LocalAcquisitionRunner();
    this.remoteRunner = options.remoteRunner ?? new HttpRemoteAcquisitionRunner();
  }

  getMode(): RunnerMode {
    return this.mode;
  }

  getLocalRunner(): OfficialAcquisitionRunner {
    return this.localRunner;
  }

  getRemoteRunner(): OfficialAcquisitionRunner {
    return this.remoteRunner;
  }

  markSourceLocallyInaccessible(sourceId: string): void {
    this.knownInaccessibleLocalSources.add(sourceId);
  }

  async execute(request: AcquisitionRequest): Promise<AcquisitionResult> {
    // Pre-validate official domain and SSRF before any runner executes
    try {
      await enforceOfficialAcquisitionSecurity(request.endpoint, request.sourceId, {
        allowHttp: request.requestPolicy?.allowHttp ?? false,
      });
    } catch (secErr) {
      const diag = classifyNetworkOrHttpError({
        error: secErr,
        requestUrl: request.endpoint,
        timeoutMs: request.timeoutPolicy.timeoutMs,
        connectionTimeoutMs: request.timeoutPolicy.connectionTimeoutMs,
        attempt: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
      });
      return {
        sourceId: request.sourceId,
        methodType: request.methodType,
        endpoint: request.endpoint,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [request.endpoint],
        content: null,
        binaryContent: null,
        contentType: null,
        responseBytes: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        failureClassification: 'ACCESS_BLOCKED',
        failureClass: 'SSRF_BLOCKED',
        failureDetails: (secErr as Error).message,
        errorType: diag.errorType,
        errorCode: diag.errorCode,
        errorName: diag.errorName,
        retryable: false,
        runnerUsed: this.mode === 'REMOTE' ? 'REMOTE' : 'LOCAL',
        runner: this.mode === 'REMOTE' ? 'REMOTE' : 'LOCAL',
        actualRunner: this.mode === 'REMOTE' ? 'REMOTE' : 'LOCAL',
        remoteStatus: this.mode === 'REMOTE' ? 'REMOTE_FAILED' : 'REMOTE_NOT_CONFIGURED',
        executionOrigin:
          this.mode === 'REMOTE'
            ? this.remoteRunner.isMock
              ? 'MOCK_REMOTE'
              : 'REAL_LIVE_REMOTE'
            : 'REAL_LIVE_LOCAL',
        localAccess: this.mode === 'REMOTE' ? 'NOT_ATTEMPTED' : 'ACCESS_BLOCKED',
        remoteAccess: this.mode === 'REMOTE' ? 'ACCESS_BLOCKED' : 'NOT_ATTEMPTED',
        selectedRunner: this.mode === 'REMOTE' ? 'REMOTE' : 'LOCAL',
        selectionReason: `Rejected by official domain / SSRF policy: ${(secErr as Error).message}`,
      };
    }

    // Mode 1: LOCAL
    if (this.mode === 'LOCAL') {
      const localRes = await this.localRunner.acquire(request);
      const validated = await validateRunnerResultSecurity(request, localRes, this.localRunner);
      return {
        ...validated,
        runner: 'LOCAL',
        actualRunner: 'LOCAL',
        remoteStatus: this.remoteRunner.isConfigured() ? 'REMOTE_UNAVAILABLE' : 'REMOTE_NOT_CONFIGURED',
        localAccess: validated.localAccess,
        remoteAccess: this.remoteRunner.isConfigured() ? 'NOT_ATTEMPTED' : 'NOT_CONFIGURED',
        selectedRunner: 'LOCAL',
        selectionReason:
          validated.localAccess === 'SUCCESS'
            ? 'RUNNER_MODE=LOCAL: local runtime succeeded'
            : `RUNNER_MODE=LOCAL: local runtime failed (${validated.localAccess})`,
      };
    }

    // Mode 2: REMOTE
    if (this.mode === 'REMOTE') {
      if (!this.remoteRunner.isConfigured()) {
        return {
          sourceId: request.sourceId,
          methodType: request.methodType,
          endpoint: request.endpoint,
          finalUrl: null,
          httpStatus: null,
          redirectChain: [request.endpoint],
          content: null,
          binaryContent: null,
          contentType: null,
          responseBytes: 0,
          durationMs: 0,
          attempts: 0,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          failureClassification: 'NETWORK_UNREACHABLE',
          failureClass: 'UNKNOWN',
          failureDetails: 'RUNNER_MODE=REMOTE requested, but remote acquisition runner is not configured',
          errorType: 'NETWORK_UNAVAILABLE',
          errorCode: 'REMOTE_RUNNER_NOT_CONFIGURED',
          errorName: 'ConfigurationError',
          retryable: false,
          runnerUsed: 'REMOTE',
          runner: 'REMOTE',
          actualRunner: 'REMOTE',
          remoteStatus: 'REMOTE_NOT_CONFIGURED',
          executionOrigin: this.remoteRunner.isMock ? 'MOCK_REMOTE' : 'REAL_LIVE_REMOTE',
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: 'NOT_CONFIGURED',
          selectedRunner: 'REMOTE',
          selectionReason: 'RUNNER_MODE=REMOTE requested, but remote acquisition runner is not configured',
        };
      }

      const remoteRes = await this.remoteRunner.acquire(request);
      const validated = await validateRunnerResultSecurity(request, remoteRes, this.remoteRunner);
      return {
        ...validated,
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus:
          validated.remoteStatus ??
          (validated.remoteAccess === 'SUCCESS'
            ? 'REMOTE_EXECUTED'
            : validated.remoteAccess === 'UNREACHABLE'
            ? 'REMOTE_UNAVAILABLE'
            : 'REMOTE_FAILED'),
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: validated.remoteAccess,
        selectedRunner: 'REMOTE',
        selectionReason:
          validated.remoteAccess === 'SUCCESS'
            ? 'RUNNER_MODE=REMOTE: remote official acquisition runner succeeded'
            : `RUNNER_MODE=REMOTE: remote official acquisition runner failed (${validated.remoteAccess})`,
      };
    }

    // Mode 3: AUTO
    // Section 7 & 11:
    // - If remote worker is NOT configured: report REMOTE_NOT_CONFIGURED and use LOCAL.
    // - If remote worker IS configured: prefer REMOTE when configured and healthy; if REMOTE fails or is unreachable,
    //   apply fallback to LOCAL while preserving evidence that REMOTE failed (and never silently report LOCAL execution as REMOTE).
    if (!this.remoteRunner.isConfigured()) {
      const localRes = await this.localRunner.acquire(request);
      const validatedLocal = await validateRunnerResultSecurity(request, localRes, this.localRunner);
      return {
        ...validatedLocal,
        runner: 'LOCAL',
        actualRunner: 'LOCAL',
        remoteStatus: 'REMOTE_NOT_CONFIGURED',
        localAccess: validatedLocal.localAccess,
        remoteAccess: 'NOT_CONFIGURED',
        selectedRunner: 'LOCAL',
        selectionReason:
          validatedLocal.localAccess === 'SUCCESS'
            ? 'RUNNER_MODE=AUTO: remote worker not configured (REMOTE_NOT_CONFIGURED); local runtime succeeded'
            : `RUNNER_MODE=AUTO: remote worker not configured (REMOTE_NOT_CONFIGURED); local runtime failed (${validatedLocal.localAccess})`,
      };
    }

    // Remote runner IS configured: attempt REMOTE first
    const remoteRes = await this.remoteRunner.acquire(request);
    const validatedRemote = await validateRunnerResultSecurity(request, remoteRes, this.remoteRunner);

    if (validatedRemote.remoteAccess === 'SUCCESS') {
      return {
        ...validatedRemote,
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: 'REMOTE_EXECUTED',
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'SUCCESS',
        selectedRunner: 'REMOTE',
        selectionReason: 'RUNNER_MODE=AUTO: remote official acquisition worker succeeded',
      };
    }

    // Do not fall back to LOCAL if the request was blocked by security/SSRF/domain policy
    if (validatedRemote.remoteAccess === 'ACCESS_BLOCKED') {
      return {
        ...validatedRemote,
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        remoteStatus: 'REMOTE_FAILED',
        localAccess: 'NOT_ATTEMPTED',
        remoteAccess: 'ACCESS_BLOCKED',
        selectedRunner: 'REMOTE',
        selectionReason: 'RUNNER_MODE=AUTO: request blocked by security policy on remote runner',
      };
    }

    const remoteFailureStatus: RemoteExecutionState =
      validatedRemote.remoteStatus === 'REMOTE_UNAVAILABLE' ||
      validatedRemote.remoteAccess === 'UNREACHABLE'
        ? 'REMOTE_UNAVAILABLE'
        : 'REMOTE_FAILED';

    logger.info('AUTO_RUNNER_REMOTE_FAILED_FALLING_BACK_TO_LOCAL', {
      sourceId: request.sourceId,
      endpoint: request.endpoint,
      remoteAccess: validatedRemote.remoteAccess,
      remoteStatus: remoteFailureStatus,
    });

    const localRes = await this.localRunner.acquire(request);
    const validatedLocal = await validateRunnerResultSecurity(request, localRes, this.localRunner);

    if (validatedLocal.localAccess === 'SUCCESS') {
      // Crucial Section 6 & 7 rule: Do NOT silently report LOCAL execution as REMOTE!
      // Report actualRunner = 'LOCAL', runnerClassification = 'REMOTE_FALLBACK', while preserving remoteStatus = 'REMOTE_UNAVAILABLE' | 'REMOTE_FAILED'.
      return {
        ...validatedLocal,
        runnerUsed: 'LOCAL',
        runner: 'LOCAL',
        actualRunner: 'LOCAL',
        runnerClassification: 'REMOTE_FALLBACK',
        executionEnvironment: 'LOCAL',
        selectedRunner: 'LOCAL',
        executionOrigin: 'REAL_LIVE_LOCAL',
        remoteStatus: remoteFailureStatus,
        localAccess: 'SUCCESS',
        remoteAccess: validatedRemote.remoteAccess,
        selectionReason: `RUNNER_MODE=AUTO: remote worker failed (${remoteFailureStatus}: ${validatedRemote.remoteAccess}); fell back to LOCAL runner which succeeded`,
      };
    }

    this.knownInaccessibleLocalSources.add(request.sourceId);

    return {
      ...validatedRemote,
      runnerUsed: 'LOCAL',
      runner: 'LOCAL',
      actualRunner: 'LOCAL',
      runnerClassification: 'REMOTE_FALLBACK',
      executionEnvironment: 'LOCAL',
      selectedRunner: 'REMOTE',
      remoteStatus: remoteFailureStatus,
      localAccess: validatedLocal.localAccess,
      remoteAccess: validatedRemote.remoteAccess,
      selectionReason: `RUNNER_MODE=AUTO: remote worker failed (${remoteFailureStatus}: ${validatedRemote.remoteAccess}) and local fallback failed (${validatedLocal.localAccess})`,
    };
  }
}
