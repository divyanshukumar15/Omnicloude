/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { getRepositories } from '../../database/index.ts';
import { getConfig } from '../../config/index.ts';
import { getJobService } from '../../jobs/index.ts';
import { sourceRegistry } from '../../ingestion/adapters/registry.ts';
import { sourceEndpointRegistry } from '../../ingestion/discovery/endpoint-registry.ts';
import { evaluateSystemReadiness } from '../../runtime/readiness-service.ts';
import { requirePermissions } from '../middleware/auth.ts';

export const operationsRouter = Router();

// GET /api/operations - Authenticated operational summary for control UI & operators
operationsRouter.get('/operations', requirePermissions('jobs:read'), async (_req, res, next) => {
  try {
    const config = getConfig();
    const repos = getRepositories();
    const jobService = getJobService();
    const evalReport = await evaluateSystemReadiness({ remoteTimeoutMs: 1500 });

    const {
      schedulerHealth,
      wpReadiness,
      storageHealth,
      runnerMode,
      remoteConfig,
      remoteHealth,
      ocrConfigured,
    } = evalReport.raw;

    const adapters = sourceRegistry.getAll();
    const sources = adapters.map((adapter) => {
      const latestRun = repos.sourceDiscoveryRuns.findLatestBySource(adapter.sourceId);
      const endpoints = sourceEndpointRegistry.getEndpointsForSource(adapter.sourceId);
      const dbSource = repos.sources.findById(adapter.sourceId);
      return {
        sourceId: adapter.sourceId,
        name: adapter.name,
        jurisdiction: adapter.jurisdiction,
        baseUrl: adapter.baseUrl,
        endpointCount: endpoints.length,
        isActive: dbSource ? dbSource.is_active === 1 : false,
        checkIntervalMinutes: dbSource?.check_interval_minutes ?? null,
        latestRun: latestRun
          ? {
              id: latestRun.id,
              adapterStatus: latestRun.adapter_status,
              httpStatus: latestRun.http_status,
              finalUrl: latestRun.final_url,
              recordsFound: latestRun.records_found,
              documentsFound: latestRun.documents_found,
              errorCode: latestRun.error_code,
              errorMessage: latestRun.error_message,
              completedAt: latestRun.completed_at,
            }
          : null,
      };
    });

    const jobCounts = jobService.getStatusCounts();
    const recentJobs = jobService.listJobs(25);
    const publishingRecords = repos.publishing.listRecent(20).map((rec) => ({
      id: rec.id,
      jobId: rec.job_id,
      recruitmentId: rec.recruitment_id ?? null,
      platform: rec.platform,
      externalPostId: rec.external_post_id,
      externalIdentityKey: rec.external_identity_key ?? null,
      permalink: rec.permalink ?? null,
      postStatus: rec.post_status ?? null,
      publishStatus: rec.publish_status,
      publishedAt: rec.published_at,
      updatedAt: rec.updated_at ?? null,
      errorMessage: rec.error_message,
    }));

    const auditLogs = repos.auditLogs.listRecent(25).map((log) => ({
      id: log.id,
      correlationId: log.correlation_id,
      actor: log.actor,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      stage: log.stage,
      status: log.status,
      createdAt: log.created_at,
    }));

    res.json({
      success: true,
      timestamp: evalReport.timestamp,
      readiness: evalReport.overallReadiness,
      CODE_READY: evalReport.CODE_READY,
      RUNTIME_READY: evalReport.RUNTIME_READY,
      EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
      PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
      production_proof: evalReport.productionProof,
      blockers: evalReport.blockers,
      scheduler: {
        status: schedulerHealth.status,
        readiness: schedulerHealth.readiness,
        running: schedulerHealth.running,
        automationMode: schedulerHealth.automationMode,
        workerId: schedulerHealth.workerId,
        pollIntervalSeconds: schedulerHealth.pollIntervalSeconds,
        maxConcurrentJobs: schedulerHealth.maxConcurrentJobs,
        activeCount: schedulerHealth.activeCount,
        dbRunningCount: schedulerHealth.dbRunningCount,
        lastPollAt: schedulerHealth.lastPollAt,
        totalClaimedCount: schedulerHealth.totalClaimedCount,
        totalRetriedCount: schedulerHealth.totalRetriedCount,
        totalRecoveredCount: schedulerHealth.totalRecoveredCount,
        error: schedulerHealth.error,
        seeder: schedulerHealth.seeder,
      },
      dependencies: {
        remoteWorker: {
          mode: runnerMode,
          readiness: evalReport.dependencies.remoteAcquisition.status,
          configured: remoteConfig.configured,
          endpointUrl: remoteConfig.workerEndpoint,
          isLocalWorker: remoteConfig.isLocalWorker,
          reachable: remoteHealth?.reachable ?? false,
          healthy: remoteHealth?.healthy ?? false,
          status: remoteHealth?.remoteStatus ?? 'REMOTE_NOT_CONFIGURED',
          executionEnvironment: remoteHealth?.executionEnvironment ?? null,
        },
        wordPress: {
          status: wpReadiness.status,
          verificationTier: wpReadiness.verificationTier,
          configured: wpReadiness.configured,
          endpointUrl: wpReadiness.endpointUrl,
          reachable: wpReadiness.reachable,
          authenticated: wpReadiness.authenticated,
          defaultPostStatus: wpReadiness.defaultPostStatus,
          errorCode: wpReadiness.errorCode ?? null,
        },
        ocr: {
          status: evalReport.dependencies.ocr.status,
          provider: evalReport.raw.ocrReadiness.provider,
          model: evalReport.raw.ocrReadiness.model,
          configured: ocrConfigured,
          OCR_CONFIGURED: evalReport.raw.ocrReadiness.OCR_CONFIGURED,
          OCR_PROVIDER_REACHABLE: evalReport.raw.ocrReadiness.OCR_PROVIDER_REACHABLE,
          OCR_MODEL_VALID: evalReport.raw.ocrReadiness.OCR_MODEL_VALID,
          OCR_PRODUCTION_READY: evalReport.raw.ocrReadiness.OCR_PRODUCTION_READY,
          classification: evalReport.raw.ocrReadiness.classification,
          liveVerified: evalReport.raw.ocrReadiness.liveVerified,
          cached: evalReport.raw.ocrReadiness.cached,
          errorCode: evalReport.raw.ocrReadiness.errorCode,
        },
        durableDocumentStorage: {
          status: storageHealth.status,
          readiness: evalReport.dependencies.durableDocumentStorage.status,
          storageDir: storageHealth.storageDir,
          configured: storageHealth.configured,
          durable: storageHealth.durable,
          usingTempFallback: storageHealth.usingTempFallback,
          writable: storageHealth.writable,
          reason: storageHealth.reason,
        },
        sourceRegistry: evalReport.dependencies.sourceRegistry,
        dockerWorker: evalReport.dependencies.dockerWorker,
      },
      readiness_evaluation: {
        overallReadiness: evalReport.overallReadiness,
        CODE_READY: evalReport.CODE_READY,
        RUNTIME_READY: evalReport.RUNTIME_READY,
        EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
        PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
        productionProof: evalReport.productionProof,
        blockers: evalReport.blockers,
        dependencies: evalReport.dependencies,
      },
      sources,
      jobs: {
        counts: jobCounts,
        recent: recentJobs,
      },
      publishing: publishingRecords,
      auditLogs,
    });
  } catch (err) {
    next(err);
  }
});
