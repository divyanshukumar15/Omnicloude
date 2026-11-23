/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExtractedField,
  StructuredRecruitmentData,
  ApplicationFeeStructure,
  CategoryWiseVacancies,
} from './types.ts';
import { DateValidator } from './date-validator.ts';
import type { NormalizedPage } from '../ingestion/types.ts';

export interface FieldValidationIssue {
  field: string;
  type: 'INVALID' | 'CONFLICT' | 'CONTAMINATION' | 'HALLUCINATION';
  reason: string;
  oldValue: unknown;
  newValue: unknown;
}

export class DeterministicFieldValidator {
  /**
   * Deterministically validates all fields, numbers, dates, and relationships.
   * Returns a list of identified issues and mutates field state safely with evidence retained.
   */
  public static validateAll(
    fields: StructuredRecruitmentData,
    documentId: string,
    pages: NormalizedPage[]
  ): FieldValidationIssue[] {
    const issues: FieldValidationIssue[] = [];

    // 1. Vacancy Numbers Validation
    if (fields.total_vacancies.value !== null) {
      const vacancies = fields.total_vacancies.value;
      if (typeof vacancies !== 'number' || isNaN(vacancies) || !Number.isInteger(vacancies) || vacancies < 0) {
        const reason = `Negative or non-integer total vacancies (${vacancies}) is invalid`;
        issues.push({
          field: 'total_vacancies',
          type: 'INVALID',
          reason,
          oldValue: vacancies,
          newValue: vacancies,
        });
        fields.total_vacancies.state = 'INVALID';
        fields.total_vacancies.validationNotes = reason;
      }
    }

    // Category-wise vacancies validation
    if (fields.category_wise_vacancies.value) {
      const cat = fields.category_wise_vacancies.value;
      const categories: Array<keyof CategoryWiseVacancies> = ['ur', 'obc', 'ews', 'sc', 'st', 'female', 'pwd', 'esm'];
      for (const c of categories) {
        const val = cat[c];
        if (typeof val === 'number' && (isNaN(val) || val < 0)) {
          const reason = `Category ${c} has invalid negative vacancy: ${val}`;
          issues.push({
            field: 'category_wise_vacancies',
            type: 'INVALID',
            reason,
            oldValue: val,
            newValue: val,
          });
          fields.category_wise_vacancies.state = 'INVALID';
          fields.category_wise_vacancies.validationNotes = reason;
          break;
        }
      }
    }

    // 2. Application Fee Numbers Validation
    if (fields.application_fee.value) {
      const fee = fields.application_fee.value;
      if (typeof fee.unreserved === 'number' && (isNaN(fee.unreserved) || fee.unreserved < 0)) {
        const reason = `Application fee cannot be negative: ${fee.unreserved}`;
        issues.push({
          field: 'application_fee',
          type: 'INVALID',
          reason,
          oldValue: fee.unreserved,
          newValue: fee.unreserved,
        });
        fields.application_fee.state = 'INVALID';
        fields.application_fee.validationNotes = reason;
      }
    }

    // 3. Age Limits & Age Relationship Validation
    const ageMin = fields.age_min.value;
    const ageMax = fields.age_max.value;

    if (ageMin !== null) {
      if (typeof ageMin !== 'number' || isNaN(ageMin) || ageMin < 14 || ageMin > 75) {
        const reason = `Minimum age (${ageMin}) is outside acceptable government job limits (14-75)`;
        issues.push({
          field: 'age_min',
          type: 'INVALID',
          reason,
          oldValue: ageMin,
          newValue: ageMin,
        });
        fields.age_min.state = 'INVALID';
        fields.age_min.validationNotes = reason;
      }
    }

    if (ageMax !== null) {
      if (typeof ageMax !== 'number' || isNaN(ageMax) || ageMax < 14 || ageMax > 75) {
        const reason = `Maximum age (${ageMax}) is outside acceptable government job limits (14-75)`;
        issues.push({
          field: 'age_max',
          type: 'INVALID',
          reason,
          oldValue: ageMax,
          newValue: ageMax,
        });
        fields.age_max.state = 'INVALID';
        fields.age_max.validationNotes = reason;
      }
    }

    if (typeof ageMin === 'number' && typeof ageMax === 'number' && ageMin > ageMax) {
      const reason = `Age relationship conflict: minimum age (${ageMin}) cannot exceed maximum age (${ageMax})`;
      issues.push({
        field: 'age_min',
        type: 'CONFLICT',
        reason,
        oldValue: ageMin,
        newValue: ageMin,
      });
      issues.push({
        field: 'age_max',
        type: 'CONFLICT',
        reason,
        oldValue: ageMax,
        newValue: ageMax,
      });
      fields.age_min.state = 'CONFLICT';
      fields.age_max.state = 'CONFLICT';
      fields.age_min.validationNotes = reason;
      fields.age_max.validationNotes = reason;
    }

    // 4. Date Relationship Validation (Start Date vs Last Date)
    const startDate = fields.application_start_date.value;
    const lastDate = fields.application_last_date.value;

    if (startDate && lastDate) {
      const seqCheck = DateValidator.validateDateSequence(startDate, lastDate);
      if (seqCheck.isConflict) {
        const reason = seqCheck.message || 'Start date cannot be after last date';
        issues.push({
          field: 'application_start_date',
          type: 'CONFLICT',
          reason,
          oldValue: startDate,
          newValue: startDate,
        });
        issues.push({
          field: 'application_last_date',
          type: 'CONFLICT',
          reason,
          oldValue: lastDate,
          newValue: lastDate,
        });
        fields.application_start_date.state = 'CONFLICT';
        fields.application_last_date.state = 'CONFLICT';
        fields.application_start_date.validationNotes = reason;
        fields.application_last_date.validationNotes = reason;
      }
    }

    // 5. Cross-Recruitment Contamination & Hallucination Check
    for (const [key, field] of Object.entries(fields)) {
      if (!field || field.state === 'MISSING' || field.value === null) {
        continue;
      }

      // Check cross-recruitment contamination
      const evidenceDocId = field.evidence?.document_id || field.evidence?.documentId;
      if (evidenceDocId && evidenceDocId !== documentId) {
        const reason = `Cross-recruitment contamination: evidence references foreign document ${evidenceDocId} instead of current ${documentId}`;
        issues.push({
          field: key,
          type: 'CONTAMINATION',
          reason,
          oldValue: field.value,
          newValue: null,
        });
        field.state = 'INVALID';
        field.confidence = 0;
        field.validationNotes = reason;
        if (field.evidence) {
          field.evidence.verified_in_document = false;
          field.evidence.verifiedInDocument = false;
        }
      }
    }

    return issues;
  }
}
