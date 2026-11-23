/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  DocumentDiscoveryStageInput,
  DocumentDiscoveryStageOutput,
  DocumentDownloadStageInput,
  DocumentDownloadStageOutput,
  DocumentValidationStageInput,
  DocumentValidationStageOutput,
  DownloadedDocumentArtifact,
  EvidenceValidationStageInput,
  EvidenceValidationStageOutput,
  FanOutJobDescriptor,
  IPipelineStageHandler,
  PipelineContext,
  SourceDiscoveryStageInput,
  SourceDiscoveryStageOutput,
  StageExecutionResult,
  StructuredExtractionStageInput,
  StructuredExtractionStageOutput,
  TextExtractionStageInput,
  TextExtractionStageOutput,
  ValidatedDocumentArtifact,
} from './contracts.ts';
import { sourceRegistry } from '../ingestion/adapters/registry.ts';
import {
  DocumentDownloader,
  type DownloaderConfig,
} from '../ingestion/downloader/document-downloader.ts';
import {
  HttpRemoteAcquisitionRunner,
  resolveRunnerMode,
  type OfficialAcquisitionRunner,
  type RunnerMode,
} from '../ingestion/discovery/acquisition-runner.ts';
import { PdfValidator } from '../ingestion/pdf/pdf-validator.ts';
import { OcrOrchestrator } from '../ingestion/ocr/ocr-orchestrator.ts';
import { OcrChecksumCache } from '../ingestion/ocr/ocr-cache.ts';
import type { OCRProvider } from '../ingestion/ocr/types.ts';
import { ProvenanceService } from '../ingestion/provenance/provenance-service.ts';
import { getDocumentStorageService, DocumentStorageError } from '../storage/index.ts';
import { getRepositories, type RepositoryContainer } from '../database/index.ts';
import {
  buildDocumentDedupeKey,
  buildNoticeDedupeKey,
} from '../jobs/job-service.ts';
import {
  IngestionError,
  type DiscoveredNotice,
  type NormalizedDocument,
  type NormalizedPage,
} from '../ingestion/types.ts';
import type { StructuredRecruitmentRecord } from '../extraction/types.ts';

