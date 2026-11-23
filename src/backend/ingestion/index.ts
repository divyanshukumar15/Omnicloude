/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.ts';
export * from './adapters/source-adapter.interface.ts';
export * from './adapters/base-adapter.ts';
export * from './adapters/registry.ts';
export * from './downloader/document-downloader.ts';
export * from './pdf/pdf-validator.ts';
export type { IOCRFallbackProvider } from './extraction/ocr-fallback.interface.ts';
export { UnconfiguredOcrProvider } from './extraction/ocr-fallback.interface.ts';
export * from './extraction/text-extractor.ts';
export * from './ocr/index.ts';
export * from './provenance/provenance-service.ts';
export * from './ingestion-pipeline.ts';

import { OfficialDocumentIngestionPipeline } from './ingestion-pipeline.ts';

let defaultIngestionPipeline: OfficialDocumentIngestionPipeline | null = null;

/**
 * @deprecated Compatibility-only accessor for OfficialDocumentIngestionPipeline.
 * Production ingestion MUST enqueue jobs via JobService / PipelineEngine (see POST /api/ingest).
 */
export function getIngestionPipeline(): OfficialDocumentIngestionPipeline {
  if (!defaultIngestionPipeline) {
    defaultIngestionPipeline = new OfficialDocumentIngestionPipeline();
  }
  return defaultIngestionPipeline;
}
