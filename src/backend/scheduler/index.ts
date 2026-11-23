/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../config/logger.ts';
import { isDatabaseInitialized } from '../database/index.ts';
import { getJobService } from '../jobs/index.ts';
import {
  SchedulerService,
  resolveSchedulerConfig,
  type SchedulerServiceDependencies,
} from './scheduler-service.ts';
import {
  SourceDiscoverySeeder,
  type SourceDiscoverySeederConfig,
  type SourceDiscoverySeederDependencies,
} from './source-discovery-seeder.ts';
import type {
  SchedulerConfig,
  SchedulerRuntimeHealth,
  SchedulerRuntimeLifecycleStatus,
  SchedulerRuntimeReadiness,
  SourceDiscoverySeederStatus,
} from './types.ts';

let defaultScheduler: SchedulerService | null = null;
let defaultSeeder: SourceDiscoverySeeder | null = null;
let runtimeInitialized = false;
let runtimeFailed = false;
let runtimeError: string | null = null;
let runtimeStartedAt: string | null = null;
let runtimeEnvSnapshot: Record<string, unknown> | undefined;

export interface SchedulerRuntimeInitResult {
  started: boolean;
  scheduler: SchedulerService | null;
  seeder: SourceDiscoverySeeder | null;
  health: SchedulerRuntimeHealth;
  error: string | null;
}

export interface SchedulerRuntimeDependencies extends SchedulerServiceDependencies {
  seederConfig?: Partial<SourceDiscoverySeederConfig>;
  seederDeps?: Omit<SourceDiscoverySeederDependencies, 'config' | 'jobService' | 'auditService'>;
}

export function getSchedulerService(deps?: SchedulerServiceDependencies): SchedulerService {
  if (!defaultScheduler || deps) {
    defaultScheduler = new SchedulerService(deps);
  }
  return defaultScheduler;
}

export function getSourceDiscoverySeeder(
  deps?: SourceDiscoverySeederDependencies
): SourceDiscoverySeeder {
  if (!defaultSeeder || deps) {
    defaultSeeder = new SourceDiscoverySeeder(deps);
  }
  return defaultSeeder;
}

export function startScheduler(deps?: SchedulerRuntimeDependencies): SchedulerService {
  try {
    if (defaultScheduler && !deps && defaultScheduler.getStatus().running) {
      return defaultScheduler;
    }

    const scheduler = getSchedulerService(deps);
    scheduler.start();
    runtimeFailed = false;
    runtimeError = null;
    runtimeInitialized = true;
    runtimeStartedAt = new Date().toISOString();
    runtimeEnvSnapshot = deps?.rawEnv;
    return scheduler;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    runtimeFailed = true;
    runtimeInitialized = false;
    runtimeError = errorMessage;
    runtimeStartedAt = null;
    logger.error('Failed to start scheduler service', err);
    throw err;
  }
}

/**
 * Safely initializes the singleton scheduler and automatic source discovery seeder
 * according to AUTOMATION_MODE:
 * - Requires database initialization to be completed first.
 * - Starts SchedulerService + SourceDiscoverySeeder automatically for `scheduled` and `continuous`.
 * - Does NOT start SchedulerService or SourceDiscoverySeeder for `manual`.
 * - On failure, logs the actual error and exposes NOT_READY/FAILED status without crashing the caller.
 */
