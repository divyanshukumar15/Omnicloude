/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import {
  HttpRemoteAcquisitionRunner,
  type AcquisitionExecutionOrigin,
  type RemoteExecutionState,
  type RunnerClassification,
  type RunnerMode,
  type ExecutionEnvironmentKind,
} from './acquisition-runner.ts';
import { getDiscoveryExecutor } from './discovery-executor.ts';
import { isOfficialDomain } from './official-domains.ts';
import { classifyNetworkOrHttpError } from './network-error-classifier.ts';
import { initDatabase, closeDatabase, getRepositories } from '../../database/index.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { logger } from '../../config/logger.ts';
import { verifyWorkerPackageFiles } from '../../../worker/container-smoke-test.ts';
import {
  OFFICIAL_SOURCE_LABELS,
  buildTruthfulVerificationReport,
  createVerificationExecutionId,
  normalizeTruthfulStatus,
  normalizeVerificationRunner,
  type TruthfulVerificationEntry,
  type TruthfulVerificationReport,
  type TruthfulVerificationStatus,
} from './verification-model.ts';

export type RealRemoteProductionStatus =
  | 'PROVEN'
  | 'NOT_CONFIGURED'
  | 'FAILED'
  | 'REACHABLE_ACQUISITION_FAILED'
  | 'NOT_PROVEN';

export type SourceVerificationClassification =
  | 'PASS'
  | 'FAIL'
  | 'INCONCLUSIVE'
  | 'NOT_CONFIGURED'
  | 'NOT_RUN'
  | 'SUCCESS_NO_RELEVANT_NOTICES'
  | 'PDF_VALIDATION_FAILED'
  | 'NETWORK_FAILURE'
  | 'TLS_FAILURE'
  | 'DNS_FAILURE';

export interface SourceVerificationSummaryEntry {
  source: string;
  sourceId: string;
  runner: 'LOCAL' | 'REMOTE' | 'MOCK';
  outcome: TruthfulVerificationStatus;
  classification: SourceVerificationClassification;
  failureClass: string;
  validPdfs: number;
  details: string | null;
}

export type RemoteProductionFailureClassification =
  | 'NONE'
  | 'REMOTE_NOT_CONFIGURED'
  | 'REMOTE_DNS_FAILURE'
  | 'REMOTE_CONNECTION_TIMEOUT'
  | 'REMOTE_CONNECTION_REFUSED'
  | 'REMOTE_TLS_FAILURE'
  | 'REMOTE_AUTH_FAILED'
  | 'REMOTE_HTTP_ERROR'
  | 'REMOTE_PROTOCOL_ERROR'
  | 'REMOTE_WORKER_ERROR'
  | 'OFFICIAL_SOURCE_TIMEOUT'
  | 'OFFICIAL_SOURCE_ACCESS_BLOCKED'
  | 'OFFICIAL_SOURCE_HTTP_ERROR'
  | 'DOCUMENT_ACQUISITION_FAILURE'
  | 'PDF_VALIDATION_FAILURE';

export type RemoteProductionStageStatus =
  | 'PASS'
  | 'FAIL'
  | 'INCONCLUSIVE'
  | 'NOT_CONFIGURED'
  | 'NOT_RUN';

export interface RemoteProductionStages {
  WORKER_URL_CONFIGURATION: RemoteProductionStageStatus;
  WORKER_HEALTH: RemoteProductionStageStatus;
  WORKER_CONNECTIVITY: RemoteProductionStageStatus;
  REMOTE_AUTH: RemoteProductionStageStatus;
  REMOTE_HTTP_EXECUTION: RemoteProductionStageStatus;
  REMOTE_EXECUTION_IDENTITY: RemoteProductionStageStatus;
  REMOTE_EXECUTION: RemoteProductionStageStatus;
  OFFICIAL_SOURCE_ACCESS: RemoteProductionStageStatus;
  DOCUMENT_ACQUISITION: RemoteProductionStageStatus;
  PDF_VALIDATION: RemoteProductionStageStatus;
  AUDIT_EVIDENCE: RemoteProductionStageStatus;
}

export interface RemoteProductionVerificationOptions {
  workerUrl?: string;
  authToken?: string;
  sourceIds?: string[];
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof globalThis.fetch;
  skipWorkerUrlIpValidation?: boolean;
  artifactPath?: string | null;
}

export interface RemoteProductionVerificationReport {
  executionId: string;
  artifactType: 'CURRENT_RUN';
  isCurrentRun: true;
  mode: 'REAL_REMOTE_PRODUCTION';
  runnerMode: RunnerMode;
  executionOrigin: AcquisitionExecutionOrigin | null;
  remoteStatus: RemoteExecutionState;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  truthfulVerification: TruthfulVerificationReport;
  dockerfileExists: boolean;
  dockerfileValid: boolean;
  dockerRuntime: 'AVAILABLE' | 'UNAVAILABLE';
  dockerBuild: 'PASS' | 'FAIL' | 'NOT_RUN';
  containerHealth: 'PASS' | 'FAIL' | 'NOT_RUN';
  containerCapabilities: 'PASS' | 'FAIL' | 'NOT_RUN';
  remoteConfigured: boolean;
  remoteReachable: boolean;
  remoteIdentityVerified: boolean;
  remoteAcquisitionExecuted: boolean;
  realRemoteProduction: RealRemoteProductionStatus;
  workerConfigured: boolean;
  workerUrl: string | null;
  workerEndpoint: string | null;
  authConfigured: boolean;
  isLoopbackWorker: boolean;
  actualRunner: 'REMOTE' | 'LOCAL' | null;
  runnerClassification: RunnerClassification | null;
  executionEnvironment: ExecutionEnvironmentKind | null;
  workerId: string | null;
  remoteWorkerId: string | null;
  workerVersion: string | null;
  workerIdentity: {
    workerId: string | null;
    remoteWorkerId: string | null;
    workerVersion: string | null;
    actualRunner: 'REMOTE' | 'LOCAL' | null;
    executionEnvironment: ExecutionEnvironmentKind | null;
    runnerClassification: RunnerClassification | null;
  };
  requestId: string | null;
  sourceId: string | null;
  testedSourceId: string | null;
  attempts: number;
  httpStatus: number | null;
  finalUrl: string | null;
  officialDomainVerified: boolean;
  stages: RemoteProductionStages;
  failureClassification: RemoteProductionFailureClassification;
  failureDetails: string | null;
  documentResult: {
    discovered: boolean;
    downloaded: boolean;
    documentUrl: string | null;
    contentType: string | null;
    bytesReceived: number;
    sha256: string | null;
  };
  pdfResult: {
    validated: boolean;
    isPdf: boolean;
    pageCount: number | null;
    sha256: string | null;
  };
  evidence: {
    endpointUrl: string | null;
    listingUrl: string | null;
    noticeUrl: string | null;
    detailUrl: string | null;
    documentUrl: string | null;
    documentSha256: string | null;
    pdfPageCount: number | null;
    httpStatus: number | null;
    bytesReceived: number;
    auditCorrelationId: string;
    auditPersisted: boolean;
  };
  governmentSources: Record<string, SourceVerificationSummaryEntry>;
  REAL_REMOTE_LOCAL_WORKER: 'PROVEN' | 'NOT_PROVEN';
  REAL_REMOTE_PRODUCTION: 'PROVEN' | 'NOT_PROVEN';
  exitCode: 0 | 1 | 2;
}

