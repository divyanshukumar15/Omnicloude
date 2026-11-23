/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

let cachedVersion: string | null = null;

/**
 * Returns the application version from package.json (single source of truth).
 * Falls back to "unknown" when package.json cannot be read (never throws).
 */
export function getAppVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  const candidates = [
    path.resolve(import.meta.dirname, '../../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        cachedVersion = parsed.version.trim();
        return cachedVersion;
      }
    } catch {
      // try next candidate
    }
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}
