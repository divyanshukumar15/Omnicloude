# Official Acquisition Worker — Production Deployment & Verification Guide

The **Official Acquisition Worker** is a standalone, provider-neutral Node.js/TypeScript HTTP microservice for **OmniHub GovJobs Automation AI**. It executes official government portal fetches and PDF downloads from an external server/container environment while enforcing the exact same allowlist, HTTPS, SSRF, DNS-rebinding, redirect, size, and PDF magic-byte security invariants as the central application.

---

## 1. Prerequisites & Repository Structure

- **Node.js**: `>= 20.0.0` (container image uses `node:22-slim`)
- **Container Builder**: Docker / OCI-compatible container runtime (for container builds)
- **Worker Package Files**:
  - `worker/Dockerfile.production` — Production container definition for the standalone worker
  - `worker/.dockerignore` — Excludes build artifacts, local databases, and secrets
  - `worker/.env.example` — Template for worker runtime environment variables
  - `worker/package.json` — Worker package manifest and scripts
  - `src/worker/server.ts` — Production HTTP server entrypoint (`npm run worker:start`)
  - `src/worker/official-acquisition-worker.ts` — Core HTTP service (`/health`, `/capabilities`, `/acquire`)
  - `src/worker/container-smoke-test.ts` — Repeatable container & package smoke test (`npm run worker:smoke:container`)
  - `src/backend/ingestion/discovery/verify-remote-production.ts` — Production remote verification CLI (`npm run verify:remote-production`)

---

## 2. Build & Local Verification

Install dependencies and validate TypeScript compilation from the repository root:

```bash
npm ci --legacy-peer-deps
npm run lint
npm run test:worker
```

---

## 3. Docker Build & Docker Run

### Build the Container Image
Run from the repository root so shared security and domain-registry modules under `src/` are included in the build context:

```bash
docker build -f worker/Dockerfile.production -t omnihub-acquisition-worker:latest .
```

### Run the Container
```bash
docker run --rm \
  -e OFFICIAL_ACQUISITION_WORKER_TOKEN=test-token \
  -e WORKER_EXECUTION_ENVIRONMENT=PRODUCTION_REMOTE \
  -p 8080:8080 \
  omnihub-acquisition-worker:latest
```

### Run the Container Smoke Test
```bash
npm run worker:smoke:container
```
*(If Docker is not installed in the current runtime environment, this command validates `worker/Dockerfile.production` and package files and reports `DOCKER_RUNTIME_NOT_AVAILABLE` rather than fabricating a pass).*

### Verification Scope Classification
The system strictly separates three distinct execution and verification tiers:
- **`CONTAINER_SMOKE_TEST`**: Local Docker image build (`docker build -f worker/Dockerfile.production -t omnihub-acquisition-worker:latest .`) and local container endpoint/authentication/identity smoke check (`npm run worker:smoke:container`). Proves container packaging only; **never** claims `REAL_REMOTE_PRODUCTION`.
- **`REAL_REMOTE_LOCAL_WORKER`**: Full HTTP remote runner execution against a worker process listening on loopback (`127.0.0.1` / `localhost`). Proves the HTTP protocol and security pipeline locally (`executionEnvironment = LOCAL_WORKER`), but **never** claims `REAL_REMOTE_PRODUCTION`.
- **`REAL_REMOTE_PRODUCTION`**: Awarded **only** when `npm run verify:remote-production` connects over **HTTPS** to an externally deployed worker (`executionEnvironment = PRODUCTION_REMOTE`, `actualRunner = REMOTE`), downloads a genuine official government PDF, passes central `%PDF-` / `pdf-parse` validation, and persists an audit record.

---

## 4. Environment Variables

### Worker Service (`worker/.env.example`)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `WORKER_HOST` | `0.0.0.0` | Network interface to bind (`0.0.0.0` required for container/remote deployments). |
| `WORKER_PORT` | `8080` | HTTP port exposed by the worker service. |
| `OFFICIAL_ACQUISITION_WORKER_TOKEN` | *(required)* | Shared secret token for constant-time `Bearer` / `HMAC-SHA256` authentication on `POST /acquire`. |
| `WORKER_EXECUTION_ENVIRONMENT` | `PRODUCTION_REMOTE` | Execution identity (`PRODUCTION_REMOTE` only when bound to non-loopback host with token configured; otherwise `LOCAL_WORKER`). |
| `WORKER_REQUEST_TIMEOUT_MS` | `15000` | Per-attempt HTTP request timeout in milliseconds (`50`–`30000`). |
| `WORKER_CONNECT_TIMEOUT_MS` | `15000` | Underlying TCP/TLS connection timeout in milliseconds (`50`–`30000`). |
| `WORKER_MAX_RETRIES` | `2` | Maximum retry attempts on transient network/5xx failures (`0`–`3`). |
| `WORKER_RETRY_BACKOFF_MS` | `500` | Base exponential backoff delay in milliseconds (`10`–`5000`). |
| `WORKER_MAX_RESPONSE_MB` | `25` | Maximum response payload size in megabytes (`1`–`50`). |
| `WORKER_MAX_CONCURRENCY` | `4` | Maximum concurrent in-flight acquisitions (`1`–`50`). |

### Central Application (`.env.example`)
```dotenv
RUNNER_MODE="AUTO" # LOCAL | REMOTE | AUTO
OFFICIAL_ACQUISITION_WORKER_URL="https://worker.yourdomain.example"
OFFICIAL_ACQUISITION_WORKER_TOKEN="<matching-secret-token>"
```

---

