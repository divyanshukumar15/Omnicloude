/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request } from 'express';
import { getAuditService } from '../../audit/index.ts';
import { logger } from '../../config/logger.ts';

export type SecurityActorType =
  | 'ADMIN_BEARER'
  | 'AUTOMATION_CLIENT'
  | 'READONLY_CLIENT'
  | 'INTERNAL_SERVICE'
  | 'ANONYMOUS';

export interface SecurityAuditPayload {
  req: Request;
  actorType: SecurityActorType;
  status: 'SUCCESS' | 'FAILURE';
  action: string;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Records API security, authentication, authorization, and rate-limit events
 * without ever persisting or logging credentials, tokens, or Authorization headers.
 */
export function recordSecurityAudit(payload: SecurityAuditPayload): void {
  const timestamp = new Date().toISOString();
  const route = `${payload.req.method} ${payload.req.originalUrl.split('?')[0]}`;
  const requestId = payload.req.correlationId || 'unknown';

  const safeDetails: Record<string, unknown> = {
    timestamp,
    route,
    actor_type: payload.actorType,
    status: payload.status,
    request_id: requestId,
    reason: payload.reason,
    client_ip: payload.req.ip || payload.req.socket?.remoteAddress || 'unknown',
    ...(payload.details ?? {}),
  };

  if (payload.status === 'FAILURE') {
    logger.warn(`[SECURITY_AUDIT] ${payload.action} (${payload.reason})`, {
      correlationId: requestId,
      route,
      actorType: payload.actorType,
      reason: payload.reason,
    });
  } else {
    logger.debug(`[SECURITY_AUDIT] ${payload.action}`, {
      correlationId: requestId,
      route,
      actorType: payload.actorType,
      reason: payload.reason,
    });
  }

  try {
    const auditService = getAuditService();
    auditService.record({
      correlationId: requestId,
      actor: payload.actorType,
      action: payload.action,
      entityType: 'API_ROUTE',
      entityId: route,
      stage: 'API_SECURITY_LAYER',
      status: payload.status,
      details: safeDetails,
    });
  } catch {
    // Database may not be initialized in isolated middleware-only unit tests
  }
}
