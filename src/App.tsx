/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  Database,
  Layers,
  CheckCircle,
  RefreshCw,
  AlertCircle,
  Activity,
  Globe,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';

interface HealthData {
  status: string;
  readiness?: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  overall_readiness?: 'READY' | 'DEGRADED' | 'NOT_READY';
  blockers?: string[];
  production_guards?: Array<{
    code: string;
    component: 'AUTOMATION' | 'RUNNER' | 'STORAGE';
    severity: 'BLOCKER' | 'DEGRADATION';
    status: string;
    message: string;
  }>;
  uptime_seconds: number;
  environment: string;
  scheduler?: {
    status: string;
    readiness: string;
    dependency_status?: string;
    automatic_processing_disabled?: boolean;
    running: boolean;
    automationMode: string;
    workerId: string;
    activeCount: number;
    dbRunningCount: number;
    lastPollAt: string | null;
    totalClaimedCount: number;
    totalRetriedCount: number;
    totalRecoveredCount: number;
    error: string | null;
  };
  checks?: {
    database?: { status: string; readiness?: string; driver: string; latency_ms: number };
    durable_document_storage?: {
      status: string;
      readiness: string;
      storage_dir: string | null;
      configured: boolean;
      durable: boolean;
      using_temp_fallback: boolean;
      writable: boolean;
      reason: string | null;
    };
    remote_worker?: {
      mode: string;
      readiness?: string;
      configured: boolean;
      endpoint_url: string | null;
      reachable: boolean;
      healthy: boolean;
      status: string;
      execution_environment: string | null;
    };
    wordpress?: {
      status: string;
      configured: boolean;
      endpoint_url: string | null;
      reachable: boolean;
      authenticated: boolean;
      error_code: string | null;
    };
    ocr?: {
      status?: string;
      provider: string;
      model: string;
      configured: boolean;
      classification?: string;
    };
    memory?: { rss_mb: number; heap_used_mb: number };
  };
}

interface StatusData {
  architecture_phase: string;
  system_status: string;
  readiness?: 'READY' | 'DEGRADED' | 'NOT_READY';
  overall_readiness?: 'READY' | 'DEGRADED' | 'NOT_READY';
  blockers?: string[];
  jobs_summary: Record<string, number>;
  pipeline: {
    total_stages: number;
    stages: Array<{ order: number; stage: string; hasHandler: boolean; status: string }>;
    execution_mode: string;
    fake_completion_allowed: boolean;
    production_publishing_enabled: boolean;
  };
}

function getStatusTextClass(state: string | undefined | null): string {
  if (state === 'READY' || state === 'HEALTHY' || state === 'up') {
    return 'text-emerald-400';
  }
  if (state === 'DEGRADED' || state === 'NOT_CONFIGURED' || state === 'MANUAL') {
    return 'text-amber-400';
  }
  return 'text-red-400';
}

function getStatusDotClass(state: string | undefined | null): string {
  if (state === 'READY') {
    return 'bg-emerald-400';
  }
  if (state === 'DEGRADED') {
    return 'bg-amber-400';
  }
  return 'bg-red-400';
}

interface ProcessingJobRow {
  job_id: string;
  target_entity_type: string;
  target_entity_id: string;
  stage: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
}

interface OperationsData {
  sources: Array<{
    sourceId: string;
    name: string;
    jurisdiction: string;
    endpointCount: number;
    latestRun: {
      adapterStatus: string;
      httpStatus: number | null;
      recordsFound: number;
      documentsFound: number;
      completedAt: string;
    } | null;
  }>;
  jobs: {
    counts: Record<string, number>;
    recent: ProcessingJobRow[];
  };
  publishing: Array<{
    id: string;
    recruitmentId: string | null;
    externalPostId: string | null;
    permalink: string | null;
    postStatus: string | null;
    publishStatus: string;
    updatedAt: string | null;
    errorMessage: string | null;
  }>;
  auditLogs: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    stage: string | null;
    status: string;
    createdAt: string;
  }>;
}

