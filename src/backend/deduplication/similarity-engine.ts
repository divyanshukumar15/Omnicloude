/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NormalizedDocument } from '../ingestion/types.ts';
import type { StructuredRecruitmentRecord } from '../extraction/types.ts';
import type {
  DeduplicationDecision,
  DeduplicationEvaluationCandidate,
} from './types.ts';
import { TextFingerprinter } from './fingerprint.ts';
import { CorrigendumAnalyzer } from './corrigendum-analyzer.ts';

export class MultiLevelSimilarityEngine {
  /**
   * Normalizes organization strings for deterministic cross-comparison.
   * Maps common acronyms, Hindi forms, and punctuation variants to a canonical key.
   */
  public static normalizeOrganization(org: string | null | undefined): string {
    if (!org) return '';
    const clean = org.toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');

    // Canonical acronym mappings
    if (/upsc|unionpublicservicecommission|संघलोकसेवाआयोग/.test(clean)) return 'IN-UPSC';
    if (/ssc|staffselectioncommission|कर्मचारीचयनआयोग/.test(clean)) return 'IN-SSC';
    if (/rrb|railwayrecruitment|रेलवेभर्तीबोर्ड/.test(clean)) return 'IN-RRB';
    if (/bpsc|biharpublicservicecommission|बिहारलोकसेवाआयोग/.test(clean)) return 'IN-BIHAR-BPSC';
    if (/bssc|biharstaffselectioncommission|बिहारकर्मचारीचयनआयोग/.test(clean)) return 'IN-BIHAR-BSSC';
    if (/uppsc|uttarpradeshpublicservicecommission|उत्तरप्रदेशलोकसेवाआयोग/.test(clean)) return 'IN-UP-UPPSC';
    if (/upsssc|uttarpradeshsubordinateservices|उत्तरप्रदेशअधीनस्थ/.test(clean)) return 'IN-UP-UPSSSC';

    return clean;
  }

  /**
   * Normalizes advertisement numbers by removing slashes, dashes, spaces, and case.
   * e.g. "04/2026-CSP" -> "042026CSP", "CEN 01/2026" -> "CEN012026".
   */
  public static normalizeAdvtNumber(advt: string | null | undefined): string {
    if (!advt) return '';
    return advt.toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');
  }

  /**
   * Calculates title similarity using Levenshtein ratio and token overlap.
   */
  public static calculateTitleSimilarity(title1: string, title2: string): number {
    const t1 = title1.toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const t2 = title2.toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ').replace(/\s+/g, ' ').trim();

    if (t1 === t2) return 1.0;
    if (!t1 || !t2) return 0.0;

    const words1 = new Set(t1.split(' ').filter((w) => w.length > 2));
    const words2 = new Set(t2.split(' ').filter((w) => w.length > 2));

    let common = 0;
    for (const w of words1) {
      if (words2.has(w)) common++;
    }

    const total = words1.size + words2.size - common;
    return total > 0 ? common / total : 0.0;
  }

