/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../errors.ts';
import { recordSecurityAudit, type SecurityActorType } from './security-audit.ts';

export type ApiPermission =
  | 'health:read'
  | 'adapters:read'
  | 'jobs:read'
  | 'jobs:write'
  | 'stage:execute'
  | 'ingest:execute'
  | 'publish:execute'
  | 'audit:read'
  | 'audit:write';

export const ADMIN_PERMISSIONS: ReadonlySet<ApiPermission> = new Set<ApiPermission>([
  'health:read',
  'adapters:read',
  'jobs:read',
  'jobs:write',
  'stage:execute',
  'ingest:execute',
  'publish:execute',
  'audit:read',
  'audit:write',
]);

export const AUTOMATION_PERMISSIONS: ReadonlySet<ApiPermission> = new Set<ApiPermission>([
  'health:read',
  'adapters:read',
  'jobs:read',
  'jobs:write',
  'stage:execute',
  'ingest:execute',
  'publish:execute',
  'audit:read',
]);

export const READONLY_PERMISSIONS: ReadonlySet<ApiPermission> = new Set<ApiPermission>([
  'health:read',
  'adapters:read',
  'jobs:read',
  'audit:read',
]);

export interface AuthenticatedContext {
  actorType: SecurityActorType;
  permissions: ReadonlySet<ApiPermission>;
  tokenFingerprint: string;
  isTrustedInternal: boolean;
}

export interface ApiAuthOptions {
  authToken?: string;
  readOnlyToken?: string;
  internalTrustedToken?: string;
  publicRoutes?: Array<{ method: string; path: string }>;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

/**
 * Constant-time token comparison over fixed-length SHA-256 digests so neither
 * mismatch position nor token length leaks via timing side-channels.
 */
export function timingSafeTokenEqual(providedToken: string, expectedToken: string): boolean {
  if (!providedToken || !expectedToken) {
    return false;
  }
  const providedDigest = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function hashTokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

function extractBearerToken(req: Request): { ok: true; token: string } | { ok: false; reason: string } {
  const rawHeader = req.headers.authorization;
  if (typeof rawHeader !== 'string' || rawHeader.trim() === '') {
    return { ok: false, reason: 'MISSING_AUTH_HEADER' };
  }

  const match = rawHeader.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !match[1]) {
    return { ok: false, reason: 'INVALID_AUTH_SCHEME' };
  }

  return { ok: true, token: match[1] };
}

function resolveConfiguredTokens(options: ApiAuthOptions) {
  const adminToken = (options.authToken ?? process.env.CONTROL_APP_AUTH_TOKEN ?? '').trim();
  const readOnlyToken = (options.readOnlyToken ?? process.env.CONTROL_APP_READONLY_TOKEN ?? '').trim();
  const internalToken = (
    options.internalTrustedToken ?? process.env.INTERNAL_TRUSTED_TOKEN ?? ''
  ).trim();
  return { adminToken, readOnlyToken, internalToken };
}

function isPublicRoute(
  req: Request,
  publicRoutes: Array<{ method: string; path: string }>
): boolean {
  const normalizedMethod = req.method.toUpperCase();
  const normalizedPath = req.path.replace(/\/+$/, '') || '/';
  return publicRoutes.some(
    (rule) =>
      rule.method.toUpperCase() === normalizedMethod &&
      (rule.path === normalizedPath || `/api${rule.path}` === normalizedPath)
  );
}

const DEFAULT_PUBLIC_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/live' },
  { method: 'GET', path: '/ready' },
  { method: 'GET', path: '/status' },
];

/**
 * Attempts to authenticate incoming request if a Bearer token is present.
 * Attaches req.auth without failing yet (useful before rate limiting so valid
 * tokens can be identified for token-level rate limit buckets and internal bypass).
 */
export function attachAuthContextMiddleware(options: ApiAuthOptions = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const extracted = extractBearerToken(req);
    if (!extracted.ok) {
      next();
      return;
    }

    const { adminToken, readOnlyToken, internalToken } = resolveConfiguredTokens(options);
    const provided = extracted.token;

    if (internalToken && timingSafeTokenEqual(provided, internalToken)) {
      req.auth = {
        actorType: 'INTERNAL_SERVICE',
        permissions: ADMIN_PERMISSIONS,
        tokenFingerprint: hashTokenFingerprint(provided),
        isTrustedInternal: true,
      };
    } else if (adminToken && timingSafeTokenEqual(provided, adminToken)) {
      req.auth = {
        actorType: 'ADMIN_BEARER',
        permissions: ADMIN_PERMISSIONS,
        tokenFingerprint: hashTokenFingerprint(provided),
        isTrustedInternal: false,
      };
    } else if (readOnlyToken && timingSafeTokenEqual(provided, readOnlyToken)) {
      req.auth = {
        actorType: 'READONLY_CLIENT',
        permissions: READONLY_PERMISSIONS,
        tokenFingerprint: hashTokenFingerprint(provided),
        isTrustedInternal: false,
      };
    }

    next();
  };
}

