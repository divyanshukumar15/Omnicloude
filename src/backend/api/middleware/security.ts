/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import {
  BadRequestError,
  ForbiddenError,
  UnsupportedMediaTypeError,
} from '../errors.ts';
import { recordSecurityAudit } from './security-audit.ts';

export interface CorsMiddlewareOptions {
  allowedOrigins?: string[];
  nodeEnv?: 'development' | 'production' | 'test';
  allowCredentials?: boolean;
}

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function resolveAllowedOrigins(options: CorsMiddlewareOptions = {}): Set<string> {
  const nodeEnv = options.nodeEnv ?? (process.env.NODE_ENV as 'development' | 'production' | 'test') ?? 'development';
  const allowed = new Set<string>();

  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    for (const raw of options.allowedOrigins) {
      const normalized = normalizeOrigin(raw);
      if (normalized) allowed.add(normalized);
    }
    return allowed;
  }

  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const raw of envOrigins) {
    // Strictly forbid wildcard '*' in CORS configuration
    if (raw === '*') continue;
    const normalized = normalizeOrigin(raw);
    if (normalized) allowed.add(normalized);
  }

  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl) {
    const normalized = normalizeOrigin(appUrl);
    if (normalized) allowed.add(normalized);
  }

  // Local dev default origin (never added automatically in production)
  if (nodeEnv !== 'production' && allowed.size === 0) {
    allowed.add('http://localhost:3000');
    allowed.add('http://127.0.0.1:3000');
  }

  return allowed;
}

/**
 * Security headers applied to all API responses.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  if (process.env.NODE_ENV === 'production' || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

/**
 * Strict CORS middleware:
 * - Never emits Access-Control-Allow-Origin: *
 * - Rejects disallowed Origins with 403 CORS_ORIGIN_NOT_ALLOWED
 * - Handles credentials safely only for explicitly allowlisted origins
 */
export function createCorsMiddleware(options: CorsMiddlewareOptions = {}) {
  const allowCredentials = options.allowCredentials ?? true;

  return (req: Request, res: Response, next: NextFunction): void => {
    const originHeader = req.headers.origin;
    if (typeof originHeader !== 'string' || originHeader.trim() === '') {
      // Non-browser or same-origin request without Origin header
      if (req.method.toUpperCase() === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    const normalizedRequestOrigin = normalizeOrigin(originHeader);
    const allowedOrigins = resolveAllowedOrigins(options);

    if (!normalizedRequestOrigin || !allowedOrigins.has(normalizedRequestOrigin)) {
      recordSecurityAudit({
        req,
        actorType: req.auth?.actorType ?? 'ANONYMOUS',
        status: 'FAILURE',
        action: 'CORS_ORIGIN_DENIED',
        reason: 'ORIGIN_NOT_ALLOWED',
        details: { origin: originHeader },
      });
      next(new ForbiddenError('CORS origin is not allowed', 'CORS_ORIGIN_NOT_ALLOWED'));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Vary', 'Origin');
    if (allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Request-Id, X-Correlation-Id'
    );
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method.toUpperCase() === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Request abuse & malformed input protection middleware:
 * - Rejects null bytes, excessively long URLs, and path-traversal anomalies
 * - Enforces application/json Content-Type on mutating requests with payloads
 */
export function requestSanityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const rawUrl = req.originalUrl || req.url || '';
  if (rawUrl.length > 2048) {
    next(new BadRequestError('Request URL exceeds maximum allowed length', 'URL_TOO_LONG'));
    return;
  }

  if (rawUrl.includes('\0') || /%00/i.test(rawUrl) || rawUrl.includes('..')) {
    recordSecurityAudit({
      req,
      actorType: req.auth?.actorType ?? 'ANONYMOUS',
      status: 'FAILURE',
      action: 'MALFORMED_REQUEST_BLOCKED',
      reason: 'SUSPICIOUS_URL_PATTERN',
    });
    next(new BadRequestError('Malformed or unsafe request path', 'MALFORMED_REQUEST'));
    return;
  }

  const method = req.method.toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const contentLength = Number(req.headers['content-length'] || '0');
    const hasTransferEncoding = Boolean(req.headers['transfer-encoding']);
    if (contentLength > 0 || hasTransferEncoding) {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        next(
          new UnsupportedMediaTypeError(
            'Content-Type must be application/json for mutating API requests'
          )
        );
        return;
      }
    }
  }

  next();
}