  /**
   * Evaluates an incoming document + extracted structured recruitment against all existing candidates.
   */
  public static evaluate(
    incomingDoc: NormalizedDocument,
    incomingRecruitment: StructuredRecruitmentRecord | undefined,
    existingCandidates: DeduplicationEvaluationCandidate[]
  ): DeduplicationDecision {
    const incomingChecksum = incomingDoc.checksumSha256;
    const incomingUrl = incomingDoc.canonicalUrl || incomingDoc.sourceUrl;
    const incomingDocId = incomingDoc.id;

    // =========================================================================
    // LEVEL 1: EXACT DOCUMENT DUPLICATE (Deterministic Checksum / Hash Match)
    // =========================================================================
    for (const candidate of existingCandidates) {
      if (candidate.checksumSha256 && candidate.checksumSha256 === incomingChecksum) {
        const isMirrorUrl = Boolean(
          incomingUrl &&
          (candidate.canonicalUrl || candidate.sourceUrl) &&
          incomingUrl !== (candidate.canonicalUrl || candidate.sourceUrl)
        );

        return {
          decision: 'DUPLICATE_DOCUMENT',
          confidence: 1.0,
          matched_fields: ['checksum_sha256', ...(isMirrorUrl ? ['mirrored_url'] : [])],
          reason: isMirrorUrl
            ? `Mirrored official PDF downloaded from alternate URL: ${incomingUrl} matches primary document checksum.`
            : `Exact binary SHA-256 hash match with previously ingested document (${candidate.documentId}).`,
          source_documents: {
            incomingDocumentId: incomingDocId,
            matchedDocumentId: candidate.documentId,
            matchedRecruitmentId: candidate.recruitmentId,
            incomingChecksum,
            matchedChecksum: candidate.checksumSha256,
            incomingUrl,
            matchedUrl: candidate.canonicalUrl || candidate.sourceUrl || undefined,
          },
          field_mutations: [],
          details: {
            exactChecksumMatch: true,
            canonicalUrlMatch: !isMirrorUrl,
          },
        };
      }
    }

    // =========================================================================
    // LEVEL 4: CORRIGENDUM / ADDENDUM / REVISED NOTIFICATION DETECTION
    // =========================================================================
    const corrigendumAnalysis = CorrigendumAnalyzer.analyze(
      incomingDoc.documentType || 'Official Notice',
      incomingDoc.pages
    );

    if (corrigendumAnalysis.isCorrigendum) {
      // Find matching parent recruitment candidate
      const referencedAdvtNorm = this.normalizeAdvtNumber(corrigendumAnalysis.referencedAdvertisementNumber);
      const incomingOrgNorm = this.normalizeOrganization(incomingRecruitment?.fields.organization.value);

      let matchedParent: DeduplicationEvaluationCandidate | null = null;

      // 1. Match by explicitly referenced advertisement number
      if (referencedAdvtNorm) {
        matchedParent = existingCandidates.find((c) => {
          const candidateAdvtNorm = this.normalizeAdvtNumber(c.advertisementNumber);
          return candidateAdvtNorm === referencedAdvtNorm;
        }) || null;
      }

      // 2. Match by advertisement number + same organization
      if (!matchedParent && incomingRecruitment?.fields.advertisement_number.value) {
        const incomingAdvtNorm = this.normalizeAdvtNumber(incomingRecruitment.fields.advertisement_number.value);
        matchedParent = existingCandidates.find((c) => {
          const cOrg = this.normalizeOrganization(c.organization);
          const cAdvt = this.normalizeAdvtNumber(c.advertisementNumber);
          return cOrg === incomingOrgNorm && cAdvt === incomingAdvtNorm;
        }) || null;
      }

      // 3. Match by same organization + high title similarity
      if (!matchedParent && incomingOrgNorm) {
        const incomingTitle = incomingRecruitment?.fields.recruitment_title.value || '';
        if (incomingTitle) {
          matchedParent = existingCandidates.find((c) => {
            const cOrg = this.normalizeOrganization(c.organization);
            if (cOrg !== incomingOrgNorm) return false;
            const titleSim = this.calculateTitleSimilarity(incomingTitle, c.recruitmentTitle);
            return titleSim >= 0.75;
          }) || null;
        }
      }

      if (matchedParent) {
        // Detect field mutations
        const mutations = incomingRecruitment
          ? CorrigendumAnalyzer.detectMutations(
              {
                application_end_date: matchedParent.applicationLastDate,
                total_vacancies: matchedParent.totalVacancies,
                title: matchedParent.recruitmentTitle,
                raw_payload_json: null,
              },
              incomingRecruitment.fields,
              incomingDocId
            )
          : [];

        const matchedFields = ['organization'];
        if (matchedParent.advertisementNumber) matchedFields.push('advertisement_number');
        if (mutations.length > 0) {
          matchedFields.push(...mutations.map((m) => m.field_name));
        }

        return {
          decision: corrigendumAnalysis.decisionType,
          confidence: corrigendumAnalysis.confidence,
          matched_fields: matchedFields,
          reason: `${corrigendumAnalysis.reason}. Linked to parent recruitment: ${matchedParent.recruitmentTitle} (${matchedParent.advertisementNumber || 'No Advt'}).`,
          source_documents: {
            incomingDocumentId: incomingDocId,
            matchedDocumentId: matchedParent.documentId,
            matchedRecruitmentId: matchedParent.recruitmentId,
            incomingChecksum,
            matchedChecksum: matchedParent.checksumSha256,
            incomingUrl,
            matchedUrl: matchedParent.canonicalUrl || matchedParent.sourceUrl || undefined,
          },
          field_mutations: mutations,
          details: {
            corrigendumKeywords: corrigendumAnalysis.matchedKeywords,
            amendmentScope: corrigendumAnalysis.amendmentScope,
            parentAdvertisementReferenced: corrigendumAnalysis.referencedAdvertisementNumber,
            advertisementNumberMatch: true,
          },
        };
      } else {
        // Corrigendum keywords present, but parent not in DB -> POSSIBLE_DUPLICATE
        return {
          decision: 'POSSIBLE_DUPLICATE',
          confidence: 0.70,
          matched_fields: ['corrigendum_keywords'],
          reason: `Corrigendum/Addendum detected (${corrigendumAnalysis.matchedKeywords.join(', ')}), but referenced parent advertisement "${corrigendumAnalysis.referencedAdvertisementNumber || 'Not Mentioned'}" is not yet found in the system. Kept unmerged for manual review.`,
          source_documents: {
            incomingDocumentId: incomingDocId,
            incomingChecksum,
            incomingUrl,
          },
          field_mutations: [],
          details: {
            corrigendumKeywords: corrigendumAnalysis.matchedKeywords,
            parentAdvertisementReferenced: corrigendumAnalysis.referencedAdvertisementNumber,
          },
        };
      }
    }

    // =========================================================================
    // LEVEL 2 & 3: DOCUMENT SIMILARITY & RECRUITMENT SIMILARITY
    // =========================================================================
    if (!incomingRecruitment) {
      return {
        decision: 'NEW_RECRUITMENT',
        confidence: 0.85,
        matched_fields: [],
        reason: 'New recruitment document ingested without prior match.',
        source_documents: {
          incomingDocumentId: incomingDocId,
          incomingChecksum,
          incomingUrl,
        },
        field_mutations: [],
      };
    }

    const incomingOrg = incomingRecruitment.fields.organization.value || '';
    const incomingOrgNorm = this.normalizeOrganization(incomingOrg);
    const incomingAdvt = incomingRecruitment.fields.advertisement_number.value || '';
    const incomingAdvtNorm = this.normalizeAdvtNumber(incomingAdvt);
    const incomingTitle = incomingRecruitment.fields.recruitment_title.value || '';
    const incomingVacancies = incomingRecruitment.fields.total_vacancies.value;
    const incomingStartDate = incomingRecruitment.fields.application_start_date.value;
    const incomingEndDate = incomingRecruitment.fields.application_last_date.value;
    const incomingFullText = incomingDoc.pages.map((p) => p.extractedText).join(' ');

    for (const candidate of existingCandidates) {
      const candidateOrgNorm = this.normalizeOrganization(candidate.organization);

      // CRITICAL BOUNDARY RULE:
      // "Two different organizations with similar recruitment names" MUST NEVER be duplicates!
      if (incomingOrgNorm && candidateOrgNorm && incomingOrgNorm !== candidateOrgNorm) {
        continue; // Different organization -> cannot be duplicate
      }

      const candidateAdvtNorm = this.normalizeAdvtNumber(candidate.advertisementNumber);

      // Case A: Exact Advertisement Number + Same Organization
      if (incomingAdvtNorm && candidateAdvtNorm && incomingAdvtNorm === candidateAdvtNorm) {
        const titleSim = this.calculateTitleSimilarity(incomingTitle, candidate.recruitmentTitle);
        const textSim = candidate.fullText
          ? TextFingerprinter.compareText(incomingFullText, candidate.fullText)
          : 0.9;

        const vacanciesMatch = incomingVacancies === candidate.totalVacancies;
        const datesMatch = incomingEndDate === candidate.applicationLastDate;

        const matchedFields = ['organization', 'advertisement_number'];
        if (vacanciesMatch) matchedFields.push('total_vacancies');
        if (datesMatch) matchedFields.push('application_last_date');
        if (textSim > 0.8) matchedFields.push('document_text_fingerprint');

        // If identical parameters or text fingerprint > 0.85 -> DUPLICATE_RECRUITMENT
        if ((vacanciesMatch && datesMatch) || textSim >= 0.85) {
          return {
            decision: 'DUPLICATE_RECRUITMENT',
            confidence: 0.98,
            matched_fields: matchedFields,
            reason: `Duplicate recruitment notification: Same organization (${candidate.organization}) and advertisement number (${candidate.advertisementNumber}) with identical vacancy and schedule details.`,
            source_documents: {
              incomingDocumentId: incomingDocId,
              matchedDocumentId: candidate.documentId,
              matchedRecruitmentId: candidate.recruitmentId,
              incomingChecksum,
              matchedChecksum: candidate.checksumSha256,
              incomingUrl,
              matchedUrl: candidate.canonicalUrl || candidate.sourceUrl || undefined,
            },
            field_mutations: [],
            details: {
              advertisementNumberMatch: true,
              organizationMatch: true,
              vacanciesMatch,
              datesMatch,
              titleSimilarityScore: titleSim,
              textFingerprintSimilarity: textSim,
            },
          };
        }
      }

      // Case B: Same Organization, High Title Similarity, but Different Advertisement Numbers
      // e.g. SSC CGL 2025 vs SSC CGL 2026, or SSC CGL vs SSC CHSL
      if (incomingOrgNorm === candidateOrgNorm) {
        const titleSim = this.calculateTitleSimilarity(incomingTitle, candidate.recruitmentTitle);

        // If advertisement numbers are explicitly different and non-empty -> UNRELATED
        if (incomingAdvtNorm && candidateAdvtNorm && incomingAdvtNorm !== candidateAdvtNorm) {
          continue; // Different recruitment batches within same organization
        }

        // If advertisement number is missing or ambiguous on one side, but title and vacancies match
        if (titleSim >= 0.85 && incomingVacancies === candidate.totalVacancies) {
          return {
            decision: 'POSSIBLE_DUPLICATE',
            confidence: 0.72,
            matched_fields: ['organization', 'recruitment_title', 'total_vacancies'],
            reason: `Strong title and vacancy similarity with ${candidate.recruitmentTitle}, but advertisement numbers are missing or inconclusive. Requires manual verification.`,
            source_documents: {
              incomingDocumentId: incomingDocId,
              matchedDocumentId: candidate.documentId,
              matchedRecruitmentId: candidate.recruitmentId,
              incomingChecksum,
              matchedChecksum: candidate.checksumSha256,
              incomingUrl,
              matchedUrl: candidate.canonicalUrl || candidate.sourceUrl || undefined,
            },
            field_mutations: [],
            details: {
              titleSimilarityScore: titleSim,
              organizationMatch: true,
            },
          };
        }
      }
    }

    // No duplicate or corrigendum match found -> NEW_RECRUITMENT
    return {
      decision: 'NEW_RECRUITMENT',
      confidence: 0.95,
      matched_fields: [],
      reason: 'No matching recruitment or document found. Verified as a new official recruitment notification.',
      source_documents: {
        incomingDocumentId: incomingDocId,
        incomingChecksum,
        incomingUrl,
      },
      field_mutations: [],
    };
  }
}
