/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request } from 'express';

/**
 * Keys that reveal infrastructure details (internal URLs, worker identity, running job IDs,
 * filesystem paths). They are removed from every response served to callers that do not hold
 * the `health:read` permission (public liveness/readiness/status probes).
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'endpoint_url',
  'endpointUrl',
  'workerEndpoint',
  'workerId',
  'activeJobIds',
  'storage_dir',
  'storageDir',
]);

/** True when the request carries a verified token with `health:read` permission. */
export function canViewSensitiveOps(req: Request): boolean {
  return Boolean(req.auth?.permissions.has('health:read'));
}

/** Deep copy of a JSON-like value with all sensitive keys removed. */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      out[key] = redactSensitive(inner);
    }
    return out as T;
  }
  return value;
}

/** Returns the body unchanged for authorized callers, otherwise a redacted copy. */
export function prepareOpsBody<T>(req: Request, body: T): T {
  return canViewSensitiveOps(req) ? body : redactSensitive(body);
}
