/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type {
  AcquisitionExecutionOrigin,
  ExecutionEnvironmentKind,
  RemoteExecutionState,
  RunnerKind,
  RunnerMode,
} from './acquisition-runner.ts';

/**
 * Canonical truthful verification status enum (BUG 7).
 * Never converts FAIL -> PASS, INCONCLUSIVE -> PASS, NOT_CONFIGURED -> PASS, or NOT_RUN -> PASS.
 */
export type TruthfulVerificationStatus =
  | 'PASS'
  | 'FAIL'
  | 'INCONCLUSIVE'
  | 'NOT_CONFIGURED'
  | 'NOT_RUN';

export type VerificationRunnerKind = 'LOCAL' | 'REMOTE' | 'MOCK';

export type VerificationCheckType =
  | 'LIVE_DISCOVERY'
  | 'REMOTE_PRODUCTION'
  | 'HEALTH_PROBE'
  | 'PDF_VALIDATION';

export interface VerificationWorkerIdentitySummary {
  workerId: string | null;
  remoteWorkerId?: string | null;
  workerVersion: string | null;
  executionEnvironment: ExecutionEnvironmentKind | string | null;
}

export interface TruthfulVerificationEntry {
  source: string;
  sourceId: string;
  adapter: string;
  runner: VerificationRunnerKind;
  runnerMode?: RunnerMode;
  actualRunner?: RunnerKind | null;
  executionOrigin?: AcquisitionExecutionOrigin | string | null;
  executionEnvironment?: ExecutionEnvironmentKind | string | null;
  remoteStatus?: RemoteExecutionState | string | null;
  workerIdentity?: VerificationWorkerIdentitySummary | null;
  checkType: VerificationCheckType;
  startedAt: string;
  completedAt: string;
  executionId: string;
  status: TruthfulVerificationStatus;
  errorCategory: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  evidence: Record<string, unknown>;
}

export interface TruthfulVerificationCounts {
  PASS: number;
  FAIL: number;
  INCONCLUSIVE: number;
  NOT_CONFIGURED: number;
  NOT_RUN: number;
}

export interface TruthfulVerificationReport {
  executionId: string;
  artifactType: 'CURRENT_RUN' | 'HISTORICAL_ARCHIVE';
  isCurrentRun: boolean;
  mode: 'LIVE' | 'REAL_REMOTE_PRODUCTION';
  runnerMode?: RunnerMode;
  actualRunner?: RunnerKind | null;
  executionOrigin?: AcquisitionExecutionOrigin | string | null;
  executionEnvironment?: ExecutionEnvironmentKind | string | null;
  remoteStatus?: RemoteExecutionState | string | null;
  workerIdentity?: VerificationWorkerIdentitySummary | null;
  startedAt: string;
  completedAt: string;
  REAL_REMOTE_PRODUCTION: 'PROVEN' | 'NOT_PROVEN';
  counts: TruthfulVerificationCounts;
  entries: TruthfulVerificationEntry[];
}

export const OFFICIAL_SOURCE_LABELS: Record<string, string> = {
  'IN-CENTRAL-SSC': 'SSC',
  'IN-CENTRAL-UPSC': 'UPSC',
  'IN-CENTRAL-RRB': 'RRB',
  'IN-BIHAR-BPSC': 'BPSC',
  'IN-BIHAR-BSSC': 'BSSC',
  'IN-UP-UPPSC': 'UPPSC',
  'IN-UP-UPSSSC': 'UPSSSC',
};

/**
 * Strictly classifies the runner that executed a verification check.
 * Guarantees MOCK is never labeled LIVE/REMOTE and LOCAL is never labeled REMOTE.
 */
export function normalizeVerificationRunner(params: {
  executionOrigin?: AcquisitionExecutionOrigin | string | null;
  actualRunner?: RunnerKind | string | null;
  isMock?: boolean;
}): VerificationRunnerKind {
  if (
    params.isMock ||
    params.executionOrigin === 'MOCK_REMOTE' ||
    params.executionOrigin === 'FIXTURE'
  ) {
    return 'MOCK';
  }
  if (
    params.actualRunner === 'REMOTE' ||
    params.executionOrigin === 'REAL_LIVE_REMOTE' ||
    params.executionOrigin === 'REAL_REMOTE_LOCAL_WORKER' ||
    params.executionOrigin === 'REAL_REMOTE_PRODUCTION'
  ) {
    return 'REMOTE';
  }
  return 'LOCAL';
}

