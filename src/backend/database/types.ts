/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type SourceType = 'PORTAL' | 'RSS' | 'API' | 'DIRECT_PAGE';

export interface SourceEntity {
  id: string;
  name: string;
  type: SourceType;
  base_url: string;
  is_active: number; // 0 or 1
  check_interval_minutes: number;
  config_json: string; // JSON string
  created_at: string;
  updated_at: string;
}

export type SourceDocumentStatus = 'DISCOVERED' | 'DOWNLOADING' | 'DOWNLOADED' | 'FAILED' | 'IGNORED';

export interface SourceDocumentEntity {
  id: string;
  source_id: string;
  url: string;
  canonical_url?: string | null;
  title: string | null;
  document_type: string | null;
  raw_hash: string | null;
  status: SourceDocumentStatus;
  metadata_json: string | null;
  discovered_at: string;
  updated_at: string;
}

export type DocumentValidationStatus = 'UNVALIDATED' | 'VALID' | 'INVALID' | 'CORRUPTED';
export type DocumentExtractionStatus =
  | 'PENDING'
  | 'EXTRACTED'
  | 'OCR_REQUIRED'
  | 'FAILED'
  | 'OCR_SUCCESS'
  | 'OCR_LOW_QUALITY'
  | 'OCR_UNAVAILABLE'
  | 'OCR_TIMEOUT'
  | 'OCR_PARTIAL'
  | 'OCR_LIMIT_EXCEEDED';

export interface DocumentEntity {
  id: string;
  source_document_id: string;
  source_url?: string | null;
  canonical_url?: string | null;
  source_domain?: string | null;
  file_path: string | null;
  file_size: number | null;
  page_count?: number | null;
  mime_type: string | null;
  sha256_hash: string | null;
  storage_uri: string | null;
  downloaded_at: string;
  validation_status: DocumentValidationStatus;
  validation_notes: string | null;
  extraction_status?: DocumentExtractionStatus;
  extraction_method?: string | null;
  is_scanned?: number;
}

export interface DocumentPageEntity {
  id: string;
  document_id: string;
  page_number: number;
  char_count: number;
  extracted_text: string;
  extraction_method: string;
  is_scanned: number;
  quality_score: number | null;
  created_at: string;
}


export type RecruitmentPublishingState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'VERIFIED'
  | 'PUBLISH_READY'
  | 'PUBLISH_BLOCKED'
  | 'REJECTED'
  | 'CONFLICT';

export interface RecruitmentEntity {
  id: string;
  source_id: string;
  document_id: string | null;
  title: string;
  department: string | null;
  notification_number: string | null;
  total_vacancies: number | null;
  application_start_date: string | null;
  application_end_date: string | null;
  raw_payload_json: string | null;
  canonical_identity_key?: string | null;
  status?: RecruitmentPublishingState;
  created_at: string;
  updated_at: string;
}

export type JobStatus = 'DRAFT' | 'VERIFIED' | 'DUPLICATE' | 'PUBLISHED' | 'ARCHIVED';

export interface JobEntity {
  id: string;
  recruitment_id: string;
  title: string;
  post_code: string | null;
  vacancies: number | null;
  pay_scale: string | null;
  age_limit_min: number | null;
  age_limit_max: number | null;
  qualification_summary: string | null;
  state: string | null;
  category: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
}

export type EvidenceEntityType = 'RECRUITMENT' | 'JOB';

export interface EvidenceEntity {
  id: string;
  entity_type: EvidenceEntityType;
  entity_id: string;
  field_name: string;
  source_document_id: string;
  snippet: string;
  page_number: number | null;
  confidence_score: number | null; // 0.0 - 1.0
  bounding_box_json: string | null;
  extracted_at: string;
}

export type PipelineStageName =
  | 'SOURCE_DISCOVERY'
  | 'DOCUMENT_DISCOVERY'
  | 'DOCUMENT_DOWNLOAD'
  | 'DOCUMENT_VALIDATION'
  | 'TEXT_EXTRACTION'
  | 'STRUCTURED_EXTRACTION'
  | 'EVIDENCE_VALIDATION'
  | 'DUPLICATE_CHECK'
  | 'PUBLISHING_GATE'
  | 'WORDPRESS_PUBLISH';

export type ProcessingJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIAL_FAILED'
  | 'PAUSED'
  | 'CANCELLED';

