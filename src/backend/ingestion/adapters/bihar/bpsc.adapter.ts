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

export interface BpscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class BpscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-BIHAR-BPSC';
  readonly name = 'Bihar Public Service Commission (BPSC)';
  readonly jurisdiction = 'BIHAR' as const;
  readonly baseUrl = 'https://bpsc.bih.nic.in';
  override readonly adapterVersion = '1.3.0';

  override getFallbackEndpoints(): string[] {
    return [
      'https://bpsc.bih.nic.in',
      'https://bpsc.bih.nic.in/NoticeHeader.htm',
    ];
  }

  /**
   * Applies source-specific classification rules for BPSC bilingual portal notices.
   */
  classifyBpscNotice(title: string, contextText: string): BpscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Tenders / E-Procurement / Quotation
    if (
      combined.includes('निविदा') ||
      combined.includes('tender') ||
      combined.includes('quotation') ||
      combined.includes('वाहन') ||
      combined.includes('maintenance')
    ) {
      return {
        rule: 'BPSC_TENDER_REJECT',
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'Commercial tender or administrative procurement notice (निविदा)',
        confidence: 0.98,
      };
    }

    // 2. Corrigenda / Amendment / Date Extension (शुद्धिपत्र / संशोधन / तिथि विस्तार)
    if (
      combined.includes('शुद्धिपत्र') ||
      combined.includes('शुद्धि-पत्र') ||
      combined.includes('संशोधन') ||
      combined.includes('corrigendum') ||
      combined.includes('amendment') ||
      combined.includes('addendum') ||
      combined.includes('तिथि विस्तार') ||
      combined.includes('extension of date')
    ) {
      return {
        rule: 'BPSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('विस्तार') || combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'BPSC Corrigendum or application extension notice (शुद्धिपत्र / तिथि विस्तार)',
        confidence: 0.95,
      };
    }

    // 3. Results & Cut-off Marks (परीक्षाफल)
    if (
      combined.includes('परीक्षाफल') ||
      combined.includes('final result') ||
      combined.includes('results:') ||
      combined.includes('cut-off marks') ||
      combined.includes('marks sheet')
    ) {
      return {
        rule: 'BPSC_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BPSC examination result or merit list publication (परीक्षाफल)',
        confidence: 0.95,
      };
    }

    // 4. Answer Key (उत्तर पुस्तिका / कुंजी)
    if (
      combined.includes('answer key') ||
      combined.includes('उत्तर पुस्तिका') ||
      combined.includes('औपबंधिक उत्तर') ||
      combined.includes('provisional answer key')
    ) {
      return {
        rule: 'BPSC_ANSWER_KEY',
        category: 'ANSWER_KEY',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BPSC provisional or final answer key notice',
        confidence: 0.95,
      };
    }

    // 5. Admit Cards (प्रवेश पत्र)
    if (
      combined.includes('प्रवेश पत्र') ||
      combined.includes('admit card') ||
      combined.includes('e-admit')
    ) {
      return {
        rule: 'BPSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BPSC e-admit card download notice (प्रवेश पत्र)',
        confidence: 0.95,
      };
    }

    // 6. Exam Programme / Interview Schedule (परीक्षा कार्यक्रम)
    if (
      combined.includes('परीक्षा कार्यक्रम') ||
      combined.includes('examination programme') ||
      combined.includes('interview program') ||
      combined.includes('time table')
    ) {
      return {
        rule: 'BPSC_EXAM_PROGRAMME',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'BPSC examination or interview programme schedule (परीक्षा कार्यक्रम)',
        confidence: 0.93,
      };
    }

    // 7. Authoritative Recruitment Advertisement (विज्ञापन संख्या / Important Notice & Advertisement)
    if (
      combined.includes('विज्ञापन संख्या') ||
      combined.includes('advertisement') ||
      combined.includes('advt no') ||
      combined.includes('संयुक्त प्रतियोगिता परीक्षा') ||
      combined.includes('combined competitive') ||
      combined.includes('school teacher') ||
      combined.includes('headmaster') ||
      combined.includes('recruitment')
    ) {
      return {
        rule: 'BPSC_RECRUITMENT_ADVT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative BPSC recruitment advertisement or vacancy notice (विज्ञापन संख्या)',
        confidence: 0.95,
      };
    }

    return {
      rule: 'BPSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General BPSC official notice',
      confidence: 0.85,
    };
  }

  /**
   * Extracts BPSC advertisement numbers in Hindi or English (e.g. 26/2026, 05/2026).
   */
  extractBpscAdvtNumber(text: string): string | null {
    const patterns = [
      /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)\s*([0-9]{1,3}\/[0-9]{4})/i,
      /([0-9]{1,3}\/[0-9]{4})/i,
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
      lower.includes('bpsc') ||
      lower.includes('bihar') ||
      lower.includes('important notice') ||
      lower.includes('advertisement') ||
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
      const classification = this.classifyBpscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractBpscAdvtNumber(rowText);
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
        externalId: `bpsc-${advtNo ? advtNo.replace(/\//g, '-') : `notice-${index}`}`,
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
          bpscRule: classification.rule,
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
