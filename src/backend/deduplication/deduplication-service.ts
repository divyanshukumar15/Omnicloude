/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { NormalizedDocument } from '../ingestion/types.ts';
import type { StructuredRecruitmentRecord } from '../extraction/types.ts';
import type {
  DeduplicationDecision,
  DeduplicationEvaluationCandidate,
} from './types.ts';
import { MultiLevelSimilarityEngine } from './similarity-engine.ts';
import { getRepositories } from '../database/index.ts';
import { getAuditService } from '../audit/index.ts';
import { logger } from '../config/logger.ts';

export class DeduplicationService {
  /**
   * Evaluates an incoming document and its structured recruitment against all existing
   * documents and recruitments in the database.
   */
  async evaluateDocument(
    incomingDoc: NormalizedDocument,
    structuredRecruitment?: StructuredRecruitmentRecord,
    correlationId: string = crypto.randomUUID()
  ): Promise<DeduplicationDecision> {
    const repos = getRepositories();
    const auditService = getAuditService();

    logger.info('Starting multi-level duplicate and corrigendum evaluation', {
      documentId: incomingDoc.id,
      checksum: incomingDoc.checksumSha256,
      correlationId,
    });

    // 1. Gather all existing recruitments and documents as evaluation candidates
    // Exclude the incoming document/recruitment itself so persisted Stage 5/6 records never self-match.
    const existingRecruitments = repos.recruitments.listAll();
    const candidates: DeduplicationEvaluationCandidate[] = [];

    for (const rec of existingRecruitments) {
      if (
        (rec.document_id && rec.document_id === incomingDoc.id) ||
        (structuredRecruitment &&
          structuredRecruitment.persisted !== false &&
          rec.id === structuredRecruitment.id &&
          (!rec.document_id || rec.document_id === incomingDoc.id))
      ) {
        continue;
      }

      const doc = rec.document_id ? repos.documents.findById(rec.document_id) : null;
      let fullText = '';
      if (rec.document_id) {
        const pages = repos.documents.getPages(rec.document_id);
        fullText = pages.map((p) => p.extracted_text).join(' ');
      }

      candidates.push({
        recruitmentId: rec.id,
        documentId: rec.document_id || '',
        organization: rec.department || '',
        recruitmentTitle: rec.title,
        advertisementNumber: rec.notification_number || null,
        totalVacancies: rec.total_vacancies || null,
        applicationStartDate: rec.application_start_date || null,
        applicationLastDate: rec.application_end_date || null,
        checksumSha256: doc?.sha256_hash || '',
        canonicalUrl: doc?.canonical_url || null,
        sourceUrl: doc?.source_url || null,
        fullText,
      });
    }

    // Also include ingested documents that may not have generated a recruitment yet
    const allDocs = repos.documents.listAll();
    for (const d of allDocs) {
      if (d.id === incomingDoc.id) {
        continue;
      }
      if (!candidates.some((c) => c.documentId === d.id)) {
        candidates.push({
          recruitmentId: '',
          documentId: d.id,
          organization: '',
          recruitmentTitle: '',
          advertisementNumber: null,
          totalVacancies: null,
          applicationStartDate: null,
          applicationLastDate: null,
          checksumSha256: d.sha256_hash || '',
          canonicalUrl: d.canonical_url,
          sourceUrl: d.source_url,
        });
      }
    }

    // 2. Execute multi-level deterministic and semantic evaluation
    const decision = MultiLevelSimilarityEngine.evaluate(
      incomingDoc,
      structuredRecruitment,
      candidates
    );

    // 3. Persist explainable decision record into database
    repos.deduplicationEvaluations.create({
      id: crypto.randomUUID(),
      incoming_document_id: incomingDoc.id,
      matched_document_id: decision.source_documents.matchedDocumentId || null,
      matched_recruitment_id: decision.source_documents.matchedRecruitmentId || null,
      decision: decision.decision,
      confidence: decision.confidence,
      matched_fields_json: JSON.stringify(decision.matched_fields),
      reason: decision.reason,
      details_json: decision.details ? JSON.stringify(decision.details) : null,
    });

    // 4. Record audit event
    auditService.record({
      correlationId,
      actor: 'DEDUPLICATION_SERVICE',
      action: `DEDUPLICATION_${decision.decision}`,
      entityType: 'DOCUMENT',
      entityId: incomingDoc.id,
      stage: 'DUPLICATE_CHECK',
      status: decision.decision === 'POSSIBLE_DUPLICATE' ? 'INFO' : 'SUCCESS',
      details: {
        decision: decision.decision,
        confidence: decision.confidence,
        matchedFields: decision.matched_fields,
        reason: decision.reason,
      },
    });

    logger.info('Deduplication evaluation completed', {
      documentId: incomingDoc.id,
      decision: decision.decision,
      confidence: decision.confidence,
      matchedFields: decision.matched_fields,
    });

    return decision;
  }

