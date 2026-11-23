/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, getConfig } from '../../src/backend/config/index.ts';
import {
  DEFAULT_OCR_MODEL,
  evaluateProductionConfigGuards,
  isEphemeralTempPath,
  isLoopbackHostname,
} from '../../src/backend/config/schema.ts';
import {
  checkOcrReadiness,
  GeminiOCRProvider,
} from '../../src/backend/ingestion/ocr/index.ts';
import {
  initDatabase,
  closeDatabase,
  getRepositories,
  bootstrapOfficialSources,
} from '../../src/backend/database/index.ts';
import {
  getDocumentStorageService,
  resetDocumentStorageService,
} from '../../src/backend/storage/index.ts';
import { evaluateSystemReadiness } from '../../src/backend/runtime/readiness-service.ts';
import { startServerRuntime } from '../../src/backend/runtime/server-runtime.ts';
import {
  resetSchedulerRuntimeState,
  SourceDiscoverySeeder,
} from '../../src/backend/scheduler/index.ts';
import { JobService } from '../../src/backend/jobs/index.ts';
import { AuditService } from '../../src/backend/audit/index.ts';
import {
  getPipelineEngine,
  SourceDiscoveryStageHandler,
} from '../../src/backend/pipeline/index.ts';
import { sourceRegistry } from '../../src/backend/ingestion/adapters/registry.ts';
import type { ISourceAdapter } from '../../src/backend/ingestion/adapters/source-adapter.interface.ts';
import type { DiscoveredNotice } from '../../src/backend/ingestion/types.ts';
import { logger } from '../../src/backend/config/logger.ts';
import {
  buildTruthfulVerificationReport,
  evaluateCurrentProductionProof,
  isHistoricalArchiveReport,
  normalizeTruthfulStatus,
  type TruthfulVerificationEntry,
} from '../../src/backend/ingestion/discovery/verification-model.ts';
import { buildMachineReadableLiveReport } from '../../src/backend/ingestion/discovery/live-check.ts';
import { runRemoteProductionVerification } from '../../src/backend/ingestion/discovery/verify-remote-production.ts';
import type { RealLiveVerificationSummary } from '../../src/backend/ingestion/discovery/discovery-service.ts';

const SAVED_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'DATABASE_PATH',
  'DOCUMENT_STORAGE_DIR',
  'AUTOMATION_MODE',
  'RUNNER_MODE',
  'OFFICIAL_ACQUISITION_WORKER_URL',
  'OFFICIAL_ACQUISITION_WORKER_TOKEN',
  'OMNIHUB_REMOTE_WORKER_URL',
  'OMNIHUB_REMOTE_WORKER_TOKEN',
  'OMNIHUB_WP_URL',
  'OMNIHUB_WP_USERNAME',
  'OMNIHUB_WP_APP_PASSWORD',
  'GEMINI_API_KEY',
  'OCR_MODEL',
  'CONTROL_APP_AUTH_TOKEN',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of SAVED_ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of SAVED_ENV_KEYS) {
    if (snap[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snap[key];
    }
  }
}

function clearExternalEnv(): void {
  delete process.env.DOCUMENT_STORAGE_DIR;
  delete process.env.OFFICIAL_ACQUISITION_WORKER_URL;
  delete process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
  delete process.env.OMNIHUB_REMOTE_WORKER_URL;
  delete process.env.OMNIHUB_REMOTE_WORKER_TOKEN;
  delete process.env.OMNIHUB_WP_URL;
  delete process.env.OMNIHUB_WP_USERNAME;
  delete process.env.OMNIHUB_WP_APP_PASSWORD;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OCR_MODEL;
  delete process.env.CONTROL_APP_AUTH_TOKEN;
}

