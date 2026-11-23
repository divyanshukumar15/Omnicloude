/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { sourceEndpointRegistry } from './endpoint-registry.ts';
import { sourceRegistry } from '../adapters/registry.ts';
import { validateTargetUrl } from '../../security/url-security.ts';
import { isOfficialDomain } from './official-domains.ts';
import { getDiscoveryExecutor } from './discovery-executor.ts';
import {
  evaluateLiveVerificationGate,
  type EndpointClassification,
  type LiveVerificationOutcome,
  type StrictVerificationFailureReason,
  type VerificationExecutionMode,
  type VerificationProofStatus,
  type LiveVerificationEvidenceArtifacts,
} from './verification-gate.ts';
import type { DiscoveryOptions } from './types.ts';
import { initDatabase, closeDatabase } from '../../database/index.ts';

export interface EndpointVerificationResult {
  endpointId: string;
  sourceId: string;
  organization: string;
  officialDomain: string;
  officialDomainVerified: boolean;
  endpointClassification: EndpointClassification;
  endpointType: string;
  requestedUrl: string;
  finalUrl: string | null;
  redirectChain: string[];
  httpStatus: number | null;
  contentType: string | null;
  responseContentType: string | null;
  responseSizeBytes: number;
  responseBytes: number;
  responseTimeMs: number;
  latencyMs: number;
  // Required Structured Evidence Fields (Section 4 & 6)
  endpointReached: boolean;
  listingValidated: boolean;
  relevantNoticeFound: boolean;
  detailRequired: boolean;
  detailResolved: boolean | null;
  documentDiscovered: boolean;
  documentDownloaded: boolean;
  pdfValidated: boolean;
  outcome: LiveVerificationOutcome;
  failureReasons: StrictVerificationFailureReason[];
  evidence: LiveVerificationEvidenceArtifacts;
  verificationMode: VerificationExecutionMode;
  verificationStatus: VerificationProofStatus;
  verifiedLive: boolean;
  // Stage 1 & 2 Metrics
  endpointReachable: boolean;
  listingParsed: boolean;
  noticesFound: number;
  detailPagesFound: number;
  documentsFound: number;
  documentsDownloaded: number;
  validPdfs: number;
  recruitmentsFound: number;
  requestAttempts?: number;
  retriesUsed?: number;
  lastErrorType?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  resultState: LiveVerificationOutcome;
  diagnosticReason: string;
  cacheState: 'LIVE' | 'CACHED' | 'STALE';
}

export interface EndpointVerificationReport {
  startedAt: string;
  completedAt: string;
  totalEndpoints: number;
  passedCount: number;
  failedCount: number;
  inconclusiveCount: number;
  results: EndpointVerificationResult[];
}

import { resolveLiveVerificationRuntimeConfig } from './discovery-service.ts';
import { classifyNetworkOrHttpError } from './network-error-classifier.ts';

