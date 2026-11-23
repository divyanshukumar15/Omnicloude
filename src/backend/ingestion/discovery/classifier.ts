/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  NoticeCategory,
  DiscoveredDocumentLink,
  RecruitmentNoticeType,
  OfficialDocumentCategory,
} from './types.ts';

/**
 * Regex patterns for Advertisement numbers across Central, Bihar, and UP government sources.
 */
const CENTRAL_SSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|Notice\s*No\.?|F\.?\s*No\.?)\s*([A-Za-z0-9\-_./]+)/i,
  /(?:Phase\s*[-–]\s*[IVXLCDM0-9]+(?:\/\d{4})?)/i,
  /(?:HQ-[A-Za-z0-9/_-]+)/i,
];

const CENTRAL_UPSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|Advertisement\s*No\.?)\s*([0-9]{1,3}\/[0-9]{4}(?:-[A-Za-z0-9]+)?)/i,
  /([0-9]{1,3}\/[0-9]{4}(?:-[A-Za-z0-9]+)?)/i,
];

const CENTRAL_RRB_CEN_PATTERNS = [
  /(?:CEN|Centralized\s*Employment\s*Notice)\s*(?:No\.?)?\s*([0-9]{1,3}\/[0-9]{4}(?:\s*\([A-Za-z0-9\s-]+\))?)/i,
  /(?:CEN)\s*([A-Za-z0-9/_-]+)/i,
];

const BIHAR_BPSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)\s*([0-9]{1,3}\/[0-9]{4})/i,
  /([0-9]{1,3}\/[0-9]{4})/i,
];

const BIHAR_BSSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|विज्ञापन\s*सं(?:ख्या)?\.?)\s*([0-9]{1,3}\/[0-9]{2,4})/i,
  /([0-9]{1,3}\/[0-9]{2,4})/i,
];

const UP_UPPSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)?\s*([A-Z]-[0-9]+\/[A-Z0-9-]+\/[0-9]{4})/i,
  /([A-Z]-[0-9]+\/[A-Z0-9-]+\/[0-9]{4})/i,
];

const UP_UPSSSC_ADVT_PATTERNS = [
  /(?:Advt\.?\s*No\.?|विज्ञापन\s*संख्या)?\s*([0-9]{1,2}-[A-Za-z\u0900-\u097F]+\/[0-9]{4})/i,
  /([0-9]{1,2}-[0-9A-Za-z/_-]+)/i,
];

/**
 * Normalizes RRB CEN notification identifiers (e.g. "CEN No. 01/2024 (ALP)" -> "CEN 01/2024").
 */
export function normalizeCenNumber(rawText: string): string | null {
  const match = rawText.match(/(?:CEN|Centralized\s*Employment\s*Notice)\s*(?:No\.?)?\s*([0-9]{1,3}\/[0-9]{4})/i);
  if (match) {
    return `CEN ${match[1].trim()}`;
  }
  return null;
}

/**
 * Extracts and normalizes advertisement/notification number based on sourceId and notice text.
 */
