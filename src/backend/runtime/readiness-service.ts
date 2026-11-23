/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { getConfig } from '../config/index.ts';
import {
  evaluateProductionConfigGuards,
  type ProductionConfigGuardFinding,
} from '../config/schema.ts';
import {
  getDatabase,
  getRepositories,
  isDatabaseInitialized,
  OFFICIAL_BOOTSTRAP_SOURCES,
} from '../database/index.ts';
import { getSchedulerRuntimeHealth, type SchedulerRuntimeHealth } from '../scheduler/index.ts';
import { getPipelineEngine } from '../pipeline/index.ts';
import { ORDERED_PIPELINE_STAGES } from '../pipeline/stages.ts';
import { sourceRegistry } from '../ingestion/adapters/registry.ts';
import {
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
  type RunnerMode,
} from '../ingestion/discovery/acquisition-runner.ts';
import { checkOcrReadiness, type OcrReadinessReport } from '../ingestion/ocr/index.ts';
import { getDocumentStorageService, type DocumentStorageHealth } from '../storage/index.ts';
import { createWordPressClient, type WordPressReadinessReport } from '../wordpress/index.ts';
import { verifyWorkerPackageFiles } from '../../worker/container-smoke-test.ts';

export type DependencyCheckState =
  | 'READY'
  | 'DEGRADED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'NOT_READY';

export type OverallReadinessState = 'READY' | 'DEGRADED' | 'NOT_READY';

export interface DependencyStatusReport {
  status: DependencyCheckState;
  requiredForRuntime: boolean;
  requiredForProduction: boolean;
  details: string;
  metadata?: Record<string, unknown>;
}

/**
 * Strictly separated 7-flag truthfulness model (BUG 13):
 * Never promotes code, mocks, local loopback, historical JSON, or unverified credentials to PROVEN.
 */
export interface ProductionProofFlags {
  CODE_IMPLEMENTED: boolean;
  RUNTIME_VERIFIED: boolean;
  EXTERNAL_SERVICES_CONFIGURED: boolean;
  REAL_REMOTE_PRODUCTION_PROVEN: boolean;
  REAL_WORDPRESS_PROVEN: boolean;
  DOCKER_BUILD_PROVEN: boolean;
  END_TO_END_PROVEN: boolean;
}

export interface AuthoritativeReadinessReport {
  timestamp: string;
  environment: string;
  overallReadiness: OverallReadinessState;
  /**
   * Backwards-compatible summary flags aligned strictly with `productionProof`.
   */
  CODE_READY: boolean;
  RUNTIME_READY: boolean;
  EXTERNAL_SERVICES_READY: boolean;
  PRODUCTION_PROVEN: boolean;
  productionProof: ProductionProofFlags;
  productionGuards: ProductionConfigGuardFinding[];
  blockers: string[];
  dependencies: {
    database: DependencyStatusReport;
    scheduler: DependencyStatusReport;
    sourceRegistry: DependencyStatusReport;
    sourceAdapters: DependencyStatusReport;
    remoteAcquisition: DependencyStatusReport;
    durableDocumentStorage: DependencyStatusReport;
    ocr: DependencyStatusReport;
    extractionPipeline: DependencyStatusReport;
    wordpress: DependencyStatusReport;
    dockerWorker: DependencyStatusReport;
  };
  raw: {
    dbHealthy: boolean;
    dbLatencyMs: number;
    schedulerHealth: SchedulerRuntimeHealth;
    wpReadiness: WordPressReadinessReport;
    storageHealth: DocumentStorageHealth;
    runnerMode: RunnerMode;
    remoteConfig: {
      configured: boolean;
      workerEndpoint: string | null;
      authConfigured: boolean;
      isLocalWorker: boolean;
      isHttps: boolean;
      isValidProductionRemoteConfig: boolean;
    };
    remoteHealth: {
      reachable: boolean;
      healthy: boolean;
      remoteStatus: string;
      executionEnvironment?: string | null;
      details: string;
    } | null;
    ocrConfigured: boolean;
    ocrReadiness: OcrReadinessReport;
  };
}

