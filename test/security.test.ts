/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateIpv4,
  isPrivateIpv6,
  validateTargetUrl,
  validateContentType,
  SecurityViolationError,
} from '../src/backend/security/index.ts';

describe('Security & SSRF Protection Tests', () => {
  it('should identify all private and loopback IPv4 ranges', () => {
    assert.equal(isPrivateIpv4('127.0.0.1'), true);
    assert.equal(isPrivateIpv4('127.255.255.255'), true);
    assert.equal(isPrivateIpv4('10.0.1.5'), true);
    assert.equal(isPrivateIpv4('172.16.0.1'), true);
    assert.equal(isPrivateIpv4('172.31.255.255'), true);
    assert.equal(isPrivateIpv4('192.168.1.1'), true);
    assert.equal(isPrivateIpv4('169.254.169.254'), true); // Cloud metadata
    assert.equal(isPrivateIpv4('0.0.0.0'), true);

    // Public IPs should not be marked private
    assert.equal(isPrivateIpv4('8.8.8.8'), false);
    assert.equal(isPrivateIpv4('142.250.190.46'), false);
    assert.equal(isPrivateIpv4('172.15.0.1'), false);
    assert.equal(isPrivateIpv4('172.32.0.1'), false);
  });

  it('should identify private and loopback IPv6 ranges', () => {
    assert.equal(isPrivateIpv6('::1'), true);
    assert.equal(isPrivateIpv6('::'), true);
    assert.equal(isPrivateIpv6('fc00::1'), true);
    assert.equal(isPrivateIpv6('fe80::1'), true);
    assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIpv6('2001:4860:4860::8888'), false);
  });

  it('should reject URLs with forbidden schemes like file: or gopher:', async () => {
    await assert.rejects(
      async () => {
        await validateTargetUrl('file:///etc/passwd');
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityViolationError);
        assert.equal((err as SecurityViolationError).code, 'FORBIDDEN_PROTOCOL');
        return true;
      }
    );
  });

  it('should block explicit localhost and private IP addresses in URLs', async () => {
    const blockedUrls = [
      'http://localhost:3000/api',
      'http://127.0.0.1/admin',
      'http://10.0.0.1/secrets',
      'http://169.254.169.254/computeMetadata/v1/',
      'http://metadata.google.internal/',
    ];

    for (const url of blockedUrls) {
      await assert.rejects(
        async () => {
          await validateTargetUrl(url);
        },
        (err: unknown) => {
          assert.ok(err instanceof SecurityViolationError);
          return true;
        }
      );
    }
  });

  it('should validate allowed content types and reject executable/dangerous payloads', () => {
    assert.equal(validateContentType('application/pdf'), 'application/pdf');
    assert.equal(validateContentType('text/html; charset=UTF-8'), 'text/html');
    assert.equal(validateContentType('application/json'), 'application/json');

    assert.throws(
      () => {
        validateContentType('application/x-msdownload');
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityViolationError);
        assert.equal((err as SecurityViolationError).code, 'DISALLOWED_MIME_TYPE');
        return true;
      }
    );

    assert.throws(
      () => {
        validateContentType(null);
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityViolationError);
        assert.equal((err as SecurityViolationError).code, 'MISSING_CONTENT_TYPE');
        return true;
      }
    );
  });
});
