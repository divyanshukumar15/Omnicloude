/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.ts';
export * from './fingerprint.ts';
export * from './corrigendum-analyzer.ts';
export * from './similarity-engine.ts';
export * from './deduplication-service.ts';

import { DeduplicationService } from './deduplication-service.ts';

let defaultDeduplicationService: DeduplicationService | null = null;

export function getDeduplicationService(): DeduplicationService {
  if (!defaultDeduplicationService) {
    defaultDeduplicationService = new DeduplicationService();
  }
  return defaultDeduplicationService;
}
