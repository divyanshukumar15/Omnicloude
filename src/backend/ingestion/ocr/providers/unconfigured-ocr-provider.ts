/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OCRProvider, OcrPageResult, OcrDocumentResult } from '../types.ts';
import { IngestionError } from '../../types.ts';

export class UnconfiguredOCRProvider implements OCRProvider {
  readonly providerName = 'UNCONFIGURED';
  readonly modelVersion = 'none';

  isAvailable(): boolean {
    return false;
  }

  async extractPage(
    pageNumber: number,
    _documentBuffer: Buffer,
    options?: { documentId?: string }
  ): Promise<OcrPageResult> {
    const documentId = options?.documentId || 'unknown';
    throw new IngestionError(
      'OCR provider is unavailable or unconfigured',
      'OCR_PROVIDER_UNAVAILABLE',
      { documentId, pageNumber }
    );
  }

  async extractDocument(
    _documentBuffer: Buffer,
    options?: { documentId?: string; checksum?: string }
  ): Promise<OcrDocumentResult> {
    const documentId = options?.documentId || 'unknown';
    throw new IngestionError(
      'OCR provider is unavailable or unconfigured',
      'OCR_PROVIDER_UNAVAILABLE',
      { documentId }
    );
  }
}
