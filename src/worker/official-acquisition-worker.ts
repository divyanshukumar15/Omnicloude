/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  OFFICIAL_SOURCE_DOMAINS,
  getAllowedDomainsForSource,
  getAllOfficialDomains,
} from '../backend/ingestion/discovery/official-domains.ts';
import {
  RRB_REGIONAL_PROBE_BOARDS,
} from '../backend/ingestion/discovery/connectivity-diagnostics.ts';
import {
  isPrivateIpv4,
  isPrivateIpv6,
  SecurityViolationError,
} from '../backend/security/url-security.ts';
import {
  classifyNetworkOrHttpError,
  type NetworkErrorClassification,
  type StructuredFetchDiagnostic,
} from '../backend/ingestion/discovery/network-error-classifier.ts';
import {
  configureGlobalFetchDispatcher,
  resolveConnectionTimeoutMs,
} from '../backend/ingestion/discovery/http-dispatcher.ts';
import type { RetryDiagnosticEntry } from '../backend/ingestion/discovery/types.ts';
import { logger } from '../backend/config/logger.ts';

export const WORKER_SERVICE_VERSION = '1.0.0';

export type WorkerFailureClass =
  | 'SUCCESS'
  | 'TIMEOUT'
  | 'DNS_FAILURE'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'TLS_FAILURE'
  | 'HTTP_ERROR'
  | 'ACCESS_BLOCKED'
  | 'REDIRECT_BLOCKED'
  | 'SSRF_BLOCKED'
  | 'CONTENT_TYPE_INVALID'
  | 'MAX_SIZE_EXCEEDED'
  | 'INVALID_PDF'
  | 'RESPONSE_STRUCTURE_UNEXPECTED'
  | 'AUTH_FAILED'
  | 'PROTOCOL_ERROR'
  | 'WORKER_ERROR'
  | 'UNKNOWN';

export type WorkerAcquisitionPurpose = 'LISTING' | 'DETAIL' | 'DOCUMENT_PDF' | 'PROBE';

export type WorkerExecutionEnvironment = 'LOCAL_WORKER' | 'PRODUCTION_REMOTE';

export interface WorkerRunnerIdentity {
  runnerId: string;
  workerId: string;
  remoteWorkerId: string;
  runnerKind: 'REMOTE';
  actualRunner: 'REMOTE';
  mode: 'LOCAL_WORKER' | 'PRODUCTION_WORKER';
  executionEnvironment: WorkerExecutionEnvironment;
  version: string;
  workerVersion: string;
  host: string;
}

export interface WorkerAcquireRequest {
  requestId?: string;
  idempotencyKey?: string;
  sourceId: string;
  endpoint: string;
  method?: 'GET' | 'POST' | string;
  headers?: Record<string, string>;
  acquisitionType?: WorkerAcquisitionPurpose | string;
  purpose?: WorkerAcquisitionPurpose | string;
  methodType?: WorkerAcquisitionPurpose | string;
  timeout?: number;
  timeoutPolicy?: {
    timeoutMs?: number;
    connectionTimeoutMs?: number;
  };
  retryPolicy?: {
    maxRetries?: number;
    retryBackoffMs?: number;
  };
  requestPolicy?: {
    method?: 'GET' | 'POST' | string;
    headers?: Record<string, string>;
    maxDownloadBytes?: number;
    maxRedirectHops?: number;
    expectedContentType?: string;
    responseType?: 'TEXT' | 'BINARY';
    allowHttp?: boolean;
  };
}

export interface WorkerAcquireResponse {
  executionId: string;
  requestId: string;
  idempotencyKey: string | null;
  deduplicatedReplay: boolean;
  sourceId: string;
  endpoint: string;
  status: 'SUCCESS' | 'FAILED';
  runner: 'REMOTE';
  actualRunner: 'REMOTE';
  executionEnvironment: WorkerExecutionEnvironment;
  workerId: string;
  remoteWorkerId: string;
  workerVersion: string;
  failureClass: WorkerFailureClass;
  failureClassification: WorkerFailureClass;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: string[];
  contentType: string | null;
  contentLength: number;
  durationMs: number;
  attempts: number;
  retriesUsed: number;
  retryReasons: string[];
  retryDiagnostics: RetryDiagnosticEntry[];
  attemptDiagnostics: StructuredFetchDiagnostic[];
  bytesReceived: number;
  isPdf: boolean;
  sha256: string | null;
  content: string | null;
  contentBase64: string | null;
  runnerIdentity: WorkerRunnerIdentity;
  startedAt: string;
  completedAt: string;
  timestamp: string;
  failureDetails: string | null;
  errorCode: string | null;
}

export interface OfficialAcquisitionWorkerConfig {
  token?: string;
  port?: number;
  host?: string;
  maxResponseMb?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConcurrency?: number;
  idempotencyTtlMs?: number;
  workerId?: string;
  remoteWorkerId?: string;
  version?: string;
  workerMode?: 'LOCAL_WORKER' | 'PRODUCTION_WORKER';
  executionEnvironment?: WorkerExecutionEnvironment;
  /**
   * Optional DNS lookup override for deterministic security/rebinding tests.
   */
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Optional test-only upstream origin map (e.g., mapping verified https://bpsc.bih.nic.in
   * to a local test HTTP upstream server AFTER all domain/HTTPS/DNS/SSRF checks succeed).
   */
  testUpstreamOriginMap?: Record<string, string>;
}

const ALLOWED_SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'pragma',
  'referer',
  'user-agent',
]);

const FORBIDDEN_UNSAFE_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-worker-signature',
  'x-worker-timestamp',
  'transfer-encoding',
  'content-length',
  'connection',
  'upgrade',
]);

const VALID_ACQUISITION_TYPES = new Set<WorkerAcquisitionPurpose>([
  'LISTING',
  'DETAIL',
  'DOCUMENT_PDF',
  'PROBE',
]);

const ALLOWED_LISTING_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
]);

const ALLOWED_PDF_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/octet-stream',
  'binary/octet-stream',
]);

/**
 * Checks whether a buffer starts with `%PDF-` magic bytes (0x25 0x50 0x44 0x46 0x2D).
 */
export function hasPdfMagicBytes(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 5) return false;
  return (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  );
}

/**
 * Detects HTML disguised as a PDF response.
 */
export function isDisguisedHtml(buffer: Buffer): boolean {
  if (!buffer || buffer.length === 0) return false;
  const head = buffer
    .subarray(0, Math.min(buffer.length, 512))
    .toString('utf8')
    .trim()
    .toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    head.includes('<html')
  );
}

/**
 * Constant-time token/signature comparison to prevent timing side-channel attacks.
 */