export async function runEndpointVerification(options: {
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  noCache?: boolean;
  endpointId?: string;
  sourceId?: string;
  endpointFixtures?: DiscoveryOptions['endpointFixtures'];
  detailFixtures?: DiscoveryOptions['detailFixtures'];
  pdfFixtures?: DiscoveryOptions['pdfFixtures'];
} = {}): Promise<EndpointVerificationReport> {
  const startedAt = new Date().toISOString();
  const runtimeConfig = resolveLiveVerificationRuntimeConfig({
    timeoutMs: options.timeoutMs,
    connectionTimeoutMs: options.connectionTimeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs,
  });
  const timeoutMs = runtimeConfig.timeoutMs;
  const connectionTimeoutMs = runtimeConfig.connectionTimeoutMs;
  const maxRetries = runtimeConfig.maxRetries;
  const retryBackoffMs = runtimeConfig.retryBackoffMs;
  let endpoints = sourceEndpointRegistry.getAllEndpoints();
  if (options.sourceId) {
    endpoints = endpoints.filter((ep) => ep.sourceId === options.sourceId);
  }
  if (options.endpointId) {
    endpoints = endpoints.filter((ep) => ep.endpointId === options.endpointId);
  }

  const results: EndpointVerificationResult[] = [];
  const executor = getDiscoveryExecutor();

  let passed = 0;
  let failed = 0;
  let inconclusive = 0;

  for (const ep of endpoints) {
    const startTime = Date.now();
    const adapter = sourceRegistry.get(ep.sourceId);
    const officialDomain = ep.officialDomain || ep.officialDomains[0] || '';

    if (!adapter) {
      results.push({
        endpointId: ep.endpointId,
        sourceId: ep.sourceId,
        organization: ep.organization,
        officialDomain,
        officialDomainVerified: false,
        endpointClassification: 'UNKNOWN',
        endpointType: ep.endpointType,
        requestedUrl: ep.url,
        finalUrl: null,
        redirectChain: [ep.url],
        httpStatus: null,
        contentType: null,
        responseContentType: null,
        responseSizeBytes: 0,
        responseBytes: 0,
        responseTimeMs: 0,
        latencyMs: 0,
        endpointReached: false,
        listingValidated: false,
        relevantNoticeFound: false,
        detailRequired: false,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        outcome: 'FAIL',
        failureReasons: ['HTTP_ERROR'],
        evidence: {},
        verificationMode: 'LIVE',
        verificationStatus: 'FAILED',
        verifiedLive: false,
        endpointReachable: false,
        listingParsed: false,
        noticesFound: 0,
        detailPagesFound: 0,
        documentsFound: 0,
        documentsDownloaded: 0,
        validPdfs: 0,
        recruitmentsFound: 0,
        requestAttempts: 1,
        retriesUsed: 0,
        lastErrorType: 'HTTP_ERROR',
        lastErrorCode: 'UNREGISTERED_SOURCE',
        lastErrorMessage: `No adapter registered for source ID ${ep.sourceId}`,
        resultState: 'FAIL',
        diagnosticReason: `No adapter registered for source ID ${ep.sourceId}`,
        cacheState: 'LIVE',
      });
      failed++;
      continue;
    }

    try {
      // Official domain check (SSRF & DNS resolution are validated inside executor's fetchWithRetry loop)
      const domainCheck = isOfficialDomain(ep.url, ep.sourceId);
      if (!domainCheck.allowed) {
        const latencyMs = Date.now() - startTime;
        results.push({
          endpointId: ep.endpointId,
          sourceId: ep.sourceId,
          organization: ep.organization,
          officialDomain,
          officialDomainVerified: false,
          endpointClassification: 'ACCESS_BLOCKED',
          endpointType: ep.endpointType,
          requestedUrl: ep.url,
          finalUrl: null,
          redirectChain: [ep.url],
          httpStatus: null,
          contentType: null,
          responseContentType: null,
          responseSizeBytes: 0,
          responseBytes: 0,
          responseTimeMs: latencyMs,
          latencyMs,
          endpointReached: false,
          listingValidated: false,
          relevantNoticeFound: false,
          detailRequired: false,
          detailResolved: null,
          documentDiscovered: false,
          documentDownloaded: false,
          pdfValidated: false,
          outcome: 'FAIL',
          failureReasons: ['ACCESS_BLOCKED'],
          evidence: {},
          verificationMode: 'LIVE',
          verificationStatus: 'FAILED',
          verifiedLive: false,
          endpointReachable: false,
          listingParsed: false,
          noticesFound: 0,
          detailPagesFound: 0,
          documentsFound: 0,
          documentsDownloaded: 0,
          validPdfs: 0,
          recruitmentsFound: 0,
          requestAttempts: 1,
          retriesUsed: 0,
          lastErrorType: 'DOMAIN_NOT_ALLOWED',
          lastErrorCode: 'EXTERNAL_REDIRECT_BLOCKED',
          lastErrorMessage: domainCheck.reason,
          resultState: 'FAIL',
          diagnosticReason: `Domain security check failed: ${domainCheck.reason}`,
          cacheState: 'LIVE',
        });
        failed++;
        continue;
      }

      if (options.endpointFixtures) {
        await validateTargetUrl(ep.url);
      }

      // Execute full E2E verification chain for this specific endpoint
      const execution = await executor.execute(ep.sourceId, {
        endpointId: ep.endpointId,
        noCache: options.noCache ?? true,
        strictLiveMode: true,
        downloadAndValidatePdfs: true,
        timeoutMs,
        connectionTimeoutMs,
        maxRetries,
        retryBackoffMs,
        maxNotices: 5,
        endpointFixtures: options.endpointFixtures,
        detailFixtures: options.detailFixtures,
        pdfFixtures: options.pdfFixtures,
      });

      const latencyMs = Date.now() - startTime;
      const endpointReached = (execution.metrics.endpointsReached ?? 0) > 0;
      const listingValidated = (execution.metrics.listingPagesValidated ?? 0) > 0;
      const noticesFound = execution.recordsFound;
      const detailPagesFetched = execution.metrics.detailPagesFetched ?? 0;
      const documentsFound = execution.documentsFound;
      const documentsDownloaded = execution.metrics.documentsDownloaded ?? 0;
      const validPdfs = execution.metrics.validPdfs ?? 0;

      const detailRequired = execution.detailRequired === true;
      const detailResolved: boolean | null = detailRequired
        ? execution.detailResolved === true
        : null;

      const lastErrorType = execution.lastErrorType ?? execution.metrics.lastErrorType ?? null;
      const isTimeout =
        lastErrorType === 'TIMEOUT' || execution.errorCode === 'HTTP_TIMEOUT';

      const gateDecision = evaluateLiveVerificationGate({
        endpointReached,
        endpointValidated: endpointReached,
        officialDomainVerified: domainCheck.allowed,
        listingValidated,
        relevantNoticeFound: noticesFound > 0,
        detailRequired,
        detailResolved,
        documentDiscovered: documentsFound > 0,
        documentDownloaded: documentsDownloaded > 0,
        pdfValidated: validPdfs > 0,
        responseSource: execution.responseSource || 'LIVE_EXECUTION',
        verificationMode: execution.verificationMode || 'LIVE',
        httpStatus: execution.httpStatus,
        finalUrl: execution.finalUrl,
        structureChanged: execution.status === 'ADAPTER_STRUCTURE_CHANGED',
        wrongContent: execution.status === 'ENDPOINT_WRONG_CONTENT',
        parseFailed: execution.status === 'ENDPOINT_PARSE_FAILED',
        accessBlocked: execution.status === 'ACCESS_BLOCKED',
        timeoutOccurred: !endpointReached && isTimeout,
        networkErrorType:
          !endpointReached &&
          !isTimeout &&
          (lastErrorType === 'DNS_ERROR' ||
            lastErrorType === 'TLS_ERROR' ||
            lastErrorType === 'CONNECTION_RESET' ||
            lastErrorType === 'CONNECTION_REFUSED' ||
            lastErrorType === 'NETWORK_UNAVAILABLE' ||
            lastErrorType === 'UNKNOWN_NETWORK_ERROR')
            ? lastErrorType
            : null,
        networkUnreachableInSandbox: false,
        downloadAttempted: (execution.metrics.documentDownloadAttempts ?? 0) > 0,
        downloadFailed: (execution.metrics.downloadFailures ?? 0) > 0 && documentsDownloaded === 0,
        invalidPdf: (execution.metrics.invalidPdfs ?? 0) > 0 && validPdfs === 0,
        invalidMime: execution.failureReasons?.includes('INVALID_MIME'),
        invalidMagicBytes: execution.failureReasons?.includes('INVALID_MAGIC_BYTES'),
        evidence: execution.evidence,
      });

      const outcome = gateDecision.outcome;
      if (outcome === 'PASS') passed++;
      else if (outcome === 'FAIL') failed++;
      else inconclusive++;

      const retriesUsed = execution.metrics.retryCount ?? 0;
      const requestAttempts =
        execution.metrics.requestAttempts ??
        execution.metrics.attempts ??
        Math.max(1, 1 + retriesUsed);
      const attemptLog = execution.metrics.attemptedEndpoints?.[0];
      const responseContentType =
        execution.responseContentType ??
        attemptLog?.responseContentType ??
        (ep.expectedContentType || 'text/html');
      const responseBytes = execution.responseBytes ?? attemptLog?.responseBytes ?? 0;
      const responseTimeMs = execution.responseTimeMs ?? attemptLog?.responseTimeMs ?? latencyMs;
      const redirectChain =
        attemptLog?.redirectChain && attemptLog.redirectChain.length > 0
          ? attemptLog.redirectChain
          : [ep.url, ...(execution.finalUrl && execution.finalUrl !== ep.url ? [execution.finalUrl] : [])];

      results.push({
        endpointId: ep.endpointId,
        sourceId: ep.sourceId,
        organization: ep.organization,
        officialDomain,
        officialDomainVerified: domainCheck.allowed,
        endpointClassification: gateDecision.endpointClassification,
        endpointType: ep.endpointType,
        requestedUrl: ep.url,
        finalUrl: execution.finalUrl,
        redirectChain,
        httpStatus: execution.httpStatus,
        contentType: responseContentType,
        responseContentType,
        responseSizeBytes: responseBytes,
        responseBytes,
        responseTimeMs,
        latencyMs,
        endpointReached: gateDecision.endpointReached,
        listingValidated: gateDecision.listingValidated,
        relevantNoticeFound: gateDecision.relevantNoticeFound,
        detailRequired: gateDecision.detailRequired,
        detailResolved: gateDecision.detailResolved,
        documentDiscovered: gateDecision.documentDiscovered,
        documentDownloaded: gateDecision.documentDownloaded,
        pdfValidated: gateDecision.pdfValidated,
        outcome,
        failureReasons: gateDecision.failureReasons,
        evidence: gateDecision.evidence,
        verificationMode: execution.verificationMode || 'LIVE',
        verificationStatus: gateDecision.verificationStatus,
        verifiedLive: Boolean(execution.verifiedLive),
        endpointReachable: gateDecision.endpointReached,
        listingParsed: gateDecision.listingValidated,
        noticesFound,
        detailPagesFound: detailPagesFetched,
        documentsFound,
        documentsDownloaded,
        validPdfs,
        recruitmentsFound: noticesFound,
        requestAttempts,
        retriesUsed,
        lastErrorType,
        lastErrorCode: execution.lastErrorCode ?? execution.metrics.lastErrorCode ?? null,
        lastErrorMessage: execution.lastErrorMessage ?? execution.metrics.lastErrorMessage ?? null,
        resultState: outcome,
        diagnosticReason: execution.errorMessage || gateDecision.diagnostic,
        cacheState: execution.cacheState || 'LIVE',
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const diag = classifyNetworkOrHttpError(err, {
        requestUrl: ep.url,
        timeoutMs,
        connectionTimeoutMs,
        attempt: 1,
        maxAttempts: maxRetries + 1,
      });
      const isSecurityFailure =
        diag.errorType === 'SSRF_BLOCKED' ||
        diag.errorType === 'DOMAIN_NOT_ALLOWED' ||
        diag.errorType === 'INVALID_URL';

      results.push({
        endpointId: ep.endpointId,
        sourceId: ep.sourceId,
        organization: ep.organization,
        officialDomain,
        officialDomainVerified: !isSecurityFailure,
        endpointClassification: isSecurityFailure ? 'ACCESS_BLOCKED' : 'NETWORK_UNREACHABLE',
        endpointType: ep.endpointType,
        requestedUrl: ep.url,
        finalUrl: null,
        redirectChain: [ep.url],
        httpStatus: diag.httpStatus,
        contentType: null,
        responseContentType: null,
        responseSizeBytes: 0,
        responseBytes: 0,
        responseTimeMs: latencyMs,
        latencyMs,
        endpointReached: false,
        listingValidated: false,
        relevantNoticeFound: false,
        detailRequired: false,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        outcome: 'FAIL',
        failureReasons: isSecurityFailure
          ? ['ACCESS_BLOCKED']
          : ['ENDPOINT_REACH_FAILED', diag.errorType === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_UNAVAILABLE'],
        evidence: {},
        verificationMode: 'LIVE',
        verificationStatus: 'FAILED',
        verifiedLive: false,
        endpointReachable: false,
        listingParsed: false,
        noticesFound: 0,
        detailPagesFound: 0,
        documentsFound: 0,
        documentsDownloaded: 0,
        validPdfs: 0,
        recruitmentsFound: 0,
        requestAttempts: 1,
        retriesUsed: 0,
        lastErrorType: diag.errorType,
        lastErrorCode: diag.errorCode,
        lastErrorMessage: diag.errorMessage,
        resultState: 'FAIL',
        diagnosticReason: `Endpoint verification failed [${diag.errorType}${diag.errorCode ? ` (${diag.errorCode})` : ''}]: ${diag.errorMessage}`,
        cacheState: 'LIVE',
      });
      failed++;
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    totalEndpoints: endpoints.length,
    passedCount: passed,
    failedCount: failed,
    inconclusiveCount: inconclusive,
    results,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const noCache = args.includes('--no-cache');

  console.log('================================================================================');
  console.log('OmniHub GovJobs AI — Official Source Endpoint Verification (v1.3.0)');
  console.log('================================================================================');
  console.log(`Cache Bypass Mode: ${noCache ? 'ENABLED (--no-cache)' : 'STANDARD'}\n`);

  initDatabase({ path: ':memory:', forceNew: true });

  const report = await runEndpointVerification({ noCache });

  console.log('--------------------------------------------------------------------------------');
  console.log('END-TO-END ENDPOINT & DOCUMENT VERIFICATION RESULTS:');
  console.log('--------------------------------------------------------------------------------');

  for (const r of report.results) {
    console.log(`[ENDPOINT: ${r.endpointId}] (${r.organization} - ${r.endpointType})`);
    console.log(`  - REQUESTED URL:       ${r.requestedUrl}`);
    console.log(`  - FINAL URL:           ${r.finalUrl || 'N/A'}`);
    console.log(`  - HTTP STATUS:         ${r.httpStatus ?? 'N/A'}`);
    console.log(`  - LATENCY:             ${r.latencyMs}ms`);
    console.log(`  - ENDPOINT REACHED:    ${r.endpointReached}`);
    console.log(`  - LISTING VALIDATED:   ${r.listingValidated}`);
    console.log(`  - RELEVANT NOTICE:     ${r.relevantNoticeFound} (${r.noticesFound} notices)`);
    console.log(`  - DETAIL RESOLVED:     ${r.detailResolved} (${r.detailPagesFound} pages)`);
    console.log(`  - DOCUMENT DISCOVERED: ${r.documentDiscovered} (${r.documentsFound} docs)`);
    console.log(`  - DOCUMENT DOWNLOADED: ${r.documentDownloaded} (${r.documentsDownloaded} downloaded)`);
    console.log(`  - PDF VALIDATED:       ${r.pdfValidated} (${r.validPdfs} valid PDFs)`);
    console.log(`  - OUTCOME:             ${r.outcome}`);
    console.log(`  - FAILURE REASONS:     ${r.failureReasons.length > 0 ? r.failureReasons.join(', ') : 'NONE'}`);
    console.log(`  - DIAGNOSTIC:          ${r.diagnosticReason}`);
    console.log(`  - CACHE STATE:         ${r.cacheState}`);
    console.log('');
  }

  console.log('--------------------------------------------------------------------------------');
  console.log(
    `Summary: Total Endpoints: ${report.totalEndpoints} | Passed: ${report.passedCount} | Failed: ${report.failedCount} | Inconclusive: ${report.inconclusiveCount}`
  );
  console.log('================================================================================\n');

  closeDatabase();
  process.exit(0);
}

if (process.argv[1]?.includes('endpoint-verifier')) {
  cli().catch((err) => {
    console.error('Endpoint verification failed:', err);
    process.exit(1);
  });
}