/**
 * Centralized API authentication guard applied to protected endpoints by default.
 * Rejects unauthenticated or invalid requests with HTTP 401 (fail-closed).
 */
export function createApiAuthMiddleware(options: ApiAuthOptions = {}) {
  const publicRoutes = options.publicRoutes ?? DEFAULT_PUBLIC_ROUTES;

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method.toUpperCase() === 'OPTIONS' || isPublicRoute(req, publicRoutes)) {
      next();
      return;
    }

    // Ensure auth context is resolved even if createApiAuthMiddleware is mounted standalone
    if (!req.auth) {
      const extracted = extractBearerToken(req);
      if (!extracted.ok) {
        recordSecurityAudit({
          req,
          actorType: 'ANONYMOUS',
          status: 'FAILURE',
          action: 'API_AUTH_REJECTED',
          reason: extracted.reason,
        });
        next(new UnauthorizedError('Authentication required: Bearer token missing or malformed'));
        return;
      }

      const { adminToken, readOnlyToken, internalToken } = resolveConfiguredTokens(options);
      const provided = extracted.token;

      if (internalToken && timingSafeTokenEqual(provided, internalToken)) {
        req.auth = {
          actorType: 'INTERNAL_SERVICE',
          permissions: ADMIN_PERMISSIONS,
          tokenFingerprint: hashTokenFingerprint(provided),
          isTrustedInternal: true,
        };
      } else if (adminToken && timingSafeTokenEqual(provided, adminToken)) {
        req.auth = {
          actorType: 'ADMIN_BEARER',
          permissions: ADMIN_PERMISSIONS,
          tokenFingerprint: hashTokenFingerprint(provided),
          isTrustedInternal: false,
        };
      } else if (readOnlyToken && timingSafeTokenEqual(provided, readOnlyToken)) {
        req.auth = {
          actorType: 'READONLY_CLIENT',
          permissions: READONLY_PERMISSIONS,
          tokenFingerprint: hashTokenFingerprint(provided),
          isTrustedInternal: false,
        };
      } else {
        const serverConfigured = Boolean(adminToken || readOnlyToken || internalToken);
        const reason = serverConfigured ? 'INVALID_TOKEN' : 'AUTH_TOKEN_NOT_CONFIGURED';
        recordSecurityAudit({
          req,
          actorType: 'ANONYMOUS',
          status: 'FAILURE',
          action: 'API_AUTH_REJECTED',
          reason,
        });
        next(
          new UnauthorizedError(
            serverConfigured
              ? 'Invalid or expired authentication token'
              : 'Server authentication token (CONTROL_APP_AUTH_TOKEN) is not configured',
            serverConfigured ? 'INVALID_CREDENTIALS' : 'AUTH_NOT_CONFIGURED'
          )
        );
        return;
      }
    }

    recordSecurityAudit({
      req,
      actorType: req.auth.actorType,
      status: 'SUCCESS',
      action: 'API_AUTH_VERIFIED',
      reason: 'AUTHENTICATED',
      details: { token_fingerprint: req.auth.tokenFingerprint },
    });

    next();
  };
}

/**
 * Endpoint-level permission enforcement middleware (returns 403 on insufficient permission).
 */
export function requirePermissions(...required: ApiPermission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      recordSecurityAudit({
        req,
        actorType: 'ANONYMOUS',
        status: 'FAILURE',
        action: 'API_AUTH_REJECTED',
        reason: 'MISSING_AUTH_CONTEXT',
      });
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const missing = required.filter((perm) => !req.auth!.permissions.has(perm));
    if (missing.length > 0) {
      recordSecurityAudit({
        req,
        actorType: req.auth.actorType,
        status: 'FAILURE',
        action: 'API_AUTHORIZATION_DENIED',
        reason: 'INSUFFICIENT_PERMISSION',
        details: { missing_permissions: missing },
      });
      next(
        new ForbiddenError(
          `Insufficient permission for this endpoint (missing: ${missing.join(', ')})`
        )
      );
      return;
    }

    next();
  };
}
