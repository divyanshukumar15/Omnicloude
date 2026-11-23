/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type FieldValidationState =
  | 'EXTRACTED'
  | 'VERIFIED'
  | 'MISSING'
  | 'CONFLICT'
  | 'INVALID'
  | 'NOT_APPLICABLE';

export type RecruitmentValidationStatus =
  | 'EXTRACTION_PENDING'
  | 'PARTIALLY_VERIFIED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'CONFLICT'
  | 'PARTIAL'      // Backwards compatibility alias
  | 'UNVERIFIED';  // Backwards compatibility alias

export type EvidenceProvenanceType = 'PAGE_EVIDENCE' | 'DOCUMENT_METADATA';

export interface FieldEvidence {
  document_id: string;
  page_number: number;
  field_name: string;
  evidence_text: string;
  extraction_method: 'DIRECT_TEXT' | 'OCR' | 'TABLE_EXTRACTION' | 'DOCUMENT_METADATA';
  verified_in_document: boolean;
  provenance_type?: EvidenceProvenanceType;
  metadata_verified?: boolean;
  char_offset_start?: number;
  char_offset_end?: number;
  ocr_result_id?: string;
  provider?: string;
  model_version?: string;
  quality_score?: number;
  timestamp?: string;

  // Backwards compatibility aliases
  documentId?: string;
  pageNumber?: number;
  snippet?: string;
  verifiedInDocument?: boolean;
  charOffsetStart?: number;
  charOffsetEnd?: number;
}

export interface ExtractedField<T> {
  value: T | null;
  state: FieldValidationState;
  confidence: number; // 0.0 - 1.0
  evidence: FieldEvidence | null;
  validationNotes?: string;
  notApplicableReason?: string;
}

export interface ApplicationFeeStructure {
  unreserved?: number | null;
  obc?: number | null;
  ews?: number | null;
  sc?: number | null;
  st?: number | null;
  female?: number | null;
  pwd?: number | null;
  exemptionDetails?: string | null;
  rawSnippet?: string;
}

export interface CategoryWiseVacancies {
  ur?: number;
  obc?: number;
  ews?: number;
  sc?: number;
  st?: number;
  female?: number;
  pwd?: number;
  esm?: number;
  other?: Record<string, number>;
}

export interface StructuredRecruitmentData {
  // Identity & Authority
  organization: ExtractedField<string>;
  recruitment_title: ExtractedField<string>;
  advertisement_number: ExtractedField<string>;
  recruitment_type: ExtractedField<string>; // 'DIRECT' | 'PROMOTION' | 'DEPUTATION' | 'CONTRACT' | 'GENERAL'
  post_names?: ExtractedField<string[]>;

  // Vacancies
  total_vacancies: ExtractedField<number>;
  category_wise_vacancies: ExtractedField<CategoryWiseVacancies>;

  // Critical Calendar Dates (strictly validated ISO YYYY-MM-DD or formatted)
  application_start_date: ExtractedField<string>;
  application_last_date: ExtractedField<string>;
  correction_last_date: ExtractedField<string>;
  exam_date: ExtractedField<string>;
  admit_card_date: ExtractedField<string>;
  result_date: ExtractedField<string>;

  // Financials & Age
  application_fee: ExtractedField<ApplicationFeeStructure>;
  age_min: ExtractedField<number>;
  age_max: ExtractedField<number>;
  age_relaxation: ExtractedField<Record<string, string | number>>;

  // Eligibility & Compensation
  educational_qualification: ExtractedField<string>;
  experience: ExtractedField<string>;
  salary_pay_level: ExtractedField<string>;

  // Selection & Syllabus
  selection_process: ExtractedField<string[] | string>;
  exam_pattern: ExtractedField<string>;
  negative_marking: ExtractedField<string>;
  syllabus: ExtractedField<string>;

  // Instructions & Portals
  required_documents: ExtractedField<string[]>;
  important_instructions: ExtractedField<string[]>;
  official_notification_url: ExtractedField<string>;
  official_application_url: ExtractedField<string>;
  official_source_url?: ExtractedField<string>;
}

