/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../config/logger.ts';

let dbInstance: DatabaseSync | null = null;
let currentDbPath: string | null = null;

export const CURRENT_SCHEMA_VERSION = 5;

export interface DatabaseInitOptions {
  path?: string;
  forceNew?: boolean;
}

/**
 * Deterministically canonicalizes a document URL for database uniqueness and identity checks.
 * Preserves query parameters (differentiating distinct downloads), drops fragment hashes,
 * lowercases scheme/host, and normalizes trailing slashes.
 */
export function normalizeCanonicalUrl(rawUrl: string | null | undefined): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Runs a synchronous database callback inside a SQLite IMMEDIATE transaction (or SAVEPOINT if nested).
 * Always rolls back cleanly on any error and rethrows the original error.
 */
export function runInSqliteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const inTx = Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
  if (inTx) {
    const sp = `sp_${crypto.randomUUID().replace(/-/g, '')}`;
    db.exec(`SAVEPOINT ${sp};`);
    try {
      const result = fn();
      db.exec(`RELEASE SAVEPOINT ${sp};`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
        db.exec(`RELEASE SAVEPOINT ${sp};`);
      } catch {
        // Ignore rollback cleanup error
      }
      throw err;
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback cleanup error
    }
    throw err;
  }
}

/**
 * Initializes and configures the SQLite database.
 * Sets foreign_keys and WAL mode, validates integrity & schema version, and applies idempotent migrations.
 */
