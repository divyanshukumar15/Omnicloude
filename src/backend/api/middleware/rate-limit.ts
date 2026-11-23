/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import { TooManyRequestsError } from '../errors.ts';
import { recordSecurityAudit } from './security-audit.ts';

export interface RateLimitOptions {
  windowMs?: number;
  maxPerIp?: number;
  maxPerToken?: number;
  skipHealthProbes?: boolean;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

function getClientIp(req: Request): string {
  const addr = req.ip || req.socket?.remoteAddress || 'unknown';
  return addr.replace(/^::ffff:/, '');
}

/**
 * In-memory sliding-window rate limiter enforcing limits per client IP and per
 * authenticated token fingerprint, while exempting verified internal trusted
 * callers and optionally health readiness probes.
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}) {
  const ipBuckets = new Map<string, RateBucket>();
  const tokenBuckets = new Map<string, RateBucket>();

  const resolveLimits = () => ({
    windowMs:
      options.windowMs ??
      (process.env.API_RATE_LIMIT_WINDOW_MS
        ? Number(process.env.API_RATE_LIMIT_WINDOW_MS)
        : 60000),
    maxPerIp:
      options.maxPerIp ??
      (process.env.API_RATE_LIMIT_MAX_IP ? Number(process.env.API_RATE_LIMIT_MAX_IP) : 120),
    maxPerToken:
      options.maxPerToken ??
      (process.env.API_RATE_LIMIT_MAX_TOKEN ? Number(process.env.API_RATE_LIMIT_MAX_TOKEN) : 240),
  });

  const skipHealthProbes = options.skipHealthProbes ?? true;

  const consumeBucket = (
    store: Map<string, RateBucket>,
    key: string,
    limit: number,
    windowMs: number,
    now: number
  ): { allowed: boolean; remaining: number; resetAt: number } => {
    // Periodic opportunistic cleanup to avoid unbounded map growth
    if (store.size > 5000) {
      for (const [k, b] of store.entries()) {
        if (b.resetAt <= now) store.delete(k);
      }
    }

    const existing = store.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      store.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt };
    }

    existing.count += 1;
    const remaining = Math.max(0, limit - existing.count);
    return {
      allowed: existing.count <= limit,
      remaining,
      resetAt: existing.resetAt,
    };
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method.toUpperCase() === 'OPTIONS') {
      next();
      return;
    }

    // Verified internal trusted service operations (via timing-safe INTERNAL_TRUSTED_TOKEN) are exempt
    if (req.auth?.isTrustedInternal) {
      next();
      return;
    }

    const normalizedPath = req.path.replace(/\/+$/, '') || '/';
    if (
      skipHealthProbes &&
      req.method.toUpperCase() === 'GET' &&
      (normalizedPath === '/health' || normalizedPath === '/api/health')
    ) {
      next();
      return;
    }

    const { windowMs, maxPerIp, maxPerToken } = resolveLimits();
    const now = Date.now();
    const clientIp = getClientIp(req);

    // 1. Per-IP check
    const ipResult = consumeBucket(ipBuckets, `ip:${clientIp}`, maxPerIp, windowMs, now);
    res.setHeader('X-RateLimit-Limit', String(maxPerIp));
    res.setHeader('X-RateLimit-Remaining', String(ipResult.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(ipResult.resetAt / 1000)));

    if (!ipResult.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((ipResult.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      recordSecurityAudit({
        req,
        actorType: req.auth?.actorType ?? 'ANONYMOUS',
        status: 'FAILURE',
        action: 'API_RATE_LIMIT_EXCEEDED',
        reason: 'IP_RATE_LIMIT_EXCEEDED',
        details: { limit: maxPerIp, window_ms: windowMs },
      });
      next(
        new TooManyRequestsError(
          `Rate limit exceeded for IP address. Retry after ${retryAfterSec}s.`,
          retryAfterSec
        )
      );
      return;
    }

    // 2. Per-authenticated-token fingerprint check
    if (req.auth?.tokenFingerprint) {
      const tokenResult = consumeBucket(
        tokenBuckets,
        `tok:${req.auth.tokenFingerprint}`,
        maxPerToken,
        windowMs,
        now
      );
      if (!tokenResult.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil((tokenResult.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        recordSecurityAudit({
          req,
          actorType: req.auth.actorType,
          status: 'FAILURE',
          action: 'API_RATE_LIMIT_EXCEEDED',
          reason: 'TOKEN_RATE_LIMIT_EXCEEDED',
          details: {
            token_fingerprint: req.auth.tokenFingerprint,
            limit: maxPerToken,
            window_ms: windowMs,
          },
        });
        next(
          new TooManyRequestsError(
            `Rate limit exceeded for authenticated client. Retry after ${retryAfterSec}s.`,
            retryAfterSec
          )
        );
        return;
      }
    }

    next();
  };
}
