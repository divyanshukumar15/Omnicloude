/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { EnvSchema, type AppConfig } from './schema.ts';
import { logger } from './logger.ts';

let cachedConfig: Readonly<AppConfig> | null = null;

export class ConfigurationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Configuration validation failed: \n- ${issues.join('\n- ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/**
 * Loads, validates, and freezes application configuration.
 * Fails safely with explicit validation errors if configuration is invalid.
 */
export function loadConfig(rawEnv: Record<string, unknown> = process.env): Readonly<AppConfig> {
  const result = EnvSchema.safeParse(rawEnv);

  if (!result.success) {
    const errorDetails = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `Key "${path}": ${issue.message}`;
    });

    logger.error('Failed to validate application configuration', undefined, {
      issues: errorDetails,
    });

    throw new ConfigurationError(errorDetails);
  }

  const frozenConfig = Object.freeze({ ...result.data });
  cachedConfig = frozenConfig;
  return frozenConfig;
}

/**
 * Returns current configuration or loads it if not already initialized.
 */
export function getConfig(): Readonly<AppConfig> {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

export { type AppConfig };
