/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { IDocumentRepository, IEvidenceRepository } from '../../database/repositories/contracts.ts';
import type { DocumentEntity, DocumentPageEntity } from '../../database/types.ts';
import type { NormalizedDocument, NormalizedPage } from '../types.ts';
import { logger } from '../../config/logger.ts';

export class ProvenanceService {
  private docRepo: IDocumentRepository;
  private evidenceRepo: IEvidenceRepository;

  constructor(docRepo: IDocumentRepository, evidenceRepo: IEvidenceRepository) {
    this.docRepo = docRepo;
    this.evidenceRepo = evidenceRepo;
  }

  /**
   * Persists document provenance and every extracted page into the database,
   * guaranteeing no page-level data is lost.
   */
  async persistProvenance(
    doc: NormalizedDocument,
    sourceDocumentId: string,
    filePath?: string
  ): Promise<DocumentEntity> {
    logger.info('Persisting document provenance and page records', {
      documentId: doc.id,
      pages: doc.pages.length,
      checksum: doc.checksumSha256,
      status: doc.extractionStatus,
    });

    // 1. Atomically create or converge canonical document entity by SHA-256 hash
    const { entity: docEntity, created } = this.docRepo.upsertByHash({
      id: doc.id,
      source_document_id: sourceDocumentId,
      source_url: doc.sourceUrl,
      canonical_url: doc.canonicalUrl,
      source_domain: doc.sourceDomain,
      file_path: filePath ?? null,
      file_size: doc.fileSize,
      page_count: doc.pageCount,
      mime_type: 'application/pdf',
      sha256_hash: doc.checksumSha256,
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: `Validated %PDF- signature, %%EOF, ${doc.pageCount} pages`,
      extraction_status: doc.extractionStatus,
      extraction_method: doc.extractionMethod,
      is_scanned: doc.isScanned ? 1 : 0,
    });

    const resolvedDocId = docEntity.id;
    if (!created) {
      this.docRepo.updateExtractionStatus(resolvedDocId, {
        status: doc.extractionStatus,
        method: doc.extractionMethod,
        isScanned: doc.isScanned ? 1 : 0,
        pageCount: doc.pageCount,
        validationNotes: `Validated %PDF- signature, %%EOF, ${doc.pageCount} pages`,
      });
    }

    // 2. Persist all page records with page-level provenance cleanly on the canonical document
    const pageEntities: Omit<DocumentPageEntity, 'created_at'>[] = doc.pages.map((p) => ({
      id: crypto.randomUUID(),
      document_id: resolvedDocId,
      page_number: p.pageNumber,
      char_count: p.charCount,
      extracted_text: p.extractedText,
      extraction_method: p.extractionMethod,
      is_scanned: p.isScanned ? 1 : 0,
      quality_score: p.qualityScore ?? (p.isScanned ? 0.1 : 0.9),
    }));

    this.docRepo.replacePages(resolvedDocId, pageEntities);

    // 3. For pages with extracted text, register ground truth evidence entries
    for (const page of doc.pages) {
      if (page.extractedText.length > 0) {
        const snippet = page.extractedText.substring(0, 300);
        this.evidenceRepo.create({
          id: crypto.randomUUID(),
          entity_type: 'RECRUITMENT',
          entity_id: resolvedDocId,
          field_name: `PAGE_${page.pageNumber}_PROVENANCE`,
          source_document_id: docEntity.source_document_id,
          snippet,
          page_number: page.pageNumber,
          confidence_score: page.qualityScore ?? 1.0,
          bounding_box_json: null,
        });
      }
    }

    return docEntity;
  }

  /**
   * Retrieves full page-level provenance for a document.
   */
  getDocumentPages(documentId: string): DocumentPageEntity[] {
    return this.docRepo.getPages(documentId);
  }

  /**
   * Retrieves document by ID.
   */
  getDocument(documentId: string): DocumentEntity | null {
    return this.docRepo.findById(documentId);
  }

  /**
   * Retrieves document by SHA-256 hash.
   */
  getDocumentByHash(sha256Hash: string): DocumentEntity | null {
    return this.docRepo.findByHash(sha256Hash);
  }
}
