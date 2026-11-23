/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';
import { DeduplicationService } from '../../src/backend/deduplication/deduplication-service.ts';
import { MultiLevelSimilarityEngine } from '../../src/backend/deduplication/similarity-engine.ts';
import { TextFingerprinter } from '../../src/backend/deduplication/fingerprint.ts';
import type { NormalizedDocument } from '../../src/backend/ingestion/types.ts';
import type { StructuredRecruitmentRecord, StructuredRecruitmentData } from '../../src/backend/extraction/types.ts';

function createMockStructuredRecruitment(params: {
  documentId: string;
  sourceId: string;
  organization: string;
  title: string;
  advertisementNumber: string | null;
  totalVacancies: number | null;
  applicationStartDate: string | null;
  applicationLastDate: string | null;
  examDate?: string | null;
}): StructuredRecruitmentRecord {
  const fields: Partial<StructuredRecruitmentData> = {
    organization: {
      value: params.organization,
      state: 'VERIFIED',
      confidence: 1.0,
      evidence: {
        document_id: params.documentId,
        page_number: 1,
        field_name: 'organization',
        evidence_text: params.organization,
        extraction_method: 'DIRECT_TEXT',
        verified_in_document: true,
      },
    },
    recruitment_title: {
      value: params.title,
      state: 'VERIFIED',
      confidence: 1.0,
      evidence: {
        document_id: params.documentId,
        page_number: 1,
        field_name: 'recruitment_title',
        evidence_text: params.title,
        extraction_method: 'DIRECT_TEXT',
        verified_in_document: true,
      },
    },
    advertisement_number: {
      value: params.advertisementNumber,
      state: params.advertisementNumber ? 'VERIFIED' : 'MISSING',
      confidence: params.advertisementNumber ? 1.0 : 0.0,
      evidence: params.advertisementNumber
        ? {
            document_id: params.documentId,
            page_number: 1,
            field_name: 'advertisement_number',
            evidence_text: params.advertisementNumber,
            extraction_method: 'DIRECT_TEXT',
            verified_in_document: true,
          }
        : null,
    },
    total_vacancies: {
      value: params.totalVacancies,
      state: params.totalVacancies ? 'VERIFIED' : 'MISSING',
      confidence: params.totalVacancies ? 1.0 : 0.0,
      evidence: params.totalVacancies
        ? {
            document_id: params.documentId,
            page_number: 1,
            field_name: 'total_vacancies',
            evidence_text: `Total Vacancies: ${params.totalVacancies}`,
            extraction_method: 'DIRECT_TEXT',
            verified_in_document: true,
          }
        : null,
    },
    application_start_date: {
      value: params.applicationStartDate,
      state: params.applicationStartDate ? 'VERIFIED' : 'MISSING',
      confidence: params.applicationStartDate ? 1.0 : 0.0,
      evidence: params.applicationStartDate
        ? {
            document_id: params.documentId,
            page_number: 1,
            field_name: 'application_start_date',
            evidence_text: `Start Date: ${params.applicationStartDate}`,
            extraction_method: 'DIRECT_TEXT',
            verified_in_document: true,
          }
        : null,
    },
    application_last_date: {
      value: params.applicationLastDate,
      state: params.applicationLastDate ? 'VERIFIED' : 'MISSING',
      confidence: params.applicationLastDate ? 1.0 : 0.0,
      evidence: params.applicationLastDate
        ? {
            document_id: params.documentId,
            page_number: 1,
            field_name: 'application_last_date',
            evidence_text: `Last Date: ${params.applicationLastDate}`,
            extraction_method: 'DIRECT_TEXT',
            verified_in_document: true,
          }
        : null,
    },
    exam_date: {
      value: params.examDate || null,
      state: params.examDate ? 'VERIFIED' : 'MISSING',
      confidence: params.examDate ? 1.0 : 0.0,
      evidence: params.examDate
        ? {
            document_id: params.documentId,
            page_number: 1,
            field_name: 'exam_date',
            evidence_text: `Exam Date: ${params.examDate}`,
            extraction_method: 'DIRECT_TEXT',
            verified_in_document: true,
          }
        : null,
    },
  };

  return {
    id: `rec-${params.documentId}`,
    sourceId: params.sourceId,
    documentId: params.documentId,
    overallStatus: 'VERIFIED',
    isCorrigendum: false,
    languageDetected: 'ENGLISH',
    fields: fields as StructuredRecruitmentData,
    extractionTimestamp: new Date().toISOString(),
    auditTrail: [],
  };
}

