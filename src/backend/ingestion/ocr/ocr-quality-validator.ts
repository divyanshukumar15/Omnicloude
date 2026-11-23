/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OcrPageResult, OcrStatus } from './types.ts';

export interface OcrQualityMetrics {
  charCount: number;
  wordCount: number;
  validCharacterRatio: number;
  garbageCharacterRatio: number;
  symbolRatio: number;
  repeatedSequenceRatio: number;
  brokenUnicodeCount: number;
  qualityScore: number;
}

export interface OcrQualityCheckResult {
  isValid: boolean;
  status: OcrStatus;
  issues: string[];
  qualityScore: number;
  metrics: OcrQualityMetrics;
}

export class OcrQualityValidator {
  /**
   * Calculates a transparent, observable quality score strictly from extracted text characteristics.
   * NEVER invents or estimates model confidence.
   */
  public static calculateQualityScore(text: string): { qualityScore: number; metrics: OcrQualityMetrics; issues: string[] } {
    const trimmed = (text || '').trim();
    const issues: string[] = [];

    if (trimmed.length === 0) {
      issues.push('EMPTY_OCR: Extracted text is empty or contains only whitespace');
      return {
        qualityScore: 0.0,
        issues,
        metrics: {
          charCount: 0,
          wordCount: 0,
          validCharacterRatio: 0,
          garbageCharacterRatio: 1.0,
          symbolRatio: 0,
          repeatedSequenceRatio: 0,
          brokenUnicodeCount: 0,
          qualityScore: 0.0,
        },
      };
    }

    const charCount = trimmed.length;
    const words = trimmed.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // 1. Broken Unicode / replacement characters check (e.g. \uFFFD, null bytes, unprintable controls)
    const brokenUnicodeMatches = trimmed.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || [];
    const brokenUnicodeCount = brokenUnicodeMatches.length;
    if (brokenUnicodeCount > 0) {
      issues.push(`BROKEN_UNICODE: Detected ${brokenUnicodeCount} replacement or invalid control characters`);
    }

    // 2. Useful character analysis: Latin letters, Devanagari script, digits, standard punctuation, and spaces
    const validMatches = trimmed.match(/[\p{L}\p{N}\s,.\-—–:;()\/\\"'%&₹@#]/gu) || [];
    const validCharCount = validMatches.length;
    const validRatio = charCount > 0 ? validCharCount / charCount : 0;
    const garbageRatio = 1.0 - validRatio;

    // 3. Symbol ratio: non-alphanumeric, non-Devanagari symbols
    const lettersAndDigitsAndDevanagari = trimmed.match(/[\p{L}\p{N}\s]/gu) || [];
    const symbolCount = charCount - lettersAndDigitsAndDevanagari.length;
    const symbolRatio = charCount > 0 ? symbolCount / charCount : 0;

    // 4. Repeated garbage characters (e.g. aaaaaaa, %%%%%%%%%, .........)
    const repeatedCharRegex = /(.)\1{5,}/;
    const hasRepeatedChars = repeatedCharRegex.test(trimmed);

    // 5. Repetitive token loops (e.g. "notice notice notice notice")
    let hasRepeatedTokens = false;
    if (words.length >= 6) {
      for (let i = 0; i <= words.length - 4; i++) {
        const w = words[i].toLowerCase();
        if (w.length >= 2 && words.slice(i, i + 5).every((token) => token.toLowerCase() === w)) {
          hasRepeatedTokens = true;
          break;
        }
      }
    }

    const repeatedSequenceRatio = (hasRepeatedChars || hasRepeatedTokens) ? 1.0 : 0.0;
    if (hasRepeatedChars || hasRepeatedTokens) {
      issues.push('REPEATED_GARBAGE: Text contains repetitive character sequences or repetitive token hallucination loops');
    }

    // 6. Density & Shortness
    if (charCount < 20) {
      issues.push(`LOW_TEXT_DENSITY / EXTREMELY_SHORT_OCR: Extracted only ${charCount} characters (minimum required: 20)`);
    }

    // 7. Symbol threshold
    if (symbolRatio > 0.40) {
      issues.push(`EXCESSIVE_SYMBOLS / MOSTLY_SYMBOLS: Abnormal symbol ratio of ${(symbolRatio * 100).toFixed(1)}% exceeds threshold (40%)`);
    }

    // 8. Low useful-character ratio
    if (validRatio < 0.60) {
      issues.push(`LOW_USEFUL_CHARACTER_RATIO: Valid character ratio of ${(validRatio * 100).toFixed(1)}% is below threshold (60%)`);
    }

    // Calculate quality score (0.0 - 1.0)
    let score = validRatio * 0.70 + Math.min(1.0, charCount / 250) * 0.30;
    if (hasRepeatedChars || hasRepeatedTokens) score -= 0.35;
    if (brokenUnicodeCount > 0) score -= 0.40;
    if (charCount < 20) score -= 0.30;
    if (symbolRatio > 0.40) score -= 0.30;

    const normalizedQualityScore = Math.max(0.0, Math.min(1.0, Math.round(score * 100) / 100));

    return {
      qualityScore: normalizedQualityScore,
      issues,
      metrics: {
        charCount,
        wordCount,
        validCharacterRatio: Math.round(validRatio * 100) / 100,
        garbageCharacterRatio: Math.round(garbageRatio * 100) / 100,
        symbolRatio: Math.round(symbolRatio * 100) / 100,
        repeatedSequenceRatio,
        brokenUnicodeCount,
        qualityScore: normalizedQualityScore,
      },
    };
  }

  /**
   * Deterministically validates an OCR page result.
   */
  public static validatePage(page: Partial<OcrPageResult> & { text: string }): OcrQualityCheckResult {
    const calculation = OcrQualityValidator.calculateQualityScore(page.text || '');

    if (page.text.trim().length === 0) {
      return {
        isValid: false,
        status: 'OCR_FAILED',
        issues: calculation.issues,
        qualityScore: 0.0,
        metrics: calculation.metrics,
      };
    }

    const isValid = calculation.issues.length === 0;
    const status: OcrStatus = isValid ? 'OCR_SUCCESS' : 'OCR_LOW_QUALITY';

    return {
      isValid,
      status,
      issues: calculation.issues,
      qualityScore: calculation.qualityScore,
      metrics: calculation.metrics,
    };
  }
}
