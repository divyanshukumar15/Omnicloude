/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { sourceRegistry } from '../adapters/registry.ts';
import { sourceEndpointRegistry, type SourceEndpointConfig } from './endpoint-registry.ts';
import { validateTargetUrl } from '../../security/url-security.ts';
import { isOfficialDomain } from './official-domains.ts';
import { classifyNoticeExplainable } from './classifier.ts';
import { generateRecruitmentIdentity } from './recruitment-identity.ts';
import { DiscoveryCache } from './discovery-cache.ts';
import { DocumentDownloader } from '../downloader/document-downloader.ts';
import { PdfValidator } from '../pdf/pdf-validator.ts';
import {
  evaluateLiveVerificationGate,
  classifyEndpointConnectivity,
  type EndpointClassification,
  type LiveVerificationGateInput,
  type LiveVerificationGateDecision,
  type LiveVerificationOutcome,
  type StrictVerificationFailureReason,
  type VerificationExecutionMode,
  type VerificationProofStatus,
  type LiveVerificationEvidenceArtifacts,
} from './verification-gate.ts';
import type {
  DiscoveryExecutionResult,
  DiscoveryOptions,
  NormalizedNotice,
  DiscoveryExecutionMetrics,
  DiscoveryEvidence,
  EndpointOutcome,
  MachineFailureReason,
  AttemptedEndpointLog,
  StructuredLiveVerificationEvidence,
  NetworkErrorClassification,
  StructuredFetchDiagnostic,
} from './types.ts';
import { classifyNetworkOrHttpError } from './network-error-classifier.ts';
import { resolveConnectionTimeoutMs } from './http-dispatcher.ts';
import {
  type OfficialAcquisitionRunner,
  type RunnerMode,
  type RunnerKind,
  type AcquisitionExecutionOrigin,
  type RemoteExecutionState,
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
} from './acquisition-runner.ts';
import type { AdapterExecutionStatus } from '../../database/types.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';

export {
  evaluateLiveVerificationGate,
  classifyEndpointConnectivity,
  type EndpointClassification,
  type LiveVerificationGateInput,
  type LiveVerificationGateDecision,
  type LiveVerificationOutcome,
  type StrictVerificationFailureReason,
  type VerificationExecutionMode,
  type VerificationProofStatus,
  type LiveVerificationEvidenceArtifacts,
};

const ERROR_PAGE_PATTERNS = [
  /filenotfound/i,
  /the\s+resource\s+you\s+are\s+looking\s+for\s+has\s+been\s+removed/i,
];

function isErrorOrWrongContentPage(html: string, finalUrl: string | null): boolean {
  if (!html || html.trim().length < 20) {
    return true;
  }
  if (finalUrl && /filenotfound|error\.aspx|404\.htm/i.test(finalUrl)) {
    return true;
  }
  const stripped = html.replace(/<[^>]+>/g, ' ').trim();
  if (stripped.length < 5) {
    return true;
  }
  for (const pat of ERROR_PAGE_PATTERNS) {
    if (pat.test(html) && !/<table|<tr|<ul|<li|notification|advertisement|recruitment|विज्ञापन/i.test(html)) {
      return true;
    }
  }
  return false;
}

export class DiscoveryExecutor {
  private downloader: DocumentDownloader;
  private pdfValidator: PdfValidator;

  constructor(downloader?: DocumentDownloader, pdfValidator?: PdfValidator) {
    this.downloader = downloader || new DocumentDownloader();
    this.pdfValidator = pdfValidator || new PdfValidator();
  }

