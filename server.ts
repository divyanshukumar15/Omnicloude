/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from './src/backend/config/logger.ts';
import { closeDatabase } from './src/backend/database/index.ts';
import { startServerRuntime } from './src/backend/runtime/server-runtime.ts';

async function bootstrap() {
  try {
    await startServerRuntime({
      registerSignalHandlers: true,
      exitOnShutdown: true,
    });
  } catch (err) {
    logger.error('Fatal initialization error during server bootstrap', err);
    closeDatabase();
    process.exit(1);
  }
}

bootstrap();