describe('Production Integration Guards, Metadata, Verification Truthfulness & Health Consistency', () => {
  let envSnap: Record<string, string | undefined>;
  let durableDir: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearExternalEnv();
    process.env.DATABASE_PATH = ':memory:';
    loadConfig();
    resetDocumentStorageService();
    resetSchedulerRuntimeState();
    closeDatabase();

    // Durable non-temp directory inside workspace for tests needing valid storage in production
    durableDir = fs.mkdtempSync(path.resolve(process.cwd(), 'data', 'test-durable-storage-'));
  });

  afterEach(() => {
    closeDatabase();
    resetSchedulerRuntimeState();
    resetDocumentStorageService();
    restoreEnv(envSnap);
    loadConfig();
    if (durableDir && fs.existsSync(durableDir)) {
      fs.rmSync(durableDir, { recursive: true, force: true });
    }
  });

  it('1. production + manual automation mode reports degradation/blocker without mutating config', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTOMATION_MODE = 'manual';
    process.env.RUNNER_MODE = 'REMOTE';
    process.env.OFFICIAL_ACQUISITION_WORKER_URL = 'https://worker.example.govjobs.invalid';
    process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN = 'prod-token-123';
    process.env.DOCUMENT_STORAGE_DIR = durableDir;
    loadConfig();

    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    getPipelineEngine();

    const config = getConfig();
    assert.equal(config.AUTOMATION_MODE, 'manual', 'AUTOMATION_MODE must not be silently mutated');

    const guards = evaluateProductionConfigGuards(config);
    const manualFinding = guards.find((f) => f.code === 'PRODUCTION_AUTOMATION_MANUAL');
    assert.ok(manualFinding, 'Expected PRODUCTION_AUTOMATION_MANUAL guard finding');
    assert.equal(manualFinding.status, 'DEGRADED');

    const report = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(report.dependencies.scheduler.status, 'DEGRADED');
    assert.equal(report.dependencies.scheduler.metadata?.automaticProcessingDisabled, true);
    assert.equal(report.dependencies.scheduler.metadata?.automationMode, 'manual');
    assert.ok(
      report.blockers.some((b) => b.includes('AUTOMATION_MODE=manual')),
      'Expected blocker explaining automatic processing is disabled in production'
    );
    assert.notEqual(report.overallReadiness, 'READY');

    // Manual mode remains valid (READY for scheduler dependency) in development/test
    process.env.NODE_ENV = 'test';
    process.env.AUTOMATION_MODE = 'manual';
    loadConfig();
    assert.equal(evaluateProductionConfigGuards(getConfig()).length, 0);
    const devReport = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(devReport.dependencies.scheduler.status, 'READY');
    assert.equal(devReport.dependencies.scheduler.metadata?.automaticProcessingDisabled, false);
  });

  it('2. production + LOCAL runner reports production remote blocker; enforces HTTPS/token/non-loopback for REMOTE and exposes AUTO fallback', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTOMATION_MODE = 'scheduled';
    process.env.RUNNER_MODE = 'LOCAL';
    process.env.DOCUMENT_STORAGE_DIR = durableDir;
    loadConfig();

    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    getPipelineEngine();

    const localGuards = evaluateProductionConfigGuards(getConfig());
    assert.ok(localGuards.some((f) => f.code === 'PRODUCTION_RUNNER_LOCAL'));

    const localReport = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(localReport.dependencies.remoteAcquisition.status, 'NOT_READY');
    assert.equal(localReport.dependencies.remoteAcquisition.metadata?.productionRemoteBlocker, true);
    assert.equal(localReport.overallReadiness, 'NOT_READY');
    assert.ok(localReport.blockers.some((b) => b.includes('RUNNER_MODE=LOCAL')));

    // REMOTE with loopback URL must be rejected and never count as REAL_REMOTE_PRODUCTION
    process.env.RUNNER_MODE = 'REMOTE';
    process.env.OFFICIAL_ACQUISITION_WORKER_URL = 'http://127.0.0.1:8080';
    process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN = 'test-token';
    loadConfig();
    assert.equal(isLoopbackHostname('127.0.0.1'), true);
    assert.equal(isLoopbackHostname('localhost'), true);
    const loopbackGuards = evaluateProductionConfigGuards(getConfig());
    assert.ok(loopbackGuards.some((f) => f.code === 'PRODUCTION_REMOTE_LOOPBACK_FORBIDDEN'));
    const loopbackReport = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(loopbackReport.dependencies.remoteAcquisition.status, 'NOT_READY');
    assert.equal(loopbackReport.productionProof.REAL_REMOTE_PRODUCTION_PROVEN, false);

    // REMOTE with external HTTP (non-HTTPS) and missing token
    process.env.OFFICIAL_ACQUISITION_WORKER_URL = 'http://worker.example.com';
    delete process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
    loadConfig();
    const httpGuards = evaluateProductionConfigGuards(getConfig());
    assert.ok(httpGuards.some((f) => f.code === 'PRODUCTION_REMOTE_HTTPS_REQUIRED'));
    assert.ok(httpGuards.some((f) => f.code === 'PRODUCTION_REMOTE_TOKEN_MISSING'));

    // AUTO without valid external HTTPS worker URL/token -> DEGRADED / REMOTE_NOT_PROVEN
    process.env.RUNNER_MODE = 'AUTO';
    delete process.env.OFFICIAL_ACQUISITION_WORKER_URL;
    delete process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
    loadConfig();
    const autoGuards = evaluateProductionConfigGuards(getConfig());
    assert.ok(
      autoGuards.some(
        (f) => f.code === 'PRODUCTION_AUTO_FALLBACK_UNPROVEN' && f.status === 'DEGRADED'
      )
    );
    const autoReport = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(autoReport.dependencies.remoteAcquisition.status, 'DEGRADED');
    assert.equal(
      autoReport.dependencies.remoteAcquisition.metadata?.classification,
      'REMOTE_NOT_PROVEN'
    );
    assert.equal(autoReport.dependencies.remoteAcquisition.metadata?.autoFallbackPossible, true);
    assert.equal(autoReport.productionProof.REAL_REMOTE_PRODUCTION_PROVEN, false);
    assert.notEqual(autoReport.overallReadiness, 'READY');

    // AUTO with external HTTPS URL but missing token -> DEGRADED / REMOTE_NOT_PROVEN
    process.env.OFFICIAL_ACQUISITION_WORKER_URL = 'https://worker.example.govjobs.invalid';
    delete process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN;
    loadConfig();
    const autoMissingTokenGuards = evaluateProductionConfigGuards(getConfig());
    assert.ok(
      autoMissingTokenGuards.some(
        (f) => f.code === 'PRODUCTION_AUTO_FALLBACK_UNPROVEN' && f.status === 'DEGRADED'
      )
    );
    const autoMissingTokenReport = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(autoMissingTokenReport.dependencies.remoteAcquisition.status, 'DEGRADED');
    assert.equal(
      autoMissingTokenReport.dependencies.remoteAcquisition.metadata?.classification,
      'REMOTE_NOT_PROVEN'
    );
    assert.equal(autoMissingTokenReport.productionProof.REAL_REMOTE_PRODUCTION_PROVEN, false);
  });

  it('3. production + missing DOCUMENT_STORAGE_DIR reports NOT_READY and refuses temp fallback', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTOMATION_MODE = 'scheduled';
    process.env.RUNNER_MODE = 'AUTO';
    delete process.env.DOCUMENT_STORAGE_DIR;
    loadConfig();
    resetDocumentStorageService();

    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    getPipelineEngine();

    const guards = evaluateProductionConfigGuards(getConfig());
    assert.ok(guards.some((f) => f.code === 'PRODUCTION_STORAGE_NOT_CONFIGURED'));

    const storageHealth = getDocumentStorageService().getHealth();
    assert.equal(storageHealth.status, 'NOT_CONFIGURED');
    assert.equal(storageHealth.usingTempFallback, false);
    assert.equal(storageHealth.durable, false);

    const report = await evaluateSystemReadiness({
      remoteTimeoutMs: 50,
      skipDockerCliCheck: true,
    });
    assert.equal(report.dependencies.durableDocumentStorage.status, 'NOT_READY');
    assert.equal(
      report.dependencies.durableDocumentStorage.metadata?.storageStatus,
      'NOT_CONFIGURED'
    );
    assert.equal(report.overallReadiness, 'NOT_READY');
    assert.ok(
      report.blockers.some((b) => b.includes('NOT_CONFIGURED')),
      'Expected exact NOT_CONFIGURED blocker reason'
    );
  });

  it('4. production + temp DOCUMENT_STORAGE_DIR (/tmp, /var/tmp) reports NOT_DURABLE and NOT_READY', async () => {
    for (const tempDir of [path.join('/tmp', 'omnihub-test-ephemeral'), '/var/tmp/omnihub-test', path.join(os.tmpdir(), 'omnihub-tmp')]) {
      assert.equal(isEphemeralTempPath(tempDir), true, `Expected ephemeral detection for ${tempDir}`);

      process.env.NODE_ENV = 'production';
      process.env.AUTOMATION_MODE = 'scheduled';
      process.env.RUNNER_MODE = 'AUTO';
      process.env.DOCUMENT_STORAGE_DIR = tempDir;
      loadConfig();
      resetDocumentStorageService();

      initDatabase({ path: ':memory:', forceNew: true });
      bootstrapOfficialSources();
      getPipelineEngine();

      const guards = evaluateProductionConfigGuards(getConfig());
      assert.ok(
        guards.some((f) => f.code === 'PRODUCTION_STORAGE_NOT_DURABLE' && f.status === 'NOT_DURABLE'),
        `Expected PRODUCTION_STORAGE_NOT_DURABLE guard for ${tempDir}`
      );

      const storageHealth = getDocumentStorageService().getHealth();
      assert.equal(storageHealth.status, 'NOT_DURABLE');
      assert.equal(storageHealth.durable, false);

      const report = await evaluateSystemReadiness({
        remoteTimeoutMs: 50,
        skipDockerCliCheck: true,
      });
      assert.equal(report.dependencies.durableDocumentStorage.status, 'NOT_READY');
      assert.equal(
        report.dependencies.durableDocumentStorage.metadata?.storageStatus,
        'NOT_DURABLE'
      );
      assert.equal(report.overallReadiness, 'NOT_READY');
      assert.ok(report.blockers.some((b) => b.includes('NOT_DURABLE')));
    }
  });

  it('5. SOURCE_DISCOVERY seeded job contains deterministic runner metadata and execution audit answers all 5 questions', async () => {
    process.env.NODE_ENV = 'test';
    process.env.RUNNER_MODE = 'AUTO';
    delete process.env.OFFICIAL_ACQUISITION_WORKER_URL;
    loadConfig();

    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();
    const sourceId = 'IN-TEST-META-SRC';
    repos.sources.create({
      id: sourceId,
      name: 'Test Metadata Commission',
      type: 'PORTAL',
      base_url: 'https://test.gov.in',
      is_active: 1,
      check_interval_minutes: 30,
      config_json: '{}',
    });

    const auditService = new AuditService(repos.auditLogs);
    const jobService = new JobService(repos.processingJobs, auditService);
    const fixedNow = Date.parse('2026-11-22T12:00:00.000Z');
    const seeder = new SourceDiscoverySeeder({
      jobService,
      sourceRepo: repos.sources,
      discoveryRunRepo: repos.sourceDiscoveryRuns,
      auditService,
      nowFn: () => fixedNow,
    });

    const passResult = await seeder.seedDueSources(fixedNow);
    assert.equal(passResult.queuedCount, 1);
    const decision = passResult.decisions[0];
    assert.equal(decision.outcome, 'QUEUED');
    assert.ok(decision.jobId);

    const seededJob = repos.processingJobs.findById(decision.jobId!);
    assert.ok(seededJob);
    const meta = JSON.parse(seededJob.metadata_json || '{}');
    assert.equal(meta.sourceId, sourceId);
    assert.equal(meta.scheduledBy, 'SOURCE_DISCOVERY_SEEDER');
    assert.equal(meta.scheduledAutomatically, true);
    assert.equal(meta.scheduledWindowKey, decision.dedupeKey);
    assert.equal(meta.seededAt, new Date(fixedNow).toISOString());
    assert.equal(meta.runnerMode, 'AUTO', 'Runner mode must come from runtime resolver, never hardcoded REMOTE');
    assert.equal(meta.runnerIntent, 'AUTO');
    assert.equal(meta.remoteRunnerConfigured, false);

    // Execute SourceDiscoveryStageHandler against a local mock adapter and verify persisted audit & discovery run records
    const fakeNotice: DiscoveredNotice = {
      id: 'notice-test-2026',
      sourceId,
      title: 'Combined Examination Notification 2026',
      noticeUrl: 'https://test.gov.in/notice-2026',
      publishedAt: new Date(fixedNow).toISOString(),
    };
    const fakeAdapter = {
      sourceId,
      name: 'Test Metadata Commission',
      baseUrl: 'https://test.gov.in',
      allowedDomains: ['test.gov.in'],
      healthCheck: async () => ({
        healthy: true,
        verifiedLive: true,
        httpStatus: 200,
        finalUrl: 'https://test.gov.in',
        runnerUsed: 'LOCAL' as const,
        message: 'Local mock health OK',
      }),
      discoverNotices: async () => [fakeNotice],
    } as unknown as ISourceAdapter;
    sourceRegistry.register(fakeAdapter);

    try {
      const handler = new SourceDiscoveryStageHandler();
      const result = await handler.execute(
        { sourceId },
        {
          jobId: seededJob.job_id,
          correlationId: 'corr-meta-test',
          targetEntityType: 'SOURCE',
          targetEntityId: sourceId,
          metadata: meta,
          logger,
          auditService,
        }
      );

      assert.equal(result.success, true);
      const auditDetails = result.auditDetails ?? {};
      // 1. Was this job scheduled automatically?
      assert.equal(auditDetails.scheduledAutomatically, true);
      assert.equal(auditDetails.scheduledBy, 'SOURCE_DISCOVERY_SEEDER');
      // 2. Which source was targeted?
      assert.equal(auditDetails.sourceId, sourceId);
      // 3. Which runner mode was requested?
      assert.equal(auditDetails.requestedRunnerMode, 'AUTO');
      // 4. Which runner actually executed?
      assert.equal(auditDetails.actualRunner, 'LOCAL');
      // 5. Was remote execution configured or not?
      assert.equal(auditDetails.remoteConfigured, false);

      const latestRun = repos.sourceDiscoveryRuns.findLatestBySource(sourceId);
      assert.ok(latestRun);
      const runMetrics = JSON.parse(latestRun.metrics_json || '{}');
      assert.equal(runMetrics.scheduledAutomatically, true);
      assert.equal(runMetrics.requestedRunnerMode, 'AUTO');
      assert.equal(runMetrics.actualRunner, 'LOCAL');
      assert.equal(runMetrics.remoteConfigured, false);
    } finally {
      // Remove temporary test adapter from global registry
      (sourceRegistry as unknown as { adapters?: Map<string, ISourceAdapter> }).adapters?.delete(
        sourceId
      );
    }
  });

  it('6. historical verification artifact cannot become current production proof', () => {
    const liveArtifactPath = path.resolve(
      process.cwd(),
      'artifacts',
      'live-verification-report.json'
    );
    const remoteArtifactPath = path.resolve(
      process.cwd(),
      'artifacts',
      'remote-production-verification-report.json'
    );

    const liveRaw = JSON.parse(fs.readFileSync(liveArtifactPath, 'utf8'));
    const remoteRaw = JSON.parse(fs.readFileSync(remoteArtifactPath, 'utf8'));

    assert.equal(liveRaw.artifactType, 'HISTORICAL_ARCHIVE');
    assert.equal(liveRaw.isCurrentRun, false);
    assert.equal(isHistoricalArchiveReport(liveRaw), true);

    assert.equal(remoteRaw.artifactType, 'HISTORICAL_ARCHIVE');
    assert.equal(remoteRaw.isCurrentRun, false);
    assert.equal(isHistoricalArchiveReport(remoteRaw), true);

    const liveEval = evaluateCurrentProductionProof(liveRaw);
    assert.equal(liveEval.isCurrentRun, false);
    assert.equal(liveEval.usableAsCurrentProof, false);
    assert.equal(liveEval.realRemoteProductionProven, false);

    const remoteEval = evaluateCurrentProductionProof(remoteRaw);
    assert.equal(remoteEval.isCurrentRun, false);
    assert.equal(remoteEval.usableAsCurrentProof, false);
    assert.equal(remoteEval.realRemoteProductionProven, false);

    // Even a tampered historical artifact claiming PROVEN is strictly rejected
    const tamperedHistorical = {
      ...remoteRaw,
      REAL_REMOTE_PRODUCTION: 'PROVEN',
      truthfulVerification: {
        REAL_REMOTE_PRODUCTION: 'PROVEN',
        entries: [
          {
            source: 'SSC',
            sourceId: 'IN-CENTRAL-SSC',
            adapter: 'IN-CENTRAL-SSC',
            runner: 'REMOTE',
            actualRunner: 'REMOTE',
            executionOrigin: 'REAL_REMOTE_PRODUCTION',
            executionEnvironment: 'PRODUCTION_REMOTE',
            status: 'PASS',
          },
        ],
      },
    };
    const tamperedEval = evaluateCurrentProductionProof(tamperedHistorical);
    assert.equal(tamperedEval.usableAsCurrentProof, false);
    assert.equal(tamperedEval.realRemoteProductionProven, false);
    assert.equal(tamperedEval.reason, 'HISTORICAL_ARCHIVE_CANNOT_BE_USED_AS_CURRENT_PROOF');
  });

  it('7. LOCAL PASS cannot become REAL_REMOTE_PRODUCTION', () => {
    const now = new Date().toISOString();
    const localPassEntry: TruthfulVerificationEntry = {
      source: 'SSC',
      sourceId: 'IN-CENTRAL-SSC',
      adapter: 'IN-CENTRAL-SSC',
      runner: 'LOCAL',
      runnerMode: 'LOCAL',
      actualRunner: 'LOCAL',
      executionOrigin: 'REAL_LIVE_LOCAL',
      executionEnvironment: 'LOCAL',
      remoteStatus: 'REMOTE_NOT_CONFIGURED',
      workerIdentity: {
        workerId: null,
        workerVersion: null,
        executionEnvironment: 'LOCAL',
      },
      checkType: 'LIVE_DISCOVERY',
      startedAt: now,
      completedAt: now,
      executionId: 'live-test-local',
      status: 'PASS',
      errorCategory: null,
      httpStatus: 200,
      finalUrl: 'https://ssc.gov.in',
      evidence: { executionOrigin: 'REAL_LIVE_LOCAL' },
    };

    // Even if caller passes realRemoteProduction: 'PROVEN', LOCAL PASS is strictly downgraded to NOT_PROVEN
    const truthful = buildTruthfulVerificationReport({
      mode: 'LIVE',
      runnerMode: 'LOCAL',
      actualRunner: 'LOCAL',
      executionOrigin: 'REAL_LIVE_LOCAL',
      executionEnvironment: 'LOCAL',
      remoteStatus: 'REMOTE_NOT_CONFIGURED',
      startedAt: now,
      completedAt: now,
      realRemoteProduction: 'PROVEN',
      entries: [localPassEntry],
    });
    assert.equal(truthful.artifactType, 'CURRENT_RUN');
    assert.equal(truthful.isCurrentRun, true);
    assert.equal(truthful.counts.PASS, 1);
    assert.equal(truthful.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');

    const proofEval = evaluateCurrentProductionProof(truthful);
    assert.equal(proofEval.isCurrentRun, true);
    assert.equal(proofEval.realRemoteProductionProven, false);

    // Also verify buildMachineReadableLiveReport enforces consistent fields & NOT_PROVEN for LOCAL PASS
    const mockLiveSummary: RealLiveVerificationSummary = {
      runnerMode: 'LOCAL',
      runnerHealth: {
        runnerMode: 'LOCAL',
        LOCAL_RUNNER: { status: 'AVAILABLE', details: 'Local runner active' },
        REMOTE_RUNNER: {
          status: 'NOT_CONFIGURED',
          configured: false,
          isMock: false,
          workerEndpoint: null,
          authConfigured: false,
          remoteStatus: 'REMOTE_NOT_CONFIGURED',
          details: 'Not configured',
        },
        SOURCE_ACCESS: {},
      },
      startedAt: now,
      completedAt: now,
      runtimeConfig: {
        timeoutMs: 15000,
        connectionTimeoutMs: 15000,
        maxRetries: 1,
        retryBackoffMs: 200,
        verbose: false,
        validationWarnings: [],
        envVars: {
          timeoutEnvVar: 'OMNIHUB_LIVE_TIMEOUT_MS',
          connectionTimeoutEnvVar: 'OMNIHUB_LIVE_CONNECT_TIMEOUT_MS',
          maxRetriesEnvVar: 'OMNIHUB_LIVE_MAX_RETRIES',
          retryBackoffEnvVar: 'OMNIHUB_LIVE_RETRY_BACKOFF_MS',
        },
      },
      sourcesChecked: 1,
      totalSources: 1,
      liveExecutionCount: 1,
      passCount: 1,
      inconclusiveCount: 0,
      failCount: 0,
      notRunCount: 0,
      realLiveLocalPassCount: 1,
      realLiveRemotePassCount: 0,
      realRemoteLocalWorkerPassCount: 0,
      realRemoteProductionPassCount: 0,
      realLivePassCount: 1,
      realLiveFailCount: 0,
      realLiveInconclusiveCount: 0,
      realPdfProofCount: 1,
      mockRemotePassCount: 0,
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'PROVEN', // intentionally over-claimed; builder must enforce NOT_PROVEN
      proofCounts: {
        REAL_LIVE_LOCAL_PASS: 1,
        REAL_LIVE_REMOTE_PASS: 0,
        REAL_REMOTE_LOCAL_WORKER_PASS: 0,
        REAL_REMOTE_PRODUCTION_PASS: 0,
        REAL_LIVE_PASS: 1,
        REAL_LIVE_FAIL: 0,
        REAL_LIVE_INCONCLUSIVE: 0,
        REAL_PDF_PROOF_COUNT: 1,
        MOCK_REMOTE_PASS: 0,
        FIXTURE_PASS: 0,
        CACHE_RESULT: 0,
        NOT_EXECUTED: 0,
      },
      relevantNoticeCount: 1,
      documentDownloadCount: 1,
      validPdfCount: 1,
      totalDurationMs: 120,
      successfulWithNotices: 1,
      successfulEmpty: 0,
      technicalFailures: 0,
      fixtureExecutionCount: 0,
      cachedExecutionCount: 0,
      mockRemoteExecutionCount: 0,
      exitCode: 0,
      results: [
        {
          sourceId: 'IN-CENTRAL-SSC',
          sourceName: 'SSC',
          mode: 'LIVE',
          runnerMode: 'LOCAL',
          actualRunner: 'LOCAL',
          executionOrigin: 'REAL_LIVE_LOCAL',
          remoteStatus: 'REMOTE_NOT_CONFIGURED',
          adapterSelected: 'IN-CENTRAL-SSC',
          primaryEndpoint: 'https://ssc.gov.in',
          endpointUrl: 'https://ssc.gov.in',
          officialDomainVerified: true,
          endpointReached: true,
          listingValidated: true,
          relevantNoticeFound: true,
          documentDownloaded: true,
          pdfValidated: true,
          validPdfs: 1,
          outcome: 'PASS',
          httpStatus: 200,
          failureClass: null,
          errorType: null,
          failureClassification: null,
          documentUrl: 'https://ssc.gov.in/doc.pdf',
          sha256: 'abc123',
          pageCount: 2,
          latencyMs: 120,
          attempts: 1,
        } as unknown as RealLiveVerificationSummary['results'][number],
      ],
    };

    const liveReport = buildMachineReadableLiveReport(mockLiveSummary);
    assert.equal(liveReport.artifactType, 'CURRENT_RUN');
    assert.equal(liveReport.isCurrentRun, true);
    assert.equal(liveReport.actualRunner, 'LOCAL');
    assert.equal(liveReport.executionOrigin, 'REAL_LIVE_LOCAL');
    assert.equal(liveReport.remoteStatus, 'REMOTE_NOT_CONFIGURED');
    assert.equal(liveReport.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(liveReport.truthfulVerification.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
  });

  it('8. NOT_CONFIGURED, REMOTE_NOT_CONFIGURED, NOT_RUN, FAIL, INCONCLUSIVE never become PASS', async () => {
    assert.equal(normalizeTruthfulStatus('NOT_CONFIGURED'), 'NOT_CONFIGURED');
    assert.equal(normalizeTruthfulStatus('REMOTE_NOT_CONFIGURED'), 'NOT_CONFIGURED');
    assert.equal(normalizeTruthfulStatus('NOT_RUN'), 'NOT_RUN');
    assert.equal(normalizeTruthfulStatus('FAIL'), 'FAIL');
    assert.equal(normalizeTruthfulStatus('INCONCLUSIVE'), 'INCONCLUSIVE');
    assert.notEqual(normalizeTruthfulStatus('NOT_CONFIGURED'), 'PASS');
    assert.notEqual(normalizeTruthfulStatus('NOT_RUN'), 'PASS');
    assert.notEqual(normalizeTruthfulStatus('REMOTE_NOT_CONFIGURED'), 'PASS');

    // Run remote production verifier with empty worker URL (no network calls, no artifact overwrite)
    const report = await runRemoteProductionVerification({
      workerUrl: '',
      authToken: '',
      artifactPath: null,
    });

    assert.equal(report.artifactType, 'CURRENT_RUN');
    assert.equal(report.isCurrentRun, true);
    assert.equal(report.runnerMode, 'REMOTE');
    assert.equal(report.remoteStatus, 'REMOTE_NOT_CONFIGURED');
    assert.equal(report.failureClassification, 'REMOTE_NOT_CONFIGURED');
    assert.equal(report.realRemoteProduction, 'NOT_CONFIGURED');
    assert.equal(report.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');
    assert.equal(report.truthfulVerification.remoteStatus, 'REMOTE_NOT_CONFIGURED');
    assert.equal(report.truthfulVerification.counts.PASS, 0);
    assert.equal(report.truthfulVerification.counts.NOT_CONFIGURED, 7);
    assert.equal(report.truthfulVerification.REAL_REMOTE_PRODUCTION, 'NOT_PROVEN');

    const proofEval = evaluateCurrentProductionProof(report);
    assert.equal(proofEval.isCurrentRun, true);
    assert.equal(proofEval.realRemoteProductionProven, false);
    assert.equal(proofEval.reason, 'REMOTE_NOT_CONFIGURED');
  });

  it('9. /health liveness and /api/ready, /api/health, /api/status remain strictly consistent', async () => {
    // Boot in unconfigured production mode (ephemeral/missing storage, manual mode, LOCAL runner)
    process.env.NODE_ENV = 'production';
    process.env.AUTOMATION_MODE = 'manual';
    process.env.RUNNER_MODE = 'LOCAL';
    delete process.env.DOCUMENT_STORAGE_DIR;
    loadConfig();
    resetDocumentStorageService();

    const handle = await startServerRuntime({
      port: 0,
      host: '127.0.0.1',
      forceNewDatabase: true,
      mountFrontend: false,
      registerSignalHandlers: false,
      rawEnv: { ...process.env, DATABASE_PATH: ':memory:' },
    });

    try {
      const baseUrl = handle.getAddress().url;
      assert.ok(handle.productionGuards.length >= 3, 'Expected startup production guard findings');

      // 1. /health is pure liveness (200) and explicitly separates itself from readiness
      const livenessRes = await fetch(`${baseUrl}/health`);
      assert.equal(livenessRes.status, 200);
      const liveness = (await livenessRes.json()) as Record<string, unknown>;
      assert.equal(liveness.status, 'alive');
      assert.equal(liveness.probe, 'LIVENESS');

      // 2. /api/ready returns 503 NOT_READY in unconfigured production
      const readyRes = await fetch(`${baseUrl}/api/ready`);
      assert.equal(readyRes.status, 503);
      const ready = (await readyRes.json()) as Record<string, unknown>;
      assert.equal(ready.ready, false);
      assert.equal(ready.overall_readiness, 'NOT_READY');

      // 3. /api/health and /api/status must strictly agree across every dependency
      const [healthRes, statusRes] = await Promise.all([
        fetch(`${baseUrl}/api/health`),
        fetch(`${baseUrl}/api/status`),
      ]);
      const health = (await healthRes.json()) as any;
      const status = (await statusRes.json()) as any;

      assert.equal(health.overall_readiness, 'NOT_READY');
      assert.equal(status.overall_readiness, health.overall_readiness);
      assert.equal(status.readiness, health.overall_readiness);
      assert.equal(status.system_status, 'NOT_READY');
      assert.notEqual(health.readiness, 'HEALTHY');

      // Scheduler consistency
      assert.equal(status.scheduler.status, health.scheduler.status);
      assert.equal(status.scheduler.dependency_status, health.scheduler.dependency_status);
      assert.equal(status.scheduler.dependency_status, 'DEGRADED');
      assert.equal(
        status.scheduler.automatic_processing_disabled,
        health.scheduler.automatic_processing_disabled
      );
      assert.equal(status.scheduler.automatic_processing_disabled, true);

      // Remote worker consistency
      assert.equal(status.remote_worker.mode, health.checks.remote_worker.mode);
      assert.equal(status.remote_worker.readiness, health.checks.remote_worker.readiness);
      assert.equal(status.remote_worker.readiness, 'NOT_READY');
      assert.equal(status.remote_worker.status, health.checks.remote_worker.status);
      assert.equal(status.remote_worker.status, 'REMOTE_NOT_CONFIGURED');

      // Durable storage consistency
      assert.equal(
        status.durable_document_storage.status,
        health.checks.durable_document_storage.status
      );
      assert.equal(
        status.durable_document_storage.readiness,
        health.checks.durable_document_storage.readiness
      );
      assert.equal(status.durable_document_storage.status, 'NOT_CONFIGURED');
      assert.equal(status.durable_document_storage.readiness, 'NOT_READY');

      // OCR consistency
      assert.equal(status.ocr.status, health.checks.ocr.status);
      assert.equal(status.ocr.status, 'NOT_CONFIGURED');
      assert.equal(status.ocr.configured, health.checks.ocr.configured);

      // WordPress consistency
      assert.equal(status.wordpress_publishing.status, health.checks.wordpress.status);
      assert.equal(status.wordpress_publishing.status, 'NOT_CONFIGURED');

      // Production guards & blockers consistency
      assert.deepEqual(status.production_guards, health.production_guards);
      assert.deepEqual(ready.production_guards, health.production_guards);
      assert.deepEqual(status.blockers, health.blockers);
    } finally {
      await handle.shutdown('TEST_COMPLETE');
    }
  });

  it('10. OCR model default is consistent across schema, .env.example, README, provider, and readiness', async () => {
    delete process.env.OCR_MODEL;
    delete process.env.GEMINI_API_KEY;
    const config = loadConfig();

    assert.equal(DEFAULT_OCR_MODEL, 'gemini-2.5-flash');
    assert.equal(config.OCR_MODEL, DEFAULT_OCR_MODEL);

    const provider = new GeminiOCRProvider({ apiKey: '' });
    assert.equal(provider.modelVersion, DEFAULT_OCR_MODEL);

    const ocrReadiness = await checkOcrReadiness({ apiKey: '', liveVerify: false });
    assert.equal(ocrReadiness.model, DEFAULT_OCR_MODEL);
    assert.equal(ocrReadiness.OCR_CONFIGURED, false);
    assert.equal(ocrReadiness.OCR_PRODUCTION_READY, false);

    const envExampleContent = fs.readFileSync(
      path.resolve(process.cwd(), '.env.example'),
      'utf8'
    );
    assert.match(envExampleContent, /^OCR_MODEL="gemini-2\.5-flash"$/m);

    const readmeContent = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
    assert.match(readmeContent, /OCR_MODEL=gemini-2\.5-flash/);
  });
});
