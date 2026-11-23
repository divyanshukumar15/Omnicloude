/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../config/logger.ts';
import { isEphemeralTempPath } from '../config/schema.ts';

export type DocumentStorageErrorCode =
  | 'DOCUMENT_STORAGE_NOT_CONFIGURED'
  | 'DOCUMENT_STORAGE_NOT_DURABLE'
  | 'DOCUMENT_STORAGE_CHECKSUM_MISMATCH'
  | 'DOCUMENT_STORAGE_NOT_FOUND'
  | 'DOCUMENT_STORAGE_IO_ERROR';

export class DocumentStorageError extends Error {
  readonly code: DocumentStorageErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DocumentStorageErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DocumentStorageError';
    this.code = code;
    this.details = details;
  }
}

export interface DocumentStorageMetadata {
  sha256Hash: string;
  byteSize: number;
  mimeType: string;
  sourceId?: string;
  documentId?: string;
  sourceUrl?: string;
  canonicalUrl?: string;
  savedAt: string;
  storageUri: string;
  filePath: string;
}

export interface SaveDocumentInput {
  buffer: Buffer;
  expectedSha256?: string;
  mimeType?: string;
  sourceId?: string;
  documentId?: string;
  sourceUrl?: string;
  canonicalUrl?: string;
}

export interface SaveDocumentResult {
  filePath: string;
  storageUri: string;
  sha256Hash: string;
  byteSize: number;
  deduplicated: boolean;
  metadata: DocumentStorageMetadata;
}

export interface ReadDocumentResult {
  buffer: Buffer;
  sha256Hash: string;
  byteSize: number;
  filePath: string;
  checksumVerified: boolean;
  metadata: DocumentStorageMetadata | null;
}

export type DocumentStorageStatus =
  | 'DURABLE_READY'
  | 'DEV_TEMP_FALLBACK'
  | 'NOT_CONFIGURED'
  | 'NOT_DURABLE'
  | 'NOT_WRITABLE';

export interface DocumentStorageHealth {
  status: DocumentStorageStatus;
  ready: boolean;
  configured: boolean;
  durable: boolean;
  usingTempFallback: boolean;
  writable: boolean;
  environment: string;
  storageDir: string | null;
  reason: string;
}

export interface DocumentStorageServiceOptions {
  storageDir?: string;
  env?: Record<string, unknown>;
}

function isPathInsideTempDir(
  candidateDir: string,
  env: Record<string, unknown> = process.env
): boolean {
  return isEphemeralTempPath(candidateDir, env);
}

function computeSha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

function normalizeSha256Hash(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleaned)) {
    throw new DocumentStorageError(
      'DOCUMENT_STORAGE_CHECKSUM_MISMATCH',
      `Invalid SHA-256 hash format: "${raw}"`
    );
  }
  return cleaned;
}

/**
 * Single authoritative durable document storage service for OmniHub GovJobs.
 *
 * Guarantees:
 * - Deterministic content-addressed paths sharded by SHA-256 prefix
 * - Atomic writes (write temp file -> fsync -> atomic rename)
 * - Mandatory SHA-256 verification on save and retrieval
 * - Never silently falls back to /tmp in production (NODE_ENV=production)
 * - In development/test, explicitly reports DEV_TEMP_FALLBACK when DOCUMENT_STORAGE_DIR is unset
 */
export class DocumentStorageService {
  private readonly explicitDir: string | undefined;
  private readonly envOverride: Record<string, unknown> | undefined;

  constructor(options: DocumentStorageServiceOptions = {}) {
    this.explicitDir = options.storageDir?.trim() || undefined;
    this.envOverride = options.env;
  }

  private getEnv(): Record<string, unknown> {
    return this.envOverride ?? process.env;
  }

  private getEnvironment(): string {
    const env = this.getEnv();
    const raw = typeof env.NODE_ENV === 'string' ? env.NODE_ENV.trim().toLowerCase() : '';
    return raw || 'development';
  }

  private getConfiguredDirRaw(): string {
    if (this.explicitDir) {
      return this.explicitDir;
    }
    const env = this.getEnv();
    const raw = typeof env.DOCUMENT_STORAGE_DIR === 'string' ? env.DOCUMENT_STORAGE_DIR.trim() : '';
    return raw;
  }