  /**
   * Single unified production discovery executor.
   * Loads authoritative endpoints from SourceEndpointRegistry and executes real discovery pipeline
   * with evidence-based fallback, strict stage metrics, and machine-readable failure reasons.
   */
  async execute(
    sourceId: string,
    options: DiscoveryOptions = {}
  ): Promise<DiscoveryExecutionResult> {
    const adapter = sourceRegistry.get(sourceId);
    if (!adapter) {
      throw new IngestionError(
        `Unregistered source adapter: ${sourceId}`,
        'SOURCE_UNAVAILABLE'
      );
    }

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // 1. Authoritative Endpoint Selection from SourceEndpointRegistry
    let endpoints = sourceEndpointRegistry.getEndpointsForSource(sourceId);
    if (options.endpointId) {
      endpoints = endpoints.filter((ep) => ep.endpointId === options.endpointId);
    }

    // Fallback virtual endpoint if registry is empty
    if (endpoints.length === 0) {
      endpoints = [
        {
          endpointId: `${sourceId.toLowerCase()}-primary-fallback`,
          sourceId,
          organization: adapter.name,
          officialDomains: adapter.officialDomains,
          endpointType: 'PRIMARY_LISTING',
          url: adapter.baseUrl,
          httpMethod: 'GET',
          paginationMethod: 'QUERY_PARAM',
          paginationParam: 'page',
          nextPageDetectionMethod: 'default',
          expectedContentType: 'text/html',
          detailPageStrategy: 'follow_html_detail',
          documentLinkStrategy: 'extract_pdf',
          endpointPriority: 1,
          enabled: true,
          lastVerifiedAt: null,
          adapterVersion: adapter.adapterVersion,
          endpointVerificationStatus: 'UNVERIFIED',
        },
      ];
    }

    // Sort endpoints by registry priority (1 = highest)
    endpoints.sort((a, b) => a.endpointPriority - b.endpointPriority);

    // 2. Cache Inspection (Production cache vs --no-cache live mode)
    const discoveryCache = DiscoveryCache.getInstance();
    const primaryEndpoint = endpoints[0];
    const cacheKey = discoveryCache.generateKey(
      sourceId,
      primaryEndpoint.url,
      adapter.adapterVersion,
      options
    );

    const hasFixtures =
      options.fixtureHtml !== undefined ||
      options.pageFixtures !== undefined ||
      options.endpointFixtures !== undefined ||
      options.detailFixtures !== undefined ||
      options.pdfFixtures !== undefined;

    const explicitMode = options.verificationMode;
    const verificationMode: VerificationExecutionMode =
      explicitMode === 'CACHE'
        ? 'CACHE'
        : explicitMode === 'LIVE'
        ? 'LIVE'
        : hasFixtures || explicitMode === 'FIXTURE'
        ? 'FIXTURE'
        : 'LIVE';

    const allowFixtures = verificationMode === 'FIXTURE';
    const fixtureSource = allowFixtures && hasFixtures;

    if (
      verificationMode === 'CACHE' ||
      (!options.noCache && !options.strictLiveMode && !hasFixtures && explicitMode !== 'LIVE')
    ) {
      const cached = discoveryCache.get(cacheKey);
      if (cached) {
        logger.debug('Reusing cached discovery execution result from registry-driven executor', {
          sourceId,
          endpointId: primaryEndpoint.endpointId,
        });
        const cachedDetailRequired = cached.detailRequired === true;
        const cachedDetailResolved: boolean | null = cachedDetailRequired
          ? cached.detailResolved === true
          : null;
        const cachedGate = evaluateLiveVerificationGate({
          endpointReached: (cached.metrics.endpointsReached ?? cached.metrics.pagesSucceeded) > 0,
          endpointValidated: (cached.metrics.endpointsReached ?? cached.metrics.pagesSucceeded) > 0,
          listingValidated: (cached.metrics.listingPagesValidated ?? cached.metrics.pagesSucceeded) > 0,
          relevantNoticeFound: cached.recordsFound > 0,
          detailRequired: cachedDetailRequired,
          detailResolved: cachedDetailResolved,
          documentDiscovered: cached.documentsFound > 0,
          documentDownloaded: (cached.metrics.documentsDownloaded ?? 0) > 0,
          pdfValidated: (cached.metrics.validPdfs ?? 0) > 0,
          responseSource: 'CACHED_RESULT',
          verificationMode: 'CACHE',
          httpStatus: cached.httpStatus,
          evidence: cached.evidence,
        });
        return {
          ...cached,
          cached: true,
          cacheState: 'CACHED',
          responseSource: 'CACHED_RESULT',
          verificationMode: 'CACHE',
          verificationStatus: cachedGate.verificationStatus,
          verifiedLive: false,
          fixtureSource: false,
          runnerMode: resolveRunnerMode(options.runnerMode),
          selectedRunner: 'LOCAL',
          localAccess: 'CACHED',
          remoteAccess: 'NOT_ATTEMPTED',
          selectionReason: 'Reused cached discovery execution result',
          executionOrigin: 'CACHE',
          detailRequired: cachedDetailRequired,
          detailResolved: cachedDetailResolved,
          documentFlow:
            cached.documentFlow ??
            (cachedDetailRequired ? 'LISTING_TO_DETAIL_TO_DOCUMENT' : 'LISTING_TO_DOCUMENT'),
          outcome: cachedGate.outcome,
          failureReasons: cachedGate.failureReasons,
        };
      }
    }

    const maxNotices = Math.min(Math.max(1, options.maxNotices ?? options.limit ?? 30), 100);
    const effectiveTimeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(Math.max(50, Math.floor(options.timeoutMs)), 30000)
        : 15000;
    const effectiveConnectionTimeoutMs = resolveConnectionTimeoutMs(
      effectiveTimeoutMs,
      options.connectionTimeoutMs
    );
    const effectiveMaxRetries =
      options.maxRetries !== undefined &&
      Number.isFinite(options.maxRetries) &&
      Number.isInteger(options.maxRetries) &&
      options.maxRetries >= 0
        ? Math.min(Math.max(0, options.maxRetries), 3)
        : 2;
    const effectiveRetryBackoffMs =
      options.retryBackoffMs !== undefined &&
      Number.isFinite(options.retryBackoffMs) &&
      options.retryBackoffMs > 0
        ? Math.min(Math.max(10, Math.floor(options.retryBackoffMs)), 5000)
        : 500;

    const effectiveRunnerMode: RunnerMode = resolveRunnerMode(options.runnerMode);
    const remoteRunner: OfficialAcquisitionRunner | null =
      options.acquisitionRunner ??
      options.remoteRunner ??
      (effectiveRunnerMode === 'REMOTE' || effectiveRunnerMode === 'AUTO'
        ? new HttpRemoteAcquisitionRunner()
        : null);
    const remoteConfigured = Boolean(remoteRunner && remoteRunner.isConfigured());

    let selectedRunner: RunnerKind =
      effectiveRunnerMode === 'REMOTE' ||
      (effectiveRunnerMode === 'AUTO' && remoteConfigured) ||
      (options.acquisitionRunner && effectiveRunnerMode !== 'AUTO')
        ? 'REMOTE'
        : 'LOCAL';
    let actualRunner: RunnerKind =
      effectiveRunnerMode === 'REMOTE' ||
      (options.acquisitionRunner && effectiveRunnerMode !== 'AUTO')
        ? 'REMOTE'
        : 'LOCAL';
    let localAccessStatus = 'NOT_ATTEMPTED';
    let remoteAccessStatus =
      effectiveRunnerMode === 'REMOTE' || effectiveRunnerMode === 'AUTO'
        ? remoteConfigured
          ? 'NOT_ATTEMPTED'
          : 'NOT_CONFIGURED'
        : 'NOT_ATTEMPTED';
    let selectionReason =
      effectiveRunnerMode === 'REMOTE'
        ? remoteConfigured
          ? 'Remote runner selected (RUNNER_MODE=REMOTE)'
          : 'RUNNER_MODE=REMOTE requested, but remote acquisition worker is not configured'
        : effectiveRunnerMode === 'AUTO'
        ? remoteConfigured
          ? 'Remote runner preferred in RUNNER_MODE=AUTO (worker configured)'
          : 'AUTO runner mode (remote worker not configured; using LOCAL)'
        : 'Local runner selected (RUNNER_MODE=LOCAL)';
    let executionOrigin: AcquisitionExecutionOrigin = hasFixtures ? 'FIXTURE' : 'REAL_LIVE_LOCAL';

    const metrics: DiscoveryExecutionMetrics = {
      pagesRequested: 0,
      pagesSucceeded: 0,
      pagesFailed: 0,
      pagesCrawled: 0,
      durationMs: 0,
      retryCount: 0,
      rejectedUrlsCount: 0,
      noticesDiscovered: 0,
      documentsDiscovered: 0,
      endpointsReached: 0,
      listingPagesValidated: 0,
      // Section 8: Detail metrics
      detailUrlsDiscovered: 0,
      detailRequestsAttempted: 0,
      detailPagesFetched: 0,
      detailPagesParsed: 0,
      detailPagesWithDocuments: 0,
      // Section 9: Document metrics
      documentUrlsDiscovered: 0,
      documentDownloadAttempts: 0,
      documentsDownloaded: 0,
      documentsValidated: 0,
      invalidDocuments: 0,
      downloadFailures: 0,
      // Section 10: PDF metrics
      pdfCandidates: 0,
      pdfDownloadAttempts: 0,
      pdfDownloadsSucceeded: 0,
      pdfValidationAttempts: 0,
      validPdfs: 0,
      pdfsValidated: 0,
      invalidPdfs: 0,
      attemptedEndpoints: [],
      timeoutMs: effectiveTimeoutMs,
      connectionTimeoutMs: effectiveConnectionTimeoutMs,
      maxRetries: effectiveMaxRetries,
      attempts: 0,
      requestAttempts: 0,
      retryReasons: [],
      retryDiagnostics: [],
      attemptDiagnostics: [],
      lastErrorType: null,
      lastErrorCode: null,
      lastErrorName: null,
      lastErrorMessage: null,
      lastErrorCause: null,
      lastErrorRetryable: null,
    };

    let selectedEndpoint: SourceEndpointConfig | null = null;
    let lastValidListingEndpoint: SourceEndpointConfig | null = null;
    let lastValidListingFinalUrl: string | null = null;
    let finalUrl: string | null = null;
    let httpStatus: number | null = null;
    let responseContentType: string | null = null;
    let responseBytes: number | null = null;
    let responseTimeMs: number | null = null;
    let verifiedLive = false;
    let lastError: Error | null = null;
    let lastErrorDiag: StructuredFetchDiagnostic | null = null;
    let machineFailureReason: MachineFailureReason = 'NONE';
    const failedStages: string[] = [];

    const allNotices: NormalizedNotice[] = [];
    const seenNoticeIds = new Set<string>();
    const timedOutDeadHostnames = new Set<string>();
    const connectionResetHostnames = new Set<string>();
    let liveTransportTimeoutEndpoints = 0;

    let endpointReached = false;
    let listingValidated = false;
    let successfulOutcome: EndpointOutcome | null = null;
    let hadValidEmptyListing = false;
    let sawStructureChanged = false;
    let sawWrongContent = false;
    let sawParseFailed = false;
    let sawAccessBlocked = false;
    let sawTimeout = false;
    let sawHttpError = false;
    let sawInvalidMime = false;
    let sawInvalidMagicBytes = false;
    let sawInvalidPdf = false;
    let sawDownloadFailed = false;

    const shouldValidatePdfs = Boolean(options.downloadAndValidatePdfs || options.pdfFixtures);

    // 3. Evidence-Based Endpoint Fallback Loop (Primary -> Secondary -> Fallback)
    for (let epIndex = 0; epIndex < endpoints.length; epIndex++) {
      const ep = endpoints[epIndex];
      const epHostname = (() => {
        try {
          return new URL(ep.url).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();

      // If this exact hostname already timed out at the transport layer after all retry attempts
      // in live mode, do not repeat another full retry cycle against the identical dead host.
      if (!allowFixtures && epHostname && timedOutDeadHostnames.has(epHostname)) {
        continue;
      }

      // In live mode, if 2 distinct endpoints for this source already exhausted full transport timeouts,
      // avoid cascading multi-minute timeouts across remaining regional mirrors unless a remote runner is configured.
      if (
        !allowFixtures &&
        liveTransportTimeoutEndpoints >= 2 &&
        !(remoteConfigured && (effectiveRunnerMode === 'REMOTE' || effectiveRunnerMode === 'AUTO'))
      ) {
        break;
      }

      selectedEndpoint = ep;
      metrics.selectedEndpointId = ep.endpointId;
      metrics.selectedEndpointUrl = ep.url;

      const endpointMaxPages = Math.min(
        Math.max(1, options.maxPages ?? ep.maxPages ?? 3),
        10
      );

      logger.info('EXECUTOR_ENDPOINT_SELECTED', {
        sourceId,
        endpointId: ep.endpointId,
        endpointUrl: ep.url,
        endpointPriority: ep.endpointPriority,
        paginationMethod: ep.paginationMethod,
        maxPages: endpointMaxPages,
        parser: adapter.name,
      });

      const seenPageUrls = new Set<string>();
      const seenPageHashes = new Set<string>();
      let currentPageUrl: string | null = ep.url;
      let currentPageNumber = 1;
      let currentEndpointNoticesCount = 0;
      let currentEndpointValidPdfs = 0;
      let currentEndpointReached = false;
      let currentEndpointListingValid = false;
      let currentEndpointOutcome: EndpointOutcome = 'ENDPOINT_UNAVAILABLE';
      let currentRedirectChain: string[] | undefined = undefined;
      let currentResponseContentType: string | null = null;
      let currentResponseBytes: number | null = null;
      let currentResponseTimeMs: number | null = null;
      let currentOfficialDomainVerified = isOfficialDomain(ep.url, sourceId).allowed;
      let currentAttemptsUsed = 0;
      let currentRetriesUsed = 0;
      const currentRetryReasons: string[] = [];
      const currentRetryDiagnostics: NonNullable<DiscoveryExecutionMetrics['retryDiagnostics']> = [];
      const currentAttemptDiagnostics: StructuredFetchDiagnostic[] = [];
      let currentLastDiagnostic: StructuredFetchDiagnostic | null = null;

      try {
        while (currentPageUrl && currentPageNumber <= endpointMaxPages && allNotices.length < maxNotices) {
          if (seenPageUrls.has(currentPageUrl)) {
            logger.debug('Stopping pagination: duplicate page URL detected', { url: currentPageUrl });
            break;
          }
          seenPageUrls.add(currentPageUrl);
          metrics.pagesRequested++;

          let pageHtml = '';

          // Check endpointFixtures -> pageFixtures -> fixtureHtml -> Live HTTP fetch
          const epFixture = allowFixtures
            ? options.endpointFixtures?.[ep.endpointId] ??
              options.endpointFixtures?.[currentPageUrl]
            : undefined;

          if (allowFixtures && epFixture !== undefined) {
            currentAttemptsUsed++;
            metrics.attempts = (metrics.attempts || 0) + 1;
            if (typeof epFixture === 'string') {
              pageHtml = epFixture;
              httpStatus = 200;
              finalUrl = currentPageUrl;
            } else {
              httpStatus = epFixture.status ?? 200;
              pageHtml = epFixture.html;
              finalUrl = epFixture.finalUrl ?? currentPageUrl;
            }
            currentResponseContentType = pageHtml.trim().startsWith('{') ? 'application/json' : 'text/html';
            currentResponseBytes = Buffer.byteLength(pageHtml, 'utf8');
            currentResponseTimeMs = 0;
            responseContentType = currentResponseContentType;
            responseBytes = currentResponseBytes;
            responseTimeMs = currentResponseTimeMs;

            if (httpStatus === 401 || httpStatus === 403) {
              sawAccessBlocked = true;
              machineFailureReason = 'ACCESS_BLOCKED';
              currentEndpointOutcome = 'ENDPOINT_BLOCKED';
              metrics.pagesFailed++;
              break;
            }
            if (httpStatus === 429) {
              sawAccessBlocked = true;
              machineFailureReason = 'HTTP_429';
              currentEndpointOutcome = 'ENDPOINT_BLOCKED';
              metrics.pagesFailed++;
              break;
            }
            if (httpStatus >= 400) {
              sawHttpError = true;
              machineFailureReason = 'HTTP_ERROR';
              currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
              metrics.pagesFailed++;
              break;
            }

            verifiedLive = false;
            endpointReached = true;
            currentEndpointReached = true;
            metrics.endpointsReached = (metrics.endpointsReached || 0) + 1;
          } else if (allowFixtures && options.pageFixtures && options.pageFixtures[currentPageNumber]) {
            currentAttemptsUsed++;
            metrics.attempts = (metrics.attempts || 0) + 1;
            pageHtml = options.pageFixtures[currentPageNumber];
            httpStatus = 200;
            finalUrl = currentPageUrl;
            currentResponseContentType = pageHtml.trim().startsWith('{') ? 'application/json' : 'text/html';
            currentResponseBytes = Buffer.byteLength(pageHtml, 'utf8');
            currentResponseTimeMs = 0;
            responseContentType = currentResponseContentType;
            responseBytes = currentResponseBytes;
            responseTimeMs = currentResponseTimeMs;
            verifiedLive = false;
            endpointReached = true;
            currentEndpointReached = true;
            metrics.endpointsReached = (metrics.endpointsReached || 0) + 1;
          } else if (allowFixtures && currentPageNumber === 1 && options.fixtureHtml !== undefined) {
            currentAttemptsUsed++;
            metrics.attempts = (metrics.attempts || 0) + 1;
            pageHtml = options.fixtureHtml;
            httpStatus = 200;
            finalUrl = currentPageUrl;
            currentResponseContentType = pageHtml.trim().startsWith('{') ? 'application/json' : 'text/html';
            currentResponseBytes = Buffer.byteLength(pageHtml, 'utf8');
            currentResponseTimeMs = 0;
            responseContentType = currentResponseContentType;
            responseBytes = currentResponseBytes;
            responseTimeMs = currentResponseTimeMs;
            verifiedLive = false;
            endpointReached = true;
            currentEndpointReached = true;
            metrics.endpointsReached = (metrics.endpointsReached || 0) + 1;
          } else if (verificationMode === 'FIXTURE') {
            // In explicit FIXTURE mode, never perform live HTTP requests if a fixture is missing
            metrics.pagesFailed++;
            sawHttpError = true;
            machineFailureReason = 'HTTP_ERROR';
            currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
            break;
          } else {
            // Live HTTP fetch with security & redirect checks (validateTargetUrl runs inside fetchWithRetry)
            try {
              const domainCheck = isOfficialDomain(currentPageUrl, sourceId);
              if (!domainCheck.allowed) {
                currentOfficialDomainVerified = false;
                metrics.rejectedUrlsCount++;
                sawAccessBlocked = true;
                machineFailureReason = 'DOMAIN_NOT_ALLOWED';
                throw new IngestionError(
                  `Disallowed non-official domain for ${sourceId}: ${domainCheck.reason}`,
                  'SSRF_BLOCKED',
                  { errorCode: 'DOMAIN_NOT_ALLOWED' },
                  false
                );
              }
              currentOfficialDomainVerified = true;

              const epTimeoutMs = options.timeoutMs ?? ep.timeoutMs ?? effectiveTimeoutMs;
              const epConnectTimeoutMs = resolveConnectionTimeoutMs(
                epTimeoutMs,
                options.connectionTimeoutMs ?? effectiveConnectionTimeoutMs
              );
              const hostAlreadyReset = Boolean(epHostname && connectionResetHostnames.has(epHostname));
              const fetchRes = await adapter.fetchWithRetry(currentPageUrl, {
                timeoutMs: epTimeoutMs,
                connectionTimeoutMs: epConnectTimeoutMs,
                maxRetries: hostAlreadyReset
                  ? 0
                  : options.maxRetries ?? ep.retryPolicy?.maxRetries ?? effectiveMaxRetries,
                retryBackoffMs: options.retryBackoffMs ?? effectiveRetryBackoffMs,
                allowHttp: false,
                runnerMode: effectiveRunnerMode,
                acquisitionRunner: options.acquisitionRunner,
                remoteRunner: options.remoteRunner ?? remoteRunner ?? undefined,
                preferRemote: effectiveRunnerMode === 'REMOTE',
                methodType: 'LISTING',
              });

              httpStatus = fetchRes.status;
              finalUrl = fetchRes.finalUrl;
              pageHtml = fetchRes.text;
              currentRedirectChain = fetchRes.redirectChain;
              currentResponseContentType = fetchRes.contentType || null;
              currentResponseBytes = fetchRes.responseBytes ?? Buffer.byteLength(fetchRes.text || '', 'utf8');
              currentResponseTimeMs = fetchRes.responseTimeMs ?? null;
              responseContentType = currentResponseContentType;
              responseBytes = currentResponseBytes;
              responseTimeMs = currentResponseTimeMs;
              if (finalUrl) {
                currentOfficialDomainVerified = isOfficialDomain(finalUrl, sourceId).allowed;
              }
              currentAttemptsUsed += fetchRes.attemptsUsed;
              currentRetriesUsed += fetchRes.retriesUsed;
              currentRetryReasons.push(...fetchRes.retryReasons);
              currentRetryDiagnostics.push(...fetchRes.retryDiagnostics);
              if (fetchRes.attemptDiagnostics && fetchRes.attemptDiagnostics.length > 0) {
                currentAttemptDiagnostics.push(...fetchRes.attemptDiagnostics);
                metrics.attemptDiagnostics!.push(...fetchRes.attemptDiagnostics);
              }
              metrics.attempts = (metrics.attempts || 0) + fetchRes.attemptsUsed;
              metrics.requestAttempts = metrics.attempts;
              metrics.retryCount += fetchRes.retriesUsed;
              metrics.retryReasons!.push(...fetchRes.retryReasons);
              metrics.retryDiagnostics!.push(...fetchRes.retryDiagnostics);
              if (fetchRes.selectedRunner) {
                selectedRunner = fetchRes.selectedRunner;
              }
              if (fetchRes.runnerUsed) {
                actualRunner = fetchRes.runnerUsed;
              }
              if (fetchRes.localAccess) {
                localAccessStatus = fetchRes.localAccess;
              }
              if (fetchRes.remoteAccess) {
                remoteAccessStatus = fetchRes.remoteAccess;
              }
              if (fetchRes.selectionReason) {
                selectionReason = fetchRes.selectionReason;
              }
              if (fetchRes.executionOrigin) {
                executionOrigin = fetchRes.executionOrigin;
              }
              verifiedLive =
                executionOrigin === 'REAL_LIVE_LOCAL' ||
                executionOrigin === 'REAL_LIVE_REMOTE' ||
                executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
                executionOrigin === 'REAL_REMOTE_PRODUCTION';
              endpointReached = true;
              currentEndpointReached = true;
              metrics.endpointsReached = (metrics.endpointsReached || 0) + 1;
            } catch (err) {
              metrics.pagesFailed++;
              lastError = err as Error;
              const errMsg = (err as Error).message.toLowerCase();
              const errCode = (err as IngestionError).code;
              const errDetails = (err as IngestionError).details as
                | {
                    status?: number;
                    httpStatus?: number | null;
                    attemptsUsed?: number;
                    retriesUsed?: number;
                    retryReasons?: string[];
                    retryDiagnostics?: NonNullable<DiscoveryExecutionMetrics['retryDiagnostics']>;
                    attemptDiagnostics?: StructuredFetchDiagnostic[];
                    lastDiagnostic?: StructuredFetchDiagnostic | null;
                    errorType?: NetworkErrorClassification | null;
                    errorCode?: string | null;
                    errorName?: string | null;
                    errorMessage?: string | null;
                    cause?: string | null;
                    retryable?: boolean;
                    runnerUsed?: RunnerKind;
                    executionOrigin?: AcquisitionExecutionOrigin;
                    localAccess?: string;
                    remoteAccess?: string;
                    selectedRunner?: RunnerKind;
                    selectionReason?: string;
                  }
                | undefined;

              if (errDetails?.selectedRunner) {
                selectedRunner = errDetails.selectedRunner;
              }
              if (errDetails?.runnerUsed) {
                actualRunner = errDetails.runnerUsed;
              }
              if (errDetails?.localAccess && localAccessStatus !== 'SUCCESS') {
                localAccessStatus = errDetails.localAccess;
              }
              if (errDetails?.remoteAccess) {
                remoteAccessStatus = errDetails.remoteAccess;
              }
              if (errDetails?.selectionReason) {
                selectionReason = errDetails.selectionReason;
              }
              if (errDetails?.executionOrigin) {
                executionOrigin = errDetails.executionOrigin;
              }

              const epTimeout = options.timeoutMs ?? ep.timeoutMs ?? effectiveTimeoutMs;
              const epConnectTimeout = resolveConnectionTimeoutMs(
                epTimeout,
                options.connectionTimeoutMs ?? effectiveConnectionTimeoutMs
              );
              const epMaxRetries = options.maxRetries ?? ep.retryPolicy?.maxRetries ?? effectiveMaxRetries;
              const classifiedDiag: StructuredFetchDiagnostic =
                errDetails?.lastDiagnostic ??
                classifyNetworkOrHttpError({
                  error: err,
                  httpStatus: errDetails?.httpStatus ?? errDetails?.status ?? null,
                  requestUrl: currentPageUrl,
                  timeoutMs: epTimeout,
                  connectionTimeoutMs: epConnectTimeout,
                  attempt: errDetails?.attemptsUsed || 1,
                  maxAttempts: epMaxRetries + 1,
                  retryDelayMs: 0,
                });

              currentLastDiagnostic = classifiedDiag;
              lastErrorDiag = classifiedDiag;

              const errAttempts =
                errDetails?.attemptsUsed !== undefined
                  ? errDetails.attemptsUsed
                  : 1;
              const errRetries = errDetails?.retriesUsed ?? 0;
              const errReasons = errDetails?.retryReasons ?? [];
              const errDiag = errDetails?.retryDiagnostics ?? [];
              const errAttemptDiag =
                errDetails?.attemptDiagnostics && errDetails.attemptDiagnostics.length > 0
                  ? errDetails.attemptDiagnostics
                  : [classifiedDiag];

              currentAttemptsUsed += errAttempts;
              currentRetriesUsed += errRetries;
              currentRetryReasons.push(...errReasons);
              currentRetryDiagnostics.push(...errDiag);
              currentAttemptDiagnostics.push(...errAttemptDiag);
              metrics.attempts = (metrics.attempts || 0) + errAttempts;
              metrics.requestAttempts = metrics.attempts;
              metrics.retryCount += errRetries;
              metrics.retryReasons!.push(...errReasons);
              metrics.retryDiagnostics!.push(...errDiag);
              metrics.attemptDiagnostics!.push(...errAttemptDiag);

              if (classifiedDiag.httpStatus !== null) {
                httpStatus = classifiedDiag.httpStatus;
              }

              if (errMsg.includes('content-type') || errCode === 'EXTRACTION_FAILED') {
                sawParseFailed = true;
                machineFailureReason = 'PARSE_FAILED';
                currentEndpointOutcome = 'ENDPOINT_PARSE_FAILED';
              } else if (
                classifiedDiag.errorType === 'SSRF_BLOCKED' ||
                classifiedDiag.errorType === 'DOMAIN_NOT_ALLOWED' ||
                classifiedDiag.errorType === 'INVALID_URL' ||
                errMsg.includes('redirect')
              ) {
                sawAccessBlocked = true;
                machineFailureReason = 'EXTERNAL_REDIRECT_BLOCKED';
                currentEndpointOutcome = 'ENDPOINT_BLOCKED';
              } else if (
                classifiedDiag.errorType === 'HTTP_403' ||
                classifiedDiag.httpStatus === 401
              ) {
                sawAccessBlocked = true;
                machineFailureReason = 'HTTP_403';
                currentEndpointOutcome = 'ENDPOINT_BLOCKED';
              } else if (classifiedDiag.errorType === 'HTTP_429') {
                sawAccessBlocked = true;
                machineFailureReason = 'HTTP_429';
                currentEndpointOutcome = 'ENDPOINT_BLOCKED';
              } else if (
                classifiedDiag.errorType === 'HTTP_404' ||
                classifiedDiag.errorType === 'HTTP_4XX' ||
                classifiedDiag.errorType === 'HTTP_502' ||
                classifiedDiag.errorType === 'HTTP_503' ||
                classifiedDiag.errorType === 'HTTP_504' ||
                classifiedDiag.errorType === 'HTTP_5XX'
              ) {
                sawHttpError = true;
                machineFailureReason = 'HTTP_ERROR';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
              } else if (classifiedDiag.errorType === 'TIMEOUT') {
                sawTimeout = true;
                machineFailureReason = 'HTTP_TIMEOUT';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                liveTransportTimeoutEndpoints++;
                if (epHostname) {
                  timedOutDeadHostnames.add(epHostname);
                }
              } else if (classifiedDiag.errorType === 'DNS_ERROR') {
                machineFailureReason = 'DNS_ERROR';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname) {
                  timedOutDeadHostnames.add(epHostname);
                }
              } else if (classifiedDiag.errorType === 'TLS_ERROR') {
                machineFailureReason = 'TLS_ERROR';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname) {
                  timedOutDeadHostnames.add(epHostname);
                }
              } else if (classifiedDiag.errorType === 'CONNECTION_RESET') {
                machineFailureReason = 'CONNECTION_RESET';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname) {
                  // Record that this host reset connection on this path, but allow alternate official paths (e.g. /NoticeBoard.htm) to be tried once
                  connectionResetHostnames.add(epHostname);
                }
              } else if (classifiedDiag.errorType === 'CONNECTION_REFUSED') {
                machineFailureReason = 'CONNECTION_REFUSED';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname) {
                  timedOutDeadHostnames.add(epHostname);
                }
              } else if (classifiedDiag.errorType === 'NETWORK_UNAVAILABLE') {
                machineFailureReason = 'NETWORK_UNAVAILABLE';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname) {
                  timedOutDeadHostnames.add(epHostname);
                }
              } else {
                machineFailureReason = 'UNKNOWN_NETWORK_ERROR';
                currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
                if (epHostname && !classifiedDiag.httpStatus) {
                  timedOutDeadHostnames.add(epHostname);
                }
              }

              logger.warn('EXECUTOR_ENDPOINT_FETCH_FAILED', {
                sourceId,
                endpointId: ep.endpointId,
                pageNumber: currentPageNumber,
                url: currentPageUrl,
                attemptsUsed: errAttempts,
                retriesUsed: errRetries,
                retryReasons: errReasons,
                errorType: classifiedDiag.errorType,
                errorCode: classifiedDiag.errorCode,
                errorName: classifiedDiag.errorName,
                cause: classifiedDiag.cause,
                error: classifiedDiag.errorMessage,
              });
              break; // Try next endpoint in registry
            }
          }

          // Content hash deduplication for pagination loops
          const pageHash = crypto.createHash('sha256').update(pageHtml).digest('hex');
          if (seenPageHashes.has(pageHash)) {
            logger.debug('Stopping pagination: identical page content detected', { pageNumber: currentPageNumber });
            break;
          }
          seenPageHashes.add(pageHash);

          metrics.pagesSucceeded++;
          metrics.pagesCrawled++;

          // Check for error page / FileNotFound redirect / empty HTML before parsing
          if (isErrorOrWrongContentPage(pageHtml, finalUrl)) {
            sawWrongContent = true;
            currentEndpointOutcome = 'ENDPOINT_WRONG_CONTENT';
            machineFailureReason = 'WRONG_CONTENT';
            if (!hasFixtures) {
              sourceEndpointRegistry.updateEndpointStatus(ep.endpointId, 'DEGRADED');
            }
            logger.warn('EXECUTOR_ENDPOINT_WRONG_CONTENT', {
              sourceId,
              endpointId: ep.endpointId,
              finalUrl,
            });
            break;
          }

          // Parse notices using adapter's source-specific parser
          let parseResult: { notices: NormalizedNotice[]; structureIntact: boolean };
          try {
            parseResult = adapter.parseNotices(pageHtml, currentPageUrl);
          } catch (parseErr) {
            sawParseFailed = true;
            lastError = parseErr as Error;
            currentEndpointOutcome = 'ENDPOINT_STRUCTURE_CHANGED';
            machineFailureReason = 'PARSE_FAILED';
            if (!hasFixtures) {
              sourceEndpointRegistry.updateEndpointStatus(ep.endpointId, 'DEGRADED');
            }
            break;
          }

          if (!parseResult.structureIntact) {
            sawStructureChanged = true;
            currentEndpointOutcome = 'ENDPOINT_STRUCTURE_CHANGED';
            machineFailureReason = 'ADAPTER_STRUCTURE_CHANGED';
            if (!hasFixtures) {
              sourceEndpointRegistry.updateEndpointStatus(ep.endpointId, 'STRUCTURE_CHANGED');
            }

            logger.warn('EXECUTOR_STRUCTURE_CHANGED_FALLBACK_TRIGGERED', {
              sourceId,
              endpointId: ep.endpointId,
              pageNumber: currentPageNumber,
              diagnostic: 'HTTP 200 returned but expected recruitment HTML structure was missing',
            });

            // HTTP 200 alone MUST NOT stop fallback! Break to try next endpoint in registry.
            break;
          }

          listingValidated = true;
          currentEndpointListingValid = true;
          lastValidListingEndpoint = ep;
          lastValidListingFinalUrl = finalUrl || currentPageUrl;
          metrics.listingPagesValidated = (metrics.listingPagesValidated || 0) + 1;
          if (!hasFixtures) {
            sourceEndpointRegistry.updateEndpointStatus(ep.endpointId, 'VERIFIED');
          }

          if (parseResult.notices.length === 0) {
            hadValidEmptyListing = true;
            currentEndpointOutcome = 'ENDPOINT_EMPTY_VALID';
            logger.debug('Zero notices found on page', { pageNumber: currentPageNumber });
            break;
          }

          // Process and classify notices
          for (const rawNotice of parseResult.notices) {
            if (allNotices.length >= maxNotices) break;

            const classification = classifyNoticeExplainable(
              rawNotice.title,
              String(rawNotice.metadata?.rawRowText || '')
            );
            if (!classification.isRecruitmentRelated) {
              continue; // Filter out tenders, procurement, admin circulars
            }

            rawNotice.evidenceStage = 'NOTICE_FOUND';

            // Explicit Source-Specific Detail Strategy (Section 1 & 4)
            const detailStrategy = adapter.evaluateNoticeDetailStrategy(rawNotice);
            rawNotice.documentFlow = detailStrategy.documentFlow;
            if (detailStrategy.detailUrl) {
              metrics.detailUrlsDiscovered!++;
              rawNotice.detailUrl = detailStrategy.detailUrl;
            }

            if (!detailStrategy.detailRequired) {
              // Listing page directly exposes the official PDF/document link(s).
              // Even if an optional detail URL exists (e.g. UPPSC View_Advt.aspx), detailRequired is false and detailResolved is null.
              rawNotice.detailRequired = false;
              rawNotice.detailResolved = null;
              rawNotice.documents = detailStrategy.directDocuments.map((d) => ({
                ...d,
                documentDiscoveryMethod: 'DIRECT_PDF' as const,
              }));
              if (rawNotice.documents.length > 0) {
                rawNotice.rawNoticeUrl = rawNotice.documents[0].url;
                rawNotice.evidenceStage = 'DOCUMENT_URL_FOUND';
              }
            } else {
              // Detail page is mandatory to discover the official PDF/document link(s).
              if (
                !hasFixtures &&
                (metrics.detailPagesWithDocuments ?? 0) >= 2 &&
                (!options.downloadAndValidatePdfs || (metrics.validPdfs ?? 0) >= 2)
              ) {
                break;
              }
              rawNotice.detailRequired = true;
              rawNotice.documents = [];

              if (options.fetchDetailPages !== false && detailStrategy.detailUrl) {
                metrics.detailRequestsAttempted!++;

                const detailTimeoutMs = options.timeoutMs ?? ep.timeoutMs ?? effectiveTimeoutMs;
                const detailConnectTimeoutMs = resolveConnectionTimeoutMs(
                  detailTimeoutMs,
                  options.connectionTimeoutMs ?? effectiveConnectionTimeoutMs
                );
                const detailRes = await adapter.followDetailPageWithStatus(
                  detailStrategy.detailUrl,
                  {
                    timeoutMs: detailTimeoutMs,
                    connectionTimeoutMs: detailConnectTimeoutMs,
                    maxRetries: options.maxRetries ?? ep.retryPolicy?.maxRetries ?? effectiveMaxRetries,
                    retryBackoffMs: options.retryBackoffMs ?? effectiveRetryBackoffMs,
                    detailFixtures: allowFixtures ? options.detailFixtures : undefined,
                    strictLiveMode: !allowFixtures,
                    runnerMode: effectiveRunnerMode,
                    acquisitionRunner: options.acquisitionRunner,
                    remoteRunner: options.remoteRunner ?? remoteRunner ?? undefined,
                    preferRemote: actualRunner === 'REMOTE',
                  }
                );

                if (detailRes.selectedRunner) {
                  selectedRunner = detailRes.selectedRunner;
                }
                if (detailRes.runnerUsed) {
                  actualRunner = detailRes.runnerUsed;
                }
                if (detailRes.localAccess && localAccessStatus !== 'SUCCESS') {
                  localAccessStatus = detailRes.localAccess;
                }
                if (detailRes.remoteAccess && detailRes.remoteAccess !== 'NOT_ATTEMPTED') {
                  remoteAccessStatus = detailRes.remoteAccess;
                }
                if (detailRes.selectionReason) {
                  selectionReason = detailRes.selectionReason;
                }
                if (detailRes.executionOrigin) {
                  executionOrigin = detailRes.executionOrigin;
                  verifiedLive =
                    executionOrigin === 'REAL_LIVE_LOCAL' ||
                    executionOrigin === 'REAL_LIVE_REMOTE' ||
                    executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
                    executionOrigin === 'REAL_REMOTE_PRODUCTION';
                }

                if (detailRes.retriesUsed) {
                  currentRetriesUsed += detailRes.retriesUsed;
                  metrics.retryCount += detailRes.retriesUsed;
                }
                if (detailRes.retryReasons && detailRes.retryReasons.length > 0) {
                  currentRetryReasons.push(...detailRes.retryReasons);
                  metrics.retryReasons!.push(...detailRes.retryReasons);
                }
                if (detailRes.retryDiagnostics && detailRes.retryDiagnostics.length > 0) {
                  currentRetryDiagnostics.push(...detailRes.retryDiagnostics);
                  metrics.retryDiagnostics!.push(...detailRes.retryDiagnostics);
                }
                if (detailRes.attemptDiagnostics && detailRes.attemptDiagnostics.length > 0) {
                  currentAttemptDiagnostics.push(...detailRes.attemptDiagnostics);
                  metrics.attemptDiagnostics!.push(...detailRes.attemptDiagnostics);
                }
                if (!detailRes.pageFetched && detailRes.lastErrorType) {
                  const lastDetailAttempt =
                    detailRes.attemptDiagnostics?.[detailRes.attemptDiagnostics.length - 1] ?? null;
                  if (lastDetailAttempt) {
                    currentLastDiagnostic = lastDetailAttempt;
                    lastErrorDiag = lastDetailAttempt;
                  }
                }

                if (detailRes.pageFetched) {
                  metrics.detailPagesFetched!++;
                  metrics.detailPagesParsed!++;
                }

                const resolvedDocs = detailRes.documents.filter(
                  (d) =>
                    d.documentType === 'PDF' ||
                    d.documentType === 'DOC' ||
                    d.url.toLowerCase().endsWith('.pdf')
                );

                if (detailRes.pageFetched && resolvedDocs.length > 0) {
                  metrics.detailPagesWithDocuments!++;
                  rawNotice.documents = resolvedDocs.map((d) => ({
                    ...d,
                    documentDiscoveryMethod: 'DETAIL_PAGE' as const,
                  }));
                  rawNotice.detailResolved = true;
                  rawNotice.evidenceStage = 'DOCUMENT_URL_FOUND';
                } else {
                  rawNotice.documents = [];
                  rawNotice.detailResolved = false;
                  failedStages.push('DETAIL_RESOLVED');
                }
              } else {
                rawNotice.detailResolved = false;
                failedStages.push('DETAIL_RESOLVED');
              }
            }

            // Document & PDF Metrics (Section 2, 9 & 10)
            for (const doc of rawNotice.documents) {
              metrics.documentUrlsDiscovered!++;
              metrics.documentsDiscovered++;

              if (doc.documentType === 'PDF' || doc.url.toLowerCase().endsWith('.pdf')) {
                metrics.pdfCandidates!++;
              }

              if (shouldValidatePdfs && (allowFixtures || currentEndpointValidPdfs < 2)) {
                metrics.documentDownloadAttempts!++;
                metrics.pdfDownloadAttempts!++;

                let docBuffer: Buffer | null = null;
                let downloadSucceeded = false;

                try {
                  if (allowFixtures && options.pdfFixtures && doc.url in options.pdfFixtures) {
                    const pdfFixture = options.pdfFixtures[doc.url];
                    if (Buffer.isBuffer(pdfFixture)) {
                      docBuffer = pdfFixture;
                      downloadSucceeded = true;
                    } else if (typeof pdfFixture === 'string') {
                      docBuffer = Buffer.from(pdfFixture, 'utf8');
                      downloadSucceeded = true;
                    } else {
                      const fStatus = pdfFixture.status ?? 200;
                      if (fStatus >= 400) {
                        throw new IngestionError(`PDF fixture HTTP ${fStatus}`, 'DOWNLOAD_FAILED');
                      }
                      docBuffer = Buffer.isBuffer(pdfFixture.body)
                        ? pdfFixture.body
                        : Buffer.from(pdfFixture.body, 'utf8');
                      downloadSucceeded = true;
                    }
                  } else if (verificationMode === 'FIXTURE') {
                    throw new IngestionError('Missing PDF fixture in FIXTURE mode', 'DOWNLOAD_FAILED');
                  } else {
                    const domainCheck = isOfficialDomain(doc.url, sourceId);
                    if (!domainCheck.allowed) {
                      sawAccessBlocked = true;
                      throw new IngestionError(
                        `Disallowed non-official document domain: ${domainCheck.reason}`,
                        'SSRF_BLOCKED',
                        { errorCode: 'DOMAIN_NOT_ALLOWED' },
                        false
                      );
                    }
                    const dlTimeoutMs = options.timeoutMs ?? ep.timeoutMs ?? effectiveTimeoutMs;
                    const dlConnectTimeoutMs = resolveConnectionTimeoutMs(
                      dlTimeoutMs,
                      options.connectionTimeoutMs ?? effectiveConnectionTimeoutMs
                    );
                    const downloadRes = await this.downloader.download(doc.url, {
                      requestTimeoutMs: dlTimeoutMs,
                      connectionTimeoutMs: dlConnectTimeoutMs,
                      maxRetries: Math.min(
                        Math.max(1, (options.maxRetries ?? ep.retryPolicy?.maxRetries ?? effectiveMaxRetries) + 1),
                        4
                      ),
                      baseRetryDelayMs: options.retryBackoffMs ?? effectiveRetryBackoffMs,
                      sourceId,
                      allowedOfficialDomains: adapter.officialDomains,
                      runnerMode: effectiveRunnerMode,
                      acquisitionRunner: options.acquisitionRunner,
                      remoteRunner: options.remoteRunner ?? remoteRunner ?? undefined,
                      preferRemote: actualRunner === 'REMOTE',
                    });
                    if (downloadRes.selectedRunner) {
                      selectedRunner = downloadRes.selectedRunner;
                    }
                    if (downloadRes.runnerUsed) {
                      actualRunner = downloadRes.runnerUsed;
                    }
                    if (downloadRes.localAccess && localAccessStatus === 'NOT_ATTEMPTED') {
                      localAccessStatus = downloadRes.localAccess;
                    }
                    if (downloadRes.remoteAccess && downloadRes.remoteAccess !== 'NOT_ATTEMPTED') {
                      remoteAccessStatus = downloadRes.remoteAccess;
                    }
                    if (downloadRes.selectionReason) {
                      selectionReason = downloadRes.selectionReason;
                    }
                    if (downloadRes.executionOrigin) {
                      executionOrigin = downloadRes.executionOrigin;
                      verifiedLive =
                        executionOrigin === 'REAL_LIVE_LOCAL' ||
                        executionOrigin === 'REAL_LIVE_REMOTE' ||
                        executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
                        executionOrigin === 'REAL_REMOTE_PRODUCTION';
                    }
                    if (downloadRes.retriesUsed > 0) {
                      currentRetriesUsed += downloadRes.retriesUsed;
                      metrics.retryCount += downloadRes.retriesUsed;
                    }
                    if (downloadRes.retryReasons && downloadRes.retryReasons.length > 0) {
                      currentRetryReasons.push(...downloadRes.retryReasons);
                      metrics.retryReasons!.push(...downloadRes.retryReasons);
                    }
                    if (downloadRes.retryDiagnostics && downloadRes.retryDiagnostics.length > 0) {
                      currentRetryDiagnostics.push(...downloadRes.retryDiagnostics);
                      metrics.retryDiagnostics!.push(...downloadRes.retryDiagnostics);
                    }
                    if (downloadRes.attemptDiagnostics && downloadRes.attemptDiagnostics.length > 0) {
                      currentAttemptDiagnostics.push(...downloadRes.attemptDiagnostics);
                      metrics.attemptDiagnostics!.push(...downloadRes.attemptDiagnostics);
                    }
                    const finalDomainCheck = isOfficialDomain(downloadRes.canonicalUrl, sourceId);
                    if (!finalDomainCheck.allowed) {
                      sawAccessBlocked = true;
                      throw new IngestionError(
                        `Document redirected to non-official domain: ${downloadRes.canonicalUrl}`,
                        'SSRF_BLOCKED',
                        { errorCode: 'DOMAIN_NOT_ALLOWED' },
                        false
                      );
                    }
                    docBuffer = downloadRes.buffer;
                    downloadSucceeded = true;
                  }
                } catch (dlErr) {
                  const errCode = (dlErr as IngestionError).code;
                  const dlMsg = (dlErr as Error).message || '';
                  const dlDetails = (dlErr as IngestionError).details as
                    | {
                        retriesUsed?: number;
                        retryReasons?: string[];
                        retryDiagnostics?: NonNullable<DiscoveryExecutionMetrics['retryDiagnostics']>;
                        attemptDiagnostics?: StructuredFetchDiagnostic[];
                        lastDiagnostic?: StructuredFetchDiagnostic | null;
                      }
                    | undefined;
                  if (dlDetails?.retriesUsed) {
                    currentRetriesUsed += dlDetails.retriesUsed;
                    metrics.retryCount += dlDetails.retriesUsed;
                  }
                  if (dlDetails?.retryReasons && dlDetails.retryReasons.length > 0) {
                    currentRetryReasons.push(...dlDetails.retryReasons);
                    metrics.retryReasons!.push(...dlDetails.retryReasons);
                  }
                  if (dlDetails?.retryDiagnostics && dlDetails.retryDiagnostics.length > 0) {
                    currentRetryDiagnostics.push(...dlDetails.retryDiagnostics);
                    metrics.retryDiagnostics!.push(...dlDetails.retryDiagnostics);
                  }
                  if (dlDetails?.attemptDiagnostics && dlDetails.attemptDiagnostics.length > 0) {
                    currentAttemptDiagnostics.push(...dlDetails.attemptDiagnostics);
                    metrics.attemptDiagnostics!.push(...dlDetails.attemptDiagnostics);
                  }
                  if (dlDetails?.lastDiagnostic) {
                    currentLastDiagnostic = dlDetails.lastDiagnostic;
                    lastErrorDiag = dlDetails.lastDiagnostic;
                  }
                  if (errCode === 'SSRF_BLOCKED') {
                    sawAccessBlocked = true;
                    downloadSucceeded = false;
                    sawDownloadFailed = true;
                    metrics.downloadFailures!++;
                    doc.pdfDownloadStatus = 'DOWNLOAD_FAILED';
                    doc.validationStatus = 'UNVALIDATED';
                    machineFailureReason = 'EXTERNAL_REDIRECT_BLOCKED';
                    failedStages.push('DOCUMENT_DOWNLOADED');
                  } else if (errCode === 'NOT_PDF' || errCode === 'CORRUPT_PDF') {
                    // The HTTP response payload WAS downloaded, then rejected by content/magic-byte check
                    downloadSucceeded = true;
                    docBuffer = null;
                    if (errCode === 'NOT_PDF' || dlMsg.includes('HTML')) {
                      sawInvalidMime = true;
                    }
                    if (errCode === 'CORRUPT_PDF' || dlMsg.includes('magic bytes')) {
                      sawInvalidMagicBytes = true;
                    }
                  } else {
                    downloadSucceeded = false;
                    sawDownloadFailed = true;
                    metrics.downloadFailures!++;
                    doc.pdfDownloadStatus = 'DOWNLOAD_FAILED';
                    doc.validationStatus = 'UNVALIDATED';
                    machineFailureReason = 'DOCUMENT_DOWNLOAD_FAILED';
                    failedStages.push('DOCUMENT_DOWNLOADED');
                  }
                }

                if (downloadSucceeded) {
                  metrics.documentsDownloaded!++;
                  metrics.pdfDownloadsSucceeded!++;
                  if (rawNotice.evidenceStage !== 'PDF_VALIDATED') {
                    rawNotice.evidenceStage = 'DOCUMENT_DOWNLOADED';
                  }

                  metrics.pdfValidationAttempts!++;

                  if (!docBuffer) {
                    // Downloaded bytes failed downloader content/magic check
                    sawInvalidPdf = true;
                    metrics.invalidDocuments!++;
                    metrics.invalidPdfs!++;
                    doc.pdfDownloadStatus = 'INVALID_PDF';
                    doc.validationStatus = sawInvalidMime ? 'NOT_PDF' : 'CORRUPT';
                    machineFailureReason = 'INVALID_PDF';
                    failedStages.push('PDF_VALIDATED');
                  } else {
                    const isHtml = DocumentDownloader.isHtmlDisguised(docBuffer);
                    const hasMagic = DocumentDownloader.hasPdfMagicBytes(docBuffer);

                    if (isHtml || !hasMagic) {
                      if (isHtml) sawInvalidMime = true;
                      if (!hasMagic) sawInvalidMagicBytes = true;
                      sawInvalidPdf = true;
                      metrics.invalidDocuments!++;
                      metrics.invalidPdfs!++;
                      doc.pdfDownloadStatus = 'INVALID_PDF';
                      doc.validationStatus = isHtml ? 'NOT_PDF' : 'CORRUPT';
                      machineFailureReason = 'INVALID_PDF';
                      failedStages.push('PDF_VALIDATED');
                    } else {
                      try {
                        const valRes = await this.pdfValidator.validate(docBuffer);

                        if (valRes.isValidStructure && valRes.pageCount > 0) {
                          metrics.documentsValidated!++;
                          metrics.validPdfs!++;
                          metrics.pdfsValidated = metrics.validPdfs;
                          currentEndpointValidPdfs++;
                          rawNotice.evidenceStage = 'PDF_VALIDATED';
                          doc.pdfDownloadStatus = 'PDF_DOWNLOADED_AND_VALIDATED';
                          doc.pdfDownloadedInCurrentRun = true;
                          doc.sha256 = valRes.sha256Hash;
                          doc.byteSize = valRes.byteSize;
                          doc.pageCount = valRes.pageCount;
                          doc.validationStatus = 'VALID';
                        } else {
                          sawInvalidPdf = true;
                          metrics.invalidDocuments!++;
                          metrics.invalidPdfs!++;
                          doc.pdfDownloadStatus = 'INVALID_PDF';
                          doc.validationStatus = 'CORRUPT';
                          machineFailureReason = 'INVALID_PDF';
                          failedStages.push('PDF_VALIDATED');
                        }
                      } catch {
                        sawInvalidPdf = true;
                        metrics.invalidDocuments!++;
                        metrics.invalidPdfs!++;
                        doc.pdfDownloadStatus = 'INVALID_PDF';
                        doc.validationStatus = 'CORRUPT';
                        machineFailureReason = 'INVALID_PDF';
                        failedStages.push('PDF_VALIDATED');
                      }
                    }
                  }
                }
              } else {
                doc.pdfDownloadStatus = 'PDF_URL_DISCOVERED';
                doc.validationStatus = 'UNVALIDATED';
              }
            }

            // Deterministic recruitment identity (Cross-region RRB CEN normalization preserved)
            const identity = generateRecruitmentIdentity({
              authority: sourceId,
              advertisementNumber: rawNotice.advertisementNumber,
              title: rawNotice.title,
              documentUrl: rawNotice.rawNoticeUrl,
              publishedDate: rawNotice.publishedDate,
            });

            if (seenNoticeIds.has(identity.identityKey)) {
              logger.info('EXECUTOR_DUPLICATE_NOTICE', {
                sourceId,
                identityKey: identity.identityKey,
                title: rawNotice.title,
              });
              continue;
            }
            seenNoticeIds.add(identity.identityKey);

            // Discovery Evidence
            const primaryDoc = rawNotice.documents.find((d) => d.isPrimaryNotification) || rawNotice.documents[0];
            const effectiveRule =
              rawNotice.sourceSpecificRule || primaryDoc?.sourceSpecificRule || 'STANDARD_OFFICIAL_CLASSIFIER';
            const classificationConfidence =
              rawNotice.classificationConfidence !== undefined
                ? rawNotice.classificationConfidence
                : rawNotice.confidence ?? classification.confidence;

            const evidence: DiscoveryEvidence = {
              source: sourceId,
              officialDomain: adapter.officialDomains[0] || new URL(ep.url).hostname,
              listingUrl: currentPageUrl,
              detailUrl: rawNotice.detailUrl || null,
              documentUrl: primaryDoc ? primaryDoc.url : rawNotice.rawNoticeUrl,
              discoveredAt: new Date().toISOString(),
              adapterVersion: adapter.adapterVersion,
              pageNumber: currentPageNumber,
              classification: rawNotice.category || classification.category,
              classificationReason: rawNotice.classificationReason || classification.reason,
              confidence: classificationConfidence ?? undefined,
              classificationConfidence,
              sourceSpecificRule: effectiveRule,
            };

            rawNotice.isRecruitmentRelated = true;
            rawNotice.recruitmentType = rawNotice.recruitmentType || classification.recruitmentType;
            rawNotice.recruitmentIdentityKey = identity.identityKey;
            rawNotice.evidence = evidence;
            rawNotice.classificationReason = rawNotice.classificationReason || classification.reason;
            rawNotice.confidence = classificationConfidence ?? undefined;
            rawNotice.classificationConfidence = classificationConfidence;
            rawNotice.sourceSpecificRule = effectiveRule;
            rawNotice.pageNumber = currentPageNumber;

            for (const doc of rawNotice.documents) {
              doc.sourceSpecificRule = doc.sourceSpecificRule || effectiveRule;
              doc.classificationConfidence =
                doc.classificationConfidence !== undefined
                  ? doc.classificationConfidence
                  : classificationConfidence;
              doc.evidence = {
                ...evidence,
                documentUrl: doc.url,
                sourceSpecificRule: doc.sourceSpecificRule,
                classificationConfidence: doc.classificationConfidence,
              };
            }

            allNotices.push(rawNotice);
            currentEndpointNoticesCount++;
            metrics.noticesDiscovered++;
          }

          // If single fixtureHtml or endpointFixtures provided without pageFixtures, do not crawl next pages
          if ((options.fixtureHtml !== undefined || epFixture !== undefined) && !options.pageFixtures) {
            break;
          }

          // Advance to next page URL
          currentPageNumber++;
          if (currentPageNumber <= endpointMaxPages && allNotices.length < maxNotices) {
            const nextLink = adapter.extractPaginationNextUrl(pageHtml, currentPageUrl);
            const generatedNext = adapter.getPageUrl(currentPageNumber, ep.url);
            currentPageUrl = nextLink || generatedNext;

            if (!currentPageUrl || seenPageUrls.has(currentPageUrl)) {
              break;
            }
          } else {
            break;
          }
        }

        if (currentEndpointNoticesCount > 0) {
          currentEndpointOutcome = 'ENDPOINT_SUCCESS';
        } else if (currentEndpointListingValid && currentEndpointNoticesCount === 0) {
          hadValidEmptyListing = true;
          currentEndpointOutcome = 'ENDPOINT_EMPTY_VALID';
        }
      } catch (err) {
        lastError = err as Error;
        currentEndpointOutcome = 'ENDPOINT_UNAVAILABLE';
        logger.warn('EXECUTOR_ENDPOINT_FAILED', {
          sourceId,
          endpointId: ep.endpointId,
          error: (err as Error).message,
        });
      }

