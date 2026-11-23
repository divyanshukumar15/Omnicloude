/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../config/logger.ts';

const BACKUP_FILE_PATTERN = /^govjobs-\d{8}-\d{6}\.db$/;
const RETENTION_BATCH_SIZE = 500;
const MAX_BATCHES_PER_TABLE = 200;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatBackupTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export interface BackupResult {
  file: string;
  removed: string[];
}

/**
 * Creates a consistent online backup using `VACUUM INTO` (safe while the DB is in use, WAL-aware)
 * and prunes older backups so that only the newest `keepCopies` remain.
 */
export function runBackup(
  db: DatabaseSync,
  backupDir: string,
  keepCopies: number,
  now: Date = new Date()
): BackupResult {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.resolve(backupDir, `govjobs-${formatBackupTimestamp(now)}.db`);
  if (fs.existsSync(file)) {
    // Same-second duplicate: already backed up.
    return { file, removed: [] };
  }
  const escaped = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort(); // timestamp in name => lexicographic == chronological
  const removed: string[] = [];
  const excess = backups.length - Math.max(1, keepCopies);
  for (let i = 0; i < excess; i += 1) {
    const victim = path.resolve(backupDir, backups[i]!);
    try {
      fs.rmSync(victim, { force: true });
      removed.push(victim);
    } catch (error) {
      logger.warn('Failed to remove old database backup', {
        file: victim,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { file, removed };
}

export interface RetentionResult {
  completedJobs: number;
  auditLogs: number;
  ocrCacheRows: number;
}

function deleteInBatches(db: DatabaseSync, table: string, idColumn: string, where: string, cutoff: string): number {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i += 1) {
    const result = db
      .prepare(
        `DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${where} LIMIT ?)`
      )
      .run(cutoff, RETENTION_BATCH_SIZE);
    const changes = Number(result.changes);
    total += changes;
    if (changes < RETENTION_BATCH_SIZE) {
      break;
    }
  }
  return total;
}

/**
 * Deletes COMPLETED processing jobs, audit logs and OCR cache rows older than `retentionDays`,
 * in small batches. FAILED/PENDING/RUNNING jobs are never touched.
 */
export function runRetention(
  db: DatabaseSync,
  retentionDays: number,
  now: Date = new Date()
): RetentionResult {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const completedJobs = deleteInBatches(
    db,
    'processing_jobs',
    'job_id',
    "status = 'COMPLETED' AND COALESCE(completed_at, updated_at) < ?",
    cutoff
  );
  const auditLogs = deleteInBatches(db, 'audit_logs', 'id', 'created_at < ?', cutoff);
  const ocrCacheRows = deleteInBatches(db, 'ocr_page_cache', 'id', 'created_at < ?', cutoff);
  return { completedJobs, auditLogs, ocrCacheRows };
}

export interface MaintenanceConfig {
  backupDir: string;
  backupIntervalHours: number; // 0 disables backups
  backupKeepCopies: number;
  retentionDays: number;
}

export class MaintenanceService {
  private timer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private lastBackupAt = 0;
  private lastRetentionAt = 0;
  private running = false;

  // NOTE: no TypeScript parameter properties here: production runs `node server.ts`
  // (type-stripping only), which rejects `private readonly` constructor shorthand.
  private readonly getDb: () => DatabaseSync;
  private readonly config: MaintenanceConfig;
  private readonly clock: () => Date;

  constructor(
    getDb: () => DatabaseSync,
    config: MaintenanceConfig,
    clock: () => Date = () => new Date()
  ) {
    this.getDb = getDb;
    this.config = config;
    this.clock = clock;
  }

  start(tickIntervalMs = 15 * 60 * 1000, firstDelayMs = 30_000): void {
    if (this.timer) {
      return;
    }
    this.lastBackupAt = this.newestBackupTime();
    this.firstTick = setTimeout(() => this.tick(), firstDelayMs);
    this.firstTick.unref();
    this.timer = setInterval(() => this.tick(), tickIntervalMs);
    this.timer.unref();
    logger.info('Database maintenance scheduled', {
      backupIntervalHours: this.config.backupIntervalHours,
      backupKeepCopies: this.config.backupKeepCopies,
      retentionDays: this.config.retentionDays,
    });
  }

  stop(): void {
    if (this.firstTick) {
      clearTimeout(this.firstTick);
      this.firstTick = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private newestBackupTime(): number {
    try {
      const dir = this.config.backupDir;
      const files = fs.readdirSync(dir).filter((n) => BACKUP_FILE_PATTERN.test(n));
      let newest = 0;
      for (const name of files) {
        newest = Math.max(newest, fs.statSync(path.resolve(dir, name)).mtimeMs);
      }
      return newest;
    } catch {
      return 0;
    }
  }

  /** True only when no job is currently RUNNING (maintenance runs in idle windows only). */
  isIdle(): boolean {
    try {
      const row = this.getDb()
        .prepare("SELECT COUNT(*) AS c FROM processing_jobs WHERE status = 'RUNNING'")
        .get() as { c: number } | undefined;
      return (row?.c ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /** Runs whatever is due. Never throws. */
  tick(): { backup?: BackupResult; retention?: RetentionResult; skipped?: string } {
    if (this.running) {
      return { skipped: 'ALREADY_RUNNING' };
    }
    if (!this.isIdle()) {
      return { skipped: 'NOT_IDLE' };
    }
    this.running = true;
    const out: { backup?: BackupResult; retention?: RetentionResult } = {};
    try {
      const now = this.clock();
      const db = this.getDb();
      const backupEveryMs = this.config.backupIntervalHours * 60 * 60 * 1000;
      if (backupEveryMs > 0 && now.getTime() - this.lastBackupAt >= backupEveryMs) {
        out.backup = runBackup(db, this.config.backupDir, this.config.backupKeepCopies, now);
        this.lastBackupAt = now.getTime();
        logger.info('Database backup completed', {
          file: out.backup.file,
          removedOldBackups: out.backup.removed.length,
        });
      }
      if (now.getTime() - this.lastRetentionAt >= 24 * 60 * 60 * 1000) {
        out.retention = runRetention(db, this.config.retentionDays, now);
        this.lastRetentionAt = now.getTime();
        logger.info('Database retention completed', { ...out.retention });
      }
    } catch (error) {
      logger.error('Database maintenance failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
    return out;
  }
}
