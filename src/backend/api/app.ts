/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { correlationMiddleware } from './middleware/correlation.ts';
import { errorHandlerMiddleware } from './middleware/error-handler.ts';
import {
  attachAuthContextMiddleware,
  createApiAuthMiddleware,
  type ApiAuthOptions,
} from './middleware/auth.ts';
import { createRateLimitMiddleware, type RateLimitOptions } from './middleware/rate-limit.ts';
import {
  createCorsMiddleware,
  requestSanityMiddleware,
  securityHeadersMiddleware,
  type CorsMiddlewareOptions,
} from './middleware/security.ts';
import { healthRouter } from './routes/health.ts';
import { statusRouter } from './routes/status.ts';
import { jobsRouter } from './routes/jobs.ts';
import { auditRouter } from './routes/audit.ts';
import { ingestionRouter } from './routes/ingestion.ts';
import { operationsRouter } from './routes/operations.ts';
import { NotFoundError } from './errors.ts';
import { getConfig } from '../config/index.ts';
import { getAppVersion } from '../runtime/app-version.ts';
import { logger } from '../config/logger.ts';

export interface CreateApiAppOptions {
  auth?: ApiAuthOptions;
  rateLimit?: RateLimitOptions;
  cors?: CorsMiddlewareOptions;
  bodyLimit?: string;
}

export function createApiApp(options: CreateApiAppOptions = {}): express.Application {
  const app = express();
  app.disable('x-powered-by');
  let trustProxyHops = 0;
  try {
    trustProxyHops = getConfig().TRUST_PROXY;
  } catch {
    trustProxyHops = 0;
  }
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  const bodyLimit = options.bodyLimit ?? process.env.API_BODY_LIMIT ?? '512kb';

  // Core correlation & security headers
  app.use(correlationMiddleware);

  // Root /health represents process liveness / basic service availability only.
  // Production dependency readiness is exposed separately at /api/ready, /api/health, and /api/status.
  app.get('/health', (_req, res) => {
    const config = getConfig();
    res.status(200).json({
      status: 'alive',
      probe: 'LIVENESS',
      service: 'OmniHub GovJobs Automation AI',
      version: getAppVersion(),
      environment: config.NODE_ENV,
      uptime_seconds: Math.floor(process.uptime()),
      readiness_endpoint: '/api/ready',
      health_endpoint: '/api/health',
      status_endpoint: '/api/status',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', securityHeadersMiddleware);
  app.use('/api', createCorsMiddleware(options.cors));
  app.use('/api', requestSanityMiddleware);

  // Strict request body size limit
  app.use('/api', express.json({ limit: bodyLimit }));

  // Attach verified authentication context (if Bearer token present) before rate limiter
  app.use('/api', attachAuthContextMiddleware(options.auth));

  // Enforce per-IP & per-token rate limiting (exempting verified internal trusted operations)
  app.use('/api', createRateLimitMiddleware(options.rateLimit));

  // Request logging (tokens/secrets automatically redacted by logger)
  app.use('/api', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl.split('?')[0]} - ${res.statusCode} (${durationMs}ms)`, {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs,
        correlationId: req.correlationId,
        actorType: req.auth?.actorType ?? 'ANONYMOUS',
      });
    });
    next();
  });

  // Centralized authentication guard: protects ALL /api/* endpoints by default
  // except explicit public readiness probes (/api/health and /api/status)
  app.use('/api', createApiAuthMiddleware(options.auth));

  // API sub-routers
  app.use('/api', healthRouter);
  app.use('/api', statusRouter);
  app.use('/api', jobsRouter);
  app.use('/api', auditRouter);
  app.use('/api', ingestionRouter);
  app.use('/api', operationsRouter);

  // 404 for unknown API routes
  app.use('/api/*', (req, _res, next) => {
    next(new NotFoundError(`API endpoint not found: ${req.method} ${req.originalUrl}`));
  });

  // Centralized Error Handler
  app.use(errorHandlerMiddleware);

  return app;
}
