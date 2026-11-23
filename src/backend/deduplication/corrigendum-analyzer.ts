/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NormalizedPage } from '../ingestion/types.ts';
import type { StructuredRecruitmentData } from '../extraction/types.ts';
import type { FieldMutationRecord, DeduplicationDecisionType } from './types.ts';

export interface CorrigendumAnalysis {
  isCorrigendum: boolean;
  decisionType: DeduplicationDecisionType;
  confidence: number;
  matchedKeywords: string[];
  referencedAdvertisementNumber: string | null;
  amendmentScope:
    | 'DATE_EXTENSION'
    | 'VACANCY_REVISION'
    | 'EXAM_RESCHEDULED'
    | 'ADDENDUM'
    | 'REVISED_NOTIFICATION'
    | 'QUALIFICATION_UPDATE'
    | 'GENERAL_AMENDMENT';
  reason: string;
}

export class CorrigendumAnalyzer {
  private static readonly CORRIGENDUM_PATTERNS = [
    // English
    { keyword: 'corrigendum', pattern: /\bcorrigendum\b/i, weight: 0.95, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'addendum', pattern: /\baddendum\b/i, weight: 0.95, decision: 'RELATED_ADDENDUM' as const },
    { keyword: 'amendment', pattern: /\b(notice\s+for\s+)?amendment\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'revised notification', pattern: /\brevised\s+(official\s+)?notification\b/i, weight: 0.95, decision: 'REVISED_NOTIFICATION' as const },
    { keyword: 'partial modification', pattern: /\bpartial\s+modification\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'extension of last date', pattern: /\bextension\s+of\s+(the\s+)?(last|closing)\s+date\b/i, weight: 0.95, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'date extended', pattern: /\bdate\s+(has\s+been\s+)?extended\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'rescheduled', pattern: /\b(exam(ination)?|schedule)\s+(is|has\s+been)?\s*rescheduled\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'vacancy revised', pattern: /\bvacanc(ies|y)\s+(is|have\s+been)?\s*revised\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'modified vacancy', pattern: /\bmodified\s+vacanc(ies|y)\b/i, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },

    // Hindi
    { keyword: 'शुद्धिपत्र', pattern: /शुद्धि[\s\-]?पत्र/u, weight: 0.95, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'संशोधन', pattern: /(आंशिक\s+)?संशोधन\s*(सूचना|विज्ञप्ति|पत्र)?/u, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'तिथि विस्तार', pattern: /तिथि\s+विस्तार|अंतिम\s+तिथि\s+विस्तार/u, weight: 0.95, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'संशोधित विज्ञप्ति', pattern: /संशोधित\s+(विज्ञप्ति|अधिसूचना|परीक्षा)/u, weight: 0.95, decision: 'REVISED_NOTIFICATION' as const },
    { keyword: 'अनुपूरक', pattern: /अनुपूरक\s+(विज्ञापन|अधिसूचना|पद)/u, weight: 0.9, decision: 'RELATED_ADDENDUM' as const },
    { keyword: 'परीक्षा स्थगित / पुनः निर्धारित', pattern: /(परीक्षा\s+स्थगित|पुनः\s*निर्धारित|परीक्षा\s+कार्यक्रम\s+संशोधन)/u, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
    { keyword: 'पद संशोधन', pattern: /(पद\s*संख्या\s*संशोधन|रिक्तियों\s*का\s*संशोधन)/u, weight: 0.9, decision: 'RELATED_CORRIGENDUM' as const },
  ];

  /**
   * Evaluates document pages and title to identify whether the document is a corrigendum,
   * addendum, or revised notification, and extracts the referenced advertisement number.
   */
  public static analyze(
    title: string,
    pages: NormalizedPage[]
  ): CorrigendumAnalysis {
    const combinedHeader = [
      title,
      pages.find((p) => p.pageNumber === 1)?.extractedText.slice(0, 2000) || '',
      pages.find((p) => p.pageNumber === 2)?.extractedText.slice(0, 1500) || '',
    ].join('\n');

    const matchedKeywords: string[] = [];
    let highestWeight = 0;
    let decisionType: DeduplicationDecisionType = 'RELATED_CORRIGENDUM';

    for (const item of this.CORRIGENDUM_PATTERNS) {
      if (item.pattern.test(combinedHeader)) {
        matchedKeywords.push(item.keyword);
        if (item.weight > highestWeight) {
          highestWeight = item.weight;
          decisionType = item.decision;
        }
      }
    }

    if (matchedKeywords.length === 0) {
      return {
        isCorrigendum: false,
        decisionType: 'NEW_RECRUITMENT',
        confidence: 0,
        matchedKeywords: [],
        referencedAdvertisementNumber: null,
        amendmentScope: 'GENERAL_AMENDMENT',
        reason: 'No corrigendum or addendum markers detected in official document text',
      };
    }

    // Determine amendment scope
    let scope: CorrigendumAnalysis['amendmentScope'] = 'GENERAL_AMENDMENT';
    if (decisionType === 'RELATED_ADDENDUM') {
      scope = 'ADDENDUM';
    } else if (decisionType === 'REVISED_NOTIFICATION') {
      scope = 'REVISED_NOTIFICATION';
    } else if (/date|तिथि|last date|closing date|विस्तार/i.test(combinedHeader) && /extension|extended|विस्तार/i.test(combinedHeader)) {
      scope = 'DATE_EXTENSION';
    } else if (/vacanc|पद|रिक्त/i.test(combinedHeader) && /revis|संशोध|modified/i.test(combinedHeader)) {
      scope = 'VACANCY_REVISION';
    } else if (/exam|schedule|rescheduled|परीक्षा|स्थगित|पुनः/i.test(combinedHeader)) {
      scope = 'EXAM_RESCHEDULED';
    } else if (/qualification|योग्यता/i.test(combinedHeader)) {
      scope = 'QUALIFICATION_UPDATE';
    }

    // Extract referenced parent advertisement number
    const referencedAdvt = this.extractReferencedAdvertisement(combinedHeader);

    return {
      isCorrigendum: true,
      decisionType,
      confidence: highestWeight,
      matchedKeywords,
      referencedAdvertisementNumber: referencedAdvt,
      amendmentScope: scope,
      reason: `Official ${decisionType.replace('_', ' ').toLowerCase()} identified with markers: ${matchedKeywords.join(', ')}`,
    };
  }

  /**
   * Extracts referenced parent advertisement numbers with prefixes like Ref:, Advt No., सन्दर्भ:, etc.
   */
  private static extractReferencedAdvertisement(headerText: string): string | null {
    const patterns = [
      /(?:reference|ref\.?)\s*[:\-]?\s*(?:notice\s*(?:no\.?)?|advt\.?\s*(?:no\.?)?|notification\s*(?:no\.?)?|cen\s*(?:no\.?)?)?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/i,
      /(?:सन्दर्भ|संदर्भ|पत्रांक)\s*[:\-]?\s*(?:विज्ञप्ति\s*(?:संख्या)?|विज्ञापन\s*(?:संख्या)?)?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/u,
      /(?:in\s+continuation\s+to\s+(?:notice|advt\.?|advertisement)\s+no\.?)\s*[:\-]?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/i,
      /(?:विज्ञापन\s*संख्या|विज्ञप्ति\s*संख्या)\s*[:\-]?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/u,
      /(?:advt\.?\s*no\.?|notification\s*no\.?|cen\s*no\.?)\s*[:\-]?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/i,
    ];

    for (const pat of patterns) {
      const match = headerText.match(pat);
      if (match && match[1] && match[1].trim().length >= 3) {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Detects field-level mutations between an original recruitment and an incoming corrigendum,
   * preserving both original and new values with exact page provenance.
   */
  public static detectMutations(
    originalRecruitment: {
      application_end_date: string | null;
      total_vacancies: number | null;
      title: string;
      raw_payload_json: string | null;
    },
    incomingFields: StructuredRecruitmentData,
    incomingDocId: string
  ): FieldMutationRecord[] {
    const mutations: FieldMutationRecord[] = [];
    const now = new Date().toISOString();

    // 1. Check Application Last Date Extension
    const incomingLastDate = incomingFields.application_last_date.value;
    if (incomingLastDate && incomingLastDate !== originalRecruitment.application_end_date) {
      const evidence = incomingFields.application_last_date.evidence;
      mutations.push({
        field_name: 'application_last_date',
        original_value: originalRecruitment.application_end_date,
        new_value: incomingLastDate,
        source_document_id: incomingDocId,
        page_number: evidence?.page_number ?? 1,
        evidence_text: evidence?.evidence_text ?? `Last date revised to ${incomingLastDate}`,
        effective_change: 'EXTENSION_OF_LAST_DATE',
        timestamp: now,
      });
    }

    // 2. Check Vacancy Revision
    const incomingVacancies = incomingFields.total_vacancies.value;
    if (
      typeof incomingVacancies === 'number' &&
      incomingVacancies > 0 &&
      incomingVacancies !== originalRecruitment.total_vacancies
    ) {
      const evidence = incomingFields.total_vacancies.evidence;
      mutations.push({
        field_name: 'total_vacancies',
        original_value: originalRecruitment.total_vacancies,
        new_value: incomingVacancies,
        source_document_id: incomingDocId,
        page_number: evidence?.page_number ?? 1,
        evidence_text: evidence?.evidence_text ?? `Vacancies revised to ${incomingVacancies}`,
        effective_change: 'VACANCY_REVISION',
        timestamp: now,
      });
    }

    // 3. Check Exam Date Reschedule
    const incomingExamDate = incomingFields.exam_date.value;
    if (incomingExamDate) {
      let originalExamDate: string | null = null;
      try {
        if (originalRecruitment.raw_payload_json) {
          const parsed = JSON.parse(originalRecruitment.raw_payload_json);
          originalExamDate = parsed.fields?.exam_date?.value || null;
        }
      } catch {
        originalExamDate = null;
      }

      if (incomingExamDate !== originalExamDate) {
        const evidence = incomingFields.exam_date.evidence;
        mutations.push({
          field_name: 'exam_date',
          original_value: originalExamDate,
          new_value: incomingExamDate,
          source_document_id: incomingDocId,
          page_number: evidence?.page_number ?? 1,
          evidence_text: evidence?.evidence_text ?? `Exam rescheduled to ${incomingExamDate}`,
          effective_change: 'EXAM_RESCHEDULED',
          timestamp: now,
        });
      }
    }

    return mutations;
  }
}
