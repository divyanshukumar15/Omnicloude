/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export interface DockerfileStructuralValidation {
  exists: boolean;
  nonEmpty: boolean;
  node20PlusRuntime: boolean;
  multiStageBuild: boolean;
  runsWorkerBuild: boolean;
  includesSharedBackendModules: boolean;
  copyPathsExistInRepo: boolean;
  nonRootUserConfigured: boolean;
  exposesPort8080: boolean;
  bindsAllInterfaces: boolean;
  hasHealthcheck: boolean;
  productionCmd: boolean;
  startsWorkerEntrypoint: boolean;
  noHardcodedSecrets: boolean;
  noWildcardLockfileCopy: boolean;
  packageManagerConsistent: boolean;
  valid: boolean;
}

export interface ContainerSmokeTestReport {
  timestamp: string;
  verificationScope: 'CONTAINER_SMOKE_TEST';
  REAL_REMOTE_PRODUCTION: 'NOT_PROVEN';
  dockerfilePath: string;
  dockerfileVerified: boolean;
  dockerfileStructure: DockerfileStructuralValidation;
  dockerRuntimeAvailable: boolean;
  status: 'PASS' | 'FAIL' | 'DOCKER_RUNTIME_NOT_AVAILABLE';
  dockerBuild: 'PASS' | 'FAIL' | 'NOT_RUN';
  dockerBuildStatus: 'PASS' | 'FAIL' | 'DOCKER_BUILD_NOT_RUN';
  containerSmokeTest: 'PASS' | 'FAIL' | 'NOT_RUN';
  checks: {
    packageFilesPresent: boolean;
    dockerfileSyntaxValid: boolean;
    packageManagerConsistent: boolean;
    imageBuilt: boolean;
    containerStarted: boolean;
    healthEndpoint200: boolean;
    readyEndpoint200: boolean;
    capabilitiesEndpoint200: boolean;
    authEnforced401: boolean;
    invalidAuthRejected403: boolean;
    validAcquireReachedWorker: boolean;
    workerIdentityVerified: boolean;
    gracefulShutdown: boolean;
  };
  details: string;
}

