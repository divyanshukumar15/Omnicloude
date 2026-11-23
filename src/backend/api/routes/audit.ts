/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { z } from 'zod';
import { getAuditService } from '../../audit/index.ts';
import { requirePermissions } from '../middleware/auth.ts';

export const auditRouter = Router();

// GET /api/audit - Read audit logs (requires authenticated access)
auditRouter.get('/audit', requirePermissions('audit:read'), (req, res) => {
  const auditService = getAuditService();
  const correlationId = req.query.correlation_id as string | undefined;
  const entityType = req.query.entity_type as string | undefined;
  const entityId = req.query.entity_id as string | undefined;
  const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  let logs;
  if (correlationId) {
    logs = auditService.getByCorrelationId(correlationId);
  } else if (entityType && entityId) {
    logs = auditService.getByEntity(entityType, entityId);
  } else {
    logs = auditService.getRecent(limit);
  }

  res.json({
    success: true,
    count: logs.length,
    data: logs,
  });
});

const CreateAuditEventSchema = z
  .object({
    action: z.string().min(1).max(128),
    entityType: z.string().min(1).max(64),
    entityId: z.string().min(1).max(128),
    stage: z.string().max(64).optional(),
    status: z.enum(['SUCCESS', 'FAILURE', 'INFO']).default('INFO'),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// POST /api/audit - Record an authenticated operator/admin audit entry
auditRouter.post('/audit', requirePermissions('audit:write'), (req, res, next) => {
  try {
    const validated = CreateAuditEventSchema.parse(req.body);
    const auditService = getAuditService();

    const record = auditService.record({
      correlationId: req.correlationId,
      actor: req.auth?.actorType || 'ADMIN_BEARER',
      action: validated.action,
      entityType: validated.entityType,
      entityId: validated.entityId,
      stage: validated.stage ?? 'ADMIN_AUDIT',
      status: validated.status,
      details: validated.details ?? null,
    });

    res.status(201).json({
      success: true,
      data: record,
    });
  } catch (err) {
    next(err);
  }
});
