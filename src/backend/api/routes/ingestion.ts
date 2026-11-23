/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { z } from 'zod';
import { sourceRegistry } from '../../ingestion/adapters/registry.ts';
import { classifyDomainTrust } from '../../ingestion/discovery/official-domains.ts';
import {
  getJobService,
  buildDocumentDedupeKey,
  buildSourceDiscoveryDedupeKey,
  normalizeOfficialIdentityUrl,
} from '../../jobs/index.ts';
import { getRepositories } from '../../database/index.ts';
import { validateTargetUrl, SecurityViolationError } from '../../security/url-security.ts';
import { requirePermissions } from '../middleware/auth.ts';

export const ingestionRouter = Router();

// GET /api/adapters - List official government adapters (authenticated)
ingestionRouter.get('/adapters', requirePermissions('adapters:read'), async (req, res, next) => {
  try {
    const checkLive = req.query.check_live === 'true';
    const adapters = sourceRegistry.getAll();

    const results = await Promise.all(
      adapters.map(async (adapter) => {
        let health = null;
        if (checkLive) {
          health = await adapter.healthCheck();
        }
        return {
          sourceId: adapter.sourceId,
          name: adapter.name,
          jurisdiction: adapter.jurisdiction,
          baseUrl: adapter.baseUrl,
          health: health ?? {
            status: 'UNVERIFIED',
            verifiedLive: false,
            message: 'Pass ?check_live=true to run live network check',
          },
        };
      })
    );

    res.json({
      success: true,
      totalAdapters: results.length,
      data: results,
    });
  } catch (err) {
    next(err);
  }
});

const IngestRequestSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(64),
    documentUrl: z.string().trim().url().max(1024).optional(),
    documentType: z.string().trim().min(1).max(64).optional(),
    noticeTitle: z.string().trim().min(1).max(300).optional(),
    runnerMode: z.enum(['LOCAL', 'REMOTE', 'AUTO']).optional(),
  })
  .strict();

// POST /api/ingest - Queue controlled official ingestion onto the canonical 10-stage PipelineEngine
ingestionRouter.post('/ingest', requirePermissions('ingest:execute'), async (req, res, next) => {
  try {
    const validated = IngestRequestSchema.parse(req.body);
    const adapter = sourceRegistry.get(validated.sourceId);

    if (!adapter) {
      res.status(400).json({
        success: false,
        error: {
          code: 'UNKNOWN_SOURCE',
          message: `Unknown official source adapter ID: ${validated.sourceId}`,
          correlationId: req.correlationId,
        },
      });
      return;
    }

    const repos = getRepositories();
    const jobService = getJobService();
    const actor = req.auth?.actorType || 'API_INGEST';

    // Ensure the canonical source row exists before enqueueing pipeline work
    let sourceRow = repos.sources.findById(adapter.sourceId);
    if (!sourceRow) {
      sourceRow = repos.sources.create({
        id: adapter.sourceId,
        name: adapter.name,
        type: 'PORTAL',
        base_url: adapter.baseUrl,
        is_active: 1,
        check_interval_minutes: 60,
        config_json: '{}',
      });
    }

    if (validated.documentUrl) {
      // Enforce SSRF & official domain allowlist before queuing DOCUMENT_DOWNLOAD
      try {
        await validateTargetUrl(validated.documentUrl, {
          allowHttp: true,
          skipDnsLookup: true,
        });
      } catch (secErr) {
        const code =
          secErr instanceof SecurityViolationError ? secErr.code : 'INVALID_DOCUMENT_URL';
        res.status(400).json({
          success: false,
          error: {
            code,
            message: (secErr as Error).message,
            correlationId: req.correlationId,
          },
        });
        return;
      }

      const trust = classifyDomainTrust(validated.documentUrl, adapter.sourceId);
      if (!trust.isOfficial) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NON_OFFICIAL_DOMAIN',
            message:
              trust.reason ||
              `Document URL domain "${trust.domain}" is not an official government domain for ${adapter.sourceId}`,
            correlationId: req.correlationId,
          },
        });
        return;
      }

      const canonicalUrl = normalizeOfficialIdentityUrl(validated.documentUrl);
      const dedupeKey = buildDocumentDedupeKey(adapter.sourceId, canonicalUrl);
      const { job, created } = jobService.createJobWithStatus({
        dedupeKey,
        targetEntityType: 'DOCUMENT',
        targetEntityId: dedupeKey,
        initialStage: 'DOCUMENT_DOWNLOAD',
        metadata: {
          sourceId: adapter.sourceId,
          documentUrl: validated.documentUrl,
          canonicalUrl,
          sourceDomain: trust.domain,
          documentType: validated.documentType || 'NOTIFICATION_PDF',
          ...(validated.noticeTitle ? { noticeTitle: validated.noticeTitle } : {}),
          ...(validated.runnerMode ? { runnerMode: validated.runnerMode } : {}),
          triggeredVia: 'API_INGEST',
        },
        correlationId: req.correlationId,
        actor,
      });

      res.status(created ? 202 : 200).json({
        success: true,
        pipeline: 'CANONICAL_PIPELINE_ENGINE',
        jobId: job.job_id,
        status: job.status,
        stage: job.stage,
        deduplicated: !created,
        dedupeKey: job.dedupe_key,
        sourceId: adapter.sourceId,
        documentUrl: validated.documentUrl,
        job,
      });
      return;
    }

    const checkIntervalMinutes = sourceRow.check_interval_minutes || 60;
    const dedupeKey = buildSourceDiscoveryDedupeKey(adapter.sourceId, checkIntervalMinutes);
    const { job, created } = jobService.createJobWithStatus({
      dedupeKey,
      targetEntityType: 'SOURCE',
      targetEntityId: adapter.sourceId,
      initialStage: 'SOURCE_DISCOVERY',
      metadata: {
        sourceId: adapter.sourceId,
        checkIntervalMinutes,
        ...(validated.runnerMode ? { runnerMode: validated.runnerMode } : {}),
        triggeredVia: 'API_INGEST',
      },
      correlationId: req.correlationId,
      actor,
    });

    res.status(created ? 202 : 200).json({
      success: true,
      pipeline: 'CANONICAL_PIPELINE_ENGINE',
      jobId: job.job_id,
      status: job.status,
      stage: job.stage,
      deduplicated: !created,
      dedupeKey: job.dedupe_key,
      sourceId: adapter.sourceId,
      job,
    });
  } catch (err) {
    next(err);
  }
});
