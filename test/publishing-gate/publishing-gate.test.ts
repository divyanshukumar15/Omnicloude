/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';
import { PublishingGate } from '../../src/backend/publishing-gate/publishing-gate.ts';
import type { PublishingEvaluationTarget } from '../../src/backend/publishing-gate/types.ts';
import type { StructuredRecruitmentData } from '../../src/backend/extraction/types.ts';
import { createDefaultStructuredFields } from '../../src/backend/extraction/index.ts';
import { getPipelineEngine } from '../../src/backend/pipeline/index.ts';

function createValidCompleteFields(docId: string, pageText: string): StructuredRecruitmentData {
  const f = createDefaultStructuredFields('IN-CENTRAL-SSC', docId);

  f.organization.value = 'Staff Selection Commission';
  f.organization.state = 'VERIFIED';
  f.organization.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'organization',
    evidence_text: 'STAFF SELECTION COMMISSION',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.recruitment_title.value = 'Combined Graduate Level Examination 2026';
  f.recruitment_title.state = 'VERIFIED';
  f.recruitment_title.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'recruitment_title',
    evidence_text: 'COMBINED GRADUATE LEVEL EXAMINATION 2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.advertisement_number.value = '04/2026-CGL';
  f.advertisement_number.state = 'VERIFIED';
  f.advertisement_number.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'advertisement_number',
    evidence_text: 'Notice No. 04/2026-CGL',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.total_vacancies.value = 12000;
  f.total_vacancies.state = 'VERIFIED';
  f.total_vacancies.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'total_vacancies',
    evidence_text: 'Total Vacancies: Approximately 12000 vacancies',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.application_start_date.value = '2026-06-01';
  f.application_start_date.state = 'VERIFIED';
  f.application_start_date.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'application_start_date',
    evidence_text: 'Dates for submission of online applications: 01/06/2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.application_last_date.value = '2026-07-01';
  f.application_last_date.state = 'VERIFIED';
  f.application_last_date.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'application_last_date',
    evidence_text: 'Last date and time for receipt of online applications: 01/07/2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.educational_qualification.value = "Bachelor's Degree from a recognized University or equivalent";
  f.educational_qualification.state = 'VERIFIED';
  f.educational_qualification.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'educational_qualification',
    evidence_text: "Essential Educational Qualification: Bachelor's Degree from a recognized University",
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.age_min.value = 18;
  f.age_min.state = 'VERIFIED';
  f.age_min.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'age_min',
    evidence_text: 'Age limit: Minimum 18 years',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.age_max.value = 32;
  f.age_max.state = 'VERIFIED';
  f.age_max.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'age_max',
    evidence_text: 'Maximum 32 years as on 01/08/2026',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.selection_process.value = ['Computer Based Examination (Tier-I)', 'Tier-II', 'Document Verification'];
  f.selection_process.state = 'VERIFIED';
  f.selection_process.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'selection_process',
    evidence_text: 'Scheme of Examination: Computer Based Examination Tier-I and Tier-II',
    extraction_method: 'DIRECT_TEXT',
    verified_in_document: true,
  };

  f.official_notification_url.value = 'https://ssc.gov.in/notices/cgl-2026-notice.pdf';
  f.official_notification_url.state = 'VERIFIED';
  f.official_notification_url.evidence = {
    document_id: docId,
    page_number: 0,
    field_name: 'official_notification_url',
    evidence_text: 'https://ssc.gov.in/notices/cgl-2026-notice.pdf',
    extraction_method: 'DOCUMENT_METADATA',
    provenance_type: 'DOCUMENT_METADATA',
    verified_in_document: false,
    metadata_verified: true,
  };

  f.official_application_url.value = 'https://ssc.gov.in/portal/apply';
  f.official_application_url.state = 'VERIFIED';
  f.official_application_url.evidence = {
    document_id: docId,
    page_number: 1,
    field_name: 'official_application_url',
    evidence_text: 'Apply Online: https://ssc.gov.in/portal/apply',
    extraction_method: 'DIRECT_TEXT',
    provenance_type: 'PAGE_EVIDENCE',
    verified_in_document: true,
  };

  return f;
}

