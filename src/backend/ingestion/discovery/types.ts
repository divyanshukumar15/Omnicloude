/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AdapterExecutionStatus } from '../../database/types.ts';
import type {
  EndpointClassification,
  LiveVerificationEvidenceArtifacts,
  VerificationExecutionMode,
  VerificationProofStatus,
} from './verification-gate.ts';

export type { EndpointClassification };
export type {
  ConnectionProbeStatus,
  DnsProbeStatus,
  TcpProbeStatus,
  TlsProbeStatus,
  RrbRegionalBoardProbeRecord,
  RrbRegionalClassification,
  SourceFailureClassification,
} from './connectivity-diagnostics.ts';
import type {
  AcquisitionExecutionOrigin,
  AcquisitionMethodType,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionRunner,
  OfficialAcquisitionRunner,
  OfficialEndpointVerificationState,
  OfficialSourceRunner,
  RemoteExecutionState,
  RunnerAccessOutcome,
  RunnerHealthReport,
  RunnerKind,
  RunnerMode,
  RuntimeAccessDiagnosticState,
  RuntimeAccessibilityState,
  SourceAccessHealthRecord,
  SourceRuntimeCapabilities,
} from './acquisition-runner.ts';
export type {
  AcquisitionExecutionOrigin,
  AcquisitionMethodType,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionRunner,
  OfficialAcquisitionRunner,
  OfficialEndpointVerificationState,
  OfficialSourceRunner,
  RemoteExecutionState,
  RunnerAccessOutcome,
  RunnerHealthReport,
  RunnerKind,
  RunnerMode,
  RuntimeAccessDiagnosticState,
  RuntimeAccessibilityState,
  SourceAccessHealthRecord,
  SourceRuntimeCapabilities,
};

export type NoticeCategory =
  | 'NOTIFICATION'
  | 'RECRUITMENT_NOTICE'
  | 'RECRUITMENT_PDF'
  | 'CORRIGENDUM'
  | 'ADDENDUM'
  | 'EXAM_NOTICE'
  | 'EXAM_DATE'
  | 'APPLICATION_NOTICE'
  | 'ADMIT_CARD'
  | 'RESULT'
  | 'ANSWER_KEY'
  | 'SYLLABUS'
  | 'IRRELEVANT_NOTICE'
  | 'TENDER'
  | 'UNKNOWN';

export type RecruitmentNoticeType =
  | 'NEW_RECRUITMENT'
  | 'RECRUITMENT_UPDATE'
  | 'CORRIGENDUM'
  | 'EXTENSION'
  | 'REVISED_NOTIFICATION'
  | 'DUPLICATE'
  | 'NON_RECRUITMENT'
  | 'IRRELEVANT'
  | 'UNKNOWN';

export type OfficialDocumentCategory =
  | 'RECRUITMENT_NOTIFICATION'
  | 'VACANCY_NOTICE'
  | 'APPLICATION_NOTICE'
  | 'EXAM_NOTICE'
  | 'CORRIGENDUM'
  | 'SYLLABUS'
  | 'ADMIT_CARD'
  | 'RESULT'
  | 'ANSWER_KEY'
  | 'OTHER';

export type DocumentEvidenceStage =
  | 'NONE'
  | 'NOTICE_FOUND'
  | 'DOCUMENT_URL_FOUND'
  | 'DOCUMENT_DOWNLOADED'
  | 'PDF_VALIDATED';

export interface DiscoveryEvidence {
  source: string;
  officialDomain: string;
  listingUrl: string;
  detailUrl: string | null;
  documentUrl: string;
  discoveredAt: string;
  adapterVersion: string;
  pageNumber: number;
  classification: string;
  classificationReason: string;
  confidence?: number;
  classificationConfidence?: number | null;
  sourceSpecificRule?: string;
}

export interface DiscoveredDocumentLink {
  url: string;
  canonicalUrl: string;
  title: string;
  documentType: 'PDF' | 'HTML' | 'DOC' | 'UNKNOWN';
  documentCategory?: OfficialDocumentCategory;
  fileSizeHint?: number;
  mimeTypeHint?: string;
  isPrimaryNotification: boolean;
  pageContextText?: string;
  publishedDate?: string;
  classificationReason?: string;
  confidence?: number;
  classificationConfidence?: number | null;
  sourceSpecificRule?: string;
  evidence?: DiscoveryEvidence;
  documentDiscoveryMethod?: 'DIRECT_PDF' | 'DETAIL_PAGE';
  pdfDownloadStatus?:
    | 'PDF_URL_DISCOVERED'
    | 'PDF_DOWNLOADED'
    | 'PDF_DOWNLOADED_AND_VALIDATED'
    | 'DOWNLOAD_FAILED'
    | 'INVALID_PDF';
  pdfDownloadedInCurrentRun?: boolean;
  sha256?: string;
  byteSize?: number;
  pageCount?: number;
  validationStatus?: 'VALID' | 'CORRUPT' | 'NOT_PDF' | 'UNVALIDATED';
}

