/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogContext {
  correlationId?: string;
  jobId?: string;
  stage?: string;
  actor?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'gemini_api_key',
  'private_key',
  'omnihub_wp_app_password',
  'app_password',
  'apppassword',
  'control_app_auth_token',
  'control_app_readonly_token',
  'internal_trusted_token',
  'x-api-key',
  'x-auth-token',
]);

function redactStringSecrets(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

/**
 * Sanitizes any data payload to prevent accidental logging of credentials, keys, or tokens.
 */
export function sanitizeLogData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return redactStringSecrets(data);
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      sanitized[key] = redactStringSecrets(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class StructuredLogger {
  private minLevel: LogLevel;
  private defaultContext: LogContext;

  constructor(minLevel: LogLevel = 'info', defaultContext: LogContext = {}) {
    this.minLevel = minLevel;
    this.defaultContext = defaultContext;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const merged = sanitizeLogData({
      timestamp,
      level: level.toUpperCase(),
      message,
      ...this.defaultContext,
      ...context,
    });
    return JSON.stringify(merged);
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, context));
    }
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    if (this.shouldLog('error')) {
      const errContext =
        error instanceof Error
          ? {
              errorName: error.name,
              errorMessage: error.message,
              stack: error.stack,
            }
          : { errorDetail: String(error) };
      console.error(this.formatMessage('error', message, { ...errContext, ...context }));
    }
  }

  withContext(context: LogContext): StructuredLogger {
    return new StructuredLogger(this.minLevel, { ...this.defaultContext, ...context });
  }
}

export const logger = new StructuredLogger(
  (process.env.LOG_LEVEL as LogLevel) || 'info'
);
