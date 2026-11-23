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

export interface BsscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class BsscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-BIHAR-BSSC';
  readonly name = 'Bihar Staff Selection Commission (BSSC)';
  readonly jurisdiction = 'BIHAR' as const;
  readonly baseUrl = 'https://bssc.bihar.gov.in';
  override readonly adapterVersion = '1.3.0';

  override getFallbackEndpoints(): string[] {
    return [
      'https://bssc.bihar.gov.in',
      'https://bssc.bihar.gov.in/NoticeBoard.htm',
    ];
  }

  /**
   * Applies source-specific classification rules for BSSC notice board.
   */
  classifyBsscNotice(title: string, contextText: string): BsscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Administrative notices / Tenders / Security guards / Transport (Rejection)
    if (
      combined.includes('निविदा') ||
      combined.includes('tender') ||
      combined.includes('quotation') ||
      combined.includes('वाहन') ||
      combined.includes('सुरक्षा गार्ड') ||
      combined.includes('स्टेशनरी') ||
      combined.includes('maintenance') ||
      combined.includes('अवकाश')
    ) {
      return {
        rule: 'BSSC_TENDER_REJECT',
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'Commercial tender, housekeeping or administrative procurement notice (निविदा)',
        confidence: 0.98,
      };
    }

    // 2. Corrigenda / Amendment / Date Extension (शुद्धिपत्र / संशोधन)
    if (
      combined.includes('शुद्धिपत्र') ||
      combined.includes('शुद्धि-पत्र') ||
      combined.includes('संशोधन') ||
      combined.includes('corrigendum') ||
      combined.includes('amendment') ||
      combined.includes('तिथि विस्तार') ||
      combined.includes('extension of date')
    ) {
      return {
        rule: 'BSSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('विस्तार') || combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'BSSC Corrigendum or application extension notice (शुद्धिपत्र / संशोधन)',
        confidence: 0.95,
      };
    }

    // 3. Results / Counselling List / Selection (काउंसलिंग / परिणाम)
    if (
      combined.includes('काउंसलिंग') ||
      combined.includes('counselling') ||
      combined.includes('मेरिट सूची') ||
      combined.includes('merit list') ||
      combined.includes('परीक्षाफल') ||
      combined.includes('final result') ||
      combined.includes('अनुशंसित')
    ) {
      return {
        rule: 'BSSC_COUNSELLING_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BSSC examination result, counselling schedule, or recommended candidate list',
        confidence: 0.95,
      };
    }

    // 4. Admit Cards (प्रवेश पत्र)
    if (
      combined.includes('प्रवेश पत्र') ||
      combined.includes('admit card') ||
      combined.includes('hall ticket')
    ) {
      return {
        rule: 'BSSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BSSC examination admit card download notice (प्रवेश पत्र)',
        confidence: 0.95,
      };
    }

    // 5. Exam Dates / Schedule (परीक्षा की तिथि)
    if (
      combined.includes('परीक्षा की तिथि') ||
      combined.includes('examination date') ||
      combined.includes('परीक्षा कार्यक्रम') ||
      combined.includes('मुख्य परीक्षा')
    ) {
      return {
        rule: 'BSSC_EXAM_NOTICE',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BSSC examination date or venue schedule announcement',
        confidence: 0.93,
      };
    }

    // 6. Recruitment Advertisements: CGL, Inter Level, Technical posts
    if (
      combined.includes('विज्ञापन संख्या') ||
      combined.includes('विज्ञापन सं') ||
      combined.includes('advertisement') ||
      combined.includes('advt no') ||
      combined.includes('graduate level') ||
      combined.includes('स्नातक स्तरीय') ||
      combined.includes('inter level') ||
      combined.includes('इंटर स्तरीय') ||
      combined.includes('stenographer') ||
      combined.includes('recruitment')
    ) {
      return {
        rule: 'BSSC_RECRUITMENT_ADVT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative BSSC recruitment notification or advertisement (विज्ञापन सं)',
        confidence: 0.95,
      };
    }

    return {
      rule: 'BSSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General BSSC notification',
      confidence: 0.85,
    };
  }

  /**
   * Extracts BSSC advertisement numbers (e.g. 01/26, 02/2026, 03/24).
   */
  extractBsscAdvtNumber(text: string): string | null {
    const patterns = [
      /(?:Advt\.?\s*No\.?|विज्ञापन\s*सं(?:ख्या)?\.?)\s*([0-9]{1,3}\/[0-9]{2,4})/i,
      /([0-9]{1,3}\/[0-9]{2,4})/i,
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
      lower.includes('bssc') ||
      lower.includes('noticeboard') ||
      lower.includes('advt') ||
      lower.includes('विज्ञापन');

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
      const classification = this.classifyBsscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractBsscAdvtNumber(rowText);
      const publishedDate = extractDateFromText(rowText);

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
        externalId: `bssc-${advtNo ? advtNo.replace(/\//g, '-') : `notice-${index}`}`,
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
          bsscRule: classification.rule,
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
