/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CriticalFailureCode,
  FieldVerificationItem,
  PublishingEvaluationTarget,
  VerificationSummary,
} from './types.ts';
import { DateValidator } from '../extraction/date-validator.ts';
import { EvidenceValidator } from '../extraction/evidence-validator.ts';
import type { ExtractedField, StructuredRecruitmentData } from '../extraction/types.ts';
import type { RepositoryContainer } from '../database/index.ts';

export interface GateRuleCheckContext {
  target: PublishingEvaluationTarget;
  fields: StructuredRecruitmentData;
  documentId: string;
  sourceId: string;
  pages: Array<{ pageNumber: number; extractedText: string }>;
  repos?: RepositoryContainer;
}

export class GateRules {
  /**
   * Evaluates all 15 Critical Gate Conditions deterministically.
   */
  public static evaluateAll(context: GateRuleCheckContext): {
    criticalFailures: CriticalFailureCode[];
    reasons: string[];
    warnings: string[];
    summary: VerificationSummary;
  } {
    const criticalFailures: CriticalFailureCode[] = [];
    const reasons: string[] = [];
    const warnings: string[] = [];

    const summary: VerificationSummary = {
      officialSourceIdentified: false,
      officialDocumentDownloaded: false,
      pdfValidationPassed: false,
      documentProvenanceStored: false,
      requiredFieldsExtracted: false,
      criticalEvidenceVerified: false,
      datesValid: false,
      noFieldConflicts: false,
      noUnresolvedDuplicates: false,
      noCorrigendumConflicts: false,
      recruitmentIdentityVerified: false,
      officialNotificationUrlPresent: false,
      officialApplicationUrlResolved: false,
      noHallucinationsPresent: false,
      sourceChecksumRecorded: false,
      urlProvenance: {},
      fieldsSummary: {},
    };

    // 1. Official Source Check
    this.checkOfficialSource(context, criticalFailures, reasons, summary);

    // 2. Official Document Downloaded & Validated
    this.checkDocumentDownloadAndPdf(context, criticalFailures, reasons, summary);

    // 3. Document Provenance & Checksum
    this.checkProvenanceAndChecksum(context, criticalFailures, reasons, summary);

    // 4. Critical Fields & Evidence
    this.checkCriticalFieldsAndEvidence(context, criticalFailures, reasons, warnings, summary);

    // 5. Date Validation
    this.checkDates(context, criticalFailures, reasons, summary);

    // 6. Field Conflicts & Relationships
    this.checkFieldConflicts(context, criticalFailures, reasons, summary);

    // 7. Deduplication State
    this.checkDeduplicationState(context, criticalFailures, reasons, summary);

    // 8. Corrigendum Conflicts
    this.checkCorrigendumConflicts(context, criticalFailures, reasons, summary);

    // 9. Hallucination Check
    this.checkHallucinations(context, criticalFailures, reasons, summary);

    return {
      criticalFailures,
      reasons,
      warnings,
      summary,
    };
  }

  /**
   * Condition 1: Official Source Identified & Active
   */
  private static checkOfficialSource(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    if (!ctx.sourceId || ctx.sourceId.trim().length === 0) {
      failures.push('OFFICIAL_SOURCE_NOT_IDENTIFIED');
      reasons.push('Official source identifier is missing from recruitment');
      summary.officialSourceIdentified = false;
      return;
    }

    if (ctx.repos) {
      const source = ctx.repos.sources.findById(ctx.sourceId);
      if (!source) {
        // Fallback: check if source belongs to known central or state adapter pattern
        const knownPrefixes = ['IN-CENTRAL-', 'IN-BIHAR-', 'IN-UP-'];
        const isKnownPrefix = knownPrefixes.some((p) => ctx.sourceId.startsWith(p));
        if (!isKnownPrefix) {
          failures.push('OFFICIAL_SOURCE_NOT_IDENTIFIED');
          reasons.push(`Official source '${ctx.sourceId}' is not registered in source registry`);
          summary.officialSourceIdentified = false;
          return;
        }
      } else if (source.is_active === 0) {
        failures.push('OFFICIAL_SOURCE_INACTIVE');
        reasons.push(`Official source '${ctx.sourceId}' is currently inactive or suspended`);
        summary.officialSourceIdentified = false;
        return;
      }
    }

    summary.officialSourceIdentified = true;
  }

