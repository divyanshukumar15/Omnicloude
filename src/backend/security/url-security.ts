/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dns from 'node:dns/promises';
import { URL } from 'node:url';
import { logger } from '../config/logger.ts';

export class SecurityViolationError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'SECURITY_VIOLATION', cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SecurityViolationError';
    this.code = code;
  }
}

export interface SecurityConfig {
  allowHttp?: boolean;
  maxDownloadBytes?: number;
  requestTimeoutMs?: number;
  maxRedirectHops?: number;
  allowedMimeTypes?: string[];
}

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/json',
  'application/xml',
  'text/xml',
];

/**
 * Checks whether an IPv4 address belongs to private, loopback, or link-local ranges.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) {
    return false;
  }

  const [b0, b1] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;

  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255 Private)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 (Link-local / Cloud metadata: AWS, GCP 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 (Carrier-grade NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 224.0.0.0/4 (Multicast) or 240.0.0.0/4 (Reserved)
  if (b0 >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is loopback, unique-local, link-local, or IPv4-mapped private.
 */
export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 loopback, :: unspecified
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:')) {
    const rawIpv4 = normalized.replace('::ffff:', '');
    if (rawIpv4.includes('.')) {
      return isPrivateIpv4(rawIpv4);
    }
  }

  // fc00::/7 (Unique Local)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (Link-local)
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  return false;
}

/**
 * Validates a target URL against protocol and SSRF constraints (including DNS resolution).
 */
export async function validateTargetUrl(
  rawUrl: string,
  options: { allowHttp?: boolean; skipDnsLookup?: boolean } = {}
): Promise<{ parsedUrl: URL; resolvedIps: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SecurityViolationError(`Malformed URL: ${rawUrl}`, 'INVALID_URL_FORMAT');
  }

  // Protocol validation (only http: and https: schemes are valid)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecurityViolationError(
      `Forbidden protocol "${parsed.protocol}". Only HTTPS and HTTP are allowed.`,
      'FORBIDDEN_PROTOCOL'
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit blocklist for localhost and known cloud metadata endpoints
  const blockedHostnames = new Set([
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
  ]);

  if (blockedHostnames.has(hostname) || hostname.endsWith('.localhost')) {
    throw new SecurityViolationError(
      `Access to internal/metadata hostname "${hostname}" is blocked`,
      'SSRF_BLOCKED_HOST'
    );
  }

  // Direct IP literal checks
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new SecurityViolationError(
      `Access to private IP address "${hostname}" is blocked`,
      'SSRF_PRIVATE_IP'
    );
  }

  // Enforce HTTPS when allowHttp is false
  if (parsed.protocol === 'http:' && options.allowHttp === false) {
    throw new SecurityViolationError('HTTP is disabled; HTTPS is required', 'INSECURE_PROTOCOL');
  }

  if (options.skipDnsLookup) {
    return { parsedUrl: parsed, resolvedIps: [] };
  }

  // Resolve hostname via DNS to prevent DNS rebinding / internal address aliasing
  let resolvedIps: string[] = [];
  try {
    const records = await dns.lookup(hostname, { all: true });
    resolvedIps = records.map((r) => r.address);
  } catch (err) {
    logger.warn('DNS lookup failed for target host', { hostname, error: String(err) });
    throw new SecurityViolationError(
      `Unable to resolve hostname "${hostname}": ${(err as Error).message}`,
      'DNS_RESOLUTION_FAILED',
      err
    );
  }

  if (resolvedIps.length === 0) {
    throw new SecurityViolationError(
      `No IP addresses resolved for hostname "${hostname}"`,
      'DNS_RESOLUTION_EMPTY'
    );
  }

  for (const ip of resolvedIps) {
    if (isPrivateIpv4(ip) || isPrivateIpv6(ip)) {
      throw new SecurityViolationError(
        `Hostname "${hostname}" resolved to blocked private IP "${ip}"`,
        'SSRF_DNS_REBINDING'
      );
    }
  }

  return { parsedUrl: parsed, resolvedIps };
}

