/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

export class TextFingerprinter {
  /**
   * Normalizes document text for language-agnostic fingerprinting (handles English & Hindi).
   */
  public static normalize(text: string): string {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Tokenizes text into normalized word tokens.
   */
  public static tokenize(text: string): string[] {
    const norm = this.normalize(text);
    return norm.split(/\s+/).filter((t) => t.length > 1);
  }

  /**
   * Generates word shingles (n-grams) of size n.
   */
  public static shingles(tokens: string[], n = 3): string[] {
    if (tokens.length <= n) {
      return tokens.length > 0 ? [tokens.join(' ')] : [];
    }
    const result: string[] = [];
    for (let i = 0; i <= tokens.length - n; i++) {
      result.push(tokens.slice(i, i + n).join(' '));
    }
    return result;
  }

  /**
   * Computes a 64-bit SimHash representation as a 16-hex character string.
   */
  public static computeSimHash(text: string): string {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return '0000000000000000';
    }

    const shingles = this.shingles(tokens, 3);
    const features = shingles.length > 0 ? shingles : tokens;

    const v = new Array<number>(64).fill(0);

    for (const feat of features) {
      // 64-bit hash using SHA-256 first 8 bytes
      const hashBuf = crypto.createHash('sha256').update(feat, 'utf8').digest();
      const high = hashBuf.readUInt32BE(0);
      const low = hashBuf.readUInt32BE(4);

      for (let i = 0; i < 32; i++) {
        const bit = (high >>> (31 - i)) & 1;
        v[i] += bit === 1 ? 1 : -1;
      }
      for (let i = 0; i < 32; i++) {
        const bit = (low >>> (31 - i)) & 1;
        v[32 + i] += bit === 1 ? 1 : -1;
      }
    }

    let highBits = 0;
    let lowBits = 0;

    for (let i = 0; i < 32; i++) {
      if (v[i] > 0) {
        highBits = (highBits | (1 << (31 - i))) >>> 0;
      }
    }
    for (let i = 0; i < 32; i++) {
      if (v[32 + i] > 0) {
        lowBits = (lowBits | (1 << (31 - i))) >>> 0;
      }
    }

    const highHex = highBits.toString(16).padStart(8, '0');
    const lowHex = lowBits.toString(16).padStart(8, '0');
    return highHex + lowHex;
  }

  /**
   * Calculates Hamming distance between two 64-bit hex SimHashes.
   */
  public static hammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== 16 || hash2.length !== 16) {
      return 64;
    }
    const h1High = parseInt(hash1.slice(0, 8), 16);
    const h1Low = parseInt(hash1.slice(8, 16), 16);
    const h2High = parseInt(hash2.slice(0, 8), 16);
    const h2Low = parseInt(hash2.slice(8, 16), 16);

    let xorHigh = (h1High ^ h2High) >>> 0;
    let xorLow = (h1Low ^ h2Low) >>> 0;

    let dist = 0;
    while (xorHigh > 0) {
      dist += xorHigh & 1;
      xorHigh = xorHigh >>> 1;
    }
    while (xorLow > 0) {
      dist += xorLow & 1;
      xorLow = xorLow >>> 1;
    }
    return dist;
  }

  /**
   * Computes normalized SimHash similarity [0.0, 1.0].
   */
  public static simHashSimilarity(hash1: string, hash2: string): number {
    const dist = this.hammingDistance(hash1, hash2);
    return Math.max(0, 1 - dist / 64);
  }

  /**
   * Computes Jaccard similarity of two token sets [0.0, 1.0].
   */
  public static jaccardSimilarity(text1: string, text2: string): number {
    const tokens1 = new Set(this.tokenize(text1));
    const tokens2 = new Set(this.tokenize(text2));

    if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
    if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

    let intersection = 0;
    for (const t of tokens1) {
      if (tokens2.has(t)) {
        intersection++;
      }
    }

    const union = tokens1.size + tokens2.size - intersection;
    return union > 0 ? intersection / union : 0.0;
  }

  /**
   * Combined text fingerprint similarity combining SimHash (60%) and Jaccard (40%).
   */
  public static compareText(text1: string, text2: string): number {
    const h1 = this.computeSimHash(text1);
    const h2 = this.computeSimHash(text2);
    const simHashScore = this.simHashSimilarity(h1, h2);
    const jaccardScore = this.jaccardSimilarity(text1, text2);
    return Math.round((simHashScore * 0.6 + jaccardScore * 0.4) * 1000) / 1000;
  }
}