  /**
   * Condition 2: Official Document Successfully Downloaded & PDF Validated
   */
  private static checkDocumentDownloadAndPdf(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    let docRecord = ctx.target.document ? {
      validation_status: ctx.target.document.extractionStatus === 'FAILED' ? 'FAILED' : 'VALID',
      file_size: ctx.target.document.fileSize,
      file_path: ctx.target.document.sourceUrl,
      mime_type: 'application/pdf',
    } : null;

    if (!docRecord && ctx.repos && ctx.documentId) {
      const dbDoc = ctx.repos.documents.findById(ctx.documentId);
      if (dbDoc) {
        docRecord = {
          validation_status: dbDoc.validation_status,
          file_size: dbDoc.file_size || 0,
          file_path: dbDoc.file_path || '',
          mime_type: dbDoc.mime_type || 'application/pdf',
        };
      }
    }

    if (!docRecord) {
      // Check if document exists in in-memory target
      if (ctx.documentId && ctx.pages && ctx.pages.length > 0) {
        summary.officialDocumentDownloaded = true;
        summary.pdfValidationPassed = true;
        return;
      }
      failures.push('DOCUMENT_NOT_DOWNLOADED');
      reasons.push(`Official recruitment document (${ctx.documentId || 'unspecified'}) has not been downloaded`);
      summary.officialDocumentDownloaded = false;
      summary.pdfValidationPassed = false;
      return;
    }

    if (docRecord.file_size <= 0) {
      failures.push('DOCUMENT_NOT_DOWNLOADED');
      reasons.push(`Downloaded recruitment PDF is empty (0 bytes)`);
      summary.officialDocumentDownloaded = false;
    } else {
      summary.officialDocumentDownloaded = true;
    }

    if (docRecord.validation_status !== 'VALID') {
      failures.push('DOCUMENT_PDF_VALIDATION_FAILED');
      reasons.push(`Recruitment document failed PDF structure/signature validation (status: ${docRecord.validation_status})`);
      summary.pdfValidationPassed = false;
    } else {
      summary.pdfValidationPassed = true;
    }
  }

  /**
   * Condition 3: Document Provenance Stored & Checksum Recorded
   */
  private static checkProvenanceAndChecksum(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    let sourceUrl = ctx.target.document?.sourceUrl || ctx.fields.official_notification_url.value || '';
    let checksum = ctx.target.document?.checksumSha256 || '';

    if ((!sourceUrl || !checksum) && ctx.repos && ctx.documentId) {
      const dbDoc = ctx.repos.documents.findById(ctx.documentId);
      if (dbDoc) {
        sourceUrl = sourceUrl || dbDoc.source_url || dbDoc.canonical_url || '';
        checksum = checksum || dbDoc.sha256_hash || '';
      }
    }

    if (!sourceUrl || sourceUrl.trim().length === 0) {
      failures.push('DOCUMENT_PROVENANCE_MISSING');
      reasons.push('Source document provenance URL is missing');
      summary.documentProvenanceStored = false;
    } else {
      summary.documentProvenanceStored = true;
    }

    // SHA-256 checksum: must be non-empty, typically 64 hex characters
    if (!checksum || checksum.trim().length < 16) {
      failures.push('SOURCE_CHECKSUM_MISSING');
      reasons.push('Source document SHA-256 cryptographic checksum is missing');
      summary.sourceChecksumRecorded = false;
    } else {
      summary.sourceChecksumRecorded = true;
    }
  }

