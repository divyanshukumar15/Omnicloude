/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import type { OCRProvider, OcrPageResult, OcrDocumentResult, OcrStatus } from '../types.ts';
import { OcrQualityValidator } from '../ocr-quality-validator.ts';
import { IngestionError } from '../../types.ts';
import { logger } from '../../../config/logger.ts';
import { DEFAULT_OCR_MODEL } from '../../../config/schema.ts';
import { preserveDocumentLayoutText } from '../../extraction/text-structure.ts';

export interface GeminiOCRProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class GeminiOCRProvider implements OCRProvider {
  readonly providerName = 'GEMINI_MULTIMODAL_OCR';
  readonly modelVersion: string;
  private ai: GoogleGenAI | null = null;
  private apiKey: string | undefined;
  private defaultTimeoutMs: number;
  private maxRetries: number;

  constructor(options: GeminiOCRProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.modelVersion = options.model || process.env.OCR_MODEL || DEFAULT_OCR_MODEL;
    this.defaultTimeoutMs = options.timeoutMs ?? (process.env.OCR_TIMEOUT_MS ? parseInt(process.env.OCR_TIMEOUT_MS, 10) : 15000);
    this.maxRetries = options.maxRetries ?? (process.env.OCR_MAX_RETRIES ? parseInt(process.env.OCR_MAX_RETRIES, 10) : 2);

    if (this.isAvailable()) {
      try {
        this.ai = new GoogleGenAI({
          apiKey: this.apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
      } catch (err) {
        logger.warn('Failed to initialize GoogleGenAI client for OCR', { error: String(err) });
        this.ai = null;
      }
    }
  }

  isAvailable(): boolean {
    const key = this.apiKey || process.env.GEMINI_API_KEY;
    return Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
  }

  public detectLanguage(text: string): 'ENGLISH' | 'HINDI' | 'MIXED' | 'UNKNOWN' {
    if (!text || text.trim().length === 0) return 'UNKNOWN';

    const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;

    if (devanagariCount >= 15 && latinCount >= 15) {
      return 'MIXED';
    }
    if (devanagariCount > latinCount && devanagariCount >= 10) {
      return 'HINDI';
    }
    if (latinCount > devanagariCount && latinCount >= 10) {
      return 'ENGLISH';
    }
    return 'UNKNOWN';
  }

  private isTransientError(errMsg: string, statusCode?: number): boolean {
    if (statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return true;
    }
    if (/429|quota|rate\s*limit|timeout|abort|econnreset|etimedout|socket\s*hang\s*up|overloaded|service\s*unavailable|503/i.test(errMsg)) {
      return true;
    }
    return false;
  }

  /**
   * Executes OCR for a single 1-indexed PDF page using Gemini multimodal PDF input.
   *
   * Operational limitation: Because the runtime does not assume native PDF-to-PNG
   * rasterization binaries (e.g., poppler/pdftoppm), the full PDF buffer is supplied
   * as inlineData with strict page-N targeting instructions. Multi-page calls rely on
   * OcrOrchestrator's maxOcrPages/maxDocumentSizeBytes limits and checksum cache to
   * bound payload cost.
   */
  async extractPage(
    pageNumber: number,
    documentBuffer: Buffer,
    options?: {
      documentId?: string;
      languageHint?: 'ENGLISH' | 'HINDI' | 'MIXED';
      timeoutMs?: number;
      signal?: AbortSignal;
      checksum?: string;
    }
  ): Promise<OcrPageResult> {
    if (!this.isAvailable() || !this.ai) {
      throw new IngestionError(
        'Gemini OCR Provider is not available (GEMINI_API_KEY not configured)',
        'OCR_PROVIDER_UNAVAILABLE',
        { documentId: options?.documentId, pageNumber }
      );
    }

    const documentId = options?.documentId || crypto.randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const prompt = `You are a high-precision verbatim OCR system for official Indian government recruitment notifications.
Strictly transcribe ONLY page ${pageNumber} (1-indexed) of this PDF document. Do NOT include text from any page before or after page ${pageNumber}.
Rules:
1. Support both English and Hindi (Devanagari script) text.
2. DO NOT translate Hindi to English or English to Hindi. Keep original script and words exactly as printed.
3. Preserve line breaks, paragraph structure, bullet lists, and tabular column layout (use "|" column separators or aligned spacing for tables such as vacancies, categories, fees, and posts).
4. Preserve all numbers, dates, advertisement numbers, percentages, pay levels, URLs, and fees without alterations.
5. Output ONLY the raw verbatim transcribed text of page ${pageNumber}. Do not add markdown fences, introductory commentary, or conclusions.`;

    const base64Pdf = documentBuffer.toString('base64');
    let attempt = 0;
    let lastError: Error | null = null;
    const startTime = Date.now();

    while (attempt <= this.maxRetries) {
      if (options?.signal?.aborted) {
        throw new IngestionError(
          `Gemini OCR request aborted before execution on page ${pageNumber}`,
          'OCR_TIMEOUT',
          { documentId, pageNumber, attempts: attempt, durationMs: Date.now() - startTime },
          true
        );
      }

      // Real timeout enforcement with AbortController and leak-free listener cleanup
      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`OCR_TIMEOUT: Page ${pageNumber} exceeded ${timeoutMs}ms limit`));
      }, timeoutMs);

