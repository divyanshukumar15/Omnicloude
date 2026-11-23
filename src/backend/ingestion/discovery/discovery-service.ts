/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { RepositoryContainer } from '../../database/index.ts';
import { getRepositories } from '../../database/index.ts';
import { sourceRegistry } from '../adapters/registry.ts';
import type {
  DiscoveryExecutionResult,
  DiscoveryOptions,
  NormalizedNotice,
  DiscoveredDocumentLink,
  MultiSourceDiscoverySummary,
} from './types.ts';
import type { SourceDiscoveryRunEntity } from '../../database/types.ts';
import { DocumentDownloader } from '../downloader/document-downloader.ts';
import { PdfValidator } from '../pdf/pdf-validator.ts';
import { OcrOrchestrator } from '../ocr/ocr-orchestrator.ts';
import { ProvenanceService } from '../provenance/provenance-service.ts';
import { StructuredExtractionService } from '../../extraction/extraction-service.ts';
import { EvidenceValidator } from '../../extraction/evidence-validator.ts';
import { DeduplicationService } from '../../deduplication/deduplication-service.ts';
import { PublishingGate } from '../../publishing-gate/publishing-gate.ts';
import { getDiscoveryExecutor } from './discovery-executor.ts';
import {
  evaluateLiveVerificationGate,
  classifyEndpointConnectivity,
  type EndpointClassification,
  type LiveVerificationOutcome,
  type StrictVerificationFailureReason,
  type VerificationExecutionMode,
  type VerificationProofStatus,
  type LiveVerificationEvidenceArtifacts,
} from './verification-gate.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';
import {
  configureGlobalFetchDispatcher,
  resolveConnectionTimeoutMs,
} from './http-dispatcher.ts';
import {
  classifyFailureTaxonomy,
  deriveConnectivityStatuses,
  probeEndpointConnectivity,
  probeRrbRegionalNetwork,
  type ConnectionProbeStatus,
  type DnsProbeStatus,
  type TcpProbeStatus,
  type TlsProbeStatus,
  type EndpointConnectivityProbeResult,
  type RrbRegionalBoardProbeRecord,
  type RrbRegionalClassification,
  type SourceFailureClassification,
} from './connectivity-diagnostics.ts';
import {
  type RunnerMode,
  type RunnerKind,
  type AcquisitionExecutionOrigin,
  type SourceRuntimeCapabilities,
  type RuntimeAccessibilityState,
  type OfficialEndpointVerificationState,
  type RuntimeAccessDiagnosticState,
  type RunnerHealthReport,
  type SourceAccessHealthRecord,
  type RunnerAccessOutcome,
  type RemoteExecutionState,
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
  evaluateSourceRuntimeCapabilities,
} from './acquisition-runner.ts';

const INITIAL_GLOBAL_FETCH = globalThis.fetch;

export {
  evaluateLiveVerificationGate,
  classifyEndpointConnectivity,
  evaluateSourceRuntimeCapabilities,
  type EndpointClassification,
  type ConnectionProbeStatus,
  type DnsProbeStatus,
  type TcpProbeStatus,
  type TlsProbeStatus,
  type RrbRegionalBoardProbeRecord,
  type RrbRegionalClassification,
  type SourceFailureClassification,
  type RunnerMode,
  type RunnerKind,
  type AcquisitionExecutionOrigin,
  type SourceRuntimeCapabilities,
  type RuntimeAccessibilityState,
  type OfficialEndpointVerificationState,
  type RuntimeAccessDiagnosticState,
  type RunnerHealthReport,
  type SourceAccessHealthRecord,
  type RunnerAccessOutcome,
  type RemoteExecutionState,
};

export interface IngestDiscoveredDocumentResult {
  sdocId: string;
  documentId: string;
  recruitmentId?: string;
  status: string;
  validationStatus: string;
  publishingState?: string;
}

export interface LiveSourceVerificationItem {
  source: string;
  sourceId: string;
  primaryEndpoint?: string;
  officialDomain: string;
  officialDomainVerified?: boolean;
  endpointClassification?: EndpointClassification;
  authorityName: string;
  adapterVersion: string;
  selectedEndpointId?: string;
  requestedEndpoint: string;
  finalUrl: string | null;
  httpStatus: number | null;
  responseContentType?: string | null;
  responseBytes?: number | null;
  responseTimeMs?: number | null;
  endpointsReached: number;
  listingPagesValidated: number;
  pagesCrawled: number;
  noticesFound: number;
  recruitmentsFound: number;
  detailUrlsDiscovered: number;
  detailPagesFetched: number;
  detailPagesResolved: number;
  documentsFound: number;
  documentsDownloaded: number;
  validPdfs: number;
  pdfsValidated: number;
  pdfCandidates: number;
  // Section 6: Required E2E Verification Fields
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
  responseSource: 'LIVE_EXECUTION' | 'CACHED_RESULT';
  verificationMode: VerificationExecutionMode;
  mode: VerificationExecutionMode;
  fixtureSource: boolean;
  verificationStatus: VerificationProofStatus;
  verifiedLive: boolean;
  resultState: LiveVerificationOutcome;
  errorDiagnostic: string;
  listingReachable: boolean;
  listingParsed: boolean;
  relevantNoticeDetection: boolean;
  detailPageReachable: boolean;
  documentDiscovery: boolean;
  documentValidation: boolean;
  paginationObserved: boolean;
  status: LiveVerificationOutcome;
  reason: string;
  durationMs: number;
  pagesChecked: number;
  officialDocumentsFound: number;
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRetries?: number;
  attempts?: number;
  requestAttempts?: number;
  failedStage?: string;
  finalFailureStage?: string;
  technicalFailure?: boolean;
  errorType?: string | null;
  errorCode?: string | null;
  retriesUsed?: number;
  retryReasons?: string[];
  retryDiagnostics?: Array<{
    attempt: number;
    maxAttempts: number;
    reason: string;
    errorType?: string;
    errorCode?: string | null;
    errorMessage?: string;
    cause?: string | null;
    statusCode: number | null;
    retryable?: boolean;
    delayMs: number;
  }>;
  attemptDiagnostics?: Array<{
    attempt: number;
    maxAttempts: number;
    reason: string;
    errorType?: string;
    errorCode?: string | null;
    errorMessage?: string;
    cause?: string | null;
    statusCode: number | null;
    retryable?: boolean;
    delayMs: number;
  }>;
  lastErrorType?: string | null;
  lastErrorCode?: string | null;
  lastErrorName?: string | null;
  lastErrorMessage?: string | null;
  lastErrorCause?: string | null;
  lastErrorRetryable?: boolean | null;
  redirectChain?: string[];
  downloadStatus?: string;
  pdfValidationStatus?: string;
  dnsStatus: DnsProbeStatus;
  resolvedIps: string[];
  tcpStatus: TcpProbeStatus;
  tlsStatus: TlsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  region: string;
  failureClassification: SourceFailureClassification;
  regionalProbes?: RrbRegionalBoardProbeRecord[];
  runnerMode?: RunnerMode;
  selectedRunner?: RunnerKind;
  actualRunner?: RunnerKind;
  runner?: RunnerKind;
  remoteStatus?: RemoteExecutionState;
  failureClass?: string;
  localAccess?: RunnerAccessOutcome | string;
  remoteAccess?: RunnerAccessOutcome | string;
  selectionReason?: string;
  executionOrigin?: AcquisitionExecutionOrigin;
  runtimeCapabilities?: SourceRuntimeCapabilities;
  runtimeAccessibility?: RuntimeAccessibilityState;
  officialEndpointStatus?: OfficialEndpointVerificationState;
  runtimeAccessStatus?: RuntimeAccessDiagnosticState;
  timestamps: {
    startedAt: string;
    completedAt: string;
  };
}

export const DEFAULT_LIVE_TIMEOUT_MS = 15000;
export const DEFAULT_LIVE_CONNECTION_TIMEOUT_MS = 15000;
export const DEFAULT_LIVE_MAX_RETRIES = 2;
export const DEFAULT_LIVE_RETRY_BACKOFF_MS = 500;

export interface LiveVerificationRuntimeConfig {
  timeoutMs: number;
  connectionTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  verbose: boolean;
  validationWarnings: string[];
  envVars: {
    timeoutEnvVar: 'OMNIHUB_LIVE_TIMEOUT_MS';
    connectionTimeoutEnvVar: 'OMNIHUB_LIVE_CONNECT_TIMEOUT_MS';
    maxRetriesEnvVar: 'OMNIHUB_LIVE_MAX_RETRIES';
    retryBackoffEnvVar: 'OMNIHUB_LIVE_RETRY_BACKOFF_MS';
  };
}