export function safeCompareStrings(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Maps low-level network/HTTP classifications into explicit WorkerFailureClass values.
 */
export function mapToWorkerFailureClass(
  errorType: NetworkErrorClassification | string | null,
  httpStatus: number | null,
  errorCode?: string | null
): WorkerFailureClass {
  if (
    errorCode === 'REDIRECT_DOMAIN_NOT_ALLOWED' ||
    errorCode === 'REDIRECT_LIMIT_EXCEEDED' ||
    errorCode === 'REDIRECT_BLOCKED'
  ) {
    return 'REDIRECT_BLOCKED';
  }
  if (errorCode === 'DOMAIN_NOT_ALLOWED' || errorCode === 'SOURCE_NOT_REGISTERED') {
    return 'ACCESS_BLOCKED';
  }
  if (
    errorType === 'SSRF_BLOCKED' ||
    errorCode?.startsWith('SSRF_') ||
    errorCode === 'FORBIDDEN_PROTOCOL' ||
    errorCode === 'INSECURE_PROTOCOL'
  ) {
    return 'SSRF_BLOCKED';
  }
  if (errorCode === 'MAX_SIZE_EXCEEDED') {
    return 'MAX_SIZE_EXCEEDED';
  }
  if (errorCode === 'CONTENT_TYPE_INVALID' || errorCode === 'DISALLOWED_MIME_TYPE') {
    return 'CONTENT_TYPE_INVALID';
  }
  if (errorCode === 'INVALID_PDF' || errorCode === 'INVALID_MAGIC_BYTES') {
    return 'INVALID_PDF';
  }
  if (errorType === 'TIMEOUT') return 'TIMEOUT';
  if (
    errorType === 'DNS_ERROR' ||
    errorCode === 'DNS_RESOLUTION_FAILED' ||
    errorCode === 'DNS_RESOLUTION_EMPTY'
  ) {
    return 'DNS_FAILURE';
  }
  if (errorType === 'CONNECTION_RESET') return 'CONNECTION_RESET';
  if (errorType === 'CONNECTION_REFUSED') return 'CONNECTION_REFUSED';
  if (errorType === 'TLS_ERROR') return 'TLS_FAILURE';
  if (errorType === 'HTTP_403' || httpStatus === 401 || httpStatus === 403) {
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
  return 'UNKNOWN';
}

export function resolveWorkerRuntimeConfig(
  overrides: OfficialAcquisitionWorkerConfig = {}
): Required<
  Pick<
    OfficialAcquisitionWorkerConfig,
    | 'port'
    | 'host'
    | 'maxResponseMb'
    | 'requestTimeoutMs'
    | 'connectTimeoutMs'
    | 'maxRetries'
    | 'retryBackoffMs'
    | 'maxConcurrency'
    | 'idempotencyTtlMs'
    | 'workerId'
    | 'version'
    | 'workerMode'
    | 'executionEnvironment'
  >
> & {
  token: string;
  dnsLookup?: OfficialAcquisitionWorkerConfig['dnsLookup'];
  testUpstreamOriginMap?: Record<string, string>;
} {
  const token = (
    overrides.token ??
    process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN ??
    process.env.OMNIHUB_REMOTE_WORKER_TOKEN ??
    ''
  ).trim();

  const port = Number(overrides.port ?? process.env.WORKER_PORT ?? 8080) || 8080;
  const host = (overrides.host ?? process.env.WORKER_HOST ?? '0.0.0.0').trim() || '0.0.0.0';
  const maxResponseMb = Math.min(
    Math.max(1, Number(overrides.maxResponseMb ?? process.env.WORKER_MAX_RESPONSE_MB ?? 25) || 25),
    50
  );
  const requestTimeoutMs = Math.min(
    Math.max(
      100,
      Number(overrides.requestTimeoutMs ?? process.env.WORKER_REQUEST_TIMEOUT_MS ?? 15000) || 15000
    ),
    60000
  );
  const connectTimeoutMs = Math.min(
    Math.max(
      100,
      Number(overrides.connectTimeoutMs ?? process.env.WORKER_CONNECT_TIMEOUT_MS ?? 15000) || 15000
    ),
    requestTimeoutMs
  );
  const maxRetries = Math.min(
    Math.max(0, Math.floor(Number(overrides.maxRetries ?? process.env.WORKER_MAX_RETRIES ?? 2) || 0)),
    3
  );
  const retryBackoffMs = Math.min(
    Math.max(
      10,
      Math.floor(Number(overrides.retryBackoffMs ?? process.env.WORKER_RETRY_BACKOFF_MS ?? 500) || 500)
    ),
    5000
  );
  const maxConcurrency = Math.min(
    Math.max(
      1,
      Math.floor(Number(overrides.maxConcurrency ?? process.env.WORKER_MAX_CONCURRENCY ?? 4) || 4)
    ),
    50
  );
  const idempotencyTtlMs = Math.min(
    Math.max(1000, Number(overrides.idempotencyTtlMs ?? 60000) || 60000),
    300000
  );

  const workerId =
    overrides.remoteWorkerId ??
    overrides.workerId ??
    process.env.WORKER_ID ??
    `omnihub-official-acquisition-worker-${process.pid}`;

  const version = (overrides.version ?? WORKER_SERVICE_VERSION).trim() || WORKER_SERVICE_VERSION;

  const envExecEnv = (process.env.WORKER_EXECUTION_ENVIRONMENT ?? '').trim().toUpperCase();
  const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopbackBind =
    normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '::1';

  const isProdRequested =
    overrides.executionEnvironment === 'PRODUCTION_REMOTE' ||
    overrides.workerMode === 'PRODUCTION_WORKER' ||
    envExecEnv === 'PRODUCTION_REMOTE' ||
    process.env.WORKER_DEPLOYMENT_ENV === 'production' ||
    (process.env.NODE_ENV === 'production' &&
      overrides.executionEnvironment !== 'LOCAL_WORKER' &&
      overrides.workerMode !== 'LOCAL_WORKER' &&
      envExecEnv !== 'LOCAL_WORKER');

  // Section 13 & 24 rule: A local process bound to loopback (127.0.0.1/localhost/::1) or lacking an auth token
  // must NEVER claim PRODUCTION_REMOTE.
  const canClaimProduction = isProdRequested && !isLoopbackBind && Boolean(token);

  const executionEnvironment: WorkerExecutionEnvironment = canClaimProduction
    ? 'PRODUCTION_REMOTE'
    : 'LOCAL_WORKER';

  const workerMode: 'LOCAL_WORKER' | 'PRODUCTION_WORKER' =
    executionEnvironment === 'PRODUCTION_REMOTE' ? 'PRODUCTION_WORKER' : 'LOCAL_WORKER';

  return {
    token,
    port,
    host,
    maxResponseMb,
    requestTimeoutMs,
    connectTimeoutMs,
    maxRetries,
    retryBackoffMs,
    maxConcurrency,
    idempotencyTtlMs,
    workerId,
    version,
    workerMode,
    executionEnvironment,
    dnsLookup: overrides.dnsLookup,
    testUpstreamOriginMap: overrides.testUpstreamOriginMap,
  };
}

/**
 * Strict Official Source & SSRF Validator for the Worker.
 * Rejects any non-official domain, any unapproved sourceId, any non-HTTPS URL (unless explicitly approved),
 * and any localhost/private/link-local/metadata IP or DNS rebinding attempt.
 */
export async function validateWorkerOfficialTarget(
  targetUrl: string,
  sourceId: string,
  options: {
    allowHttp?: boolean;
    isRedirectHop?: boolean;
    dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  } = {}
): Promise<{ parsedUrl: URL; resolvedIps: string[] }> {
  // 1. Verify sourceId is registered in OFFICIAL_SOURCE_DOMAINS
  const sourceConfig = OFFICIAL_SOURCE_DOMAINS[sourceId];
  if (!sourceConfig) {
    throw new SecurityViolationError(
      `Unapproved or unknown sourceId "${sourceId}". Worker only serves registered official sources.`,
      'SOURCE_NOT_REGISTERED'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new SecurityViolationError(`Malformed URL: ${targetUrl}`, 'INVALID_URL_FORMAT');
  }

  // 2. Enforce HTTPS-only (unless explicitly approved for an official source)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecurityViolationError(
      `Forbidden URL scheme "${parsed.protocol}". Only HTTPS is permitted.`,
      'FORBIDDEN_PROTOCOL'
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // 3. Immediate SSRF check on hostname literals BEFORE domain allowlist check
  const blockedHostnames = new Set([
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '[::1]',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    '169.254.169.254',
  ]);
  const bareHost = hostname.replace(/^\[|\]$/g, '');

  if (
    blockedHostnames.has(hostname) ||
    blockedHostnames.has(bareHost) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new SecurityViolationError(
      `SSRF blocked: access to internal/loopback/metadata host "${hostname}" is forbidden`,
      'SSRF_BLOCKED_HOST'
    );
  }

  if (
    isPrivateIpv4(bareHost) ||
    isPrivateIpv6(bareHost) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bareHost)
  ) {
    throw new SecurityViolationError(
      `SSRF blocked: direct IP literal or private IP "${hostname}" is forbidden`,
      'SSRF_PRIVATE_IP'
    );
  }

  // 4. Enforce HTTPS only
  const allowHttp = options.allowHttp ?? false;
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new SecurityViolationError(
      `Insecure HTTP protocol rejected for "${targetUrl}"; HTTPS is required`,
      'INSECURE_PROTOCOL'
    );
  }

  // 5. Enforce exact hostname match against registered official domains for this sourceId
  // (including RRB regional official domains)
  const sourceAllowedDomains = getAllowedDomainsForSource(sourceId).map((d) => d.toLowerCase());
  const rrbRegionalDomains =
    sourceId === 'IN-CENTRAL-RRB'
      ? RRB_REGIONAL_PROBE_BOARDS.map((b) => b.officialDomain.toLowerCase())
      : [];
  const permittedForSource = new Set([...sourceAllowedDomains, ...rrbRegionalDomains]);

  const matchesSourceAllowlist = Array.from(permittedForSource).some(
    (allowedDomain) => hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`)
  );

  if (!matchesSourceAllowlist) {
    throw new SecurityViolationError(
      options.isRedirectHop
        ? `Redirect blocked: destination hostname "${hostname}" is not an approved official domain for ${sourceId}`
        : `Domain blocked: hostname "${hostname}" is not in the approved official domain registry for ${sourceId}`,
      options.isRedirectHop ? 'REDIRECT_DOMAIN_NOT_ALLOWED' : 'DOMAIN_NOT_ALLOWED'
    );
  }

  // 6. DNS resolution & DNS rebinding protection
  let resolvedIps: string[] = [];
  try {
    const lookupFn =
      options.dnsLookup ??
      (async (h: string) => {
        const res = await dns.lookup(h, { all: true });
        return res;
      });
    const records = await lookupFn(bareHost);
    resolvedIps = records.map((r) => r.address);
  } catch (err) {
    throw new SecurityViolationError(
      `DNS resolution failed for official host "${hostname}": ${(err as Error).message}`,
      'DNS_RESOLUTION_FAILED',
      err
    );
  }

  if (resolvedIps.length === 0) {
    throw new SecurityViolationError(
      `DNS resolution returned no IP addresses for "${hostname}"`,
      'DNS_RESOLUTION_EMPTY'
    );
  }

  for (const ip of resolvedIps) {
    const cleanIp = ip.replace(/^\[|\]$/g, '');
    if (isPrivateIpv4(cleanIp) || isPrivateIpv6(cleanIp)) {
      throw new SecurityViolationError(
        `SSRF DNS rebinding blocked: "${hostname}" resolved to non-public IP "${cleanIp}"`,
        'SSRF_DNS_REBINDING'
      );
    }
  }

  return { parsedUrl: parsed, resolvedIps };
}

/**
 * Sanitizes incoming request headers so caller cannot inject cookies, auth tokens, or host headers.
 */
function sanitizeForwardHeaders(
  rawHeaders: Record<string, string> | undefined,
  responseType: 'TEXT' | 'BINARY',
  originReferer?: string
): Record<string, string> {
  const safe: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
    Accept:
      responseType === 'BINARY'
        ? 'application/pdf,application/octet-stream,*/*;q=0.8'
        : 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
    ...(originReferer ? { Referer: originReferer } : {}),
  };

  if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      const lower = k.toLowerCase().trim();
      if (ALLOWED_SAFE_REQUEST_HEADERS.has(lower) && typeof v === 'string' && v.length < 512) {
        safe[k] = v;
      }
    }
  }

  return safe;
}

/**
 * Standalone Official Acquisition Worker service class.
 */
export class OfficialAcquisitionWorkerService {
  private readonly config: ReturnType<typeof resolveWorkerRuntimeConfig>;
  private readonly startedAtMs = Date.now();
  private activeRequests = 0;
  private totalRequestsHandled = 0;
  private shuttingDown = false;
  private readonly inFlightMap = new Map<string, Promise<WorkerAcquireResponse>>();
  private readonly replayCache = new Map<
    string,
    { expiresAt: number; response: WorkerAcquireResponse }
  >();

  constructor(overrides: OfficialAcquisitionWorkerConfig = {}) {
    this.config = resolveWorkerRuntimeConfig(overrides);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beginGracefulShutdown(): void {
    this.shuttingDown = true;
  }

  async waitForActiveRequests(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  getIdentity(): WorkerRunnerIdentity {
    return {
      runnerId: this.config.workerId,
      workerId: this.config.workerId,
      remoteWorkerId: this.config.workerId,
      runnerKind: 'REMOTE',
      actualRunner: 'REMOTE',
      mode: this.config.workerMode,
      executionEnvironment: this.config.executionEnvironment,
      version: this.config.version,
      workerVersion: this.config.version,
      host: `${this.config.host}:${this.config.port}`,
    };
  }

  getHealthReport(): {
    status: 'HEALTHY' | 'DRAINING';
    service: 'OfficialAcquisitionWorker';
    version: string;
    uptime: number;
    uptimeMs: number;
    timestamp: string;
    capabilities: {
      supportedSourcesCount: number;
      rrbRegionalBoardsCount: number;
      supportedPurposes: WorkerAcquisitionPurpose[];
      httpsOnly: boolean;
      officialDomainAllowlistEnforced: true;
      ssrfProtectionEnforced: true;
      redirectValidationEnforced: true;
      maxResponseMb: number;
      requestTimeoutMs: number;
      connectTimeoutMs: number;
      maxRetries: number;
      retryBackoffMs: number;
      maxConcurrency: number;
    };
    runnerIdentity: WorkerRunnerIdentity;
    authConfigured: boolean;
    activeRequests: number;
    maxConcurrency: number;
    totalRequestsHandled: number;
  } {
    const uptimeMs = Date.now() - this.startedAtMs;
    return {
      status: this.shuttingDown ? 'DRAINING' : 'HEALTHY',
      service: 'OfficialAcquisitionWorker',
      version: this.config.version,
      uptime: Math.floor(uptimeMs / 1000),
      uptimeMs,
      timestamp: new Date().toISOString(),
      capabilities: {
        supportedSourcesCount: Object.keys(OFFICIAL_SOURCE_DOMAINS).length,
        rrbRegionalBoardsCount: RRB_REGIONAL_PROBE_BOARDS.length,
        supportedPurposes: ['LISTING', 'DETAIL', 'DOCUMENT_PDF', 'PROBE'],
        httpsOnly: true,
        officialDomainAllowlistEnforced: true,
        ssrfProtectionEnforced: true,
        redirectValidationEnforced: true,
        maxResponseMb: this.config.maxResponseMb,
        requestTimeoutMs: this.config.requestTimeoutMs,
        connectTimeoutMs: this.config.connectTimeoutMs,
        maxRetries: this.config.maxRetries,
        retryBackoffMs: this.config.retryBackoffMs,
        maxConcurrency: this.config.maxConcurrency,
      },
      runnerIdentity: this.getIdentity(),
      authConfigured: Boolean(this.config.token),
      activeRequests: this.activeRequests,
      maxConcurrency: this.config.maxConcurrency,
      totalRequestsHandled: this.totalRequestsHandled,
    };
  }

  getReadinessReport(): {
    ready: boolean;
    status: 'READY' | 'NOT_READY';
    service: 'OfficialAcquisitionWorker';
    version: string;
    executionEnvironment: WorkerExecutionEnvironment;
    authConfigured: boolean;
    shuttingDown: boolean;
    activeRequests: number;
    maxConcurrency: number;
    reason: string;
    runnerIdentity: WorkerRunnerIdentity;
    timestamp: string;
  } {
    const authConfigured = Boolean(this.config.token);
    const requiresAuthForReady = this.config.executionEnvironment === 'PRODUCTION_REMOTE';
    const ready = !this.shuttingDown && (!requiresAuthForReady || authConfigured);
    const reason = this.shuttingDown
      ? 'Worker is shutting down and draining requests'
      : requiresAuthForReady && !authConfigured
        ? 'OFFICIAL_ACQUISITION_WORKER_TOKEN is not configured for PRODUCTION_REMOTE'
        : 'Worker is ready to accept authenticated acquisition requests';

    return {
      ready,
      status: ready ? 'READY' : 'NOT_READY',
      service: 'OfficialAcquisitionWorker',
      version: this.config.version,
      executionEnvironment: this.config.executionEnvironment,
      authConfigured,
      shuttingDown: this.shuttingDown,
      activeRequests: this.activeRequests,
      maxConcurrency: this.config.maxConcurrency,
      reason,
      runnerIdentity: this.getIdentity(),
      timestamp: new Date().toISOString(),
    };
  }

  getCapabilitiesReport(): {
    service: 'OfficialAcquisitionWorker';
    version: string;
    executionEnvironment: WorkerExecutionEnvironment;
    runnerIdentity: WorkerRunnerIdentity;
    supportedMethods: ['GET', 'POST'];
    supportedAcquisitionTypes: WorkerAcquisitionPurpose[];
    supportedPurposes: WorkerAcquisitionPurpose[];
    securityFeatures: string[];
    maxResponseSize: {
      maxResponseMb: number;
      maxResponseBytes: number;
    };
    timeoutConfiguration: {
      requestTimeoutMs: number;
      connectTimeoutMs: number;
      maxRetries: number;
      retryBackoffMs: number;
      maxConcurrency: number;
    };
    supportedSources: Array<{
      sourceId: string;
      name: string;
      category: string;
      approvedDomains: string[];
    }>;
    rrbRegionalBoardsCount: number;
    securityPolicies: {
      httpsOnly: boolean;
      arbitraryProxyAllowed: false;
      officialDomainAllowlistEnforced: true;
      ssrfProtectionEnforced: true;
      dnsRebindingProtectionEnforced: true;
      redirectValidationEnforced: true;
      maxRedirectHops: number;
      maxResponseMb: number;
      maxResponseBytes: number;
      requestTimeoutMs: number;
      connectTimeoutMs: number;
      maxRetries: number;
      retryBackoffMs: number;
      maxConcurrency: number;
      authenticationRequired: true;
      supportedAuthSchemes: ['Bearer', 'HMAC-SHA256'];
      idempotencySupported: true;
    };
    totalApprovedOfficialDomains: number;
  } {
    const supportedSources = Object.values(OFFICIAL_SOURCE_DOMAINS).map((src) => ({
      sourceId: src.sourceId,
      name: src.name,
      category: src.category,
      approvedDomains: getAllowedDomainsForSource(src.sourceId),
    }));

    const maxResponseBytes = this.config.maxResponseMb * 1024 * 1024;
    const acquisitionTypes: WorkerAcquisitionPurpose[] = [
      'LISTING',
      'DETAIL',
      'DOCUMENT_PDF',
      'PROBE',
    ];

    return {
      service: 'OfficialAcquisitionWorker',
      version: this.config.version,
      executionEnvironment: this.config.executionEnvironment,
      runnerIdentity: this.getIdentity(),
      supportedMethods: ['GET', 'POST'],
      supportedAcquisitionTypes: acquisitionTypes,
      supportedPurposes: acquisitionTypes,
      securityFeatures: [
        'OFFICIAL_DOMAIN_ALLOWLIST',
        'EXACT_HOSTNAME_VALIDATION',
        'HTTPS_ONLY',
        'SSRF_PROTECTION',
        'DNS_REBINDING_PROTECTION',
        'PER_HOP_REDIRECT_VALIDATION',
        'CONSTANT_TIME_TOKEN_AUTH',
        'PDF_MAGIC_BYTES_VALIDATION',
        'RESPONSE_SIZE_CAP',
        'CONCURRENCY_LIMIT',
      ],
      maxResponseSize: {
        maxResponseMb: this.config.maxResponseMb,
        maxResponseBytes,
      },
      timeoutConfiguration: {
        requestTimeoutMs: this.config.requestTimeoutMs,
        connectTimeoutMs: this.config.connectTimeoutMs,
        maxRetries: this.config.maxRetries,
        retryBackoffMs: this.config.retryBackoffMs,
        maxConcurrency: this.config.maxConcurrency,
      },
      supportedSources,
      rrbRegionalBoardsCount: RRB_REGIONAL_PROBE_BOARDS.length,
      securityPolicies: {
        httpsOnly: true,
        arbitraryProxyAllowed: false,
        officialDomainAllowlistEnforced: true,
        ssrfProtectionEnforced: true,
        dnsRebindingProtectionEnforced: true,
        redirectValidationEnforced: true,
        maxRedirectHops: 3,
        maxResponseMb: this.config.maxResponseMb,
        maxResponseBytes,
        requestTimeoutMs: this.config.requestTimeoutMs,
        connectTimeoutMs: this.config.connectTimeoutMs,
        maxRetries: this.config.maxRetries,
        retryBackoffMs: this.config.retryBackoffMs,
        maxConcurrency: this.config.maxConcurrency,
        authenticationRequired: true,
        supportedAuthSchemes: ['Bearer', 'HMAC-SHA256'],
        idempotencySupported: true,
      },
      totalApprovedOfficialDomains: getAllOfficialDomains().length,
    };
  }

  /**
   * Verifies server-side Bearer token or HMAC-SHA256 signature using constant-time comparison.
   * Never logs or echoes the authentication token.
   */
  verifyRequestAuth(req: {
    authorizationHeader?: string;
    signatureHeader?: string;
    timestampHeader?: string;
    rawBody?: string;
  }): { authenticated: boolean; statusCode: 200 | 401 | 403; reason?: string } {
    if (!this.config.token) {
      return {
        authenticated: false,
        statusCode: 401,
        reason:
          'Worker authentication token is not configured on server (OFFICIAL_ACQUISITION_WORKER_TOKEN missing)',
      };
    }

    const authHeader = (req.authorizationHeader ?? '').trim();
    const sigHeader = (req.signatureHeader ?? '').trim();

    if (!authHeader && !sigHeader) {
      return {
        authenticated: false,
        statusCode: 401,
        reason:
          'Missing authentication credentials (expected Authorization: Bearer <token> or X-Worker-Signature)',
      };
    }

    if (authHeader) {
      if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return {
          authenticated: false,
          statusCode: 401,
          reason: 'Invalid Authorization scheme; expected Bearer token',
        };
      }
      const suppliedToken = authHeader.slice(7).trim();
      if (!safeCompareStrings(suppliedToken, this.config.token)) {
        return {
          authenticated: false,
          statusCode: 403,
          reason: 'Invalid worker Bearer token',
        };
      }
      return { authenticated: true, statusCode: 200 };
    }

    // HMAC-SHA256 verification
    const rawPayload = req.timestampHeader
      ? `${req.timestampHeader}.${req.rawBody ?? ''}`
      : req.rawBody ?? '';
    const expectedHmac = `sha256=${crypto
      .createHmac('sha256', this.config.token)
      .update(rawPayload, 'utf8')
      .digest('hex')}`;

    if (!safeCompareStrings(sigHeader, expectedHmac)) {
      return {
        authenticated: false,
        statusCode: 403,
        reason: 'Invalid X-Worker-Signature HMAC digest',
      };
    }

    return { authenticated: true, statusCode: 200 };
  }

  private pruneReplayCache(): void {
    const now = Date.now();
    for (const [k, entry] of this.replayCache.entries()) {
      if (entry.expiresAt <= now) {
        this.replayCache.delete(k);
      }
    }
  }

  private buildResponseEnvelope(
    partial: Omit<
      WorkerAcquireResponse,
      | 'executionId'
      | 'runner'
      | 'actualRunner'
      | 'executionEnvironment'
      | 'workerId'
      | 'remoteWorkerId'
      | 'workerVersion'
      | 'runnerIdentity'
      | 'startedAt'
      | 'completedAt'
    > & {
      executionId?: string;
      startedAt?: string;
      completedAt?: string;
    }
  ): WorkerAcquireResponse {
    const identity = this.getIdentity();
    const completedAt = partial.completedAt ?? partial.timestamp;
    const completedMs = Date.parse(completedAt);
    const startedAt =
      partial.startedAt ??
      (Number.isFinite(completedMs)
        ? new Date(Math.max(0, completedMs - Math.max(0, partial.durationMs))).toISOString()
        : completedAt);
    return {
      ...partial,
      executionId: partial.executionId ?? partial.requestId,
      runner: 'REMOTE',
      actualRunner: 'REMOTE',
      executionEnvironment: identity.executionEnvironment,
      workerId: identity.workerId,
      remoteWorkerId: identity.remoteWorkerId,
      workerVersion: identity.workerVersion,
      runnerIdentity: identity,
      startedAt,
      completedAt,
    };
  }

  private logObservability(res: WorkerAcquireResponse): void {
    logger.info('WORKER_ACQUIRE_OBSERVABILITY', {
      requestId: res.requestId,
      sourceId: res.sourceId,
      endpoint: res.endpoint,
      workerId: res.workerId,
      workerVersion: res.workerVersion,
      actualRunner: res.actualRunner,
      executionEnvironment: res.executionEnvironment,
      attempts: res.attempts,
      durationMs: res.durationMs,
      httpStatus: res.httpStatus,
      failureClass: res.failureClass,
      bytesReceived: res.bytesReceived,
      timestamp: res.timestamp,
    });
  }

  /**
   * Validates all structured acquisition request fields before any network execution (Section 7).
   */
  validateRequestContract(payload: Partial<WorkerAcquireRequest>): {
    valid: boolean;
    errorCode?: string;
    failureClass?: WorkerFailureClass;
    reason?: string;
    normalizedPurpose?: WorkerAcquisitionPurpose;
    normalizedMethod?: 'GET' | 'POST';
  } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        errorCode: 'MALFORMED_ACQUIRE_REQUEST',
        failureClass: 'PROTOCOL_ERROR',
        reason: 'Request body must be a JSON object',
      };
    }

    if (!payload.sourceId || typeof payload.sourceId !== 'string' || !payload.sourceId.trim()) {
      return {
        valid: false,
        errorCode: 'INVALID_ACQUIRE_REQUEST',
        failureClass: 'ACCESS_BLOCKED',
        reason: 'Missing required field: sourceId',
      };
    }

    if (!payload.endpoint || typeof payload.endpoint !== 'string' || !payload.endpoint.trim()) {
      return {
        valid: false,
        errorCode: 'INVALID_ACQUIRE_REQUEST',
        failureClass: 'ACCESS_BLOCKED',
        reason: 'Missing required field: endpoint',
      };
    }

    // Method validation (only GET or POST)
    const rawMethod = payload.method ?? payload.requestPolicy?.method ?? 'GET';
    if (typeof rawMethod !== 'string' || (rawMethod !== 'GET' && rawMethod !== 'POST')) {
      return {
        valid: false,
        errorCode: 'UNSUPPORTED_HTTP_METHOD',
        failureClass: 'ACCESS_BLOCKED',
        reason: `Unsupported HTTP method "${String(rawMethod)}"; only GET and POST are permitted`,
      };
    }

    // Acquisition type / purpose validation
    const rawType = payload.acquisitionType ?? payload.purpose ?? payload.methodType ?? 'LISTING';
    if (
      typeof rawType !== 'string' ||
      !VALID_ACQUISITION_TYPES.has(rawType as WorkerAcquisitionPurpose)
    ) {
      return {
        valid: false,
        errorCode: 'INVALID_ACQUISITION_TYPE',
        failureClass: 'ACCESS_BLOCKED',
        reason: `Unsupported acquisitionType "${String(rawType)}"; allowed: LISTING, DETAIL, DOCUMENT_PDF, PROBE`,
      };
    }

    // Header validation: reject unsafe/forbidden headers or non-string values
    const headerSources = [payload.headers, payload.requestPolicy?.headers].filter(Boolean);
    for (const hdrObj of headerSources) {
      if (typeof hdrObj !== 'object' || Array.isArray(hdrObj)) {
        return {
          valid: false,
          errorCode: 'UNSAFE_REQUEST_HEADERS',
          failureClass: 'ACCESS_BLOCKED',
          reason: 'Headers must be a key-value object of strings',
        };
      }
      for (const [k, v] of Object.entries(hdrObj as Record<string, unknown>)) {
        const lowerKey = k.toLowerCase().trim();
        if (
          FORBIDDEN_UNSAFE_REQUEST_HEADERS.has(lowerKey) ||
          !ALLOWED_SAFE_REQUEST_HEADERS.has(lowerKey)
        ) {
          return {
            valid: false,
            errorCode: 'UNSAFE_REQUEST_HEADERS',
            failureClass: 'ACCESS_BLOCKED',
            reason: `Forbidden or unsafe request header "${k}" is not permitted`,
          };
        }
        if (typeof v !== 'string' || v.length > 512 || /[\r\n]/.test(v)) {
          return {
            valid: false,
            errorCode: 'UNSAFE_REQUEST_HEADERS',
            failureClass: 'ACCESS_BLOCKED',
            reason: `Invalid header value for "${k}"`,
          };
        }
      }
    }

    // Timeout validation: reject negative, NaN, non-numeric, or > 30000ms timeout overrides
    const rawTimeouts = [
      payload.timeout,
      payload.timeoutPolicy?.timeoutMs,
      payload.timeoutPolicy?.connectionTimeoutMs,
    ].filter((v) => v !== undefined);
    for (const t of rawTimeouts) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 50 || t > 30000) {
        return {
          valid: false,
          errorCode: 'INVALID_TIMEOUT_CONFIGURATION',
          failureClass: 'ACCESS_BLOCKED',
          reason: `Invalid timeout configuration (${String(t)}ms); must be between 50ms and 30000ms`,
        };
      }
    }

    // Retry policy validation: reject negative, non-integer, or excessive retries (> 3)
    if (payload.retryPolicy !== undefined) {
      if (typeof payload.retryPolicy !== 'object' || Array.isArray(payload.retryPolicy)) {
        return {
          valid: false,
          errorCode: 'EXCESSIVE_RETRY_CONFIGURATION',
          failureClass: 'ACCESS_BLOCKED',
          reason: 'Invalid retryPolicy structure',
        };
      }
      const { maxRetries, retryBackoffMs } = payload.retryPolicy;
      if (
        maxRetries !== undefined &&
        (typeof maxRetries !== 'number' ||
          !Number.isInteger(maxRetries) ||
          maxRetries < 0 ||
          maxRetries > 3)
      ) {
        return {
          valid: false,
          errorCode: 'EXCESSIVE_RETRY_CONFIGURATION',
          failureClass: 'ACCESS_BLOCKED',
          reason: `Invalid or excessive retry count (${String(maxRetries)}); maximum allowed is 3`,
        };
      }
      if (
        retryBackoffMs !== undefined &&
        (typeof retryBackoffMs !== 'number' ||
          !Number.isFinite(retryBackoffMs) ||
          retryBackoffMs < 10 ||
          retryBackoffMs > 5000)
      ) {
        return {
          valid: false,
          errorCode: 'EXCESSIVE_RETRY_CONFIGURATION',
          failureClass: 'ACCESS_BLOCKED',
          reason: `Invalid retryBackoffMs (${String(retryBackoffMs)}); must be between 10ms and 5000ms`,
        };
      }
    }

    // Security limit override checks
    if (payload.requestPolicy) {
      if (payload.requestPolicy.allowHttp === true) {
        return {
          valid: false,
          errorCode: 'SECURITY_LIMIT_OVERRIDE_REJECTED',
          failureClass: 'SSRF_BLOCKED',
          reason: 'Caller cannot override HTTPS-only enforcement (allowHttp=true rejected)',
        };
      }
      const maxSecurityCeilingBytes = Math.max(this.config.maxResponseMb * 1024 * 1024, 25 * 1024 * 1024);
      if (
        payload.requestPolicy.maxDownloadBytes !== undefined &&
        (typeof payload.requestPolicy.maxDownloadBytes !== 'number' ||
          !Number.isFinite(payload.requestPolicy.maxDownloadBytes) ||
          payload.requestPolicy.maxDownloadBytes <= 0 ||
          payload.requestPolicy.maxDownloadBytes > maxSecurityCeilingBytes)
      ) {
        return {
          valid: false,
          errorCode: 'SECURITY_LIMIT_OVERRIDE_REJECTED',
          failureClass: 'MAX_SIZE_EXCEEDED',
          reason: `Caller maxDownloadBytes (${String(payload.requestPolicy.maxDownloadBytes)}) exceeds worker security limit (${maxSecurityCeilingBytes})`,
        };
      }
      if (
        payload.requestPolicy.maxRedirectHops !== undefined &&
        (typeof payload.requestPolicy.maxRedirectHops !== 'number' ||
          payload.requestPolicy.maxRedirectHops < 0 ||
          payload.requestPolicy.maxRedirectHops > 5)
      ) {
        return {
          valid: false,
          errorCode: 'SECURITY_LIMIT_OVERRIDE_REJECTED',
          failureClass: 'REDIRECT_BLOCKED',
          reason: `Caller maxRedirectHops (${String(payload.requestPolicy.maxRedirectHops)}) exceeds worker redirect limit`,
        };
      }
    }

    return {
      valid: true,
      normalizedPurpose: rawType as WorkerAcquisitionPurpose,
      normalizedMethod: rawMethod,
    };
  }

  /**
   * Executes a structured official-source acquisition request with idempotency,
   * concurrency bounds, SSRF/domain enforcement, manual redirect validation,
   * measurable retries, and PDF magic-byte/SHA-256 verification.
   */
  async handleAcquire(
    payload: WorkerAcquireRequest,
    headerMeta: { requestIdHeader?: string; idempotencyKeyHeader?: string } = {}
  ): Promise<WorkerAcquireResponse> {
    this.totalRequestsHandled++;
    this.pruneReplayCache();

    const requestId =
      (payload?.requestId || headerMeta.requestIdHeader || '').trim() || crypto.randomUUID();
    const explicitIdempotencyKey =
      (payload?.idempotencyKey || headerMeta.idempotencyKeyHeader || '').trim() || null;
    const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId.trim() : '';
    const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '';

    const validation = this.validateRequestContract(payload);
    if (!validation.valid) {
      const invalidRes = this.buildResponseEnvelope({
        requestId,
        idempotencyKey: explicitIdempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        endpoint,
        status: 'FAILED',
        failureClass: validation.failureClass || 'ACCESS_BLOCKED',
        failureClassification: validation.failureClass || 'ACCESS_BLOCKED',
        httpStatus: 400,
        finalUrl: null,
        redirectChain: endpoint ? [endpoint] : [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        timestamp: new Date().toISOString(),
        failureDetails: validation.reason || 'Invalid acquisition request contract',
        errorCode: validation.errorCode || 'INVALID_ACQUIRE_REQUEST',
      });
      this.logObservability(invalidRes);
      return invalidRes;
    }

    const purpose: WorkerAcquisitionPurpose = validation.normalizedPurpose || 'LISTING';
    const method: 'GET' | 'POST' = validation.normalizedMethod || 'GET';

    if (this.shuttingDown) {
      const drainRes = this.buildResponseEnvelope({
        requestId,
        idempotencyKey: explicitIdempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        endpoint,
        status: 'FAILED',
        failureClass: 'HTTP_ERROR',
        failureClassification: 'HTTP_ERROR',
        httpStatus: 503,
        finalUrl: null,
        redirectChain: endpoint ? [endpoint] : [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        timestamp: new Date().toISOString(),
        failureDetails: 'Official Acquisition Worker is shutting down and draining requests',
        errorCode: 'WORKER_SHUTTING_DOWN',
      });
      this.logObservability(drainRes);
      return drainRes;
    }

    // Check replay cache / in-flight deduplication when idempotencyKey or explicit requestId is provided
    const dedupToken =
      explicitIdempotencyKey || (payload.requestId ? payload.requestId.trim() : null);
    const cacheKey = dedupToken
      ? `${sourceId}:${method}:${purpose}:${endpoint}:${dedupToken}`
      : null;

    if (cacheKey) {
      const cached = this.replayCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.info('WORKER_IDEMPOTENT_REPLAY_HIT', {
          requestId,
          idempotencyKey: explicitIdempotencyKey,
          sourceId,
          endpoint,
        });
        return {
          ...cached.response,
          requestId,
          idempotencyKey: explicitIdempotencyKey,
          deduplicatedReplay: true,
        };
      }

      const inFlight = this.inFlightMap.get(cacheKey);
      if (inFlight) {
        logger.info('WORKER_INFLIGHT_COALESCED', {
          requestId,
          idempotencyKey: explicitIdempotencyKey,
          sourceId,
          endpoint,
        });
        const sharedResult = await inFlight;
        return {
          ...sharedResult,
          requestId,
          idempotencyKey: explicitIdempotencyKey,
          deduplicatedReplay: true,
        };
      }
    }

    // Enforce concurrency limit
    if (this.activeRequests >= this.config.maxConcurrency) {
      const limitRes = this.buildResponseEnvelope({
        requestId,
        idempotencyKey: explicitIdempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        endpoint,
        status: 'FAILED',
        failureClass: 'ACCESS_BLOCKED',
        failureClassification: 'ACCESS_BLOCKED',
        httpStatus: 429,
        finalUrl: null,
        redirectChain: endpoint ? [endpoint] : [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        timestamp: new Date().toISOString(),
        failureDetails: `Worker concurrency limit (${this.config.maxConcurrency}) reached`,
        errorCode: 'WORKER_CONCURRENCY_LIMIT_EXCEEDED',
      });
      this.logObservability(limitRes);
      return limitRes;
    }

    const executionPromise = this.executeAcquireInternal(
      requestId,
      explicitIdempotencyKey,
      sourceId,
      endpoint,
      method,
      purpose,
      payload
    );

    if (cacheKey) {
      this.inFlightMap.set(cacheKey, executionPromise);
    }

    this.activeRequests++;
    try {
      const response = await executionPromise;
      this.logObservability(response);
      if (cacheKey) {
        this.replayCache.set(cacheKey, {
          expiresAt: Date.now() + this.config.idempotencyTtlMs,
          response,
        });
      }
      return response;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (cacheKey) {
        this.inFlightMap.delete(cacheKey);
      }
    }
  }

  private async executeAcquireInternal(
    requestId: string,
    idempotencyKey: string | null,
    sourceId: string,
    endpoint: string,
    method: 'GET' | 'POST',
    purpose: WorkerAcquisitionPurpose,
    payload: WorkerAcquireRequest
  ): Promise<WorkerAcquireResponse> {
    const startedAt = Date.now();
    const maxBytesLimit = Math.min(
      payload.requestPolicy?.maxDownloadBytes ?? this.config.maxResponseMb * 1024 * 1024,
      this.config.maxResponseMb * 1024 * 1024
    );
    const maxRedirectHops = Math.min(
      Math.max(0, payload.requestPolicy?.maxRedirectHops ?? 3),
      5
    );
    const timeoutMs = Math.min(
      Math.max(
        50,
        Math.floor(
          payload.timeoutPolicy?.timeoutMs ??
            payload.timeout ??
            this.config.requestTimeoutMs
        )
      ),
      this.config.requestTimeoutMs
    );
    const connectionTimeoutMs = resolveConnectionTimeoutMs(
      timeoutMs,
      payload.timeoutPolicy?.connectionTimeoutMs ?? this.config.connectTimeoutMs
    );
    const maxRetries = Math.min(
      Math.max(0, Math.floor(payload.retryPolicy?.maxRetries ?? this.config.maxRetries)),
      this.config.maxRetries
    );
    const retryBackoffMs = Math.min(
      Math.max(
        10,
        Math.floor(payload.retryPolicy?.retryBackoffMs ?? this.config.retryBackoffMs)
      ),
      5000
    );
    const maxAttempts = maxRetries + 1;
    const isPdfTarget =
      purpose === 'DOCUMENT_PDF' ||
      payload.requestPolicy?.responseType === 'BINARY' ||
      endpoint.toLowerCase().endsWith('.pdf');
    const responseType: 'TEXT' | 'BINARY' = isPdfTarget ? 'BINARY' : 'TEXT';

    // 1. Validate initial target URL against official domain allowlist, HTTPS, and SSRF/DNS rebinding
    try {
      await validateWorkerOfficialTarget(endpoint, sourceId, {
        allowHttp: false,
        isRedirectHop: false,
        dnsLookup: this.config.dnsLookup,
      });
    } catch (secErr) {
      const errCode =
        secErr instanceof SecurityViolationError ? secErr.code : 'SSRF_BLOCKED';
      const failureClass = mapToWorkerFailureClass('SSRF_BLOCKED', null, errCode);
      const diag = classifyNetworkOrHttpError({
        error: secErr,
        requestUrl: endpoint,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts,
        retryDelayMs: 0,
      });
      return this.buildResponseEnvelope({
        requestId,
        idempotencyKey,
        deduplicatedReplay: false,
        sourceId,
        endpoint,
        status: 'FAILED',
        failureClass,
        failureClassification: failureClass,
        httpStatus: null,
        finalUrl: null,
        redirectChain: endpoint ? [endpoint] : [],
        contentType: null,
        contentLength: 0,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [diag],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        timestamp: new Date().toISOString(),
        failureDetails: (secErr as Error).message,
        errorCode: errCode,
      });
    }

    const dispatcher = await configureGlobalFetchDispatcher(timeoutMs, connectionTimeoutMs);

    let attempt = 0;
    let attemptsUsed = 0;
    let retriesUsed = 0;
    const retryReasons: string[] = [];
    const retryDiagnostics: RetryDiagnosticEntry[] = [];
    const attemptDiagnostics: StructuredFetchDiagnostic[] = [];
    let lastDiagnostic: StructuredFetchDiagnostic | null = null;
    let lastFailureClass: WorkerFailureClass = 'UNKNOWN';
    let lastErrorCode: string | null = null;
    let lastErrorMessage: string | null = null;
    let lastHttpStatus: number | null = null;
    let lastRedirectChain: string[] = [endpoint];

    while (attempt <= maxRetries) {
      attemptsUsed++;
      const currentAttemptNum = attempt + 1;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(
          Object.assign(new Error(`Worker request timeout after ${timeoutMs}ms`), {
            name: 'TimeoutError',
            code: 'ETIMEDOUT',
          })
        );
      }, timeoutMs);

      try {
        let currentUrl = endpoint;
        let hops = 0;
        let response: globalThis.Response | null = null;
        const redirectChain: string[] = [endpoint];
        lastRedirectChain = redirectChain;

        while (hops <= maxRedirectHops) {
          // Validate current hop (initial URL already validated on hop 0, validate every redirect hop > 0)
          if (hops > 0) {
            await validateWorkerOfficialTarget(currentUrl, sourceId, {
              allowHttp: false,
              isRedirectHop: true,
              dnsLookup: this.config.dnsLookup,
            });
          }

          const originReferer = (() => {
            try {
              return `${new URL(currentUrl).origin}/`;
            } catch {
              return undefined;
            }
          })();

          // Support test-only upstream socket mapping AFTER all security/domain/SSRF checks have passed on currentUrl
          let fetchUrl = currentUrl;
          if (this.config.testUpstreamOriginMap) {
            const parsedHop = new URL(currentUrl);
            const mappedOrigin =
              this.config.testUpstreamOriginMap[parsedHop.origin] ||
              this.config.testUpstreamOriginMap[parsedHop.hostname];
            if (mappedOrigin) {
              fetchUrl = new URL(
                `${parsedHop.pathname}${parsedHop.search}`,
                mappedOrigin
              ).toString();
            }
          }

          response = await fetch(fetchUrl, {
            method,
            redirect: 'manual',
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
            headers: sanitizeForwardHeaders(
              payload.headers ?? payload.requestPolicy?.headers,
              responseType,
              originReferer
            ),
          } as RequestInit);

          if ([301, 302, 303, 307, 308].includes(response.status)) {
            hops++;
            if (hops > maxRedirectHops) {
              throw new SecurityViolationError(
                `Exceeded maximum redirect hops (${maxRedirectHops})`,
                'REDIRECT_LIMIT_EXCEEDED'
              );
            }
            const location = response.headers.get('location');
            if (!location) {
              throw new SecurityViolationError(
                'Redirect response missing Location header',
                'REDIRECT_BLOCKED'
              );
            }
            currentUrl = new URL(location, currentUrl).toString();
            redirectChain.push(currentUrl);
            continue;
          }

          break;
        }

        clearTimeout(timeoutHandle);

        if (!response) {
          throw new Error('No HTTP response received from official endpoint');
        }

        lastHttpStatus = response.status;
        const finalUrl = currentUrl;

        // Check HTTP status codes
        if (response.status < 200 || response.status >= 400) {
          const isRetryableStatus =
            response.status === 408 ||
            response.status === 429 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504;

          const diag = classifyNetworkOrHttpError({
            httpStatus: response.status,
            requestUrl: finalUrl,
            timeoutMs,
            connectionTimeoutMs,
            attempt: currentAttemptNum,
            maxAttempts,
            retryDelayMs: 0,
          });
          lastDiagnostic = diag;
          lastFailureClass = mapToWorkerFailureClass(
            diag.errorType,
            response.status,
            diag.errorCode
          );
          lastErrorCode = diag.errorCode;
          lastErrorMessage = `Official endpoint returned HTTP ${response.status}`;

          if (isRetryableStatus && attempt < maxRetries) {
            const backoff = Math.min(retryBackoffMs * Math.pow(2, attempt), 5000);
            diag.retryDelayMs = backoff;
            diag.delayMs = backoff;
            diag.reason = diag.errorType;
            retryReasons.push(diag.errorType);
            retryDiagnostics.push(diag);
            attemptDiagnostics.push(diag);
            attempt++;
            retriesUsed++;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }

          attemptDiagnostics.push(diag);
          break;
        }

        // Check Content-Length header if present
        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
          const declaredBytes = parseInt(contentLengthHeader, 10);
          if (!Number.isNaN(declaredBytes) && declaredBytes > maxBytesLimit) {
            throw new SecurityViolationError(
              `Declared Content-Length (${declaredBytes} bytes) exceeds worker limit (${maxBytesLimit} bytes)`,
              'MAX_SIZE_EXCEEDED'
            );
          }
        }

        // Stream response body with strict size cap
        const chunks: Uint8Array[] = [];
        let bytesReceived = 0;

        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              bytesReceived += value.byteLength;
              if (bytesReceived > maxBytesLimit) {
                await reader.cancel();
                throw new SecurityViolationError(
                  `Response stream (${bytesReceived} bytes) exceeded worker limit (${maxBytesLimit} bytes)`,
                  'MAX_SIZE_EXCEEDED'
                );
              }
              chunks.push(value);
            }
          }
        }

        const rawBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const rawContentType = response.headers.get('content-type');
        const cleanMime = rawContentType
          ? rawContentType.split(';')[0].trim().toLowerCase()
          : '';

        const hasMagic = hasPdfMagicBytes(rawBuffer);
        const looksLikePdf =
          isPdfTarget || cleanMime === 'application/pdf' || hasMagic;

        if (looksLikePdf) {
          // Validate PDF MIME and magic bytes
          if (isDisguisedHtml(rawBuffer) || !hasMagic) {
            throw new SecurityViolationError(
              `Target PDF response failed magic-byte validation (%PDF- missing; mime="${cleanMime || 'unknown'}")`,
              'INVALID_PDF'
            );
          }
          if (cleanMime && !ALLOWED_PDF_CONTENT_TYPES.has(cleanMime)) {
            throw new SecurityViolationError(
              `Invalid Content-Type "${cleanMime}" for PDF acquisition`,
              'CONTENT_TYPE_INVALID'
            );
          }

          const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');

          return this.buildResponseEnvelope({
            requestId,
            idempotencyKey,
            deduplicatedReplay: false,
            sourceId,
            endpoint,
            status: 'SUCCESS',
            failureClass: 'SUCCESS',
            failureClassification: 'SUCCESS',
            httpStatus: response.status,
            finalUrl,
            redirectChain,
            contentType: cleanMime || 'application/pdf',
            contentLength: rawBuffer.length,
            durationMs: Date.now() - startedAt,
            attempts: attemptsUsed,
            retriesUsed,
            retryReasons,
            retryDiagnostics,
            attemptDiagnostics,
            bytesReceived: rawBuffer.length,
            isPdf: true,
            sha256,
            content: null,
            contentBase64: rawBuffer.toString('base64'),
            timestamp: new Date().toISOString(),
            failureDetails: null,
            errorCode: null,
          });
        }

        // Listing / Detail text response validation
        if (!cleanMime || !ALLOWED_LISTING_CONTENT_TYPES.has(cleanMime)) {
          throw new SecurityViolationError(
            `Disallowed or unexpected Content-Type "${cleanMime || 'missing'}" from ${finalUrl}`,
            'CONTENT_TYPE_INVALID'
          );
        }

        const textContent = rawBuffer.toString('utf8');
        const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');

        return this.buildResponseEnvelope({
          requestId,
          idempotencyKey,
          deduplicatedReplay: false,
          sourceId,
          endpoint,
          status: 'SUCCESS',
          failureClass: 'SUCCESS',
          failureClassification: 'SUCCESS',
          httpStatus: response.status,
          finalUrl,
          redirectChain,
          contentType: cleanMime,
          contentLength: rawBuffer.length,
          durationMs: Date.now() - startedAt,
          attempts: attemptsUsed,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          bytesReceived: rawBuffer.length,
          isPdf: false,
          sha256,
          content: textContent,
          contentBase64: null,
          timestamp: new Date().toISOString(),
          failureDetails: null,
          errorCode: null,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);

        if (err instanceof SecurityViolationError) {
          const diag = classifyNetworkOrHttpError({
            error: err,
            requestUrl: endpoint,
            timeoutMs,
            connectionTimeoutMs,
            attempt: currentAttemptNum,
            maxAttempts,
            retryDelayMs: 0,
          });
          lastDiagnostic = diag;
          lastErrorCode = err.code;
          lastErrorMessage = err.message;
          lastFailureClass = mapToWorkerFailureClass(
            diag.errorType,
            lastHttpStatus,
            err.code
          );
          attemptDiagnostics.push(diag);
          break;
        }

        const diag = classifyNetworkOrHttpError({
          error: err,
          requestUrl: endpoint,
          timeoutMs,
          connectionTimeoutMs,
          attempt: currentAttemptNum,
          maxAttempts,
          retryDelayMs: 0,
        });
        lastDiagnostic = diag;
        lastErrorCode = diag.errorCode;
        lastErrorMessage = diag.errorMessage;
        lastFailureClass = mapToWorkerFailureClass(diag.errorType, null, diag.errorCode);

        if (diag.retryable && attempt < maxRetries) {
          const backoff = Math.min(retryBackoffMs * Math.pow(2, attempt), 5000);
          diag.retryDelayMs = backoff;
          diag.delayMs = backoff;
          diag.reason = diag.errorType;
          retryReasons.push(diag.errorType);
          retryDiagnostics.push(diag);
          attemptDiagnostics.push(diag);
          attempt++;
          retriesUsed++;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        attemptDiagnostics.push(diag);
        break;
      }
    }

    return this.buildResponseEnvelope({
      requestId,
      idempotencyKey,
      deduplicatedReplay: false,
      sourceId,
      endpoint,
      status: 'FAILED',
      failureClass: lastFailureClass,
      failureClassification: lastFailureClass,
      httpStatus: lastHttpStatus,
      finalUrl: lastRedirectChain[lastRedirectChain.length - 1] || null,
      redirectChain: lastRedirectChain,
      contentType: null,
      contentLength: 0,
      durationMs: Date.now() - startedAt,
      attempts: attemptsUsed,
      retriesUsed,
      retryReasons,
      retryDiagnostics,
      attemptDiagnostics,
      bytesReceived: 0,
      isPdf: false,
      sha256: null,
      content: null,
      contentBase64: null,
      timestamp: new Date().toISOString(),
      failureDetails:
        lastErrorMessage ||
        lastDiagnostic?.errorMessage ||
        'Official source acquisition failed',
      errorCode: lastErrorCode || lastDiagnostic?.errorCode || lastFailureClass,
    });
  }
}

/**
 * Creates the Express HTTP application and HTTP server for the Official Acquisition Worker.
 * Exposes ONLY:
 * - GET /health
 * - GET /capabilities
 * - POST /acquire (authenticated)
 */
export function createOfficialAcquisitionWorkerApp(
  overrides: OfficialAcquisitionWorkerConfig = {}
): {
  app: express.Express;
  worker: OfficialAcquisitionWorkerService;
  start: (portOverride?: number, hostOverride?: string) => Promise<{
    server: http.Server;
    port: number;
    url: string;
    close: () => Promise<void>;
    gracefulShutdown: (timeoutMs?: number) => Promise<void>;
  }>;
} {
  const config = resolveWorkerRuntimeConfig(overrides);
  const worker = new OfficialAcquisitionWorkerService(config);
  const app = express();

  // Capture raw body for optional HMAC signature verification while bounding request payload size
  app.use(
    express.json({
      limit: '100kb',
      verify: (req: Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  // Handle malformed JSON payloads cleanly
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      const requestId = req.header('x-request-id') || crypto.randomUUID();
      const identity = worker.getIdentity();
      res.setHeader('X-Request-Id', requestId);
      const nowIso = new Date().toISOString();
      res.status(400).json({
        executionId: requestId,
        requestId,
        idempotencyKey: req.header('idempotency-key') ?? null,
        deduplicatedReplay: false,
        sourceId: '',
        endpoint: '',
        status: 'FAILED',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        executionEnvironment: identity.executionEnvironment,
        workerId: identity.workerId,
        remoteWorkerId: identity.remoteWorkerId,
        workerVersion: identity.workerVersion,
        failureClass: 'PROTOCOL_ERROR',
        failureClassification: 'PROTOCOL_ERROR',
        httpStatus: 400,
        finalUrl: null,
        redirectChain: [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        runnerIdentity: identity,
        startedAt: nowIso,
        completedAt: nowIso,
        timestamp: nowIso,
        failureDetails: 'Malformed JSON in request body',
        errorCode: 'MALFORMED_ACQUIRE_REQUEST',
      } satisfies WorkerAcquireResponse);
      return;
    }
    next(err);
  });

  app.get('/health', (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') || crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const report = worker.getHealthReport();
    res.status(report.status === 'HEALTHY' ? 200 : 503).json(report);
  });

  app.get('/ready', (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') || crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const report = worker.getReadinessReport();
    res.status(report.ready ? 200 : 503).json(report);
  });

  app.get('/capabilities', (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') || crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.status(200).json(worker.getCapabilitiesReport());
  });

  app.post('/acquire', async (req: Request & { rawBody?: string }, res: Response) => {
    const requestIdHeader = req.header('x-request-id') || undefined;
    const idempotencyKeyHeader = req.header('idempotency-key') || undefined;
    const requestId =
      (typeof req.body?.requestId === 'string' && req.body.requestId.trim()) ||
      requestIdHeader ||
      crypto.randomUUID();

    res.setHeader('X-Request-Id', requestId);
    const identity = worker.getIdentity();

    // 1. Authenticate request
    const authResult = worker.verifyRequestAuth({
      authorizationHeader: req.header('authorization') || undefined,
      signatureHeader: req.header('x-worker-signature') || undefined,
      timestampHeader: req.header('x-worker-timestamp') || undefined,
      rawBody: req.rawBody,
    });

    if (!authResult.authenticated) {
      logger.warn('WORKER_AUTH_REJECTED', {
        requestId,
        statusCode: authResult.statusCode,
        reason: authResult.reason,
        workerId: identity.workerId,
        workerVersion: identity.workerVersion,
        executionEnvironment: identity.executionEnvironment,
      });

      const authNowIso = new Date().toISOString();
      res.status(authResult.statusCode).json({
        executionId: requestId,
        requestId,
        idempotencyKey: idempotencyKeyHeader ?? null,
        deduplicatedReplay: false,
        sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : '',
        endpoint: typeof req.body?.endpoint === 'string' ? req.body.endpoint : '',
        status: 'FAILED',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        executionEnvironment: identity.executionEnvironment,
        workerId: identity.workerId,
        remoteWorkerId: identity.remoteWorkerId,
        workerVersion: identity.workerVersion,
        failureClass: 'ACCESS_BLOCKED',
        failureClassification: 'ACCESS_BLOCKED',
        httpStatus: authResult.statusCode,
        finalUrl: null,
        redirectChain: [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        runnerIdentity: identity,
        startedAt: authNowIso,
        completedAt: authNowIso,
        timestamp: authNowIso,
        failureDetails: authResult.reason || 'Unauthorized worker request',
        errorCode: 'UNAUTHORIZED_WORKER_REQUEST',
      } satisfies WorkerAcquireResponse);
      return;
    }

    // 2. Validate structured request contract before network execution
    const body = (req.body ?? {}) as Partial<WorkerAcquireRequest>;
    const validation = worker.validateRequestContract(body);
    if (!validation.valid) {
      const valNowIso = new Date().toISOString();
      res.status(400).json({
        executionId: requestId,
        requestId,
        idempotencyKey: idempotencyKeyHeader ?? null,
        deduplicatedReplay: false,
        sourceId: typeof body?.sourceId === 'string' ? body.sourceId : '',
        endpoint: typeof body?.endpoint === 'string' ? body.endpoint : '',
        status: 'FAILED',
        runner: 'REMOTE',
        actualRunner: 'REMOTE',
        executionEnvironment: identity.executionEnvironment,
        workerId: identity.workerId,
        remoteWorkerId: identity.remoteWorkerId,
        workerVersion: identity.workerVersion,
        failureClass: validation.failureClass || 'ACCESS_BLOCKED',
        failureClassification: validation.failureClass || 'ACCESS_BLOCKED',
        httpStatus: 400,
        finalUrl: null,
        redirectChain: [],
        contentType: null,
        contentLength: 0,
        durationMs: 0,
        attempts: 0,
        retriesUsed: 0,
        retryReasons: [],
        retryDiagnostics: [],
        attemptDiagnostics: [],
        bytesReceived: 0,
        isPdf: false,
        sha256: null,
        content: null,
        contentBase64: null,
        runnerIdentity: identity,
        startedAt: valNowIso,
        completedAt: valNowIso,
        timestamp: valNowIso,
        failureDetails: validation.reason || 'Invalid acquisition request',
        errorCode: validation.errorCode || 'INVALID_ACQUIRE_REQUEST',
      } satisfies WorkerAcquireResponse);
      return;
    }

    const result = await worker.handleAcquire(
      {
        ...body,
        requestId,
        sourceId: body.sourceId!,
        endpoint: body.endpoint!,
      },
      { requestIdHeader, idempotencyKeyHeader }
    );

    const statusCode =
      result.errorCode === 'WORKER_SHUTTING_DOWN'
        ? 503
        : result.errorCode === 'WORKER_CONCURRENCY_LIMIT_EXCEEDED'
        ? 429
        : 200;
    res.status(statusCode).json(result);
  });

  // Reject all other routes so the worker can never be misused
  app.use((req: Request, res: Response) => {
    const requestId = req.header('x-request-id') || crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.status(404).json({
      requestId,
      status: 'FAILED',
      failureClass: 'ACCESS_BLOCKED',
      errorCode: 'ROUTE_NOT_FOUND',
      message:
        'Official Acquisition Worker only supports GET /health, GET /ready, GET /capabilities, and POST /acquire',
    });
  });

  const start = async (
    portOverride?: number,
    hostOverride?: string
  ): Promise<{
    server: http.Server;
    port: number;
    url: string;
    close: () => Promise<void>;
    gracefulShutdown: (timeoutMs?: number) => Promise<void>;
  }> => {
    const listenPort = portOverride ?? config.port;
    const listenHost = hostOverride ?? config.host;

    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.on('error', reject);
      server.listen(listenPort, listenHost, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
        const displayHost =
          listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
        const url = `http://${displayHost}:${actualPort}`;
        const close = () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          });
        const gracefulShutdown = async (timeoutMs = 5000) => {
          worker.beginGracefulShutdown();
          await worker.waitForActiveRequests(timeoutMs);
          await close();
        };
        resolve({
          server,
          port: actualPort,
          url,
          close,
          gracefulShutdown,
        });
      });
    });
  };

  return { app, worker, start };
}
