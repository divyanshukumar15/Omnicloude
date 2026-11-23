/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { JobService } from './job-service.ts';
import { getRepositories, type RepositoryContainer } from '../database/index.ts';
import { getAuditService } from '../audit/index.ts';

let defaultJobService: JobService | null = null;
let lastRepos: RepositoryContainer | null = null;

export function getJobService(): JobService {
  const repos = getRepositories();
  if (!defaultJobService || lastRepos !== repos) {
    lastRepos = repos;
    const auditService = getAuditService();
    defaultJobService = new JobService(repos.processingJobs, auditService);
  }
  return defaultJobService;
}

export * from './job-service.ts';
