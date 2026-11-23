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

export interface UppscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class UppscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-UP-UPPSC';
  readonly name = 'Uttar Pradesh Public Service Commission (UPPSC)';
  readonly jurisdiction = 'UTTAR_PRADESH' as const;
  readonly baseUrl = 'https://uppsc.up.nic.in';
  override readonly adapterVersion = '1.3.0';

  override getFallbackEndpoints(): string[] {
    return [
      'https://uppsc.up.nic.in',
      'https://uppsc.up.nic.in/CandidatePages/Notifications.aspx',
    ];
  }

  /**
   * Applies source-specific classification rules for UPPSC AllNotifications portal.
   */
  classifyUppscNotice(title: string, contextText: string): UppscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Commercial tenders / non-recruitment procurement
    if (
      combined.includes('tender') ||
      combined.includes('निविदा') ||
      combined.includes('quotation') ||
      combined.includes('scrap') ||
      combined.includes('vehicle')
    ) {
      return {
        rule: 'UPPSC_TENDER_REJECT',
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
      combined.includes('विज्ञप्ति') ||
      combined.includes('corrigendum') ||
      combined.includes('amendment') ||
      combined.includes('addendum') ||
      combined.includes('तिथि विस्तार') ||
      combined.includes('extension of last date')
    ) {
      return {
        rule: 'UPPSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('विस्तार') || combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'UPPSC Corrigendum, modification or extension notice (विज्ञप्ति / शुद्धिपत्र)',
        confidence: 0.95,
      };
    }

    // 3. Results & Marksheet / Selection List (चयन परिणाम / परीक्षाफल)
    if (
      combined.includes('result') ||
      combined.includes('परिणाम') ||
      combined.includes('चयन सूची') ||
      combined.includes('marksheet') ||
      combined.includes('cut off')
    ) {
      return {
        rule: 'UPPSC_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPPSC examination result or candidate selection list',
        confidence: 0.95,
      };
    }

    // 4. Admit Cards / Interview Letters (प्रवेश पत्र / साक्षात्कार पत्र)
    if (
      combined.includes('admit card') ||
      combined.includes('प्रवेश पत्र') ||
      combined.includes('interview letter') ||
      combined.includes('hall ticket')
    ) {
      return {
        rule: 'UPPSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPPSC admit card or interview call letter download notice',
        confidence: 0.95,
      };
    }

    // 5. Exam Calendar & Schedule (परीक्षा कार्यक्रम)
    if (
      combined.includes('exam calendar') ||
      combined.includes('examination schedule') ||
      combined.includes('परीक्षा कार्यक्रम') ||
      combined.includes('time table')
    ) {
      return {
        rule: 'UPPSC_EXAM_SCHEDULE',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPPSC examination schedule or exam calendar release',
        confidence: 0.93,
      };
    }

    // 6. Direct Recruitment Advertisements: Combined State / PCS, RO/ARO, Medical/Lecturer
    const uppscExams = [
      'combined state',
      'upper subordinate',
      'pcs',
      'p.c.s',
      'ro/aro',
      'review officer',
      'assistant review officer',
      'assistant conservator of forest',
      'staff nurse',
      'lecturer',
      'assistant professor',
      'dental surgeon',
      'medical officer',
      'chikitsa adhikari',
      'allnotifications',
      'advertisement',
      'advt',
      'विज्ञापन',
    ];

    if (uppscExams.some((e) => combined.includes(e)) || combined.includes('recruitment')) {
      return {
        rule: 'UPPSC_DIRECT_ADVT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative UPPSC recruitment advertisement (AllNotifications)',
        confidence: 0.95,
      };
    }

    return {
      rule: 'UPPSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General UPPSC recruitment announcement',
      confidence: 0.85,
    };
  }

  /**
   * Extracts UPPSC Advt Number (e.g. A-1/E-1/2026, A-2/E-1/2026, D-1/E-1/2026).
   */
  extractUppscAdvtNumber(text: string): string | null {
    const patterns = [
      /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)?\s*([A-Z]-[0-9]+\/[A-Z0-9-]+\/[0-9]{4})/i,
      /([A-Z]-[0-9]+\/[A-Z0-9-]+\/[0-9]{4})/i,
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
    const hasStructure =
      lower.includes('<table') ||
      lower.includes('uppsc') ||
      lower.includes('allnotifications') ||
      lower.includes('whats_new_scroling') ||
      lower.includes('open_pdf.aspx') ||
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

    // Pattern 1: Table rows (AllNotifications.aspx / CandidatePages/Notifications.aspx)
    while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
      const rowHtml = rowMatch[1];
      if (rowHtml.includes('<th')) continue;

      const docLinks = this.extractDocumentLinks(rowHtml, currentUrl).filter((d) => {
        const u = d.url.toLowerCase();
        return (
          d.documentType === 'PDF' ||
          d.documentType === 'DOC' ||
          u.includes('open_pdf.aspx') ||
          u.includes('view_advertisement.aspx') ||
          u.includes('view_advt.aspx') ||
          u.includes('notice') ||
          u.includes('advt') ||
          u.endsWith('.pdf') ||
          u.endsWith('.html') ||
          u.endsWith('.htm') ||
          (u.endsWith('.aspx') && !u.includes('userhelp.aspx') && !u.includes('default.aspx'))
        );
      });
      if (docLinks.length === 0) continue;

      const rowText = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanedRowTitle = rowText
        .replace(/\b(?:Download\s*(?:PDF)?|Notification\s*(?:PDF)?|Notice\s*(?:PDF)?|View\s*Details|View\s*Advertisement|User\s*Instructions|Apply|Click\s*Here)\b/gi, '')
        .trim();

      const title = cleanedRowTitle.length > 5 ? cleanedRowTitle : (docLinks[0].title || rowText.slice(0, 120));
      const classification = this.classifyUppscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractUppscAdvtNumber(rowText);
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
        externalId: `uppsc-${advtNo ? advtNo.replace(/\//g, '-') : `advt-${index}`}`,
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
          uppscRule: classification.rule,
        },
      });
      index++;
    }

    // Pattern 2: UPPSC Notice Board / What's New list items (<ul class='Whats_New_Scroling'><li><a href=Open_PDF.aspx?...>)
    if (notices.length === 0) {
      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch: RegExpExecArray | null;

      while ((liMatch = liRegex.exec(htmlContent)) !== null) {
        const liHtml = liMatch[1];
        const docLinks = this.extractDocumentLinks(liHtml, currentUrl).filter((d) => {
          const u = d.url.toLowerCase();
          return (
            d.documentType === 'PDF' ||
            d.documentType === 'DOC' ||
            u.includes('open_pdf.aspx') ||
            u.endsWith('.pdf')
          );
        });
        if (docLinks.length === 0) continue;

        const lblMatch = liHtml.match(/<span[^>]*class=["'][^"']*lbl_css[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const liText = liHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const extractedLbl = lblMatch
          ? lblMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : '';
        const title = extractedLbl.length > 5 ? extractedLbl : (docLinks[0].title || liText.slice(0, 140));
        const classification = this.classifyUppscNotice(title, liText);

        if (!classification.isRecruitmentRelated) continue;

        const advtNo = this.extractUppscAdvtNumber(`${title} ${liText}`);
        const publishedDate = extractDateFromText(liText);

        const categorizedDocs: DiscoveredDocumentLink[] = docLinks.map((d) => ({
          ...d,
          title,
          isPrimaryNotification: true,
          documentCategory:
            classification.category === 'CORRIGENDUM'
              ? 'CORRIGENDUM'
              : classification.category === 'RESULT'
              ? 'RESULT'
              : 'RECRUITMENT_NOTIFICATION',
          classificationReason: classification.reason,
          classificationConfidence: classification.confidence,
          sourceSpecificRule: classification.rule,
        }));

        const detailReq = this.deriveNoticeDetailRequirement(categorizedDocs, docLinks[0].url);

        notices.push({
          sourceId: this.sourceId,
          externalId: `uppsc-${advtNo ? `${advtNo.replace(/\//g, '-')}-${index}` : `notice-${index}`}`,
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
            rawRowText: liText,
            uppscRule: classification.rule,
          },
        });
        index++;
      }
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
