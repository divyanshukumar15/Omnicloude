/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DateValidator } from '../../src/backend/extraction/date-validator.ts';
import { EvidenceValidator } from '../../src/backend/extraction/evidence-validator.ts';
import { DeterministicFieldValidator } from '../../src/backend/extraction/field-validator.ts';
import { CorrigendumDetector } from '../../src/backend/extraction/corrigendum-detector.ts';
import { StructuredExtractionService } from '../../src/backend/extraction/extraction-service.ts';
import type { NormalizedDocument, NormalizedPage } from '../../src/backend/ingestion/types.ts';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';

describe('Production-Grade Government Job Extraction & Evidence Verification Tests', () => {
  before(() => {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();

    // Seed mock sources
    const sources = [
      { id: 'IN-CENTRAL-SSC', name: 'Staff Selection Commission', type: 'PORTAL' as const, base_url: 'https://ssc.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-BIHAR-BPSC', name: 'Bihar Public Service Commission', type: 'PORTAL' as const, base_url: 'https://bpsc.bih.nic.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-UP-UPPSC', name: 'Uttar Pradesh Public Service Commission', type: 'PORTAL' as const, base_url: 'https://uppsc.up.nic.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-CENTRAL-UPSC', name: 'Union Public Service Commission', type: 'PORTAL' as const, base_url: 'https://upsc.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
      { id: 'IN-CENTRAL-RRB', name: 'Railway Recruitment Boards', type: 'PORTAL' as const, base_url: 'https://indianrailways.gov.in', is_active: 1, check_interval_minutes: 60, config_json: '{}' },
    ];
    for (const s of sources) {
      repos.sources.create(s);
    }

    // Seed mock documents to satisfy foreign keys
    const testDocIds = [
      'doc-complete-eng-01',
      'doc-hindi-01',
      'doc-mixed-01',
      'doc-missing-date-01',
      'doc-invalid-date-01',
      'doc-conflict-date-01',
      'doc-vacancy-01',
      'doc-fee-01',
      'doc-age-01',
      'doc-qual-01',
      'doc-no-evidence-01',
      'doc-hallucination-01',
      'doc-contamination-01',
      'doc-corrigendum-01',
      'doc-optional-missing-01',
    ];

    for (const dId of testDocIds) {
      const sId = dId.includes('hindi') ? 'IN-BIHAR-BPSC' : dId.includes('mixed') ? 'IN-UP-UPPSC' : 'IN-CENTRAL-SSC';
      const docHash = crypto.createHash('sha256').update(dId).digest('hex');
      repos.sourceDocuments.create({
        id: `sdoc-${dId}`,
        source_id: sId,
        url: `https://example.gov.in/${dId}.pdf`,
        title: `Notice ${dId}`,
        document_type: 'PDF',
        raw_hash: docHash.slice(0, 12),
        status: 'DISCOVERED',
        metadata_json: '{}',
      });
      repos.documents.create({
        id: dId,
        source_document_id: `sdoc-${dId}`,
        source_url: `https://example.gov.in/${dId}.pdf`,
        canonical_url: `https://example.gov.in/${dId}.pdf`,
        source_domain: 'example.gov.in',
        file_path: `/data/${dId}.pdf`,
        file_size: 20000,
        page_count: 2,
        mime_type: 'application/pdf',
        sha256_hash: docHash,
        storage_uri: `file:///data/${dId}.pdf`,
        validation_status: 'VALID',
        validation_notes: null,
        extraction_status: 'EXTRACTED',
        extraction_method: 'DIRECT_TEXT',
        is_scanned: 0,
      });
    }
  });

  after(() => {
    closeDatabase();
  });

  const extractionService = new StructuredExtractionService();

  // 1. Complete English Notification
  it('[PASS] should extract complete English notification with all fields and verified evidence', async () => {
    const page1Text = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Advt. No. 04/2026-CGL
      Total Vacancies: 1450
      Dates for submission of online applications: 01/03/2026 to 31/03/2026
      Last date and time for receipt of online applications: 31/03/2026
      Dates of window for Application Form Correction: 05/04/2026 to 07/04/2026
      Schedule of Tier-I Examination: June 2026
    `;

    const page2Text = `
      UR: 650, OBC: 380, SC: 220, ST: 110, EWS: 90
      Application Fee: ₹100/- (Women candidates and candidates belonging to SC/ST/PwD are exempted)
      Age Limit: 18 to 27 years as on 01/01/2026
      Educational Qualification: Bachelor's Degree from a recognized University
      Pay Level: Pay Level-7 (₹44,900 to ₹1,42,400)
      Negative marking of 0.50 marks for each wrong answer in Tier-I
    `;

    const doc: NormalizedDocument = {
      id: 'doc-complete-eng-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/notice-cgl-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/notice-cgl-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
      fileSize: 45000,
      pageCount: 2,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-complete-eng-01', pageNumber: 1, extractedText: page1Text, charCount: page1Text.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
        { documentId: 'doc-complete-eng-01', pageNumber: 2, extractedText: page2Text, charCount: page2Text.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: 800, avgCharsPerPage: 400, scannedPageCount: 0, textPageCount: 2, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.languageDetected, 'ENGLISH');
    assert.equal(record.fields.organization.value, 'Staff Selection Commission');
    assert.equal(record.fields.organization.state, 'VERIFIED');
    assert.ok(record.fields.organization.evidence?.verified_in_document);
    assert.equal(record.fields.advertisement_number.value, '04/2026-CGL');
    assert.equal(record.fields.total_vacancies.value, 1450);
    assert.equal(record.fields.application_last_date.value, '2026-03-31');
    assert.equal(record.overallStatus, 'VERIFIED');
  });

  // 2. Hindi Notification
  it('[PASS] should extract Hindi notification accurately preserving Devanagari text and dates', async () => {
    const hindiText = `
      बिहार लोक सेवा आयोग
      विज्ञापन संख्या: 02/2026
      सहायक प्राध्यापक भर्ती 2026
      कुल पद: 850
      अनारक्षित: 350, अन्य पिछड़ा वर्ग: 230
      आवेदन प्रारंभ तिथि: 10/02/2026
      आवेदन की अंतिम तिथि: 25/02/2026
      आवेदन शुल्क: ₹200/- (महिला एवं आरक्षित वर्ग के लिए छूट)
      आयु सीमा: 21 से 37 वर्ष
      शैक्षणिक योग्यता: स्नातकोत्तर डिग्री एवं नेट परीक्षा उत्तीर्ण
      वेतनमान: पे लेवल-10
    `;

    const doc: NormalizedDocument = {
      id: 'doc-hindi-01',
      sourceId: 'IN-BIHAR-BPSC',
      sourceUrl: 'https://bpsc.bih.nic.in/advt-02-2026.pdf',
      canonicalUrl: 'https://bpsc.bih.nic.in/advt-02-2026.pdf',
      sourceDomain: 'bpsc.bih.nic.in',
      checksumSha256: 'hindi9876543210abcdef0123456789abcdef0123456789abcdef0123456789ab',
      fileSize: 32000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'STATE_ADVERTISEMENT_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-hindi-01', pageNumber: 1, extractedText: hindiText, charCount: hindiText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: hindiText.length, avgCharsPerPage: hindiText.length, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.languageDetected, 'HINDI');
    assert.equal(record.fields.organization.value, 'बिहार लोक सेवा आयोग');
    assert.equal(record.fields.organization.state, 'VERIFIED');
    assert.ok(record.fields.recruitment_title.value?.includes('सहायक प्राध्यापक भर्ती'));
    assert.equal(record.fields.advertisement_number.value, '02/2026');
    assert.equal(record.fields.total_vacancies.value, 850);
    assert.equal(record.fields.application_last_date.value, '2026-02-25');
    assert.ok(record.fields.educational_qualification.value?.includes('स्नातकोत्तर'));
    assert.equal(record.overallStatus, 'VERIFIED');
  });

  // 3. Mixed Hindi/English Notification
  it('[PASS] should extract mixed Hindi/English notification without text loss', async () => {
    const mixedText = `
      Uttar Pradesh Public Service Commission
      Advt. No. A-1/E-1/2026
      सहायक लेखाकार भर्ती 2026
      Total Vacancies: 350
      Last date and time for receipt of online applications: 20/05/2026
      Educational Qualification: वाणिज्य में स्नातक डिग्री (Bachelor of Commerce)
      Age Limit: 21 to 40 years
      Application Fee: ₹125
    `;

    const doc: NormalizedDocument = {
      id: 'doc-mixed-01',
      sourceId: 'IN-UP-UPPSC',
      sourceUrl: 'https://uppsc.up.nic.in/mixed.pdf',
      canonicalUrl: 'https://uppsc.up.nic.in/mixed.pdf',
      sourceDomain: 'uppsc.up.nic.in',
      checksumSha256: 'mixed1234567890abcdef0123456789abcdef0123456789abcdef0123456789ab',
      fileSize: 25000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-mixed-01', pageNumber: 1, extractedText: mixedText, charCount: mixedText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: mixedText.length, avgCharsPerPage: mixedText.length, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.languageDetected, 'BILINGUAL');
    assert.equal(record.fields.organization.value, 'Uttar Pradesh Public Service Commission');
    assert.ok(record.fields.recruitment_title.value?.includes('सहायक लेखाकार भर्ती'));
    assert.equal(record.fields.advertisement_number.value, 'A-1/E-1/2026');
    assert.equal(record.fields.total_vacancies.value, 350);
    assert.ok(record.fields.educational_qualification.value?.includes('वाणिज्य में स्नातक'));
    assert.equal(record.overallStatus, 'VERIFIED');
  });

  // 4. Missing Application Date
  it('[PASS] should mark overall status as PARTIALLY_VERIFIED when application last date is missing', async () => {
    const textWithoutDate = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Advt. No. 05/2026-CGL
      Total Vacancies: 900
      Educational Qualification: Bachelor's Degree from a recognized University
      Note: Dates of application will be intimated on the website separately.
    `;

    const doc: NormalizedDocument = {
      id: 'doc-missing-date-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/nodate.pdf',
      canonicalUrl: 'https://ssc.gov.in/nodate.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'nodatehash1234567890abcdef0123456789abcdef0123456789abcdef0123456',
      fileSize: 18000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-missing-date-01', pageNumber: 1, extractedText: textWithoutDate, charCount: textWithoutDate.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: textWithoutDate.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.fields.application_last_date.value, null);
    assert.equal(record.fields.application_last_date.state, 'MISSING');
    // Because application_last_date is a critical field, missing it results in PARTIALLY_VERIFIED, NOT REJECTED
    assert.equal(record.overallStatus, 'PARTIALLY_VERIFIED');
  });

  // 5. Invalid Date Rejection (Calendar validation)
  it('[PASS] should reject impossible calendar dates with INVALID state', async () => {
    // 31st February is impossible
    const feb31 = DateValidator.parseAndValidate('31/02/2026');
    assert.equal(feb31.isValid, false);
    assert.equal(feb31.errorCode, 'IMPOSSIBLE_CALENDAR_DATE');

    // 31st April is impossible
    const apr31 = DateValidator.parseAndValidate('31/04/2026');
    assert.equal(apr31.isValid, false);
    assert.equal(apr31.errorCode, 'IMPOSSIBLE_CALENDAR_DATE');

    // 29th February in non-leap year 2025 is impossible
    const feb29NonLeap = DateValidator.parseAndValidate('29/02/2025');
    assert.equal(feb29NonLeap.isValid, false);
    assert.equal(feb29NonLeap.errorCode, 'NON_LEAP_YEAR_FEB_29');

    // Notification containing impossible calendar date
    const impossibleDateText = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Advt. No. 06/2026-CGL
      Total Vacancies: 800
      Last date and time for receipt of online applications: 31/02/2026
    `;

    const doc: NormalizedDocument = {
      id: 'doc-invalid-date-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/invalid-date.pdf',
      canonicalUrl: 'https://ssc.gov.in/invalid-date.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'invaliddatehash1234567890abcdef0123456789abcdef0123456789abcdef01',
      fileSize: 15000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-invalid-date-01', pageNumber: 1, extractedText: impossibleDateText, charCount: impossibleDateText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: impossibleDateText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);
    assert.equal(record.fields.application_last_date.state, 'INVALID');
    assert.equal(record.overallStatus, 'REJECTED');
  });

  // 6. Conflicting Dates Test
  it('[PASS] should detect conflicting dates when application_start_date is after application_last_date', async () => {
    const contradictoryDateText = `
      Union Public Service Commission
      Combined Central Services Examination 2026
      Total Vacancies: 500
      Online application starts: 25/03/2026
      Last date for submission of applications: 10/03/2026
    `;

    const doc: NormalizedDocument = {
      id: 'doc-conflict-date-01',
      sourceId: 'IN-CENTRAL-UPSC',
      sourceUrl: 'https://upsc.gov.in/conflict.pdf',
      canonicalUrl: 'https://upsc.gov.in/conflict.pdf',
      sourceDomain: 'upsc.gov.in',
      checksumSha256: 'conflicthash1234567890abcdef0123456789abcdef0123456789abcdef01234',
      fileSize: 12000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-conflict-date-01', pageNumber: 1, extractedText: contradictoryDateText, charCount: contradictoryDateText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: contradictoryDateText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.fields.application_start_date.state, 'CONFLICT');
    assert.equal(record.fields.application_last_date.state, 'CONFLICT');
    assert.equal(record.overallStatus, 'CONFLICT');
  });

  // 7. Vacancy Extraction & Negative Vacancy Rejection
  it('[PASS] should extract valid vacancies and reject negative vacancy values as INVALID', async () => {
    const vacancyText = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Total Vacancies: 2450
      UR: 1000, OBC: 600
    `;

    const doc: NormalizedDocument = {
      id: 'doc-vacancy-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/vacancy.pdf',
      canonicalUrl: 'https://ssc.gov.in/vacancy.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'vacancyhash1234567890abcdef0123456789abcdef0123456789abcdef012345',
      fileSize: 12000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-vacancy-01', pageNumber: 1, extractedText: vacancyText, charCount: vacancyText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: vacancyText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);
    assert.equal(record.fields.total_vacancies.value, 2450);
    assert.equal(record.fields.total_vacancies.state, 'VERIFIED');

    // Test rejection of negative vacancies
    record.fields.total_vacancies.value = -100;
    const issues = DeterministicFieldValidator.validateAll(record.fields, doc.id, doc.pages);
    assert.equal(record.fields.total_vacancies.state, 'INVALID');
    assert.ok(issues.some((i) => i.field === 'total_vacancies' && i.type === 'INVALID'));
  });

  // 8. Fee Extraction & Negative Fee Rejection
  it('[PASS] should extract fee details and reject negative fee values as INVALID', async () => {
    const feeText = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Application Fee: ₹250 (Exempted for Women and SC/ST)
    `;

    const doc: NormalizedDocument = {
      id: 'doc-fee-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/fee.pdf',
      canonicalUrl: 'https://ssc.gov.in/fee.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'feehash1234567890abcdef0123456789abcdef0123456789abcdef0123456789a',
      fileSize: 10000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-fee-01', pageNumber: 1, extractedText: feeText, charCount: feeText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: feeText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);
    assert.equal(record.fields.application_fee.value?.unreserved, 250);

    // Test rejection of negative application fee
    record.fields.application_fee.value = { unreserved: -50 };
    const issues = DeterministicFieldValidator.validateAll(record.fields, doc.id, doc.pages);
    assert.equal(record.fields.application_fee.state, 'INVALID');
    assert.ok(issues.some((i) => i.field === 'application_fee' && i.type === 'INVALID'));
  });

  // 9. Age Extraction & Age Limit Conflict Check
  it('[PASS] should extract age limits and detect conflict when age_min exceeds age_max', async () => {
    const ageText = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Age Limit: 18 to 30 years
    `;

    const doc: NormalizedDocument = {
      id: 'doc-age-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/age.pdf',
      canonicalUrl: 'https://ssc.gov.in/age.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'agehash1234567890abcdef0123456789abcdef0123456789abcdef0123456789ab',
      fileSize: 10000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-age-01', pageNumber: 1, extractedText: ageText, charCount: ageText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: ageText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);
    assert.equal(record.fields.age_min.value, 18);
    assert.equal(record.fields.age_max.value, 30);

    // Injected conflict where age_min > age_max
    record.fields.age_min.value = 35;
    record.fields.age_max.value = 25;
    const issues = DeterministicFieldValidator.validateAll(record.fields, doc.id, doc.pages);
    assert.equal(record.fields.age_min.state, 'CONFLICT');
    assert.equal(record.fields.age_max.state, 'CONFLICT');
    assert.ok(issues.some((i) => i.field === 'age_min' && i.type === 'CONFLICT'));
  });

  // 10. Qualification Extraction
  it('[PASS] should extract educational qualifications preserving exact official snippet evidence', async () => {
    const qualText = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Educational Qualification: Bachelor's Degree from a recognized University or Institute
    `;

    const doc: NormalizedDocument = {
      id: 'doc-qual-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/qual.pdf',
      canonicalUrl: 'https://ssc.gov.in/qual.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'qualhash1234567890abcdef0123456789abcdef0123456789abcdef0123456789a',
      fileSize: 10000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-qual-01', pageNumber: 1, extractedText: qualText, charCount: qualText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: qualText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);
    assert.ok(record.fields.educational_qualification.value?.includes("Bachelor's Degree"));
    assert.equal(record.fields.educational_qualification.state, 'VERIFIED');
    assert.ok(record.fields.educational_qualification.evidence?.evidence_text.includes("Bachelor's Degree"));
  });

  // 11. Evidence Missing Check
  it('[PASS] should reject verification when evidence is missing for an extracted field', () => {
    const pages: NormalizedPage[] = [
      { documentId: 'doc-no-evidence-01', pageNumber: 1, extractedText: 'Some text', charCount: 9, extractionMethod: 'DIRECT_TEXT', isScanned: false },
    ];

    const result = EvidenceValidator.verifySnippetOnPage(null, pages);
    assert.equal(result.verified, false);
    assert.equal(result.failureReason, 'NO_EVIDENCE_PROVIDED');
  });

  // 12. Hallucinated Value Rejection & Stripping
  it('[PASS] should protect against hallucinated values and strip unevidenced facts', async () => {
    const pages: NormalizedPage[] = [
      {
        documentId: 'doc-hallucination-01',
        pageNumber: 1,
        extractedText: 'Official Notice: Combined Graduate Level Examination 2026. Advt. No. 04/2026.',
        charCount: 75,
        extractionMethod: 'DIRECT_TEXT',
        isScanned: false,
      },
    ];

    // Simulating an AI producing a fabricated result_date with hallucinated snippet
    const mockFields = {
      organization: extractionService.createMissingField<string>(),
      recruitment_title: extractionService.createMissingField<string>(),
      advertisement_number: extractionService.createMissingField<string>(),
      recruitment_type: extractionService.createMissingField<string>(),
      total_vacancies: extractionService.createMissingField<number>(),
      category_wise_vacancies: extractionService.createMissingField<any>(),
      application_start_date: extractionService.createMissingField<string>(),
      application_last_date: extractionService.createMissingField<string>(),
      correction_last_date: extractionService.createMissingField<string>(),
      exam_date: extractionService.createMissingField<string>(),
      admit_card_date: extractionService.createMissingField<string>(),
      result_date: {
        value: '2026-12-30',
        state: 'EXTRACTED' as const,
        confidence: 0.99,
        evidence: {
          document_id: 'doc-hallucination-01',
          page_number: 1,
          field_name: 'result_date',
          evidence_text: 'Fabricated: Final merit list will be published on 30 December 2026',
          extraction_method: 'DIRECT_TEXT' as const,
          verified_in_document: false,
        },
      },
      application_fee: extractionService.createMissingField<any>(),
      age_min: extractionService.createMissingField<number>(),
      age_max: extractionService.createMissingField<number>(),
      age_relaxation: extractionService.createMissingField<any>(),
      educational_qualification: extractionService.createMissingField<string>(),
      experience: extractionService.createMissingField<string>(),
      salary_pay_level: extractionService.createMissingField<string>(),
      selection_process: extractionService.createMissingField<any>(),
      exam_pattern: extractionService.createMissingField<string>(),
      negative_marking: extractionService.createMissingField<string>(),
      syllabus: extractionService.createMissingField<string>(),
      required_documents: extractionService.createMissingField<string[]>(),
      important_instructions: extractionService.createMissingField<string[]>(),
      official_notification_url: extractionService.createMissingField<string>(),
      official_application_url: extractionService.createMissingField<string>(),
    };

    // Filter hallucinations
    const stripped = EvidenceValidator.filterHallucinations(mockFields, pages, 'doc-hallucination-01');
    assert.equal(stripped.length, 1);
    assert.equal(stripped[0].field, 'result_date');
    assert.equal(mockFields.result_date.value, null);
    assert.equal(mockFields.result_date.state, 'MISSING');
    assert.equal(mockFields.result_date.evidence, null);
  });

  // 13. Cross-Recruitment Contamination Check
  it('[PASS] should detect and reject cross-recruitment contamination from other documents', async () => {
    const pages: NormalizedPage[] = [
      {
        documentId: 'doc-contamination-01',
        pageNumber: 1,
        extractedText: 'Staff Selection Commission. Notice 04/2026-CGL.',
        charCount: 50,
        extractionMethod: 'DIRECT_TEXT',
        isScanned: false,
      },
    ];

    const contaminatedField = {
      value: 5000,
      state: 'EXTRACTED' as const,
      confidence: 0.95,
      evidence: {
        document_id: 'doc-foreign-job-999', // Foreign document ID from another recruitment!
        page_number: 1,
        field_name: 'total_vacancies',
        evidence_text: 'Total Vacancies: 5000',
        extraction_method: 'DIRECT_TEXT' as const,
        verified_in_document: false,
      },
    };

    const mockFields: any = {
      organization: extractionService.createMissingField<string>(),
      recruitment_title: extractionService.createMissingField<string>(),
      advertisement_number: extractionService.createMissingField<string>(),
      recruitment_type: extractionService.createMissingField<string>(),
      total_vacancies: contaminatedField,
      category_wise_vacancies: extractionService.createMissingField<any>(),
      application_start_date: extractionService.createMissingField<string>(),
      application_last_date: extractionService.createMissingField<string>(),
      correction_last_date: extractionService.createMissingField<string>(),
      exam_date: extractionService.createMissingField<string>(),
      admit_card_date: extractionService.createMissingField<string>(),
      result_date: extractionService.createMissingField<string>(),
      application_fee: extractionService.createMissingField<any>(),
      age_min: extractionService.createMissingField<number>(),
      age_max: extractionService.createMissingField<number>(),
      age_relaxation: extractionService.createMissingField<any>(),
      educational_qualification: extractionService.createMissingField<string>(),
      experience: extractionService.createMissingField<string>(),
      salary_pay_level: extractionService.createMissingField<string>(),
      selection_process: extractionService.createMissingField<any>(),
      exam_pattern: extractionService.createMissingField<string>(),
      negative_marking: extractionService.createMissingField<string>(),
      syllabus: extractionService.createMissingField<string>(),
      required_documents: extractionService.createMissingField<string[]>(),
      important_instructions: extractionService.createMissingField<string[]>(),
      official_notification_url: extractionService.createMissingField<string>(),
      official_application_url: extractionService.createMissingField<string>(),
    };

    const issues = DeterministicFieldValidator.validateAll(mockFields, 'doc-contamination-01', pages);
    assert.ok(issues.some((i) => i.field === 'total_vacancies' && i.type === 'CONTAMINATION'));
    assert.equal(mockFields.total_vacancies.state, 'INVALID');
  });

  // 14. Corrigendum-Related Document
  it('[PASS] should identify corrigendum-related documents without overwriting parent evidence', async () => {
    const corrigendumText = `
      Staff Selection Commission
      CORRIGENDUM
      Reference: Notice No. 04/2026-CGL
      Subject: Extension of Last Date for Submission of Online Applications
      It is hereby informed that the last date and time for submission of online applications
      for Combined Graduate Level Examination 2026 has been extended till 15/04/2026.
    `;

    const doc: NormalizedDocument = {
      id: 'doc-corrigendum-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/corrigendum-cgl-2026.pdf',
      canonicalUrl: 'https://ssc.gov.in/corrigendum-cgl-2026.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'corrigendumhash1234567890abcdef0123456789abcdef0123456789abcdef01',
      fileSize: 8500,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'CORRIGENDUM_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-corrigendum-01', pageNumber: 1, extractedText: corrigendumText, charCount: corrigendumText.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: corrigendumText.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    assert.equal(record.isCorrigendum, true);
    assert.equal(record.relatedRecruitmentId, '04/2026-CGL');
    assert.equal(record.fields.application_last_date.value, '2026-04-15');

    // Verify corrigendum association was persisted in database
    const repos = getRepositories();
    const associations = repos.corrigendumAssociations.listByCorrigendumDocument('doc-corrigendum-01');
    assert.ok(associations.length > 0);
    assert.equal(associations[0].updated_field, 'application_last_date');
    assert.equal(associations[0].new_value, '2026-04-15');
  });

  // 15. Optional Field Missing
  it('[PASS] should allow VERIFIED status when optional fields are missing but critical fields are verified', async () => {
    const textWithOptionalMissing = `
      Staff Selection Commission
      Notice: Combined Graduate Level Examination 2026
      Advt. No. 08/2026-CGL
      Total Vacancies: 600
      Last date and time for receipt of online applications: 25/04/2026
      Educational Qualification: Bachelor's Degree from a recognized University
    `;

    const doc: NormalizedDocument = {
      id: 'doc-optional-missing-01',
      sourceId: 'IN-CENTRAL-SSC',
      sourceUrl: 'https://ssc.gov.in/opt-missing.pdf',
      canonicalUrl: 'https://ssc.gov.in/opt-missing.pdf',
      sourceDomain: 'ssc.gov.in',
      checksumSha256: 'optmissinghash1234567890abcdef0123456789abcdef0123456789abcdef01',
      fileSize: 10000,
      pageCount: 1,
      discoveryTimestamp: new Date().toISOString(),
      downloadTimestamp: new Date().toISOString(),
      documentType: 'NOTIFICATION_PDF',
      extractionStatus: 'EXTRACTED',
      extractionMethod: 'DIRECT_TEXT',
      isScanned: false,
      pages: [
        { documentId: 'doc-optional-missing-01', pageNumber: 1, extractedText: textWithOptionalMissing, charCount: textWithOptionalMissing.length, extractionMethod: 'DIRECT_TEXT', isScanned: false },
      ],
      qualityMetadata: { totalCharacters: textWithOptionalMissing.length, avgCharsPerPage: 100, scannedPageCount: 0, textPageCount: 1, isScannedDocument: false, extractionMethod: 'DIRECT_TEXT' },
    };

    const record = await extractionService.extractRecruitment(doc);

    // Optional fields must be null & MISSING without hallucinated values
    assert.equal(record.fields.syllabus.value, null);
    assert.equal(record.fields.syllabus.state, 'MISSING');
    assert.equal(record.fields.exam_date.value, null);
    assert.equal(record.fields.exam_date.state, 'MISSING');
    assert.equal(record.fields.negative_marking.value, null);
    assert.equal(record.fields.negative_marking.state, 'MISSING');

    // All critical fields are present and verified => VERIFIED status achieved
    assert.equal(record.overallStatus, 'VERIFIED');
  });
});
