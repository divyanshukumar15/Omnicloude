/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, TooManyRequestsError } from '../errors.ts';
import { logger } from '../../config/logger.ts';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const correlationId = req.correlationId || 'unknown';
  const bodyErr = err as BodyParserError;

  // Handle Express JSON body-parser size limit errors
  if (bodyErr.type === 'entity.too.large' || bodyErr.status === 413) {
    logger.warn('Request body exceeded size limit', {
      correlationId,
      path: req.originalUrl,
    });

    res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds maximum allowed size limit',
        correlationId,
      },
    });
    return;
  }

  // Handle Express malformed JSON syntax errors
  if (bodyErr.type === 'entity.parse.failed' || (err instanceof SyntaxError && bodyErr.status === 400)) {
    logger.warn('Malformed JSON payload rejected', {
      correlationId,
      path: req.originalUrl,
    });

    res.status(400).json({
      success: false,
      error: {
        code: 'MALFORMED_JSON',
        message: 'Request body contains malformed JSON',
        correlationId,
      },
    });
    return;
  }

  // Handle Zod Schema Validation Errors
  if (err instanceof ZodError) {
    const formattedIssues = err.issues.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    logger.warn('Request validation failed', {
      correlationId,
      path: req.originalUrl,
      issues: formattedIssues,
    });

    res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request payload validation failed',
        details: formattedIssues,
        correlationId,
      },
    });
    return;
  }

  // Handle Known Operational AppErrors
  if (err instanceof AppError) {
    if (err instanceof TooManyRequestsError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }

    logger.warn(`Operational error: ${err.message}`, {
      correlationId,
      statusCode: err.statusCode,
      code: err.errorCode,
      details: err.details,
    });

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details,
        correlationId,
      },
    });
    return;
  }

  // Handle Unhandled Internal Exceptions
  logger.error('Unhandled internal server error', err, {
    correlationId,
    path: req.originalUrl,
    method: req.method,
  });

  const isDev = process.env.NODE_ENV !== 'production';

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An internal server error occurred',
      correlationId,
      ...(isDev ? { debug: err.message } : {}),
    },
  });
}
