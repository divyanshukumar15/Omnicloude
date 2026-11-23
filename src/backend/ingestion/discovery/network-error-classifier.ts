/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { URL } from 'node:url';

export type NetworkErrorClassification =
  | 'TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'NETWORK_UNAVAILABLE'
  | 'HTTP_429'
  | 'HTTP_502'
  | 'HTTP_503'
  | 'HTTP_504'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'UNKNOWN_NETWORK_ERROR';

export type TimeoutStageClassification =
  | 'REQUEST_TIMEOUT'
  | 'CONNECT_TIMEOUT'
  | 'TLS_HANDSHAKE_TIMEOUT'
  | 'READ_TIMEOUT';

export interface StructuredFetchDiagnostic {
  attempt: number;
  maxAttempts: number;
  errorType: NetworkErrorClassification;
  errorCode: string | null;
  errorName: string;
  errorMessage: string;
  cause: string | null;
  requestUrl: string;
  hostname: string | null;
  httpStatus: number | null;
  timeoutMs: number;
  connectionTimeoutMs?: number;
  timeoutStage?: TimeoutStageClassification | null;
  retryable: boolean;
  retryDelayMs: number;
  // Backwards-compatible aliases used by existing diagnostic consumers
  reason: string;
  statusCode: number | null;
  delayMs: number;
}

const TECHNICAL_FAILURE_ERROR_TYPES = new Set<string>([
  'TIMEOUT',
  'DNS_ERROR',
  'TLS_ERROR',
  'CONNECTION_RESET',
  'CONNECTION_REFUSED',
  'NETWORK_UNAVAILABLE',
  'HTTP_429',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
  'HTTP_403',
  'HTTP_404',
  'HTTP_4XX',
  'HTTP_5XX',
  'INVALID_URL',
  'SSRF_BLOCKED',
  'DOMAIN_NOT_ALLOWED',
  'UNKNOWN_NETWORK_ERROR',
]);

export function isTechnicalFailureErrorType(errorType: string | null | undefined): boolean {
  if (!errorType) return false;
  return TECHNICAL_FAILURE_ERROR_TYPES.has(errorType);
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;'"&]+/gi,
  /(cookie\s*[:=]\s*)[^\r\n;]+/gi,
  /(set-cookie\s*[:=]\s*)[^\r\n;]+/gi,
  /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*)[^\s&;'"\r\n]+/gi,
  /(bearer\s+)[a-zA-Z0-9._~+/=-]+/gi,
];

/**
 * Sanitizes any diagnostic string or URL to ensure API keys, passwords,
 * authentication tokens, cookies, and Authorization headers are never exposed.
 */
export function sanitizeDiagnosticText(input: string | null | undefined): string {
  if (!input) return '';
  let sanitized = String(input);
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '$1[REDACTED]');
  }
  return sanitized;
}

/**
 * Sanitizes a request URL by redacting any sensitive query parameters or credentials.
 */
export function sanitizeRequestUrl(rawUrl: string): { sanitizedUrl: string; hostname: string | null } {
  if (!rawUrl) return { sanitizedUrl: '', hostname: null };
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    const sensitiveParams = [
      'apikey',
      'api_key',
      'api-key',
      'token',
      'access_token',
      'auth_token',
      'password',
      'secret',
      'key',
      'signature',
      'sig',
    ];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveParams.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return {
      sanitizedUrl: sanitizeDiagnosticText(parsed.toString()),
      hostname: parsed.hostname ? parsed.hostname.toLowerCase() : null,
    };
  } catch {
    return {
      sanitizedUrl: sanitizeDiagnosticText(rawUrl),
      hostname: null,
    };
  }
}

interface UnwrappedErrorChain {
  errorCode: string | null;
  errorName: string;
  topMessage: string;
  causeDescription: string | null;
  combinedSearchText: string;
  httpStatus: number | null;
}

