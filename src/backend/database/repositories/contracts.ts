/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SourceEntity,
  SourceDocumentEntity,
  DocumentEntity,
  DocumentPageEntity,
  RecruitmentEntity,
  JobEntity,
  EvidenceEntity,
  ProcessingJobEntity,
  DeduplicationRecordEntity,
  PublishingRecordEntity,
  AuditLogEntity,
  ExtractionAuditEntity,
  CorrigendumAssociationEntity,
  PipelineStageName,
  ProcessingJobStatus,
} from '../types.ts';

export interface JobClaimOptions {
  maxConcurrentJobs?: number;
  leaseDurationMs?: number;
  nowIso?: string;
}

export interface ScheduleRetryInput {
  workerId: string;
  errorCode: string;
  errorMessage: string;
  nextRetryAt: string;
  maxAttempts?: number;
}

export interface RecoverStaleJobsOptions {
  nowIso?: string;
  maxAttempts?: number;
  retryBackoffMs?: number;
}

export interface RecoveredStaleJobRecord {
  job: ProcessingJobEntity;
  previousOwner: string | null;
  previousClaimedAt: string | null;
  expiredLeaseAt: string | null;
  outcome: 'REQUEUED_PENDING' | 'MARKED_FAILED';
  reason: string;
}

export interface CreateProcessingJobRecord {
  job_id?: string;
  parent_job_id?: string | null;
  dedupe_key?: string | null;
  target_entity_type: string;
  target_entity_id: string;
  stage: PipelineStageName;
  status?: ProcessingJobStatus;
  max_attempts?: number;
  metadata_json?: string | null;
}

export interface IProcessingJobRepository {
  create(job: CreateProcessingJobRecord): ProcessingJobEntity;

  createIdempotent(job: CreateProcessingJobRecord): {
    job: ProcessingJobEntity;
    created: boolean;
  };

  findById(jobId: string): ProcessingJobEntity | null;

  findByDedupeKey(dedupeKey: string): ProcessingJobEntity | null;

  listByParentJobId(parentJobId: string): ProcessingJobEntity[];

  listByTarget(
    targetEntityType: string,
    targetEntityId: string,
    stage?: PipelineStageName,
    limit?: number
  ): ProcessingJobEntity[];

  listPausedAwaitingChildren(): ProcessingJobEntity[];

  listReconcilableParents(): ProcessingJobEntity[];

  updateMetadata(jobId: string, metadataJson: string | null): ProcessingJobEntity;

  updateStatus(
    jobId: string,
    update: {
      status: ProcessingJobStatus;
      stage?: PipelineStageName;
      attemptsIncrement?: boolean;
      error_code?: string | null;
      error_message?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      clearLease?: boolean;
    }
  ): ProcessingJobEntity;

  claimJob(jobId: string, workerId: string, options?: JobClaimOptions): ProcessingJobEntity | null;

  claimNextPendingJob(workerId: string, options?: JobClaimOptions): ProcessingJobEntity | null;

  scheduleRetry(jobId: string, input: ScheduleRetryInput): ProcessingJobEntity | null;

  requeueJob(jobId: string, nowIso?: string): ProcessingJobEntity | null;

  recoverStaleJobs(options?: RecoverStaleJobsOptions): RecoveredStaleJobRecord[];

  renewLease(
    jobId: string,
    workerId: string,
    leaseDurationMs: number,
    nowIso?: string
  ): ProcessingJobEntity | null;

  countRunning(): number;

  listStaleRunning(referenceIso?: string): ProcessingJobEntity[];

  listRecent(limit?: number, status?: ProcessingJobStatus): ProcessingJobEntity[];

  countByStatus(): Record<ProcessingJobStatus, number>;
}

export interface IAuditLogRepository {
  create(log: {
    id?: string;
    correlation_id: string;
    actor: string;
    action: string;
    entity_type: string;
    entity_id: string;
    stage?: string | null;
    status: string;
    details_json?: string | null;
  }): AuditLogEntity;

  listByCorrelationId(correlationId: string): AuditLogEntity[];

  listByEntity(entityType: string, entityId: string): AuditLogEntity[];

  listRecent(limit?: number): AuditLogEntity[];
}

export interface ISourceRepository {
  create(source: Omit<SourceEntity, 'created_at' | 'updated_at'>): SourceEntity;
  findById(id: string): SourceEntity | null;
  listActive(): SourceEntity[];
  listAll(): SourceEntity[];
  setActive(id: string, isActive: boolean): SourceEntity | null;
}

export interface ISourceDocumentRepository {
  create(doc: Omit<SourceDocumentEntity, 'discovered_at' | 'updated_at'>): SourceDocumentEntity;
  upsertCanonical(
    doc: Omit<SourceDocumentEntity, 'discovered_at' | 'updated_at'>
  ): { entity: SourceDocumentEntity; created: boolean };
  findById(id: string): SourceDocumentEntity | null;
  findBySourceAndCanonicalUrl(sourceId: string, url: string): SourceDocumentEntity | null;
  listBySource(sourceId: string): SourceDocumentEntity[];
  updateStatus(id: string, status: SourceDocumentEntity['status']): void;
}