const DEFAULT_VERIFICATION_SOURCES = [
  'IN-CENTRAL-SSC',
  'IN-CENTRAL-UPSC',
  'IN-UP-UPPSC',
];

function classifyWorkerTransportError(
  errorType: string | null | undefined,
  statusCode: number | null | undefined
): RemoteProductionFailureClassification {
  if (statusCode === 401 || statusCode === 403) return 'REMOTE_AUTH_FAILED';
  if (errorType === 'DNS_ERROR') return 'REMOTE_DNS_FAILURE';
  if (errorType === 'TIMEOUT') return 'REMOTE_CONNECTION_TIMEOUT';
  if (errorType === 'CONNECTION_REFUSED') return 'REMOTE_CONNECTION_REFUSED';
  if (errorType === 'TLS_ERROR') return 'REMOTE_TLS_FAILURE';
  if (statusCode && statusCode >= 400) return 'REMOTE_HTTP_ERROR';
  return 'REMOTE_WORKER_ERROR';
}

/**
 * Executes end-to-end verification of the deployed Production Remote Acquisition Worker.
 *
 * Strict Section 8, 9, 10 Invariants:
 * - REAL_REMOTE_PRODUCTION becomes 'PROVEN' ONLY when:
 *   1. OFFICIAL_ACQUISITION_WORKER_URL is configured and is an external HTTPS endpoint (not loopback)
 *   2. Central application makes a real HTTP request to /health, /capabilities, and POST /acquire
 *   3. Authentication succeeds
 *   4. Worker returns actualRunner='REMOTE' and executionEnvironment='PRODUCTION_REMOTE'
 *   5. Request reaches an approved official source and returns valid response
 *   6. Official PDF is acquired and validated by the central PDF validation pipeline
 *   7. Request/response evidence is persisted in the audit trail
 */