/**
 * Normalizes raw verification outcomes into canonical TruthfulVerificationStatus without
 * ever upgrading FAIL, INCONCLUSIVE, NOT_CONFIGURED, or NOT_RUN into PASS.
 */
export function normalizeTruthfulStatus(raw: string | null | undefined): TruthfulVerificationStatus {
  const upper = (raw || '').trim().toUpperCase();
  if (upper === 'PASS') return 'PASS';
  if (upper === 'FAIL') return 'FAIL';
  if (upper === 'INCONCLUSIVE') return 'INCONCLUSIVE';
  if (upper === 'NOT_CONFIGURED' || upper === 'REMOTE_NOT_CONFIGURED') return 'NOT_CONFIGURED';
  return 'NOT_RUN';
}

/**
 * Returns true if a parsed JSON verification report is a historical archive
 * and MUST NOT be mixed into current verification status.
 */
export function isHistoricalArchiveReport(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (obj.artifactType === 'HISTORICAL_ARCHIVE') return true;
  if (obj.isCurrentRun === false) return true;
  return false;
}

export interface CurrentProductionProofEvaluation {
  isCurrentRun: boolean;
  usableAsCurrentProof: boolean;
  realRemoteProductionProven: boolean;
  reason: string;
}

/**
 * Evaluates whether a parsed verification report can count as current REAL_REMOTE_PRODUCTION proof.
 * Strictly enforces:
 * - Historical archive artifacts NEVER count as current proof (even if they contain PASS values).
 * - LOCAL PASS or REAL_REMOTE_LOCAL_WORKER PASS NEVER counts as REAL_REMOTE_PRODUCTION.
 * - MOCK entries NEVER count as REAL_REMOTE_PRODUCTION.
 * - NOT_CONFIGURED / NOT_RUN / FAIL / INCONCLUSIVE NEVER count as PASS.
 */
export function evaluateCurrentProductionProof(raw: unknown): CurrentProductionProofEvaluation {
  if (!raw || typeof raw !== 'object') {
    return {
      isCurrentRun: false,
      usableAsCurrentProof: false,
      realRemoteProductionProven: false,
      reason: 'INVALID_OR_EMPTY_VERIFICATION_REPORT',
    };
  }

  const obj = raw as Record<string, unknown>;
  if (
    isHistoricalArchiveReport(obj) ||
    obj.artifactType !== 'CURRENT_RUN' ||
    obj.isCurrentRun !== true
  ) {
    return {
      isCurrentRun: false,
      usableAsCurrentProof: false,
      realRemoteProductionProven: false,
      reason: 'HISTORICAL_ARCHIVE_CANNOT_BE_USED_AS_CURRENT_PROOF',
    };
  }

  const nestedTruthful =
    obj.truthfulVerification && typeof obj.truthfulVerification === 'object'
      ? (obj.truthfulVerification as Record<string, unknown>)
      : obj;

  const entries = Array.isArray(nestedTruthful.entries)
    ? (nestedTruthful.entries as TruthfulVerificationEntry[])
    : [];

  const hasAnyMock = entries.some(
    (e) =>
      e.runner === 'MOCK' ||
      e.executionOrigin === 'MOCK_REMOTE' ||
      e.executionOrigin === 'FIXTURE'
  );
  if (hasAnyMock) {
    return {
      isCurrentRun: true,
      usableAsCurrentProof: true,
      realRemoteProductionProven: false,
      reason: 'MOCK_ENTRIES_CANNOT_PROVE_PRODUCTION',
    };
  }

  const hasGenuineRemoteProductionPass = entries.some(
    (e) =>
      e.status === 'PASS' &&
      e.runner === 'REMOTE' &&
      e.actualRunner !== 'LOCAL' &&
      (e.executionOrigin === 'REAL_REMOTE_PRODUCTION' ||
        e.evidence?.executionOrigin === 'REAL_REMOTE_PRODUCTION') &&
      e.executionEnvironment !== 'LOCAL' &&
      e.executionEnvironment !== 'LOCAL_WORKER'
  );

  const reportClaimsProven =
    obj.REAL_REMOTE_PRODUCTION === 'PROVEN' &&
    nestedTruthful.REAL_REMOTE_PRODUCTION === 'PROVEN';

  if (reportClaimsProven && hasGenuineRemoteProductionPass) {
    return {
      isCurrentRun: true,
      usableAsCurrentProof: true,
      realRemoteProductionProven: true,
      reason: 'CURRENT_RUN_REMOTE_PRODUCTION_VERIFIED',
    };
  }

  return {
    isCurrentRun: true,
    usableAsCurrentProof: true,
    realRemoteProductionProven: false,
    reason:
      obj.remoteStatus === 'REMOTE_NOT_CONFIGURED' ||
      obj.failureClassification === 'REMOTE_NOT_CONFIGURED'
        ? 'REMOTE_NOT_CONFIGURED'
        : 'NO_GENUINE_REMOTE_PRODUCTION_PASS_IN_CURRENT_RUN',
  };
}

