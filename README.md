# OmniHub GovJobs Automation AI

Autonomous official Indian government recruitment discovery, document provenance, durable content-addressed storage, multimodal OCR, evidence-verified structured extraction, duplicate/corrigendum detection, publishing gate enforcement, and WordPress REST API publishing.

---

## Architecture Overview

- **Central Control Plane & Scheduler (`server.ts`, `src/backend/runtime/server-runtime.ts`)**
  - Node.js 22+ + Express REST API + SQLite WAL persistence (`./data/govjobs.db` by default, schema v5).
  - Automatic `SchedulerService` lifecycle (`AUTOMATION_MODE=scheduled|continuous|manual`) with automatic source bootstrap, `SourceDiscoverySeeder`, atomic lease-based job claiming (`processing_jobs`), exponential retry backoff with jitter, heartbeat lease renewal, stale-job recovery, parent/child reconciliation, and `SIGINT`/`SIGTERM` graceful drain.
- **Canonical 10-Stage Contract-Gated Pipeline (`src/backend/pipeline/`)**
  `SOURCE_DISCOVERY` → `DOCUMENT_DISCOVERY` → `DOCUMENT_DOWNLOAD` → `DOCUMENT_VALIDATION` → `TEXT_EXTRACTION` (with scanned-page OCR) → `STRUCTURED_EXTRACTION` → `EVIDENCE_VALIDATION` → `DUPLICATE_CHECK` → `PUBLISHING_GATE` → `WORDPRESS_PUBLISH`
  - Covers 7 official central & state portals: **SSC**, **UPSC**, **RRB**, **BPSC**, **BSSC**, **UPPSC**, **UPSSSC**.
- **Standalone Official Acquisition Worker (`src/worker/server.ts`, `worker/Dockerfile.production`)**
  - Deployed externally over HTTPS for government portals requiring alternate/India egress.
  - Exposes `GET /health`, `GET /ready`, `GET /capabilities`, and authenticated `POST /acquire` (constant-time Bearer & HMAC-SHA256).

---

## Production Deployment Procedure

### 1. Environment Setup
Copy `.env.example` to `.env` (never commit `.env` or real secrets):

```bash
cp .env.example .env
```

Install dependencies reproducibly from `package-lock.json`:

```bash
npm ci --legacy-peer-deps
```

Required production environment variables:
- `NODE_ENV=production`
- `CONTROL_APP_AUTH_TOKEN`: Strong random secret for `/api/*` admin/write routes.
- `CONTROL_APP_READONLY_TOKEN`: Optional read-only Bearer token.
- `CORS_ALLOWED_ORIGINS`: Comma-separated allowed frontend origins.
- `DATABASE_PATH`: Persistent SQLite database path (e.g., `/var/lib/omnihub/govjobs.db`).
- `DOCUMENT_STORAGE_DIR`: Persistent durable directory for official PDF artifacts (never `/tmp` in production).
- `AUTOMATION_MODE`: `manual` (safe default), `scheduled`, or `continuous`.
- `RUNNER_MODE`: `REMOTE` (recommended for production), `AUTO`, or `LOCAL`.
- `OFFICIAL_ACQUISITION_WORKER_URL`: External `https://` URL of the deployed worker.
- `OFFICIAL_ACQUISITION_WORKER_TOKEN`: Shared secret matching the worker container.
- `GEMINI_API_KEY`, `OCR_PROVIDER=gemini`, `OCR_MODEL=gemini-2.5-flash`, `OCR_MAX_CONCURRENCY=3`: Scanned/Hindi PDF OCR.
- `OMNIHUB_WP_URL` (`https://` required in production), `OMNIHUB_WP_USERNAME`, `OMNIHUB_WP_APP_PASSWORD`, `OMNIHUB_WP_DEFAULT_STATUS` (`draft` or `publish`).

### 2. Database Initialization & Source Bootstrap
Database initialization and official source bootstrap run automatically on startup (before the scheduler starts):
- Executes `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA quick_check`.
- Applies idempotent SQLite migrations up to schema v5 (including duplicate-safe reconciliation and unique partial indexes on `source_documents(source_id, canonical_url)`, `documents(sha256_hash)`, `recruitments(canonical_identity_key)`, and `publishing_records(platform, external_identity_key)`).
- Automatically seeds all 7 official sources (`IN-CENTRAL-SSC`, `IN-CENTRAL-UPSC`, `IN-CENTRAL-RRB`, `IN-BIHAR-BPSC`, `IN-BIHAR-BSSC`, `IN-UP-UPPSC`, `IN-UP-UPSSSC`) idempotently without overwriting operator customizations.

