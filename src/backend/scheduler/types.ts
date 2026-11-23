/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type AutomationMode = 'manual' | 'scheduled' | 'continuous';

export interface SchedulerConfig {
  automationMode: AutomationMode;
  pollIntervalSeconds: number;
  maxConcurrentJobs: number;
  maxRetries: number;
  maxAttempts: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  workerId: string;
}

export interface SchedulerPollResult {
  recoveredJobIds: string[];
  claimedJobIds: string[];
  activeCount: number;
}

export interface SchedulerStatusSnapshot {
  running: boolean;
  stopping: boolean;
  automationMode: AutomationMode;
  pollIntervalSeconds: number;
  maxConcurrentJobs: number;
  maxRetries: number;
  maxAttempts: number;
  retryBackoffMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  workerId: string;
  activeJobIds: string[];
  activeCount: number;
  dbRunningCount: number;
  totalClaimedCount: number;
  totalRetriedCount: number;
  totalRecoveredCount: number;
  lastPollAt: string | null;
}

export type SchedulerRuntimeReadiness = 'READY' | 'NOT_READY' | 'FAILED' | 'MANUAL';

export type SchedulerRuntimeLifecycleStatus =
  | 'RUNNING'
  | 'STOPPED'
  | 'MANUAL'
  | 'FAILED'
  | 'NOT_READY';

export interface NextDueSourceSummary {
  sourceId: string;
  sourceName: string;
  checkIntervalMinutes: number;
  nextDueAt: string;
}

export interface SourceDiscoverySeederStatus {
  enabled: boolean;
  running: boolean;
  stopping: boolean;
  seedIntervalMs: number;
  lastSeedAt: string | null;
  nextDueSource: NextDueSourceSummary | null;
  queuedCount: number;
  duplicatePreventedCount: number;
  lastError: string | null;
}

export interface SchedulerRuntimeHealth extends SchedulerStatusSnapshot {
  status: SchedulerRuntimeLifecycleStatus;
  readiness: SchedulerRuntimeReadiness;
  initialized: boolean;
  startedAt: string | null;
  error: string | null;
  seeder: SourceDiscoverySeederStatus;
}
