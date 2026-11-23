/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  getRepositories,
  bootstrapOfficialSources,
} from '../../src/backend/database/index.ts';
import {
  StructuredExtractionService,
  computeCanonicalRecruitmentIdentity,
} from '../../src/backend/extraction/extraction-service.ts';
import type { NormalizedDocument } from '../../src/backend/ingestion/types.ts';
import {
  StructuredExtractionStageHandler,
  EvidenceValidationStageHandler,
} from '../../src/backend/pipeline/ingestion-handlers.ts';
import { DuplicateCheckStageHandler } from '../../src/backend/pipeline/duplicate-check-handler.ts';
import type { PipelineContext } from '../../src/backend/pipeline/contracts.ts';
import { logger } from '../../src/backend/config/logger.ts';
import { getAuditService } from '../../src/backend/audit/index.ts';

function createTestDocument(params: {
  id: string;
  sourceId: string;
  url: string;
  checksum?: string;
  pages: Array<{ pageNumber: number; text: string; method?: 'DIRECT_TEXT' | 'OCR' }>;
}): NormalizedDocument {
  const fullText = params.pages.map((p) => p.text).join('\n\n');
  const parsedDomain = new URL(params.url).hostname;
  const now = new Date().toISOString();
  const totalChars = params.pages.reduce((sum, p) => sum + p.text.length, 0);
  const scannedCount = params.pages.filter((p) => p.method === 'OCR').length;
  return {
    id: params.id,
    sourceId: params.sourceId,
    sourceUrl: params.url,
    canonicalUrl: params.url,
    sourceDomain: parsedDomain,
    checksumSha256:
      params.checksum || crypto.createHash('sha256').update(`${params.id}:${fullText}`).digest('hex'),
    fileSize: Buffer.byteLength(fullText, 'utf8') + 512,
    pageCount: params.pages.length,
    discoveryTimestamp: now,
    downloadTimestamp: now,
    documentType: 'NOTIFICATION_PDF',
    extractionStatus: 'EXTRACTED',
    extractionMethod: scannedCount > 0 ? 'MIXED' : 'DIRECT_TEXT',
    isScanned: scannedCount === params.pages.length,
    pages: params.pages.map((p) => ({
      documentId: params.id,
      pageNumber: p.pageNumber,
      extractedText: p.text,
      charCount: p.text.length,
      extractionMethod: p.method || 'DIRECT_TEXT',
      isScanned: p.method === 'OCR',
      qualityScore: 0.96,
    })),
    qualityMetadata: {
      totalCharacters: totalChars,
      avgCharsPerPage: Math.round(totalChars / Math.max(1, params.pages.length)),
      scannedPageCount: scannedCount,
      textPageCount: params.pages.length - scannedCount,
      isScannedDocument: scannedCount === params.pages.length,
      extractionMethod: scannedCount > 0 ? 'MIXED' : 'DIRECT_TEXT',
    },
  };
}

function seedDocumentRow(doc: NormalizedDocument): void {
  const repos = getRepositories();
  const sourceDocId = `srcdoc-${doc.id}`;
  repos.sourceDocuments.create({
    id: sourceDocId,
    source_id: doc.sourceId,
    url: doc.canonicalUrl,
    title: doc.id,
    document_type: doc.documentType,
    raw_hash: doc.checksumSha256,
    status: 'DOWNLOADED',
    metadata_json: null,
  });
  repos.documents.create({
    id: doc.id,
    source_document_id: sourceDocId,
    source_url: doc.sourceUrl,
    canonical_url: doc.canonicalUrl,
    source_domain: doc.sourceDomain,
    file_path: `/tmp/${doc.id}.pdf`,
    file_size: doc.fileSize,
    page_count: doc.pageCount,
    mime_type: 'application/pdf',
    sha256_hash: doc.checksumSha256,
    storage_uri: `file:///tmp/${doc.id}.pdf`,
    validation_status: 'VALID',
    validation_notes: 'Test document',
    extraction_status: 'EXTRACTED',
    extraction_method: doc.extractionMethod,
    is_scanned: doc.isScanned ? 1 : 0,
  });
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const p of doc.pages) {
    db.prepare(
      `INSERT INTO document_pages (id, document_id, page_number, char_count, extracted_text, extraction_method, is_scanned, quality_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${doc.id}-p${p.pageNumber}`,
      doc.id,
      p.pageNumber,
      p.charCount,
      p.extractedText,
      p.extractionMethod,
      p.isScanned ? 1 : 0,
      p.qualityScore ?? 0.95,
      now
    );
  }
}

