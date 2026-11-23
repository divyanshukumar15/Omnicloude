/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type OcrStatus =
  | 'OCR_SUCCESS'
  | 'OCR_LOW_QUALITY'
  | 'OCR_FAILED'
  | 'OCR_REQUIRED'
  | 'OCR_UNAVAILABLE'
  | 'OCR_TIMEOUT'
  | 'OCR_PARTIAL'
  | 'OCR_LIMIT_EXCEEDED';

export interface OcrPageResult {
  document_id: string;
  page_number: number;
  text: string;
  language: 'ENGLISH' | 'HINDI' | 'MIXED' | 'UNKNOWN';
  model_confidence: number | null;
  confidence: number | null; // Kept for backward compatibility; null when not returned by model
  quality_score: number; // Transparent observable heuristic quality score (0.0 - 1.0)
  confidence_source: 'MODEL' | 'NOT_PROVIDED';
  provider: string;
  model_version: string;
  processing_time_ms: number;
  status: OcrStatus;
  char_count: number;
  word_count: number;
  retry_count?: number;
  quality_notes?: string;
  failure_reason?: string;
  ocr_result_id?: string;
  timestamp?: string;
}

export interface OcrDocumentResult {
  document_id: string;
  checksum_sha256: string;
  provider: string;
  model_version: string;
  totalPages: number;
  scannedPages: number;
  textPages: number;
  isMixed: boolean;
  pages: OcrPageResult[];
  failedPages: number[];
  overallStatus: OcrStatus;
  cached: boolean;
  failure_reason?: string;
}

export interface OCRProvider {
  readonly providerName: string;
  readonly modelVersion: string;

  /**
   * Returns whether the OCR provider is active, online, and properly credentialed.
   */
  isAvailable(): boolean;

  /**
   * Extracts text from a single page of a PDF document buffer with timeout cancellation.
   */
  extractPage(
    pageNumber: number,
    documentBuffer: Buffer,
    options?: {
      documentId?: string;
      languageHint?: 'ENGLISH' | 'HINDI' | 'MIXED';
      timeoutMs?: number;
      signal?: AbortSignal;
      checksum?: string;
    }
  ): Promise<OcrPageResult>;

  /**
   * Extracts text for an entire document or specific scanned pages.
   */
  extractDocument(
    documentBuffer: Buffer,
    options?: {
      documentId?: string;
      checksum?: string;
      scannedPageNumbers?: number[];
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<OcrDocumentResult>;
}
