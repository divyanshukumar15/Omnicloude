-- OmniHub GovJobs Automation AI Database Schema
-- Compatible with SQLite (initial development) and structured for easy migration to PostgreSQL

PRAGMA foreign_keys = ON;

-- 1. Sources table: portals, feeds, and websites being monitored
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('PORTAL', 'RSS', 'API', 'DIRECT_PAGE')),
  base_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  check_interval_minutes INTEGER NOT NULL DEFAULT 60,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Source Documents table: links/files discovered from sources
CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  document_type TEXT,
  raw_hash TEXT,
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK(status IN ('DISCOVERED', 'DOWNLOADING', 'DOWNLOADED', 'FAILED', 'IGNORED')),
  metadata_json TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- 3. Documents table: downloaded physical files with hashes, provenance, and validation
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL,
  source_url TEXT,
  canonical_url TEXT,
  source_domain TEXT,
  file_path TEXT,
  file_size INTEGER,
  page_count INTEGER,
  mime_type TEXT,
  sha256_hash TEXT,
  storage_uri TEXT,
  downloaded_at TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'UNVALIDATED' CHECK(validation_status IN ('UNVALIDATED', 'VALID', 'INVALID', 'CORRUPTED')),
  validation_notes TEXT,
  extraction_status TEXT DEFAULT 'PENDING' CHECK(extraction_status IN ('PENDING', 'EXTRACTED', 'OCR_REQUIRED', 'FAILED', 'OCR_SUCCESS', 'OCR_LOW_QUALITY', 'OCR_UNAVAILABLE', 'OCR_TIMEOUT', 'OCR_PARTIAL', 'OCR_LIMIT_EXCEEDED')),
  extraction_method TEXT,
  is_scanned INTEGER DEFAULT 0,
  FOREIGN KEY (source_document_id) REFERENCES source_documents(id) ON DELETE CASCADE
);

-- 3b. Document Pages table: retains page-level provenance and extracted content
CREATE TABLE IF NOT EXISTS document_pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  extracted_text TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  is_scanned INTEGER NOT NULL DEFAULT 0,
  quality_score REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 4. Recruitments table: top-level recruitment advertisements/notifications
CREATE TABLE IF NOT EXISTS recruitments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  document_id TEXT,
  title TEXT NOT NULL,
  department TEXT,
  notification_number TEXT,
  total_vacancies INTEGER,
  application_start_date TEXT,
  application_end_date TEXT,
  raw_payload_json TEXT,
  canonical_identity_key TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'VALIDATING', 'VERIFIED', 'PUBLISH_READY', 'PUBLISH_BLOCKED', 'REJECTED', 'CONFLICT')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- 5. Jobs table: individual job posts/cadres under a recruitment
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  recruitment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  post_code TEXT,
  vacancies INTEGER,
  pay_scale TEXT,
  age_limit_min INTEGER,
  age_limit_max INTEGER,
  qualification_summary TEXT,
  state TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'VERIFIED', 'DUPLICATE', 'PUBLISHED', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (recruitment_id) REFERENCES recruitments(id) ON DELETE CASCADE
);

-- 6. Evidence table: ground truth snippets, page numbers, and confidence for claims
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('RECRUITMENT', 'JOB')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  snippet TEXT NOT NULL,
  page_number INTEGER,
  confidence_score REAL,
  bounding_box_json TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES source_documents(id)
);

