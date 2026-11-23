/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigurationError } from '../src/backend/config/index.ts';

describe('Config Module Tests', () => {
  it('should load default configuration safely', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
    });

    assert.equal(config.NODE_ENV, 'test');
    assert.equal(config.PORT, 3000);
    assert.equal(typeof config.MAX_DOWNLOAD_BYTES, 'number');
    assert.ok(config.MAX_DOWNLOAD_BYTES > 0);
    assert.equal(typeof config.REQUEST_TIMEOUT_MS, 'number');
  });

  it('should freeze configuration preventing mutation', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.throws(() => {
      // @ts-expect-error Testing immutability
      config.PORT = 9999;
    }, TypeError);
  });

  it('should fail safely on invalid port configuration', () => {
    assert.throws(
      () => {
        loadConfig({
          PORT: 'not-a-number',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConfigurationError);
        assert.ok((err as ConfigurationError).issues.some((i) => i.includes('PORT')));
        return true;
      }
    );
  });

  it('should fail safely on invalid log level', () => {
    assert.throws(
      () => {
        loadConfig({
          LOG_LEVEL: 'ultra-verbose-invalid',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConfigurationError);
        assert.ok((err as ConfigurationError).issues.some((i) => i.includes('LOG_LEVEL')));
        return true;
      }
    );
  });
});