export interface IDocumentRepository {
  create(doc: Omit<DocumentEntity, 'downloaded_at'>): DocumentEntity;
  upsertByHash(
    doc: Omit<DocumentEntity, 'downloaded_at'>
  ): { entity: DocumentEntity; created: boolean };
  findById(id: string): DocumentEntity | null;
  findByHash(sha256Hash: string): DocumentEntity | null;
  findByCanonicalUrl(url: string): DocumentEntity | null;
  listAll(): DocumentEntity[];
  updateExtractionStatus(
    id: string,
    update: {
      status: DocumentEntity['extraction_status'];
      method?: string | null;
      isScanned?: number;
      pageCount?: number;
      validationNotes?: string | null;
    }
  ): void;
  updateValidation(
    id: string,
    update: {
      validationStatus: DocumentEntity['validation_status'];
      sha256Hash?: string | null;
      fileSize?: number | null;
      pageCount?: number | null;
      filePath?: string | null;
      validationNotes?: string | null;
    }
  ): void;
  savePages(pages: Omit<DocumentPageEntity, 'created_at'>[]): void;
  replacePages(documentId: string, pages: Omit<DocumentPageEntity, 'created_at'>[]): void;
  getPages(documentId: string): DocumentPageEntity[];
}

export interface IRecruitmentRepository {
  create(recruitment: Omit<RecruitmentEntity, 'created_at' | 'updated_at'>): RecruitmentEntity;
  findById(id: string): RecruitmentEntity | null;
  findByCanonicalIdentity(canonicalIdentityKey: string): RecruitmentEntity | null;
  findByAdvertisementNumber(advtNumber: string): RecruitmentEntity | null;
  findByDocument(documentId: string): RecruitmentEntity | null;
  listRecent(limit?: number): RecruitmentEntity[];
  listAll(): RecruitmentEntity[];
  update(id: string, update: Partial<Omit<RecruitmentEntity, 'id' | 'created_at'>>): RecruitmentEntity | null;
  updateStatus(id: string, status: import('../types.ts').RecruitmentPublishingState): RecruitmentEntity | null;
}

export interface IJobRepository {
  create(job: Omit<JobEntity, 'created_at' | 'updated_at'>): JobEntity;
  findById(id: string): JobEntity | null;
  listByRecruitment(recruitmentId: string): JobEntity[];
}

export interface IEvidenceRepository {
  create(evidence: Omit<EvidenceEntity, 'extracted_at'>): EvidenceEntity;
  listByEntity(entityType: 'RECRUITMENT' | 'JOB', entityId: string): EvidenceEntity[];
}

export interface IDeduplicationRecordRepository {
  create(record: Omit<DeduplicationRecordEntity, 'created_at'>): DeduplicationRecordEntity;
  findByJob(jobId: string): DeduplicationRecordEntity[];
}

export interface IDeduplicationEvaluationRepository {
  create(evaluation: Omit<import('../types.ts').DeduplicationEvaluationEntity, 'created_at'>): import('../types.ts').DeduplicationEvaluationEntity;
  findByIncomingDocument(documentId: string): import('../types.ts').DeduplicationEvaluationEntity[];
  findByMatchedRecruitment(recruitmentId: string): import('../types.ts').DeduplicationEvaluationEntity[];
  listRecent(limit?: number): import('../types.ts').DeduplicationEvaluationEntity[];
}

export interface IPublishingGateEvaluationRepository {
  create(evaluation: Omit<import('../types.ts').PublishingGateEvaluationEntity, 'evaluated_at'>): import('../types.ts').PublishingGateEvaluationEntity;
  findByRecruitment(recruitmentId: string): import('../types.ts').PublishingGateEvaluationEntity[];
  findLatestByRecruitment(recruitmentId: string): import('../types.ts').PublishingGateEvaluationEntity | null;
  listRecent(limit?: number): import('../types.ts').PublishingGateEvaluationEntity[];
}

export interface IPublishingRecordRepository {
  create(record: PublishingRecordEntity): PublishingRecordEntity;
  upsertByExternalIdentity(record: PublishingRecordEntity): PublishingRecordEntity;
  update(id: string, update: Partial<Omit<PublishingRecordEntity, 'id'>>): PublishingRecordEntity | null;
  findById(id: string): PublishingRecordEntity | null;
  findByJob(jobId: string): PublishingRecordEntity[];
  findByRecruitment(recruitmentId: string): PublishingRecordEntity[];
  findByExternalIdentity(platform: string, externalIdentityKey: string): PublishingRecordEntity | null;
  findByExternalPostId(platform: string, externalPostId: string): PublishingRecordEntity | null;
  listRecent(limit?: number): PublishingRecordEntity[];
}

export interface IExtractionAuditRepository {
  create(record: ExtractionAuditEntity): ExtractionAuditEntity;
  listByDocument(documentId: string): ExtractionAuditEntity[];
  listByRecruitment(recruitmentId: string): ExtractionAuditEntity[];
}

export interface ICorrigendumAssociationRepository {
  create(record: CorrigendumAssociationEntity): CorrigendumAssociationEntity;
  listByOriginalRecruitment(recruitmentId: string): CorrigendumAssociationEntity[];
  listByCorrigendumDocument(documentId: string): CorrigendumAssociationEntity[];
}

export interface ISourceDiscoveryRunRepository {
  create(run: import('../types.ts').SourceDiscoveryRunEntity): import('../types.ts').SourceDiscoveryRunEntity;
  findById(id: string): import('../types.ts').SourceDiscoveryRunEntity | null;
  listBySource(sourceId: string, limit?: number): import('../types.ts').SourceDiscoveryRunEntity[];
  listRecent(limit?: number): import('../types.ts').SourceDiscoveryRunEntity[];
  findLatestBySource(sourceId: string): import('../types.ts').SourceDiscoveryRunEntity | null;
}

export interface IOcrCacheRepository {
  save(entry: Omit<import('../types.ts').OcrPageCacheEntity, 'created_at'>): import('../types.ts').OcrPageCacheEntity;
  findByKey(
    documentChecksum: string,
    pageNumber: number,
    provider: string,
    modelVersion: string
  ): import('../types.ts').OcrPageCacheEntity | null;
  listByDocument(documentChecksum: string): import('../types.ts').OcrPageCacheEntity[];
  clear(): void;
}




