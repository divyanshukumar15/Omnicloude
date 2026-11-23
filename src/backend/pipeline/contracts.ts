/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PipelineStageName } from '../database/types.ts';
import type { StructuredLogger } from '../config/logger.ts';
import type { AuditService } from '../audit/audit-service.ts';
import type {
  DiscoveredDocument,
  DiscoveredNotice,
  NormalizedDocument,
} from '../ingestion/types.ts';
import type { DownloaderConfig } from '../ingestion/downloader/document-downloader.ts';
import type {
  OfficialAcquisitionRunner,
  RunnerKind,
  RunnerMode,
} from '../ingestion/discovery/acquisition-runner.ts';
import type { StructuredRecruitmentRecord } from '../extraction/types.ts';
import type { DeduplicationDecision } from '../deduplication/types.ts';
import type { PublishingEvaluationTarget, PublishingGateResult } from '../publishing-gate/types.ts';
import type { WordPressClientConfig, WordPressPublishStatus } from '../wordpress/types.ts';

export interface PipelineContext {
  jobId: string;
  correlationId: string;
  targetEntityType: string;
  targetEntityId: string;
  metadata: Record<string, unknown>;
  logger: StructuredLogger;
  auditService: AuditService;
}

/**
 * Declarative descriptor emitted by discovery stages to fan out independent,
 * deterministically idempotent child jobs linked via parent_job_id.
 */
export interface FanOutJobDescriptor {
  targetEntityType: string;
  targetEntityId: string;
  initialStage: PipelineStageName;
  dedupeKey: string;
  metadata: Record<string, unknown>;
  maxAttempts?: number;
}

/**
 * Canonical internal representation produced by DOCUMENT_DOWNLOAD
 * and consumed directly by DOCUMENT_VALIDATION and TEXT_EXTRACTION.
 */
export interface DownloadedDocumentArtifact {
  sourceId: string;
  documentId: string;
  sourceDocumentId: string;
  buffer: Buffer;
  sourceUrl: string;
  canonicalUrl: string;
  sourceDomain: string;
  byteLength: number;
  contentType: string;
  mimeType: string;
  checksumSha256: string;
  downloadedAt: string;
  documentType: string;
  filePath?: string;
  storageUri?: string;
  runner?: RunnerKind;
  workerId?: string | null;
  executionTimestamp?: string;
  httpStatus?: number | null;
  finalUrl?: string;
  contentLength?: number;
}

/**
 * Canonical validated PDF artifact produced by DOCUMENT_VALIDATION
 * and consumed directly by TEXT_EXTRACTION.
 */
export interface ValidatedDocumentArtifact {
  documentId: string;
  sourceDocumentId: string;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string;
  sourceDomain: string;
  documentType: string;
  sha256Hash: string;
  byteSize: number;
  pdfVersion: string;
  pageCount: number;
  mimeType: string;
  contentType: string;
  hasEofMarker: boolean;
  isValidStructure: boolean;
  mimeValidationPassed: boolean;
  downloadedAt: string;
  filePath?: string;
}

export interface SourceDiscoveryStageInput {
  sourceId?: string;
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  clientConfig?: WordPressClientConfig;
  wpStatus?: WordPressPublishStatus;
  categories?: string[];
  noticeCategory?: string;
  forceUpdate?: boolean;
}

export interface SourceDiscoveryStageOutput {
  sourceId: string;
  notices: DiscoveredNotice[];
  outcome?: 'SUCCESS_WITH_NOTICES' | 'SUCCESS_NO_RELEVANT_NOTICES';
  noOp?: boolean;
  discoveryMetadata: {
    adapterName: string;
    discoveredAt: string;
    noticeCount: number;
    runner?: RunnerKind;
    runnerMode?: RunnerMode;
    workerId?: string | null;
    executionTimestamp?: string;
    httpStatus?: number | null;
    finalUrl?: string | null;
    childJobIds?: string[];
    createdChildJobIds?: string[];
    dedupedChildJobIds?: string[];
  };
}

export interface DocumentDiscoveryStageInput {
  sourceId?: string;
  notice?: DiscoveredNotice;
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  clientConfig?: WordPressClientConfig;
  wpStatus?: WordPressPublishStatus;
  categories?: string[];
  noticeCategory?: string;
  forceUpdate?: boolean;
}

export interface DocumentDiscoveryStageOutput {
  sourceId: string;
  notice: DiscoveredNotice;
  discoveredDocuments: DiscoveredDocument[];
  outcome?: 'DOCUMENTS_DISCOVERED' | 'NO_DOCUMENT_AVAILABLE';
  noOp?: boolean;
  runnerMode?: RunnerMode;
  childJobIds?: string[];
  createdChildJobIds?: string[];
  dedupedChildJobIds?: string[];
}

export interface DocumentDownloadStageInput {
  sourceId?: string;
  documentUrl?: string;
  canonicalUrl?: string;
  documentType?: string;
  sourceDomain?: string;
  notice?: DiscoveredNotice;
  discoveredDocument?: DiscoveredDocument;
  documentId?: string;
  sourceDocumentId?: string;
  runnerMode?: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
  downloaderConfig?: DownloaderConfig;
}

