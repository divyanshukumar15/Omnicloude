/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.ts';
import { logger } from '../config/logger.ts';
import { initDatabase, closeDatabase, bootstrapOfficialSources } from '../database/index.ts';
import { initializeSchedulerRuntime, stopScheduler } from './index.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  initDatabase({ path: config.DATABASE_PATH });
  bootstrapOfficialSources();

  const initResult = initializeSchedulerRuntime();
  const status = initResult.health;

  if (initResult.error) {
    logger.error('Scheduler runner failed to initialize scheduler runtime', undefined, {
      error: initResult.error,
      automationMode: status.automationMode,
    });
    closeDatabase();
    process.exit(1);
    return;
  }

  if (!initResult.started) {
    logger.info('Scheduler runner exiting cleanly (AUTOMATION_MODE=manual)', {
      automationMode: status.automationMode,
    });
    closeDatabase();
    return;
  }

  logger.info('Scheduler core entrypoint initialized', {
    workerId: status.workerId,
    automationMode: status.automationMode,
    pollIntervalSeconds: status.pollIntervalSeconds,
    maxConcurrentJobs: status.maxConcurrentJobs,
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      logger.info('Scheduler core shutting down', { signal });
      await stopScheduler(true);
      closeDatabase();
      process.exit(0);
    })();
    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentModulePath = fileURLToPath(import.meta.url);
if (
  invokedScript === currentModulePath ||
  invokedScript.endsWith(path.join('src', 'backend', 'scheduler', 'runner.ts'))
) {
  main().catch((err) => {
    logger.error('Fatal error in scheduler core entrypoint', err);
    closeDatabase();
    process.exit(1);
  });
}
