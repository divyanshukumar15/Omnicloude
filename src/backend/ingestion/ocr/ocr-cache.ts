/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { OcrPageResult, OcrDocumentResult, OcrStatus } from './types.ts';
import type { IOcrCacheRepository } from '../../database/repositories/contracts.ts';
import { getRepositories } from '../../database/index.ts';
import { logger } from '../../config/logger.ts';

export class OcrChecksumCache {
  private static instance: OcrChecksumCache | null = null;
  private memoryCache = new Map<string, OcrPageResult>();
  private documentCache = new Map<string, OcrDocumentResult>();
  private repo: IOcrCacheRepository | null = null;

  constructor(repo?: IOcrCacheRepository) {
    if (repo) {
      this.repo = repo;
    }
  }

  private getRepository(): IOcrCacheRepository | null {
    if (this.repo) return this.repo;
    try {
      this.repo = getRepositories().ocrCache;
      return this.repo;
    } catch {
      return null;
    }
  }

  public static getInstance(): OcrChecksumCache {
    if (!OcrChecksumCache.instance) {
      OcrChecksumCache.instance = new OcrChecksumCache();
    }
    return OcrChecksumCache.instance;
  }

  public static buildKey(
    checksum: string,
    pageNumber: number,
    provider: string,
    modelVersion: string
  ): string {
    return `${checksum}::p${pageNumber}::${provider}::${modelVersion}`;
  }

  /**
   * Retrieves persistent cached page OCR result by checksum, page number, provider, and model version.
   */
  public getPage(
    checksum: string,
    pageNumber: number,
    provider: string,
    modelVersion: string
  ): OcrPageResult | null {
    if (!checksum) return null;
    const memKey = OcrChecksumCache.buildKey(checksum, pageNumber, provider, modelVersion);

    // 1. Fast in-memory check
    const mem = this.memoryCache.get(memKey);
    if (mem) {
      return { ...mem };
    }

    // 2. Persistent Database check
    const repo = this.getRepository();
    if (repo) {
      try {
        const row = repo.findByKey(checksum, pageNumber, provider, modelVersion);
        if (row) {
          const pageResult: OcrPageResult = {
            document_id: row.id,
            page_number: row.page_number,
            text: row.extracted_text,
            language: row.language as OcrPageResult['language'],
            model_confidence: row.model_confidence,
            confidence: row.model_confidence,
            quality_score: row.quality_score,
            confidence_source: row.confidence_source as OcrPageResult['confidence_source'],
            provider: row.provider,
            model_version: row.model_version,
            processing_time_ms: 0,
            status: row.status as OcrStatus,
            char_count: row.char_count,
            word_count: row.word_count,
            timestamp: row.created_at,
          };
          this.memoryCache.set(memKey, pageResult);
          return pageResult;
        }
      } catch (err) {
        logger.warn('Failed to query persistent OCR cache', { error: String(err) });
      }
    }

    return null;
  }

  /**
   * Checks if an OCR page result exists in persistent cache.
   */
  public hasPage(
    checksum: string,
    pageNumber: number,
    provider: string,
    modelVersion: string
  ): boolean {
    return this.getPage(checksum, pageNumber, provider, modelVersion) !== null;
  }

  /**
   * Saves an OCR page result to persistent cache.
   */
  public setPage(
    checksum: string,
    pageResult: OcrPageResult
  ): void {
    if (!checksum || !pageResult) return;
    const provider = pageResult.provider;
    const modelVersion = pageResult.model_version || 'default';
    const memKey = OcrChecksumCache.buildKey(checksum, pageResult.page_number, provider, modelVersion);

    this.memoryCache.set(memKey, { ...pageResult });

    const repo = this.getRepository();
    if (repo) {
      try {
        const id = pageResult.ocr_result_id || crypto.randomUUID();
        repo.save({
          id,
          document_checksum: checksum,
          page_number: pageResult.page_number,
          provider,
          model_version: modelVersion,
          extracted_text: pageResult.text,
          language: pageResult.language,
          model_confidence: pageResult.model_confidence ?? null,
          quality_score: pageResult.quality_score,
          confidence_source: pageResult.confidence_source,
          status: pageResult.status,
          char_count: pageResult.char_count,
          word_count: pageResult.word_count,
          metadata_json: JSON.stringify({
            quality_notes: pageResult.quality_notes,
            failure_reason: pageResult.failure_reason,
            retry_count: pageResult.retry_count,
          }),
        });
      } catch (err) {
        logger.warn('Failed to save persistent OCR cache entry', { error: String(err) });
      }
    }
  }

  /**
   * Backward-compatible document cache check.
   */
  public has(checksumSha256: string): boolean {
    if (!checksumSha256) return false;
    return this.documentCache.has(checksumSha256);
  }

  /**
   * Backward-compatible document cache getter.
   */
  public get(checksumSha256: string): OcrDocumentResult | null {
    if (!checksumSha256) return null;
    const entry = this.documentCache.get(checksumSha256);
    if (!entry) return null;
    return {
      ...entry,
      cached: true,
    };
  }

  /**
   * Backward-compatible document cache setter.
   */
  public set(checksumSha256: string, result: OcrDocumentResult): void {
    if (!checksumSha256) return;
    this.documentCache.set(checksumSha256, {
      ...result,
      cached: true,
    });
    // Also save individual pages into page cache
    for (const p of result.pages) {
      this.setPage(checksumSha256, p);
    }
  }

  /**
   * Clears in-memory and persistent cache.
   */
  public clear(): void {
    this.memoryCache.clear();
    this.documentCache.clear();
    const repo = this.getRepository();
    if (repo) {
      try {
        repo.clear();
      } catch {
        // Ignore if db is in memory or closed
      }
    }
  }

  public size(): number {
    return this.memoryCache.size;
  }
}