export async function runRemoteProductionVerification(
  options: RemoteProductionVerificationOptions = {}
): Promise<RemoteProductionVerificationReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const auditCorrelationId = `remote-prod-verify-${crypto.randomUUID()}`;

  const rawWorkerUrl = (
    options.workerUrl ??
    process.env.OFFICIAL_ACQUISITION_WORKER_URL ??
    process.env.OMNIHUB_REMOTE_WORKER_URL ??
    ''
  ).trim();
  const rawToken = (
    options.authToken ??
    process.env.OFFICIAL_ACQUISITION_WORKER_TOKEN ??
    process.env.OMNIHUB_REMOTE_WORKER_TOKEN ??
    ''
  ).trim();

  const timeoutMs = options.timeoutMs ?? 15000;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 15000;
  const maxRetries = options.maxRetries ?? 1;
  const candidateSources =
    options.sourceIds && options.sourceIds.length > 0
      ? options.sourceIds
      : DEFAULT_VERIFICATION_SOURCES;

  const stages: RemoteProductionStages = {
    WORKER_URL_CONFIGURATION: 'NOT_CONFIGURED',
    WORKER_HEALTH: 'NOT_CONFIGURED',
    WORKER_CONNECTIVITY: 'NOT_CONFIGURED',
    REMOTE_AUTH: 'NOT_CONFIGURED',
    REMOTE_HTTP_EXECUTION: 'NOT_CONFIGURED',
    REMOTE_EXECUTION_IDENTITY: 'NOT_CONFIGURED',
    REMOTE_EXECUTION: 'NOT_CONFIGURED',
    OFFICIAL_SOURCE_ACCESS: 'NOT_CONFIGURED',
    DOCUMENT_ACQUISITION: 'NOT_CONFIGURED',
    PDF_VALIDATION: 'NOT_CONFIGURED',
    AUDIT_EVIDENCE: 'NOT_CONFIGURED',
  };

  let auditService: AuditService | null = null;
  try {
    const repos = getRepositories();
    auditService = new AuditService(repos.auditLogs);
  } catch {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();
    auditService = new AuditService(repos.auditLogs);
  }

  const recordAudit = (
    action: string,
    status: 'SUCCESS' | 'FAILURE' | 'INFO',
    stage: string,
    details: Record<string, unknown>
  ): boolean => {
    try {
      auditService?.record({
        correlationId: auditCorrelationId,
        actor: 'verify:remote-production',
        action,
        entityType: 'RemoteAcquisitionWorker',
        entityId: rawWorkerUrl || 'unconfigured',
        stage,
        status,
        details: {
          executionMode: 'REMOTE',
          timestamp: new Date().toISOString(),
          ...details,
        },
      });
      return true;
    } catch {
      return false;
    }
  };

  const executionId = createVerificationExecutionId('remote-prod');
  // Track ONLY sources actually executed during THIS verification run (never hardcode PASS or mix historical artifacts!)
  const currentRunSourceResults = new Map<
    string,
    {
      sourceId: string;
      runner: 'LOCAL' | 'REMOTE' | 'MOCK';
      outcome: TruthfulVerificationStatus;
      classification: SourceVerificationClassification;
      failureClass: string;
      validPdfs: number;
      details: string | null;
      httpStatus: number | null;
      finalUrl: string | null;
      evidence: Record<string, unknown>;
    }
  >();

  const buildCurrentRunSevenSourceSummary = (ctx: {
    remoteStatus: RemoteExecutionState;
    executionEnvironment: ExecutionEnvironmentKind | null;
    workerIdentity: {
      workerId: string | null;
      remoteWorkerId: string | null;
      workerVersion: string | null;
      executionEnvironment: ExecutionEnvironmentKind | null;
    };
  }): {
    governmentSources: Record<string, SourceVerificationSummaryEntry>;
    truthfulEntries: TruthfulVerificationEntry[];
  } => {
    const completedAtNow = new Date().toISOString();
    const governmentSources: Record<string, SourceVerificationSummaryEntry> = {};
    const truthfulEntries: TruthfulVerificationEntry[] = [];

    for (const [sourceId, shortName] of Object.entries(OFFICIAL_SOURCE_LABELS)) {
      const executed = currentRunSourceResults.get(sourceId);
      if (executed) {
        const entryOrigin =
          typeof executed.evidence.executionOrigin === 'string'
            ? executed.evidence.executionOrigin
            : null;
        governmentSources[shortName] = {
          source: shortName,
          sourceId,
          runner: executed.runner,
          outcome: executed.outcome,
          classification: executed.classification,
          failureClass: executed.failureClass,
          validPdfs: executed.validPdfs,
          details: executed.details,
        };
        truthfulEntries.push({
          source: shortName,
          sourceId,
          adapter: sourceId,
          runner: executed.runner,
          runnerMode: 'REMOTE',
          actualRunner: executed.runner === 'LOCAL' ? 'LOCAL' : 'REMOTE',
          executionOrigin: entryOrigin,
          executionEnvironment: ctx.executionEnvironment,
          remoteStatus: ctx.remoteStatus,
          workerIdentity: ctx.workerIdentity,
          checkType: 'REMOTE_PRODUCTION',
          startedAt,
          completedAt: completedAtNow,
          executionId,
          status: executed.outcome,
          errorCategory: executed.outcome === 'PASS' ? null : executed.failureClass,
          httpStatus: executed.httpStatus,
          finalUrl: executed.finalUrl,
          evidence: executed.evidence,
        });
      } else {
        const statusWhenNotExecuted: TruthfulVerificationStatus = !rawWorkerUrl
          ? 'NOT_CONFIGURED'
          : 'NOT_RUN';
        governmentSources[shortName] = {
          source: shortName,
          sourceId,
          runner: 'REMOTE',
          outcome: statusWhenNotExecuted,
          classification: statusWhenNotExecuted,
          failureClass: statusWhenNotExecuted,
          validPdfs: 0,
          details: !rawWorkerUrl
            ? 'Remote acquisition worker not configured; source not checked'
            : 'Not executed in this verification run',
        };
        truthfulEntries.push({
          source: shortName,
          sourceId,
          adapter: sourceId,
          runner: 'REMOTE',
          runnerMode: 'REMOTE',
          actualRunner: null,
          executionOrigin: null,
          executionEnvironment: ctx.executionEnvironment,
          remoteStatus: ctx.remoteStatus,
          workerIdentity: ctx.workerIdentity,
          checkType: 'REMOTE_PRODUCTION',
          startedAt,
          completedAt: completedAtNow,
          executionId,
          status: statusWhenNotExecuted,
          errorCategory: statusWhenNotExecuted,
          httpStatus: null,
          finalUrl: null,
          evidence: { executedInCurrentRun: false },
        });
      }
    }

    return { governmentSources, truthfulEntries };
  };

  const finalizeReport = (
    partial: Omit<
      RemoteProductionVerificationReport,
      | 'executionId'
      | 'artifactType'
      | 'isCurrentRun'
      | 'mode'
      | 'runnerMode'
      | 'executionOrigin'
      | 'remoteStatus'
      | 'startedAt'
      | 'completedAt'
      | 'durationMs'
      | 'truthfulVerification'
      | 'dockerfileExists'
      | 'dockerfileValid'
      | 'dockerRuntime'
      | 'dockerBuild'
      | 'containerHealth'
      | 'containerCapabilities'
      | 'remoteConfigured'
      | 'remoteReachable'
      | 'remoteIdentityVerified'
      | 'remoteAcquisitionExecuted'
      | 'realRemoteProduction'
      | 'governmentSources'
      | 'workerUrl'
      | 'workerId'
      | 'workerIdentity'
      | 'sourceId'
      | 'attempts'
      | 'httpStatus'
      | 'finalUrl'
      | 'documentResult'
      | 'pdfResult'
    > & {
      attempts?: number;
    }
  ): RemoteProductionVerificationReport => {
    const syncedStages: RemoteProductionStages = {
      ...partial.stages,
      WORKER_URL_CONFIGURATION: partial.workerConfigured
        ? 'PASS'
        : partial.workerEndpoint === 'INVALID_WORKER_URL'
        ? 'FAIL'
        : 'NOT_CONFIGURED',
      WORKER_HEALTH: partial.stages.WORKER_CONNECTIVITY,
      REMOTE_HTTP_EXECUTION:
        partial.stages.REMOTE_AUTH === 'PASS'
          ? partial.stages.REMOTE_EXECUTION === 'PASS' ||
            partial.stages.OFFICIAL_SOURCE_ACCESS !== 'NOT_CONFIGURED'
            ? 'PASS'
            : partial.stages.REMOTE_EXECUTION
          : partial.stages.REMOTE_AUTH === 'FAIL'
          ? 'FAIL'
          : partial.stages.WORKER_CONNECTIVITY === 'PASS'
          ? 'INCONCLUSIVE'
          : 'NOT_CONFIGURED',
      REMOTE_EXECUTION_IDENTITY:
        partial.REAL_REMOTE_PRODUCTION === 'PROVEN'
          ? 'PASS'
          : partial.isLoopbackWorker && partial.stages.REMOTE_EXECUTION === 'PASS'
          ? 'FAIL'
          : partial.stages.REMOTE_EXECUTION,
      AUDIT_EVIDENCE: partial.evidence.auditPersisted ? 'PASS' : 'FAIL',
    };

    const docUrl = partial.evidence.documentUrl;
    const docSha = partial.evidence.documentSha256;
    const pdfPages = partial.evidence.pdfPageCount;
    const isPdfValidated = Boolean(
      partial.stages.PDF_VALIDATION === 'PASS' && docSha && pdfPages && pdfPages >= 1
    );

    const pkgCheck = verifyWorkerPackageFiles();
    const remoteConfigured = Boolean(
      partial.workerConfigured && partial.workerEndpoint !== 'INVALID_WORKER_URL'
    );
    const remoteReachable = syncedStages.WORKER_HEALTH === 'PASS';
    const remoteIdentityVerified =
      syncedStages.REMOTE_EXECUTION === 'PASS' && partial.actualRunner === 'REMOTE';
    const remoteAcquisitionExecuted =
      remoteIdentityVerified &&
      (syncedStages.OFFICIAL_SOURCE_ACCESS === 'PASS' ||
        syncedStages.OFFICIAL_SOURCE_ACCESS === 'FAIL');

    let realRemoteProduction: RealRemoteProductionStatus = 'NOT_CONFIGURED';
    if (partial.REAL_REMOTE_PRODUCTION === 'PROVEN') {
      realRemoteProduction = 'PROVEN';
    } else if (!partial.workerConfigured && !partial.workerEndpoint) {
      realRemoteProduction = 'NOT_CONFIGURED';
    } else if (partial.isLoopbackWorker) {
      realRemoteProduction = 'NOT_PROVEN';
    } else if (remoteReachable && remoteIdentityVerified) {
      realRemoteProduction = 'REACHABLE_ACQUISITION_FAILED';
    } else {
      realRemoteProduction = 'FAILED';
    }

    const completedAt = new Date().toISOString();
    const derivedRemoteStatus: RemoteExecutionState = !remoteConfigured
      ? 'REMOTE_NOT_CONFIGURED'
      : !remoteReachable
        ? 'REMOTE_UNAVAILABLE'
        : partial.REAL_REMOTE_PRODUCTION === 'PROVEN' || partial.REAL_REMOTE_LOCAL_WORKER === 'PROVEN'
          ? 'REMOTE_EXECUTED'
          : 'REMOTE_FAILED';
    const derivedExecutionOrigin: AcquisitionExecutionOrigin | null =
      partial.REAL_REMOTE_PRODUCTION === 'PROVEN'
        ? 'REAL_REMOTE_PRODUCTION'
        : partial.isLoopbackWorker || partial.executionEnvironment === 'LOCAL_WORKER'
          ? 'REAL_REMOTE_LOCAL_WORKER'
          : remoteConfigured && partial.actualRunner === 'REMOTE'
            ? 'REAL_LIVE_REMOTE'
            : null;
    const summaryWorkerIdentity = {
      workerId: partial.remoteWorkerId,
      remoteWorkerId: partial.remoteWorkerId,
      workerVersion: partial.workerVersion,
      executionEnvironment: partial.executionEnvironment,
    };

    const { governmentSources, truthfulEntries } = buildCurrentRunSevenSourceSummary({
      remoteStatus: derivedRemoteStatus,
      executionEnvironment: partial.executionEnvironment,
      workerIdentity: summaryWorkerIdentity,
    });
    const truthfulVerification = buildTruthfulVerificationReport({
      executionId,
      mode: 'REAL_REMOTE_PRODUCTION',
      runnerMode: 'REMOTE',
      actualRunner: partial.actualRunner,
      executionOrigin: derivedExecutionOrigin,
      executionEnvironment: partial.executionEnvironment,
      remoteStatus: derivedRemoteStatus,
      workerIdentity: summaryWorkerIdentity,
      startedAt,
      completedAt,
      realRemoteProduction: partial.REAL_REMOTE_PRODUCTION,
      entries: truthfulEntries,
    });

    const report: RemoteProductionVerificationReport = {
      executionId,
      artifactType: 'CURRENT_RUN',
      isCurrentRun: true,
      mode: 'REAL_REMOTE_PRODUCTION',
      runnerMode: 'REMOTE',
      executionOrigin: derivedExecutionOrigin,
      remoteStatus: derivedRemoteStatus,
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
      truthfulVerification,
      dockerfileExists: pkgCheck.dockerfileStructure.exists,
      dockerfileValid: pkgCheck.dockerfileStructure.valid,
      dockerRuntime: 'UNAVAILABLE',
      dockerBuild: 'NOT_RUN',
      containerHealth: 'NOT_RUN',
      containerCapabilities: 'NOT_RUN',
      remoteConfigured,
      remoteReachable,
      remoteIdentityVerified,
      remoteAcquisitionExecuted,
      realRemoteProduction,
      ...partial,
      REAL_REMOTE_PRODUCTION: truthfulVerification.REAL_REMOTE_PRODUCTION,
      workerUrl: partial.workerEndpoint,
      workerId: partial.remoteWorkerId,
      workerIdentity: {
        workerId: partial.remoteWorkerId,
        remoteWorkerId: partial.remoteWorkerId,
        workerVersion: partial.workerVersion,
        actualRunner: partial.actualRunner,
        executionEnvironment: partial.executionEnvironment,
        runnerClassification: partial.runnerClassification,
      },
      sourceId: partial.testedSourceId,
      attempts: partial.attempts ?? (partial.workerConfigured ? 1 : 0),
      httpStatus: partial.evidence.httpStatus,
      finalUrl: partial.evidence.listingUrl ?? partial.evidence.endpointUrl,
      stages: syncedStages,
      documentResult: {
        discovered: Boolean(docUrl || partial.evidence.noticeUrl),
        downloaded: Boolean(docUrl && docSha),
        documentUrl: docUrl,
        contentType: docUrl ? 'application/pdf' : null,
        bytesReceived: partial.evidence.bytesReceived,
        sha256: docSha,
      },
      pdfResult: {
        validated: isPdfValidated,
        isPdf: isPdfValidated,
        pageCount: pdfPages,
        sha256: docSha,
      },
      governmentSources,
    };

    const artifactTarget =
      options.artifactPath === undefined
        ? path.resolve(process.cwd(), 'artifacts', 'remote-production-verification-report.json')
        : options.artifactPath;

    if (artifactTarget) {
      try {
        fs.mkdirSync(path.dirname(artifactTarget), { recursive: true });
        fs.writeFileSync(artifactTarget, JSON.stringify(report, null, 2) + '\n', 'utf8');
      } catch {
        // Ignore artifact write errors in read-only environments
      }
    }

    return report;
  };

  // 1. Check if OFFICIAL_ACQUISITION_WORKER_URL is configured
  if (!rawWorkerUrl) {
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_NOT_CONFIGURED',
      'FAILURE',
      'CONFIGURATION',
      { reason: 'OFFICIAL_ACQUISITION_WORKER_URL is not configured' }
    );
    return finalizeReport({
      workerConfigured: false,
      workerEndpoint: null,
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: false,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: null,
      workerVersion: null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_NOT_CONFIGURED',
      failureDetails:
        'OFFICIAL_ACQUISITION_WORKER_URL is not configured. External production worker verification cannot proceed.',
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  let parsedWorkerUrl: URL;
  try {
    parsedWorkerUrl = new URL(rawWorkerUrl);
  } catch {
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_INVALID_URL',
      'FAILURE',
      'WORKER_CONNECTIVITY',
      { workerUrl: rawWorkerUrl }
    );
    stages.WORKER_CONNECTIVITY = 'FAIL';
    return finalizeReport({
      workerConfigured: false,
      workerEndpoint: 'INVALID_WORKER_URL',
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: false,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: null,
      workerVersion: null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails: `Malformed OFFICIAL_ACQUISITION_WORKER_URL: ${rawWorkerUrl}`,
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  const sanitizedWorkerEndpoint = `${parsedWorkerUrl.origin}${parsedWorkerUrl.pathname}`;
  const runner = new HttpRemoteAcquisitionRunner({
    workerUrl: rawWorkerUrl,
    authToken: rawToken,
    fetchFn: options.fetchFn,
    skipWorkerUrlIpValidation: options.skipWorkerUrlIpValidation,
  });
  const isLoopback = runner.isLocalWorkerEndpoint();

  // Enforce HTTPS for external production worker URLs
  if (!isLoopback && parsedWorkerUrl.protocol !== 'https:') {
    stages.WORKER_CONNECTIVITY = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_INSECURE_PROTOCOL',
      'FAILURE',
      'WORKER_CONNECTIVITY',
      { workerEndpoint: sanitizedWorkerEndpoint, protocol: parsedWorkerUrl.protocol }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: false,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: null,
      workerVersion: null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails: `External production worker URL must use HTTPS (received ${parsedWorkerUrl.protocol})`,
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  // Stage 1: WORKER_CONNECTIVITY (/health and /capabilities)
  const healthRes = await runner.checkHealth(Math.min(timeoutMs, 8000));
  if (!healthRes.reachable || !healthRes.healthy) {
    stages.WORKER_CONNECTIVITY = 'FAIL';
    const failureClassification = !healthRes.reachable
      ? classifyWorkerTransportError(healthRes.errorType, healthRes.statusCode)
      : healthRes.statusCode && healthRes.statusCode >= 400
      ? 'REMOTE_HTTP_ERROR'
      : 'REMOTE_PROTOCOL_ERROR';

    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_HEALTH_FAILED',
      'FAILURE',
      'WORKER_CONNECTIVITY',
      {
        workerEndpoint: sanitizedWorkerEndpoint,
        details: healthRes.details,
        failureClassification,
      }
    );

    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: isLoopback,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: healthRes.remoteWorkerId ?? null,
      workerVersion: healthRes.workerVersion ?? null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification,
      failureDetails: healthRes.details,
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: healthRes.statusCode ?? null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  // Verify health contract fields (service, version, uptime, timestamp, capabilities)
  const rawHealth = healthRes.rawHealth ?? {};
  if (
    typeof rawHealth.service !== 'string' ||
    typeof rawHealth.timestamp !== 'string' ||
    (typeof rawHealth.uptime !== 'number' && typeof rawHealth.uptimeMs !== 'number')
  ) {
    stages.WORKER_CONNECTIVITY = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_HEALTH_CONTRACT_INVALID',
      'FAILURE',
      'WORKER_CONNECTIVITY',
      { workerEndpoint: sanitizedWorkerEndpoint }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: isLoopback,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: healthRes.remoteWorkerId ?? null,
      workerVersion: healthRes.workerVersion ?? null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails:
        'Worker /health response is missing required contract fields (service, uptime, timestamp)',
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: 200,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  const capRes = await runner.getCapabilities(Math.min(timeoutMs, 8000));
  if (!capRes.reachable || capRes.supportedSourcesCount < 1) {
    stages.WORKER_CONNECTIVITY = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_CAPABILITIES_FAILED',
      'FAILURE',
      'WORKER_CONNECTIVITY',
      { workerEndpoint: sanitizedWorkerEndpoint }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: Boolean(rawToken),
      isLoopbackWorker: isLoopback,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: healthRes.remoteWorkerId ?? null,
      workerVersion: healthRes.workerVersion ?? null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails: 'Worker /capabilities endpoint unreachable or returned 0 supported sources',
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.WORKER_CONNECTIVITY = 'PASS';

  // Stage 2: REMOTE_AUTH check — if token is missing on client side, fail before or during acquire
  if (!rawToken) {
    stages.REMOTE_AUTH = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_AUTH_TOKEN_MISSING',
      'FAILURE',
      'REMOTE_AUTH',
      { workerEndpoint: sanitizedWorkerEndpoint }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: false,
      isLoopbackWorker: isLoopback,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: healthRes.remoteWorkerId ?? null,
      workerVersion: healthRes.workerVersion ?? null,
      requestId: null,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_AUTH_FAILED',
      failureDetails:
        'OFFICIAL_ACQUISITION_WORKER_TOKEN is not configured; cannot authenticate to remote worker',
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  // Probe POST /acquire directly on the first candidate source's official endpoint to verify
  // REMOTE_AUTH and REMOTE_EXECUTION (runner identity: actualRunner=REMOTE, executionEnvironment=PRODUCTION_REMOTE)
  const primarySourceId = candidateSources[0];
  const probeEndpointMap: Record<string, string> = {
    'IN-CENTRAL-SSC': 'https://ssc.gov.in/api/general-website/portal/notice-boards',
    'IN-CENTRAL-UPSC': 'https://www.upsc.gov.in',
    'IN-UP-UPPSC': 'https://uppsc.up.nic.in',
    'IN-CENTRAL-RRB': 'https://rrbcdg.gov.in',
    'IN-BIHAR-BPSC': 'https://bpsc.bih.nic.in',
    'IN-BIHAR-BSSC': 'https://bssc.bihar.gov.in',
    'IN-UP-UPSSSC': 'https://upsssc.gov.in',
  };
  const probeTargetUrl = probeEndpointMap[primarySourceId] || 'https://ssc.gov.in';
  const probeRequestId = `verify-prod-${crypto.randomUUID()}`;

  const directAcquireRes = await runner.acquire({
    requestId: probeRequestId,
    sourceId: primarySourceId,
    endpoint: probeTargetUrl,
    methodType: 'LISTING',
    timeoutPolicy: {
      timeoutMs,
      connectionTimeoutMs,
    },
    retryPolicy: {
      maxRetries,
      retryBackoffMs: 300,
    },
  });

  // Check if authentication failed (401/403 UNAUTHORIZED_WORKER_REQUEST)
  if (
    directAcquireRes.errorCode === 'UNAUTHORIZED_WORKER_REQUEST' ||
    ((directAcquireRes.httpStatus === 401 || directAcquireRes.httpStatus === 403) &&
      directAcquireRes.failureDetails?.toLowerCase().includes('worker'))
  ) {
    stages.REMOTE_AUTH = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_AUTH_REJECTED',
      'FAILURE',
      'REMOTE_AUTH',
      {
        workerEndpoint: sanitizedWorkerEndpoint,
        httpStatus: directAcquireRes.httpStatus,
        errorCode: directAcquireRes.errorCode,
      }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? healthRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? healthRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: primarySourceId,
      officialDomainVerified: isOfficialDomain(probeTargetUrl, primarySourceId).allowed,
      stages,
      failureClassification: 'REMOTE_AUTH_FAILED',
      failureDetails: directAcquireRes.failureDetails || 'Worker rejected authentication token',
      evidence: {
        endpointUrl: probeTargetUrl,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: directAcquireRes.httpStatus,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  // Check if worker returned malformed payload or protocol error
  if (directAcquireRes.errorCode === 'REMOTE_PROTOCOL_ERROR') {
    stages.REMOTE_AUTH = 'PASS';
    stages.REMOTE_EXECUTION = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_PROTOCOL_ERROR',
      'FAILURE',
      'REMOTE_EXECUTION',
      {
        workerEndpoint: sanitizedWorkerEndpoint,
        failureDetails: directAcquireRes.failureDetails,
      }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: null,
      runnerClassification: null,
      executionEnvironment: null,
      remoteWorkerId: healthRes.remoteWorkerId ?? null,
      workerVersion: healthRes.workerVersion ?? null,
      requestId: probeRequestId,
      testedSourceId: primarySourceId,
      officialDomainVerified: isOfficialDomain(probeTargetUrl, primarySourceId).allowed,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails:
        directAcquireRes.failureDetails || 'Remote worker returned malformed response',
      evidence: {
        endpointUrl: probeTargetUrl,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: directAcquireRes.httpStatus,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.REMOTE_AUTH = 'PASS';

  // Stage 3: Verify runner identity returned by the worker
  const returnedIdentity = directAcquireRes.runnerIdentity;
  const hasValidIdentity =
    directAcquireRes.actualRunner === 'REMOTE' &&
    Boolean(directAcquireRes.remoteWorkerId || returnedIdentity?.runnerId) &&
    Boolean(directAcquireRes.workerVersion || returnedIdentity?.version);

  if (!hasValidIdentity) {
    stages.REMOTE_EXECUTION = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_IDENTITY_MISSING',
      'FAILURE',
      'REMOTE_EXECUTION',
      {
        workerEndpoint: sanitizedWorkerEndpoint,
        actualRunner: directAcquireRes.actualRunner,
        remoteWorkerId: directAcquireRes.remoteWorkerId,
        workerVersion: directAcquireRes.workerVersion,
      }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: directAcquireRes.actualRunner ?? null,
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: primarySourceId,
      officialDomainVerified: isOfficialDomain(probeTargetUrl, primarySourceId).allowed,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails:
        'Worker response is missing required identity fields (actualRunner=REMOTE, remoteWorkerId, workerVersion)',
      evidence: {
        endpointUrl: probeTargetUrl,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: directAcquireRes.httpStatus,
        bytesReceived: directAcquireRes.bytesReceived ?? 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.REMOTE_EXECUTION = 'PASS';

  // Stage 4, 5, 6: Execute E2E discovery + PDF download + central PDF validation across candidate sources
  // Note (Section 9): Do not require all seven government sources to succeed for the worker itself to be considered operational.
  const executor = getDiscoveryExecutor();
  let lastExecResult: Awaited<ReturnType<typeof executor.execute>> | null = null;
  let lastSourceId = primarySourceId;

  for (const sourceId of candidateSources) {
    lastSourceId = sourceId;
    const execRes = await executor.execute(sourceId, {
      verificationMode: 'LIVE',
      runnerMode: 'REMOTE',
      remoteRunner: runner,
      downloadAndValidatePdfs: true,
      strictLiveMode: true,
      timeoutMs,
      connectionTimeoutMs,
      maxRetries,
      noCache: true,
    });
    lastExecResult = execRes;

    const normalizedOutcome = normalizeTruthfulStatus(execRes.outcome);
    const runnerKind = normalizeVerificationRunner({
      executionOrigin: execRes.executionOrigin,
      actualRunner: execRes.actualRunner ?? 'REMOTE',
    });
    const fc =
      normalizedOutcome === 'PASS'
        ? 'SUCCESS'
        : execRes.lastErrorType || execRes.failureReasons?.[0] || 'FAIL';
    const classification: SourceVerificationClassification =
      normalizedOutcome === 'PASS'
        ? 'PASS'
        : normalizedOutcome === 'INCONCLUSIVE'
          ? 'INCONCLUSIVE'
          : fc === 'TLS_ERROR' || fc === 'TLS_FAILURE'
            ? 'TLS_FAILURE'
            : fc === 'DNS_ERROR' || fc === 'DNS_FAILURE'
              ? 'DNS_FAILURE'
              : fc === 'INVALID_PDF' || fc === 'PDF_VALIDATION_FAILED'
                ? 'PDF_VALIDATION_FAILED'
                : fc === 'TIMEOUT' || fc === 'CONNECTION_RESET' || fc === 'CONNECTION_REFUSED'
                  ? 'NETWORK_FAILURE'
                  : 'FAIL';

    currentRunSourceResults.set(sourceId, {
      sourceId,
      runner: runnerKind,
      outcome: normalizedOutcome,
      classification,
      failureClass: fc,
      validPdfs: execRes.metrics.validPdfs ?? 0,
      details: execRes.lastErrorMessage || execRes.failureReasons?.[0] || null,
      httpStatus: execRes.verificationEvidence?.httpStatus ?? null,
      finalUrl: execRes.evidence?.listingUrl ?? execRes.evidence?.endpointUrl ?? null,
      evidence: {
        executedInCurrentRun: true,
        validPdfs: execRes.metrics.validPdfs ?? 0,
        documentUrl: execRes.evidence?.documentUrl ?? null,
        documentSha256: execRes.evidence?.documentSha256 ?? null,
        executionOrigin: execRes.executionOrigin,
      },
    });

    if (execRes.outcome === 'PASS' && (execRes.metrics.validPdfs ?? 0) >= 1) {
      break;
    }
  }

  if (!lastExecResult) {
    stages.OFFICIAL_SOURCE_ACCESS = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_NO_SOURCE_EXECUTED',
      'FAILURE',
      'OFFICIAL_SOURCE_ACCESS',
      { candidateSources }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: null,
      officialDomainVerified: false,
      stages,
      failureClassification: 'REMOTE_WORKER_ERROR',
      failureDetails: 'No official sources were executed during verification',
      evidence: {
        endpointUrl: null,
        listingUrl: null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: null,
        bytesReceived: 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  const endpointUrl =
    lastExecResult.evidence?.endpointUrl ||
    lastExecResult.metrics.attemptedEndpoints?.[0]?.url ||
    probeTargetUrl;
  const officialDomainVerified = isOfficialDomain(endpointUrl, lastSourceId).allowed;

  // Evaluate Stage 4: OFFICIAL_SOURCE_ACCESS
  const listingFetched =
    Boolean(lastExecResult.verificationEvidence?.endpointReached) &&
    Boolean(lastExecResult.verificationEvidence?.listingValidated);

  if (!listingFetched) {
    stages.OFFICIAL_SOURCE_ACCESS = 'FAIL';
    const errType = lastExecResult.lastErrorType || directAcquireRes.errorType;
    const httpStatus =
      lastExecResult.verificationEvidence?.httpStatus ?? directAcquireRes.httpStatus ?? null;

    let failureClassification: RemoteProductionFailureClassification =
      'OFFICIAL_SOURCE_HTTP_ERROR';
    if (errType === 'TIMEOUT') {
      failureClassification = 'OFFICIAL_SOURCE_TIMEOUT';
    } else if (
      errType === 'HTTP_403' ||
      errType === 'SSRF_BLOCKED' ||
      httpStatus === 401 ||
      httpStatus === 403
    ) {
      failureClassification = 'OFFICIAL_SOURCE_ACCESS_BLOCKED';
    } else if (
      errType === 'CONNECTION_RESET' ||
      errType === 'CONNECTION_REFUSED' ||
      errType === 'DNS_ERROR' ||
      errType === 'TLS_ERROR'
    ) {
      failureClassification = 'OFFICIAL_SOURCE_TIMEOUT';
    }

    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_OFFICIAL_SOURCE_FAILED',
      'FAILURE',
      'OFFICIAL_SOURCE_ACCESS',
      {
        sourceId: lastSourceId,
        endpointUrl,
        failureClassification,
        errorType: errType,
        httpStatus,
      }
    );

    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: lastSourceId,
      officialDomainVerified,
      stages,
      failureClassification,
      failureDetails:
        lastExecResult.lastErrorMessage ||
        lastExecResult.failureReasons?.[0] ||
        directAcquireRes.failureDetails ||
        'Remote worker could not reach official source',
      evidence: {
        endpointUrl,
        listingUrl: lastExecResult.evidence?.listingUrl ?? null,
        noticeUrl: null,
        detailUrl: null,
        documentUrl: null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus,
        bytesReceived: lastExecResult.verificationEvidence?.responseBytes ?? 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.OFFICIAL_SOURCE_ACCESS = 'PASS';

  // Evaluate Stage 5: DOCUMENT_ACQUISITION
  const docsDownloaded = lastExecResult.metrics.documentsDownloaded ?? 0;
  if (docsDownloaded < 1) {
    stages.DOCUMENT_ACQUISITION = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_DOCUMENT_ACQUISITION_FAILED',
      'FAILURE',
      'DOCUMENT_ACQUISITION',
      {
        sourceId: lastSourceId,
        endpointUrl,
        noticesDiscovered: lastExecResult.recordsFound,
      }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: lastSourceId,
      officialDomainVerified,
      stages,
      failureClassification: 'DOCUMENT_ACQUISITION_FAILURE',
      failureDetails:
        lastExecResult.lastErrorMessage ||
        lastExecResult.failureReasons?.[0] ||
        'Failed to download official PDF document via remote worker',
      evidence: {
        endpointUrl,
        listingUrl: lastExecResult.evidence?.listingUrl ?? endpointUrl,
        noticeUrl: lastExecResult.evidence?.noticeUrl ?? null,
        detailUrl: lastExecResult.evidence?.detailUrl ?? null,
        documentUrl: lastExecResult.evidence?.documentUrl ?? null,
        documentSha256: null,
        pdfPageCount: null,
        httpStatus: lastExecResult.verificationEvidence?.httpStatus ?? 200,
        bytesReceived: lastExecResult.verificationEvidence?.responseBytes ?? 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.DOCUMENT_ACQUISITION = 'PASS';

  // Evaluate Stage 6: PDF_VALIDATION
  const validPdfs = lastExecResult.metrics.validPdfs ?? 0;
  const pdfSha256 = lastExecResult.evidence?.documentSha256 ?? null;
  const pdfPages = lastExecResult.evidence?.pdfPageCount ?? null;

  if (
    lastExecResult.outcome !== 'PASS' ||
    validPdfs < 1 ||
    !pdfSha256 ||
    !pdfPages ||
    pdfPages < 1
  ) {
    stages.PDF_VALIDATION = 'FAIL';
    const auditPersisted = recordAudit(
      'REMOTE_PRODUCTION_PDF_VALIDATION_FAILED',
      'FAILURE',
      'PDF_VALIDATION',
      {
        sourceId: lastSourceId,
        documentUrl: lastExecResult.evidence?.documentUrl ?? null,
        validPdfs,
      }
    );
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: directAcquireRes.runnerClassification ?? null,
      executionEnvironment: directAcquireRes.executionEnvironment ?? null,
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: lastSourceId,
      officialDomainVerified,
      stages,
      failureClassification: 'PDF_VALIDATION_FAILURE',
      failureDetails:
        lastExecResult.lastErrorMessage ||
        lastExecResult.failureReasons?.[0] ||
        'Acquired document failed central PDF validation pipeline',
      evidence: {
        endpointUrl,
        listingUrl: lastExecResult.evidence?.listingUrl ?? endpointUrl,
        noticeUrl: lastExecResult.evidence?.noticeUrl ?? null,
        detailUrl: lastExecResult.evidence?.detailUrl ?? null,
        documentUrl: lastExecResult.evidence?.documentUrl ?? null,
        documentSha256: pdfSha256,
        pdfPageCount: pdfPages,
        httpStatus: lastExecResult.verificationEvidence?.httpStatus ?? 200,
        bytesReceived: lastExecResult.verificationEvidence?.responseBytes ?? 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  stages.PDF_VALIDATION = 'PASS';

  // Check Section 6 & 8: Distinguish REMOTE_LOCAL_WORKER vs REMOTE_PRODUCTION
  const isProductionRemoteProven =
    !isLoopback &&
    directAcquireRes.actualRunner === 'REMOTE' &&
    directAcquireRes.executionEnvironment === 'PRODUCTION_REMOTE' &&
    lastExecResult.executionOrigin === 'REAL_REMOTE_PRODUCTION';

  const isLocalWorkerProven =
    directAcquireRes.actualRunner === 'REMOTE' &&
    (isLoopback ||
      directAcquireRes.executionEnvironment === 'LOCAL_WORKER' ||
      lastExecResult.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER');

  const auditPersisted = recordAudit(
    isProductionRemoteProven
      ? 'REMOTE_PRODUCTION_VERIFIED_PROVEN'
      : 'REMOTE_LOCAL_WORKER_VERIFIED_NOT_PRODUCTION',
    isProductionRemoteProven ? 'SUCCESS' : 'INFO',
    'PDF_VALIDATION',
    {
      sourceId: lastSourceId,
      workerEndpoint: sanitizedWorkerEndpoint,
      actualRunner: 'REMOTE',
      executionEnvironment: directAcquireRes.executionEnvironment,
      remoteWorkerId: directAcquireRes.remoteWorkerId,
      workerVersion: directAcquireRes.workerVersion,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      documentUrl: lastExecResult.evidence?.documentUrl,
      documentSha256: pdfSha256,
      pdfPageCount: pdfPages,
      REAL_REMOTE_PRODUCTION: isProductionRemoteProven ? 'PROVEN' : 'NOT_PROVEN',
    }
  );

  if (!isProductionRemoteProven) {
    return finalizeReport({
      workerConfigured: true,
      workerEndpoint: sanitizedWorkerEndpoint,
      authConfigured: true,
      isLoopbackWorker: isLoopback,
      actualRunner: 'REMOTE',
      runnerClassification: 'REMOTE_LOCAL_WORKER',
      executionEnvironment: directAcquireRes.executionEnvironment ?? 'LOCAL_WORKER',
      remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
      workerVersion: directAcquireRes.workerVersion ?? null,
      requestId: directAcquireRes.requestId ?? probeRequestId,
      testedSourceId: lastSourceId,
      officialDomainVerified,
      stages,
      failureClassification: 'REMOTE_PROTOCOL_ERROR',
      failureDetails: isLoopback
        ? 'Worker succeeded on loopback (127.0.0.1/localhost), which proves REAL_REMOTE_LOCAL_WORKER but cannot count as REAL_REMOTE_PRODUCTION'
        : `Worker returned executionEnvironment="${String(directAcquireRes.executionEnvironment)}" instead of "PRODUCTION_REMOTE"`,
      evidence: {
        endpointUrl,
        listingUrl: lastExecResult.evidence?.listingUrl ?? endpointUrl,
        noticeUrl: lastExecResult.evidence?.noticeUrl ?? null,
        detailUrl: lastExecResult.evidence?.detailUrl ?? null,
        documentUrl: lastExecResult.evidence?.documentUrl ?? null,
        documentSha256: pdfSha256,
        pdfPageCount: pdfPages,
        httpStatus: lastExecResult.verificationEvidence?.httpStatus ?? 200,
        bytesReceived: lastExecResult.verificationEvidence?.responseBytes ?? 0,
        auditCorrelationId,
        auditPersisted,
      },
      REAL_REMOTE_LOCAL_WORKER: isLocalWorkerProven ? 'PROVEN' : 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
      exitCode: 1,
    });
  }

  logger.info('REMOTE_PRODUCTION_VERIFICATION_PROVEN', {
    workerEndpoint: sanitizedWorkerEndpoint,
    remoteWorkerId: directAcquireRes.remoteWorkerId,
    workerVersion: directAcquireRes.workerVersion,
    testedSourceId: lastSourceId,
    documentUrl: lastExecResult.evidence?.documentUrl,
    documentSha256: pdfSha256,
    pdfPageCount: pdfPages,
  });

  return finalizeReport({
    workerConfigured: true,
    workerEndpoint: sanitizedWorkerEndpoint,
    authConfigured: true,
    isLoopbackWorker: false,
    actualRunner: 'REMOTE',
    runnerClassification: 'REMOTE_PRODUCTION',
    executionEnvironment: 'PRODUCTION_REMOTE',
    remoteWorkerId: directAcquireRes.remoteWorkerId ?? null,
    workerVersion: directAcquireRes.workerVersion ?? null,
    requestId: directAcquireRes.requestId ?? probeRequestId,
    testedSourceId: lastSourceId,
    officialDomainVerified,
    stages,
    failureClassification: 'NONE',
    failureDetails: null,
    evidence: {
      endpointUrl,
      listingUrl: lastExecResult.evidence?.listingUrl ?? endpointUrl,
      noticeUrl: lastExecResult.evidence?.noticeUrl ?? null,
      detailUrl: lastExecResult.evidence?.detailUrl ?? null,
      documentUrl: lastExecResult.evidence?.documentUrl ?? null,
      documentSha256: pdfSha256,
      pdfPageCount: pdfPages,
      httpStatus: lastExecResult.verificationEvidence?.httpStatus ?? 200,
      bytesReceived: lastExecResult.verificationEvidence?.responseBytes ?? 0,
      auditCorrelationId,
      auditPersisted,
    },
    REAL_REMOTE_LOCAL_WORKER: 'PROVEN',
    REAL_REMOTE_PRODUCTION: 'PROVEN',
    exitCode: 0,
  });
}

async function runCli(): Promise<void> {
  initDatabase({ path: ':memory:', forceNew: true });
  try {
    const report = await runRemoteProductionVerification();
    console.log('=== OMNIHUB REMOTE PRODUCTION WORKER VERIFICATION ===');
    console.log(`mode:                      ${report.mode}`);
    console.log(`workerConfigured:          ${report.workerConfigured}`);
    console.log(`workerUrl:                 ${report.workerUrl ?? 'null'}`);
    console.log(`authConfigured:            ${report.authConfigured}`);
    console.log(`actualRunner:              ${report.actualRunner ?? 'null'}`);
    console.log(`runnerClassification:      ${report.runnerClassification ?? 'null'}`);
    console.log(`executionEnvironment:      ${report.executionEnvironment ?? 'null'}`);
    console.log(`workerId:                  ${report.workerId ?? 'null'}`);
    console.log(`workerVersion:             ${report.workerVersion ?? 'null'}`);
    console.log(`requestId:                 ${report.requestId ?? 'null'}`);
    console.log(`sourceId:                  ${report.sourceId ?? 'null'}`);
    console.log(`attempts:                  ${report.attempts}`);
    console.log(`httpStatus:                ${report.httpStatus ?? 'null'}`);
    console.log(`finalUrl:                  ${report.finalUrl ?? 'null'}`);
    console.log(`WORKER_URL_CONFIGURATION:  ${report.stages.WORKER_URL_CONFIGURATION}`);
    console.log(`WORKER_HEALTH:             ${report.stages.WORKER_HEALTH}`);
    console.log(`REMOTE_AUTH:               ${report.stages.REMOTE_AUTH}`);
    console.log(`REMOTE_HTTP_EXECUTION:     ${report.stages.REMOTE_HTTP_EXECUTION}`);
    console.log(`REMOTE_EXECUTION_IDENTITY: ${report.stages.REMOTE_EXECUTION_IDENTITY}`);
    console.log(`OFFICIAL_SOURCE_ACCESS:    ${report.stages.OFFICIAL_SOURCE_ACCESS}`);
    console.log(`DOCUMENT_ACQUISITION:      ${report.stages.DOCUMENT_ACQUISITION}`);
    console.log(`PDF_VALIDATION:            ${report.stages.PDF_VALIDATION}`);
    console.log(`AUDIT_EVIDENCE:            ${report.stages.AUDIT_EVIDENCE}`);
    console.log(`failureClassification:     ${report.failureClassification}`);
    console.log(`failureDetails:            ${report.failureDetails ?? 'NONE'}`);
    console.log(`REAL_REMOTE_LOCAL_WORKER:  ${report.REAL_REMOTE_LOCAL_WORKER}`);
    console.log(`REAL_REMOTE_PRODUCTION:    ${report.REAL_REMOTE_PRODUCTION}`);
    console.log('MACHINE_READABLE_REMOTE_PRODUCTION_JSON:');
    console.log(JSON.stringify(report));
    closeDatabase();
    process.exit(report.exitCode);
  } catch (err) {
    console.error('Unexpected error in verify:remote-production:', err);
    try {
      closeDatabase();
    } catch {
      // ignore
    }
    process.exit(2);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('verify-remote-production.ts') ||
    process.argv[1].endsWith('verify-remote-production.js'));

if (isDirectRun) {
  void runCli();
}