export interface EvaluateReadinessOptions {
  remoteTimeoutMs?: number;
  skipDockerCliCheck?: boolean;
  dockerAvailableOverride?: boolean;
  ocrLiveVerify?: boolean;
  ocrForceRefresh?: boolean;
  ocrReadinessOverride?: OcrReadinessReport;
  /**
   * Explicit current-run external proof flags (must only be set from current verified runs;
   * defaults to false so unverified environments never fabricate PROVEN).
   */
  remoteProductionProven?: boolean;
  dockerBuildProven?: boolean;
}

let cachedDockerCliAvailable: boolean | null = null;

function detectDockerCliAvailable(): boolean {
  if (cachedDockerCliAvailable !== null) {
    return cachedDockerCliAvailable;
  }
  try {
    execSync('which docker', { stdio: 'ignore', timeout: 1000 });
    cachedDockerCliAvailable = true;
  } catch {
    cachedDockerCliAvailable = false;
  }
  return cachedDockerCliAvailable;
}


// ---------------------------------------------------------------------------
// Probe cache: public /api/health, /api/status and /api/ready are unauthenticated and each call
// would otherwise trigger live outbound requests (remote worker + WordPress). Only those two
// outbound probes are cached (short TTL, in-flight requests shared); DB, scheduler and storage
// state are always evaluated live.
// ---------------------------------------------------------------------------
interface ProbeCacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}
const probeCache = new Map<string, ProbeCacheEntry>();

function resolveProbeCacheMs(): number {
  const raw = process.env.READINESS_CACHE_SECONDS;
  if (raw !== undefined && raw.trim() !== '') {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : 0;
  }
  // Default: 30s in real production only. Disabled in development and under the node test runner
  // so tests always observe fresh state.
  if (process.env.NODE_ENV === 'production' && !process.env.NODE_TEST_CONTEXT) {
    return 30_000;
  }
  return 0;
}

async function cachedProbe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ttlMs = resolveProbeCacheMs();
  if (ttlMs <= 0) {
    return fn();
  }
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.promise as Promise<T>;
  }
  const promise = fn();
  probeCache.set(key, { expiresAt: now + ttlMs, promise });
  promise.catch(() => {
    if (probeCache.get(key)?.promise === promise) {
      probeCache.delete(key);
    }
  });
  return promise;
}

/** Test/maintenance helper: drop all cached outbound probe results. */
export function clearReadinessProbeCache(): void {
  probeCache.clear();
}

/**
 * Single authoritative readiness evaluation service (BUG 9, BUG 11, BUG 13).
 * Used by /api/health, /api/status, and /api/operations so every endpoint reports
 * consistent, truthful, separated readiness and proof levels without ever conflating
 * code implementation, local runtime, configured credentials, or external production proof.
 */