export function createVerificationExecutionId(prefix = 'verify'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function summarizeTruthfulEntries(
  entries: TruthfulVerificationEntry[]
): TruthfulVerificationCounts {
  const counts: TruthfulVerificationCounts = {
    PASS: 0,
    FAIL: 0,
    INCONCLUSIVE: 0,
    NOT_CONFIGURED: 0,
    NOT_RUN: 0,
  };
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

export function buildTruthfulVerificationReport(params: {
  executionId?: string;
  mode: 'LIVE' | 'REAL_REMOTE_PRODUCTION';
  runnerMode?: RunnerMode;
  actualRunner?: RunnerKind | null;
  executionOrigin?: AcquisitionExecutionOrigin | string | null;
  executionEnvironment?: ExecutionEnvironmentKind | string | null;
  remoteStatus?: RemoteExecutionState | string | null;
  workerIdentity?: VerificationWorkerIdentitySummary | null;
  startedAt: string;
  completedAt: string;
  realRemoteProduction: 'PROVEN' | 'NOT_PROVEN';
  entries: TruthfulVerificationEntry[];
}): TruthfulVerificationReport {
  const executionId = params.executionId || createVerificationExecutionId(params.mode.toLowerCase());
  // Enforce strict invariants:
  // 1. MOCK runner entries can NEVER prove REAL_REMOTE_PRODUCTION.
  // 2. LOCAL PASS or LOCAL_WORKER PASS can NEVER prove REAL_REMOTE_PRODUCTION.
  // 3. NOT_CONFIGURED / NOT_RUN / FAIL / INCONCLUSIVE can NEVER prove REAL_REMOTE_PRODUCTION.
  const hasAnyMock = params.entries.some(
    (e) =>
      e.runner === 'MOCK' ||
      e.executionOrigin === 'MOCK_REMOTE' ||
      e.executionOrigin === 'FIXTURE'
  );
  const hasGenuineRemoteProductionPass = params.entries.some(
    (e) =>
      e.status === 'PASS' &&
      e.runner === 'REMOTE' &&
      e.actualRunner !== 'LOCAL' &&
      (e.executionOrigin === 'REAL_REMOTE_PRODUCTION' ||
        e.evidence?.executionOrigin === 'REAL_REMOTE_PRODUCTION') &&
      e.executionEnvironment !== 'LOCAL' &&
      e.executionEnvironment !== 'LOCAL_WORKER'
  );
  const realRemoteProduction: 'PROVEN' | 'NOT_PROVEN' =
    !hasAnyMock && hasGenuineRemoteProductionPass && params.realRemoteProduction === 'PROVEN'
      ? 'PROVEN'
      : 'NOT_PROVEN';

  return {
    executionId,
    artifactType: 'CURRENT_RUN',
    isCurrentRun: true,
    mode: params.mode,
    ...(params.runnerMode !== undefined ? { runnerMode: params.runnerMode } : {}),
    ...(params.actualRunner !== undefined ? { actualRunner: params.actualRunner } : {}),
    ...(params.executionOrigin !== undefined ? { executionOrigin: params.executionOrigin } : {}),
    ...(params.executionEnvironment !== undefined
      ? { executionEnvironment: params.executionEnvironment }
      : {}),
    ...(params.remoteStatus !== undefined ? { remoteStatus: params.remoteStatus } : {}),
    ...(params.workerIdentity !== undefined ? { workerIdentity: params.workerIdentity } : {}),
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    REAL_REMOTE_PRODUCTION: realRemoteProduction,
    counts: summarizeTruthfulEntries(params.entries),
    entries: params.entries,
  };
}
