/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type FailureClassification = 'TRANSIENT' | 'PERMANENT';

const PERMANENT_ERROR_CODES = new Set([
  'STAGE_NOT_IMPLEMENTED',
  'INVALID_INPUT',
  'INVALID_JOB_ID',
  'MISSING_RECRUITMENT_ID',
  'RECRUITMENT_NOT_FOUND',
  'CORRUPTED_RECRUITMENT_PAYLOAD',
  'MISSING_STRUCTURED_FIELDS',
  'PUBLISHING_GATE_BLOCKED',
  'GATE_EVALUATION_ERROR',
  'EVIDENCE_VALIDATION_FAILED',
  'CORRUPT_PDF',
  'SSRF_BLOCKED',
  'SECURITY_VIOLATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'AUTH_FAILED',
  'WP_AUTH_FAILED',
  'WP_CONFIG_INVALID',
  'WP_NOT_CONFIGURED',
  'WP_VALIDATION_ERROR',
  'OCR_PROVIDER_UNAVAILABLE',
  'OCR_LIMIT_EXCEEDED',
  'VALIDATION_ERROR',
  'SCHEMA_VALIDATION_ERROR',
  'DUPLICATE_CONFIRMED',
  'PERMANENT_FAILURE',
  'CANCELLED_BY_USER',
  'DB_PERSISTENCE_PERMANENT',
  'DATABASE_CONSTRAINT_ERROR',
  'DATABASE_SCHEMA_ERROR',
]);

const TRANSIENT_ERROR_CODES = new Set([
  'TIMEOUT',
  'TRANSIENT_FAILURE',
  'TRANSIENT_ERROR',
  'NETWORK_ERROR',
  'NETWORK_UNAVAILABLE',
  'CONNECTION_RESET',
  'CONNECTION_REFUSED',
  'DNS_FAILURE',
  'TLS_FAILURE',
  'SOURCE_UNAVAILABLE',
  'DOWNLOAD_FAILED',
  'OCR_TIMEOUT',
  'OCR_RATE_LIMIT',
  'WP_TIMEOUT',
  'WP_RATE_LIMITED',
  'WP_SERVER_ERROR',
  'WP_NETWORK_ERROR',
  'SCHEDULER_EXECUTION_ERROR',
  'LEASE_EXPIRED_RECOVERED',
  'RATE_LIMIT_EXCEEDED',
  'HTTP_429',
  'HTTP_5XX',
  'DB_PERSISTENCE_TRANSIENT',
  'DATABASE_BUSY',
  'DATABASE_LOCKED',
]);

const PERMANENT_PATTERN =
  /ssrf|security\s*violation|unauthorized|forbidden|invalid\s*(input|url|config|schema|job)|private\s*ip|corrupt|schema\s*validation|gate\s*(blocked|rejected)|not\s*implemented|not\s*configured|permanently\s*invalid|permanent\s*failure|sqlite_constraint|foreign\s+key\s+constraint|check\s+constraint|not\s+null\s+constraint|no\s+such\s+(table|column)/i;

const TRANSIENT_PATTERN =
  /transient|timeout|timed\s*out|econnreset|econnrefused|etimedout|enotfound|ehostunreach|epipe|429|500|502|503|504|rate\s*limit|temporarily\s*unavailable|socket\s*hang\s*up|network\s*(error|unavailable|reset)|service\s*unavailable|database\s+(is\s+)?locked|sqlite_busy|sqlite_locked|sqlite_ioerr/i;

/**
 * Classifies a stage/job failure as TRANSIENT (eligible for bounded retry)
 * or PERMANENT (must remain FAILED immediately without retrying).
 */
export function classifyJobFailure(
  errorCode?: string | null,
  errorMessage?: string | null
): FailureClassification {
  const normalizedCode = (errorCode || '').trim().toUpperCase();
  const message = errorMessage || '';

  if (normalizedCode && PERMANENT_ERROR_CODES.has(normalizedCode)) {
    return 'PERMANENT';
  }

  if (PERMANENT_PATTERN.test(message)) {
    return 'PERMANENT';
  }

  if (normalizedCode && TRANSIENT_ERROR_CODES.has(normalizedCode)) {
    return 'TRANSIENT';
  }

  if (normalizedCode && /TRANSIENT|TIMEOUT|NETWORK|RATE_LIMIT|RETRY|5XX|502|503|504|429/.test(normalizedCode)) {
    return 'TRANSIENT';
  }

  if (TRANSIENT_PATTERN.test(message)) {
    return 'TRANSIENT';
  }

  // Fail closed: unrecognized validation/logic failures are not retried indefinitely
  return 'PERMANENT';
}

/**
 * Computes exponential backoff with equal jitter:
 * delay lies in [0.5 * cappedExponential, cappedExponential], strictly >= 1ms.
 */
export function computeRetryBackoffMs(
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  randomFn: () => number = Math.random
): number {
  const safeBase = Math.max(1, baseBackoffMs);
  const safeMax = Math.max(safeBase, maxBackoffMs);
  const exponent = Math.max(0, attempt - 1);
  const exponential = Math.min(safeMax, safeBase * Math.pow(2, exponent));
  const clampedRandom = Math.min(1, Math.max(0, randomFn()));
  return Math.max(1, Math.round(exponential * (0.5 + 0.5 * clampedRandom)));
}