  /**
   * Condition 4: Required Critical Fields Extracted & Validated with Page-Level Evidence
   */
  private static checkCriticalFieldsAndEvidence(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    warnings: string[],
    summary: VerificationSummary
  ): void {
    const f = ctx.fields;

    // Define critical fields to evaluate
    const criticalFieldsConfig: Array<{
      key: keyof StructuredRecruitmentData;
      missingCode: CriticalFailureCode;
      label: string;
      allowNotApplicable: boolean;
      requireEvidence: boolean;
    }> = [
      { key: 'organization', missingCode: 'ORGANIZATION_MISSING', label: 'Organization', allowNotApplicable: false, requireEvidence: true },
      { key: 'recruitment_title', missingCode: 'RECRUITMENT_TITLE_MISSING', label: 'Recruitment Title', allowNotApplicable: false, requireEvidence: true },
      { key: 'advertisement_number', missingCode: 'ADVERTISEMENT_NUMBER_MISSING', label: 'Advertisement Number', allowNotApplicable: true, requireEvidence: true },
      { key: 'total_vacancies', missingCode: 'TOTAL_VACANCIES_MISSING', label: 'Total Vacancies', allowNotApplicable: true, requireEvidence: true },
      { key: 'application_start_date', missingCode: 'APPLICATION_START_DATE_MISSING', label: 'Application Start Date', allowNotApplicable: true, requireEvidence: true },
      { key: 'application_last_date', missingCode: 'APPLICATION_LAST_DATE_MISSING', label: 'Application Last Date', allowNotApplicable: true, requireEvidence: true },
      { key: 'educational_qualification', missingCode: 'EDUCATIONAL_QUALIFICATION_MISSING', label: 'Educational Qualification', allowNotApplicable: true, requireEvidence: true },
      { key: 'selection_process', missingCode: 'SELECTION_PROCESS_MISSING', label: 'Selection Process', allowNotApplicable: true, requireEvidence: true },
      { key: 'official_notification_url', missingCode: 'OFFICIAL_NOTIFICATION_URL_MISSING', label: 'Official Notification URL', allowNotApplicable: false, requireEvidence: true },
    ];

    const allowedMetadataUrls = this.resolveAllowedMetadataUrls(ctx);

    let allRequiredPresent = true;
    let allEvidenceValid = true;

    for (const cfg of criticalFieldsConfig) {
      const field = f[cfg.key] as ExtractedField<unknown>;
      const item: FieldVerificationItem = {
        state: field?.state || 'MISSING',
        hasEvidence: Boolean(field?.evidence),
        verifiedInDocument: Boolean(field?.evidence?.verified_in_document || field?.evidence?.verifiedInDocument),
        pageNumber: field?.evidence?.page_number,
        snippet: field?.evidence?.evidence_text || field?.evidence?.snippet,
        notApplicableReason: field?.notApplicableReason,
        notes: field?.validationNotes,
      };

      // Case 1: Field explicitly marked NOT_APPLICABLE
      if (field?.state === 'NOT_APPLICABLE') {
        if (!cfg.allowNotApplicable) {
          failures.push(cfg.missingCode);
          reasons.push(`${cfg.label} is mandatory for government recruitment and cannot be NOT_APPLICABLE`);
          allRequiredPresent = false;
        } else if (!field.notApplicableReason || field.notApplicableReason.trim().length < 3) {
          failures.push('NOT_APPLICABLE_WITHOUT_REASON');
          reasons.push(`Field '${cfg.label}' was marked NOT_APPLICABLE but lacks a verified mandatory justification reason`);
          allRequiredPresent = false;
        } else {
          // Properly evidenced NOT_APPLICABLE state is allowed!
          item.state = 'NOT_APPLICABLE';
        }
        summary.fieldsSummary[cfg.key] = item;
        continue;
      }

      // Case 2: Field is MISSING or has null value (MISSING != VERIFIED)
      if (!field || field.state === 'MISSING' || field.value === null || field.value === undefined || field.value === '') {
        failures.push(cfg.missingCode);
        reasons.push(`Critical field '${cfg.label}' is missing or unverified (MISSING != VERIFIED)`);
        allRequiredPresent = false;
        summary.fieldsSummary[cfg.key] = item;
        continue;
      }

      // Case 3: Field is present, verify evidence
      if (cfg.requireEvidence) {
        if (EvidenceValidator.isUrlField(cfg.key)) {
          const urlCheck = EvidenceValidator.validateUrlEvidence(
            cfg.key,
            field,
            ctx.pages,
            ctx.documentId || undefined,
            allowedMetadataUrls
          );
          if (!summary.urlProvenance) {
            summary.urlProvenance = {};
          }
          summary.urlProvenance[cfg.key] = urlCheck.provenanceTier;
          item.urlProvenanceTier = urlCheck.provenanceTier;
          item.provenanceType =
            urlCheck.provenanceTier === 'TRUSTED_METADATA'
              ? 'DOCUMENT_METADATA'
              : urlCheck.provenanceTier === 'PDF_GROUNDED'
                ? 'PAGE_EVIDENCE'
                : undefined;
          item.verifiedInDocument = urlCheck.provenanceTier === 'PDF_GROUNDED';
          item.metadataVerified = urlCheck.provenanceTier === 'TRUSTED_METADATA';

          if (!urlCheck.verified) {
            const reason = urlCheck.failureReason || 'URL_PROVENANCE_UNVERIFIED';
            if (reason.includes('CROSS_RECRUITMENT_CONTAMINATION')) {
              failures.push('EVIDENCE_FOREIGN_DOCUMENT_LINKED');
            } else if (!field.evidence) {
              failures.push('CRITICAL_EVIDENCE_MISSING');
            } else {
              failures.push('EVIDENCE_SNIPPET_UNVERIFIED');
            }
            reasons.push(`URL evidence for '${cfg.label}' failed verification (${reason})`);
            allEvidenceValid = false;
          }
        } else if (!field.evidence) {
          failures.push('CRITICAL_EVIDENCE_MISSING');
          reasons.push(`Critical field '${cfg.label}' has a value but no page-level evidence snippet is attached`);
          allEvidenceValid = false;
        } else {
          const evDocId = field.evidence.document_id || field.evidence.documentId;
          // Cross-document contamination check
          if (ctx.documentId && evDocId && evDocId !== ctx.documentId) {
            failures.push('EVIDENCE_FOREIGN_DOCUMENT_LINKED');
            reasons.push(
              `Evidence for '${cfg.label}' references foreign document (${evDocId}) instead of official document (${ctx.documentId})`
            );
            allEvidenceValid = false;
          }

          // Verify snippet against document pages if pages are available
          if (ctx.pages && ctx.pages.length > 0) {
            const check = EvidenceValidator.verifySnippetOnPage(field.evidence, ctx.pages);
            if (!check.verified) {
              failures.push('EVIDENCE_SNIPPET_UNVERIFIED');
              reasons.push(
                `Evidence snippet for '${cfg.label}' could not be verified on page ${field.evidence.page_number} (${check.failureReason})`
              );
              allEvidenceValid = false;
              item.verifiedInDocument = false;
            } else {
              item.verifiedInDocument = true;
            }
          }
        }
      }

      summary.fieldsSummary[cfg.key] = item;
    }

    // Special Check: Age Information (either age_min, age_max, or age_relaxation or explicit NOT_APPLICABLE)
    const hasAgeMin = f.age_min.value !== null && f.age_min.state !== 'MISSING';
    const hasAgeMax = f.age_max.value !== null && f.age_max.state !== 'MISSING';
    const ageMinNA = f.age_min.state === 'NOT_APPLICABLE';
    const ageMaxNA = f.age_max.state === 'NOT_APPLICABLE';

    if (!hasAgeMin && !hasAgeMax && !ageMinNA && !ageMaxNA) {
      failures.push('AGE_INFORMATION_MISSING');
      reasons.push('Neither minimum age nor maximum age information is extracted (or marked NOT_APPLICABLE with reason)');
      allRequiredPresent = false;
    } else if ((ageMinNA && !f.age_min.notApplicableReason) || (ageMaxNA && !f.age_max.notApplicableReason)) {
      failures.push('NOT_APPLICABLE_WITHOUT_REASON');
      reasons.push('Age information was marked NOT_APPLICABLE without required justification reason');
      allRequiredPresent = false;
    }

    // Populate fieldsSummary for age fields
    summary.fieldsSummary.age_min = {
      state: f.age_min.state,
      hasEvidence: Boolean(f.age_min.evidence),
      verifiedInDocument: Boolean(f.age_min.evidence?.verified_in_document || f.age_min.evidence?.verifiedInDocument),
      pageNumber: f.age_min.evidence?.page_number,
      snippet: f.age_min.evidence?.evidence_text || f.age_min.evidence?.snippet,
      notApplicableReason: f.age_min.notApplicableReason,
      notes: f.age_min.validationNotes,
    };
    summary.fieldsSummary.age_max = {
      state: f.age_max.state,
      hasEvidence: Boolean(f.age_max.evidence),
      verifiedInDocument: Boolean(f.age_max.evidence?.verified_in_document || f.age_max.evidence?.verifiedInDocument),
      pageNumber: f.age_max.evidence?.page_number,
      snippet: f.age_max.evidence?.evidence_text || f.age_max.evidence?.snippet,
      notApplicableReason: f.age_max.notApplicableReason,
      notes: f.age_max.validationNotes,
    };

    // Special Check: Official Application URL & Official Source URL provenance
    const appUrlField = f.official_application_url;
    const appUrlItem: FieldVerificationItem = {
      state: appUrlField.state,
      hasEvidence: Boolean(appUrlField.evidence),
      verifiedInDocument: Boolean(appUrlField.evidence?.verified_in_document || appUrlField.evidence?.verifiedInDocument),
      pageNumber: appUrlField.evidence?.page_number,
      snippet: appUrlField.evidence?.evidence_text || appUrlField.evidence?.snippet,
      notApplicableReason: appUrlField.notApplicableReason,
      notes: appUrlField.validationNotes,
    };

    if (appUrlField.state === 'NOT_APPLICABLE') {
      if (!appUrlField.notApplicableReason || appUrlField.notApplicableReason.trim().length < 3) {
        failures.push('NOT_APPLICABLE_WITHOUT_REASON');
        reasons.push('Official application URL was marked NOT_APPLICABLE without a stated reason (e.g., offline submission)');
      }
      summary.officialApplicationUrlResolved = true;
    } else if (appUrlField.value && appUrlField.value.trim().length > 0) {
      const appCheck = EvidenceValidator.validateUrlEvidence(
        'official_application_url',
        appUrlField,
        ctx.pages,
        ctx.documentId || undefined,
        allowedMetadataUrls
      );
      if (!summary.urlProvenance) summary.urlProvenance = {};
      summary.urlProvenance.official_application_url = appCheck.provenanceTier;
      appUrlItem.urlProvenanceTier = appCheck.provenanceTier;
      appUrlItem.provenanceType = appCheck.provenanceTier === 'PDF_GROUNDED' ? 'PAGE_EVIDENCE' : undefined;
      appUrlItem.verifiedInDocument = appCheck.provenanceTier === 'PDF_GROUNDED';
      appUrlItem.metadataVerified = false;
      summary.officialApplicationUrlResolved = appCheck.verified;
      if (!appCheck.verified) {
        if (appCheck.failureReason?.includes('CROSS_RECRUITMENT_CONTAMINATION')) {
          failures.push('EVIDENCE_FOREIGN_DOCUMENT_LINKED');
        } else {
          failures.push('EVIDENCE_SNIPPET_UNVERIFIED');
        }
        reasons.push(
          `Official application URL could not be verified in document (${appCheck.failureReason})`
        );
        allEvidenceValid = false;
      }
    } else {
      // If missing and recruitment type is direct/online, warn or block
      if (f.recruitment_type.value === 'DIRECT') {
        warnings.push('Official application URL is not specified for a direct recruitment');
      }
      summary.officialApplicationUrlResolved = false;
    }
    summary.fieldsSummary.official_application_url = appUrlItem;

    if (f.official_source_url && f.official_source_url.value && f.official_source_url.state !== 'MISSING') {
      const srcUrlCheck = EvidenceValidator.validateUrlEvidence(
        'official_source_url',
        f.official_source_url,
        ctx.pages,
        ctx.documentId || undefined,
        allowedMetadataUrls
      );
      if (!summary.urlProvenance) summary.urlProvenance = {};
      summary.urlProvenance.official_source_url = srcUrlCheck.provenanceTier;
      summary.fieldsSummary.official_source_url = {
        state: f.official_source_url.state,
        hasEvidence: Boolean(f.official_source_url.evidence),
        verifiedInDocument: srcUrlCheck.provenanceTier === 'PDF_GROUNDED',
        provenanceType:
          srcUrlCheck.provenanceTier === 'TRUSTED_METADATA'
            ? 'DOCUMENT_METADATA'
            : srcUrlCheck.provenanceTier === 'PDF_GROUNDED'
              ? 'PAGE_EVIDENCE'
              : undefined,
        metadataVerified: srcUrlCheck.provenanceTier === 'TRUSTED_METADATA',
        urlProvenanceTier: srcUrlCheck.provenanceTier,
        pageNumber: f.official_source_url.evidence?.page_number,
        snippet: f.official_source_url.evidence?.evidence_text || f.official_source_url.evidence?.snippet,
        notes: f.official_source_url.validationNotes,
      };
      if (!srcUrlCheck.verified) {
        if (srcUrlCheck.failureReason?.includes('CROSS_RECRUITMENT_CONTAMINATION')) {
          failures.push('EVIDENCE_FOREIGN_DOCUMENT_LINKED');
        } else {
          failures.push('EVIDENCE_SNIPPET_UNVERIFIED');
        }
        reasons.push(`Official source URL failed provenance verification (${srcUrlCheck.failureReason})`);
        allEvidenceValid = false;
      }
    }

    // Check Recruitment Identity (Organization + Title + Advertisement Number)
    const orgOk = f.organization.value && f.organization.state !== 'MISSING';
    const titleOk = f.recruitment_title.value && f.recruitment_title.state !== 'MISSING';
    const advtOk = (f.advertisement_number.value && f.advertisement_number.state !== 'MISSING') ||
                   (f.advertisement_number.state === 'NOT_APPLICABLE' && f.advertisement_number.notApplicableReason);

    summary.recruitmentIdentityVerified = Boolean(orgOk && titleOk && advtOk);
    summary.officialNotificationUrlPresent = Boolean(
      f.official_notification_url.value &&
      f.official_notification_url.state !== 'MISSING' &&
      summary.urlProvenance?.official_notification_url !== 'UNVERIFIED'
    );
    summary.requiredFieldsExtracted = allRequiredPresent;
    summary.criticalEvidenceVerified = allEvidenceValid;
  }

