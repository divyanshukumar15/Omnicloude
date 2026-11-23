/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initDatabase,
  closeDatabase,
  getRepositories,
  type AdapterExecutionStatus,
} from '../../src/backend/database/index.ts';
import { CURRENT_SCHEMA_VERSION } from '../../src/backend/database/connection.ts';

describe('Database Schema Migration, WAL & Integrity Tests', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDbPath(filename = 'test-migration.db'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-db-test-'));
    tempDirs.push(dir);
    return path.join(dir, filename);
  }

  it('[PASS] should accept all 19 AdapterExecutionStatus values in source_discovery_runs', () => {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();

    repos.sources.create({
      id: 'IN-CENTRAL-SSC',
      name: 'SSC',
      type: 'PORTAL',
      base_url: 'https://ssc.gov.in',
      is_active: 1,
      check_interval_minutes: 60,
      config_json: '{}',
    });

    const allStatuses: AdapterExecutionStatus[] = [
      'PASS',
      'FAIL',
      'SUCCESS',
      'SUCCESS_WITH_VALID_DOCUMENT',
      'SUCCESS_WITH_NOTICES',
      'SUCCESS_NO_RELEVANT_NOTICES',
      'ENDPOINT_WRONG_CONTENT',
      'ENDPOINT_PARSE_FAILED',
      'DOCUMENT_DISCOVERY_FAILED',
      'DOCUMENT_DOWNLOAD_FAILED',
      'PDF_VALIDATION_FAILED',
      'ADAPTER_STRUCTURE_CHANGED',
      'WRONG_ENDPOINT',
      'SOURCE_UNAVAILABLE',
      'ACCESS_BLOCKED',
      'PARSE_FAILED',
      'NETWORK_UNAVAILABLE',
      'INCONCLUSIVE',
      'DEGRADED',
    ];

    for (let i = 0; i < allStatuses.length; i++) {
      const status = allStatuses[i];
      const created = repos.sourceDiscoveryRuns.create({
        id: `run-${i}-${status}`,
        source_id: 'IN-CENTRAL-SSC',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        http_status: 200,
        final_url: 'https://ssc.gov.in',
        records_found: 1,
        documents_found: 1,
        adapter_status: status,
        error_code: null,
        error_message: null,
        metrics_json: '{}',
      });
      assert.equal(created.adapter_status, status);
    }

    const stored = repos.sourceDiscoveryRuns.listBySource('IN-CENTRAL-SSC', 50);
    assert.equal(stored.length, allStatuses.length);
  });

  it('[PASS] should migrate legacy 10-value source_discovery_runs CHECK constraint while preserving existing rows', () => {
    const dbPath = createTempDbPath('legacy-migration.db');

    // Create legacy schema manually with old 10-value CHECK constraint
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        check_interval_minutes INTEGER NOT NULL DEFAULT 60,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE source_discovery_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        http_status INTEGER,
        final_url TEXT,
        records_found INTEGER NOT NULL DEFAULT 0,
        documents_found INTEGER NOT NULL DEFAULT 0,
        adapter_status TEXT NOT NULL CHECK(adapter_status IN ('SUCCESS', 'SUCCESS_WITH_NOTICES', 'SUCCESS_NO_RELEVANT_NOTICES', 'ADAPTER_STRUCTURE_CHANGED', 'SOURCE_UNAVAILABLE', 'ACCESS_BLOCKED', 'PARSE_FAILED', 'DEGRADED', 'NETWORK_UNAVAILABLE', 'INCONCLUSIVE')),
        error_code TEXT,
        error_message TEXT,
        metrics_json TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );
      INSERT INTO sources (id, name, type, base_url, is_active, check_interval_minutes, config_json, created_at, updated_at)
      VALUES ('IN-CENTRAL-UPSC', 'UPSC', 'PORTAL', 'https://www.upsc.gov.in', 1, 60, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO source_discovery_runs (id, source_id, started_at, completed_at, http_status, final_url, records_found, documents_found, adapter_status)
      VALUES ('legacy-run-1', 'IN-CENTRAL-UPSC', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 200, 'https://www.upsc.gov.in', 3, 2, 'SUCCESS_WITH_NOTICES');
    `);
    legacyDb.close();

    // Open with initDatabase -> should migrate automatically and preserve row
    const db = initDatabase({ path: dbPath, forceNew: true });
    const repos = getRepositories();

    const preserved = repos.sourceDiscoveryRuns.findById('legacy-run-1');
    assert.ok(preserved);
    assert.equal(preserved.adapter_status, 'SUCCESS_WITH_NOTICES');
    assert.equal(preserved.records_found, 3);

    // Must now accept previously rejected statuses
    const newRun = repos.sourceDiscoveryRuns.create({
      id: 'migrated-run-2',
      source_id: 'IN-CENTRAL-UPSC',
      started_at: '2026-01-02T00:00:00Z',
      completed_at: '2026-01-02T00:01:00Z',
      http_status: 200,
      final_url: 'https://www.upsc.gov.in',
      records_found: 2,
      documents_found: 2,
      adapter_status: 'SUCCESS_WITH_VALID_DOCUMENT',
      error_code: null,
      error_message: null,
      metrics_json: null,
    });
    assert.equal(newRun.adapter_status, 'SUCCESS_WITH_VALID_DOCUMENT');

    const versionRow = db.prepare('PRAGMA user_version;').get() as { user_version: number };
    assert.equal(versionRow.user_version, CURRENT_SCHEMA_VERSION);

    closeDatabase();
  });

  it('[PASS] should migrate legacy processing_jobs table to v3 with parent_job_id and unique dedupe_key while preserving rows', () => {
    const dbPath = createTempDbPath('legacy-jobs-v2.db');

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE processing_jobs (
        job_id TEXT PRIMARY KEY,
        target_entity_type TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error_code TEXT,
        error_message TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      INSERT INTO processing_jobs (
        job_id, target_entity_type, target_entity_id, stage, status, attempts, max_attempts, created_at, updated_at
      ) VALUES (
        'legacy-job-1', 'SOURCE', 'IN-CENTRAL-SSC', 'SOURCE_DISCOVERY', 'PENDING', 0, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      );
      PRAGMA user_version = 2;
    `);
    legacyDb.close();

    const db = initDatabase({ path: dbPath, forceNew: true });
    const repos = getRepositories();

    const preserved = repos.processingJobs.findById('legacy-job-1');
    assert.ok(preserved);
    assert.equal(preserved.parent_job_id ?? null, null);
    assert.equal(preserved.dedupe_key ?? null, null);

    const first = repos.processingJobs.createIdempotent({
      parent_job_id: 'legacy-job-1',
      dedupe_key: 'doc:test-stable-hash-1',
      target_entity_type: 'DOCUMENT',
      target_entity_id: 'doc-1',
      stage: 'DOCUMENT_DOWNLOAD',
    });
    assert.equal(first.created, true);
    assert.equal(first.job.parent_job_id, 'legacy-job-1');

    const second = repos.processingJobs.createIdempotent({
      parent_job_id: 'legacy-job-1',
      dedupe_key: 'doc:test-stable-hash-1',
      target_entity_type: 'DOCUMENT',
      target_entity_id: 'doc-1-duplicate',
      stage: 'DOCUMENT_DOWNLOAD',
    });
    assert.equal(second.created, false);
    assert.equal(second.job.job_id, first.job.job_id);

    const versionRow = db.prepare('PRAGMA user_version;').get() as { user_version: number };
    assert.equal(versionRow.user_version, CURRENT_SCHEMA_VERSION);
  });

  it('[PASS] should fail clearly when database schema version is newer than application supports', () => {
    const dbPath = createTempDbPath('future-version.db');
    const futureDb = new DatabaseSync(dbPath);
    futureDb.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 5};`);
    futureDb.close();

    assert.throws(
      () => initDatabase({ path: dbPath, forceNew: true }),
      /Incompatible SQLite schema version/
    );
  });
});