export function resolveLiveVerificationRuntimeConfig(
  overrides: {
    timeoutMs?: number;
    connectionTimeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    verbose?: boolean;
  } = {}
): LiveVerificationRuntimeConfig {
  const validationWarnings: string[] = [];

  // 1. Validate OMNIHUB_LIVE_TIMEOUT_MS environment variable
  let defaultTimeout = DEFAULT_LIVE_TIMEOUT_MS;
  const rawTimeoutEnv = process.env.OMNIHUB_LIVE_TIMEOUT_MS;
  if (rawTimeoutEnv !== undefined && rawTimeoutEnv.trim() !== '') {
    const parsedTimeout = Number(rawTimeoutEnv.trim());
    if (!Number.isFinite(parsedTimeout) || !Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
      validationWarnings.push(
        `Invalid OMNIHUB_LIVE_TIMEOUT_MS="${rawTimeoutEnv}" rejected; using safe default ${DEFAULT_LIVE_TIMEOUT_MS}ms`
      );
      defaultTimeout = DEFAULT_LIVE_TIMEOUT_MS;
    } else if (parsedTimeout < 1000 || parsedTimeout > 30000) {
      const clamped = Math.min(Math.max(1000, parsedTimeout), 30000);
      validationWarnings.push(
        `OMNIHUB_LIVE_TIMEOUT_MS=${parsedTimeout} clamped to bounded range [1000..30000]: ${clamped}ms`
      );
      defaultTimeout = clamped;
    } else {
      defaultTimeout = parsedTimeout;
    }
  }

  let timeoutMs = defaultTimeout;
  if (overrides.timeoutMs !== undefined) {
    if (
      typeof overrides.timeoutMs !== 'number' ||
      !Number.isFinite(overrides.timeoutMs) ||
      overrides.timeoutMs <= 0
    ) {
      validationWarnings.push(
        `Invalid timeoutMs override (${String(overrides.timeoutMs)}) rejected; using ${defaultTimeout}ms`
      );
      timeoutMs = defaultTimeout;
    } else {
      timeoutMs = Math.min(Math.max(50, Math.floor(overrides.timeoutMs)), 30000);
    }
  }

  // 1b. Validate OMNIHUB_LIVE_CONNECT_TIMEOUT_MS environment variable (must be <= timeoutMs)
  let defaultConnectTimeout = timeoutMs;
  const rawConnectTimeoutEnv = process.env.OMNIHUB_LIVE_CONNECT_TIMEOUT_MS;
  if (rawConnectTimeoutEnv !== undefined && rawConnectTimeoutEnv.trim() !== '') {
    const parsedConnectTimeout = Number(rawConnectTimeoutEnv.trim());
    if (
      !Number.isFinite(parsedConnectTimeout) ||
      !Number.isInteger(parsedConnectTimeout) ||
      parsedConnectTimeout <= 0
    ) {
      validationWarnings.push(
        `Invalid OMNIHUB_LIVE_CONNECT_TIMEOUT_MS="${rawConnectTimeoutEnv}" rejected; using ${timeoutMs}ms`
      );
      defaultConnectTimeout = timeoutMs;
    } else {
      defaultConnectTimeout = resolveConnectionTimeoutMs(timeoutMs, parsedConnectTimeout);
    }
  }

  let connectionTimeoutMs = defaultConnectTimeout;
  if (overrides.connectionTimeoutMs !== undefined) {
    if (
      typeof overrides.connectionTimeoutMs !== 'number' ||
      !Number.isFinite(overrides.connectionTimeoutMs) ||
      overrides.connectionTimeoutMs <= 0
    ) {
      validationWarnings.push(
        `Invalid connectionTimeoutMs override (${String(overrides.connectionTimeoutMs)}) rejected; using ${defaultConnectTimeout}ms`
      );
      connectionTimeoutMs = defaultConnectTimeout;
    } else {
      connectionTimeoutMs = resolveConnectionTimeoutMs(timeoutMs, overrides.connectionTimeoutMs);
    }
  } else {
    connectionTimeoutMs = resolveConnectionTimeoutMs(timeoutMs, defaultConnectTimeout);
  }

  // Apply connectionTimeoutMs and timeoutMs to the Node fetch / Undici global dispatcher
  configureGlobalFetchDispatcher(timeoutMs, connectionTimeoutMs);

  // 2. Validate OMNIHUB_LIVE_MAX_RETRIES environment variable
  let defaultRetries = DEFAULT_LIVE_MAX_RETRIES;
  const rawRetriesEnv = process.env.OMNIHUB_LIVE_MAX_RETRIES;
  if (rawRetriesEnv !== undefined && rawRetriesEnv.trim() !== '') {
    const parsedRetries = Number(rawRetriesEnv.trim());
    if (!Number.isFinite(parsedRetries) || !Number.isInteger(parsedRetries) || parsedRetries < 0) {
      validationWarnings.push(
        `Invalid OMNIHUB_LIVE_MAX_RETRIES="${rawRetriesEnv}" rejected; using safe default ${DEFAULT_LIVE_MAX_RETRIES}`
      );
      defaultRetries = DEFAULT_LIVE_MAX_RETRIES;
    } else if (parsedRetries > 3) {
      validationWarnings.push(
        `OMNIHUB_LIVE_MAX_RETRIES=${parsedRetries} clamped to bounded maximum 3`
      );
      defaultRetries = 3;
    } else {
      defaultRetries = parsedRetries;
    }
  }

  let maxRetries = defaultRetries;
  if (overrides.maxRetries !== undefined) {
    if (
      typeof overrides.maxRetries !== 'number' ||
      !Number.isFinite(overrides.maxRetries) ||
      !Number.isInteger(overrides.maxRetries) ||
      overrides.maxRetries < 0
    ) {
      validationWarnings.push(
        `Invalid maxRetries override (${String(overrides.maxRetries)}) rejected; using ${defaultRetries}`
      );
      maxRetries = defaultRetries;
    } else {
      maxRetries = Math.min(Math.max(0, overrides.maxRetries), 3);
    }
  }

  // 3. Validate OMNIHUB_LIVE_RETRY_BACKOFF_MS environment variable
  let defaultBackoff = DEFAULT_LIVE_RETRY_BACKOFF_MS;
  const rawBackoffEnv = process.env.OMNIHUB_LIVE_RETRY_BACKOFF_MS;
  if (rawBackoffEnv !== undefined && rawBackoffEnv.trim() !== '') {
    const parsedBackoff = Number(rawBackoffEnv.trim());
    if (!Number.isFinite(parsedBackoff) || !Number.isInteger(parsedBackoff) || parsedBackoff <= 0) {
      validationWarnings.push(
        `Invalid OMNIHUB_LIVE_RETRY_BACKOFF_MS="${rawBackoffEnv}" rejected; using safe default ${DEFAULT_LIVE_RETRY_BACKOFF_MS}ms`
      );
      defaultBackoff = DEFAULT_LIVE_RETRY_BACKOFF_MS;
    } else {
      defaultBackoff = Math.min(Math.max(50, parsedBackoff), 5000);
    }
  }

  let retryBackoffMs = defaultBackoff;
  if (overrides.retryBackoffMs !== undefined) {
    if (
      typeof overrides.retryBackoffMs !== 'number' ||
      !Number.isFinite(overrides.retryBackoffMs) ||
      overrides.retryBackoffMs <= 0
    ) {
      validationWarnings.push(
        `Invalid retryBackoffMs override (${String(overrides.retryBackoffMs)}) rejected; using ${defaultBackoff}ms`
      );
      retryBackoffMs = defaultBackoff;
    } else {
      retryBackoffMs = Math.min(Math.max(10, Math.floor(overrides.retryBackoffMs)), 5000);
    }
  }

  const verbose =
    overrides.verbose ??
    (process.env.OMNIHUB_LIVE_VERBOSE === 'true' || process.env.OMNIHUB_LIVE_VERBOSE === '1');

  return {
    timeoutMs,
    connectionTimeoutMs,
    maxRetries,
    retryBackoffMs,
    verbose,
    validationWarnings,
    envVars: {
      timeoutEnvVar: 'OMNIHUB_LIVE_TIMEOUT_MS',
      connectionTimeoutEnvVar: 'OMNIHUB_LIVE_CONNECT_TIMEOUT_MS',
      maxRetriesEnvVar: 'OMNIHUB_LIVE_MAX_RETRIES',
      retryBackoffEnvVar: 'OMNIHUB_LIVE_RETRY_BACKOFF_MS',
    },
  };
}

export type RuntimeProofCategory =
  | 'REAL_LIVE_PROOF'
  | 'MOCK_REMOTE_PROOF'
  | 'FIXTURE_PROOF'
  | 'CACHE_PROOF'
  | 'NOT_EXECUTED';

const SOURCE_AUDIT_EVIDENCE: Record<string, string> = {
  'IN-CENTRAL-SSC':
    'Official SSC API (https://ssc.gov.in/api/general-website/portal/records and notice-boards) reachable over HTTPS; returns JSON notices with direct official PDFs.',
  'IN-CENTRAL-UPSC':
    'Bare upsc.gov.in (164.100.229.104) times out behind NIC origin firewall; canonical Akamai-fronted https://www.upsc.gov.in (23.46.63.242) responds HTTP 200 with Drupal .views-row items -> /whats-new/* detail pages -> /sites/default/files/*.pdf.',
  'IN-CENTRAL-RRB':
    'Multi-board regional probe across all 21 official RRB boards + legacy Allahabad & Centralised Apply portal (23 endpoints): 16 regional boards time out at TCP port 443 (ETIMEDOUT); rrbald.gov.in & rrbranchi.gov.in complete TCP connect then fail TLS certificate validation (CERT_HAS_EXPIRED); rrbbbs.gov.in returns TCP ECONNREFUSED; rrbbhopal.gov.in, rrbprayagraj.gov.in & rrbthiruvananthapuram.gov.in fail DNS; www.rrbapply.gov.in completes TLS 1.3 via CloudFront but returns HTTP 404 Angular SPA shell across all routes (NOT_A_RECRUITMENT_ENDPOINT).',
  'IN-BIHAR-BPSC':
    'Official Bihar portal https://bpsc.bih.nic.in (164.100.251.54) and /NoticeHeader.htm resolve DNS then drop TCP SYN packets on port 443 (ETIMEDOUT); alternate https://bpsc.bihar.gov.in and https://onlinebpsc.bihar.gov.in complete TCP SYN-ACK then reset TLS connections after ClientHello (ECONNRESET).',
  'IN-BIHAR-BSSC':
    'Official Bihar portal https://bssc.bihar.gov.in and /NoticeBoard.htm resolve DNS to Bihar State Data Centre IPs (103.55.73.122, 164.100.130.68), complete TCP SYN-ACK on port 443, then fail TLS handshake with socket reset/timeout (ECONNRESET).',
  'IN-UP-UPPSC':
    'Official UPPSC portal https://uppsc.up.nic.in and /AllNotifications.aspx respond HTTP 200 over HTTPS with direct /Open_PDF.aspx?I4PnQ0tBagk=... official PDF streams.',
  'IN-UP-UPSSSC':
    'Official UPSSSC portal https://upsssc.gov.in (164.100.181.99) and /AllNotifications.aspx resolve DNS cleanly then drop TCP SYN packets on port 443 from external cloud egress (ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT).',
};

