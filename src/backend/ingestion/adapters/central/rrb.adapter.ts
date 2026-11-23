/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseSourceAdapter } from '../base-adapter.ts';
import type { NormalizedNotice, DiscoveredDocumentLink } from '../../discovery/types.ts';
import {
  normalizeCenNumber,
  extractAdvertisementNumber,
  extractDateFromText,
  isRecruitmentRelated,
} from '../../discovery/classifier.ts';
import { registerRrbRegionalDomain } from '../../discovery/official-domains.ts';

export interface RrbRegionalBoardConfig {
  code: string;
  name: string;
  url: string;
}

export interface RrbNoticeClassificationResult {
  rule: string;
  category: NormalizedNotice['category'];
  recruitmentType: NormalizedNotice['recruitmentType'];
  isRecruitmentRelated: boolean;
  reason: string;
  confidence: number;
}

export class RrbSourceAdapter extends BaseSourceAdapter {
  readonly sourceId = 'IN-CENTRAL-RRB';
  readonly name = 'Railway Recruitment Boards (RRB)';
  readonly jurisdiction = 'CENTRAL' as const;
  readonly baseUrl = 'https://rrbcdg.gov.in';
  override readonly adapterVersion = '1.3.0';

  override getFallbackEndpoints(): string[] {
    return super.getFallbackEndpoints();
  }

  // Complete registry of all 21 official Railway Recruitment Boards
  private regionalBoards: RrbRegionalBoardConfig[] = [
    { code: 'RRB-CDG', name: 'RRB Chandigarh', url: 'https://rrbcdg.gov.in' },
    { code: 'RRB-MUM', name: 'RRB Mumbai', url: 'https://rrbmumbai.gov.in' },
    { code: 'RRB-KOL', name: 'RRB Kolkata', url: 'https://rrbkolkata.gov.in' },
    { code: 'RRB-SEC', name: 'RRB Secunderabad', url: 'https://rrbsecunderabad.gov.in' },
    { code: 'RRB-CHN', name: 'RRB Chennai', url: 'https://rrbchennai.gov.in' },
    { code: 'RRB-PAT', name: 'RRB Patna', url: 'https://rrbpatna.gov.in' },
    { code: 'RRB-AHM', name: 'RRB Ahmedabad', url: 'https://rrbahmedabad.gov.in' },
    { code: 'RRB-BHP', name: 'RRB Bhopal', url: 'https://rrbbhopal.gov.in' },
    { code: 'RRB-AJM', name: 'RRB Ajmer', url: 'https://rrbajmer.gov.in' },
    { code: 'RRB-ALD', name: 'RRB Prayagraj', url: 'https://rrbprayagraj.gov.in' },
    { code: 'RRB-GKP', name: 'RRB Gorakhpur', url: 'https://rrbgkp.gov.in' },
    { code: 'RRB-GHY', name: 'RRB Guwahati', url: 'https://rrbguwahati.gov.in' },
    { code: 'RRB-RNC', name: 'RRB Ranchi', url: 'https://rrbranchi.gov.in' },
    { code: 'RRB-MLD', name: 'RRB Malda', url: 'https://rrbmalda.gov.in' },
    { code: 'RRB-MFP', name: 'RRB Muzaffarpur', url: 'https://rrbmuzaffarpur.gov.in' },
    { code: 'RRB-SGU', name: 'RRB Siliguri', url: 'https://rrbsiliguri.gov.in' },
    { code: 'RRB-TVM', name: 'RRB Thiruvananthapuram', url: 'https://rrbthiruvananthapuram.gov.in' },
    { code: 'RRB-JMU', name: 'RRB Jammu', url: 'https://rrbjammu.nic.in' },
    { code: 'RRB-BNC', name: 'RRB Bangalore', url: 'https://rrbbnc.gov.in' },
    { code: 'RRB-BBS', name: 'RRB Bhubaneswar', url: 'https://rrbbbs.gov.in' },
    { code: 'RRB-BSP', name: 'RRB Bilaspur', url: 'https://rrbbilaspur.gov.in' },
  ];

  /**
   * Dynamically registers a regional board domain in the RRB registry.
   */
  public registerRegionalBoard(board: RrbRegionalBoardConfig): void {
    const existing = this.regionalBoards.find((b) => b.code === board.code);
    if (!existing) {
      this.regionalBoards.push(board);
    }
    try {
      const hostname = new URL(board.url).hostname;
      registerRrbRegionalDomain(hostname);
    } catch {
      // Ignore invalid URL
    }
  }

  public getRegionalBoards(): readonly RrbRegionalBoardConfig[] {
    return this.regionalBoards;
  }

