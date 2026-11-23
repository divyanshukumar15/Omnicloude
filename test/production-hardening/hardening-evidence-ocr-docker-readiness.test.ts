/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMultiPageSamplePdf } from '../ingestion/fixtures.ts';
import {
  initDatabase,
  closeDatabase,
  getRepositories,
  bootstrapOfficialSources,
} from '../../src/backend/database/index.ts';
import {
  EvidenceValidator,
  StructuredExtractionService,
  createDefaultStructuredFields,
} from '../../src/backend/extraction/index.ts';
import { PublishingGate } from '../../src/backend/publishing-gate/publishing-gate.ts';
import {
  preserveDocumentLayoutText,
  detectAndExtractTables,
} from '../../src/backend/ingestion/extraction/text-structure.ts';
import {
  OcrOrchestrator,
  OcrChecksumCache,
  checkOcrReadiness,
  resetOcrReadinessCache,
  validateOcrModelSyntax,
  type OCRProvider,
  type OcrPageResult,
} from '../../src/backend/ingestion/ocr/index.ts';
import {
  verifyWorkerPackageFiles,
  runContainerSmokeTest,
} from '../../src/worker/container-smoke-test.ts';
import { evaluateSystemReadiness } from '../../src/backend/runtime/readiness-service.ts';
import { createApiApp } from '../../src/backend/api/app.ts';
import type { NormalizedDocument } from '../../src/backend/ingestion/types.ts';

function buildBlankPdf(pageCount: number): Buffer {
  const scannedPages: number[] = [];
  for (let i = 1; i <= pageCount; i++) {
    scannedPages.push(i);
  }
  return createMultiPageSamplePdf({ pageCount, scannedPages });
}