      const currentEpClassification = classifyEndpointConnectivity({
        officialDomainVerified: currentOfficialDomainVerified,
        endpointReached: currentEndpointReached,
        httpStatus,
        finalUrl,
        listingValidated: currentEndpointListingValid,
        relevantNoticeFound: currentEndpointNoticesCount > 0,
        documentDiscovered: currentEndpointNoticesCount > 0,
        documentDownloaded: currentEndpointValidPdfs > 0,
        pdfValidated: currentEndpointValidPdfs > 0,
        structureChanged: currentEndpointOutcome === 'ENDPOINT_STRUCTURE_CHANGED',
        wrongContent: currentEndpointOutcome === 'ENDPOINT_WRONG_CONTENT',
        parseFailed: currentEndpointOutcome === 'ENDPOINT_PARSE_FAILED',
        accessBlocked: currentEndpointOutcome === 'ENDPOINT_BLOCKED',
        timeoutOccurred: currentLastDiagnostic?.errorType === 'TIMEOUT',
        errorType: currentLastDiagnostic?.errorType ?? null,
        downloadAttempted: shouldValidatePdfs && currentEndpointNoticesCount > 0,
      });

      // Record attempted endpoint telemetry
      const attemptLog: AttemptedEndpointLog = {
        endpointId: ep.endpointId,
        url: ep.url,
        priority: ep.endpointPriority,
        outcome: currentEndpointOutcome,
        endpointClassification: currentEpClassification,
        officialDomain: ep.officialDomain || ep.officialDomains[0] || adapter.officialDomains[0] || '',
        officialDomainVerified: currentOfficialDomainVerified,
        httpStatus,
        responseContentType: currentResponseContentType,
        responseBytes: currentResponseBytes,
        responseTimeMs: currentResponseTimeMs,
        noticesCount: currentEndpointNoticesCount,
        validPdfsCount: currentEndpointValidPdfs,
        reason: currentLastDiagnostic?.errorMessage || lastError?.message,
        redirectChain: currentRedirectChain,
        attemptsUsed: currentAttemptsUsed,
        retriesUsed: currentRetriesUsed,
        retryReasons: currentRetryReasons,
        retryDiagnostics: currentRetryDiagnostics,
        attemptDiagnostics: currentAttemptDiagnostics,
        lastErrorType: currentLastDiagnostic?.errorType ?? null,
        lastErrorCode: currentLastDiagnostic?.errorCode ?? null,
        lastErrorName: currentLastDiagnostic?.errorName ?? null,
        lastErrorMessage: currentLastDiagnostic?.errorMessage ?? null,
        lastErrorCause: currentLastDiagnostic?.cause ?? null,
        lastErrorRetryable: currentLastDiagnostic?.retryable ?? null,
      };
      metrics.attemptedEndpoints?.push(attemptLog);