  private static resolveAllowedMetadataUrls(ctx: GateRuleCheckContext): string[] {
    const urls = new Set<string>();
    if (ctx.target.document?.canonicalUrl) urls.add(ctx.target.document.canonicalUrl);
    if (ctx.target.document?.sourceUrl) urls.add(ctx.target.document.sourceUrl);
    if (ctx.repos && ctx.documentId) {
      const dbDoc = ctx.repos.documents.findById(ctx.documentId);
      if (dbDoc?.canonical_url) urls.add(dbDoc.canonical_url);
      if (dbDoc?.source_url) urls.add(dbDoc.source_url);
    }
    return Array.from(urls);
  }

  /**
   * Condition 5: Strict Calendar Date & Sequence Validation
   */
  private static checkDates(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    const f = ctx.fields;
    let datesValid = true;

    const dateKeys: Array<keyof StructuredRecruitmentData> = [
      'application_start_date',
      'application_last_date',
      'correction_last_date',
      'exam_date',
      'admit_card_date',
      'result_date',
    ];

    for (const key of dateKeys) {
      const dateField = f[key] as ExtractedField<string>;
      if (dateField.value && dateField.state !== 'MISSING' && dateField.state !== 'NOT_APPLICABLE') {
        if (!DateValidator.isValidCalendarDate(dateField.value)) {
          failures.push('INVALID_CALENDAR_DATE');
          reasons.push(`Field '${key}' has an impossible or invalid calendar date: '${dateField.value}'`);
          datesValid = false;
        }
      }
    }

    // Sequence Check: Start Date <= Last Date
    const startDate = f.application_start_date.value;
    const lastDate = f.application_last_date.value;

    if (startDate && lastDate && f.application_start_date.state !== 'NOT_APPLICABLE' && f.application_last_date.state !== 'NOT_APPLICABLE') {
      const seq = DateValidator.validateDateSequence(startDate, lastDate);
      if (seq.isConflict) {
        failures.push('DATE_SEQUENCE_CONFLICT');
        reasons.push(seq.message || `Application start date (${startDate}) is after application last date (${lastDate})`);
        datesValid = false;
      }
    }

    // Sequence Check: Last Date <= Exam Date (if exam date is specified)
    const examDate = f.exam_date.value;
    if (lastDate && examDate && f.exam_date.state !== 'NOT_APPLICABLE') {
      const examSeq = DateValidator.validateDateSequence(lastDate, examDate);
      if (examSeq.isConflict) {
        failures.push('DATE_SEQUENCE_CONFLICT');
        reasons.push(examSeq.message || `Application closing date (${lastDate}) cannot be after exam date (${examDate})`);
        datesValid = false;
      }
    }

    summary.datesValid = datesValid;
  }