export interface DocumentDownloadStageOutput extends DownloadedDocumentArtifact {
  downloadedDocument: DownloadedDocumentArtifact;
  attemptsUsed: number;
  retriesUsed: number;
}

export interface DocumentValidationStageInput {
  downloadedDocument?: DownloadedDocumentArtifact;
  buffer?: Buffer;
  documentId?: string;
  sourceDocumentId?: string;
  sourceId?: string;
  sourceUrl?: string;
  canonicalUrl?: string;
  sourceDomain?: string;
  documentType?: string;
  mimeType?: string;
  contentType?: string;
  downloadedAt?: string;
  filePath?: string;
}

export interface DocumentValidationStageOutput extends ValidatedDocumentArtifact {
  validatedDocument: ValidatedDocumentArtifact;
}

export interface TextExtractionStageInput {
  validatedDocument?: ValidatedDocumentArtifact;
  downloadedDocument?: DownloadedDocumentArtifact;
  buffer?: Buffer;
  documentId?: string;
  sourceDocumentId?: string;
  sourceId?: string;
  sourceUrl?: string;
  canonicalUrl?: string;
  sourceDomain?: string;
  documentType?: string;
  sha256Hash?: string;
  checksumSha256?: string;
  byteSize?: number;
  byteLength?: number;
  pageCount?: number;
  downloadedAt?: string;
  filePath?: string;
}

export interface TextExtractionStageOutput {
  document: NormalizedDocument;
  documentId: string;
  sourceDocumentId: string;
  extractionStatus: NormalizedDocument['extractionStatus'];
  extractionMethod: NormalizedDocument['extractionMethod'];
  isScanned: boolean;
  pageCount: number;
  pages: NormalizedDocument['pages'];
  qualityMetadata: NormalizedDocument['qualityMetadata'];
  ocrDetails?: NormalizedDocument['ocrDetails'];
}

export interface StructuredExtractionStageInput {
  document?: NormalizedDocument;
  documentId?: string;
  sourceId?: string;
}

export interface StructuredExtractionStageOutput extends StructuredRecruitmentRecord {
  record: StructuredRecruitmentRecord;
  structuredRecruitment: StructuredRecruitmentRecord;
  recruitmentId: string;
}

export interface EvidenceValidationStageInput {
  record?: StructuredRecruitmentRecord;
  structuredRecruitment?: StructuredRecruitmentRecord;
  recruitmentId?: string;
}

export interface EvidenceValidationStageOutput {
  recruitmentId: string;
  validationStatus: StructuredRecruitmentRecord['overallStatus'];
  evidenceCount: number;
  record: StructuredRecruitmentRecord;
  structuredRecruitment: StructuredRecruitmentRecord;
}

export interface DuplicateCheckStageOutput extends DeduplicationDecision {
  deduplicationDecision: DeduplicationDecision;
  recruitmentId?: string;
  duplicateSuppressed?: boolean;
  terminalReason?: string;
}

export interface PublishingGateStageOutput extends PublishingGateResult {
  publishingGateResult: PublishingGateResult;
  recruitmentId?: string;
}

export interface StageExecutionResult<TOutput = unknown> {
  success: boolean;
  output?: TOutput;
  errorCode?: string;
  errorMessage?: string;
  auditDetails?: Record<string, unknown>;
  /**
   * Non-binary durable metadata merged onto processing_jobs.metadata_json
   * so retries or process restarts can reconstruct stage inputs cleanly.
   */
  persistMetadata?: Record<string, unknown>;
  /**
   * Child jobs to create atomically (deduplicated via dedupeKey) linked via parent_job_id.
   */
  fanOutJobs?: FanOutJobDescriptor[];
  /**
   * When true, parks the parent job in PAUSED (AWAITING_CHILDREN) instead of advancing
   * or prematurely marking it COMPLETED before its child jobs finish WORDPRESS_PUBLISH.
   */
  awaitChildren?: boolean;
  /**
   * When true, terminates the processing job cleanly as a terminal NO-OP (COMPLETED)
   * at the current stage without advancing into downstream stages (e.g. DUPLICATE_SUPPRESSED,
   * SUCCESS_NO_RELEVANT_NOTICES, NO_DOCUMENT_AVAILABLE).
   */
  terminateAsNoOp?: boolean;
  /**
   * Machine-readable reason recorded on metadata and audit logs when terminateAsNoOp is true.
   */
  terminalReason?: string;
}

export interface IPipelineStageHandler<TInput = unknown, TOutput = unknown> {
  readonly stageName: PipelineStageName;
  execute(input: TInput, context: PipelineContext): Promise<StageExecutionResult<TOutput>>;
}

export type {
  DiscoveredDocument,
  DiscoveredNotice,
  NormalizedDocument,
  StructuredRecruitmentRecord,
  DeduplicationDecision,
  PublishingEvaluationTarget,
  PublishingGateResult,
};
