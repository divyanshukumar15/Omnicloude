/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type {
  PublishingEvaluationTarget,
  PublishingGateResult,
  RecruitmentPublishingState,
} from './types.ts';
import { GateRules } from './gate-rules.ts';
import type { StructuredRecruitmentData, StructuredRecruitmentRecord } from '../extraction/types.ts';
import { getRepositories } from '../database/index.ts';
import { getAuditService } from '../audit/index.ts';
import { createDefaultStructuredFields } from '../extraction/index.ts';

export class PublishingGate {
  public static readonly VALIDATION_VERSION = '1.0.0';

  /**
   * Evaluates whether a recruitment satisfies all critical conditions for publishing.
   * Can evaluate a persisted recruitment ID or an in-memory evaluation target.
   */
  public static async evaluate(
    targetInput: string | PublishingEvaluationTarget
  ): Promise<PublishingGateResult> {
    const repos = getRepositories();
    const evaluatedAt = new Date().toISOString();

    let target: PublishingEvaluationTarget;

    if (typeof targetInput === 'string') {
      const rec = repos.recruitments.findById(targetInput);
      if (!rec) {
        return {
          allowed: false,
          blocked: true,
          state: 'REJECTED',
          reasons: [`Recruitment '${targetInput}' not found in database`],
          critical_failures: ['RECRUITMENT_TITLE_MISSING'],
          warnings: [],
          verification_summary: {
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
            fieldsSummary: {},
          },
          validation_version: PublishingGate.VALIDATION_VERSION,
          evaluated_at: evaluatedAt,
        };
      }

      target = {
        recruitmentId: rec.id,
        sourceId: rec.source_id,
        documentId: rec.document_id || undefined,
        title: rec.title,
        department: rec.department,
        notificationNumber: rec.notification_number,
        totalVacancies: rec.total_vacancies,
        applicationStartDate: rec.application_start_date,
        applicationEndDate: rec.application_end_date,
        rawPayloadJson: rec.raw_payload_json,
        status: rec.status,
      };
    } else {
      target = targetInput;
    }

    // Resolve structured fields
    let fields: StructuredRecruitmentData;
    if (target.fields) {
      fields = target.fields;
    } else if (target.rawPayloadJson) {
      try {
        const parsed = JSON.parse(target.rawPayloadJson);
        fields = parsed.fields || parsed;
      } catch {
        fields = createDefaultStructuredFields(target.sourceId || 'DEFAULT', target.documentId || 'DOC');
      }
    } else {
      fields = createDefaultStructuredFields(target.sourceId || 'DEFAULT', target.documentId || 'DOC');
      // Populate fields from basic target attributes if available
      if (target.title) fields.recruitment_title.value = target.title;
      if (target.notificationNumber) fields.advertisement_number.value = target.notificationNumber;
      if (target.totalVacancies) fields.total_vacancies.value = target.totalVacancies;
      if (target.applicationStartDate) fields.application_start_date.value = target.applicationStartDate;
      if (target.applicationEndDate) fields.application_last_date.value = target.applicationEndDate;
      if (target.department) fields.organization.value = target.department;
    }

    // Resolve document and page context
    let pages: Array<{ pageNumber: number; extractedText: string }> = target.pages || [];
    const docId = target.documentId || target.document?.id || '';

    if (pages.length === 0 && docId) {
      const dbPages = repos.documents.getPages(docId);
      if (dbPages && dbPages.length > 0) {
        pages = dbPages.map((p) => ({
          pageNumber: p.page_number,
          extractedText: p.extracted_text,
        }));
      } else if (target.document && target.document.pages) {
        pages = target.document.pages.map((p) => ({
          pageNumber: p.pageNumber,
          extractedText: p.extractedText,
        }));
      }
    }

    // Execute gate rules check
    const { criticalFailures, reasons, warnings, summary } = GateRules.evaluateAll({
      target,
      fields,
      documentId: docId,
      sourceId: target.sourceId || '',
      pages,
      repos,
    });

    const allowed = criticalFailures.length === 0;
    const blocked = !allowed;

    // Determine state
    let state: RecruitmentPublishingState;
    if (allowed) {
      state = 'PUBLISH_READY';
    } else if (
      criticalFailures.includes('DATE_SEQUENCE_CONFLICT') ||
      criticalFailures.includes('FIELD_RELATIONSHIP_CONFLICT') ||
      criticalFailures.includes('CORRIGENDUM_CONFLICT_UNRESOLVED')
    ) {
      state = 'CONFLICT';
    } else if (
      criticalFailures.includes('DOCUMENT_PDF_VALIDATION_FAILED') ||
      criticalFailures.includes('DUPLICATE_UNRESOLVED')
    ) {
      state = 'REJECTED';
    } else {
      state = 'PUBLISH_BLOCKED';
    }

    const result: PublishingGateResult = {
      allowed,
      blocked,
      state,
      reasons,
      critical_failures: criticalFailures,
      warnings,
      verification_summary: summary,
      validation_version: PublishingGate.VALIDATION_VERSION,
      evaluated_at: evaluatedAt,
    };

    // If this is a persisted recruitment ID, log evaluation record & audit event
    if (target.recruitmentId) {
      try {
        repos.publishingGateEvaluations.create({
          id: crypto.randomUUID(),
          recruitment_id: target.recruitmentId,
          decision: allowed ? 'ALLOWED' : 'BLOCKED',
          gate_state: state,
          reasons_json: JSON.stringify(reasons),
          critical_failures_json: JSON.stringify(criticalFailures),
          warnings_json: JSON.stringify(warnings),
          summary_json: JSON.stringify(summary),
          validation_version: PublishingGate.VALIDATION_VERSION,
        });

        const auditService = getAuditService();
        auditService.record({
          correlationId: crypto.randomUUID(),
          actor: 'PUBLISHING_GATE',
          action: allowed ? 'PUBLISHING_GATE_ALLOWED' : 'PUBLISHING_GATE_BLOCKED',
          entityType: 'RECRUITMENT',
          entityId: target.recruitmentId,
          stage: 'PUBLISHING_GATE',
          status: allowed ? 'SUCCESS' : 'FAILURE',
          details: {
            allowed,
            state,
            critical_failures: criticalFailures,
            reasonsCount: reasons.length,
          },
        });
      } catch (err) {
        // Logging should not crash evaluation
      }
    }

    return result;
  }

  /**
   * Evaluates the recruitment and updates its persisted status in the database.
   */
  public static async evaluateAndTransition(recruitmentId: string): Promise<PublishingGateResult> {
    const repos = getRepositories();
    const result = await this.evaluate(recruitmentId);

    // Update recruitment state
    repos.recruitments.updateStatus(recruitmentId, result.state);

    return result;
  }

  /**
   * Re-evaluates recruitment upon data changes (extraction, evidence, corrigendum, duplicate).
   */
  public static async recheck(recruitmentId: string): Promise<PublishingGateResult> {
    return this.evaluateAndTransition(recruitmentId);
  }
}