  /**
   * Condition 6: No Unresolved Field Conflicts or Impossible Relationships
   */
  private static checkFieldConflicts(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    const f = ctx.fields;
    let noConflicts = true;

    // Check if any field has state CONFLICT or INVALID
    for (const [key, field] of Object.entries(f)) {
      const typedField = field as ExtractedField<unknown>;
      if (typedField.state === 'CONFLICT') {
        failures.push('FIELD_RELATIONSHIP_CONFLICT');
        reasons.push(`Field '${key}' is in an unresolved CONFLICT state: ${typedField.validationNotes || 'conflicting data values'}`);
        noConflicts = false;
      } else if (typedField.state === 'INVALID') {
        failures.push('FIELD_RELATIONSHIP_CONFLICT');
        reasons.push(`Field '${key}' is in an INVALID state: ${typedField.validationNotes || 'data validation failed'}`);
        noConflicts = false;
      }
    }

    // Age relationship conflict (min > max)
    const ageMin = f.age_min.value;
    const ageMax = f.age_max.value;
    if (typeof ageMin === 'number' && typeof ageMax === 'number' && ageMin > ageMax) {
      failures.push('FIELD_RELATIONSHIP_CONFLICT');
      reasons.push(`Age conflict: minimum age (${ageMin}) exceeds maximum age (${ageMax})`);
      noConflicts = false;
    }

    // Negative vacancies check
    const totalVacancies = f.total_vacancies.value;
    if (typeof totalVacancies === 'number' && (isNaN(totalVacancies) || totalVacancies < 0)) {
      failures.push('FIELD_RELATIONSHIP_CONFLICT');
      reasons.push(`Total vacancies cannot be negative (${totalVacancies})`);
      noConflicts = false;
    }

    summary.noFieldConflicts = noConflicts;
  }

