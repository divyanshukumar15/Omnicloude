/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { NormalizedDocument, NormalizedPage } from '../ingestion/types.ts';
import type {
  StructuredRecruitmentData,
  StructuredRecruitmentRecord,
  ExtractedField,
  FieldEvidence,
  RecruitmentValidationStatus,
  ApplicationFeeStructure,
  CategoryWiseVacancies,
} from './types.ts';
import { RecruitmentPersistenceError, classifyPersistenceError } from './types.ts';
import { DateValidator } from './date-validator.ts';
import { EvidenceValidator } from './evidence-validator.ts';
import { DeterministicFieldValidator } from './field-validator.ts';
import { CorrigendumDetector } from './corrigendum-detector.ts';
import { getDatabase, getRepositories, runInSqliteTransaction } from '../database/index.ts';
import { getAuditService } from '../audit/index.ts';
import { logger } from '../config/logger.ts';
import { detectAndExtractTables } from '../ingestion/extraction/text-structure.ts';

export interface ExtractionContext {
  readonly documentId: string;
  readonly sourceId: string;
  readonly correlationId: string;
  readonly pages: ReadonlyArray<NormalizedPage>;
  readonly pageMethodMap: ReadonlyMap<number, string>;
  readonly pageMetadataMap: ReadonlyMap<number, NormalizedPage>;
  readonly warnings: string[];
  readonly auditTrail: StructuredRecruitmentRecord['auditTrail'];
}

export interface ExtractRecruitmentOptions {
  /**
   * When false, runs full extraction, validation, and deterministic identity generation
   * as an isolated candidate WITHOUT writing to `recruitments` or `jobs` yet so
   * DUPLICATE_CHECK can execute first. Defaults to true for backwards compatibility.
   */
  persist?: boolean;
}

export interface CanonicalRecruitmentIdentity {
  canonicalIdentityKey: string;
  deterministicRecruitmentId: string;
  basis: 'SOURCE_ADVT' | 'SOURCE_CORRIGENDUM_DOC' | 'SOURCE_CANONICAL_URL' | 'SOURCE_CHECKSUM' | 'SOURCE_TITLE';
}

function normalizeIdentityToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097f\/\-_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeUrlForIdentity(rawUrl: string | undefined | null): string {
  if (!rawUrl || !rawUrl.trim()) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}${parsed.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Generates a deterministic canonical identity key and recruitment ID from stable
 * official source/document attributes so retries and duplicates always converge.
 */
export function computeCanonicalRecruitmentIdentity(params: {
  sourceId: string;
  advertisementNumber?: string | null;
  canonicalUrl?: string | null;
  checksumSha256?: string | null;
  title?: string | null;
  isCorrigendum?: boolean;
  documentId?: string;
}): CanonicalRecruitmentIdentity {
  const sourceKey = (params.sourceId || 'UNKNOWN_SOURCE').trim().toUpperCase();
  const advt = params.advertisementNumber ? normalizeIdentityToken(params.advertisementNumber) : '';
  const url = normalizeUrlForIdentity(params.canonicalUrl);
  const checksum = params.checksumSha256?.trim().toLowerCase() || '';
  const normTitle = params.title ? normalizeIdentityToken(params.title) : '';

  let canonicalIdentityKey: string;
  let basis: CanonicalRecruitmentIdentity['basis'];

  if (params.isCorrigendum) {
    // Corrigenda are linked to parent recruitments rather than duplicating parent identity
    const docPart = checksum || url || params.documentId || normTitle || 'corrigendum';
    canonicalIdentityKey = `corrigendum::${sourceKey}::${advt || 'unreferenced'}::${docPart}`;
    basis = 'SOURCE_CORRIGENDUM_DOC';
  } else if (advt && advt.length >= 2) {
    canonicalIdentityKey = `recruitment::${sourceKey}::advt::${advt}`;
    basis = 'SOURCE_ADVT';
  } else if (url) {
    canonicalIdentityKey = `recruitment::${sourceKey}::url::${url}`;
    basis = 'SOURCE_CANONICAL_URL';
  } else if (checksum) {
    canonicalIdentityKey = `recruitment::${sourceKey}::sha256::${checksum}`;
    basis = 'SOURCE_CHECKSUM';
  } else {
    canonicalIdentityKey = `recruitment::${sourceKey}::title::${normTitle || params.documentId || 'untitled'}`;
    basis = 'SOURCE_TITLE';
  }

  const digest = crypto.createHash('sha256').update(canonicalIdentityKey).digest('hex').slice(0, 24);
  return {
    canonicalIdentityKey,
    deterministicRecruitmentId: `rec-${digest}`,
    basis,
  };
}

function parseNumericToken(raw: string): number {
  return parseInt(raw.replace(/,/g, ''), 10);
}

/**
 * Stateless, concurrency-safe structured extraction service.
 * All per-document state lives inside an isolated per-execution ExtractionContext.
 */
export class StructuredExtractionService {
  /**
   * Creates an isolated per-execution ExtractionContext so concurrent extractions
   * never share or overwrite page metadata/method maps.
   */
  public createExtractionContext(
    document: NormalizedDocument,
    correlationId: string = crypto.randomUUID()
  ): ExtractionContext {
    return {
      documentId: document.id,
      sourceId: document.sourceId,
      correlationId,
      pages: document.pages,
      pageMethodMap: new Map(document.pages.map((p) => [p.pageNumber, p.extractionMethod])),
      pageMetadataMap: new Map(document.pages.map((p) => [p.pageNumber, p])),
      warnings: [],
      auditTrail: [],
    };
  }

  /**
   * Helper to initialize a missing field without hallucinated values.
   */
  public createMissingField<T>(fieldDescription = 'Not Mentioned'): ExtractedField<T> {
    return {
      value: null,
      state: 'MISSING',
      confidence: 0.0,
      evidence: null,
      validationNotes: `${fieldDescription} in official notification`,
    };
  }

  /**
   * Helper to construct valid FieldEvidence with complete provenance using an isolated ExtractionContext.
   */
  public createEvidence(
    documentId: string,
    pageNumber: number,
    fieldName: string,
    snippet: string,
    extractionMethod: 'DIRECT_TEXT' | 'OCR' | 'TABLE_EXTRACTION' | 'DOCUMENT_METADATA' = 'DIRECT_TEXT',
    verifiedInDocument = false,
    ctx?: ExtractionContext
  ): FieldEvidence {
    const pageMeta = ctx?.pageMetadataMap.get(pageNumber);
    const pageMethod = pageMeta?.extractionMethod || ctx?.pageMethodMap.get(pageNumber);
    const resolvedMethod =
      extractionMethod === 'DIRECT_TEXT' && pageMethod === 'OCR' ? 'OCR' : extractionMethod;
    const isDocumentMetadata = resolvedMethod === 'DOCUMENT_METADATA';

    return {
      document_id: documentId,
      page_number: isDocumentMetadata ? 0 : pageNumber,
      field_name: fieldName,
      evidence_text: snippet,
      extraction_method: resolvedMethod,
      provenance_type: isDocumentMetadata ? 'DOCUMENT_METADATA' : 'PAGE_EVIDENCE',
      verified_in_document: isDocumentMetadata ? false : verifiedInDocument,
      metadata_verified: isDocumentMetadata ? true : false,
      ocr_result_id: isDocumentMetadata ? undefined : pageMeta?.ocrResultId,
      model_version: isDocumentMetadata ? undefined : pageMeta?.modelVersion,
      quality_score: isDocumentMetadata ? undefined : pageMeta?.qualityScore,
      timestamp: new Date().toISOString(),
      documentId,
      pageNumber: isDocumentMetadata ? 0 : pageNumber,
      snippet,
      verifiedInDocument: isDocumentMetadata ? false : verifiedInDocument,
    };
  }

  /**
   * Builds a strictly grounded URL field: prefers verbatim page evidence when the URL
   * is printed in the PDF, otherwise marks explicit DOCUMENT_METADATA provenance
   * (`page_number: 0`, `verified_in_document: false`, `metadata_verified: true`).
   */
  private buildMetadataOrPageUrlField(
    fieldName: 'official_notification_url' | 'official_source_url',
    rawUrl: string | undefined | null,
    documentId: string,
    pages: ReadonlyArray<NormalizedPage>,
    ctx: ExtractionContext
  ): ExtractedField<string> {
    if (!rawUrl || !EvidenceValidator.isValidHttpUrl(rawUrl)) {
      return this.createMissingField<string>();
    }
    const cleanUrl = rawUrl.trim();
    for (const page of pages) {
      if (
        page.extractionMethod === 'FAILED' ||
        page.extractionMethod === 'OCR_REQUIRED' ||
        !page.extractedText
      ) {
        continue;
      }
      const match = EvidenceValidator.findNormalizedMatchInOriginalText(page.extractedText, cleanUrl);
      if (match) {
        const verbatimSnippet = page.extractedText.slice(match.charOffsetStart, match.charOffsetEnd);
        return {
          value: cleanUrl,
          state: 'EXTRACTED',
          confidence: 1.0,
          evidence: this.createEvidence(
            documentId,
            page.pageNumber,
            fieldName,
            verbatimSnippet,
            'DIRECT_TEXT',
            false,
            ctx
          ),
        };
      }
    }

    return {
      value: cleanUrl,
      state: 'EXTRACTED',
      confidence: 1.0,
      evidence: this.createEvidence(
        documentId,
        0,
        fieldName,
        cleanUrl,
        'DOCUMENT_METADATA',
        false,
        ctx
      ),
    };
  }

  /**
   * Detects whether text is English, Hindi (Devanagari script), or Bilingual.
   */
  public detectLanguage(text: string): 'HINDI' | 'ENGLISH' | 'BILINGUAL' {
    const devanagariMatches = text.match(/[\u0900-\u097F]/g) || [];
    const latinMatches = text.match(/[A-Za-z]/g) || [];

    if (devanagariMatches.length >= 15 && latinMatches.length >= 15) {
      return 'BILINGUAL';
    }
    if (devanagariMatches.length > latinMatches.length) {
      return 'HINDI';
    }
    return 'ENGLISH';
  }

  /**
   * Extracts structured recruitment details and page-level verbatim evidence from document pages.
   * Fully stateless across concurrent calls.
   */
  async extractRecruitment(
    document: NormalizedDocument,
    correlationId: string = crypto.randomUUID(),
    options: ExtractRecruitmentOptions = {}
  ): Promise<StructuredRecruitmentRecord> {
    const ctx = this.createExtractionContext(document, correlationId);
    const pages = ctx.pages;
    const documentId = ctx.documentId;
    const auditService = getAuditService();
    const shouldPersist = options.persist ?? true;

    const recordAudit = (action: string, status: string, message: string, field?: string) => {
      ctx.auditTrail.push({
        action,
        field,
        status,
        message,
        timestamp: new Date().toISOString(),
      });
      auditService.record({
        correlationId,
        actor: 'EXTRACTION_ENGINE',
        action,
        entityType: 'RECRUITMENT',
        entityId: documentId,
        stage: 'STRUCTURED_EXTRACTION',
        status: status === 'SUCCESS' || status === 'VERIFIED' ? 'SUCCESS' : 'INFO',
        details: { field, message },
      });
    };

    recordAudit('EXTRACTION_STARTED', 'INFO', `Beginning structured extraction for document ${documentId}`);

    const allText = pages.map((p) => p.extractedText).join('\n\n');
    const language = this.detectLanguage(allText);

    // 1. Corrigendum / Addendum Detection
    const corrigendumInfo = CorrigendumDetector.analyze(document.documentType, [...pages]);

    // 2. Initialize default empty structured fields without hallucinated values
    const fields: StructuredRecruitmentData = {
      organization: this.createMissingField(),
      recruitment_title: this.createMissingField(),
      advertisement_number: this.createMissingField(),
      recruitment_type: this.createMissingField(),
      post_names: this.createMissingField(),
      total_vacancies: this.createMissingField(),
      category_wise_vacancies: this.createMissingField(),
      application_start_date: this.createMissingField(),
      application_last_date: this.createMissingField(),
      correction_last_date: this.createMissingField(),
      exam_date: this.createMissingField(),
      admit_card_date: this.createMissingField(),
      result_date: this.createMissingField(),
      application_fee: this.createMissingField(),
      age_min: this.createMissingField(),
      age_max: this.createMissingField(),
      age_relaxation: this.createMissingField(),
      educational_qualification: this.createMissingField(),
      experience: this.createMissingField(),
      salary_pay_level: this.createMissingField(),
      selection_process: this.createMissingField(),
      exam_pattern: this.createMissingField(),
      negative_marking: this.createMissingField(),
      syllabus: this.createMissingField(),
      required_documents: this.createMissingField(),
      important_instructions: this.createMissingField(),
      official_notification_url: this.buildMetadataOrPageUrlField(
        'official_notification_url',
        document.canonicalUrl || document.sourceUrl,
        documentId,
        pages,
        ctx
      ),
      official_application_url: this.createMissingField(),
      official_source_url: this.buildMetadataOrPageUrlField(
        'official_source_url',
        document.sourceUrl,
        documentId,
        pages,
        ctx
      ),
    };

    // 3. Scan page-by-page to find fields and record exact page-level verbatim evidence
    for (const page of pages) {
      const pNum = page.pageNumber;
      const text = page.extractedText;
      if (!text || text.trim().length === 0) continue;

      // Organization Extraction
      if (fields.organization.state === 'MISSING') {
        const orgPatterns = [
          /(Staff Selection Commission)/i,
          /(Union Public Service Commission)/i,
          /(Railway Recruitment Board[s]?)/i,
          /(Bihar Public Service Commission)/i,
          /(Bihar Staff Selection Commission)/i,
          /(Uttar Pradesh Public Service Commission)/i,
          /(Uttar Pradesh Subordinate Services Selection Commission)/i,
          /(कर्मचारी चयन आयोग)/u,
          /(संघ लोक सेवा आयोग)/u,
          /(रेलवे भर्ती बोर्ड)/u,
          /(बिहार लोक सेवा आयोग)/u,
          /(बिहार कर्मचारी चयन आयोग)/u,
          /(उत्तर प्रदेश लोक सेवा आयोग)/u,
          /(उत्तर प्रदेश अधीनस्थ सेवा चयन आयोग)/u,
          /([A-Z][A-Za-z\s]+(?:Ministry|Department|Commission|Corporation|Authority))/i,
        ];

        for (const pattern of orgPatterns) {
          const match = text.match(pattern);
          if (match && match[1]) {
            fields.organization = {
              value: match[1].trim(),
              state: 'EXTRACTED',
              confidence: 0.95,
              evidence: this.createEvidence(documentId, pNum, 'organization', match[0], 'DIRECT_TEXT', false, ctx),
            };
            break;
          }
        }
      }

      // Recruitment Title Extraction
      if (fields.recruitment_title.state === 'MISSING') {
        const titlePatterns = [
          /(Combined Graduate Level Examination[^\n.,]*)/i,
          /(Civil Services Examination[^\n.,]*)/i,
          /(Centralized Employment Notice[^\n.,]*)/i,
          /(Combined Higher Secondary \([0-9+]+\) Level Examination[^\n.,]*)/i,
          /(Combined Competitive Examination[^\n.,]*)/i,
          /(Recruitment to the posts? of [^\n.,]+)/i,
          /(संयुक्त स्नातक स्तरीय परीक्षा[^\n.,]*)/u,
          /(सिविल सेवा परीक्षा[^\n.,]*)/u,
          /(सहायक प्राध्यापक भर्ती[^\n.,]*)/u,
          /(सहायक लेखाकार भर्ती[^\n.,]*)/u,
          /(अवर अधीनस्थ सेवा चयन परीक्षा[^\n.,]*)/u,
          /([^\n]+(?:भर्ती|परीक्षा|विज्ञप्ति|Examination)\s*20\d\d)/u,
        ];

        for (const pattern of titlePatterns) {
          const match = text.match(pattern);
          if (match && match[1]) {
            fields.recruitment_title = {
              value: match[1].trim(),
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(documentId, pNum, 'recruitment_title', match[0], 'DIRECT_TEXT', false, ctx),
            };
            break;
          }
        }
      }

      // Advertisement Number
      if (fields.advertisement_number.state === 'MISSING') {
        const advtPatterns = [
          /(?:advertisement\s*no\.?|advt\.?\s*no\.?|notice\s*no\.?|notification\s*no\.?|cen\s*no\.?)\s*[:\-]?\s*([0-9A-Z\/\-_]+(?:\/[0-9]{4})?)/i,
          /(?:विज्ञापन\s*संख्या|अधिसूचना\s*संख्या)\s*[:\-]?\s*([0-9A-Z\/\-_]+(?:\/[0-9]{4})?)/u,
          /([0-9]{1,3}\/[0-9]{4}\-[A-Za-z0-9\-]+)/i,
        ];

        for (const pattern of advtPatterns) {
          const match = text.match(pattern);
          if (match && match[1]) {
            fields.advertisement_number = {
              value: match[1].trim(),
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(documentId, pNum, 'advertisement_number', match[0], 'DIRECT_TEXT', false, ctx),
            };
            break;
          }
        }
      }

      // Recruitment Type
      if (fields.recruitment_type.state === 'MISSING') {
        const typePatterns: Array<{ regex: RegExp; normalized: string }> = [
          { regex: /(direct\s+recruitment|सीधी\s+भर्ती)/i, normalized: 'DIRECT' },
          { regex: /(contractual\s+recruitment|on\s+contract\s+basis|संविदा\s+भर्ती)/i, normalized: 'CONTRACT' },
          { regex: /(deputation\s+basis|प्रतिनियुक्ति)/i, normalized: 'DEPUTATION' },
          { regex: /(departmental\s+promotion|limited\s+departmental)/i, normalized: 'PROMOTION' },
        ];
        for (const tp of typePatterns) {
          const match = text.match(tp.regex);
          if (match) {
            fields.recruitment_type = {
              value: tp.normalized,
              state: 'EXTRACTED',
              confidence: 0.88,
              evidence: this.createEvidence(documentId, pNum, 'recruitment_type', match[0], 'DIRECT_TEXT', false, ctx),
            };
            break;
          }
        }
      }

      // Multi-post Names Extraction (explicit post/cadre lists or tables)
      if (fields.post_names && fields.post_names.state === 'MISSING') {
        const postLineMatch = text.match(
          /(?:name\s+of\s+posts?|posts?\s+offered|post\s+names?|पदों?\s+का\s+नाम)\s*[:\-]\s*([^\n]+)/i
        );
        if (postLineMatch && postLineMatch[1]) {
          const parsedPosts = postLineMatch[1]
            .split(/(?:,|;|\/|\band\b|एवं|तथा)/i)
            .map((p) => p.trim())
            .filter((p) => p.length >= 2);
          if (parsedPosts.length > 0) {
            fields.post_names = {
              value: parsedPosts,
              state: 'EXTRACTED',
              confidence: 0.88,
              evidence: this.createEvidence(documentId, pNum, 'post_names', postLineMatch[0], 'TABLE_EXTRACTION', false, ctx),
            };
          }
        } else {
          // Table-style numbered posts: e.g. "1. Assistant Section Officer - 120 posts"
          const tableBlockMatch = text.match(
            /(?:^\s*1\.\s+[^\n]+(?:\n\s*2\.\s+[^\n]+)+)/m
          );
          if (tableBlockMatch) {
            const rawLines = tableBlockMatch[0].split('\n').map((l) => l.trim()).filter(Boolean);
            const extractedPosts = rawLines
              .map((line) => line.replace(/^\d+\.\s*/, '').split(/\s*(?:\||—|–|-|\t|:\s*\d)/)[0].trim())
              .filter((p) => p.length >= 3 && /[A-Za-z\u0900-\u097F]/.test(p));
            if (extractedPosts.length >= 2) {
              fields.post_names = {
                value: extractedPosts,
                state: 'EXTRACTED',
                confidence: 0.84,
                evidence: this.createEvidence(documentId, pNum, 'post_names', tableBlockMatch[0], 'TABLE_EXTRACTION', false, ctx),
              };
            }
          }
        }
      }

      // Total Vacancies (supports comma-formatted counts and preserves negative detection for validation)
      if (fields.total_vacancies.state === 'MISSING') {
        const vacancyPatterns = [
          /(?:total\s+(?:tentative\s+)?)?vacanc(?:ies|y)\s*[:\-]?\s*(-?\d{1,3}(?:,\d{2,3})+|-?\d{1,6})/i,
          /(?:कुल\s+)?(?:पद|रिक्तियां|रिक्तियों\s+की\s+संख्या)\s*[:\-]?\s*(-?\d{1,3}(?:,\d{2,3})+|-?\d{1,6})/u,
          /(-?\d{1,3}(?:,\d{2,3})+|-?\d{1,6})\s+(?:tentative\s+)?vacancies/i,
          /(-?\d{1,3}(?:,\d{2,3})+|-?\d{1,6})\s+पदों/u,
        ];

        for (const pattern of vacancyPatterns) {
          const match = text.match(pattern);
          if (match && match[1]) {
            const val = parseNumericToken(match[1]);
            if (!isNaN(val)) {
              fields.total_vacancies = {
                value: val,
                state: 'EXTRACTED',
                confidence: 0.92,
                evidence: this.createEvidence(documentId, pNum, 'total_vacancies', match[0], 'DIRECT_TEXT', false, ctx),
              };
              break;
            }
          }
        }
      }

      // Category-wise Vacancies (full multi-category & table-heavy extraction)
      if (fields.category_wise_vacancies.state === 'MISSING') {
        const categoryLinePatterns = [
          /(?:(?:UR|GEN|Unreserved|अनारक्षित|OBC|BC|अन्य\s+पिछड़ा\s+वर्ग|EWS|आर्थिक\s+रूप\s+से\s+कमजोर\s+वर्ग|SC|अनुसूचित\s+जाति|ST|अनुसूचित\s+जनजाति|Female|Women|महिला|PwB?D|PH|दिव्यांग|ESM|Ex[\-\s]?Servicemen|भूतपूर्व\s+सैनिक)\s*[:\-=]?\s*\d{1,6}(?:[\s,;|\/]+)?){2,}/iu,
        ];

        for (const cp of categoryLinePatterns) {
          const catBlock = text.match(cp);
          if (catBlock) {
            const snippet = catBlock[0].trim();
            const cats: CategoryWiseVacancies = {};
            const extractCat = (regex: RegExp): number | undefined => {
              const m = snippet.match(regex);
              return m && m[1] ? parseNumericToken(m[1]) : undefined;
            };
            cats.ur = extractCat(/(?:UR|GEN|Unreserved|अनारक्षित)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.obc = extractCat(/(?:OBC|BC|अन्य\s+पिछड़ा\s+वर्ग)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.ews = extractCat(/(?:EWS|आर्थिक\s+रूप\s+से\s+कमजोर\s+वर्ग)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.sc = extractCat(/(?:SC|अनुसूचित\s+जाति)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.st = extractCat(/(?:ST|अनुसूचित\s+जनजाति)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.female = extractCat(/(?:Female|Women|महिला)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.pwd = extractCat(/(?:PwB?D|PH|दिव्यांग)\s*[:\-=]?\s*(\d{1,6})/iu);
            cats.esm = extractCat(/(?:ESM|Ex[\-\s]?Servicemen|भूतपूर्व\s+सैनिक)\s*[:\-=]?\s*(\d{1,6})/iu);

            const definedKeys = Object.values(cats).filter((v) => typeof v === 'number');
            if (definedKeys.length >= 2) {
              fields.category_wise_vacancies = {
                value: cats,
                state: 'EXTRACTED',
                confidence: 0.88,
                evidence: this.createEvidence(documentId, pNum, 'category_wise_vacancies', snippet, 'TABLE_EXTRACTION', false, ctx),
              };
              break;
            }
          }
        }
      }

      // Important Calendar Dates (Start, Last, Correction, Exam, Admit Card, Result)
      const dateToken =
        '([0-3]?[0-9][\\/\\-\\.][0-1]?[0-9][\\/\\-\\.]\\d{4}|[0-3]?[0-9]\\s+[A-Za-z\\u0900-\\u097F]+\\s+\\d{4})';
      const dateSnippets = [
        {
          target: 'application_start_date' as const,
          regex: new RegExp(
            `(?:dates? for submission of (?:online )?applications?|online application starts?|commencement of online application|application start date|आवेदन\\s+प्रारंभ\\s+तिथि|ऑनलाइन\\s+आवेदन\\s+प्रारंभ)\\s*[:\\-]?\\s*${dateToken}`,
            'iu'
          ),
        },
        {
          target: 'application_last_date' as const,
          regex: new RegExp(
            `(?:last date[\\s\\S]{0,140}?(?:extended (?:till|to|up to)|बढ़ाकर)|extended (?:till|to|up to)|last date (?:and time )?for (?:receipt|submission) of (?:online )?applications?|application last date|closing date|अंतिम\\s+तिथि)\\s*[:\\-]?\\s*${dateToken}`,
            'iu'
          ),
        },
        {
          target: 'correction_last_date' as const,
          regex: new RegExp(
            `(?:dates? of (?:window for )?application form correction|correction window(?:\\s+last\\s+date)?|correction last date|संशोधन\\s+की\\s+अंतिम\\s+तिथि)\\s*[:\\-]?\\s*${dateToken}`,
            'iu'
          ),
        },
        {
          target: 'exam_date' as const,
          regex: new RegExp(
            `(?:schedule of (?:tier-[iI]+|preliminary)?\\s*(?:computer based )?examination|exam(?:ination)?\\s+date|परीक्षा\\s+तिथि)\\s*[:\\-]?\\s*(${dateToken.slice(1, -1)}|[A-Za-z\\u0900-\\u097F]+\\s+\\d{4})`,
            'iu'
          ),
        },
        {
          target: 'admit_card_date' as const,
          regex: new RegExp(
            `(?:admit\\s+card\\s+(?:release\\s+)?date|issue\\s+of\\s+e-?admit\\s+card|प्रवेश\\s+पत्र\\s+तिथि)\\s*[:\\-]?\\s*${dateToken}`,
            'iu'
          ),
        },
        {
          target: 'result_date' as const,
          regex: new RegExp(
            `(?:result\\s+(?:declaration\\s+)?date|tentative\\s+result\\s+date|परिणाम\\s+तिथि)\\s*[:\\-]?\\s*${dateToken}`,
            'iu'
          ),
        },
      ];

      for (const ds of dateSnippets) {
        if (fields[ds.target].state === 'MISSING') {
          const match = text.match(ds.regex);
          if (match && match[1]) {
            const rawDate = match[1].trim();
            const validation = DateValidator.parseAndValidate(rawDate);

            if (validation.isValid && validation.isoDate) {
              fields[ds.target] = {
                value: validation.isoDate,
                state: 'EXTRACTED',
                confidence: 0.95,
                evidence: this.createEvidence(documentId, pNum, ds.target, match[0], 'DIRECT_TEXT', false, ctx),
              };
            } else if (
              validation.errorCode === 'IMPOSSIBLE_CALENDAR_DATE' ||
              validation.errorCode === 'NON_LEAP_YEAR_FEB_29'
            ) {
              fields[ds.target] = {
                value: rawDate,
                state: 'INVALID',
                confidence: 0.0,
                evidence: this.createEvidence(documentId, pNum, ds.target, match[0], 'DIRECT_TEXT', false, ctx),
                validationNotes: `Invalid calendar date: ${validation.errorMessage}`,
              };
              recordAudit(
                'INVALID_DATE_DETECTED',
                'REJECTED',
                validation.errorMessage || 'Invalid date',
                ds.target
              );
            }
          }
        }
      }

      // Application Fee (multi-category & exemptions)
      if (fields.application_fee.state === 'MISSING') {
        const feeLineMatch = text.match(
          /(?:application\s+fee|examination\s+fee|fee\s+payable|आवेदन\s+शुल्क|परीक्षा\s+शुल्क)\s*[:\-]?\s*([^\n]+)/iu
        );
        if (feeLineMatch) {
          const feeLine = feeLineMatch[0].trim();
          const primaryAmountMatch = feeLine.match(/(?:₹|rs\.?|inr|रुपये)?\s*(-?\d{1,5})/i);
          if (primaryAmountMatch) {
            const amount = parseInt(primaryAmountMatch[1], 10);
            const extractCatFee = (regex: RegExp): number | undefined => {
              const m = feeLine.match(regex);
              return m && m[1] ? parseInt(m[1], 10) : undefined;
            };
            const scFee = extractCatFee(/(?:SC(?:\/ST)?|अनुसूचित\s+जाति)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,5})/iu);
            const stFee = extractCatFee(/(?:ST|अनुसूचित\s+जनजाति)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,5})/iu);
            const obcFee = extractCatFee(/(?:OBC|अन्य\s+पिछड़ा\s+वर्ग)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,5})/iu);
            const ewsFee = extractCatFee(/(?:EWS)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,5})/iu);
            const femaleFee = extractCatFee(/(?:Female|Women|महिला)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,5})/iu);
            const exemptMentioned = /women|female|sc|st|pwd|pwbd|exempt|nil|निःशुल्क|छूट/i.test(feeLine);

            const feeStruct: ApplicationFeeStructure = {
              unreserved: amount,
              obc: obcFee ?? null,
              ews: ewsFee ?? null,
              sc: scFee ?? (exemptMentioned && /sc[\s\/]*st[^.\n]*(?:exempt|nil|free|छूट|निःशुल्क)/i.test(feeLine) ? 0 : null),
              st: stFee ?? (exemptMentioned && /sc[\s\/]*st[^.\n]*(?:exempt|nil|free|छूट|निःशुल्क)/i.test(feeLine) ? 0 : null),
              female: femaleFee ?? (exemptMentioned && /(?:women|female|महिला)[^.\n]*(?:exempt|nil|free|छूट|निःशुल्क)/i.test(feeLine) ? 0 : null),
              exemptionDetails: exemptMentioned ? 'Women/SC/ST/PwD fee exemption mentioned' : null,
              rawSnippet: feeLine,
            };
            fields.application_fee = {
              value: feeStruct,
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(documentId, pNum, 'application_fee', feeLine, 'DIRECT_TEXT', false, ctx),
            };
          }
        }
      }

      // Age Limits (range or separate min/max in English & Hindi)
      if (fields.age_min.state === 'MISSING' || fields.age_max.state === 'MISSING') {
        const ageMatch = text.match(
          /(?:age\s+limit|आयु\s+सीमा)\s*[:\-]?\s*(\d{2})\s*(?:to|से|-|–)\s*(\d{2})\s*(?:years|वर्ष)?/iu
        );
        if (ageMatch) {
          fields.age_min = {
            value: parseInt(ageMatch[1], 10),
            state: 'EXTRACTED',
            confidence: 0.9,
            evidence: this.createEvidence(documentId, pNum, 'age_min', ageMatch[0], 'DIRECT_TEXT', false, ctx),
          };
          fields.age_max = {
            value: parseInt(ageMatch[2], 10),
            state: 'EXTRACTED',
            confidence: 0.9,
            evidence: this.createEvidence(documentId, pNum, 'age_max', ageMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        } else {
          if (fields.age_min.state === 'MISSING') {
            const minMatch = text.match(/(?:minimum\s+age|न्यूनतम\s+आयु)\s*[:\-]?\s*(\d{2})\s*(?:years|वर्ष)?/iu);
            if (minMatch) {
              fields.age_min = {
                value: parseInt(minMatch[1], 10),
                state: 'EXTRACTED',
                confidence: 0.9,
                evidence: this.createEvidence(documentId, pNum, 'age_min', minMatch[0], 'DIRECT_TEXT', false, ctx),
              };
            }
          }
          if (fields.age_max.state === 'MISSING') {
            const maxMatch = text.match(/(?:maximum\s+age|upper\s+age\s+limit|अधिकतम\s+आयु)\s*[:\-]?\s*(\d{2})\s*(?:years|वर्ष)?/iu);
            if (maxMatch) {
              fields.age_max = {
                value: parseInt(maxMatch[1], 10),
                state: 'EXTRACTED',
                confidence: 0.9,
                evidence: this.createEvidence(documentId, pNum, 'age_max', maxMatch[0], 'DIRECT_TEXT', false, ctx),
              };
            }
          }
        }
      }

      // Age Relaxation
      if (fields.age_relaxation.state === 'MISSING') {
        const relaxMatch = text.match(
          /(?:age\s+relaxation|upper\s+age\s+relaxation|आयु\s+(?:सीमा\s+)?में\s+छूट)\s*[:\-]?\s*([^\n]+)/iu
        );
        if (relaxMatch && relaxMatch[1]) {
          const line = relaxMatch[0].trim();
          const rules: Record<string, string | number> = {};
          const scSt = line.match(/(?:SC\/ST|SC\s*&\s*ST|अनुसूचित\s+जाति\/जनजाति)\s*[:\-]?\s*(\d+)\s*(?:years|वर्ष)/iu);
          const obc = line.match(/(?:OBC|अन्य\s+पिछड़ा\s+वर्ग)\s*[:\-]?\s*(\d+)\s*(?:years|वर्ष)/iu);
          const pwd = line.match(/(?:PwB?D|PH|दिव्यांग)\s*[:\-]?\s*(\d+)\s*(?:years|वर्ष)/iu);
          const esm = line.match(/(?:ESM|Ex[\-\s]?Servicemen)\s*[:\-]?\s*(\d+)\s*(?:years|वर्ष)/iu);
          if (scSt) rules['SC/ST'] = `${scSt[1]} years`;
          if (obc) rules['OBC'] = `${obc[1]} years`;
          if (pwd) rules['PwD'] = `${pwd[1]} years`;
          if (esm) rules['ESM'] = `${esm[1]} years`;
          if (Object.keys(rules).length === 0) {
            rules['summary'] = relaxMatch[1].trim();
          }
          fields.age_relaxation = {
            value: rules,
            state: 'EXTRACTED',
            confidence: 0.86,
            evidence: this.createEvidence(documentId, pNum, 'age_relaxation', line, 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Educational Qualification
      if (fields.educational_qualification.state === 'MISSING') {
        const qualPatterns = [
          /(?:essential\s+educational\s+qualifications?|educational\s+qualifications?|minimum\s+qualification|अनिवार्य\s+शैक्षणिक\s+योग्यता|शैक्षणिक\s+योग्यता)\s*[:\-]?\s*([^\n]+)/iu,
          /(Bachelor['’]?s\s+Degree\s+from\s+a\s+recognized\s+University[^\n]*)/i,
          /(स्नातक\s+डिग्री[^\n]*)/u,
          /(स्नातकोत्तर\s+डिग्री[^\n]*)/u,
          /(वाणिज्य\s+में\s+स्नातक[^\n]*)/u,
          /(10\+2\s*(?:Intermediate)?[^\n]*)/i,
          /(Matriculation\s*\/\s*10th\s*Class[^\n]*)/i,
        ];

        for (const qp of qualPatterns) {
          const match = text.match(qp);
          if (match && match[1]) {
            fields.educational_qualification = {
              value: match[1].trim().replace(/\.+$/, ''),
              state: 'EXTRACTED',
              confidence: 0.88,
              evidence: this.createEvidence(documentId, pNum, 'educational_qualification', match[0].trim(), 'DIRECT_TEXT', false, ctx),
            };
            break;
          }
        }
      }

      // Experience
      if (fields.experience.state === 'MISSING') {
        const expMatch = text.match(
          /(?:essential\s+experience|work\s+experience|experience\s+required|experience|कार्य\s+अनुभव|अनुभव)\s*[:\-]\s*([^\n\.]+)/iu
        );
        if (expMatch && expMatch[1]) {
          fields.experience = {
            value: expMatch[1].trim(),
            state: 'EXTRACTED',
            confidence: 0.85,
            evidence: this.createEvidence(documentId, pNum, 'experience', expMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Salary / Pay Level
      if (fields.salary_pay_level.state === 'MISSING') {
        const payMatch = text.match(
          /(?:pay\s+level|pay\s+scale|pay\s+matrix|salary|वेतनमान|पे\s+लेवल)\s*[:\-]?\s*([^\n\.,]+(?:\([^)]+\))?)/iu
        );
        if (payMatch && payMatch[1]) {
          fields.salary_pay_level = {
            value: payMatch[1].trim(),
            state: 'EXTRACTED',
            confidence: 0.88,
            evidence: this.createEvidence(documentId, pNum, 'salary_pay_level', payMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Selection Process / Scheme of Examination
      if (fields.selection_process.state === 'MISSING') {
        const selectionMatch = text.match(
          /(?:selection\s+process|scheme\s+of\s+examination|mode\s+of\s+selection|चयन\s+प्रक्रिया)\s*[:\-]?\s*([^\n\.]+)/iu
        );
        if (selectionMatch && selectionMatch[1]) {
          const stages = selectionMatch[1]
            .split(/(?:,|;|\/|\band\b|\+|→|->|एवं)/i)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          fields.selection_process = {
            value: stages.length > 0 ? stages : [selectionMatch[1].trim()],
            state: 'EXTRACTED',
            confidence: 0.9,
            evidence: this.createEvidence(documentId, pNum, 'selection_process', selectionMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Exam Pattern
      if (fields.exam_pattern.state === 'MISSING') {
        const patternMatch = text.match(
          /(?:exam(?:ination)?\s+pattern|pattern\s+of\s+exam(?:ination)?|परीक्षा\s+पैटर्न|परीक्षा\s+योजना)\s*[:\-]\s*([^\n]+)/iu
        );
        if (patternMatch && patternMatch[1]) {
          fields.exam_pattern = {
            value: patternMatch[1].trim(),
            state: 'EXTRACTED',
            confidence: 0.86,
            evidence: this.createEvidence(documentId, pNum, 'exam_pattern', patternMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Negative Marking
      if (fields.negative_marking.state === 'MISSING') {
        const negMatch = text.match(
          /(negative\s+marking\s+of\s+\d+(?:[\/\.]\d+)?\s+marks?|\d+(?:[\/\.]\d+)?[ \t]+negative\s+marking|negative\s+marking\s*[:\-]\s*[^\n]+|नकारात्मक\s+अंकन[^\n]+)/iu
        );
        if (negMatch) {
          fields.negative_marking = {
            value: negMatch[0].trim().replace(/\.+$/, ''),
            state: 'EXTRACTED',
            confidence: 0.85,
            evidence: this.createEvidence(documentId, pNum, 'negative_marking', negMatch[0].trim(), 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Syllabus
      if (fields.syllabus.state === 'MISSING') {
        const syllabusMatch = text.match(
          /(?:syllabus|indicative\s+syllabus|पाठ्यक्रम)\s*[:\-]\s*([^\n]+)/iu
        );
        if (syllabusMatch && syllabusMatch[1]) {
          fields.syllabus = {
            value: syllabusMatch[1].trim(),
            state: 'EXTRACTED',
            confidence: 0.85,
            evidence: this.createEvidence(documentId, pNum, 'syllabus', syllabusMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Required Documents
      if (fields.required_documents.state === 'MISSING') {
        const docsMatch = text.match(
          /(?:required\s+documents|documents\s+required|आवश्यक\s+दस्तावेज)\s*[:\-]\s*([^\n]+)/iu
        );
        if (docsMatch && docsMatch[1]) {
          const items = docsMatch[1]
            .split(/(?:,|;|\/|\band\b|एवं)/i)
            .map((s) => s.trim())
            .filter((s) => s.length >= 2);
          if (items.length > 0) {
            fields.required_documents = {
              value: items,
              state: 'EXTRACTED',
              confidence: 0.84,
              evidence: this.createEvidence(documentId, pNum, 'required_documents', docsMatch[0], 'DIRECT_TEXT', false, ctx),
            };
          }
        }
      }

      // Important Instructions
      if (fields.important_instructions.state === 'MISSING') {
        const instrMatch = text.match(
          /(?:important\s+instructions?|महत्वपूर्ण\s+निर्देश)\s*[:\-]\s*([^\n]+)/iu
        );
        if (instrMatch && instrMatch[1]) {
          const items = instrMatch[1]
            .split(/(?:;|\|)/)
            .map((s) => s.trim())
            .filter((s) => s.length >= 4);
          if (items.length > 0) {
            fields.important_instructions = {
              value: items,
              state: 'EXTRACTED',
              confidence: 0.84,
              evidence: this.createEvidence(documentId, pNum, 'important_instructions', instrMatch[0], 'DIRECT_TEXT', false, ctx),
            };
          }
        }
      }

      // Official Application URL (when explicitly printed in the notification PDF)
      if (fields.official_application_url.state === 'MISSING') {
        const appUrlMatch = text.match(
          /(?:official\s+(?:application\s+(?:url|portal|link)|website)|apply\s+online(?:\s+at)?|ऑनलाइन\s+आवेदन\s+वेबसाइट)\s*[:\-]?\s*(https?:\/\/[^\s,);]+)/iu
        );
        if (appUrlMatch && appUrlMatch[1]) {
          fields.official_application_url = {
            value: appUrlMatch[1].trim(),
            state: 'EXTRACTED',
            confidence: 0.92,
            evidence: this.createEvidence(documentId, pNum, 'official_application_url', appUrlMatch[0], 'DIRECT_TEXT', false, ctx),
          };
        }
      }

      // Structured Table Extraction (BUG 7): consume layout-preserved tables for multi-post,
      // category-wise vacancy, total vacancy, and application fee tables (English & Hindi).
      const pageTables =
        page.tables && page.tables.length > 0 ? page.tables : detectAndExtractTables(text, pNum);

      for (const table of pageTables) {
        const lowerHeaders = table.headers.map((h) => h.toLowerCase());

        // 1. Multi-post names from tabular post listings
        if (fields.post_names && fields.post_names.state === 'MISSING') {
          const postColIdx = lowerHeaders.findIndex((h) =>
            /(?:name\s+of\s+post|post\s+name|post|designation|cadre|पद\s+का\s+नाम|पद)/iu.test(h)
          );
          if (postColIdx !== -1) {
            const tablePosts = table.rows
              .map((row) => (row[postColIdx] || '').trim())
              .filter(
                (val) =>
                  val.length >= 2 &&
                  /[A-Za-z\u0900-\u097F]/.test(val) &&
                  !/^(?:total|grand\s+total|कुल|योग)$/iu.test(val)
              );
            if (tablePosts.length >= 1) {
              fields.post_names = {
                value: tablePosts,
                state: 'EXTRACTED',
                confidence: 0.9,
                evidence: this.createEvidence(documentId, pNum, 'post_names', table.rawText, 'TABLE_EXTRACTION', false, ctx),
              };
            }
          }
        }

        // 2. Category-wise & total vacancies from tabular vacancy breakdowns
        type NumericCategoryKey = Exclude<keyof CategoryWiseVacancies, 'other'>;
        const catColumnMatchers: Array<{ key: NumericCategoryKey; regex: RegExp }> = [
          { key: 'ur', regex: /^(?:ur|gen|general|unreserved|अनारक्षित)$/iu },
          { key: 'obc', regex: /^(?:obc|bc|अन्य\s+पिछड़ा\s+वर्ग|पिछड़ा\s+वर्ग)$/iu },
          { key: 'ews', regex: /^(?:ews|आर्थिक\s+रूप\s+से\s+कमजोर(?:\s+वर्ग)?)$/iu },
          { key: 'sc', regex: /^(?:sc|अनुसूचित\s+जाति)$/iu },
          { key: 'st', regex: /^(?:st|अनुसूचित\s+जनजाति)$/iu },
          { key: 'female', regex: /^(?:female|women|महिला)$/iu },
          { key: 'pwd', regex: /^(?:pwb?d|ph|दिव्यांग)$/iu },
          { key: 'esm', regex: /^(?:esm|ex[\-\s]?servicemen|भूतपूर्व\s+सैनिक)$/iu },
        ];

        // Mode 2A: Categories are column headers (e.g. Post | UR | OBC | EWS | SC | ST | Total)
        const catColMap = new Map<NumericCategoryKey, number>();
        for (let colIdx = 0; colIdx < table.headers.length; colIdx++) {
          const hdr = table.headers[colIdx].trim();
          for (const matcher of catColumnMatchers) {
            if (matcher.regex.test(hdr) && !catColMap.has(matcher.key)) {
              catColMap.set(matcher.key, colIdx);
            }
          }
        }

        const totalColIdx = lowerHeaders.findIndex((h) =>
          /^(?:total|total\s+vacancies|total\s+posts|vacancies|posts|कुल|कुल\s+पद|रिक्तियां)$/iu.test(h.trim())
        );

        if (catColMap.size >= 2 && fields.category_wise_vacancies.state === 'MISSING') {
          const totalRow = table.rows.find((row) =>
            row.some((cell) => /^(?:total|grand\s+total|कुल|योग)$/iu.test(cell.trim()))
          );
          const cats: CategoryWiseVacancies = {};
          for (const [catKey, colIdx] of catColMap.entries()) {
            if (totalRow) {
              const numMatch = (totalRow[colIdx] || '').match(/\d{1,3}(?:,\d{2,3})+|\d{1,6}/);
              if (numMatch) {
                cats[catKey] = parseNumericToken(numMatch[0]);
              }
            } else {
              let sum = 0;
              let foundAny = false;
              for (const row of table.rows) {
                const numMatch = (row[colIdx] || '').match(/\d{1,3}(?:,\d{2,3})+|\d{1,6}/);
                if (numMatch) {
                  sum += parseNumericToken(numMatch[0]);
                  foundAny = true;
                }
              }
              if (foundAny) {
                cats[catKey] = sum;
              }
            }
          }
          const definedCount = Object.values(cats).filter((v) => typeof v === 'number').length;
          if (definedCount >= 2) {
            fields.category_wise_vacancies = {
              value: cats,
              state: 'EXTRACTED',
              confidence: 0.91,
              evidence: this.createEvidence(
                documentId,
                pNum,
                'category_wise_vacancies',
                table.rawText,
                'TABLE_EXTRACTION',
                false,
                ctx
              ),
            };
          }
        }

        // Mode 2B: Categories are row labels (e.g. Category | Vacancies  or  श्रेणी | पद)
        const categoryHeaderIdx = lowerHeaders.findIndex((h) =>
          /(?:category|श्रेणी|वर्ग)/iu.test(h)
        );
        const vacancyHeaderIdx = lowerHeaders.findIndex((h) =>
          /(?:vacanc|posts|पद|रिक्ति)/iu.test(h)
        );
        if (
          categoryHeaderIdx !== -1 &&
          vacancyHeaderIdx !== -1 &&
          fields.category_wise_vacancies.state === 'MISSING'
        ) {
          const cats: CategoryWiseVacancies = {};
          for (const row of table.rows) {
            const label = (row[categoryHeaderIdx] || '').trim();
            const valCell = (row[vacancyHeaderIdx] || '').trim();
            const numMatch = valCell.match(/\d{1,3}(?:,\d{2,3})+|\d{1,6}/);
            if (!numMatch) continue;
            const parsed = parseNumericToken(numMatch[0]);
            for (const matcher of catColumnMatchers) {
              if (matcher.regex.test(label)) {
                cats[matcher.key] = parsed;
                break;
              }
            }
          }
          if (Object.values(cats).filter((v) => typeof v === 'number').length >= 2) {
            fields.category_wise_vacancies = {
              value: cats,
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(
                documentId,
                pNum,
                'category_wise_vacancies',
                table.rawText,
                'TABLE_EXTRACTION',
                false,
                ctx
              ),
            };
          }
        }

        // Total vacancies from table Total row or vacancy column sum
        if (fields.total_vacancies.state === 'MISSING' && totalColIdx !== -1) {
          const totalRow = table.rows.find((row) =>
            row.some((cell) => /^(?:total|grand\s+total|कुल|योग)$/iu.test(cell.trim()))
          );
          let resolvedTotal: number | null = null;
          if (totalRow) {
            const numMatch = (totalRow[totalColIdx] || '').match(/\d{1,3}(?:,\d{2,3})+|\d{1,6}/);
            if (numMatch) resolvedTotal = parseNumericToken(numMatch[0]);
          } else {
            let sum = 0;
            let count = 0;
            for (const row of table.rows) {
              const numMatch = (row[totalColIdx] || '').match(/\d{1,3}(?:,\d{2,3})+|\d{1,6}/);
              if (numMatch) {
                sum += parseNumericToken(numMatch[0]);
                count++;
              }
            }
            if (count > 0) resolvedTotal = sum;
          }
          if (resolvedTotal !== null && !isNaN(resolvedTotal)) {
            fields.total_vacancies = {
              value: resolvedTotal,
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(
                documentId,
                pNum,
                'total_vacancies',
                table.rawText,
                'TABLE_EXTRACTION',
                false,
                ctx
              ),
            };
          }
        }

        // 3. Application fee tables (e.g. Category | Application Fee  or  श्रेणी | आवेदन शुल्क)
        const feeHeaderIdx = lowerHeaders.findIndex((h) =>
          /(?:fee|fees|शुल्क|आवेदन\s+शुल्क|परीक्षा\s+शुल्क)/iu.test(h)
        );
        const existingFeePopulatedCount = fields.application_fee.value
          ? ['unreserved', 'obc', 'ews', 'sc', 'st', 'female', 'pwd'].filter(
              (k) =>
                typeof (fields.application_fee.value as Record<string, unknown>)[k] === 'number'
            ).length
          : 0;
        const canExtractFeeFromTable =
          categoryHeaderIdx !== -1 &&
          feeHeaderIdx !== -1 &&
          (fields.application_fee.state === 'MISSING' ||
            fields.application_fee.evidence?.extraction_method !== 'TABLE_EXTRACTION');

        if (canExtractFeeFromTable) {
          const feeStruct: ApplicationFeeStructure = {
            unreserved: null,
            obc: null,
            ews: null,
            sc: null,
            st: null,
            female: null,
            exemptionDetails: null,
            rawSnippet: table.rawText,
          };
          let foundAnyFee = false;

          for (const row of table.rows) {
            const label = (row[categoryHeaderIdx] || '').trim();
            const feeCell = (row[feeHeaderIdx] || '').trim();
            const isFree = /(?:nil|exempt|free|0\b|निःशुल्क|छूट)/iu.test(feeCell);
            const numMatch = feeCell.match(/(?:₹|rs\.?|inr|रुपये)?\s*(\d{1,5})/i);
            const amount = numMatch ? parseInt(numMatch[1], 10) : isFree ? 0 : null;
            if (amount === null) continue;
            foundAnyFee = true;

            if (/(?:ur|gen|general|unreserved|अनारक्षित)/iu.test(label)) {
              feeStruct.unreserved = amount;
            }
            if (/(?:obc|bc|अन्य\s+पिछड़ा\s+वर्ग)/iu.test(label)) {
              feeStruct.obc = amount;
            }
            if (/(?:ews)/iu.test(label)) {
              feeStruct.ews = amount;
            }
            if (/(?:sc|अनुसूचित\s+जाति)/iu.test(label)) {
              feeStruct.sc = amount;
            }
            if (/(?:st|अनुसूचित\s+जनजाति)/iu.test(label)) {
              feeStruct.st = amount;
            }
            if (/(?:female|women|महिला)/iu.test(label)) {
              feeStruct.female = amount;
            }
            if (isFree) {
              feeStruct.exemptionDetails = 'Fee exemption specified in table';
            }
          }

          const tableFeePopulatedCount = ['unreserved', 'obc', 'ews', 'sc', 'st', 'female', 'pwd'].filter(
            (k) => typeof (feeStruct as Record<string, unknown>)[k] === 'number'
          ).length;

          if (
            foundAnyFee &&
            (fields.application_fee.state === 'MISSING' ||
              tableFeePopulatedCount > existingFeePopulatedCount)
          ) {
            fields.application_fee = {
              value: feeStruct,
              state: 'EXTRACTED',
              confidence: 0.9,
              evidence: this.createEvidence(
                documentId,
                pNum,
                'application_fee',
                table.rawText,
                'TABLE_EXTRACTION',
                false,
                ctx
              ),
            };
          }
        }
      }
    }

    // 4. Deterministic Field Validation (Numbers, Ranges, Dates, Cross-Contamination)
    const validationIssues = DeterministicFieldValidator.validateAll(fields, documentId, [...pages]);
    for (const issue of validationIssues) {
      recordAudit(
        `VALIDATION_ISSUE_${issue.type}`,
        issue.type === 'CONFLICT' ? 'CONFLICT' : 'REJECTED',
        issue.reason,
        issue.field
      );
    }

    // 5. CRITICAL RULE: Evidence Validator Check (passing document metadata URLs for explicit URL provenance)
    const allowedMetadataUrls = [document.canonicalUrl, document.sourceUrl].filter(
      (u): u is string => Boolean(u && u.trim())
    );
    const evidenceReport = EvidenceValidator.validateAllFields(
      fields,
      [...pages],
      documentId,
      allowedMetadataUrls
    );

    // 6. Compute Overall Recruitment Validation Status
    let overallStatus: RecruitmentValidationStatus = 'EXTRACTION_PENDING';

    const fieldValues = Object.values(fields).filter((f): f is ExtractedField<unknown> => Boolean(f));
    const hasConflictField = fieldValues.some((f) => f.state === 'CONFLICT');
    const hasInvalidField = fieldValues.some((f) => f.state === 'INVALID');

    if (hasConflictField) {
      overallStatus = 'CONFLICT';
      recordAudit('RECRUITMENT_CONFLICT', 'CONFLICT', 'Recruitment has conflicting field values');
    } else if (hasInvalidField) {
      overallStatus = 'REJECTED';
      recordAudit(
        'RECRUITMENT_REJECTED',
        'REJECTED',
        `Recruitment validation failed: ${evidenceReport.invalidFields.map((i) => `${i.field} (${i.reason})`).join(', ')}`
      );
    } else if (evidenceReport.criticalFieldsValid) {
      overallStatus = 'VERIFIED';
      recordAudit(
        'RECRUITMENT_VERIFIED',
        'VERIFIED',
        'All critical recruitment fields verified with valid source evidence'
      );
    } else {
      const hasAnyExtracted = fieldValues.some((f) => f.state === 'VERIFIED' || f.state === 'EXTRACTED');
      overallStatus = hasAnyExtracted ? 'PARTIALLY_VERIFIED' : 'EXTRACTION_PENDING';
      recordAudit('RECRUITMENT_PARTIAL', overallStatus, 'Some critical fields lack verified source evidence');
    }

    // 7. Compute Deterministic Canonical Identity (never random UUID before dedup!)
    const identity = computeCanonicalRecruitmentIdentity({
      sourceId: document.sourceId,
      advertisementNumber: fields.advertisement_number.value,
      canonicalUrl: document.canonicalUrl || document.sourceUrl,
      checksumSha256: document.checksumSha256,
      title: fields.recruitment_title.value,
      isCorrigendum: corrigendumInfo.isCorrigendum,
      documentId,
    });

    const record: StructuredRecruitmentRecord = {
      id: identity.deterministicRecruitmentId,
      canonicalIdentityKey: identity.canonicalIdentityKey,
      persisted: false,
      sourceId: document.sourceId,
      documentId,
      overallStatus,
      isCorrigendum: corrigendumInfo.isCorrigendum,
      relatedRecruitmentId: corrigendumInfo.referencedAdvertisementNumber,
      corrigendumNotes: corrigendumInfo.notes || null,
      languageDetected: language,
      fields,
      extractionTimestamp: new Date().toISOString(),
      auditTrail: ctx.auditTrail,
    };

    if (shouldPersist) {
      const persistedRecord = this.persistRecruitmentCandidate(record, document, correlationId);
      return persistedRecord;
    }

    return record;
  }

  /**
   * Persists or deterministically upserts a validated extraction candidate into `recruitments`,
   * `jobs`, and `corrigendum_associations` inside an atomic SQLite transaction (BUG 3).
   *
   * Strict invariants:
   * - Never swallows database errors for required writes.
   * - Rolls back all required writes atomically on any failure.
   * - Sets `persisted: true` ONLY after transaction commit succeeds.
   * - Throws a typed `RecruitmentPersistenceError` classified as transient vs permanent.
   * - Optional `extraction_audit_records` writes run after commit and never mask required persistence failures.
   */
  public persistRecruitmentCandidate(
    candidate: StructuredRecruitmentRecord,
    document: NormalizedDocument,
    correlationId: string = crypto.randomUUID(),
    options?: { existingRecruitmentId?: string | null }
  ): StructuredRecruitmentRecord {
    const repos = getRepositories();
    const fields = candidate.fields;
    const canonicalIdentityKey =
      candidate.canonicalIdentityKey ??
      computeCanonicalRecruitmentIdentity({
        sourceId: candidate.sourceId,
        advertisementNumber: fields.advertisement_number.value,
        canonicalUrl: document.canonicalUrl || document.sourceUrl,
        checksumSha256: document.checksumSha256,
        title: fields.recruitment_title.value,
        isCorrigendum: candidate.isCorrigendum,
        documentId: candidate.documentId,
      }).canonicalIdentityKey;

    let resolvedRecruitmentId = candidate.id;
    let convergedExisting = false;
    let committedRecord: StructuredRecruitmentRecord;

    try {
      committedRecord = runInSqliteTransaction(getDatabase(), () => {
        const existingRow =
          (options?.existingRecruitmentId
            ? repos.recruitments.findById(options.existingRecruitmentId)
            : null) ??
          repos.recruitments.findByCanonicalIdentity(canonicalIdentityKey) ??
          repos.recruitments.findById(candidate.id) ??
          repos.recruitments.findByDocument(candidate.documentId);

        resolvedRecruitmentId = existingRow?.id ?? candidate.id;
        convergedExisting = Boolean(existingRow);

        const recordPayloadView: StructuredRecruitmentRecord = {
          ...candidate,
          id: resolvedRecruitmentId,
          canonicalIdentityKey,
          persisted: true,
        };

        const recruitmentPayload = {
          title: fields.recruitment_title.value || 'Untitled Recruitment Notice',
          department: fields.organization.value || null,
          notification_number: fields.advertisement_number.value || null,
          total_vacancies: typeof fields.total_vacancies.value === 'number' ? fields.total_vacancies.value : null,
          application_start_date: fields.application_start_date.value || null,
          application_end_date: fields.application_last_date.value || null,
          raw_payload_json: JSON.stringify(recordPayloadView),
          canonical_identity_key: canonicalIdentityKey,
        };

        if (existingRow) {
          repos.recruitments.update(existingRow.id, recruitmentPayload);
        } else {
          repos.recruitments.create({
            id: resolvedRecruitmentId,
            source_id: document.sourceId,
            document_id: candidate.documentId,
            ...recruitmentPayload,
          });
        }

        const jobId = `job-${resolvedRecruitmentId}`;
        if (!repos.jobs.findById(jobId)) {
          repos.jobs.create({
            id: jobId,
            recruitment_id: resolvedRecruitmentId,
            title: fields.recruitment_title.value || 'General Officer / Staff',
            post_code: fields.advertisement_number.value || null,
            vacancies: typeof fields.total_vacancies.value === 'number' ? fields.total_vacancies.value : null,
            pay_scale: fields.salary_pay_level.value || null,
            age_limit_min: typeof fields.age_min.value === 'number' ? fields.age_min.value : null,
            age_limit_max: typeof fields.age_max.value === 'number' ? fields.age_max.value : null,
            qualification_summary: fields.educational_qualification.value || null,
            state: candidate.languageDetected === 'HINDI' ? 'State' : 'Central',
            category: 'General',
            status: candidate.overallStatus === 'VERIFIED' ? 'VERIFIED' : 'DRAFT',
          });
        }

        // Corrigendum Association persistence inside the same transaction so parent/amendment state is atomic
        if (candidate.isCorrigendum) {
          const parentRec = candidate.relatedRecruitmentId
            ? repos.recruitments.findByAdvertisementNumber(candidate.relatedRecruitmentId)
            : null;
          const association = CorrigendumDetector.buildAssociation({
            corrigendumDocumentId: candidate.documentId,
            originalAdvertisementNumber: candidate.relatedRecruitmentId ?? null,
            amendmentType: candidate.corrigendumNotes?.toLowerCase().includes('exten')
              ? 'EXTENSION'
              : 'CORRIGENDUM',
            updatedFields: fields.application_last_date.value
              ? [
                  {
                    fieldName: 'application_last_date',
                    newValue: fields.application_last_date.value,
                    sourcePage: fields.application_last_date.evidence?.page_number || 1,
                    evidenceText: fields.application_last_date.evidence?.evidence_text || '',
                    effectiveDate: fields.application_last_date.value,
                  },
                ]
              : [],
            notes: candidate.corrigendumNotes ?? '',
          });

          for (const uf of association.updatedFields) {
            repos.corrigendumAssociations.create({
              id: crypto.randomUUID(),
              original_recruitment_id: parentRec?.id ?? null,
              corrigendum_document_id: candidate.documentId,
              related_document_id: parentRec?.document_id ?? null,
              amendment_type: association.amendmentType,
              updated_field: uf.fieldName,
              source_page: uf.sourcePage,
              old_value: parentRec?.application_end_date ?? null,
              new_value: String(uf.newValue),
              evidence_snippet: uf.evidenceText,
              effective_date: uf.effectiveDate,
              created_at: new Date().toISOString(),
            });
          }
        }

        return recordPayloadView;
      });
    } catch (dbErr) {
      const classified = classifyPersistenceError(dbErr);
      const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      logger.error('Failed to persist structured recruitment candidate transactionally', dbErr, {
        recruitmentId: resolvedRecruitmentId,
        documentId: candidate.documentId,
        canonicalIdentityKey,
        correlationId,
        code: classified.code,
        retryable: classified.retryable,
      });
      throw new RecruitmentPersistenceError(
        `Failed to persist recruitment candidate (${classified.code}): ${errMsg}`,
        {
          code: classified.code,
          retryable: classified.retryable,
          cause: dbErr,
        }
      );
    }

    // Optional field-level audit trail (runs AFTER required transaction commit; non-fatal)
    for (const [key, field] of Object.entries(fields)) {
      if (field && field.state !== 'MISSING') {
        try {
          repos.extractionAudits.create({
            id: crypto.randomUUID(),
            document_id: candidate.documentId,
            recruitment_id: committedRecord.id,
            field: key,
            old_value: null,
            new_value: typeof field.value === 'object' ? JSON.stringify(field.value) : String(field.value),
            evidence_id: field.evidence ? `${candidate.documentId}-p${field.evidence.page_number}-${key}` : null,
            validation_status: field.state,
            reason: field.validationNotes || `Field extracted with confidence ${field.confidence}`,
            timestamp: new Date().toISOString(),
          });
        } catch (auditErr) {
          logger.warn('Optional extraction_audit_records insert failed after committed persistence', {
            recruitmentId: committedRecord.id,
            field: key,
            error: String(auditErr),
          });
        }
      }
    }

    logger.info('Structured recruitment record persisted/converged transactionally', {
      recruitmentId: committedRecord.id,
      canonicalIdentityKey,
      convergedExisting,
      documentId: candidate.documentId,
      status: candidate.overallStatus,
      isCorrigendum: candidate.isCorrigendum,
      correlationId,
    });

    return committedRecord;
  }
}
