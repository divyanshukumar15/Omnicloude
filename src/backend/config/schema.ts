/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_OCR_MODEL = 'gemini-2.5-flash';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/govjobs.db'),
  DOCUMENT_STORAGE_DIR: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MAX_DOWNLOAD_BYTES: z.coerce.number().int().positive().default(26214400), // 25 MB
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000), // 15 seconds
  MAX_REDIRECT_HOPS: z.coerce.number().int().min(0).max(10).default(3),
  // Optional external integrations
  GEMINI_API_KEY: z.string().optional(),
  APP_URL: z.string().url().optional().or(z.literal('')),
  // OCR Configuration
  OCR_PROVIDER: z.string().default('GEMINI_MULTIMODAL_OCR'),
  // OCR model configuration — canonical runtime setting
  OCR_MODEL: z.string().default(DEFAULT_OCR_MODEL),
  OCR_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OCR_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OCR_MAX_PAGES: z.coerce.number().int().positive().default(30),
  MAX_OCR_DOCUMENT_SIZE: z.coerce.number().int().positive().default(26214400), // 25 MB
  MAX_OCR_TIME: z.coerce.number().int().positive().default(60000), // 60 seconds
  // Official Source Discovery Configuration
  SOURCE_MAX_PAGES: z.coerce.number().int().positive().default(3),
  SOURCE_MAX_NOTICES: z.coerce.number().int().positive().default(30),
  SOURCE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SOURCE_RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(2),
  SOURCE_CACHE_TTL: z.coerce.number().int().positive().default(300000), // 5 minutes in ms
  // Live Verification Runtime Configuration
  OMNIHUB_LIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(15000),
  OMNIHUB_LIVE_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  OMNIHUB_LIVE_RETRY_BACKOFF_MS: z.coerce.number().int().min(50).max(5000).default(500),
  // Official Source Acquisition Runner Configuration
  RUNNER_MODE: z.enum(['LOCAL', 'REMOTE', 'AUTO']).default('LOCAL'),
  OFFICIAL_ACQUISITION_WORKER_URL: z.string().url().optional().or(z.literal('')),
  OFFICIAL_ACQUISITION_WORKER_TOKEN: z.string().optional(),
  OMNIHUB_REMOTE_WORKER_URL: z.string().url().optional().or(z.literal('')),
  OMNIHUB_REMOTE_WORKER_TOKEN: z.string().optional(),
  // Standalone Official Acquisition Worker Service Configuration
  WORKER_EXECUTION_ENVIRONMENT: z.enum(['LOCAL_WORKER', 'PRODUCTION_REMOTE']).optional(),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  WORKER_HOST: z.string().default('0.0.0.0'),
  WORKER_MAX_RESPONSE_MB: z.coerce.number().int().min(1).max(100).default(25),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(50).max(30000).default(15000),
  WORKER_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(50).max(30000).default(15000),
  WORKER_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  WORKER_RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(10000).default(500),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
  // WordPress Publishing Configuration
  OMNIHUB_WP_URL: z.string().url().optional().or(z.literal('')),
  OMNIHUB_WP_USERNAME: z.string().optional(),
  OMNIHUB_WP_APP_PASSWORD: z.string().optional(),
  OMNIHUB_WP_DEFAULT_STATUS: z.enum(['draft', 'publish']).default('draft'),
  OMNIHUB_WP_TIMEOUT_MS: z.coerce.number().int().min(50).max(30000).default(15000),
  OMNIHUB_WP_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  OMNIHUB_WP_RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(10000).default(500),
  // API Security, Authentication, CORS & Rate Limiting
  CONTROL_APP_AUTH_TOKEN: z.string().optional(),
  CONTROL_APP_READONLY_TOKEN: z.string().optional(),
  INTERNAL_TRUSTED_TOKEN: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  API_BODY_LIMIT: z.string().default('512kb'),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  API_RATE_LIMIT_MAX_IP: z.coerce.number().int().min(1).max(10000).default(120),
  API_RATE_LIMIT_MAX_TOKEN: z.coerce.number().int().min(1).max(20000).default(240),
  // Scheduler Core & Reliability Configuration
  AUTOMATION_MODE: z.enum(['manual', 'scheduled', 'continuous']).default('manual'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(100).default(2),
  MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(2),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(21).optional(),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(3600000).default(1000),
  RETRY_MAX_BACKOFF_MS: z.coerce.number().int().min(10).max(86400000).default(300000),
  JOB_LEASE_MS: z.coerce.number().int().min(100).max(86400000).default(300000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(50).max(3600000).default(60000),
  // Reverse proxy, readiness cache & startup policy
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  READINESS_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).optional(),
  ALLOW_DEGRADED_START: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().toLowerCase() === 'true'),
  // Database maintenance (backups + retention)
  MAINTENANCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().toLowerCase()),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).max(8760).default(24),
  BACKUP_KEEP_COPIES: z.coerce.number().int().min(1).max(365).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export interface ProductionConfigGuardFinding {
  code:
    | 'PRODUCTION_AUTOMATION_MANUAL'
    | 'PRODUCTION_RUNNER_LOCAL'
    | 'PRODUCTION_REMOTE_URL_MISSING'
    | 'PRODUCTION_REMOTE_URL_INVALID'
    | 'PRODUCTION_REMOTE_LOOPBACK_FORBIDDEN'
    | 'PRODUCTION_REMOTE_HTTPS_REQUIRED'
    | 'PRODUCTION_REMOTE_TOKEN_MISSING'
    | 'PRODUCTION_AUTO_FALLBACK_UNPROVEN'
    | 'PRODUCTION_STORAGE_NOT_CONFIGURED'
    | 'PRODUCTION_STORAGE_NOT_DURABLE';
  component: 'AUTOMATION' | 'RUNNER' | 'STORAGE';
  severity: 'BLOCKER' | 'DEGRADATION';
  status: 'DEGRADED' | 'NOT_READY' | 'NOT_DURABLE' | 'NOT_CONFIGURED';
  message: string;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.endsWith('.localhost')
  );
}

