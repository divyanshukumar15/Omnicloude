/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DeduplicationDecisionType } from '../database/types.ts';

export type { DeduplicationDecisionType };

export interface FieldMutationRecord {
  field_name: string;
  original_value: unknown;
  new_value: unknown;
  source_document_id: string;
  page_number: number;
  evidence_text: string;
  effective_change:
    | 'EXTENSION_OF_LAST_DATE'
    | 'VACANCY_REVISION'
    | 'EXAM_RESCHEDULED'
    | 'AGE_LIMIT_REVISION'
    | 'FEE_MODIFICATION'
    | 'QUALIFICATION_UPDATE'
    | 'ADDENDUM_ADDITIONAL_POSTS'
    | 'GENERAL_AMENDMENT';
  timestamp: string;
}

export interface DeduplicationDecisionSourceDocuments {
  incomingDocumentId: string;
  matchedDocumentId?: string;
  matchedRecruitmentId?: string;
  incomingChecksum?: string;
  matchedChecksum?: string;
  incomingUrl?: string;
  matchedUrl?: string;
}

export interface DeduplicationDecision {
  decision: DeduplicationDecisionType;
  confidence: number; // 0.0 - 1.0
  matched_fields: string[];
  reason: string;
  source_documents: DeduplicationDecisionSourceDocuments;
  field_mutations: FieldMutationRecord[];
  details?: {
    exactChecksumMatch?: boolean;
    canonicalUrlMatch?: boolean;
    advertisementNumberMatch?: boolean;
    organizationMatch?: boolean;
    titleSimilarityScore?: number;
    textFingerprintSimilarity?: number;
    vacanciesMatch?: boolean;
    datesMatch?: boolean;
    corrigendumKeywords?: string[];
    amendmentScope?: string;
    parentAdvertisementReferenced?: string | null;
  };
}

export interface DeduplicationEvaluationCandidate {
  recruitmentId: string;
  documentId: string;
  organization: string;
  recruitmentTitle: string;
  advertisementNumber: string | null;
  totalVacancies: number | null;
  applicationStartDate: string | null;
  applicationLastDate: string | null;
  examDate?: string | null;
  checksumSha256: string;
  canonicalUrl?: string | null;
  sourceUrl?: string | null;
  fullText?: string;
}
