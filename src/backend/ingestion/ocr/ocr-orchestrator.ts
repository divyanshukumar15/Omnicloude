/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import type { OCRProvider, OcrStatus, OcrPageResult } from './types.ts';
import { GeminiOCRProvider } from './providers/gemini-ocr-provider.ts';
import { UnconfiguredOCRProvider } from './providers/unconfigured-ocr-provider.ts';
import { OcrQualityValidator } from './ocr-quality-validator.ts';
import { OcrChecksumCache } from './ocr-cache.ts';
import type {
  NormalizedDocument,
  NormalizedPage,
  ExtractionQualityMetadata,
} from '../types.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';
import {
  preserveDocumentLayoutText,
  buildNormalizedSearchText,
  detectAndExtractTables,
} from '../extraction/text-structure.ts';

export interface OcrOrchestratorOptions {
  provider?: OCRProvider;
  scannedThresholdCharsPerPage?: number;
  maxOcrPages?: number;
  maxDocumentSizeBytes?: number;
  perPageTimeoutMs?: number;
  maxDocumentTimeMs?: number;
  maxConcurrency?: number;
  cache?: OcrChecksumCache;
}

export class OcrOrchestrator {
  private provider: OCRProvider;
  private scannedThresholdChars: number;
  private maxOcrPages: number;
  private maxDocumentSizeBytes: number;
  private perPageTimeoutMs: number;
  private maxDocumentTimeMs: number;
  private maxConcurrency: number;
  private cache: OcrChecksumCache;

  constructor(options: OcrOrchestratorOptions = {}) {
    if (options.provider) {
      this.provider = options.provider;
    } else {
      const gemini = new GeminiOCRProvider();
      this.provider = gemini.isAvailable() ? gemini : new UnconfiguredOCRProvider();
    }

    this.scannedThresholdChars = options.scannedThresholdCharsPerPage ?? 40;
    this.maxOcrPages = options.maxOcrPages ?? (process.env.OCR_MAX_PAGES ? parseInt(process.env.OCR_MAX_PAGES, 10) : 30);
    this.maxDocumentSizeBytes = options.maxDocumentSizeBytes ?? (process.env.MAX_OCR_DOCUMENT_SIZE ? parseInt(process.env.MAX_OCR_DOCUMENT_SIZE, 10) : 26214400); // 25 MB
    this.perPageTimeoutMs = options.perPageTimeoutMs ?? (process.env.OCR_TIMEOUT_MS ? parseInt(process.env.OCR_TIMEOUT_MS, 10) : 15000);
    this.maxDocumentTimeMs = options.maxDocumentTimeMs ?? (process.env.MAX_OCR_TIME ? parseInt(process.env.MAX_OCR_TIME, 10) : 60000); // 60s
    const rawConcurrency =
      options.maxConcurrency ??
      (process.env.OCR_MAX_CONCURRENCY ? parseInt(process.env.OCR_MAX_CONCURRENCY, 10) : 3);
    this.maxConcurrency = Number.isFinite(rawConcurrency)
      ? Math.max(1, Math.min(8, Math.floor(rawConcurrency)))
      : 3;
    this.cache = options.cache || OcrChecksumCache.getInstance();
  }

  public getProvider(): OCRProvider {
    return this.provider;
  }

  public setProvider(provider: OCRProvider): void {
    this.provider = provider;
  }

  public getCache(): OcrChecksumCache {
    return this.cache;
  }