export function extractAdvertisementNumber(text: string, sourceId: string): string | null {
  if (!text || text.trim().length === 0) return null;

  switch (sourceId) {
    case 'IN-CENTRAL-SSC':
      for (const pattern of CENTRAL_SSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    case 'IN-CENTRAL-UPSC':
      for (const pattern of CENTRAL_UPSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    case 'IN-CENTRAL-RRB': {
      const cen = normalizeCenNumber(text);
      if (cen) return cen;
      for (const pattern of CENTRAL_RRB_CEN_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;
    }

    case 'IN-BIHAR-BPSC':
      for (const pattern of BIHAR_BPSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    case 'IN-BIHAR-BSSC':
      for (const pattern of BIHAR_BSSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    case 'IN-UP-UPPSC':
      for (const pattern of UP_UPPSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    case 'IN-UP-UPSSSC':
      for (const pattern of UP_UPSSSC_ADVT_PATTERNS) {
        const m = text.match(pattern);
        if (m) return (m[1] || m[0]).trim();
      }
      break;

    default: {
      const generic = text.match(/(?:Advt\.?\s*No\.?|Notice\s*No\.?|Notification\s*No\.?)\s*([A-Za-z0-9/_-]+)/i);
      if (generic) return generic[1].trim();
      break;
    }
  }

  return null;
}

export interface ExplainableClassification {
  category: NoticeCategory;
  recruitmentType: RecruitmentNoticeType;
  documentCategory: OfficialDocumentCategory;
  isRecruitmentRelated: boolean;
  confidence: number;
  reason: string;
}

/**
 * Performs explainable classification of notice title and context.
 * Identifies false positives (tenders, admin circulars, holidays) and returns explicit confidence and reasons.
 */
export function classifyNoticeExplainable(title: string, contextText = ''): ExplainableClassification {
  const combined = `${title} ${contextText}`.toLowerCase();

  // 1. Tenders and irrelevant administrative notices (unrelated to job seekers)
  const irrelevantPatterns = [
    { token: 'tender', reason: 'Tender procurement notice' },
    { token: 'e-procurement', reason: 'Procurement portal notice' },
    { token: 'निविदा', reason: 'Hindi procurement/tender notice (निविदा)' },
    { token: 'quotation', reason: 'Commercial quotation request' },
    { token: 'rfp', reason: 'Request for proposal notice' },
    { token: 'auction', reason: 'Property or scrap auction notice' },
    { token: 'stationery', reason: 'Office supplies procurement notice' },
    { token: 'vehicle hiring', reason: 'Vehicle procurement / administrative transport' },
    { token: 'office maintenance', reason: 'Internal office maintenance notice' },
    { token: 'housekeeping', reason: 'Facility management notice' },
    { token: 'transfer / posting', reason: 'Internal employee transfer/posting order' },
    { token: 'transfer order', reason: 'Internal employee transfer order' },
    { token: 'disposal of scrap', reason: 'Administrative scrap disposal' },
    { token: 'holiday list', reason: 'Official government holiday circular' },
    { token: 'gazetted holiday', reason: 'Government holiday notification' },
    { token: 'circular regarding leave', reason: 'Internal employee leave circular' },
  ];

  for (const item of irrelevantPatterns) {
    if (combined.includes(item.token)) {
      return {
        category: 'IRRELEVANT_NOTICE',
        recruitmentType: 'IRRELEVANT',
        documentCategory: 'OTHER',
        isRecruitmentRelated: false,
        confidence: 0.95,
        reason: item.reason,
      };
    }
  }

  // 2. Corrigendum / Extension / Amendment
  if (
    combined.includes('extension of last date') ||
    combined.includes('last date extended') ||
    combined.includes('तिथि विस्तार') ||
    combined.includes('तिथि बढ़ाई गई') ||
    combined.includes('date extension notice')
  ) {
    return {
      category: 'CORRIGENDUM',
      recruitmentType: 'EXTENSION',
      documentCategory: 'CORRIGENDUM',
      isRecruitmentRelated: true,
      confidence: 0.95,
      reason: 'Application or examination date extension notice',
    };
  }

  if (
    combined.includes('revised vacancy') ||
    combined.includes('revised notification') ||
    combined.includes('संशोधित')
  ) {
    return {
      category: 'CORRIGENDUM',
      recruitmentType: 'REVISED_NOTIFICATION',
      documentCategory: 'CORRIGENDUM',
      isRecruitmentRelated: true,
      confidence: 0.92,
      reason: 'Revised vacancy or notification details',
    };
  }

  if (
    combined.includes('corrigendum') ||
    combined.includes('amendment') ||
    combined.includes('addendum') ||
    combined.includes('शुद्धिपत्र') ||
    combined.includes('संशोधन') ||
    combined.includes('शुद्धि-पत्र') ||
    combined.includes('errata')
  ) {
    const isAddendum = combined.includes('addendum');
    return {
      category: isAddendum ? 'ADDENDUM' : 'CORRIGENDUM',
      recruitmentType: 'CORRIGENDUM',
      documentCategory: 'CORRIGENDUM',
      isRecruitmentRelated: true,
      confidence: 0.95,
      reason: isAddendum ? 'Addendum notice to existing advertisement' : 'Corrigendum/amendment notice to existing advertisement',
    };
  }

  // 3. Admit Card / Hall Ticket
  if (
    combined.includes('admit card') ||
    combined.includes('hall ticket') ||
    combined.includes('e-admit') ||
    combined.includes('प्रवेश पत्र') ||
    combined.includes('call letter')
  ) {
    return {
      category: 'ADMIT_CARD',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'ADMIT_CARD',
      isRecruitmentRelated: true,
      confidence: 0.95,
      reason: 'Admit card or examination hall ticket release notice',
    };
  }

  // 4. Exam Notice / Schedule
  if (
    combined.includes('exam date') ||
    combined.includes('examination schedule') ||
    combined.includes('time table') ||
    combined.includes('परीक्षा कार्यक्रम') ||
    combined.includes('exam city') ||
    combined.includes('examination calendar') ||
    combined.includes('date of examination')
  ) {
    return {
      category: 'EXAM_NOTICE',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'EXAM_NOTICE',
      isRecruitmentRelated: true,
      confidence: 0.92,
      reason: 'Examination schedule, exam date, or exam city announcement',
    };
  }

  // 5. Application Notice
  if (
    combined.includes('online application') ||
    combined.includes('application form') ||
    combined.includes('apply online') ||
    combined.includes('आवेदन पत्र') ||
    combined.includes('re-opening of online application')
  ) {
    return {
      category: 'APPLICATION_NOTICE',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'APPLICATION_NOTICE',
      isRecruitmentRelated: true,
      confidence: 0.9,
      reason: 'Online application form or portal activation notice',
    };
  }

  // 6. Result / Selection List
  if (
    combined.includes('result') ||
    combined.includes('merit list') ||
    combined.includes('final recommendation') ||
    combined.includes('selection list') ||
    combined.includes('परीक्षाफल') ||
    combined.includes('चयन सूची') ||
    combined.includes('marks')
  ) {
    return {
      category: 'RESULT',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'RESULT',
      isRecruitmentRelated: true,
      confidence: 0.94,
      reason: 'Recruitment examination result, cut-off marks, or final merit list',
    };
  }

  // 7. Answer Key
  if (
    combined.includes('answer key') ||
    combined.includes('tentative answer key') ||
    combined.includes('objection tracker') ||
    combined.includes('उत्तर कुंजी')
  ) {
    return {
      category: 'ANSWER_KEY',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'ANSWER_KEY',
      isRecruitmentRelated: true,
      confidence: 0.95,
      reason: 'Tentative or final answer key and objection management notice',
    };
  }

  // 8. Syllabus
  if (
    combined.includes('syllabus') ||
    combined.includes('exam pattern') ||
    combined.includes('पाठ्यक्रम')
  ) {
    return {
      category: 'SYLLABUS',
      recruitmentType: 'RECRUITMENT_UPDATE',
      documentCategory: 'SYLLABUS',
      isRecruitmentRelated: true,
      confidence: 0.92,
      reason: 'Curriculum, exam scheme, or detailed syllabus notice',
    };
  }

  // 9. Primary Recruitment Notification / Vacancy
  if (
    combined.includes('recruitment') ||
    combined.includes('notification') ||
    combined.includes('advertisement') ||
    combined.includes('advt') ||
    combined.includes('notice') ||
    combined.includes('vacancy') ||
    combined.includes('विज्ञापन') ||
    combined.includes('भर्ती') ||
    combined.includes('cen ') ||
    combined.includes('examination, 20') ||
    combined.includes('examination-20') ||
    combined.includes('exam 20') ||
    combined.includes('combined graduate level') ||
    combined.includes('combined higher secondary') ||
    combined.includes('civil services') ||
    combined.includes('combined state') ||
    combined.includes('post recruitment')
  ) {
    return {
      category: 'NOTIFICATION',
      recruitmentType: 'NEW_RECRUITMENT',
      documentCategory: 'RECRUITMENT_NOTIFICATION',
      isRecruitmentRelated: true,
      confidence: 0.92,
      reason: 'Authoritative official recruitment notification or employment advertisement',
    };
  }

  return {
    category: 'UNKNOWN',
    recruitmentType: 'UNKNOWN',
    documentCategory: 'OTHER',
    isRecruitmentRelated: false,
    confidence: 0.3,
    reason: 'Notice does not match established government recruitment or procurement patterns',
  };
}

/**
 * Classifies government notice into category using keyword analysis in English & Hindi.
 */
export function classifyNotice(title: string, contextText = ''): NoticeCategory {
  return classifyNoticeExplainable(title, contextText).category;
}

/**
 * Determines high-level recruitment notice type for workflow routing.
 */
export function classifyRecruitmentType(category: NoticeCategory, title = ''): RecruitmentNoticeType {
  const explainable = classifyNoticeExplainable(title);
  if (explainable.recruitmentType !== 'UNKNOWN' && explainable.recruitmentType !== 'NON_RECRUITMENT') {
    return explainable.recruitmentType;
  }

  if (category === 'CORRIGENDUM' || category === 'ADDENDUM') {
    return 'CORRIGENDUM';
  }
  if (category === 'NOTIFICATION' || category === 'RECRUITMENT_NOTICE' || category === 'RECRUITMENT_PDF') {
    return 'NEW_RECRUITMENT';
  }
  if (
    category === 'EXAM_NOTICE' ||
    category === 'EXAM_DATE' ||
    category === 'APPLICATION_NOTICE' ||
    category === 'ADMIT_CARD' ||
    category === 'RESULT' ||
    category === 'ANSWER_KEY' ||
    category === 'SYLLABUS'
  ) {
    return 'RECRUITMENT_UPDATE';
  }
  if (category === 'IRRELEVANT_NOTICE' || category === 'TENDER') {
    return 'IRRELEVANT';
  }
  return 'NON_RECRUITMENT';
}

/**
 * Returns whether notice is relevant to recruitment pipeline.
 */
export function isRecruitmentRelated(category: NoticeCategory): boolean {
  return category !== 'IRRELEVANT_NOTICE' && category !== 'TENDER' && category !== 'UNKNOWN';
}

/**
 * Classifies document links (PDF vs HTML vs DOC) and determines if it is the primary notification.
 */
export function classifyDocumentLink(
  href: string,
  linkText: string,
  noticeCategory: NoticeCategory
): DiscoveredDocumentLink {
  const cleanUrl = href.trim();
  const lowerUrl = cleanUrl.toLowerCase();
  const lowerText = linkText.toLowerCase();

  let documentType: DiscoveredDocumentLink['documentType'] = 'UNKNOWN';
  if (
    lowerUrl.endsWith('.pdf') ||
    lowerUrl.includes('.pdf?') ||
    lowerUrl.includes('/pdf/') ||
    lowerUrl.includes('open_pdf.aspx') ||
    lowerUrl.includes('download_pdf.aspx') ||
    lowerUrl.includes('viewpdf.aspx')
  ) {
    documentType = 'PDF';
  } else if (
    lowerUrl.endsWith('.html') ||
    lowerUrl.endsWith('.htm') ||
    lowerUrl.endsWith('.aspx') ||
    lowerUrl.endsWith('.php') ||
    lowerUrl.includes('.html?') ||
    lowerUrl.includes('.htm?') ||
    lowerUrl.includes('.aspx?') ||
    lowerUrl.includes('.php?') ||
    lowerUrl.includes('/whats-new/') ||
    lowerUrl.includes('/examinations/') ||
    lowerUrl.includes('/recruitment/') ||
    lowerUrl.includes('/notice/') ||
    lowerUrl.includes('/detail/') ||
    lowerUrl.endsWith('/forms-downloads') ||
    lowerUrl.includes('/forms-downloads?')
  ) {
    documentType = 'HTML';
  } else if (lowerUrl.endsWith('.doc') || lowerUrl.endsWith('.docx')) {
    documentType = 'DOC';
  } else {
    if (lowerText.includes('pdf') || lowerText.includes('download')) {
      documentType = 'PDF';
    }
  }

  // Classify official document category
  let documentCategory: OfficialDocumentCategory = 'OTHER';
  let classificationReason = 'Generic official document attachment';
  let confidence = 0.7;

  if (lowerText.includes('syllabus') || lowerText.includes('पाठ्यक्रम')) {
    documentCategory = 'SYLLABUS';
    classificationReason = 'Syllabus document';
    confidence = 0.95;
  } else if (lowerText.includes('admit') || lowerText.includes('प्रवेश पत्र')) {
    documentCategory = 'ADMIT_CARD';
    classificationReason = 'Admit card document';
    confidence = 0.95;
  } else if (lowerText.includes('corrigendum') || lowerText.includes('शुद्धिपत्र') || lowerText.includes('amendment') || lowerText.includes('addendum')) {
    documentCategory = 'CORRIGENDUM';
    classificationReason = 'Corrigendum document';
    confidence = 0.95;
  } else if (lowerText.includes('result') || lowerText.includes('merit') || lowerText.includes('चयन') || lowerUrl.includes('/wr-') || lowerUrl.includes('/fr-')) {
    documentCategory = 'RESULT';
    classificationReason = 'Result document';
    confidence = 0.95;
  } else if (lowerText.includes('answer key') || lowerText.includes('कुंजी')) {
    documentCategory = 'ANSWER_KEY';
    classificationReason = 'Answer key document';
    confidence = 0.95;
  } else if (lowerText.includes('apply') || lowerText.includes('application form') || lowerText.includes('आवेदन')) {
    documentCategory = 'APPLICATION_NOTICE';
    classificationReason = 'Application form or instructions document';
    confidence = 0.9;
  } else if (lowerText.includes('vacancy') || lowerText.includes('vacancies') || lowerText.includes('पद')) {
    documentCategory = 'VACANCY_NOTICE';
    classificationReason = 'Vacancy matrix document';
    confidence = 0.9;
  } else if (
    lowerText.includes('notification') ||
    lowerText.includes('detailed advertisement') ||
    lowerText.includes('advt') ||
    lowerText.includes('विज्ञापन') ||
    lowerText.includes('detailed notice') ||
    lowerUrl.includes('advtno') ||
    lowerUrl.includes('advt-') ||
    lowerUrl.includes('notif-') ||
    lowerUrl.includes('cen_') ||
    noticeCategory === 'NOTIFICATION' ||
    noticeCategory === 'RECRUITMENT_NOTICE'
  ) {
    documentCategory = 'RECRUITMENT_NOTIFICATION';
    classificationReason = 'Authoritative recruitment notification document';
    confidence = 0.95;
  }

  const isPrimary =
    documentCategory === 'RECRUITMENT_NOTIFICATION' &&
    documentType === 'PDF' &&
    !lowerText.includes('syllabus') &&
    !lowerText.includes('form') &&
    !lowerText.includes('proforma') &&
    !lowerText.includes('corrigendum');

  return {
    url: cleanUrl,
    canonicalUrl: cleanUrl.split('#')[0],
    title: linkText.trim() || 'Official Notice Document',
    documentType,
    documentCategory,
    isPrimaryNotification: isPrimary,
    classificationReason,
    confidence,
  };
}

/**
 * Parses published or closing dates from notice titles/subtitles if available.
 */
export function extractDateFromText(text: string): string | null {
  if (!text) return null;

  // DD/MM/YYYY or DD-MM-YYYY
  const matchDmy = text.match(/\b([0-3]?[0-9])[/-]([0-1]?[0-9])[/-](20[2-3][0-9])\b/);
  if (matchDmy) {
    const day = matchDmy[1].padStart(2, '0');
    const month = matchDmy[2].padStart(2, '0');
    const year = matchDmy[3];
    return `${year}-${month}-${day}`;
  }

  // DD Month YYYY (e.g. 15 March 2024 or 15-Mar-2024)
  const monthMap: Record<string, string> = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };

  const matchTextDate = text.match(/\b([0-3]?[0-9])[- ]+([A-Za-z]{3,9})[- ,]+(20[2-3][0-9])\b/i);
  if (matchTextDate) {
    const day = matchTextDate[1].padStart(2, '0');
    const mStr = matchTextDate[2].toLowerCase();
    const year = matchTextDate[3];
    const month = monthMap[mStr];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}
