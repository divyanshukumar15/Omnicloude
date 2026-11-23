/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { IngestionError } from '../types.ts';

export interface ValidatedPdfMetadata {
  sha256Hash: string;
  byteSize: number;
  pdfVersion: string;
  pageCount: number;
  hasEofMarker: boolean;
  isValidStructure: boolean;
}

export class PdfValidator {
  /**
   * Generates standard SHA-256 hex digest for document integrity tracking.
   */
  public static computeSha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Checks whether the PDF ends with the standard %%EOF marker.
   */
  public static verifyEofMarker(buffer: Buffer): boolean {
    if (buffer.length < 5) return false;
    // Search the last 1024 bytes for %%EOF
    const searchWindow = buffer.subarray(Math.max(0, buffer.length - 1024));
    return searchWindow.includes('%%EOF');
  }

  /**
   * Extracts PDF version string from header (e.g. "1.4", "1.7").
   */
  public static extractPdfVersion(buffer: Buffer): string {
    if (buffer.length < 8) return 'UNKNOWN';
    const header = buffer.subarray(0, 20).toString('latin1');
    const match = header.match(/%PDF-([0-9]\.[0-9])/);
    return match ? match[1] : 'UNKNOWN';
  }

  /**
   * Performs comprehensive PDF validation.
   * Throws classified IngestionErrors on corruption or invalid structure.
   */
  async validate(buffer: Buffer): Promise<ValidatedPdfMetadata> {
    if (!buffer || buffer.length === 0) {
      throw new IngestionError('Cannot validate empty buffer (0 bytes)', 'CORRUPT_PDF');
    }

    // 1. Signature Check
    const header = buffer.subarray(0, 5).toString('latin1');
    if (header !== '%PDF-') {
      throw new IngestionError(
        'File is missing %PDF- header signature',
        'NOT_PDF',
        { headerHex: buffer.subarray(0, 5).toString('hex') }
      );
    }

    // 2. Trailing %%EOF marker check
    const hasEof = PdfValidator.verifyEofMarker(buffer);
    if (!hasEof) {
      throw new IngestionError(
        'PDF is truncated or corrupted (missing %%EOF marker)',
        'CORRUPT_PDF',
        { byteSize: buffer.length }
      );
    }

    // 3. Structural inspection and Page Count via PDFParse
    let pageCount = 0;
    const parser = new PDFParse({ data: buffer });
    try {
      const textResult = await parser.getText();
      pageCount = textResult.total;

      if (pageCount <= 0) {
        throw new IngestionError('PDF parsed with invalid page count (<= 0)', 'CORRUPT_PDF');
      }
    } catch (parseErr) {
      if (parseErr instanceof IngestionError) throw parseErr;
      throw new IngestionError(
        `Failed to parse PDF internal structure: ${(parseErr as Error).message}`,
        'CORRUPT_PDF',
        { error: (parseErr as Error).message }
      );
    } finally {
      await parser.destroy();
    }

    const sha256Hash = PdfValidator.computeSha256(buffer);
    const pdfVersion = PdfValidator.extractPdfVersion(buffer);

    return {
      sha256Hash,
      byteSize: buffer.length,
      pdfVersion,
      pageCount,
      hasEofMarker: true,
      isValidStructure: true,
    };
  }
}