export interface NormalizedNotice {
  sourceId: string;
  externalId: string;
  title: string;
  advertisementNumber: string | null;
  category: NoticeCategory;
  isRecruitmentRelated: boolean;
  recruitmentType: RecruitmentNoticeType;
  publishedDate: string | null;
  closingDate: string | null;
  rawNoticeUrl: string;
  detailUrl?: string | null;
  detailRequired?: boolean;
  detailResolved?: boolean | null;
  documentFlow?: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
  evidenceStage?: DocumentEvidenceStage;
  documents: DiscoveredDocumentLink[];
  regionalSubSource?: string | null;
  recruitmentIdentityKey?: string;
  evidence?: DiscoveryEvidence;
  classificationReason?: string;
  confidence?: number;
  classificationConfidence?: number | null;
  sourceSpecificRule?: string;
  pageNumber?: number;
  metadata: Record<string, unknown>;
}

export type EndpointOutcome =
  | 'ENDPOINT_SUCCESS'
  | 'ENDPOINT_EMPTY_VALID'
  | 'ENDPOINT_WRONG_CONTENT'
  | 'ENDPOINT_PARSE_FAILED'
  | 'ENDPOINT_UNAVAILABLE'
  | 'ENDPOINT_BLOCKED'
  | 'ENDPOINT_STRUCTURE_CHANGED'
  | 'ENDPOINT_INCONCLUSIVE';

import type {
  NetworkErrorClassification,
  StructuredFetchDiagnostic,
} from './network-error-classifier.ts';

export type { NetworkErrorClassification, StructuredFetchDiagnostic };

export type MachineFailureReason =
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'HTTP_TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'NETWORK_UNAVAILABLE'
  | 'UNKNOWN_NETWORK_ERROR'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'HTTP_502'
  | 'HTTP_503'
  | 'HTTP_504'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'ACCESS_BLOCKED'
  | 'CAPTCHA'
  | 'ANTI_BOT'
  | 'JS_REQUIRED'
  | 'WRONG_CONTENT'
  | 'WRONG_ENDPOINT'
  | 'EMPTY_EXPECTED_SECTION'
  | 'PARSE_FAILED'
  | 'NO_RELEVANT_NOTICE'
  | 'DETAIL_REQUIRED'
  | 'DETAIL_NOT_RESOLVED'
  | 'DETAIL_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_LINK_MISSING'
  | 'DOCUMENT_DOWNLOAD_FAILED'
  | 'INVALID_DOCUMENT'
  | 'INVALID_MIME'
  | 'INVALID_MAGIC_BYTES'
  | 'INVALID_PDF'
  | 'PDF_CORRUPT'
  | 'EXTERNAL_REDIRECT_BLOCKED'
  | 'SOURCE_STRUCTURE_CHANGED'
  | 'ADAPTER_STRUCTURE_CHANGED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CACHED_RESULT'
  | 'NONE';

export interface RetryDiagnosticEntry {
  attempt: number;
  maxAttempts: number;
  reason: string;
  statusCode: number | null;
  delayMs: number;
  errorType?: NetworkErrorClassification;
  errorCode?: string | null;
  errorName?: string;
  errorMessage?: string;
  cause?: string | null;
  requestUrl?: string;
  hostname?: string | null;
  httpStatus?: number | null;
  timeoutMs?: number;
  retryable?: boolean;
  retryDelayMs?: number;
}

export interface AttemptedEndpointLog {
  endpointId: string;
  url: string;
  priority: number;
  outcome: EndpointOutcome;
  endpointClassification?: EndpointClassification;
  officialDomain?: string;
  officialDomainVerified?: boolean;
  httpStatus: number | null;
  responseContentType?: string | null;
  responseBytes?: number | null;
  responseTimeMs?: number | null;
  noticesCount: number;
  validPdfsCount?: number;
  reason?: string;
  redirectChain?: string[];
  attemptsUsed?: number;
  retriesUsed?: number;
  retryReasons?: string[];
  retryDiagnostics?: RetryDiagnosticEntry[];
  attemptDiagnostics?: StructuredFetchDiagnostic[];
  lastErrorType?: NetworkErrorClassification | null;
  lastErrorCode?: string | null;
  lastErrorName?: string | null;
  lastErrorMessage?: string | null;
  lastErrorCause?: string | null;
  lastErrorRetryable?: boolean | null;
}

