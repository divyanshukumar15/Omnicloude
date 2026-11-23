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

export interface UpscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class UpscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-CENTRAL-UPSC';
  readonly name = 'Union Public Service Commission (UPSC)';
  readonly jurisdiction = 'CENTRAL' as const;
  readonly baseUrl = 'https://www.upsc.gov.in';
  override readonly adapterVersion = '1.3.0';
  override readonly defaultDiscoveryPath = 'HYBRID' as const;

  override getFallbackEndpoints(): string[] {
    return [
      'https://www.upsc.gov.in',
      'https://www.upsc.gov.in/examinations/active-exams',
      'https://www.upsc.gov.in/recruitment/recruitment-advertisement',
    ];
  }

  /**
   * UPSC Drupal views pagination: 0-indexed ?page=N.
   */
  override getPageUrl(pageNumber: number, baseUrl: string): string | null {
    if (pageNumber <= 1) return baseUrl;
    try {
      const u = new URL(baseUrl);
      u.searchParams.set('page', String(pageNumber - 1));
      return u.toString();
    } catch {
      return null;
    }
  }

  /**
   * Applies source-specific classification rules for UPSC portal notices.
   */
  classifyUpscNotice(title: string, contextText: string): UpscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Annual Examination Calendar - do not create a job recruitment for the calendar itself
    if (
      combined.includes('annual calendar') ||
      combined.includes('programme of examinations') ||
      combined.includes('revised annual calendar')
    ) {
      return {
        rule: 'UPSC_CALENDAR_REJECT',
        category: 'EXAM_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'UPSC Annual Examination Calendar (comprehensive schedule, not individual job notice)',
        confidence: 0.96,
      };
    }

    // 2. Corrigenda / Addenda / Notice of Extension
    if (
      combined.includes('corrigendum') ||
      combined.includes('addendum') ||
      combined.includes('amendment') ||
      combined.includes('notice of cancellation') ||
      combined.includes('extension of closing date')
    ) {
      return {
        rule: 'UPSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'UPSC Corrigendum or notice modifying existing advertisement',
        confidence: 0.95,
      };
    }

    // 3. Results & Marks
    if (
      combined.includes('final result') ||
      combined.includes('written result') ||
      combined.includes('recommended candidates') ||
      combined.includes('marks of candidates')
    ) {
      return {
        rule: 'UPSC_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSC examination or interview result release',
        confidence: 0.95,
      };
    }

    // 4. Interview Schedule / Personality Test / Time Table
    if (
      combined.includes('interview schedule') ||
      combined.includes('personality test') ||
      combined.includes('time table') ||
      combined.includes('e-summon letter')
    ) {
      return {
        rule: 'UPSC_EXAM_SCHEDULE',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSC interview schedule or personality test summons',
        confidence: 0.93,
      };
    }

    // 5. Admit Cards / e-Admit Cards
    if (combined.includes('e-admit card') || combined.includes('admit card')) {
      return {
        rule: 'UPSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'UPSC e-admit card release',
        confidence: 0.95,
      };
    }

    // 6. Direct Recruitment Advertisements (e.g. Advt No. 03/2026, Advertisement No.13 - 2026, Specialist, Medical Officer)
    if (
      combined.includes('advertisement no') ||
      combined.includes('advt no') ||
      combined.includes('recruitment advertisement') ||
      combined.includes('direct recruitment by selection')
    ) {
      return {
        rule: 'UPSC_RECRUITMENT_ADVT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative UPSC Direct Recruitment Advertisement',
        confidence: 0.95,
      };
    }

    // 7. National Examinations (Civil Services, CDS, NDA, Engineering Services, Geo-Scientist, etc.)
    const majorExams = [
      'civil services',
      'combined defence services',
      'cds',
      'national defence academy',
      'nda',
      'engineering services',
      'combined medical services',
      'central armed police forces',
      'capf',
      'indian forest service',
      'combined geo-scientist',
    ];

    if (majorExams.some((exam) => combined.includes(exam)) || combined.includes('examination, 20')) {
      return {
        rule: 'UPSC_EXAM_NOTICE',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'UPSC Major National Competitive Examination recruitment notification',
        confidence: 0.95,
      };
    }

    return {
      rule: 'UPSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General UPSC recruitment announcement',
      confidence: 0.85,
    };
  }

  /**
   * Extracts UPSC Advt Number or Examination Notice Number.
   */
  extractUpscAdvtNumber(text: string): string | null {
    const upscPatterns = [
      /(?:Advt\.?\s*No\.?|Advertisement\s*No\.?)\s*([0-9]{1,3}\s*[-/]\s*[0-9]{4}(?:-[A-Za-z0-9]+)?)/i,
      /(?:Exam\s*Notice\s*No\.?)\s*([0-9]{1,3}\s*[-/]\s*[0-9]{4}(?:-[A-Za-z0-9]+)?)/i,
      /([0-9]{1,3}\/[0-9]{4}(?:-[A-Za-z0-9]+)?)/i,
    ];

    for (const pat of upscPatterns) {
      const match = text.match(pat);
      if (match) {
        return (match[1] || match[0]).trim().replace(/\s*-\s*/g, '/');
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
    // Reject empty SPA shell without real content
    if (
      lower.includes('<app-root') &&
      !lower.includes('<table') &&
      !lower.includes('views-row') &&
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
      lower.includes('views-table') ||
      lower.includes('views-row') ||
      lower.includes('recruitment') ||
      lower.includes('upsc.gov.in') ||
      lower.includes('examination');

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
      const classification = this.classifyUpscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractUpscAdvtNumber(rowText);
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
        externalId: `upsc-${advtNo ? advtNo.replace(/\//g, '-') : `advt-${index}`}`,
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
          rawRowText: rowText,
          upscRule: classification.rule,
        },
      });
      index++;
    }

    // Fallback: Live www.upsc.gov.in uses Drupal Views <div class="views-row ..."> containers
    // on '/', '/whats-new', '/examinations/active-exams', and '/recruitment/recruitment-advertisement'.
    if (notices.length === 0 && lower.includes('views-row')) {
      const viewsRowRegex = /<div\s+class=["'][^"']*views-row[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
      let viewMatch: RegExpExecArray | null;
      const seenDetailOrDocUrls = new Set<string>();

      while ((viewMatch = viewsRowRegex.exec(htmlContent)) !== null) {
        if (notices.length >= 6) break;
        const blockHtml = viewMatch[1];
        const allLinks = this.extractDocumentLinks(blockHtml, currentUrl);
        // Filter to official UPSC notice detail or PDF links
        const docLinks = allLinks.filter((d) => {
          const u = d.url.toLowerCase();
          return (
            d.documentType === 'PDF' ||
            u.endsWith('.pdf') ||
            u.includes('/sites/default/files/') ||
            (u.includes('/whats-new/') && !u.endsWith('/whats-new') && !u.endsWith('/whats-new/')) ||
            (u.includes('/examinations/') && !u.endsWith('/active-exams') && !u.includes('/archive')) ||
            (u.includes('/recruitment/') && !u.endsWith('/recruitment-advertisement'))
          );
        });
        if (docLinks.length === 0) continue;

        const primaryUrl = docLinks[0].url;
        if (seenDetailOrDocUrls.has(primaryUrl)) continue;
        seenDetailOrDocUrls.add(primaryUrl);

        const rowText = blockHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const cleanedRowTitle = rowText
          .replace(/\b(?:Download\s*(?:PDF)?|Notification\s*(?:PDF)?|Notice\s*(?:PDF)?|View\s*Details|Click\s*Here)\b/gi, '')
          .trim();

        const title =
          cleanedRowTitle.length > 5
            ? cleanedRowTitle
            : docLinks[0].title || rowText.slice(0, 120);
        const classification = this.classifyUpscNotice(title, rowText);

        if (!classification.isRecruitmentRelated) continue;

        const advtNo = this.extractUpscAdvtNumber(rowText);
        const publishedDate = extractDateFromText(rowText);

        const categorizedDocs: DiscoveredDocumentLink[] = docLinks.map((d) => ({
          ...d,
          isPrimaryNotification: d.documentType === 'PDF',
          documentCategory:
            classification.category === 'CORRIGENDUM' ? 'CORRIGENDUM' : 'RECRUITMENT_NOTIFICATION',
          classificationReason: classification.reason,
          classificationConfidence: classification.confidence,
          sourceSpecificRule: classification.rule,
        }));

        const detailReq = this.deriveNoticeDetailRequirement(categorizedDocs, primaryUrl);

        notices.push({
          sourceId: this.sourceId,
          externalId: `upsc-${advtNo ? advtNo.replace(/\//g, '-') : `advt-${index}`}`,
          title,
          advertisementNumber: advtNo,
          category: classification.category,
          isRecruitmentRelated: true,
          recruitmentType: classification.recruitmentType,
          publishedDate,
          closingDate: null,
          rawNoticeUrl: primaryUrl,
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
            rawRowText: rowText,
            upscRule: classification.rule,
            drupalViewsRow: true,
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
