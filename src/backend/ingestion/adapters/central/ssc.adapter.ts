/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseSourceAdapter } from '../base-adapter.ts';
import type { NormalizedNotice, DiscoveredDocumentLink } from '../../discovery/types.ts';
import {
  extractAdvertisementNumber,
  extractDateFromText,
  classifyRecruitmentType,
  isRecruitmentRelated,
} from '../../discovery/classifier.ts';

export interface SscNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class SscSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-CENTRAL-SSC';
  readonly name = 'Staff Selection Commission (SSC)';
  readonly jurisdiction = 'CENTRAL' as const;
  readonly baseUrl = 'https://ssc.gov.in';
  override readonly adapterVersion = '1.3.0';
  override readonly defaultDiscoveryPath = 'HYBRID' as const;

  override getFallbackEndpoints(): string[] {
    return [
      'https://ssc.gov.in',
      'https://ssc.gov.in/api/general-website/portal/notice-boards?page=1&limit=15&contentType=notice-boards&key=createdAt&order=DESC&isAttachment=true&language=english&attributes=id,headline,examId,contentType,redirectUrl,startDate,endDate,language,createdAt',
      'https://ssc.gov.in/notices',
    ];
  }

  /**
   * SSC Drupal views pagination helper.
   * SSC listing uses 0-indexed Drupal query ?page=N.
   */
  override getPageUrl(pageNumber: number, baseUrl: string): string | null {
    if (pageNumber <= 1) return baseUrl;
    try {
      const u = new URL(baseUrl);
      // Drupal views standard: page 1 is ?page=0 (or default), page 2 is ?page=1
      u.searchParams.set('page', String(pageNumber - 1));
      return u.toString();
    } catch {
      return null;
    }
  }

  /**
   * Applies source-specific classification rules for SSC portal notices.
   */
  classifySscNotice(title: string, contextText: string): SscNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Irrelevant: Tenders, E-Procurement, Office Circulars
    if (
      combined.includes('tender') ||
      combined.includes('e-procurement') ||
      combined.includes('gem') ||
      combined.includes('scrap') ||
      combined.includes('vehicle hiring') ||
      combined.includes('holiday')
    ) {
      return {
        rule: 'SSC_TENDER_REJECT',
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'Commercial tender or administrative non-recruitment circular',
        confidence: 0.98,
      };
    }

    // 2. Corrigenda / Addenda / Date Extension
    if (
      combined.includes('corrigendum') ||
      combined.includes('addendum') ||
      combined.includes('amendment') ||
      combined.includes('extension of last date') ||
      combined.includes('last date extended') ||
      combined.includes('revised vacancies') ||
      combined.includes('cancellation')
    ) {
      return {
        rule: 'SSC_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'SSC corrigendum or extension notice for existing recruitment',
        confidence: 0.95,
      };
    }

    // 3. Admit Card / Application Status
    if (
      combined.includes('admit card') ||
      combined.includes('admission certificate') ||
      combined.includes('status of application')
    ) {
      return {
        rule: 'SSC_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'SSC admit card or candidate application status release',
        confidence: 0.95,
      };
    }

    // 4. Results & Answer Keys
    if (
      combined.includes('result of') ||
      combined.includes('declaration of result') ||
      combined.includes('marks of qualified') ||
      combined.includes('final result')
    ) {
      return {
        rule: 'SSC_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'SSC written/final examination result announcement',
        confidence: 0.95,
      };
    }

    if (combined.includes('tentative answer key') || combined.includes('final answer key')) {
      return {
        rule: 'SSC_ANSWER_KEY',
        category: 'ANSWER_KEY',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'SSC examination answer key release',
        confidence: 0.95,
      };
    }

    // 5. Exam Schedule & Dates
    if (
      combined.includes('schedule of examination') ||
      combined.includes('dates of tier') ||
      combined.includes('examination schedule') ||
      combined.includes('important notice regarding exam')
    ) {
      return {
        rule: 'SSC_EXAM_NOTICE',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'SSC examination schedule or tier dates announcement',
        confidence: 0.92,
      };
    }

    // 6. Primary Recruitment Notifications: Known SSC Exam Families
    const sscFamilies = [
      'combined graduate level',
      'cgl',
      'combined higher secondary',
      'chsl',
      'multi tasking staff',
      'mts',
      'sub-inspector in delhi police',
      'cpo',
      'junior engineer',
      'constable (gd)',
      'selection posts',
      'phase-xii',
      'phase-xiii',
      'stenographer',
      'junior hindi translator',
      'notice of examination',
      'detailed advertisement',
    ];

    const isRecognizedFamily = sscFamilies.some((f) => combined.includes(f));
    if (isRecognizedFamily || combined.includes('recruitment') || combined.includes('examination')) {
      return {
        rule: 'SSC_RECRUITMENT_ADVERTISEMENT',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative SSC recruitment notification or examination announcement',
        confidence: 0.95,
      };
    }

    return {
      rule: 'SSC_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General SSC notification',
      confidence: 0.8,
    };
  }

  /**
   * Extracts SSC F.No / Notice No / Advt No with priority regexes.
   */
  extractSscAdvtNumber(text: string): string | null {
    const sscPatterns = [
      /(?:F\.?\s*No\.?\s*([A-Za-z0-9\-_./]+))/i,
      /(?:HQ-[A-Za-z0-9/_-]+)/i,
      /(?:Advt\.?\s*No\.?\s*([A-Za-z0-9\-_./]+))/i,
      /(?:Notice\s*No\.?\s*([A-Za-z0-9\-_./]+))/i,
      /(?:Phase\s*[-–]\s*[IVXLCDM0-9]+(?:\/\d{4})?(?:\/[A-Za-z0-9_-]+)?)/i,
      /(?:CGL|CHSL|MTS|CPO|JE|GD)-[0-9]{4}(?:\/[0-9]+)?/i,
    ];

    for (const pat of sscPatterns) {
      const match = text.match(pat);
      if (match) {
        return (match[1] || match[0]).trim();
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

    const trimmed = htmlContent.trim();

    // Pattern 0: Official SSC Portal JSON API response (/api/general-website/portal/notice-boards or /records)
    if (trimmed.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(trimmed) as {
          statusCode?: string | number;
          data?: Array<{
            id?: string;
            headline?: string;
            heading?: string;
            examId?: string;
            contentType?: string;
            redirectUrl?: string;
            startDate?: string | null;
            endDate?: string | null;
            createdAt?: string | null;
            attachments?: Array<{
              id?: string;
              fileName?: string;
              type?: string;
              size?: number;
              path?: string;
            }>;
          }>;
        };

        if (String(parsedJson.statusCode) === '200' && Array.isArray(parsedJson.data)) {
          const notices: NormalizedNotice[] = [];
          let index = 1;

          for (const item of parsedJson.data) {
            const rawHeadline = String(item.headline || item.heading || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!rawHeadline) continue;

            const contextStr = `${rawHeadline} ${item.examId || ''} ${item.contentType || ''}`.trim();
            const classification = this.classifySscNotice(rawHeadline, contextStr);
            if (!classification.isRecruitmentRelated) continue;

            const attachments = Array.isArray(item.attachments) ? item.attachments : [];
            const categorizedDocs: DiscoveredDocumentLink[] = [];

            for (const att of attachments) {
              const rawPath = String(att.path || '').trim();
              if (!rawPath) continue;
              const normalizedPath = rawPath
                .replace(/\\/g, '/')
                .replace(/^\/+/, '')
                .split('/')
                .map((seg) => encodeURIComponent(seg))
                .join('/');
              const pdfUrl = new URL(`/api/attachment/${normalizedPath}`, 'https://ssc.gov.in').toString();
              categorizedDocs.push({
                url: pdfUrl,
                canonicalUrl: pdfUrl,
                title: String(att.fileName || rawHeadline).trim(),
                documentType: 'PDF',
                documentCategory:
                  classification.category === 'CORRIGENDUM'
                    ? 'CORRIGENDUM'
                    : classification.category === 'RESULT'
                    ? 'RESULT'
                    : classification.category === 'ADMIT_CARD'
                    ? 'ADMIT_CARD'
                    : classification.category === 'ANSWER_KEY'
                    ? 'ANSWER_KEY'
                    : 'RECRUITMENT_NOTIFICATION',
                fileSizeHint: typeof att.size === 'number' ? att.size : undefined,
                mimeTypeHint: att.type || 'application/pdf',
                isPrimaryNotification: true,
                publishedDate: item.createdAt ? item.createdAt.slice(0, 10) : undefined,
                classificationReason: classification.reason,
                confidence: classification.confidence,
                classificationConfidence: classification.confidence,
                sourceSpecificRule: classification.rule,
                documentDiscoveryMethod: 'DIRECT_PDF',
              });
            }

            if (categorizedDocs.length === 0 && item.redirectUrl) {
              try {
                const resolvedRedirect = new URL(item.redirectUrl, 'https://ssc.gov.in').toString();
                if (resolvedRedirect.toLowerCase().endsWith('.pdf')) {
                  categorizedDocs.push({
                    url: resolvedRedirect,
                    canonicalUrl: resolvedRedirect,
                    title: rawHeadline,
                    documentType: 'PDF',
                    documentCategory: 'RECRUITMENT_NOTIFICATION',
                    isPrimaryNotification: true,
                    classificationReason: classification.reason,
                    confidence: classification.confidence,
                    classificationConfidence: classification.confidence,
                    sourceSpecificRule: classification.rule,
                    documentDiscoveryMethod: 'DIRECT_PDF',
                  });
                }
              } catch {
                // ignore invalid redirectUrl
              }
            }

            if (categorizedDocs.length === 0) continue;

            const advtNo = this.extractSscAdvtNumber(contextStr);
            const publishedDate =
              (item.createdAt && /^\d{4}-\d{2}-\d{2}/.test(item.createdAt)
                ? item.createdAt.slice(0, 10)
                : null) || extractDateFromText(rawHeadline);

            notices.push({
              sourceId: this.sourceId,
              externalId: `ssc-${item.id || (advtNo ? advtNo.replace(/\//g, '-') : `api-${index}`)}`,
              title: rawHeadline,
              advertisementNumber: advtNo,
              category: classification.category,
              isRecruitmentRelated: true,
              recruitmentType: classification.recruitmentType,
              publishedDate,
              closingDate: item.endDate ? String(item.endDate).slice(0, 10) : null,
              rawNoticeUrl: categorizedDocs[0].url,
              detailUrl: null,
              detailRequired: false,
              detailResolved: null,
              documentFlow: 'LISTING_TO_DOCUMENT',
              documents: categorizedDocs,
              classificationReason: classification.reason,
              confidence: classification.confidence,
              classificationConfidence: classification.confidence,
              sourceSpecificRule: classification.rule,
              metadata: {
                rawRowText: contextStr,
                sscRule: classification.rule,
                examId: item.examId || null,
                portalRecordId: item.id || null,
              },
            });
            index++;
          }

          return {
            notices,
            structureIntact: true,
            detailRequired: false,
            documentFlow: 'LISTING_TO_DOCUMENT',
          };
        }

        return {
          notices: [],
          structureIntact: false,
          detailRequired: false,
          documentFlow: 'LISTING_TO_DOCUMENT',
        };
      } catch {
        return {
          notices: [],
          structureIntact: false,
          detailRequired: false,
          documentFlow: 'LISTING_TO_DOCUMENT',
        };
      }
    }

    const lower = htmlContent.toLowerCase();

    // Detect unrendered Angular SPA shell (<app-root></app-root> with 0 links and 0 table rows)
    const isUnrenderedSpaShell =
      lower.includes('<app-root') &&
      !lower.includes('<table') &&
      !lower.includes('<tr') &&
      !/<a\s/i.test(htmlContent);

    if (isUnrenderedSpaShell) {
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
      lower.includes('notice') ||
      lower.includes('latest-news') ||
      lower.includes('announcement') ||
      lower.includes('cgl') ||
      lower.includes('ssc.gov.in');

    if (!hasStructure) {
      return {
        notices: [],
        structureIntact: false,
        detailRequired: false,
        documentFlow: 'LISTING_TO_DOCUMENT',
      };
    }

    const notices: NormalizedNotice[] = [];
    let index = 1;

    // Pattern 1: Table Rows (Standard Drupal views table or standard HTML table)
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
      const rowHtml = rowMatch[1];
      if (rowHtml.includes('<th')) continue; // Skip header

      const docLinks = this.extractDocumentLinks(rowHtml, currentUrl);
      if (docLinks.length === 0) continue;

      const rowText = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanedRowTitle = rowText
        .replace(/\b(?:Download\s*(?:PDF)?|Notification\s*(?:PDF)?|Notice\s*(?:PDF)?|View\s*Details|Click\s*Here)\b/gi, '')
        .trim();

      const title = cleanedRowTitle.length > 5 ? cleanedRowTitle : (docLinks[0].title || rowText.slice(0, 120));
      const classification = this.classifySscNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const advtNo = this.extractSscAdvtNumber(rowText);
      const publishedDate = extractDateFromText(rowText);

      // Prioritize primary PDF notice
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
        externalId: `ssc-${advtNo ? advtNo.replace(/\//g, '-') : `notice-${index}`}`,
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
          sscRule: classification.rule,
        },
      });
      index++;
    }

    // Pattern 2: Card List Layout (e.g. <li class="views-row"> or <div class="card">)
    if (notices.length === 0) {
      const cardRegex = /<(?:li|div)[^>]*class=["'][^"']*(?:notice|views-row|card|news)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div)>/gi;
      let cardMatch: RegExpExecArray | null;

      while ((cardMatch = cardRegex.exec(htmlContent)) !== null) {
        const cardHtml = cardMatch[1];
        const docLinks = this.extractDocumentLinks(cardHtml, currentUrl);
        if (docLinks.length === 0) continue;

        const cardText = cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const cleanedCardTitle = cardText
          .replace(/\b(?:Download\s*(?:PDF)?|Notification\s*(?:PDF)?|Notice\s*(?:PDF)?|View\s*Details|Click\s*Here)\b/gi, '')
          .trim();
        const title = cleanedCardTitle.length > 5 ? cleanedCardTitle : (docLinks[0].title || cardText.slice(0, 120));
        const classification = this.classifySscNotice(title, cardText);

        if (!classification.isRecruitmentRelated) continue;

        const advtNo = this.extractSscAdvtNumber(cardText);
        const publishedDate = extractDateFromText(cardText);

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
          externalId: `ssc-${advtNo ? advtNo.replace(/\//g, '-') : `card-${index}`}`,
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
            cardText,
            sscRule: classification.rule,
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
