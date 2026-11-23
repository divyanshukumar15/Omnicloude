/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DiscoveredNotice,
  DiscoveredDocument,
  NormalizedDocument,
} from '../types.ts';
import type {
  DiscoveryExecutionResult,
  DiscoveredDocumentLink,
  NoticeCategory,
  NormalizedNotice,
  DiscoveryOptions,
} from '../discovery/types.ts';
import type { AdapterExecutionStatus } from '../../database/types.ts';

export type Jurisdiction = 'CENTRAL' | 'BIHAR' | 'UTTAR_PRADESH';

export type DomainTrustCategory = 'OFFICIAL_DOMAIN' | 'NON_OFFICIAL_DOMAIN' | 'UNKNOWN_DOMAIN';

export interface OfficialUrlValidationResult {
  url: string;
  canonicalUrl: string;
  trustCategory: DomainTrustCategory;
  isOfficial: boolean;
  hostname: string;
  reason?: string;
}

export type SourceHealthState =
  | 'UP'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'BLOCKED'
  | 'STRUCTURE_CHANGED'
  | 'UNKNOWN';

export interface SourceHealthResult {
  sourceId: string;
  authorityName: string;
  jurisdiction: Jurisdiction;
  baseUrl: string;
  officialDomains: string[];
  status: 'HEALTHY' | 'UNHEALTHY' | 'UNVERIFIED';
  healthState: SourceHealthState;
  verifiedLive: boolean;
  statusCode?: number;
  httpStatus?: number | null;
  latencyMs?: number;
  durationMs?: number;
  message: string;
  checkedAt: string;
  testOutcome?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  lastSuccessfulDiscovery?: string | null;
  lastAttemptedDiscovery?: string | null;
  lastError?: string | null;
  parserStatus?: string;
  discoveredCount?: number;
  adapterVersion?: string;
  runnerUsed?: RunnerKind;
  executionOrigin?: AcquisitionExecutionOrigin;
  workerId?: string | null;
  executionTimestamp?: string;
  finalUrl?: string | null;
  contentType?: string | null;
  contentLength?: number | null;
}

export interface SourceHealthCheckOptions {
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  preferRemote?: boolean;
}

export type AdapterDiscoveryPathMode = 'DIRECT_PDF' | 'DETAIL_PAGE' | 'HYBRID';

export type SourceDocumentFlow =
  | 'LISTING_TO_DOCUMENT'
  | 'LISTING_TO_DETAIL_TO_DOCUMENT';

export interface NoticeDetailStrategyEvaluation {
  documentFlow: SourceDocumentFlow;
  detailRequired: boolean;
  detailUrl: string | null;
  directDocuments: DiscoveredDocumentLink[];
}

import type {
  AcquisitionExecutionOrigin,
  NetworkErrorClassification,
  OfficialAcquisitionRunner,
  RetryDiagnosticEntry,
  RunnerAccessOutcome,
  RunnerKind,
  RunnerMode,
  StructuredFetchDiagnostic,
} from '../discovery/types.ts';

export interface DetailPageFollowResult {
  pageFetched: boolean;
  documents: DiscoveredDocumentLink[];
  attemptsUsed?: number;
  retriesUsed?: number;
  retryReasons?: string[];
  retryDiagnostics?: RetryDiagnosticEntry[];
  attemptDiagnostics?: StructuredFetchDiagnostic[];
  lastErrorType?: NetworkErrorClassification | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  runnerUsed?: RunnerKind;
  executionOrigin?: AcquisitionExecutionOrigin;
  localAccess?: RunnerAccessOutcome | string;
  remoteAccess?: RunnerAccessOutcome | string;
  selectedRunner?: RunnerKind;
  selectionReason?: string;
}

export interface ISourceAdapter {
  readonly sourceId: string;
  readonly name: string;
  readonly authorityName: string;
  readonly jurisdiction: Jurisdiction;
  readonly baseUrl: string;
  readonly officialDomains: string[];
  readonly adapterVersion: string;
  readonly defaultDiscoveryPath: AdapterDiscoveryPathMode;

  /**
   * Performs an actual network verification check against the official portal.
   * NEVER marks verifiedLive: true unless an HTTP response is actually received.
   * Runner-aware: respects RUNNER_MODE (LOCAL | REMOTE | AUTO) and never runs local fetch when REMOTE is requested.
   */
  healthCheck(timeoutMs?: number, options?: SourceHealthCheckOptions): Promise<SourceHealthResult>;