  /**
   * Condition 7: No Unresolved Duplicates
   */
  private static checkDeduplicationState(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    if (!ctx.repos) {
      summary.noUnresolvedDuplicates = true;
      return;
    }

    const docId = ctx.documentId;
    const recId = ctx.target.recruitmentId;

    // Check deduplication evaluations for document or recruitment
    const docEvals = docId ? ctx.repos.deduplicationEvaluations.findByIncomingDocument(docId) : [];
    const recEvals = recId ? ctx.repos.deduplicationEvaluations.findByMatchedRecruitment(recId) : [];

    const allEvals = [...docEvals, ...recEvals];

    for (const ev of allEvals) {
      if (ev.decision === 'DUPLICATE_DOCUMENT' || ev.decision === 'DUPLICATE_RECRUITMENT') {
        failures.push('DUPLICATE_UNRESOLVED');
        reasons.push(`Document/Recruitment has an unresolved duplicate decision (${ev.decision}): ${ev.reason}`);
        summary.noUnresolvedDuplicates = false;
        return;
      }
      if (ev.decision === 'POSSIBLE_DUPLICATE') {
        failures.push('DUPLICATE_UNRESOLVED');
        reasons.push(`Unresolved potential duplicate requires operator verification: ${ev.reason}`);
        summary.noUnresolvedDuplicates = false;
        return;
      }
    }

    summary.noUnresolvedDuplicates = true;
  }

