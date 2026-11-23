/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOfficialAcquisitionWorkerApp,
  resolveWorkerRuntimeConfig,
} from './official-acquisition-worker.ts';
import { logger } from '../backend/config/logger.ts';

async function main(): Promise<void> {
  const config = resolveWorkerRuntimeConfig({
    executionEnvironment:
      process.env.WORKER_EXECUTION_ENVIRONMENT === 'LOCAL_WORKER'
        ? 'LOCAL_WORKER'
        : 'PRODUCTION_REMOTE',
    workerMode:
      process.env.WORKER_EXECUTION_ENVIRONMENT === 'LOCAL_WORKER'
        ? 'LOCAL_WORKER'
        : 'PRODUCTION_WORKER',
  });
  const { start, worker } = createOfficialAcquisitionWorkerApp(config);

  const instance = await start(config.port, config.host);
  const identity = worker.getIdentity();

  logger.info('OFFICIAL_ACQUISITION_WORKER_STARTED', {
    url: instance.url,
    port: instance.port,
    host: config.host,
    remoteWorkerId: identity.remoteWorkerId,
    workerVersion: identity.workerVersion,
    executionEnvironment: identity.executionEnvironment,
    authConfigured: Boolean(config.token),
    maxResponseMb: config.maxResponseMb,
    requestTimeoutMs: config.requestTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    maxRetries: config.maxRetries,
    retryBackoffMs: config.retryBackoffMs,
    maxConcurrency: config.maxConcurrency,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('OFFICIAL_ACQUISITION_WORKER_SHUTTING_DOWN', { signal });
    try {
      await instance.gracefulShutdown(5000);
      logger.info('OFFICIAL_ACQUISITION_WORKER_STOPPED', { signal });
      process.exit(0);
    } catch (err) {
      logger.error('OFFICIAL_ACQUISITION_WORKER_SHUTDOWN_ERROR', {
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only auto-start when executed directly as an entrypoint (via tsx src/worker/server.ts or node dist/worker/server.js)
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentModulePath = fileURLToPath(import.meta.url);
if (
  invokedScript === currentModulePath ||
  invokedScript.endsWith(path.join('src', 'worker', 'server.ts')) ||
  invokedScript.endsWith(path.join('dist', 'worker', 'server.js'))
) {
  main().catch((err) => {
    logger.error('OFFICIAL_ACQUISITION_WORKER_FATAL', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
