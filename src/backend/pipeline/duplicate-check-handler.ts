/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PipelineStageName } from '../database/types.ts';
import type {
  DuplicateCheckStageOutput,
  IPipelineStageHandler,
  PipelineContext,
  StageExecutionResult,
} from './contracts.ts';
import { getDeduplicationService } from '../deduplication/index.ts';
import { getExtractionService } from '../extraction/index.ts';
import { getRepositories } from '../database/index.ts';
import {
  reconstructNormalizedDocumentFromDb,
  reconstructStructuredRecruitmentFromDb,
} from './ingestion-handlers.ts';
import type { NormalizedDocument } from '../ingestion/types.ts';
import {
  RecruitmentPersistenceError,
  type StructuredRecruitmentRecord,
} from '../extraction/types.ts';

export interface DuplicateCheckInput {
  document?: NormalizedDocument;
  structuredRecruitment?: StructuredRecruitmentRecord;
  record?: StructuredRecruitmentRecord;
  documentId?: string;
  recruitmentId?: string;
}

export class DuplicateCheckStageHandler
  implements IPipelineStageHandler<DuplicateCheckInput, DuplicateCheckStageOutput>
{
  readonly stageName: PipelineStageName = 'DUPLICATE_CHECK';

  async execute(
    input: DuplicateCheckInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<DuplicateCheckStageOutput>> {
    const dedupService = getDeduplicationService();
    const extractionService = getExtractionService();
    const repos = getRepositories();

    let document = input?.document;
    if (!document) {
      const documentId =
        input?.documentId ||
        (typeof context.metadata.documentId === 'string' ? context.metadata.documentId : undefined);
      const sourceId =
        typeof context.metadata.sourceId === 'string' ? context.metadata.sourceId : undefined;
      if (documentId) {
        document = reconstructNormalizedDocumentFromDb(repos, documentId, sourceId) ?? undefined;
      }
    }

    if (!document) {
      return {
        success: false,
        errorCode: 'INVALID_INPUT',
        errorMessage: 'Normalized document is required for DUPLICATE_CHECK stage',
      };
    }

    let structuredRecruitment = input?.structuredRecruitment ?? input?.record;
    const inputRecruitmentId =
      structuredRecruitment?.id ||
      input?.recruitmentId ||
      (typeof context.metadata.recruitmentId === 'string'
        ? context.metadata.recruitmentId
        : undefined);

    if (!structuredRecruitment && inputRecruitmentId) {
      structuredRecruitment =
        reconstructStructuredRecruitmentFromDb(repos, inputRecruitmentId) ?? undefined;
    }

    try {
      // 1. Evaluate duplicates & corrigenda BEFORE persisting a new recruitment row!
      const decision = await dedupService.evaluateDocument(
        document,
        structuredRecruitment,
        context.correlationId
      );

      let canonicalRecruitmentId: string | undefined =
        decision.source_documents.matchedRecruitmentId ??
        structuredRecruitment?.id ??
        inputRecruitmentId;
      let resolvedRecord: StructuredRecruitmentRecord | undefined = structuredRecruitment;

      const isConfirmedDuplicate =
        decision.decision === 'DUPLICATE_DOCUMENT' ||
        decision.decision === 'DUPLICATE_RECRUITMENT';

      // 2. Apply decision cleanly:
      //    - DUPLICATE_DOCUMENT / DUPLICATE_RECRUITMENT -> converge to existing canonical recruitment and
      //      terminate processing job cleanly as NO-OP so it NEVER enters PUBLISHING_GATE or WORDPRESS_PUBLISH.
      //    - RELATED_CORRIGENDUM / RELATED_ADDENDUM / REVISED_NOTIFICATION -> link to parent recruitment and
      //      continue downstream so the canonical WordPress post can be updated cleanly.
      //    - NEW_RECRUITMENT / UNRELATED / POSSIBLE_DUPLICATE -> deterministically persist/upsert candidate.
      if (isConfirmedDuplicate) {
        const matchedId = decision.source_documents.matchedRecruitmentId;
        if (matchedId) {
          canonicalRecruitmentId = matchedId;
          const existingRecord = reconstructStructuredRecruitmentFromDb(repos, matchedId);
          if (existingRecord) {
            resolvedRecord = existingRecord;
          }
        }
      } else if (
        decision.decision === 'RELATED_CORRIGENDUM' ||
        decision.decision === 'RELATED_ADDENDUM' ||
        decision.decision === 'REVISED_NOTIFICATION'
      ) {
        if (decision.source_documents.matchedRecruitmentId) {
          canonicalRecruitmentId = decision.source_documents.matchedRecruitmentId;
        }
      } else if (structuredRecruitment && !structuredRecruitment.persisted) {
        const persisted = extractionService.persistRecruitmentCandidate(
          structuredRecruitment,
          document,
          context.correlationId
        );
        resolvedRecord = persisted;
        canonicalRecruitmentId = persisted.id;
      }

      const action = await dedupService.applyDecision(
        decision,
        document,
        resolvedRecord,
        context.correlationId
      );

      if (isConfirmedDuplicate) {
        return {
          success: true,
          terminateAsNoOp: true,
          terminalReason: 'DUPLICATE_SUPPRESSED',
          output: {
            ...decision,
            deduplicationDecision: decision,
            recruitmentId: canonicalRecruitmentId,
            duplicateSuppressed: true,
            terminalReason: 'DUPLICATE_SUPPRESSED',
            ...(resolvedRecord ? { record: resolvedRecord, structuredRecruitment: resolvedRecord } : {}),
          },
          persistMetadata: {
            documentId: document.id,
            recruitmentId: canonicalRecruitmentId,
            canonicalIdentityKey: resolvedRecord?.canonicalIdentityKey ?? null,
            deduplicationDecision: decision.decision,
            duplicateSuppressed: true,
            terminalOutcome: 'DUPLICATE_SUPPRESSED',
            matchedDocumentId: decision.source_documents.matchedDocumentId ?? null,
            matchedRecruitmentId: decision.source_documents.matchedRecruitmentId ?? null,
          },
          auditDetails: {
            decision: decision.decision,
            confidence: decision.confidence,
            matchedFields: decision.matched_fields,
            actionTaken: action.actionTaken,
            canonicalRecruitmentId: canonicalRecruitmentId ?? null,
            duplicateSuppressed: true,
          },
        };
      }

      // Reload parent record after corrigendum mutation so downstream stages see updated state
      if (
        (decision.decision === 'RELATED_CORRIGENDUM' ||
          decision.decision === 'RELATED_ADDENDUM' ||
          decision.decision === 'REVISED_NOTIFICATION') &&
        canonicalRecruitmentId
      ) {
        const refreshedParent = reconstructStructuredRecruitmentFromDb(repos, canonicalRecruitmentId);
        if (refreshedParent) {
          resolvedRecord = refreshedParent;
        }
      }

      return {
        success: true,
        output: {
          ...decision,
          deduplicationDecision: decision,
          recruitmentId: canonicalRecruitmentId,
          duplicateSuppressed: false,
          ...(resolvedRecord ? { record: resolvedRecord, structuredRecruitment: resolvedRecord } : {}),
        },
        persistMetadata: {
          documentId: document.id,
          recruitmentId: canonicalRecruitmentId,
          canonicalIdentityKey: resolvedRecord?.canonicalIdentityKey ?? null,
          deduplicationDecision: decision.decision,
          duplicateSuppressed: false,
          matchedDocumentId: decision.source_documents.matchedDocumentId ?? null,
          matchedRecruitmentId: decision.source_documents.matchedRecruitmentId ?? null,
        },
        auditDetails: {
          decision: decision.decision,
          confidence: decision.confidence,
          matchedFields: decision.matched_fields,
          actionTaken: action.actionTaken,
          canonicalRecruitmentId: canonicalRecruitmentId ?? null,
          duplicateSuppressed: false,
        },
      };
    } catch (err) {
      if (err instanceof RecruitmentPersistenceError) {
        return {
          success: false,
          errorCode: err.code,
          errorMessage: err.message,
          auditDetails: {
            persistenceFailed: true,
            retryable: err.retryable,
            errorCode: err.code,
          },
        };
      }
      return {
        success: false,
        errorCode: 'DUPLICATE_CHECK_FAILED',
        errorMessage: `Deduplication evaluation failed: ${(err as Error).message}`,
      };
    }
  }
}