export interface StructuredRecruitmentRecord {
  id: string;
  canonicalIdentityKey?: string;
  persisted?: boolean;
  sourceId: string;
  documentId: string;
  overallStatus: RecruitmentValidationStatus;
  isCorrigendum: boolean;
  relatedRecruitmentId?: string | null;
  corrigendumNotes?: string | null;
  languageDetected: 'HINDI' | 'ENGLISH' | 'BILINGUAL';
  fields: StructuredRecruitmentData;
  extractionTimestamp: string;
  auditTrail: Array<{
    action: string;
    field?: string;
    status: string;
    message: string;
    timestamp: string;
  }>;
}

export interface ExtractionAuditRecord {
  id: string;
  document_id: string;
  recruitment_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  evidence_id: string | null;
  validation_status: FieldValidationState;
  reason: string;
  timestamp: string;
}

export interface CorrigendumUpdatedField {
  fieldName: string;
  oldValue?: unknown;
  newValue: unknown;
  sourcePage: number;
  evidenceText: string;
  effectiveDate: string | null;
}

export interface CorrigendumAssociation {
  id: string;
  originalRecruitmentId: string | null;
  originalAdvertisementNumber: string | null;
  corrigendumDocumentId: string;
  relatedDocumentId: string | null;
  amendmentType: 'CORRIGENDUM' | 'ADDENDUM' | 'CANCELLATION' | 'EXTENSION' | 'GENERAL';
  updatedFields: CorrigendumUpdatedField[];
  effectiveDate: string | null;
  detectedAt: string;
  notes?: string | null;
}

/**
 * Fields strictly required to be verified with source evidence for a recruitment to achieve VERIFIED status.
 */
export const CRITICAL_RECRUITMENT_FIELDS: ReadonlyArray<keyof StructuredRecruitmentData> = [
  'organization',
  'recruitment_title',
  'advertisement_number',
  'total_vacancies',
  'application_last_date',
  'educational_qualification',
  'official_notification_url',
] as const;

/**
 * Optional fields that do not block a recruitment from being marked VERIFIED if they are unmentioned.
 */
export const OPTIONAL_RECRUITMENT_FIELDS: ReadonlyArray<keyof StructuredRecruitmentData> = [
  'recruitment_type',
  'category_wise_vacancies',
  'application_start_date',
  'correction_last_date',
  'exam_date',
  'admit_card_date',
  'result_date',
  'application_fee',
  'age_min',
  'age_max',
  'age_relaxation',
  'experience',
  'salary_pay_level',
  'selection_process',
  'exam_pattern',
  'negative_marking',
  'syllabus',
  'required_documents',
  'important_instructions',
  'official_application_url',
] as const;

export type PersistenceErrorCode =
  | 'DB_PERSISTENCE_TRANSIENT'
  | 'DB_PERSISTENCE_PERMANENT';

export function classifyPersistenceError(err: unknown): {
  code: PersistenceErrorCode;
  retryable: boolean;
} {
  const errObj = err as { code?: unknown; errcode?: unknown; message?: unknown } | null | undefined;
  const rawCode = String(errObj?.code ?? '').toUpperCase();
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (
    rawCode.includes('SQLITE_BUSY') ||
    rawCode.includes('SQLITE_LOCKED') ||
    rawCode.includes('SQLITE_IOERR') ||
    rawCode.includes('SQLITE_PROTOCOL') ||
    /database\s+(is\s+)?locked|database\s+table\s+is\s+locked|sqlite_busy|sqlite_locked|sqlite_ioerr|busy_timeout|temporarily\s+unavailable/i.test(
      message
    )
  ) {
    return { code: 'DB_PERSISTENCE_TRANSIENT', retryable: true };
  }

  return { code: 'DB_PERSISTENCE_PERMANENT', retryable: false };
}

export class RecruitmentPersistenceError extends Error {
  public readonly code: PersistenceErrorCode;
  public readonly retryable: boolean;
  public readonly stage = 'PERSISTENCE';
  public readonly causeError?: unknown;

  constructor(
    message: string,
    options: { code: PersistenceErrorCode; retryable: boolean; cause?: unknown }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RecruitmentPersistenceError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.causeError = options.cause;
  }
}

