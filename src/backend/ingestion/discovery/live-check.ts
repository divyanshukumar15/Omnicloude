/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runRealLiveVerification,
  resolveLiveVerificationRuntimeConfig,
  computeLiveVerificationExitCode,
  type RealLiveVerificationSummary,
} from './discovery-service.ts';
import {
  buildTruthfulVerificationReport,
  createVerificationExecutionId,
  normalizeTruthfulStatus,
  normalizeVerificationRunner,
  type TruthfulVerificationEntry,
} from './verification-model.ts';
import { initDatabase, closeDatabase } from '../../database/index.ts';

interface ParsedCliOptions {
  verbose: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  invalidReason?: string;
}

const SHORT_SOURCE_LABELS: Record<string, string> = {
  'IN-CENTRAL-SSC': 'SSC',
  'IN-CENTRAL-UPSC': 'UPSC',
  'IN-CENTRAL-RRB': 'RRB',
  'IN-BIHAR-BPSC': 'BPSC',
  'IN-BIHAR-BSSC': 'BSSC',
  'IN-UP-UPPSC': 'UPPSC',
  'IN-UP-UPSSSC': 'UPSSSC',
};

export function parseLiveCheckArgs(argv: string[]): ParsedCliOptions {
  let verbose = false;
  let timeoutMs: number | undefined;
  let maxRetries: number | undefined;
  let retryBackoffMs: number | undefined;

  for (const arg of argv) {
    if (arg === '--e2e' || arg === '--no-cache') {
      continue;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--timeout=')) {
      const val = Number(arg.split('=')[1]);
      if (isNaN(val) || val <= 0) {
        return { verbose, invalidReason: `Invalid --timeout value: ${arg}` };
      }
      timeoutMs = val;
    } else if (arg.startsWith('--retries=')) {
      const val = Number(arg.split('=')[1]);
      if (isNaN(val) || val < 0) {
        return { verbose, invalidReason: `Invalid --retries value: ${arg}` };
      }
      maxRetries = val;
    } else if (arg.startsWith('--backoff=')) {
      const val = Number(arg.split('=')[1]);
      if (isNaN(val) || val <= 0) {
        return { verbose, invalidReason: `Invalid --backoff value: ${arg}` };
      }
      retryBackoffMs = val;
    } else if (arg.startsWith('--mode=')) {
      const modeVal = arg.split('=')[1]?.toUpperCase();
      if (modeVal !== 'LIVE') {
        return {
          verbose,
          invalidReason: `verify:live only permits --mode=LIVE (received ${arg})`,
        };
      }
    } else if (arg.startsWith('-')) {
      return { verbose, invalidReason: `Unknown CLI option: ${arg}` };
    }
  }

  return { verbose, timeoutMs, maxRetries, retryBackoffMs };
}

