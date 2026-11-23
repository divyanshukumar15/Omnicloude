/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';

const testFiles = [
  path.resolve(import.meta.dirname, 'config.test.ts'),
  path.resolve(import.meta.dirname, 'security.test.ts'),
  path.resolve(import.meta.dirname, 'database.test.ts'),
  path.resolve(import.meta.dirname, 'database/schema-migration.test.ts'),
  path.resolve(import.meta.dirname, 'pipeline-and-jobs.test.ts'),
  path.resolve(import.meta.dirname, 'pipeline-fanout.test.ts'),
  path.resolve(import.meta.dirname, 'ingestion/ingestion-pipeline.test.ts'),
  path.resolve(import.meta.dirname, 'extraction/extraction.test.ts'),
  path.resolve(import.meta.dirname, 'ingestion/ocr.test.ts'),
  path.resolve(import.meta.dirname, 'deduplication/deduplication.test.ts'),
  path.resolve(import.meta.dirname, 'publishing-gate/publishing-gate.test.ts'),
  path.resolve(import.meta.dirname, 'discovery/source-adapters.test.ts'),
  path.resolve(import.meta.dirname, 'worker/official-acquisition-worker.test.ts'),
  path.resolve(import.meta.dirname, 'wordpress/wordpress-publish.test.ts'),
  path.resolve(import.meta.dirname, 'api/security-layer.test.ts'),
  path.resolve(import.meta.dirname, 'api/operations.test.ts'),
  path.resolve(import.meta.dirname, 'scheduler/scheduler-claim.test.ts'),
  path.resolve(import.meta.dirname, 'scheduler/scheduler-reliability.test.ts'),
  path.resolve(import.meta.dirname, 'scheduler/scheduler-runtime.test.ts'),
  path.resolve(import.meta.dirname, 'scheduler/source-discovery-seeder.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/bootstrap-storage-readiness.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/extraction-dedup-concurrency.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/remote-reconciliation-wp.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/hardening-pipeline-db-wp.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/hardening-evidence-ocr-docker-readiness.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/production-integration-guards.test.ts'),
  path.resolve(import.meta.dirname, 'production-hardening/hardening-public-probes-guards-maintenance.test.ts'),
];


console.log('--- Running OmniHub GovJobs Automation AI Foundation Tests ---');

const testStream = run({
  files: testFiles,
});

const formatted = testStream.compose(spec);
formatted.pipe(process.stdout);

testStream.on('test:fail', () => {
  process.exitCode = 1;
});

formatted.on('end', () => {
  process.exit(process.exitCode || 0);
});

testStream.on('end', () => {
  setTimeout(() => {
    process.exit(process.exitCode || 0);
  }, 300);
});

testStream.on('close', () => {
  setTimeout(() => {
    process.exit(process.exitCode || 0);
  }, 300);
});