      const onExternalAbort = () => {
        controller.abort(options?.signal?.reason);
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }

      let abortReject: ((reason?: unknown) => void) | null = null;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortReject = reject;
      });
      const onInternalAbort = () => {
        abortReject?.(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error(`OCR_TIMEOUT: Page ${pageNumber} aborted`)
        );
      };
      controller.signal.addEventListener('abort', onInternalAbort, { once: true });

      try {
        const response = await Promise.race([
          this.ai.models.generateContent({
            model: this.modelVersion,
            contents: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: base64Pdf,
                },
              },
              {
                text: prompt,
              },
            ],
          }),
          abortPromise,
        ]);

        const rawText = response.text || '';
        const preservedText = preserveDocumentLayoutText(rawText);
        const durationMs = Date.now() - startTime;
        const detectedLang = this.detectLanguage(preservedText);

        const initialPageResult: OcrPageResult = {
          document_id: documentId,
          page_number: pageNumber,
          text: preservedText,
          language: detectedLang,
          model_confidence: null, // Strictly null: Gemini does not return numeric OCR confidence
          confidence: null,
          quality_score: 0.0,
          confidence_source: 'NOT_PROVIDED',
          provider: this.providerName,
          model_version: this.modelVersion,
          processing_time_ms: durationMs,
          status: 'OCR_SUCCESS',
          char_count: preservedText.length,
          word_count: preservedText.split(/\s+/).filter(Boolean).length,
          retry_count: attempt,
          ocr_result_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        };

        // Transparent quality check & quality score calculation
        const qualityCheck = OcrQualityValidator.validatePage(initialPageResult);
        initialPageResult.status = qualityCheck.status;
        initialPageResult.quality_score = qualityCheck.qualityScore;
        if (!qualityCheck.isValid) {
          initialPageResult.quality_notes = qualityCheck.issues.join('; ');
        }

        return initialPageResult;
      } catch (err: unknown) {
        const errMsg = (err as Error).message || String(err);
        lastError = err as Error;

        // If external document-level signal aborted, do NOT retry locally
        if (options?.signal?.aborted) {
          throw new IngestionError(
            `Gemini OCR aborted by document timeout budget on page ${pageNumber}: ${errMsg}`,
            'OCR_TIMEOUT',
            { documentId, pageNumber, attempts: attempt, durationMs: Date.now() - startTime },
            true
          );
        }

        // Check if aborted due to timeout
        if (timedOut || controller.signal.aborted || /timeout/i.test(errMsg)) {
          if (attempt < this.maxRetries) {
            attempt++;
            const backoff = Math.pow(2, attempt) * 500;
            logger.warn(`OCR transient timeout on page ${pageNumber}, retrying in ${backoff}ms (attempt ${attempt}/${this.maxRetries})`, {
              documentId,
              pageNumber,
            });
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw new IngestionError(
            `Gemini OCR request timed out after ${timeoutMs}ms on page ${pageNumber}`,
            'OCR_TIMEOUT',
            { documentId, pageNumber, attempts: attempt, durationMs: Date.now() - startTime },
            true
          );
        }

        // Check for non-retryable authentication failure
        if (/api_key|unauthorized|forbidden|401|403|permission_denied/i.test(errMsg)) {
          throw new IngestionError(
            `Gemini OCR authentication failure: ${errMsg}`,
            'OCR_PROVIDER_UNAVAILABLE',
            { documentId, pageNumber, error: errMsg },
            false
          );
        }

        // Check for non-retryable 400 invalid request or corrupt document
        if (/invalid\s*argument|bad\s*request|400|unsupported/i.test(errMsg)) {
          throw new IngestionError(
            `Gemini OCR invalid request: ${errMsg}`,
            'OCR_FAILED',
            { documentId, pageNumber, error: errMsg },
            false
          );
        }

        // Check for transient failure (429 rate limit or 5xx)
        if (this.isTransientError(errMsg) && attempt < this.maxRetries) {
          attempt++;
          const backoff = Math.pow(2, attempt) * 500;
          logger.warn(`OCR transient error on page ${pageNumber}, retrying in ${backoff}ms (attempt ${attempt}/${this.maxRetries})`, {
            documentId,
            pageNumber,
            error: errMsg,
          });
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        // Final failure
        if (/rate|429|quota/i.test(errMsg)) {
          throw new IngestionError(
            `Gemini OCR rate limit exceeded (429): ${errMsg}`,
            'OCR_RATE_LIMIT',
            { documentId, pageNumber, attempts: attempt },
            true
          );
        }

        throw new IngestionError(
          `Gemini OCR execution failed: ${errMsg}`,
          'OCR_FAILED',
          { documentId, pageNumber, attempts: attempt, error: errMsg },
          false
        );
      } finally {
        clearTimeout(timeoutId);
        controller.signal.removeEventListener('abort', onInternalAbort);
        if (options?.signal) {
          options.signal.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    throw new IngestionError(
      `Gemini OCR exceeded maximum retries (${this.maxRetries}): ${lastError?.message}`,
      'OCR_FAILED',
      { documentId, pageNumber, attempts: attempt }
    );
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
    const documentId = options?.documentId || crypto.randomUUID();
    const checksum = options?.checksum || crypto.createHash('sha256').update(documentBuffer).digest('hex');
    const targetPages = options?.scannedPageNumbers || [1];

    const pageResults: OcrPageResult[] = [];
    const failedPages: number[] = [];
    let hasFailure = false;
    let hasLowQuality = false;
    let failureReason: string | undefined;

    for (const pageNum of targetPages) {
      try {
        const pageResult = await this.extractPage(pageNum, documentBuffer, {
          documentId,
          timeoutMs: options?.timeoutMs,
          signal: options?.signal,
          checksum,
        });
        pageResults.push(pageResult);

        if (pageResult.status === 'OCR_FAILED') {
          hasFailure = true;
          failedPages.push(pageNum);
          failureReason = pageResult.failure_reason || pageResult.quality_notes || 'Page OCR failed';
        } else if (pageResult.status === 'OCR_LOW_QUALITY') {
          hasLowQuality = true;
        }
      } catch (err) {
        hasFailure = true;
        failedPages.push(pageNum);
        const errMsg = (err as Error).message || String(err);
        failureReason = errMsg;

        const failedPage: OcrPageResult = {
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
        };
        pageResults.push(failedPage);
      }
    }

    let overallStatus: OcrStatus = 'OCR_SUCCESS';
    if (failedPages.length > 0 && failedPages.length < targetPages.length) {
      overallStatus = 'OCR_PARTIAL';
    } else if (failedPages.length === targetPages.length) {
      overallStatus = 'OCR_FAILED';
    } else if (hasLowQuality) {
      overallStatus = 'OCR_LOW_QUALITY';
    }

    return {
      document_id: documentId,
      checksum_sha256: checksum,
      provider: this.providerName,
      model_version: this.modelVersion,
      totalPages: pageResults.length,
      scannedPages: pageResults.length,
      textPages: 0,
      isMixed: false,
      pages: pageResults,
      failedPages,
      overallStatus,
      cached: false,
      failure_reason: failureReason,
    };
  }
}