## 5. HTTPS Requirement & External Deployment

The central application enforces **HTTPS** (`https://`) for all external production worker URLs (`OFFICIAL_ACQUISITION_WORKER_URL`). Plain `http://` is permitted only for local loopback testing (`127.0.0.1` / `localhost`), which is classified strictly as `REAL_REMOTE_LOCAL_WORKER` and can never satisfy `REAL_REMOTE_PRODUCTION`.

### Deploying to Any Container or Node.js Host
1. Build and push `omnihub-acquisition-worker:latest` to your container registry, or deploy from the repository root using `worker/Dockerfile.production`.
2. Configure `OFFICIAL_ACQUISITION_WORKER_TOKEN` as a secret environment variable and set `WORKER_EXECUTION_ENVIRONMENT=PRODUCTION_REMOTE`, `WORKER_HOST=0.0.0.0`, `WORKER_PORT=8080`.
3. Terminate TLS (HTTPS) in front of port `8080` using your platform's managed TLS ingress or a reverse proxy (such as Caddy or Nginx with Let's Encrypt).

---

## 6. Health Check & Capabilities Endpoints

### `GET /health` (Unauthenticated)
```bash
curl -sS https://worker.yourdomain.example/health | jq .
```
Returns HTTP `200` with `status: "HEALTHY"`, `service: "OfficialAcquisitionWorker"`, `version`, `uptime`, `timestamp`, `capabilities`, and `runnerIdentity`. Never contacts external government websites.

### `GET /ready` (Unauthenticated)
```bash
curl -sS https://worker.yourdomain.example/ready | jq .
```
Returns HTTP `200` (`status: "READY"`) when the worker is accepting requests and `OFFICIAL_ACQUISITION_WORKER_TOKEN` is configured in `PRODUCTION_REMOTE` mode, or HTTP `503` (`status: "NOT_READY"`) when draining or missing required auth configuration.

### `GET /capabilities` (Unauthenticated)
```bash
curl -sS https://worker.yourdomain.example/capabilities | jq .
```
Returns `service`, `version`, `executionEnvironment`, `supportedMethods`, `supportedAcquisitionTypes`, `securityFeatures`, `maxResponseSize`, `timeoutConfiguration`, `supportedSources`, and `rrbRegionalBoardsCount` without exposing secrets or tokens.

---

## 7. Authentication (`POST /acquire`)

Every `POST /acquire` request requires authentication using `OFFICIAL_ACQUISITION_WORKER_TOKEN`:
- **Bearer Header**: `Authorization: Bearer <OFFICIAL_ACQUISITION_WORKER_TOKEN>`
- **HMAC-SHA256 Header**: `X-Worker-Timestamp: <ms>` and `X-Worker-Signature: sha256=<hmac>`

Missing credentials return `401 Unauthorized`. Invalid tokens or signatures return `403 Forbidden`. Tokens are compared in constant time (`crypto.timingSafeEqual`) and are never logged or echoed.

---

## 8. Running `verify:remote-production`

Once the external worker is deployed over HTTPS and configured in the main application's environment, run:

```bash
npm run verify:remote-production
```

### Verification Stages
The command evaluates and reports 9 explicit stages (`PASS`, `FAIL`, `INCONCLUSIVE`, or `NOT_CONFIGURED`):
1. `WORKER_URL_CONFIGURATION`
2. `WORKER_HEALTH`
3. `REMOTE_AUTH`
4. `REMOTE_HTTP_EXECUTION`
5. `REMOTE_EXECUTION_IDENTITY`
6. `OFFICIAL_SOURCE_ACCESS`
7. `DOCUMENT_ACQUISITION`
8. `PDF_VALIDATION`
9. `AUDIT_EVIDENCE`

`REAL_REMOTE_PRODUCTION = PROVEN` is awarded **only** when all 9 stages pass against a real external HTTPS worker returning `actualRunner = "REMOTE"` and `executionEnvironment = "PRODUCTION_REMOTE"`, a real official PDF is validated by the central pipeline, and the audit record is persisted.

---

## 9. Troubleshooting

- **`REMOTE_NOT_CONFIGURED`**: `OFFICIAL_ACQUISITION_WORKER_URL` is unset. Set it to your external `https://` worker URL.
- **`REMOTE_AUTH_FAILED` (`401` / `403`)**: Verify that `OFFICIAL_ACQUISITION_WORKER_TOKEN` matches identically on both the central application and the remote worker container.
- **`REMOTE_PROTOCOL_ERROR`**: Either the worker URL points to a loopback address (`127.0.0.1` / `localhost`), uses `http://` instead of `https://`, or the worker was started without `WORKER_EXECUTION_ENVIRONMENT=PRODUCTION_REMOTE`.
- **`OFFICIAL_SOURCE_TIMEOUT` / `OFFICIAL_SOURCE_ACCESS_BLOCKED`**: The remote worker executed properly, but the target government portal timed out or blocked the worker host's egress IP.
- **`PDF_VALIDATION_FAILURE`**: The upstream response returned HTTP 200 (such as an HTML error page) or a corrupted file that failed `%PDF-` magic-byte or `pdf-parse` validation.

---

## 10. Token Rotation

1. Generate a new 32-byte random token:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `OFFICIAL_ACQUISITION_WORKER_TOKEN` in the external worker deployment and restart the container (graceful `SIGTERM` drains in-flight requests).
3. Update `OFFICIAL_ACQUISITION_WORKER_TOKEN` in the central application environment.
4. Run `npm run verify:remote-production` to confirm `REMOTE_AUTH: PASS`.
