/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { DiscoveryExecutionResult, DiscoveryOptions } from './types.ts';

export interface CachedDiscoveryEntry {
  key: string;
  sourceId: string;
  targetUrl: string;
  adapterVersion: string;
  result: DiscoveryExecutionResult;
  cachedAt: number;
  expiresAt: number;
}

export class DiscoveryCache {
  private static instance: DiscoveryCache | null = null;
  private memoryCache: Map<string, CachedDiscoveryEntry> = new Map();
  private defaultTtlMs = 300000; // 5 minutes

  static getInstance(): DiscoveryCache {
    if (!DiscoveryCache.instance) {
      DiscoveryCache.instance = new DiscoveryCache();
    }
    return DiscoveryCache.instance;
  }

  generateKey(
    sourceId: string,
    targetUrl: string,
    adapterVersion: string,
    options?: DiscoveryOptions
  ): string {
    const serializedOptions = JSON.stringify({
      limit: options?.limit,
      page: options?.page,
      maxPages: options?.maxPages,
      maxNotices: options?.maxNotices,
    });
    return crypto
      .createHash('sha256')
      .update(`${sourceId}::${targetUrl}::${adapterVersion}::${serializedOptions}`)
      .digest('hex');
  }

  get(key: string): DiscoveryExecutionResult | null {
    const entry = this.memoryCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }

    return {
      ...entry.result,
      cached: true,
    };
  }

  set(
    key: string,
    sourceId: string,
    targetUrl: string,
    adapterVersion: string,
    result: DiscoveryExecutionResult,
    ttlMs?: number
  ): void {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;

    this.memoryCache.set(key, {
      key,
      sourceId,
      targetUrl,
      adapterVersion,
      result: { ...result, cached: false },
      cachedAt: now,
      expiresAt: now + effectiveTtl,
    });
  }

  clear(): void {
    this.memoryCache.clear();
  }

  delete(key: string): void {
    this.memoryCache.delete(key);
  }

  size(): number {
    return this.memoryCache.size;
  }
}