      // Single-fixture mode (`options.fixtureHtml` without `endpointFixtures`): stop after first endpoint
      // UNLESS primary structure changed (so Suite 13 test 1 can observe primary log).
      if (options.fixtureHtml !== undefined && !options.endpointFixtures) {
        if (currentEndpointOutcome === 'ENDPOINT_SUCCESS' || currentEndpointOutcome === 'ENDPOINT_EMPTY_VALID') {
          successfulOutcome = currentEndpointOutcome;
        }
        break;
      }

      // Endpoint Fallback Criteria (Section 2 & 3):
      // Stop fallback loop immediately when an endpoint achieves valid evidence:
      // - In PDF validation mode (`shouldValidatePdfs`): requires `currentEndpointNoticesCount > 0 && currentEndpointValidPdfs > 0`
      // - In listing discovery mode: requires `currentEndpointNoticesCount > 0`
      const achievedEvidence = shouldValidatePdfs
        ? currentEndpointNoticesCount > 0 && currentEndpointValidPdfs > 0
        : currentEndpointNoticesCount > 0;

      if (achievedEvidence) {
        successfulOutcome = 'ENDPOINT_SUCCESS';
        if (!options.scanAllRegionalEndpoints) {
          break;
        }
      }

      if (currentEndpointOutcome === 'ENDPOINT_EMPTY_VALID') {
        hadValidEmptyListing = true;
      }

