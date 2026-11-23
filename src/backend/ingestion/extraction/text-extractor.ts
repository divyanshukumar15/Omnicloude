/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PDFParse } from 'pdf-parse';
import type { IOCRFallbackProvider } from './ocr-fallback.interface.ts';
import { UnconfiguredOcrProvider } from './ocr-fallback.interface.ts';
import type {
  NormalizedPage,
  ExtractionQualityMetadata,
} from '../types.ts';
import { IngestionError } from '../types.ts';
import { logger } from '../../config/logger.ts';
import {
  preserveDocumentLayoutText,
  buildNormalizedSearchText,
  detectAndExtractTables,
} from './text-structure.ts';

export interface ExtractionResult {
  extractionStatus: 'EXTRACTED' | 'OCR_REQUIRED' | 'FAILED';
  extractionMethod: 'DIRECT_TEXT' | 'OCR' | 'OCR_REQUIRED' | 'FAILED';
  isScanned: boolean;
  pageCount: number;
  pages: NormalizedPage[];
  qualityMetadata: ExtractionQualityMetadata;
}

export interface TextExtractorOptions {
  ocrProvider?: IOCRFallbackProvider;
  scannedThresholdCharsPerPage?: number;
}

export class TextExtractor {
  private ocrProvider: IOCRFallbackProvider;
  private scannedThresholdChars: number;

  constructor(options: TextExtractorOptions = {}) {
    this.ocrProvider = options.ocrProvider ?? new UnconfiguredOcrProvider();
    this.scannedThresholdChars = options.scannedThresholdCharsPerPage ?? 40;
  }

  /**
   * Extracts text page-by-page from a PDF buffer, detects scanned pages,
   * invokes OCR if available, or returns OCR_REQUIRED if OCR is unconfigured.
   */
  async extract(documentId: string, buffer: Buffer): Promise<ExtractionResult> {
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
      logger.error('PDF text extraction parser error', err, { documentId });
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

    const pages: NormalizedPage[] = [];
    let totalCharacters = 0;
    let scannedPagesCount = 0;

    // Analyze each page for text density
    for (let i = 0; i < totalPages; i++) {
      const pageNum = i + 1;
      const text = rawPagesText[i] || '';
      const charCount = text.length;
      totalCharacters += charCount;

      const isPageScanned = charCount < this.scannedThresholdChars;
      if (isPageScanned) {
        scannedPagesCount++;
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
        qualityScore: isPageScanned ? 0.1 : Math.min(1.0, charCount / 500),
      });
    }

    const avgChars = Math.round(totalCharacters / totalPages);
    const isScannedDocument = scannedPagesCount === totalPages || avgChars < this.scannedThresholdChars;

    // If document is determined to be scanned (e.g. image-only PDF notice)
    if (isScannedDocument) {
      logger.info('Detected scanned PDF document during text extraction', {
        documentId,
        totalPages,
        avgCharsPerPage: avgChars,
        ocrAvailable: this.ocrProvider.isAvailable(),
      });

      // Check if OCR fallback is configured
      if (this.ocrProvider.isAvailable()) {
        try {
          for (const page of pages) {
            const ocrResult = await this.ocrProvider.extractPage(page.pageNumber, buffer);
            const preservedText = preserveDocumentLayoutText(ocrResult.text || '');
            page.extractedText = preservedText;
            page.normalizedSearchText = buildNormalizedSearchText(preservedText);
            page.tables = detectAndExtractTables(preservedText, page.pageNumber);
            page.charCount = preservedText.length;
            page.extractionMethod = 'OCR';
            page.qualityScore = ocrResult.quality_score ?? ocrResult.confidence ?? 0.0;
          }

          const ocrChars = pages.reduce((acc, p) => acc + p.charCount, 0);
          return {
            extractionStatus: 'EXTRACTED',
            extractionMethod: 'OCR',
            isScanned: true,
            pageCount: totalPages,
            pages,
            qualityMetadata: {
              totalCharacters: ocrChars,
              avgCharsPerPage: Math.round(ocrChars / totalPages),
              scannedPageCount: totalPages,
              textPageCount: 0,
              isScannedDocument: true,
              extractionMethod: 'OCR',
            },
          };
        } catch (ocrErr) {
          logger.error('OCR fallback processing failed', ocrErr, { documentId });
          throw new IngestionError(
            `OCR fallback execution failed: ${(ocrErr as Error).message}`,
            'EXTRACTION_FAILED',
            { documentId }
          );
        }
      }

      // STRICT REQUIREMENT: If OCR provider is not configured, DO NOT invent extracted text.
      // Return clear status OCR_REQUIRED.
      for (const page of pages) {
        page.extractionMethod = 'OCR_REQUIRED';
      }

      return {
        extractionStatus: 'OCR_REQUIRED',
        extractionMethod: 'OCR_REQUIRED',
        isScanned: true,
        pageCount: totalPages,
        pages,
        qualityMetadata: {
          totalCharacters,
          avgCharsPerPage: avgChars,
          scannedPageCount: scannedPagesCount,
          textPageCount: totalPages - scannedPagesCount,
          isScannedDocument: true,
          extractionMethod: 'OCR_REQUIRED',
        },
      };
    }

    // Normal direct text extraction passed
    return {
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pageCount: totalPages,
      pages,
      qualityMetadata: {
        totalCharacters,
        avgCharsPerPage: avgChars,
        scannedPageCount: scannedPagesCount,
        textPageCount: totalPages - scannedPagesCount,
        isScannedDocument: false,
        extractionMethod: 'DIRECT_TEXT',
      },
    };
  }
}
