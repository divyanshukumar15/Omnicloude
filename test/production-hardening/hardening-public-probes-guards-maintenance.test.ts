/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { initDatabase, closeDatabase } from '../../src/backend/database/index.ts';
import { createApiApp } from '../../src/backend/api/app.ts';
import { redactSensitive } from '../../src/backend/api/redact-public.ts';
import { getAppVersion } from '../../src/backend/runtime/app-version.ts';
import { evaluateFatalSecurityGuards, EnvSchema } from '../../src/backend/config/schema.ts';
import {
  runBackup,
  runRetention,
  MaintenanceService,
} from '../../src/backend/database/maintenance.ts';

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const SENSITIVE = ['endpoint_url', 'endpointUrl', 'workerEndpoint', 'workerId', 'activeJobIds', 'storage_dir', 'storageDir'];

describe('Public probes: redaction & version', () => {
  const ADMIN_TOKEN = 'probe-admin-token-0123456789abcdef0123456789';
  let server: http.Server;
  let baseUrl = '';

  before(async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    const app = createApiApp({
      auth: { authToken: ADMIN_TOKEN },
      rateLimit: { windowMs: 60000, maxPerIp: 1000, maxPerToken: 1000 },
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  it('redactSensitive removes sensitive keys at any depth without mutating input', () => {
    const input = { a: { endpoint_url: 'https://x', keep: 1, list: [{ workerId: 'w1', ok: true }] }, storageDir: '/p' };
    const out = redactSensitive(input);
    const keys = collectKeys(out);
    for (const k of SENSITIVE) assert.equal(keys.has(k), false, `${k} must be removed`);
    assert.equal((out as typeof input).a.keep, 1);
    assert.equal(input.a.endpoint_url, 'https://x');
  });

  it('unauthenticated /api/status, /api/health and /api/ready never expose infrastructure details', async () => {
    for (const route of ['/api/status', '/api/health', '/api/ready']) {
      const res = await fetch(`${baseUrl}${route}`);
      const body = await res.json();
      const keys = collectKeys(body);
      for (const k of SENSITIVE) {
        assert.equal(keys.has(k), false, `${route} leaked ${k}`);
      }
    }
  });

  it('authenticated /api/status keeps the full detail', async () => {
    const res = await fetch(`${baseUrl}/api/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { remote_worker: Record<string, unknown> };
    assert.ok('endpoint_url' in body.remote_worker);
  });

  it('/api/status reports the package.json version, not the old phase label', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = (await res.json()) as { version: string; architecture_phase: string };
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string };
    assert.equal(body.version, pkg.version);
    assert.equal(getAppVersion(), pkg.version);
    assert.ok(!body.architecture_phase.includes('Phase 1'));
  });
});

describe('Production fail-closed security guards', () => {
  const good = EnvSchema.parse({
    NODE_ENV: 'production',
    CONTROL_APP_AUTH_TOKEN: 'x'.repeat(40),
    OMNIHUB_WP_URL: 'https://wp.example.com',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    GEMINI_API_KEY: 'key',
    RUNNER_MODE: 'AUTO',
  });

  it('returns nothing outside production', () => {
    const dev = EnvSchema.parse({ NODE_ENV: 'development' });
    assert.deepEqual(evaluateFatalSecurityGuards(dev), []);
  });

  it('returns nothing for a secure production config', () => {
    assert.deepEqual(evaluateFatalSecurityGuards(good), []);
  });

  it('flags weak token, http WordPress, missing CORS/APP_URL and missing Gemini key', () => {
    const bad = EnvSchema.parse({
      NODE_ENV: 'production',
      CONTROL_APP_AUTH_TOKEN: 'short',
      OMNIHUB_WP_URL: 'http://wp.example.com',
    });
    const codes = evaluateFatalSecurityGuards(bad).map((f) => f.code);
    assert.ok(codes.includes('PRODUCTION_AUTH_TOKEN_WEAK'));
    assert.ok(codes.includes('PRODUCTION_WP_NOT_HTTPS'));
    assert.ok(codes.includes('PRODUCTION_CORS_NOT_CONFIGURED'));
    assert.ok(codes.includes('PRODUCTION_GEMINI_KEY_MISSING'));
  });

  it('flags RUNNER_MODE=REMOTE without a valid https worker URL and token', () => {
    const remote = { ...good, RUNNER_MODE: 'REMOTE' as const };
    const codes = evaluateFatalSecurityGuards(remote).map((f) => f.code);
    assert.ok(codes.includes('PRODUCTION_REMOTE_RUNNER_INVALID'));
  });

  it('TRUST_PROXY defaults to 0 and parses hop counts', () => {
    assert.equal(EnvSchema.parse({}).TRUST_PROXY, 0);
    assert.equal(EnvSchema.parse({ TRUST_PROXY: '2' }).TRUST_PROXY, 2);
  });
});

describe('SQLite maintenance: backup & retention', () => {
  let dir = '';
  let db: DatabaseSync;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-maint-'));
    db = new DatabaseSync(path.join(dir, 'test.db'));
    db.exec(`
      CREATE TABLE processing_jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE audit_logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE ocr_page_cache (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    `);
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runBackup writes a restorable copy and keeps only the newest N', () => {
    const backups = path.join(dir, 'backups');
    for (let i = 0; i < 5; i += 1) {
      runBackup(db, backups, 3, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    const files = fs.readdirSync(backups).sort();
    assert.equal(files.length, 3);
    assert.ok(files[0]!.endsWith('000002.db'));
    const copy = new DatabaseSync(path.join(backups, files[2]!));
    const row = copy.prepare('SELECT COUNT(*) AS c FROM processing_jobs').get() as { c: number };
    assert.equal(row.c, 0);
    copy.close();
  });

  it('runRetention deletes only old COMPLETED jobs and old audit/OCR rows', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const old = '2026-01-01T00:00:00.000Z';
    const recent = '2026-05-30T00:00:00.000Z';
    const ins = db.prepare('INSERT INTO processing_jobs VALUES (?,?,?,?,?)');
    ins.run('old-done', 'COMPLETED', old, old, old);
    ins.run('recent-done', 'COMPLETED', recent, recent, recent);
    ins.run('old-failed', 'FAILED', old, old, old);
    ins.run('old-running', 'RUNNING', old, old, null);
    db.prepare('INSERT INTO audit_logs VALUES (?,?)').run('a-old', old);
    db.prepare('INSERT INTO audit_logs VALUES (?,?)').run('a-new', recent);
    db.prepare('INSERT INTO ocr_page_cache VALUES (?,?)').run('o-old', old);

    const result = runRetention(db, 90, now);
    assert.deepEqual(result, { completedJobs: 1, auditLogs: 1, ocrCacheRows: 1 });
    const ids = (db.prepare('SELECT job_id FROM processing_jobs ORDER BY job_id').all() as { job_id: string }[]).map((r) => r.job_id);
    assert.deepEqual(ids, ['old-failed', 'old-running', 'recent-done']);
  });

  it('MaintenanceService skips while a job is RUNNING (not idle)', () => {
    const svc = new MaintenanceService(() => db, {
      backupDir: path.join(dir, 'backups2'),
      backupIntervalHours: 1,
      backupKeepCopies: 2,
      retentionDays: 90,
    });
    assert.equal(svc.isIdle(), false); // 'old-running' exists from the previous test
    assert.equal(svc.tick().skipped, 'NOT_IDLE');
    assert.equal(fs.existsSync(path.join(dir, 'backups2')), false);
  });
});