export interface RealLiveSourceVerificationResult {
  source: string;
  sourceId: string;
  region: string;
  authorityName: string;
  endpoint: string;
  primaryEndpoint: string;
  officialDomain: string;
  officialDomainVerified: boolean;
  endpointClassification: EndpointClassification;
  failureClassification: SourceFailureClassification;
  dnsStatus: DnsProbeStatus;
  resolvedIps: string[];
  tcpStatus: TcpProbeStatus;
  tlsStatus: TlsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  classificationEvidence: string;
  proofType: RuntimeProofCategory;
  mode: VerificationExecutionMode;
  verificationMode: VerificationExecutionMode;
  fixtureSource: boolean;
  verifiedLive: boolean;
  endpointUrl: string;
  endpointReached: boolean;
  listingFetched: boolean;
  listingParsed: boolean;
  listingValidated: boolean;
  relevantNoticeFound: boolean;
  relevantNotices: number;
  detailRequired: boolean;
  detailResolved: boolean | null;
  documentDiscovered: boolean;
  documentsDiscovered: number;
  documentDownloaded: boolean;
  documentsDownloaded: number;
  pdfValidated: boolean;
  validPdfs: number;
  evidenceValidated: boolean;
  outcome: LiveVerificationOutcome;
  finalStatus: LiveVerificationOutcome;
  failureReason: string | null;
  failureDetails: string | null;
  technicalFailure: boolean;
  errorType: string | null;
  errorCode: string | null;
  failedStage: string;
  finalFailureStage: string;
  failureReasons: StrictVerificationFailureReason[];
  regionalProbes?: RrbRegionalBoardProbeRecord[];
  timeoutMs: number;
  requestTimeoutMs: number;
  connectionTimeoutMs: number;
  maxRetries: number;
  attempts: number;
  requestAttempts: number;
  retriesUsed: number;
  retryReasons: string[];
  retryDiagnostics: Array<{
    attempt: number;
    maxAttempts: number;
    reason: string;
    errorType?: string;
    errorCode?: string | null;
    errorMessage?: string;
    cause?: string | null;
    statusCode: number | null;
    retryable?: boolean;
    delayMs: number;
  }>;
  attemptDiagnostics: Array<{
    attempt: number;
    maxAttempts: number;
    reason: string;
    errorType?: string;
    errorCode?: string | null;
    errorMessage?: string;
    cause?: string | null;
    statusCode: number | null;
    retryable?: boolean;
    delayMs: number;
  }>;
  lastErrorType: string | null;
  lastErrorCode: string | null;
  lastErrorName: string | null;
  lastErrorMessage: string | null;
  lastErrorCause: string | null;
  lastErrorRetryable: boolean | null;
  durationMs: number;
  noticeUrl: string | null;
  detailUrl: string | null;
  documentUrl: string | null;
  sha256: string | null;
  pageCount: number | null;
  evidence: LiveVerificationEvidenceArtifacts;
  timestamps: {
    startedAt: string;
    completedAt: string;
  };
  diagnostic: string;
  // Safe verbose diagnostic fields (never includes secrets)
  requestUrl: string;
  httpStatus: number | null;
  responseContentType: string | null;
  responseBytes: number | null;
  responseTimeMs: number | null;
  redirectChain: string[];
  adapterSelected: string;
  noticeCount: number;
  documentCount: number;
  documentsDownloadedCount: number;
  validPdfsCount: number;
  downloadStatus: string;
  pdfValidationStatus: string;
  // Section 2, 3, 7 & 12: Runner & Runtime Capability Diagnostics
  runnerMode: RunnerMode;
  selectedRunner: RunnerKind;
  actualRunner: RunnerKind;
  runner: RunnerKind;
  remoteStatus: RemoteExecutionState;
  failureClass: string;
  localAccess: RunnerAccessOutcome | string;
  remoteAccess: RunnerAccessOutcome | string;
  selectionReason: string;
  executionOrigin: AcquisitionExecutionOrigin;
  runtimeCapabilities: SourceRuntimeCapabilities;
  runtimeAccessibility: RuntimeAccessibilityState;
  officialEndpointStatus: OfficialEndpointVerificationState;
  runtimeAccessStatus: RuntimeAccessDiagnosticState;
}

export interface RealLiveVerificationSummary {
  startedAt: string;
  completedAt: string;
  runtimeConfig: LiveVerificationRuntimeConfig;
  runnerMode: RunnerMode;
  runnerHealth: RunnerHealthReport;
  sourcesChecked: number;
  totalSources: number;
  liveExecutionCount: number;
  passCount: number;
  inconclusiveCount: number;
  failCount: number;
  notRunCount: number;
  realLiveLocalPassCount: number;
  realLiveRemotePassCount: number;
  realRemoteLocalWorkerPassCount: number;
  realRemoteProductionPassCount: number;
  realLivePassCount: number;
  realLiveFailCount: number;
  realLiveInconclusiveCount: number;
  realPdfProofCount: number;
  mockRemotePassCount: number;
  REAL_REMOTE_LOCAL_WORKER: 'PROVEN' | 'NOT_PROVEN';
  REAL_REMOTE_PRODUCTION: 'PROVEN' | 'NOT_PROVEN';
  proofCounts: {
    REAL_LIVE_LOCAL_PASS: number;
    REAL_LIVE_REMOTE_PASS: number;
    REAL_REMOTE_LOCAL_WORKER_PASS?: number;
    REAL_REMOTE_PRODUCTION_PASS?: number;
    REAL_LIVE_PASS: number;
    REAL_LIVE_FAIL: number;
    REAL_LIVE_INCONCLUSIVE: number;
    REAL_PDF_PROOF_COUNT: number;
    MOCK_REMOTE_PASS: number;
    FIXTURE_PASS: number;
    CACHE_RESULT: number;
    NOT_EXECUTED: number;
  };
  relevantNoticeCount: number;
  documentDownloadCount: number;
  validPdfCount: number;
  totalDurationMs: number;
  successfulWithNotices: number;
  successfulEmpty: number;
  technicalFailures: number;
  fixtureExecutionCount: number;
  cachedExecutionCount: number;
  mockRemoteExecutionCount: number;
  exitCode: 0 | 1 | 2 | 3;
  results: RealLiveSourceVerificationResult[];
}

export function computeLiveVerificationExitCode(
  summary: Pick<
    RealLiveVerificationSummary,
    'totalSources' | 'passCount' | 'inconclusiveCount' | 'failCount' | 'notRunCount'
  > & { technicalFailures?: number }
): 0 | 1 | 2 | 3 {
  if (!summary || summary.totalSources <= 0 || summary.notRunCount > 0) {
    return 2;
  }
  if (summary.failCount > 0 || (summary.technicalFailures ?? 0) > 0) {
    return 1;
  }
  return 0;
}

export interface LiveVerificationReport {
  startedAt: string;
  completedAt: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  totalSources: number;
  passedCount: number;
  failedCount: number;
  inconclusiveCount: number;
  passCount: number;
  failCount: number;
  liveExecutionCount: number;
  items: LiveSourceVerificationItem[];
}

export class DiscoveryService {
  private repos: RepositoryContainer;
  private downloader: DocumentDownloader;
  private pdfValidator: PdfValidator;
  private ocrOrchestrator: OcrOrchestrator;
  private provenanceService: ProvenanceService;
  private extractionService: StructuredExtractionService;
  private deduplicationService: DeduplicationService;

  constructor(repos?: RepositoryContainer) {
    this.repos = repos || getRepositories();
    this.downloader = new DocumentDownloader();
    this.pdfValidator = new PdfValidator();
    this.ocrOrchestrator = new OcrOrchestrator();
    this.provenanceService = new ProvenanceService(this.repos.documents, this.repos.evidence);
    this.extractionService = new StructuredExtractionService();
    this.deduplicationService = new DeduplicationService();
  }

  /**
   * Discovers recruitment notices from a specific official government source.
   */
  async discoverSource(
    sourceId: string,
    options: DiscoveryOptions = {}
  ): Promise<DiscoveryExecutionResult> {
    const adapter = sourceRegistry.get(sourceId);
    if (!adapter) {
      throw new Error(`Unregistered source adapter: ${sourceId}`);
    }

    // Ensure source record exists in database
    let sourceRecord = this.repos.sources.findById(sourceId);
    if (!sourceRecord) {
      sourceRecord = this.repos.sources.create({
        id: sourceId,
        name: adapter.name,
        type: 'PORTAL',
        base_url: adapter.baseUrl,
        is_active: 1,
        check_interval_minutes: 60,
        config_json: '{}',
      });
    }

    const correlationId = options.correlationId || crypto.randomUUID();
    logger.info(`Starting official source discovery for ${sourceId}`, {
      sourceId,
      correlationId,
      fixtureMode: options.fixtureHtml !== undefined || !!options.pageFixtures,
    });

    const executor = getDiscoveryExecutor();
    const execution = await executor.execute(sourceId, {
      ...options,
      maxNotices: options.maxNotices ?? options.limit,
      correlationId,
    });

    // Persist discovery run in database
    const runId = crypto.randomUUID();
    const runRecord: SourceDiscoveryRunEntity = {
      id: runId,
      source_id: sourceId,
      started_at: execution.startedAt,
      completed_at: execution.completedAt,
      http_status: execution.httpStatus,
      final_url: execution.finalUrl,
      records_found: execution.recordsFound,
      documents_found: execution.documentsFound,
      adapter_status: execution.status,
      error_code: execution.errorCode || null,
      error_message: execution.errorMessage || null,
      metrics_json: JSON.stringify(execution.metrics),
    };

    this.repos.sourceDiscoveryRuns.create(runRecord);

    // Save newly discovered documents into source_documents table with discovery evidence
    for (const notice of execution.notices) {
      for (const doc of notice.documents) {
        const docId = `sdoc-${crypto.createHash('sha256').update(doc.url).digest('hex').slice(0, 16)}`;
        const existing = this.repos.sourceDocuments.findById(docId);
        if (!existing) {
          this.repos.sourceDocuments.create({
            id: docId,
            source_id: sourceId,
            url: doc.url,
            title: doc.title,
            document_type: doc.isPrimaryNotification ? 'PRIMARY_NOTIFICATION_PDF' : 'NOTICE_DOCUMENT',
            raw_hash: null,
            status: 'DISCOVERED',
            metadata_json: JSON.stringify({
              advertisementNumber: notice.advertisementNumber,
              category: notice.category,
              publishedDate: notice.publishedDate,
              canonicalUrl: doc.canonicalUrl,
              regionalSubSource: notice.regionalSubSource,
              recruitmentIdentityKey: notice.recruitmentIdentityKey,
              documentCategory: doc.documentCategory,
              classificationReason: doc.classificationReason || notice.classificationReason,
              confidence: doc.confidence || notice.confidence,
              evidence: doc.evidence || notice.evidence,
              pageNumber: notice.pageNumber,
            }),
          });
        }
      }
    }

    // Record audit log
    this.repos.auditLogs.create({
      correlation_id: correlationId,
      actor: 'DISCOVERY_SERVICE',
      action: 'SOURCE_DISCOVERY_COMPLETED',
      entity_type: 'SOURCE',
      entity_id: sourceId,
      stage: 'SOURCE_DISCOVERY',
      status:
        execution.status === 'SUCCESS' ||
        execution.status === 'PASS' ||
        execution.status === 'SUCCESS_WITH_VALID_DOCUMENT' ||
        execution.status === 'SUCCESS_WITH_NOTICES' ||
        execution.status === 'SUCCESS_NO_RELEVANT_NOTICES'
          ? 'SUCCESS'
          : 'FAILURE',
      details_json: JSON.stringify({
        status: execution.status,
        recordsFound: execution.recordsFound,
        documentsFound: execution.documentsFound,
        verifiedLive: execution.verifiedLive,
        pagesCrawled: execution.metrics.pagesCrawled,
      }),
    });

    return execution;
  }

