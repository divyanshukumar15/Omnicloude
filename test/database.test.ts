/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase, getRepositories } from '../src/backend/database/index.ts';

describe('Database & Repository Layer Tests', () => {
  before(() => {
    initDatabase({ path: ':memory:', forceNew: true });
  });

  after(() => {
    closeDatabase();
  });

  it('should initialize all 10 core tables in SQLite schema', () => {
    const repos = getRepositories();
    assert.ok(repos.sources);
    assert.ok(repos.sourceDocuments);
    assert.ok(repos.documents);
    assert.ok(repos.recruitments);
    assert.ok(repos.jobs);
    assert.ok(repos.evidence);
    assert.ok(repos.processingJobs);
    assert.ok(repos.deduplication);
    assert.ok(repos.publishing);
    assert.ok(repos.auditLogs);
  });

  it('should create and retrieve a source entity', () => {
    const repos = getRepositories();
    const source = repos.sources.create({
      id: 'src-test-01',
      name: 'UPSC Official Portal',
      type: 'PORTAL',
      base_url: 'https://upsc.gov.in',
      is_active: 1,
      check_interval_minutes: 30,
      config_json: JSON.stringify({ timeout: 10000 }),
    });

    assert.equal(source.id, 'src-test-01');
    assert.equal(source.name, 'UPSC Official Portal');
    assert.equal(source.type, 'PORTAL');

    const fetched = repos.sources.findById('src-test-01');
    assert.ok(fetched);
    assert.equal(fetched.base_url, 'https://upsc.gov.in');
  });

  it('should create recruitment, job, and evidence entities', () => {
    const repos = getRepositories();

    const recruitment = repos.recruitments.create({
      id: 'rec-test-01',
      source_id: 'src-test-01',
      document_id: null,
      title: 'Civil Services Examination 2026',
      department: 'DoPT',
      notification_number: '01/2026-CSP',
      total_vacancies: 1050,
      application_start_date: '2026-02-01',
      application_end_date: '2026-02-21',
      raw_payload_json: null,
    });

    assert.equal(recruitment.id, 'rec-test-01');
    assert.equal(recruitment.total_vacancies, 1050);

    const job = repos.jobs.create({
      id: 'job-test-01',
      recruitment_id: 'rec-test-01',
      title: 'Indian Administrative Service (IAS)',
      post_code: 'IAS-01',
      vacancies: 180,
      pay_scale: 'Level 10',
      age_limit_min: 21,
      age_limit_max: 32,
      qualification_summary: 'Graduate in any discipline',
      state: 'Central',
      category: 'All',
      status: 'VERIFIED',
    });

    assert.equal(job.id, 'job-test-01');
    assert.equal(job.vacancies, 180);

    const sourceDoc = repos.sourceDocuments.create({
      id: 'src-doc-test-01',
      source_id: 'src-test-01',
      url: 'https://upsc.gov.in/notifications/01-2026.pdf',
      title: 'Civil Services 2026 Notification PDF',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: 'abc123hash',
      status: 'DISCOVERED',
      metadata_json: null,
    });
    assert.equal(sourceDoc.id, 'src-doc-test-01');

    const evidence = repos.evidence.create({
      id: 'evi-test-01',
      entity_type: 'JOB',
      entity_id: 'job-test-01',
      field_name: 'vacancies',
      source_document_id: 'src-doc-test-01',
      snippet: 'Total number of vacancies for IAS is 180 as per Annexure I',
      page_number: 4,
      confidence_score: 0.98,
      bounding_box_json: null,
    });

    assert.equal(evidence.id, 'evi-test-01');
    assert.equal(evidence.confidence_score, 0.98);
  });
});