export function verifyWorkerPackageFiles(rootDir = process.cwd()): {
  valid: boolean;
  missingFiles: string[];
  emptyFiles: string[];
  dockerfileStructure: DockerfileStructuralValidation;
  details: string;
} {
  // Authoritative worker container packaging lives under worker/Dockerfile.production (BUG 11).
  // Do NOT require a redundant root Dockerfile.
  const requiredFiles = [
    '.env.example',
    'worker/Dockerfile.production',
    'worker/.dockerignore',
    'worker/.env.example',
    'worker/package.json',
    'worker/README.md',
    'src/worker/server.ts',
    'src/worker/official-acquisition-worker.ts',
    'src/worker/container-smoke-test.ts',
  ];

  const missingFiles: string[] = [];
  const emptyFiles: string[] = [];

  for (const relPath of requiredFiles) {
    const absPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(absPath)) {
      missingFiles.push(relPath);
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    if (content.trim().length === 0) {
      emptyFiles.push(relPath);
    }
  }

  const workerDockerfilePath = path.resolve(rootDir, 'worker/Dockerfile.production');
  const dockerfileExists = fs.existsSync(workerDockerfilePath);
  const workerDockerfile = dockerfileExists ? fs.readFileSync(workerDockerfilePath, 'utf8') : '';
  const nonEmpty = workerDockerfile.trim().length > 0;
  const node20PlusRuntime = /FROM\s+node:2[0-9]/i.test(workerDockerfile);
  const fromStages = workerDockerfile.match(/^\s*FROM\s+\S+/gim) || [];
  const multiStageBuild = fromStages.length >= 2 && /\bAS\s+builder\b/i.test(workerDockerfile) && /\bAS\s+runtime\b/i.test(workerDockerfile);
  const runsWorkerBuild = /npm\s+run\s+worker:build/i.test(workerDockerfile);
  const includesSharedBackendModules =
    (/COPY\s+.*src\/backend/i.test(workerDockerfile) &&
      /COPY\s+.*src\/worker/i.test(workerDockerfile)) ||
    /COPY\s+src\s+/i.test(workerDockerfile);
  const copyPathsExistInRepo = [
    'package.json',
    'tsconfig.json',
    'src/backend',
    'src/worker',
    'worker/package.json',
    'worker/.env.example',
  ].every((p) => fs.existsSync(path.resolve(rootDir, p)));
  const nonRootUserConfigured = /USER\s+node\b/i.test(workerDockerfile);
  const exposesPort8080 = /EXPOSE\s+8080\b/i.test(workerDockerfile);
  const bindsAllInterfaces = /WORKER_HOST=0\.0\.0\.0/i.test(workerDockerfile);
  const hasHealthcheck = /^\s*HEALTHCHECK\b/im.test(workerDockerfile);
  const productionCmd = /CMD\s+\[\s*"node"\s*,\s*"\/app\/dist\/worker\/server\.js"\s*\]/i.test(workerDockerfile);
  const startsWorkerEntrypoint =
    productionCmd ||
    /worker:start/i.test(workerDockerfile) ||
    /src\/worker\/server\.ts/i.test(workerDockerfile) ||
    /dist\/worker\/server\.js/i.test(workerDockerfile);

  const tokenMatch = workerDockerfile.match(/OFFICIAL_ACQUISITION_WORKER_TOKEN\s*=\s*([^\s\\]+)/i);
  const tokenVal = tokenMatch ? tokenMatch[1].replace(/^["']|["']$/g, '').trim() : '';
  const hasInlineSecretPatterns = /(?:GEMINI_API_KEY|OMNIHUB_WP_APP_PASSWORD|CONTROL_APP_AUTH_TOKEN)\s*=\s*[^\s\\]+/i.test(workerDockerfile);
  const noHardcodedSecrets = tokenVal.length === 0 && !hasInlineSecretPatterns;

  // Package manager consistency check:
  // - Never allow wildcard lockfile COPY assumptions (e.g. package-lock.json* or bun.lock*)
  // - If npm ci is referenced in worker/Dockerfile.production or worker/README.md, package-lock.json MUST exist
  const noWildcardLockfileCopy = !/COPY\s+.*(?:package-lock\.json\*|bun\.lock\*)/i.test(workerDockerfile);
  const hasPackageLock = fs.existsSync(path.resolve(rootDir, 'package-lock.json'));
  const dockerfileUsesNpmCi = /\bnpm\s+ci\b/i.test(workerDockerfile);
  const workerReadmePath = path.resolve(rootDir, 'worker/README.md');
  const workerReadme = fs.existsSync(workerReadmePath) ? fs.readFileSync(workerReadmePath, 'utf8') : '';
  const readmeUsesNpmCi = /\bnpm\s+ci\b/i.test(workerReadme);
  const packageManagerConsistent =
    noWildcardLockfileCopy && (hasPackageLock || (!dockerfileUsesNpmCi && !readmeUsesNpmCi));

  const dockerfileStructure: DockerfileStructuralValidation = {
    exists: dockerfileExists,
    nonEmpty,
    node20PlusRuntime,
    multiStageBuild,
    runsWorkerBuild,
    includesSharedBackendModules,
    copyPathsExistInRepo,
    nonRootUserConfigured,
    exposesPort8080,
    bindsAllInterfaces,
    hasHealthcheck,
    productionCmd,
    startsWorkerEntrypoint,
    noHardcodedSecrets,
    noWildcardLockfileCopy,
    packageManagerConsistent,
    valid:
      dockerfileExists &&
      nonEmpty &&
      node20PlusRuntime &&
      multiStageBuild &&
      runsWorkerBuild &&
      includesSharedBackendModules &&
      copyPathsExistInRepo &&
      nonRootUserConfigured &&
      exposesPort8080 &&
      bindsAllInterfaces &&
      hasHealthcheck &&
      productionCmd &&
      startsWorkerEntrypoint &&
      noHardcodedSecrets &&
      noWildcardLockfileCopy &&
      packageManagerConsistent,
  };

  if (missingFiles.length > 0) {
    return {
      valid: false,
      missingFiles,
      emptyFiles,
      dockerfileStructure,
      details: `Missing worker package files: ${missingFiles.join(', ')}`,
    };
  }

  if (emptyFiles.length > 0) {
    return {
      valid: false,
      missingFiles,
      emptyFiles,
      dockerfileStructure,
      details: `Empty worker package files: ${emptyFiles.join(', ')}`,
    };
  }

  if (!dockerfileStructure.packageManagerConsistent) {
    return {
      valid: false,
      missingFiles: [],
      emptyFiles: [],
      dockerfileStructure,
      details:
        'Package manager inconsistency: npm ci referenced without package-lock.json in repository (use npm install or commit package-lock.json)',
    };
  }

  if (!dockerfileStructure.valid) {
    return {
      valid: false,
      missingFiles: [],
      emptyFiles: [],
      dockerfileStructure,
      details:
        'worker/Dockerfile.production failed structural validation (requires Node 20+, multi-stage builder/runtime, npm run worker:build, shared backend/worker sources, USER node, WORKER_HOST=0.0.0.0, EXPOSE 8080, HEALTHCHECK, production CMD, and no hard-coded secrets)',
    };
  }

  return {
    valid: true,
    missingFiles: [],
    emptyFiles: [],
    dockerfileStructure,
    details: 'worker/Dockerfile.production and worker package files are structurally valid and package-manager consistent',
  };
}

function isDockerRuntimeAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function runContainerSmokeTest(): Promise<ContainerSmokeTestReport> {
  const pkgCheck = verifyWorkerPackageFiles();
  const dockerAvailable = isDockerRuntimeAvailable();

  const report: ContainerSmokeTestReport = {
    timestamp: new Date().toISOString(),
    verificationScope: 'CONTAINER_SMOKE_TEST',
    REAL_REMOTE_PRODUCTION: 'NOT_PROVEN',
    dockerfilePath: 'worker/Dockerfile.production',
    dockerfileVerified: pkgCheck.valid,
    dockerfileStructure: pkgCheck.dockerfileStructure,
    dockerRuntimeAvailable: dockerAvailable,
    status: 'DOCKER_RUNTIME_NOT_AVAILABLE',
    dockerBuild: 'NOT_RUN',
    dockerBuildStatus: 'DOCKER_BUILD_NOT_RUN',
    containerSmokeTest: 'NOT_RUN',
    checks: {
      packageFilesPresent: pkgCheck.missingFiles.length === 0 && pkgCheck.emptyFiles.length === 0,
      dockerfileSyntaxValid: pkgCheck.dockerfileStructure.valid,
      packageManagerConsistent: pkgCheck.dockerfileStructure.packageManagerConsistent,
      imageBuilt: false,
      containerStarted: false,
      healthEndpoint200: false,
      readyEndpoint200: false,
      capabilitiesEndpoint200: false,
      authEnforced401: false,
      invalidAuthRejected403: false,
      validAcquireReachedWorker: false,
      workerIdentityVerified: false,
      gracefulShutdown: false,
    },
    details: pkgCheck.details,
  };

  if (!pkgCheck.valid) {
    report.status = 'FAIL';
    return report;
  }

  if (!dockerAvailable) {
    report.status = 'DOCKER_RUNTIME_NOT_AVAILABLE';
    report.dockerBuild = 'NOT_RUN';
    report.dockerBuildStatus = 'DOCKER_BUILD_NOT_RUN';
    report.containerSmokeTest = 'NOT_RUN';
    report.details =
      'DOCKER_RUNTIME_NOT_AVAILABLE / DOCKER_BUILD_NOT_RUN: Docker CLI/daemon is not available in the current runtime environment; worker/Dockerfile.production and worker package validated statically.';
    return report;
  }

  const imageTag = 'omnihub-acquisition-worker:latest';
  const containerName = `omnihub-worker-smoke-${process.pid}`;
  const smokePort = 18080;
  const smokeToken = 'smoke-test-secret-token-2026';

  try {
    execFileSync('docker', ['build', '-f', 'worker/Dockerfile.production', '-t', imageTag, '.'], {
      stdio: 'pipe',
      timeout: 180000,
    });
    report.checks.imageBuilt = true;
    report.dockerBuild = 'PASS';
    report.dockerBuildStatus = 'PASS';

    const proc = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '-e',
        `OFFICIAL_ACQUISITION_WORKER_TOKEN=${smokeToken}`,
        '-e',
        'WORKER_EXECUTION_ENVIRONMENT=PRODUCTION_REMOTE',
        '-e',
        'WORKER_HOST=0.0.0.0',
        '-e',
        'WORKER_PORT=8080',
        '-p',
        `${smokePort}:8080`,
        imageTag,
      ],
      { stdio: 'ignore' }
    );

    const baseUrl = `http://127.0.0.1:${smokePort}`;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.status === 200) {
          const healthJson = (await res.json()) as {
            status?: string;
            runnerIdentity?: { actualRunner?: string; executionEnvironment?: string };
          };
          report.checks.containerStarted = true;
          report.checks.healthEndpoint200 = healthJson.status === 'HEALTHY';
          if (
            healthJson.runnerIdentity?.actualRunner === 'REMOTE' &&
            healthJson.runnerIdentity?.executionEnvironment === 'PRODUCTION_REMOTE'
          ) {
            report.checks.workerIdentityVerified = true;
          }
          break;
        }
      } catch {
        // wait for container startup
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!report.checks.healthEndpoint200) {
      throw new Error('Container /health did not return HTTP 200 within 15s');
    }

    const readyRes = await fetch(`${baseUrl}/ready`);
    report.checks.readyEndpoint200 = readyRes.status === 200;

    const capRes = await fetch(`${baseUrl}/capabilities`);
    report.checks.capabilitiesEndpoint200 = capRes.status === 200;

    const unauthRes = await fetch(`${baseUrl}/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'smoke-unauth',
        sourceId: 'IN-CENTRAL-SSC',
        endpoint: 'https://ssc.gov.in',
      }),
    });
    report.checks.authEnforced401 = unauthRes.status === 401;

    const badAuthRes = await fetch(`${baseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({
        requestId: 'smoke-bad-auth',
        sourceId: 'IN-CENTRAL-SSC',
        endpoint: 'https://ssc.gov.in',
      }),
    });
    report.checks.invalidAuthRejected403 = badAuthRes.status === 403;

    // Safe non-official acquisition request proving authenticated request reaches worker and enforces domain allowlist + worker identity
    const validAuthRes = await fetch(`${baseUrl}/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${smokeToken}`,
      },
      body: JSON.stringify({
        requestId: 'smoke-valid-auth',
        sourceId: 'IN-CENTRAL-SSC',
        endpoint: 'https://unapproved.example.com',
        acquisitionType: 'LISTING',
      }),
    });
    const validAuthBody = (await validAuthRes.json()) as {
      actualRunner?: string;
      executionEnvironment?: string;
      status?: string;
      failureClass?: string;
    };
    report.checks.validAcquireReachedWorker =
      validAuthRes.status === 200 &&
      validAuthBody.status === 'FAILED' &&
      validAuthBody.failureClass === 'ACCESS_BLOCKED' &&
      validAuthBody.actualRunner === 'REMOTE';
    report.checks.workerIdentityVerified =
      report.checks.workerIdentityVerified &&
      validAuthBody.actualRunner === 'REMOTE' &&
      validAuthBody.executionEnvironment === 'PRODUCTION_REMOTE';

    execFileSync('docker', ['stop', '-t', '5', containerName], { stdio: 'ignore', timeout: 10000 });
    proc.kill('SIGTERM');
    report.checks.gracefulShutdown = true;

    const allPassed = Object.values(report.checks).every(Boolean);
    report.containerSmokeTest = allPassed ? 'PASS' : 'FAIL';
    report.status = allPassed ? 'PASS' : 'FAIL';
    report.details = allPassed
      ? 'CONTAINER_SMOKE_TEST passed: Container built, started, verified endpoints/auth/identity, and shut down cleanly (REAL_REMOTE_PRODUCTION remains NOT_PROVEN until externally deployed over HTTPS)'
      : 'One or more container smoke checks failed';
    return report;
  } catch (err) {
    try {
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } catch {
      // ignore cleanup error
    }
    if (!report.checks.imageBuilt) {
      report.dockerBuild = 'FAIL';
      report.dockerBuildStatus = 'FAIL';
    }
    report.containerSmokeTest = 'FAIL';
    report.status = 'FAIL';
    report.details = `Container smoke test failed: ${(err as Error).message}`;
    return report;
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('container-smoke-test.ts') ||
    process.argv[1].endsWith('container-smoke-test.js'));

if (isDirectRun) {
  void runContainerSmokeTest().then((res) => {
    console.log('=== OMNIHUB WORKER CONTAINER SMOKE TEST ===');
    console.log(`verificationScope:     ${res.verificationScope}`);
    console.log(`dockerfilePath:        ${res.dockerfilePath}`);
    console.log(`status:                ${res.status}`);
    console.log(`dockerfileVerified:    ${res.dockerfileVerified}`);
    console.log(`dockerRuntimeAvailable:${res.dockerRuntimeAvailable}`);
    console.log(`dockerBuild:           ${res.dockerBuildStatus}`);
    console.log(`containerSmokeTest:    ${res.containerSmokeTest}`);
    console.log(`REAL_REMOTE_PRODUCTION:${res.REAL_REMOTE_PRODUCTION}`);
    console.log(`details:               ${res.details}`);
    console.log(JSON.stringify(res));
    process.exit(res.status === 'FAIL' ? 1 : 0);
  });
}