  /**
   * Connects discovered official documents to the existing end-to-end pipeline:
   * SOURCE_DISCOVERY ↓ DOCUMENT_DISCOVERY ↓ DOCUMENT_DOWNLOAD ↓ DOCUMENT_VALIDATION ↓
   * TEXT_EXTRACTION / OCR ↓ STRUCTURED_EXTRACTION ↓ EVIDENCE_VALIDATION ↓ DUPLICATE_CHECK ↓ PUBLISHING_GATE
   */
  async ingestDiscoveredDocument(
    sourceId: string,
    doc: DiscoveredDocumentLink,
    notice: NormalizedNotice,
    options?: { buffer?: Buffer; correlationId?: string }
  ): Promise<IngestDiscoveredDocumentResult> {
    const correlationId = options?.correlationId || crypto.randomUUID();
    const sdocId = `sdoc-${crypto.createHash('sha256').update(doc.url).digest('hex').slice(0, 16)}`;
    const documentId = `doc-${crypto.createHash('sha256').update(doc.url).digest('hex').slice(0, 16)}`;

    // 1. Ensure source document record exists with full discovery evidence
    if (!this.repos.sourceDocuments.findById(sdocId)) {
      this.repos.sourceDocuments.create({
        id: sdocId,
        source_id: sourceId,
        url: doc.url,
        title: doc.title,
        document_type: doc.isPrimaryNotification ? 'PRIMARY_NOTIFICATION_PDF' : 'NOTICE_DOCUMENT',
        raw_hash: null,
        status: 'DOWNLOADED',
        metadata_json: JSON.stringify({
          advertisementNumber: notice.advertisementNumber,
          category: notice.category,
          publishedDate: notice.publishedDate,
          canonicalUrl: doc.canonicalUrl,
          evidence: doc.evidence || notice.evidence,
          documentCategory: doc.documentCategory,
        }),
      });
    }

    // 2. Obtain Document Buffer (via secure download or supplied fixture)
    let buffer: Buffer;
    let checksumSha256: string;
    let fileSize: number;

    if (options?.buffer) {
      buffer = options.buffer;
      checksumSha256 = PdfValidator.computeSha256(buffer);
      fileSize = buffer.length;
    } else {
      const downloadResult = await this.downloader.download(doc.url);
      buffer = downloadResult.buffer;
      checksumSha256 = PdfValidator.computeSha256(buffer);
      fileSize = downloadResult.byteLength;
    }

    // 3. Document Validation
    const validation = await this.pdfValidator.validate(buffer);
    if (!validation.isValidStructure) {
      throw new IngestionError(
        `PDF structure validation failed: EOF marker=${validation.hasEofMarker}, pageCount=${validation.pageCount}`,
        'CORRUPT_PDF'
      );
    }

    // 4. Text Extraction / OCR Orchestration
    const normalizedDoc = await this.ocrOrchestrator.processDocument({
      documentId,
      sourceId,
      sourceUrl: doc.url,
      canonicalUrl: doc.canonicalUrl,
      sourceDomain: new URL(doc.url).hostname,
      checksumSha256,
      fileSize,
      documentType: 'NOTIFICATION_PDF',
      buffer,
    });

    // 5. Store Provenance
    this.provenanceService.persistProvenance(normalizedDoc, sdocId);

    // 6. Structured Field Extraction
    const extractionResult = await this.extractionService.extractRecruitment(
      normalizedDoc,
      correlationId
    );

    // 7. Evidence Verification
    EvidenceValidator.validateAllFields(
      extractionResult.fields,
      normalizedDoc.pages,
      normalizedDoc.id
    );

    // 8. Duplicate / Corrigendum Detection
    await this.deduplicationService.evaluateDocument(
      normalizedDoc,
      extractionResult,
      correlationId
    );

    // 9. Publishing Gate Evaluation
    const gateDecision = await PublishingGate.evaluate(extractionResult.id);

    return {
      sdocId,
      documentId,
      recruitmentId: extractionResult.id,
      status: normalizedDoc.extractionStatus,
      validationStatus: extractionResult.overallStatus,
      publishingState: gateDecision.state,
    };
  }

  /**
   * Runs discovery across all registered government sources with complete failure isolation.
   * A failure in one source (e.g. timeout, structure changed) NEVER halts remaining sources.
   */
  async discoverAllSources(options: DiscoveryOptions = {}): Promise<DiscoveryExecutionResult[]> {
    const adapters = sourceRegistry.getAll();
    const results: DiscoveryExecutionResult[] = [];

    for (const adapter of adapters) {
      try {
        const res = await this.discoverSource(adapter.sourceId, options);
        results.push(res);
      } catch (err) {
        logger.error(`Discovery failed for ${adapter.sourceId}, isolating failure and continuing`, {
          sourceId: adapter.sourceId,
          error: (err as Error).message,
        });
        results.push({
          sourceId: adapter.sourceId,
          authorityName: adapter.name,
          status: 'SOURCE_UNAVAILABLE',
          verifiedLive: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          httpStatus: 0,
          finalUrl: adapter.baseUrl,
          recordsFound: 0,
          documentsFound: 0,
          ignoredCount: 0,
          notices: [],
          errorCode: 'SOURCE_UNAVAILABLE',
          errorMessage: (err as Error).message,
          metrics: {
            pagesRequested: 1,
            pagesSucceeded: 0,
            pagesFailed: 1,
            pagesCrawled: 0,
            durationMs: 0,
            retryCount: 0,
            rejectedUrlsCount: 0,
            noticesDiscovered: 0,
            documentsDiscovered: 0,
          },
        });
      }
    }

    return results;
  }

  /**
   * Aggregates multi-source discovery into a comprehensive summary report.
   *
   * Status counting semantics:
   * - SUCCESS_WITH_NOTICES (or PASS / SUCCESS_WITH_VALID_DOCUMENT): successfulWithNotices += 1
   * - SUCCESS_NO_RELEVANT_NOTICES: successfulEmpty += 1 (NEVER increments successfulWithNotices or successfulSources)
   * - INCONCLUSIVE / NETWORK_UNAVAILABLE: inconclusive += 1
   * - All other failure states: failed += 1
   */
  async discoverAllSourcesSummary(options: DiscoveryOptions = {}): Promise<MultiSourceDiscoverySummary> {
    const startedAt = new Date().toISOString();
    const results = await this.discoverAllSources(options);
    const completedAt = new Date().toISOString();

    const resultsMap: Record<string, DiscoveryExecutionResult> = {};
    let successfulWithNotices = 0;
    let successfulEmpty = 0;
    let failed = 0;
    let inconclusive = 0;
    let totalNotices = 0;
    let totalDocs = 0;

    for (const r of results) {
      resultsMap[r.sourceId] = r;
      totalNotices += r.recordsFound;
      totalDocs += r.documentsFound;

      if (
        r.status === 'SUCCESS' ||
        r.status === 'PASS' ||
        r.status === 'SUCCESS_WITH_VALID_DOCUMENT' ||
        r.status === 'SUCCESS_WITH_NOTICES'
      ) {
        successfulWithNotices += 1;
      } else if (r.status === 'SUCCESS_NO_RELEVANT_NOTICES') {
        successfulEmpty += 1;
      } else if (r.status === 'INCONCLUSIVE' || r.status === 'NETWORK_UNAVAILABLE') {
        inconclusive += 1;
      } else {
        failed += 1;
      }
    }

    return {
      startedAt,
      completedAt,
      totalSources: results.length,
      successfulSources: successfulWithNotices,
      successfulWithNotices,
      successfulEmpty,
      failedSources: failed,
      failed,
      inconclusiveSources: inconclusive,
      inconclusive,
      totalNoticesFound: totalNotices,
      totalDocumentsFound: totalDocs,
      results: resultsMap,
    };
  }