export function buildMachineReadableLiveReport(summary: RealLiveVerificationSummary) {
  const exitCode = computeLiveVerificationExitCode(summary);
  const executionId = createVerificationExecutionId('live');
  const topRemoteStatus =
    summary.runnerHealth.REMOTE_RUNNER.remoteStatus ??
    (summary.runnerHealth.REMOTE_RUNNER.configured ? 'REMOTE_UNAVAILABLE' : 'REMOTE_NOT_CONFIGURED');

  const deriveExecutionEnvironment = (origin: string | null | undefined, actualRunner: string | null | undefined) => {
    if (origin === 'REAL_REMOTE_PRODUCTION') return 'PRODUCTION_REMOTE' as const;
    if (origin === 'REAL_REMOTE_LOCAL_WORKER') return 'LOCAL_WORKER' as const;
    if (actualRunner === 'REMOTE') return 'LOCAL_WORKER' as const;
    return 'LOCAL' as const;
  };

  const truthfulEntries: TruthfulVerificationEntry[] = summary.results.map((r) => {
    const entryExecEnv = deriveExecutionEnvironment(r.executionOrigin, r.actualRunner);
    return {
      source: SHORT_SOURCE_LABELS[r.sourceId] || r.sourceId,
      sourceId: r.sourceId,
      adapter: r.adapterSelected || r.sourceId,
      runner: normalizeVerificationRunner({
        executionOrigin: r.executionOrigin,
        actualRunner: r.actualRunner,
        isMock: r.executionOrigin === 'MOCK_REMOTE' || r.executionOrigin === 'FIXTURE',
      }),
      runnerMode: r.runnerMode,
      actualRunner: r.actualRunner,
      executionOrigin: r.executionOrigin,
      executionEnvironment: entryExecEnv,
      remoteStatus: r.remoteStatus ?? topRemoteStatus,
      workerIdentity: {
        workerId: null,
        workerVersion: null,
        executionEnvironment: entryExecEnv,
      },
      checkType: 'LIVE_DISCOVERY',
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      executionId,
      status: normalizeTruthfulStatus(r.outcome),
      errorCategory:
        r.outcome === 'PASS'
          ? null
          : r.failureClass || r.errorType || r.failureClassification || 'UNKNOWN_FAILURE',
      httpStatus: r.httpStatus ?? null,
      finalUrl: r.endpointUrl || r.primaryEndpoint || null,
      evidence: {
        officialDomainVerified: r.officialDomainVerified,
        endpointReached: r.endpointReached,
        listingValidated: r.listingValidated,
        relevantNoticeFound: r.relevantNoticeFound,
        documentDownloaded: r.documentDownloaded,
        pdfValidated: r.pdfValidated,
        validPdfs: r.validPdfs,
        documentUrl: r.documentUrl,
        sha256: r.sha256,
        pageCount: r.pageCount,
        executionOrigin: r.executionOrigin,
        actualRunner: r.actualRunner,
        runnerMode: r.runnerMode,
        executionEnvironment: entryExecEnv,
        remoteStatus: r.remoteStatus ?? topRemoteStatus,
      },
    };
  });

  const primaryActualRunner =
    summary.results.some((r) => r.actualRunner === 'REMOTE') ? 'REMOTE' : 'LOCAL';
  const primaryExecutionOrigin =
    summary.realRemoteProductionPassCount > 0
      ? 'REAL_REMOTE_PRODUCTION'
      : summary.realRemoteLocalWorkerPassCount > 0
        ? 'REAL_REMOTE_LOCAL_WORKER'
        : 'REAL_LIVE_LOCAL';
  const primaryExecutionEnvironment = deriveExecutionEnvironment(
    primaryExecutionOrigin,
    primaryActualRunner
  );

  const truthfulVerification = buildTruthfulVerificationReport({
    executionId,
    mode: 'LIVE',
    runnerMode: summary.runnerMode,
    actualRunner: primaryActualRunner,
    executionOrigin: primaryExecutionOrigin,
    executionEnvironment: primaryExecutionEnvironment,
    remoteStatus: topRemoteStatus,
    workerIdentity: {
      workerId: null,
      workerVersion: null,
      executionEnvironment: primaryExecutionEnvironment,
    },
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    realRemoteProduction: summary.REAL_REMOTE_PRODUCTION,
    entries: truthfulEntries,
  });

  return {
    executionId,
    artifactType: 'CURRENT_RUN' as const,
    isCurrentRun: true,
    executionStatus: 'LIVE_EXECUTION_PERFORMED',
    mode: 'LIVE',
    runnerMode: summary.runnerMode,
    actualRunner: primaryActualRunner,
    executionOrigin: primaryExecutionOrigin,
    executionEnvironment: primaryExecutionEnvironment,
    remoteStatus: topRemoteStatus,
    workerIdentity: {
      workerId: null,
      workerVersion: null,
      executionEnvironment: primaryExecutionEnvironment,
    },
    runnerHealth: summary.runnerHealth,
    cache: 'DISABLED',
    fixtures: 'DISABLED',
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    truthfulVerification,
    runtimeConfig: {
      timeoutMs: summary.runtimeConfig.timeoutMs,
      connectionTimeoutMs: summary.runtimeConfig.connectionTimeoutMs,
      maxRetries: summary.runtimeConfig.maxRetries,
      retryBackoffMs: summary.runtimeConfig.retryBackoffMs,
      verbose: summary.runtimeConfig.verbose,
      validationWarnings: summary.runtimeConfig.validationWarnings,
    },
    sourcesChecked: summary.sourcesChecked,
    totalSources: summary.totalSources,
    liveExecuted: summary.liveExecutionCount,
    passCount: summary.passCount,
    inconclusiveCount: summary.inconclusiveCount,
    failCount: summary.failCount,
    notRunCount: summary.notRunCount,
    realLiveLocalPassCount: summary.realLiveLocalPassCount,
    realLiveRemotePassCount: summary.realLiveRemotePassCount,
    realRemoteLocalWorkerPassCount: summary.realRemoteLocalWorkerPassCount,
    realRemoteProductionPassCount: summary.realRemoteProductionPassCount,
    realLivePassCount: summary.realLivePassCount,
    realLiveFailCount: summary.realLiveFailCount,
    realLiveInconclusiveCount: summary.realLiveInconclusiveCount,
    realPdfProofCount: summary.realPdfProofCount,
    mockRemotePassCount: summary.mockRemotePassCount,
    REAL_LIVE_LOCAL_PASS: summary.realLiveLocalPassCount,
    REAL_LIVE_REMOTE_PASS: summary.realLiveRemotePassCount,
    REAL_REMOTE_LOCAL_WORKER: summary.REAL_REMOTE_LOCAL_WORKER,
    REAL_REMOTE_PRODUCTION: truthfulVerification.REAL_REMOTE_PRODUCTION,
    REAL_LIVE_PASS: summary.realLivePassCount,
    REAL_LIVE_FAIL: summary.realLiveFailCount,
    REAL_LIVE_INCONCLUSIVE: summary.realLiveInconclusiveCount,
    REAL_PDF_PROOF_COUNT: summary.realPdfProofCount,
    REAL_VALID_PDF_COUNT: summary.realPdfProofCount,
    MOCK_REMOTE_PASS: summary.mockRemotePassCount,
    proofCounts: summary.proofCounts,
    proofCategoryBreakdown: {
      REAL_LIVE_LOCAL: summary.results.filter((r) => r.executionOrigin === 'REAL_LIVE_LOCAL').length,
      REAL_LIVE_REMOTE: summary.results.filter(
        (r) =>
          r.executionOrigin === 'REAL_LIVE_REMOTE' ||
          r.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
          r.executionOrigin === 'REAL_REMOTE_PRODUCTION'
      ).length,
      REAL_REMOTE_LOCAL_WORKER: summary.results.filter(
        (r) => r.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER'
      ).length,
      REAL_REMOTE_PRODUCTION: summary.results.filter(
        (r) => r.executionOrigin === 'REAL_REMOTE_PRODUCTION'
      ).length,
      REAL_LIVE: summary.liveExecutionCount,
      MOCK: summary.mockRemoteExecutionCount,
      FIXTURE: summary.fixtureExecutionCount,
      CACHE: summary.cachedExecutionCount,
      NOT_EXECUTED: summary.notRunCount,
    },
    relevantNoticeCount: summary.relevantNoticeCount,
    documentDownloadCount: summary.documentDownloadCount,
    validPdfCount: summary.validPdfCount,
    totalDurationMs: summary.totalDurationMs,
    successfulWithNotices: summary.successfulWithNotices,
    successfulEmpty: summary.successfulEmpty,
    technicalFailures: summary.technicalFailures,
    exitCode,
    sources: summary.results.map((r) => ({
      source: SHORT_SOURCE_LABELS[r.sourceId] || r.sourceId,
      sourceId: r.sourceId,
      shortName: SHORT_SOURCE_LABELS[r.sourceId] || r.sourceId,
      region: r.region,
      mode: r.mode,
      proofType: r.proofType,
      runnerMode: r.runnerMode,
      selectedRunner: r.selectedRunner,
      actualRunner: r.actualRunner,
      runner: r.runner,
      remoteStatus: r.remoteStatus,
      status: r.outcome,
      failureClass: r.failureClass,
      localAccess: r.localAccess,
      remoteAccess: r.remoteAccess,
      selectionReason: r.selectionReason,
      executionOrigin: r.executionOrigin,
      runtimeCapabilities: r.runtimeCapabilities,
      runtimeAccessibility: r.runtimeAccessibility,
      officialEndpointStatus: r.officialEndpointStatus,
      runtimeAccessStatus: r.runtimeAccessStatus,
      endpoint: r.endpointUrl,
      primaryEndpoint: r.primaryEndpoint,
      endpointUrl: r.endpointUrl,
      officialDomain: r.officialDomain,
      officialDomainVerified: r.officialDomainVerified,
      endpointClassification: r.endpointClassification,
      failureClassification: r.failureClassification,
      dnsStatus: r.dnsStatus,
      resolvedIps: r.resolvedIps,
      tcpStatus: r.tcpStatus,
      tlsStatus: r.tlsStatus,
      connectionStatus: r.connectionStatus,
      classificationEvidence: r.classificationEvidence,
      httpStatus: r.httpStatus,
      responseContentType: r.responseContentType,
      responseBytes: r.responseBytes,
      responseTimeMs: r.responseTimeMs,
      redirectChain: r.redirectChain,
      endpointReached: r.endpointReached,
      listingFetched: r.listingFetched,
      listingParsed: r.listingParsed,
      listingValidated: r.listingValidated,
      relevantNoticeFound: r.relevantNoticeFound,
      relevantNotices: r.relevantNotices,
      detailRequired: r.detailRequired,
      detailResolved: r.detailResolved,
      documentDiscovered: r.documentDiscovered,
      documentsDiscovered: r.documentsDiscovered,
      documentCount: r.documentCount,
      documentDownloaded: r.documentDownloaded,
      documentsDownloaded: r.documentsDownloaded,
      pdfValidated: r.pdfValidated,
      validPdfs: r.validPdfs,
      validPdfCount: r.validPdfsCount,
      evidenceValidated: r.evidenceValidated,
      evidence: r.evidence,
      timeoutMs: r.timeoutMs,
      requestTimeoutMs: r.requestTimeoutMs,
      connectionTimeoutMs: r.connectionTimeoutMs,
      maxRetries: r.maxRetries,
      attempts: r.attempts,
      requestAttempts: r.requestAttempts,
      retriesUsed: r.retriesUsed,
      retryReasons: r.retryReasons,
      retryDiagnostics: r.retryDiagnostics,
      attemptDiagnostics: r.attemptDiagnostics,
      technicalFailure: r.technicalFailure,
      errorType: r.errorType,
      errorCode: r.errorCode,
      lastErrorType: r.lastErrorType,
      lastErrorCode: r.lastErrorCode,
      lastErrorName: r.lastErrorName,
      lastErrorMessage: r.lastErrorMessage,
      lastErrorCause: r.lastErrorCause,
      lastErrorRetryable: r.lastErrorRetryable,
      finalFailureStage: r.finalFailureStage,
      failedStage: r.failedStage,
      outcome: r.outcome,
      finalStatus: r.finalStatus,
      failureReason: r.failureReason,
      failureDetails: r.failureDetails,
      failureReasons: r.failureReasons,
      regionalProbes: r.regionalProbes,
      durationMs: r.durationMs,
      noticeUrl: r.noticeUrl,
      detailUrl: r.detailUrl,
      documentUrl: r.documentUrl,
      sha256: r.sha256,
      pageCount: r.pageCount,
      diagnostic: r.diagnostic,
    })),
  };
}