  /**
   * Health check accessor as required by standard SourceAdapter contract.
   */
  getSourceHealth(timeoutMs?: number, options?: SourceHealthCheckOptions): Promise<SourceHealthResult>;

  /**
   * Validates whether a target URL belongs to an official trusted government domain.
   */
  validateOfficialUrl(url: string): Promise<OfficialUrlValidationResult>;

  /**
   * Discovers recruitment notices from the official portal.
   * Throws classified IngestionError (e.g. SOURCE_UNAVAILABLE) if connection fails.
   */
  discoverNotices(options?: DiscoveryOptions): Promise<DiscoveredNotice[]>;

  /**
   * Discovers official document URLs attached to a notice.
   */
  discoverDocuments(notice: DiscoveredNotice, options?: DiscoveryOptions): Promise<DiscoveredDocument[]>;

  /**
   * Applies source-specific normalization rules to the document.
   */
  normalizeDocument(doc: NormalizedDocument): Promise<NormalizedDocument>;

  /**
   * High-level discovery execution with full tracking, classification, limits, and metrics.
   */
  executeDiscovery(options?: DiscoveryOptions): Promise<DiscoveryExecutionResult>;

  /**
   * Extracts verified document links from HTML or API response content.
   */
  extractDocumentLinks(htmlOrContent: string, pageUrl: string): DiscoveredDocumentLink[];

  /**
   * Classifies notice into standard categories.
   */
  classifyNotice(title: string, context?: string): NoticeCategory;

  /**
   * Returns fallback candidate endpoints in priority order.
   */
  getFallbackEndpoints(): string[];

  /**
   * Parses official notice listings from HTML or API response content.
   */
  parseNotices(htmlContent: string, currentUrl: string): {
    notices: NormalizedNotice[];
    structureIntact: boolean;
    detailRequired?: boolean;
    documentFlow?: SourceDocumentFlow;
  };

  /**
   * Determines whether a notice discovered on a listing page requires resolving a detail page
   * vs exposing official PDF documents directly from the listing page.
   */
  evaluateNoticeDetailStrategy(notice: NormalizedNotice): NoticeDetailStrategyEvaluation;

  /**
   * Returns current execution status of this adapter.
   */
  getSourceStatus(): AdapterExecutionStatus;

  /**
   * Fetches target URL with bounded retries and security checks.
   */
  fetchWithRetry(
    targetUrl: string,
    options?: {
      timeoutMs?: number;
      connectionTimeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      maxDownloadBytes?: number;
      maxRedirectHops?: number;
      allowHttp?: boolean;
      expectedContentType?: string;
      methodType?: 'LISTING' | 'DETAIL' | 'PROBE';
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
    }
  ): Promise<{
    status: number;
    text: string;
    finalUrl: string;
    attemptsUsed: number;
    retriesUsed: number;
    retryReasons: string[];
    retryDiagnostics: RetryDiagnosticEntry[];
    attemptDiagnostics?: StructuredFetchDiagnostic[];
    contentType?: string;
    responseBytes?: number;
    responseTimeMs?: number;
    redirectChain?: string[];
    runnerUsed?: RunnerKind;
    executionOrigin?: AcquisitionExecutionOrigin;
    workerId?: string | null;
    executionTimestamp?: string;
    localAccess?: RunnerAccessOutcome | string;
    remoteAccess?: RunnerAccessOutcome | string;
    selectedRunner?: RunnerKind;
    selectionReason?: string;
  }>;

  /**
   * Follows official detail page to extract attached documents.
   */
  followDetailPage(
    detailUrl: string,
    options?: {
      timeoutMs?: number;
      connectionTimeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      detailFixtures?: Record<string, string | null>;
      strictLiveMode?: boolean;
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
    }
  ): Promise<DiscoveredDocumentLink[]>;

  /**
   * Follows official detail page and reports both whether the page HTTP fetch succeeded
   * and the extracted documents.
   */
  followDetailPageWithStatus(
    detailUrl: string,
    options?: {
      timeoutMs?: number;
      connectionTimeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      detailFixtures?: Record<string, string | null>;
      strictLiveMode?: boolean;
      runnerMode?: RunnerMode;
      acquisitionRunner?: OfficialAcquisitionRunner;
      remoteRunner?: OfficialAcquisitionRunner;
      preferRemote?: boolean;
    }
  ): Promise<DetailPageFollowResult>;

  /**
   * Discovers next page link in HTML if present.
   */
  extractPaginationNextUrl(htmlContent: string, currentUrl: string): string | null;

  /**
   * Generates URL for a specific page number.
   */
  getPageUrl(pageNumber: number, baseUrl: string): string | null;
}