describe('Phase 5 - Complex Duplicate, Near-Duplicate and Corrigendum Detection Tests', () => {
  let dedupService: DeduplicationService;

  before(() => {
    initDatabase({ path: ':memory:', forceNew: true });
    dedupService = new DeduplicationService();
    const repos = getRepositories();

    // Seed test sources
    const sources = [
      { id: 'IN-CENTRAL-SSC', name: 'Staff Selection Commission', type: 'PORTAL' as const, base_url: 'https://ssc.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-CENTRAL-UPSC', name: 'Union Public Service Commission', type: 'PORTAL' as const, base_url: 'https://upsc.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-BIHAR-BPSC', name: 'Bihar Public Service Commission', type: 'PORTAL' as const, base_url: 'https://bpsc.bih.nic.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-UP-UPPSC', name: 'Uttar Pradesh Public Service Commission', type: 'PORTAL' as const, base_url: 'https://uppsc.up.nic.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-UP-UPSSSC', name: 'Uttar Pradesh Subordinate Services Selection Commission', type: 'PORTAL' as const, base_url: 'https://upsssc.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
    ];
    for (const s of sources) {
      if (!repos.sources.findById(s.id)) repos.sources.create(s);
    }

    // Seed Primary Base Recruitment 1: SSC CGL 2026
    const sdoc1 = repos.sourceDocuments.create({
      id: 'doc-ssc-cgl-2026',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      title: 'Combined Graduate Level Examination 2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADED',
      metadata_json: null,
    });

    repos.documents.create({
      id: 'doc-ssc-cgl-2026',
      source_document_id: sdoc1.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/cgl-2026.pdf',
      file_size: 154200,
      page_count: 50,
      mime_type: 'application/pdf',
      sha256_hash: 'cgl2026hash11111111111111111111111111111111111111111111111111111111',
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    repos.recruitments.create({
      id: 'rec-ssc-cgl-2026',
      source_id: 'IN-CENTRAL-SSC',
      document_id: 'doc-ssc-cgl-2026',
      title: 'Combined Graduate Level Examination 2026',
      department: 'Staff Selection Commission',
      notification_number: '04/2026-CGL',
      total_vacancies: 12000,
      application_start_date: '2026-06-01',
      application_end_date: '2026-07-01',
      raw_payload_json: JSON.stringify({
        fields: {
          exam_date: { value: '2026-09-15' },
        },
      }),
    });

    repos.evidence.create({
      id: 'ev-cgl-lastdate-orig',
      entity_type: 'RECRUITMENT',
      entity_id: 'rec-ssc-cgl-2026',
      field_name: 'application_last_date',
      source_document_id: 'doc-ssc-cgl-2026',
      snippet: 'Closing date for receipt of online application: 01/07/2026',
      page_number: 1,
      confidence_score: 1.0,
      bounding_box_json: null,
    });

    // Seed Primary Base Recruitment 2: UPSC Civil Services 2026
    const sdoc2 = repos.sourceDocuments.create({
      id: 'doc-upsc-csp-2026',
      source_id: 'IN-CENTRAL-UPSC',
      url: 'https://upsc.gov.in/notices/csp-2026.pdf',
      title: 'Civil Services Examination 2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADED',
      metadata_json: null,
    });

    repos.documents.create({
      id: 'doc-upsc-csp-2026',
      source_document_id: sdoc2.id,
      source_url: 'https://upsc.gov.in/notices/csp-2026.pdf',
      canonical_url: 'https://upsc.gov.in/notices/csp-2026.pdf',
      source_domain: 'upsc.gov.in',
      file_path: '/tmp/csp-2026.pdf',
      file_size: 210500,
      page_count: 85,
      mime_type: 'application/pdf',
      sha256_hash: 'upsccsp2026hash22222222222222222222222222222222222222222222222222222',
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    repos.recruitments.create({
      id: 'rec-upsc-csp-2026',
      source_id: 'IN-CENTRAL-UPSC',
      document_id: 'doc-upsc-csp-2026',
      title: 'Civil Services Examination 2026',
      department: 'Union Public Service Commission',
      notification_number: '05/2026-CSP',
      total_vacancies: 1056,
      application_start_date: '2026-02-01',
      application_end_date: '2026-02-21',
      raw_payload_json: JSON.stringify({
        fields: {
          exam_date: { value: '2026-05-24' },
        },
      }),
    });
  });

  after(() => {
    closeDatabase();
  });

  // 1. EXACT DUPLICATE PDF (Level 1: Exact Checksum Match)
  it('[PASS] should detect exact duplicate PDF by SHA-256 checksum with 1.0 confidence', async () => {
    const incomingDoc: NormalizedDocument = {
      id: 'doc-incoming-exact-dup',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/cgl-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'cgl2026hash11111111111111111111111111111111111111111111111111111111',
      fileSize: 154200,
      pageCount: 50,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [],
      qualityMetadata: { totalCharacters: 5000, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 50, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const decision = await dedupService.evaluateDocument(incomingDoc);

    assert.equal(decision.decision, 'DUPLICATE_DOCUMENT');
    assert.equal(decision.confidence, 1.0);
    assert.ok(decision.matched_fields.includes('checksum_sha256'));
    assert.equal(decision.source_documents.matchedDocumentId, 'doc-ssc-cgl-2026');
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-ssc-cgl-2026');
    assert.ok(decision.reason.includes('Exact binary SHA-256 hash match'));

    // Apply decision must suppress creation
    const result = await dedupService.applyDecision(decision, incomingDoc);
    assert.equal(result.applied, true);
    assert.equal(result.actionTaken, 'DUPLICATE_SUPPRESSED_NO_NEW_RECRUITMENT');
  });

  // 2. SAME PDF FROM DIFFERENT URL (Mirror Link / Level 1)
  it('[PASS] should detect same PDF downloaded from different/mirrored URL', async () => {
    const mirrorDoc: NormalizedDocument = {
      id: 'doc-incoming-mirror-url',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://regional.ssc.gov.in/mirrors/notices/cgl_2026_copy.pdf',
      canonicalUrl: 'https://regional.ssc.gov.in/mirrors/notices/cgl_2026_copy.pdf',
      sourceDomain: 'regional.ssc.gov.in',
      checksumSha256: 'cgl2026hash11111111111111111111111111111111111111111111111111111111',
      fileSize: 154200,
      pageCount: 50,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [],
      qualityMetadata: { totalCharacters: 5000, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 50, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const decision = await dedupService.evaluateDocument(mirrorDoc);

    assert.equal(decision.decision, 'DUPLICATE_DOCUMENT');
    assert.equal(decision.confidence, 1.0);
    assert.ok(decision.matched_fields.includes('mirrored_url'));
    assert.ok(decision.reason.includes('Mirrored official PDF downloaded from alternate URL'));
    assert.equal(decision.source_documents.matchedDocumentId, 'doc-ssc-cgl-2026');
  });

  // 3. SAME RECRUITMENT DIFFERENT PDF (Level 2 & 3: Characteristics & Fingerprint Match)
  it('[PASS] should detect same recruitment in different PDF (reformatted/compressed) as DUPLICATE_RECRUITMENT', async () => {
    const diffPdfDoc: NormalizedDocument = {
      id: 'doc-ssc-cgl-diff-pdf',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/portal/re-exported-cgl.pdf',
      canonicalUrl: 'https://ssc.gov.in/portal/re-exported-cgl.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'newchecksumdiffpdf999999999999999999999999999999999999999999999999',
      fileSize: 160000,
      pageCount: 52,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-ssc-cgl-diff-pdf',
          pageNumber: 1,
          extractedText: 'Staff Selection Commission Combined Graduate Level Examination 2026 Notice 04/2026-CGL Vacancies: 12000 Last Date: 2026-07-01',
          charCount: 125,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 125, avgCharsPerPage: 125, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: diffPdfDoc.id,
      sourceId: 'IN-CENTRAL-SSC',
      organization: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026',
      advertisementNumber: '04/2026-CGL',
      totalVacancies: 12000,
      applicationStartDate: '2026-06-01',
      applicationLastDate: '2026-07-01',
    });

    const decision = await dedupService.evaluateDocument(diffPdfDoc, structured);

    assert.equal(decision.decision, 'DUPLICATE_RECRUITMENT');
    assert.ok(decision.confidence >= 0.95);
    assert.ok(decision.matched_fields.includes('organization'));
    assert.ok(decision.matched_fields.includes('advertisement_number'));
    assert.ok(decision.matched_fields.includes('total_vacancies'));
    assert.ok(decision.matched_fields.includes('application_last_date'));
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-ssc-cgl-2026');
  });

  // 4. MIRRORED PDF
  it('[PASS] should detect mirrored official PDF from secondary official domain', async () => {
    const cdnMirrorDoc: NormalizedDocument = {
      id: 'doc-upsc-cdn-mirror',
      sourceId: 'IN-CENTRAL-UPSC',
      sourceUrl: 'https://cdn.nic.in/upsc/csp-2026-mirror.pdf',
      canonicalUrl: 'https://cdn.nic.in/upsc/csp-2026-mirror.pdf',
      sourceDomain: 'cdn.nic.in',
      checksumSha256: 'upsccsp2026hash22222222222222222222222222222222222222222222222222222',
      fileSize: 210500,
      pageCount: 85,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [],
      qualityMetadata: { totalCharacters: 5000, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 85, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const decision = await dedupService.evaluateDocument(cdnMirrorDoc);

    assert.equal(decision.decision, 'DUPLICATE_DOCUMENT');
    assert.equal(decision.confidence, 1.0);
    assert.ok(decision.matched_fields.includes('mirrored_url'));
    assert.equal(decision.source_documents.matchedDocumentId, 'doc-upsc-csp-2026');
  });

  // 5. OFFICIAL CORRIGENDUM (Linking to parent & preserving both evidence snippets)
  it('[PASS] should identify official corrigendum, link to parent recruitment, and preserve original evidence', async () => {
    const corrigendumDoc: NormalizedDocument = {
      id: 'doc-cgl-corrigendum-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/corrigendum-cgl-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/corrigendum-cgl-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'corrigendumcglhash333333333333333333333333333333333333333333333333',
      fileSize: 32000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'CORRIGENDUM_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-cgl-corrigendum-01',
          pageNumber: 1,
          extractedText: `
STAFF SELECTION COMMISSION
CORRIGENDUM / AMENDMENT NOTICE
Ref: Combined Graduate Level Examination, 2026 (Advt No. 04/2026-CGL)

It is hereby informed that the closing date for submission of online application has been extended.
Revised Last Date: 15/07/2026
          `.trim(),
          charCount: 220,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 220, avgCharsPerPage: 220, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: corrigendumDoc.id,
      sourceId: 'IN-CENTRAL-SSC',
      organization: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026 Corrigendum',
      advertisementNumber: '04/2026-CGL',
      totalVacancies: null,
      applicationStartDate: null,
      applicationLastDate: '2026-07-15',
    });

    const decision = await dedupService.evaluateDocument(corrigendumDoc, structured);

    assert.equal(decision.decision, 'RELATED_CORRIGENDUM');
    assert.ok(decision.confidence >= 0.9);
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-ssc-cgl-2026');
    assert.equal(decision.field_mutations.length, 1);

    const dateMutation = decision.field_mutations[0];
    assert.equal(dateMutation.field_name, 'application_last_date');
    assert.equal(dateMutation.original_value, '2026-07-01');
    assert.equal(dateMutation.new_value, '2026-07-15');
    assert.equal(dateMutation.effective_change, 'EXTENSION_OF_LAST_DATE');

    // Apply decision to database
    const appResult = await dedupService.applyDecision(decision, corrigendumDoc, structured);
    assert.equal(appResult.applied, true);

    const repos = getRepositories();
    // 1. Verify parent recruitment was updated with latest date
    const updatedParent = repos.recruitments.findById('rec-ssc-cgl-2026')!;
    assert.equal(updatedParent.application_end_date, '2026-07-15');

    // 2. Verify corrigendum association record was stored
    const associations = repos.corrigendumAssociations.listByOriginalRecruitment('rec-ssc-cgl-2026');
    assert.ok(associations.length > 0);
    assert.equal(associations[0].updated_field, 'application_last_date');
    assert.equal(associations[0].old_value, '2026-07-01');
    assert.equal(associations[0].new_value, '2026-07-15');

    // 3. STRICT REQUIREMENT: Verify BOTH original and new evidence exist (never overwritten!)
    const allEvidence = repos.evidence.listByEntity('RECRUITMENT', 'rec-ssc-cgl-2026');
    const originalEv = allEvidence.find((e) => e.source_document_id === 'doc-ssc-cgl-2026');
    const corrigendumEv = allEvidence.find((e) => e.source_document_id === 'doc-cgl-corrigendum-01');

    assert.ok(originalEv, 'Original evidence must remain in evidence table');
    assert.ok(corrigendumEv, 'New corrigendum evidence must be inserted alongside original evidence');
    assert.ok(originalEv.snippet.includes('01/07/2026'));
  });

  // 6. OFFICIAL ADDENDUM
  it('[PASS] should detect official addendum with addendum keywords and link to parent recruitment', async () => {
    const addendumDoc: NormalizedDocument = {
      id: 'doc-upsc-addendum-01',
      sourceId: 'IN-CENTRAL-UPSC',
      sourceUrl: 'https://upsc.gov.in/notices/addendum-csp-2026.pdf',
      canonicalUrl: 'https://upsc.gov.in/notices/addendum-csp-2026.pdf',
      sourceDomain: 'upsc.gov.in',
      checksumSha256: 'addendumcsp2026hash444444444444444444444444444444444444444444444444',
      fileSize: 45000,
      pageCount: 2,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'ADDENDUM_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-upsc-addendum-01',
          pageNumber: 1,
          extractedText: `
UNION PUBLIC SERVICE COMMISSION
ADDENDUM TO NOTICE NO. 05/2026-CSP (CIVIL SERVICES EXAMINATION, 2026)
Reference is invited to the Commission's Notice dated 01/02/2026.
Government has decided to include additional vacancies under Indian Forest Service.
          `.trim(),
          charCount: 250,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 250, avgCharsPerPage: 250, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: addendumDoc.id,
      sourceId: 'IN-CENTRAL-UPSC',
      organization: 'Union Public Service Commission',
      title: 'Civil Services Examination 2026 Addendum',
      advertisementNumber: '05/2026-CSP',
      totalVacancies: 1150,
      applicationStartDate: '2026-02-01',
      applicationLastDate: '2026-02-21',
    });

    const decision = await dedupService.evaluateDocument(addendumDoc, structured);

    assert.equal(decision.decision, 'RELATED_ADDENDUM');
    assert.ok(decision.confidence >= 0.9);
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-upsc-csp-2026');
  });

  // 7. EXTENSION NOTICE (Hindi & English)
  it('[PASS] should detect extension notice in Hindi (तिथि विस्तार) and record date mutation', async () => {
    const extensionDoc: NormalizedDocument = {
      id: 'doc-hindi-extension-01',
      sourceId: 'IN-CENTRAL-UPSC',
      sourceUrl: 'https://upsc.gov.in/notices/date-extension-hindi.pdf',
      canonicalUrl: 'https://upsc.gov.in/notices/date-extension-hindi.pdf',
      sourceDomain: 'upsc.gov.in',
      checksumSha256: 'hindiextensionhash555555555555555555555555555555555555555555555555',
      fileSize: 28000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'EXTENSION_NOTICE',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-hindi-extension-01',
          pageNumber: 1,
          extractedText: `
संघ लोक सेवा आयोग
शुद्धिपत्र / तिथि विस्तार सूचना
सन्दर्भ: सिविल सेवा परीक्षा 2026 (विज्ञापन संख्या: 05/2026-CSP)

ऑनलाइन आवेदन भरने की अंतिम तिथि विस्तार कर 05/03/2026 निर्धारित की जाती है।
          `.trim(),
          charCount: 180,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 180, avgCharsPerPage: 180, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: extensionDoc.id,
      sourceId: 'IN-CENTRAL-UPSC',
      organization: 'संघ लोक सेवा आयोग',
      title: 'सिविल सेवा परीक्षा 2026 तिथि विस्तार',
      advertisementNumber: '05/2026-CSP',
      totalVacancies: null,
      applicationStartDate: null,
      applicationLastDate: '2026-03-05',
    });

    const decision = await dedupService.evaluateDocument(extensionDoc, structured);

    assert.equal(decision.decision, 'RELATED_CORRIGENDUM');
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-upsc-csp-2026');
    assert.equal(decision.field_mutations.length, 1);
    assert.equal(decision.field_mutations[0].effective_change, 'EXTENSION_OF_LAST_DATE');
    assert.equal(decision.field_mutations[0].new_value, '2026-03-05');
  });

  // 8. REVISED VACANCY NOTICE
  it('[PASS] should detect revised vacancy notice and record mutation retaining original vacancies', async () => {
    const revisedVacDoc: NormalizedDocument = {
      id: 'doc-cgl-revised-vacancies',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/cgl-revised-vacancies.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/cgl-revised-vacancies.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'revisedvachash6666666666666666666666666666666666666666666666666666',
      fileSize: 42000,
      pageCount: 2,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'CORRIGENDUM_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-cgl-revised-vacancies',
          pageNumber: 1,
          extractedText: `
STAFF SELECTION COMMISSION
NOTICE FOR REVISED VACANCIES / PARTIAL MODIFICATION
Combined Graduate Level Examination 2026 (Advt No. 04/2026-CGL)

The vacancies reported for CGL 2026 have been revised.
Total Revised Vacancies: 14250.
          `.trim(),
          charCount: 220,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 220, avgCharsPerPage: 220, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: revisedVacDoc.id,
      sourceId: 'IN-CENTRAL-SSC',
      organization: 'Staff Selection Commission',
      title: 'Combined Graduate Level Examination 2026 Revised Vacancies',
      advertisementNumber: '04/2026-CGL',
      totalVacancies: 14250,
      applicationStartDate: '2026-06-01',
      applicationLastDate: '2026-07-01',
    });

    const decision = await dedupService.evaluateDocument(revisedVacDoc, structured);

    assert.equal(decision.decision, 'RELATED_CORRIGENDUM');
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-ssc-cgl-2026');

    const vacMutation = decision.field_mutations.find((m) => m.field_name === 'total_vacancies');
    assert.ok(vacMutation);
    assert.equal(vacMutation.original_value, 12000);
    assert.equal(vacMutation.new_value, 14250);
    assert.equal(vacMutation.effective_change, 'VACANCY_REVISION');
  });

  // 9. REVISED EXAM DATE
  it('[PASS] should detect rescheduled exam date and record exam date mutation', async () => {
    const examRescheduleDoc: NormalizedDocument = {
      id: 'doc-upsc-exam-rescheduled',
      sourceId: 'IN-CENTRAL-UPSC',
      sourceUrl: 'https://upsc.gov.in/notices/csp-exam-rescheduled.pdf',
      canonicalUrl: 'https://upsc.gov.in/notices/csp-exam-rescheduled.pdf',
      sourceDomain: 'upsc.gov.in',
      checksumSha256: 'examreschedulehash777777777777777777777777777777777777777777777777',
      fileSize: 31000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'CORRIGENDUM_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-upsc-exam-rescheduled',
          pageNumber: 1,
          extractedText: `
UNION PUBLIC SERVICE COMMISSION
CORRIGENDUM / RESCHEDULED EXAMINATION NOTICE
Civil Services Examination 2026 (Advt No. 05/2026-CSP)

The Civil Services (Preliminary) Examination 2026 has been rescheduled due to unavoidable circumstances.
Revised Examination Date: 14/06/2026.
          `.trim(),
          charCount: 240,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 240, avgCharsPerPage: 240, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: examRescheduleDoc.id,
      sourceId: 'IN-CENTRAL-UPSC',
      organization: 'Union Public Service Commission',
      title: 'Civil Services Examination 2026 Exam Rescheduled',
      advertisementNumber: '05/2026-CSP',
      totalVacancies: null,
      applicationStartDate: null,
      applicationLastDate: null,
      examDate: '2026-06-14',
    });

    const decision = await dedupService.evaluateDocument(examRescheduleDoc, structured);

    assert.equal(decision.decision, 'RELATED_CORRIGENDUM');
    assert.equal(decision.source_documents.matchedRecruitmentId, 'rec-upsc-csp-2026');

    const examMutation = decision.field_mutations.find((m) => m.field_name === 'exam_date');
    assert.ok(examMutation);
    assert.equal(examMutation.new_value, '2026-06-14');
    assert.equal(examMutation.effective_change, 'EXAM_RESCHEDULED');
  });

  // 10. UNRELATED RECRUITMENT WITH SIMILAR TITLE (Same organization, different batches/years)
  it('[PASS] should classify same organization but distinct advertisement/year as UNRELATED', async () => {
    const sscChslDoc: NormalizedDocument = {
      id: 'doc-ssc-chsl-2026',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notices/chsl-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notices/chsl-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'chsl2026hash8888888888888888888888888888888888888888888888888888',
      fileSize: 180000,
      pageCount: 60,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-ssc-chsl-2026',
          pageNumber: 1,
          extractedText: 'Staff Selection Commission Combined Higher Secondary (10+2) Level Examination 2026 Notice 06/2026-CHSL Vacancies: 3712',
          charCount: 130,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 130, avgCharsPerPage: 130, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: sscChslDoc.id,
      sourceId: 'IN-CENTRAL-SSC',
      organization: 'Staff Selection Commission',
      title: 'Combined Higher Secondary (10+2) Level Examination 2026',
      advertisementNumber: '06/2026-CHSL',
      totalVacancies: 3712,
      applicationStartDate: '2026-04-01',
      applicationLastDate: '2026-05-01',
    });

    const decision = await dedupService.evaluateDocument(sscChslDoc, structured);

    // Must be classified as a completely new/unrelated recruitment!
    assert.equal(decision.decision, 'NEW_RECRUITMENT');
    assert.equal(decision.source_documents.matchedRecruitmentId, undefined);
  });

  // 11. TWO DIFFERENT ORGANIZATIONS WITH SIMILAR RECRUITMENT NAMES
  it('[PASS] should strictly classify recruitments from two different organizations with identical titles as UNRELATED', async () => {
    // Bihar Public Service Commission conducting "Civil Services Examination 2026"
    const bpscDoc: NormalizedDocument = {
      id: 'doc-bpsc-civil-services',
      sourceId: 'IN-BIHAR-BPSC',
      sourceUrl: 'https://bpsc.bih.nic.in/notices/bpsc-cce-2026.pdf',
      canonicalUrl: 'https://bpsc.bih.nic.in/notices/bpsc-cce-2026.pdf',
      sourceDomain: 'bpsc.bih.nic.in',
      checksumSha256: 'bpscccehash9999999999999999999999999999999999999999999999999999',
      fileSize: 140000,
      pageCount: 30,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        {
          documentId: 'doc-bpsc-civil-services',
          pageNumber: 1,
          extractedText: 'बिहार लोक सेवा आयोग (BPSC) Civil Services Examination 2026 विज्ञापन संख्या 70/2026 कुल पद 1957',
          charCount: 95,
          extractionMethod: 'DIRECT_TEXT',
          isScanned: false,
        },
      ],
      qualityMetadata: { totalCharacters: 95, avgCharsPerPage: 95, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const structured = createMockStructuredRecruitment({
      documentId: bpscDoc.id,
      sourceId: 'IN-BIHAR-BPSC',
      organization: 'Bihar Public Service Commission',
      title: 'Civil Services Examination 2026', // Identical title to UPSC Civil Services!
      advertisementNumber: '70/2026-CCE',
      totalVacancies: 1957,
      applicationStartDate: '2026-09-01',
      applicationLastDate: '2026-09-30',
    });

    const decision = await dedupService.evaluateDocument(bpscDoc, structured);

    // CRITICAL ACCEPTANCE CRITERIA:
    // Even though both have title "Civil Services Examination 2026", organizations are different (BPSC vs UPSC).
    // MUST NOT be classified as duplicate!
    assert.equal(decision.decision, 'NEW_RECRUITMENT');
    assert.equal(decision.source_documents.matchedRecruitmentId, undefined);
  });

  // 12. Text Fingerprint and SimHash Determinism Verification
  it('[PASS] should compute identical SimHashes for identical text and detect high similarity for minor whitespace edits', () => {
    const textA = 'Government of India Staff Selection Commission Combined Graduate Level Examination 2026 Notice with 12000 vacancies';
    const textB = 'Government of India Staff Selection Commission Combined Graduate Level Examination 2026 Notice with 12000 vacancies';
    const textC = 'Government of India, Staff Selection Commission: Combined Graduate Level Examination 2026 Notice with 12000 vacancies.';

    const hashA = TextFingerprinter.computeSimHash(textA);
    const hashB = TextFingerprinter.computeSimHash(textB);
    const hashC = TextFingerprinter.computeSimHash(textC);

    assert.equal(hashA, hashB, 'Identical texts must produce identical SimHash');
    assert.equal(TextFingerprinter.simHashSimilarity(hashA, hashB), 1.0);

    // Punctuation and formatting differences should still maintain > 0.95 similarity
    const simAC = TextFingerprinter.compareText(textA, textC);
    assert.ok(simAC >= 0.95, `Expected similarity >= 0.95, got ${simAC}`);
  });
});