  /**
   * Executes strict end-to-end live verification against official government sources.
   *
   * Strict PASS Gate:
   * - Never marks PASS merely because HTTP 200 was returned, HTML parsed, or 0 notices were found.
   * - Requires real end-to-end evidence:
   *   official endpoint reached -> listing validated -> relevant notice discovered ->
   *   detail resolved when required -> official document URL discovered ->
   *   document actually downloaded -> document validated as real PDF.
   */
  async runLiveVerification(
    timeoutMs?: number,
    options: DiscoveryOptions = {}
  ): Promise<LiveVerificationReport> {
    const startedAt = new Date().toISOString();
    const runtimeConfig = resolveLiveVerificationRuntimeConfig({
      timeoutMs: timeoutMs ?? options.timeoutMs,
      connectionTimeoutMs: options.connectionTimeoutMs,
      maxRetries: options.maxRetries,
      retryBackoffMs: options.retryBackoffMs,
      verbose: options.verbose,
    });
    const effectiveTimeoutMs = runtimeConfig.timeoutMs;
    const effectiveConnectionTimeoutMs = runtimeConfig.connectionTimeoutMs;
    const effectiveMaxRetries = runtimeConfig.maxRetries;
    const effectiveRetryBackoffMs = runtimeConfig.retryBackoffMs;

    const adapters = sourceRegistry.getAll();
    const executor = getDiscoveryExecutor();

    // Execute all 7 sources independently so one source timing out or failing never stops or blocks others
    const items: LiveSourceVerificationItem[] = await Promise.all(
      adapters.map(async (adapter): Promise<LiveSourceVerificationItem> => {
        const startTime = Date.now();
        const officialDomain = adapter.officialDomains[0] || '';

        let execution: DiscoveryExecutionResult | null = null;
        let execError: Error | null = null;

        try {
          execution = await executor.execute(adapter.sourceId, {
            ...options,
            noCache: options.noCache ?? true,
            strictLiveMode: true,
            downloadAndValidatePdfs: true,
            timeoutMs: effectiveTimeoutMs,
            connectionTimeoutMs: effectiveConnectionTimeoutMs,
            maxRetries: effectiveMaxRetries,
            retryBackoffMs: effectiveRetryBackoffMs,
            maxNotices: options.maxNotices ?? 10,
            // Do NOT force maxPages: 1; allow configured maxPages from registry or options
          });
        } catch (err) {
          execError = err as Error;
          logger.warn(`Live discovery execution failed during verification for ${adapter.sourceId}`, {
            error: execError.message,
          });
        }

        const endpointsReached = execution?.metrics.endpointsReached ?? execution?.metrics.pagesSucceeded ?? 0;
        const listingPagesValidated = execution?.metrics.listingPagesValidated ?? 0;
        const pagesCrawled = execution?.metrics.pagesCrawled ?? 0;
        const noticesFound = execution?.recordsFound ?? 0;
        const detailUrlsDiscovered = execution?.metrics.detailUrlsDiscovered ?? 0;
        const detailPagesFetched = execution?.metrics.detailPagesFetched ?? 0;
        const detailPagesWithDocs = execution?.metrics.detailPagesWithDocuments ?? 0;
        const docsFound = execution?.documentsFound ?? 0;
        const docsDownloaded = execution?.metrics.documentsDownloaded ?? 0;
        const validPdfs = execution?.metrics.validPdfs ?? execution?.metrics.pdfsValidated ?? 0;
        const pdfCandidates = execution?.metrics.pdfCandidates ?? docsFound;
        const selectedEpId = execution?.metrics.selectedEndpointId || adapter.baseUrl;
        const responseSource = execution?.responseSource || 'LIVE_EXECUTION';

        const itemStartedAt = execution?.startedAt || new Date(startTime).toISOString();
        const itemCompletedAt = execution?.completedAt || new Date().toISOString();

        const hasFixtures =
          options.fixtureHtml !== undefined ||
          options.pageFixtures !== undefined ||
          options.endpointFixtures !== undefined ||
          options.detailFixtures !== undefined ||
          options.pdfFixtures !== undefined;
        const effectiveMode: VerificationExecutionMode =
          options.verificationMode ||
          execution?.verificationMode ||
          (hasFixtures ? 'FIXTURE' : 'LIVE');
        const fixtureSource = Boolean(execution?.fixtureSource ?? (effectiveMode === 'FIXTURE' && hasFixtures));

        const detailRequired = execution?.detailRequired === true;
        const detailResolved: boolean | null = detailRequired
          ? execution?.detailResolved === true
          : null;

        const attemptedLogs = execution?.metrics.attemptedEndpoints || [];
        const matchingLog =
          attemptedLogs.find((l) => l.endpointId === selectedEpId) ||
          attemptedLogs[attemptedLogs.length - 1];

        const lastErrorType =
          execution?.lastErrorType ??
          execution?.metrics.lastErrorType ??
          matchingLog?.lastErrorType ??
          null;
        const lastErrorCode =
          execution?.lastErrorCode ??
          execution?.metrics.lastErrorCode ??
          matchingLog?.lastErrorCode ??
          execution?.errorCode ??
          null;
        const lastErrorName =
          execution?.errorName ??
          execution?.metrics.lastErrorName ??
          matchingLog?.lastErrorName ??
          null;
        const lastErrorMessage =
          execution?.lastErrorMessage ??
          execution?.metrics.lastErrorMessage ??
          matchingLog?.lastErrorMessage ??
          execution?.errorMessage ??
          execError?.message ??
          null;
        const lastErrorCause =
          execution?.errorCause ??
          execution?.metrics.lastErrorCause ??
          matchingLog?.lastErrorCause ??
          null;
        const lastErrorRetryable =
          execution?.metrics.lastErrorRetryable ??
          matchingLog?.lastErrorRetryable ??
          null;

        const isTimeoutError =
          lastErrorType === 'TIMEOUT' ||
          execution?.errorCode === 'HTTP_TIMEOUT' ||
          Boolean(execution?.errorMessage?.toLowerCase().includes('timeout')) ||
          Boolean(execError?.message?.toLowerCase().includes('timeout'));

        const primaryEndpoint = execution?.primaryEndpoint || execution?.metrics.primaryEndpoint || adapter.baseUrl;
        const officialDomainVerified =
          execution?.officialDomainVerified ??
          execution?.metrics.officialDomainVerified ??
          true;
        const responseContentType =
          execution?.responseContentType ??
          execution?.metrics.responseContentType ??
          matchingLog?.responseContentType ??
          null;
        const responseBytes =
          execution?.responseBytes ??
          execution?.metrics.responseBytes ??
          matchingLog?.responseBytes ??
          0;
        const responseTimeMs =
          execution?.responseTimeMs ??
          execution?.metrics.responseTimeMs ??
          matchingLog?.responseTimeMs ??
          (Date.now() - startTime);

        const gateDecision = evaluateLiveVerificationGate({
          endpointReached: endpointsReached > 0,
          endpointValidated: endpointsReached > 0,
          officialDomainVerified,
          listingValidated: listingPagesValidated > 0,
          relevantNoticeFound: noticesFound > 0,
          detailRequired,
          detailResolved,
          detailPagesFetched,
          documentDiscovered: docsFound > 0,
          documentDownloaded: docsDownloaded > 0,
          pdfValidated: validPdfs > 0,
          responseSource,
          verificationMode: effectiveMode,
          httpStatus: execution?.httpStatus ?? null,
          finalUrl: execution?.finalUrl ?? null,
          structureChanged: execution?.status === 'ADAPTER_STRUCTURE_CHANGED',
          wrongContent: execution?.status === 'ENDPOINT_WRONG_CONTENT',
          parseFailed: execution?.status === 'ENDPOINT_PARSE_FAILED',
          accessBlocked:
            execution?.status === 'ACCESS_BLOCKED' ||
            execution?.failureReasons?.includes('ACCESS_BLOCKED') ||
            execution?.errorCode === 'EXTERNAL_REDIRECT_BLOCKED',
          timeoutOccurred: endpointsReached === 0 && isTimeoutError,
          httpError:
            endpointsReached === 0 &&
            (execution?.errorCode === 'HTTP_ERROR' ||
              (execution?.httpStatus !== null && (execution?.httpStatus ?? 0) >= 400)),
          networkErrorType:
            endpointsReached === 0 &&
            !isTimeoutError &&
            (lastErrorType === 'DNS_ERROR' ||
              lastErrorType === 'TLS_ERROR' ||
              lastErrorType === 'CONNECTION_RESET' ||
              lastErrorType === 'CONNECTION_REFUSED' ||
              lastErrorType === 'NETWORK_UNAVAILABLE' ||
              lastErrorType === 'UNKNOWN_NETWORK_ERROR')
              ? lastErrorType
              : null,
          networkUnreachableInSandbox: false,
          downloadAttempted: (execution?.metrics.documentDownloadAttempts ?? 0) > 0,
          downloadFailed: (execution?.metrics.downloadFailures ?? 0) > 0 && docsDownloaded === 0,
          invalidPdf: (execution?.metrics.invalidPdfs ?? 0) > 0 && validPdfs === 0,
          invalidMime: execution?.failureReasons?.includes('INVALID_MIME'),
          invalidMagicBytes: execution?.failureReasons?.includes('INVALID_MAGIC_BYTES'),
          evidence: {
            endpointUrl: execution?.evidence?.endpointUrl || execution?.metrics.selectedEndpointUrl || adapter.baseUrl,
            ...execution?.evidence,
          },
        });

        const outcome: LiveVerificationOutcome = gateDecision.outcome;
        const technicalFailure: boolean = outcome === 'FAIL';
        const endpointClassification: EndpointClassification =
          execution?.endpointClassification || gateDecision.endpointClassification;

        const diagnostic =
          execution?.errorMessage ||
          execError?.message ||
          gateDecision.diagnostic;

        // Section 11: Record verification audit log without fabricating production health
        this.repos.auditLogs.create({
          correlation_id: options.correlationId || crypto.randomUUID(),
          actor: 'LIVE_VERIFICATION_HARNESS',
          action: 'SOURCE_LIVE_VERIFICATION_COMPLETED',
          entity_type: 'SOURCE',
          entity_id: adapter.sourceId,
          stage: 'SOURCE_DISCOVERY',
          status: outcome === 'PASS' ? 'SUCCESS' : 'FAILURE',
          details_json: JSON.stringify({
            verificationMode: gateDecision.verificationMode,
            fixtureSource,
            outcome,
            endpointClassification,
            technicalFailure,
            failureReasons: gateDecision.failureReasons,
            evidence: gateDecision.evidence,
            timestamps: {
              startedAt: itemStartedAt,
              completedAt: itemCompletedAt,
            },
          }),
        });

        const redirectChain =
          matchingLog?.redirectChain && matchingLog.redirectChain.length > 0
            ? matchingLog.redirectChain
            : [
                gateDecision.evidence.endpointUrl || adapter.baseUrl,
                ...(execution?.finalUrl &&
                execution.finalUrl !== (gateDecision.evidence.endpointUrl || adapter.baseUrl)
                  ? [execution.finalUrl]
                  : []),
              ];

        const retriesUsed =
          !gateDecision.endpointReached && matchingLog?.retriesUsed !== undefined
            ? matchingLog.retriesUsed
            : execution?.metrics.retryCount ?? 0;
        const retryReasons =
          !gateDecision.endpointReached && matchingLog?.retryReasons
            ? matchingLog.retryReasons
            : execution?.metrics.retryReasons ?? [];
        const retryDiagnostics =
          !gateDecision.endpointReached && matchingLog?.retryDiagnostics
            ? matchingLog.retryDiagnostics
            : execution?.metrics.retryDiagnostics ?? [];
        const attemptDiagnostics =
          !gateDecision.endpointReached &&
          matchingLog?.attemptDiagnostics &&
          matchingLog.attemptDiagnostics.length > 0
            ? matchingLog.attemptDiagnostics
            : execution?.metrics.attemptDiagnostics ?? [];
        const attempts =
          !gateDecision.endpointReached &&
          matchingLog?.attemptsUsed !== undefined &&
          matchingLog.attemptsUsed > 0
            ? matchingLog.attemptsUsed
            : Math.max(1, 1 + retriesUsed);

        const downloadStatus = !gateDecision.relevantNoticeFound
          ? 'NOT_APPLICABLE'
          : !gateDecision.documentDiscovered
          ? 'NO_DOCUMENT_URL'
          : gateDecision.documentDownloaded
          ? 'DOWNLOADED'
          : 'DOWNLOAD_FAILED';

        const pdfValidationStatus = !gateDecision.documentDownloaded
          ? 'NOT_APPLICABLE'
          : gateDecision.pdfValidated
          ? 'VALID_PDF'
          : 'INVALID_PDF';

        const effectiveErrorType = outcome === 'PASS' ? null : lastErrorType;
        const effectiveErrorCode = outcome === 'PASS' ? null : lastErrorCode;

        const shouldRunSocketProbe =
          effectiveMode === 'LIVE' &&
          !hasFixtures &&
          options.connectivityProbe !== false &&
          (options.connectivityProbe === true || globalThis.fetch === INITIAL_GLOBAL_FETCH);

        const targetProbeUrl = gateDecision.evidence.endpointUrl || primaryEndpoint;
        let connectivityProbe: EndpointConnectivityProbeResult | null = null;
        if (shouldRunSocketProbe && !gateDecision.endpointReached && lastErrorType !== 'SSRF_BLOCKED') {
          connectivityProbe = await probeEndpointConnectivity(
            targetProbeUrl,
            adapter.sourceId,
            Math.min(effectiveConnectionTimeoutMs, 4000)
          );
        }

        const connectivityDerived = deriveConnectivityStatuses({
          endpointReached: gateDecision.endpointReached,
          lastErrorType: effectiveErrorType,
          lastErrorCode: effectiveErrorCode,
          failureReasons: gateDecision.failureReasons,
          probe: connectivityProbe,
        });

        const failureClassification = classifyFailureTaxonomy({
          outcome,
          endpointClassification,
          dnsStatus: connectivityDerived.dnsStatus,
          connectionStatus: connectivityDerived.connectionStatus,
          httpStatus: execution?.httpStatus ?? null,
          errorType: effectiveErrorType,
          errorCode: effectiveErrorCode,
          failureReasons: gateDecision.failureReasons,
          documentDownloaded: gateDecision.documentDownloaded,
          pdfValidated: gateDecision.pdfValidated,
        });

        let regionalProbes: RrbRegionalBoardProbeRecord[] | undefined = undefined;
        if (adapter.sourceId === 'IN-CENTRAL-RRB') {
          regionalProbes = await probeRrbRegionalNetwork({
            attemptedEndpoints: attemptedLogs,
            runLiveSockets: shouldRunSocketProbe && !gateDecision.endpointReached,
            timeoutMs: 3500,
          });
        }

        const effectiveRunnerMode: RunnerMode =
          execution?.runnerMode || resolveRunnerMode(options.runnerMode);
        const selectedRunner: RunnerKind =
          execution?.selectedRunner ||
          (effectiveRunnerMode === 'REMOTE' ? 'REMOTE' : 'LOCAL');
        const actualRunner: RunnerKind =
          execution?.actualRunner || execution?.runner || selectedRunner;
        const executionOrigin: AcquisitionExecutionOrigin =
          execution?.executionOrigin ||
          (fixtureSource
            ? 'FIXTURE'
            : gateDecision.verificationMode === 'CACHE'
            ? 'CACHE'
            : actualRunner === 'REMOTE'
            ? 'REAL_LIVE_REMOTE'
            : 'REAL_LIVE_LOCAL');
        const localAccess =
          execution?.localAccess ||
          (actualRunner === 'LOCAL'
            ? gateDecision.endpointReached
              ? 'SUCCESS'
              : effectiveErrorType || 'LOCAL_FAILED'
            : 'NOT_ATTEMPTED');
        const remoteAccess =
          execution?.remoteAccess ||
          (actualRunner === 'REMOTE'
            ? gateDecision.endpointReached
              ? 'SUCCESS'
              : effectiveErrorType || 'REMOTE_FAILED'
            : effectiveRunnerMode === 'AUTO'
            ? 'NOT_CONFIGURED'
            : 'NOT_ATTEMPTED');
        const remoteStatus: RemoteExecutionState =
          execution?.remoteStatus ||
          (remoteAccess === 'NOT_CONFIGURED'
            ? 'REMOTE_NOT_CONFIGURED'
            : remoteAccess === 'SUCCESS'
            ? 'REMOTE_EXECUTED'
            : remoteAccess === 'NOT_ATTEMPTED'
            ? 'REMOTE_NOT_CONFIGURED'
            : remoteAccess === 'NETWORK_UNAVAILABLE' ||
              remoteAccess === 'CONNECTION_REFUSED' ||
              remoteAccess === 'REMOTE_UNAVAILABLE' ||
              remoteAccess === 'UNREACHABLE'
            ? 'REMOTE_UNAVAILABLE'
            : 'REMOTE_FAILED');
        const failureClass =
          execution?.failureClass ||
          (outcome === 'PASS' ? 'SUCCESS' : effectiveErrorType || failureClassification);
        const selectionReason =
          execution?.selectionReason ||
          (actualRunner === 'REMOTE'
            ? 'Remote acquisition runner selected'
            : 'Local acquisition runner selected');

        const runtimeEval = evaluateSourceRuntimeCapabilities({
          officialDomainVerified,
          endpointClassification,
          dnsStatus: connectivityDerived.dnsStatus,
          tcpStatus: connectivityDerived.tcpStatus,
          tlsStatus: connectivityDerived.tlsStatus,
          connectionStatus: connectivityDerived.connectionStatus,
          endpointReached: gateDecision.endpointReached,
          httpStatus: execution?.httpStatus ?? null,
          responseBytes,
          redirectChain,
          documentDownloaded: gateDecision.documentDownloaded,
          pdfValidated: gateDecision.pdfValidated,
          failureReasons: gateDecision.failureReasons,
        });

        const verifiedLive = Boolean(
          execution?.verifiedLive &&
            gateDecision.verificationMode === 'LIVE' &&
            (executionOrigin === 'REAL_LIVE_LOCAL' ||
              executionOrigin === 'REAL_LIVE_REMOTE' ||
              executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
              executionOrigin === 'REAL_REMOTE_PRODUCTION')
        );

        return {
          source: adapter.sourceId,
          sourceId: adapter.sourceId,
          region: adapter.jurisdiction,
          primaryEndpoint,
          officialDomain,
          officialDomainVerified,
          endpointClassification,
          failureClassification,
          dnsStatus: connectivityDerived.dnsStatus,
          resolvedIps: connectivityDerived.resolvedIps,
          tcpStatus: connectivityDerived.tcpStatus,
          tlsStatus: connectivityDerived.tlsStatus,
          connectionStatus: connectivityDerived.connectionStatus,
          regionalProbes,
          runnerMode: effectiveRunnerMode,
          selectedRunner,
          actualRunner,
          runner: actualRunner,
          remoteStatus,
          failureClass,
          localAccess,
          remoteAccess,
          selectionReason,
          executionOrigin,
          runtimeCapabilities: runtimeEval.runtimeCapabilities,
          runtimeAccessibility: runtimeEval.runtimeAccessibility,
          officialEndpointStatus: runtimeEval.officialEndpointStatus,
          runtimeAccessStatus: runtimeEval.runtimeAccessStatus,
          authorityName: adapter.name,
          adapterVersion: adapter.adapterVersion,
          selectedEndpointId: selectedEpId,
          requestedEndpoint: gateDecision.evidence.endpointUrl || adapter.baseUrl,
          finalUrl: execution?.finalUrl || null,
          httpStatus: execution?.httpStatus || null,
          responseContentType,
          responseBytes,
          responseTimeMs,
          endpointsReached,
          listingPagesValidated,
          pagesCrawled,
          noticesFound,
          recruitmentsFound: noticesFound,
          detailUrlsDiscovered,
          detailPagesFetched,
          detailPagesResolved: detailPagesWithDocs,
          documentsFound: docsFound,
          documentsDownloaded: docsDownloaded,
          validPdfs,
          pdfsValidated: validPdfs,
          pdfCandidates,
          endpointReached: gateDecision.endpointReached,
          listingValidated: gateDecision.listingValidated,
          relevantNoticeFound: gateDecision.relevantNoticeFound,
          detailRequired: gateDecision.detailRequired,
          detailResolved: gateDecision.detailResolved,
          documentDiscovered: gateDecision.documentDiscovered,
          documentDownloaded: gateDecision.documentDownloaded,
          pdfValidated: gateDecision.pdfValidated,
          outcome,
          technicalFailure,
          errorType: effectiveErrorType,
          errorCode: effectiveErrorCode,
          failedStage: gateDecision.failedStage,
          finalFailureStage: gateDecision.failedStage,
          failureReasons: gateDecision.failureReasons,
          evidence: gateDecision.evidence,
          responseSource,
          verificationMode: gateDecision.verificationMode,
          mode: gateDecision.verificationMode,
          fixtureSource,
          verificationStatus: gateDecision.verificationStatus,
          verifiedLive,
          resultState: outcome,
          errorDiagnostic: diagnostic,
          timeoutMs: effectiveTimeoutMs,
          connectionTimeoutMs: effectiveConnectionTimeoutMs,
          maxRetries: effectiveMaxRetries,
          attempts,
          requestAttempts: attempts,
          retriesUsed,
          retryReasons,
          retryDiagnostics,
          attemptDiagnostics,
          lastErrorType: effectiveErrorType,
          lastErrorCode: effectiveErrorCode,
          lastErrorName: outcome === 'PASS' ? null : lastErrorName,
          lastErrorMessage: outcome === 'PASS' ? null : lastErrorMessage,
          lastErrorCause: outcome === 'PASS' ? null : lastErrorCause,
          lastErrorRetryable: outcome === 'PASS' ? null : lastErrorRetryable,
          redirectChain,
          downloadStatus,
          pdfValidationStatus,
          // Accurate stage boolean flags (Section 6 & 11)
          listingReachable: endpointsReached > 0,
          listingParsed: listingPagesValidated > 0,
          relevantNoticeDetection: noticesFound > 0,
          detailPageReachable: detailPagesFetched > 0,
          documentDiscovery: gateDecision.documentDiscovered,
          documentValidation: validPdfs > 0,
          paginationObserved: pagesCrawled > 1,
          status: outcome,
          pagesChecked: pagesCrawled,
          officialDocumentsFound: docsFound,
          durationMs: Date.now() - startTime,
          timestamps: {
            startedAt: itemStartedAt,
            completedAt: itemCompletedAt,
          },
          reason:
            outcome === 'PASS'
              ? `Official source verified end-to-end (${noticesFound} notices, ${validPdfs} valid PDFs)`
              : gateDecision.diagnostic,
        };
      })
    );

    const passed = items.filter((i) => i.outcome === 'PASS').length;
    const failed = items.filter((i) => i.outcome === 'FAIL').length;
    const inconclusive = items.filter((i) => i.outcome === 'INCONCLUSIVE' && !i.technicalFailure).length;
    const completedAt = new Date().toISOString();
    const liveExecutionCount = items.filter((i) => i.verificationMode === 'LIVE' && !i.fixtureSource).length;

    return {
      startedAt,
      completedAt,
      environment: passed > 0 && items.some((i) => i.verifiedLive) ? 'PRODUCTION' : 'SANDBOX',
      totalSources: adapters.length,
      passedCount: passed,
      failedCount: failed,
      inconclusiveCount: inconclusive,
      passCount: passed,
      failCount: failed,
      liveExecutionCount,
      items,
    };
  }

