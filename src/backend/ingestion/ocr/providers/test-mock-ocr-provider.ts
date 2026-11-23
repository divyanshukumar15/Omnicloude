/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { OCRProvider, OcrPageResult, OcrDocumentResult, OcrStatus } from '../types.ts';
import { OcrQualityValidator } from '../ocr-quality-validator.ts';
import { IngestionError } from '../../types.ts';

export interface TestMockOcrPageConfig {
  pageNumber: number;
  text: string;
  language?: 'ENGLISH' | 'HINDI' | 'MIXED' | 'UNKNOWN';
  model_confidence?: number | null;
  confidence?: number | null;
  quality_score?: number;
  confidence_source?: 'MODEL' | 'NOT_PROVIDED';
  forceStatus?: OcrStatus;
  delayMs?: number;
  simulateTimeout?: boolean;
  simulateRateLimit?: boolean;
  simulateServerError?: boolean;
  simulateAuthFailure?: boolean;
  simulateFailure?: boolean;
}

export interface TestMockOcrProviderOptions {
  providerName?: string;
  modelVersion?: string;
  available?: boolean;
  pages?: Record<number, TestMockOcrPageConfig>;
  defaultText?: string;
  simulateTimeout?: boolean;
  simulateRateLimit?: boolean;
  simulateServerError?: boolean;
  simulateAuthFailure?: boolean;
  simulateFailure?: boolean;
}

export class TestMockOCRProvider implements OCRProvider {
  public providerName: string;
  public modelVersion: string;
  private available: boolean;
  private pages: Map<number, TestMockOcrPageConfig> = new Map();
  private defaultText: string;
  private simulateTimeout: boolean;
  private simulateRateLimit: boolean;
  private simulateServerError: boolean;
  private simulateAuthFailure: boolean;
  private simulateFailure: boolean;