const SAMPLE_PAGE_1 = `
STAFF SELECTION COMMISSION
Notice No. 04/2026-CGL
COMBINED GRADUATE LEVEL EXAMINATION 2026
Dates for submission of online applications: 01/06/2026 to 01/07/2026
Last date and time for receipt of online applications: 01/07/2026 (23:00 hours)
Total Vacancies: Approximately 12000 vacancies are available for recruitment.
Essential Educational Qualification: Bachelor's Degree from a recognized University or equivalent.
Age limit: Minimum 18 years and Maximum 32 years as on 01/08/2026.
Scheme of Examination: Computer Based Examination Tier-I and Tier-II followed by Document Verification.
Official website: https://ssc.gov.in
Apply Online: https://ssc.gov.in/portal/apply
`;

describe('Phase 6 - Production-Grade Publishing Gate', () => {
  before(() => {
    initDatabase({ path: ':memory:' });
    const repos = getRepositories();

    // Seed test source
    repos.sources.create({
      id: 'IN-CENTRAL-SSC',
      name: 'Staff Selection Commission',
      type: 'PORTAL',
      base_url: 'https://ssc.gov.in',
      is_active: 1,
      check_interval_minutes: 60,
      config_json: '{}',
    });

    // Seed source document and document
    const sdoc = repos.sourceDocuments.create({
      id: 'sdoc-gate-ssc-cgl-2026',
      source_id: 'IN-CENTRAL-SSC',
      url: 'https://ssc.gov.in/notices/cgl-2026-notice.pdf',
      title: 'Combined Graduate Level Examination 2026',
      document_type: 'NOTIFICATION_PDF',
      raw_hash: null,
      status: 'DOWNLOADED',
      metadata_json: null,
    });

    repos.documents.create({
      id: 'doc-gate-ssc-cgl-2026',
      source_document_id: sdoc.id,
      source_url: 'https://ssc.gov.in/notices/cgl-2026-notice.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-2026-notice.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/ssc-cgl-2026.pdf',
      file_size: 245000,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: 'cglgatehash11111111111111111111111111111111111111111111111111111111',
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    repos.documents.savePages([
      {
        id: 'page-gate-cgl-01',
        document_id: 'doc-gate-ssc-cgl-2026',
        page_number: 1,
        char_count: SAMPLE_PAGE_1.length,
        extracted_text: SAMPLE_PAGE_1,
        extraction_method: 'DIRECT_TEXT',
        is_scanned: 0,
        quality_score: 1.0,
      },
    ]);
  });

  after(() => {
    closeDatabase();
  });

  // 1. VALID COMPLETE RECRUITMENT -> ALLOWED
  it('[PASS] should ALLOW a valid complete recruitment with verified evidence and set PUBLISH_READY', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';
    const fields = createValidCompleteFields(docId, SAMPLE_PAGE_1);

    const target: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-valid-complete',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      title: 'Combined Graduate Level Examination 2026',
      fields,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const result = await PublishingGate.evaluate(target);

    assert.equal(result.allowed, true, 'Valid complete recruitment must be allowed');
    assert.equal(result.blocked, false);
    assert.equal(result.state, 'PUBLISH_READY');
    assert.equal(result.critical_failures.length, 0);
    assert.equal(result.verification_summary.officialSourceIdentified, true);
    assert.equal(result.verification_summary.officialDocumentDownloaded, true);
    assert.equal(result.verification_summary.pdfValidationPassed, true);
    assert.equal(result.verification_summary.criticalEvidenceVerified, true);
    assert.equal(result.verification_summary.datesValid, true);
    assert.equal(result.verification_summary.noHallucinationsPresent, true);
  });

  // 2. MISSING CRITICAL FIELD -> BLOCKED (MISSING != VERIFIED)
  it('[PASS] should BLOCK recruitment when a critical field is missing (MISSING != VERIFIED)', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';
    const fields = createValidCompleteFields(docId, SAMPLE_PAGE_1);

    // Make application_last_date MISSING
    fields.application_last_date.value = null;
    fields.application_last_date.state = 'MISSING';
    fields.application_last_date.evidence = null;

    const target: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-missing-lastdate',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      title: 'Combined Graduate Level Examination 2026',
      fields,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const result = await PublishingGate.evaluate(target);

    assert.equal(result.allowed, false, 'Missing critical field must block publication');
    assert.equal(result.blocked, true);
    assert.equal(result.state, 'PUBLISH_BLOCKED');
    assert.ok(result.critical_failures.includes('APPLICATION_LAST_DATE_MISSING'));
    assert.ok(result.reasons.some((r) => r.includes('MISSING != VERIFIED')));
  });

  // 3. INVALID DATE -> BLOCKED
  it('[PASS] should BLOCK recruitment when calendar date is invalid or sequence is impossible', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';

    // Subtest A: Impossible calendar date (Feb 31)
    const fieldsA = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    fieldsA.application_last_date.value = '2026-02-31';

    const targetA: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-invalid-feb31',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsA,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultA = await PublishingGate.evaluate(targetA);
    assert.equal(resultA.allowed, false);
    assert.ok(resultA.critical_failures.includes('INVALID_CALENDAR_DATE'));

    // Subtest B: Start date AFTER last date
    const fieldsB = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    fieldsB.application_start_date.value = '2026-08-01';
    fieldsB.application_last_date.value = '2026-07-01';

    const targetB: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-date-sequence-conflict',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsB,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultB = await PublishingGate.evaluate(targetB);
    assert.equal(resultB.allowed, false);
    assert.equal(resultB.state, 'CONFLICT');
    assert.ok(resultB.critical_failures.includes('DATE_SEQUENCE_CONFLICT'));
  });

  // 4. MISSING EVIDENCE -> BLOCKED
  it('[PASS] should BLOCK recruitment when critical field lacks evidence or evidence is foreign', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';

    // Subtest A: Value present but evidence missing
    const fieldsA = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    fieldsA.total_vacancies.evidence = null;

    const targetA: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-no-evidence',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsA,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultA = await PublishingGate.evaluate(targetA);
    assert.equal(resultA.allowed, false);
    assert.ok(resultA.critical_failures.includes('CRITICAL_EVIDENCE_MISSING'));

    // Subtest B: Foreign document contamination in evidence
    const fieldsB = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    fieldsB.total_vacancies.evidence = {
      document_id: 'doc-foreign-upsc-csp',
      page_number: 1,
      field_name: 'total_vacancies',
      evidence_text: 'Total Vacancies: Approximately 12000 vacancies',
      extraction_method: 'DIRECT_TEXT',
      verified_in_document: true,
    };

    const targetB: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-foreign-evidence',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsB,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultB = await PublishingGate.evaluate(targetB);
    assert.equal(resultB.allowed, false);
    assert.ok(resultB.critical_failures.includes('EVIDENCE_FOREIGN_DOCUMENT_LINKED'));
  });

  // 5. DUPLICATE UNRESOLVED -> BLOCKED
  it('[PASS] should BLOCK recruitment when an unresolved duplicate decision exists', async () => {
    const repos = getRepositories();
    const docId = 'doc-gate-duplicate-target';

    // Seed document
    repos.documents.create({
      id: docId,
      source_document_id: 'sdoc-gate-ssc-cgl-2026',
      source_url: 'https://ssc.gov.in/notices/cgl-dup.pdf',
      canonical_url: 'https://ssc.gov.in/notices/cgl-dup.pdf',
      source_domain: 'ssc.gov.in',
      file_path: '/tmp/cgl-dup.pdf',
      file_size: 245000,
      page_count: 1,
      mime_type: 'application/pdf',
      sha256_hash: 'duphash11111111111111111111111111111111111111111111111111111111',
      storage_uri: null,
      validation_status: 'VALID',
      validation_notes: null,
      extraction_status: 'EXTRACTED',
      extraction_method: 'DIRECT_TEXT',
      is_scanned: 0,
    });

    // Record an unresolved duplicate decision
    repos.deduplicationEvaluations.create({
      id: 'eval-dup-unresolved-01',
      incoming_document_id: docId,
      matched_document_id: 'doc-gate-ssc-cgl-2026',
      matched_recruitment_id: 'rec-gate-valid-complete',
      decision: 'DUPLICATE_DOCUMENT',
      confidence: 1.0,
      matched_fields_json: JSON.stringify(['sha256_hash']),
      reason: 'Exact duplicate by SHA-256 hash',
      details_json: null,
    });

    const fields = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    const target: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-dup-blocked',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const result = await PublishingGate.evaluate(target);

    assert.equal(result.allowed, false);
    assert.equal(result.state, 'REJECTED');
    assert.ok(result.critical_failures.includes('DUPLICATE_UNRESOLVED'));
  });

  // 6. CORRIGENDUM CONFLICT -> BLOCKED
  it('[PASS] should BLOCK recruitment when corrigendum conflict exists with unresolvable amendment', async () => {
    const repos = getRepositories();
    const docId = 'doc-gate-ssc-cgl-2026';
    const recId = 'rec-gate-corrigendum-conflict';

    // Seed recruitment
    repos.recruitments.create({
      id: recId,
      source_id: 'IN-CENTRAL-SSC',
      document_id: docId,
      title: 'Combined Graduate Level Examination 2026',
      department: 'Staff Selection Commission',
      notification_number: '04/2026-CGL',
      total_vacancies: 12000,
      application_start_date: '2026-06-01',
      application_end_date: '2026-07-01',
      raw_payload_json: null,
      status: 'DRAFT',
    });

    // Add a conflicting corrigendum association with impossible date
    repos.corrigendumAssociations.create({
      id: 'corr-assoc-conflict-01',
      original_recruitment_id: recId,
      corrigendum_document_id: docId,
      related_document_id: docId,
      amendment_type: 'DATE_EXTENSION',
      updated_field: 'application_last_date',
      source_page: 1,
      old_value: '2026-07-01',
      new_value: '2026-02-31',
      evidence_snippet: 'Extended date: 31/02/2026',
      effective_date: '2026-02-31',
      created_at: new Date().toISOString(),
    });

    const fields = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    const target: PublishingEvaluationTarget = {
      recruitmentId: recId,
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const result = await PublishingGate.evaluate(target);

    assert.equal(result.allowed, false);
    assert.equal(result.state, 'CONFLICT');
    assert.ok(result.critical_failures.includes('CORRIGENDUM_CONFLICT_UNRESOLVED'));
  });

  // 7. HALLUCINATED VALUE -> BLOCKED
  it('[PASS] should BLOCK recruitment when a field has a hallucinated value not found in official document', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';
    const fields = createValidCompleteFields(docId, SAMPLE_PAGE_1);

    // Educational qualification has a snippet that is fabricated and never existed on page 1
    fields.educational_qualification.value = 'Ph.D. in Aeronautical Engineering required';
    fields.educational_qualification.evidence = {
      document_id: docId,
      page_number: 1,
      field_name: 'educational_qualification',
      evidence_text: 'Ph.D. in Aeronautical Engineering with 10 years experience',
      extraction_method: 'DIRECT_TEXT',
      verified_in_document: false,
    };

    const target: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-hallucination',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const result = await PublishingGate.evaluate(target);

    assert.equal(result.allowed, false);
    assert.ok(result.critical_failures.includes('HALLUCINATED_FIELD_DETECTED'));
    assert.equal(result.verification_summary.noHallucinationsPresent, false);
  });

  // 8. VALID NOT_APPLICABLE FIELD -> ALLOWED IF PROPERLY EVIDENCED
  it('[PASS] should ALLOW recruitment with properly evidenced NOT_APPLICABLE fields and block if reason missing', async () => {
    const docId = 'doc-gate-ssc-cgl-2026';

    // Subtest A: NOT_APPLICABLE with valid verified reason -> ALLOWED
    const fieldsA = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    // Deputation post with no upper age limit
    fieldsA.age_max.value = null;
    fieldsA.age_max.state = 'NOT_APPLICABLE';
    fieldsA.age_max.notApplicableReason = 'No upper age limit prescribed for this cadre under official service rules';

    // Offline recruitment without online portal
    fieldsA.official_application_url.value = null;
    fieldsA.official_application_url.state = 'NOT_APPLICABLE';
    fieldsA.official_application_url.notApplicableReason = 'Physical application form only; to be submitted via registered post';

    const targetA: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-not-applicable-valid',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsA,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultA = await PublishingGate.evaluate(targetA);
    assert.equal(resultA.allowed, true, 'Properly evidenced NOT_APPLICABLE fields must be allowed');
    assert.equal(resultA.state, 'PUBLISH_READY');
    assert.equal(resultA.verification_summary.fieldsSummary.age_max.state, 'NOT_APPLICABLE');

    // Subtest B: NOT_APPLICABLE without reason -> BLOCKED
    const fieldsB = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    fieldsB.age_max.value = null;
    fieldsB.age_max.state = 'NOT_APPLICABLE';
    fieldsB.age_max.notApplicableReason = ''; // Missing mandatory reason!

    const targetB: PublishingEvaluationTarget = {
      recruitmentId: 'rec-gate-not-applicable-no-reason',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: fieldsB,
      pages: [{ pageNumber: 1, extractedText: SAMPLE_PAGE_1 }],
    };

    const resultB = await PublishingGate.evaluate(targetB);
    assert.equal(resultB.allowed, false);
    assert.ok(resultB.critical_failures.includes('NOT_APPLICABLE_WITHOUT_REASON'));
  });

  // 9. CORRECTED RECRUITMENT BECOMES PUBLISHABLE AFTER REVALIDATION
  it('[PASS] should transition recruitment from PUBLISH_BLOCKED to PUBLISH_READY after revalidation', async () => {
    const repos = getRepositories();
    const docId = 'doc-gate-ssc-cgl-2026';
    const recId = 'rec-gate-lifecycle-transition';

    // Create initial flawed recruitment missing application last date
    const initialFields = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    initialFields.application_last_date.value = null;
    initialFields.application_last_date.state = 'MISSING';
    initialFields.application_last_date.evidence = null;

    repos.recruitments.create({
      id: recId,
      source_id: 'IN-CENTRAL-SSC',
      document_id: docId,
      title: 'Combined Graduate Level Examination 2026',
      department: 'Staff Selection Commission',
      notification_number: '04/2026-CGL',
      total_vacancies: 12000,
      application_start_date: '2026-06-01',
      application_end_date: null,
      raw_payload_json: JSON.stringify({ fields: initialFields }),
      status: 'DRAFT',
    });

    // Step 1: Initial evaluation -> BLOCKED
    const initialResult = await PublishingGate.evaluateAndTransition(recId);
    assert.equal(initialResult.allowed, false);
    assert.equal(initialResult.state, 'PUBLISH_BLOCKED');
    assert.ok(initialResult.critical_failures.includes('APPLICATION_LAST_DATE_MISSING'));

    // Verify DB was updated to PUBLISH_BLOCKED
    const recInDb1 = repos.recruitments.findById(recId)!;
    assert.equal(recInDb1.status, 'PUBLISH_BLOCKED');

    // Step 2: Fix flaw by correcting the recruitment fields with verified evidence
    const correctedFields = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    repos.recruitments.update(recId, {
      application_end_date: '2026-07-01',
      raw_payload_json: JSON.stringify({ fields: correctedFields }),
    });

    // Step 3: Re-evaluate using recheck()
    const correctedResult = await PublishingGate.recheck(recId);
    assert.equal(correctedResult.allowed, true);
    assert.equal(correctedResult.state, 'PUBLISH_READY');
    assert.equal(correctedResult.critical_failures.length, 0);

    // Verify DB was updated to PUBLISH_READY
    const recInDb2 = repos.recruitments.findById(recId)!;
    assert.equal(recInDb2.status, 'PUBLISH_READY');

    // Verify publishing gate evaluations table logged both decisions
    const evals = repos.publishingGateEvaluations.findByRecruitment(recId);
    assert.equal(evals.length, 2);
    assert.equal(evals[0].decision, 'ALLOWED'); // latest
    assert.equal(evals[1].decision, 'BLOCKED'); // first
  });

  // 10. PIPELINE INTEGRATION
  it('[PASS] should block pipeline execution at PUBLISHING_GATE stage if recruitment fails gate', async () => {
    const engine = getPipelineEngine();
    const docId = 'doc-gate-ssc-cgl-2026';

    const flawedFields = createValidCompleteFields(docId, SAMPLE_PAGE_1);
    flawedFields.organization.value = null;
    flawedFields.organization.state = 'MISSING';

    const target: PublishingEvaluationTarget = {
      recruitmentId: 'rec-pipeline-gate-test',
      sourceId: 'IN-CENTRAL-SSC',
      documentId: docId,
      fields: flawedFields,
    };

    const handler = engine.getHandler('PUBLISHING_GATE');
    assert.ok(handler);

    const { logger } = await import('../../src/backend/config/logger.ts');
    const { getAuditService } = await import('../../src/backend/audit/index.ts');

    const result = await handler.execute({ target }, {
      jobId: 'job-pipeline-test-01',
      correlationId: 'corr-pipeline-gate-01',
      targetEntityType: 'RECRUITMENT',
      targetEntityId: 'rec-pipeline-gate-test',
      metadata: {},
      logger,
      auditService: getAuditService(),
    });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'PUBLISHING_GATE_BLOCKED');
  });
});