export function writeLiveVerificationReportArtifact(
  summary: RealLiveVerificationSummary,
  artifactPath = path.resolve(process.cwd(), 'artifacts', 'live-verification-report.json')
): string {
  const reportPayload = buildMachineReadableLiveReport(summary);
  const dir = path.dirname(artifactPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(reportPayload, null, 2) + '\n', 'utf8');
  return artifactPath;
}

async function runLiveCheck() {
  const cliOpts = parseLiveCheckArgs(process.argv.slice(2));
  if (cliOpts.invalidReason) {
    console.error(`Configuration error: ${cliOpts.invalidReason}`);
    process.exit(2);
  }

  const runtimeConfig = resolveLiveVerificationRuntimeConfig({
    timeoutMs: cliOpts.timeoutMs,
    maxRetries: cliOpts.maxRetries,
    retryBackoffMs: cliOpts.retryBackoffMs,
    verbose: cliOpts.verbose,
  });

  // Section 2: Print sanitized runtime configuration summary at the beginning of LIVE verification
  console.log('LIVE CONFIG');
  console.log('mode: LIVE');
  console.log('cache: DISABLED');
  console.log('fixtures: DISABLED');
  console.log(`timeoutMs: ${runtimeConfig.timeoutMs}`);
  console.log(`connectionTimeoutMs: ${runtimeConfig.connectionTimeoutMs}`);
  console.log(`maxRetries: ${runtimeConfig.maxRetries}`);
  if (runtimeConfig.validationWarnings.length > 0) {
    for (const warning of runtimeConfig.validationWarnings) {
      console.log(`configWarning: ${warning}`);
    }
  }
  console.log('');

  initDatabase({ path: ':memory:', forceNew: true });

  const summary = await runRealLiveVerification({
    verificationMode: 'LIVE',
    timeoutMs: runtimeConfig.timeoutMs,
    connectionTimeoutMs: runtimeConfig.connectionTimeoutMs,
    maxRetries: runtimeConfig.maxRetries,
    retryBackoffMs: runtimeConfig.retryBackoffMs,
    verbose: runtimeConfig.verbose,
    noCache: true,
  });

  const artifactPath = writeLiveVerificationReportArtifact(summary);
  const exitCode = computeLiveVerificationExitCode(summary);

  console.log('\n=== OMNIHUB LIVE VERIFICATION ===');
  console.log('Mode: LIVE');
  console.log('Cache: DISABLED');
  console.log('Fixtures: DISABLED');
  console.log(`Sources: ${summary.sourcesChecked}`);
  console.log(
    `Runtime Config: timeoutMs=${runtimeConfig.timeoutMs}, connectionTimeoutMs=${runtimeConfig.connectionTimeoutMs}, maxRetries=${runtimeConfig.maxRetries}, retryBackoffMs=${runtimeConfig.retryBackoffMs}, verbose=${runtimeConfig.verbose}`
  );
  console.log('');

  for (const r of summary.results) {
    const shortName = SHORT_SOURCE_LABELS[r.sourceId] || r.sourceId;
    console.log(`${shortName} -> ${r.outcome}`);
  }

  console.log('');
  console.log(`PASS: ${summary.passCount}`);
  console.log(`INCONCLUSIVE: ${summary.inconclusiveCount}`);
  console.log(`FAIL: ${summary.failCount}`);
  console.log(`Valid PDFs: ${summary.validPdfCount}`);
  console.log('');

  const nonPassResults = summary.results.filter((r) => r.outcome !== 'PASS');
  if (nonPassResults.length > 0) {
    console.log('--------------------------------------------------------------------------------');
    console.log('NON-PASS SOURCE STAGE DIAGNOSTICS:');
    console.log('--------------------------------------------------------------------------------');
    for (const r of nonPassResults) {
      const shortName = SHORT_SOURCE_LABELS[r.sourceId] || r.sourceId;
      console.log(
        `${shortName} (${r.sourceId}) | outcome: ${r.outcome} | endpointClassification: ${r.endpointClassification} | technicalFailure: ${r.technicalFailure} | failedStage: ${r.failedStage} | requestAttempts: ${r.requestAttempts} | retriesUsed: ${r.retriesUsed} | errorType: ${r.errorType ?? 'NONE'} | errorCode: ${r.errorCode ?? 'NONE'} | lastErrorMessage: ${r.lastErrorMessage ?? r.diagnostic}`
      );
      const attemptLogs =
        r.attemptDiagnostics && r.attemptDiagnostics.length > 0
          ? r.attemptDiagnostics
          : r.retryDiagnostics;
      for (const diag of attemptLogs) {
        const typeLabel = diag.errorType || diag.reason;
        const codeLabel = diag.errorCode ? ` (${diag.errorCode})` : diag.statusCode ? ` (${diag.statusCode})` : '';
        const actionLabel =
          diag.delayMs > 0 ? `Retrying after ${diag.delayMs}ms` : 'Final failure';
        console.log(
          `  ${shortName} Attempt ${diag.attempt}/${diag.maxAttempts} ${typeLabel}${codeLabel} ${actionLabel}`
        );
      }
    }
    console.log('');
  }

  console.log('--------------------------------------------------------------------------------');
  console.log('SOURCE-BY-SOURCE LIVE E2E VERIFICATION REPORT:');
  console.log('--------------------------------------------------------------------------------');

  for (const r of summary.results) {
    console.log(`${r.sourceId} (${r.authorityName})`);
    console.log(`  sourceId:               ${r.sourceId}`);
    console.log(`  region:                 ${r.region}`);
    console.log(`  mode:                   ${r.mode}`);
    console.log(`  primaryEndpoint:        ${r.primaryEndpoint}`);
    console.log(`  endpointUrl:            ${r.endpointUrl}`);
    console.log(`  officialDomain:         ${r.officialDomain}`);
    console.log(`  officialDomainVerified: ${r.officialDomainVerified}`);
    console.log(`  endpointClassification: ${r.endpointClassification}`);
    console.log(`  failureClassification:  ${r.failureClassification}`);
    console.log(`  dnsStatus:              ${r.dnsStatus}${r.resolvedIps.length > 0 ? ` (${r.resolvedIps.join(', ')})` : ''}`);
    console.log(`  tcpStatus:              ${r.tcpStatus}`);
    console.log(`  tlsStatus:              ${r.tlsStatus}`);
    console.log(`  connectionStatus:       ${r.connectionStatus}`);
    console.log(`  httpStatus:             ${r.httpStatus ?? 'null'}`);
    console.log(`  responseContentType:    ${r.responseContentType ?? 'null'}`);
    console.log(`  responseBytes:          ${r.responseBytes}`);
    console.log(`  responseTimeMs:         ${r.responseTimeMs}`);
    console.log(`  redirectChain:          ${r.redirectChain.join(' -> ')}`);
    console.log(`  endpointReached:        ${r.endpointReached}`);
    console.log(`  listingFetched:         ${r.listingFetched}`);
    console.log(`  listingParsed:          ${r.listingParsed}`);
    console.log(`  listingValidated:       ${r.listingValidated}`);
    console.log(`  relevantNoticeFound:    ${r.relevantNoticeFound}`);
    console.log(`  detailRequired:         ${r.detailRequired}`);
    console.log(`  detailResolved:         ${r.detailResolved}`);
    console.log(`  documentDiscovered:     ${r.documentDiscovered}`);
    console.log(`  documentDownloaded:     ${r.documentDownloaded}`);
    console.log(`  pdfValidated:           ${r.pdfValidated}`);
    console.log(`  evidenceValidated:      ${r.evidenceValidated}`);
    console.log(`  timeoutMs:              ${r.timeoutMs}`);
    console.log(`  connectionTimeoutMs:    ${r.connectionTimeoutMs}`);
    console.log(`  maxRetries:             ${r.maxRetries}`);
    console.log(`  requestAttempts:        ${r.requestAttempts}`);
    console.log(`  attempts:               ${r.attempts}`);
    console.log(`  retriesUsed:            ${r.retriesUsed}`);
    console.log(
      `  retryReasons:           ${r.retryReasons.length > 0 ? r.retryReasons.join(', ') : 'NONE'}`
    );
    console.log(`  technicalFailure:       ${r.technicalFailure}`);
    console.log(`  errorType:              ${r.errorType ?? 'null'}`);
    console.log(`  errorCode:              ${r.errorCode ?? 'null'}`);
    console.log(`  lastErrorType:          ${r.lastErrorType ?? 'null'}`);
    console.log(`  lastErrorCode:          ${r.lastErrorCode ?? 'null'}`);
    console.log(`  lastErrorMessage:       ${r.lastErrorMessage ?? 'null'}`);
    console.log(`  finalFailureStage:      ${r.finalFailureStage}`);
    console.log(`  failedStage:            ${r.failedStage}`);
    console.log(`  outcome:                ${r.outcome}`);
    console.log(
      `  failureReasons:         ${r.failureReasons.length > 0 ? r.failureReasons.join(', ') : 'NONE'}`
    );
    console.log(`  durationMs:             ${r.durationMs}`);
    console.log(`  noticeUrl:              ${r.noticeUrl ?? 'null'}`);
    console.log(`  detailUrl:              ${r.detailUrl ?? 'null'}`);
    console.log(`  documentUrl:            ${r.documentUrl ?? 'null'}`);
    console.log(`  sha256:                 ${r.sha256 ?? 'null'}`);
    console.log(`  pageCount:              ${r.pageCount ?? 'null'}`);

    if (r.regionalProbes && r.regionalProbes.length > 0) {
      console.log(`  regionalProbes (${r.regionalProbes.length} official RRB boards):`);
      for (const rp of r.regionalProbes) {
        console.log(
          `    - [${rp.boardId}] ${rp.region} | ${rp.endpoint} | DNS: ${rp.dnsResult} | TCP: ${rp.tcpStatus} | TLS: ${rp.tlsStatus} | HTTP: ${rp.httpStatus ?? 'null'} | Class: ${rp.regionalStatus} | PDF: ${rp.pdfResult} | Status: ${rp.finalStatus}`
        );
      }
    }

    if (runtimeConfig.verbose) {
      console.log(`  [verbose] requestUrl:          ${r.requestUrl}`);
      console.log(`  [verbose] httpStatus:          ${r.httpStatus ?? 'N/A'}`);
      console.log(`  [verbose] redirectChain:       ${r.redirectChain.join(' -> ')}`);
      console.log(`  [verbose] adapterSelected:     ${r.adapterSelected}`);
      console.log(`  [verbose] noticeCount:         ${r.noticeCount}`);
      console.log(`  [verbose] documentCount:       ${r.documentCount}`);
      console.log(`  [verbose] downloadStatus:      ${r.downloadStatus}`);
      console.log(`  [verbose] pdfValidationStatus: ${r.pdfValidationStatus}`);
    }

    console.log(`  diagnostic:             ${r.diagnostic}`);
    console.log('');
  }

  console.log('--------------------------------------------------------------------------------');
  console.log('FINAL AGGREGATE LIVE VERIFICATION SUMMARY:');
  console.log('--------------------------------------------------------------------------------');
  console.log(`  TOTAL SOURCES:         ${summary.totalSources}`);
  console.log(`  REAL_LIVE_PASS:        ${summary.realLivePassCount}`);
  console.log(`  REAL_LIVE_FAIL:        ${summary.realLiveFailCount}`);
  console.log(`  REAL_LIVE_INCONCLUSIVE:${summary.realLiveInconclusiveCount}`);
  console.log(`  REAL_PDF_PROOF_COUNT:  ${summary.realPdfProofCount}`);
  console.log(`  REAL_VALID_PDF_COUNT:  ${summary.realPdfProofCount}`);
  console.log(`  LIVE EXECUTED:         ${summary.liveExecutionCount}`);
  console.log(`  FIXTURE EXECUTED:      ${summary.fixtureExecutionCount}`);
  console.log(`  CACHE EXECUTED:        ${summary.cachedExecutionCount}`);
  console.log(`  NOT EXECUTED:          ${summary.notRunCount}`);
  console.log(`  PASS:                  ${summary.passCount}`);
  console.log(`  INCONCLUSIVE:          ${summary.inconclusiveCount}`);
  console.log(`  FAIL:                  ${summary.failCount}`);
  console.log(`  sourcesChecked:        ${summary.sourcesChecked}`);
  console.log(`  relevantNoticeCount:   ${summary.relevantNoticeCount}`);
  console.log(`  documentDownloadCount: ${summary.documentDownloadCount}`);
  console.log(`  validPdfCount:         ${summary.validPdfCount}`);
  console.log(`  totalDurationMs:       ${summary.totalDurationMs}`);
  console.log(`  successfulWithNotices: ${summary.successfulWithNotices}`);
  console.log(`  successfulEmpty:       ${summary.successfulEmpty}`);
  console.log(`  technicalFailures:     ${summary.technicalFailures}`);
  console.log(`  exitCode:              ${exitCode}`);
  console.log(`  reportArtifact:        ${artifactPath}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('MACHINE_READABLE_SUMMARY_JSON:');
  console.log(JSON.stringify(buildMachineReadableLiveReport(summary)));
  console.log('================================================================================\n');

  closeDatabase();
  process.exit(exitCode);
}

// Only execute CLI main when run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('live-check.ts') || process.argv[1].endsWith('live-check.js'));

if (isDirectRun) {
  runLiveCheck().catch((err) => {
    console.error('Live verification harness unexpected execution error:', err);
    try {
      closeDatabase();
    } catch {
      // ignore close error
    }
    process.exit(3);
  });
}
