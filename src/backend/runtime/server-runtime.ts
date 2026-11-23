/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, type AppConfig } from '../config/index.ts';
import {
  evaluateFatalSecurityGuards,
  evaluateProductionConfigGuards,
  type ProductionConfigGuardFinding,
} from '../config/schema.ts';
import { logger } from '../config/logger.ts';
import { getDocumentStorageService } from '../storage/index.ts';
import { MaintenanceService } from '../database/maintenance.ts';
import {
  initDatabase,
  closeDatabase,
  isDatabaseInitialized,
  bootstrapOfficialSources,
  getDatabase,
} from '../database/index.ts';
import { createApiApp, type CreateApiAppOptions } from '../api/app.ts';
import {
  initializeSchedulerRuntime,
  stopScheduler,
  resetSchedulerRuntimeState,
  type SchedulerRuntimeDependencies,
  type SchedulerRuntimeInitResult,
} from '../scheduler/index.ts';

export interface ServerRuntimeOptions {
  rawEnv?: Record<string, unknown>;
  port?: number;
  host?: string;
  forceNewDatabase?: boolean;
  mountFrontend?: boolean;
  registerSignalHandlers?: boolean;
  exitOnShutdown?: boolean;
  apiOptions?: CreateApiAppOptions;
  schedulerDeps?: SchedulerRuntimeDependencies;
  onDatabaseInitialized?: () => void;
}

export interface ServerRuntimeHandle {
  app: express.Application;
  server: http.Server;
  config: Readonly<AppConfig>;
  schedulerInit: SchedulerRuntimeInitResult;
  productionGuards: ProductionConfigGuardFinding[];
  getAddress: () => { host: string; port: number; url: string };
  shutdown: (signal?: string) => Promise<void>;
}

/**
 * Starts the OmniHub backend HTTP server with ordered startup:
 * 1. Validate configuration
 * 2. Initialize SQLite database & schemas
 * 3. Initialize & auto-start SchedulerService + SourceDiscoverySeeder when AUTOMATION_MODE is `scheduled` or `continuous`
 * 4. Mount Express API + Frontend & bind HTTP listener
 * 5. Register single idempotent SIGINT/SIGTERM graceful shutdown
 */
