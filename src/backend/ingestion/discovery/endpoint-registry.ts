/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type EndpointType =
  | 'PRIMARY_LISTING'
  | 'SECONDARY_LISTING'
  | 'NOTICE_BOARD'
  | 'EXAM_LISTING'
  | 'DETAIL_PAGE'
  | 'LISTING'
  | 'NOTICE'
  | 'DETAIL'
  | 'DOCUMENT'
  | 'FEED'
  | 'API';

export type PaginationMethod = 'QUERY_PARAM' | 'NEXT_LINK' | 'OFFSET' | 'NONE';

export type EndpointVerificationStatus =
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'STRUCTURE_CHANGED'
  | 'DEGRADED';

export type ExpectedEndpointResponseKind =
  | 'HTML_LISTING'
  | 'JSON_API_RESPONSE'
  | 'DETAIL_PAGE'
  | 'DOCUMENT_PDF'
  | 'REDIRECT_INTERSTITIAL'
  | 'ACCESS_DENIED_RESPONSE';

export type EndpointDetailFlow =
  | 'DIRECT_PDF'
  | 'DETAIL_REQUIRED'
  | 'DIRECT_PDF_OR_DETAIL';

export type EndpointDocumentFlow =
  | 'LISTING_TO_DOCUMENT'
  | 'LISTING_TO_DETAIL_TO_DOCUMENT';

export interface SourceEndpointAuditRecord {
  endpointId: string;
  sourceId: string;
  organization: string;
  endpointUrl: string;
  officialDomain: string;
  officialDomains: string[];
  endpointType: EndpointType;
  purpose: string;
  expectedResponse: ExpectedEndpointResponseKind;
  paginationSupported: boolean;
  detailFlow: EndpointDetailFlow;
  documentFlow: EndpointDocumentFlow;
  active: boolean;
  endpointPriority: number;
}

export interface SourceEndpointConfig {
  endpointId: string;
  sourceId: string;
  organization: string;
  officialDomains: string[];
  officialDomain?: string;
  endpointType: EndpointType;
  url: string;
  endpointUrl?: string;
  purpose?: string;
  expectedResponse?: ExpectedEndpointResponseKind;
  paginationSupported?: boolean;
  detailFlow?: EndpointDetailFlow;
  documentFlow?: EndpointDocumentFlow;
  active?: boolean;
  httpMethod: 'GET' | 'POST';
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  expectedContentType: string;
  paginationMethod: PaginationMethod;
  paginationParam?: string;
  nextLinkSelector?: string;
  nextPageDetectionMethod: string;
  detailPageStrategy: string;
  documentLinkStrategy: string;
  endpointPriority: number; // 1 = highest priority / primary
  enabled: boolean;
  maxPages?: number;
  maxLinks?: number;
  timeoutMs?: number;
  retryPolicy?: {
    maxRetries: number;
    backoffFactorMs: number;
  };
  cachePolicy?: {
    ttlMs: number;
    allowCache: boolean;
  };
  lastVerifiedAt: string | null;
  adapterVersion: string;
  endpointVerificationStatus: EndpointVerificationStatus;
}

export class SourceEndpointRegistry {
  private static instance: SourceEndpointRegistry | null = null;
  private endpoints: Map<string, SourceEndpointConfig> = new Map();

  constructor() {
    this.registerDefaults();
  }

  static getInstance(): SourceEndpointRegistry {
    if (!SourceEndpointRegistry.instance) {
      SourceEndpointRegistry.instance = new SourceEndpointRegistry();
    }
    return SourceEndpointRegistry.instance;
  }

