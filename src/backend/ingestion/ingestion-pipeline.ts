/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { ISourceAdapter } from './adapters/source-adapter.interface.ts';
import { sourceRegistry } from './adapters/registry.ts';
import { DocumentDownloader } from './downloader/document-downloader.ts';
import { PdfValidator } from './pdf/pdf-validator.ts';
import { TextExtractor } from './extraction/text-extractor.ts';
import { OcrOrchestrator } from './ocr/ocr-orchestrator.ts';
import type { OCRProvider } from './ocr/types.ts';
import type { IOCRFallbackProvider } from './extraction/ocr-fallback.interface.ts';
import { ProvenanceService } from './provenance/provenance-service.ts';
import type {
  DiscoveredNotice,
  DiscoveredDocument,
  NormalizedDocument,
} from './types.ts';
import { IngestionError } from './types.ts';
import { getRepositories } from '../database/index.ts';
import { getAuditService } from '../audit/index.ts';
import { logger } from '../config/logger.ts';

export interface IngestionPipelineOptions {
  ocrProvider?: OCRProvider | IOCRFallbackProvider;
  ocrOrchestrator?: OcrOrchestrator;
  maxDownloadBytes?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface IngestionRunResult {
  success: boolean;
  document?: NormalizedDocument;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * @deprecated Compatibility-only legacy ingestion helper.
 * Production ingestion MUST flow through JobService + SchedulerService + canonical 10-stage PipelineEngine
 * (SOURCE_DISCOVERY -> DOCUMENT_DISCOVERY -> DOCUMENT_DOWNLOAD -> DOCUMENT_VALIDATION -> TEXT_EXTRACTION
 *  -> STRUCTURED_EXTRACTION -> EVIDENCE_VALIDATION -> DUPLICATE_CHECK -> PUBLISHING_GATE -> WORDPRESS_PUBLISH).
 */
export class OfficialDocumentIngestionPipeline {
  private downloader: DocumentDownloader;
  private validator: PdfValidator;
  private extractor: TextExtractor;
  private ocrOrchestrator: OcrOrchestrator;
  private provenanceService: ProvenanceService;

  constructor(options: IngestionPipelineOptions = {}) {
    this.downloader = new DocumentDownloader({
      maxDownloadBytes: options.maxDownloadBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRetries: options.maxRetries,
    });
    this.validator = new PdfValidator();
    this.extractor = new TextExtractor({
      ocrProvider: options.ocrProvider as IOCRFallbackProvider,
    });

    if (options.ocrOrchestrator) {
      this.ocrOrchestrator = options.ocrOrchestrator;
    } else {
      this.ocrOrchestrator = new OcrOrchestrator({
        provider: options.ocrProvider as OCRProvider,
      });
    }

    const repos = getRepositories();
    this.provenanceService = new ProvenanceService(repos.documents, repos.evidence);
  }

  /**
   * @deprecated Compatibility-only helper. Blocked in production unless `allowLegacyCompatibilityExecution: true`
   * is explicitly passed, so production traffic cannot bypass the canonical 10-stage PipelineEngine.
   */
  async processOfficialDocument(params: {
    sourceId: string;
    notice?: DiscoveredNotice;
    documentUrl?: string;
    correlationId?: string;
    allowLegacyCompatibilityExecution?: boolean;
  }): Promise<NormalizedDocument> {
    if (process.env.NODE_ENV === 'production' && !params.allowLegacyCompatibilityExecution) {
      throw new IngestionError(
        'Legacy OfficialDocumentIngestionPipeline is disabled in production. Enqueue jobs via JobService / POST /api/ingest so they execute through the canonical PipelineEngine.',
        'LEGACY_PIPELINE_BYPASS_BLOCKED',
        { sourceId: params.sourceId },
        false
      );
    }

    const correlationId = params.correlationId || crypto.randomUUID();
    const auditService = getAuditService();
    const repos = getRepositories();

    logger.warn('Executing deprecated compatibility OfficialDocumentIngestionPipeline (non-canonical path)', {
      sourceId: params.sourceId,
      documentUrl: params.documentUrl,
      correlationId,
    });

    // 1. Resolve official source adapter
    const adapter = sourceRegistry.get(params.sourceId);
    if (!adapter) {
      throw new IngestionError(
        `Unknown source adapter ID: ${params.sourceId}`,
        'SOURCE_UNAVAILABLE',
        { sourceId: params.sourceId }
      );
    }

    // 2. Discover notice if not provided
    let notice = params.notice;
    if (!notice) {
      if (params.documentUrl) {
        notice = {
          id: `notice-${crypto.randomUUID()}`,
          sourceId: adapter.sourceId,
          title: `Direct Official Notice (${adapter.name})`,
          noticeUrl: params.documentUrl,
          publishedAt: new Date().toISOString(),
        };
      } else {
        const notices = await adapter.discoverNotices({ limit: 1 });
        if (notices.length === 0) {
          throw new IngestionError(
            `No official notices discovered from ${adapter.name}`,
            'NO_NOTICE_FOUND',
            { sourceId: adapter.sourceId }
          );
        }
        notice = notices[0];
      }
    }

    // 3. Resolve document URL
    let targetDocUrl = params.documentUrl;
    if (!targetDocUrl) {
      const discoveredDocs = await adapter.discoverDocuments(notice);
      if (discoveredDocs.length === 0) {
        throw new IngestionError(
          `No document links found in official notice "${notice.title}"`,
          'NO_NOTICE_FOUND',
          { noticeId: notice.id }
        );
      }
      targetDocUrl = discoveredDocs[0].documentUrl;
    }

    const docId = crypto.randomUUID();
    const sourceDocId = crypto.randomUUID();

    // Persist source document reference
    repos.sourceDocuments.create({
      id: sourceDocId,
      source_id: adapter.sourceId,
      url: targetDocUrl,
      title: notice.title,
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADING',
      metadata_json: JSON.stringify(notice.rawMetadata || {}),
    });

    auditService.record({
      correlationId,
      actor: 'INGESTION_PIPELINE',
      action: 'DOCUMENT_DOWNLOAD_STARTED',
      entityType: 'SOURCE_DOCUMENT',
      entityId: sourceDocId,
      stage: 'DOCUMENT_DOWNLOAD',
      status: 'INFO',
      details: { url: targetDocUrl },
    });

    try {
      // 4. Secure Download
      const downloaded = await this.downloader.download(targetDocUrl);

      // 5. PDF Validation & 6. Integrity Check
      const pdfMetadata = await this.validator.validate(downloaded.buffer);

      auditService.record({
        correlationId,
        actor: 'INGESTION_PIPELINE',
        action: 'PDF_VALIDATED',
        entityType: 'DOCUMENT',
        entityId: docId,
        stage: 'DOCUMENT_VALIDATION',
        status: 'SUCCESS',
        details: {
          checksum: pdfMetadata.sha256Hash,
          pageCount: pdfMetadata.pageCount,
          byteSize: pdfMetadata.byteSize,
        },
      });

      // 7. Text Extraction & OCR Processing (Selective page OCR, quality validation, checksum caching)
      const normalizedDoc = await this.ocrOrchestrator.processDocument({
        documentId: docId,
        sourceId: adapter.sourceId,
        sourceUrl: downloaded.sourceUrl,
        canonicalUrl: downloaded.canonicalUrl,
        sourceDomain: downloaded.sourceDomain,
        checksumSha256: pdfMetadata.sha256Hash,
        fileSize: downloaded.byteLength,
        documentType: 'NOTIFICATION_PDF',
        buffer: downloaded.buffer,
      });

      // Source-specific normalization hook
      const finalDoc = await adapter.normalizeDocument(normalizedDoc);

      // Persist provenance and page-level evidence
      await this.provenanceService.persistProvenance(finalDoc, sourceDocId);

      repos.sourceDocuments.updateStatus(sourceDocId, 'DOWNLOADED');

      auditService.record({
        correlationId,
        actor: 'INGESTION_PIPELINE',
        action: 'DOCUMENT_INGESTED',
        entityType: 'DOCUMENT',
        entityId: docId,
        stage: 'TEXT_EXTRACTION',
        status: finalDoc.extractionStatus === 'OCR_UNAVAILABLE' || finalDoc.extractionStatus === 'OCR_REQUIRED' ? 'INFO' : 'SUCCESS',
        details: {
          checksum: finalDoc.checksumSha256,
          extractionStatus: finalDoc.extractionStatus,
          pageCount: finalDoc.pageCount,
          totalChars: finalDoc.qualityMetadata.totalCharacters,
        },
      });

      logger.info('Official document ingestion completed', {
        documentId: docId,
        checksum: finalDoc.checksumSha256,
        status: finalDoc.extractionStatus,
        pages: finalDoc.pageCount,
      });

      return finalDoc;
    } catch (err) {
      repos.sourceDocuments.updateStatus(sourceDocId, 'FAILED');

      const failureCode = err instanceof IngestionError ? err.code : 'UNKNOWN_FAILURE';
      const failureMsg = (err as Error).message;

      auditService.record({
        correlationId,
        actor: 'INGESTION_PIPELINE',
        action: 'INGESTION_FAILED',
        entityType: 'SOURCE_DOCUMENT',
        entityId: sourceDocId,
        stage: 'INGESTION_PIPELINE',
        status: 'FAILURE',
        details: { failureCode, failureMsg },
      });

      logger.error('Official document ingestion failed', err, {
        sourceDocId,
        failureCode,
        url: targetDocUrl,
      });

      throw err;
    }
  }

  getDownloader(): DocumentDownloader {
    return this.downloader;
  }

  getValidator(): PdfValidator {
    return this.validator;
  }

  getExtractor(): TextExtractor {
    return this.extractor;
  }

  getOcrOrchestrator(): OcrOrchestrator {
    return this.ocrOrchestrator;
  }

  getProvenanceService(): ProvenanceService {
    return this.provenanceService;
  }
}