export async function startServerRuntime(
  options: ServerRuntimeOptions = {}
): Promise<ServerRuntimeHandle> {
  const effectiveEnv = options.rawEnv ?? process.env;

  // 1. Safe environment and configuration validation
  const config = loadConfig(effectiveEnv);
  const productionGuards = evaluateProductionConfigGuards(config, effectiveEnv);
  const startupStorageHealth = getDocumentStorageService({ env: effectiveEnv }).getHealth();
  logger.info('Environment and configuration validated successfully', {
    environment: config.NODE_ENV,
    port: options.port ?? config.PORT,
    automationMode: config.AUTOMATION_MODE,
    runnerMode: config.RUNNER_MODE,
    documentStorageStatus: startupStorageHealth.status,
  });

  if (config.NODE_ENV === 'production') {
    // Fail closed: refuse to boot with an insecure production configuration unless the operator
    // explicitly opted into a degraded start (staging). The node test runner is exempt so that
    // existing runtime tests can boot minimal production fixtures; the pure guard function is
    // unit-tested directly.
    const fatalGuards = evaluateFatalSecurityGuards(config, effectiveEnv);
    if (fatalGuards.length > 0 && !process.env.NODE_TEST_CONTEXT) {
      const summary = fatalGuards.map((g) => `[${g.code}] ${g.message}`).join(' | ');
      if (config.ALLOW_DEGRADED_START) {
        logger.warn('ALLOW_DEGRADED_START=true: starting with insecure production configuration', {
          findings: fatalGuards.map((g) => g.code),
        });
      } else {
        logger.error('Refusing to start: insecure production configuration', {
          findings: fatalGuards.map((g) => g.code),
        });
        throw new Error(`Insecure production configuration, refusing to start: ${summary}`);
      }
    }
    if (config.TRUST_PROXY === 0) {
      logger.warn(
        'TRUST_PROXY is 0: behind a reverse proxy all clients share the proxy IP for rate limiting. Set TRUST_PROXY to the number of proxy hops.'
      );
    }
    for (const guard of productionGuards) {
      logger.warn(`Production configuration guard [${guard.code}]`, {
        component: guard.component,
        severity: guard.severity,
        status: guard.status,
        message: guard.message,
      });
    }
    if (startupStorageHealth.status !== 'DURABLE_READY') {
      logger.warn('Production durable document storage guard failed on startup', {
        status: startupStorageHealth.status,
        storageDir: startupStorageHealth.storageDir,
        writable: startupStorageHealth.writable,
        durable: startupStorageHealth.durable,
        reason: startupStorageHealth.reason,
      });
    }
  }

  // 2. Initialize database & schemas BEFORE starting scheduler
  initDatabase({
    path: config.DATABASE_PATH,
    forceNew: options.forceNewDatabase,
  });

  if (!isDatabaseInitialized()) {
    throw new Error('Database initialization failed prior to scheduler startup');
  }

  // 2b. Idempotently bootstrap all 7 official government sources on fresh DB (preserving existing config/disabled flags)
  bootstrapOfficialSources();

  options.onDatabaseInitialized?.();

  // 2c. Scheduled DB backups + retention (production default; opt-in/out via MAINTENANCE_ENABLED)
  const maintenanceEnabled =
    config.MAINTENANCE_ENABLED === 'true' ||
    (config.NODE_ENV === 'production' && config.MAINTENANCE_ENABLED !== 'false');
  const maintenance = maintenanceEnabled
    ? new MaintenanceService(() => getDatabase(), {
        backupDir: config.BACKUP_DIR,
        backupIntervalHours: config.BACKUP_INTERVAL_HOURS,
        backupKeepCopies: config.BACKUP_KEEP_COPIES,
        retentionDays: config.RETENTION_DAYS,
      })
    : null;
  maintenance?.start();

  // 3. Initialize Scheduler Runtime (auto-starts scheduler + discovery seeder only for `scheduled` | `continuous`, never `manual`)
  const schedulerDeps: SchedulerRuntimeDependencies = {
    ...options.schedulerDeps,
    rawEnv: options.schedulerDeps?.rawEnv ?? effectiveEnv,
  };
  const schedulerInit = initializeSchedulerRuntime(schedulerDeps);

  // 4. Create core Express application and mount API routes
  const app = express();
  if (config.TRUST_PROXY > 0) {
    app.set('trust proxy', config.TRUST_PROXY);
  }
  const apiApp = createApiApp(options.apiOptions);
  app.use(apiApp);

  // 5. Mount UI / Frontend (Dev vs Production) unless disabled for headless runtime tests
  const shouldMountFrontend = options.mountFrontend ?? true;
  if (shouldMountFrontend) {
    const isDev = config.NODE_ENV !== 'production';
    if (isDev) {
      logger.info('Mounting Vite dev middleware');
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.resolve('dist');
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get('*', (_req, res) => {
          res.sendFile(path.resolve(distPath, 'index.html'));
        });
      }
    }
  }

  // 6. Start HTTP server
  const listenPort = options.port ?? config.PORT;
  const listenHost = options.host ?? config.HOST;

  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(listenPort, listenHost, () => {
      const addr = srv.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      logger.info(
        `OmniHub GovJobs Automation AI server listening on http://${listenHost}:${boundPort}`
      );
      resolve(srv);
    });
    srv.on('error', reject);
  });

  // 7. Single idempotent graceful shutdown handler
  let shutdownPromise: Promise<void> | null = null;
  let onSigInt: (() => void) | null = null;
  let onSigTerm: (() => void) | null = null;

  const removeSignalHandlers = () => {
    if (onSigInt) {
      process.off('SIGINT', onSigInt);
      onSigInt = null;
    }
    if (onSigTerm) {
      process.off('SIGTERM', onSigTerm);
      onSigTerm = null;
    }
  };

  const shutdown = (signal = 'MANUAL_SHUTDOWN'): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      removeSignalHandlers();
      logger.info('Shutting down server runtime gracefully...', { signal });

      // Stop accepting new scheduler work, stop polling/continuous loop & heartbeats, await in-flight
      maintenance?.stop();
      await stopScheduler(true);
      resetSchedulerRuntimeState();

      // Close HTTP server cleanly
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });

      // Close database cleanly after scheduler & HTTP server are done
      closeDatabase();
      logger.info('Server runtime shutdown complete', { signal });

      if (options.exitOnShutdown) {
        process.exit(0);
      }
    })();

    return shutdownPromise;
  };

  if (options.registerSignalHandlers ?? true) {
    onSigInt = () => {
      void shutdown('SIGINT');
    };
    onSigTerm = () => {
      void shutdown('SIGTERM');
    };
    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);
  }

  return {
    app,
    server,
    config,
    schedulerInit,
    productionGuards,
    getAddress: () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : listenPort;
      const host = listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost;
      return { host, port, url: `http://${host}:${port}` };
    },
    shutdown,
  };
}