  /**
   * Production-safe Real Live E2E Verification Harness across all 7 government sources:
   * SSC, UPSC, RRB, BPSC, BSSC, UPPSC, UPSSSC.
   *
   * Enforces:
   * - Explicit verificationMode ('LIVE' | 'FIXTURE' | 'CACHE')
   * - Per-source failure isolation (one source failing never stops the other six)
   * - Official domain allowlist, HTTPS, SSRF protection, bounded retry & size limits
   * - Real PDF download, magic-byte & structure validation, SHA-256 & pageCount evidence
   * - Strict verification gate (no fake PASS on HTTP 200 or empty valid listings)
   */
  async runRealLiveVerification(
    options: DiscoveryOptions & { timeoutMs?: number } = {}
  ): Promise<RealLiveVerificationSummary> {
    const mode: VerificationExecutionMode = options.verificationMode ?? 'LIVE';
    const runtimeConfig = resolveLiveVerificationRuntimeConfig({
      timeoutMs: options.timeoutMs,
      connectionTimeoutMs: options.connectionTimeoutMs,
      maxRetries: options.maxRetries,
      retryBackoffMs: options.retryBackoffMs,
      verbose: options.verbose,
    });

    const report = await this.runLiveVerification(runtimeConfig.timeoutMs, {
      ...options,
      timeoutMs: runtimeConfig.timeoutMs,
      connectionTimeoutMs: runtimeConfig.connectionTimeoutMs,
      maxRetries: runtimeConfig.maxRetries,
      retryBackoffMs: runtimeConfig.retryBackoffMs,
      verbose: runtimeConfig.verbose,
      verificationMode: mode,
      noCache: mode !== 'CACHE',
      strictLiveMode: mode === 'LIVE',
      downloadAndValidatePdfs: true,
      // When mode is LIVE, strip any fixture overrides so the live HTTP path is strictly used
      fixtureHtml: mode === 'FIXTURE' ? options.fixtureHtml : undefined,
      pageFixtures: mode === 'FIXTURE' ? options.pageFixtures : undefined,
      endpointFixtures: mode === 'FIXTURE' ? options.endpointFixtures : undefined,
      detailFixtures: mode === 'FIXTURE' ? options.detailFixtures : undefined,
      pdfFixtures: mode === 'FIXTURE' ? options.pdfFixtures : undefined,
    });

    const results: RealLiveSourceVerificationResult[] = report.items.map((item) => {
      const stage = item.failedStage || (item.outcome === 'PASS' ? 'NONE' : 'STRICT_PASS_GATE');
      const attemptsCount = item.attempts ?? Math.max(1, 1 + (item.retriesUsed ?? 0));
      const isTechFailure = item.outcome === 'FAIL';
      const errType = item.lastErrorType ?? null;
      const errCode = item.lastErrorCode ?? null;
      const resolvedEndpoint = item.evidence.endpointUrl || item.requestedEndpoint;
      const executionOrigin: AcquisitionExecutionOrigin =
        item.executionOrigin ||
        (item.mode === 'CACHE' || item.responseSource === 'CACHED_RESULT'
          ? 'CACHE'
          : item.mode === 'FIXTURE' || item.fixtureSource
          ? 'FIXTURE'
          : 'REAL_LIVE_LOCAL');
      const proofType: RuntimeProofCategory =
        executionOrigin === 'MOCK_REMOTE'
          ? 'MOCK_REMOTE_PROOF'
          : item.mode === 'CACHE' ||
            item.responseSource === 'CACHED_RESULT' ||
            executionOrigin === 'CACHE'
          ? 'CACHE_PROOF'
          : item.mode === 'FIXTURE' ||
            item.fixtureSource ||
            executionOrigin === 'FIXTURE'
          ? 'FIXTURE_PROOF'
          : 'REAL_LIVE_PROOF';
      const reqTimeoutMs = item.timeoutMs ?? runtimeConfig.timeoutMs;
      const connTimeoutMs = item.connectionTimeoutMs ?? runtimeConfig.connectionTimeoutMs;
      const evidenceValidated = Boolean(
        item.pdfValidated && item.evidence.documentSha256 && (item.evidence.pdfPageCount ?? 0) > 0
      );
      const failureReason =
        item.outcome === 'PASS'
          ? null
          : item.failureReasons[0] || errType || item.failedStage || 'VERIFICATION_FAILED';
      const failureDetails =
        item.outcome === 'PASS'
          ? null
          : item.lastErrorMessage || item.errorDiagnostic || item.reason;

      const fallbackRuntimeEval = evaluateSourceRuntimeCapabilities({
        officialDomainVerified: item.officialDomainVerified ?? true,
        endpointClassification: item.endpointClassification ?? 'UNKNOWN',
        dnsStatus: item.dnsStatus,
        tcpStatus: item.tcpStatus,
        tlsStatus: item.tlsStatus,
        connectionStatus: item.connectionStatus,
        endpointReached: item.endpointReached,
        httpStatus: item.httpStatus,
        responseBytes: item.responseBytes ?? null,
        redirectChain: item.redirectChain || [resolvedEndpoint],
        documentDownloaded: item.documentDownloaded,
        pdfValidated: item.pdfValidated,
        failureReasons: item.failureReasons,
      });

      return {
        source: item.sourceId,
        sourceId: item.sourceId,
        region: item.region,
        authorityName: item.authorityName,
        endpoint: resolvedEndpoint,
        primaryEndpoint: item.primaryEndpoint || item.requestedEndpoint,
        officialDomain: item.officialDomain,
        officialDomainVerified: item.officialDomainVerified ?? true,
        endpointClassification: item.endpointClassification ?? 'UNKNOWN',
        failureClassification: item.failureClassification,
        dnsStatus: item.dnsStatus,
        resolvedIps: item.resolvedIps,
        tcpStatus: item.tcpStatus,
        tlsStatus: item.tlsStatus,
        connectionStatus: item.connectionStatus,
        classificationEvidence:
          SOURCE_AUDIT_EVIDENCE[item.sourceId] ||
          `Endpoint ${resolvedEndpoint} classified as ${item.endpointClassification ?? 'UNKNOWN'}.`,
        proofType,
        mode: item.mode,
        verificationMode: item.verificationMode,
        fixtureSource: item.fixtureSource,
        verifiedLive: item.verifiedLive && executionOrigin !== 'MOCK_REMOTE',
        endpointUrl: resolvedEndpoint,
        endpointReached: item.endpointReached,
        listingFetched: item.endpointReached,
        listingParsed: item.listingValidated,
        listingValidated: item.listingValidated,
        relevantNoticeFound: item.relevantNoticeFound,
        relevantNotices: item.noticesFound,
        detailRequired: item.detailRequired,
        detailResolved: item.detailResolved,
        documentDiscovered: item.documentDiscovered,
        documentsDiscovered: item.documentsFound,
        documentDownloaded: item.documentDownloaded,
        documentsDownloaded: item.documentsDownloaded,
        pdfValidated: item.pdfValidated,
        validPdfs: item.validPdfs,
        evidenceValidated,
        outcome: item.outcome,
        finalStatus: item.outcome,
        failureReason,
        failureDetails,
        technicalFailure: isTechFailure,
        errorType: errType,
        errorCode: errCode,
        failedStage: stage,
        finalFailureStage: stage,
        failureReasons: item.failureReasons,
        regionalProbes: item.regionalProbes,
        timeoutMs: reqTimeoutMs,
        requestTimeoutMs: reqTimeoutMs,
        connectionTimeoutMs: connTimeoutMs,
        maxRetries: item.maxRetries ?? runtimeConfig.maxRetries,
        attempts: attemptsCount,
        requestAttempts: item.requestAttempts ?? attemptsCount,
        retriesUsed: item.retriesUsed ?? 0,
        retryReasons: item.retryReasons ?? [],
        retryDiagnostics: item.retryDiagnostics ?? [],
        attemptDiagnostics: item.attemptDiagnostics ?? [],
        lastErrorType: errType,
        lastErrorCode: errCode,
        lastErrorName: item.lastErrorName ?? null,
        lastErrorMessage: item.lastErrorMessage ?? null,
        lastErrorCause: item.lastErrorCause ?? null,
        lastErrorRetryable: item.lastErrorRetryable ?? null,
        durationMs: item.durationMs,
        noticeUrl: item.evidence.noticeUrl ?? null,
        detailUrl: item.evidence.detailUrl ?? null,
        documentUrl: item.evidence.documentUrl ?? null,
        sha256: item.evidence.documentSha256 ?? null,
        pageCount: item.evidence.pdfPageCount ?? null,
        evidence: item.evidence,
        timestamps: item.timestamps,
        diagnostic: item.errorDiagnostic || item.reason,
        requestUrl: resolvedEndpoint,
        httpStatus: item.httpStatus,
        responseContentType: item.responseContentType ?? null,
        responseBytes: item.responseBytes ?? null,
        responseTimeMs: item.responseTimeMs ?? null,
        redirectChain: item.redirectChain || [resolvedEndpoint],
        adapterSelected: `${item.authorityName} (${item.adapterVersion})`,
        noticeCount: item.noticesFound,
        documentCount: item.documentsFound,
        documentsDownloadedCount: item.documentsDownloaded,
        validPdfsCount: item.validPdfs,
        downloadStatus: item.downloadStatus || 'NOT_APPLICABLE',
        pdfValidationStatus: item.pdfValidationStatus || 'NOT_APPLICABLE',
        runnerMode: item.runnerMode || resolveRunnerMode(options.runnerMode),
        selectedRunner: item.selectedRunner || 'LOCAL',
        actualRunner: item.actualRunner || item.runner || item.selectedRunner || 'LOCAL',
        runner: item.actualRunner || item.runner || item.selectedRunner || 'LOCAL',
        remoteStatus: item.remoteStatus || 'REMOTE_NOT_CONFIGURED',
        failureClass:
          item.failureClass ||
          (item.outcome === 'PASS' ? 'SUCCESS' : errType || item.failureClassification),
        localAccess: item.localAccess || 'NOT_ATTEMPTED',
        remoteAccess: item.remoteAccess || 'NOT_ATTEMPTED',
        selectionReason: item.selectionReason || 'Local runner selected',
        executionOrigin,
        runtimeCapabilities:
          item.runtimeCapabilities || fallbackRuntimeEval.runtimeCapabilities,
        runtimeAccessibility:
          item.runtimeAccessibility || fallbackRuntimeEval.runtimeAccessibility,
        officialEndpointStatus:
          item.officialEndpointStatus || fallbackRuntimeEval.officialEndpointStatus,
        runtimeAccessStatus:
          item.runtimeAccessStatus || fallbackRuntimeEval.runtimeAccessStatus,
      };
    });

    const expectedTotalSources = sourceRegistry.getAll().length;
    const notRunCount = Math.max(0, expectedTotalSources - results.length);

    // Derive aggregate metrics from actual execution events (Section 5, 6, 7, 10, 12 & 14)
    const relevantNoticeCount = results.reduce((sum, r) => sum + r.noticeCount, 0);
    const documentDownloadCount = results.reduce((sum, r) => sum + r.documentsDownloadedCount, 0);
    const validPdfCount = results.reduce((sum, r) => sum + r.validPdfsCount, 0);
    const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const passCount = results.filter((r) => r.outcome === 'PASS').length;
    const failCount = results.filter((r) => r.outcome === 'FAIL').length;
    const technicalFailures = results.filter((r) => r.technicalFailure).length;
    const inconclusiveCount = results.filter(
      (r) => r.outcome === 'INCONCLUSIVE' && !r.technicalFailure
    ).length;

    const realLiveLocalPassCount = results.filter(
      (r) =>
        r.proofType === 'REAL_LIVE_PROOF' &&
        r.executionOrigin === 'REAL_LIVE_LOCAL' &&
        r.outcome === 'PASS' &&
        r.verifiedLive
    ).length;
    const realRemoteLocalWorkerPassCount = results.filter(
      (r) =>
        r.proofType === 'REAL_LIVE_PROOF' &&
        r.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' &&
        r.outcome === 'PASS' &&
        r.verifiedLive
    ).length;
    const realRemoteProductionPassCount = results.filter(
      (r) =>
        r.proofType === 'REAL_LIVE_PROOF' &&
        r.executionOrigin === 'REAL_REMOTE_PRODUCTION' &&
        r.outcome === 'PASS' &&
        r.verifiedLive
    ).length;
    const realLiveRemotePassCount = results.filter(
      (r) =>
        r.proofType === 'REAL_LIVE_PROOF' &&
        (r.executionOrigin === 'REAL_LIVE_REMOTE' ||
          r.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
          r.executionOrigin === 'REAL_REMOTE_PRODUCTION') &&
        r.outcome === 'PASS' &&
        r.verifiedLive
    ).length;
    const realLivePassCount = realLiveLocalPassCount + realLiveRemotePassCount;
    const realLiveFailCount = results.filter(
      (r) => r.proofType === 'REAL_LIVE_PROOF' && r.outcome === 'FAIL'
    ).length;
    const realLiveInconclusiveCount = results.filter(
      (r) => r.proofType === 'REAL_LIVE_PROOF' && r.outcome === 'INCONCLUSIVE'
    ).length;
    const realPdfProofCount = results
      .filter((r) => r.proofType === 'REAL_LIVE_PROOF' && r.verifiedLive && r.evidenceValidated)
      .reduce((sum, r) => sum + r.validPdfsCount, 0);
    const mockRemotePassCount = results.filter(
      (r) => r.proofType === 'MOCK_REMOTE_PROOF' && r.outcome === 'PASS'
    ).length;
    const fixturePassCount = results.filter(
      (r) => r.proofType === 'FIXTURE_PROOF' && r.outcome === 'PASS'
    ).length;
    const cacheResultCount = results.filter((r) => r.proofType === 'CACHE_PROOF').length;

    const successfulWithNotices = results.filter(
      (r) => r.outcome === 'PASS' && r.relevantNoticeFound && r.pdfValidated
    ).length;
    const successfulEmpty = results.filter(
      (r) =>
        r.outcome === 'INCONCLUSIVE' &&
        !r.technicalFailure &&
        r.endpointReached &&
        r.listingValidated &&
        !r.relevantNoticeFound
    ).length;

    const effectiveRunnerMode = resolveRunnerMode(options.runnerMode);
    const runnerHealth = await this.getRunnerHealthReport(results, options);

    const summaryBase = {
      sourcesChecked: results.length,
      totalSources: report.totalSources,
      passCount,
      inconclusiveCount,
      failCount,
      notRunCount,
      technicalFailures,
    };

    return {
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      runtimeConfig,
      runnerMode: effectiveRunnerMode,
      runnerHealth,
      ...summaryBase,
      realLiveLocalPassCount,
      realLiveRemotePassCount,
      realRemoteLocalWorkerPassCount,
      realRemoteProductionPassCount,
      realLivePassCount,
      realLiveFailCount,
      realLiveInconclusiveCount,
      realPdfProofCount,
      mockRemotePassCount,
      REAL_REMOTE_LOCAL_WORKER:
        realRemoteLocalWorkerPassCount > 0 ? 'PROVEN' : 'NOT_PROVEN',
      REAL_REMOTE_PRODUCTION:
        realRemoteProductionPassCount > 0 ? 'PROVEN' : 'NOT_PROVEN',
      proofCounts: {
        REAL_LIVE_LOCAL_PASS: realLiveLocalPassCount,
        REAL_LIVE_REMOTE_PASS: realLiveRemotePassCount,
        REAL_REMOTE_LOCAL_WORKER_PASS: realRemoteLocalWorkerPassCount,
        REAL_REMOTE_PRODUCTION_PASS: realRemoteProductionPassCount,
        REAL_LIVE_PASS: realLivePassCount,
        REAL_LIVE_FAIL: realLiveFailCount,
        REAL_LIVE_INCONCLUSIVE: realLiveInconclusiveCount,
        REAL_PDF_PROOF_COUNT: realPdfProofCount,
        MOCK_REMOTE_PASS: mockRemotePassCount,
        FIXTURE_PASS: fixturePassCount,
        CACHE_RESULT: cacheResultCount,
        NOT_EXECUTED: notRunCount,
      },
      relevantNoticeCount,
      documentDownloadCount,
      validPdfCount,
      totalDurationMs,
      successfulWithNotices,
      successfulEmpty,
      liveExecutionCount: results.filter(
        (r) =>
          r.mode === 'LIVE' &&
          !r.fixtureSource &&
          (r.executionOrigin === 'REAL_LIVE_LOCAL' ||
            r.executionOrigin === 'REAL_LIVE_REMOTE' ||
            r.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
            r.executionOrigin === 'REAL_REMOTE_PRODUCTION')
      ).length,
      fixtureExecutionCount: results.filter(
        (r) => r.mode === 'FIXTURE' || r.fixtureSource || r.executionOrigin === 'FIXTURE'
      ).length,
      cachedExecutionCount: results.filter(
        (r) => r.mode === 'CACHE' || r.executionOrigin === 'CACHE'
      ).length,
      mockRemoteExecutionCount: results.filter(
        (r) => r.executionOrigin === 'MOCK_REMOTE'
      ).length,
      exitCode: computeLiveVerificationExitCode(summaryBase),
      results,
    };
  }

