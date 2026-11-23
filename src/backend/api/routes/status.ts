/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { getPipelineEngine } from '../../pipeline/index.ts';
import { getJobService } from '../../jobs/index.ts';
import { evaluateSystemReadiness } from '../../runtime/readiness-service.ts';
import { getAppVersion } from '../../runtime/app-version.ts';
import { prepareOpsBody } from '../redact-public.ts';

export const statusRouter = Router();

statusRouter.get('/status', async (req, res) => {
  const engine = getPipelineEngine();
  const jobService = getJobService();
  const evalReport = await evaluateSystemReadiness({ remoteTimeoutMs: 1500 });

  const {
    dbHealthy,
    schedulerHealth,
    wpReadiness,
    storageHealth,
    runnerMode,
    remoteConfig,
    remoteHealth,
    ocrConfigured,
    ocrReadiness,
  } = evalReport.raw;
  const pipelineStages = engine.getPipelineDefinition();
  const jobCounts = jobService.getStatusCounts();
  const schedulerFailed = schedulerHealth.status === 'FAILED';
  const isProd = evalReport.environment === 'production';
  const systemStatus =
    !dbHealthy || schedulerFailed
      ? 'DEGRADED'
      : isProd && evalReport.overallReadiness !== 'READY'
        ? evalReport.overallReadiness
        : 'OPERATIONAL';

  const appVersion = getAppVersion();
  const body = {
    service: 'OmniHub GovJobs Automation AI',
    version: appVersion,
    architecture_phase: `v${appVersion}`,
    environment: evalReport.environment,
    system_status: systemStatus,
    readiness: evalReport.overallReadiness,
    overall_readiness: evalReport.overallReadiness,
    CODE_READY: evalReport.CODE_READY,
    RUNTIME_READY: evalReport.RUNTIME_READY,
    EXTERNAL_SERVICES_READY: evalReport.EXTERNAL_SERVICES_READY,
    PRODUCTION_PROVEN: evalReport.PRODUCTION_PROVEN,
    production_proof: evalReport.productionProof,
    production_guards: evalReport.productionGuards,
    blockers: evalReport.blockers,
    timestamp: evalReport.timestamp,
    jobs_summary: jobCounts,
    scheduler: {
      status: schedulerHealth.status,
      readiness: schedulerHealth.readiness,
      dependency_status: evalReport.dependencies.scheduler.status,
      automatic_processing_disabled: Boolean(
        evalReport.dependencies.scheduler.metadata?.automaticProcessingDisabled
      ),
      initialized: schedulerHealth.initialized,
      running: schedulerHealth.running,
      stopping: schedulerHealth.stopping,
      automationMode: schedulerHealth.automationMode,
      workerId: schedulerHealth.workerId,
      pollIntervalSeconds: schedulerHealth.pollIntervalSeconds,
      maxConcurrentJobs: schedulerHealth.maxConcurrentJobs,
      activeCount: schedulerHealth.activeCount,
      activeJobIds: schedulerHealth.activeJobIds,
      dbRunningCount: schedulerHealth.dbRunningCount,
      lastPollAt: schedulerHealth.lastPollAt,
      totalClaimedCount: schedulerHealth.totalClaimedCount,
      totalRetriedCount: schedulerHealth.totalRetriedCount,
      totalRecoveredCount: schedulerHealth.totalRecoveredCount,
      startedAt: schedulerHealth.startedAt,
      error: schedulerHealth.error,
      seeder: schedulerHealth.seeder,
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
    ocr: {
      status: evalReport.dependencies.ocr.status,
      provider: ocrReadiness.provider,
      model: ocrReadiness.model,
      configured: ocrConfigured,
      OCR_CONFIGURED: ocrReadiness.OCR_CONFIGURED,
      OCR_PROVIDER_REACHABLE: ocrReadiness.OCR_PROVIDER_REACHABLE,
      OCR_MODEL_VALID: ocrReadiness.OCR_MODEL_VALID,
      OCR_PRODUCTION_READY: ocrReadiness.OCR_PRODUCTION_READY,
      classification: ocrReadiness.classification,
      live_verified: ocrReadiness.liveVerified,
      cached: ocrReadiness.cached,
      error_code: ocrReadiness.errorCode,
    },
    pipeline: {
      total_stages: pipelineStages.length,
      stages: pipelineStages,
      execution_mode: 'CONTRACT_GATED_STRICT',
      fake_completion_allowed: false,
      production_publishing_enabled: wpReadiness.status === 'READY',
    },
    wordpress_publishing: {
      status: wpReadiness.status,
      readiness: wpReadiness.status,
      verification_tier: wpReadiness.verificationTier,
      configured: wpReadiness.configured,
      endpoint_url: wpReadiness.endpointUrl,
      https_enforced: wpReadiness.httpsEnforced,
      default_post_status: wpReadiness.defaultPostStatus,
      reachable: wpReadiness.reachable,
      authenticated: wpReadiness.authenticated,
      error_code: wpReadiness.errorCode ?? null,
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
    security: {
      ssrf_protection: 'ENABLED',
      https_preferred: true,
      private_ip_blocking: 'STRICT',
      content_type_enforcement: 'ENABLED',
    },
  };
  res.json(prepareOpsBody(req, body));
});
