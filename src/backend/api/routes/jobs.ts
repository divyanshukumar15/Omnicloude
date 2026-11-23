/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { z } from 'zod';
import { getJobService, InvalidStateTransitionError } from '../../jobs/index.ts';
import { getPipelineEngine } from '../../pipeline/index.ts';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { requirePermissions } from '../middleware/auth.ts';
import { recordSecurityAudit } from '../middleware/security-audit.ts';
import type { PipelineStageName, ProcessingJobStatus } from '../../database/types.ts';

export const jobsRouter = Router();

const SAFE_ID_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;

const CreateJobSchema = z
  .object({
    targetEntityType: z.string().min(1, 'targetEntityType is required').max(64),
    targetEntityId: z.string().min(1, 'targetEntityId is required').max(128),
    initialStage: z
      .enum([
        'SOURCE_DISCOVERY',
        'DOCUMENT_DISCOVERY',
        'DOCUMENT_DOWNLOAD',
        'DOCUMENT_VALIDATION',
        'TEXT_EXTRACTION',
        'STRUCTURED_EXTRACTION',
        'EVIDENCE_VALIDATION',
        'DUPLICATE_CHECK',
        'PUBLISHING_GATE',
        'WORDPRESS_PUBLISH',
      ])
      .optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// POST /api/jobs - Create a processing job (requires authenticated admin/automation access)
jobsRouter.post('/jobs', requirePermissions('jobs:write'), (req, res, next) => {
  try {
    const validated = CreateJobSchema.parse(req.body);
    const jobService = getJobService();

    const job = jobService.createJob({
      targetEntityType: validated.targetEntityType,
      targetEntityId: validated.targetEntityId,
      initialStage: validated.initialStage as PipelineStageName | undefined,
      maxAttempts: validated.maxAttempts,
      metadata: validated.metadata,
      correlationId: req.correlationId,
      actor: req.auth?.actorType || 'REST_API',
    });

    res.status(201).json({
      success: true,
      data: job,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id - Get a processing job by ID (requires authenticated access)
jobsRouter.get('/jobs/:id', requirePermissions('jobs:read'), (req, res, next) => {
  try {
    if (!SAFE_ID_REGEX.test(req.params.id)) {
      throw new BadRequestError('Invalid job ID format', 'INVALID_JOB_ID');
    }

    const jobService = getJobService();
    const job = jobService.getJob(req.params.id);

    if (!job) {
      throw new NotFoundError(`Processing job "${req.params.id}" not found`);
    }

    res.json({
      success: true,
      data: job,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs - List recent processing jobs (requires authenticated access)
jobsRouter.get('/jobs', requirePermissions('jobs:read'), (req, res, next) => {
  try {
    const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const status = req.query.status as ProcessingJobStatus | undefined;
    const jobService = getJobService();

    const jobs = jobService.listJobs(limit, status);

    res.json({
      success: true,
      count: jobs.length,
      data: jobs,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/run-stage - Run current stage safely via pipeline engine
// Enforces stage:execute and (for WORDPRESS_PUBLISH) publish:execute permissions
jobsRouter.post(
  '/jobs/:id/run-stage',
  requirePermissions('stage:execute'),
  async (req, res, next) => {
    try {
      if (!SAFE_ID_REGEX.test(req.params.id)) {
        throw new BadRequestError('Invalid job ID format', 'INVALID_JOB_ID');
      }

      const jobService = getJobService();
      const job = jobService.getJob(req.params.id);
      if (!job) {
        throw new NotFoundError(`Processing job "${req.params.id}" not found`);
      }

      if (job.stage === 'WORDPRESS_PUBLISH' && !req.auth?.permissions.has('publish:execute')) {
        recordSecurityAudit({
          req,
          actorType: req.auth?.actorType ?? 'ANONYMOUS',
          status: 'FAILURE',
          action: 'API_AUTHORIZATION_DENIED',
          reason: 'MISSING_PUBLISH_PERMISSION',
          details: { job_id: job.job_id, stage: job.stage },
        });
        throw new ForbiddenError(
          'Publishing stage execution requires publish:execute permission'
        );
      }

      const engine = getPipelineEngine();
      const stageInput =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};

      const result = await engine.executeCurrentStage(
        req.params.id,
        req.correlationId,
        stageInput
      );

      res.json({
        success: result.result.success,
        job: result.job,
        execution_result: result.result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/jobs/:id/retry - Manually re-queue a FAILED or PAUSED job back to PENDING
jobsRouter.post('/jobs/:id/retry', requirePermissions('jobs:write'), (req, res, next) => {
  try {
    if (!SAFE_ID_REGEX.test(req.params.id)) {
      throw new BadRequestError('Invalid job ID format', 'INVALID_JOB_ID');
    }

    const jobService = getJobService();
    const existing = jobService.getJob(req.params.id);
    if (!existing) {
      throw new NotFoundError(`Processing job "${req.params.id}" not found`);
    }

    const retried = jobService.retryJob(
      req.params.id,
      req.auth?.actorType || 'OPERATOR',
      req.correlationId
    );

    res.json({
      success: true,
      data: retried,
    });
  } catch (err) {
    if (err instanceof InvalidStateTransitionError) {
      next(new ConflictError(err.message, 'INVALID_JOB_RETRY_STATE'));
      return;
    }
    next(err);
  }
});