describe('Production Hardening: Concurrency (BUG 4), Dedup-Before-Persist (BUG 5), Bilingual/Rich Extraction (BUG 6)', () => {
  beforeEach(() => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
  });

  afterEach(() => {
    closeDatabase();
  });

  // =========================================================================
  // BUG 4 — Stateless Concurrency-Safe Structured Extraction
  // =========================================================================
  it('[BUG 4] extracts 20 concurrent distinct documents on a shared service instance with zero cross-contamination', async () => {
    const sharedService = new StructuredExtractionService();

    const docs = Array.from({ length: 20 }, (_, idx) => {
      const n = idx + 1;
      const orgName =
        idx % 2 === 0
          ? `Staff Selection Commission Unit ${n}`
          : `Bihar Public Service Commission Division ${n}`;
      const advt = `ADVT-2026-${String(n).padStart(3, '0')}`;
      const vacancies = 100 + n * 17;
      const applyUrl = `https://ssc.gov.in/apply/exam-${n}`;
      return createTestDocument({
        id: `doc-concurrent-${n}`,
        sourceId: idx % 2 === 0 ? 'IN-CENTRAL-SSC' : 'IN-BIHAR-BPSC',
        url: `https://ssc.gov.in/notifications/advt-${n}.pdf`,
        pages: [
          {
            pageNumber: 1,
            method: idx % 3 === 0 ? 'OCR' : 'DIRECT_TEXT',
            text: [
              orgName,
              `Advertisement No.: ${advt}`,
              `Notice: Recruitment for Junior Analyst Grade ${n} Examination 2026`,
              `Total Vacancies: ${vacancies}`,
            ].join('\n'),
          },
          {
            pageNumber: 2,
            method: 'DIRECT_TEXT',
            text: [
              'Important Dates:',
              `Opening Date for Online Application: 01/${String((n % 9) + 1).padStart(2, '0')}/2026`,
              `Last Date for Submission of Online Application: 25/${String((n % 9) + 1).padStart(2, '0')}/2026`,
              `Apply Online: ${applyUrl}`,
            ].join('\n'),
          },
        ],
      });
    });

    const results = await Promise.all(
      docs.map((doc, idx) =>
        sharedService.extractRecruitment(doc, `corr-concurrent-${idx}`, { persist: false })
      )
    );

    assert.equal(results.length, 20);
    for (let idx = 0; idx < 20; idx++) {
      const n = idx + 1;
      const res = results[idx];
      const expectedAdvt = `ADVT-2026-${String(n).padStart(3, '0')}`;
      const expectedVacancies = 100 + n * 17;
      const expectedApplyUrl = `https://ssc.gov.in/apply/exam-${n}`;

      assert.equal(res.documentId, `doc-concurrent-${n}`);
      assert.equal(res.fields.advertisement_number.value, expectedAdvt);
      assert.equal(res.fields.total_vacancies.value, expectedVacancies);
      assert.equal(res.fields.official_application_url.value, expectedApplyUrl);

      assert.equal(res.fields.advertisement_number.evidence?.page_number, 1);
      assert.equal(res.fields.official_application_url.evidence?.page_number, 2);
      assert.equal(
        res.fields.advertisement_number.evidence?.extraction_method,
        idx % 3 === 0 ? 'OCR' : 'DIRECT_TEXT',
        'Per-page extraction_method must never leak across concurrent jobs'
      );
    }
  });

  // =========================================================================
  // BUG 5 — Duplicate Recruitment Must NOT Be Persisted Before DUPLICATE_CHECK
  // =========================================================================
  it('[BUG 5] does not persist recruitment before DUPLICATE_CHECK, converges duplicates/retries, and links corrigenda without duplicating parent', async () => {
    const repos = getRepositories();
    const extractionHandler = new StructuredExtractionStageHandler();
    const evidenceHandler = new EvidenceValidationStageHandler();
    const dedupHandler = new DuplicateCheckStageHandler();

    const makeContext = (jobId: string, sourceId: string): PipelineContext => ({
      jobId,
      correlationId: `corr-${jobId}`,
      targetEntityType: 'DOCUMENT',
      targetEntityId: jobId,
      metadata: { sourceId },
      logger,
      auditService: getAuditService(),
    });

    const originalDoc = createTestDocument({
      id: 'doc-bug5-orig-1',
      sourceId: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notifications/cgl-2026.pdf',
      pages: [
        {
          pageNumber: 1,
          text: [
            'Staff Selection Commission',
            'Advertisement No.: SSC/CGL/2026/01',
            'Combined Graduate Level Examination 2026 Recruitment Notification',
            'Total Vacancies: 1450',
            'Educational Qualification: Bachelor Degree from a recognized university.',
            'Online Application Start Date: 10/06/2026',
            'Last Date for Submission of Online Application: 15/07/2026',
            'Apply Online: https://ssc.gov.in/apply/cgl-2026',
          ].join('\n'),
        },
      ],
    });
    seedDocumentRow(originalDoc);

    // Stage 1: STRUCTURED_EXTRACTION must NOT persist to `recruitments`
    const ext1 = await extractionHandler.execute(
      { document: originalDoc },
      makeContext('job-1', 'IN-CENTRAL-SSC')
    );
    assert.equal(ext1.success, true);
    assert.equal(ext1.output?.structuredRecruitment.persisted, false);
    assert.equal(
      repos.recruitments.listAll().length,
      0,
      'STRUCTURED_EXTRACTION must not persist recruitment row before DUPLICATE_CHECK'
    );

    // Stage 2: EVIDENCE_VALIDATION must NOT persist to `recruitments`
    const ev1 = await evidenceHandler.execute(
      { structuredRecruitment: ext1.output!.structuredRecruitment },
      makeContext('job-1', 'IN-CENTRAL-SSC')
    );
    assert.equal(ev1.success, true);
    assert.equal(
      repos.recruitments.listAll().length,
      0,
      'EVIDENCE_VALIDATION must not persist recruitment row before DUPLICATE_CHECK'
    );

    // Stage 3: DUPLICATE_CHECK evaluates first, then persists exactly 1 canonical recruitment
    const dup1 = await dedupHandler.execute(
      { document: originalDoc, structuredRecruitment: ev1.output!.structuredRecruitment },
      makeContext('job-1', 'IN-CENTRAL-SSC')
    );
    assert.equal(dup1.success, true);
    assert.equal(dup1.output?.decision, 'NEW_RECRUITMENT');
    assert.equal(repos.recruitments.listAll().length, 1);
    const canonicalId = dup1.output!.recruitmentId!;

    // Duplicate / retry document with same recruitment identity
    const duplicateDoc = createTestDocument({
      id: 'doc-bug5-dup-2',
      sourceId: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notifications/cgl-2026-mirror.pdf',
      pages: [
        {
          pageNumber: 1,
          text: [
            'Staff Selection Commission',
            'Advertisement No.: SSC/CGL/2026/01',
            'Combined Graduate Level Examination 2026 Recruitment Notification',
            'Total Vacancies: 1450',
            'Educational Qualification: Bachelor Degree from a recognized university.',
            'Online Application Start Date: 10/06/2026',
            'Last Date for Submission of Online Application: 15/07/2026',
            'Apply Online: https://ssc.gov.in/apply/cgl-2026',
          ].join('\n'),
        },
      ],
    });
    seedDocumentRow(duplicateDoc);

    const ext2 = await extractionHandler.execute(
      { document: duplicateDoc },
      makeContext('job-2', 'IN-CENTRAL-SSC')
    );
    assert.equal(ext2.success, true);
    assert.equal(
      repos.recruitments.listAll().length,
      1,
      'Duplicate extraction must not insert second row before DUPLICATE_CHECK'
    );

    const dup2 = await dedupHandler.execute(
      { document: duplicateDoc, structuredRecruitment: ext2.output!.structuredRecruitment },
      makeContext('job-2', 'IN-CENTRAL-SSC')
    );
    assert.equal(dup2.success, true);
    assert.ok(['DUPLICATE_RECRUITMENT', 'DUPLICATE_DOCUMENT'].includes(dup2.output!.decision));
    assert.equal(dup2.output!.recruitmentId, canonicalId, 'Duplicate must converge to canonical recruitment ID');
    assert.equal(repos.recruitments.listAll().length, 1, 'DB must still contain only 1 recruitment row');

    // Corrigendum for the same advertisement must link to parent without creating a second parent recruitment
    const corrigendumDoc = createTestDocument({
      id: 'doc-bug5-corr-3',
      sourceId: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notifications/cgl-2026-corrigendum.pdf',
      pages: [
        {
          pageNumber: 1,
          text: [
            'Staff Selection Commission',
            'CORRIGENDUM',
            'Reference Advertisement No.: SSC/CGL/2026/01',
            'Combined Graduate Level Examination 2026',
            'The Last Date for Submission of Online Application is extended to 30/07/2026.',
          ].join('\n'),
        },
      ],
    });
    seedDocumentRow(corrigendumDoc);

    const ext3 = await extractionHandler.execute(
      { document: corrigendumDoc },
      makeContext('job-3', 'IN-CENTRAL-SSC')
    );
    assert.equal(ext3.success, true);
    const dup3 = await dedupHandler.execute(
      { document: corrigendumDoc, structuredRecruitment: ext3.output!.structuredRecruitment },
      makeContext('job-3', 'IN-CENTRAL-SSC')
    );
    assert.equal(dup3.success, true);
    assert.equal(dup3.output!.decision, 'RELATED_CORRIGENDUM');
    assert.equal(dup3.output!.recruitmentId, canonicalId);
    assert.equal(
      repos.recruitments.listAll().length,
      1,
      'Corrigendum must link to parent without creating a duplicate recruitment row'
    );

    // Deterministic canonical identity consistency check
    const idA = computeCanonicalRecruitmentIdentity({
      sourceId: 'IN-CENTRAL-SSC',
      advertisementNumber: 'SSC/CGL/2026/01',
    });
    const idB = computeCanonicalRecruitmentIdentity({
      sourceId: 'in-central-ssc',
      advertisementNumber: '  ssc/cgl/2026/01 ',
    });
    assert.equal(idA.deterministicRecruitmentId, idB.deterministicRecruitmentId);
  });

  // =========================================================================
  // BUG 6 — Comprehensive Hindi / English / Bilingual Structured Extraction
  // =========================================================================
  it('[BUG 6] extracts bilingual multi-post category-wise vacancies, dates, fees, age, qualification, salary, selection, exam pattern, negative marking, syllabus, documents, URLs with verbatim evidence and zero hallucination', async () => {
    const service = new StructuredExtractionService();

    const richBilingualDoc = createTestDocument({
      id: 'doc-bug6-bilingual',
      sourceId: 'IN-BIHAR-BPSC',
      url: 'https://www.bpsc.bih.nic.in/Advt/BPSC-2026-44.pdf',
      pages: [
        {
          pageNumber: 1,
          text: [
            'बिहार लोक सेवा आयोग (Bihar Public Service Commission)',
            'Advertisement No.: BPSC/44/2026',
            'Recruitment Notification for Combined Assistant Engineer & Revenue Officer Examination 2026',
            'Post Name: Assistant Engineer (Civil), Revenue Officer',
            'Total Vacancies: 820',
            'Category-wise Vacancy: UR: 320, OBC: 180, EWS: 82, SC: 140, ST: 48, Female: 250, PwD: 30, ESM: 20',
            'Pay Scale: Pay Level-9 (Rs. 53,100 - 1,67,800) as per 7th CPC',
          ].join('\n'),
        },
        {
          pageNumber: 2,
          text: [
            'महत्वपूर्ण तिथियाँ / Important Dates:',
            'Online Application Start Date: 10/08/2026',
            'Last Date for Submission of Online Application: 05/09/2026',
            'Correction Window Last Date: 10/09/2026',
            'Admit Card Date: 01/10/2026',
            'Written Examination Date: 18/10/2026',
            'Application Fee: General / UR: Rs. 750/-, OBC: Rs. 750/-, EWS: Rs. 750/-, SC/ST: Rs. 200/-, Female: Rs. 200/-, PwD: Rs. 200/-',
            'Age Limit: Minimum Age 21 years and Maximum Age 37 years. Upper age relaxation: SC/ST 5 years, OBC 3 years.',
          ].join('\n'),
        },
        {
          pageNumber: 3,
          text: [
            'Educational Qualification: Bachelor Degree in Civil Engineering (B.E./B.Tech) from a recognized university.',
            'Experience: Minimum 2 years post-qualification field experience in public works.',
            'Selection Process: Written Examination, Interview, Document Verification.',
            'Exam Pattern: Objective MCQ 150 Questions, 300 Marks, Duration 2 Hours.',
            'Negative Marking: 0.25 mark will be deducted for each wrong answer.',
            'Syllabus: General Studies, Indian Polity, Civil Engineering Mechanics, and Structural Analysis.',
            'Required Documents: 10th Marksheet, Degree Certificate, Caste Certificate, Photo ID Proof.',
            'Important Instructions: Candidates must apply online only and retain a printed copy of the submitted form.',
            'Apply Online: https://onlinebpsc.bihar.gov.in/apply/44-2026',
            'Official Website: https://www.bpsc.bih.nic.in',
          ].join('\n'),
        },
      ],
    });

    const record = await service.extractRecruitment(richBilingualDoc, 'corr-bug6-rich', { persist: false });
    const f = record.fields;

    assert.equal(record.languageDetected, 'BILINGUAL');
    assert.equal(f.advertisement_number.value, 'BPSC/44/2026');
    assert.equal(f.total_vacancies.value, 820);
    assert.ok(f.category_wise_vacancies.value);
    assert.equal(f.category_wise_vacancies.value?.ur, 320);
    assert.equal(f.category_wise_vacancies.value?.obc, 180);
    assert.equal(f.category_wise_vacancies.value?.ews, 82);
    assert.equal(f.category_wise_vacancies.value?.sc, 140);
    assert.equal(f.category_wise_vacancies.value?.st, 48);
    assert.equal(f.category_wise_vacancies.value?.female, 250);
    assert.equal(f.category_wise_vacancies.value?.pwd, 30);
    assert.equal(f.category_wise_vacancies.value?.esm, 20);

    assert.equal(f.application_start_date.value, '2026-08-10');
    assert.equal(f.application_last_date.value, '2026-09-05');
    assert.equal(f.correction_last_date.value, '2026-09-10');
    assert.equal(f.admit_card_date.value, '2026-10-01');
    assert.equal(f.exam_date.value, '2026-10-18');

    assert.equal(f.application_fee.value?.unreserved, 750);
    assert.equal(f.age_min.value, 21);
    assert.equal(f.age_max.value, 37);
    assert.ok(f.age_relaxation.value && Object.keys(f.age_relaxation.value).length > 0);

    assert.ok(f.educational_qualification.value?.includes('B.E./B.Tech'));
    assert.ok(f.experience.value?.includes('2 years'));
    assert.ok(f.salary_pay_level.value?.includes('Level-9'));
    assert.ok(f.selection_process.value);
    assert.ok(f.exam_pattern.value?.includes('150 Questions'));
    assert.ok(f.negative_marking.value?.includes('0.25'));
    assert.ok(f.syllabus.value?.includes('General Studies'));
    assert.ok(Array.isArray(f.required_documents.value) && f.required_documents.value.length > 0);
    assert.ok(Array.isArray(f.important_instructions.value) && f.important_instructions.value.length > 0);
    assert.equal(f.official_application_url.value, 'https://onlinebpsc.bihar.gov.in/apply/44-2026');
    assert.equal(f.official_notification_url.value, 'https://www.bpsc.bih.nic.in/Advt/BPSC-2026-44.pdf');

    // Every populated field must carry verbatim page-level evidence
    assert.equal(f.category_wise_vacancies.evidence?.page_number, 1);
    assert.equal(f.application_last_date.evidence?.page_number, 2);
    assert.equal(f.negative_marking.evidence?.page_number, 3);
    assert.equal(f.syllabus.evidence?.page_number, 3);

    // Sparse Hindi-only notice: missing fields MUST remain MISSING with null value (zero hallucination)
    const sparseHindiDoc = createTestDocument({
      id: 'doc-bug6-sparse-hindi',
      sourceId: 'IN-UP-UPSSSC',
      url: 'https://upsssc.gov.in/notice-hindi.pdf',
      pages: [
        {
          pageNumber: 1,
          text: [
            'उत्तर प्रदेश अधीनस्थ सेवा चयन आयोग, लखनऊ',
            'विज्ञापन संख्या: 05-परीक्षा/2026',
            'कुल पद: 250',
            'ऑनलाइन आवेदन प्रारंभ तिथि: 12/09/2026',
            'ऑनलाइन आवेदन की अंतिम तिथि: 02/10/2026',
          ].join('\n'),
        },
      ],
    });

    const sparseRecord = await service.extractRecruitment(sparseHindiDoc, 'corr-bug6-hindi', { persist: false });
    assert.equal(sparseRecord.languageDetected, 'HINDI');
    assert.equal(sparseRecord.fields.total_vacancies.value, 250);
    assert.equal(sparseRecord.fields.application_start_date.value, '2026-09-12');
    assert.equal(sparseRecord.fields.application_last_date.value, '2026-10-02');
    assert.equal(sparseRecord.fields.negative_marking.state, 'MISSING');
    assert.equal(sparseRecord.fields.negative_marking.value, null);
    assert.equal(sparseRecord.fields.syllabus.state, 'MISSING');
    assert.equal(sparseRecord.fields.syllabus.value, null);
    assert.equal(sparseRecord.fields.salary_pay_level.state, 'MISSING');
    assert.equal(sparseRecord.fields.salary_pay_level.value, null);
  });
});