  public getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  /**
   * Processes a PDF document through the full multi-page OCR and text extraction pipeline:
   * 1. Safety limit checks (document size, max pages, total time).
   * 2. Direct text extraction attempt for all N pages preserving layout & table structure.
   * 3. Selective page-level scanned detection (only scanned pages are routed to OCR).
   * 4. Bounded-concurrency multi-page OCR with persistent caching, accurate remaining
   *    timeout budgets, leak-free AbortSignal cleanup, and partial failure isolation.
   * 5. Ordered page assembly with complete provenance and page-level evidence metadata.
   */
  async processDocument(params: {
    documentId: string;
    sourceId: string;
    sourceUrl: string;
    canonicalUrl: string;
    sourceDomain: string;
    checksumSha256: string;
    fileSize: number;
    documentType: string;
    buffer: Buffer;
  }): Promise<NormalizedDocument> {
    const {
      documentId,
      sourceId,
      sourceUrl,
      canonicalUrl,
      sourceDomain,
      checksumSha256,
      fileSize,
      documentType,
      buffer,
    } = params;

    const startTime = Date.now();

    // 1. Safety Limit: Document Size Check
    if (fileSize > this.maxDocumentSizeBytes) {
      const reason = `Document size (${fileSize} bytes) exceeds maximum OCR limit of ${this.maxDocumentSizeBytes} bytes`;
      logger.warn('Document exceeds maximum allowed OCR size limit', {
        documentId,
        fileSize,
        maxLimit: this.maxDocumentSizeBytes,
      });

      return {
        id: documentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        checksumSha256,
        fileSize,
        pageCount: 0,
        discoveryTimestamp: new Date().toISOString(),
        downloadTimestamp: new Date().toISOString(),
        documentType,
        validationNotes: `MAX_OCR_DOCUMENT_SIZE_EXCEEDED: ${reason}`,
        extractionStatus: 'OCR_LIMIT_EXCEEDED',
        extractionMethod: 'FAILED',
        isScanned: true,
        pages: [],
        qualityMetadata: {
          totalCharacters: 0,
          avgCharsPerPage: 0,
          scannedPageCount: 0,
          textPageCount: 0,
          isScannedDocument: true,
          extractionMethod: 'FAILED',
        },
        ocrDetails: {
          overallStatus: 'OCR_LIMIT_EXCEEDED',
          totalPages: 0,
          scannedPages: 0,
          textPages: 0,
          successfulPages: [],
          failedPages: [],
          pendingPages: [],
          timedOut: false,
          reason,
          failureReason: reason,
        },
      };
    }

    // 2. Direct Text Extraction Attempt for all N pages (layout-preserving)
    const rawPagesText: string[] = [];
    let totalPages = 0;

    const parser = new PDFParse({ data: buffer });
    try {
      const textResult = await parser.getText();
      totalPages = textResult.total;

      for (const p of textResult.pages) {
        rawPagesText.push(preserveDocumentLayoutText(p.text || ''));
      }
    } catch (err) {
      logger.error('PDF text extraction error during orchestrator pass', err, { documentId });
      throw new IngestionError(
        `PDF text extraction failed: ${(err as Error).message}`,
        'EXTRACTION_FAILED',
        { documentId, error: (err as Error).message }
      );
    } finally {
      await parser.destroy();
    }

    if (totalPages === 0) {
      throw new IngestionError(
        'PDF parser returned zero pages during text extraction',
        'CORRUPT_PDF',
        { documentId }
      );
    }

    // 3. Safety Limit: Max OCR Pages Check
    if (totalPages > this.maxOcrPages) {
      const reason = `Document page count (${totalPages}) exceeds maximum OCR limit of ${this.maxOcrPages} pages`;
      logger.warn('Document exceeds maximum allowed OCR pages limit', {
        documentId,
        totalPages,
        maxLimit: this.maxOcrPages,
      });

      const allPagesList = Array.from({ length: totalPages }, (_, i) => i + 1);
      return {
        id: documentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        checksumSha256,
        fileSize,
        pageCount: totalPages,
        discoveryTimestamp: new Date().toISOString(),
        downloadTimestamp: new Date().toISOString(),
        documentType,
        validationNotes: `MAX_OCR_PAGES_EXCEEDED: ${reason}`,
        extractionStatus: 'OCR_LIMIT_EXCEEDED',
        extractionMethod: 'FAILED',
        isScanned: true,
        pages: rawPagesText.map((t, idx) => ({
          documentId,
          pageNumber: idx + 1,
          extractedText: t,
          normalizedSearchText: buildNormalizedSearchText(t),
          tables: detectAndExtractTables(t, idx + 1),
          charCount: t.length,
          extractionMethod: 'FAILED',
          isScanned: true,
          failureReason: reason,
        })),
        qualityMetadata: {
          totalCharacters: 0,
          avgCharsPerPage: 0,
          scannedPageCount: totalPages,
          textPageCount: 0,
          isScannedDocument: true,
          extractionMethod: 'FAILED',
        },
        ocrDetails: {
          overallStatus: 'OCR_LIMIT_EXCEEDED',
          totalPages,
          scannedPages: totalPages,
          textPages: 0,
          successfulPages: [],
          failedPages: allPagesList,
          pendingPages: allPagesList,
          timedOut: false,
          reason,
          failureReason: reason,
        },
      };
    }

    // 4. Page-Level Scanned Detection (Handles image-only, low text density, and mixed PDFs)
    const pages: NormalizedPage[] = [];
    const scannedPageNumbers: number[] = [];
    let totalCharacters = 0;

    for (let i = 0; i < totalPages; i++) {
      const pageNum = i + 1;
      const text = rawPagesText[i] || '';
      const charCount = text.length;
      totalCharacters += charCount;

      const isPageScanned = charCount < this.scannedThresholdChars;
      if (isPageScanned) {
        scannedPageNumbers.push(pageNum);
      }

      pages.push({
        documentId,
        pageNumber: pageNum,
        extractedText: text,
        normalizedSearchText: buildNormalizedSearchText(text),
        tables: detectAndExtractTables(text, pageNum),
        charCount,
        extractionMethod: 'DIRECT_TEXT',
        isScanned: isPageScanned,
        qualityScore: isPageScanned ? 0.0 : Math.min(1.0, charCount / 500),
      });
    }

    const isMixedPdf = scannedPageNumbers.length > 0 && scannedPageNumbers.length < totalPages;

    // 5. If document contains sufficient text on ALL pages, do NOT trigger OCR unnecessarily
    if (scannedPageNumbers.length === 0) {
      logger.info('Document has sufficient embedded text on all pages; skipping OCR', { documentId, totalPages });
      return {
        id: documentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        checksumSha256,
        fileSize,
        pageCount: totalPages,
        discoveryTimestamp: new Date().toISOString(),
        downloadTimestamp: new Date().toISOString(),
        documentType,
        extractionStatus: 'EXTRACTED',
        extractionMethod: 'DIRECT_TEXT',
        isScanned: false,
        pages,
        qualityMetadata: {
          totalCharacters,
          avgCharsPerPage: Math.round(totalCharacters / totalPages),
          scannedPageCount: 0,
          textPageCount: totalPages,
          isScannedDocument: false,
          extractionMethod: 'DIRECT_TEXT',
        },
      };
    }

    // 6. Check OCR Provider Availability
    if (!this.provider.isAvailable()) {
      const reason = 'OCR provider is unavailable or unconfigured';
      logger.warn('OCR provider is unavailable. Returning OCR_UNAVAILABLE status without fabricating text', {
        documentId,
        provider: this.provider.providerName,
      });

      for (const pNum of scannedPageNumbers) {
        const page = pages[pNum - 1];
        if (page) {
          page.extractionMethod = 'OCR_REQUIRED';
          page.failureReason = reason;
        }
      }

      return {
        id: documentId,
        sourceId,
        sourceUrl,
        canonicalUrl,
        sourceDomain,
        checksumSha256,
        fileSize,
        pageCount: totalPages,
        discoveryTimestamp: new Date().toISOString(),
        downloadTimestamp: new Date().toISOString(),
        documentType,
        extractionStatus: 'OCR_UNAVAILABLE',
        extractionMethod: 'OCR_REQUIRED',
        isScanned: true,
        pages,
        qualityMetadata: {
          totalCharacters,
          avgCharsPerPage: Math.round(totalCharacters / totalPages),
          scannedPageCount: scannedPageNumbers.length,
          textPageCount: totalPages - scannedPageNumbers.length,
          isScannedDocument: true,
          extractionMethod: 'OCR_REQUIRED',
        },
        ocrDetails: {
          overallStatus: 'OCR_UNAVAILABLE',
          totalPages,
          scannedPages: scannedPageNumbers.length,
          textPages: totalPages - scannedPageNumbers.length,
          successfulPages: [],
          failedPages: [...scannedPageNumbers],
          pendingPages: [...scannedPageNumbers],
          timedOut: false,
          reason,
          failureReason: reason,
        },
      };
    }

    // 7. Bounded-Concurrency Multi-Page OCR with Accurate Remaining Document-Level Timeout Budget
    const documentAbortController = new AbortController();
    let documentTimedOut = false;
    const documentTimer = setTimeout(() => {
      documentTimedOut = true;
      documentAbortController.abort(new Error(`MAX_OCR_TIME: Document processing exceeded ${this.maxDocumentTimeMs}ms`));
    }, this.maxDocumentTimeMs);

    const failedPageSet = new Set<number>();
    const successfulPageSet = new Set<number>();
    const pendingPageSet = new Set<number>();
    let hasLowQualityPage = false;
    let anyPageTimedOut = false;
    let primaryFailureReason: string | undefined;

    const processSingleScannedPage = async (pNum: number): Promise<void> => {
      const page = pages[pNum - 1];
      const elapsedMs = Date.now() - startTime;
      const remainingDocMs = this.maxDocumentTimeMs - elapsedMs;

      // Check document-level cancellation or exhausted time budget before starting
      if (documentTimedOut || documentAbortController.signal.aborted || remainingDocMs <= 0) {
        documentTimedOut = true;
        pendingPageSet.add(pNum);
        failedPageSet.add(pNum);
        primaryFailureReason =
          primaryFailureReason || `Document exceeded maximum OCR processing time (${this.maxDocumentTimeMs}ms)`;
        if (page) {
          page.extractionMethod = 'FAILED';
          page.failureReason = primaryFailureReason;
        }
        return;
      }

      // 7a. Check Persistent Cache First (cost/duplicate call protection)
      const cachedPage = this.cache.getPage(
        checksumSha256,
        pNum,
        this.provider.providerName,
        this.provider.modelVersion
      );

      if (cachedPage && (cachedPage.status === 'OCR_SUCCESS' || cachedPage.status === 'OCR_LOW_QUALITY')) {
        logger.info('Reusing persistent cached OCR page result', {
          documentId,
          pageNumber: pNum,
          provider: cachedPage.provider,
          modelVersion: cachedPage.model_version,
        });

        const preservedCachedText = preserveDocumentLayoutText(cachedPage.text || '');
        page.extractedText = preservedCachedText;
        page.normalizedSearchText = buildNormalizedSearchText(preservedCachedText);
        page.tables = detectAndExtractTables(preservedCachedText, pNum);
        page.charCount = preservedCachedText.length;
        page.language = cachedPage.language;
        page.extractionMethod = 'OCR';
        page.qualityScore = cachedPage.quality_score;
        page.modelConfidence = cachedPage.model_confidence;
        page.confidenceSource = cachedPage.confidence_source;
        page.ocrResultId = cachedPage.ocr_result_id;
        page.modelVersion = cachedPage.model_version;
        page.isScanned = true;

        successfulPageSet.add(pNum);
        if (cachedPage.status === 'OCR_LOW_QUALITY') {
          hasLowQualityPage = true;
        }
        return;
      }

      // 7b. Cache Miss: Execute OCR with Remaining Budget & Leak-Free AbortSignal Cleanup
      const effectivePageTimeoutMs = Math.max(1, Math.min(this.perPageTimeoutMs, remainingDocMs));
      const pageAbortController = new AbortController();
      let pageTimedOut = false;
      const pageTimer = setTimeout(() => {
        pageTimedOut = true;
        pageAbortController.abort(new Error(`OCR_TIMEOUT: Page ${pNum} exceeded ${effectivePageTimeoutMs}ms`));
      }, effectivePageTimeoutMs);

      const onDocAbort = () => {
        pageAbortController.abort(documentAbortController.signal.reason);
      };
      documentAbortController.signal.addEventListener('abort', onDocAbort, { once: true });

      let abortReject: ((reason?: unknown) => void) | null = null;
      const pageAbortPromise = new Promise<never>((_resolve, reject) => {
        abortReject = reject;
      });
      const onPageAbort = () => {
        abortReject?.(
          pageAbortController.signal.reason instanceof Error
            ? pageAbortController.signal.reason
            : new Error(`OCR_TIMEOUT: Page ${pNum} aborted`)
        );
      };
      pageAbortController.signal.addEventListener('abort', onPageAbort, { once: true });

      try {
        const ocrResult = await Promise.race([
          this.provider.extractPage(pNum, buffer, {
            documentId,
            timeoutMs: effectivePageTimeoutMs,
            signal: pageAbortController.signal,
            checksum: checksumSha256,
          }),
          pageAbortPromise,
        ]);

        const preservedText = preserveDocumentLayoutText(ocrResult.text || '');
        const normalizedOcrResult: OcrPageResult = {
          ...ocrResult,
          text: preservedText,
          char_count: preservedText.length,
        };

        // Update page with transparent layout-preserving OCR output
        page.extractedText = preservedText;
        page.normalizedSearchText = buildNormalizedSearchText(preservedText);
        page.tables = detectAndExtractTables(preservedText, pNum);
        page.charCount = preservedText.length;
        page.language = normalizedOcrResult.language;
        page.extractionMethod = normalizedOcrResult.status === 'OCR_FAILED' ? 'OCR_FAILED' : 'OCR';
        page.qualityScore = normalizedOcrResult.quality_score;
        page.modelConfidence = normalizedOcrResult.model_confidence;
        page.confidenceSource = normalizedOcrResult.confidence_source;
        page.ocrResultId = normalizedOcrResult.ocr_result_id;
        page.modelVersion = normalizedOcrResult.model_version;
        page.isScanned = true;

        if (normalizedOcrResult.status === 'OCR_SUCCESS' || normalizedOcrResult.status === 'OCR_LOW_QUALITY') {
          successfulPageSet.add(pNum);
          // Save to persistent cache
          this.cache.setPage(checksumSha256, normalizedOcrResult);
        } else {
          failedPageSet.add(pNum);
          primaryFailureReason =
            primaryFailureReason || normalizedOcrResult.failure_reason || normalizedOcrResult.quality_notes;
        }

        if (normalizedOcrResult.status === 'OCR_LOW_QUALITY') {
          hasLowQualityPage = true;
        }
      } catch (pageErr) {
        failedPageSet.add(pNum);
        const errMsg = (pageErr as Error).message || String(pageErr);
        if (pageTimedOut || documentTimedOut || /timeout|exceeded|aborted/i.test(errMsg)) {
          anyPageTimedOut = true;
        }
        primaryFailureReason = primaryFailureReason || errMsg;

        page.extractionMethod = 'OCR_FAILED';
        page.qualityScore = 0.0;
        page.failureReason = errMsg;

        logger.error('OCR page failure during multi-page orchestration pass', pageErr, {
          documentId,
          pageNumber: pNum,
          timedOut: pageTimedOut || documentTimedOut,
        });
      } finally {
        clearTimeout(pageTimer);
        documentAbortController.signal.removeEventListener('abort', onDocAbort);
        pageAbortController.signal.removeEventListener('abort', onPageAbort);
      }
    };

    try {
      let nextQueueIndex = 0;
      const workerCount = Math.min(this.maxConcurrency, scannedPageNumbers.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextQueueIndex < scannedPageNumbers.length) {
          const currentIndex = nextQueueIndex++;
          const pNum = scannedPageNumbers[currentIndex];
          await processSingleScannedPage(pNum);
        }
      });
      await Promise.all(workers);
    } finally {
      clearTimeout(documentTimer);
    }

    const successfulPageNumbers = Array.from(successfulPageSet).sort((a, b) => a - b);
    const failedPageNumbers = Array.from(failedPageSet).sort((a, b) => a - b);
    const pendingPageNumbers = Array.from(pendingPageSet).sort((a, b) => a - b);
    const timedOut = Boolean(
      documentTimedOut ||
        anyPageTimedOut ||
        documentAbortController.signal.aborted ||
        /timeout|exceeded/i.test(primaryFailureReason || '')
    );

    // 8. Determine Overall Status & Partial Failure Handling
    // Strict invariant: NEVER report EXTRACTED or OCR_SUCCESS on timeout, pending pages, or partial failure.
    let overallExtractionStatus: NormalizedDocument['extractionStatus'] = 'EXTRACTED';
    let overallOcrStatus: OcrStatus = 'OCR_SUCCESS';

    if (timedOut) {
      overallExtractionStatus = 'OCR_TIMEOUT';
      overallOcrStatus = 'OCR_TIMEOUT';
    } else if (failedPageNumbers.length > 0 && successfulPageNumbers.length > 0) {
      overallExtractionStatus = 'OCR_PARTIAL';
      overallOcrStatus = 'OCR_PARTIAL';
    } else if (failedPageNumbers.length > 0 && successfulPageNumbers.length === 0) {
      overallExtractionStatus = 'FAILED';
      overallOcrStatus = 'OCR_FAILED';
    } else if (pendingPageNumbers.length > 0) {
      overallExtractionStatus = 'OCR_PARTIAL';
      overallOcrStatus = 'OCR_PARTIAL';
    } else if (hasLowQualityPage) {
      overallExtractionStatus = 'OCR_LOW_QUALITY';
      overallOcrStatus = 'OCR_LOW_QUALITY';
    }

    const finalExtractionMethod: NormalizedDocument['extractionMethod'] = isMixedPdf ? 'MIXED' : 'OCR';
    const finalTotalChars = pages.reduce((acc, p) => acc + p.charCount, 0);

    return {
      id: documentId,
      sourceId,
      sourceUrl,
      canonicalUrl,
      sourceDomain,
      checksumSha256,
      fileSize,
      pageCount: totalPages,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType,
      extractionStatus: overallExtractionStatus,
      extractionMethod: finalExtractionMethod,
      isScanned: true,
      pages,
      qualityMetadata: {
        totalCharacters: finalTotalChars,
        avgCharsPerPage: Math.round(finalTotalChars / totalPages),
        scannedPageCount: scannedPageNumbers.length,
        textPageCount: totalPages - scannedPageNumbers.length,
        isScannedDocument: true,
        extractionMethod: finalExtractionMethod,
      },
      ocrDetails: {
        overallStatus: overallOcrStatus,
        totalPages,
        scannedPages: scannedPageNumbers.length,
        textPages: totalPages - scannedPageNumbers.length,
        successfulPages: successfulPageNumbers,
        failedPages: failedPageNumbers,
        pendingPages: pendingPageNumbers,
        timedOut,
        reason: primaryFailureReason,
        failureReason: primaryFailureReason,
      },
    };
  }
}