      if (epIndex < endpoints.length - 1) {
        logger.info('EXECUTOR_FALLBACK_TO_NEXT_ENDPOINT', {
          sourceId,
          failedOrEmptyEndpointId: ep.endpointId,
          outcome: currentEndpointOutcome,
          nextEndpointId: endpoints[epIndex + 1].endpointId,
        });
      }
    }

    if (!successfulOutcome && hadValidEmptyListing && allNotices.length === 0) {
      successfulOutcome = 'ENDPOINT_EMPTY_VALID';
      if (lastValidListingEndpoint) {
        selectedEndpoint = lastValidListingEndpoint;
        finalUrl = lastValidListingFinalUrl || lastValidListingEndpoint.url;
        metrics.selectedEndpointId = lastValidListingEndpoint.endpointId;
        metrics.selectedEndpointUrl = lastValidListingEndpoint.url;
      }
    } else if (!endpointReached && !lastValidListingEndpoint && endpoints.length > 0) {
      selectedEndpoint = endpoints[0];
      metrics.selectedEndpointId = endpoints[0].endpointId;
      metrics.selectedEndpointUrl = endpoints[0].url;
    }

    // Align top-level metrics.lastError* with the selected endpoint's actual telemetry
    const selectedAttemptLog =
      metrics.attemptedEndpoints?.find((l) => l.endpointId === selectedEndpoint?.endpointId) ||
      metrics.attemptedEndpoints?.[metrics.attemptedEndpoints.length - 1];
    if (!endpointReached && !lastValidListingEndpoint && selectedAttemptLog) {
      if (selectedAttemptLog.attemptsUsed !== undefined) {
        metrics.attempts = selectedAttemptLog.attemptsUsed;
        metrics.requestAttempts = selectedAttemptLog.attemptsUsed;
      }
      if (selectedAttemptLog.retriesUsed !== undefined) {
        metrics.retryCount = selectedAttemptLog.retriesUsed;
      }
      if (selectedAttemptLog.retryReasons) {
        metrics.retryReasons = selectedAttemptLog.retryReasons;
      }
      if (selectedAttemptLog.retryDiagnostics) {
        metrics.retryDiagnostics = selectedAttemptLog.retryDiagnostics;
      }
      if (selectedAttemptLog.attemptDiagnostics) {
        metrics.attemptDiagnostics = selectedAttemptLog.attemptDiagnostics;
      }
    }
    const effectiveLastDiag =
      endpointReached && listingValidated && allNotices.length === 0
        ? null
        : selectedAttemptLog?.lastErrorType
        ? {
            errorType: selectedAttemptLog.lastErrorType,
            errorCode: selectedAttemptLog.lastErrorCode ?? null,
            errorName: selectedAttemptLog.lastErrorName ?? null,
            errorMessage: selectedAttemptLog.lastErrorMessage ?? null,
            cause: selectedAttemptLog.lastErrorCause ?? null,
            retryable: selectedAttemptLog.lastErrorRetryable ?? null,
          }
        : lastErrorDiag
        ? {
            errorType: lastErrorDiag.errorType,
            errorCode: lastErrorDiag.errorCode,
            errorName: lastErrorDiag.errorName,
            errorMessage: lastErrorDiag.errorMessage,
            cause: lastErrorDiag.cause,
            retryable: lastErrorDiag.retryable,
          }
        : null;

    metrics.lastErrorType = effectiveLastDiag?.errorType ?? null;
    metrics.lastErrorCode = effectiveLastDiag?.errorCode ?? null;
    metrics.lastErrorName = effectiveLastDiag?.errorName ?? null;
    metrics.lastErrorMessage = effectiveLastDiag?.errorMessage ?? null;
    metrics.lastErrorCause = effectiveLastDiag?.cause ?? null;
    metrics.lastErrorRetryable = effectiveLastDiag?.retryable ?? null;

    metrics.durationMs = Date.now() - startTime;
    const totalDocs = allNotices.reduce((acc, n) => acc + n.documents.length, 0);
    metrics.pdfsValidated = metrics.validPdfs || 0;

    // 4. Evaluate Strict Live Verification Gate with Explicit detailRequired & detailResolved Semantics
    const hasDirectPdfNotice = allNotices.some(
      (n) => n.detailRequired === false && n.documents.length > 0
    );
    const hasDetailRequiredNotice = allNotices.some((n) => n.detailRequired === true);
    const detailRequired =
      allNotices.length > 0 && hasDetailRequiredNotice && !hasDirectPdfNotice;
    const detailResolvedValue: boolean | null = detailRequired
      ? allNotices.some((n) => n.detailRequired === true && n.detailResolved === true)
      : null;
    const documentFlow = detailRequired
      ? ('LISTING_TO_DETAIL_TO_DOCUMENT' as const)
      : ('LISTING_TO_DOCUMENT' as const);

    // Build concrete E2E evidence artifacts (Section 6)
    const verifiedNotice =
      allNotices.find((n) =>
        n.documents.some((d) => d.pdfDownloadStatus === 'PDF_DOWNLOADED_AND_VALIDATED')
      ) ||
      allNotices.find((n) => n.documents.length > 0) ||
      allNotices[0];
    const verifiedDoc =
      verifiedNotice?.documents.find(
        (d) => d.pdfDownloadStatus === 'PDF_DOWNLOADED_AND_VALIDATED'
      ) || verifiedNotice?.documents[0];

    const evidenceArtifacts: LiveVerificationEvidenceArtifacts = {
      endpointUrl: selectedEndpoint?.url || adapter.baseUrl || undefined,
      listingUrl:
        verifiedNotice?.evidence?.listingUrl ||
        finalUrl ||
        selectedEndpoint?.url ||
        undefined,
      noticeUrl: verifiedNotice?.rawNoticeUrl || undefined,
      detailUrl: verifiedNotice?.detailUrl || undefined,
      documentUrl: verifiedDoc?.url || undefined,
      documentSha256: verifiedDoc?.sha256 || undefined,
      pdfPageCount: verifiedDoc?.pageCount ?? undefined,
    };

    const effectiveOfficialDomain =
      selectedEndpoint?.officialDomain ||
      selectedEndpoint?.officialDomains[0] ||
      adapter.officialDomains[0] ||
      '';
    const effectiveOfficialDomainVerified = isOfficialDomain(
      selectedEndpoint?.url || adapter.baseUrl,
      sourceId
    ).allowed;

    const gateInput: LiveVerificationGateInput = {
      endpointReached,
      endpointValidated: endpointReached,
      officialDomainVerified: effectiveOfficialDomainVerified,
      listingValidated,
      relevantNoticeFound: allNotices.length > 0,
      detailRequired,
      detailResolved: detailResolvedValue,
      documentDiscovered: totalDocs > 0,
      documentDownloaded: (metrics.documentsDownloaded || 0) > 0,
      pdfValidated: (metrics.validPdfs || 0) > 0,
      responseSource: 'LIVE_EXECUTION',
      verificationMode,
      httpStatus,
      finalUrl,
      emptyPage: sawWrongContent && !listingValidated,
      wrongContent: sawWrongContent && !listingValidated,
      parseFailed: sawParseFailed && !listingValidated,
      structureChanged: sawStructureChanged && !listingValidated,
      accessBlocked: sawAccessBlocked && !(endpointReached && listingValidated && allNotices.length === 0),
      timeoutOccurred: sawTimeout && !endpointReached,
      httpError: sawHttpError && !endpointReached,
      networkErrorType:
        !endpointReached &&
        !sawTimeout &&
        !sawAccessBlocked &&
        !sawHttpError &&
        (effectiveLastDiag?.errorType === 'DNS_ERROR' ||
          effectiveLastDiag?.errorType === 'TLS_ERROR' ||
          effectiveLastDiag?.errorType === 'CONNECTION_RESET' ||
          effectiveLastDiag?.errorType === 'CONNECTION_REFUSED' ||
          effectiveLastDiag?.errorType === 'NETWORK_UNAVAILABLE' ||
          effectiveLastDiag?.errorType === 'UNKNOWN_NETWORK_ERROR')
          ? effectiveLastDiag.errorType
          : null,
      networkUnreachableInSandbox: false,
      downloadAttempted: (metrics.documentDownloadAttempts || 0) > 0,
      downloadFailed: sawDownloadFailed && (metrics.documentsDownloaded || 0) === 0,
      invalidMime: sawInvalidMime,
      invalidMagicBytes: sawInvalidMagicBytes,
      invalidPdf: sawInvalidPdf,
      evidence: evidenceArtifacts,
    };

    const gateDecision = evaluateLiveVerificationGate({
      ...gateInput,
      verificationMode:
        executionOrigin === 'MOCK_REMOTE' ? 'FIXTURE' : verificationMode,
    });
    if (
      sawAccessBlocked &&
      !(endpointReached && listingValidated && allNotices.length === 0) &&
      !gateDecision.failureReasons.includes('ACCESS_BLOCKED')
    ) {
      gateDecision.failureReasons.push('ACCESS_BLOCKED');
    }

    const remoteStatus: RemoteExecutionState = !remoteConfigured
      ? 'REMOTE_NOT_CONFIGURED'
      : remoteAccessStatus === 'SUCCESS'
      ? 'REMOTE_EXECUTED'
      : remoteAccessStatus === 'NOT_ATTEMPTED'
      ? 'REMOTE_UNAVAILABLE'
      : remoteAccessStatus === 'NETWORK_UNAVAILABLE' ||
        remoteAccessStatus === 'CONNECTION_REFUSED' ||
        remoteAccessStatus === 'REMOTE_UNAVAILABLE' ||
        remoteAccessStatus === 'UNREACHABLE'
      ? 'REMOTE_UNAVAILABLE'
      : 'REMOTE_FAILED';

    const failureClass =
      gateDecision.outcome === 'PASS'
        ? 'SUCCESS'
        : effectiveLastDiag?.errorType || machineFailureReason;

    metrics.officialDomain = effectiveOfficialDomain;
    metrics.officialDomainVerified = effectiveOfficialDomainVerified;
    metrics.endpointClassification = gateDecision.endpointClassification;
    metrics.responseContentType =
      selectedAttemptLog?.responseContentType ?? responseContentType;
    metrics.responseBytes = selectedAttemptLog?.responseBytes ?? responseBytes;
    metrics.responseTimeMs = selectedAttemptLog?.responseTimeMs ?? responseTimeMs;
    metrics.runnerMode = effectiveRunnerMode;
    metrics.selectedRunner = selectedRunner;
    metrics.actualRunner = actualRunner;
    metrics.runner = actualRunner;
    metrics.remoteStatus = remoteStatus;
    metrics.localAccess = localAccessStatus;
    metrics.remoteAccess = remoteAccessStatus;
    metrics.selectionReason = selectionReason;
    metrics.executionOrigin = executionOrigin;
    metrics.failureClass = failureClass;

    // 5. Map Final Status for DiscoveryExecutionResult
    let finalStatus: AdapterExecutionStatus;

    if (shouldValidatePdfs || options.strictLiveMode) {
      if (gateDecision.outcome === 'PASS') {
        finalStatus = 'PASS';
        machineFailureReason = 'NONE';
      } else if (gateDecision.status === 'SUCCESS_NO_RELEVANT_NOTICES') {
        finalStatus = 'SUCCESS_NO_RELEVANT_NOTICES';
        machineFailureReason = 'NO_RELEVANT_NOTICE';
      } else if (gateDecision.status === 'ADAPTER_STRUCTURE_CHANGED') {
        finalStatus = 'ADAPTER_STRUCTURE_CHANGED';
        machineFailureReason = 'ADAPTER_STRUCTURE_CHANGED';
      } else if (gateDecision.status === 'ENDPOINT_WRONG_CONTENT') {
        finalStatus = 'ENDPOINT_WRONG_CONTENT';
        machineFailureReason = 'WRONG_CONTENT';
      } else if (gateDecision.status === 'ENDPOINT_PARSE_FAILED') {
        finalStatus = 'ENDPOINT_PARSE_FAILED';
        machineFailureReason = 'PARSE_FAILED';
      } else if (gateDecision.status === 'DOCUMENT_DISCOVERY_FAILED') {
        finalStatus = 'DOCUMENT_DISCOVERY_FAILED';
        machineFailureReason = detailRequired && !detailResolvedValue ? 'DETAIL_NOT_RESOLVED' : 'DOCUMENT_NOT_FOUND';
      } else if (gateDecision.status === 'DOCUMENT_DOWNLOAD_FAILED') {
        finalStatus = 'DOCUMENT_DOWNLOAD_FAILED';
        machineFailureReason = 'DOCUMENT_DOWNLOAD_FAILED';
      } else if (gateDecision.status === 'PDF_VALIDATION_FAILED') {
        finalStatus = 'PDF_VALIDATION_FAILED';
        machineFailureReason = 'INVALID_PDF';
      } else if (gateDecision.status === 'ACCESS_BLOCKED') {
        finalStatus = 'ACCESS_BLOCKED';
        machineFailureReason = 'ACCESS_BLOCKED';
      } else if (gateDecision.status === 'SOURCE_UNAVAILABLE') {
        finalStatus = 'SOURCE_UNAVAILABLE';
      } else {
        finalStatus = 'INCONCLUSIVE';
      }
    } else {
      // Standard discovery mode without PDF download requirement
      if (allNotices.length > 0 && totalDocs > 0) {
        finalStatus = 'SUCCESS_WITH_NOTICES';
        machineFailureReason = 'NONE';
      } else if (allNotices.length > 0 && totalDocs === 0) {
        finalStatus = 'DOCUMENT_DISCOVERY_FAILED';
        machineFailureReason = detailRequired && !detailResolvedValue ? 'DETAIL_NOT_RESOLVED' : 'DOCUMENT_NOT_FOUND';
      } else if (successfulOutcome === 'ENDPOINT_EMPTY_VALID' || hadValidEmptyListing) {
        finalStatus = 'SUCCESS_NO_RELEVANT_NOTICES';
        machineFailureReason = 'NONE';
      } else if (sawStructureChanged) {
        finalStatus = 'ADAPTER_STRUCTURE_CHANGED';
        machineFailureReason = 'ADAPTER_STRUCTURE_CHANGED';
      } else if (sawWrongContent) {
        finalStatus = 'ENDPOINT_WRONG_CONTENT';
        machineFailureReason = 'WRONG_CONTENT';
      } else if (sawParseFailed) {
        finalStatus = 'ENDPOINT_PARSE_FAILED';
        machineFailureReason = 'PARSE_FAILED';
      } else if (sawAccessBlocked) {
        finalStatus = 'ACCESS_BLOCKED';
        machineFailureReason = 'ACCESS_BLOCKED';
      } else if (!endpointReached) {
        finalStatus = 'SOURCE_UNAVAILABLE';
        machineFailureReason = effectiveLastDiag?.errorType === 'DNS_ERROR'
          ? 'DNS_ERROR'
          : effectiveLastDiag?.errorType === 'TLS_ERROR'
          ? 'TLS_ERROR'
          : effectiveLastDiag?.errorType === 'CONNECTION_RESET'
          ? 'CONNECTION_RESET'
          : effectiveLastDiag?.errorType === 'CONNECTION_REFUSED'
          ? 'CONNECTION_REFUSED'
          : 'HTTP_TIMEOUT';
      } else {
        finalStatus = 'ADAPTER_STRUCTURE_CHANGED';
        machineFailureReason = 'ADAPTER_STRUCTURE_CHANGED';
      }
    }

    const overallEvidenceStage = gateDecision.pdfValidated
      ? ('PDF_VALIDATED' as const)
      : gateDecision.documentDownloaded
      ? ('DOCUMENT_DOWNLOADED' as const)
      : gateDecision.documentDiscovered
      ? ('DOCUMENT_URL_FOUND' as const)
      : gateDecision.relevantNoticeFound
      ? ('NOTICE_FOUND' as const)
      : ('NONE' as const);

    const effectiveErrorDiagnostic =
      endpointReached && listingValidated && allNotices.length === 0
        ? gateDecision.diagnostic
        : effectiveLastDiag?.errorMessage
        ? `Failed to fetch from ${sourceId} [${effectiveLastDiag.errorType}${
            effectiveLastDiag.errorCode ? ` (${effectiveLastDiag.errorCode})` : ''
          }]: ${effectiveLastDiag.errorMessage}`
        : lastError?.message || gateDecision.diagnostic;

    const structuredEvidence: StructuredLiveVerificationEvidence = {
      sourceId,
      endpointId: selectedEndpoint?.endpointId || 'unknown',
      requestedUrl: selectedEndpoint?.url || adapter.baseUrl,
      finalUrl,
      officialDomain: effectiveOfficialDomain,
      officialDomainVerified: effectiveOfficialDomainVerified,
      endpointClassification: gateDecision.endpointClassification,
      httpStatus,
      responseContentType: metrics.responseContentType,
      responseBytes: metrics.responseBytes,
      responseTimeMs: metrics.responseTimeMs,
      redirectChain: selectedAttemptLog?.redirectChain,
      endpointReached: gateDecision.endpointReached,
      endpointValidated: gateDecision.endpointValidated,
      listingValidated: gateDecision.listingValidated,
      relevantNoticeFound: gateDecision.relevantNoticeFound,
      detailRequired: gateDecision.detailRequired,
      detailResolved: gateDecision.detailResolved,
      documentFlow,
      documentDiscovered: gateDecision.documentDiscovered,
      documentDownloaded: gateDecision.documentDownloaded,
      pdfValidated: gateDecision.pdfValidated,
      evidenceStage: overallEvidenceStage,
      pagesAttempted: metrics.pagesRequested,
      pagesFetched: metrics.pagesCrawled,
      noticesDiscovered: metrics.noticesDiscovered,
      detailUrlsDiscovered: metrics.detailUrlsDiscovered || 0,
      detailRequestsAttempted: metrics.detailRequestsAttempted || 0,
      detailPagesFetched: metrics.detailPagesFetched || 0,
      detailPagesParsed: metrics.detailPagesParsed || 0,
      detailPagesWithDocuments: metrics.detailPagesWithDocuments || 0,
      documentUrlsDiscovered: metrics.documentUrlsDiscovered || 0,
      documentDownloadAttempts: metrics.documentDownloadAttempts || 0,
      documentsDownloaded: metrics.documentsDownloaded || 0,
      documentsValidated: metrics.documentsValidated || 0,
      invalidDocuments: metrics.invalidDocuments || 0,
      downloadFailures: metrics.downloadFailures || 0,
      pdfCandidates: metrics.pdfCandidates || 0,
      pdfDownloadAttempts: metrics.pdfDownloadAttempts || 0,
      pdfDownloadsSucceeded: metrics.pdfDownloadsSucceeded || 0,
      pdfValidationAttempts: metrics.pdfValidationAttempts || 0,
      validPdfs: metrics.validPdfs || 0,
      pdfsValidated: metrics.pdfsValidated || 0,
      invalidPdfs: metrics.invalidPdfs || 0,
      failedStages: Array.from(new Set(failedStages)),
      failureReasons: gateDecision.failureReasons,
      outcome: gateDecision.outcome,
      responseSource: 'LIVE_EXECUTION',
      verificationMode,
      verificationStatus: gateDecision.verificationStatus,
      evidence: gateDecision.evidence,
      startedAt,
      completedAt: new Date().toISOString(),
      failureReason: machineFailureReason,
      errorDiagnostic: effectiveErrorDiagnostic,
      finalStatus,
    };

    logger.info('EXECUTOR_DISCOVERY_COMPLETED', {
      sourceId,
      finalStatus,
      outcome: gateDecision.outcome,
      endpointClassification: gateDecision.endpointClassification,
      verificationMode,
      verificationStatus: gateDecision.verificationStatus,
      selectedEndpoint: selectedEndpoint?.endpointId,
      attemptedEndpointsCount: metrics.attemptedEndpoints?.length,
      noticesDiscovered: metrics.noticesDiscovered,
      detailRequired: gateDecision.detailRequired,
      detailResolved: gateDecision.detailResolved,
      documentsDownloaded: metrics.documentsDownloaded,
      validPdfs: metrics.validPdfs,
      lastErrorType: metrics.lastErrorType,
      lastErrorCode: metrics.lastErrorCode,
      failureReasons: gateDecision.failureReasons,
    });

    const isCleanSuccess =
      finalStatus === 'PASS' ||
      finalStatus === 'SUCCESS_WITH_NOTICES' ||
      finalStatus === 'SUCCESS_NO_RELEVANT_NOTICES';

    const result: DiscoveryExecutionResult = {
      sourceId,
      authorityName: adapter.name,
      primaryEndpoint: primaryEndpoint.url,
      officialDomain: effectiveOfficialDomain,
      officialDomainVerified: effectiveOfficialDomainVerified,
      endpointClassification: gateDecision.endpointClassification,
      responseContentType: metrics.responseContentType,
      responseBytes: metrics.responseBytes,
      responseTimeMs: metrics.responseTimeMs,
      status: finalStatus,
      outcome: gateDecision.outcome,
      technicalFailure: gateDecision.outcome === 'FAIL',
      responseSource: 'LIVE_EXECUTION',
      verificationMode,
      verificationStatus: gateDecision.verificationStatus,
      detailRequired: gateDecision.detailRequired,
      detailResolved: gateDecision.detailResolved,
      documentFlow,
      evidence: gateDecision.evidence,
      failureReasons: gateDecision.failureReasons,
      verificationEvidence: structuredEvidence,
      verifiedLive,
      fixtureSource,
      runnerMode: effectiveRunnerMode,
      selectedRunner,
      actualRunner,
      runner: actualRunner,
      remoteStatus,
      localAccess: localAccessStatus,
      remoteAccess: remoteAccessStatus,
      selectionReason,
      executionOrigin,
      failureClass,
      startedAt,
      completedAt: new Date().toISOString(),
      httpStatus,
      finalUrl,
      recordsFound: allNotices.length,
      documentsFound: totalDocs,
      ignoredCount: 0,
      notices: allNotices,
      metrics,
      cached: false,
      cacheState: 'LIVE',
      errorCode: isCleanSuccess ? null : effectiveLastDiag?.errorCode || machineFailureReason,
      errorType: isCleanSuccess ? null : effectiveLastDiag?.errorType ?? null,
      errorName: isCleanSuccess ? null : effectiveLastDiag?.errorName ?? null,
      errorCause: isCleanSuccess ? null : effectiveLastDiag?.cause ?? null,
      errorMessage: isCleanSuccess ? null : effectiveErrorDiagnostic,
      lastErrorType: isCleanSuccess ? null : effectiveLastDiag?.errorType ?? null,
      lastErrorCode: isCleanSuccess ? null : effectiveLastDiag?.errorCode ?? null,
      lastErrorMessage: isCleanSuccess ? null : effectiveLastDiag?.errorMessage ?? null,
    };

    // Cache results for production discovery
    discoveryCache.set(
      cacheKey,
      sourceId,
      selectedEndpoint?.url || adapter.baseUrl,
      adapter.adapterVersion,
      result,
      options.cacheTtlMs
    );

    return result;
  }
}

let executorInstance: DiscoveryExecutor | null = null;
export function getDiscoveryExecutor(): DiscoveryExecutor {
  if (!executorInstance) {
    executorInstance = new DiscoveryExecutor();
  }
  return executorInstance;
}