export interface ProcessingJobEntity {
  job_id: string;
  parent_job_id?: string | null;
  dedupe_key?: string | null;
  target_entity_type: string;
  target_entity_id: string;
  stage: PipelineStageName;
  status: ProcessingJobStatus;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  metadata_json: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  lease_expires_at?: string | null;
  next_retry_at?: string | null;
  last_heartbeat_at?: string | null;
  recovery_count?: number;
  last_recovery_reason?: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type DeduplicationResolution = 'UNRESOLVED' | 'CONFIRMED_DUPLICATE' | 'FALSE_POSITIVE' | 'MERGED';

export interface DeduplicationRecordEntity {
  id: string;
  primary_job_id: string;
  duplicate_job_id: string;
  similarity_score: number;
  strategy: string;
  resolution_status: DeduplicationResolution;
  notes: string | null;
  created_at: string;
}

export type PublishStatus = 'PENDING' | 'GATE_PASSED' | 'GATE_REJECTED' | 'PUBLISHED' | 'FAILED';

export interface PublishingRecordEntity {
  id: string;
  job_id: string;
  recruitment_id?: string | null;
  platform: string; // e.g., 'WORDPRESS'
  external_post_id: string | null;
  external_identity_key?: string | null;
  permalink?: string | null;
  post_status?: string | null;
  categories_json?: string | null;
  canonical_source_url?: string | null;
  official_pdf_url?: string | null;
  publish_status: PublishStatus;
  validation_check_passed: number; // 0 or 1
  published_at: string | null;
  updated_at?: string | null;
  payload_hash: string | null;
  error_message: string | null;
}

export interface AuditLogEntity {
  id: string;
  correlation_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  stage: string | null;
  status: string; // 'SUCCESS' | 'FAILURE' | 'INFO'
  details_json: string | null;
  created_at: string;
}

export interface ExtractionAuditEntity {
  id: string;
  document_id: string;
  recruitment_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  evidence_id: string | null;
  validation_status: string;
  reason: string;
  timestamp: string;
}

export interface CorrigendumAssociationEntity {
  id: string;
  original_recruitment_id: string | null;
  corrigendum_document_id: string;
  related_document_id: string | null;
  amendment_type: string;
  updated_field: string;
  source_page: number;
  old_value: string | null;
  new_value: string;
  evidence_snippet: string;
  effective_date: string | null;
  created_at: string;
}

export type DeduplicationDecisionType =
  | 'NEW_RECRUITMENT'
  | 'DUPLICATE_DOCUMENT'
  | 'DUPLICATE_RECRUITMENT'
  | 'RELATED_CORRIGENDUM'
  | 'RELATED_ADDENDUM'
  | 'REVISED_NOTIFICATION'
  | 'POSSIBLE_DUPLICATE'
  | 'UNRELATED';

export interface DeduplicationEvaluationEntity {
  id: string;
  incoming_document_id: string;
  matched_document_id: string | null;
  matched_recruitment_id: string | null;
  decision: DeduplicationDecisionType;
  confidence: number;
  matched_fields_json: string;
  reason: string;
  details_json: string | null;
  created_at: string;
}

export interface PublishingGateEvaluationEntity {
  id: string;
  recruitment_id: string;
  decision: 'ALLOWED' | 'BLOCKED';
  gate_state: RecruitmentPublishingState;
  reasons_json: string;
  critical_failures_json: string;
  warnings_json: string;
  summary_json: string;
  validation_version: string;
  evaluated_at: string;
}

export type AdapterExecutionStatus =
  | 'PASS'
  | 'FAIL'
  | 'SUCCESS'
  | 'SUCCESS_WITH_VALID_DOCUMENT'
  | 'SUCCESS_WITH_NOTICES'
  | 'SUCCESS_NO_RELEVANT_NOTICES'
  | 'ENDPOINT_WRONG_CONTENT'
  | 'ENDPOINT_PARSE_FAILED'
  | 'DOCUMENT_DISCOVERY_FAILED'
  | 'DOCUMENT_DOWNLOAD_FAILED'
  | 'PDF_VALIDATION_FAILED'
  | 'ADAPTER_STRUCTURE_CHANGED'
  | 'WRONG_ENDPOINT'
  | 'SOURCE_UNAVAILABLE'
  | 'ACCESS_BLOCKED'
  | 'PARSE_FAILED'
  | 'NETWORK_UNAVAILABLE'
  | 'INCONCLUSIVE'
  | 'DEGRADED';

export interface SourceDiscoveryRunEntity {
  id: string;
  source_id: string;
  started_at: string;
  completed_at: string;
  http_status: number | null;
  final_url: string | null;
  records_found: number;
  documents_found: number;
  adapter_status: AdapterExecutionStatus;
  error_code: string | null;
  error_message: string | null;
  metrics_json: string | null;
}

export interface OcrPageCacheEntity {
  id: string;
  document_checksum: string;
  page_number: number;
  provider: string;
  model_version: string;
  extracted_text: string;
  language: string;
  model_confidence: number | null;
  quality_score: number;
  confidence_source: string;
  status: string;
  char_count: number;
  word_count: number;
  metadata_json: string | null;
  created_at: string;
}