export function initDatabase(options: DatabaseInitOptions = {}): DatabaseSync {
  if (dbInstance && !options.forceNew) {
    return dbInstance;
  }

  const dbPath = options.path || process.env.DATABASE_PATH || './data/govjobs.db';

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  logger.info('Initializing SQLite database connection', { dbPath });

  const db = new DatabaseSync(dbPath);

  try {
    // Run startup quick integrity check on file-backed databases before serving traffic
    if (dbPath !== ':memory:') {
      const quickCheckRow = db.prepare('PRAGMA quick_check;').get() as
        | { quick_check?: string }
        | undefined;
      if (!quickCheckRow || quickCheckRow.quick_check !== 'ok') {
        throw new Error(
          `SQLite integrity check failed for "${dbPath}": ${quickCheckRow?.quick_check ?? 'unknown'}`
        );
      }
    }

    // Check existing schema version for forward incompatibility before mutating
    const userVersionRow = db.prepare('PRAGMA user_version;').get() as
      | { user_version?: number }
      | undefined;
    const existingVersion = Number(userVersionRow?.user_version ?? 0);
    if (existingVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Incompatible SQLite schema version ${existingVersion}; application supports up to version ${CURRENT_SCHEMA_VERSION}`
      );
    }

    // Enable foreign keys
    db.exec('PRAGMA foreign_keys = ON;');

    // Enable WAL mode and busy_timeout for better concurrency when file-based
    if (dbPath !== ':memory:') {
      try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
        db.exec('PRAGMA busy_timeout = 5000;');
      } catch (err) {
        logger.warn('Could not set WAL mode on SQLite', { error: String(err) });
      }
    }

    // Load and execute the schema DDL
    const schemaPath = path.resolve(import.meta.dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
      db.exec(schemaSql);
    } else {
      throw new Error(`Schema file not found at: ${schemaPath}`);
    }

    ensurePublishingRecordsMigration(db);
    ensureProcessingJobsClaimMigration(db);
    ensureProcessingJobsFanoutMigration(db);
    ensureProcessingJobsPartialFailedMigration(db);
    ensureRecruitmentsCanonicalIdentityMigration(db);
    ensureSourceDiscoveryRunsMigration(db);
    ensureSourceDocumentsDedupeMigration(db);
    ensureDocumentsSha256DedupeMigration(db);

    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(1, 'initial_phase1_schema_and_claim_lease', now);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(2, 'source_discovery_runs_full_adapter_status_check', now);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(3, 'processing_jobs_parent_link_and_dedupe_key', now);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(4, 'partial_failed_reconciliation_and_canonical_recruitment_identity', now);
    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(
      CURRENT_SCHEMA_VERSION,
      'db_level_document_and_publishing_dedupe_with_legacy_reconciliation',
      now
    );
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);

    logger.info('SQLite schema loaded and verified successfully', {
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    dbInstance = db;
    currentDbPath = dbPath;
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // Ignore secondary close error
    }
    throw err;
  }
}

function ensureSourceDiscoveryRunsMigration(db: DatabaseSync): void {
  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_discovery_runs'")
    .get() as { sql?: string } | undefined;

  const createSql = tableRow?.sql ?? '';
  if (!createSql) {
    return;
  }

  // Legacy tables only listed 10 adapter_status values and rejected PASS / SUCCESS_WITH_VALID_DOCUMENT etc.
  if (
    createSql.includes('SUCCESS_WITH_VALID_DOCUMENT') &&
    createSql.includes("'PASS'") &&
    createSql.includes('ENDPOINT_PARSE_FAILED')
  ) {
    return;
  }

  logger.info('Migrating legacy source_discovery_runs CHECK constraint to support all 19 AdapterExecutionStatus values');

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE source_discovery_runs_migrated (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      http_status INTEGER,
      final_url TEXT,
      records_found INTEGER NOT NULL DEFAULT 0,
      documents_found INTEGER NOT NULL DEFAULT 0,
      adapter_status TEXT NOT NULL CHECK(adapter_status IN (
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
        'DEGRADED'
      )),
      error_code TEXT,
      error_message TEXT,
      metrics_json TEXT,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    );
    INSERT INTO source_discovery_runs_migrated (
      id, source_id, started_at, completed_at, http_status,
      final_url, records_found, documents_found, adapter_status,
      error_code, error_message, metrics_json
    )
    SELECT
      id, source_id, started_at, completed_at, http_status,
      final_url, records_found, documents_found, adapter_status,
      error_code, error_message, metrics_json
    FROM source_discovery_runs;
    DROP TABLE source_discovery_runs;
    ALTER TABLE source_discovery_runs_migrated RENAME TO source_discovery_runs;
    CREATE INDEX IF NOT EXISTS idx_discovery_runs_source ON source_discovery_runs(source_id, started_at);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureProcessingJobsClaimMigration(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('processing_jobs')")
    .all() as Array<{ name: string }>;
  const existingCols = new Set(columns.map((c) => c.name));

  const requiredColumns: Array<[string, string]> = [
    ['claimed_by', 'TEXT'],
    ['claimed_at', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['next_retry_at', 'TEXT'],
    ['last_heartbeat_at', 'TEXT'],
    ['recovery_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_recovery_reason', 'TEXT'],
  ];

  for (const [colName, colType] of requiredColumns) {
    if (!existingCols.has(colName)) {
      db.exec(`ALTER TABLE processing_jobs ADD COLUMN ${colName} ${colType};`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_claim
    ON processing_jobs(status, claimed_by, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_lease
    ON processing_jobs(status, lease_expires_at);
  `);
}

function ensureProcessingJobsFanoutMigration(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('processing_jobs')")
    .all() as Array<{ name: string }>;
  const existingCols = new Set(columns.map((c) => c.name));

  if (!existingCols.has('parent_job_id')) {
    db.exec('ALTER TABLE processing_jobs ADD COLUMN parent_job_id TEXT;');
  }
  if (!existingCols.has('dedupe_key')) {
    db.exec('ALTER TABLE processing_jobs ADD COLUMN dedupe_key TEXT;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_parent
    ON processing_jobs(parent_job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_dedupe_key
    ON processing_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}

function ensureProcessingJobsPartialFailedMigration(db: DatabaseSync): void {
  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processing_jobs'")
    .get() as { sql?: string } | undefined;

  const createSql = tableRow?.sql ?? '';
  if (!createSql || createSql.includes('PARTIAL_FAILED')) {
    return;
  }

  logger.info('Migrating legacy processing_jobs CHECK constraint to support PARTIAL_FAILED parent reconciliation status');

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE processing_jobs_migrated (
      job_id TEXT PRIMARY KEY,
      parent_job_id TEXT,
      dedupe_key TEXT,
      target_entity_type TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL_FAILED', 'PAUSED', 'CANCELLED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_code TEXT,
      error_message TEXT,
      metadata_json TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      last_heartbeat_at TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      last_recovery_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    INSERT INTO processing_jobs_migrated (
      job_id, parent_job_id, dedupe_key, target_entity_type, target_entity_id, stage, status,
      attempts, max_attempts, error_code, error_message, metadata_json,
      claimed_by, claimed_at, lease_expires_at, next_retry_at, last_heartbeat_at,
      recovery_count, last_recovery_reason, created_at, updated_at, started_at, completed_at
    )
    SELECT
      job_id, parent_job_id, dedupe_key, target_entity_type, target_entity_id, stage, status,
      attempts, max_attempts, error_code, error_message, metadata_json,
      claimed_by, claimed_at, lease_expires_at, next_retry_at, last_heartbeat_at,
      COALESCE(recovery_count, 0), last_recovery_reason, created_at, updated_at, started_at, completed_at
    FROM processing_jobs;
    DROP TABLE processing_jobs;
    ALTER TABLE processing_jobs_migrated RENAME TO processing_jobs;
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status, stage);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_claim ON processing_jobs(status, claimed_by, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_lease ON processing_jobs(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_parent ON processing_jobs(parent_job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_dedupe_key ON processing_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureRecruitmentsCanonicalIdentityMigration(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('recruitments')")
    .all() as Array<{ name: string }>;
  const existingCols = new Set(columns.map((c) => c.name));

  if (!existingCols.has('canonical_identity_key')) {
    db.exec('ALTER TABLE recruitments ADD COLUMN canonical_identity_key TEXT;');
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recruitments_canonical_identity
    ON recruitments(canonical_identity_key) WHERE canonical_identity_key IS NOT NULL;
  `);
}

function ensurePublishingRecordsMigration(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('publishing_records')")
    .all() as Array<{ name: string }>;
  const existingCols = new Set(columns.map((c) => c.name));

  const requiredColumns: Array<[string, string]> = [
    ['recruitment_id', 'TEXT'],
    ['external_identity_key', 'TEXT'],
    ['permalink', 'TEXT'],
    ['post_status', 'TEXT'],
    ['categories_json', 'TEXT'],
    ['canonical_source_url', 'TEXT'],
    ['official_pdf_url', 'TEXT'],
    ['validation_check_passed', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'TEXT'],
  ];

  for (const [colName, colType] of requiredColumns) {
    if (!existingCols.has(colName)) {
      db.exec(`ALTER TABLE publishing_records ADD COLUMN ${colName} ${colType};`);
    }
  }

  // Migrate away from legacy strict FK on publishing_records.job_id if present in existing DB
  const fkList = db.prepare("PRAGMA foreign_key_list('publishing_records')").all();
  if (fkList.length > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS publishing_records_migrated (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        recruitment_id TEXT,
        platform TEXT NOT NULL,
        external_post_id TEXT,
        external_identity_key TEXT,
        permalink TEXT,
        post_status TEXT,
        categories_json TEXT,
        canonical_source_url TEXT,
        official_pdf_url TEXT,
        publish_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(publish_status IN ('PENDING', 'GATE_PASSED', 'GATE_REJECTED', 'PUBLISHED', 'FAILED')),
        validation_check_passed INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        updated_at TEXT,
        payload_hash TEXT,
        error_message TEXT
      );
      INSERT INTO publishing_records_migrated (
        id, job_id, recruitment_id, platform, external_post_id, external_identity_key,
        permalink, post_status, categories_json, canonical_source_url, official_pdf_url,
        publish_status, validation_check_passed, published_at, updated_at, payload_hash, error_message
      )
      SELECT
        id, job_id, recruitment_id, platform, external_post_id, external_identity_key,
        permalink, post_status, categories_json, canonical_source_url, official_pdf_url,
        publish_status, validation_check_passed, published_at, updated_at, payload_hash, error_message
      FROM publishing_records;
      DROP TABLE publishing_records;
      ALTER TABLE publishing_records_migrated RENAME TO publishing_records;
    `);
  }

  // Reconcile any legacy duplicate (platform, external_identity_key) rows BEFORE creating the unique partial index
  const duplicatePubGroups = db
    .prepare(
      `SELECT platform, external_identity_key
       FROM publishing_records
       WHERE external_identity_key IS NOT NULL AND TRIM(external_identity_key) != ''
       GROUP BY platform, external_identity_key
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ platform: string; external_identity_key: string }>;

  if (duplicatePubGroups.length > 0) {
    runInSqliteTransaction(db, () => {
      const now = new Date().toISOString();
      for (const group of duplicatePubGroups) {
        const rows = db
          .prepare(
            `SELECT * FROM publishing_records
             WHERE platform = ? AND external_identity_key = ?
             ORDER BY
               CASE WHEN publish_status = 'PUBLISHED' THEN 0 ELSE 1 END ASC,
               CASE WHEN external_post_id IS NOT NULL AND TRIM(external_post_id) != '' THEN 0 ELSE 1 END ASC,
               COALESCE(updated_at, published_at, '') DESC,
               id ASC`
          )
          .all(group.platform, group.external_identity_key) as Array<{
          id: string;
          external_post_id: string | null;
          publish_status: string;
        }>;

        if (rows.length <= 1) continue;
        const winner = rows[0];
        const loserIds = rows.slice(1).map((r) => r.id);

        for (const loserId of loserIds) {
          db.prepare('DELETE FROM publishing_records WHERE id = ?').run(loserId);
        }

        db.prepare(
          `INSERT INTO audit_logs (
            id, correlation_id, actor, action, entity_type, entity_id, stage, status, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          `migration-v5-${crypto.randomUUID()}`,
          'SCHEMA_MIGRATION_V5',
          'LEGACY_PUBLISHING_DUPLICATES_RECONCILED',
          'PUBLISHING_RECORD',
          winner.id,
          'MIGRATION',
          'INFO',
          JSON.stringify({
            platform: group.platform,
            externalIdentityKey: group.external_identity_key,
            canonicalRecordId: winner.id,
            canonicalExternalPostId: winner.external_post_id,
            removedDuplicateIds: loserIds,
          }),
          now
        );
      }
    });
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_publishing_job ON publishing_records(job_id);
    CREATE INDEX IF NOT EXISTS idx_publishing_recruitment ON publishing_records(recruitment_id);
    CREATE INDEX IF NOT EXISTS idx_publishing_identity ON publishing_records(platform, external_identity_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_platform_identity_unique
      ON publishing_records(platform, external_identity_key)
      WHERE external_identity_key IS NOT NULL AND TRIM(external_identity_key) != '';
  `);
}

function ensureSourceDocumentsDedupeMigration(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('source_documents')")
    .all() as Array<{ name: string }>;
  const existingCols = new Set(columns.map((c) => c.name));

  if (!existingCols.has('canonical_url')) {
    db.exec('ALTER TABLE source_documents ADD COLUMN canonical_url TEXT;');
  }

  // Backfill canonical_url for any legacy rows missing it
  const rowsMissingCanonical = db
    .prepare(
      "SELECT id, url FROM source_documents WHERE canonical_url IS NULL OR TRIM(canonical_url) = ''"
    )
    .all() as Array<{ id: string; url: string }>;

  if (rowsMissingCanonical.length > 0) {
    runInSqliteTransaction(db, () => {
      const updateStmt = db.prepare(
        'UPDATE source_documents SET canonical_url = ? WHERE id = ?'
      );
      for (const row of rowsMissingCanonical) {
        updateStmt.run(normalizeCanonicalUrl(row.url), row.id);
      }
    });
  }

  // Reconcile any legacy duplicate (source_id, canonical_url) rows BEFORE creating unique index
  const duplicateGroups = db
    .prepare(
      `SELECT source_id, canonical_url
       FROM source_documents
       WHERE canonical_url IS NOT NULL AND TRIM(canonical_url) != ''
       GROUP BY source_id, canonical_url
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ source_id: string; canonical_url: string }>;

  if (duplicateGroups.length > 0) {
    runInSqliteTransaction(db, () => {
      const now = new Date().toISOString();
      for (const group of duplicateGroups) {
        const rows = db
          .prepare(
            `SELECT * FROM source_documents
             WHERE source_id = ? AND canonical_url = ?
             ORDER BY
               CASE WHEN status = 'DOWNLOADED' THEN 0 ELSE 1 END ASC,
               CASE WHEN raw_hash IS NOT NULL AND TRIM(raw_hash) != '' THEN 0 ELSE 1 END ASC,
               discovered_at ASC,
               id ASC`
          )
          .all(group.source_id, group.canonical_url) as Array<{
          id: string;
          title: string | null;
          raw_hash: string | null;
          metadata_json: string | null;
        }>;

        if (rows.length <= 1) continue;
        const winner = rows[0];
        const losers = rows.slice(1);
        const loserIds = losers.map((r) => r.id);

        let mergedMeta: Record<string, unknown> = {};
        if (winner.metadata_json) {
          try {
            const parsed = JSON.parse(winner.metadata_json);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              mergedMeta = parsed as Record<string, unknown>;
            }
          } catch {
            mergedMeta = {};
          }
        }
        const existingMerged = Array.isArray(mergedMeta.reconciledLegacySourceDocumentIds)
          ? (mergedMeta.reconciledLegacySourceDocumentIds as string[])
          : [];
        mergedMeta.reconciledLegacySourceDocumentIds = Array.from(
          new Set([...existingMerged, ...loserIds])
        );

        const resolvedHash =
          winner.raw_hash || losers.find((l) => l.raw_hash)?.raw_hash || null;
        const resolvedTitle =
          winner.title || losers.find((l) => l.title)?.title || null;

        for (const loser of losers) {
          db.prepare('UPDATE documents SET source_document_id = ? WHERE source_document_id = ?').run(
            winner.id,
            loser.id
          );
          db.prepare('UPDATE evidence SET source_document_id = ? WHERE source_document_id = ?').run(
            winner.id,
            loser.id
          );
          db.prepare('DELETE FROM source_documents WHERE id = ?').run(loser.id);
        }

        db.prepare(
          'UPDATE source_documents SET raw_hash = ?, title = ?, metadata_json = ?, updated_at = ? WHERE id = ?'
        ).run(resolvedHash, resolvedTitle, JSON.stringify(mergedMeta), now, winner.id);

        db.prepare(
          `INSERT INTO audit_logs (
            id, correlation_id, actor, action, entity_type, entity_id, stage, status, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          `migration-v5-${crypto.randomUUID()}`,
          'SCHEMA_MIGRATION_V5',
          'LEGACY_SOURCE_DOCUMENT_DUPLICATES_RECONCILED',
          'SOURCE_DOCUMENT',
          winner.id,
          'MIGRATION',
          'INFO',
          JSON.stringify({
            sourceId: group.source_id,
            canonicalUrl: group.canonical_url,
            canonicalSourceDocumentId: winner.id,
            removedDuplicateIds: loserIds,
          }),
          now
        );
      }
    });
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_documents_canonical_unique
      ON source_documents(source_id, canonical_url)
      WHERE canonical_url IS NOT NULL AND TRIM(canonical_url) != '';
  `);
}

function ensureDocumentsSha256DedupeMigration(db: DatabaseSync): void {
  // Reconcile any legacy duplicate documents sharing the exact same non-empty sha256_hash
  // BEFORE creating the unique partial index.
  // Note: canonical_url on documents is intentionally NOT unique so revised PDFs published
  // at the same official URL (with a new sha256_hash) and corrigenda remain preserved.
  const duplicateHashGroups = db
    .prepare(
      `SELECT sha256_hash
       FROM documents
       WHERE sha256_hash IS NOT NULL AND TRIM(sha256_hash) != ''
       GROUP BY sha256_hash
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ sha256_hash: string }>;

  if (duplicateHashGroups.length > 0) {
    runInSqliteTransaction(db, () => {
      const now = new Date().toISOString();
      for (const group of duplicateHashGroups) {
        const rows = db
          .prepare(
            `SELECT * FROM documents
             WHERE sha256_hash = ?
             ORDER BY
               CASE WHEN validation_status = 'VALID' THEN 0 ELSE 1 END ASC,
               CASE WHEN extraction_status IN ('EXTRACTED', 'OCR_SUCCESS') THEN 0 ELSE 1 END ASC,
               downloaded_at ASC,
               id ASC`
          )
          .all(group.sha256_hash) as Array<{
          id: string;
          source_document_id: string;
        }>;

        if (rows.length <= 1) continue;
        const winner = rows[0];
        const losers = rows.slice(1);
        const loserIds = losers.map((r) => r.id);

        const winnerPageCountRow = db
          .prepare('SELECT COUNT(*) as cnt FROM document_pages WHERE document_id = ?')
          .get(winner.id) as { cnt: number };
        let winnerHasPages = Number(winnerPageCountRow?.cnt ?? 0) > 0;

        for (const loser of losers) {
          if (!winnerHasPages) {
            const loserPageCountRow = db
              .prepare('SELECT COUNT(*) as cnt FROM document_pages WHERE document_id = ?')
              .get(loser.id) as { cnt: number };
            if (Number(loserPageCountRow?.cnt ?? 0) > 0) {
              db.prepare('UPDATE document_pages SET document_id = ? WHERE document_id = ?').run(
                winner.id,
                loser.id
              );
              winnerHasPages = true;
            }
          } else {
            db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(loser.id);
          }

          db.prepare('UPDATE recruitments SET document_id = ? WHERE document_id = ?').run(
            winner.id,
            loser.id
          );
          db.prepare('UPDATE extraction_audit_records SET document_id = ? WHERE document_id = ?').run(
            winner.id,
            loser.id
          );
          db.prepare(
            'UPDATE corrigendum_associations SET corrigendum_document_id = ? WHERE corrigendum_document_id = ?'
          ).run(winner.id, loser.id);
          db.prepare(
            'UPDATE corrigendum_associations SET related_document_id = ? WHERE related_document_id = ?'
          ).run(winner.id, loser.id);
          db.prepare(
            'UPDATE deduplication_evaluations SET incoming_document_id = ? WHERE incoming_document_id = ?'
          ).run(winner.id, loser.id);
          db.prepare(
            'UPDATE deduplication_evaluations SET matched_document_id = ? WHERE matched_document_id = ?'
          ).run(winner.id, loser.id);
          db.prepare('DELETE FROM documents WHERE id = ?').run(loser.id);
        }

        db.prepare(
          `INSERT INTO audit_logs (
            id, correlation_id, actor, action, entity_type, entity_id, stage, status, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          `migration-v5-${crypto.randomUUID()}`,
          'SCHEMA_MIGRATION_V5',
          'LEGACY_DOCUMENT_DUPLICATES_RECONCILED',
          'DOCUMENT',
          winner.id,
          'MIGRATION',
          'INFO',
          JSON.stringify({
            sha256Hash: group.sha256_hash,
            canonicalDocumentId: winner.id,
            removedDuplicateIds: loserIds,
          }),
          now
        );
      }
    });
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha256_unique
      ON documents(sha256_hash)
      WHERE sha256_hash IS NOT NULL AND TRIM(sha256_hash) != '';
  `);
}

/**
 * Returns active database instance or throws if not initialized.
 */
export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Returns true if the SQLite database connection has already been initialized.
 */
export function isDatabaseInitialized(): boolean {
  return dbInstance !== null;
}

/**
 * Closes current database connection cleanly, checkpointing WAL on file-backed databases.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    if (currentDbPath && currentDbPath !== ':memory:') {
      try {
        dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (err) {
        logger.warn('SQLite WAL checkpoint before close failed', { error: String(err) });
      }
    }
    try {
      dbInstance.close();
    } catch {
      // Ignore if already closed
    }
    dbInstance = null;
    currentDbPath = null;
    logger.info('Database connection closed');
  }
}