const WRAPPER_CODES = new Set([
  'SOURCE_UNAVAILABLE',
  'DOWNLOAD_FAILED',
  'EXTRACTION_FAILED',
  'SECURITY_VIOLATION',
  'DNS_RESOLUTION_FAILED',
]);

/**
 * Unwraps nested `.cause` chains (including Node/Undici `TypeError: fetch failed`
 * and `AggregateError.errors`) and `IngestionError.details` to recover the real
 * low-level OS/TLS/DNS/Undici error code, name, and cause message.
 */
export function unwrapErrorChain(err: unknown, explicitHttpStatus?: number | null): UnwrappedErrorChain {
  const visited = new Set<unknown>();
  const queue: unknown[] = [err];
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  const causeParts: string[] = [];
  let detectedStatus: number | null =
    typeof explicitHttpStatus === 'number' ? explicitHttpStatus : null;

  let isTop = true;
  let topMessage = '';
  let topName = 'Error';

  while (queue.length > 0 && visited.size < 20) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    if (typeof current === 'string') {
      const clean = sanitizeDiagnosticText(current.trim());
      if (clean) {
        messages.push(clean);
        if (!isTop) causeParts.push(clean);
      }
      isTop = false;
      continue;
    }

    if (typeof current !== 'object') {
      isTop = false;
      continue;
    }

    const obj = current as Record<string, unknown>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
    const msg = typeof obj.message === 'string' && obj.message.trim() ? sanitizeDiagnosticText(obj.message.trim()) : null;
    const code =
      typeof obj.code === 'string' && obj.code.trim()
        ? obj.code.trim()
        : typeof obj.errno === 'string' && obj.errno.trim()
        ? obj.errno.trim()
        : null;

    if (isTop) {
      if (name) topName = name;
      if (msg) topMessage = msg;
    } else {
      const part = [
        name && name !== 'Error' ? name : null,
        msg,
        code ? `[code=${code}]` : null,
      ]
        .filter(Boolean)
        .join(': ');
      if (part) causeParts.push(part);
    }

    if (name) names.push(name);
    if (msg) messages.push(msg);
    if (code) codes.push(code);

    // Inspect IngestionError.details if present
    if (obj.details && typeof obj.details === 'object') {
      const details = obj.details as Record<string, unknown>;
      if (typeof details.status === 'number' && detectedStatus === null) {
        detectedStatus = details.status;
      }
      if (typeof details.httpStatus === 'number' && detectedStatus === null) {
        detectedStatus = details.httpStatus;
      }
      if (typeof details.errorCode === 'string' && details.errorCode.trim()) {
        codes.push(details.errorCode.trim());
      }
      if (typeof details.secCode === 'string' && details.secCode.trim()) {
        codes.push(details.secCode.trim());
      }
      if (typeof details.code === 'string' && details.code.trim()) {
        codes.push(details.code.trim());
      }
      if (typeof details.cause === 'string' && details.cause.trim()) {
        const cleanCause = sanitizeDiagnosticText(details.cause.trim());
        causeParts.push(cleanCause);
        messages.push(cleanCause);
      }
      if (typeof details.originalError === 'string' && details.originalError.trim()) {
        const cleanOrig = sanitizeDiagnosticText(details.originalError.trim());
        if (cleanOrig !== topMessage) {
          causeParts.push(cleanOrig);
          messages.push(cleanOrig);
        }
      }
    }

    if (obj.cause) {
      queue.push(obj.cause);
    }
    if (Array.isArray(obj.errors)) {
      for (const subErr of obj.errors) {
        queue.push(subErr);
      }
    }

    isTop = false;
  }

  // Prefer specific low-level OS/Undici/Security error codes over generic IngestionError wrapper codes
  const specificCode = codes.find((c) => !WRAPPER_CODES.has(c)) || codes[0] || null;
  const specificName =
    names.find((n) => n !== 'TypeError' && n !== 'Error' && n !== 'IngestionError') ||
    topName ||
    'Error';

  const uniqueCauses = Array.from(new Set(causeParts));
  const causeDescription = uniqueCauses.length > 0 ? uniqueCauses.join(' | ') : null;

  return {
    errorCode: specificCode,
    errorName: specificName,
    topMessage: topMessage || 'Unknown error',
    causeDescription,
    combinedSearchText: [...codes, ...names, ...messages].join(' ').toLowerCase(),
    httpStatus: detectedStatus,
  };
}