### 3. Durable Document Storage Configuration
Set `DOCUMENT_STORAGE_DIR` to a mounted persistent volume (e.g., `/var/lib/omnihub/documents`).
- Artifacts are stored content-addressed by SHA-256 with atomic write + checksum verification.
- When `NODE_ENV=production`, missing or temporary (`/tmp`) storage directories report `NOT_READY` and block production readiness.

### 4. OCR Configuration
Configure `GEMINI_API_KEY`, `OCR_PROVIDER=gemini`, `OCR_MODEL=gemini-2.5-flash`, and `OCR_MAX_CONCURRENCY=3`.
- Readiness distinguishes `OCR_CONFIGURED`, `OCR_PROVIDER_REACHABLE`, `OCR_MODEL_VALID`, and `OCR_PRODUCTION_READY`.
- Scanned/Hindi pages are cached by `(checksum, page, provider, model)` in SQLite `ocr_results`.

### 5. Standalone Acquisition Worker — Docker Build & Container Startup
Build the canonical production worker image from the repository root using `worker/Dockerfile.production`:

```bash
docker build -f worker/Dockerfile.production -t omnihub-acquisition-worker:latest .
```

Start the worker container (non-root `node` user, port `8080`, graceful `SIGTERM`/`SIGINT` drain):

```bash
docker run -d --name omnihub-worker \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e WORKER_EXECUTION_ENVIRONMENT=PRODUCTION_REMOTE \
  -e OFFICIAL_ACQUISITION_WORKER_TOKEN="<strong-random-token>" \
  omnihub-acquisition-worker:latest
```

Verify worker container endpoints before placing behind HTTPS/TLS termination:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/ready
curl -fsS http://127.0.0.1:8080/capabilities
```

Or run the automated container smoke test:

```bash
npm run worker:smoke:container
```

### 6. WordPress Configuration & Live Verification
Set `OMNIHUB_WP_URL` (`https://...`), `OMNIHUB_WP_USERNAME`, `OMNIHUB_WP_APP_PASSWORD`, and `OMNIHUB_WP_DEFAULT_STATUS`.
- Every publish passes the 15-check fail-closed `PublishingGate`, acquires a per-identity concurrency lock, verifies remote read-back (`GET /wp-json/wp/v2/posts/:id`), and records a unique `(platform, external_identity_key)` entry in `publishing_records`.

### 7. Build & Start the Central Application
```bash
npm run build
NODE_ENV=production AUTOMATION_MODE=scheduled npm start
```

(`npm start` runs `node server.ts` natively on Node 22+.)

Scheduler modes (`AUTOMATION_MODE`):
- `manual`: API server starts; automatic scheduler does **not** start.
- `scheduled`: Automatic `SourceDiscoverySeeder` + `SchedulerService` poll and execute jobs on `POLL_INTERVAL_SECONDS`.
- `continuous`: Continuous polling loop with lease heartbeats and stale-job recovery.

### 8. Liveness, Readiness & Operations Checks
- **Liveness probe (process alive only)**: `GET /api/live` → HTTP `200` when the Node.js process is alive.
- **Readiness probe (production traffic gate)**: `GET /api/ready` → HTTP `200` only when `overall_readiness` is `READY` in production; HTTP `503` when `NOT_READY` or critical dependencies are missing.
- **Health summary**: `GET /api/health` → full dependency status, `production_proof` flags, and active blockers.
- **Authenticated operations overview**: `GET /api/operations` (`Authorization: Bearer <CONTROL_APP_AUTH_TOKEN>`).

### 9. Monitoring & Logs
- Structured JSON logs with correlation IDs (`correlationId`) and automatic secret/token redaction.
- Durable audit trail persisted in `audit_logs` (accessible via authenticated `GET /api/audit`).
- Never log `CONTROL_APP_AUTH_TOKEN`, `OFFICIAL_ACQUISITION_WORKER_TOKEN`, `GEMINI_API_KEY`, or `OMNIHUB_WP_APP_PASSWORD`.

