/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CorrigendumDetectionResult {
  isCorrigendum: boolean;
  confidence: number;
  referencedAdvertisementNumber: string | null;
  detectedKeywords: string[];
  amendmentScope?: 'DATE_EXTENSION' | 'VACANCY_REVISION' | 'QUALIFICATION_UPDATE' | 'GENERAL_MODIFICATION';
  notes?: string;
}

const CORRIGENDUM_KEYWORD_PATTERNS = [
  // English
  { keyword: 'corrigendum', pattern: /\bcorrigendum\b/i, weight: 0.9 },
  { keyword: 'addendum', pattern: /\baddendum\b/i, weight: 0.85 },
  { keyword: 'amendment', pattern: /\b(notice\s+for\s+)?amendment\b/i, weight: 0.8 },
  { keyword: 'partial modification', pattern: /\bpartial\s+modification\b/i, weight: 0.85 },
  { keyword: 'extension of last date', pattern: /\bextension\s+of\s+(the\s+)?(last\s+)?date\b/i, weight: 0.85 },
  { keyword: 'revised vacancies', pattern: /\brevised\s+vacanc(ies|y)\b/i, weight: 0.8 },
  // Hindi
  { keyword: 'शुद्धिपत्र', pattern: /शुद्धि[\s\-]?पत्र/u, weight: 0.95 },
  { keyword: 'संशोधन', pattern: /(आंशिक\s+)?संशोधन\s+(सूचना|विज्ञप्ति)?/u, weight: 0.85 },
  { keyword: 'तिथि विस्तार', pattern: /तिथि\s+विस्तार/u, weight: 0.85 },
  { keyword: 'संशोधित विज्ञप्ति', pattern: /संशोधित\s+विज्ञप्ति/u, weight: 0.9 },
];

export class CorrigendumDetector {
  /**
   * Analyzes document text and title to identify whether it is a corrigendum/addendum,
   * and extracts any referenced parent advertisement/notification numbers.
   */
  public static analyze(
    title: string,
    pages: Array<{ pageNumber: number; extractedText: string }>
  ): CorrigendumDetectionResult {
    const combinedHeader = [
      title,
      pages.find((p) => p.pageNumber === 1)?.extractedText.substring(0, 1500) || '',
      pages.find((p) => p.pageNumber === 2)?.extractedText.substring(0, 1500) || '',
    ].join('\n');

    const matchedKeywords: string[] = [];
    let maxWeight = 0;

    for (const item of CORRIGENDUM_KEYWORD_PATTERNS) {
      if (item.pattern.test(combinedHeader)) {
        matchedKeywords.push(item.keyword);
        if (item.weight > maxWeight) {
          maxWeight = item.weight;
        }
      }
    }

    if (matchedKeywords.length === 0) {
      return {
        isCorrigendum: false,
        confidence: 0,
        referencedAdvertisementNumber: null,
        detectedKeywords: [],
      };
    }

    // Determine amendment scope
    let scope: CorrigendumDetectionResult['amendmentScope'] = 'GENERAL_MODIFICATION';
    if (/date|तिथि/i.test(combinedHeader) && /extension|विस्तार/i.test(combinedHeader)) {
      scope = 'DATE_EXTENSION';
    } else if (/vacanc|पद|रिक्त/i.test(combinedHeader) && /revis|संशोध/i.test(combinedHeader)) {
      scope = 'VACANCY_REVISION';
    } else if (/qualification|योग्यता/i.test(combinedHeader)) {
      scope = 'QUALIFICATION_UPDATE';
    }

    // Attempt to extract referenced parent advertisement number
    let referencedAdvt: string | null = null;
    const refMatchEng =
      combinedHeader.match(
        /(?:reference|ref\.?)\s*[:\-]?\s*(?:notice\s*(?:no\.?)?|advt\.?\s*(?:no\.?)?|notification\s*(?:no\.?)?)?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/i
      ) ||
      combinedHeader.match(
        /(?:advt\.?\s*no\.?|notification\s*no\.?|notice\s*no\.?)\s*[:\-]?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/i
      );

    if (refMatchEng && refMatchEng[1]) {
      referencedAdvt = refMatchEng[1].trim();
    } else {
      const refMatchHindi =
        combinedHeader.match(
          /(?:सन्दर्भ|संदर्भ)\s*[:\-]?\s*(?:विज्ञप्ति\s*(?:संख्या)?|विज्ञापन\s*(?:संख्या)?)?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/u
        ) ||
        combinedHeader.match(
          /(?:विज्ञापन\s*संख्या|विज्ञप्ति\s*संख्या)\s*[:\-]?\s*([0-9A-Z\/\-_]*\d+[0-9A-Z\/\-_]*(?:\/[0-9]{4})?)/u
        );
      if (refMatchHindi && refMatchHindi[1]) {
        referencedAdvt = refMatchHindi[1].trim();
      }
    }

    return {
      isCorrigendum: true,
      confidence: maxWeight,
      referencedAdvertisementNumber: referencedAdvt,
      detectedKeywords: matchedKeywords,
      amendmentScope: scope,
      notes: `Corrigendum/Addendum identified via: ${matchedKeywords.join(', ')}`,
    };
  }

  /**
   * Constructs the structured CorrigendumAssociation without overwriting original evidence.
   */
  public static buildAssociation(params: {
    corrigendumDocumentId: string;
    originalRecruitmentId?: string | null;
    originalAdvertisementNumber?: string | null;
    relatedDocumentId?: string | null;
    amendmentType?: 'CORRIGENDUM' | 'ADDENDUM' | 'CANCELLATION' | 'EXTENSION' | 'GENERAL';
    updatedFields: Array<{
      fieldName: string;
      oldValue?: unknown;
      newValue: unknown;
      sourcePage: number;
      evidenceText: string;
      effectiveDate: string | null;
    }>;
    effectiveDate?: string | null;
    notes?: string | null;
  }) {
    return {
      id: crypto.randomUUID(),
      originalRecruitmentId: params.originalRecruitmentId ?? null,
      originalAdvertisementNumber: params.originalAdvertisementNumber ?? null,
      corrigendumDocumentId: params.corrigendumDocumentId,
      relatedDocumentId: params.relatedDocumentId ?? null,
      amendmentType: params.amendmentType || 'CORRIGENDUM',
      updatedFields: params.updatedFields,
      effectiveDate: params.effectiveDate ?? null,
      detectedAt: new Date().toISOString(),
      notes: params.notes ?? null,
    };
  }
}