export default function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [operations, setOperations] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [controlToken, setControlToken] = useState<string>(() => {
    try {
      return window.sessionStorage.getItem('omnihub_control_auth_token') || '';
    } catch {
      return '';
    }
  });
  const [protectedOutput, setProtectedOutput] = useState<string | null>(null);

  const handleTokenChange = (value: string) => {
    setControlToken(value);
    try {
      if (value) {
        window.sessionStorage.setItem('omnihub_control_auth_token', value);
      } else {
        window.sessionStorage.removeItem('omnihub_control_auth_token');
      }
    } catch {
      // Ignore storage access errors
    }
  };

  const buildAuthHeaders = useCallback(
    (extraHeaders: Record<string, string> = {}): Record<string, string> => {
      const headers: Record<string, string> = { ...extraHeaders };
      if (controlToken.trim()) {
        headers.Authorization = `Bearer ${controlToken.trim()}`;
      }
      return headers;
    },
    [controlToken]
  );

  const fetchOperationsData = useCallback(async () => {
    if (!controlToken.trim()) {
      setOperations(null);
      return;
    }
    try {
      const opRes = await fetch('/api/operations', {
        method: 'GET',
        headers: buildAuthHeaders(),
      });
      if (opRes.ok) {
        const opJson = await opRes.json();
        setOperations(opJson);
      } else {
        setOperations(null);
      }
    } catch {
      setOperations(null);
    }
  }, [controlToken, buildAuthHeaders]);

  const fetchSystemData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hRes, sRes] = await Promise.all([fetch('/api/health'), fetch('/api/status')]);

      const canParseHealth = hRes.ok || hRes.status === 503;
      const canParseStatus = sRes.ok || sRes.status === 503;

      if (!canParseHealth || !canParseStatus) {
        throw new Error(`Failed to fetch status: Health ${hRes.status}, Status ${sRes.status}`);
      }

      const hData = await hRes.json();
      const sData = await sRes.json();
      setHealth(hData);
      setStatus(sData);
      await fetchOperationsData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchOperationsData]);

  useEffect(() => {
    fetchSystemData();
  }, [fetchSystemData]);

  const handleTestCreateJob = async () => {
    setCreatingJob(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          targetEntityType: 'SOURCE_PORTAL',
          targetEntityId: 'IN-CENTRAL-SSC',
          initialStage: 'SOURCE_DISCOVERY',
          metadata: { portalName: 'Staff Selection Commission', manualTrigger: true },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setActionMessage(`Job queued: ${data.data.job_id} (${data.data.status})`);
        await fetchSystemData();
      } else {
        setActionMessage(
          `Creation error (${res.status}): ${data.error?.message || 'Unauthorized or invalid request'}`
        );
      }
    } catch (err) {
      setActionMessage(`Network error: ${(err as Error).message}`);
    } finally {
      setCreatingJob(false);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    setRetryingJobId(jobId);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        setActionMessage(`Retried job ${jobId} -> ${data.data.status}`);
        await fetchSystemData();
      } else {
        setActionMessage(
          `Retry error (${res.status}): ${data.error?.message || 'Unable to retry job'}`
        );
      }
    } catch (err) {
      setActionMessage(`Network error: ${(err as Error).message}`);
    } finally {
      setRetryingJobId(null);
    }
  };

  const handleFetchProtectedEndpoint = async (endpoint: '/api/adapters' | '/api/audit') => {
    setProtectedOutput(null);
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: buildAuthHeaders(),
      });
      const data = await res.json();
      setProtectedOutput(
        `GET ${endpoint} -> HTTP ${res.status}\n${JSON.stringify(data, null, 2).slice(0, 1200)}`
      );
    } catch (err) {
      setProtectedOutput(`GET ${endpoint} error: ${(err as Error).message}`);
    }
  };

  const overallReadiness =
    health?.overall_readiness ?? status?.overall_readiness ?? undefined;
  const activeBlockers = health?.blockers ?? status?.blockers ?? [];
  const schedulerDepStatus =
    health?.scheduler?.dependency_status ?? health?.scheduler?.status ?? 'UNKNOWN';
  const wpStatus = health?.checks?.wordpress?.status ?? 'NOT_CONFIGURED';
  const workerReadiness =
    health?.checks?.remote_worker?.readiness ??
    health?.checks?.remote_worker?.status ??
    'NOT_CONFIGURED';
  const storageStatus =
    health?.checks?.durable_document_storage?.status ?? 'NOT_CONFIGURED';
  const storageReadiness =
    health?.checks?.durable_document_storage?.readiness ?? storageStatus;
  const ocrStatus =
    health?.checks?.ocr?.status ??
    (health?.checks?.ocr?.configured ? 'DEGRADED' : 'NOT_CONFIGURED');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="border border-slate-800 bg-slate-900/60 rounded-lg p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full ${
                    overallReadiness ? getStatusDotClass(overallReadiness) : 'bg-slate-500'
                  }`}
                />
                <span
                  className={`text-xs uppercase tracking-wider font-bold ${
                    overallReadiness ? getStatusTextClass(overallReadiness) : 'text-slate-400'
                  }`}
                >
                  {overallReadiness ?? 'INITIALIZING'} | {health?.environment ?? 'development'}
                </span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
                OmniHub GovJobs Automation AI
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Autonomous Official Document Ingestion, Evidence Gate &amp; WordPress Operations
              </p>
            </div>
            <button
              onClick={fetchSystemData}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs rounded border border-slate-700 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh Status
            </button>
          </div>
        </div>

        {error && (
          <div className="border border-red-800/80 bg-red-950/40 rounded-lg p-4 flex items-center gap-3 text-red-300 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>Connection check failed: {error}</span>
          </div>
        )}

        {activeBlockers.length > 0 && (
          <div className="border border-amber-700/70 bg-amber-950/30 rounded-lg p-4 text-xs text-amber-200 space-y-1">
            <div className="font-semibold uppercase tracking-wider text-amber-300">
              Readiness Blockers ({activeBlockers.length})
            </div>
            {activeBlockers.map((blocker, idx) => (
              <div key={idx} className="text-amber-200/90">
                • {blocker}
              </div>
            ))}
          </div>
        )}

        {/* Core Telemetry Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
              <Database
                className={`w-4 h-4 ${
                  health?.checks?.database?.status === 'up' ? 'text-emerald-400' : 'text-red-400'
                }`}
              />
              <span>DATABASE &amp; STORAGE</span>
            </div>
            <div className="text-base font-bold text-white">
              {health?.checks?.database?.status === 'up' ? 'SQLite WAL Ready' : 'Unavailable'}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Latency: {health?.checks?.database?.latency_ms ?? 0}ms | Storage:{' '}
              <span className={getStatusTextClass(storageReadiness)}>{storageStatus}</span>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
              <Activity className={`w-4 h-4 ${getStatusTextClass(schedulerDepStatus)}`} />
              <span>SCHEDULER</span>
            </div>
            <div className={`text-base font-bold ${getStatusTextClass(schedulerDepStatus)}`}>
              {schedulerDepStatus}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Mode: {health?.scheduler?.automationMode ?? 'manual'} | State:{' '}
              {health?.scheduler?.status ?? 'UNKNOWN'}
              {health?.scheduler?.automatic_processing_disabled ? ' (Auto Disabled)' : ''}
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
              <Globe className={`w-4 h-4 ${getStatusTextClass(workerReadiness)}`} />
              <span>EXTERNAL LINKS</span>
            </div>
            <div className="text-base font-bold text-white">
              WP: <span className={getStatusTextClass(wpStatus)}>{wpStatus}</span>
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Worker:{' '}
              <span className={getStatusTextClass(workerReadiness)}>
                {workerReadiness}
              </span>{' '}
              ({health?.checks?.remote_worker?.status ?? 'REMOTE_NOT_CONFIGURED'})
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-4">
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
              <Layers className="w-4 h-4 text-purple-400" />
              <span>JOB QUEUE</span>
            </div>
            <div className="text-base font-bold text-white">
              {status
                ? `${status.jobs_summary?.PENDING ?? 0}P / ${status.jobs_summary?.RUNNING ?? 0}R`
                : 'Loading...'}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Done: {status?.jobs_summary?.COMPLETED ?? 0} | Failed:{' '}
              {status?.jobs_summary?.FAILED ?? 0}
            </div>
          </div>
        </div>

        {/* Security & Operator Authentication */}
        <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400" />
              Operator Controls &amp; Protected Telemetry
            </h2>
            <span className="text-xs text-slate-400">
              OCR:{' '}
              <span className={getStatusTextClass(ocrStatus)}>{ocrStatus}</span>
              {health?.checks?.ocr?.classification ? ` (${health.checks.ocr.classification})` : ''}
            </span>
          </div>

          <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2">
            <label htmlFor="control-bearer-token" className="text-xs text-slate-400 whitespace-nowrap">
              Control Bearer Token:
            </label>
            <input
              id="control-bearer-token"
              type="password"
              value={controlToken}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder="Paste CONTROL_APP_AUTH_TOKEN to unlock operations & retry controls"
              autoComplete="off"
              className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleTestCreateJob}
              disabled={creatingJob}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded shadow transition flex items-center gap-2"
            >
              {creatingJob ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
              Queue Source Discovery Job
            </button>

            <button
              type="button"
              onClick={fetchOperationsData}
              className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition"
            >
              Load Operations Data
            </button>

            <button
              type="button"
              onClick={() => handleFetchProtectedEndpoint('/api/adapters')}
              className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition"
            >
              GET /api/adapters
            </button>

            <button
              type="button"
              onClick={() => handleFetchProtectedEndpoint('/api/audit')}
              className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition"
            >
              GET /api/audit
            </button>
          </div>

          {actionMessage && (
            <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs text-emerald-400">
              {actionMessage}
            </div>
          )}

          {protectedOutput && (
            <pre className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs text-slate-300 overflow-x-auto max-h-48">
              {protectedOutput}
            </pre>
          )}
        </div>

        {/* Authenticated Operational Tables */}
        {operations && (
          <div className="space-y-6">
            {/* Processing Jobs with Retry Action */}
            <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
              <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300 mb-3">
                Recent Processing Jobs ({operations.jobs.recent.length})
              </h2>
              {operations.jobs.recent.length === 0 ? (
                <p className="text-xs text-slate-500">No processing jobs recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {operations.jobs.recent.slice(0, 10).map((job) => (
                    <div
                      key={job.job_id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-slate-950/60 border border-slate-800/80 rounded text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="text-slate-200 font-semibold">
                          {job.target_entity_id} — {job.stage}
                        </div>
                        <div className="text-slate-400">
                          Status: {job.status} | Attempts: {job.attempts}/{job.max_attempts}
                          {job.error_code ? ` | Error: ${job.error_code}` : ''}
                        </div>
                      </div>
                      {(job.status === 'FAILED' || job.status === 'PAUSED') && (
                        <button
                          type="button"
                          disabled={retryingJobId === job.job_id}
                          onClick={() => handleRetryJob(job.job_id)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded text-xs font-semibold"
                        >
                          <RotateCcw className="w-3 h-3" />
                          {retryingJobId === job.job_id ? 'Retrying...' : 'Retry Job'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Official Sources & Discovery Status */}
            <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
              <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300 mb-3">
                Official Government Sources ({operations.sources.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {operations.sources.map((src) => (
                  <div
                    key={src.sourceId}
                    className="p-3 bg-slate-950/60 border border-slate-800/80 rounded text-xs"
                  >
                    <div className="flex items-center justify-between text-slate-200 font-semibold">
                      <span>{src.sourceId}</span>
                      <span className="text-slate-400">{src.endpointCount} endpoints</span>
                    </div>
                    <div className="text-slate-400 mt-1">
                      Latest:{' '}
                      {src.latestRun
                        ? `${src.latestRun.adapterStatus} (${src.latestRun.recordsFound} notices)`
                        : 'No runs recorded'}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* WordPress Publishing & Audit Trail */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
                <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300 mb-3">
                  WordPress Publishing ({operations.publishing.length})
                </h2>
                {operations.publishing.length === 0 ? (
                  <p className="text-xs text-slate-500">No publishing records yet.</p>
                ) : (
                  <div className="space-y-2">
                    {operations.publishing.slice(0, 6).map((pub) => (
                      <div
                        key={pub.id}
                        className="p-2.5 bg-slate-950/60 border border-slate-800/80 rounded text-xs"
                      >
                        <div className="text-slate-200 font-semibold">
                          {pub.publishStatus} {pub.externalPostId ? `(#${pub.externalPostId})` : ''}
                        </div>
                        {pub.permalink ? (
                          <a
                            href={pub.permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:underline inline-flex items-center gap-1 mt-1"
                          >
                            View Post <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <div className="text-slate-500 mt-1">
                            {pub.errorMessage || 'Awaiting WordPress permalink'}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
                <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300 mb-3">
                  Recent Audit Events ({operations.auditLogs.length})
                </h2>
                {operations.auditLogs.length === 0 ? (
                  <p className="text-xs text-slate-500">No audit logs recorded.</p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {operations.auditLogs.slice(0, 10).map((log) => (
                      <div
                        key={log.id}
                        className="p-2 bg-slate-950/60 border border-slate-800/80 rounded text-xs flex items-center justify-between gap-2"
                      >
                        <span className="text-slate-300 truncate">{log.action}</span>
                        <span className="text-slate-500 whitespace-nowrap">{log.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Pipeline Stage Contract Definitions */}
        <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-300">
              Pipeline Stages &amp; Contract Boundaries
            </h2>
            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
              No Fake Completion Permitted
            </span>
          </div>

          <div className="space-y-2">
            {status?.pipeline?.stages.map((st) => (
              <div
                key={st.stage}
                className="flex items-center justify-between py-2 px-3 bg-slate-950/60 rounded border border-slate-800/80 text-xs"
              >
                <div className="flex items-center gap-3">
                  <span className="text-slate-500 font-mono w-5">{st.order}.</span>
                  <span className="text-slate-200 font-semibold">{st.stage}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">
                    {st.stage === 'WORDPRESS_PUBLISH' ? 'GATE_LOCKED' : 'CONTRACT_DEFINED'}
                  </span>
                  <CheckCircle className="w-3.5 h-3.5 text-slate-500" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
