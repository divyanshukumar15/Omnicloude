/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { IAuditLogRepository } from '../database/repositories/contracts.ts';
import type { AuditLogEntity } from '../database/types.ts';
import { logger } from '../config/logger.ts';

export interface AuditEventInput {
  correlationId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  stage?: string | null;
  status: 'SUCCESS' | 'FAILURE' | 'INFO';
  details?: Record<string, unknown> | null;
}

export class AuditService {
  private auditRepo: IAuditLogRepository;

  constructor(auditRepo: IAuditLogRepository) {
    this.auditRepo = auditRepo;
  }

  /**
   * Records an immutable audit log entry and logs it to structured stdout.
   */
  record(input: AuditEventInput): AuditLogEntity {
    const detailsJson = input.details ? JSON.stringify(input.details) : null;

    const log = this.auditRepo.create({
      id: crypto.randomUUID(),
      correlation_id: input.correlationId,
      actor: input.actor,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      stage: input.stage ?? null,
      status: input.status,
      details_json: detailsJson,
    });

    logger.info(`[AUDIT] ${input.action} on ${input.entityType}:${input.entityId}`, {
      correlationId: input.correlationId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      stage: input.stage ?? undefined,
      status: input.status,
    });

    return log;
  }

  getByCorrelationId(correlationId: string): AuditLogEntity[] {
    return this.auditRepo.listByCorrelationId(correlationId);
  }

  getByEntity(entityType: string, entityId: string): AuditLogEntity[] {
    return this.auditRepo.listByEntity(entityType, entityId);
  }

  getRecent(limit = 100): AuditLogEntity[] {
    return this.auditRepo.listRecent(limit);
  }
}
