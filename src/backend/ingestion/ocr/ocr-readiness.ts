/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_OCR_MODEL } from '../../config/schema.ts';

export type OcrReadinessClassification =
  | 'OK'
  | 'NOT_CONFIGURED'
  | 'AUTH_ERROR'
  | 'INVALID_MODEL'
  | 'QUOTA_ERROR'
  | 'UNAVAILABLE'
  | 'UNVERIFIED';

export type OcrReadinessStatus =
  | 'READY'
  | 'CONFIGURED_UNVERIFIED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'INVALID_CONFIG';

export interface OcrReadinessReport {
  OCR_CONFIGURED: boolean;
  OCR_PROVIDER_REACHABLE: boolean;
  OCR_MODEL_VALID: boolean;
  OCR_PRODUCTION_READY: boolean;
  status: OcrReadinessStatus;
  classification: OcrReadinessClassification;
  provider: string;
  model: string;
  modelSyntaxValid: boolean;
  liveVerified: boolean;
  cached: boolean;
  checkedAt: string;
  latencyMs: number | null;
  errorCode: string | null;
  message: string;
}

export interface OcrProbeResult {
  reachable: boolean;
  modelValid: boolean;
  resolvedModelName?: string;
}

export type OcrLiveProbeFn = (params: {
  provider: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<OcrProbeResult>;

export interface CheckOcrReadinessOptions {
  apiKey?: string;
  provider?: string;
  model?: string;
  /**
   * When true, performs a lightweight live provider/model verification call
   * (or reuses a fresh TTL-cached live verification result unless forceRefresh is set).
   * Defaults to false so routine /api/health probes never spam external APIs.
   */
  liveVerify?: boolean;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
  timeoutMs?: number;
  probeFn?: OcrLiveProbeFn;
}

interface CachedReadinessEntry {
  report: OcrReadinessReport;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TRANSIENT_ERROR_CACHE_TTL_MS = 60 * 1000; // 1 minute
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

const PLACEHOLDER_API_KEYS = new Set([
  'my_gemini_api_key',
  'your_gemini_api_key',
  'your-api-key',
  'changeme',
  'placeholder',
  'none',
  'null',
  'undefined',
]);

const PLACEHOLDER_MODELS = new Set([
  'your_model',
  'your-model',
  'placeholder',
  'test',
  'none',
  'null',
  'undefined',
]);

const readinessCache = new Map<string, CachedReadinessEntry>();

export function resetOcrReadinessCache(): void {
  readinessCache.clear();
}

/**
 * Strips any potential API key patterns before returning or logging diagnostics.
 */
export function redactOcrErrorMessage(raw: string, apiKey?: string): string {
  let sanitized = raw || 'Unknown OCR provider error';
  if (apiKey && apiKey.trim().length >= 6) {
    sanitized = sanitized.split(apiKey.trim()).join('[REDACTED]');
  }
  sanitized = sanitized
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[REDACTED_API_KEY]')
    .replace(/(api[_\-]?key|key|token)\s*[=:]\s*["']?[^\s"'&]+["']?/gi, '$1=[REDACTED]');
  return sanitized;
}

export function isApiKeyConfigured(apiKey?: string): boolean {
  const trimmed = (apiKey || '').trim();
  if (trimmed.length < 8) return false;
  if (PLACEHOLDER_API_KEYS.has(trimmed.toLowerCase())) return false;
  return true;
}

export function validateOcrModelSyntax(
  model: string,
  provider: string = 'GEMINI_MULTIMODAL_OCR'
): { valid: boolean; reason?: string } {
  const trimmed = (model || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'OCR_MODEL is empty' };
  }
  if (PLACEHOLDER_MODELS.has(trimmed.toLowerCase())) {
    return { valid: false, reason: `OCR_MODEL "${trimmed}" is a placeholder value` };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: 'OCR_MODEL cannot contain whitespace' };
  }
  if (provider.toUpperCase().includes('GEMINI')) {
    const normalized = trimmed.replace(/^models\//i, '');
    if (!/^gemini-\d+(?:\.\d+)?-[a-z0-9][a-z0-9.\-]*$/i.test(normalized)) {
      return {
        valid: false,
        reason: `OCR_MODEL "${trimmed}" does not match valid Gemini model syntax (expected gemini-<version>-<variant>)`,
      };
    }
  } else if (!/^[a-z0-9][a-z0-9._:/\-]{2,}$/i.test(trimmed)) {
    return { valid: false, reason: `OCR_MODEL "${trimmed}" contains invalid characters` };
  }
  return { valid: true };
}

export function classifyOcrProbeError(
  err: unknown,
  apiKey?: string
): {
  classification: 'AUTH_ERROR' | 'INVALID_MODEL' | 'QUOTA_ERROR' | 'UNAVAILABLE';
  errorCode: string;
  message: string;
} {
  const errObj = err as { status?: number; statusCode?: number; code?: string; message?: string } | null;
  const status = errObj?.status ?? errObj?.statusCode;
  const rawMessage = errObj?.message || String(err);
  const message = redactOcrErrorMessage(rawMessage, apiKey);

  if (
    status === 401 ||
    status === 403 ||
    /api[_\s-]*key[_\s-]*invalid|api key not valid|unauthenticated|unauthorized|forbidden|permission[_\s-]*denied|\b401\b|\b403\b/i.test(
      rawMessage
    )
  ) {
    return {
      classification: 'AUTH_ERROR',
      errorCode: 'OCR_AUTH_ERROR',
      message: `OCR provider authentication failed: ${message}`,
    };
  }

  if (
    status === 404 ||
    /model[s]?\/[^\s]+.*not found|is not found|not supported for|invalid[_\s-]*model|unknown model|\b404\b/i.test(
      rawMessage
    )
  ) {
    return {
      classification: 'INVALID_MODEL',
      errorCode: 'OCR_INVALID_MODEL',
      message: `Configured OCR model is invalid or unsupported by provider: ${message}`,
    };
  }

  if (
    status === 429 ||
    /resource[_\s-]*exhausted|quota|rate[_\s-]*limit|too many requests|\b429\b/i.test(rawMessage)
  ) {
    return {
      classification: 'QUOTA_ERROR',
      errorCode: 'OCR_QUOTA_ERROR',
      message: `OCR provider quota or rate limit exceeded: ${message}`,
    };
  }

  return {
    classification: 'UNAVAILABLE',
    errorCode: 'OCR_PROVIDER_UNAVAILABLE',
    message: `OCR provider is unreachable or unavailable: ${message}`,
  };
}

async function defaultGeminiProbe(params: {
  provider: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<OcrProbeResult> {
  const ai = new GoogleGenAI({
    apiKey: params.apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const modelName = params.model.replace(/^models\//i, '');

  let abortReject: ((reason?: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  const onAbort = () => {
    abortReject?.(new Error(`OCR readiness probe timed out after ${params.timeoutMs}ms`));
  };

  if (params.signal.aborted) {
    throw new Error(`OCR readiness probe aborted before start`);
  }
  params.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const modelInfo = await Promise.race([
      ai.models.get({ model: modelName }),
      abortPromise,
    ]);
    const resolvedName = (modelInfo as { name?: string } | null)?.name;
    return {
      reachable: true,
      modelValid: Boolean(resolvedName || modelInfo),
      resolvedModelName: resolvedName || modelName,
    };
  } finally {
    params.signal.removeEventListener('abort', onAbort);
  }
}

function buildCacheKey(provider: string, model: string, apiKey: string): string {
  const keyHash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16);
  return `${provider}::${model}::${keyHash}`;
}

/**
 * Verifies OCR readiness truthfully without ever exposing API keys or spamming
 * external provider APIs on every health poll.
 *
 * Separates:
 * - OCR_CONFIGURED: provider, API key, and model syntax are configured
 * - OCR_PROVIDER_REACHABLE: provider endpoint responded to live probe
 * - OCR_MODEL_VALID: configured model exists/is accepted by provider
 * - OCR_PRODUCTION_READY: ALL three above are verified true
 */
export async function checkOcrReadiness(
  options: CheckOcrReadinessOptions = {}
): Promise<OcrReadinessReport> {
  const provider = (options.provider ?? process.env.OCR_PROVIDER ?? 'GEMINI_MULTIMODAL_OCR').trim() || 'GEMINI_MULTIMODAL_OCR';
  const model = (options.model ?? process.env.OCR_MODEL ?? DEFAULT_OCR_MODEL).trim();
  const apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.GEMINI_API_KEY ?? '');
  const checkedAt = new Date().toISOString();

  // 1. Check API key configuration
  if (!isApiKeyConfigured(apiKey)) {
    return {
      OCR_CONFIGURED: false,
      OCR_PROVIDER_REACHABLE: false,
      OCR_MODEL_VALID: false,
      OCR_PRODUCTION_READY: false,
      status: 'NOT_CONFIGURED',
      classification: 'NOT_CONFIGURED',
      provider,
      model,
      modelSyntaxValid: validateOcrModelSyntax(model, provider).valid,
      liveVerified: false,
      cached: false,
      checkedAt,
      latencyMs: null,
      errorCode: 'OCR_API_KEY_NOT_CONFIGURED',
      message: `OCR provider "${provider}" is not configured (GEMINI_API_KEY missing or placeholder)`,
    };
  }

  // 2. Validate model syntax locally before any network call
  const syntaxCheck = validateOcrModelSyntax(model, provider);
  if (!syntaxCheck.valid) {
    return {
      OCR_CONFIGURED: false,
      OCR_PROVIDER_REACHABLE: false,
      OCR_MODEL_VALID: false,
      OCR_PRODUCTION_READY: false,
      status: 'INVALID_CONFIG',
      classification: 'INVALID_MODEL',
      provider,
      model,
      modelSyntaxValid: false,
      liveVerified: false,
      cached: false,
      checkedAt,
      latencyMs: null,
      errorCode: 'OCR_INVALID_MODEL_SYNTAX',
      message: syntaxCheck.reason || `Invalid OCR model "${model}"`,
    };
  }

  const cacheKey = buildCacheKey(provider, model, apiKey);
  const now = Date.now();
  const cachedEntry = readinessCache.get(cacheKey);
  const hasValidCache = Boolean(cachedEntry && cachedEntry.expiresAt > now);

  // 3. Return cached live verification when valid and not forced to refresh
  if (hasValidCache && !options.forceRefresh && cachedEntry) {
    return {
      ...cachedEntry.report,
      cached: true,
    };
  }

  // 4. Non-live mode: never report READY or OCR_PRODUCTION_READY from key presence alone
  if (!options.liveVerify) {
    return {
      OCR_CONFIGURED: true,
      OCR_PROVIDER_REACHABLE: false,
      OCR_MODEL_VALID: false,
      OCR_PRODUCTION_READY: false,
      status: 'CONFIGURED_UNVERIFIED',
      classification: 'UNVERIFIED',
      provider,
      model,
      modelSyntaxValid: true,
      liveVerified: false,
      cached: false,
      checkedAt,
      latencyMs: null,
      errorCode: 'OCR_LIVE_VERIFICATION_NOT_RUN',
      message: `OCR provider "${provider}" (${model}) is syntactically configured, but live provider/model verification has not been executed`,
    };
  }

  // 5. Execute lightweight live verification with bounded timeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`OCR readiness probe timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const probeStart = Date.now();
  const probe = options.probeFn ?? defaultGeminiProbe;

  try {
    const result = await probe({
      provider,
      model,
      apiKey: apiKey.trim(),
      timeoutMs,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - probeStart;
    const ready = Boolean(result.reachable && result.modelValid);

    const report: OcrReadinessReport = {
      OCR_CONFIGURED: true,
      OCR_PROVIDER_REACHABLE: Boolean(result.reachable),
      OCR_MODEL_VALID: Boolean(result.modelValid),
      OCR_PRODUCTION_READY: ready,
      status: ready ? 'READY' : 'INVALID_CONFIG',
      classification: ready ? 'OK' : result.reachable ? 'INVALID_MODEL' : 'UNAVAILABLE',
      provider,
      model,
      modelSyntaxValid: true,
      liveVerified: true,
      cached: false,
      checkedAt: new Date().toISOString(),
      latencyMs,
      errorCode: ready ? null : result.reachable ? 'OCR_INVALID_MODEL' : 'OCR_PROVIDER_UNAVAILABLE',
      message: ready
        ? `OCR provider "${provider}" reachable and model "${model}" verified (${latencyMs}ms)`
        : result.reachable
          ? `OCR provider "${provider}" reachable, but model "${model}" is not valid`
          : `OCR provider "${provider}" could not be reached`,
    };

    const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    readinessCache.set(cacheKey, {
      report,
      expiresAt: Date.now() + ttlMs,
    });

    return report;
  } catch (err) {
    const latencyMs = Date.now() - probeStart;
    const classified = classifyOcrProbeError(err, apiKey);
    const providerReachable =
      classified.classification === 'INVALID_MODEL' || classified.classification === 'QUOTA_ERROR';

    const report: OcrReadinessReport = {
      OCR_CONFIGURED: true,
      OCR_PROVIDER_REACHABLE: providerReachable,
      OCR_MODEL_VALID: false,
      OCR_PRODUCTION_READY: false,
      status: classified.classification === 'INVALID_MODEL' ? 'INVALID_CONFIG' : 'UNAVAILABLE',
      classification: classified.classification,
      provider,
      model,
      modelSyntaxValid: true,
      liveVerified: true,
      cached: false,
      checkedAt: new Date().toISOString(),
      latencyMs,
      errorCode: classified.errorCode,
      message: classified.message,
    };

    const ttlMs =
      classified.classification === 'QUOTA_ERROR' || classified.classification === 'UNAVAILABLE'
        ? Math.min(options.cacheTtlMs ?? TRANSIENT_ERROR_CACHE_TTL_MS, TRANSIENT_ERROR_CACHE_TTL_MS)
        : (options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);

    readinessCache.set(cacheKey, {
      report,
      expiresAt: Date.now() + ttlMs,
    });

    return report;
  } finally {
    clearTimeout(timer);
  }
}