  /**
   * Evaluates durable document storage readiness truthfully without mutating configuration.
   */
  public getHealth(): DocumentStorageHealth {
    const environment = this.getEnvironment();
    const isProduction = environment === 'production';
    const configuredRaw = this.getConfiguredDirRaw();

    if (!configuredRaw) {
      if (isProduction) {
        return {
          status: 'NOT_CONFIGURED',
          ready: false,
          configured: false,
          durable: false,
          usingTempFallback: false,
          writable: false,
          environment,
          storageDir: null,
          reason:
            'DOCUMENT_STORAGE_DIR is required in production (NODE_ENV=production); ephemeral /tmp fallback is strictly forbidden.',
        };
      }

      const devTempDir = path.join(os.tmpdir(), 'omnihub-documents-dev');
      const writable = this.probeDirectoryWritable(devTempDir);
      return {
        status: writable ? 'DEV_TEMP_FALLBACK' : 'NOT_WRITABLE',
        ready: writable,
        configured: false,
        durable: false,
        usingTempFallback: true,
        writable,
        environment,
        storageDir: devTempDir,
        reason: writable
          ? `Non-production (${environment}) explicit temp storage active at ${devTempDir}; set DOCUMENT_STORAGE_DIR for durable storage.`
          : `Dev temp storage directory ${devTempDir} is not writable.`,
      };
    }

    const resolvedDir = path.resolve(configuredRaw);
    const insideTemp = isPathInsideTempDir(resolvedDir, this.getEnv());

    if (isProduction && insideTemp) {
      return {
        status: 'NOT_DURABLE',
        ready: false,
        configured: true,
        durable: false,
        usingTempFallback: false,
        writable: false,
        environment,
        storageDir: resolvedDir,
        reason: `DOCUMENT_STORAGE_DIR ("${resolvedDir}") points inside ephemeral temp storage, which is prohibited in production.`,
      };
    }

    const writable = this.probeDirectoryWritable(resolvedDir);
    if (!writable) {
      return {
        status: 'NOT_WRITABLE',
        ready: false,
        configured: true,
        durable: !insideTemp,
        usingTempFallback: false,
        writable: false,
        environment,
        storageDir: resolvedDir,
        reason: `Configured DOCUMENT_STORAGE_DIR ("${resolvedDir}") is not writable.`,
      };
    }

    return {
      status: insideTemp ? 'DEV_TEMP_FALLBACK' : 'DURABLE_READY',
      ready: true,
      configured: true,
      durable: !insideTemp,
      usingTempFallback: insideTemp,
      writable: true,
      environment,
      storageDir: resolvedDir,
      reason: insideTemp
        ? `Explicitly configured temp storage directory active in ${environment}: ${resolvedDir}`
        : `Durable document storage verified and writable at ${resolvedDir}`,
    };
  }

  private probeDirectoryWritable(dirPath: string): boolean {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return false;
      }
      fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the active storage root directory or throws in production when unconfigured/ephemeral.
   */
  public resolveStorageDir(): string {
    const health = this.getHealth();
    if (!health.ready || !health.storageDir) {
      const code: DocumentStorageErrorCode =
        health.status === 'NOT_CONFIGURED'
          ? 'DOCUMENT_STORAGE_NOT_CONFIGURED'
          : health.status === 'NOT_DURABLE'
            ? 'DOCUMENT_STORAGE_NOT_DURABLE'
            : 'DOCUMENT_STORAGE_IO_ERROR';
      throw new DocumentStorageError(code, health.reason, { health });
    }
    return health.storageDir;
  }

  /**
   * Deterministic sharded file path for a SHA-256 content hash.
   */
  public getPathForHash(sha256Hash: string): string {
    const normalized = normalizeSha256Hash(sha256Hash);
    const rootDir = this.resolveStorageDir();
    return path.join(rootDir, normalized.slice(0, 2), normalized.slice(2, 4), `${normalized}.pdf`);
  }

  public getMetadataPathForFile(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  private resolveTargetPath(filePathOrHash: string): string {
    const trimmed = filePathOrHash.trim();
    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      return this.getPathForHash(trimmed);
    }
    if (trimmed.startsWith('file://')) {
      return path.resolve(trimmed.slice('file://'.length));
    }
    return path.resolve(trimmed);
  }

