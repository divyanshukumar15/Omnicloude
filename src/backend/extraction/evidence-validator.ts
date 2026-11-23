/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtractedField, FieldEvidence, StructuredRecruitmentData } from './types.ts';
import { CRITICAL_RECRUITMENT_FIELDS } from './types.ts';
import type { NormalizedPage } from '../ingestion/types.ts';

export type UrlProvenanceTier = 'PDF_GROUNDED' | 'TRUSTED_METADATA' | 'UNVERIFIED';

export interface EvidenceVerificationResult {
  verified: boolean;
  pageNumber: number;
  documentId: string;
  charOffsetStart?: number;
  charOffsetEnd?: number;
  failureReason?: string;
}

export interface UrlEvidenceVerificationResult {
  verified: boolean;
  provenanceTier: UrlProvenanceTier;
  pageNumber: number;
  documentId: string;
  charOffsetStart?: number;
  charOffsetEnd?: number;
  failureReason?: string;
}

const URL_FIELD_KEYS = new Set<string>([
  'official_notification_url',
  'official_application_url',
  'official_source_url',
]);

const METADATA_ELIGIBLE_URL_FIELDS = new Set<string>([
  'official_notification_url',
  'official_source_url',
]);

function normalizeComparableUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || parsed.hostname.length < 3 || !parsed.hostname.includes('.')) {
      return null;
    }
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export class EvidenceValidator {
  /**
   * Normalizes text for comparison (collapses multiple whitespace, trims, lowercases).
   */
  public static normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Returns true if `fieldKey` is one of the structured URL fields.
   */
  public static isUrlField(fieldKey: string): boolean {
    return URL_FIELD_KEYS.has(fieldKey);
  }

  /**
   * Validates that a string is a syntactically valid http(s) URL with a valid hostname.
   */
  public static isValidHttpUrl(rawUrl: unknown): boolean {
    return typeof rawUrl === 'string' && normalizeComparableUrl(rawUrl) !== null;
  }

  /**
   * Matches `snippet` inside `originalText` using whitespace-collapsed, case-insensitive
   * matching, and maps the match bounds back to EXACT UTF-16 character offsets in
   * `originalText` so `originalText.slice(charOffsetStart, charOffsetEnd)` returns the
   * exact original substring (preserving spaces, tabs, newlines, Devanagari, and punctuation).
   */
  public static findNormalizedMatchInOriginalText(
    originalText: string,
    snippet: string
  ): { charOffsetStart: number; charOffsetEnd: number } | null {
    if (!originalText || !snippet) return null;

    const normalizedSnippet = EvidenceValidator.normalizeText(snippet);
    if (!normalizedSnippet) return null;

    const normChars: string[] = [];
    const origStarts: number[] = [];
    const origEnds: number[] = [];

    let i = 0;
    const len = originalText.length;

    // Skip leading whitespace
    while (i < len && /\s/.test(originalText[i])) {
      i++;
    }

    while (i < len) {
      const ch = originalText[i];
      if (/\s/.test(ch)) {
        const wsStart = i;
        while (i < len && /\s/.test(originalText[i])) {
          i++;
        }
        // Only emit a single separating space if more non-whitespace characters follow
        if (i < len) {
          normChars.push(' ');
          origStarts.push(wsStart);
          origEnds.push(i);
        }
      } else {
        const lower = ch.toLowerCase();
        for (let k = 0; k < lower.length; k++) {
          normChars.push(lower[k]);
          origStarts.push(i);
          origEnds.push(i + 1);
        }
        i++;
      }
    }

    if (normChars.length === 0) return null;

    const normalizedOriginal = normChars.join('');
    const matchIndex = normalizedOriginal.indexOf(normalizedSnippet);
    if (matchIndex === -1) {
      return null;
    }

    const endNormIndex = matchIndex + normalizedSnippet.length - 1;
    const charOffsetStart = origStarts[matchIndex];
    const charOffsetEnd = origEnds[endNormIndex];

    if (
      charOffsetStart === undefined ||
      charOffsetEnd === undefined ||
      charOffsetEnd < charOffsetStart
    ) {
      return null;
    }

    return { charOffsetStart, charOffsetEnd };
  }

  /**
   * Validates that an evidence snippet genuinely exists on the specified page of the document
   * and returns exact UTF-16 character offsets into the original `page.extractedText`.
   */
  public static verifySnippetOnPage(
    evidence: FieldEvidence | null,
    pages: Array<{ pageNumber: number; extractedText: string }>
  ): EvidenceVerificationResult {
    if (!evidence) {
      return {
        verified: false,
        pageNumber: 0,
        documentId: '',
        failureReason: 'NO_EVIDENCE_PROVIDED',
      };
    }

    const snippet = evidence.evidence_text || evidence.snippet || '';
    const pageNum = evidence.page_number ?? evidence.pageNumber ?? 0;
    const docId = evidence.document_id || evidence.documentId || '';

    if (!snippet || snippet.trim().length === 0) {
      return {
        verified: false,
        pageNumber: pageNum,
        documentId: docId,
        failureReason: 'EMPTY_EVIDENCE_SNIPPET',
      };
    }

    // Find the specified page
    const page = pages.find((p) => p.pageNumber === pageNum);
    if (!page) {
      return {
        verified: false,
        pageNumber: pageNum,
        documentId: docId,
        failureReason: `PAGE_${pageNum}_NOT_FOUND_IN_DOCUMENT`,
      };
    }

    if ((page as any).extractionMethod === 'FAILED' || (page as any).extractionMethod === 'OCR_REQUIRED') {
      return {
        verified: false,
        pageNumber: pageNum,
        documentId: docId,
        failureReason: `PAGE_${pageNum}_EXTRACTION_FAILED_OR_UNAVAILABLE`,
      };
    }

    const match = EvidenceValidator.findNormalizedMatchInOriginalText(page.extractedText, snippet);

    if (!match) {
      return {
        verified: false,
        pageNumber: pageNum,
        documentId: docId,
        failureReason: 'SNIPPET_NOT_FOUND_ON_PAGE',
      };
    }

    return {
      verified: true,
      pageNumber: pageNum,
      documentId: docId,
      charOffsetStart: match.charOffsetStart,
      charOffsetEnd: match.charOffsetEnd,
    };
  }

  /**
   * Strict URL provenance validation (BUG 5):
   * Never bypasses verification for URL fields. Requires either:
   * 1. `PDF_GROUNDED`: verbatim snippet verified on a document page containing the URL, OR
   * 2. `TRUSTED_METADATA`: explicit `DOCUMENT_METADATA` provenance with `page_number === 0`,
   *    valid http(s) URL, matching `document_id`, matching `evidence_text`, and (when known)
   *    matching the document's own source/canonical metadata URL.
   *
   * Rejects missing evidence, malformed URLs, foreign `document_id`, and mismatched URL/evidence.
   */
  public static validateUrlEvidence(
    fieldKey: string,
    field: ExtractedField<unknown> | undefined,
    pages: Array<{ pageNumber: number; extractedText: string }>,
    currentDocumentId?: string,
    allowedMetadataUrls?: string[]
  ): UrlEvidenceVerificationResult {
    const rawValue = typeof field?.value === 'string' ? field.value.trim() : '';
    const normalizedValueUrl = normalizeComparableUrl(rawValue);
    const evidence = field?.evidence ?? null;
    const evDocId = evidence?.document_id || evidence?.documentId || '';
    const pageNum = evidence?.page_number ?? evidence?.pageNumber ?? 0;

    if (!normalizedValueUrl) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: 'INVALID_URL_FORMAT',
      };
    }

    if (!evidence) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: 0,
        documentId: '',
        failureReason: 'URL_EVIDENCE_MISSING',
      };
    }

    const snippet = (evidence.evidence_text || evidence.snippet || '').trim();
    if (!snippet) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: 'EMPTY_EVIDENCE_SNIPPET',
      };
    }

    // Strict cross-document contamination check
    if (currentDocumentId && (!evDocId || evDocId !== currentDocumentId)) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: evDocId
          ? `CROSS_RECRUITMENT_CONTAMINATION: Evidence document ID (${evDocId}) does not match current document (${currentDocumentId})`
          : `URL_EVIDENCE_MISSING_DOCUMENT_ID: Evidence lacks document_id matching ${currentDocumentId}`,
      };
    }

    const isExplicitMetadata =
      evidence.provenance_type === 'DOCUMENT_METADATA' ||
      evidence.extraction_method === 'DOCUMENT_METADATA';

    // Path A: Page-grounded URL evidence (PDF_GROUNDED)
    if (!isExplicitMetadata) {
      if (pageNum <= 0) {
        return {
          verified: false,
          provenanceTier: 'UNVERIFIED',
          pageNumber: pageNum,
          documentId: evDocId,
          failureReason: 'URL_PAGE_EVIDENCE_INVALID_PAGE_NUMBER',
        };
      }

      // Ensure the claimed URL value actually matches a URL inside the evidence snippet
      const snippetMatchesUrl =
        snippet.toLowerCase().includes(rawValue.toLowerCase()) ||
        normalizeComparableUrl(snippet) === normalizedValueUrl;
      if (!snippetMatchesUrl) {
        return {
          verified: false,
          provenanceTier: 'UNVERIFIED',
          pageNumber: pageNum,
          documentId: evDocId,
          failureReason: 'URL_EVIDENCE_VALUE_MISMATCH',
        };
      }

      if (pages.length === 0) {
        return {
          verified: false,
          provenanceTier: 'UNVERIFIED',
          pageNumber: pageNum,
          documentId: evDocId,
          failureReason: 'NO_DOCUMENT_PAGES_AVAILABLE_FOR_URL_VERIFICATION',
        };
      }

      const pageCheck = EvidenceValidator.verifySnippetOnPage(evidence, pages);
      if (!pageCheck.verified) {
        return {
          verified: false,
          provenanceTier: 'UNVERIFIED',
          pageNumber: pageNum,
          documentId: evDocId,
          failureReason: pageCheck.failureReason || 'SNIPPET_NOT_FOUND_ON_PAGE',
        };
      }

      return {
        verified: true,
        provenanceTier: 'PDF_GROUNDED',
        pageNumber: pageNum,
        documentId: evDocId,
        charOffsetStart: pageCheck.charOffsetStart,
        charOffsetEnd: pageCheck.charOffsetEnd,
      };
    }

    // Path B: Explicit DOCUMENT_METADATA provenance (TRUSTED_METADATA)
    if (!METADATA_ELIGIBLE_URL_FIELDS.has(fieldKey)) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: `DOCUMENT_METADATA_NOT_ALLOWED_FOR_${fieldKey.toUpperCase()}`,
      };
    }

    if (pageNum !== 0) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: 'DOCUMENT_METADATA_REQUIRES_PAGE_NUMBER_ZERO',
      };
    }

    const normalizedEvidenceUrl = normalizeComparableUrl(snippet);
    if (!normalizedEvidenceUrl || normalizedEvidenceUrl !== normalizedValueUrl) {
      return {
        verified: false,
        provenanceTier: 'UNVERIFIED',
        pageNumber: pageNum,
        documentId: evDocId,
        failureReason: 'URL_METADATA_EVIDENCE_MISMATCH',
      };
    }

    if (allowedMetadataUrls && allowedMetadataUrls.length > 0) {
      const allowedNormalized = allowedMetadataUrls
        .map((u) => normalizeComparableUrl(u))
        .filter((u): u is string => Boolean(u));
      if (allowedNormalized.length > 0 && !allowedNormalized.includes(normalizedValueUrl)) {
        return {
          verified: false,
          provenanceTier: 'UNVERIFIED',
          pageNumber: pageNum,
          documentId: evDocId,
          failureReason: 'URL_METADATA_NOT_BOUND_TO_DOCUMENT',
        };
      }
    }

    return {
      verified: true,
      provenanceTier: 'TRUSTED_METADATA',
      pageNumber: 0,
      documentId: evDocId,
    };
  }

  /**
   * Verifies all extracted fields in a structured recruitment record against document pages
   * and explicit document metadata provenance (for metadata-sourced URLs).
   */
  public static validateAllFields(
    fields: StructuredRecruitmentData,
    pages: NormalizedPage[],
    currentDocumentId?: string,
    allowedMetadataUrls?: string[]
  ): {
    allValid: boolean;
    mandatoryFieldsValid: boolean;
    criticalFieldsValid: boolean;
    verifiedFields: string[];
    invalidFields: Array<{ field: string; reason: string }>;
    missingFields: string[];
  } {
    const verifiedFields: string[] = [];
    const invalidFields: Array<{ field: string; reason: string }> = [];
    const missingFields: string[] = [];

    for (const [key, field] of Object.entries(fields)) {
      if (!field) continue;
      const fieldKey = key as keyof StructuredRecruitmentData;

      if (field.state === 'MISSING' || field.value === null) {
        missingFields.push(key);
        continue;
      }

      if (field.state === 'NOT_APPLICABLE') {
        continue;
      }

      // Strict URL verification without blanket bypass (BUG 5)
      if (EvidenceValidator.isUrlField(fieldKey)) {
        const urlCheck = EvidenceValidator.validateUrlEvidence(
          fieldKey,
          field,
          pages,
          currentDocumentId,
          allowedMetadataUrls
        );

        if (urlCheck.verified) {
          if (field.evidence) {
            if (urlCheck.provenanceTier === 'PDF_GROUNDED') {
              field.evidence.provenance_type = 'PAGE_EVIDENCE';
              field.evidence.verified_in_document = true;
              field.evidence.verifiedInDocument = true;
              field.evidence.metadata_verified = false;
              field.evidence.char_offset_start = urlCheck.charOffsetStart;
              field.evidence.charOffsetStart = urlCheck.charOffsetStart;
              field.evidence.char_offset_end = urlCheck.charOffsetEnd;
              field.evidence.charOffsetEnd = urlCheck.charOffsetEnd;
            } else {
              field.evidence.provenance_type = 'DOCUMENT_METADATA';
              field.evidence.page_number = 0;
              field.evidence.pageNumber = 0;
              field.evidence.verified_in_document = false;
              field.evidence.verifiedInDocument = false;
              field.evidence.metadata_verified = true;
            }
          }
          if (field.state === 'EXTRACTED' || field.state === 'VERIFIED') {
            field.state = 'VERIFIED';
          }
          verifiedFields.push(key);
        } else {
          if (field.evidence) {
            field.evidence.verified_in_document = false;
            field.evidence.verifiedInDocument = false;
            field.evidence.metadata_verified = false;
          }
          field.state = 'INVALID';
          field.validationNotes = `URL evidence validation failed: ${urlCheck.failureReason}`;
          invalidFields.push({ field: key, reason: urlCheck.failureReason || 'URL_UNVERIFIED' });
        }
        continue;
      }

      // Cross-document contamination check if currentDocumentId is provided
      const evidenceDocId = field.evidence?.document_id || field.evidence?.documentId;
      if (currentDocumentId && evidenceDocId && evidenceDocId !== currentDocumentId) {
        const reason = `CROSS_RECRUITMENT_CONTAMINATION: Evidence document ID (${evidenceDocId}) does not match current document (${currentDocumentId})`;
        field.state = 'INVALID';
        if (field.evidence) {
          field.evidence.verified_in_document = false;
          field.evidence.verifiedInDocument = false;
        }
        field.validationNotes = reason;
        invalidFields.push({ field: key, reason });
        continue;
      }

      const check = EvidenceValidator.verifySnippetOnPage(field.evidence, pages);

      if (check.verified) {
        if (field.evidence) {
          field.evidence.provenance_type = 'PAGE_EVIDENCE';
          field.evidence.verified_in_document = true;
          field.evidence.verifiedInDocument = true;
          field.evidence.metadata_verified = false;
          field.evidence.char_offset_start = check.charOffsetStart;
          field.evidence.charOffsetStart = check.charOffsetStart;
          field.evidence.char_offset_end = check.charOffsetEnd;
          field.evidence.charOffsetEnd = check.charOffsetEnd;
        }
        if (field.state === 'EXTRACTED') {
          field.state = 'VERIFIED';
        }
        verifiedFields.push(key);
      } else {
        if (field.evidence) {
          field.evidence.verified_in_document = false;
          field.evidence.verifiedInDocument = false;
        }
        field.state = 'INVALID';
        field.validationNotes = `Evidence validation failed: ${check.failureReason}`;
        invalidFields.push({ field: key, reason: check.failureReason || 'UNKNOWN' });
      }
    }

    // Check critical fields
    const criticalValid = CRITICAL_RECRUITMENT_FIELDS.every((cKey) => {
      const f = fields[cKey];
      if (!f || f.state !== 'VERIFIED') return false;
      if (EvidenceValidator.isUrlField(cKey)) {
        const pageVerified = Boolean(f.evidence?.verified_in_document || f.evidence?.verifiedInDocument);
        const metadataVerified = Boolean(
          f.evidence?.provenance_type === 'DOCUMENT_METADATA' && f.evidence?.metadata_verified
        );
        return pageVerified || metadataVerified;
      }
      return Boolean(f.evidence?.verified_in_document || f.evidence?.verifiedInDocument);
    });

    return {
      allValid: invalidFields.length === 0,
      mandatoryFieldsValid: criticalValid,
      criticalFieldsValid: criticalValid,
      verifiedFields,
      invalidFields,
      missingFields,
    };
  }

  /**
   * Hallucination protection filter:
   * Replaces any model-generated or unsupported value (including URL fields) that lacks
   * valid source page evidence or trusted document metadata provenance with null and MISSING.
   */
  public static filterHallucinations(
    fields: StructuredRecruitmentData,
    pages: NormalizedPage[],
    documentId: string,
    allowedMetadataUrls?: string[]
  ): Array<{ field: string; removedValue: unknown; reason: string }> {
    const stripped: Array<{ field: string; removedValue: unknown; reason: string }> = [];

    for (const [key, field] of Object.entries(fields)) {
      if (!field) continue;
      if (field.value === null || field.state === 'MISSING' || field.state === 'NOT_APPLICABLE') continue;

      if (EvidenceValidator.isUrlField(key)) {
        const urlCheck = EvidenceValidator.validateUrlEvidence(
          key,
          field,
          pages,
          documentId,
          allowedMetadataUrls
        );
        if (!urlCheck.verified) {
          const reason = `URL evidence rejected (${urlCheck.failureReason}); value cannot be verified from source document or trusted metadata`;
          stripped.push({
            field: key,
            removedValue: field.value,
            reason,
          });
          field.value = null;
          field.state = 'MISSING';
          field.confidence = 0.0;
          field.evidence = null;
          field.validationNotes = reason;
        }
        continue;
      }

      const check = EvidenceValidator.verifySnippetOnPage(field.evidence, pages);
      const evidenceDocId = field.evidence?.document_id || field.evidence?.documentId;

      if (!check.verified || (evidenceDocId && evidenceDocId !== documentId)) {
        const reason = !check.verified
          ? `Evidence snippet rejected (${check.failureReason}); value cannot be verified from source document`
          : `Cross-recruitment contamination from ${evidenceDocId}`;

        stripped.push({
          field: key,
          removedValue: field.value,
          reason,
        });

        field.value = null;
        field.state = 'MISSING';
        field.confidence = 0.0;
        field.evidence = null;
        field.validationNotes = reason;
      }
    }

    return stripped;
  }
}
