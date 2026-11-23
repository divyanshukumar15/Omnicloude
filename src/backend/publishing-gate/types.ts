/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RecruitmentPublishingState } from '../database/types.ts';
import type { StructuredRecruitmentData, StructuredRecruitmentRecord } from '../extraction/types.ts';
import type { NormalizedDocument } from '../ingestion/types.ts';

export type { RecruitmentPublishingState };

export type CriticalFailureCode =
  | 'OFFICIAL_SOURCE_NOT_IDENTIFIED'
  | 'OFFICIAL_SOURCE_INACTIVE'
  | 'DOCUMENT_NOT_DOWNLOADED'
  | 'DOCUMENT_PDF_VALIDATION_FAILED'
  | 'DOCUMENT_PROVENANCE_MISSING'
  | 'SOURCE_CHECKSUM_MISSING'
  | 'ORGANIZATION_MISSING'
  | 'RECRUITMENT_TITLE_MISSING'
  | 'ADVERTISEMENT_NUMBER_MISSING'
  | 'TOTAL_VACANCIES_MISSING'
  | 'APPLICATION_START_DATE_MISSING'
  | 'APPLICATION_LAST_DATE_MISSING'
  | 'EDUCATIONAL_QUALIFICATION_MISSING'
  | 'AGE_INFORMATION_MISSING'
  | 'SELECTION_PROCESS_MISSING'
  | 'OFFICIAL_NOTIFICATION_URL_MISSING'
  | 'OFFICIAL_APPLICATION_URL_MISSING'
  | 'CRITICAL_EVIDENCE_MISSING'
  | 'EVIDENCE_SNIPPET_UNVERIFIED'
  | 'EVIDENCE_FOREIGN_DOCUMENT_LINKED'
  | 'INVALID_CALENDAR_DATE'
  | 'DATE_SEQUENCE_CONFLICT'
  | 'FIELD_RELATIONSHIP_CONFLICT'
  | 'DUPLICATE_UNRESOLVED'
  | 'CORRIGENDUM_CONFLICT_UNRESOLVED'
  | 'HALLUCINATED_FIELD_DETECTED'
  | 'NOT_APPLICABLE_WITHOUT_REASON';

export type UrlProvenanceTier = 'PDF_GROUNDED' | 'TRUSTED_METADATA' | 'UNVERIFIED';

export interface FieldVerificationItem {
  state: 'VERIFIED' | 'EXTRACTED' | 'NOT_APPLICABLE' | 'MISSING' | 'INVALID' | 'CONFLICT';
  hasEvidence: boolean;
  verifiedInDocument: boolean;
  provenanceType?: 'PAGE_EVIDENCE' | 'DOCUMENT_METADATA';
  metadataVerified?: boolean;
  urlProvenanceTier?: UrlProvenanceTier;
  pageNumber?: number;
  snippet?: string;
  notApplicableReason?: string;
  notes?: string;
}

export interface VerificationSummary {
  officialSourceIdentified: boolean;
  officialDocumentDownloaded: boolean;
  pdfValidationPassed: boolean;
  documentProvenanceStored: boolean;
  requiredFieldsExtracted: boolean;
  criticalEvidenceVerified: boolean;
  datesValid: boolean;
  noFieldConflicts: boolean;
  noUnresolvedDuplicates: boolean;
  noCorrigendumConflicts: boolean;
  recruitmentIdentityVerified: boolean;
  officialNotificationUrlPresent: boolean;
  officialApplicationUrlResolved: boolean;
  noHallucinationsPresent: boolean;
  sourceChecksumRecorded: boolean;
  urlProvenance?: Record<string, UrlProvenanceTier>;
  fieldsSummary: Record<string, FieldVerificationItem>;
}

export interface PublishingGateResult {
  allowed: boolean;
  blocked: boolean;
  state: RecruitmentPublishingState;
  reasons: string[];
  critical_failures: CriticalFailureCode[];
  warnings: string[];
  verification_summary: VerificationSummary;
  validation_version: string;
  evaluated_at: string;
}

export interface PublishingEvaluationTarget {
  recruitmentId: string;
  sourceId?: string;
  documentId?: string;
  title?: string;
  department?: string | null;
  notificationNumber?: string | null;
  totalVacancies?: number | null;
  applicationStartDate?: string | null;
  applicationEndDate?: string | null;
  rawPayloadJson?: string | null;
  status?: RecruitmentPublishingState;

  // Optional in-memory attachments for direct test/pipeline execution
  fields?: StructuredRecruitmentData;
  structuredRecord?: StructuredRecruitmentRecord;
  document?: NormalizedDocument | null;
  pages?: Array<{ pageNumber: number; extractedText: string }>;
}