function extractSerializablePassthrough(
  input: Record<string, unknown> | undefined,
  context: PipelineContext
): Record<string, unknown> {
  const keys = [
    'clientConfig',
    'wpStatus',
    'categories',
    'noticeCategory',
    'forceUpdate',
    'runnerMode',
    'runnerIntent',
    'scheduledBy',
    'scheduledAutomatically',
    'scheduledWindowKey',
    'seededAt',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const val = input?.[key] ?? context.metadata[key];
    if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

function resolveStageRunnerOptions(
  input:
    | {
        runnerMode?: RunnerMode;
        acquisitionRunner?: OfficialAcquisitionRunner;
        remoteRunner?: OfficialAcquisitionRunner;
      }
    | undefined,
  context: PipelineContext
): {
  runnerMode: RunnerMode;
  acquisitionRunner?: OfficialAcquisitionRunner;
  remoteRunner?: OfficialAcquisitionRunner;
} {
  const rawMode =
    input?.runnerMode ??
    (typeof context.metadata.runnerMode === 'string'
      ? (context.metadata.runnerMode as RunnerMode)
      : undefined);
  return {
    runnerMode: resolveRunnerMode(rawMode),
    acquisitionRunner: input?.acquisitionRunner,
    remoteRunner: input?.remoteRunner,
  };
}

function loadPdfBufferFromDurableStorage(params: {
  filePath?: string;
  sha256Hash?: string;
}): Buffer | undefined {
  const storage = getDocumentStorageService();
  if (params.sha256Hash && storage.exists(params.sha256Hash)) {
    return storage.readDocument(params.sha256Hash, params.sha256Hash).buffer;
  }
  if (params.filePath && fs.existsSync(params.filePath)) {
    return storage.readDocument(params.filePath, params.sha256Hash).buffer;
  }
  return undefined;
}

function resolveHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function ensureSourceAndSourceDocument(
  repos: RepositoryContainer,
  params: {
    sourceId: string;
    sourceDocumentId: string;
    documentUrl: string;
    title?: string | null;
    documentType?: string;
    rawHash?: string | null;
    sourceDomain?: string;
    status?: 'DISCOVERED' | 'DOWNLOADING' | 'DOWNLOADED' | 'FAILED' | 'IGNORED';
  }
): string {
  if (!repos.sources.findById(params.sourceId)) {
    const adapter = sourceRegistry.get(params.sourceId);
    const baseUrl =
      adapter?.baseUrl ||
      (params.sourceDomain ? `https://${params.sourceDomain}` : params.documentUrl || 'https://gov.in');
    repos.sources.create({
      id: params.sourceId,
      name: adapter?.name || params.sourceId,
      type: 'PORTAL',
      base_url: baseUrl,
      is_active: 1,
      check_interval_minutes: 60,
      config_json: '{}',
    });
  }

  const existingById = repos.sourceDocuments.findById(params.sourceDocumentId);
  if (existingById) {
    if (params.status && existingById.status !== params.status) {
      repos.sourceDocuments.updateStatus(existingById.id, params.status);
    }
    return existingById.id;
  }

  const { entity } = repos.sourceDocuments.upsertCanonical({
    id: params.sourceDocumentId,
    source_id: params.sourceId,
    url: params.documentUrl,
    canonical_url: params.documentUrl,
    title: params.title ?? params.documentType ?? 'Official Recruitment Document',
    document_type: params.documentType || 'NOTIFICATION_PDF',
    raw_hash: params.rawHash ?? null,
    status: params.status || 'DOWNLOADED',
    metadata_json: null,
  });
  return entity.id;
}

export function reconstructNormalizedDocumentFromDb(
  repos: RepositoryContainer,
  documentId: string,
  fallbackSourceId?: string
): NormalizedDocument | null {
  const dbDoc = repos.documents.findById(documentId);
  if (!dbDoc) return null;

  const dbPages = repos.documents.getPages(documentId);
  const srcDoc = repos.sourceDocuments.findById(dbDoc.source_document_id);
  const sourceId = srcDoc?.source_id || fallbackSourceId || 'UNKNOWN_SOURCE';

  const pages: NormalizedPage[] = dbPages.map((p) => ({
    documentId: p.document_id,
    pageNumber: p.page_number,
    extractedText: p.extracted_text,
    charCount: p.char_count,
    extractionMethod: p.extraction_method as NormalizedPage['extractionMethod'],
    isScanned: p.is_scanned === 1,
    qualityScore: p.quality_score ?? undefined,
  }));

  const totalChars = pages.reduce((acc, p) => acc + p.charCount, 0);
  const scannedCount = pages.filter((p) => p.isScanned).length;
  const pageCount = dbDoc.page_count || pages.length;
  const extractionMethod = (dbDoc.extraction_method ||
    'DIRECT_TEXT') as NormalizedDocument['extractionMethod'];
  const extractionStatus = (dbDoc.extraction_status ||
    'EXTRACTED') as NormalizedDocument['extractionStatus'];

  return {
    id: dbDoc.id,
    sourceId,
    sourceUrl: dbDoc.source_url || srcDoc?.url || '',
    canonicalUrl: dbDoc.canonical_url || dbDoc.source_url || srcDoc?.url || '',
    sourceDomain: dbDoc.source_domain || resolveHostname(dbDoc.canonical_url || dbDoc.source_url || ''),
    checksumSha256: dbDoc.sha256_hash || '',
    fileSize: dbDoc.file_size || 0,
    pageCount,
    discoveryTimestamp: srcDoc?.discovered_at || dbDoc.downloaded_at,
    downloadTimestamp: dbDoc.downloaded_at,
    documentType: srcDoc?.document_type || 'NOTIFICATION_PDF',
    validationNotes: dbDoc.validation_notes ?? undefined,
    extractionStatus,
    extractionMethod,
    isScanned: dbDoc.is_scanned === 1,
    pages,
    qualityMetadata: {
      totalCharacters: totalChars,
      avgCharsPerPage: pageCount > 0 ? Math.round(totalChars / pageCount) : 0,
      scannedPageCount: scannedCount,
      textPageCount: Math.max(0, pageCount - scannedCount),
      isScannedDocument: dbDoc.is_scanned === 1,
      extractionMethod,
    },
  };
}

export function reconstructStructuredRecruitmentFromDb(
  repos: RepositoryContainer,
  recruitmentId: string
): StructuredRecruitmentRecord | null {
  const row = repos.recruitments.findById(recruitmentId);
  if (!row || !row.raw_payload_json) return null;
  try {
    const parsed = JSON.parse(row.raw_payload_json) as StructuredRecruitmentRecord;
    if (parsed && parsed.fields && parsed.id) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export class SourceDiscoveryStageHandler
  implements IPipelineStageHandler<SourceDiscoveryStageInput, SourceDiscoveryStageOutput>
{
  readonly stageName = 'SOURCE_DISCOVERY' as const;

  async execute(
    input: SourceDiscoveryStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<SourceDiscoveryStageOutput>> {
    const startedAt = new Date().toISOString();
    const sourceId =
      input?.sourceId ||
      (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined) ||
      context.targetEntityId;
    const adapter = sourceRegistry.get(sourceId);

    const scheduledBy =
      typeof context.metadata.scheduledBy === 'string'
        ? context.metadata.scheduledBy
        : 'MANUAL_OR_API';
    const scheduledAutomatically = Boolean(
      context.metadata.scheduledAutomatically ?? scheduledBy === 'SOURCE_DISCOVERY_SEEDER'
    );
    const scheduledWindowKey =
      typeof context.metadata.scheduledWindowKey === 'string'
        ? context.metadata.scheduledWindowKey
        : null;
    const seededAt =
      typeof context.metadata.seededAt === 'string' ? context.metadata.seededAt : null;
    const runnerOptions = resolveStageRunnerOptions(input, context);
    const requestedRunnerMode = runnerOptions.runnerMode;
    const remoteRunnerConfigured = runnerOptions.remoteRunner
      ? runnerOptions.remoteRunner.isConfigured()
      : new HttpRemoteAcquisitionRunner().isConfigured();

    const buildAuditRecord = (
      actualRunner: 'LOCAL' | 'REMOTE' | null,
      workerId: string | null = null,
      extra: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      sourceId,
      scheduledAutomatically,
      scheduledBy,
      scheduledWindowKey,
      seededAt,
      requestedRunnerMode,
      runnerMode: requestedRunnerMode,
      actualRunner,
      runner: actualRunner,
      remoteConfigured: remoteRunnerConfigured,
      workerId,
      ...extra,
    });

    const recordDiscoveryRun = (params: {
      httpStatus: number | null;
      finalUrl: string | null;
      recordsFound: number;
      documentsFound: number;
      adapterStatus:
        | 'SUCCESS_WITH_NOTICES'
        | 'SUCCESS_NO_RELEVANT_NOTICES'
        | 'SOURCE_UNAVAILABLE';
      errorCode?: string | null;
      errorMessage?: string | null;
      actualRunner?: 'LOCAL' | 'REMOTE' | null;
      workerId?: string | null;
    }) => {
      try {
        const repos = getRepositories();
        if (!repos.sources.findById(sourceId)) {
          return;
        }
        repos.sourceDiscoveryRuns.create({
          id: crypto.randomUUID(),
          source_id: sourceId,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          http_status: params.httpStatus,
          final_url: params.finalUrl,
          records_found: params.recordsFound,
          documents_found: params.documentsFound,
          adapter_status: params.adapterStatus,
          error_code: params.errorCode ?? null,
          error_message: params.errorMessage ?? null,
          metrics_json: JSON.stringify({
            jobId: context.jobId,
            correlationId: context.correlationId,
            stage: 'SOURCE_DISCOVERY',
            ...buildAuditRecord(params.actualRunner ?? null, params.workerId ?? null),
          }),
        });
      } catch {
        // Non-fatal history persistence guard
      }
    };

    if (!adapter) {
      recordDiscoveryRun({
        httpStatus: null,
        finalUrl: null,
        recordsFound: 0,
        documentsFound: 0,
        adapterStatus: 'SOURCE_UNAVAILABLE',
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `Source adapter "${sourceId}" is not registered`,
        actualRunner: null,
      });
      return {
        success: false,
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `Source adapter "${sourceId}" is not registered`,
        auditDetails: buildAuditRecord(null, null),
      };
    }

    const health = await adapter.healthCheck(undefined, runnerOptions);
    const actualRunner: 'LOCAL' | 'REMOTE' =
      health.runnerUsed ?? (requestedRunnerMode === 'REMOTE' ? 'REMOTE' : 'LOCAL');

    if (!health.verifiedLive) {
      recordDiscoveryRun({
        httpStatus: health.httpStatus ?? null,
        finalUrl: health.finalUrl ?? adapter.baseUrl,
        recordsFound: 0,
        documentsFound: 0,
        adapterStatus: 'SOURCE_UNAVAILABLE',
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `Official source "${adapter.name}" could not be verified live (${requestedRunnerMode}): ${health.message}`,
        actualRunner,
        workerId: health.workerId ?? null,
      });
      return {
        success: false,
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `Official source "${adapter.name}" could not be verified live (${requestedRunnerMode}): ${health.message}`,
        auditDetails: buildAuditRecord(actualRunner, health.workerId ?? null, { health }),
      };
    }

    try {
      const notices = await adapter.discoverNotices({
        runnerMode: requestedRunnerMode,
        acquisitionRunner: runnerOptions.acquisitionRunner,
        remoteRunner: runnerOptions.remoteRunner,
      });
      if (notices.length === 0) {
        const discoveredAt = new Date().toISOString();
        recordDiscoveryRun({
          httpStatus: health.httpStatus ?? 200,
          finalUrl: health.finalUrl ?? adapter.baseUrl,
          recordsFound: 0,
          documentsFound: 0,
          adapterStatus: 'SUCCESS_NO_RELEVANT_NOTICES',
          errorCode: null,
          errorMessage: null,
          actualRunner,
          workerId: health.workerId ?? null,
        });
        return {
          success: true,
          terminateAsNoOp: true,
          terminalReason: 'SUCCESS_NO_RELEVANT_NOTICES',
          output: {
            sourceId,
            notices: [],
            outcome: 'SUCCESS_NO_RELEVANT_NOTICES',
            noOp: true,
            discoveryMetadata: {
              adapterName: adapter.name,
              discoveredAt,
              noticeCount: 0,
              runner: actualRunner,
              runnerMode: requestedRunnerMode,
              workerId: health.workerId ?? null,
              executionTimestamp: health.executionTimestamp ?? discoveredAt,
              httpStatus: health.httpStatus ?? 200,
              finalUrl: health.finalUrl ?? adapter.baseUrl,
            },
          },
          persistMetadata: {
            ...buildAuditRecord(actualRunner, health.workerId ?? null),
            discoveredNoticeCount: 0,
            discoveryOutcome: 'SUCCESS_NO_RELEVANT_NOTICES',
            lastDiscoveredAt: discoveredAt,
          },
          auditDetails: buildAuditRecord(actualRunner, health.workerId ?? null, {
            noticeCount: 0,
            outcome: 'SUCCESS_NO_RELEVANT_NOTICES',
          }),
        };
      }

      const passthrough = extractSerializablePassthrough(
        input as Record<string, unknown> | undefined,
        context
      );

      const fanOutJobs: FanOutJobDescriptor[] = notices.map((notice) => ({
        targetEntityType: 'NOTICE',
        targetEntityId: notice.id,
        initialStage: 'DOCUMENT_DISCOVERY',
        dedupeKey: buildNoticeDedupeKey(sourceId, notice.noticeUrl),
        metadata: {
          ...passthrough,
          runnerMode: requestedRunnerMode,
          sourceId,
          notice,
        },
      }));

      const discoveredAt = new Date().toISOString();
      recordDiscoveryRun({
        httpStatus: health.httpStatus ?? 200,
        finalUrl: health.finalUrl ?? adapter.baseUrl,
        recordsFound: notices.length,
        documentsFound: 0,
        adapterStatus: 'SUCCESS_WITH_NOTICES',
        actualRunner,
        workerId: health.workerId ?? null,
      });

      return {
        success: true,
        output: {
          sourceId,
          notices,
          outcome: 'SUCCESS_WITH_NOTICES',
          noOp: false,
          discoveryMetadata: {
            adapterName: adapter.name,
            discoveredAt,
            noticeCount: notices.length,
            runner: actualRunner,
            runnerMode: requestedRunnerMode,
            workerId: health.workerId ?? null,
            executionTimestamp: health.executionTimestamp ?? discoveredAt,
            httpStatus: health.httpStatus ?? 200,
            finalUrl: health.finalUrl ?? adapter.baseUrl,
          },
        },
        fanOutJobs,
        awaitChildren: true,
        persistMetadata: {
          ...buildAuditRecord(actualRunner, health.workerId ?? null),
          discoveredNoticeCount: notices.length,
          lastDiscoveredAt: discoveredAt,
        },
        auditDetails: buildAuditRecord(actualRunner, health.workerId ?? null, {
          noticeCount: notices.length,
          outcome: 'SUCCESS_WITH_NOTICES',
        }),
      };
    } catch (err) {
      const code = err instanceof IngestionError ? err.code : 'SOURCE_UNAVAILABLE';
      recordDiscoveryRun({
        httpStatus: health.httpStatus ?? null,
        finalUrl: health.finalUrl ?? adapter.baseUrl,
        recordsFound: 0,
        documentsFound: 0,
        adapterStatus: 'SOURCE_UNAVAILABLE',
        errorCode: code,
        errorMessage: (err as Error).message,
        actualRunner,
        workerId: health.workerId ?? null,
      });
      return {
        success: false,
        errorCode: code,
        errorMessage: (err as Error).message,
        auditDetails: buildAuditRecord(actualRunner, health.workerId ?? null, {
          errorCode: code,
        }),
      };
    }
  }
}

export class DocumentDiscoveryStageHandler
  implements IPipelineStageHandler<DocumentDiscoveryStageInput, DocumentDiscoveryStageOutput>
{
  readonly stageName = 'DOCUMENT_DISCOVERY' as const;

  async execute(
    input: DocumentDiscoveryStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<DocumentDiscoveryStageOutput>> {
    const sourceId =
      input?.sourceId ||
      (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined) ||
      context.targetEntityId;
    const adapter = sourceRegistry.get(sourceId);

    if (!adapter) {
      return {
        success: false,
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `Source adapter "${sourceId}" not found`,
      };
    }

    const notice =
      input?.notice ||
      (context.metadata.notice as DiscoveredNotice | undefined);
    if (!notice || !notice.noticeUrl) {
      return {
        success: false,
        errorCode: 'NO_NOTICE_FOUND',
        errorMessage: 'Notice or noticeUrl missing for document discovery',
      };
    }

    try {
      const runnerOptions = resolveStageRunnerOptions(input, context);
      const normalizedNotice: DiscoveredNotice = {
        ...notice,
        sourceId,
      };
      const docs = await adapter.discoverDocuments(normalizedNotice, {
        runnerMode: runnerOptions.runnerMode,
        acquisitionRunner: runnerOptions.acquisitionRunner,
        remoteRunner: runnerOptions.remoteRunner,
      });

      if (docs.length === 0) {
        return {
          success: true,
          terminateAsNoOp: true,
          terminalReason: 'NO_DOCUMENT_AVAILABLE',
          output: {
            sourceId,
            notice: normalizedNotice,
            discoveredDocuments: [],
            outcome: 'NO_DOCUMENT_AVAILABLE',
            noOp: true,
            runnerMode: runnerOptions.runnerMode,
          },
          persistMetadata: {
            sourceId,
            runnerMode: runnerOptions.runnerMode,
            noticeId: normalizedNotice.id,
            noticeUrl: normalizedNotice.noticeUrl,
            discoveredDocumentCount: 0,
            documentDiscoveryOutcome: 'NO_DOCUMENT_AVAILABLE',
          },
          auditDetails: {
            sourceId,
            noticeId: normalizedNotice.id,
            noticeUrl: normalizedNotice.noticeUrl,
            documentCount: 0,
            outcome: 'NO_DOCUMENT_AVAILABLE',
          },
        };
      }

      const passthrough = extractSerializablePassthrough(
        input as Record<string, unknown> | undefined,
        context
      );

      // Deterministic fan-out: each discovered document gets its own independent child job
      // with stable official dedupe identity: sourceId + canonicalDocumentUrl.
      const fanOutJobs: FanOutJobDescriptor[] = docs.map((doc) => {
        const canonicalDocUrl = doc.canonicalUrl || doc.documentUrl;
        return {
          targetEntityType: 'DOCUMENT',
          targetEntityId: doc.id,
          initialStage: 'DOCUMENT_DOWNLOAD',
          dedupeKey: buildDocumentDedupeKey(sourceId, canonicalDocUrl),
          metadata: {
            ...passthrough,
            runnerMode: runnerOptions.runnerMode,
            sourceId,
            notice: normalizedNotice,
            documentUrl: doc.documentUrl,
            canonicalUrl: canonicalDocUrl,
            documentType: doc.documentType,
            sourceDomain: doc.sourceDomain,
            discoveredDocument: doc,
          },
        };
      });

      return {
        success: true,
        output: {
          sourceId,
          notice: normalizedNotice,
          discoveredDocuments: docs,
          outcome: 'DOCUMENTS_DISCOVERED',
          noOp: false,
          runnerMode: runnerOptions.runnerMode,
        },
        fanOutJobs,
        awaitChildren: true,
        persistMetadata: {
          sourceId,
          runnerMode: runnerOptions.runnerMode,
          noticeId: normalizedNotice.id,
          noticeUrl: normalizedNotice.noticeUrl,
          discoveredDocumentCount: docs.length,
        },
      };
    } catch (err) {
      const code = err instanceof IngestionError ? err.code : 'NO_NOTICE_FOUND';
      return {
        success: false,
        errorCode: code,
        errorMessage: (err as Error).message,
      };
    }
  }
}

export class DocumentDownloadStageHandler
  implements IPipelineStageHandler<DocumentDownloadStageInput, DocumentDownloadStageOutput>
{
  readonly stageName = 'DOCUMENT_DOWNLOAD' as const;
  private downloader: DocumentDownloader;
  private defaultDownloadConfig: DownloaderConfig;

  constructor(downloader?: DocumentDownloader, defaultDownloadConfig: DownloaderConfig = {}) {
    this.downloader = downloader ?? new DocumentDownloader();
    this.defaultDownloadConfig = defaultDownloadConfig;
  }

  async execute(
    input: DocumentDownloadStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<DocumentDownloadStageOutput>> {
    const discoveredDoc =
      input?.discoveredDocument ??
      (context.metadata.discoveredDocument as
        | { documentUrl?: string; canonicalUrl?: string; documentType?: string; sourceDomain?: string; title?: string }
        | undefined);
    const url =
      input?.documentUrl ||
      discoveredDoc?.documentUrl ||
      (typeof context.metadata.documentUrl === 'string' ? context.metadata.documentUrl : undefined);
    const sourceId =
      input?.sourceId ||
      (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined) ||
      'UNKNOWN_SOURCE';

    if (!url) {
      return {
        success: false,
        errorCode: 'DOWNLOAD_FAILED',
        errorMessage: 'Missing documentUrl for download stage',
      };
    }

    const runnerOptions = resolveStageRunnerOptions(input, context);
    const downloadConfig: DownloaderConfig = {
      ...this.defaultDownloadConfig,
      runnerMode: runnerOptions.runnerMode,
      ...(runnerOptions.acquisitionRunner
        ? { acquisitionRunner: runnerOptions.acquisitionRunner }
        : {}),
      ...(runnerOptions.remoteRunner ? { remoteRunner: runnerOptions.remoteRunner } : {}),
      ...(input?.downloaderConfig || {}),
      ...(sourceId !== 'UNKNOWN_SOURCE' ? { sourceId } : {}),
    };

    try {
      const downloaded = await this.downloader.download(url, downloadConfig);
      const checksumSha256 = downloaded.checksumSha256 || PdfValidator.computeSha256(downloaded.buffer);
      const storage = getDocumentStorageService();
      const storedDoc = storage.saveDocument({
        buffer: downloaded.buffer,
        expectedSha256: checksumSha256,
      });
      const filePath = storedDoc.filePath;
      const storageUri = storedDoc.storageUri;

      const documentId =
        input?.documentId ||
        (typeof context.metadata.documentId === 'string' ? context.metadata.documentId : undefined) ||
        `doc-${context.jobId}`;
      const sourceDocumentId =
        input?.sourceDocumentId ||
        (typeof context.metadata.sourceDocumentId === 'string'
          ? context.metadata.sourceDocumentId
          : undefined) ||
        `srcdoc-${context.jobId}`;
      const documentType =
        input?.documentType ||
        discoveredDoc?.documentType ||
        (typeof context.metadata.documentType === 'string'
          ? context.metadata.documentType
          : 'NOTIFICATION_PDF');
      const contentType = downloaded.contentType || downloaded.mimeType || 'application/pdf';
      const runnerUsed = downloaded.runner ?? downloaded.runnerUsed ?? 'LOCAL';
      const workerId = downloaded.workerId ?? null;
      const executionTimestamp = downloaded.executionTimestamp ?? downloaded.downloadedAt;
      const httpStatus = downloaded.httpStatus ?? 200;
      const finalUrl = downloaded.finalUrl || downloaded.canonicalUrl;
      const contentLength = downloaded.contentLength ?? downloaded.byteLength;

      // Persist durable source/document metadata atomically so concurrent workers converge to canonical IDs
      const repos = getRepositories();
      const canonicalSourceDocumentId = ensureSourceAndSourceDocument(repos, {
        sourceId,
        sourceDocumentId,
        documentUrl: finalUrl || downloaded.sourceUrl,
        title: discoveredDoc?.title || input?.notice?.title || documentType,
        documentType,
        rawHash: checksumSha256,
        sourceDomain: downloaded.sourceDomain,
        status: 'DOWNLOADED',
      });

      const existingById = repos.documents.findById(documentId);
      let canonicalDocumentId = documentId;
      if (!existingById) {
        const { entity: docRow } = repos.documents.upsertByHash({
          id: documentId,
          source_document_id: canonicalSourceDocumentId,
          source_url: downloaded.sourceUrl,
          canonical_url: finalUrl,
          source_domain: downloaded.sourceDomain,
          file_path: filePath,
          file_size: contentLength,
          page_count: null,
          mime_type: contentType,
          sha256_hash: checksumSha256,
          storage_uri: storageUri,
          validation_status: 'UNVALIDATED',
          validation_notes: null,
          extraction_status: 'PENDING',
          extraction_method: null,
          is_scanned: 0,
        });
        canonicalDocumentId = docRow.id;
      } else {
        repos.documents.updateValidation(documentId, {
          validationStatus: 'UNVALIDATED',
          sha256Hash: checksumSha256,
          fileSize: contentLength,
          filePath,
        });
      }

      const artifact: DownloadedDocumentArtifact = {
        sourceId,
        documentId: canonicalDocumentId,
        sourceDocumentId: canonicalSourceDocumentId,
        buffer: downloaded.buffer,
        sourceUrl: downloaded.sourceUrl,
        canonicalUrl: finalUrl,
        sourceDomain: downloaded.sourceDomain,
        byteLength: contentLength,
        contentType,
        mimeType: contentType,
        checksumSha256,
        downloadedAt: downloaded.downloadedAt,
        documentType,
        filePath,
        storageUri,
        runner: runnerUsed,
        workerId,
        executionTimestamp,
        httpStatus,
        finalUrl,
        contentLength,
      };

      return {
        success: true,
        output: {
          ...artifact,
          downloadedDocument: artifact,
          attemptsUsed: downloaded.attemptsUsed,
          retriesUsed: downloaded.retriesUsed,
        },
        persistMetadata: {
          sourceId,
          documentId: canonicalDocumentId,
          sourceDocumentId: canonicalSourceDocumentId,
          documentUrl: url,
          sourceUrl: artifact.sourceUrl,
          canonicalUrl: artifact.canonicalUrl,
          finalUrl,
          sourceDomain: artifact.sourceDomain,
          documentType: artifact.documentType,
          byteLength: artifact.byteLength,
          contentLength,
          contentType: artifact.contentType,
          mimeType: artifact.mimeType,
          checksumSha256,
          downloadedAt: artifact.downloadedAt,
          filePath,
          storageUri,
          runner: runnerUsed,
          workerId,
          executionTimestamp,
          httpStatus,
        },
      };
    } catch (err) {
      const code =
        err instanceof DocumentStorageError
          ? err.code
          : err instanceof IngestionError
            ? err.code
            : 'DOWNLOAD_FAILED';
      return {
        success: false,
        errorCode: code,
        errorMessage: (err as Error).message,
      };
    }
  }
}

export class DocumentValidationStageHandler
  implements IPipelineStageHandler<DocumentValidationStageInput, DocumentValidationStageOutput>
{
  readonly stageName = 'DOCUMENT_VALIDATION' as const;
  private validator = new PdfValidator();

  async execute(
    input: DocumentValidationStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<DocumentValidationStageOutput>> {
    const downloaded = input?.downloadedDocument;
    const repos = getRepositories();

    const documentId =
      downloaded?.documentId ||
      input?.documentId ||
      (typeof context.metadata.documentId === 'string' ? context.metadata.documentId : undefined) ||
      `doc-${context.jobId}`;
    const sourceDocumentId =
      downloaded?.sourceDocumentId ||
      input?.sourceDocumentId ||
      (typeof context.metadata.sourceDocumentId === 'string'
        ? context.metadata.sourceDocumentId
        : undefined) ||
      `srcdoc-${context.jobId}`;
    const sourceId =
      downloaded?.sourceId ||
      input?.sourceId ||
      (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined) ||
      'UNKNOWN_SOURCE';

    let filePath =
      downloaded?.filePath ||
      input?.filePath ||
      (typeof context.metadata.filePath === 'string' ? context.metadata.filePath : undefined);
    let buffer: Buffer | undefined = downloaded?.buffer ?? input?.buffer;

    const expectedSha256 =
      downloaded?.checksumSha256 ||
      (typeof context.metadata.checksumSha256 === 'string'
        ? context.metadata.checksumSha256
        : undefined);

    if (!buffer) {
      try {
        const dbDoc = repos.documents.findById(documentId);
        filePath = filePath || dbDoc?.file_path || undefined;
        buffer = loadPdfBufferFromDurableStorage({
          filePath,
          sha256Hash: expectedSha256 || dbDoc?.sha256_hash || undefined,
        });
      } catch (storageErr) {
        const code =
          storageErr instanceof DocumentStorageError ? storageErr.code : 'CORRUPT_PDF';
        return {
          success: false,
          errorCode: code,
          errorMessage: (storageErr as Error).message,
        };
      }
    }

    if (!buffer) {
      return {
        success: false,
        errorCode: 'CORRUPT_PDF',
        errorMessage: 'Missing buffer (and no durable file_path found) for PDF validation stage',
      };
    }

    const mimeType =
      downloaded?.mimeType ||
      downloaded?.contentType ||
      input?.mimeType ||
      input?.contentType ||
      (typeof context.metadata.mimeType === 'string' ? context.metadata.mimeType : 'application/pdf');
    const normalizedMime = mimeType.toLowerCase();
    const mimeValidationPassed =
      normalizedMime.includes('pdf') || normalizedMime.includes('octet-stream') || normalizedMime === '';

    try {
      const metadata = await this.validator.validate(buffer);
      if (!filePath) {
        const stored = getDocumentStorageService().saveDocument({
          buffer,
          expectedSha256: metadata.sha256Hash,
        });
        filePath = stored.filePath;
      }

      const sourceUrl =
        downloaded?.sourceUrl ||
        input?.sourceUrl ||
        (typeof context.metadata.sourceUrl === 'string' ? context.metadata.sourceUrl : '') ||
        (typeof context.metadata.documentUrl === 'string' ? context.metadata.documentUrl : '');
      const canonicalUrl =
        downloaded?.canonicalUrl ||
        input?.canonicalUrl ||
        (typeof context.metadata.canonicalUrl === 'string' ? context.metadata.canonicalUrl : '') ||
        sourceUrl;
      const sourceDomain =
        downloaded?.sourceDomain ||
        input?.sourceDomain ||
        (typeof context.metadata.sourceDomain === 'string' ? context.metadata.sourceDomain : '') ||
        resolveHostname(canonicalUrl);
      const documentType =
        downloaded?.documentType ||
        input?.documentType ||
        (typeof context.metadata.documentType === 'string'
          ? context.metadata.documentType
          : 'NOTIFICATION_PDF');
      const downloadedAt =
        downloaded?.downloadedAt ||
        input?.downloadedAt ||
        (typeof context.metadata.downloadedAt === 'string'
          ? context.metadata.downloadedAt
          : new Date().toISOString());

      // Persist validated status onto documents row if present
      if (repos.documents.findById(documentId)) {
        repos.documents.updateValidation(documentId, {
          validationStatus: 'VALID',
          sha256Hash: metadata.sha256Hash,
          fileSize: metadata.byteSize,
          pageCount: metadata.pageCount,
          filePath,
          validationNotes: `Validated %PDF-${metadata.pdfVersion}, %%EOF, ${metadata.pageCount} pages`,
        });
      }

      const validatedArtifact: ValidatedDocumentArtifact = {
        documentId,
        sourceDocumentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        documentType,
        sha256Hash: metadata.sha256Hash,
        byteSize: metadata.byteSize,
        pdfVersion: metadata.pdfVersion,
        pageCount: metadata.pageCount,
        mimeType,
        contentType: mimeType,
        hasEofMarker: metadata.hasEofMarker,
        isValidStructure: metadata.isValidStructure,
        mimeValidationPassed,
        downloadedAt,
        filePath,
      };

      return {
        success: true,
        output: {
          ...validatedArtifact,
          validatedDocument: validatedArtifact,
        },
        persistMetadata: {
          documentId,
          sourceDocumentId,
          sourceId,
          sourceUrl,
          canonicalUrl,
          sourceDomain,
          documentType,
          sha256Hash: metadata.sha256Hash,
          checksumSha256: metadata.sha256Hash,
          byteSize: metadata.byteSize,
          pdfVersion: metadata.pdfVersion,
          pageCount: metadata.pageCount,
          mimeType,
          mimeValidationPassed,
          pdfValidated: true,
          filePath,
        },
      };
    } catch (err) {
      const code = err instanceof IngestionError ? err.code : 'CORRUPT_PDF';
      if (repos.documents.findById(documentId)) {
        repos.documents.updateValidation(documentId, {
          validationStatus: code === 'NOT_PDF' ? 'INVALID' : 'CORRUPTED',
          validationNotes: (err as Error).message,
        });
      }
      return {
        success: false,
        errorCode: code,
        errorMessage: (err as Error).message,
      };
    }
  }
}

export interface TextExtractionStageHandlerOptions {
  ocrOrchestrator?: OcrOrchestrator;
  ocrProvider?: OCRProvider;
}

export class TextExtractionStageHandler
  implements IPipelineStageHandler<TextExtractionStageInput, TextExtractionStageOutput>
{
  readonly stageName = 'TEXT_EXTRACTION' as const;
  private injectedOrchestrator?: OcrOrchestrator;
  private injectedProvider?: OCRProvider;

  constructor(options: TextExtractionStageHandlerOptions = {}) {
    this.injectedOrchestrator = options.ocrOrchestrator;
    this.injectedProvider = options.ocrProvider;
  }

  private resolveOrchestrator(repos: RepositoryContainer): OcrOrchestrator {
    if (this.injectedOrchestrator) {
      return this.injectedOrchestrator;
    }
    return new OcrOrchestrator({
      provider: this.injectedProvider,
      cache: new OcrChecksumCache(repos.ocrCache),
    });
  }

  async execute(
    input: TextExtractionStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<TextExtractionStageOutput>> {
    const repos = getRepositories();
    const validated = input?.validatedDocument;
    const downloaded = input?.downloadedDocument;

    const documentId =
      validated?.documentId ||
      downloaded?.documentId ||
      input?.documentId ||
      (typeof context.metadata.documentId === 'string' ? context.metadata.documentId : undefined) ||
      `doc-${context.jobId}`;
    const sourceDocumentId =
      validated?.sourceDocumentId ||
      downloaded?.sourceDocumentId ||
      input?.sourceDocumentId ||
      (typeof context.metadata.sourceDocumentId === 'string'
        ? context.metadata.sourceDocumentId
        : undefined) ||
      `srcdoc-${context.jobId}`;
    const sourceId =
      validated?.sourceId ||
      downloaded?.sourceId ||
      input?.sourceId ||
      (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined) ||
      'UNKNOWN_SOURCE';

    let filePath =
      validated?.filePath ||
      downloaded?.filePath ||
      input?.filePath ||
      (typeof context.metadata.filePath === 'string' ? context.metadata.filePath : undefined);
    let buffer: Buffer | undefined = downloaded?.buffer ?? input?.buffer;

    const expectedSha256 =
      validated?.sha256Hash ||
      downloaded?.checksumSha256 ||
      input?.sha256Hash ||
      input?.checksumSha256 ||
      (typeof context.metadata.sha256Hash === 'string' ? context.metadata.sha256Hash : undefined) ||
      (typeof context.metadata.checksumSha256 === 'string'
        ? context.metadata.checksumSha256
        : undefined);

    if (!buffer) {
      try {
        const dbDoc = repos.documents.findById(documentId);
        filePath = filePath || dbDoc?.file_path || undefined;
        buffer = loadPdfBufferFromDurableStorage({
          filePath,
          sha256Hash: expectedSha256 || dbDoc?.sha256_hash || undefined,
        });
      } catch (storageErr) {
        const code =
          storageErr instanceof DocumentStorageError ? storageErr.code : 'EXTRACTION_FAILED';
        return {
          success: false,
          errorCode: code,
          errorMessage: (storageErr as Error).message,
        };
      }
    }

    if (!buffer) {
      return {
        success: false,
        errorCode: 'EXTRACTION_FAILED',
        errorMessage: 'Missing PDF buffer (and no durable file_path found) for text extraction stage',
      };
    }

    const sourceUrl =
      validated?.sourceUrl ||
      downloaded?.sourceUrl ||
      input?.sourceUrl ||
      (typeof context.metadata.sourceUrl === 'string' ? context.metadata.sourceUrl : '') ||
      (typeof context.metadata.documentUrl === 'string' ? context.metadata.documentUrl : '') ||
      `https://gov.in/${documentId}.pdf`;
    const canonicalUrl =
      validated?.canonicalUrl ||
      downloaded?.canonicalUrl ||
      input?.canonicalUrl ||
      (typeof context.metadata.canonicalUrl === 'string' ? context.metadata.canonicalUrl : '') ||
      sourceUrl;
    const sourceDomain =
      validated?.sourceDomain ||
      downloaded?.sourceDomain ||
      input?.sourceDomain ||
      (typeof context.metadata.sourceDomain === 'string' ? context.metadata.sourceDomain : '') ||
      resolveHostname(canonicalUrl) ||
      'gov.in';
    const checksumSha256 =
      validated?.sha256Hash ||
      downloaded?.checksumSha256 ||
      input?.sha256Hash ||
      input?.checksumSha256 ||
      (typeof context.metadata.sha256Hash === 'string' ? context.metadata.sha256Hash : '') ||
      PdfValidator.computeSha256(buffer);
    const fileSize =
      validated?.byteSize ||
      downloaded?.byteLength ||
      input?.byteSize ||
      input?.byteLength ||
      buffer.length;
    const documentType =
      validated?.documentType ||
      downloaded?.documentType ||
      input?.documentType ||
      (typeof context.metadata.documentType === 'string'
        ? context.metadata.documentType
        : 'NOTIFICATION_PDF');

    try {
      const orchestrator = this.resolveOrchestrator(repos);
      const rawNormalized = await orchestrator.processDocument({
        documentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        checksumSha256,
        fileSize,
        documentType,
        buffer,
      });

      const adapter = sourceRegistry.get(sourceId);
      const finalDoc: NormalizedDocument = adapter
        ? await adapter.normalizeDocument(rawNormalized)
        : rawNormalized;

      // Ensure durable source, source_document, document, and page provenance rows exist atomically
      const canonicalSourceDocId = ensureSourceAndSourceDocument(repos, {
        sourceId,
        sourceDocumentId,
        documentUrl: canonicalUrl,
        documentType,
        rawHash: checksumSha256,
        sourceDomain,
        status: 'DOWNLOADED',
      });

      let resolvedDocumentId = documentId;
      const existingDoc = repos.documents.findById(documentId) ?? repos.documents.findByHash(checksumSha256);
      if (!existingDoc) {
        const provenanceService = new ProvenanceService(repos.documents, repos.evidence);
        const persistedDoc = await provenanceService.persistProvenance(
          finalDoc,
          canonicalSourceDocId,
          filePath
        );
        resolvedDocumentId = persistedDoc.id;
      } else {
        resolvedDocumentId = existingDoc.id;
        repos.documents.updateValidation(resolvedDocumentId, {
          validationStatus: 'VALID',
          sha256Hash: checksumSha256,
          fileSize,
          pageCount: finalDoc.pageCount,
          filePath: filePath ?? existingDoc.file_path,
        });
        repos.documents.updateExtractionStatus(resolvedDocumentId, {
          status: finalDoc.extractionStatus,
          method: finalDoc.extractionMethod,
          isScanned: finalDoc.isScanned ? 1 : 0,
          pageCount: finalDoc.pageCount,
          validationNotes:
            finalDoc.validationNotes ??
            `Extracted ${finalDoc.pageCount} pages via ${finalDoc.extractionMethod}`,
        });
        repos.documents.replacePages(
          resolvedDocumentId,
          finalDoc.pages.map((p) => ({
            id: crypto.randomUUID(),
            document_id: resolvedDocumentId,
            page_number: p.pageNumber,
            char_count: p.charCount,
            extracted_text: p.extractedText,
            extraction_method: p.extractionMethod,
            is_scanned: p.isScanned ? 1 : 0,
            quality_score: p.qualityScore ?? (p.isScanned ? 0.1 : 0.9),
          }))
        );
      }

      const resolvedFinalDoc: NormalizedDocument =
        resolvedDocumentId === finalDoc.id
          ? finalDoc
          : {
              ...finalDoc,
              id: resolvedDocumentId,
              pages: finalDoc.pages.map((p) => ({ ...p, documentId: resolvedDocumentId })),
            };

      const output: TextExtractionStageOutput = {
        document: resolvedFinalDoc,
        documentId: resolvedDocumentId,
        sourceDocumentId: canonicalSourceDocId,
        extractionStatus: resolvedFinalDoc.extractionStatus,
        extractionMethod: resolvedFinalDoc.extractionMethod,
        isScanned: resolvedFinalDoc.isScanned,
        pageCount: resolvedFinalDoc.pageCount,
        pages: resolvedFinalDoc.pages,
        qualityMetadata: resolvedFinalDoc.qualityMetadata,
        ocrDetails: resolvedFinalDoc.ocrDetails,
      };

      const persistMetadata = {
        sourceId,
        documentId: resolvedDocumentId,
        sourceDocumentId: canonicalSourceDocId,
        canonicalUrl,
        sourceUrl,
        sourceDomain,
        checksumSha256,
        extractionStatus: finalDoc.extractionStatus,
        extractionMethod: finalDoc.extractionMethod,
        pageCount: finalDoc.pageCount,
        filePath,
      };

      const isSuccessfulExtraction =
        finalDoc.extractionStatus === 'EXTRACTED' ||
        finalDoc.extractionStatus === 'OCR_SUCCESS';

      if (!isSuccessfulExtraction) {
        const failureCode =
          finalDoc.extractionStatus === 'OCR_UNAVAILABLE'
            ? 'OCR_UNAVAILABLE'
            : finalDoc.extractionStatus === 'OCR_TIMEOUT'
              ? 'OCR_TIMEOUT'
              : finalDoc.extractionStatus === 'OCR_LIMIT_EXCEEDED'
                ? 'OCR_LIMIT_EXCEEDED'
                : finalDoc.extractionStatus === 'OCR_LOW_QUALITY'
                  ? 'OCR_LOW_QUALITY'
                  : finalDoc.extractionStatus === 'OCR_PARTIAL'
                    ? 'OCR_PARTIAL'
                    : finalDoc.extractionStatus === 'OCR_REQUIRED'
                      ? 'OCR_REQUIRED'
                      : 'EXTRACTION_FAILED';

        return {
          success: false,
          output,
          errorCode: failureCode,
          errorMessage:
            finalDoc.ocrDetails?.failureReason ||
            finalDoc.validationNotes ||
            `Text/OCR extraction did not succeed (status: ${finalDoc.extractionStatus})`,
          persistMetadata,
          auditDetails: {
            documentId,
            extractionStatus: finalDoc.extractionStatus,
            extractionMethod: finalDoc.extractionMethod,
            ocrDetails: finalDoc.ocrDetails,
          },
        };
      }

      return {
        success: true,
        output,
        persistMetadata,
        auditDetails: {
          documentId,
          extractionStatus: finalDoc.extractionStatus,
          extractionMethod: finalDoc.extractionMethod,
          pageCount: finalDoc.pageCount,
          totalCharacters: finalDoc.qualityMetadata.totalCharacters,
        },
      };
    } catch (err) {
      const code = err instanceof IngestionError ? err.code : 'EXTRACTION_FAILED';
      return {
        success: false,
        errorCode: code,
        errorMessage: (err as Error).message,
      };
    }
  }
}

export class StructuredExtractionStageHandler
  implements IPipelineStageHandler<StructuredExtractionStageInput, StructuredExtractionStageOutput>
{
  readonly stageName = 'STRUCTURED_EXTRACTION' as const;

  async execute(
    input: StructuredExtractionStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<StructuredExtractionStageOutput>> {
    const repos = getRepositories();
    let document = input?.document;

    if (!document) {
      const documentId =
        input?.documentId ||
        (typeof context.metadata.documentId === 'string' ? context.metadata.documentId : undefined);
      const sourceId =
        input?.sourceId ||
        (typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined);
      if (documentId) {
        document = reconstructNormalizedDocumentFromDb(repos, documentId, sourceId) ?? undefined;
      }
    }

    if (!document) {
      return {
        success: false,
        errorCode: 'EXTRACTION_FAILED',
        errorMessage: 'Missing normalized document for structured extraction stage',
      };
    }

    try {
      const { getExtractionService } = await import('../extraction/index.ts');
      const extractionService = getExtractionService();
      // BUG 5: Do NOT persist recruitment before DUPLICATE_CHECK runs.
      // Extract deterministically as an in-memory candidate carrying canonicalIdentityKey.
      const record = await extractionService.extractRecruitment(document, context.correlationId, {
        persist: false,
      });

      const output: StructuredExtractionStageOutput = {
        ...record,
        record,
        structuredRecruitment: record,
        recruitmentId: record.id,
      };

      return {
        success: record.overallStatus !== 'REJECTED',
        output,
        errorCode: record.overallStatus === 'REJECTED' ? 'EVIDENCE_VALIDATION_FAILED' : undefined,
        errorMessage:
          record.overallStatus === 'REJECTED'
            ? 'Recruitment validation rejected due to evidence failure or invalid calendar dates'
            : undefined,
        persistMetadata: {
          documentId: document.id,
          recruitmentId: record.id,
          canonicalIdentityKey: record.canonicalIdentityKey ?? null,
          extractionOverallStatus: record.overallStatus,
          persistedBeforeDedup: false,
        },
      };
    } catch (err) {
      return {
        success: false,
        errorCode: 'EXTRACTION_FAILED',
        errorMessage: (err as Error).message,
      };
    }
  }
}

export class EvidenceValidationStageHandler
  implements IPipelineStageHandler<EvidenceValidationStageInput, EvidenceValidationStageOutput>
{
  readonly stageName = 'EVIDENCE_VALIDATION' as const;

  async execute(
    input: EvidenceValidationStageInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<EvidenceValidationStageOutput>> {
    let record = input?.record ?? input?.structuredRecruitment;

    if (!record) {
      const repos = getRepositories();
      const recruitmentId =
        input?.recruitmentId ||
        (typeof context.metadata.recruitmentId === 'string'
          ? context.metadata.recruitmentId
          : undefined);
      if (recruitmentId) {
        record = reconstructStructuredRecruitmentFromDb(repos, recruitmentId) ?? undefined;
      }
      // Restart recovery when candidate was intentionally NOT persisted before DUPLICATE_CHECK
      if (!record) {
        const documentId =
          typeof context.metadata.documentId === 'string'
            ? context.metadata.documentId
            : undefined;
        const sourceId =
          typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined;
        if (documentId) {
          const doc = reconstructNormalizedDocumentFromDb(repos, documentId, sourceId);
          if (doc) {
            const { getExtractionService } = await import('../extraction/index.ts');
            record = await getExtractionService().extractRecruitment(doc, context.correlationId, {
              persist: false,
            });
          }
        }
      }
    }

    if (!record) {
      return {
        success: false,
        errorCode: 'EVIDENCE_VALIDATION_FAILED',
        errorMessage: 'Missing structured recruitment record for evidence validation stage',
      };
    }

    const isVerified =
      record.overallStatus === 'VERIFIED' ||
      record.overallStatus === 'PARTIALLY_VERIFIED' ||
      record.overallStatus === 'PARTIAL';

    const evidenceCount = Object.values(record.fields).filter(
      (f) => f.evidence?.verifiedInDocument || f.evidence?.verified_in_document
    ).length;

    return {
      success: isVerified,
      output: {
        recruitmentId: record.id,
        validationStatus: record.overallStatus,
        evidenceCount,
        record,
        structuredRecruitment: record,
      },
      errorCode: isVerified ? undefined : 'EVIDENCE_VALIDATION_FAILED',
      errorMessage: isVerified
        ? undefined
        : `Evidence validation failed: Recruitment status is ${record.overallStatus}`,
      persistMetadata: {
        recruitmentId: record.id,
        canonicalIdentityKey: record.canonicalIdentityKey ?? null,
        evidenceValidationStatus: record.overallStatus,
        verifiedEvidenceCount: evidenceCount,
      },
    };
  }
}