export interface StructuredLiveVerificationEvidence {
  sourceId: string;
  endpointId: string;
  requestedUrl: string;
  finalUrl: string | null;
  officialDomain?: string;
  officialDomainVerified?: boolean;
  endpointClassification?: EndpointClassification;
  httpStatus?: number | null;
  responseContentType?: string | null;
  responseBytes?: number | null;
  responseTimeMs?: number | null;
  redirectChain?: string[];
  endpointReached: boolean;
  endpointValidated?: boolean;
  listingValidated: boolean;
  relevantNoticeFound: boolean;
  detailRequired: boolean;
  detailResolved: boolean | null;
  documentFlow?: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
  documentDiscovered: boolean;
  documentDownloaded: boolean;
  pdfValidated: boolean;
  evidenceStage: DocumentEvidenceStage;
  evidence: LiveVerificationEvidenceArtifacts;
  pagesAttempted: number;
  pagesFetched: number;
  noticesDiscovered: number;
  detailUrlsDiscovered: number;
  detailRequestsAttempted: number;
  detailPagesFetched: number;
  detailPagesParsed: number;
  detailPagesWithDocuments: number;
  documentUrlsDiscovered: number;
  documentDownloadAttempts: number;
  documentsDownloaded: number;
  documentsValidated: number;
  invalidDocuments: number;
  downloadFailures: number;
  pdfCandidates: number;
  pdfDownloadAttempts: number;
  pdfDownloadsSucceeded: number;
  pdfValidationAttempts: number;
  validPdfs: number;
  pdfsValidated: number;
  invalidPdfs: number;
  failedStages: string[];
  failureReasons: string[];
  responseSource: 'LIVE_EXECUTION' | 'CACHED_RESULT' | 'LIVE' | 'CACHE' | 'STALE';
  verificationMode: VerificationExecutionMode;
  verificationStatus: VerificationProofStatus;
  startedAt: string;
  completedAt: string;
  failureReason: MachineFailureReason;
  errorDiagnostic: string;
  outcome: 'PASS' | 'INCONCLUSIVE' | 'FAIL';
  finalStatus: AdapterExecutionStatus;
}

export interface PdfFixtureSpec {
  status?: number;
  contentType?: string;
  body: Buffer | string;
}

export interface DiscoveryOptions {
  limit?: number;
  maxPages?: number;
  maxNotices?: number;
  verificationMode?: VerificationExecutionMode;
  fixtureHtml?: string;
  pageFixtures?: Record<number, string>;
  endpointFixtures?: Record<string, string | { status?: number; html: string; finalUrl?: string }>;
  detailFixtures?: Record<string, string | null>;
  pdfFixtures?: Record<string, Buffer | string | PdfFixtureSpec>;
  page?: number;
  cacheTtlMs?: number;
  noCache?: boolean;
  correlationId?: string;
  fetchDetailPages?: boolean;
  downloadAndValidatePdfs?: boolean;
  endpointId?: string;
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  verbose?: boolean;
  strictLiveMode?: boolean;
  connectivityProbe?: boolean;
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  scanAllRegionalEndpoints?: boolean;
}

export interface DiscoveryLimits {
  maxPages: number;
  maxNotices: number;
  requestTimeoutMs: number;
  maxRetries: number;
  perNoticeDocumentLimit: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxPages: 3,
  maxNotices: 30,
  requestTimeoutMs: 15000,
  maxRetries: 2,
  perNoticeDocumentLimit: 10,
};

