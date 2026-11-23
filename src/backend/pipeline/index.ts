/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PipelineEngine } from './engine.ts';
import { getJobService, type JobService } from '../jobs/index.ts';
import { getAuditService } from '../audit/index.ts';
import { logger } from '../config/logger.ts';

import {
  SourceDiscoveryStageHandler,
  DocumentDiscoveryStageHandler,
  DocumentDownloadStageHandler,
  DocumentValidationStageHandler,
  TextExtractionStageHandler,
  StructuredExtractionStageHandler,
  EvidenceValidationStageHandler,
} from './ingestion-handlers.ts';
import { DuplicateCheckStageHandler } from './duplicate-check-handler.ts';
import { PublishingGateStageHandler } from './publishing-gate-handler.ts';
import { WordPressPublishStageHandler } from './wordpress-publish-handler.ts';

let defaultEngine: PipelineEngine | null = null;
let lastJobService: JobService | null = null;

export function getPipelineEngine(): PipelineEngine {
  const jobService = getJobService();
  if (!defaultEngine || lastJobService !== jobService) {
    lastJobService = jobService;
    const auditService = getAuditService();
    defaultEngine = new PipelineEngine(jobService, auditService, logger);

    // Register stage handlers
    defaultEngine.registerStageHandler(new SourceDiscoveryStageHandler());
    defaultEngine.registerStageHandler(new DocumentDiscoveryStageHandler());
    defaultEngine.registerStageHandler(new DocumentDownloadStageHandler());
    defaultEngine.registerStageHandler(new DocumentValidationStageHandler());
    defaultEngine.registerStageHandler(new TextExtractionStageHandler());
    defaultEngine.registerStageHandler(new StructuredExtractionStageHandler());
    defaultEngine.registerStageHandler(new EvidenceValidationStageHandler());
    defaultEngine.registerStageHandler(new DuplicateCheckStageHandler());
    defaultEngine.registerStageHandler(new PublishingGateStageHandler());
    defaultEngine.registerStageHandler(new WordPressPublishStageHandler());
  }
  return defaultEngine;
}

export * from './stages.ts';
export * from './contracts.ts';
export * from './engine.ts';
export * from './ingestion-handlers.ts';
export * from './duplicate-check-handler.ts';
export * from './publishing-gate-handler.ts';
export * from './wordpress-publish-handler.ts';


