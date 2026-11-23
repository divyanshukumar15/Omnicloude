/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.ts';
export * from './date-validator.ts';
export * from './evidence-validator.ts';
export * from './field-validator.ts';
export * from './corrigendum-detector.ts';
export * from './extraction-service.ts';

import { StructuredExtractionService } from './extraction-service.ts';
import type { StructuredRecruitmentData, ExtractedField } from './types.ts';

let defaultExtractionService: StructuredExtractionService | null = null;

export function getExtractionService(): StructuredExtractionService {
  if (!defaultExtractionService) {
    defaultExtractionService = new StructuredExtractionService();
  }
  return defaultExtractionService;
}

export function createDefaultStructuredFields(_sourceId = 'DEFAULT', _documentId = 'DOC'): StructuredRecruitmentData {
  const missing = <T>(): ExtractedField<T> => ({
    value: null,
    state: 'MISSING',
    confidence: 0,
    evidence: null,
  });

  return {
    organization: missing<string>(),
    recruitment_title: missing<string>(),
    advertisement_number: missing<string>(),
    recruitment_type: missing<string>(),
    total_vacancies: missing<number>(),
    category_wise_vacancies: missing<any>(),
    application_start_date: missing<string>(),
    application_last_date: missing<string>(),
    correction_last_date: missing<string>(),
    exam_date: missing<string>(),
    admit_card_date: missing<string>(),
    result_date: missing<string>(),
    application_fee: missing<any>(),
    age_min: missing<number>(),
    age_max: missing<number>(),
    age_relaxation: missing<any>(),
    educational_qualification: missing<string>(),
    experience: missing<string>(),
    salary_pay_level: missing<string>(),
    selection_process: missing<any>(),
    exam_pattern: missing<string>(),
    negative_marking: missing<string>(),
    syllabus: missing<string>(),
    required_documents: missing<string[]>(),
    important_instructions: missing<string[]>(),
    official_notification_url: missing<string>(),
    official_application_url: missing<string>(),
  };
}