  /**
   * Section 11: Builds the Runner Health & Source Access Diagnostic Report.
   */
  async getRunnerHealthReport(
    results: RealLiveSourceVerificationResult[] = [],
    options: DiscoveryOptions = {}
  ): Promise<RunnerHealthReport> {
    const effectiveRunnerMode = resolveRunnerMode(options.runnerMode);
    const remoteRunner =
      options.remoteRunner ??
      (options.acquisitionRunner?.runnerKind === 'REMOTE'
        ? options.acquisitionRunner
        : new HttpRemoteAcquisitionRunner());

    const remoteConfigured = remoteRunner.isConfigured();
    const sanitizedRemoteConfig =
      remoteRunner instanceof HttpRemoteAcquisitionRunner
        ? remoteRunner.getSanitizedConfig()
        : {
            configured: remoteConfigured,
            workerEndpoint: remoteConfigured ? 'CUSTOM_REMOTE_RUNNER' : null,
            authConfigured: false,
          };

    const shortLabels: Record<string, string> = {
      'IN-CENTRAL-SSC': 'SSC',
      'IN-CENTRAL-UPSC': 'UPSC',
      'IN-CENTRAL-RRB': 'RRB',
      'IN-BIHAR-BPSC': 'BPSC',
      'IN-BIHAR-BSSC': 'BSSC',
      'IN-UP-UPPSC': 'UPPSC',
      'IN-UP-UPSSSC': 'UPSSSC',
    };

    const sourceAccess: Record<string, SourceAccessHealthRecord> = {};
    for (const r of results) {
      const key = shortLabels[r.sourceId] || r.sourceId;
      sourceAccess[key] = {
        sourceId: r.sourceId,
        source: key,
        officialEndpointStatus: r.officialEndpointStatus,
        runtimeAccessibility: r.runtimeAccessibility,
        runtimeAccessStatus: r.runtimeAccessStatus,
        runtimeCapabilities: r.runtimeCapabilities,
        localAccess: r.localAccess as RunnerAccessOutcome,
        remoteAccess: r.remoteAccess as RunnerAccessOutcome,
        selectedRunner: r.selectedRunner,
        reason: r.selectionReason || r.diagnostic,
      };
    }

    return {
      runnerMode: effectiveRunnerMode,
      LOCAL_RUNNER: {
        status: 'AVAILABLE',
        details: 'Local Node/Undici official acquisition runner active',
      },
      REMOTE_RUNNER: {
        status: !remoteConfigured
          ? 'NOT_CONFIGURED'
          : remoteRunner.isMock
          ? 'MOCK'
          : 'AVAILABLE',
        configured: remoteConfigured,
        isMock: remoteRunner.isMock,
        workerEndpoint: sanitizedRemoteConfig.workerEndpoint,
        authConfigured: sanitizedRemoteConfig.authConfigured,
        details: !remoteConfigured
          ? 'Remote official acquisition worker is not configured (OMNIHUB_REMOTE_WORKER_URL unset)'
          : remoteRunner.isMock
          ? 'Mock remote runner active (unit test mode only; never counted as REAL_LIVE_PASS)'
          : 'Remote official acquisition worker configured',
      },
      SOURCE_ACCESS: sourceAccess,
    };
  }

  getLatestRun(sourceId: string): SourceDiscoveryRunEntity | null {
    return this.repos.sourceDiscoveryRuns.findLatestBySource(sourceId);
  }

  listRecentRuns(limit = 50): SourceDiscoveryRunEntity[] {
    return this.repos.sourceDiscoveryRuns.listRecent(limit);
  }
}

let discoveryServiceInstance: DiscoveryService | null = null;

export function getDiscoveryService(): DiscoveryService {
  if (!discoveryServiceInstance) {
    discoveryServiceInstance = new DiscoveryService();
  }
  return discoveryServiceInstance;
}

export async function runRealLiveVerification(
  options: DiscoveryOptions & { timeoutMs?: number } = {}
): Promise<RealLiveVerificationSummary> {
  return getDiscoveryService().runRealLiveVerification(options);
}
