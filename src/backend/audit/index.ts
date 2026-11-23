/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuditService } from './audit-service.ts';
import { getRepositories, type RepositoryContainer } from '../database/index.ts';

let defaultAuditService: AuditService | null = null;
let lastRepos: RepositoryContainer | null = null;

export function getAuditService(): AuditService {
  const repos = getRepositories();
  if (!defaultAuditService || lastRepos !== repos) {
    lastRepos = repos;
    defaultAuditService = new AuditService(repos.auditLogs);
  }
  return defaultAuditService;
}

export * from './audit-service.ts';
