/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseSourceAdapter } from '../base-adapter.ts';
import type { NormalizedNotice, DiscoveredDocumentLink } from '../../discovery/types.ts';
import {
  extractAdvertisementNumber,
  extractDateFromText,
  isRecruitmentRelated,
} from '../../discovery/classifier.ts';

export interface UpssscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class UpssscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-UP-UPSSSC';
  readonly name = 'Uttar Pradesh Subordinate Services Selection Commission (UPSSSC)';
  readonly jurisdiction = 'UTTAR_PRADESH' as const;
  readonly baseUrl = 'https://upsssc.gov.in';
  override readonly adapterVersion = '1.3.0';

  override getFallbackEndpoints(): string[] {
    return [
      'https://upsssc.gov.in',
      'https://upsssc.gov.in/AllNotifications.aspx',
    ];
  }

  /**
   * Applies source-specific classification rules for UPSSSC portal notices.
   */
  classifyUpssscNotice(title: string, contextText: string): UpssscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Tenders and administrative notices (निविदा)
    if (
      combined.includes('tender') ||
      combined.includes('निविदा') ||
      combined.includes('quotation') ||
      combined.includes('scrap') ||
      combined.includes('वाहन') ||
      combined.includes('security')
    ) {
      return {
        rule: 'UPSSSC_TENDER_REJECT',
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'Commercial tender or administrative procurement notice (निविदा)',
        confidence: 0.98,
      };
    }

    // 2. Corrigenda / Amendment / Date Extension (विज्ञप्ति / शुद्धिपत्र / तिथि विस्तार)
    if (
      combined.includes('शुद्धिपत्र') ||
      combined.includes('शुद्धि-पत्र') ||
      combined.includes('संशोधन') ||
      combined.includes('विज्ञप्ति') ||
      combined.includes('corrigendum') ||
      combined.includes('amendment') ||
      combined.includes('तिथि विस्तार') ||
      combined.includes('last date extended')
    ) {
      return {
        rule: 'UPSSSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('विस्तार') || combined.includes('extended') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'UPSSSC Corrigendum, modification or application extension notice',
        confidence: 0.95,
      };
    }

    // 3. Shortlisting / PET Cutoff (मुख्य परीक्षा हेतु शॉर्टलिस्टिंग)
    if (
      combined.includes('शॉर्टलिस्टिंग') ||
      combined.includes('shortlisting') ||
      combined.includes('pet cutoff') ||
      combined.includes('कट-ऑफ अंक') ||
      combined.includes('अर्हकारी अंक')
    ) {
      return {
        rule: 'UPSSSC_SHORTLISTING',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSSSC PET shortlisting or eligibility cutoff announcement for Main Examination',
        confidence: 0.95,
      };
    }

    // 4. Results & Score Cards (अंतिम परिणाम / स्कोर कार्ड)
    if (
      combined.includes('परिणाम') ||
      combined.includes('result') ||
      combined.includes('score card') ||
      combined.includes('स्कोर कार्ड') ||
      combined.includes('चयन सूची')
    ) {
      return {
        rule: 'UPSSSC_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSSSC examination result, merit list, or score card publication',
        confidence: 0.95,
      };
    }

    // 5. Answer Key (उत्तर कुंजी)
    if (
      combined.includes('उत्तर कुंजी') ||
      combined.includes('answer key') ||
      combined.includes('आपत्ति')
    ) {
      return {
        rule: 'UPSSSC_ANSWER_KEY',
        category: 'ANSWER_KEY',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSSSC examination answer key or objection window release',
        confidence: 0.95,
      };
    }

    // 6. Admit Cards (प्रवेश पत्र)
    if (
      combined.includes('प्रवेश पत्र') ||
      combined.includes('admit card') ||
      combined.includes('hall ticket')
    ) {
      return {
        rule: 'UPSSSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSSSC examination admit card download notice',
        confidence: 0.95,
      };
    }

    // 7. Exam Advertisements: PET, VDO, Lekhpal, Junior Assistant, AllNotifications
    const upssscExams = [
      'pet-',
      'preliminary eligibility test',
      'प्रारंभिक अर्हता परीक्षा',
      'gram panchayat adhikari',
      'gram vikas adhikari',
      'vdo',
      'lekhpal',
      'junior assistant',
      'कनिष्ठ सहायक',
      'allnotifications',
      'advertisement',
      'विज्ञापन',
      '-exam/',
      '-परीक्षा/',
    ];

    if (upssscExams.some((e) => combined.includes(e)) || combined.includes('recruitment')) {
      return {
        rule: 'UPSSSC_EXAM_ADVT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative UPSSSC examination recruitment advertisement',
        confidence: 0.95,
      };
    }

    return {
      rule: 'UPSSSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General UPSSSC official notice',
      confidence: 0.85,
    };
  }

  /**
   * Extracts UPSSSC Exam/Advt Number (e.g. 01-Exam/2026, 02-Exam/2026, 03-परीक्षा/2026).
   */
  extractUpssscAdvtNumber(text: string): string | null {
    const patterns = [
      /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)?\s*([0-9]{1,2}-[A-Za-z\u0900-\u097F]+\/[0-9]{4})/i,
      /([0-9]{1,2}-[0-9A-Za-z/_-]+)/i,
    ];

    for (const pat of patterns) {
      const match = text.match(pat);
      if (match) {
        return match[1].trim();
      }
    }
    return extractAdvertisementNumber(text, this.sourceId);
  }

  parseNotices(htmlContent: string, currentUrl: string): {
    notices: NormalizedNotice[];
    structureIntact: boolean;
    detailRequired?: boolean;
    documentFlow?: 'LISTING_TO_DOCUMENT' | 'LISTING_TO_DETAIL_TO_DOCUMENT';
  } {
    if (!htmlContent || typeof htmlContent !== 'string') {
      return {
        notices: [],
        structureIntact: false,
        detailRequired: false,
        documentFlow: 'LISTING_TO_DOCUMENT',
      };
    }

    const lower = htmlContent.toLowerCase();
    if (
      lower.includes('<app-root') &&
      !lower.includes('<table') &&
      !lower.includes('<a ')
    ) {
      return {
        notices: [],
        structureIntact: false,
        detailRequired: false,
        documentFlow: 'LISTING_TO_DOCUMENT',
      };
    }

    const hasStructure =
      lower.includes('<table') ||
      lower.includes('upsssc') ||
      lower.includes('allnotifications') ||
      lower.includes('advertisement') ||
      lower.includes('परीक्षा');

    if (!hasStructure) {
      return {
        notices: [],
        structureIntact: false,
        detailRequired: false,
        documentFlow: 'LISTING_TO_DOCUMENT',
      };
    }

    const notices: NormalizedNotice[] = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let index = 1;

    // Track seen exam numbers on this table to prevent repeated row duplicate noise
    const seenExamNumbers = new Set<string>();

    while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
      const rowHtml = rowMatch[1];
      if (rowHtml.includes('<th')) continue;

      const docLinks = this.extractDocumentLinks(rowHtml, currentUrl);
      if (docLinks.length === 0) continue;

      const rowText = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanedRowTitle = rowText
        .replace(/\b(?:Download\s*(?:PDF)?|Notification\s*(?:PDF)?|Notice\s*(?:PDF)?|View\s*Details|Click\s*Here)\b/gi, '')
        .trim();

      const title = cleanedRowTitle.length > 5 ? cleanedRowTitle : (docLinks[0].title || rowText.slice(0, 120));
      const classification = this.classifyUpssscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractUpssscAdvtNumber(rowText);
      const publishedDate = extractDateFromText(rowText);

      // Deduplicate repeated listings under the exact same exam notice row on same page
      if (advtNo && seenExamNumbers.has(advtNo)) {
        continue;
      }
      if (advtNo) {
        seenExamNumbers.add(advtNo);
      }

      const categorizedDocs: DiscoveredDocumentLink[] = docLinks.map((d) => ({
        ...d,
        isPrimaryNotification: d.documentType === 'PDF',
        documentCategory: classification.category === 'CORRIGENDUM' ? 'CORRIGENDUM' : 'RECRUITMENT_NOTIFICATION',
        classificationReason: classification.reason,
        classificationConfidence: classification.confidence,
        sourceSpecificRule: classification.rule,
      }));

      const detailReq = this.deriveNoticeDetailRequirement(categorizedDocs, docLinks[0].url);

      notices.push({
        sourceId: this.sourceId,
        externalId: `upsssc-${advtNo ? advtNo.replace(/\//g, '-') : `exam-${index}`}`,
        title,
        advertisementNumber: advtNo,
        category: classification.category,
        isRecruitmentRelated: true,
        recruitmentType: classification.recruitmentType,
        publishedDate,
        closingDate: null,
        rawNoticeUrl: docLinks[0].url,
        detailUrl: detailReq.detailUrl,
        detailRequired: detailReq.detailRequired,
        detailResolved: detailReq.detailResolved,
        documentFlow: detailReq.documentFlow,
        documents: categorizedDocs,
        classificationReason: classification.reason,
        confidence: classification.confidence,
        classificationConfidence: classification.confidence,
        sourceSpecificRule: classification.rule,
        metadata: {
          advtNo,
          rawRowText: rowText,
          upssscRule: classification.rule,
        },
      });
      index++;
    }

    const detailRequired =
      notices.length > 0 &&
      notices.some((n) => n.detailRequired === true) &&
      !notices.some((n) => n.detailRequired === false);
    const documentFlow = detailRequired
      ? ('LISTING_TO_DETAIL_TO_DOCUMENT' as const)
      : ('LISTING_TO_DOCUMENT' as const);

    return {
      notices,
      structureIntact: true,
      detailRequired,
      documentFlow,
    };
  }
}