  /**
   * Atomically writes bytes to destination path using temp file + fsync + rename.
   */
  private atomicWriteFile(destPath: string, data: Buffer | string): void {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${destPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmpPath, 'wx', 0o640);
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < payload.length) {
        const written = fs.writeSync(fd, payload, offset, payload.length - offset);
        if (written <= 0) {
          throw new Error('Zero bytes written during atomic document write');
        }
        offset += written;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, destPath);
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // ignore cleanup error
      }
      throw new DocumentStorageError(
        'DOCUMENT_STORAGE_IO_ERROR',
        `Atomic write failed for "${destPath}": ${err instanceof Error ? err.message : String(err)}`,
        { destPath }
      );
    }
  }

  /**
   * Saves a document buffer durably using deterministic SHA-256 content addressing.
   * Verifies expectedSha256 if supplied and refuses mismatched payloads.
   */
  public saveDocument(input: SaveDocumentInput): SaveDocumentResult {
    const actualHash = computeSha256Hex(input.buffer);
    if (input.expectedSha256) {
      const normalizedExpected = normalizeSha256Hash(input.expectedSha256);
      if (normalizedExpected !== actualHash) {
        throw new DocumentStorageError(
          'DOCUMENT_STORAGE_CHECKSUM_MISMATCH',
          `Document SHA-256 mismatch on save: expected ${normalizedExpected}, computed ${actualHash}`,
          { expectedSha256: normalizedExpected, actualSha256: actualHash }
        );
      }
    }

    const filePath = this.getPathForHash(actualHash);
    const storageUri = `file://${filePath}`;
    let deduplicated = false;

    if (fs.existsSync(filePath)) {
      const existingBytes = fs.readFileSync(filePath);
      const existingHash = computeSha256Hex(existingBytes);
      if (existingHash === actualHash && existingBytes.length === input.buffer.length) {
        deduplicated = true;
      } else {
        logger.warn('Existing stored document failed integrity check; rewriting atomically', {
          filePath,
          expectedHash: actualHash,
          existingHash,
        });
        this.atomicWriteFile(filePath, input.buffer);
      }
    } else {
      this.atomicWriteFile(filePath, input.buffer);
    }

    const metadata: DocumentStorageMetadata = {
      sha256Hash: actualHash,
      byteSize: input.buffer.length,
      mimeType: input.mimeType || 'application/pdf',
      sourceId: input.sourceId,
      documentId: input.documentId,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      savedAt: new Date().toISOString(),
      storageUri,
      filePath,
    };

    const metaPath = this.getMetadataPathForFile(filePath);
    this.atomicWriteFile(metaPath, JSON.stringify(metadata, null, 2));

    return {
      filePath,
      storageUri,
      sha256Hash: actualHash,
      byteSize: input.buffer.length,
      deduplicated,
      metadata,
    };
  }

  /**
   * Retrieves a stored document by file path, storage URI, or SHA-256 hash.
   * Always verifies SHA-256 checksum when expectedSha256 is provided or stored in metadata.
   */
  public readDocument(filePathOrHash: string, expectedSha256?: string): ReadDocumentResult {
    const filePath = this.resolveTargetPath(filePathOrHash);
    if (!fs.existsSync(filePath)) {
      throw new DocumentStorageError(
        'DOCUMENT_STORAGE_NOT_FOUND',
        `Stored document not found at "${filePath}"`,
        { filePath }
      );
    }

    const buffer = fs.readFileSync(filePath);
    const actualHash = computeSha256Hex(buffer);
    const metadata = this.getMetadata(filePath);

    const hashToVerify =
      expectedSha256?.trim() ||
      metadata?.sha256Hash ||
      (/^[a-fA-F0-9]{64}$/.test(filePathOrHash.trim()) ? filePathOrHash.trim() : undefined);

    if (hashToVerify) {
      const normalizedExpected = normalizeSha256Hash(hashToVerify);
      if (normalizedExpected !== actualHash) {
        throw new DocumentStorageError(
          'DOCUMENT_STORAGE_CHECKSUM_MISMATCH',
          `Stored document checksum mismatch at "${filePath}": expected ${normalizedExpected}, got ${actualHash}`,
          { filePath, expectedSha256: normalizedExpected, actualSha256: actualHash }
        );
      }
    }

    return {
      buffer,
      sha256Hash: actualHash,
      byteSize: buffer.length,
      filePath,
      checksumVerified: Boolean(hashToVerify),
      metadata,
    };
  }

  /**
   * Verifies that a stored document exists and matches the expected SHA-256 checksum.
   */
  public verifyChecksum(
    filePathOrHash: string,
    expectedSha256: string
  ): { valid: boolean; exists: boolean; actualSha256: string | null; expectedSha256: string } {
    const normalizedExpected = normalizeSha256Hash(expectedSha256);
    const filePath = this.resolveTargetPath(filePathOrHash);
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        exists: false,
        actualSha256: null,
        expectedSha256: normalizedExpected,
      };
    }

    const buffer = fs.readFileSync(filePath);
    const actualSha256 = computeSha256Hex(buffer);
    return {
      valid: actualSha256 === normalizedExpected,
      exists: true,
      actualSha256,
      expectedSha256: normalizedExpected,
    };
  }

  /**
   * Checks whether a document exists in storage.
   */
  public exists(filePathOrHash: string): boolean {
    try {
      const filePath = this.resolveTargetPath(filePathOrHash);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Reads sidecar metadata JSON if present.
   */
  public getMetadata(filePathOrHash: string): DocumentStorageMetadata | null {
    try {
      const filePath = this.resolveTargetPath(filePathOrHash);
      const metaPath = this.getMetadataPathForFile(filePath);
      if (!fs.existsSync(metaPath)) {
        return null;
      }
      const raw = fs.readFileSync(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as DocumentStorageMetadata;
      if (parsed && typeof parsed.sha256Hash === 'string') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a stored document and its metadata sidecar if present.
   */
  public deleteDocument(filePathOrHash: string): boolean {
    const filePath = this.resolveTargetPath(filePathOrHash);
    let deleted = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }
    const metaPath = this.getMetadataPathForFile(filePath);
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
    return deleted;
  }
}

let defaultStorageService: DocumentStorageService | null = null;

export function getDocumentStorageService(
  options?: DocumentStorageServiceOptions
): DocumentStorageService {
  if (options) {
    return new DocumentStorageService(options);
  }
  if (!defaultStorageService) {
    defaultStorageService = new DocumentStorageService();
  }
  return defaultStorageService;
}

export function resetDocumentStorageService(): void {
  defaultStorageService = null;
}