describe('Production Hardening Part 2: BUG 5, BUG 6, BUG 7, BUG 8, BUG 9, BUG 11, BUG 13', () => {
  after(() => {
    resetOcrReadinessCache();
    closeDatabase();
  });

  // =========================================================================
  // BUG 5 — URL evidence must not bypass verification; explicit PDF_GROUNDED vs TRUSTED_METADATA
  // =========================================================================
  it('[BUG 5] enforces strict URL provenance in EvidenceValidator and PublishingGate (PDF_GROUNDED vs TRUSTED_METADATA vs UNVERIFIED)', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const repos = getRepositories();

    const docId = 'doc-bug5-url-proof';
    const page1 = [
      'STAFF SELECTION COMMISSION',
      'Notice No. 05/2026-URL',
      'Combined Graduate Level Examination 2026',
      'Dates for submission of online applications: 01/06/2026',
      'Last date for submission of online applications: 01/07/2026',
      'Total Vacancies: 2500',
      'Age Limit: 18 to 30 years',
      "Essential Educational Qualification: Bachelor's Degree from a recognized University",
      'Selection Process: Tier-I, Tier-II',
      'Apply Online: https://ssc.gov.in/portal/apply-05',
    ].join('\n');

    const sdoc = repos.sourceDocuments.upsertCanonical({
      id: 'sdoc-bug5',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notices/05-2026.pdf',
      title: 'SSC 05/2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADED',
      metadata_json: null,
    });
    repos.documents.upsertByHash({
      id: docId,
      source_document_id: sdoc.entity.id,
      source_url: 'https://ssc.gov.in/notices/05-2026.pdf',
      canonical_url: 'https://ssc.gov.in/notices/05-2026.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/bug5.pdf',
      file_size: 4096,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: '5'.repeat(64),
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    const pages = [{ documentId: docId, pageNumber: 1, extractedText: page1, charCount: page1.length, extractionMethod: 'DIRECT_TEXT' as const, isScanned: false }];

    // 1. Extraction emits explicit DOCUMENT_METADATA (page_number: 0, verified_in_document: false, metadata_verified: true)
    const service = new StructuredExtractionService();
    const doc: NormalizedDocument = {
      id: docId,
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/05-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/05-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: '5'.repeat(64),
      fileSize: 4096,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages,
      qualityMetadata: { totalCharacters: page1.length, avgCharsPerPage: page1.length, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const rec = await service.extractRecruitment(doc, 'corr-bug5', { persist: false });
    assert.equal(rec.overallStatus, 'VERIFIED');
    assert.equal(rec.fields.official_notification_url.evidence?.provenance_type, 'DOCUMENT_METADATA');
    assert.equal(rec.fields.official_notification_url.evidence?.page_number, 0);
    assert.equal(rec.fields.official_notification_url.evidence?.verified_in_document, false);
    assert.equal(rec.fields.official_notification_url.evidence?.metadata_verified, true);
    assert.equal(rec.fields.official_application_url.evidence?.provenance_type, 'PAGE_EVIDENCE');
    assert.equal(rec.fields.official_application_url.evidence?.verified_in_document, true);

    // Gate distinguishes TRUSTED_METADATA vs PDF_GROUNDED and allows valid recruitment
    const validGate = await PublishingGate.evaluate({
      recruitmentId: 'rec-bug5-valid',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: rec.fields,
      document: doc,
      pages: [{ pageNumber: 1, extractedText: page1 }],
    });
    assert.equal(validGate.allowed, true);
    assert.equal(validGate.verification_summary.urlProvenance?.official_notification_url, 'TRUSTED_METADATA');
    assert.equal(validGate.verification_summary.urlProvenance?.official_application_url, 'PDF_GROUNDED');

    // 2. Reject malformed URL (javascript: / non-http)
    const malformedFields = structuredClone(rec.fields);
    malformedFields.official_notification_url.value = 'javascript:alert(1)';
    const malformedCheck = EvidenceValidator.validateUrlEvidence(
      'official_notification_url',
      malformedFields.official_notification_url,
      pages,
      docId
    );
    assert.equal(malformedCheck.verified, false);
    assert.equal(malformedCheck.provenanceTier, 'UNVERIFIED');

    // 3. Reject foreign document_id on URL evidence
    const foreignFields = structuredClone(rec.fields);
    foreignFields.official_notification_url.evidence!.document_id = 'doc-other-foreign';
    const foreignGate = await PublishingGate.evaluate({
      recruitmentId: 'rec-bug5-foreign',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: foreignFields,
      document: doc,
      pages: [{ pageNumber: 1, extractedText: page1 }],
    });
    assert.equal(foreignGate.allowed, false);
    assert.ok(foreignGate.critical_failures.includes('EVIDENCE_FOREIGN_DOCUMENT_LINKED'));

    // 4. Reject ungrounded/hallucinated official_application_url with null evidence
    const hallucinatedUrlFields = structuredClone(rec.fields);
    hallucinatedUrlFields.official_application_url = {
      value: 'https://fake-portal.example.com/apply',
      state: 'VERIFIED',
      confidence: 1.0,
      evidence: null,
    };
    const hallucinatedGate = await PublishingGate.evaluate({
      recruitmentId: 'rec-bug5-hallucinated',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: hallucinatedUrlFields,
      document: doc,
      pages: [{ pageNumber: 1, extractedText: page1 }],
    });
    assert.equal(hallucinatedGate.allowed, false);
    assert.ok(hallucinatedGate.critical_failures.includes('HALLUCINATED_FIELD_DETECTED'));
    assert.equal(hallucinatedGate.verification_summary.urlProvenance?.official_application_url, 'UNVERIFIED');

    // 5. Reject mismatched URL evidence_text vs field value in filterHallucinations
    const mismatchedFields = createDefaultStructuredFields('IN-CENTRAL-SSC', docId);
    mismatchedFields.official_notification_url = {
      value: 'https://ssc.gov.in/notices/05-2026.pdf',
      state: 'VERIFIED',
      confidence: 1.0,
      evidence: {
        document_id: docId,
        page_number: 0,
        field_name: 'official_notification_url',
        evidence_text: 'https://ssc.gov.in/notices/DIFFERENT.pdf',
        extraction_method: 'DOCUMENT_METADATA',
        provenance_type: 'DOCUMENT_METADATA',
        verified_in_document: false,
        metadata_verified: true,
      },
    };
    const stripped = EvidenceValidator.filterHallucinations(mismatchedFields, pages, docId, [
      'https://ssc.gov.in/notices/05-2026.pdf',
    ]);
    assert.equal(stripped.length, 1);
    assert.equal(mismatchedFields.official_notification_url.state, 'MISSING');

    closeDatabase();
  });

  // =========================================================================
  // BUG 6 — Exact original-text UTF-16 character offsets across whitespace/scripts
  // =========================================================================
  it('[BUG 6] maps verified evidence offsets back to exact UTF-16 indices in original page text', () => {
    const cases: Array<{ label: string; original: string; snippet: string; expectedSlice: string }> = [
      {
        label: 'multiple spaces and tabs',
        original: '   Header\t\tTitle:\t   Staff   Selection   Commission   ',
        snippet: 'Staff Selection Commission',
        expectedSlice: 'Staff   Selection   Commission',
      },
      {
        label: 'CRLF and LF newlines',
        original: 'Notice No.\r\n\t04/2026-CGL\n\nTotal   Vacancies:\r\n14,582',
        snippet: 'Total Vacancies: 14,582',
        expectedSlice: 'Total   Vacancies:\r\n14,582',
      },
      {
        label: 'Hindi Devanagari with vowel matras and whitespace',
        original: '  बिहार   लोक  सेवा   आयोग\nविज्ञापन\tसंख्या:   44/2026  ',
        snippet: 'विज्ञापन संख्या: 44/2026',
        expectedSlice: 'विज्ञापन\tसंख्या:   44/2026',
      },
      {
        label: 'mixed English + Hindi + punctuation',
        original: 'Apply Online (ऑनलाइन   आवेदन): https://bpsc.bih.nic.in/apply?id=44&yr=2026!',
        snippet: 'Apply Online (ऑनलाइन आवेदन): https://bpsc.bih.nic.in/apply?id=44&yr=2026!',
        expectedSlice: 'Apply Online (ऑनलाइन   आवेदन): https://bpsc.bih.nic.in/apply?id=44&yr=2026!',
      },
      {
        label: 'start of page with no leading whitespace',
        original: 'UNION PUBLIC SERVICE COMMISSION\nCivil Services Exam 2026',
        snippet: 'UNION PUBLIC SERVICE COMMISSION',
        expectedSlice: 'UNION PUBLIC SERVICE COMMISSION',
      },
      {
        label: 'end of page with trailing whitespace',
        original: 'Fee payable: Rs. 100/-   \r\n  ',
        snippet: 'Rs. 100/-',
        expectedSlice: 'Rs. 100/-',
      },
    ];

    for (const tc of cases) {
      const result = EvidenceValidator.verifySnippetOnPage(
        {
          document_id: 'doc-bug6',
          page_number: 1,
          field_name: 'test_field',
          evidence_text: tc.snippet,
          extraction_method: 'DIRECT_TEXT',
          verified_in_document: false,
        },
        [{ pageNumber: 1, extractedText: tc.original }]
      );

      assert.equal(result.verified, true, `Failed to verify snippet for case: ${tc.label}`);
      assert.equal(typeof result.charOffsetStart, 'number');
      assert.equal(typeof result.charOffsetEnd, 'number');
      const actualSlice = tc.original.slice(result.charOffsetStart, result.charOffsetEnd);
      assert.equal(
        actualSlice,
        tc.expectedSlice,
        `Offset slice mismatch for "${tc.label}": got "${actualSlice}", expected "${tc.expectedSlice}"`
      );
    }
  });

  // =========================================================================
  // BUG 7 — Preserve line breaks and structured tables + consume in StructuredExtractionService
  // =========================================================================
  it('[BUG 7] preserves line breaks/tables and extracts multi-post, category vacancies, and fees with TABLE_EXTRACTION provenance', async () => {
    const rawPdfPage = [
      '  STAFF SELECTION COMMISSION   ',
      'Notice No. 07/2026-TABLE\r\n',
      'Combined Graduate Level Examination 2026',
      'Dates for submission of online applications: 01/06/2026',
      'Last date for submission of online applications: 01/07/2026',
      '',
      '| Name of Post | UR | OBC | EWS | SC | ST | Total |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| Assistant Section Officer | 120 | 60 | 25 | 35 | 15 | 255 |',
      '| Inspector of Income Tax | 80 | 40 | 15 | 25 | 10 | 170 |',
      '| Total | 200 | 100 | 40 | 60 | 25 | 425 |',
      '',
      'Category\tApplication Fee',
      'UR\tRs. 100',
      'OBC\tRs. 100',
      'SC\tExempt (Nil)',
      'Female\tNil',
    ].join('\n');

    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const preserved = preserveDocumentLayoutText(rawPdfPage);
    assert.ok(preserved.includes('\n'), 'Line breaks must be preserved');
    assert.ok(preserved.includes('| Assistant Section Officer |'), 'Pipe table must remain intact');
    assert.ok(preserved.includes('Category\tApplication Fee'), 'Tab table must remain intact');

    const tables = detectAndExtractTables(preserved, 1);
    assert.equal(tables.length, 2, 'Must detect both the pipe vacancy table and tab fee table');
    assert.equal(tables[0].delimiterType, 'PIPE');
    assert.equal(tables[1].delimiterType, 'TAB');

    // Also test Hindi multi-space aligned table
    const hindiTableText = [
      'बिहार लोक सेवा आयोग',
      'विज्ञापन संख्या: 45/2026',
      'सहायक लेखाकार भर्ती 2026',
      'श्रेणी      पद',
      'अनारक्षित    50',
      'अन्य पिछड़ा वर्ग    30',
      'अनुसूचित जाति    20',
    ].join('\n');
    const hindiTables = detectAndExtractTables(hindiTableText, 1);
    assert.equal(hindiTables.length, 1);
    assert.equal(hindiTables[0].delimiterType, 'ALIGNED_COLUMNS');

    const service = new StructuredExtractionService();
    const doc: NormalizedDocument = {
      id: 'doc-bug7-table',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/07-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/07-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: '7'.repeat(64),
      fileSize: 4096,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-bug7-table',
          pageNumber: 1,
          extractedText: preserved,
          tables,
          charCount: preserved.length,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
          qualityScore: 0.99,
        },
      ],
      qualityMetadata: {
        totalCharacters: preserved.length,
        avgCharsPerPage: preserved.length,
        scannedPageCount: 0,
        textPageCount: 1,
        isScannedDocument: false,
        extractionMethod: 'DIRECT_TEXT',
      },
    };

    const rec = await service.extractRecruitment(doc, 'corr-bug7', { persist: false });
    assert.deepEqual(rec.fields.post_names?.value, ['Assistant Section Officer', 'Inspector of Income Tax']);
    assert.equal(rec.fields.post_names?.evidence?.extraction_method, 'TABLE_EXTRACTION');
    assert.equal(rec.fields.post_names?.evidence?.verified_in_document, true);

    assert.equal(rec.fields.total_vacancies.value, 425);
    assert.equal(rec.fields.total_vacancies.evidence?.extraction_method, 'TABLE_EXTRACTION');

    assert.equal(rec.fields.category_wise_vacancies.value?.ur, 200);
    assert.equal(rec.fields.category_wise_vacancies.value?.obc, 100);
    assert.equal(rec.fields.category_wise_vacancies.value?.ews, 40);
    assert.equal(rec.fields.category_wise_vacancies.value?.sc, 60);
    assert.equal(rec.fields.category_wise_vacancies.value?.st, 25);
    assert.equal(rec.fields.category_wise_vacancies.evidence?.extraction_method, 'TABLE_EXTRACTION');
    assert.equal(rec.fields.category_wise_vacancies.evidence?.verified_in_document, true);

    // Exact offset check on table snippet
    const catEv = rec.fields.category_wise_vacancies.evidence!;
    assert.equal(preserved.slice(catEv.char_offset_start, catEv.char_offset_end), tables[0].rawText);

    assert.equal(rec.fields.application_fee.value?.unreserved, 100);
    assert.equal(rec.fields.application_fee.value?.sc, 0);
    assert.equal(rec.fields.application_fee.value?.female, 0);
    assert.equal(rec.fields.application_fee.evidence?.extraction_method, 'TABLE_EXTRACTION');
  });

  // =========================================================================
  // BUG 8 — Bounded concurrency, remaining timeout budget, partial/timeout reporting, cache reuse
  // =========================================================================
  it('[BUG 8] enforces bounded OCR concurrency, accurate timeout budgets, honest partial/timeout statuses, and checksum cache reuse', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    const pdf6Pages = buildBlankPdf(6);
    const cache = new OcrChecksumCache();
    cache.clear();

    // 1. Bounded concurrency <= 3 on 6-page scanned PDF + ordered assembly + cache reuse
    let inFlight = 0;
    let peakInFlight = 0;
    let providerCalls = 0;

    const concurrentProvider: OCRProvider = {
      providerName: 'TEST_CONCURRENT_OCR',
      modelVersion: 'test-v1',
      isAvailable: () => true,
      extractPage: async (pageNumber) => {
        providerCalls++;
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        const text = `STAFF SELECTION COMMISSION\nPage ${pageNumber} Official Notice 08/2026\nTotal Vacancies: 1000`;
        return {
          document_id: 'doc-bug8-conc',
          page_number: pageNumber,
          text,
          language: 'ENGLISH',
          model_confidence: null,
          confidence: null,
          quality_score: 0.95,
          confidence_source: 'NOT_PROVIDED',
          provider: 'TEST_CONCURRENT_OCR',
          model_version: 'test-v1',
          processing_time_ms: 30,
          status: 'OCR_SUCCESS',
          char_count: text.length,
          word_count: text.split(/\s+/).length,
          ocr_result_id: `ocr-p${pageNumber}`,
          timestamp: new Date().toISOString(),
        };
      },
      extractDocument: async () => {
        throw new Error('unused');
      },
    };

    const orchestrator = new OcrOrchestrator({
      provider: concurrentProvider,
      maxConcurrency: 3,
      cache,
    });

    const res1 = await orchestrator.processDocument({
      documentId: 'doc-bug8-conc',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/scanned6.pdf',
      canonicalUrl: 'https://ssc.gov.in/scanned6.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: '8'.repeat(64),
      fileSize: pdf6Pages.length,
      documentType: 'NOTIFICATION_PDF',
      buffer: pdf6Pages,
    });

    assert.equal(res1.extractionStatus, 'EXTRACTED');
    assert.ok(peakInFlight >= 2 && peakInFlight <= 3, `Expected bounded concurrency 2..3, observed peak=${peakInFlight}`);
    assert.equal(providerCalls, 6);
    assert.deepEqual(res1.ocrDetails?.successfulPages, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(res1.ocrDetails?.failedPages, []);
    assert.deepEqual(res1.ocrDetails?.pendingPages, []);
    assert.equal(res1.ocrDetails?.timedOut, false);
    assert.ok(res1.pages[0].extractedText.includes('\n'), 'OCR page text must preserve line breaks');

    // Second run on same checksum + provider + model must hit cache (0 new provider calls)
    const resCached = await orchestrator.processDocument({
      documentId: 'doc-bug8-conc-2',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/scanned6.pdf',
      canonicalUrl: 'https://ssc.gov.in/scanned6.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: '8'.repeat(64),
      fileSize: pdf6Pages.length,
      documentType: 'NOTIFICATION_PDF',
      buffer: pdf6Pages,
    });
    assert.equal(providerCalls, 6, 'Cache must prevent duplicate OCR calls');
    assert.equal(resCached.extractionStatus, 'EXTRACTED');

    // 2. Document timeout must report OCR_TIMEOUT + pendingPages + timedOut=true (NEVER EXTRACTED)
    const slowProvider: OCRProvider = {
      providerName: 'TEST_SLOW_OCR',
      modelVersion: 'test-v1',
      isAvailable: () => true,
      extractPage: async (pageNumber, _buf, opts) => {
        if (pageNumber === 1) {
          const text = 'Page 1 fast extracted content with sufficient text length for quality check.';
          return {
            document_id: 'doc-bug8-to',
            page_number: 1,
            text,
            language: 'ENGLISH',
            model_confidence: null,
            confidence: null,
            quality_score: 0.9,
            confidence_source: 'NOT_PROVIDED',
            provider: 'TEST_SLOW_OCR',
            model_version: 'test-v1',
            processing_time_ms: 5,
            status: 'OCR_SUCCESS',
            char_count: text.length,
            word_count: 12,
            ocr_result_id: 'ocr-fast-1',
            timestamp: new Date().toISOString(),
          };
        }
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('OCR_TIMEOUT: aborted'));
          }, { once: true });
        });
        throw new Error('should have timed out');
      },
      extractDocument: async () => {
        throw new Error('unused');
      },
    };

    const timeoutOrchestrator = new OcrOrchestrator({
      provider: slowProvider,
      maxConcurrency: 1,
      perPageTimeoutMs: 500,
      maxDocumentTimeMs: 120,
      cache: new OcrChecksumCache(),
    });

    const timeoutRes = await timeoutOrchestrator.processDocument({
      documentId: 'doc-bug8-to',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/slow6.pdf',
      canonicalUrl: 'https://ssc.gov.in/slow6.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: '9'.repeat(64),
      fileSize: pdf6Pages.length,
      documentType: 'NOTIFICATION_PDF',
      buffer: pdf6Pages,
    });

    assert.equal(timeoutRes.extractionStatus, 'OCR_TIMEOUT');
    assert.equal(timeoutRes.ocrDetails?.timedOut, true);
    assert.deepEqual(timeoutRes.ocrDetails?.successfulPages, [1]);
    assert.ok((timeoutRes.ocrDetails?.pendingPages?.length ?? 0) >= 1, 'Unstarted pages after timeout must be listed in pendingPages');
    assert.ok((timeoutRes.ocrDetails?.failedPages.length ?? 0) >= 1);

    // 3. Single page failure -> OCR_PARTIAL (never EXTRACTED)
    const partialProvider: OCRProvider = {
      providerName: 'TEST_PARTIAL_OCR',
      modelVersion: 'test-v1',
      isAvailable: () => true,
      extractPage: async (pageNumber) => {
        if (pageNumber === 3) {
          throw new Error('Corrupt image stream on page 3');
        }
        const text = `Page ${pageNumber} extracted cleanly with full notification details and numbers.`;
        return {
          document_id: 'doc-bug8-part',
          page_number: pageNumber,
          text,
          language: 'ENGLISH',
          model_confidence: null,
          confidence: null,
          quality_score: 0.9,
          confidence_source: 'NOT_PROVIDED',
          provider: 'TEST_PARTIAL_OCR',
          model_version: 'test-v1',
          processing_time_ms: 5,
          status: 'OCR_SUCCESS',
          char_count: text.length,
          word_count: 11,
          ocr_result_id: `ocr-part-${pageNumber}`,
          timestamp: new Date().toISOString(),
        };
      },
      extractDocument: async () => {
        throw new Error('unused');
      },
    };

    const partialRes = await new OcrOrchestrator({
      provider: partialProvider,
      maxConcurrency: 3,
      cache: new OcrChecksumCache(),
    }).processDocument({
      documentId: 'doc-bug8-part',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/part6.pdf',
      canonicalUrl: 'https://ssc.gov.in/part6.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'a'.repeat(64),
      fileSize: pdf6Pages.length,
      documentType: 'NOTIFICATION_PDF',
      buffer: pdf6Pages,
    });
    assert.equal(partialRes.extractionStatus, 'OCR_PARTIAL');
    assert.deepEqual(partialRes.ocrDetails?.failedPages, [3]);
    assert.deepEqual(partialRes.ocrDetails?.successfulPages, [1, 2, 4, 5, 6]);

    // 4. Max page limit enforcement (31 pages > 30 -> OCR_LIMIT_EXCEEDED)
    const pdf31Pages = buildBlankPdf(31);
    const limitRes = await orchestrator.processDocument({
      documentId: 'doc-bug8-31p',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/31p.pdf',
      canonicalUrl: 'https://ssc.gov.in/31p.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'b'.repeat(64),
      fileSize: pdf31Pages.length,
      documentType: 'NOTIFICATION_PDF',
      buffer: pdf31Pages,
    });
    assert.equal(limitRes.extractionStatus, 'OCR_LIMIT_EXCEEDED');
  });

  // =========================================================================
  // BUG 9 — OCR readiness separates config, reachability, model validity, and production readiness
  // =========================================================================
  it('[BUG 9] verifies OCR readiness with model syntax checks, live probe error classification, TTL caching, and zero key leakage', async () => {
    resetOcrReadinessCache();

    // 1. Missing API key -> NOT_CONFIGURED
    const unconfigured = await checkOcrReadiness({ apiKey: '', model: 'gemini-2.5-flash' });
    assert.equal(unconfigured.OCR_CONFIGURED, false);
    assert.equal(unconfigured.OCR_PRODUCTION_READY, false);
    assert.equal(unconfigured.status, 'NOT_CONFIGURED');

    // 2. Invalid model syntax -> INVALID_MODEL
    assert.equal(validateOcrModelSyntax('not-a-gemini-model', 'GEMINI_MULTIMODAL_OCR').valid, false);
    const badSyntax = await checkOcrReadiness({ apiKey: 'AIzaSyTestSecretKey123456', model: 'bad model name' });
    assert.equal(badSyntax.OCR_CONFIGURED, false);
    assert.equal(badSyntax.OCR_MODEL_VALID, false);
    assert.equal(badSyntax.classification, 'INVALID_MODEL');

    // 3. Key + valid model syntax WITHOUT live verification -> CONFIGURED_UNVERIFIED (NOT READY!)
    const unverified = await checkOcrReadiness({
      apiKey: 'AIzaSyTestSecretKey123456',
      model: 'gemini-2.5-flash',
      liveVerify: false,
    });
    assert.equal(unverified.OCR_CONFIGURED, true);
    assert.equal(unverified.OCR_PROVIDER_REACHABLE, false);
    assert.equal(unverified.OCR_MODEL_VALID, false);
    assert.equal(unverified.OCR_PRODUCTION_READY, false);
    assert.equal(unverified.status, 'CONFIGURED_UNVERIFIED');

    // 4. Live verification success + TTL cache reuse (probe called only ONCE)
    let probeCalls = 0;
    const liveOk1 = await checkOcrReadiness({
      apiKey: 'AIzaSyTestSecretKey123456',
      model: 'gemini-2.5-flash',
      liveVerify: true,
      probeFn: async () => {
        probeCalls++;
        return { reachable: true, modelValid: true, resolvedModelName: 'models/gemini-2.5-flash' };
      },
    });
    assert.equal(liveOk1.OCR_PRODUCTION_READY, true);
    assert.equal(liveOk1.status, 'READY');
    assert.equal(liveOk1.cached, false);
    assert.equal(probeCalls, 1);

    const liveOkCached = await checkOcrReadiness({
      apiKey: 'AIzaSyTestSecretKey123456',
      model: 'gemini-2.5-flash',
      liveVerify: false, // routine health check reuses fresh cache!
      probeFn: async () => {
        probeCalls++;
        return { reachable: true, modelValid: true };
      },
    });
    assert.equal(liveOkCached.OCR_PRODUCTION_READY, true);
    assert.equal(liveOkCached.cached, true);
    assert.equal(probeCalls, 1, 'Routine health check must reuse cached verification without spamming API');

    // 5. AUTH_ERROR classification & zero API key leakage
    const leakedKey = 'AIzaSySuperSecretNeverLog99999';
    const authFail = await checkOcrReadiness({
      apiKey: leakedKey,
      model: 'gemini-2.5-flash',
      liveVerify: true,
      forceRefresh: true,
      probeFn: async () => {
        throw new Error(`401 API_KEY_INVALID for key=${leakedKey}`);
      },
    });
    assert.equal(authFail.classification, 'AUTH_ERROR');
    assert.equal(authFail.OCR_PRODUCTION_READY, false);
    assert.ok(!authFail.message.includes(leakedKey), 'API key must NEVER leak into readiness messages');

    // 6. INVALID_MODEL classification
    const invalidModel = await checkOcrReadiness({
      apiKey: 'AIzaSyValidKeyForModelCheck',
      model: 'gemini-9.9-nonexistent',
      liveVerify: true,
      forceRefresh: true,
      probeFn: async () => {
        throw new Error('404 models/gemini-9.9-nonexistent is not found');
      },
    });
    assert.equal(invalidModel.classification, 'INVALID_MODEL');
    assert.equal(invalidModel.OCR_PROVIDER_REACHABLE, true);
    assert.equal(invalidModel.OCR_MODEL_VALID, false);
    assert.equal(invalidModel.OCR_PRODUCTION_READY, false);

    // 7. QUOTA_ERROR classification
    const quotaErr = await checkOcrReadiness({
      apiKey: 'AIzaSyValidKeyForQuotaCheck',
      model: 'gemini-2.5-flash',
      liveVerify: true,
      forceRefresh: true,
      probeFn: async () => {
        throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
      },
    });
    assert.equal(quotaErr.classification, 'QUOTA_ERROR');
    assert.equal(quotaErr.OCR_PRODUCTION_READY, false);

    // 8. UNAVAILABLE classification
    const unavailErr = await checkOcrReadiness({
      apiKey: 'AIzaSyValidKeyForNetCheck',
      model: 'gemini-2.5-flash',
      liveVerify: true,
      forceRefresh: true,
      probeFn: async () => {
        throw new Error('ECONNREFUSED: upstream unreachable');
      },
    });
    assert.equal(unavailErr.classification, 'UNAVAILABLE');
    assert.equal(unavailErr.OCR_PROVIDER_REACHABLE, false);
    assert.equal(unavailErr.OCR_PRODUCTION_READY, false);
  });

  // =========================================================================
  // BUG 11 — Docker readiness validates worker/Dockerfile.production & package-manager consistency
  // =========================================================================
  it('[BUG 11] validates worker/Dockerfile.production without root Dockerfile, enforces package-manager consistency, and reports DOCKER_RUNTIME_NOT_AVAILABLE honestly', async () => {
    // 1. Repository verification must pass and validate multi-stage + worker:build + HEALTHCHECK + CMD + package-manager consistency
    const repoCheck = verifyWorkerPackageFiles(process.cwd());
    assert.equal(repoCheck.valid, true, repoCheck.details);
    assert.equal(repoCheck.dockerfileStructure.multiStageBuild, true);
    assert.equal(repoCheck.dockerfileStructure.runsWorkerBuild, true);
    assert.equal(repoCheck.dockerfileStructure.hasHealthcheck, true);
    assert.equal(repoCheck.dockerfileStructure.productionCmd, true);
    assert.equal(repoCheck.dockerfileStructure.noHardcodedSecrets, true);
    assert.equal(repoCheck.dockerfileStructure.packageManagerConsistent, true);

    // 2. Temporary workspace WITHOUT root Dockerfile must STILL validate cleanly
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-bug11-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'worker'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'src/backend'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'src/worker'), { recursive: true });
      for (const rel of [
        '.env.example',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'worker/Dockerfile.production',
        'worker/.dockerignore',
        'worker/.env.example',
        'worker/package.json',
        'worker/README.md',
        'src/worker/server.ts',
        'src/worker/official-acquisition-worker.ts',
        'src/worker/container-smoke-test.ts',
      ]) {
        fs.copyFileSync(path.resolve(process.cwd(), rel), path.join(tmpRoot, rel));
      }
      assert.equal(fs.existsSync(path.join(tmpRoot, 'Dockerfile')), false);
      const noRootCheck = verifyWorkerPackageFiles(tmpRoot);
      assert.equal(noRootCheck.valid, true, 'Must NOT require a root Dockerfile');
      assert.equal(noRootCheck.dockerfileStructure.noWildcardLockfileCopy, true);

      // Removing package-lock.json while worker/Dockerfile.production uses `npm ci` MUST fail package-manager consistency
      fs.unlinkSync(path.join(tmpRoot, 'package-lock.json'));
      const inconsistent = verifyWorkerPackageFiles(tmpRoot);
      assert.equal(inconsistent.valid, false);
      assert.equal(inconsistent.dockerfileStructure.packageManagerConsistent, false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // 3. Container smoke test in sandbox (without Docker) reports DOCKER_RUNTIME_NOT_AVAILABLE & DOCKER_BUILD_NOT_RUN
    const smoke = await runContainerSmokeTest();
    assert.equal(smoke.dockerfilePath, 'worker/Dockerfile.production');
    assert.equal(smoke.dockerfileVerified, true);
    if (!smoke.dockerRuntimeAvailable) {
      assert.equal(smoke.status, 'DOCKER_RUNTIME_NOT_AVAILABLE');
      assert.equal(smoke.dockerBuildStatus, 'DOCKER_BUILD_NOT_RUN');
      assert.equal(smoke.containerSmokeTest, 'NOT_RUN');
    }
  });

  // =========================================================================
  // BUG 13 — 7-flag truthful separation of code readiness vs external production proof
  // =========================================================================
  it('[BUG 13] exposes all 7 productionProof flags truthfully across ReadinessService, /api/health, /api/status, and /api/operations', async () => {
    initDatabase({ path: ':memory:', forceNew: true });
    bootstrapOfficialSources();
    resetOcrReadinessCache();

    const adminToken = 'bug13-proof-admin-token-456789';
    const app = createApiApp({
      auth: { authToken: adminToken },
      rateLimit: { windowMs: 60_000, maxPerIp: 1000, maxPerToken: 1000 },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const report = await evaluateSystemReadiness({
        remoteTimeoutMs: 500,
        skipDockerCliCheck: true,
      });

      assert.equal(report.productionProof.CODE_IMPLEMENTED, true);
      assert.equal(report.productionProof.RUNTIME_VERIFIED, true);
      assert.equal(report.productionProof.REAL_REMOTE_PRODUCTION_PROVEN, false);
      assert.equal(report.productionProof.REAL_WORDPRESS_PROVEN, false);
      assert.equal(report.productionProof.DOCKER_BUILD_PROVEN, false);
      assert.equal(report.productionProof.END_TO_END_PROVEN, false);
      assert.equal(report.PRODUCTION_PROVEN, false);

      // Even if OCR key is syntactically present (CONFIGURED_UNVERIFIED), OCR_PRODUCTION_READY and END_TO_END_PROVEN MUST remain false
      const unverifiedOcrReport = await evaluateSystemReadiness({
        remoteTimeoutMs: 500,
        skipDockerCliCheck: true,
        ocrReadinessOverride: {
          OCR_CONFIGURED: true,
          OCR_PROVIDER_REACHABLE: false,
          OCR_MODEL_VALID: false,
          OCR_PRODUCTION_READY: false,
          status: 'CONFIGURED_UNVERIFIED',
          classification: 'UNVERIFIED',
          provider: 'GEMINI_MULTIMODAL_OCR',
          model: 'gemini-2.5-flash',
          modelSyntaxValid: true,
          liveVerified: false,
          cached: false,
          checkedAt: new Date().toISOString(),
          latencyMs: null,
          errorCode: 'OCR_LIVE_VERIFICATION_NOT_RUN',
          message: 'Unverified',
        },
      });
      assert.equal(unverifiedOcrReport.dependencies.ocr.status, 'DEGRADED');
      assert.equal(unverifiedOcrReport.productionProof.END_TO_END_PROVEN, false);

      // Verify /api/health, /api/status, and /api/operations all expose identical production_proof flags
      const [hRes, sRes, oRes] = await Promise.all([
        fetch(`${baseUrl}/api/health`),
        fetch(`${baseUrl}/api/status`),
        fetch(`${baseUrl}/api/operations`, { headers: { Authorization: `Bearer ${adminToken}` } }),
      ]);
      assert.equal(hRes.status, 200);
      assert.equal(sRes.status, 200);
      assert.equal(oRes.status, 200);

      const h = (await hRes.json()) as { production_proof: Record<string, boolean> };
      const s = (await sRes.json()) as { production_proof: Record<string, boolean> };
      const o = (await oRes.json()) as { production_proof: Record<string, boolean> };

      assert.deepEqual(h.production_proof, s.production_proof);
      assert.deepEqual(s.production_proof, o.production_proof);
      assert.equal(h.production_proof.CODE_IMPLEMENTED, true);
      assert.equal(h.production_proof.END_TO_END_PROVEN, false);
      // /api/live (liveness) vs /api/ready (readiness) separation
      const liveRes = await fetch(`${baseUrl}/api/live`);
      assert.equal(liveRes.status, 200);
      const liveJson = (await liveRes.json()) as { status: string; probe: string };
      assert.equal(liveJson.status, 'alive');
      assert.equal(liveJson.probe, 'LIVENESS');

      const readyRes = await fetch(`${baseUrl}/api/ready`);
      const readyJson = (await readyRes.json()) as {
        probe: string;
        overall_readiness: string;
        production_proof: Record<string, boolean>;
      };
      assert.equal(readyJson.probe, 'READINESS');
      assert.equal(readyJson.production_proof.END_TO_END_PROVEN, false);
      assert.notEqual(readyJson.overall_readiness, 'READY');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
    }
  });
});
