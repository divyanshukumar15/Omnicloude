/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const correlationId = typeof incomingId === 'string' && incomingId.trim() !== ''
    ? incomingId
    : crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}