  /**
   * Condition 8: No Unresolved Corrigendum Conflicts
   */
  private static checkCorrigendumConflicts(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    if (!ctx.repos || !ctx.target.recruitmentId) {
      summary.noCorrigendumConflicts = true;
      return;
    }

    // Check if there are corrigendum associations with unapplied or conflicting effective dates
    const associations = ctx.repos.corrigendumAssociations.listByOriginalRecruitment(ctx.target.recruitmentId);
    for (const assoc of associations) {
      if (assoc.amendment_type === 'DATE_EXTENSION' && assoc.effective_date) {
        if (!DateValidator.isValidCalendarDate(assoc.effective_date)) {
          failures.push('CORRIGENDUM_CONFLICT_UNRESOLVED');
          reasons.push(`Corrigendum date extension contains an unresolvable date: ${assoc.effective_date}`);
          summary.noCorrigendumConflicts = false;
          return;
        }
      }
    }

    summary.noCorrigendumConflicts = true;
  }

  /**
   * Condition 9: No Hallucinated Fields Present
   */
  private static checkHallucinations(
    ctx: GateRuleCheckContext,
    failures: CriticalFailureCode[],
    reasons: string[],
    summary: VerificationSummary
  ): void {
    const f = ctx.fields;
    let noHallucinations = true;
    const allowedMetadataUrls = this.resolveAllowedMetadataUrls(ctx);

    for (const [key, field] of Object.entries(f)) {
      if (!field) continue;
      const typedField = field as ExtractedField<unknown>;

      if (typedField.value !== null && typedField.state !== 'MISSING' && typedField.state !== 'NOT_APPLICABLE') {
        // URL fields MUST be validated through EvidenceValidator (PDF_GROUNDED or TRUSTED_METADATA) — never bypassed (BUG 5)
        if (EvidenceValidator.isUrlField(key)) {
          const urlCheck = EvidenceValidator.validateUrlEvidence(
            key,
            typedField,
            ctx.pages,
            ctx.documentId || undefined,
            allowedMetadataUrls
          );
          if (!summary.urlProvenance) summary.urlProvenance = {};
          summary.urlProvenance[key] = urlCheck.provenanceTier;

          if (!urlCheck.verified) {
            failures.push('HALLUCINATED_FIELD_DETECTED');
            reasons.push(
              `URL field '${key}' failed provenance verification (${urlCheck.failureReason}); unverified URLs cannot pass publishing gate`
            );
            noHallucinations = false;
          }
          continue;
        }

        // If value claims extraction/verification but has no evidence snippet at all
        if (!typedField.evidence || !typedField.evidence.evidence_text || typedField.evidence.evidence_text.trim().length === 0) {
          failures.push('HALLUCINATED_FIELD_DETECTED');
          reasons.push(`Field '${key}' has value '${String(typedField.value).slice(0, 40)}' but completely lacks source document evidence`);
          noHallucinations = false;
          continue;
        }

        // If pages are provided, verify the snippet is genuinely in the document
        if (ctx.pages && ctx.pages.length > 0) {
          const check = EvidenceValidator.verifySnippetOnPage(typedField.evidence, ctx.pages);
          if (!check.verified) {
            failures.push('HALLUCINATED_FIELD_DETECTED');
            reasons.push(
              `Field '${key}' evidence snippet was not found in official document (hallucination detected: ${check.failureReason})`
            );
            noHallucinations = false;
          }
        }
      }
    }

    summary.noHallucinationsPresent = noHallucinations;
  }
}