### 10. Backup, Recovery & Rollback
- **SQLite Backup**: Run an online consistent snapshot using `sqlite3 "$DATABASE_PATH" "VACUUM INTO '/backups/govjobs-$(date +%F-%H%M).db';"` and back up `DOCUMENT_STORAGE_DIR` concurrently.
- **Graceful Shutdown**: Send `SIGTERM` to drain in-flight jobs/worker requests and run `PRAGMA wal_checkpoint(TRUNCATE)` before exit.
- **Recovery**: On restart, `SchedulerService` automatically recovers expired leases (`recoverStaleJobs`) and resumes pending jobs without duplicating documents or WordPress posts.
- **Rollback**: Stop the central server (`SIGTERM`), restore the verified SQLite backup and `DOCUMENT_STORAGE_DIR` snapshot, redeploy the previous image/tag, and verify `/api/live` and `/api/ready`.

### 11. Troubleshooting
- **`NOT_READY` on `/api/ready`**: Inspect `blockers` in the JSON response (common causes: unset `DOCUMENT_STORAGE_DIR`, missing `OFFICIAL_ACQUISITION_WORKER_URL`, unverified `GEMINI_API_KEY`, or unreachable `OMNIHUB_WP_URL`).
- **`401` / `403` on `/api/*`**: Ensure `Authorization: Bearer <CONTROL_APP_AUTH_TOKEN>` is provided (read-only tokens cannot call mutating routes like `POST /api/ingest`).
- **`DOCKER_RUNTIME_NOT_AVAILABLE`**: Docker CLI/daemon is absent on the current host; run `docker build -f worker/Dockerfile.production` on a Docker-enabled build host or CI runner.
- **`INCONCLUSIVE / ENVIRONMENT_BLOCKED` on `verify:live`**: Target government portal blocked or timed out from the current network egress; deploy the standalone acquisition worker to an external HTTPS host and run `npm run verify:remote-production`.

---

## Production Hardening Notes

- **Public probes:** `/health` (root) and `/api/live` are liveness only. `/api/health`, `/api/status` and `/api/ready` are readiness endpoints; for callers without a `health:read` Bearer token the worker endpoint URL, `workerId`, active job IDs and storage paths are removed from the response. Send `Authorization: Bearer <token>` to see full detail. The outbound remote-worker and WordPress probes are cached (`READINESS_CACHE_SECONDS`, default 30s in production).
- **Reverse proxy:** set `TRUST_PROXY` to the number of proxy hops (e.g. `1` behind a single nginx) so per-IP rate limiting sees real client IPs. The rate limiter is in-memory, so run a single app instance.
- **Fail-closed startup:** with `NODE_ENV=production` the server refuses to start on an insecure config (weak `CONTROL_APP_AUTH_TOKEN`, non-https WordPress URL, no CORS origin/`APP_URL`, missing `GEMINI_API_KEY`, invalid REMOTE worker config). `ALLOW_DEGRADED_START=true` bypasses this for staging only.
- **Docker:** `docker build -t omnihub-govjobs .` then run with volumes for `/app/data`, `/app/documents` and `/app/backups`, and pass the env vars above. Requires Node >= 22.18 when run without Docker.
- **Backups & retention:** online `VACUUM INTO` backups every `BACKUP_INTERVAL_HOURS` (newest `BACKUP_KEEP_COPIES` kept) and batched deletion of completed jobs, audit logs and OCR cache older than `RETENTION_DAYS`. Runs only when no job is RUNNING. Restore by stopping the app and replacing `DATABASE_PATH` with a backup file.
- **Not proven by this repository:** reachability of the official sources from an India-egress host and the remote worker deployment still have to be verified on real infrastructure (`npm run verify:remote-production`).

## Verification Commands

- `npm run lint` — TypeScript strict type check (`tsc --noEmit`).
- `npm test` — Full automated backend test matrix (all unit, DB migration, extraction, OCR, scheduler, security, WordPress, and production-hardening suites).
- `npm run test:worker` — Standalone Official Acquisition Worker security, auth, SSRF, redirect, and identity test suite.
- `npm run verify:scheduler-runtime` — Verifies server startup, `AUTOMATION_MODE=scheduled` vs `manual`, and `SIGINT`/`SIGTERM` shutdown.
- `npm run worker:smoke:container` — Validates `worker/Dockerfile.production`, `package-lock.json` consistency, and runs Docker build/container smoke checks when Docker is installed.
- `npm run verify:live` — Un-mocked live HTTP/PDF verification against all 7 official government portals.
- `npm run verify:remote-production` — 9-stage live remote verification against `OFFICIAL_ACQUISITION_WORKER_URL`.