export interface ClassifyNetworkErrorOptions {
  error?: unknown;
  httpStatus?: number | null;
  requestUrl: string;
  timeoutMs: number;
  connectionTimeoutMs?: number;
  attempt: number;
  maxAttempts: number;
  retryDelayMs?: number;
}

/**
 * Classifies any HTTP or network failure into a deterministic `NetworkErrorClassification`,
 * determines whether it is retryable, and preserves the structured error diagnostic.
 */
export function classifyNetworkOrHttpError(params: ClassifyNetworkErrorOptions): StructuredFetchDiagnostic;
export function classifyNetworkOrHttpError(
  error: unknown,
  options: Omit<ClassifyNetworkErrorOptions, 'error'>
): StructuredFetchDiagnostic;
export function classifyNetworkOrHttpError(
  arg1: ClassifyNetworkErrorOptions | unknown,
  arg2?: Omit<ClassifyNetworkErrorOptions, 'error'>
): StructuredFetchDiagnostic {
  const params: ClassifyNetworkErrorOptions =
    arg2 !== undefined
      ? { ...arg2, error: arg1 }
      : (arg1 as ClassifyNetworkErrorOptions);
  const { sanitizedUrl, hostname } = sanitizeRequestUrl(params.requestUrl);
  const unwrapped = unwrapErrorChain(params.error, params.httpStatus);
  const httpStatus = unwrapped.httpStatus;
  const rawCode = unwrapped.errorCode;
  const upperCode = (rawCode || '').toUpperCase();
  const text = unwrapped.combinedSearchText;

  let errorType: NetworkErrorClassification = 'UNKNOWN_NETWORK_ERROR';
  let errorCode: string | null = rawCode;
  let timeoutStage: TimeoutStageClassification | null = null;
  let retryable = false;

  // 1. Check URL / Domain / SSRF security violations first (Permanent, never retried)
  if (
    upperCode === 'DOMAIN_NOT_ALLOWED' ||
    text.includes('non-official domain') ||
    text.includes('unapproved domain') ||
    text.includes('domain not allowed') ||
    text.includes('disallowed domain')
  ) {
    errorType = 'DOMAIN_NOT_ALLOWED';
    errorCode = errorCode || 'DOMAIN_NOT_ALLOWED';
    retryable = false;
  } else if (
    upperCode === 'SSRF_PRIVATE_IP' ||
    upperCode === 'SSRF_BLOCKED_HOST' ||
    upperCode === 'SSRF_DNS_REBINDING' ||
    upperCode === 'SSRF_BLOCKED' ||
    text.includes('private ip') ||
    text.includes('internal/metadata hostname') ||
    text.includes('resolved to blocked private ip') ||
    text.includes('ssrf')
  ) {
    errorType = 'SSRF_BLOCKED';
    errorCode = errorCode || 'SSRF_BLOCKED';
    retryable = false;
  } else if (
    upperCode === 'INVALID_URL_FORMAT' ||
    upperCode === 'ERR_INVALID_URL' ||
    upperCode === 'INVALID_URL' ||
    upperCode === 'INSECURE_PROTOCOL' ||
    upperCode === 'FORBIDDEN_PROTOCOL' ||
    text.includes('malformed url') ||
    text.includes('invalid url') ||
    text.includes('forbidden protocol') ||
    text.includes('http is disabled; https is required') ||
    text.includes('https is required')
  ) {
    errorType = 'INVALID_URL';
    errorCode = errorCode || 'INVALID_URL';
    retryable = false;
  }
  // 2. Check explicit HTTP status codes
  else if (typeof httpStatus === 'number' && httpStatus >= 400) {
    errorCode = errorCode && !WRAPPER_CODES.has(errorCode) ? errorCode : `HTTP_${httpStatus}`;
    if (httpStatus === 429) {
      errorType = 'HTTP_429';
      retryable = true;
    } else if (httpStatus === 502) {
      errorType = 'HTTP_502';
      retryable = true;
    } else if (httpStatus === 503) {
      errorType = 'HTTP_503';
      retryable = true;
    } else if (httpStatus === 504) {
      errorType = 'HTTP_504';
      retryable = true;
    } else if (httpStatus === 408) {
      errorType = 'TIMEOUT';
      timeoutStage = 'REQUEST_TIMEOUT';
      retryable = true;
    } else if (httpStatus === 403) {
      errorType = 'HTTP_403';
      retryable = false;
    } else if (httpStatus === 404) {
      errorType = 'HTTP_404';
      retryable = false;
    } else if (httpStatus >= 500 && httpStatus <= 599) {
      errorType = 'HTTP_5XX';
      retryable = true;
    } else {
      errorType = 'HTTP_4XX';
      retryable = false;
    }
  }
  // 3. Check TLS Handshake Timeout before general TLS errors
  else if (
    upperCode === 'ERR_TLS_HANDSHAKE_TIMEOUT' ||
    upperCode === 'TLS_HANDSHAKE_TIMEOUT' ||
    ((text.includes('tls') || text.includes('handshake')) &&
      (text.includes('timeout') || text.includes('timed out')))
  ) {
    errorType = 'TIMEOUT';
    timeoutStage = 'TLS_HANDSHAKE_TIMEOUT';
    errorCode =
      errorCode && !WRAPPER_CODES.has(errorCode)
        ? errorCode
        : 'TLS_HANDSHAKE_TIMEOUT';
    retryable = true;
  }
  // 4. Check TLS / Certificate errors
  // Explicit TLS/SSL/cert error codes and deterministic certificate error strings always classify as TLS_ERROR.
  // Generic 'tls'/'ssl'/'certificate' keyword fallback must not override explicit OS socket reset/refused codes
  // (e.g. Node's ECONNRESET wrapper: "Client network socket disconnected before secure TLS connection was established").
  else if (
    upperCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    upperCode === 'CERT_HAS_EXPIRED' ||
    upperCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    upperCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    upperCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    upperCode === 'CERT_UNTRUSTED' ||
    upperCode === 'UNABLE_TO_GET_ISSUER_CERT' ||
    upperCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    upperCode === 'EPROTO' ||
    upperCode.startsWith('ERR_TLS_') ||
    upperCode.startsWith('ERR_SSL_') ||
    upperCode.startsWith('CERT_') ||
    text.includes('unable to verify the first certificate') ||
    text.includes('self signed certificate') ||
    text.includes('self-signed certificate') ||
    text.includes('certificate has expired') ||
    ((upperCode !== 'ECONNRESET' &&
      upperCode !== 'EPIPE' &&
      upperCode !== 'UND_ERR_SOCKET' &&
      upperCode !== 'ECONNREFUSED') &&
      (text.includes('tls') || text.includes('ssl') || text.includes('certificate')))
  ) {
    errorType = 'TLS_ERROR';
    errorCode = errorCode || 'TLS_ERROR';
    // Deterministic certificate validation failures are permanent; transient TLS resets are retryable
    const isDeterministicCertError =
      upperCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      upperCode === 'CERT_HAS_EXPIRED' ||
      upperCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      upperCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      upperCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
      upperCode === 'CERT_UNTRUSTED' ||
      upperCode === 'UNABLE_TO_GET_ISSUER_CERT' ||
      upperCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
      text.includes('unable to verify the first certificate') ||
      text.includes('self signed certificate') ||
      text.includes('self-signed certificate') ||
      text.includes('certificate has expired');
    retryable = !isDeterministicCertError;
  }
  // 5. Check DNS errors
  else if (
    upperCode === 'ENOTFOUND' ||
    upperCode === 'EAI_AGAIN' ||
    upperCode === 'EAI_FAIL' ||
    upperCode === 'EAI_NODATA' ||
    upperCode === 'ENODATA' ||
    upperCode === 'ESERVFAIL' ||
    upperCode === 'DNS_RESOLUTION_FAILED' ||
    upperCode === 'DNS_RESOLUTION_EMPTY' ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('getaddrinfo') ||
    text.includes('unable to resolve hostname') ||
    text.includes('no ip addresses resolved')
  ) {
    errorType = 'DNS_ERROR';
    errorCode = errorCode || 'ENOTFOUND';
    retryable = true;
  }
  // 6. Check Connection Reset
  else if (
    upperCode === 'ECONNRESET' ||
    upperCode === 'EPIPE' ||
    upperCode === 'UND_ERR_SOCKET' ||
    text.includes('econnreset') ||
    text.includes('socket hang up') ||
    text.includes('connection reset') ||
    text.includes('other side closed')
  ) {
    errorType = 'CONNECTION_RESET';
    errorCode = errorCode || 'ECONNRESET';
    retryable = true;
  }
  // 7. Check Connection Refused
  else if (
    upperCode === 'ECONNREFUSED' ||
    text.includes('econnrefused') ||
    text.includes('connection refused')
  ) {
    errorType = 'CONNECTION_REFUSED';
    errorCode = errorCode || 'ECONNREFUSED';
    retryable = true;
  }
  // 8. Check Timeout (CONNECT_TIMEOUT, READ_TIMEOUT, REQUEST_TIMEOUT, OS ETIMEDOUT)
  else if (
    upperCode === 'ETIMEDOUT' ||
    upperCode === 'ESOCKETTIMEDOUT' ||
    upperCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    upperCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    upperCode === 'UND_ERR_BODY_TIMEOUT' ||
    upperCode === 'CONNECT_TIMEOUT' ||
    upperCode === 'READ_TIMEOUT' ||
    upperCode === 'ABORT_ERR' ||
    upperCode === 'REQUEST_TIMEOUT' ||
    upperCode === 'TIMEOUT' ||
    unwrapped.errorName === 'TimeoutError' ||
    unwrapped.errorName === 'AbortError' ||
    unwrapped.errorName === 'ConnectTimeoutError' ||
    unwrapped.errorName === 'HeadersTimeoutError' ||
    unwrapped.errorName === 'BodyTimeoutError' ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('aborted') ||
    text.includes('abort')
  ) {
    errorType = 'TIMEOUT';
    if (
      upperCode === 'UND_ERR_CONNECT_TIMEOUT' ||
      upperCode === 'CONNECT_TIMEOUT' ||
      unwrapped.errorName === 'ConnectTimeoutError' ||
      text.includes('connect timeout')
    ) {
      timeoutStage = 'CONNECT_TIMEOUT';
      errorCode =
        errorCode && !WRAPPER_CODES.has(errorCode)
          ? errorCode
          : 'UND_ERR_CONNECT_TIMEOUT';
    } else if (
      upperCode === 'UND_ERR_HEADERS_TIMEOUT' ||
      upperCode === 'UND_ERR_BODY_TIMEOUT' ||
      upperCode === 'READ_TIMEOUT' ||
      unwrapped.errorName === 'HeadersTimeoutError' ||
      unwrapped.errorName === 'BodyTimeoutError' ||
      text.includes('read timeout') ||
      text.includes('headers timeout') ||
      text.includes('body timeout')
    ) {
      timeoutStage = 'READ_TIMEOUT';
      errorCode =
        errorCode && !WRAPPER_CODES.has(errorCode) ? errorCode : 'READ_TIMEOUT';
    } else {
      timeoutStage = 'REQUEST_TIMEOUT';
      errorCode =
        errorCode && !WRAPPER_CODES.has(errorCode) ? errorCode : 'ETIMEDOUT';
    }
    retryable = true;
  }
  // 8. Check Network Unavailable (ENETUNREACH, EHOSTUNREACH, ENETDOWN, EHOSTDOWN)
  else if (
    upperCode === 'ENETUNREACH' ||
    upperCode === 'EHOSTUNREACH' ||
    upperCode === 'ENETDOWN' ||
    upperCode === 'EHOSTDOWN' ||
    text.includes('enetunreach') ||
    text.includes('ehostunreach') ||
    text.includes('network is unreachable') ||
    text.includes('no route to host') ||
    text.includes('network unavailable')
  ) {
    errorType = 'NETWORK_UNAVAILABLE';
    errorCode = errorCode || 'ENETUNREACH';
    retryable = true;
  }
  // 9. Check HTTP status embedded in message when httpStatus wasn't passed explicitly
  else if (/\bhttp\s+403\b|\b\(http\s+403\)/i.test(text)) {
    errorType = 'HTTP_403';
    errorCode = 'HTTP_403';
    retryable = false;
  } else if (/\bhttp\s+404\b|\b\(http\s+404\)/i.test(text)) {
    errorType = 'HTTP_404';
    errorCode = 'HTTP_404';
    retryable = false;
  } else if (/\bhttp\s+429\b|\b\(http\s+429\)/i.test(text)) {
    errorType = 'HTTP_429';
    errorCode = 'HTTP_429';
    retryable = true;
  } else if (/\bhttp\s+502\b|\b\(http\s+502\)/i.test(text)) {
    errorType = 'HTTP_502';
    errorCode = 'HTTP_502';
    retryable = true;
  } else if (/\bhttp\s+503\b|\b\(http\s+503\)/i.test(text)) {
    errorType = 'HTTP_503';
    errorCode = 'HTTP_503';
    retryable = true;
  } else if (/\bhttp\s+504\b|\b\(http\s+504\)/i.test(text)) {
    errorType = 'HTTP_504';
    errorCode = 'HTTP_504';
    retryable = true;
  }
  // 10. Unknown network error (e.g. generic "fetch failed" without a specific error code)
  else {
    errorType = 'UNKNOWN_NETWORK_ERROR';
    errorCode = errorCode && !WRAPPER_CODES.has(errorCode) ? errorCode : null;
    // Transient unknown network errors (e.g., raw fetch failed / temporary socket glitch) are retryable
    retryable = true;
  }

  // Build informative errorMessage that never hides the underlying cause behind bare "fetch failed"
  let errorMessage = unwrapped.topMessage;
  if (
    unwrapped.causeDescription &&
    (errorMessage.toLowerCase() === 'fetch failed' ||
      errorMessage.toLowerCase().endsWith(': fetch failed'))
  ) {
    errorMessage = `${errorMessage} (${unwrapped.causeDescription})`;
  } else if (
    errorCode &&
    !errorMessage.includes(errorCode) &&
    errorMessage.toLowerCase() === 'fetch failed'
  ) {
    errorMessage = `${errorMessage} [${errorCode}]`;
  }

  const delayMs = params.retryDelayMs ?? 0;

  return {
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    errorType,
    errorCode,
    errorName: unwrapped.errorName,
    errorMessage: sanitizeDiagnosticText(errorMessage),
    cause: unwrapped.causeDescription ? sanitizeDiagnosticText(unwrapped.causeDescription) : null,
    requestUrl: sanitizedUrl,
    hostname,
    httpStatus,
    timeoutMs: params.timeoutMs,
    connectionTimeoutMs: params.connectionTimeoutMs ?? params.timeoutMs,
    timeoutStage,
    retryable,
    retryDelayMs: delayMs,
    reason: errorType,
    statusCode: httpStatus,
    delayMs,
  };
}