/**
 * Validates whether the Content-Type header matches allowed government publication formats.
 */
export function validateContentType(
  contentTypeHeader: string | null,
  allowedMimes: string[] = DEFAULT_ALLOWED_MIME_TYPES
): string {
  if (!contentTypeHeader) {
    throw new SecurityViolationError('Missing Content-Type header on response', 'MISSING_CONTENT_TYPE');
  }

  const cleanMime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  const isAllowed = allowedMimes.some((allowed) => allowed.toLowerCase() === cleanMime);

  if (!isAllowed) {
    throw new SecurityViolationError(
      `Disallowed content-type: "${cleanMime}". Allowed types: ${allowedMimes.join(', ')}`,
      'DISALLOWED_MIME_TYPE'
    );
  }

  return cleanMime;
}

/**
 * Executes a secure HTTP/HTTPS fetch with SSRF protection, redirect verification,
 * size boundaries, and timeouts.
 */
export async function secureFetch(
  targetUrl: string,
  config: SecurityConfig = {}
): Promise<{
  url: string;
  status: number;
  mimeType: string;
  contentLength: number;
  bodyBuffer: Buffer;
}> {
  const allowHttp = config.allowHttp ?? true;
  const maxDownloadBytes = config.maxDownloadBytes ?? 26214400; // 25 MB
  const timeoutMs = config.requestTimeoutMs ?? 15000;
  const maxHops = config.maxRedirectHops ?? 3;
  const allowedMimes = config.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;

  let currentUrl = targetUrl;
  let hops = 0;

  while (hops <= maxHops) {
    // 1. Validate target URL and DNS resolution for current hop
    await validateTargetUrl(currentUrl, { allowHttp });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(new SecurityViolationError(`Request timed out after ${timeoutMs}ms`, 'REQUEST_TIMEOUT'));
    }, timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual', // We inspect and validate redirects manually
        signal: controller.signal,
        headers: {
          'User-Agent': 'OmniHub-GovJobs-Automation-AI/1.0 (+https://omnihub.internal)',
          Accept: 'text/html,application/xhtml+xml,application/pdf,application/json,*/*;q=0.8',
        },
      });

      // Handle Redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        hops++;
        if (hops > maxHops) {
          throw new SecurityViolationError(
            `Exceeded maximum redirect limit (${maxHops})`,
            'MAX_REDIRECTS_EXCEEDED'
          );
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new SecurityViolationError('Redirect response without Location header', 'INVALID_REDIRECT');
        }

        // Resolve relative redirects safely against current URL
        const nextUrl = new URL(location, currentUrl).toString();
        logger.info('Following validated redirect', { from: currentUrl, to: nextUrl, hop: hops });
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP request failed with status: ${response.status} ${response.statusText}`);
      }

      // Validate Content-Type
      const mime = validateContentType(response.headers.get('content-type'), allowedMimes);

      // Validate Content-Length header if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredSize = parseInt(contentLengthHeader, 10);
        if (!isNaN(declaredSize) && declaredSize > maxDownloadBytes) {
          throw new SecurityViolationError(
            `Declared Content-Length (${declaredSize} bytes) exceeds limit (${maxDownloadBytes} bytes)`,
            'MAX_SIZE_EXCEEDED'
          );
        }
      }

      // Stream and cap payload size
      if (!response.body) {
        return {
          url: currentUrl,
          status: response.status,
          mimeType: mime,
          contentLength: 0,
          bodyBuffer: Buffer.alloc(0),
        };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        if (totalBytes > maxDownloadBytes) {
          await reader.cancel();
          throw new SecurityViolationError(
            `Downloaded payload exceeded limit of ${maxDownloadBytes} bytes`,
            'MAX_SIZE_EXCEEDED'
          );
        }
        chunks.push(value);
      }

      const combinedBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

      return {
        url: currentUrl,
        status: response.status,
        mimeType: mime,
        contentLength: totalBytes,
        bodyBuffer: combinedBuffer,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new SecurityViolationError(`Exceeded maximum redirect hops (${maxHops})`, 'MAX_REDIRECTS_EXCEEDED');
}