  constructor(options: TestMockOcrProviderOptions = {}) {
    this.providerName = options.providerName || 'TEST_MOCK_OCR_PROVIDER';
    this.modelVersion = options.modelVersion || 'test-mock-v1';
    this.available = options.available ?? true;
    this.defaultText = options.defaultText || '';
    this.simulateTimeout = options.simulateTimeout ?? false;
    this.simulateRateLimit = options.simulateRateLimit ?? false;
    this.simulateServerError = options.simulateServerError ?? false;
    this.simulateAuthFailure = options.simulateAuthFailure ?? false;
    this.simulateFailure = options.simulateFailure ?? false;

    if (options.pages) {
      for (const [pNum, cfg] of Object.entries(options.pages)) {
        this.pages.set(parseInt(pNum, 10), cfg);
      }
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setModelVersion(version: string): void {
    this.modelVersion = version;
  }

  setPageConfig(pageNumber: number, config: TestMockOcrPageConfig): void {
    this.pages.set(pageNumber, config);
  }

  public detectLanguage(text: string): 'ENGLISH' | 'HINDI' | 'MIXED' | 'UNKNOWN' {
    if (!text || text.trim().length === 0) return 'UNKNOWN';

    const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    const totalLetters = devanagariCount + latinCount;

    if (totalLetters === 0) return 'UNKNOWN';

    const devRatio = devanagariCount / totalLetters;
    const latinRatio = latinCount / totalLetters;

    if (devRatio >= 0.70) {
      return 'HINDI';
    }
    if (latinRatio >= 0.70) {
      return 'ENGLISH';
    }
    if (devanagariCount >= 10 && latinCount >= 10) {
      return 'MIXED';
    }
    if (devanagariCount > latinCount) {
      return 'HINDI';
    }
    if (latinCount > devanagariCount) {
      return 'ENGLISH';
    }
    return 'UNKNOWN';
  }

  async extractPage(
    pageNumber: number,
    _documentBuffer: Buffer,
    options?: {
      documentId?: string;
      languageHint?: 'ENGLISH' | 'HINDI' | 'MIXED';
      timeoutMs?: number;
      signal?: AbortSignal;
      checksum?: string;
    }
  ): Promise<OcrPageResult> {
    const documentId = options?.documentId || 'test-doc-id';
    const cfg = this.pages.get(pageNumber);

    if (!this.available) {
      throw new IngestionError(
        'Mock OCR Provider is currently unavailable',
        'OCR_PROVIDER_UNAVAILABLE',
        { documentId, pageNumber }
      );
    }

    if (this.simulateAuthFailure || cfg?.simulateAuthFailure) {
      throw new IngestionError(
        'OCR authentication failure: API_KEY_INVALID (401)',
        'OCR_PROVIDER_UNAVAILABLE',
        { documentId, pageNumber },
        false
      );
    }

    if (this.simulateTimeout || cfg?.simulateTimeout) {
      throw new IngestionError(
        `OCR request timed out after ${options?.timeoutMs || 3000}ms`,
        'OCR_TIMEOUT',
        { documentId, pageNumber },
        true
      );
    }

    if (this.simulateRateLimit || cfg?.simulateRateLimit) {
      throw new IngestionError(
        'OCR quota / rate limit exceeded (429)',
        'OCR_RATE_LIMIT',
        { documentId, pageNumber },
        true
      );
    }

    if (this.simulateServerError || cfg?.simulateServerError) {
      throw new IngestionError(
        'OCR server internal error (500)',
        'OCR_FAILED',
        { documentId, pageNumber },
        true
      );
    }

    if (this.simulateFailure || cfg?.simulateFailure) {
      throw new IngestionError(
        'Internal OCR engine processing failed',
        'OCR_FAILED',
        { documentId, pageNumber }
      );
    }

    // Delay simulation and AbortSignal handling
    if (cfg?.delayMs && cfg.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), cfg.delayMs);
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new IngestionError('OCR page processing aborted by timeout', 'OCR_TIMEOUT', { documentId, pageNumber }));
          });
        }
      });
    }

    const text = cfg ? cfg.text : this.defaultText;
    const language = cfg?.language || this.detectLanguage(text);

    // Honest confidence handling: model_confidence is null unless explicitly provided
    const modelConfidence = cfg?.model_confidence !== undefined ? cfg.model_confidence : null;
    const confidenceSource = cfg?.confidence_source || (modelConfidence !== null ? 'MODEL' : 'NOT_PROVIDED');

    const pageResult: OcrPageResult = {
      document_id: documentId,
      page_number: pageNumber,
      text,
      language,
      model_confidence: modelConfidence,
      confidence: modelConfidence,
      quality_score: cfg?.quality_score ?? 0.0,
      confidence_source: confidenceSource,
      provider: this.providerName,
      model_version: this.modelVersion,
      processing_time_ms: 10,
      status: cfg?.forceStatus || 'OCR_SUCCESS',
      char_count: text.length,
      word_count: text.split(/\s+/).filter(Boolean).length,
      ocr_result_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    if (!cfg?.forceStatus) {
      const quality = OcrQualityValidator.validatePage(pageResult);
      pageResult.status = quality.status;
      pageResult.quality_score = cfg?.quality_score ?? quality.qualityScore;
      if (!quality.isValid) {
        pageResult.quality_notes = quality.issues.join('; ');
      }
    }

    return pageResult;
  }

  async extractDocument(
    documentBuffer: Buffer,
    options?: {
      documentId?: string;
      checksum?: string;
      scannedPageNumbers?: number[];
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<OcrDocumentResult> {
    const documentId = options?.documentId || 'test-doc-id';
    const checksum = options?.checksum || 'mock-checksum';
    const pagesToExtract = options?.scannedPageNumbers || [1];

    const results: OcrPageResult[] = [];
    const failedPages: number[] = [];
    let hasFailure = false;
    let hasLowQuality = false;
    let failureReason: string | undefined;

    for (const pageNum of pagesToExtract) {
      try {
        const pageRes = await this.extractPage(pageNum, documentBuffer, {
          documentId,
          timeoutMs: options?.timeoutMs,
          signal: options?.signal,
          checksum,
        });
        results.push(pageRes);
        if (pageRes.status === 'OCR_FAILED') {
          hasFailure = true;
          failedPages.push(pageNum);
          failureReason = pageRes.failure_reason || pageRes.quality_notes;
        } else if (pageRes.status === 'OCR_LOW_QUALITY') {
          hasLowQuality = true;
        }
      } catch (err) {
        hasFailure = true;
        failedPages.push(pageNum);
        const errMsg = (err as Error).message || String(err);
        failureReason = errMsg;
        results.push({
          document_id: documentId,
          page_number: pageNum,
          text: '',
          language: 'UNKNOWN',
          model_confidence: null,
          confidence: null,
          quality_score: 0.0,
          confidence_source: 'NOT_PROVIDED',
          provider: this.providerName,
          model_version: this.modelVersion,
          processing_time_ms: 0,
          status: 'OCR_FAILED',
          char_count: 0,
          word_count: 0,
          failure_reason: errMsg,
          ocr_result_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
      }
    }

    let overallStatus: OcrStatus = 'OCR_SUCCESS';
    if (failedPages.length > 0 && failedPages.length < pagesToExtract.length) {
      overallStatus = 'OCR_PARTIAL';
    } else if (failedPages.length === pagesToExtract.length) {
      overallStatus = 'OCR_FAILED';
    } else if (hasLowQuality) {
      overallStatus = 'OCR_LOW_QUALITY';
    }

    return {
      document_id: documentId,
      checksum_sha256: checksum,
      provider: this.providerName,
      model_version: this.modelVersion,
      totalPages: results.length,
      scannedPages: results.length,
      textPages: 0,
      isMixed: false,
      pages: results,
      failedPages,
      overallStatus,
      cached: false,
      failure_reason: failureReason,
    };
  }
}