-- 7. Processing Jobs table: state machine tracking job execution
CREATE TABLE IF NOT EXISTS processing_jobs (
  job_id TEXT PRIMARY KEY,
  parent_job_id TEXT,
  dedupe_key TEXT,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL_FAILED', 'PAUSED', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  next_retry_at TEXT,
  last_heartbeat_at TEXT,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  last_recovery_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

-- 8. Deduplication Records table: candidate/confirmed duplicates across postings
CREATE TABLE IF NOT EXISTS deduplication_records (
  id TEXT PRIMARY KEY,
  primary_job_id TEXT NOT NULL,
  duplicate_job_id TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  strategy TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK(resolution_status IN ('UNRESOLVED', 'CONFIRMED_DUPLICATE', 'FALSE_POSITIVE', 'MERGED')),
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (primary_job_id) REFERENCES jobs(id),
  FOREIGN KEY (duplicate_job_id) REFERENCES jobs(id)
);

-- 9. Publishing Records table: external destination publishing state
CREATE TABLE IF NOT EXISTS publishing_records (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  recruitment_id TEXT,
  platform TEXT NOT NULL,
  external_post_id TEXT,
  external_identity_key TEXT,
  permalink TEXT,
  post_status TEXT,
  categories_json TEXT,
  canonical_source_url TEXT,
  official_pdf_url TEXT,
  publish_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(publish_status IN ('PENDING', 'GATE_PASSED', 'GATE_REJECTED', 'PUBLISHED', 'FAILED')),
  validation_check_passed INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  updated_at TEXT,
  payload_hash TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_publishing_job ON publishing_records(job_id);

-- 10. Audit Logs table: immutable audit trail for every pipeline transition
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  stage TEXT,
  status TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

-- 11. Extraction Audit Records table: field-level value mutation and decision traceability
CREATE TABLE IF NOT EXISTS extraction_audit_records (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  recruitment_id TEXT,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  evidence_id TEXT,
  validation_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 12. Corrigendum Associations table: links amendments/corrigendums to parent recruitments
CREATE TABLE IF NOT EXISTS corrigendum_associations (
  id TEXT PRIMARY KEY,
  original_recruitment_id TEXT,
  corrigendum_document_id TEXT NOT NULL,
  related_document_id TEXT,
  amendment_type TEXT NOT NULL,
  updated_field TEXT NOT NULL,
  source_page INTEGER NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  evidence_snippet TEXT NOT NULL,
  effective_date TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (original_recruitment_id) REFERENCES recruitments(id) ON DELETE SET NULL,
  FOREIGN KEY (corrigendum_document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Indexes for performance and quick query lookup
CREATE INDEX IF NOT EXISTS idx_source_docs_source ON source_documents(source_id);
CREATE INDEX IF NOT EXISTS idx_docs_source_doc ON documents(source_document_id);
CREATE INDEX IF NOT EXISTS idx_recruitments_source ON recruitments(source_id);
CREATE INDEX IF NOT EXISTS idx_jobs_recruitment ON jobs(recruitment_id);
CREATE INDEX IF NOT EXISTS idx_evidence_target ON evidence(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status, stage);
CREATE INDEX IF NOT EXISTS idx_audit_logs_corr ON audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_doc_pages_doc ON document_pages(document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_extraction_audit_doc ON extraction_audit_records(document_id, field);
CREATE INDEX IF NOT EXISTS idx_corrigendum_orig ON corrigendum_associations(original_recruitment_id);

-- 13. Deduplication Evaluations table: stores multi-level explainable decisions
CREATE TABLE IF NOT EXISTS deduplication_evaluations (
  id TEXT PRIMARY KEY,
  incoming_document_id TEXT NOT NULL,
  matched_document_id TEXT,
  matched_recruitment_id TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('NEW_RECRUITMENT', 'DUPLICATE_DOCUMENT', 'DUPLICATE_RECRUITMENT', 'RELATED_CORRIGENDUM', 'RELATED_ADDENDUM', 'REVISED_NOTIFICATION', 'POSSIBLE_DUPLICATE', 'UNRELATED')),
  confidence REAL NOT NULL,
  matched_fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dedup_eval_incoming ON deduplication_evaluations(incoming_document_id);
CREATE INDEX IF NOT EXISTS idx_dedup_eval_matched ON deduplication_evaluations(matched_recruitment_id);

-- 14. Publishing Gate Evaluations table: stores gate verification decisions & audit trail
CREATE TABLE IF NOT EXISTS publishing_gate_evaluations (
  id TEXT PRIMARY KEY,
  recruitment_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('ALLOWED', 'BLOCKED')),
  gate_state TEXT NOT NULL CHECK(gate_state IN ('DRAFT', 'VALIDATING', 'VERIFIED', 'PUBLISH_READY', 'PUBLISH_BLOCKED', 'REJECTED', 'CONFLICT')),
  reasons_json TEXT NOT NULL,
  critical_failures_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  validation_version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publishing_gate_rec ON publishing_gate_evaluations(recruitment_id, evaluated_at);

-- 15. Source Discovery Runs table: records live controlled discovery execution path & observability
CREATE TABLE IF NOT EXISTS source_discovery_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  http_status INTEGER,
  final_url TEXT,
  records_found INTEGER NOT NULL DEFAULT 0,
  documents_found INTEGER NOT NULL DEFAULT 0,
  adapter_status TEXT NOT NULL CHECK(adapter_status IN (
    'PASS',
    'FAIL',
    'SUCCESS',
    'SUCCESS_WITH_VALID_DOCUMENT',
    'SUCCESS_WITH_NOTICES',
    'SUCCESS_NO_RELEVANT_NOTICES',
    'ENDPOINT_WRONG_CONTENT',
    'ENDPOINT_PARSE_FAILED',
    'DOCUMENT_DISCOVERY_FAILED',
    'DOCUMENT_DOWNLOAD_FAILED',
    'PDF_VALIDATION_FAILED',
    'ADAPTER_STRUCTURE_CHANGED',
    'WRONG_ENDPOINT',
    'SOURCE_UNAVAILABLE',
    'ACCESS_BLOCKED',
    'PARSE_FAILED',
    'NETWORK_UNAVAILABLE',
    'INCONCLUSIVE',
    'DEGRADED'
  )),
  error_code TEXT,
  error_message TEXT,
  metrics_json TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_source ON source_discovery_runs(source_id, started_at);

-- 15b. Schema Migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 16. Persistent OCR Page Cache: caches extracted page text across process restarts
CREATE TABLE IF NOT EXISTS ocr_page_cache (
  id TEXT PRIMARY KEY,
  document_checksum TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model_version TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  language TEXT NOT NULL,
  model_confidence REAL,
  quality_score REAL NOT NULL,
  confidence_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OCR_SUCCESS', 'OCR_LOW_QUALITY', 'OCR_FAILED', 'OCR_TIMEOUT', 'OCR_PARTIAL', 'OCR_LIMIT_EXCEEDED')),
  char_count INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(document_checksum, page_number, provider, model_version)
);

CREATE INDEX IF NOT EXISTS idx_ocr_cache_lookup ON ocr_page_cache(document_checksum, page_number, provider, model_version);