export function initializeSchedulerRuntime(
  deps?: SchedulerRuntimeDependencies
): SchedulerRuntimeInitResult {
  const effectiveEnv = deps?.rawEnv ?? process.env;
  runtimeEnvSnapshot = deps?.rawEnv;

  try {
    if (!isDatabaseInitialized()) {
      throw new Error('Database must be initialized before starting scheduler runtime');
    }

    const config = resolveSchedulerConfig(effectiveEnv, deps?.config);

    if (config.automationMode === 'manual') {
      if (defaultSeeder) {
        void defaultSeeder.stop().catch(() => undefined);
        defaultSeeder = null;
      }
      runtimeFailed = false;
      runtimeError = null;
      runtimeInitialized = true;
      runtimeStartedAt = null;
      logger.info('Scheduler and source discovery seeder auto-start skipped because AUTOMATION_MODE=manual', {
        automationMode: config.automationMode,
      });
      return {
        started: false,
        scheduler: null,
        seeder: null,
        health: getSchedulerRuntimeHealth(effectiveEnv),
        error: null,
      };
    }

    // Never create a second running scheduler or seeder instance
    if (
      defaultScheduler &&
      defaultScheduler.getStatus().running &&
      !deps?.config &&
      !deps?.jobService &&
      !deps?.pipelineEngine &&
      !deps?.seederConfig &&
      !deps?.seederDeps
    ) {
      if (defaultSeeder && !defaultSeeder.getStatus().running) {
        defaultSeeder.start();
      }
      logger.info('Reusing existing running scheduler singleton', {
        workerId: defaultScheduler.getStatus().workerId,
        automationMode: defaultScheduler.getStatus().automationMode,
      });
      return {
        started: true,
        scheduler: defaultScheduler,
        seeder: defaultSeeder,
        health: getSchedulerRuntimeHealth(effectiveEnv),
        error: null,
      };
    }

    const scheduler = startScheduler(deps);

    // Stop any superseded seeder instance before creating a fresh one for explicit deps
    if (defaultSeeder) {
      void defaultSeeder.stop().catch(() => undefined);
      defaultSeeder = null;
    }

    const customEngineMissingDiscovery =
      Boolean(deps?.pipelineEngine) &&
      !deps?.pipelineEngine?.getHandler('SOURCE_DISCOVERY') &&
      deps?.seederConfig?.enabled !== true;

    const defaultSeedIntervalMs = Math.min(config.pollIntervalSeconds * 1000, 60_000);
    const seeder = getSourceDiscoverySeeder({
      ...deps?.seederDeps,
      jobService: deps?.jobService,
      auditService: deps?.auditService,
      config: {
        enabled: !customEngineMissingDiscovery,
        seedIntervalMs: defaultSeedIntervalMs,
        maxAttempts: config.maxAttempts,
        ...deps?.seederConfig,
      },
      onJobsQueued: (queuedCount) => {
        deps?.seederDeps?.onJobsQueued?.(queuedCount);
        if (queuedCount > 0 && defaultScheduler && defaultScheduler.getStatus().running) {
          void defaultScheduler.pollOnce();
        }
      },
    });
    if (!customEngineMissingDiscovery) {
      seeder.start();
    }

    return {
      started: true,
      scheduler,
      seeder,
      health: getSchedulerRuntimeHealth(effectiveEnv),
      error: null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    runtimeFailed = true;
    runtimeInitialized = false;
    runtimeError = errorMessage;
    runtimeStartedAt = null;

    if (defaultSeeder) {
      void defaultSeeder.stop().catch(() => undefined);
      defaultSeeder = null;
    }

    if (defaultScheduler) {
      void defaultScheduler.stop(false).catch(() => undefined);
      defaultScheduler = null;
    }

    logger.error('Scheduler runtime initialization failed; exposing NOT_READY/FAILED', err);

    return {
      started: false,
      scheduler: null,
      seeder: null,
      health: getSchedulerRuntimeHealth(effectiveEnv),
      error: errorMessage,
    };
  }
}

export async function stopSourceDiscoverySeeder(): Promise<void> {
  if (defaultSeeder) {
    await defaultSeeder.stop();
    defaultSeeder = null;
  }
}

export async function stopScheduler(waitForInFlight = true): Promise<void> {
  // Always stop automatic job seeding FIRST so no new jobs are created during shutdown
  await stopSourceDiscoverySeeder();

  if (defaultScheduler) {
    await defaultScheduler.stop(waitForInFlight);
    defaultScheduler = null;
  }
  runtimeInitialized = false;
  runtimeStartedAt = null;
}

export function resetSchedulerRuntimeState(): void {
  if (defaultSeeder) {
    void defaultSeeder.stop().catch(() => undefined);
    defaultSeeder = null;
  }
  runtimeInitialized = false;
  runtimeFailed = false;
  runtimeError = null;
  runtimeStartedAt = null;
  runtimeEnvSnapshot = undefined;
}

function readDbRunningCountSafely(): number {
  if (!isDatabaseInitialized()) {
    return 0;
  }
  try {
    return getJobService().countRunningJobs();
  } catch {
    return 0;
  }
}

function resolveSafeConfigOrFallback(rawEnv: Record<string, unknown>): {
  config: SchedulerConfig | null;
  configError: string | null;
} {
  try {
    return {
      config: resolveSchedulerConfig(rawEnv),
      configError: null,
    };
  } catch (err) {
    return {
      config: null,
      configError: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildInactiveSeederStatus(enabled: boolean): SourceDiscoverySeederStatus {
  const probe = new SourceDiscoverySeeder({ config: { enabled } });
  return probe.getStatus();
}

/**
 * Exposes live, non-hardcoded scheduler runtime health and counters,
 * including truthful automatic source discovery seeder status.
 */
export function getSchedulerRuntimeHealth(
  rawEnv: Record<string, unknown> = runtimeEnvSnapshot ?? process.env
): SchedulerRuntimeHealth {
  const dbRunningCount = readDbRunningCountSafely();

  if (defaultScheduler) {
    const snap = defaultScheduler.getStatus();
    const seederStatus = defaultSeeder
      ? defaultSeeder.getStatus()
      : buildInactiveSeederStatus(snap.automationMode !== 'manual');
    let status: SchedulerRuntimeLifecycleStatus;
    let readiness: SchedulerRuntimeReadiness;

    if (runtimeFailed) {
      status = 'FAILED';
      readiness = 'NOT_READY';
    } else if (snap.running) {
      status = 'RUNNING';
      readiness = 'READY';
    } else if (snap.automationMode === 'manual') {
      status = 'MANUAL';
      readiness = 'MANUAL';
    } else {
      status = 'STOPPED';
      readiness = 'NOT_READY';
    }

    return {
      ...snap,
      dbRunningCount,
      status,
      readiness,
      initialized: runtimeInitialized,
      startedAt: runtimeStartedAt,
      error: runtimeError,
      seeder: seederStatus,
    };
  }

  const { config, configError } = resolveSafeConfigOrFallback(rawEnv);
  const automationMode = config?.automationMode ?? 'manual';
  const effectiveError = runtimeError ?? configError;
  const hasFailure = runtimeFailed || configError !== null;
  const seederStatus = defaultSeeder
    ? defaultSeeder.getStatus()
    : buildInactiveSeederStatus(false);

  let status: SchedulerRuntimeLifecycleStatus;
  let readiness: SchedulerRuntimeReadiness;
  if (hasFailure) {
    status = 'FAILED';
    readiness = 'NOT_READY';
  } else if (automationMode === 'manual') {
    status = 'MANUAL';
    readiness = 'MANUAL';
  } else {
    status = 'NOT_READY';
    readiness = 'NOT_READY';
  }

  return {
    running: false,
    stopping: false,
    automationMode,
    pollIntervalSeconds: config?.pollIntervalSeconds ?? 0,
    maxConcurrentJobs: config?.maxConcurrentJobs ?? 0,
    maxRetries: config?.maxRetries ?? 0,
    maxAttempts: config?.maxAttempts ?? 0,
    retryBackoffMs: config?.retryBackoffMs ?? 0,
    leaseDurationMs: config?.leaseDurationMs ?? 0,
    heartbeatIntervalMs: config?.heartbeatIntervalMs ?? 0,
    workerId: 'uninitialized',
    activeJobIds: [],
    activeCount: 0,
    dbRunningCount,
    totalClaimedCount: 0,
    totalRetriedCount: 0,
    totalRecoveredCount: 0,
    lastPollAt: null,
    status,
    readiness,
    initialized: runtimeInitialized,
    startedAt: null,
    error: effectiveError,
    seeder: seederStatus,
  };
}

export { SchedulerService, resolveSchedulerConfig, type SchedulerServiceDependencies };
export {
  SourceDiscoverySeeder,
  type SourceDiscoverySeederConfig,
  type SourceDiscoverySeederDependencies,
  type SourceDiscoverySeedDecision,
  type SourceDiscoverySeedOutcome,
  type SourceDiscoverySeedPassResult,
} from './source-discovery-seeder.ts';
export * from './retry-policy.ts';
export * from './types.ts';
