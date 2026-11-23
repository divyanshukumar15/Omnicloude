/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type IngestionFailureCode =
  | 'SOURCE_UNAVAILABLE'
  | 'NO_NOTICE_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'SSRF_BLOCKED'
  | 'NOT_PDF'
  | 'CORRUPT_PDF'
  | 'OCR_REQUIRED'
  | 'OCR_PROVIDER_UNAVAILABLE'
  | 'OCR_TIMEOUT'
  | 'OCR_RATE_LIMIT'
  | 'OCR_FAILED'
  | 'OCR_LOW_QUALITY'
  | 'OCR_PARTIAL'
  | 'OCR_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_LANGUAGE'
  | 'EXTRACTION_FAILED'
  | 'TIMEOUT'
  | 'LEGACY_PIPELINE_BYPASS_BLOCKED'
  | 'UNKNOWN_FAILURE';

export class IngestionError extends Error {
  public readonly code: IngestionFailureCode;
  public readonly details?: unknown;
  public readonly isRetryable: boolean;

  get retryable(): boolean {
    return this.isRetryable;
  }

  constructor(message: string, code: IngestionFailureCode, details?: unknown, isRetryable = false) {
    super(message);
    this.name = 'IngestionError';
    this.code = code;
    this.details = details;
    this.isRetryable = isRetryable;
  }
}

export interface DiscoveredNotice {
  id: string;
  sourceId: string;
  title: string;
  noticeUrl: string;
  category?: string;
  notificationNumber?: string;
  publishedAt?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface DiscoveredDocument {
  id: string;
  noticeId: string;
  sourceId: string;
  documentUrl: string;
  canonicalUrl: string;
  documentType: string; // e.g. 'NOTIFICATION_PDF', 'CORRIGENDUM_PDF'
  title: string;
  discoveredAt: string;
  sourceDomain: string;
}

import type { ExtractedTableStructure } from './extraction/text-structure.ts';
export type { ExtractedTableStructure };

export interface NormalizedPage {
  documentId: string;
  pageNumber: number;
  extractedText: string;
  normalizedSearchText?: string;
  tables?: ExtractedTableStructure[];
  charCount: number;
  extractionMethod: 'DIRECT_TEXT' | 'OCR' | 'OCR_REQUIRED' | 'OCR_FAILED' | 'FAILED';
  isScanned: boolean;
  language?: string;
  qualityScore?: number;
  modelConfidence?: number | null;
  confidenceSource?: string;
  ocrResultId?: string;
  modelVersion?: string;
  failureReason?: string;
}

export interface ExtractionQualityMetadata {
  totalCharacters: number;
  avgCharsPerPage: number;
  scannedPageCount: number;
  textPageCount: number;
  isScannedDocument: boolean;
  extractionMethod: 'DIRECT_TEXT' | 'OCR' | 'OCR_REQUIRED' | 'MIXED' | 'FAILED';
}

export interface NormalizedDocument {
  id: string;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string;
  sourceDomain: string;
  checksumSha256: string;
  fileSize: number;
  pageCount: number;
  discoveryTimestamp: string;
  downloadTimestamp: string;
  documentType: string;
  validationNotes?: string;
  extractionStatus:
    | 'EXTRACTED'
    | 'OCR_REQUIRED'
    | 'OCR_SUCCESS'
    | 'OCR_LOW_QUALITY'
    | 'OCR_UNAVAILABLE'
    | 'OCR_TIMEOUT'
    | 'OCR_PARTIAL'
    | 'OCR_LIMIT_EXCEEDED'
    | 'FAILED';
  extractionMethod: 'DIRECT_TEXT' | 'OCR' | 'OCR_REQUIRED' | 'MIXED' | 'FAILED';
  isScanned: boolean;
  pages: NormalizedPage[];
  qualityMetadata: ExtractionQualityMetadata;
  ocrDetails?: {
    overallStatus: string;
    totalPages: number;
    scannedPages: number;
    textPages: number;
    successfulPages?: number[];
    failedPages: number[];
    pendingPages?: number[];
    timedOut?: boolean;
    reason?: string;
    failureReason?: string;
  };
}
