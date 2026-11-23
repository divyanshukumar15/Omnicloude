/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15000;

export interface HttpDispatcherConfig {
  requestTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface InspectableDispatcher {
  readonly __omnihubConfig?: HttpDispatcherConfig;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const UNDICI_GLOBAL_DISPATCHER_SYMBOL = Symbol.for('undici.globalDispatcher.1');
const NATIVE_FETCH: typeof fetch | undefined =
  typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

type UndiciAgentConstructor = new (options: {
  connectTimeout?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
  connect?: { timeout?: number };
}) => object;

let cachedAgentConstructor: UndiciAgentConstructor | null = null;
const dispatcherCache = new Map<string, InspectableDispatcher>();

/**
 * Resolves a bounded connection timeout in milliseconds.
 * Ensures connectionTimeoutMs <= requestTimeoutMs and within [50..30000].
 */
export function resolveConnectionTimeoutMs(
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  connectionTimeoutMs?: number
): number {
  const boundedRequestTimeout =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? Math.min(Math.max(50, Math.floor(requestTimeoutMs)), 30000)
      : DEFAULT_REQUEST_TIMEOUT_MS;

  if (
    connectionTimeoutMs !== undefined &&
    Number.isFinite(connectionTimeoutMs) &&
    connectionTimeoutMs > 0
  ) {
    const clamped = Math.min(Math.max(50, Math.floor(connectionTimeoutMs)), 30000);
    return Math.min(clamped, boundedRequestTimeout);
  }

  return boundedRequestTimeout;
}

/**
 * Lazily obtains Node's built-in Undici Agent constructor without making any network connection
 * and without invoking any test-mocked globalThis.fetch.
 */
async function ensureUndiciAgentConstructor(): Promise<UndiciAgentConstructor | null> {
  if (cachedAgentConstructor) {
    return cachedAgentConstructor;
  }

  const globalObj = globalThis as Record<symbol, unknown>;
  let existingDispatcher = globalObj[UNDICI_GLOBAL_DISPATCHER_SYMBOL];

  if (!existingDispatcher && NATIVE_FETCH) {
    const controller = new AbortController();
    controller.abort();
    try {
      await NATIVE_FETCH('http://127.0.0.1:1', { signal: controller.signal });
    } catch {
      // Expected immediate AbortError; side effect initializes Symbol.for('undici.globalDispatcher.1')
    }
    existingDispatcher = globalObj[UNDICI_GLOBAL_DISPATCHER_SYMBOL];
  }

  if (
    existingDispatcher &&
    typeof existingDispatcher === 'object' &&
    typeof (existingDispatcher as { constructor?: unknown }).constructor === 'function' &&
    (existingDispatcher as { constructor: { name?: string } }).constructor.name === 'Agent'
  ) {
    cachedAgentConstructor = (existingDispatcher as { constructor: UndiciAgentConstructor })
      .constructor;
  }

  return cachedAgentConstructor;
}

// Eagerly warm up Undici Agent constructor at module load time (zero network I/O)
void ensureUndiciAgentConstructor();

/**
 * Returns an Undici Agent dispatcher configured with explicit `connectTimeout`,
 * `connect.timeout`, `headersTimeout`, and `bodyTimeout` so Node's default 10000ms
 * Undici connection timeout never silently overrides the configured timeout policy.
 */
export async function getOrCreateFetchDispatcher(
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  connectionTimeoutMs?: number
): Promise<InspectableDispatcher | undefined> {
  const effectiveRequestTimeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? Math.min(Math.max(50, Math.floor(requestTimeoutMs)), 30000)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const effectiveConnectionTimeoutMs = resolveConnectionTimeoutMs(
    effectiveRequestTimeoutMs,
    connectionTimeoutMs
  );

  const cacheKey = `${effectiveConnectionTimeoutMs}:${effectiveRequestTimeoutMs}`;
  const cached = dispatcherCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const AgentCtor = await ensureUndiciAgentConstructor();
  if (!AgentCtor) {
    return undefined;
  }

  const agentInstance = new AgentCtor({
    connectTimeout: effectiveConnectionTimeoutMs,
    connect: { timeout: effectiveConnectionTimeoutMs },
    headersTimeout: effectiveRequestTimeoutMs,
    bodyTimeout: effectiveRequestTimeoutMs,
  }) as InspectableDispatcher;

  Object.defineProperty(agentInstance, '__omnihubConfig', {
    value: {
      requestTimeoutMs: effectiveRequestTimeoutMs,
      connectionTimeoutMs: effectiveConnectionTimeoutMs,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  dispatcherCache.set(cacheKey, agentInstance);
  return agentInstance;
}

/**
 * Configures Node's global Undici dispatcher to use the specified connection and request timeouts.
 */
export async function configureGlobalFetchDispatcher(
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  connectionTimeoutMs?: number
): Promise<InspectableDispatcher | undefined> {
  const dispatcher = await getOrCreateFetchDispatcher(requestTimeoutMs, connectionTimeoutMs);
  if (dispatcher) {
    const globalObj = globalThis as Record<symbol, unknown>;
    globalObj[UNDICI_GLOBAL_DISPATCHER_SYMBOL] = dispatcher;
  }
  return dispatcher;
}

/**
 * Inspects an Undici Agent dispatcher (or the current global dispatcher) to verify
 * the active `connectTimeout` and `headersTimeout` / `bodyTimeout` values.
 */
export function inspectFetchDispatcherTimeouts(
  dispatcher?: unknown
): {
  connectTimeoutMs: number | null;
  headersTimeoutMs: number | null;
  bodyTimeoutMs: number | null;
} {
  const target =
    dispatcher ??
    (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER_SYMBOL];

  if (!target || typeof target !== 'object') {
    return {
      connectTimeoutMs: null,
      headersTimeoutMs: null,
      bodyTimeoutMs: null,
    };
  }

  const inspectable = target as InspectableDispatcher;
  if (inspectable.__omnihubConfig) {
    for (const sym of Object.getOwnPropertySymbols(target)) {
      if (sym.toString() === 'Symbol(options)') {
        const opts = (target as Record<symbol, unknown>)[sym] as
          | {
              connectTimeout?: number;
              headersTimeout?: number;
              bodyTimeout?: number;
              connect?: { timeout?: number };
            }
          | undefined;
        if (opts) {
          return {
            connectTimeoutMs:
              opts.connect?.timeout ??
              opts.connectTimeout ??
              inspectable.__omnihubConfig.connectionTimeoutMs,
            headersTimeoutMs:
              opts.headersTimeout ?? inspectable.__omnihubConfig.requestTimeoutMs,
            bodyTimeoutMs:
              opts.bodyTimeout ?? inspectable.__omnihubConfig.requestTimeoutMs,
          };
        }
      }
    }
    return {
      connectTimeoutMs: inspectable.__omnihubConfig.connectionTimeoutMs,
      headersTimeoutMs: inspectable.__omnihubConfig.requestTimeoutMs,
      bodyTimeoutMs: inspectable.__omnihubConfig.requestTimeoutMs,
    };
  }

  for (const sym of Object.getOwnPropertySymbols(target)) {
    if (sym.toString() === 'Symbol(options)') {
      const opts = (target as Record<symbol, unknown>)[sym] as
        | {
            connectTimeout?: number;
            headersTimeout?: number;
            bodyTimeout?: number;
            connect?: { timeout?: number };
          }
        | undefined;
      if (opts) {
        return {
          connectTimeoutMs: opts.connect?.timeout ?? opts.connectTimeout ?? null,
          headersTimeoutMs: opts.headersTimeout ?? null,
          bodyTimeoutMs: opts.bodyTimeout ?? null,
        };
      }
    }
  }

  return {
    connectTimeoutMs: null,
    headersTimeoutMs: null,
    bodyTimeoutMs: null,
  };
}