export function isEphemeralTempPath(
  candidateDir: string,
  env: Record<string, unknown> = process.env
): boolean {
  const resolvedCandidate = path.resolve(candidateDir);
  const envTmpDirs = [env.TMPDIR, env.TEMP, env.TMP]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => path.resolve(v.trim()));
  const tmpRoots = Array.from(
    new Set([path.resolve(os.tmpdir()), '/tmp', '/var/tmp', '/private/tmp', ...envTmpDirs])
  );

  for (const tmpRoot of tmpRoots) {
    const normalizedRoot = tmpRoot.endsWith(path.sep) ? tmpRoot : `${tmpRoot}${path.sep}`;
    if (resolvedCandidate === tmpRoot || resolvedCandidate.startsWith(normalizedRoot)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates production configuration guards without mutating user-configured values.
 * Returns an empty list for non-production environments (development/test).
 */
export function evaluateProductionConfigGuards(
  config: Pick<
    AppConfig,
    | 'NODE_ENV'
    | 'AUTOMATION_MODE'
    | 'RUNNER_MODE'
    | 'OFFICIAL_ACQUISITION_WORKER_URL'
    | 'OMNIHUB_REMOTE_WORKER_URL'
    | 'OFFICIAL_ACQUISITION_WORKER_TOKEN'
    | 'OMNIHUB_REMOTE_WORKER_TOKEN'
    | 'DOCUMENT_STORAGE_DIR'
  >,
  env: Record<string, unknown> = process.env
): ProductionConfigGuardFinding[] {
  if (config.NODE_ENV !== 'production') {
    return [];
  }

  const findings: ProductionConfigGuardFinding[] = [];

  // 1. Production automation guard (never silently mutate AUTOMATION_MODE)
  if (config.AUTOMATION_MODE === 'manual') {
    findings.push({
      code: 'PRODUCTION_AUTOMATION_MANUAL',
      component: 'AUTOMATION',
      severity: 'DEGRADATION',
      status: 'DEGRADED',
      message:
        'Production started with AUTOMATION_MODE=manual: automatic source discovery and scheduled job processing are disabled.',
    });
  }

  // 2. Production runner guard
  const workerUrl = (
    config.OFFICIAL_ACQUISITION_WORKER_URL ||
    config.OMNIHUB_REMOTE_WORKER_URL ||
    ''
  ).trim();
  const workerToken = (
    config.OFFICIAL_ACQUISITION_WORKER_TOKEN ||
    config.OMNIHUB_REMOTE_WORKER_TOKEN ||
    ''
  ).trim();

  if (config.RUNNER_MODE === 'LOCAL') {
    findings.push({
      code: 'PRODUCTION_RUNNER_LOCAL',
      component: 'RUNNER',
      severity: 'BLOCKER',
      status: 'NOT_READY',
      message:
        'RUNNER_MODE=LOCAL is configured in production: an external HTTPS remote acquisition worker is required for production official source acquisition.',
    });
  } else if (config.RUNNER_MODE === 'REMOTE') {
    if (!workerUrl) {
      findings.push({
        code: 'PRODUCTION_REMOTE_URL_MISSING',
        component: 'RUNNER',
        severity: 'BLOCKER',
        status: 'NOT_READY',
        message:
          'RUNNER_MODE=REMOTE in production requires a valid external HTTPS OFFICIAL_ACQUISITION_WORKER_URL.',
      });
    } else {
      try {
        const parsed = new URL(workerUrl);
        if (isLoopbackHostname(parsed.hostname)) {
          findings.push({
            code: 'PRODUCTION_REMOTE_LOOPBACK_FORBIDDEN',
            component: 'RUNNER',
            severity: 'BLOCKER',
            status: 'NOT_READY',
            message: `OFFICIAL_ACQUISITION_WORKER_URL points to loopback host "${parsed.hostname}", which cannot count as REAL_REMOTE_PRODUCTION.`,
          });
        } else if (parsed.protocol !== 'https:') {
          findings.push({
            code: 'PRODUCTION_REMOTE_HTTPS_REQUIRED',
            component: 'RUNNER',
            severity: 'BLOCKER',
            status: 'NOT_READY',
            message: `OFFICIAL_ACQUISITION_WORKER_URL must use HTTPS in production (received ${parsed.protocol}).`,
          });
        }
      } catch {
        findings.push({
          code: 'PRODUCTION_REMOTE_URL_INVALID',
          component: 'RUNNER',
          severity: 'BLOCKER',
          status: 'NOT_READY',
          message: 'OFFICIAL_ACQUISITION_WORKER_URL is malformed.',
        });
      }
    }

    if (!workerToken) {
      findings.push({
        code: 'PRODUCTION_REMOTE_TOKEN_MISSING',
        component: 'RUNNER',
        severity: 'BLOCKER',
        status: 'NOT_READY',
        message:
          'RUNNER_MODE=REMOTE in production requires OFFICIAL_ACQUISITION_WORKER_TOKEN to authenticate with the remote worker.',
      });
    }
  } else if (config.RUNNER_MODE === 'AUTO') {
    let validExternalHttps = false;
    if (workerUrl) {
      try {
        const parsed = new URL(workerUrl);
        validExternalHttps = parsed.protocol === 'https:' && !isLoopbackHostname(parsed.hostname);
      } catch {
        validExternalHttps = false;
      }
    }
    if (!validExternalHttps || !workerToken) {
      findings.push({
        code: 'PRODUCTION_AUTO_FALLBACK_UNPROVEN',
        component: 'RUNNER',
        severity: 'DEGRADATION',
        status: 'DEGRADED',
        message:
          'RUNNER_MODE=AUTO in production lacks a valid external HTTPS worker URL and auth token; LOCAL fallback may occur and production remote acquisition is not proven.',
      });
    }
  }

  // 3. Production durable storage guard
  const storageDir = (config.DOCUMENT_STORAGE_DIR || '').trim();
  if (!storageDir) {
    findings.push({
      code: 'PRODUCTION_STORAGE_NOT_CONFIGURED',
      component: 'STORAGE',
      severity: 'BLOCKER',
      status: 'NOT_READY',
      message:
        'DOCUMENT_STORAGE_DIR must be configured in production (NODE_ENV=production); ephemeral temp fallback is prohibited.',
    });
  } else if (isEphemeralTempPath(storageDir, env)) {
    findings.push({
      code: 'PRODUCTION_STORAGE_NOT_DURABLE',
      component: 'STORAGE',
      severity: 'BLOCKER',
      status: 'NOT_DURABLE',
      message: `DOCUMENT_STORAGE_DIR ("${path.resolve(storageDir)}") points inside an ephemeral temporary directory, which is prohibited in production.`,
    });
  }

  return findings;
}

export interface FatalSecurityGuardFinding {
  code:
    | 'PRODUCTION_AUTH_TOKEN_WEAK'
    | 'PRODUCTION_WP_NOT_HTTPS'
    | 'PRODUCTION_CORS_NOT_CONFIGURED'
    | 'PRODUCTION_GEMINI_KEY_MISSING'
    | 'PRODUCTION_REMOTE_RUNNER_INVALID';
  message: string;
}

/**
 * Production fail-closed guards. Unlike {@link evaluateProductionConfigGuards} (which only reports
 * readiness degradation), any finding returned here must stop startup unless the operator
 * explicitly sets ALLOW_DEGRADED_START=true (staging only).
 * Returns an empty list outside production.
 */
export function evaluateFatalSecurityGuards(
  config: Pick<
    AppConfig,
    | 'NODE_ENV'
    | 'CONTROL_APP_AUTH_TOKEN'
    | 'OMNIHUB_WP_URL'
    | 'CORS_ALLOWED_ORIGINS'
    | 'APP_URL'
    | 'GEMINI_API_KEY'
    | 'OCR_PROVIDER'
    | 'AUTOMATION_MODE'
    | 'RUNNER_MODE'
    | 'OFFICIAL_ACQUISITION_WORKER_URL'
    | 'OMNIHUB_REMOTE_WORKER_URL'
    | 'OFFICIAL_ACQUISITION_WORKER_TOKEN'
    | 'OMNIHUB_REMOTE_WORKER_TOKEN'
    | 'DOCUMENT_STORAGE_DIR'
  >,
  env: Record<string, unknown> = process.env
): FatalSecurityGuardFinding[] {
  if (config.NODE_ENV !== 'production') {
    return [];
  }
  const findings: FatalSecurityGuardFinding[] = [];

  const authToken = (config.CONTROL_APP_AUTH_TOKEN ?? '').trim();
  if (authToken.length < 32) {
    findings.push({
      code: 'PRODUCTION_AUTH_TOKEN_WEAK',
      message:
        'CONTROL_APP_AUTH_TOKEN must be set to a secret of at least 32 characters in production.',
    });
  }

  const wpUrl = (config.OMNIHUB_WP_URL ?? '').trim();
  if (wpUrl && !wpUrl.toLowerCase().startsWith('https://')) {
    findings.push({
      code: 'PRODUCTION_WP_NOT_HTTPS',
      message: 'OMNIHUB_WP_URL must use https:// in production.',
    });
  }

  const corsOrigins = (config.CORS_ALLOWED_ORIGINS ?? '').trim();
  const appUrl = (config.APP_URL ?? '').trim();
  if (!corsOrigins && !appUrl) {
    findings.push({
      code: 'PRODUCTION_CORS_NOT_CONFIGURED',
      message: 'Set CORS_ALLOWED_ORIGINS or APP_URL in production so browser origins are explicit.',
    });
  }

  if (config.OCR_PROVIDER === 'GEMINI_MULTIMODAL_OCR' && !(config.GEMINI_API_KEY ?? '').trim()) {
    findings.push({
      code: 'PRODUCTION_GEMINI_KEY_MISSING',
      message:
        'GEMINI_API_KEY must be set in production because OCR_PROVIDER=GEMINI_MULTIMODAL_OCR is active.',
    });
  }

  if (config.RUNNER_MODE === 'REMOTE') {
    const remoteCodes = new Set([
      'PRODUCTION_REMOTE_URL_MISSING',
      'PRODUCTION_REMOTE_URL_INVALID',
      'PRODUCTION_REMOTE_LOOPBACK_FORBIDDEN',
      'PRODUCTION_REMOTE_HTTPS_REQUIRED',
      'PRODUCTION_REMOTE_TOKEN_MISSING',
    ]);
    for (const finding of evaluateProductionConfigGuards(config, env)) {
      if (remoteCodes.has(finding.code)) {
        findings.push({ code: 'PRODUCTION_REMOTE_RUNNER_INVALID', message: finding.message });
      }
    }
  }

  return findings;
}