  /**
   * Applies source-specific classification rules for Railway Recruitment Boards.
   */
  classifyRrbNotice(title: string, contextText: string): RrbNoticeClassificationResult {
    const combined = `${title} ${contextText}`.toLowerCase();

    // 1. Tenders / Commercial / Non-Recruitment
    if (
      combined.includes('tender') ||
      combined.includes('quotation') ||
      combined.includes('scrap') ||
      combined.includes('hiring')
    ) {
      return {
        rule: 'RRB_TENDER_REJECT',
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        isRecruitmentRelated: false,
        reason: 'Commercial tender or non-recruitment procurement notice',
        confidence: 0.98,
      };
    }

    // 2. Corrigenda / Addenda / Date Extension / Revised Vacancies
    if (
      combined.includes('corrigendum') ||
      combined.includes('addendum') ||
      combined.includes('amendment') ||
      combined.includes('extension of closing date') ||
      combined.includes('revision of vacancies') ||
      combined.includes('notice regarding extension')
    ) {
      return {
        rule: 'RRB_CEN_CORRIGENDUM',
        category: 'CORRIGENDUM',
        recruitmentType: combined.includes('extension') ? 'EXTENSION' : 'CORRIGENDUM',
        isRecruitmentRelated: true,
        reason: 'RRB CEN corrigendum, addendum, or vacancy revision notice',
        confidence: 0.95,
      };
    }

    // 3. Results / Document Verification / Panel
    if (
      combined.includes('provisional panel') ||
      combined.includes('document verification') ||
      combined.includes('dv schedule') ||
      combined.includes('final result') ||
      combined.includes('cutoff marks') ||
      combined.includes('cut-off marks')
    ) {
      return {
        rule: 'RRB_CEN_RESULT',
        category: 'RESULT',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'RRB CEN provisional panel or document verification result',
        confidence: 0.95,
      };
    }

    // 4. Answer Key / Objection Tracker
    if (
      combined.includes('answer key') ||
      combined.includes('objection tracker') ||
      combined.includes('question paper')
    ) {
      return {
        rule: 'RRB_CEN_ANSWER_KEY',
        category: 'ANSWER_KEY',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'RRB CBT answer key or objection tracker notice',
        confidence: 0.95,
      };
    }

    // 5. Admit Cards / City Intimation / E-Call Letter
    if (
      combined.includes('city intimation') ||
      combined.includes('e-call letter') ||
      combined.includes('admit card') ||
      combined.includes('travel pass')
    ) {
      return {
        rule: 'RRB_CEN_ADMIT_CARD',
        category: 'ADMIT_CARD',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'RRB exam city intimation or e-call letter release',
        confidence: 0.95,
      };
    }

    // 6. CBT Examination Dates / Schedule
    if (
      combined.includes('cbt schedule') ||
      combined.includes('schedule of cbt') ||
      combined.includes('exam date') ||
      combined.includes('notice on cbt')
    ) {
      return {
        rule: 'RRB_CEN_EXAM_NOTICE',
        category: 'EXAM_NOTICE',
        recruitmentType: 'RECRUITMENT_UPDATE',
        isRecruitmentRelated: true,
        reason: 'RRB CBT exam schedule or phase date notification',
        confidence: 0.93,
      };
    }

    // 7. Centralized Employment Notice (CEN) Primary Recruitment Notification
    const cenIndicators = [
      'cen',
      'centralized employment notice',
      'detailed cen',
      'recruitment of assistant loco pilot',
      'alp',
      'technicians',
      'ntpc',
      'group d',
      'level-1 posts',
      'paramedical categories',
      'junior engineer',
      'rpf constable',
      'rpf sub-inspector',
    ];

    if (cenIndicators.some((ind) => combined.includes(ind)) || combined.includes('employment notice')) {
      return {
        rule: 'RRB_CEN_PRIMARY_NOTIFICATION',
        category: 'NOTIFICATION',
        recruitmentType: 'NEW_RECRUITMENT',
        isRecruitmentRelated: true,
        reason: 'Authoritative RRB Centralized Employment Notice (CEN) notification',
        confidence: 0.95,
      };
    }

    return {
      rule: 'RRB_GENERIC_NOTICE',
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      isRecruitmentRelated: true,
      reason: 'General Railway Recruitment announcement',
      confidence: 0.85,
    };
  }

  /**
   * Normalizes CEN numbers across central and 21 regional boards.
   */
  extractRrbCenNumber(text: string): string | null {
    const cen = normalizeCenNumber(text);
    if (cen) return cen;

    const patterns = [
      /(?:CEN|Centralized\s*Employment\s*Notice)\s*(?:No\.?)?\s*([0-9]{1,3}\/[0-9]{4})/i,
      /(?:CEN\s*RPF\s*[0-9]{1,2}\/[0-9]{4})/i,
      /(?:CEN)\s*([A-Za-z0-9/_-]+)/i,
    ];

    for (const pat of patterns) {
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

    const lower = htmlContent.toLowerCase();
    // Reject empty SPA shell (e.g. www.rrbapply.gov.in Angular shell without rendered notices)
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
      lower.includes('cen') ||
      lower.includes('railway') ||
      lower.includes('rrb') ||
      lower.includes('recruitment') ||
      lower.includes('employment notice');

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

    // Detect if this is a regional sub-portal
    const matchedRegion = this.regionalBoards.find((r) => currentUrl.includes(r.url.replace('https://', '')));

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
      const classification = this.classifyRrbNotice(title, rowText);

      if (!classification.isRecruitmentRelated) continue;

      const cenNumber = this.extractRrbCenNumber(rowText);
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
        externalId: `rrb-${cenNumber ? cenNumber.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') : `cen-${index}`}`,
        title,
        advertisementNumber: cenNumber,
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
        regionalSubSource: matchedRegion ? matchedRegion.code : 'CENTRAL_RRB',
        classificationReason: classification.reason,
        confidence: classification.confidence,
        classificationConfidence: classification.confidence,
        sourceSpecificRule: classification.rule,
        metadata: {
          cenNumber,
          rawRowText: rowText,
          regionalBoard: matchedRegion ? matchedRegion.name : 'Centralized RRB Portal',
          rrbRule: classification.rule,
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
