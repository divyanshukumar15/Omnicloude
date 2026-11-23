/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DatabaseSync } from 'node:sqlite';
import { initDatabase, getDatabase, closeDatabase, isDatabaseInitialized } from './connection.ts';
import {
  SqliteProcessingJobRepository,
  SqliteAuditLogRepository,
  SqliteSourceRepository,
  SqliteSourceDocumentRepository,
  SqliteDocumentRepository,
  SqliteRecruitmentRepository,
  SqliteJobRepository,
  SqliteEvidenceRepository,
  SqliteDeduplicationRepository,
  SqlitePublishingRepository,
  SqliteExtractionAuditRepository,
  SqliteCorrigendumAssociationRepository,
  SqliteDeduplicationEvaluationRepository,
  SqlitePublishingGateEvaluationRepository,
  SqliteSourceDiscoveryRunRepository,
  SqliteOcrCacheRepository,
} from './repositories/sqlite-repositories.ts';
import type {
  IProcessingJobRepository,
  IAuditLogRepository,
  ISourceRepository,
  ISourceDocumentRepository,
  IDocumentRepository,
  IRecruitmentRepository,
  IJobRepository,
  IEvidenceRepository,
  IDeduplicationRecordRepository,
  IDeduplicationEvaluationRepository,
  IPublishingGateEvaluationRepository,
  IPublishingRecordRepository,
  IExtractionAuditRepository,
  ICorrigendumAssociationRepository,
  ISourceDiscoveryRunRepository,
  IOcrCacheRepository,
} from './repositories/contracts.ts';

export interface RepositoryContainer {
  processingJobs: IProcessingJobRepository;
  auditLogs: IAuditLogRepository;
  sources: ISourceRepository;
  sourceDocuments: ISourceDocumentRepository;
  documents: IDocumentRepository;
  recruitments: IRecruitmentRepository;
  jobs: IJobRepository;
  evidence: IEvidenceRepository;
  deduplication: IDeduplicationRecordRepository;
  deduplicationEvaluations: IDeduplicationEvaluationRepository;
  publishingGateEvaluations: IPublishingGateEvaluationRepository;
  publishing: IPublishingRecordRepository;
  extractionAudits: IExtractionAuditRepository;
  corrigendumAssociations: ICorrigendumAssociationRepository;
  sourceDiscoveryRuns: ISourceDiscoveryRunRepository;
  ocrCache: IOcrCacheRepository;
}

let repos: RepositoryContainer | null = null;
let reposDb: DatabaseSync | null = null;

export function getRepositories(): RepositoryContainer {
  const db = getDatabase();
  if (!repos || reposDb !== db) {
    reposDb = db;
    repos = {
      processingJobs: new SqliteProcessingJobRepository(db),
      auditLogs: new SqliteAuditLogRepository(db),
      sources: new SqliteSourceRepository(db),
      sourceDocuments: new SqliteSourceDocumentRepository(db),
      documents: new SqliteDocumentRepository(db),
      recruitments: new SqliteRecruitmentRepository(db),
      jobs: new SqliteJobRepository(db),
      evidence: new SqliteEvidenceRepository(db),
      deduplication: new SqliteDeduplicationRepository(db),
      deduplicationEvaluations: new SqliteDeduplicationEvaluationRepository(db),
      publishingGateEvaluations: new SqlitePublishingGateEvaluationRepository(db),
      publishing: new SqlitePublishingRepository(db),
      extractionAudits: new SqliteExtractionAuditRepository(db),
      corrigendumAssociations: new SqliteCorrigendumAssociationRepository(db),
      sourceDiscoveryRuns: new SqliteSourceDiscoveryRunRepository(db),
      ocrCache: new SqliteOcrCacheRepository(db),
    };
  }
  return repos;
}

export {
  initDatabase,
  getDatabase,
  closeDatabase,
  isDatabaseInitialized,
  normalizeCanonicalUrl,
  runInSqliteTransaction,
  CURRENT_SCHEMA_VERSION,
} from './connection.ts';
export * from './source-bootstrap.ts';
export * from './types.ts';
export * from './repositories/contracts.ts';