  /**
   * Applies the deduplication decision:
   * - Links corrigenda to parents without overwriting original evidence.
   * - Retains BOTH original and revised values with exact source document provenance.
   * - Flags exact duplicates to prevent duplicate job creation.
   * - Holds ambiguous POSSIBLE_DUPLICATE without automatic merging.
   */
  async applyDecision(
    decision: DeduplicationDecision,
    incomingDoc: NormalizedDocument,
    structuredRecruitment?: StructuredRecruitmentRecord,
    correlationId: string = crypto.randomUUID()
  ): Promise<{ applied: boolean; actionTaken: string }> {
    const repos = getRepositories();
    const auditService = getAuditService();
    const matchedRecruitmentId = decision.source_documents.matchedRecruitmentId;

    switch (decision.decision) {
      case 'DUPLICATE_DOCUMENT':
      case 'DUPLICATE_RECRUITMENT': {
        // Flag document and do NOT create duplicate recruitment
        repos.documents.updateExtractionStatus(incomingDoc.id, {
          status: 'EXTRACTED',
          validationNotes: `Deduplication: ${decision.decision} (${decision.reason})`,
        });

        auditService.record({
          correlationId,
          actor: 'DEDUPLICATION_SERVICE',
          action: 'DUPLICATE_SUPPRESSED',
          entityType: 'DOCUMENT',
          entityId: incomingDoc.id,
          stage: 'DUPLICATE_CHECK',
          status: 'SUCCESS',
          details: { decision: decision.decision, reason: decision.reason },
        });

        return {
          applied: true,
          actionTaken: 'DUPLICATE_SUPPRESSED_NO_NEW_RECRUITMENT',
        };
      }

      case 'RELATED_CORRIGENDUM':
      case 'RELATED_ADDENDUM':
      case 'REVISED_NOTIFICATION': {
        if (!matchedRecruitmentId) {
          return {
            applied: true,
            actionTaken: 'CORRIGENDUM_IDENTIFIED_PARENT_NOT_FOUND_HELD_FOR_REVIEW',
          };
        }

        const parentRecruitment = repos.recruitments.findById(matchedRecruitmentId);
        if (!parentRecruitment) {
          return { applied: false, actionTaken: 'PARENT_RECRUITMENT_NOT_FOUND' };
        }

        // Ensure source_documents and documents records exist for foreign key constraints,
        // resolving canonical IDs when source_document_id !== document.id or unique indexes converge.
        const existingCorrigendumDoc = repos.documents.findById(incomingDoc.id);
        let resolvedSourceDocumentId = existingCorrigendumDoc?.source_document_id;
        if (!resolvedSourceDocumentId) {
          const existingSourceDocById = repos.sourceDocuments.findById(incomingDoc.id);
          if (existingSourceDocById) {
            resolvedSourceDocumentId = existingSourceDocById.id;
          } else {
            const upsertedSourceDoc = repos.sourceDocuments.upsertCanonical({
              id: incomingDoc.id,
              source_id: incomingDoc.sourceId || 'IN-CENTRAL-SSC',
              url: incomingDoc.canonicalUrl || incomingDoc.sourceUrl || `https://gov.in/${incomingDoc.id}.pdf`,
              canonical_url: incomingDoc.canonicalUrl || incomingDoc.sourceUrl || `https://gov.in/${incomingDoc.id}.pdf`,
              title: incomingDoc.documentType || 'Corrigendum Document',
              document_type: 'CORRIGENDUM_PDF',
              raw_hash: incomingDoc.checksumSha256 || null,
              status: 'DOWNLOADED',
              metadata_json: null,
            });
            resolvedSourceDocumentId = upsertedSourceDoc.entity.id;
          }
        }

        let resolvedDocumentId = existingCorrigendumDoc?.id;
        if (!resolvedDocumentId) {
          const existingByHash = incomingDoc.checksumSha256
            ? repos.documents.findByHash(incomingDoc.checksumSha256)
            : null;
          const upsertedDoc = repos.documents.upsertByHash({
            id: incomingDoc.id,
            source_document_id: resolvedSourceDocumentId,
            source_url: incomingDoc.sourceUrl || `https://gov.in/${incomingDoc.id}.pdf`,
            canonical_url: incomingDoc.canonicalUrl || incomingDoc.sourceUrl || `https://gov.in/${incomingDoc.id}.pdf`,
            source_domain: incomingDoc.sourceDomain || 'gov.in',
            file_path: existingByHash?.file_path ?? null,
            file_size: incomingDoc.fileSize || 1024,
            page_count: incomingDoc.pageCount || 1,
            mime_type: 'application/pdf',
            sha256_hash: incomingDoc.checksumSha256 || null,
            storage_uri: existingByHash?.storage_uri ?? null,
            validation_status: 'VALID',
            validation_notes: null,
            extraction_status: 'EXTRACTED',
            extraction_method: 'DIRECT_TEXT',
            is_scanned: 0,
          });
          resolvedDocumentId = upsertedDoc.entity.id;
          resolvedSourceDocumentId = upsertedDoc.entity.source_document_id;
        }

        // Store each field mutation in corrigendum_associations
        for (const mut of decision.field_mutations) {
          repos.corrigendumAssociations.create({
            id: crypto.randomUUID(),
            original_recruitment_id: matchedRecruitmentId,
            corrigendum_document_id: resolvedDocumentId,
            related_document_id: parentRecruitment.document_id,
            amendment_type: mut.effective_change,
            updated_field: mut.field_name,
            source_page: mut.page_number,
            old_value: mut.original_value !== null ? String(mut.original_value) : null,
            new_value: String(mut.new_value),
            evidence_snippet: mut.evidence_text,
            effective_date: mut.effective_change === 'EXTENSION_OF_LAST_DATE' ? String(mut.new_value) : null,
            created_at: mut.timestamp,
          });

          // STRICT REQUIREMENT: "Never overwrite the original evidence. Store both pieces of evidence."
          // Insert the corrigendum's new evidence into the evidence table alongside the original evidence
          repos.evidence.create({
            id: crypto.randomUUID(),
            entity_type: 'RECRUITMENT',
            entity_id: matchedRecruitmentId,
            field_name: mut.field_name,
            source_document_id: resolvedSourceDocumentId,
            snippet: mut.evidence_text,
            page_number: mut.page_number,
            confidence_score: 0.95,
            bounding_box_json: null,
          });
        }

        // Update the parent recruitment with the latest applicable values
        const updatePayload: Record<string, unknown> = {};
        for (const mut of decision.field_mutations) {
          if (mut.field_name === 'application_last_date' && typeof mut.new_value === 'string') {
            updatePayload.application_end_date = mut.new_value;
          }
          if (mut.field_name === 'total_vacancies' && typeof mut.new_value === 'number') {
            updatePayload.total_vacancies = mut.new_value;
          }
        }

        if (Object.keys(updatePayload).length > 0) {
          repos.recruitments.update(matchedRecruitmentId, updatePayload);
        }

        auditService.record({
          correlationId,
          actor: 'DEDUPLICATION_SERVICE',
          action: 'CORRIGENDUM_LINKED_TO_PARENT',
          entityType: 'RECRUITMENT',
          entityId: matchedRecruitmentId,
          stage: 'DUPLICATE_CHECK',
          status: 'SUCCESS',
          details: {
            corrigendumDocumentId: incomingDoc.id,
            mutationsCount: decision.field_mutations.length,
            decision: decision.decision,
          },
        });

        return {
          applied: true,
          actionTaken: 'CORRIGENDUM_LINKED_EVIDENCE_PRESERVED_PARENT_UPDATED',
        };
      }

      case 'POSSIBLE_DUPLICATE': {
        // "Do not automatically merge a POSSIBLE_DUPLICATE. Require deterministic evidence for automatic merging."
        auditService.record({
          correlationId,
          actor: 'DEDUPLICATION_SERVICE',
          action: 'POSSIBLE_DUPLICATE_FLAGGED',
          entityType: 'DOCUMENT',
          entityId: incomingDoc.id,
          stage: 'DUPLICATE_CHECK',
          status: 'INFO',
          details: { reason: decision.reason, confidence: decision.confidence },
        });

        return {
          applied: true,
          actionTaken: 'POSSIBLE_DUPLICATE_HELD_FOR_MANUAL_REVIEW',
        };
      }

      case 'NEW_RECRUITMENT':
      case 'UNRELATED':
      default: {
        return {
          applied: true,
          actionTaken: 'PROCEED_NEW_RECRUITMENT_CREATION',
        };
      }
    }
  }
}
