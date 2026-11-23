/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PipelineStageName } from '../database/types.ts';

export const ORDERED_PIPELINE_STAGES: readonly PipelineStageName[] = [
  'SOURCE_DISCOVERY',
  'DOCUMENT_DISCOVERY',
  'DOCUMENT_DOWNLOAD',
  'DOCUMENT_VALIDATION',
  'TEXT_EXTRACTION',
  'STRUCTURED_EXTRACTION',
  'EVIDENCE_VALIDATION',
  'DUPLICATE_CHECK',
  'PUBLISHING_GATE',
  'WORDPRESS_PUBLISH',
] as const;

export function getNextStage(current: PipelineStageName): PipelineStageName | null {
  const index = ORDERED_PIPELINE_STAGES.indexOf(current);
  if (index === -1 || index >= ORDERED_PIPELINE_STAGES.length - 1) {
    return null;
  }
  return ORDERED_PIPELINE_STAGES[index + 1];
}

export function isValidStageTransition(from: PipelineStageName, to: PipelineStageName): boolean {
  const fromIndex = ORDERED_PIPELINE_STAGES.indexOf(from);
  const toIndex = ORDERED_PIPELINE_STAGES.indexOf(to);
  // Stages must transition forward strictly sequentially or retry same stage
  return toIndex === fromIndex || toIndex === fromIndex + 1;
}
