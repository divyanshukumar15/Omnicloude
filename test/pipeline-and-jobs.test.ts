/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase } from '../src/backend/database/index.ts';
import { getJobService } from '../src/backend/jobs/index.ts';
import { getAuditService } from '../src/backend/audit/index.ts';
import { getPipelineEngine, ORDERED_PIPELINE_STAGES, getNextStage } from '../src/backend/pipeline/index.ts';

describe('Pipeline & Processing Job Engine Tests', () => {
  before(() => {
    initDatabase({ path: ':memory:', forceNew: true });
  });

  after(() => {
    closeDatabase();
  });

  it('should define all 10 pipeline stages in the exact required sequence', () => {
    const expectedStages = [
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
    ];

    assert.deepEqual(ORDERED_PIPELINE_STAGES, expectedStages);
    assert.equal(getNextStage('SOURCE_DISCOVERY'), 'DOCUMENT_DISCOVERY');
    assert.equal(getNextStage('PUBLISHING_GATE'), 'WORDPRESS_PUBLISH');
    assert.equal(getNextStage('WORDPRESS_PUBLISH'), null);
  });

  it('should create and persist a processing job with audit logging', () => {
    const jobService = getJobService();
    const auditService = getAuditService();

    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'ssc-feed-101',
      initialStage: 'SOURCE_DISCOVERY',
      metadata: { testCase: 'phase1_verification' },
    });

    assert.ok(job.job_id);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.stage, 'SOURCE_DISCOVERY');
    assert.equal(job.attempts, 0);

    // Verify audit log exists
    const logs = auditService.getByEntity('PROCESSING_JOB', job.job_id);
    assert.ok(logs.length >= 1);
    assert.equal(logs[0].action, 'JOB_CREATED');
  });

  it('should advance job to RUNNING and record attempts properly', () => {
    const jobService = getJobService();
    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'upsc-feed-202',
    });

    const running = jobService.startJob(job.job_id);
    assert.equal(running.status, 'RUNNING');
    assert.equal(running.attempts, 1);
    assert.ok(running.started_at);
  });

  it('should NEVER allow fake job completion when stage handlers are unhandled', async () => {
    const jobService = getJobService();
    const auditService = getAuditService();
    const { PipelineEngine } = await import('../src/backend/pipeline/engine.ts');
    const { logger } = await import('../src/backend/config/logger.ts');
    const bareEngine = new PipelineEngine(jobService, auditService, logger);

    const job = jobService.createJob({
      targetEntityType: 'SOURCE',
      targetEntityId: 'test-unhandled-source',
      initialStage: 'WORDPRESS_PUBLISH',
    });

    // Execute current stage on bare engine without handler
    const { job: resultJob, result } = await bareEngine.executeCurrentStage(
      job.job_id,
      'corr-test-safety-01'
    );

    // Must NOT be fake COMPLETED!
    assert.notEqual(resultJob.status, 'COMPLETED');
    assert.equal(resultJob.status, 'FAILED');
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'STAGE_NOT_IMPLEMENTED');
    assert.ok(result.errorMessage?.includes('Execution halted safely'));
  });

  it('should register WordPressPublishStageHandler on the default pipeline engine', () => {
    const engine = getPipelineEngine();
    const def = engine.getPipelineDefinition();
    const wpStage = def.find((s) => s.stage === 'WORDPRESS_PUBLISH');
    assert.ok(wpStage);
    assert.equal(wpStage.hasHandler, true);
    assert.equal(wpStage.status, 'REGISTERED');
  });
});