export interface DiscoveryExecutionMetrics {
  pagesRequested: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesCrawled: number;
  durationMs: number;
  retryCount: number;
  rejectedUrlsCount: number;
  noticesDiscovered: number;
  documentsDiscovered: number;
  // Section 4: Endpoints & Listing pages validated
  endpointsReached?: number;
  listingPagesValidated?: number;
  // Detail metrics (Section 8)
  detailUrlsDiscovered?: number;
  detailRequestsAttempted?: number;
  detailPagesFetched?: number;
  detailPagesParsed?: number;
  detailPagesWithDocuments?: number;
  // Document metrics (Section 9)
  documentUrlsDiscovered?: number;
  documentDownloadAttempts?: number;
  documentsDownloaded?: number;
  documentsValidated?: number;
  invalidDocuments?: number;
  downloadFailures?: number;
  // PDF metrics (Section 10)
  pdfCandidates?: number;
  pdfDownloadAttempts?: number;
  pdfDownloadsSucceeded?: number;
  pdfValidationAttempts?: number;
  validPdfs?: number;
  pdfsValidated?: number;
  invalidPdfs?: number;
  // Fallback & Retry telemetry (Section 4, 7 & 13)
  selectedEndpointId?: string;
  selectedEndpointUrl?: string;
  primaryEndpoint?: string;
  officialDomain?: string;
  officialDomainVerified?: boolean;
  endpointClassification?: EndpointClassification;
  responseContentType?: string | null;
  responseBytes?: number | null;
  responseTimeMs?: number | null;
  attemptedEndpoints?: AttemptedEndpointLog[];
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRetries?: number;
  attempts?: number;
  requestAttempts?: number;
  retryReasons?: string[];
  retryDiagnostics?: RetryDiagnosticEntry[];
  attemptDiagnostics?: StructuredFetchDiagnostic[];
  lastErrorType?: NetworkErrorClassification | null;
  lastErrorCode?: string | null;
  lastErrorName?: string | null;
  lastErrorMessage?: string | null;
  lastErrorCause?: string | null;
  lastErrorRetryable?: boolean | null;
  runnerMode?: RunnerMode;
  selectedRunner?: RunnerKind;
  actualRunner?: RunnerKind;
  runner?: RunnerKind;
  remoteStatus?: RemoteExecutionState;
  localAccess?: RunnerAccessOutcome | string;
  remoteAccess?: RunnerAccessOutcome | string;
  selectionReason?: string;
  executionOrigin?: AcquisitionExecutionOrigin;
  failureClass?: string;
}

export interface DiscoveryExecutionResult {
  sourceId: string;
  authorityName?: string;
  primaryEndpoint?: string;
  officialDomain?: string;
  officialDomainVerified?: boolean;
  endpointClassification?: EndpointClassification;
  responseContentType?: string | null;
  responseBytes?: number | null;
  responseTimeMs?: number | null;
  status: AdapterExecutionStatus;
  outcome?: 'PASS' | 'INCONCLUSIVE' | 'FAIL';
  technicalFailure?: boolean;
  verifiedLive: boolean;
  fixtureSource?: boolean;
  verificationMode?: VerificationExecutionMode;
  verificationStatus?: VerificationProofStatus;
  detailRequired?: boolean;
  detailResolved?: boolean | null;
  documentFlow?: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
  evidenceStage?: DocumentEvidenceStage;
  evidence?: LiveVerificationEvidenceArtifacts;
  startedAt: string;
  completedAt: string;
  httpStatus: number | null;
  finalUrl: string | null;
  recordsFound: number;
  documentsFound: number;
  ignoredCount?: number;
  notices: NormalizedNotice[];
  cached?: boolean;
  cacheState?: 'LIVE' | 'CACHED' | 'STALE';
  responseSource?: 'LIVE_EXECUTION' | 'CACHED_RESULT';
  failureReasons?: string[];
  verificationEvidence?: StructuredLiveVerificationEvidence;
  errorCode?: string | null;
  errorType?: NetworkErrorClassification | null;
  errorName?: string | null;
  errorCause?: string | null;
  errorMessage?: string | null;
  lastErrorType?: NetworkErrorClassification | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  runnerMode?: RunnerMode;
  selectedRunner?: RunnerKind;
  actualRunner?: RunnerKind;
  runner?: RunnerKind;
  remoteStatus?: RemoteExecutionState;
  localAccess?: RunnerAccessOutcome | string;
  remoteAccess?: RunnerAccessOutcome | string;
  selectionReason?: string;
  executionOrigin?: AcquisitionExecutionOrigin;
  failureClass?: string;
  metrics: DiscoveryExecutionMetrics;
}

export interface AdapterHealthCheckResult {
  sourceId: string;
  isHealthy: boolean;
  verifiedLive: boolean;
  testOutcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  httpStatus?: number | null;
  responseTimeMs: number;
  details: string;
  diagnostics?: Record<string, unknown>;
}

export interface MultiSourceDiscoverySummary {
  startedAt: string;
  completedAt: string;
  totalSources: number;
  successfulSources: number;
  successfulWithNotices: number;
  successfulEmpty: number;
  failedSources: number;
  failed: number;
  inconclusiveSources: number;
  inconclusive: number;
  totalNoticesFound: number;
  totalDocumentsFound: number;
  results: Record<string, DiscoveryExecutionResult>;
}
