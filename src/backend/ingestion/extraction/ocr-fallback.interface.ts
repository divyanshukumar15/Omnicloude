/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OcrPageResult {
  text: string;
  confidence?: number | null; // 0.0 - 1.0 or null
  quality_score?: number;
  wordCount: number;
}

export interface IOCRFallbackProvider {
  readonly providerName: string;

  /**
   * Returns whether the OCR provider is active and properly credentialed.
   */
  isAvailable(): boolean;

  /**
   * Extracts text from a single page buffer or image.
   */
  extractPage(pageNumber: number, documentBuffer: Buffer): Promise<OcrPageResult>;
}

/**
 * Default unconfigured OCR provider (used when no external vision service is configured).
 */
export class UnconfiguredOcrProvider implements IOCRFallbackProvider {
  readonly providerName = 'NONE_UNCONFIGURED';

  isAvailable(): boolean {
    return false;
  }

  async extractPage(_pageNumber: number, _documentBuffer: Buffer): Promise<OcrPageResult> {
    throw new Error('OCR provider is unconfigured in Phase 2 environment');
  }
}