  private registerDefaults(): void {
    const defaultConfigs: SourceEndpointConfig[] = [
      // 1. SSC
      {
        endpointId: 'ssc-primary',
        sourceId: 'IN-CENTRAL-SSC',
        organization: 'Staff Selection Commission (SSC)',
        officialDomains: ['ssc.gov.in'],
        officialDomain: 'ssc.gov.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://ssc.gov.in',
        endpointUrl: 'https://ssc.gov.in',
        purpose: 'Official SSC primary portal root and notice board entry point',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'drupal_views_zero_indexed_query',
        expectedContentType: 'text/html',
        detailPageStrategy: 'follow_html_or_direct_pdf',
        documentLinkStrategy: 'extract_pdf_and_doc_anchors',
        endpointPriority: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'ssc-notice-sanction',
        sourceId: 'IN-CENTRAL-SSC',
        organization: 'Staff Selection Commission (SSC)',
        officialDomains: ['ssc.gov.in'],
        officialDomain: 'ssc.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://ssc.gov.in/api/general-website/portal/notice-boards?page=1&limit=15&contentType=notice-boards&key=createdAt&order=DESC&isAttachment=true&language=english&attributes=id,headline,examId,contentType,redirectUrl,startDate,endDate,language,createdAt',
        endpointUrl:
          'https://ssc.gov.in/api/general-website/portal/notice-boards?page=1&limit=15&contentType=notice-boards&key=createdAt&order=DESC&isAttachment=true&language=english&attributes=id,headline,examId,contentType,redirectUrl,startDate,endDate,language,createdAt',
        purpose: 'Official SSC portal Notice Board JSON API backing the Angular Notice Board UI',
        expectedResponse: 'JSON_API_RESPONSE',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'ssc_portal_api_page_query',
        expectedContentType: 'application/json',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'ssc_api_attachment_pdf',
        endpointPriority: 2,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'ssc-notices-section',
        sourceId: 'IN-CENTRAL-SSC',
        organization: 'Staff Selection Commission (SSC)',
        officialDomains: ['ssc.gov.in'],
        officialDomain: 'ssc.gov.in',
        endpointType: 'NOTICE_BOARD',
        url: 'https://ssc.gov.in/notices',
        endpointUrl: 'https://ssc.gov.in/notices',
        purpose: 'Official SSC notices board fallback route',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'drupal_views_zero_indexed_query',
        expectedContentType: 'text/html',
        detailPageStrategy: 'follow_html_or_direct_pdf',
        documentLinkStrategy: 'extract_pdf_and_doc_anchors',
        endpointPriority: 3,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 2. UPSC
      {
        endpointId: 'upsc-primary',
        sourceId: 'IN-CENTRAL-UPSC',
        organization: 'Union Public Service Commission (UPSC)',
        officialDomains: ['www.upsc.gov.in', 'upsc.gov.in'],
        officialDomain: 'www.upsc.gov.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://www.upsc.gov.in',
        endpointUrl: 'https://www.upsc.gov.in',
        purpose: 'Official UPSC CDN-fronted portal root and What\'s New examination notifications listing',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DETAIL_REQUIRED',
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'drupal_views_query',
        expectedContentType: 'text/html',
        detailPageStrategy: 'follow_html_detail',
        documentLinkStrategy: 'extract_pdf_anchors',
        endpointPriority: 1,
        maxPages: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'upsc-active-exams',
        sourceId: 'IN-CENTRAL-UPSC',
        organization: 'Union Public Service Commission (UPSC)',
        officialDomains: ['www.upsc.gov.in', 'upsc.gov.in'],
        officialDomain: 'www.upsc.gov.in',
        endpointType: 'EXAM_LISTING',
        url: 'https://www.upsc.gov.in/examinations/active-exams',
        endpointUrl: 'https://www.upsc.gov.in/examinations/active-exams',
        purpose: 'Official UPSC active examinations listing with detail links to notification PDFs',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DETAIL_REQUIRED',
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'drupal_views_query',
        expectedContentType: 'text/html',
        detailPageStrategy: 'follow_html_detail',
        documentLinkStrategy: 'extract_pdf_anchors',
        endpointPriority: 2,
        maxPages: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'upsc-recruitment-advt',
        sourceId: 'IN-CENTRAL-UPSC',
        organization: 'Union Public Service Commission (UPSC)',
        officialDomains: ['www.upsc.gov.in', 'upsc.gov.in'],
        officialDomain: 'www.upsc.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://www.upsc.gov.in/recruitment/recruitment-advertisement',
        endpointUrl: 'https://www.upsc.gov.in/recruitment/recruitment-advertisement',
        purpose: 'Official UPSC ORA direct recruitment advertisements listing',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DETAIL_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'drupal_views_query',
        expectedContentType: 'text/html',
        detailPageStrategy: 'follow_html_detail',
        documentLinkStrategy: 'extract_pdf_anchors',
        endpointPriority: 3,
        maxPages: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 3. RRB (Registry-Driven Regional Discovery Strategy across Official Regional Boards)
      {
        endpointId: 'rrb-central-primary',
        sourceId: 'IN-CENTRAL-RRB',
        organization: 'Railway Recruitment Board Chandigarh (Nodal CEN Portal)',
        officialDomains: ['rrbcdg.gov.in', 'rrbapply.gov.in', 'indianrailways.gov.in'],
        officialDomain: 'rrbcdg.gov.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://rrbcdg.gov.in',
        endpointUrl: 'https://rrbcdg.gov.in',
        purpose: 'Official nodal RRB Chandigarh portal publishing Centralized Employment Notices (CEN)',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NEXT_LINK',
        nextPageDetectionMethod: 'next_link_anchor',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_html',
        documentLinkStrategy: 'cen_pdf_extraction',
        endpointPriority: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'rrb-cdg-secondary',
        sourceId: 'IN-CENTRAL-RRB',
        organization: 'Railway Recruitment Board Mumbai',
        officialDomains: ['rrbmumbai.gov.in', 'rrbcdg.gov.in'],
        officialDomain: 'rrbmumbai.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://rrbmumbai.gov.in',
        endpointUrl: 'https://rrbmumbai.gov.in',
        purpose: 'Official regional RRB Mumbai portal publishing CEN notifications and regional panels',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NEXT_LINK',
        nextPageDetectionMethod: 'next_link_anchor',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_html',
        documentLinkStrategy: 'cen_pdf_extraction',
        endpointPriority: 2,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'rrb-chennai-regional',
        sourceId: 'IN-CENTRAL-RRB',
        organization: 'Railway Recruitment Board Chennai',
        officialDomains: ['rrbchennai.gov.in'],
        officialDomain: 'rrbchennai.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://rrbchennai.gov.in',
        endpointUrl: 'https://rrbchennai.gov.in',
        purpose: 'Official regional RRB Chennai portal publishing CEN notifications and updates',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NEXT_LINK',
        nextPageDetectionMethod: 'next_link_anchor',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_html',
        documentLinkStrategy: 'cen_pdf_extraction',
        endpointPriority: 3,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'rrb-kolkata-regional',
        sourceId: 'IN-CENTRAL-RRB',
        organization: 'Railway Recruitment Board Kolkata',
        officialDomains: ['rrbkolkata.gov.in'],
        officialDomain: 'rrbkolkata.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://rrbkolkata.gov.in',
        endpointUrl: 'https://rrbkolkata.gov.in',
        purpose: 'Official regional RRB Kolkata portal publishing CEN notifications and updates',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NEXT_LINK',
        nextPageDetectionMethod: 'next_link_anchor',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_html',
        documentLinkStrategy: 'cen_pdf_extraction',
        endpointPriority: 4,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'rrb-secunderabad-regional',
        sourceId: 'IN-CENTRAL-RRB',
        organization: 'Railway Recruitment Board Secunderabad',
        officialDomains: ['rrbsecunderabad.gov.in'],
        officialDomain: 'rrbsecunderabad.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://rrbsecunderabad.gov.in',
        endpointUrl: 'https://rrbsecunderabad.gov.in',
        purpose: 'Official regional RRB Secunderabad portal publishing CEN notifications and updates',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NEXT_LINK',
        nextPageDetectionMethod: 'next_link_anchor',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_html',
        documentLinkStrategy: 'cen_pdf_extraction',
        endpointPriority: 5,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 4. BPSC
      {
        endpointId: 'bpsc-primary',
        sourceId: 'IN-BIHAR-BPSC',
        organization: 'Bihar Public Service Commission (BPSC)',
        officialDomains: ['bpsc.bih.nic.in'],
        officialDomain: 'bpsc.bih.nic.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://bpsc.bih.nic.in',
        endpointUrl: 'https://bpsc.bih.nic.in',
        purpose: 'Official BPSC main notice board listing recruitment advertisements and direct PDFs',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'bilingual_hindi_english_table',
        endpointPriority: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'bpsc-notice-header',
        sourceId: 'IN-BIHAR-BPSC',
        organization: 'Bihar Public Service Commission (BPSC)',
        officialDomains: ['bpsc.bih.nic.in'],
        officialDomain: 'bpsc.bih.nic.in',
        endpointType: 'NOTICE_BOARD',
        url: 'https://bpsc.bih.nic.in/NoticeHeader.htm',
        endpointUrl: 'https://bpsc.bih.nic.in/NoticeHeader.htm',
        purpose: 'Official BPSC secondary notice header table frame',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'bilingual_hindi_english_table',
        endpointPriority: 2,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'bpsc-bihar-gov',
        sourceId: 'IN-BIHAR-BPSC',
        organization: 'Bihar Public Service Commission (BPSC)',
        officialDomains: ['bpsc.bihar.gov.in', 'bpsc.bih.nic.in'],
        officialDomain: 'bpsc.bihar.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://bpsc.bihar.gov.in',
        endpointUrl: 'https://bpsc.bihar.gov.in',
        purpose: 'Official alternate BPSC Bihar state portal mirror',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'bilingual_hindi_english_table',
        endpointPriority: 3,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 5. BSSC
      {
        endpointId: 'bssc-primary',
        sourceId: 'IN-BIHAR-BSSC',
        organization: 'Bihar Staff Selection Commission (BSSC)',
        officialDomains: ['bssc.bihar.gov.in'],
        officialDomain: 'bssc.bihar.gov.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://bssc.bihar.gov.in',
        endpointUrl: 'https://bssc.bihar.gov.in',
        purpose: 'Official BSSC portal root',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'noticeboard_table',
        endpointPriority: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'bssc-notice-board',
        sourceId: 'IN-BIHAR-BSSC',
        organization: 'Bihar Staff Selection Commission (BSSC)',
        officialDomains: ['bssc.bihar.gov.in'],
        officialDomain: 'bssc.bihar.gov.in',
        endpointType: 'NOTICE_BOARD',
        url: 'https://bssc.bihar.gov.in/NoticeBoard.htm',
        endpointUrl: 'https://bssc.bihar.gov.in/NoticeBoard.htm',
        purpose: 'Official BSSC Soochna Pat (NoticeBoard.htm) listing recruitment notices and PDFs',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'noticeboard_table',
        endpointPriority: 2,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'bssc-bih-nic',
        sourceId: 'IN-BIHAR-BSSC',
        organization: 'Bihar Staff Selection Commission (BSSC)',
        officialDomains: ['bssc.bih.nic.in', 'bssc.bihar.gov.in'],
        officialDomain: 'bssc.bih.nic.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://bssc.bih.nic.in',
        endpointUrl: 'https://bssc.bih.nic.in',
        purpose: 'Official alternate BSSC NIC portal mirror',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: false,
        detailFlow: 'DIRECT_PDF',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'NONE',
        nextPageDetectionMethod: 'none',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf',
        documentLinkStrategy: 'noticeboard_table',
        endpointPriority: 3,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 6. UPPSC
      {
        endpointId: 'uppsc-primary',
        sourceId: 'IN-UP-UPPSC',
        organization: 'Uttar Pradesh Public Service Commission (UPPSC)',
        officialDomains: ['uppsc.up.nic.in'],
        officialDomain: 'uppsc.up.nic.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://uppsc.up.nic.in',
        endpointUrl: 'https://uppsc.up.nic.in',
        purpose: 'Official UPPSC home portal exposing active advertisements and Whats_New_Scroling Open_PDF.aspx links',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'aspx_gridview_paging',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_aspx',
        documentLinkStrategy: 'all_notifications_grid',
        endpointPriority: 1,
        maxPages: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'uppsc-all-notifications',
        sourceId: 'IN-UP-UPPSC',
        organization: 'Uttar Pradesh Public Service Commission (UPPSC)',
        officialDomains: ['uppsc.up.nic.in'],
        officialDomain: 'uppsc.up.nic.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://uppsc.up.nic.in/CandidatePages/Notifications.aspx',
        endpointUrl: 'https://uppsc.up.nic.in/CandidatePages/Notifications.aspx',
        purpose: 'Official UPPSC CandidatePages All Notifications table for active recruitment advertisements',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'aspx_gridview_paging',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_aspx',
        documentLinkStrategy: 'all_notifications_grid',
        endpointPriority: 2,
        maxPages: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },

      // 7. UPSSSC
      {
        endpointId: 'upsssc-primary',
        sourceId: 'IN-UP-UPSSSC',
        organization: 'Uttar Pradesh Subordinate Services Selection Commission (UPSSSC)',
        officialDomains: ['upsssc.gov.in'],
        officialDomain: 'upsssc.gov.in',
        endpointType: 'PRIMARY_LISTING',
        url: 'https://upsssc.gov.in',
        endpointUrl: 'https://upsssc.gov.in',
        purpose: 'Official UPSSSC home portal and notice board',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'aspx_gridview_paging',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_aspx',
        documentLinkStrategy: 'all_notifications_grid',
        endpointPriority: 1,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
      {
        endpointId: 'upsssc-all-notifications',
        sourceId: 'IN-UP-UPSSSC',
        organization: 'Uttar Pradesh Subordinate Services Selection Commission (UPSSSC)',
        officialDomains: ['upsssc.gov.in'],
        officialDomain: 'upsssc.gov.in',
        endpointType: 'SECONDARY_LISTING',
        url: 'https://upsssc.gov.in/AllNotifications.aspx',
        endpointUrl: 'https://upsssc.gov.in/AllNotifications.aspx',
        purpose: 'Official UPSSSC AllNotifications.aspx recruitment advertisement grid',
        expectedResponse: 'HTML_LISTING',
        paginationSupported: true,
        detailFlow: 'DIRECT_PDF_OR_DETAIL',
        documentFlow: 'LISTING_TO_DOCUMENT',
        active: true,
        httpMethod: 'GET',
        paginationMethod: 'QUERY_PARAM',
        paginationParam: 'page',
        nextPageDetectionMethod: 'aspx_gridview_paging',
        expectedContentType: 'text/html',
        detailPageStrategy: 'direct_pdf_or_aspx',
        documentLinkStrategy: 'all_notifications_grid',
        endpointPriority: 2,
        enabled: true,
        lastVerifiedAt: new Date().toISOString(),
        adapterVersion: '1.3.0',
        endpointVerificationStatus: 'VERIFIED',
      },
    ];

    for (const ep of defaultConfigs) {
      this.endpoints.set(ep.endpointId, ep);
    }
  }

  getEndpointsForSource(sourceId: string): SourceEndpointConfig[] {
    return Array.from(this.endpoints.values())
      .filter((ep) => ep.sourceId === sourceId && ep.enabled)
      .sort((a, b) => a.endpointPriority - b.endpointPriority);
  }

  getAllEndpoints(): SourceEndpointConfig[] {
    return Array.from(this.endpoints.values());
  }

  getEndpoint(endpointId: string): SourceEndpointConfig | undefined {
    return this.endpoints.get(endpointId);
  }

  auditEndpoints(sourceId?: string): SourceEndpointAuditRecord[] {
    const list = sourceId
      ? Array.from(this.endpoints.values()).filter((ep) => ep.sourceId === sourceId)
      : Array.from(this.endpoints.values());
    return list
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.endpointPriority - b.endpointPriority)
      .map((ep) => ({
        endpointId: ep.endpointId,
        sourceId: ep.sourceId,
        organization: ep.organization,
        endpointUrl: ep.endpointUrl || ep.url,
        officialDomain: ep.officialDomain || ep.officialDomains[0] || '',
        officialDomains: ep.officialDomains,
        endpointType: ep.endpointType,
        purpose: ep.purpose || `${ep.organization} ${ep.endpointType}`,
        expectedResponse:
          ep.expectedResponse ||
          (ep.expectedContentType.includes('json') ? 'JSON_API_RESPONSE' : 'HTML_LISTING'),
        paginationSupported: ep.paginationSupported ?? ep.paginationMethod !== 'NONE',
        detailFlow:
          ep.detailFlow ||
          (ep.detailPageStrategy === 'direct_pdf'
            ? 'DIRECT_PDF'
            : ep.detailPageStrategy === 'follow_html_detail'
            ? 'DETAIL_REQUIRED'
            : 'DIRECT_PDF_OR_DETAIL'),
        documentFlow:
          ep.documentFlow ||
          (ep.detailPageStrategy === 'follow_html_detail'
            ? 'LISTING_TO_DETAIL_TO_DOCUMENT'
            : 'LISTING_TO_DOCUMENT'),
        active: ep.active ?? ep.enabled,
        endpointPriority: ep.endpointPriority,
      }));
  }

  updateEndpointStatus(
    endpointId: string,
    status: EndpointVerificationStatus,
    verifiedAt = new Date().toISOString()
  ): void {
    const ep = this.endpoints.get(endpointId);
    if (ep) {
      ep.endpointVerificationStatus = status;
      ep.lastVerifiedAt = verifiedAt;
    }
  }
}

export const sourceEndpointRegistry = SourceEndpointRegistry.getInstance();