export async function evaluateSystemReadiness(
  options: EvaluateReadinessOptions = {}
): Promise<AuthoritativeReadinessReport> {
  const timestamp = new Date().toISOString();
  const config = getConfig();
  const isProd = config.NODE_ENV === 'production';
  const blockers: string[] = [];

  // 1. Database connectivity
  let dbHealthy = false;
  let dbLatencyMs = 0;
  if (isDatabaseInitialized()) {
    try {
      const db = getDatabase();
      const qStart = Date.now();
      db.prepare('SELECT 1 as alive').get();
      dbLatencyMs = Date.now() - qStart;
      dbHealthy = true;
    } catch {
      dbHealthy = false;
    }
  }
  const databaseDep: DependencyStatusReport = {
    status: dbHealthy ? 'READY' : 'UNAVAILABLE',
    requiredForRuntime: true,
    requiredForProduction: true,
    details: dbHealthy ? `SQLite reachable (${dbLatencyMs}ms)` : 'SQLite database unavailable',
    metadata: { driver: 'sqlite3-sync', latency_ms: dbLatencyMs },
  };
  if (!dbHealthy) blockers.push('Database is not initialized or unreachable');

  const productionGuards = evaluateProductionConfigGuards(config);

  // 2. Scheduler (Production automation guard: never silently treat manual mode as READY in production)
  const schedulerHealth = getSchedulerRuntimeHealth();
  const schedulerFailed = schedulerHealth.status === 'FAILED';
  const productionManualAutomationDisabled =
    isProd && schedulerHealth.automationMode === 'manual';
  const schedulerDep: DependencyStatusReport = {
    status: schedulerFailed
      ? 'UNAVAILABLE'
      : productionManualAutomationDisabled
        ? 'DEGRADED'
        : schedulerHealth.running || (!isProd && schedulerHealth.automationMode === 'manual')
          ? 'READY'
          : 'DEGRADED',
    requiredForRuntime: true,
    requiredForProduction: true,
    details: schedulerFailed
      ? `Scheduler failed: ${schedulerHealth.error || 'unknown error'}`
      : productionManualAutomationDisabled
        ? 'Production started with AUTOMATION_MODE=manual: automatic source discovery and scheduled job processing are disabled'
        : `Scheduler ${schedulerHealth.status} (mode=${schedulerHealth.automationMode})`,
    metadata: {
      status: schedulerHealth.status,
      readiness: schedulerHealth.readiness,
      running: schedulerHealth.running,
      automationMode: schedulerHealth.automationMode,
      automaticProcessingDisabled: productionManualAutomationDisabled,
      productionAutomationBlocker: productionManualAutomationDisabled,
      seeder: schedulerHealth.seeder,
    },
  };
  if (schedulerFailed) {
    blockers.push(`Scheduler failed: ${schedulerHealth.error || 'unknown'}`);
  } else if (productionManualAutomationDisabled) {
    blockers.push(
      'Production started with AUTOMATION_MODE=manual: automatic source discovery and scheduled job processing are disabled'
    );
  }

  // 3. Source registry / DB bootstrap
  let totalSourcesInDb = 0;
  let activeSourcesInDb = 0;
  if (dbHealthy) {
    try {
      const repos = getRepositories();
      totalSourcesInDb = repos.sources.listAll().length;
      activeSourcesInDb = repos.sources.listActive().length;
    } catch {
      totalSourcesInDb = 0;
      activeSourcesInDb = 0;
    }
  }
  const sourceRegistryDep: DependencyStatusReport = {
    status: !dbHealthy
      ? 'UNAVAILABLE'
      : totalSourcesInDb >= OFFICIAL_BOOTSTRAP_SOURCES.length && activeSourcesInDb > 0
        ? 'READY'
        : totalSourcesInDb > 0
          ? 'DEGRADED'
          : 'NOT_READY',
    requiredForRuntime: true,
    requiredForProduction: true,
    details:
      totalSourcesInDb > 0
        ? `${totalSourcesInDb} sources registered (${activeSourcesInDb} active)`
        : 'No sources bootstrapped in database',
    metadata: {
      totalSources: totalSourcesInDb,
      activeSources: activeSourcesInDb,
      expectedOfficialSources: OFFICIAL_BOOTSTRAP_SOURCES.length,
    },
  };
  if (dbHealthy && totalSourcesInDb === 0) {
    blockers.push('Official sources table is empty (source bootstrap not executed)');
  }

  // 4. Source adapters
  const registeredAdapters = sourceRegistry.getAll();
  const sourceAdaptersDep: DependencyStatusReport = {
    status:
      registeredAdapters.length >= OFFICIAL_BOOTSTRAP_SOURCES.length
        ? 'READY'
        : registeredAdapters.length > 0
          ? 'DEGRADED'
          : 'NOT_READY',
    requiredForRuntime: true,
    requiredForProduction: true,
    details: `${registeredAdapters.length}/${OFFICIAL_BOOTSTRAP_SOURCES.length} official source adapters registered`,
    metadata: {
      registeredCount: registeredAdapters.length,
      sourceIds: registeredAdapters.map((a) => a.sourceId),
    },
  };

  // 5. Remote acquisition config / availability (Production runner guard)
  const runnerMode = resolveRunnerMode();
  const remoteRunner = new HttpRemoteAcquisitionRunner();
  const remoteConfig = remoteRunner.getSanitizedConfig();
  const remoteTimeoutMs = options.remoteTimeoutMs ?? 1500;
  const remoteHealth = remoteRunner.isConfigured()
    ? await cachedProbe(
        `remote|${remoteConfig.workerEndpoint}|${remoteConfig.authConfigured}|${remoteTimeoutMs}`,
        () => remoteRunner.checkHealth(remoteTimeoutMs)
      )
    : null;

  const productionLocalRunnerBlocker = isProd && runnerMode === 'LOCAL';
  const productionRemoteMissingToken =
    isProd && runnerMode === 'REMOTE' && !remoteConfig.authConfigured;
  const productionAutoMissingToken =
    isProd && runnerMode === 'AUTO' && remoteConfig.configured && !remoteConfig.authConfigured;
  const productionRemoteLoopback =
    isProd && remoteConfig.configured && remoteConfig.isLocalWorker;
  const productionRemoteNotHttps =
    isProd && remoteConfig.configured && !remoteConfig.isLocalWorker && !remoteConfig.isHttps;

  let remoteDepStatus: DependencyCheckState;
  let remoteDepDetails: string;
  if (productionLocalRunnerBlocker) {
    remoteDepStatus = 'NOT_READY';
    remoteDepDetails =
      'RUNNER_MODE=LOCAL is configured in production: external HTTPS remote acquisition worker is required for production official source acquisition';
  } else if (!remoteConfig.configured) {
    remoteDepStatus =
      runnerMode === 'REMOTE'
        ? 'NOT_READY'
        : runnerMode === 'AUTO' && isProd
          ? 'DEGRADED'
          : 'NOT_CONFIGURED';
    remoteDepDetails =
      runnerMode === 'REMOTE'
        ? 'RUNNER_MODE=REMOTE requires an external HTTPS OFFICIAL_ACQUISITION_WORKER_URL, which is not configured'
        : runnerMode === 'AUTO' && isProd
          ? 'Remote worker not configured (RUNNER_MODE=AUTO): LOCAL fallback may be used; REMOTE_NOT_PROVEN'
          : `Remote worker not configured (RUNNER_MODE=${runnerMode})`;
  } else if (productionRemoteLoopback) {
    remoteDepStatus = runnerMode === 'REMOTE' ? 'NOT_READY' : 'DEGRADED';
    remoteDepDetails =
      'OFFICIAL_ACQUISITION_WORKER_URL points to loopback (localhost/127.0.0.1), which cannot count as REAL_REMOTE_PRODUCTION';
  } else if (productionRemoteNotHttps) {
    remoteDepStatus = runnerMode === 'REMOTE' ? 'NOT_READY' : 'DEGRADED';
    remoteDepDetails =
      'OFFICIAL_ACQUISITION_WORKER_URL must use HTTPS in production';
  } else if (productionRemoteMissingToken) {
    remoteDepStatus = 'NOT_READY';
    remoteDepDetails =
      'RUNNER_MODE=REMOTE in production requires OFFICIAL_ACQUISITION_WORKER_TOKEN';
  } else if (productionAutoMissingToken) {
    remoteDepStatus = 'DEGRADED';
    remoteDepDetails =
      'RUNNER_MODE=AUTO in production lacks OFFICIAL_ACQUISITION_WORKER_TOKEN: LOCAL fallback may be used; REMOTE_NOT_PROVEN';
  } else if (remoteHealth?.healthy) {
    remoteDepStatus = remoteConfig.isLocalWorker
      ? 'DEGRADED'
      : isProd && !remoteConfig.authConfigured
        ? 'DEGRADED'
        : 'READY';
    remoteDepDetails = remoteConfig.isLocalWorker
      ? 'Remote acquisition worker reachable on loopback (local worker, not production remote)'
      : isProd && !remoteConfig.authConfigured
        ? 'Remote acquisition worker reachable, but OFFICIAL_ACQUISITION_WORKER_TOKEN is missing'
        : `Production remote acquisition worker healthy (${remoteHealth.executionEnvironment ?? 'REMOTE'})`;
  } else {
    remoteDepStatus = 'UNAVAILABLE';
    remoteDepDetails = remoteHealth?.details || 'Remote acquisition worker unreachable';
  }

  const productionRemoteBlocker =
    productionLocalRunnerBlocker ||
    (isProd && runnerMode === 'REMOTE' && remoteDepStatus !== 'READY') ||
    (isProd && (!remoteConfig.isValidProductionRemoteConfig || !remoteHealth?.healthy));
  const remoteNotProven =
    !options.remoteProductionProven ||
    !remoteConfig.isValidProductionRemoteConfig ||
    !remoteHealth?.healthy;

  const remoteAcquisitionDep: DependencyStatusReport = {
    status: remoteDepStatus,
    requiredForRuntime: runnerMode === 'REMOTE' || productionLocalRunnerBlocker,
    requiredForProduction: true,
    details: remoteDepDetails,
    metadata: {
      mode: runnerMode,
      classification: remoteNotProven ? 'REMOTE_NOT_PROVEN' : 'REMOTE_PROVEN',
      configured: remoteConfig.configured,
      endpointUrl: remoteConfig.workerEndpoint,
      authConfigured: remoteConfig.authConfigured,
      isLocalWorker: remoteConfig.isLocalWorker,
      isHttps: remoteConfig.isHttps,
      isValidProductionRemoteConfig: remoteConfig.isValidProductionRemoteConfig,
      productionRemoteBlocker,
      autoFallbackPossible: runnerMode === 'AUTO' && (!remoteConfig.isValidProductionRemoteConfig || !remoteHealth?.healthy),
      reachable: remoteHealth?.reachable ?? false,
      healthy: remoteHealth?.healthy ?? false,
      remoteStatus: remoteHealth?.remoteStatus ?? 'REMOTE_NOT_CONFIGURED',
      executionEnvironment: remoteHealth?.executionEnvironment ?? null,
    },
  };
  if (productionLocalRunnerBlocker) {
    blockers.push(
      'Production runner blocker: RUNNER_MODE=LOCAL is configured in production (external HTTPS remote acquisition worker required)'
    );
  } else if (runnerMode === 'REMOTE' && remoteDepStatus !== 'READY') {
    blockers.push(`Remote acquisition worker blocked for RUNNER_MODE=REMOTE: ${remoteDepDetails}`);
  } else if (!remoteConfig.configured) {
    blockers.push(
      runnerMode === 'AUTO' && isProd
        ? 'Remote production acquisition worker is not configured (RUNNER_MODE=AUTO fallback to LOCAL is not production remote proof)'
        : 'Remote production acquisition worker (OFFICIAL_ACQUISITION_WORKER_URL) is not configured'
    );
  } else if (remoteConfig.isLocalWorker) {
    blockers.push('Remote acquisition worker points to loopback (cannot count as REAL_REMOTE_PRODUCTION)');
  } else if (isProd && !remoteConfig.isHttps) {
    blockers.push('Remote acquisition worker URL must use HTTPS in production');
  } else if (isProd && !remoteConfig.authConfigured) {
    blockers.push('Remote acquisition worker token (OFFICIAL_ACQUISITION_WORKER_TOKEN) is missing in production');
  } else if (!remoteHealth?.healthy) {
    blockers.push(`Remote acquisition worker unhealthy: ${remoteDepDetails}`);
  }

  // 6. Durable document storage (Production durable storage guard)
  const storageHealth = getDocumentStorageService().getHealth();
  const storageDepStatus: DependencyCheckState =
    storageHealth.status === 'DURABLE_READY'
      ? 'READY'
      : storageHealth.status === 'DEV_TEMP_FALLBACK'
        ? 'DEGRADED'
        : storageHealth.status === 'NOT_CONFIGURED'
          ? isProd
            ? 'NOT_READY'
            : 'NOT_CONFIGURED'
          : storageHealth.status === 'NOT_DURABLE' || storageHealth.status === 'NOT_WRITABLE'
            ? 'NOT_READY'
            : 'UNAVAILABLE';
  const storageDep: DependencyStatusReport = {
    status: storageDepStatus,
    requiredForRuntime: isProd,
    requiredForProduction: true,
    details: storageHealth.reason,
    metadata: {
      storageStatus: storageHealth.status,
      storageDir: storageHealth.storageDir,
      configured: storageHealth.configured,
      durable: storageHealth.durable,
      usingTempFallback: storageHealth.usingTempFallback,
      writable: storageHealth.writable,
    },
  };
  if (storageHealth.status !== 'DURABLE_READY') {
    blockers.push(`Durable document storage ${storageHealth.status}: ${storageHealth.reason}`);
  }

  // 7. OCR provider/model readiness (BUG 9 — never report READY from API key presence alone)
  const ocrReadiness: OcrReadinessReport =
    options.ocrReadinessOverride ??
    (await checkOcrReadiness({
      apiKey: config.GEMINI_API_KEY,
      provider: config.OCR_PROVIDER,
      model: config.OCR_MODEL,
      liveVerify: options.ocrLiveVerify ?? false,
      forceRefresh: options.ocrForceRefresh ?? false,
    }));

  const ocrConfigured = ocrReadiness.OCR_CONFIGURED;
  const ocrDepStatus: DependencyCheckState =
    ocrReadiness.OCR_PRODUCTION_READY
      ? 'READY'
      : ocrReadiness.status === 'NOT_CONFIGURED'
        ? 'NOT_CONFIGURED'
        : ocrReadiness.status === 'INVALID_CONFIG'
          ? 'NOT_READY'
          : ocrReadiness.status === 'UNAVAILABLE'
            ? 'UNAVAILABLE'
            : 'DEGRADED';

  const ocrDep: DependencyStatusReport = {
    status: ocrDepStatus,
    requiredForRuntime: false,
    requiredForProduction: true,
    details: ocrReadiness.message,
    metadata: {
      provider: ocrReadiness.provider,
      model: ocrReadiness.model,
      configured: ocrReadiness.OCR_CONFIGURED,
      OCR_CONFIGURED: ocrReadiness.OCR_CONFIGURED,
      OCR_PROVIDER_REACHABLE: ocrReadiness.OCR_PROVIDER_REACHABLE,
      OCR_MODEL_VALID: ocrReadiness.OCR_MODEL_VALID,
      OCR_PRODUCTION_READY: ocrReadiness.OCR_PRODUCTION_READY,
      classification: ocrReadiness.classification,
      modelSyntaxValid: ocrReadiness.modelSyntaxValid,
      liveVerified: ocrReadiness.liveVerified,
      cached: ocrReadiness.cached,
      checkedAt: ocrReadiness.checkedAt,
      errorCode: ocrReadiness.errorCode,
    },
  };
  if (!ocrReadiness.OCR_PRODUCTION_READY) {
    blockers.push(`OCR not production-verified (${ocrReadiness.classification}): ${ocrReadiness.message}`);
  }

  // 8. Extraction & pipeline stages
  const engine = getPipelineEngine();
  const registeredStages = engine.getPipelineDefinition();
  const missingStages = ORDERED_PIPELINE_STAGES.filter(
    (s) => !registeredStages.some((def) => def.stage === s && def.hasHandler)
  );
  const extractionPipelineDep: DependencyStatusReport = {
    status: missingStages.length === 0 ? 'READY' : 'DEGRADED',
    requiredForRuntime: true,
    requiredForProduction: true,
    details:
      missingStages.length === 0
        ? `All ${ORDERED_PIPELINE_STAGES.length} pipeline stages registered`
        : `Missing pipeline stages: ${missingStages.join(', ')}`,
    metadata: {
      registeredStagesCount: registeredStages.length,
      requiredStagesCount: ORDERED_PIPELINE_STAGES.length,
      missingStages,
    },
  };
  if (missingStages.length > 0) {
    blockers.push(`Pipeline stages not registered: ${missingStages.join(', ')}`);
  }

  // 9. WordPress configuration / authentication
  const wpClient = createWordPressClient();
  const wpReadiness = await cachedProbe(
    `wp|${config.OMNIHUB_WP_URL ?? ''}|${config.OMNIHUB_WP_USERNAME ?? ''}|${config.OMNIHUB_WP_APP_PASSWORD ? 'pw' : 'nopw'}`,
    () => wpClient.checkReadiness()
  );
  const wpDep: DependencyStatusReport = {
    status:
      wpReadiness.status === 'READY'
        ? 'READY'
        : wpReadiness.status === 'NOT_CONFIGURED'
          ? 'NOT_CONFIGURED'
          : 'UNAVAILABLE',
    requiredForRuntime: false,
    requiredForProduction: true,
    details:
      wpReadiness.status === 'READY'
        ? `WordPress authenticated (${wpReadiness.verificationTier})`
        : wpReadiness.errorMessage || `WordPress ${wpReadiness.status}`,
    metadata: {
      status: wpReadiness.status,
      verificationTier: wpReadiness.verificationTier,
      configured: wpReadiness.configured,
      endpointUrl: wpReadiness.endpointUrl,
      httpsEnforced: wpReadiness.httpsEnforced,
      reachable: wpReadiness.reachable,
      authenticated: wpReadiness.authenticated,
      latencyMs: wpReadiness.latencyMs,
      errorCode: wpReadiness.errorCode ?? null,
    },
  };
  if (wpReadiness.status !== 'READY') {
    blockers.push(`WordPress publishing ${wpReadiness.status}: ${wpReadiness.errorMessage || wpReadiness.errorCode}`);
  } else if (wpReadiness.verificationTier !== 'REAL_WORDPRESS_PRODUCTION_VERIFIED') {
    blockers.push('WordPress endpoint is loopback/non-production (not REAL_WORDPRESS_PRODUCTION_VERIFIED)');
  }

  // 10. Docker / worker packaging config (BUG 11 — validate worker/Dockerfile.production, NOT root Dockerfile)
  const workerPkg = verifyWorkerPackageFiles();
  const dockerCliAvailable =
    options.dockerAvailableOverride !== undefined
      ? options.dockerAvailableOverride
      : options.skipDockerCliCheck
        ? false
        : detectDockerCliAvailable();
  const dockerFilesValid =
    workerPkg.valid &&
    workerPkg.dockerfileStructure.exists &&
    workerPkg.dockerfileStructure.valid &&
    workerPkg.dockerfileStructure.packageManagerConsistent;
  const dockerBuildProven = Boolean(options.dockerBuildProven && dockerCliAvailable && dockerFilesValid);
  const dockerWorkerDep: DependencyStatusReport = {
    status: dockerFilesValid ? (dockerCliAvailable ? 'READY' : 'DEGRADED') : 'NOT_READY',
    requiredForRuntime: false,
    requiredForProduction: false,
    details: !dockerFilesValid
      ? workerPkg.details
      : dockerCliAvailable
        ? dockerBuildProven
          ? 'worker/Dockerfile.production valid and Docker image build proven'
          : 'worker/Dockerfile.production valid and Docker CLI available (DOCKER_BUILD_NOT_RUN)'
        : 'worker/Dockerfile.production valid, but Docker CLI/runtime is DOCKER_RUNTIME_NOT_AVAILABLE (DOCKER_BUILD_NOT_RUN)',
    metadata: {
      dockerfilePath: 'worker/Dockerfile.production',
      workerDockerfileExists: workerPkg.dockerfileStructure.exists,
      workerDockerfileValid: workerPkg.dockerfileStructure.valid,
      multiStageBuild: workerPkg.dockerfileStructure.multiStageBuild,
      runsWorkerBuild: workerPkg.dockerfileStructure.runsWorkerBuild,
      hasHealthcheck: workerPkg.dockerfileStructure.hasHealthcheck,
      packageManagerConsistent: workerPkg.dockerfileStructure.packageManagerConsistent,
      dockerRuntime: dockerCliAvailable ? 'AVAILABLE' : 'DOCKER_RUNTIME_NOT_AVAILABLE',
      dockerBuild: dockerBuildProven ? 'PASS' : 'DOCKER_BUILD_NOT_RUN',
    },
  };
  if (!dockerFilesValid) {
    blockers.push(`Worker container configuration invalid: ${workerPkg.details}`);
  } else if (!dockerCliAvailable) {
    blockers.push('Docker CLI/runtime is DOCKER_RUNTIME_NOT_AVAILABLE in this environment (DOCKER_BUILD_NOT_RUN)');
  } else if (!dockerBuildProven) {
    blockers.push('Docker image build has not been proven in this runtime (DOCKER_BUILD_NOT_RUN)');
  }

  // Compute strictly separated 7-flag production proof model (BUG 13)
  const CODE_IMPLEMENTED =
    sourceAdaptersDep.status === 'READY' &&
    dockerFilesValid &&
    missingStages.length === 0;

  const remoteRuntimeReady =
    runnerMode === 'REMOTE'
      ? Boolean(
          remoteConfig.configured &&
            remoteHealth?.healthy &&
            (!isProd || remoteConfig.isValidProductionRemoteConfig)
        )
      : !productionLocalRunnerBlocker;

  const RUNTIME_VERIFIED =
    dbHealthy &&
    !schedulerFailed &&
    (!isProd || storageHealth.status === 'DURABLE_READY') &&
    remoteRuntimeReady;

  const EXTERNAL_SERVICES_CONFIGURED =
    Boolean(wpReadiness.configured) &&
    Boolean(ocrReadiness.OCR_CONFIGURED) &&
    Boolean(remoteConfig.configured);

  const REAL_REMOTE_PRODUCTION_PROVEN = Boolean(
    options.remoteProductionProven &&
      remoteConfig.configured &&
      remoteConfig.isValidProductionRemoteConfig &&
      !remoteConfig.isLocalWorker &&
      remoteHealth?.healthy &&
      remoteHealth.executionEnvironment === 'PRODUCTION_REMOTE'
  );

  const REAL_WORDPRESS_PROVEN = Boolean(
    wpReadiness.status === 'READY' &&
      wpReadiness.authenticated &&
      wpReadiness.httpsEnforced &&
      wpReadiness.verificationTier === 'REAL_WORDPRESS_PRODUCTION_VERIFIED'
  );

  const DOCKER_BUILD_PROVEN = dockerBuildProven;

  const END_TO_END_PROVEN = Boolean(
    CODE_IMPLEMENTED &&
      RUNTIME_VERIFIED &&
      !productionManualAutomationDisabled &&
      EXTERNAL_SERVICES_CONFIGURED &&
      ocrReadiness.OCR_PRODUCTION_READY &&
      storageHealth.status === 'DURABLE_READY' &&
      storageHealth.durable &&
      !storageHealth.usingTempFallback &&
      REAL_REMOTE_PRODUCTION_PROVEN &&
      REAL_WORDPRESS_PROVEN &&
      DOCKER_BUILD_PROVEN
  );

  const productionProof: ProductionProofFlags = {
    CODE_IMPLEMENTED,
    RUNTIME_VERIFIED,
    EXTERNAL_SERVICES_CONFIGURED,
    REAL_REMOTE_PRODUCTION_PROVEN,
    REAL_WORDPRESS_PROVEN,
    DOCKER_BUILD_PROVEN,
    END_TO_END_PROVEN,
  };

  // Backwards-compatible summary flags
  const CODE_READY = CODE_IMPLEMENTED;
  const RUNTIME_READY = RUNTIME_VERIFIED;
  const EXTERNAL_SERVICES_READY =
    wpReadiness.status === 'READY' &&
    ocrReadiness.OCR_PRODUCTION_READY &&
    Boolean(
      remoteConfig.configured &&
        remoteHealth?.healthy &&
        (!isProd || remoteConfig.isValidProductionRemoteConfig)
    );
  const PRODUCTION_PROVEN = END_TO_END_PROVEN;

  const overallReadiness: OverallReadinessState = !RUNTIME_READY
    ? 'NOT_READY'
    : EXTERNAL_SERVICES_READY &&
        storageHealth.status === 'DURABLE_READY' &&
        schedulerDep.status === 'READY' &&
        remoteAcquisitionDep.status === 'READY' &&
        sourceRegistryDep.status === 'READY' &&
        extractionPipelineDep.status === 'READY'
      ? 'READY'
      : 'DEGRADED';

  return {
    timestamp,
    environment: config.NODE_ENV,
    overallReadiness,
    CODE_READY,
    RUNTIME_READY,
    EXTERNAL_SERVICES_READY,
    PRODUCTION_PROVEN,
    productionProof,
    productionGuards,
    blockers,
    dependencies: {
      database: databaseDep,
      scheduler: schedulerDep,
      sourceRegistry: sourceRegistryDep,
      sourceAdapters: sourceAdaptersDep,
      remoteAcquisition: remoteAcquisitionDep,
      durableDocumentStorage: storageDep,
      ocr: ocrDep,
      extractionPipeline: extractionPipelineDep,
      wordpress: wpDep,
      dockerWorker: dockerWorkerDep,
    },
    raw: {
      dbHealthy,
      dbLatencyMs,
      schedulerHealth,
      wpReadiness,
      storageHealth,
      runnerMode,
      remoteConfig,
      remoteHealth,
      ocrConfigured,
      ocrReadiness,
    },
  };
}
