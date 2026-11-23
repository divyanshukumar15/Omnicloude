/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { getConfig } from '../../config/index.ts';
import { evaluateSystemReadiness } from '../../runtime/readiness-service.ts';
import { getAppVersion } from '../../runtime/app-version.ts';
import { prepareOpsBody } from '../redact-public.ts';

export const healthRouter = Router();

/**
 * Pure process liveness probe: answers ONLY "is the Node.js process alive?"
 * Never fails due to external dependencies (WordPress, remote worker, OCR).
 */
healthRouter.get('/live', (_req, res) => {
  const config = getConfig();
  res.status(200).json({
    status: 'alive',
    probe: 'LIVENESS',
    service: 'OmniHub GovJobs Automation AI',
    version: getAppVersion(),
    environment: config.NODE_ENV,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Authoritative production readiness probe: answers "can this service safely process production jobs?"
 * Returns HTTP 200 ONLY when overallReadiness is READY (or DEGRADED in non-production);
 * returns HTTP 503 when NOT_READY (or in production whenever critical dependencies are missing/unproven).
 */
healthRouter.get('/ready', async (req, res) => {
  const startTime = Date.now();
  const config = getConfig();
  const evalReport = await evaluateSystemReadiness({ remoteTimeoutMs: 1500 });
  const isProd = config.NODE_ENV === 'production';

  const readyForTraffic = isProd
    ? evalReport.overallReadiness === 'READY'
    : evalReport.overallReadiness !== 'NOT_READY';

  res.status(readyForTraffic ? 200 : 503).json(prepareOpsBody(req, {
    probe: 'READINESS',
    ready: readyForTraffic,
    status: evalReport.overallReadiness,
    overall_readiness: evalReport.overallReadiness,
    CODE_READY: evalReport.CODE_READY,
    RUNTIME_READY: evalReport.RUNTIME_READY,
    EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
    PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
    production_proof: evalReport.productionProof,
    production_guards: evalReport.productionGuards,
    blockers: evalReport.blockers,
    dependencies: evalReport.dependencies,
    environment: config.NODE_ENV,
    timestamp: evalReport.timestamp,
    duration_ms: Date.now() - startTime,
  }));
});

healthRouter.get('/health', async (req, res) => {
  const startTime = Date.now();
  const config = getConfig();
  const evalReport = await evaluateSystemReadiness({ remoteTimeoutMs: 1500 });

  const {
    dbHealthy,
    dbLatencyMs,
    schedulerHealth,
    wpReadiness,
    storageHealth,
    runnerMode,
    remoteConfig,
    remoteHealth,
    ocrConfigured,
  } = evalReport.raw;

  const schedulerFailed = schedulerHealth.status === 'FAILED';
  const uptimeSeconds = Math.floor(process.uptime());
  const memUsage = process.memoryUsage();

  // Preserve liveness status contract for process health probes while exposing full truthful readiness
  const overallHealthy = dbHealthy && !schedulerFailed;
  const legacyReadiness: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' =
    evalReport.overallReadiness === 'READY'
      ? 'HEALTHY'
      : evalReport.overallReadiness === 'DEGRADED'
        ? 'DEGRADED'
        : 'UNHEALTHY';
  const responseStatus = overallHealthy ? 200 : 503;

  res.status(responseStatus).json(prepareOpsBody(req, {
    status: overallHealthy ? 'healthy' : 'unhealthy',
    readiness: legacyReadiness,
    overall_readiness: evalReport.overallReadiness,
    CODE_READY: evalReport.CODE_READY,
    RUNTIME_READY: evalReport.RUNTIME_READY,
    EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
    PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
    production_proof: evalReport.productionProof,
    production_guards: evalReport.productionGuards,
    blockers: evalReport.blockers,
    timestamp: evalReport.timestamp,
    service: 'OmniHub GovJobs Automation AI',
    version: getAppVersion(),
    environment: config.NODE_ENV,
    uptime_seconds: uptimeSeconds,
    scheduler: {
      status: schedulerHealth.status,
      readiness: schedulerHealth.readiness,
      dependency_status: evalReport.dependencies.scheduler.status,
      automatic_processing_disabled: Boolean(
        evalReport.dependencies.scheduler.metadata?.automaticProcessingDisabled
      ),
      running: schedulerHealth.running,
      automationMode: schedulerHealth.automationMode,
      workerId: schedulerHealth.workerId,
      activeCount: schedulerHealth.activeCount,
      dbRunningCount: schedulerHealth.dbRunningCount,
      lastPollAt: schedulerHealth.lastPollAt,
      totalClaimedCount: schedulerHealth.totalClaimedCount,
      totalRetriedCount: schedulerHealth.totalRetriedCount,
      totalRecoveredCount: schedulerHealth.totalRecoveredCount,
      error: schedulerHealth.error,
      seeder: schedulerHealth.seeder,
    },
    checks: {
      database: {
        status: dbHealthy ? 'up' : 'down',
        readiness: evalReport.dependencies.database.status,
        driver: 'sqlite3-sync',
        latency_ms: dbLatencyMs,
      },
      scheduler: {
        status: schedulerHealth.status,
        readiness: schedulerHealth.readiness,
        dependency_status: evalReport.dependencies.scheduler.status,
        automatic_processing_disabled: Boolean(
          evalReport.dependencies.scheduler.metadata?.automaticProcessingDisabled
        ),
        running: schedulerHealth.running,
        automationMode: schedulerHealth.automationMode,
        workerId: schedulerHealth.workerId,
        activeCount: schedulerHealth.activeCount,
        dbRunningCount: schedulerHealth.dbRunningCount,
        lastPollAt: schedulerHealth.lastPollAt,
        totalClaimedCount: schedulerHealth.totalClaimedCount,
        totalRetriedCount: schedulerHealth.totalRetriedCount,
        totalRecoveredCount: schedulerHealth.totalRecoveredCount,
        error: schedulerHealth.error,
        seeder: schedulerHealth.seeder,
      },
      source_registry: {
        status: evalReport.dependencies.sourceRegistry.status,
        details: evalReport.dependencies.sourceRegistry.details,
        ...(evalReport.dependencies.sourceRegistry.metadata || {}),
      },
      source_adapters: {
        status: evalReport.dependencies.sourceAdapters.status,
        details: evalReport.dependencies.sourceAdapters.details,
        ...(evalReport.dependencies.sourceAdapters.metadata || {}),
      },
      durable_document_storage: {
        status: storageHealth.status,
        readiness: evalReport.dependencies.durableDocumentStorage.status,
        storage_dir: storageHealth.storageDir,
        configured: storageHealth.configured,
        durable: storageHealth.durable,
        using_temp_fallback: storageHealth.usingTempFallback,
        writable: storageHealth.writable,
        reason: storageHealth.reason,
      },
      extraction_pipeline: {
        status: evalReport.dependencies.extractionPipeline.status,
        details: evalReport.dependencies.extractionPipeline.details,
        ...(evalReport.dependencies.extractionPipeline.metadata || {}),
      },
      remote_worker: {
        mode: runnerMode,
        readiness: evalReport.dependencies.remoteAcquisition.status,
        configured: remoteConfig.configured,
        endpoint_url: remoteConfig.workerEndpoint,
        is_local_worker: remoteConfig.isLocalWorker,
        reachable: remoteHealth?.reachable ?? false,
        healthy: remoteHealth?.healthy ?? false,
        status: remoteHealth?.remoteStatus ?? 'REMOTE_NOT_CONFIGURED',
        execution_environment: remoteHealth?.executionEnvironment ?? null,
      },
      wordpress: {
        status: wpReadiness.status,
        verification_tier: wpReadiness.verificationTier,
        configured: wpReadiness.configured,
        endpoint_url: wpReadiness.endpointUrl,
        reachable: wpReadiness.reachable,
        authenticated: wpReadiness.authenticated,
        latency_ms: wpReadiness.latencyMs,
        error_code: wpReadiness.errorCode ?? null,
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
        live_verified: evalReport.raw.ocrReadiness.liveVerified,
        cached: evalReport.raw.ocrReadiness.cached,
        error_code: evalReport.raw.ocrReadiness.errorCode,
      },
      docker_worker: {
        status: evalReport.dependencies.dockerWorker.status,
        details: evalReport.dependencies.dockerWorker.details,
        ...(evalReport.dependencies.dockerWorker.metadata || {}),
      },
      memory: {
        rss_mb: Math.round((memUsage.rss / 1024 / 1024) * 100) / 100,
        heap_used_mb: Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100,
      },
    },
    readiness_evaluation: {
      overallReadiness: evalReport.overallReadiness,
      CODE_READY: evalReport.CODE_READY,
      RUNTIME_READY: evalReport.RUNTIME_READY,
      EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
      PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
      productionProof: evalReport.productionProof,
      productionGuards: evalReport.productionGuards,
      blockers: evalReport.blockers,
      dependencies: evalReport.dependencies,
    },
    duration_ms: Date.now() - startTime,
  }));
});
