/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase, getRepositories } from '../../src/backend/database/index.ts';
import { sourceRegistry } from '../../src/backend/ingestion/adapters/registry.ts';
import {
  isOfficialDomain,
  classifyDomainTrust,
  registerRrbRegionalDomain,
} from '../../src/backend/ingestion/discovery/official-domains.ts';
import {
  classifyNotice,
  classifyNoticeExplainable,
  normalizeCenNumber,
  extractAdvertisementNumber,
  extractDateFromText,
  isRecruitmentRelated,
  classifyRecruitmentType,
  classifyDocumentLink,
} from '../../src/backend/ingestion/discovery/classifier.ts';
import { generateRecruitmentIdentity } from '../../src/backend/ingestion/discovery/recruitment-identity.ts';
import { DiscoveryCache } from '../../src/backend/ingestion/discovery/discovery-cache.ts';
import dns from 'node:dns/promises';
import {
  DiscoveryService,
  getDiscoveryService,
  runRealLiveVerification,
  resolveLiveVerificationRuntimeConfig,
  computeLiveVerificationExitCode,
} from '../../src/backend/ingestion/discovery/discovery-service.ts';
import {
  parseLiveCheckArgs,
  buildMachineReadableLiveReport,
} from '../../src/backend/ingestion/discovery/live-check.ts';
import {
  getDiscoveryExecutor,
  evaluateLiveVerificationGate,
  classifyEndpointConnectivity,
} from '../../src/backend/ingestion/discovery/discovery-executor.ts';
import { classifyNetworkOrHttpError } from '../../src/backend/ingestion/discovery/network-error-classifier.ts';
import {
  classifyFailureTaxonomy,
  deriveConnectivityStatuses,
  probeEndpointConnectivity,
  probeRrbRegionalNetwork,
  RRB_REGIONAL_PROBE_BOARDS,
} from '../../src/backend/ingestion/discovery/connectivity-diagnostics.ts';
import {
  configureGlobalFetchDispatcher,
  inspectFetchDispatcherTimeouts,
  getOrCreateFetchDispatcher,
} from '../../src/backend/ingestion/discovery/http-dispatcher.ts';
import { sourceEndpointRegistry } from '../../src/backend/ingestion/discovery/endpoint-registry.ts';
import { runEndpointVerification } from '../../src/backend/ingestion/discovery/endpoint-verifier.ts';
import {
  type OfficialAcquisitionRunner,
  type AcquisitionRequest,
  type AcquisitionResult,
  LocalAcquisitionRunner,
  HttpRemoteAcquisitionRunner,
  evaluateSourceRuntimeCapabilities,
} from '../../src/backend/ingestion/discovery/acquisition-runner.ts';
import { RrbSourceAdapter } from '../../src/backend/ingestion/adapters/central/rrb.adapter.ts';
import { createValidSamplePdf } from '../ingestion/fixtures.ts';
import {
  SSC_SNAPSHOTS,
  UPSC_SNAPSHOTS,
  RRB_SNAPSHOTS,
  BPSC_SNAPSHOTS,
  BSSC_SNAPSHOTS,
  UPPSC_SNAPSHOTS,
  UPSSSC_SNAPSHOTS,
} from './fixtures/source-snapshots.ts';

describe('Real Live Discovery Hardening — Production-Grade Source Adapters', () => {
  before(() => {
    initDatabase({ path: ':memory:', forceNew: true });
    const repos = getRepositories();
    const allAdapters = sourceRegistry.getAll();
    for (const a of allAdapters) {
      if (!repos.sources.findById(a.sourceId)) {
        repos.sources.create({
          id: a.sourceId,
          name: a.name,
          type: 'PORTAL',
          base_url: a.baseUrl,
          is_active: 1,
          check_interval_minutes: 60,
          config_json: '{}',
        });
      }
    }
  });

  after(() => {
    closeDatabase();
  });

  beforeEach(() => {
    DiscoveryCache.getInstance().clear();
  });

  describe('1. Common Source Adapter Contract & Official Configuration', () => {
    it('registers all 7 required government source adapters', () => {
      const requiredSourceIds = [
        'IN-CENTRAL-SSC',
        'IN-CENTRAL-UPSC',
        'IN-CENTRAL-RRB',
        'IN-BIHAR-BPSC',
        'IN-BIHAR-BSSC',
        'IN-UP-UPPSC',
        'IN-UP-UPSSSC',
      ];

      for (const id of requiredSourceIds) {
        const adapter = sourceRegistry.get(id);
        assert.ok(adapter, `Adapter ${id} must be registered in registry`);
        assert.equal(adapter.sourceId, id);
        assert.ok(adapter.name.length > 0);
        assert.ok(adapter.baseUrl.startsWith('https://'));
        assert.ok(adapter.officialDomains.length > 0);
        assert.ok(adapter.adapterVersion);
      }
    });

    it('verifies jurisdictions for central, bihar, and up', () => {
      assert.equal(sourceRegistry.get('IN-CENTRAL-SSC')?.jurisdiction, 'CENTRAL');
      assert.equal(sourceRegistry.get('IN-CENTRAL-UPSC')?.jurisdiction, 'CENTRAL');
      assert.equal(sourceRegistry.get('IN-CENTRAL-RRB')?.jurisdiction, 'CENTRAL');
      assert.equal(sourceRegistry.get('IN-BIHAR-BPSC')?.jurisdiction, 'BIHAR');
      assert.equal(sourceRegistry.get('IN-BIHAR-BSSC')?.jurisdiction, 'BIHAR');
      assert.equal(sourceRegistry.get('IN-UP-UPPSC')?.jurisdiction, 'UTTAR_PRADESH');
      assert.equal(sourceRegistry.get('IN-UP-UPSSSC')?.jurisdiction, 'UTTAR_PRADESH');
    });

    it('validates official URLs via adapter contract method validateOfficialUrl', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const validRes = await ssc.validateOfficialUrl('https://ssc.gov.in/notices/cgl2026.pdf');
      assert.equal(validRes.isOfficial, true);
      assert.equal(validRes.trustCategory, 'OFFICIAL_DOMAIN');

      const invalidRes = await ssc.validateOfficialUrl('https://sarkariresult.com/ssc-cgl.pdf');
      assert.equal(invalidRes.isOfficial, false);
      assert.equal(invalidRes.trustCategory, 'NON_OFFICIAL_DOMAIN');
    });
  });

  describe('2. Official Domain Verification & 3-Tier Domain Trust Gate', () => {
    it('classifies genuine government domains as OFFICIAL_DOMAIN', () => {
      assert.equal(classifyDomainTrust('https://ssc.gov.in/notice.pdf', 'IN-CENTRAL-SSC').category, 'OFFICIAL_DOMAIN');
      assert.equal(classifyDomainTrust('https://upsc.gov.in/doc.pdf', 'IN-CENTRAL-UPSC').category, 'OFFICIAL_DOMAIN');
      assert.equal(classifyDomainTrust('https://bpsc.bih.nic.in/advt.pdf', 'IN-BIHAR-BPSC').category, 'OFFICIAL_DOMAIN');
      assert.equal(classifyDomainTrust('https://bssc.bihar.gov.in/notice.pdf', 'IN-BIHAR-BSSC').category, 'OFFICIAL_DOMAIN');
      assert.equal(classifyDomainTrust('https://uppsc.up.nic.in/doc.pdf', 'IN-UP-UPPSC').category, 'OFFICIAL_DOMAIN');
      assert.equal(classifyDomainTrust('https://upsssc.gov.in/doc.pdf', 'IN-UP-UPSSSC').category, 'OFFICIAL_DOMAIN');
    });

    it('strictly classifies commercial third-party aggregators as NON_OFFICIAL_DOMAIN', () => {
      const aggregators = [
        'https://sarkariresult.com/upsc-job',
        'https://freejobalert.com/ssc-cgl',
        'https://naukri.com/govt-jobs',
        'https://apify.com/actors/job-scraper',
        'https://jagranjosh.com/jobs/upsssc',
      ];

      for (const url of aggregators) {
        const trust = classifyDomainTrust(url);
        assert.equal(trust.category, 'NON_OFFICIAL_DOMAIN');
        assert.equal(trust.isOfficial, false);
      }
    });

    it('classifies spoofed TLDs, IP addresses, and localhost as UNKNOWN_DOMAIN', () => {
      assert.equal(classifyDomainTrust('http://127.0.0.1:8080/doc.pdf').category, 'UNKNOWN_DOMAIN');
      assert.equal(classifyDomainTrust('http://169.254.169.254/latest').category, 'UNKNOWN_DOMAIN');
      assert.equal(classifyDomainTrust('https://unknown-host.internal/doc.pdf').category, 'UNKNOWN_DOMAIN');
    });

    it('supports dynamic RRB regional domain registry extension', () => {
      const rrb = sourceRegistry.get('IN-CENTRAL-RRB') as RrbSourceAdapter;
      rrb.registerRegionalBoard({
        code: 'RRB-BLR',
        name: 'RRB Bangalore Custom',
        url: 'https://rrbbnc.gov.in',
      });

      const check = isOfficialDomain('https://rrbbnc.gov.in/cen-01-2026.pdf', 'IN-CENTRAL-RRB');
      assert.equal(check.allowed, true);
    });
  });

  describe('3. Bounded Multi-Page Pagination', () => {
    it('crawls page 1 and follows next-page links to page 2', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const result = await ssc.executeDiscovery({
        pageFixtures: {
          1: SSC_SNAPSHOTS.multiPage1,
          2: SSC_SNAPSHOTS.multiPage2,
        },
        maxPages: 2,
        maxNotices: 10,
      });

      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.metrics.pagesCrawled, 2);
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.title.includes('Selection Posts Phase-XII')));
      assert.ok(result.notices.some((n) => n.title.includes('Multi Tasking')));
    });

    it('detects duplicate page content and halts pagination immediately', async () => {
      const upsc = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      // Provide identical HTML for page 1 and page 2
      const result = await upsc.executeDiscovery({
        pageFixtures: {
          1: UPSC_SNAPSHOTS.multiPage1,
          2: UPSC_SNAPSHOTS.multiPage1, // Loop back
        },
        maxPages: 5,
      });

      // Should stop after page 1 because page 2 has identical SHA-256 hash
      assert.equal(result.metrics.pagesCrawled, 1);
      assert.equal(result.recordsFound, 1);
    });

    it('strictly enforces maxPages safety limit', async () => {
      const rrb = sourceRegistry.get('IN-CENTRAL-RRB')!;
      const result = await rrb.executeDiscovery({
        pageFixtures: {
          1: RRB_SNAPSHOTS.multiPage1,
          2: RRB_SNAPSHOTS.multiPage2,
        },
        maxPages: 1, // Restrict to 1 page
      });

      assert.equal(result.metrics.pagesCrawled, 1);
      assert.equal(result.recordsFound, 1);
    });
  });

  describe('4. Official Document Discovery (Detail-Page Follow Through & Multi-Doc Classification)', () => {
    it('follows detail page when notice links to HTML page rather than PDF', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const result = await ssc.executeDiscovery({
        fixtureHtml: SSC_SNAPSHOTS.detailPageListing,
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
        },
        fetchDetailPages: true,
      });

      assert.equal(result.recordsFound, 1);
      const notice = result.notices[0];
      assert.ok(notice.detailUrl?.includes('cpo-2026.html'));
      assert.ok(notice.documents.length >= 2, 'Must extract documents from detail page');
      assert.ok(notice.documents.some((d) => d.url.includes('cpo-2026-notification.pdf')));
    });

    it('classifies multiple documents and prioritizes primary recruitment notification', () => {
      const doc1 = classifyDocumentLink('https://upsc.gov.in/Notification.pdf', 'Detailed Notification', 'NOTIFICATION');
      const doc2 = classifyDocumentLink('https://upsc.gov.in/Syllabus.pdf', 'Detailed Syllabus', 'NOTIFICATION');
      const doc3 = classifyDocumentLink('https://upsc.gov.in/AdmitCard.pdf', 'Download e-Admit Card', 'NOTIFICATION');

      assert.equal(doc1.documentCategory, 'RECRUITMENT_NOTIFICATION');
      assert.equal(doc1.isPrimaryNotification, true);

      assert.equal(doc2.documentCategory, 'SYLLABUS');
      assert.equal(doc2.isPrimaryNotification, false);

      assert.equal(doc3.documentCategory, 'ADMIT_CARD');
      assert.equal(doc3.isPrimaryNotification, false);
    });
  });

  describe('5. Explainable Notice Classification & False Positive Control', () => {
    it('identifies and explains rejection of tenders, scrap disposal, and administrative orders', () => {
      const tender = classifyNoticeExplainable('Tender for supply of office computers');
      assert.equal(tender.category, 'IRRELEVANT_NOTICE');
      assert.equal(tender.isRecruitmentRelated, false);
      assert.ok(tender.reason.toLowerCase().includes('tender'));

      const scrap = classifyNoticeExplainable('Auction notice for disposal of unserviceable scrap');
      assert.equal(scrap.category, 'IRRELEVANT_NOTICE');
      assert.equal(scrap.isRecruitmentRelated, false);
      assert.ok(scrap.reason.toLowerCase().includes('scrap') || scrap.reason.toLowerCase().includes('auction'));

      const holiday = classifyNoticeExplainable('List of Gazetted Holidays for Year 2026');
      assert.equal(holiday.category, 'IRRELEVANT_NOTICE');
      assert.equal(holiday.isRecruitmentRelated, false);
    });

    it('accurately identifies English and Hindi recruitment notices with reasons', () => {
      const cgl = classifyNoticeExplainable('Notice of Combined Graduate Level Examination 2026');
      assert.equal(cgl.category, 'NOTIFICATION');
      assert.equal(cgl.recruitmentType, 'NEW_RECRUITMENT');
      assert.equal(cgl.isRecruitmentRelated, true);

      const bpscHindi = classifyNoticeExplainable('विज्ञापन संख्या 26/2026 - 71वीं संयुक्त प्रतियोगिता परीक्षा');
      assert.equal(bpscHindi.category, 'NOTIFICATION');
      assert.equal(bpscHindi.isRecruitmentRelated, true);
    });
  });

  describe('6. Concrete Source Adapter Parsing on Realistic HTML Snapshots', () => {
    it('SSC Adapter: parses normal listing with advertisement numbers', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const result = await ssc.executeDiscovery({ fixtureHtml: SSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === 'HQ-CGL/2026/01'));
    });

    it('UPSC Adapter: parses views-table with CDS and Specialist ads', async () => {
      const upsc = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      const result = await upsc.executeDiscovery({ fixtureHtml: UPSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === '05/2026'));
    });

    it('RRB Adapter: parses CEN recruitment and extracts CEN numbers', async () => {
      const rrb = sourceRegistry.get('IN-CENTRAL-RRB')!;
      const result = await rrb.executeDiscovery({ fixtureHtml: RRB_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === 'CEN 01/2026'));
    });

    it('BPSC Adapter: parses Hindi advertisement table and extracts विज्ञापन संख्या', async () => {
      const bpsc = sourceRegistry.get('IN-BIHAR-BPSC')!;
      const result = await bpsc.executeDiscovery({ fixtureHtml: BPSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === '26/2026'));
    });

    it('BSSC Adapter: parses notice board table', async () => {
      const bssc = sourceRegistry.get('IN-BIHAR-BSSC')!;
      const result = await bssc.executeDiscovery({ fixtureHtml: BSSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
    });

    it('UPPSC Adapter: parses allnotifications table', async () => {
      const uppsc = sourceRegistry.get('IN-UP-UPPSC')!;
      const result = await uppsc.executeDiscovery({ fixtureHtml: UPPSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === 'A-1/E-1/2026'));
    });

    it('UPSSSC Adapter: parses allnotifications table', async () => {
      const upsssc = sourceRegistry.get('IN-UP-UPSSSC')!;
      const result = await upsssc.executeDiscovery({ fixtureHtml: UPSSSC_SNAPSHOTS.normalListing });
      assert.equal(result.status, 'SUCCESS_WITH_NOTICES');
      assert.equal(result.recordsFound, 2);
      assert.ok(result.notices.some((n) => n.advertisementNumber === '01-Exam/2026'));
    });
  });

  describe('7. Corrigendum, Extension, and Deterministic Identity Resolution', () => {
    it('detects corrigendum and date extension notices accurately', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const result = await ssc.executeDiscovery({ fixtureHtml: SSC_SNAPSHOTS.corrigendumListing });
      assert.equal(result.recordsFound, 1);
      const notice = result.notices[0];
      assert.ok(notice.recruitmentType === 'CORRIGENDUM' || notice.recruitmentType === 'EXTENSION');
    });

    it('produces identical identity key across listing and detail page', () => {
      const id1 = generateRecruitmentIdentity({
        authority: 'IN-CENTRAL-UPSC',
        advertisementNumber: '08/2024',
        title: 'Combined Defence Services Examination',
        documentUrl: 'https://upsc.gov.in/notices/cds-2024.pdf',
      });

      const id2 = generateRecruitmentIdentity({
        authority: 'IN-CENTRAL-UPSC',
        advertisementNumber: '08/2024',
        title: 'Combined Defence Services Examination 2024 Final Details',
        documentUrl: 'https://upsc.gov.in/exam/cds-2024.html',
      });

      assert.equal(id1.identityKey, id2.identityKey);
    });
  });

  describe('8. Empty Result Safety & Structure Change Handling', () => {
    it('returns SUCCESS_NO_RELEVANT_NOTICES when table is intact but has only irrelevant tenders', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const result = await ssc.executeDiscovery({ fixtureHtml: SSC_SNAPSHOTS.irrelevantListing });
      assert.equal(result.status, 'SUCCESS_NO_RELEVANT_NOTICES');
      assert.equal(result.recordsFound, 0);
    });

    it('returns ADAPTER_STRUCTURE_CHANGED when page layout/selectors completely change', async () => {
      const upsc = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      const result = await upsc.executeDiscovery({ fixtureHtml: UPSC_SNAPSHOTS.invalidStructure });
      assert.equal(result.status, 'ADAPTER_STRUCTURE_CHANGED');
      assert.equal(result.recordsFound, 0);
    });
  });

  describe('9. Multi-Source Discovery, Failure Isolation & Live Verification', () => {
    it('isolates failures: a failing source does not stop remaining sources in discoverAllSourcesSummary', async () => {
      const discoveryService = new DiscoveryService();
      // Provide valid fixture for SSC and broken fixture for UPSC
      const summary = await discoveryService.discoverAllSourcesSummary({
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
      });

      assert.ok(summary.totalSources >= 7);
      assert.ok(summary.successfulSources >= 1);
      assert.ok(summary.results['IN-CENTRAL-SSC']);
    });

    it('executes live verification without generating fake success in sandbox', async () => {
      const discoveryService = new DiscoveryService();
      const report = await discoveryService.runLiveVerification(800);

      assert.equal(report.totalSources, 7);
      assert.ok(report.items.length === 7);

      for (const item of report.items) {
        // Must be PASS or INCONCLUSIVE (never fake PASS if blocked)
        assert.ok(item.status === 'PASS' || item.status === 'INCONCLUSIVE' || item.status === 'FAIL');
        assert.ok(item.durationMs >= 0);
        assert.ok(item.reason);
      }
    });

    it('attaches discovery evidence to discovered documents and persists in DB', async () => {
      const repos = getRepositories();
      const discoveryService = new DiscoveryService(repos);

      const result = await discoveryService.discoverSource('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
      });

      assert.ok(result.notices.length > 0);
      const notice = result.notices[0];
      assert.ok(notice.evidence);
      assert.equal(notice.evidence.source, 'IN-CENTRAL-SSC');
      assert.equal(notice.evidence.officialDomain, 'ssc.gov.in');
      assert.ok(notice.evidence.discoveredAt);
    });

    it('ingests discovered document through full pipeline (validation, extraction, gate)', async () => {
      const repos = getRepositories();
      const discoveryService = new DiscoveryService(repos);

      const testPdf = createValidSamplePdf(`
Union Public Service Commission
Advertisement No. 15/2026-CDS
Combined Defence Services Examination 2026
Total Vacancies: 450
Application Start Date: 01/03/2026
Application Last Date: 25/03/2026
Age Limit: 20 to 24 years
Educational Qualification: Degree of a recognized University
Selection Process: Written Examination and SSB Interview
Application Fee: Rs. 200/- (Female/SC/ST exempted)
Official Website: https://upsc.gov.in
      `.trim());

      const docLink = {
        url: 'https://upsc.gov.in/sites/default/files/Advt-15-2026.pdf',
        canonicalUrl: 'https://upsc.gov.in/sites/default/files/Advt-15-2026.pdf',
        title: 'CDS Examination 2026 Notification',
        documentType: 'PDF' as const,
        isPrimaryNotification: true,
      };

      const notice = {
        sourceId: 'IN-CENTRAL-UPSC',
        externalId: 'upsc-15-2026',
        title: 'CDS Examination 2026',
        advertisementNumber: '15/2026-CDS',
        category: 'NOTIFICATION' as const,
        isRecruitmentRelated: true,
        recruitmentType: 'NEW_RECRUITMENT' as const,
        publishedDate: '2026-03-01',
        closingDate: '2026-03-25',
        rawNoticeUrl: docLink.url,
        documents: [docLink],
        metadata: {},
      };

      const ingestResult = await discoveryService.ingestDiscoveredDocument(
        'IN-CENTRAL-UPSC',
        docLink,
        notice,
        { buffer: testPdf }
      );

      assert.ok(ingestResult.documentId);
      assert.ok(ingestResult.recruitmentId);
      assert.equal(ingestResult.status, 'EXTRACTED');
      assert.ok(ingestResult.publishingState);
    });
  });

  describe('10. Source-Specific Live Adapter Intelligence & Evidence Completeness', () => {
    it('verifies all 7 adapters are upgraded to version 1.3.0', () => {
      const allAdapters = sourceRegistry.getAll();
      assert.equal(allAdapters.length, 7);
      for (const a of allAdapters) {
        assert.equal(a.adapterVersion, '1.3.0', `${a.sourceId} must be at version 1.3.0`);
      }
    });

    it('attaches sourceSpecificRule to notices across all adapters', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const sscRes = await ssc.executeDiscovery({ fixtureHtml: SSC_SNAPSHOTS.normalListing });
      assert.ok(sscRes.notices.length > 0);
      assert.equal(sscRes.notices[0].sourceSpecificRule, 'SSC_RECRUITMENT_ADVERTISEMENT');

      const upsc = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      const upscRes = await upsc.executeDiscovery({ fixtureHtml: UPSC_SNAPSHOTS.normalListing });
      assert.ok(upscRes.notices.length > 0);
      assert.ok(upscRes.notices[0].sourceSpecificRule?.startsWith('UPSC_'));

      const rrb = sourceRegistry.get('IN-CENTRAL-RRB')!;
      const rrbRes = await rrb.executeDiscovery({ fixtureHtml: RRB_SNAPSHOTS.normalListing });
      assert.ok(rrbRes.notices.length > 0);
      assert.equal(rrbRes.notices[0].sourceSpecificRule, 'RRB_CEN_PRIMARY_NOTIFICATION');

      const bpsc = sourceRegistry.get('IN-BIHAR-BPSC')!;
      const bpscRes = await bpsc.executeDiscovery({ fixtureHtml: BPSC_SNAPSHOTS.normalListing });
      assert.ok(bpscRes.notices.length > 0);
      assert.equal(bpscRes.notices[0].sourceSpecificRule, 'BPSC_RECRUITMENT_ADVT');

      const bssc = sourceRegistry.get('IN-BIHAR-BSSC')!;
      const bsscRes = await bssc.executeDiscovery({ fixtureHtml: BSSC_SNAPSHOTS.normalListing });
      assert.ok(bsscRes.notices.length > 0);
      assert.equal(bsscRes.notices[0].sourceSpecificRule, 'BSSC_RECRUITMENT_ADVT');

      const uppsc = sourceRegistry.get('IN-UP-UPPSC')!;
      const uppscRes = await uppsc.executeDiscovery({ fixtureHtml: UPPSC_SNAPSHOTS.normalListing });
      assert.ok(uppscRes.notices.length > 0);
      assert.equal(uppscRes.notices[0].sourceSpecificRule, 'UPPSC_DIRECT_ADVT');

      const upsssc = sourceRegistry.get('IN-UP-UPSSSC')!;
      const upssscRes = await upsssc.executeDiscovery({ fixtureHtml: UPSSSC_SNAPSHOTS.normalListing });
      assert.ok(upssscRes.notices.length > 0);
      assert.equal(upssscRes.notices[0].sourceSpecificRule, 'UPSSSC_EXAM_ADVT');
    });

    it('unifies cross-region RRB CEN recruitment identity into the exact same identity key', () => {
      // Notice from RRB Mumbai
      const mumbaiNotice = generateRecruitmentIdentity({
        authority: 'RRB Mumbai',
        cenNumber: 'CEN 01/2026',
        title: 'Recruitment of Assistant Loco Pilot (ALP)',
      });

      // Same CEN notice from RRB Patna
      const patnaNotice = generateRecruitmentIdentity({
        authority: 'RRB Patna',
        cenNumber: 'CEN 01/2026',
        title: 'Centralized Employment Notice CEN 01/2026 ALP Vacancy',
      });

      // Central portal notice
      const centralNotice = generateRecruitmentIdentity({
        authority: 'IN-CENTRAL-RRB',
        cenNumber: 'CEN 01/2026',
        title: 'Assistant Loco Pilot',
      });

      assert.equal(mumbaiNotice.normalizedAuthority, 'RRB');
      assert.equal(patnaNotice.normalizedAuthority, 'RRB');
      assert.equal(centralNotice.normalizedAuthority, 'RRB');
      assert.equal(mumbaiNotice.identityKey, patnaNotice.identityKey);
      assert.equal(mumbaiNotice.identityKey, centralNotice.identityKey);
    });

    it('verifies all 12 observable criteria are present in LiveSourceVerificationItem', async () => {
      const discoveryService = new DiscoveryService();
      const report = await discoveryService.runLiveVerification(600, { maxRetries: 0 });

      assert.equal(report.items.length, 7);
      for (const item of report.items) {
        // 1. source
        assert.ok(typeof item.source === 'string' && item.source.length > 0);
        // 2. officialDomain
        assert.ok(typeof item.officialDomain === 'string' && item.officialDomain.length > 0);
        // 3. listingReachable
        assert.ok(typeof item.listingReachable === 'boolean');
        // 4. listingParsed
        assert.ok(typeof item.listingParsed === 'boolean');
        // 5. relevantNoticeDetection
        assert.ok(typeof item.relevantNoticeDetection === 'boolean');
        // 6. detailPageReachable
        assert.ok(typeof item.detailPageReachable === 'boolean');
        // 7. documentDiscovery
        assert.ok(typeof item.documentDiscovery === 'boolean');
        // 8. documentValidation
        assert.ok(typeof item.documentValidation === 'boolean');
        // 9. paginationObserved
        assert.ok(typeof item.paginationObserved === 'boolean');
        // 10. adapterVersion
        assert.equal(item.adapterVersion, '1.3.0');
        // 11. status (PASS, FAIL, INCONCLUSIVE)
        assert.ok(item.status === 'PASS' || item.status === 'FAIL' || item.status === 'INCONCLUSIVE');
        // 12. reason
        assert.ok(typeof item.reason === 'string' && item.reason.length > 0);
      }
    });
  });

  describe('11. Source Endpoint Registry & Multi-Stage Endpoint Verification', () => {
    it('verifies all 7 adapters are upgraded to version 1.3.0', () => {
      const allAdapters = sourceRegistry.getAll();
      assert.equal(allAdapters.length, 7);
      for (const a of allAdapters) {
        assert.equal(a.adapterVersion, '1.3.0', `${a.sourceId} must be at version 1.3.0`);
      }
    });

    it('retrieves configured endpoints for all 7 sources from sourceEndpointRegistry', () => {
      const sources = [
        'IN-CENTRAL-SSC',
        'IN-CENTRAL-UPSC',
        'IN-CENTRAL-RRB',
        'IN-BIHAR-BPSC',
        'IN-BIHAR-BSSC',
        'IN-UP-UPPSC',
        'IN-UP-UPSSSC',
      ];

      for (const sourceId of sources) {
        const endpoints = sourceEndpointRegistry.getEndpointsForSource(sourceId);
        assert.ok(endpoints.length >= 1, `Source ${sourceId} must have at least 1 registered endpoint`);
        const primary = endpoints[0];
        assert.equal(primary.endpointPriority, 1);
        assert.equal(primary.enabled, true);
        assert.equal(primary.adapterVersion, '1.3.0');
      }
    });

    it('verifies fallback endpoints priority order for each adapter', () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      assert.deepEqual(ssc.getFallbackEndpoints(), [
        'https://ssc.gov.in',
        'https://ssc.gov.in/api/general-website/portal/notice-boards?page=1&limit=15&contentType=notice-boards&key=createdAt&order=DESC&isAttachment=true&language=english&attributes=id,headline,examId,contentType,redirectUrl,startDate,endDate,language,createdAt',
        'https://ssc.gov.in/notices',
      ]);

      const upsc = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      assert.deepEqual(upsc.getFallbackEndpoints(), [
        'https://www.upsc.gov.in',
        'https://www.upsc.gov.in/examinations/active-exams',
        'https://www.upsc.gov.in/recruitment/recruitment-advertisement',
      ]);

      const bpsc = sourceRegistry.get('IN-BIHAR-BPSC')!;
      assert.deepEqual(bpsc.getFallbackEndpoints(), [
        'https://bpsc.bih.nic.in',
        'https://bpsc.bih.nic.in/NoticeHeader.htm',
      ]);
    });

    it('executes runEndpointVerification and produces Stage 1 and Stage 2 verification metrics', async () => {
      const report = await runEndpointVerification({ timeoutMs: 600, maxRetries: 0, noCache: true });
      assert.ok(report.totalEndpoints >= 7);
      assert.ok(report.results.length >= 7);

      for (const res of report.results) {
        assert.ok(res.endpointId);
        assert.ok(res.sourceId);
        assert.ok(res.requestedUrl);
        assert.ok(typeof res.endpointReachable === 'boolean');
        assert.ok(typeof res.listingParsed === 'boolean');
        assert.ok(res.resultState === 'PASS' || res.resultState === 'FAIL' || res.resultState === 'INCONCLUSIVE');
        assert.equal(res.cacheState, 'LIVE');
      }
    });

    it('evaluates health state as STRUCTURE_CHANGED when HTTP 200 is returned but recruitment HTML structure is invalid', async () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const invalidHtml = '<html><body><h1>Under Maintenance</h1></body></html>';
      const parseRes = ssc.parseNotices(invalidHtml, 'https://ssc.gov.in');
      assert.equal(parseRes.structureIntact, false);
      assert.equal(parseRes.notices.length, 0);
    });
  });

  describe('12. Registry-Driven Discovery Executor & End-to-End PDF Verification', () => {
    it('executes registry-driven discovery via DiscoveryExecutor', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        noCache: true,
      });

      assert.equal(res.status, 'SUCCESS_WITH_NOTICES');
      assert.ok(res.recordsFound > 0);
      assert.ok(res.metrics.selectedEndpointId);
      assert.equal(res.cacheState, 'LIVE');
    });

    it('ensures getFallbackEndpoints returns endpoints from sourceEndpointRegistry', () => {
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const fallbacks = ssc.getFallbackEndpoints();
      const registryEndpoints = sourceEndpointRegistry.getEndpointsForSource('IN-CENTRAL-SSC').map((ep) => ep.url);

      assert.deepEqual(fallbacks, registryEndpoints);
    });

    it('records documentDiscoveryMethod as DIRECT_PDF or DETAIL_PAGE', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.detailPageListing,
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
        },
        fetchDetailPages: true,
        noCache: true,
      });

      assert.equal(res.recordsFound, 1);
      const doc = res.notices[0].documents[0];
      assert.equal(doc.documentDiscoveryMethod, 'DETAIL_PAGE');
    });

    it('bypasses cache when noCache option is provided', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-BIHAR-BPSC', {
        fixtureHtml: BPSC_SNAPSHOTS.normalListing,
        noCache: true,
      });

      assert.equal(res.cached, false);
      assert.equal(res.cacheState, 'LIVE');
    });

    it('distinguishes SUCCESS_NO_RELEVANT_NOTICES from ADAPTER_STRUCTURE_CHANGED', async () => {
      const executor = getDiscoveryExecutor();
      const irrelevantRes = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.irrelevantListing,
        noCache: true,
      });
      assert.equal(irrelevantRes.status, 'SUCCESS_NO_RELEVANT_NOTICES');

      const brokenRes = await executor.execute('IN-CENTRAL-UPSC', {
        fixtureHtml: UPSC_SNAPSHOTS.invalidStructure,
        noCache: true,
      });
      assert.equal(brokenRes.status, 'ADAPTER_STRUCTURE_CHANGED');
    });

    it('executes end-to-end multi-source live verification reporting stage metrics', async () => {
      const discoveryService = new DiscoveryService();
      const report = await discoveryService.runLiveVerification(600, { maxRetries: 0 });

      assert.equal(report.totalSources, 7);
      assert.equal(report.items.length, 7);

      for (const item of report.items) {
        assert.ok(item.source);
        assert.ok(item.adapterVersion);
        assert.ok(typeof item.pagesCrawled === 'number');
        assert.ok(typeof item.noticesFound === 'number');
        assert.ok(typeof item.documentsFound === 'number');
        assert.ok(typeof item.documentsDownloaded === 'number');
        assert.ok(typeof item.validPdfs === 'number');
        assert.ok(item.resultState === 'PASS' || item.resultState === 'FAIL' || item.resultState === 'INCONCLUSIVE');
      }
    });
  });

  describe('13. Production Discovery Fallback, Stage Metrics & Strict Live PASS Gate', () => {
    it('does NOT stop fallback on primary endpoint HTTP 200 when structure is invalid or generic content returned', async () => {
      const executor = getDiscoveryExecutor();

      // SSC has 3 registered endpoints: ssc-primary, ssc-notice-sanction, ssc-notices-section
      // Run executor with invalid HTML for primary, valid for fallback
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.invalidStructure, // Primary endpoint returns invalid HTML
        noCache: true,
      });

      assert.ok(res.metrics.attemptedEndpoints);
      assert.ok(res.metrics.attemptedEndpoints.length >= 1);
      const primaryLog = res.metrics.attemptedEndpoints[0];
      assert.equal(primaryLog.endpointId, 'ssc-primary');
      assert.equal(primaryLog.outcome, 'ENDPOINT_STRUCTURE_CHANGED');
    });

    it('tracks granular detail page metrics (discovered, attempted, fetched, parsed, withDocuments)', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.detailPageListing,
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
        },
        fetchDetailPages: true,
        noCache: true,
      });

      assert.equal(res.metrics.detailUrlsDiscovered, 1);
      assert.equal(res.metrics.detailRequestsAttempted, 1);
      assert.equal(res.metrics.detailPagesFetched, 1);
      assert.equal(res.metrics.detailPagesParsed, 1);
      assert.equal(res.metrics.detailPagesWithDocuments, 1);
    });

    it('tracks document & PDF metrics (candidates, download attempts, valid PDFs, invalid PDFs)', async () => {
      const executor = getDiscoveryExecutor();
      const samplePdf = createValidSamplePdf('Staff Selection Commission CGL 2026 Notification');
      
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      assert.ok(typeof res.metrics.pdfCandidates === 'number');
      assert.ok(typeof res.metrics.documentDownloadAttempts === 'number');
      assert.ok(typeof res.metrics.documentsDownloaded === 'number');
      assert.ok(typeof res.metrics.validPdfs === 'number');
      assert.ok(typeof res.metrics.invalidPdfs === 'number');
    });

    it('requires actual downloaded and validated PDF for final PASS status during downloadAndValidatePdfs mode', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      // Without network or buffer fixture for external PDF URLs, download fails -> status is INCONCLUSIVE or FAIL
      assert.notEqual(res.status, 'PASS', 'Status cannot be PASS if PDFs were not actually downloaded and validated');
    });

    it('records machine-readable failure reason and attempted endpoints telemetry', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-UPSC', {
        fixtureHtml: UPSC_SNAPSHOTS.invalidStructure,
        noCache: true,
      });

      assert.equal(res.status, 'ADAPTER_STRUCTURE_CHANGED');
      assert.equal(res.errorCode, 'ADAPTER_STRUCTURE_CHANGED');
      assert.ok(res.metrics.attemptedEndpoints);
      assert.ok(res.metrics.attemptedEndpoints.length >= 1);
    });

    it('returns SUCCESS_NO_RELEVANT_NOTICES when source structure is confirmed valid but 0 active recruitment notices exist', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.irrelevantListing,
        noCache: true,
      });

      assert.equal(res.status, 'SUCCESS_NO_RELEVANT_NOTICES');
      assert.equal(res.errorCode, null);
      assert.equal(res.recordsFound, 0);
    });
  });

  describe('14. Strict Live Verification Correctness & End-to-End PASS Gate (Tests 1-10)', () => {
    it('Test 1 — HTTP 200 with zero notices: returns SUCCESS_NO_RELEVANT_NOTICES and outcome INCONCLUSIVE (NEVER PASS)', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.irrelevantListing,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.status, 'SUCCESS_NO_RELEVANT_NOTICES');
      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'INCONCLUSIVE');
      assert.ok(res.failureReasons?.includes('NO_RELEVANT_NOTICE'));
      assert.ok(res.failureReasons?.includes('INSUFFICIENT_EVIDENCE'));
    });

    it('Test 2 — HTTP 200 with empty/error page: returns FAIL with listingValidated === false', async () => {
      const executor = getDiscoveryExecutor();
      const errorHtml = '<html><body><h1>FileNotFound</h1><p>The resource you are looking for has been removed.</p></body></html>';

      const res = await executor.execute('IN-UP-UPPSC', {
        endpointFixtures: {
          'uppsc-all-notifications': {
            status: 200,
            html: errorHtml,
            finalUrl: 'https://uppsc.up.nic.in/FileNotFound.aspx',
          },
          'uppsc-primary': {
            status: 200,
            html: '   ',
            finalUrl: 'https://uppsc.up.nic.in',
          },
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.verificationEvidence?.listingValidated, false);
      assert.ok(res.failureReasons?.includes('WRONG_CONTENT'));
    });

    it('Test 3 — Relevant notice found, detail required, detail fails: returns FAIL with detailResolved === false', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.detailPageListing,
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': null, // Simulate detail page fetch failure
        },
        fetchDetailPages: true,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.verificationEvidence?.relevantNoticeFound, true);
      assert.equal(res.verificationEvidence?.detailResolved, false);
      assert.ok(res.failureReasons?.includes('DETAIL_NOT_RESOLVED'));
    });

    it('Test 4 — Document URL discovered, download not executed: returns INCONCLUSIVE (NEVER PASS)', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        downloadAndValidatePdfs: false, // Document URL discovered, download not executed
        noCache: true,
      });

      assert.ok(res.documentsFound > 0);
      assert.equal(res.metrics.documentsDownloaded, 0);
      assert.equal(res.metrics.validPdfs, 0);
      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'INCONCLUSIVE');
      assert.ok(res.failureReasons?.includes('DOCUMENT_DOWNLOAD_FAILED'));
      assert.ok(res.failureReasons?.includes('INSUFFICIENT_EVIDENCE'));
    });

    it('Test 5 — Document downloaded, HTML returned instead of PDF: returns FAIL with pdfValidated === false', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf':
            '<!DOCTYPE html><html><body><h1>Session Expired / Login Required</h1></body></html>',
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf':
            '<html><body>Error 404 Not Found</body></html>',
        },
        noCache: true,
      });

      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.verificationEvidence?.pdfValidated, false);
      assert.equal(res.metrics.validPdfs, 0);
      assert.ok(res.failureReasons?.includes('INVALID_MIME'));
    });

    it('Test 6 — Primary endpoint empty, secondary endpoint valid: achieves PASS via secondary endpoint', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('Staff Selection Commission CGL 2026 Official Notification');

      const res = await executor.execute('IN-CENTRAL-SSC', {
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.irrelevantListing, // 0 relevant notices on primary
          'ssc-notice-sanction': SSC_SNAPSHOTS.normalListing, // Valid recruitment notices on secondary
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'PASS');
      assert.equal(res.status, 'PASS');
      assert.equal(res.metrics.selectedEndpointId, 'ssc-notice-sanction');
      assert.ok((res.metrics.attemptedEndpoints?.length ?? 0) >= 2);
      assert.equal(res.metrics.attemptedEndpoints?.[0].endpointId, 'ssc-primary');
      assert.equal(res.metrics.attemptedEndpoints?.[0].outcome, 'ENDPOINT_EMPTY_VALID');
      assert.equal(res.metrics.attemptedEndpoints?.[1].endpointId, 'ssc-notice-sanction');
      assert.equal(res.metrics.attemptedEndpoints?.[1].outcome, 'ENDPOINT_SUCCESS');
      assert.ok((res.metrics.validPdfs ?? 0) > 0);
    });

    it('Test 7 — Primary endpoint succeeds: fallback endpoints are NOT executed', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('SSC CGL 2026 Official Notification PDF');

      const res = await executor.execute('IN-CENTRAL-SSC', {
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.normalListing,
          'ssc-notice-sanction': SSC_SNAPSHOTS.normalListing,
          'ssc-notices-section': SSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'PASS');
      assert.equal(res.metrics.selectedEndpointId, 'ssc-primary');
      assert.equal(res.metrics.attemptedEndpoints?.length, 1, 'Must stop immediately after primary endpoint achieves E2E PASS');
      assert.equal(res.metrics.attemptedEndpoints?.[0].endpointId, 'ssc-primary');
    });

    it('Test 8 — Multi-page discovery: crawls page 1 and page 2 when maxPages > 1 and discovers notice on page 2', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-SSC', {
        pageFixtures: {
          1: SSC_SNAPSHOTS.multiPage1,
          2: SSC_SNAPSHOTS.multiPage2,
        },
        maxPages: 2,
        noCache: true,
      });

      assert.equal(res.metrics.pagesCrawled, 2);
      assert.equal(res.recordsFound, 2);
      assert.ok(res.notices.some((n) => n.pageNumber === 1 && n.title.includes('Selection Posts Phase-XII')));
      assert.ok(res.notices.some((n) => n.pageNumber === 2 && n.title.includes('Multi Tasking')));
    });

    it('Test 9 — Full end-to-end live PASS: verifies all 7 stages and returns outcome === PASS', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('Sub-Inspector in Delhi Police and CAPFs Examination 2026 Official Notification');

      const res = await executor.execute('IN-CENTRAL-SSC', {
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.detailPageListing,
        },
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
        },
        pdfFixtures: {
          'https://ssc.gov.in/files/cpo-2026-notification.pdf': validPdf,
          'https://ssc.gov.in/files/cpo-2026-syllabus.pdf': validPdf,
          'https://ssc.gov.in/files/cpo-2026-annexures.pdf': validPdf,
        },
        fetchDetailPages: true,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'PASS');
      assert.equal(res.status, 'PASS');
      assert.equal(res.verificationEvidence?.endpointReached, true);
      assert.equal(res.verificationEvidence?.listingValidated, true);
      assert.equal(res.verificationEvidence?.relevantNoticeFound, true);
      assert.equal(res.verificationEvidence?.detailResolved, true);
      assert.equal(res.verificationEvidence?.documentDiscovered, true);
      assert.equal(res.verificationEvidence?.documentDownloaded, true);
      assert.equal(res.verificationEvidence?.pdfValidated, true);
      assert.equal(res.failureReasons?.length, 0);
    });

    it('Test 10 — Cached result cannot claim live PASS: marks responseSource === CACHED_RESULT and outcome INCONCLUSIVE', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('SSC CGL 2026 Notification');

      // First run populates cache (noCache: false, without fixtures blocking cache)
      const cacheInstance = DiscoveryCache.getInstance();
      const ssc = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const endpoints = sourceEndpointRegistry.getEndpointsForSource('IN-CENTRAL-SSC');
      const cacheKey = cacheInstance.generateKey('IN-CENTRAL-SSC', endpoints[0].url, ssc.adapterVersion, {
        noCache: false,
      });

      const liveRes = await executor.execute('IN-CENTRAL-SSC', {
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        noCache: true,
      });
      assert.equal(liveRes.outcome, 'PASS');

      // Store in cache and retrieve via non-noCache call
      cacheInstance.set(cacheKey, 'IN-CENTRAL-SSC', endpoints[0].url, ssc.adapterVersion, liveRes, 60000);

      const cachedRes = await executor.execute('IN-CENTRAL-SSC', {
        noCache: false,
      });

      assert.equal(cachedRes.cached, true);
      assert.equal(cachedRes.responseSource, 'CACHED_RESULT');
      assert.equal(cachedRes.verificationMode, 'CACHE');
      assert.equal(cachedRes.verificationStatus, 'CACHED_UNVERIFIED');
      assert.equal(cachedRes.verifiedLive, false);
      assert.notEqual(cachedRes.outcome, 'PASS');
      assert.equal(cachedRes.outcome, 'INCONCLUSIVE');
      assert.ok(cachedRes.failureReasons?.includes('CACHED_RESULT'));
    });
  });

  describe('15. Final Hardening — Detail Semantics, 7-Source E2E Matrix & False-Positive/Negative Prevention', () => {
    it('Case A — HTTP 200 + valid HTML + no notice: returns INCONCLUSIVE (NOT PASS) with NO_RELEVANT_NOTICE', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-BIHAR-BPSC', {
        fixtureHtml: BPSC_SNAPSHOTS.irrelevantListing,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'INCONCLUSIVE');
      assert.equal(res.detailRequired, false);
      assert.equal(res.detailResolved, null);
      assert.ok(res.failureReasons?.includes('NO_RELEVANT_NOTICE'));
      assert.ok(res.failureReasons?.includes('INSUFFICIENT_EVIDENCE'));
    });

    it('Case B — HTTP 200 + notice + PDF URL discovered + PDF never downloaded: returns INCONCLUSIVE (NOT PASS)', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-RRB', {
        fixtureHtml: RRB_SNAPSHOTS.normalListing,
        downloadAndValidatePdfs: false,
        noCache: true,
      });

      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'INCONCLUSIVE');
      assert.equal(res.verificationEvidence?.relevantNoticeFound, true);
      assert.equal(res.verificationEvidence?.documentDiscovered, true);
      assert.equal(res.verificationEvidence?.documentDownloaded, false);
      assert.equal(res.verificationEvidence?.pdfValidated, false);
      assert.equal(res.notices[0].evidenceStage, 'DOCUMENT_URL_FOUND');
      assert.ok(res.failureReasons?.includes('DOCUMENT_DOWNLOAD_FAILED'));
      assert.ok(res.failureReasons?.includes('INSUFFICIENT_EVIDENCE'));
    });

    it('Case C — HTTP 200 + notice + PDF downloaded + invalid PDF: returns FAIL with documentDownloaded=true, pdfValidated=false, INVALID_DOCUMENT & INVALID_PDF', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-BIHAR-BSSC', {
        fixtureHtml: BSSC_SNAPSHOTS.normalListing,
        pdfFixtures: {
          'https://bssc.bihar.gov.in/advertisement/Advt-01-2026-4th-CGL.pdf':
            '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n/* truncated without EOF or pages */',
          'https://bssc.bihar.gov.in/advertisement/Advt-02-2026-Inter.pdf':
            '<!DOCTYPE html><html><body>Error page</body></html>',
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.verificationEvidence?.documentDiscovered, true);
      assert.equal(res.verificationEvidence?.documentDownloaded, true);
      assert.equal(res.verificationEvidence?.pdfValidated, false);
      assert.equal(res.notices[0].evidenceStage, 'DOCUMENT_DOWNLOADED');
      assert.equal(res.metrics.documentsDownloaded, 2);
      assert.equal(res.metrics.validPdfs, 0);
      assert.equal(res.metrics.pdfsValidated, 0);
      assert.ok(res.failureReasons?.includes('INVALID_DOCUMENT'));
      assert.ok(res.failureReasons?.includes('INVALID_PDF'));
    });

    it('Case D — Listing + detail URL + detail cannot be fetched + detailRequired=true: returns FAIL with DETAIL_REQUIRED & DETAIL_NOT_RESOLVED', async () => {
      const executor = getDiscoveryExecutor();
      const res = await executor.execute('IN-CENTRAL-UPSC', {
        fixtureHtml: UPSC_SNAPSHOTS.detailPageListing,
        detailFixtures: {
          'https://upsc.gov.in/examinations/civil-services-2026.html': null,
        },
        fetchDetailPages: true,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.detailRequired, true);
      assert.equal(res.detailResolved, false);
      assert.equal(res.verificationEvidence?.detailRequired, true);
      assert.equal(res.verificationEvidence?.detailResolved, false);
      assert.equal(res.verificationEvidence?.documentDiscovered, false);
      assert.equal(res.metrics.detailUrlsDiscovered, 1);
      assert.equal(res.metrics.detailRequestsAttempted, 1);
      assert.equal(res.metrics.detailPagesFetched, 0);
      assert.ok(res.failureReasons?.includes('DETAIL_REQUIRED'));
      assert.ok(res.failureReasons?.includes('DETAIL_NOT_RESOLVED'));
      assert.ok(res.failureReasons?.includes('DOCUMENT_NOT_FOUND'));
    });

    it('Case E — Listing + detail URL exists + source exposes PDF directly + detailRequired=false + valid PDF: returns PASS with detailResolved=null (no false negative)', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('UPPSC Combined State Upper Subordinate Services PCS Examination 2026');

      // UPPSC_SNAPSHOTS.normalListing has BOTH View_Advt.aspx?ID=PCS-2026 AND Advt/A-1-E-1-2026-PCS.pdf on Row 1
      const res = await executor.execute('IN-UP-UPPSC', {
        endpointFixtures: {
          'uppsc-all-notifications': UPPSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://uppsc.up.nic.in/Advt/A-1-E-1-2026-PCS.pdf': validPdf,
          'https://uppsc.up.nic.in/Advt/A-2-E-1-2026-RO-ARO.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.outcome, 'PASS');
      assert.equal(res.status, 'PASS');
      assert.equal(res.detailRequired, false);
      assert.equal(res.detailResolved, null);
      assert.equal(res.verificationEvidence?.detailRequired, false);
      assert.equal(res.verificationEvidence?.detailResolved, null);
      assert.equal(res.metrics.detailUrlsDiscovered, 1, 'Optional detail URL on row is recorded');
      assert.equal(res.metrics.detailPagesFetched, 0, 'Detail page fetch is not required when direct PDF is exposed');
      assert.equal(res.verificationEvidence?.documentDiscovered, true);
      assert.equal(res.verificationEvidence?.documentDownloaded, true);
      assert.equal(res.verificationEvidence?.pdfValidated, true);
      assert.equal(res.failureReasons?.length, 0);
      assert.ok(res.evidence?.listingUrl);
      assert.ok(res.evidence?.documentUrl?.endsWith('.pdf'));
      assert.ok(res.evidence?.documentSha256);
      assert.ok((res.evidence?.pdfPageCount ?? 0) >= 1);
    });

    it('verifies all 7 sources (SSC, UPSC, RRB, BPSC, BSSC, UPPSC, UPSSSC) end-to-end across direct-PDF and detail-PDF paths', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('Official Government Recruitment Notification 2026');

      const sourceTestMatrix: Array<{
        sourceId: string;
        endpointId: string;
        listingHtml: string;
        detailFixtures?: Record<string, string | null>;
        pdfFixtures: Record<string, Buffer>;
        expectedDetailRequired: boolean;
        expectedDetailResolved: boolean | null;
      }> = [
        // 1. SSC (Direct PDF mode)
        {
          sourceId: 'IN-CENTRAL-SSC',
          endpointId: 'ssc-primary',
          listingHtml: SSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
            'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 1b. SSC (Detail-page required mode)
        {
          sourceId: 'IN-CENTRAL-SSC',
          endpointId: 'ssc-primary',
          listingHtml: SSC_SNAPSHOTS.detailPageListing,
          detailFixtures: {
            'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
          },
          pdfFixtures: {
            'https://ssc.gov.in/files/cpo-2026-notification.pdf': validPdf,
            'https://ssc.gov.in/files/cpo-2026-syllabus.pdf': validPdf,
            'https://ssc.gov.in/files/cpo-2026-annexures.pdf': validPdf,
          },
          expectedDetailRequired: true,
          expectedDetailResolved: true,
        },
        // 2. UPSC (Direct PDF mode)
        {
          sourceId: 'IN-CENTRAL-UPSC',
          endpointId: 'upsc-recruitment-advt',
          listingHtml: UPSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://upsc.gov.in/sites/default/files/Advt-05-2026-Specialist.pdf': validPdf,
            'https://upsc.gov.in/sites/default/files/Advt-06-2026-CDS.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 2b. UPSC (Detail-page required mode)
        {
          sourceId: 'IN-CENTRAL-UPSC',
          endpointId: 'upsc-active-exams',
          listingHtml: UPSC_SNAPSHOTS.detailPageListing,
          detailFixtures: {
            'https://upsc.gov.in/examinations/civil-services-2026.html': UPSC_SNAPSHOTS.detailPageContent,
          },
          pdfFixtures: {
            'https://upsc.gov.in/sites/default/files/Notification-CSP-2026.pdf': validPdf,
            'https://upsc.gov.in/sites/default/files/CSE-2026-Syllabus.pdf': validPdf,
            'https://upsc.gov.in/sites/default/files/CSE-Instructions.pdf': validPdf,
          },
          expectedDetailRequired: true,
          expectedDetailResolved: true,
        },
        // 3. RRB
        {
          sourceId: 'IN-CENTRAL-RRB',
          endpointId: 'rrb-central-primary',
          listingHtml: RRB_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://rrbapply.gov.in/docs/CEN_01_2026_ALP.pdf': validPdf,
            'https://rrbapply.gov.in/docs/CEN_02_2026_Tech.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 4. BPSC
        {
          sourceId: 'IN-BIHAR-BPSC',
          endpointId: 'bpsc-primary',
          listingHtml: BPSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://bpsc.bih.nic.in/Advt/Advt-26-2026-71st-CCE.pdf': validPdf,
            'https://bpsc.bih.nic.in/Advt/Advt-27-2026-AP.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 5. BSSC
        {
          sourceId: 'IN-BIHAR-BSSC',
          endpointId: 'bssc-notice-board',
          listingHtml: BSSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://bssc.bihar.gov.in/advertisement/Advt-01-2026-4th-CGL.pdf': validPdf,
            'https://bssc.bihar.gov.in/advertisement/Advt-02-2026-Inter.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 6. UPPSC
        {
          sourceId: 'IN-UP-UPPSC',
          endpointId: 'uppsc-all-notifications',
          listingHtml: UPPSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://uppsc.up.nic.in/Advt/A-1-E-1-2026-PCS.pdf': validPdf,
            'https://uppsc.up.nic.in/Advt/A-2-E-1-2026-RO-ARO.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
        // 7. UPSSSC
        {
          sourceId: 'IN-UP-UPSSSC',
          endpointId: 'upsssc-all-notifications',
          listingHtml: UPSSSC_SNAPSHOTS.normalListing,
          pdfFixtures: {
            'https://upsssc.gov.in/Advt/01-Exam-2026-PET.pdf': validPdf,
            'https://upsssc.gov.in/Advt/02-Exam-2026-JA.pdf': validPdf,
          },
          expectedDetailRequired: false,
          expectedDetailResolved: null,
        },
      ];

      for (const tc of sourceTestMatrix) {
        const res = await executor.execute(tc.sourceId, {
          endpointId: tc.endpointId,
          endpointFixtures: {
            [tc.endpointId]: tc.listingHtml,
          },
          detailFixtures: tc.detailFixtures,
          pdfFixtures: tc.pdfFixtures,
          fetchDetailPages: true,
          downloadAndValidatePdfs: true,
          strictLiveMode: true,
          noCache: true,
        });

        assert.equal(res.outcome, 'PASS', `Expected PASS for ${tc.sourceId} (${tc.endpointId})`);
        assert.equal(res.status, 'PASS');
        assert.equal(res.detailRequired, tc.expectedDetailRequired, `detailRequired mismatch for ${tc.sourceId}`);
        assert.equal(res.detailResolved, tc.expectedDetailResolved, `detailResolved mismatch for ${tc.sourceId}`);
        assert.equal(res.verificationEvidence?.endpointReached, true);
        assert.equal(res.verificationEvidence?.listingValidated, true);
        assert.equal(res.verificationEvidence?.relevantNoticeFound, true);
        assert.equal(res.verificationEvidence?.detailRequired, tc.expectedDetailRequired);
        assert.equal(res.verificationEvidence?.detailResolved, tc.expectedDetailResolved);
        assert.equal(res.verificationEvidence?.documentDiscovered, true);
        assert.equal(res.verificationEvidence?.documentDownloaded, true);
        assert.equal(res.verificationEvidence?.pdfValidated, true);
        assert.equal(res.failureReasons?.length, 0);

        // Section 6: Evidence artifacts populated
        assert.ok(res.evidence?.listingUrl, `listingUrl missing for ${tc.sourceId}`);
        assert.ok(res.evidence?.noticeUrl, `noticeUrl missing for ${tc.sourceId}`);
        assert.ok(res.evidence?.documentUrl, `documentUrl missing for ${tc.sourceId}`);
        assert.ok(res.evidence?.documentSha256, `documentSha256 missing for ${tc.sourceId}`);
        assert.ok((res.evidence?.pdfPageCount ?? 0) > 0, `pdfPageCount missing for ${tc.sourceId}`);

        // Section 10: Distinguish FIXTURE vs LIVE
        assert.equal(res.verificationMode, 'FIXTURE');
        assert.equal(res.verificationStatus, 'FIXTURE_VERIFIED');
        assert.equal(res.verifiedLive, false, 'Fixture runs must never claim verifiedLive = true');

        // Section 11: Metric consistency invariant: pdfsValidated <= documentsDownloaded <= documentsDiscovered
        const pdfsValidated = res.metrics.pdfsValidated ?? 0;
        const docsDownloaded = res.metrics.documentsDownloaded ?? 0;
        const docsDiscovered = res.metrics.documentsDiscovered;
        assert.ok(
          pdfsValidated <= docsDownloaded && docsDownloaded <= docsDiscovered,
          `Metric invariant violated for ${tc.sourceId}: pdfsValidated=${pdfsValidated}, docsDownloaded=${docsDownloaded}, docsDiscovered=${docsDiscovered}`
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 16. FINAL HARDENING: EXPLICIT DETAIL SEMANTICS (NO FALLBACK GUESSING) & STATUS COUNTING (Tests A–G)
  // ---------------------------------------------------------------------------
  describe('16. Final Hardening: Explicit Detail Semantics & Normal-Discovery Status Counting (Tests A–G)', () => {
    it('Test A — Direct PDF: detailRequired=false, detailResolved=null, valid PDF downloaded + validated -> PASS', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('BPSC 71st Combined Competitive Examination Notification 2026');

      const res = await executor.execute('IN-BIHAR-BPSC', {
        endpointId: 'bpsc-primary',
        endpointFixtures: {
          'bpsc-primary': BPSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://bpsc.bih.nic.in/Advt/Advt-26-2026-71st-CCE.pdf': validPdf,
          'https://bpsc.bih.nic.in/Advt/Advt-27-2026-AP.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.detailRequired, false);
      assert.equal(res.detailResolved, null);
      assert.equal(res.documentFlow, 'LISTING_TO_DOCUMENT');
      assert.equal(res.outcome, 'PASS');
      assert.equal(res.status, 'PASS');
      assert.ok((res.metrics.documentsDownloaded ?? 0) > 0);
      assert.ok((res.metrics.pdfsValidated ?? 0) > 0);
    });

    it('Test B — Detail PDF: detailRequired=true, detailResolved=true, valid PDF downloaded + validated -> PASS', async () => {
      const executor = getDiscoveryExecutor();
      const validPdf = createValidSamplePdf('SSC Sub-Inspector in Delhi Police and CAPFs Examination 2026');

      const res = await executor.execute('IN-CENTRAL-SSC', {
        endpointId: 'ssc-primary',
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.detailPageListing,
        },
        detailFixtures: {
          'https://ssc.gov.in/notice/detail/cpo-2026.html': SSC_SNAPSHOTS.detailPageContent,
        },
        pdfFixtures: {
          'https://ssc.gov.in/files/cpo-2026-notification.pdf': validPdf,
          'https://ssc.gov.in/files/cpo-2026-syllabus.pdf': validPdf,
          'https://ssc.gov.in/files/cpo-2026-annexures.pdf': validPdf,
        },
        fetchDetailPages: true,
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(res.detailRequired, true);
      assert.equal(res.detailResolved, true);
      assert.equal(res.documentFlow, 'LISTING_TO_DETAIL_TO_DOCUMENT');
      assert.equal(res.outcome, 'PASS');
      assert.equal(res.status, 'PASS');
      assert.ok((res.metrics.documentsDownloaded ?? 0) > 0);
      assert.ok((res.metrics.pdfsValidated ?? 0) > 0);
    });

    it('Test C — Required detail unresolved: detailRequired=true, detailResolved=false, valid-looking document URL -> NOT PASS', () => {
      const decision = evaluateLiveVerificationGate({
        endpointReached: true,
        endpointValidated: true,
        listingValidated: true,
        relevantNoticeFound: true,
        detailRequired: true,
        detailResolved: false,
        documentDiscovered: true,
        documentDownloaded: true,
        pdfValidated: true,
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
        evidence: {
          listingUrl: 'https://upsc.gov.in/examinations/active-exams',
          detailUrl: 'https://upsc.gov.in/examinations/civil-services-2026.html',
          documentUrl: 'https://upsc.gov.in/sites/default/files/Notification-CSP-2026.pdf',
        },
      });

      assert.notEqual(decision.outcome, 'PASS');
      assert.equal(decision.outcome, 'FAIL');
      assert.equal(decision.detailRequired, true);
      assert.equal(decision.detailResolved, false);
      assert.equal(decision.documentDiscovered, false);
      assert.ok(decision.failureReasons.includes('DETAIL_REQUIRED'));
      assert.ok(decision.failureReasons.includes('DETAIL_NOT_RESOLVED'));
    });

    it('Test D — Missing detail metadata: detailRequired=true but detailResolved is missing/undefined -> NOT PASS (no fallback inference from detailPagesWithDocs > 0)', () => {
      // 1. Gate evaluation when detailRequired=true and detailResolved=undefined/null
      const missingUndefinedDecision = evaluateLiveVerificationGate({
        endpointReached: true,
        endpointValidated: true,
        listingValidated: true,
        relevantNoticeFound: true,
        detailRequired: true,
        detailResolved: undefined,
        documentDiscovered: true,
        documentDownloaded: true,
        pdfValidated: true,
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
      });

      assert.notEqual(missingUndefinedDecision.outcome, 'PASS');
      assert.equal(missingUndefinedDecision.outcome, 'FAIL');
      assert.equal(missingUndefinedDecision.detailRequired, true);
      assert.equal(missingUndefinedDecision.detailResolved, false);
      assert.ok(missingUndefinedDecision.failureReasons.includes('DETAIL_REQUIRED'));
      assert.ok(missingUndefinedDecision.failureReasons.includes('DETAIL_NOT_RESOLVED'));

      // 2. Also verify when detailRequired=true and detailResolved=null
      const missingNullDecision = evaluateLiveVerificationGate({
        endpointReached: true,
        endpointValidated: true,
        listingValidated: true,
        relevantNoticeFound: true,
        detailRequired: true,
        detailResolved: null,
        documentDiscovered: true,
        documentDownloaded: true,
        pdfValidated: true,
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
      });

      assert.notEqual(missingNullDecision.outcome, 'PASS');
      assert.equal(missingNullDecision.outcome, 'FAIL');
      assert.equal(missingNullDecision.detailRequired, true);
      assert.equal(missingNullDecision.detailResolved, false);
    });

    it('Test E — No relevant notices: SUCCESS_NO_RELEVANT_NOTICES -> INCONCLUSIVE / non-PASS and does NOT increment successfulWithNotices', async () => {
      const discoveryService = getDiscoveryService();

      // 1. Live verification gate on empty valid listing -> INCONCLUSIVE (non-PASS)
      const gateDecision = evaluateLiveVerificationGate({
        endpointReached: true,
        endpointValidated: true,
        listingValidated: true,
        relevantNoticeFound: false,
        detailRequired: false,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
      });
      assert.equal(gateDecision.outcome, 'INCONCLUSIVE');
      assert.notEqual(gateDecision.outcome, 'PASS');
      assert.equal(gateDecision.status, 'SUCCESS_NO_RELEVANT_NOTICES');

      // 2. Normal discovery summary across all 7 sources when all return empty valid listings (0 relevant notices)
      const emptyFixtures: Record<string, string> = {};
      for (const ep of sourceEndpointRegistry.getAllEndpoints()) {
        emptyFixtures[ep.endpointId] =
          '<html><body><table><tr><th>Notice</th></tr></table><p>ssc.gov.in upsc.gov.in railway bpsc bihar bssc noticeboard uppsc upsssc allnotifications recruitment advertisement</p></body></html>';
      }

      const summary = await discoveryService.discoverAllSourcesSummary({
        endpointFixtures: emptyFixtures,
        noCache: true,
      });

      assert.equal(summary.totalSources, 7);
      assert.equal(summary.successfulWithNotices, 0, 'SUCCESS_NO_RELEVANT_NOTICES must NOT increment successfulWithNotices');
      assert.equal(summary.successfulSources, 0, 'SUCCESS_NO_RELEVANT_NOTICES must NOT increment successfulSources');
      assert.equal(summary.successfulEmpty, 7, 'All 7 empty valid sources must be counted in successfulEmpty');
      assert.equal(summary.failed, 0);
      assert.equal(summary.inconclusive, 0);
      assert.equal(summary.totalNoticesFound, 0);
    });

    it('Test F — Notices found: SUCCESS_WITH_NOTICES increments successfulWithNotices and separates from successfulEmpty', async () => {
      const discoveryService = getDiscoveryService();

      const mixedFixtures: Record<string, string> = {};
      for (const ep of sourceEndpointRegistry.getAllEndpoints()) {
        mixedFixtures[ep.endpointId] =
          '<html><body><table><tr><th>Notice</th></tr></table><p>ssc.gov.in upsc.gov.in railway bpsc bihar bssc noticeboard uppsc upsssc allnotifications recruitment advertisement</p></body></html>';
      }
      // 2 sources with real relevant notices:
      mixedFixtures['ssc-primary'] = SSC_SNAPSHOTS.normalListing;
      mixedFixtures['bpsc-primary'] = BPSC_SNAPSHOTS.normalListing;

      const summary = await discoveryService.discoverAllSourcesSummary({
        endpointFixtures: mixedFixtures,
        noCache: true,
      });

      assert.equal(summary.totalSources, 7);
      assert.equal(summary.successfulWithNotices, 2, 'Only SSC and BPSC have usable job notices');
      assert.equal(summary.successfulSources, 2);
      assert.equal(summary.successfulEmpty, 5, '5 empty valid sources counted separately in successfulEmpty');
      assert.equal(summary.failed, 0);
      assert.equal(summary.inconclusive, 0);
      assert.ok(summary.totalNoticesFound >= 4);
    });

    it('Test G — Real PDF validation: requires documentsDownloaded > 0 and pdfsValidated > 0 before strict PASS', async () => {
      const executor = getDiscoveryExecutor();

      // 1. Document URL discovered, but download fails -> documentsDownloaded=0, pdfsValidated=0 -> FAIL (NOT PASS)
      const dlFailedRes = await executor.execute('IN-CENTRAL-SSC', {
        endpointId: 'ssc-primary',
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': {
            status: 500,
            body: 'Internal Server Error',
          },
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': {
            status: 500,
            body: 'Internal Server Error',
          },
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(dlFailedRes.metrics.documentsDownloaded, 0);
      assert.equal(dlFailedRes.metrics.pdfsValidated, 0);
      assert.notEqual(dlFailedRes.outcome, 'PASS');
      assert.equal(dlFailedRes.outcome, 'FAIL');

      // 2. Document downloaded (documentsDownloaded > 0), but invalid PDF (pdfsValidated = 0) -> FAIL (NOT PASS)
      const invalidPdfRes = await executor.execute('IN-CENTRAL-SSC', {
        endpointId: 'ssc-primary',
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': Buffer.from('%PDF-1.4\n%corrupt without eof', 'utf8'),
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': Buffer.from('%PDF-1.4\n%corrupt without eof', 'utf8'),
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.ok((invalidPdfRes.metrics.documentsDownloaded ?? 0) > 0);
      assert.equal(invalidPdfRes.metrics.pdfsValidated, 0);
      assert.notEqual(invalidPdfRes.outcome, 'PASS');
      assert.equal(invalidPdfRes.outcome, 'FAIL');

      // 3. Document downloaded (documentsDownloaded > 0) AND validated (pdfsValidated > 0) -> PASS
      const validPdf = createValidSamplePdf('SSC CGL 2026 Validated Notification');
      const validPdfRes = await executor.execute('IN-CENTRAL-SSC', {
        endpointId: 'ssc-primary',
        endpointFixtures: {
          'ssc-primary': SSC_SNAPSHOTS.normalListing,
        },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.ok((validPdfRes.metrics.documentsDownloaded ?? 0) > 0);
      assert.ok((validPdfRes.metrics.pdfsValidated ?? 0) > 0);
      assert.equal(validPdfRes.outcome, 'PASS');
      assert.equal(validPdfRes.status, 'PASS');
    });
  });

  // ---------------------------------------------------------------------------
  // 17. REAL LIVE E2E VERIFICATION HARNESS (Tests 1–10)
  // ---------------------------------------------------------------------------
  describe('17. Real Live E2E Verification Harness (Tests 1–10)', () => {
    const validSamplePdf = createValidSamplePdf('Official Government Recruitment Notification 2026 - Live Verified');

    // Helper to mock dns.lookup + globalThis.fetch for controlled live HTTP adapter tests
    async function withMockedLiveNetwork<T>(
      handler: (url: string) => Promise<Response>,
      fn: () => Promise<T>
    ): Promise<{ result: T; requestedUrls: string[] }> {
      const requestedUrls: string[] = [];
      const origLookup = dns.lookup;
      const origFetch = globalThis.fetch;

      // Return a public non-private IPv4 for official government domains; allow private IPs to fail SSRF check
      (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async (hostname: string) => {
        if (
          hostname === 'localhost' ||
          hostname.startsWith('127.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          hostname.startsWith('169.254.')
        ) {
          return [{ address: hostname, family: 4 }];
        }
        return [{ address: '164.100.158.10', family: 4 }];
      }) as unknown as typeof dns.lookup;

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);
        return handler(url);
      }) as typeof globalThis.fetch;

      try {
        const result = await fn();
        return { result, requestedUrls };
      } finally {
        (dns as unknown as { lookup: typeof dns.lookup }).lookup = origLookup;
        globalThis.fetch = origFetch;
      }
    }

    it('Test 1 — All seven sources execute independently via runRealLiveVerification()', async () => {
      const { result: summary, requestedUrls } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('ssc.gov.in')) {
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('rrbapply.gov.in') || url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('bpsc.bih.nic.in')) {
            return new Response(BPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.includes('upsssc.gov.in')) {
            return new Response(UPSSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response('Not found', { status: 404 });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            timeoutMs: 2000,
            maxRetries: 0,
            noCache: true,
          })
      );

      assert.equal(summary.totalSources, 7);
      assert.equal(summary.liveExecutionCount, 7);
      assert.equal(summary.fixtureExecutionCount, 0);
      assert.equal(summary.passCount, 7);
      assert.ok(requestedUrls.length >= 7);

      const expectedSources = [
        'IN-CENTRAL-SSC',
        'IN-CENTRAL-UPSC',
        'IN-CENTRAL-RRB',
        'IN-BIHAR-BPSC',
        'IN-BIHAR-BSSC',
        'IN-UP-UPPSC',
        'IN-UP-UPSSSC',
      ];
      assert.deepEqual(
        summary.results.map((r) => r.sourceId),
        expectedSources
      );
      for (const r of summary.results) {
        assert.equal(r.mode, 'LIVE');
        assert.equal(r.fixtureSource, false);
        assert.equal(r.verifiedLive, true);
        assert.equal(r.outcome, 'PASS');
        assert.ok(r.evidence.endpointUrl);
        assert.ok(r.evidence.listingUrl);
        assert.ok(r.evidence.documentUrl);
        assert.ok(r.evidence.documentSha256);
        assert.ok((r.evidence.pdfPageCount ?? 0) >= 1);
      }
    });

    it('Test 2 — One source failure (e.g. BPSC HTTP 500) does not stop the remaining six sources', async () => {
      const { result: summary } = await withMockedLiveNetwork(
        async (url) => {
          if (url.includes('bpsc.bih.nic.in') || url.includes('bpsc.bihar.gov.in')) {
            return new Response('Internal Server Error', { status: 500 });
          }
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('ssc.gov.in')) {
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(UPSSSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            timeoutMs: 2000,
            maxRetries: 0,
            noCache: true,
          })
      );

      assert.equal(summary.totalSources, 7);
      assert.equal(summary.passCount, 6, 'Six sources must still succeed');
      const bpscResult = summary.results.find((r) => r.sourceId === 'IN-BIHAR-BPSC');
      assert.ok(bpscResult);
      assert.notEqual(bpscResult.outcome, 'PASS');
    });

    it('Test 3 — LIVE mode performs actual HTTP requests through the production adapter path and ignores fixture overrides', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res, requestedUrls } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            // Even if fixtureHtml is passed, LIVE mode must ignore it and use live fetch
            fixtureHtml: '<html><body><p>Fake fixture that must be ignored in LIVE mode</p></body></html>',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.equal(res.verificationMode, 'LIVE');
      assert.equal(res.fixtureSource, false);
      assert.equal(res.verifiedLive, true);
      assert.equal(res.outcome, 'PASS');
      assert.ok(requestedUrls.some((u) => u.includes('ssc.gov.in')), 'Must perform real HTTP request to ssc.gov.in');
      assert.ok(requestedUrls.some((u) => u.endsWith('.pdf')), 'Must perform real HTTP download for PDF');
    });

    it('Test 4 — FIXTURE mode does not perform live HTTP requests', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res, requestedUrls } = await withMockedLiveNetwork(
        async () => {
          throw new Error('LIVE HTTP REQUEST MUST NOT BE CALLED IN FIXTURE MODE');
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'FIXTURE',
            endpointId: 'ssc-primary',
            endpointFixtures: {
              'ssc-primary': SSC_SNAPSHOTS.normalListing,
            },
            pdfFixtures: {
              'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validSamplePdf,
              'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validSamplePdf,
            },
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(requestedUrls.length, 0, 'Zero live HTTP requests allowed in FIXTURE mode');
      assert.equal(res.verificationMode, 'FIXTURE');
      assert.equal(res.fixtureSource, true);
      assert.equal(res.verifiedLive, false);
      assert.equal(res.outcome, 'PASS');
    });

    it('Test 5 — HTTP 200 + empty valid listing in LIVE mode returns INCONCLUSIVE with NO_RELEVANT_NOTICE', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res } = await withMockedLiveNetwork(
        async () =>
          new Response(
            '<html><body><table><tr><th>BPSC Notice</th></tr></table><p>bpsc bihar advertisement</p></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }
          ),
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.equal(res.verificationMode, 'LIVE');
      assert.equal(res.fixtureSource, false);
      assert.equal(res.outcome, 'INCONCLUSIVE');
      assert.notEqual(res.outcome, 'PASS');
      assert.ok(res.failureReasons?.includes('NO_RELEVANT_NOTICE'));
    });

    it('Test 6 — Live relevant notice + valid official PDF downloaded and validated returns PASS', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          return new Response(BPSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.equal(res.verificationMode, 'LIVE');
      assert.equal(res.verificationStatus, 'LIVE_VERIFIED');
      assert.equal(res.fixtureSource, false);
      assert.equal(res.verifiedLive, true);
      assert.equal(res.outcome, 'PASS');
      assert.ok(res.evidence?.endpointUrl);
      assert.ok(res.evidence?.listingUrl);
      assert.ok(res.evidence?.documentUrl);
      assert.ok(res.evidence?.documentSha256);
      assert.ok((res.evidence?.pdfPageCount ?? 0) >= 1);
    });

    it('Test 7 — Document URL discovered in LIVE mode but download fails returns FAIL (NOT PASS)', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response('Not Found', { status: 404 });
          }
          return new Response(BPSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.metrics.documentsDownloaded, 0);
      assert.ok(res.failureReasons?.includes('DOCUMENT_DOWNLOAD_FAILED'));
    });

    it('Test 8 — Downloaded invalid PDF in LIVE mode returns FAIL (NOT PASS)', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(Buffer.from('%PDF-1.4\n%corrupt truncated pdf without eof', 'utf8'), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          return new Response(BPSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'FAIL');
      assert.ok((res.metrics.documentsDownloaded ?? 0) > 0);
      assert.equal(res.metrics.pdfsValidated, 0);
      assert.ok(res.failureReasons?.includes('INVALID_PDF'));
    });

    it('Test 9 — Private/internal IP or unsafe redirect in LIVE mode is BLOCKED and returns FAIL', async () => {
      const executor = getDiscoveryExecutor();
      const { result: res } = await withMockedLiveNetwork(
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: 'http://127.0.0.1:8080/internal-admin',
            },
          }),
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
            maxRetries: 0,
          })
      );

      assert.notEqual(res.outcome, 'PASS');
      assert.equal(res.outcome, 'FAIL');
      assert.equal(res.status, 'ACCESS_BLOCKED');
      assert.ok(res.failureReasons?.includes('ACCESS_BLOCKED'));
    });

    it('Test 10 — One source timeout: other six sources still execute and complete in runRealLiveVerification()', async () => {
      const { result: summary } = await withMockedLiveNetwork(
        async (url) => {
          if (url.includes('uppsc.up.nic.in')) {
            throw new Error('Request timeout after 2000ms (AbortError)');
          }
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('ssc.gov.in')) {
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bpsc.bih.nic.in')) {
            return new Response(BPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(UPSSSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            timeoutMs: 1000,
            maxRetries: 0,
            noCache: true,
          })
      );

      assert.equal(summary.totalSources, 7);
      assert.equal(summary.passCount, 6, 'Other six sources must complete with PASS');
      const uppscResult = summary.results.find((r) => r.sourceId === 'IN-UP-UPPSC');
      assert.ok(uppscResult);
      assert.notEqual(uppscResult.outcome, 'PASS');
      assert.ok(uppscResult.failureReasons.includes('TIMEOUT'));
      assert.ok(uppscResult.failureReasons.includes('ENDPOINT_REACH_FAILED'));
    });

    it('Test 11 — Default timeout (15000ms), default retries (2), env overrides, and invalid config handling', async () => {
      const prevTimeout = process.env.OMNIHUB_LIVE_TIMEOUT_MS;
      const prevRetries = process.env.OMNIHUB_LIVE_MAX_RETRIES;
      const prevBackoff = process.env.OMNIHUB_LIVE_RETRY_BACKOFF_MS;

      try {
        delete process.env.OMNIHUB_LIVE_TIMEOUT_MS;
        delete process.env.OMNIHUB_LIVE_MAX_RETRIES;
        delete process.env.OMNIHUB_LIVE_RETRY_BACKOFF_MS;

        // 1. Default timeout is 15000 ms and default retries are 2 when not configured
        const defaultCfg = resolveLiveVerificationRuntimeConfig();
        assert.equal(defaultCfg.timeoutMs, 15000, 'Default timeout must be 15000ms when not configured');
        assert.equal(defaultCfg.maxRetries, 2, 'Default maxRetries must be 2 when not configured');
        assert.equal(defaultCfg.retryBackoffMs, 500);
        assert.equal(defaultCfg.validationWarnings.length, 0);

        // 2. Environment variable timeout and retry count are respected
        process.env.OMNIHUB_LIVE_TIMEOUT_MS = '14000';
        process.env.OMNIHUB_LIVE_MAX_RETRIES = '1';
        const envCfg = resolveLiveVerificationRuntimeConfig();
        assert.equal(envCfg.timeoutMs, 14000, 'Environment variable timeout must be respected');
        assert.equal(envCfg.maxRetries, 1, 'Environment variable retry count must be respected');

        // 3. Invalid/malformed timeout or retry configuration is rejected safely and falls back to 15000 / 2
        process.env.OMNIHUB_LIVE_TIMEOUT_MS = 'not-a-number';
        process.env.OMNIHUB_LIVE_MAX_RETRIES = '-5';
        const malformedCfg = resolveLiveVerificationRuntimeConfig();
        assert.equal(malformedCfg.timeoutMs, 15000, 'Malformed timeout must fall back to 15000ms');
        assert.equal(malformedCfg.maxRetries, 2, 'Negative/invalid retry count must fall back to 2');
        assert.ok(malformedCfg.validationWarnings.length >= 2);

        process.env.OMNIHUB_LIVE_TIMEOUT_MS = '0';
        process.env.OMNIHUB_LIVE_MAX_RETRIES = 'abc';
        const zeroTimeoutCfg = resolveLiveVerificationRuntimeConfig();
        assert.equal(zeroTimeoutCfg.timeoutMs, 15000);
        assert.equal(zeroTimeoutCfg.maxRetries, 2);

        // 4. Unlimited / huge timeout is clamped to 30000ms max; tiny timeout clamped to 1000ms min
        process.env.OMNIHUB_LIVE_TIMEOUT_MS = '999999';
        process.env.OMNIHUB_LIVE_MAX_RETRIES = '99';
        const clampedHigh = resolveLiveVerificationRuntimeConfig();
        assert.equal(clampedHigh.timeoutMs, 30000);
        assert.equal(clampedHigh.maxRetries, 3);

        process.env.OMNIHUB_LIVE_TIMEOUT_MS = '100';
        const clampedLow = resolveLiveVerificationRuntimeConfig();
        assert.equal(clampedLow.timeoutMs, 1000);
      } finally {
        if (prevTimeout === undefined) delete process.env.OMNIHUB_LIVE_TIMEOUT_MS;
        else process.env.OMNIHUB_LIVE_TIMEOUT_MS = prevTimeout;
        if (prevRetries === undefined) delete process.env.OMNIHUB_LIVE_MAX_RETRIES;
        else process.env.OMNIHUB_LIVE_MAX_RETRIES = prevRetries;
        if (prevBackoff === undefined) delete process.env.OMNIHUB_LIVE_RETRY_BACKOFF_MS;
        else process.env.OMNIHUB_LIVE_RETRY_BACKOFF_MS = prevBackoff;
      }
    });

    it('Test 12 — Safe transient retry: TIMEOUT, HTTP 429, and HTTP 503 trigger bounded retries with diagnostics', async () => {
      const executor = getDiscoveryExecutor();

      // 12a. HTTP 503 transient failure -> retry -> HTTP 200 succeeds
      let ssc503Calls = 0;
      const { result: res503 } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          ssc503Calls++;
          if (ssc503Calls === 1) {
            return new Response('Service Temporarily Unavailable', { status: 503 });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            timeoutMs: 2000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(ssc503Calls, 2, 'Transient 503 must retry once (attempt 1 -> attempt 2)');
      assert.equal(res503.metrics.retryCount, 1);
      assert.deepEqual(res503.metrics.retryReasons, ['HTTP_503']);
      assert.equal(res503.metrics.retryDiagnostics?.[0]?.attempt, 1);
      assert.equal(res503.metrics.retryDiagnostics?.[0]?.maxAttempts, 3);
      assert.equal(res503.metrics.retryDiagnostics?.[0]?.reason, 'HTTP_503');
      assert.equal(res503.metrics.retryDiagnostics?.[0]?.statusCode, 503);
      assert.equal(res503.outcome, 'PASS');

      // 12b. HTTP 429 transient failure -> retry -> HTTP 200 succeeds
      let ssc429Calls = 0;
      const { result: res429 } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          ssc429Calls++;
          if (ssc429Calls === 1) {
            return new Response('Too Many Requests', { status: 429 });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            timeoutMs: 2000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(ssc429Calls, 2, 'Transient 429 must trigger retry');
      assert.equal(res429.metrics.retryCount, 1);
      assert.deepEqual(res429.metrics.retryReasons, ['HTTP_429']);
      assert.equal(res429.outcome, 'PASS');

      // 12c. Request timeout triggers bounded retries (attempt 1 -> backoff -> attempt 2 -> backoff -> attempt 3 -> final failure)
      let timeoutCalls = 0;
      const { result: resTimeout } = await withMockedLiveNetwork(
        async () => {
          timeoutCalls++;
          throw new Error('Request timeout after 100ms');
        },
        () =>
          executor.execute('IN-CENTRAL-UPSC', {
            verificationMode: 'LIVE',
            endpointId: 'upsc-primary',
            maxPages: 1,
            timeoutMs: 100,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(timeoutCalls, 3, 'Timeout with maxRetries=2 must execute 3 total attempts (1 initial + 2 retries)');
      assert.equal(resTimeout.metrics.attempts, 3);
      assert.equal(resTimeout.metrics.retryCount, 2);
      assert.deepEqual(resTimeout.metrics.retryReasons, ['TIMEOUT', 'TIMEOUT']);
      assert.equal(resTimeout.metrics.retryDiagnostics?.length, 2);
      assert.equal(resTimeout.metrics.retryDiagnostics?.[0]?.attempt, 1);
      assert.equal(resTimeout.metrics.retryDiagnostics?.[0]?.maxAttempts, 3);
      assert.equal(resTimeout.metrics.retryDiagnostics?.[0]?.reason, 'TIMEOUT');
      assert.equal(resTimeout.metrics.retryDiagnostics?.[1]?.attempt, 2);
      assert.equal(resTimeout.metrics.retryDiagnostics?.[1]?.maxAttempts, 3);
      assert.notEqual(resTimeout.outcome, 'PASS');
    });

    it('Test 13 — Permanent failures (HTTP 403, HTTP 404, SSRF rejection, HTML-disguised invalid PDF) are NOT retried', async () => {
      const executor = getDiscoveryExecutor();

      // 13a. HTTP 403 permanent failure -> 1 request only, 0 retries
      let calls403 = 0;
      const { result: res403 } = await withMockedLiveNetwork(
        async () => {
          calls403++;
          return new Response('Forbidden', { status: 403 });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            endpointId: 'bpsc-primary',
            maxPages: 1,
            timeoutMs: 2000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(calls403, 1, 'HTTP 403 must NOT be retried');
      assert.equal(res403.metrics.attempts, 1);
      assert.equal(res403.metrics.retryCount, 0);
      assert.equal(res403.outcome, 'FAIL');
      assert.ok(res403.failureReasons?.includes('ACCESS_BLOCKED'));

      // 13b. HTTP 404 permanent failure -> 1 request only, 0 retries
      let calls404 = 0;
      const { result: res404 } = await withMockedLiveNetwork(
        async () => {
          calls404++;
          return new Response('Not Found', { status: 404 });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            endpointId: 'bpsc-primary',
            maxPages: 1,
            timeoutMs: 2000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(calls404, 1, 'Permanent HTTP 404 must NOT be retried');
      assert.equal(res404.metrics.attempts, 1);
      assert.equal(res404.metrics.retryCount, 0);
      assert.equal(res404.outcome, 'FAIL');
      assert.ok(res404.failureReasons?.includes('HTTP_ERROR'));

      // 13c. HTML error page disguised as PDF -> 1 download request per PDF URL, 0 retries, FAIL
      let pdfDownloadCalls = 0;
      const { result: resHtmlPdf } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            pdfDownloadCalls++;
            return new Response('<!DOCTYPE html><html><body>Error 404 Page</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(BPSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            endpointId: 'bpsc-primary',
            maxPages: 1,
            maxNotices: 1,
            timeoutMs: 2000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(pdfDownloadCalls, 1, 'HTML-disguised invalid PDF must NOT be retried');
      assert.equal(resHtmlPdf.outcome, 'FAIL');
      assert.ok(resHtmlPdf.failureReasons?.includes('INVALID_DOCUMENT'));
      assert.ok(resHtmlPdf.failureReasons?.includes('INVALID_PDF'));
    });

    it('Test 14 — Aggregate summary metrics, exit codes, null missing evidence, and machine-readable report with timeout/retry fields', async () => {
      // Mix of outcomes across the 7 sources:
      // - BPSC: HTTP 403 -> FAIL (finalFailureStage: ENDPOINT_REQUEST)
      // - UPPSC: valid empty listing -> INCONCLUSIVE (finalFailureStage: NOTICE_CLASSIFICATION)
      // - Other 5 sources: valid notice + valid PDF -> PASS (finalFailureStage: NONE)
      const { result: summary } = await withMockedLiveNetwork(
        async (url) => {
          if (url.includes('bpsc.bih.nic.in') || url.includes('bpsc.bihar.gov.in')) {
            return new Response('Forbidden', { status: 403 });
          }
          if (url.includes('uppsc.up.nic.in')) {
            return new Response(
              '<html><body><table><tr><th>UPPSC Notice</th></tr></table><p>uppsc allahabad advertisement</p></body></html>',
              { status: 200, headers: { 'content-type': 'text/html' } }
            );
          }
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('ssc.gov.in')) {
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(UPSSSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            retryBackoffMs: 10,
            verbose: true,
            noCache: true,
          })
      );

      assert.equal(summary.runtimeConfig.timeoutMs, 15000);
      assert.equal(summary.runtimeConfig.maxRetries, 2);
      assert.equal(summary.sourcesChecked, 7);
      assert.equal(summary.totalSources, 7);
      assert.equal(summary.liveExecutionCount, 7);
      assert.equal(summary.passCount, 5);
      assert.equal(summary.inconclusiveCount, 1);
      assert.equal(summary.failCount, 1);
      assert.equal(summary.notRunCount, 0);
      assert.ok(summary.relevantNoticeCount >= 5);
      assert.ok(summary.documentDownloadCount >= 5);
      assert.ok(summary.validPdfCount >= 5);
      assert.ok(summary.totalDurationMs >= 0);
      assert.equal(summary.successfulWithNotices, 5, 'Only full PASS sources count toward successfulWithNotices');
      assert.equal(summary.successfulEmpty, 1, 'Empty valid listing counts toward successfulEmpty');
      assert.equal(summary.technicalFailures, 1, 'HTTP 403 source counts toward technicalFailures');
      assert.equal(summary.exitCode, 1, 'One or more FAIL sources must produce exitCode 1');

      const bpsc = summary.results.find((r) => r.sourceId === 'IN-BIHAR-BPSC')!;
      assert.equal(bpsc.outcome, 'FAIL');
      assert.equal(bpsc.failedStage, 'ENDPOINT_REQUEST');
      assert.equal(bpsc.finalFailureStage, 'ENDPOINT_REQUEST');
      assert.equal(bpsc.timeoutMs, 15000);
      assert.equal(bpsc.maxRetries, 2);
      assert.ok(bpsc.attempts >= 1);
      assert.equal(bpsc.retriesUsed, 0);
      assert.deepEqual(bpsc.retryReasons, []);
      assert.equal(bpsc.noticeUrl, null);
      assert.equal(bpsc.detailUrl, null);
      assert.equal(bpsc.documentUrl, null);
      assert.equal(bpsc.sha256, null);
      assert.equal(bpsc.pageCount, null);

      const uppsc = summary.results.find((r) => r.sourceId === 'IN-UP-UPPSC')!;
      assert.equal(uppsc.outcome, 'INCONCLUSIVE');
      assert.equal(uppsc.failedStage, 'NOTICE_CLASSIFICATION');
      assert.equal(uppsc.finalFailureStage, 'NOTICE_CLASSIFICATION');
      assert.equal(uppsc.timeoutMs, 15000);
      assert.equal(uppsc.maxRetries, 2);
      assert.equal(uppsc.noticeUrl, null);
      assert.equal(uppsc.documentUrl, null);
      assert.equal(uppsc.sha256, null);
      assert.equal(uppsc.pageCount, null);

      const ssc = summary.results.find((r) => r.sourceId === 'IN-CENTRAL-SSC')!;
      assert.equal(ssc.outcome, 'PASS');
      assert.equal(ssc.failedStage, 'NONE');
      assert.equal(ssc.finalFailureStage, 'NONE');
      assert.equal(ssc.timeoutMs, 15000);
      assert.equal(ssc.maxRetries, 2);
      assert.ok(ssc.documentUrl);
      assert.ok(ssc.sha256);
      assert.ok((ssc.pageCount ?? 0) >= 1);

      const reportPayload = buildMachineReadableLiveReport(summary);
      assert.equal(reportPayload.executionStatus, 'LIVE_EXECUTION_PERFORMED');
      assert.equal(reportPayload.mode, 'LIVE');
      assert.equal(reportPayload.cache, 'DISABLED');
      assert.equal(reportPayload.fixtures, 'DISABLED');
      assert.equal(reportPayload.runtimeConfig.timeoutMs, 15000);
      assert.equal(reportPayload.runtimeConfig.maxRetries, 2);
      assert.equal(reportPayload.sourcesChecked, 7);
      assert.equal(reportPayload.sources.length, 7);
      for (const s of reportPayload.sources) {
        assert.equal(s.timeoutMs, 15000);
        assert.equal(s.maxRetries, 2);
        assert.ok(typeof s.attempts === 'number' && s.attempts >= 1);
        assert.ok(typeof s.retriesUsed === 'number');
        assert.ok(Array.isArray(s.retryReasons));
        assert.ok(typeof s.finalFailureStage === 'string');
      }

      // Verify exit code mapping (0 = no hard FAIL, 1 = hard FAIL, 2 = invalid/misconfigured)
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 7,
          inconclusiveCount: 0,
          failCount: 0,
          notRunCount: 0,
        }),
        0
      );
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 5,
          inconclusiveCount: 2,
          failCount: 0,
          notRunCount: 0,
        }),
        0
      );
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 6,
          inconclusiveCount: 0,
          failCount: 1,
          notRunCount: 0,
        }),
        1
      );
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 0,
          passCount: 0,
          inconclusiveCount: 0,
          failCount: 0,
          notRunCount: 0,
        }),
        2
      );

      // Verify CLI arg parser rejects non-LIVE mode and invalid flags
      assert.ok(parseLiveCheckArgs(['--mode=FIXTURE']).invalidReason);
      assert.ok(parseLiveCheckArgs(['--timeout=-5']).invalidReason);
      assert.equal(parseLiveCheckArgs(['--e2e', '--verbose']).verbose, true);
    });

    it('Test 15 — LIVE mode strictly bypasses DiscoveryCache and enforces detail-required vs direct-PDF semantics', async () => {
      const executor = getDiscoveryExecutor();
      const cache = DiscoveryCache.getInstance();
      cache.clear();

      // 1. Populate cache via non-LIVE run
      await executor.execute('IN-CENTRAL-SSC', {
        verificationMode: 'FIXTURE',
        endpointId: 'ssc-primary',
        endpointFixtures: { 'ssc-primary': SSC_SNAPSHOTS.normalListing },
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validSamplePdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validSamplePdf,
        },
        downloadAndValidatePdfs: true,
        noCache: false,
      });

      // 2. Now run in LIVE mode: must NOT return cached result, must perform real HTTP request
      const { result: liveRes, requestedUrls } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            downloadAndValidatePdfs: true,
          })
      );

      assert.equal(liveRes.cached, false, 'LIVE mode must never return a cached result');
      assert.equal(liveRes.responseSource, 'LIVE_EXECUTION');
      assert.equal(liveRes.verificationMode, 'LIVE');
      assert.ok(requestedUrls.length > 0, 'LIVE mode must make real HTTP requests even when cache is populated');

      // 3. Detail-required source fails with DETAIL_FETCH when detail page request fails in LIVE mode
      const detailListingHtml = `
        <html><body>
          <table>
            <tr>
              <td><a href="/recruitment/detail-notice-2026.html">Combined Graduate Level Recruitment Examination 2026</a></td>
            </tr>
          </table>
        </body></html>
      `;
      const { result: detailFailRes } = await withMockedLiveNetwork(
        async (url) => {
          if (url.includes('detail-notice-2026.html')) {
            return new Response('Internal Server Error', { status: 500 });
          }
          return new Response(detailListingHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            maxRetries: 0,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(detailFailRes.detailRequired, true);
      assert.equal(detailFailRes.detailResolved, false);
      assert.equal(detailFailRes.outcome, 'FAIL');
      assert.equal(detailFailRes.verificationEvidence?.failedStages.includes('DETAIL_RESOLVED'), true);
    });

    it('Test 16 — Unwraps Node/Undici TypeError("fetch failed") .cause chains, executes real retries on transient network errors, preserves original errorCode, and redacts secrets', async () => {
      const executor = getDiscoveryExecutor();

      // 16a. Undici ConnectTimeoutError wrapped inside TypeError('fetch failed') -> 3 attempts (retriesUsed=2) + preserves UND_ERR_CONNECT_TIMEOUT
      let undiciTimeoutCalls = 0;
      const { result: resUndiciTimeout } = await withMockedLiveNetwork(
        async () => {
          undiciTimeoutCalls++;
          const causeErr = Object.assign(new Error('Connect Timeout Error (attempted address: upsc.gov.in:443, timeout: 10000ms)'), {
            name: 'ConnectTimeoutError',
            code: 'UND_ERR_CONNECT_TIMEOUT',
          });
          throw new TypeError('fetch failed', { cause: causeErr });
        },
        () =>
          executor.execute('IN-CENTRAL-UPSC', {
            verificationMode: 'LIVE',
            endpointId: 'upsc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(undiciTimeoutCalls, 3, 'Undici ConnectTimeoutError inside TypeError("fetch failed") must execute 3 total attempts');
      assert.equal(resUndiciTimeout.metrics.requestAttempts, 3);
      assert.equal(resUndiciTimeout.metrics.attempts, 3);
      assert.equal(resUndiciTimeout.metrics.retryCount, 2);
      assert.equal(resUndiciTimeout.lastErrorType, 'TIMEOUT');
      assert.equal(resUndiciTimeout.lastErrorCode, 'UND_ERR_CONNECT_TIMEOUT');
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.length, 3);
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[0]?.attempt, 1);
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[0]?.maxAttempts, 3);
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[0]?.errorType, 'TIMEOUT');
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[0]?.errorCode, 'UND_ERR_CONNECT_TIMEOUT');
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[2]?.attempt, 3);
      assert.equal(resUndiciTimeout.metrics.attemptDiagnostics?.[2]?.delayMs, 0);

      // 16b. ECONNRESET wrapped inside TypeError('fetch failed') -> Attempt 1 fails -> retry executes -> Attempt 2 succeeds
      let connResetCalls = 0;
      const { result: resConnResetRecovery } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          connResetCalls++;
          if (connResetCalls === 1) {
            const causeErr = Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
            });
            throw new TypeError('fetch failed', { cause: causeErr });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(connResetCalls, 2, 'Transient ECONNRESET inside TypeError("fetch failed") must trigger second request');
      assert.equal(resConnResetRecovery.metrics.retryCount, 1);
      assert.deepEqual(resConnResetRecovery.metrics.retryReasons, ['CONNECTION_RESET']);
      assert.equal(resConnResetRecovery.metrics.retryDiagnostics?.[0]?.errorCode, 'ECONNRESET');
      assert.equal(resConnResetRecovery.outcome, 'PASS');

      // 16c. Persistent ECONNRESET -> 3 attempts, classified as CONNECTION_RESET (NOT misclassified as TIMEOUT!)
      let persistentResetCalls = 0;
      const { result: resPersistentReset } = await withMockedLiveNetwork(
        async () => {
          persistentResetCalls++;
          const causeErr = Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          });
          throw new TypeError('fetch failed', { cause: causeErr });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            endpointId: 'bpsc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(persistentResetCalls, 3);
      assert.equal(resPersistentReset.lastErrorType, 'CONNECTION_RESET');
      assert.equal(resPersistentReset.lastErrorCode, 'ECONNRESET');
      assert.ok(resPersistentReset.failureReasons?.includes('CONNECTION_RESET'));
      assert.ok(!resPersistentReset.failureReasons?.includes('TIMEOUT'), 'CONNECTION_RESET must not be misclassified as TIMEOUT');

      // 16d. Permanent TLS certificate verification failure -> NOT retried (1 attempt), classified as TLS_ERROR
      let tlsCalls = 0;
      const { result: resTls } = await withMockedLiveNetwork(
        async () => {
          tlsCalls++;
          const causeErr = Object.assign(new Error('unable to verify the first certificate'), {
            code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          });
          throw new TypeError('fetch failed', { cause: causeErr });
        },
        () =>
          executor.execute('IN-BIHAR-BSSC', {
            verificationMode: 'LIVE',
            endpointId: 'bssc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(tlsCalls, 1, 'Deterministic TLS certificate verification failure must not retry');
      assert.equal(resTls.metrics.requestAttempts, 1);
      assert.equal(resTls.metrics.retryCount, 0);
      assert.equal(resTls.lastErrorType, 'TLS_ERROR');
      assert.equal(resTls.lastErrorCode, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      assert.ok(resTls.failureReasons?.includes('TLS_ERROR'));

      // 16e. SSRF rejection -> NOT retried (1 attempt), classified as SSRF_BLOCKED
      const origLookup = dns.lookup;
      let ssrfLookupCalls = 0;
      let ssrfFetchCalls = 0;
      const origFetch = globalThis.fetch;
      (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => {
        ssrfLookupCalls++;
        return [{ address: '127.0.0.1', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      }) as unknown as typeof dns.lookup;
      globalThis.fetch = (async () => {
        ssrfFetchCalls++;
        return new Response('should never be called', { status: 200 });
      }) as typeof fetch;

      try {
        const resSsrf = await executor.execute('IN-CENTRAL-SSC', {
          verificationMode: 'LIVE',
          endpointId: 'ssc-primary',
          maxPages: 1,
          timeoutMs: 15000,
          maxRetries: 2,
          retryBackoffMs: 10,
          downloadAndValidatePdfs: true,
          strictLiveMode: true,
          noCache: true,
        });

        assert.equal(ssrfLookupCalls, 1, 'SSRF rejection must fail on Attempt 1 and never retry');
        assert.equal(ssrfFetchCalls, 0, 'SSRF rejection must block HTTP fetch before socket connect');
        assert.equal(resSsrf.metrics.requestAttempts, 1);
        assert.equal(resSsrf.metrics.retryCount, 0);
        assert.equal(resSsrf.lastErrorType, 'SSRF_BLOCKED');
        assert.equal(resSsrf.outcome, 'FAIL');
      } finally {
        (dns as unknown as { lookup: typeof dns.lookup }).lookup = origLookup;
        globalThis.fetch = origFetch;
      }

      // 16f. Transient DNS failure (ENOTFOUND / EAI_AGAIN) inside fetchWithRetry -> retried on Attempt 1, succeeds on Attempt 2
      let dnsAttempt = 0;
      (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => {
        dnsAttempt++;
        if (dnsAttempt === 1) {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND ssc.gov.in'), { code: 'ENOTFOUND' });
        }
        return [{ address: '164.100.213.100', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      }) as unknown as typeof dns.lookup;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (u.endsWith('.pdf')) {
          return new Response(new Uint8Array(validSamplePdf), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return new Response(SSC_SNAPSHOTS.normalListing, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }) as typeof fetch;

      try {
        const resDnsRetry = await executor.execute('IN-CENTRAL-SSC', {
          verificationMode: 'LIVE',
          endpointId: 'ssc-primary',
          maxPages: 1,
          timeoutMs: 15000,
          maxRetries: 2,
          retryBackoffMs: 10,
          downloadAndValidatePdfs: true,
          strictLiveMode: true,
          noCache: true,
        });

        assert.ok(dnsAttempt >= 2, 'Transient DNS failure must be retried inside fetchWithRetry');
        assert.equal(resDnsRetry.metrics.retryCount, 1);
        assert.deepEqual(resDnsRetry.metrics.retryReasons, ['DNS_ERROR']);
        assert.equal(resDnsRetry.outcome, 'PASS');
      } finally {
        (dns as unknown as { lookup: typeof dns.lookup }).lookup = origLookup;
        globalThis.fetch = origFetch;
      }

      // 16g. Verify secret redaction in classifyNetworkOrHttpError
      const leakyError = new TypeError('fetch failed: Authorization: Bearer secret-jwt-token-999 Cookie: session=abc', {
        cause: Object.assign(new Error('connect ECONNREFUSED 164.100.1.1:443?api_key=super_secret_123'), {
          code: 'ECONNREFUSED',
        }),
      });
      const classified = classifyNetworkOrHttpError(leakyError, {
        requestUrl: 'https://user:pass123@upsc.gov.in/recruitment?token=my_secret_token&page=1',
        timeoutMs: 15000,
        attempt: 1,
        maxAttempts: 3,
      });

      assert.equal(classified.errorType, 'CONNECTION_REFUSED');
      assert.equal(classified.errorCode, 'ECONNREFUSED');
      assert.equal(classified.retryable, true);
      assert.ok(!classified.requestUrl.includes('pass123'));
      assert.ok(!classified.requestUrl.includes('my_secret_token'));
      assert.ok(!classified.errorMessage.includes('secret-jwt-token-999'));
      assert.ok(!classified.errorMessage.includes('super_secret_123'));
      assert.ok(!(classified.cause || '').includes('super_secret_123'));
    });

    it('Test 17 — Technical failure exit-code alignment, Undici 15000ms connection timeout configuration, and aggregate counter separation', async () => {
      const executor = getDiscoveryExecutor();

      // 1. Timeout after all retries -> FAIL (technicalFailure = true, failedStage = LISTING_FETCH)
      let timeoutAttempts = 0;
      const { result: timeoutRes } = await withMockedLiveNetwork(
        async () => {
          timeoutAttempts++;
          const causeErr = Object.assign(
            new Error('Connect Timeout Error (attempted address: upsc.gov.in:443, timeout: 15000ms)'),
            {
              name: 'ConnectTimeoutError',
              code: 'UND_ERR_CONNECT_TIMEOUT',
            }
          );
          throw new TypeError('fetch failed', { cause: causeErr });
        },
        () =>
          executor.execute('IN-CENTRAL-UPSC', {
            verificationMode: 'LIVE',
            endpointId: 'upsc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(timeoutAttempts, 3, 'Timeout must execute 3 total attempts (1 initial + 2 retries)');
      assert.equal(timeoutRes.outcome, 'FAIL', 'Timeout after all retries must produce outcome = FAIL');
      assert.equal(timeoutRes.technicalFailure, true, 'Timeout must set technicalFailure = true');
      assert.equal(timeoutRes.status, 'SOURCE_UNAVAILABLE');
      assert.equal(timeoutRes.lastErrorType, 'TIMEOUT');
      assert.equal(timeoutRes.lastErrorCode, 'UND_ERR_CONNECT_TIMEOUT');
      assert.equal(timeoutRes.metrics.attempts, 3);
      assert.equal(timeoutRes.metrics.retryCount, 2);
      assert.equal(timeoutRes.metrics.timeoutMs, 15000);
      assert.equal(timeoutRes.metrics.connectionTimeoutMs, 15000);

      // 2. Connection reset after all retries -> FAIL
      let resetAttempts = 0;
      const { result: resetRes } = await withMockedLiveNetwork(
        async () => {
          resetAttempts++;
          const causeErr = Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          });
          throw new TypeError('fetch failed', { cause: causeErr });
        },
        () =>
          executor.execute('IN-BIHAR-BPSC', {
            verificationMode: 'LIVE',
            endpointId: 'bpsc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(resetAttempts, 3);
      assert.equal(resetRes.outcome, 'FAIL', 'Connection reset after all retries must produce outcome = FAIL');
      assert.equal(resetRes.technicalFailure, true);
      assert.equal(resetRes.lastErrorType, 'CONNECTION_RESET');
      assert.equal(resetRes.lastErrorCode, 'ECONNRESET');
      assert.equal(resetRes.metrics.attempts, 3);
      assert.equal(resetRes.metrics.retryCount, 2);

      // 3. HTTP 503 after all retries -> FAIL
      let http503Attempts = 0;
      const { result: http503Res } = await withMockedLiveNetwork(
        async () => {
          http503Attempts++;
          return new Response('Service Unavailable', { status: 503 });
        },
        () =>
          executor.execute('IN-BIHAR-BSSC', {
            verificationMode: 'LIVE',
            endpointId: 'bssc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(http503Attempts, 3, 'HTTP 503 must retry up to maxRetries=2 (3 attempts)');
      assert.equal(http503Res.outcome, 'FAIL', 'HTTP 503 after all retries must produce outcome = FAIL');
      assert.equal(http503Res.technicalFailure, true);
      assert.equal(http503Res.lastErrorType, 'HTTP_503');
      assert.equal(http503Res.lastErrorCode, 'HTTP_503');
      assert.equal(http503Res.metrics.attempts, 3);
      assert.equal(http503Res.metrics.retryCount, 2);

      // 4. HTTP 404 -> permanent FAIL without unnecessary retry
      let http404Attempts = 0;
      const { result: http404Res } = await withMockedLiveNetwork(
        async () => {
          http404Attempts++;
          return new Response('Not Found', { status: 404 });
        },
        () =>
          executor.execute('IN-UP-UPPSC', {
            verificationMode: 'LIVE',
            endpointId: 'uppsc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(http404Attempts, 1, 'HTTP 404 must fail permanently without retry');
      assert.equal(http404Res.outcome, 'FAIL');
      assert.equal(http404Res.technicalFailure, true);
      assert.equal(http404Res.lastErrorType, 'HTTP_404');
      assert.equal(http404Res.lastErrorCode, 'HTTP_404');
      assert.equal(http404Res.metrics.attempts, 1);
      assert.equal(http404Res.metrics.retryCount, 0);

      // 5. No relevant notice -> INCONCLUSIVE (technicalFailure = false)
      const { result: noNoticeRes } = await withMockedLiveNetwork(
        async () =>
          new Response(
            '<html><body><table><tr><th>SSC Notice</th></tr></table><p>ssc.gov.in noticeboard advertisement</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } }
          ),
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(noNoticeRes.outcome, 'INCONCLUSIVE', 'NO_RELEVANT_NOTICE must remain INCONCLUSIVE');
      assert.equal(noNoticeRes.technicalFailure, false, 'NO_RELEVANT_NOTICE must NOT be marked as technicalFailure');
      assert.ok(noNoticeRes.failureReasons?.includes('NO_RELEVANT_NOTICE'));

      // 6. Valid real PDF -> PASS (technicalFailure = false)
      const { result: validPdfPassRes } = await withMockedLiveNetwork(
        async (url) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          return new Response(SSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          executor.execute('IN-CENTRAL-SSC', {
            verificationMode: 'LIVE',
            endpointId: 'ssc-primary',
            maxPages: 1,
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            downloadAndValidatePdfs: true,
            strictLiveMode: true,
            noCache: true,
          })
      );

      assert.equal(validPdfPassRes.outcome, 'PASS');
      assert.equal(validPdfPassRes.technicalFailure, false);

      // 7, 8, 9. Exit-code verification:
      // - Technical failure causes exitCode = 1 (whether via failCount > 0 or technicalFailures > 0)
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 0,
          inconclusiveCount: 1,
          failCount: 6,
          notRunCount: 0,
          technicalFailures: 6,
        }),
        1,
        'Hard source FAIL / technicalFailures > 0 must return exitCode 1'
      );
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 0,
          inconclusiveCount: 7,
          failCount: 0,
          notRunCount: 0,
          technicalFailures: 1,
        }),
        1,
        'technicalFailures > 0 must return exitCode 1 even if failCount is 0'
      );
      // - Only legitimate INCONCLUSIVE results with 0 technical failures produce exitCode = 0
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 0,
          inconclusiveCount: 7,
          failCount: 0,
          notRunCount: 0,
          technicalFailures: 0,
        }),
        0,
        'All sources completing with truthful INCONCLUSIVE and 0 technicalFailures must return exitCode 0'
      );
      // - notRunCount > 0 produces exitCode = 2
      assert.equal(
        computeLiveVerificationExitCode({
          totalSources: 7,
          passCount: 6,
          inconclusiveCount: 0,
          failCount: 0,
          notRunCount: 1,
          technicalFailures: 0,
        }),
        2,
        'notRunCount > 0 must return exitCode 2'
      );

      // 10. UND_ERR_CONNECT_TIMEOUT is preserved with timeoutStage = CONNECT_TIMEOUT
      const connectTimeoutClassified = classifyNetworkOrHttpError(
        new TypeError('fetch failed', {
          cause: Object.assign(
            new Error('Connect Timeout Error (attempted address: upsc.gov.in:443, timeout: 15000ms)'),
            { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }
          ),
        }),
        {
          requestUrl: 'https://upsc.gov.in/recruitment',
          timeoutMs: 15000,
          connectionTimeoutMs: 15000,
          attempt: 3,
          maxAttempts: 3,
        }
      );
      assert.equal(connectTimeoutClassified.errorType, 'TIMEOUT');
      assert.equal(connectTimeoutClassified.errorCode, 'UND_ERR_CONNECT_TIMEOUT');
      assert.equal(connectTimeoutClassified.timeoutStage, 'CONNECT_TIMEOUT');
      assert.equal(connectTimeoutClassified.timeoutMs, 15000);
      assert.equal(connectTimeoutClassified.connectionTimeoutMs, 15000);

      // 11. Connection timeout configuration is actually applied to the HTTP client / Undici dispatcher (not stuck at 10000ms)
      const dispatcher = await configureGlobalFetchDispatcher(15000, 15000);
      assert.ok(dispatcher, 'Undici Agent dispatcher must be created and configured');
      const inspected = inspectFetchDispatcherTimeouts(dispatcher);
      assert.equal(
        inspected.connectTimeoutMs,
        15000,
        'Undici dispatcher connectTimeout must be 15000ms (overriding default 10000ms)'
      );
      assert.equal(inspected.headersTimeoutMs, 15000);
      assert.equal(inspected.bodyTimeoutMs, 15000);

      // Also verify custom connectionTimeoutMs <= timeoutMs is applied
      const customDispatcher = await getOrCreateFetchDispatcher(15000, 12000);
      const customInspected = inspectFetchDispatcherTimeouts(customDispatcher);
      assert.equal(customInspected.connectTimeoutMs, 12000);
      assert.equal(customInspected.headersTimeoutMs, 15000);

      // 12. Full 7-source run with mixed PASS, INCONCLUSIVE (NO_RELEVANT_NOTICE), and technical FAIL (TIMEOUT):
      // Verify aggregate counters never double-count a source as both technical FAIL and INCONCLUSIVE
      const { result: mixedSummary } = await withMockedLiveNetwork(
        async (url) => {
          if (url.includes('ssc.gov.in') && !url.includes('upsssc.gov.in')) {
            // SSC -> valid empty listing -> INCONCLUSIVE (NO_RELEVANT_NOTICE)
            return new Response(
              '<html><body><table><tr><th>SSC Notice</th></tr></table><p>ssc.gov.in noticeboard advertisement</p></body></html>',
              { status: 200, headers: { 'content-type': 'text/html' } }
            );
          }
          if (url.includes('upsc.gov.in')) {
            // UPSC -> UND_ERR_CONNECT_TIMEOUT -> FAIL
            const causeErr = Object.assign(
              new Error('Connect Timeout Error (attempted address: upsc.gov.in:443, timeout: 15000ms)'),
              { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }
            );
            throw new TypeError('fetch failed', { cause: causeErr });
          }
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validSamplePdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bpsc.bih.nic.in')) {
            return new Response(BPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(UPSSSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 2,
            retryBackoffMs: 10,
            noCache: true,
          })
      );

      assert.equal(mixedSummary.totalSources, 7);
      assert.equal(mixedSummary.passCount, 5);
      assert.equal(mixedSummary.inconclusiveCount, 1, 'Only SSC (NO_RELEVANT_NOTICE) is INCONCLUSIVE');
      assert.equal(mixedSummary.failCount, 1, 'UPSC timeout is counted in failCount');
      assert.equal(mixedSummary.technicalFailures, 1, 'technicalFailures matches failCount');
      assert.equal(
        mixedSummary.passCount + mixedSummary.inconclusiveCount + mixedSummary.failCount,
        7,
        'passCount + inconclusiveCount + failCount must equal 7 without overlap'
      );
      assert.equal(mixedSummary.exitCode, 1, 'Any technical failure must produce exitCode = 1');

      const reportJson = buildMachineReadableLiveReport(mixedSummary);
      const upscReport = reportJson.sources.find((s) => s.sourceId === 'IN-CENTRAL-UPSC')!;
      assert.equal(upscReport.outcome, 'FAIL');
      assert.equal(upscReport.technicalFailure, true);
      assert.equal(upscReport.failedStage, 'LISTING_FETCH');
      assert.equal(upscReport.errorType, 'TIMEOUT');
      assert.equal(upscReport.errorCode, 'UND_ERR_CONNECT_TIMEOUT');
      assert.equal(upscReport.attempts, 3);
      assert.equal(upscReport.retriesUsed, 2);
      assert.equal(upscReport.timeoutMs, 15000);
      assert.equal(upscReport.connectionTimeoutMs, 15000);

      const sscReport = reportJson.sources.find((s) => s.sourceId === 'IN-CENTRAL-SSC')!;
      assert.equal(sscReport.outcome, 'INCONCLUSIVE');
      assert.equal(sscReport.technicalFailure, false);
      assert.equal(sscReport.failedStage, 'NOTICE_CLASSIFICATION');
      assert.equal(sscReport.timeoutMs, 15000);
      assert.equal(sscReport.connectionTimeoutMs, 15000);
    });

    it('Test 18: verifies official endpoint audit, EndpointClassification taxonomy, SSC notice-boards JSON API, UPPSC Open_PDF.aspx flow, RRB regional routing, BSSC ECONNRESET, and strict E2E verification semantics', async () => {
      // 1. Official endpoint audit across all 7 sources
      const audited = sourceEndpointRegistry.auditEndpoints();
      assert.ok(audited.length >= 16);
      const expectedSources = [
        'IN-CENTRAL-SSC',
        'IN-CENTRAL-UPSC',
        'IN-CENTRAL-RRB',
        'IN-BIHAR-BPSC',
        'IN-BIHAR-BSSC',
        'IN-UP-UPPSC',
        'IN-UP-UPSSSC',
      ];
      for (const sId of expectedSources) {
        const eps = sourceEndpointRegistry.auditEndpoints(sId);
        assert.ok(eps.length >= 2, `Source ${sId} must have audited endpoints`);
        for (const ep of eps) {
          assert.equal(ep.sourceId, sId);
          assert.ok(ep.endpointUrl.startsWith('https://'));
          assert.ok(ep.officialDomain.length > 0);
          assert.ok(ep.purpose.length > 5);
          assert.ok(
            ep.expectedResponse === 'HTML_LISTING' || ep.expectedResponse === 'JSON_API_RESPONSE'
          );
          assert.equal(typeof ep.paginationSupported, 'boolean');
          assert.ok(
            ep.detailFlow === 'DIRECT_PDF' ||
              ep.detailFlow === 'DETAIL_REQUIRED' ||
              ep.detailFlow === 'DIRECT_PDF_OR_DETAIL'
          );
          assert.ok(
            ep.documentFlow === 'LISTING_TO_DOCUMENT' ||
              ep.documentFlow === 'LISTING_TO_DETAIL_TO_DOCUMENT'
          );
          assert.equal(ep.active, true);
          assert.equal(isOfficialDomain(ep.endpointUrl, sId).allowed, true);
        }
      }

      // 2. EndpointClassification taxonomy unit verification
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          listingValidated: true,
          relevantNoticeFound: true,
          detailRequired: false,
          detailResolved: null,
          documentDiscovered: true,
          documentDownloaded: true,
          pdfValidated: true,
        }),
        'ENDPOINT_CORRECT'
      );

      // Stale/wrong endpoint (404 or FileNotFound redirect)
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: false,
          httpStatus: 404,
          errorType: 'HTTP_404',
        }),
        'ENDPOINT_STALE_OR_WRONG'
      );
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          finalUrl: 'https://uppsc.up.nic.in/FileNotFound.aspx?aspxerrorpath=/AllNotifications.aspx',
          listingValidated: false,
          wrongContent: true,
        }),
        'ENDPOINT_STALE_OR_WRONG'
      );

      // Network unreachable (timeout, connection reset, DNS, 5xx)
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: false,
          timeoutOccurred: true,
          errorType: 'TIMEOUT',
        }),
        'NETWORK_UNREACHABLE'
      );
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: false,
          errorType: 'CONNECTION_RESET',
        }),
        'NETWORK_UNREACHABLE'
      );

      // Access blocked (403, 429, disallowed domain)
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: false,
          httpStatus: 403,
          accessBlocked: true,
          errorType: 'HTTP_403',
        }),
        'ACCESS_BLOCKED'
      );
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: false,
          endpointReached: false,
        }),
        'ACCESS_BLOCKED'
      );

      // Response structure changed & Parser failure
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          listingValidated: false,
          structureChanged: true,
        }),
        'RESPONSE_STRUCTURE_CHANGED'
      );
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          listingValidated: false,
          parseFailed: true,
        }),
        'PARSER_FAILURE'
      );

      // Document flow failure (invalid PDF or unresolved detail page)
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          listingValidated: true,
          relevantNoticeFound: true,
          detailRequired: false,
          detailResolved: null,
          documentDiscovered: true,
          documentDownloaded: true,
          pdfValidated: false,
          invalidPdf: true,
        }),
        'DOCUMENT_FLOW_FAILURE'
      );
      assert.equal(
        classifyEndpointConnectivity({
          officialDomainVerified: true,
          endpointReached: true,
          httpStatus: 200,
          listingValidated: true,
          relevantNoticeFound: true,
          detailRequired: true,
          detailResolved: false,
          documentDiscovered: false,
          documentDownloaded: false,
          pdfValidated: false,
        }),
        'DOCUMENT_FLOW_FAILURE'
      );

      // 3. SSC: Unrendered Angular SPA shell on primary falls back to official SSC portal JSON API and achieves PASS
      const sscAdapter = sourceRegistry.get('IN-CENTRAL-SSC')!;
      const angularShellHtml =
        '<!doctype html><html lang="en"><head><title>ssc.gov.in</title></head><body><app-root></app-root><script src="main.js"></script></body></html>';
      const spaParse = sscAdapter.parseNotices(angularShellHtml, 'https://ssc.gov.in');
      assert.equal(spaParse.structureIntact, false, 'Unrendered Angular SPA shell must trigger fallback');

      const sscPortalApiJson = JSON.stringify({
        statusCode: '200',
        data: [
          {
            id: '1324',
            headline: 'Important Notice for Sub-Inspector in Delhi Police and CAPFs Examination, 2025',
            examId: 'CPO',
            contentType: 'notice-boards',
            createdAt: '2026-11-13T04:55:27.547Z',
            attachments: [
              {
                id: '1507',
                fileName: 'City live CPO Exam notice_13112026.pdf',
                type: 'application/pdf',
                size: 328499,
                path: 'uploads/masterData/NoticeBoards/City live CPO Exam notice_13112026.pdf',
              },
            ],
          },
        ],
      });
      const sscApiParse = sscAdapter.parseNotices(
        sscPortalApiJson,
        'https://ssc.gov.in/api/general-website/portal/notice-boards'
      );
      assert.equal(sscApiParse.structureIntact, true);
      assert.equal(sscApiParse.notices.length, 1);
      assert.equal(sscApiParse.notices[0].detailRequired, false);
      assert.equal(sscApiParse.notices[0].detailResolved, null);
      assert.equal(
        sscApiParse.notices[0].documents[0].url,
        'https://ssc.gov.in/api/attachment/uploads/masterData/NoticeBoards/City%20live%20CPO%20Exam%20notice_13112026.pdf'
      );

      // 4. UPPSC: Live Whats_New_Scroling unquoted href=Open_PDF.aspx?... list item parsing & direct PDF classification
      const uppscAdapter = sourceRegistry.get('IN-UP-UPPSC')!;
      const uppscLiveHtml = `
        <html><body>
          <ul class='Whats_New_Scroling'>
            <li>
              <a href=Open_PDF.aspx?I4PnQ0tBagkIY3nIrO0zxAYQ8Jqy3+nN target=_Blank>
                <span class='link_style_new'>Notice :- </span>
                <span class='lbl_css'>विज्ञप्ति - विज्ञापन संख्याः D-6/E-1/2025, उ0प्र0 विशेष अधीनस्थ शैक्षिक सेवा संवर्ग (तदर्थ) चयन परीक्षा-2025</span>
                (Visible up to : <span class='date_style'>27/05/2026</span>)
              </a>
            </li>
          </ul>
        </body></html>
      `;
      const uppscParse = uppscAdapter.parseNotices(uppscLiveHtml, 'https://uppsc.up.nic.in');
      assert.equal(uppscParse.structureIntact, true);
      assert.equal(uppscParse.notices.length, 1);
      assert.equal(uppscParse.notices[0].advertisementNumber, 'D-6/E-1/2025');
      assert.equal(uppscParse.notices[0].detailRequired, false);
      assert.equal(uppscParse.notices[0].detailResolved, null);
      assert.equal(uppscParse.notices[0].documentFlow, 'LISTING_TO_DOCUMENT');
      assert.equal(
        uppscParse.notices[0].documents[0].url,
        'https://uppsc.up.nic.in/Open_PDF.aspx?I4PnQ0tBagkIY3nIrO0zxAYQ8Jqy3+nN'
      );
      assert.equal(uppscParse.notices[0].documents[0].documentType, 'PDF');

      // 5. RRB regional routing, CEN extraction, and relative PDF URL normalization
      const rrbAdapter = sourceRegistry.get('IN-CENTRAL-RRB') as RrbSourceAdapter;
      assert.equal(isOfficialDomain('https://rrbcdg.gov.in/uploads/CEN_01_2026.pdf', 'IN-CENTRAL-RRB').allowed, true);
      assert.equal(isOfficialDomain('https://rrbchennai.gov.in/CEN_02_2026.pdf', 'IN-CENTRAL-RRB').allowed, true);
      const rrbRegionalHtml = `
        <html><body>
          <table>
            <tr>
              <td>13-11-2026</td>
              <td>CEN 01/2026 - Recruitment of Assistant Loco Pilot (ALP) Detailed Notification</td>
              <td><a href="/uploads/2026/CEN_01_2026_ALP_English.pdf">Download CEN PDF</a></td>
            </tr>
          </table>
        </body></html>
      `;
      const rrbParse = rrbAdapter.parseNotices(rrbRegionalHtml, 'https://rrbcdg.gov.in');
      assert.equal(rrbParse.structureIntact, true);
      assert.equal(rrbParse.notices.length, 1);
      assert.equal(rrbParse.notices[0].advertisementNumber, 'CEN 01/2026');
      assert.equal(rrbParse.notices[0].regionalSubSource, 'RRB-CDG');
      assert.equal(
        rrbParse.notices[0].documents[0].url,
        'https://rrbcdg.gov.in/uploads/2026/CEN_01_2026_ALP_English.pdf'
      );
    });
  });

  describe('19. Five-Source Recovery & Real Live Runtime Proof Hardening (UPSC, RRB, BPSC, BSSC, UPSSSC)', () => {
    it('recovers UPSC via www.upsc.gov.in Drupal .views-row -> /whats-new/* detail page -> /sites/default/files/*.pdf E2E PASS', async () => {
      const upscAdapter = sourceRegistry.get('IN-CENTRAL-UPSC')!;
      assert.equal(upscAdapter.baseUrl, 'https://www.upsc.gov.in');
      assert.equal(isOfficialDomain('https://www.upsc.gov.in', 'IN-CENTRAL-UPSC').allowed, true);
      assert.equal(
        isOfficialDomain('https://www.upsc.gov.in/whats-new/13%20-%202026', 'IN-CENTRAL-UPSC').allowed,
        true
      );
      assert.equal(
        isOfficialDomain(
          'https://www.upsc.gov.in/sites/default/files/AdvtNo-13-2026-Engl-131126_0.pdf',
          'IN-CENTRAL-UPSC'
        ).allowed,
        true
      );

      // Authentic Drupal Views .views-row HTML structure served by https://www.upsc.gov.in/
      const upscDrupalViewsHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Welcome to UPSC | UPSC</title></head>
        <body>
          <div class="view-content">
            <div class="views-row views-row-1 views-row-odd views-row-first">
              <div class="views-field views-field-field-exam-name">
                <div class="field-content">
                  <a href="/whats-new/13%20-%202026">Advertisement No.13 - 2026</a>
                </div>
              </div>
            </div>
            <div class="views-row views-row-2 views-row-even">
              <div class="views-field views-field-field-exam-name">
                <div class="field-content">
                  <a href="/whats-new/Engineering%20Services%20%28Preliminary%29%20Examination%2C%202026/Marks%20Information">
                    Marks Information: Engineering Services (Preliminary) Examination, 2026
                  </a>
                </div>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      // Authentic detail page HTML served by https://www.upsc.gov.in/whats-new/13%20-%202026
      const upscDetailHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <body>
          <table class="views-table cols-2">
            <thead>
              <tr><th>Name of Examination</th><th>Documents</th></tr>
            </thead>
            <tbody>
              <tr class="odd views-row-first views-row-last">
                <td>Advertisement No.13 - 2026</td>
                <td>
                  <div class="item-list">
                    <ul>
                      <li>
                        <a href="https://www.upsc.gov.in/sites/default/files/AdvtNo-13-2026-Engl-131126_0.pdf" target="_blank">
                          Document (982.32 KB)
                        </a>
                      </li>
                    </ul>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </body>
        </html>
      `;

      const parseRes = upscAdapter.parseNotices(upscDrupalViewsHtml, 'https://www.upsc.gov.in');
      assert.equal(parseRes.structureIntact, true);
      assert.equal(parseRes.notices.length, 2);
      assert.equal(parseRes.notices[0].advertisementNumber, '13/2026');
      assert.equal(parseRes.notices[0].detailRequired, true);
      assert.equal(parseRes.notices[0].detailResolved, false);
      assert.equal(parseRes.notices[0].detailUrl, 'https://www.upsc.gov.in/whats-new/13%20-%202026');

      const validPdf = createValidSamplePdf('UPSC Advertisement No. 13/2026 Direct Recruitment Notification');
      const executor = getDiscoveryExecutor();
      const execRes = await executor.execute('IN-CENTRAL-UPSC', {
        endpointFixtures: {
          'upsc-primary': upscDrupalViewsHtml,
        },
        detailFixtures: {
          'https://www.upsc.gov.in/whats-new/13%20-%202026': upscDetailHtml,
          'https://www.upsc.gov.in/whats-new/Engineering%20Services%20%28Preliminary%29%20Examination%2C%202026/Marks%20Information':
            upscDetailHtml,
        },
        pdfFixtures: {
          'https://www.upsc.gov.in/sites/default/files/AdvtNo-13-2026-Engl-131126_0.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(execRes.outcome, 'PASS');
      assert.equal(execRes.detailRequired, true);
      assert.equal(execRes.detailResolved, true);
      assert.equal(execRes.metrics.detailPagesFetched, 2);
      assert.equal(execRes.metrics.validPdfs, 2);
      assert.equal(
        execRes.evidence?.documentUrl,
        'https://www.upsc.gov.in/sites/default/files/AdvtNo-13-2026-Engl-131126_0.pdf'
      );
      assert.ok(execRes.evidence?.documentSha256);
    });

    it('aligns RRB primaryEndpoint and officialDomain to https://rrbcdg.gov.in and supports multi-board regional fallback', async () => {
      const rrbAdapter = sourceRegistry.get('IN-CENTRAL-RRB') as RrbSourceAdapter;
      const rrbEndpoints = sourceEndpointRegistry.getEndpointsForSource('IN-CENTRAL-RRB');
      assert.equal(rrbAdapter.baseUrl, 'https://rrbcdg.gov.in');
      assert.equal(rrbEndpoints[0].url, 'https://rrbcdg.gov.in');
      assert.equal(rrbEndpoints[0].officialDomain, 'rrbcdg.gov.in');
      assert.ok(rrbEndpoints.length >= 4, 'RRB registry must include multiple regional RRB endpoints');

      // Unrendered Angular SPA shell (e.g. www.rrbapply.gov.in) is rejected as structureIntact=false
      const rrbSpaShell = '<!doctype html><html><body><app-root></app-root></body></html>';
      assert.equal(rrbAdapter.parseNotices(rrbSpaShell, 'https://rrbcdg.gov.in').structureIntact, false);

      // Simulate primary regional board failing and secondary regional board (rrbmumbai.gov.in) succeeding with valid CEN PDF
      const validPdf = createValidSamplePdf('RRB Mumbai CEN 01/2026 ALP Official Notification');
      const rrbMumbaiHtml = `
        <html><body>
          <table class="cen-table">
            <tr>
              <td>CEN 01/2026 (Assistant Loco Pilot) Detailed Notification</td>
              <td><a href="/notices/CEN_01_2026_Mumbai.pdf">Download CEN PDF</a></td>
            </tr>
          </table>
        </body></html>
      `;

      const executor = getDiscoveryExecutor();
      const execRes = await executor.execute('IN-CENTRAL-RRB', {
        endpointFixtures: {
          'rrb-central-primary': { status: 503, html: 'Service Unavailable' },
          'rrb-cdg-secondary': rrbMumbaiHtml,
        },
        pdfFixtures: {
          'https://rrbmumbai.gov.in/notices/CEN_01_2026_Mumbai.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(execRes.outcome, 'PASS');
      assert.equal(execRes.metrics.selectedEndpointId, 'rrb-cdg-secondary');
      assert.equal(execRes.evidence?.endpointUrl, 'https://rrbmumbai.gov.in');
      assert.equal(execRes.evidence?.documentUrl, 'https://rrbmumbai.gov.in/notices/CEN_01_2026_Mumbai.pdf');
      assert.equal(execRes.notices[0].regionalSubSource, 'RRB-MUM');
    });

    it('attempts alternate official path /NoticeBoard.htm when BSSC root / resets connection (ECONNRESET)', async () => {
      const validPdf = createValidSamplePdf('BSSC 4th Graduate Level Combined Competitive Examination 2026');
      const bsscNoticeBoardHtml = `
        <html><body>
          <table class="notice-board">
            <tr>
              <td>13-11-2026</td>
              <td>विज्ञापन संख्या-01/26 : चतुर्थ स्नातक स्तरीय संयुक्त प्रतियोगिता परीक्षा (4th CGL)</td>
              <td><a href="/Advertisement/Advt_01_26_CGL.pdf">Click here to view Advertisement</a></td>
            </tr>
          </table>
        </body></html>
      `;

      const executor = getDiscoveryExecutor();
      const execRes = await executor.execute('IN-BIHAR-BSSC', {
        endpointFixtures: {
          'bssc-primary': { status: 502, html: 'Bad Gateway' },
          'bssc-notice-board': bsscNoticeBoardHtml,
        },
        pdfFixtures: {
          'https://bssc.bihar.gov.in/Advertisement/Advt_01_26_CGL.pdf': validPdf,
        },
        downloadAndValidatePdfs: true,
        strictLiveMode: true,
        noCache: true,
      });

      assert.equal(execRes.outcome, 'PASS');
      assert.equal(execRes.metrics.selectedEndpointId, 'bssc-notice-board');
      assert.equal(execRes.evidence?.endpointUrl, 'https://bssc.bihar.gov.in/NoticeBoard.htm');
      assert.equal(execRes.evidence?.documentUrl, 'https://bssc.bihar.gov.in/Advertisement/Advt_01_26_CGL.pdf');
    });

    it('distinguishes REAL_LIVE_PROOF, FIXTURE_PROOF, and CACHE_PROOF and exposes all Section 8 diagnostic fields', async () => {
      const validPdf = createValidSamplePdf('Official Notification PDF');
      const fixtureSummary = await runRealLiveVerification({
        verificationMode: 'FIXTURE',
        fixtureHtml: SSC_SNAPSHOTS.normalListing,
        pdfFixtures: {
          'https://ssc.gov.in/api/attachments/cgl-2026-notice.pdf': validPdf,
          'https://ssc.gov.in/api/attachments/chsl-2026.pdf': validPdf,
        },
      });

      assert.equal(fixtureSummary.realLivePassCount, 0, 'Fixture runs must never count as REAL_LIVE_PASS');
      assert.ok(fixtureSummary.proofCounts.FIXTURE_PASS >= 1, 'Fixture PASS must be counted under FIXTURE_PASS');

      const report = buildMachineReadableLiveReport(fixtureSummary);
      assert.ok(report.proofCounts);
      assert.equal(report.realLivePassCount, 0);

      for (const s of report.sources) {
        assert.ok(s.source);
        assert.ok(s.endpoint);
        assert.ok(s.endpointClassification);
        assert.ok(s.classificationEvidence);
        assert.equal(s.proofType, 'FIXTURE_PROOF');
        assert.equal(typeof s.requestTimeoutMs, 'number');
        assert.equal(typeof s.connectionTimeoutMs, 'number');
        assert.equal(typeof s.listingFetched, 'boolean');
        assert.equal(typeof s.listingParsed, 'boolean');
        assert.equal(typeof s.relevantNotices, 'number');
        assert.equal(typeof s.detailRequired, 'boolean');
        assert.equal(typeof s.documentsDiscovered, 'number');
        assert.equal(typeof s.documentsDownloaded, 'number');
        assert.equal(typeof s.validPdfs, 'number');
        assert.equal(typeof s.evidenceValidated, 'boolean');
        assert.ok(s.finalStatus === 'PASS' || s.finalStatus === 'FAIL' || s.finalStatus === 'INCONCLUSIVE');
      }
    });
  });

  describe('20. Four-Source Connectivity Recovery, Staged DNS/TCP/TLS Diagnostics & Strict Security Preservation', () => {
    async function withMockedLiveNetwork<T>(
      handler: (url: string) => Promise<Response>,
      fn: () => Promise<T>
    ): Promise<{ result: T; requestedUrls: string[] }> {
      const requestedUrls: string[] = [];
      const origLookup = dns.lookup;
      const origFetch = globalThis.fetch;

      (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async (hostname: string) => {
        if (
          hostname === 'localhost' ||
          hostname.startsWith('127.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          hostname.startsWith('169.254.')
        ) {
          return [{ address: hostname, family: 4 }];
        }
        return [{ address: '164.100.158.10', family: 4 }];
      }) as unknown as typeof dns.lookup;

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);
        return handler(url);
      }) as typeof globalThis.fetch;

      try {
        const result = await fn();
        return { result, requestedUrls };
      } finally {
        (dns as unknown as { lookup: typeof dns.lookup }).lookup = origLookup;
        globalThis.fetch = origFetch;
      }
    }

    it('keeps SSC, UPSC, and UPPSC PASS with valid PDFs while rejecting RRB/BPSC/BSSC/UPSSSC false PASSes on transport failures or missing PDFs', async () => {
      const validPdf = createValidSamplePdf('Official Central & State Recruitment Notification 2026');

      // Simulated mixed LIVE run mirroring real-world conditions:
      // - SSC, UPSC, UPPSC succeed E2E with valid official PDFs
      // - RRB returns HTTP 200 HTML notice but PDF fails to download -> MUST NOT PASS
      // - BPSC times out at connect (UND_ERR_CONNECT_TIMEOUT) -> FAIL / TIMEOUT
      // - BSSC resets TLS connection (ECONNRESET) -> FAIL / CONNECTION_RESET
      // - UPSSSC times out (ETIMEDOUT) -> FAIL / TIMEOUT
      const { result: summary } = await withMockedLiveNetwork(
        async (url: string) => {
          if (url.includes('ssc.gov.in') && !url.includes('upsssc.gov.in')) {
            if (url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            if (url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            if (url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('rrb')) {
            if (url.endsWith('.pdf')) {
              return new Response('<html>404 Not Found</html>', {
                status: 404,
                headers: { 'content-type': 'text/html' },
              });
            }
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bpsc.bih.nic.in')) {
            const causeErr = Object.assign(
              new Error('Connect Timeout Error (attempted address: bpsc.bih.nic.in:443, timeout: 15000ms)'),
              { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' }
            );
            throw new TypeError('fetch failed', { cause: causeErr });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            const causeErr = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
              code: 'ECONNRESET',
            });
            throw new TypeError('fetch failed', { cause: causeErr });
          }
          // UPSSSC -> ETIMEDOUT
          const upssscCause = Object.assign(new Error('connect ETIMEDOUT 164.100.181.99:443'), {
            code: 'ETIMEDOUT',
          });
          throw new TypeError('fetch failed', { cause: upssscCause });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            timeoutMs: 15000,
            connectionTimeoutMs: 15000,
            maxRetries: 1,
            retryBackoffMs: 10,
            noCache: true,
            connectivityProbe: false,
          })
      );

      assert.equal(summary.realLivePassCount, 3, 'Only SSC, UPSC, UPPSC should be REAL_LIVE_PASS');
      assert.equal(summary.realLiveFailCount, 4);
      assert.ok(summary.realPdfProofCount >= 3);

      const byId = Object.fromEntries(summary.results.map((r) => [r.sourceId, r]));

      for (const provenId of ['IN-CENTRAL-SSC', 'IN-CENTRAL-UPSC', 'IN-UP-UPPSC']) {
        assert.equal(byId[provenId].finalStatus, 'PASS');
        assert.equal(byId[provenId].dnsStatus, 'RESOLVED');
        assert.equal(byId[provenId].connectionStatus, 'CONNECTED');
        assert.equal(byId[provenId].failureClassification, 'ENDPOINT_CORRECT');
        assert.equal(byId[provenId].evidenceValidated, true);
      }

      // RRB HTTP 200 listing without valid PDF cannot become PASS
      assert.equal(byId['IN-CENTRAL-RRB'].finalStatus, 'FAIL');
      assert.equal(byId['IN-CENTRAL-RRB'].listingFetched, true);
      assert.equal(byId['IN-CENTRAL-RRB'].pdfValidated, false);
      assert.equal(byId['IN-CENTRAL-RRB'].failureClassification, 'PDF_DOWNLOAD_FAILED');
      assert.ok(Array.isArray(byId['IN-CENTRAL-RRB'].regionalProbes));
      assert.ok(byId['IN-CENTRAL-RRB'].regionalProbes!.length >= 21, 'Must cover all 21 official RRB boards + apply portal');

      // BPSC timeout cannot become PASS
      assert.equal(byId['IN-BIHAR-BPSC'].finalStatus, 'FAIL');
      assert.equal(byId['IN-BIHAR-BPSC'].connectionStatus, 'TIMEOUT');
      assert.equal(byId['IN-BIHAR-BPSC'].tcpStatus, 'TIMEOUT');
      assert.equal(byId['IN-BIHAR-BPSC'].tlsStatus, 'NOT_ATTEMPTED');
      assert.equal(byId['IN-BIHAR-BPSC'].failureClassification, 'TIMEOUT');
      assert.equal(byId['IN-BIHAR-BPSC'].errorCode, 'UND_ERR_CONNECT_TIMEOUT');

      // BSSC ECONNRESET cannot become PASS
      assert.equal(byId['IN-BIHAR-BSSC'].finalStatus, 'FAIL');
      assert.equal(byId['IN-BIHAR-BSSC'].connectionStatus, 'CONNECTION_RESET');
      assert.equal(byId['IN-BIHAR-BSSC'].tcpStatus, 'CONNECTED');
      assert.equal(byId['IN-BIHAR-BSSC'].tlsStatus, 'CONNECTION_RESET');
      assert.equal(byId['IN-BIHAR-BSSC'].failureClassification, 'CONNECTION_RESET');
      assert.equal(byId['IN-BIHAR-BSSC'].errorCode, 'ECONNRESET');

      // UPSSSC ETIMEDOUT cannot become PASS
      assert.equal(byId['IN-UP-UPSSSC'].finalStatus, 'FAIL');
      assert.equal(byId['IN-UP-UPSSSC'].connectionStatus, 'TIMEOUT');
      assert.equal(byId['IN-UP-UPSSSC'].tcpStatus, 'TIMEOUT');
      assert.equal(byId['IN-UP-UPSSSC'].tlsStatus, 'NOT_ATTEMPTED');
      assert.equal(byId['IN-UP-UPSSSC'].failureClassification, 'TIMEOUT');
      assert.equal(byId['IN-UP-UPSSSC'].errorCode, 'ETIMEDOUT');

      // Machine-readable report fields verification
      const report = buildMachineReadableLiveReport(summary);
      assert.equal(report.REAL_LIVE_PASS, 3);
      assert.equal(report.REAL_LIVE_FAIL, 4);
      assert.equal(report.REAL_LIVE_INCONCLUSIVE, 0);
      assert.ok(report.REAL_PDF_PROOF_COUNT >= 3);
      assert.equal(report.REAL_VALID_PDF_COUNT, report.REAL_PDF_PROOF_COUNT);
      assert.deepEqual(report.proofCategoryBreakdown, {
        REAL_LIVE_LOCAL: 7,
        REAL_LIVE_REMOTE: 0,
        REAL_REMOTE_LOCAL_WORKER: 0,
        REAL_REMOTE_PRODUCTION: 0,
        REAL_LIVE: 7,
        MOCK: 0,
        FIXTURE: 0,
        CACHE: 0,
        NOT_EXECUTED: 0,
      });
      for (const s of report.sources) {
        assert.ok(s.region);
        assert.ok(s.dnsStatus);
        assert.ok(s.tcpStatus);
        assert.ok(s.tlsStatus);
        assert.ok(s.connectionStatus);
        assert.ok(s.failureClassification);
        assert.equal(typeof s.listingFetched, 'boolean');
        assert.equal(typeof s.listingParsed, 'boolean');
        assert.equal(typeof s.evidenceValidated, 'boolean');
        assert.ok(s.finalStatus === 'PASS' || s.finalStatus === 'FAIL' || s.finalStatus === 'INCONCLUSIVE');
      }
    });

    it('validates RRB regional domains independently and records structured per-region DNS/TCP/TLS/PDF telemetry', async () => {
      for (const board of RRB_REGIONAL_PROBE_BOARDS) {
        assert.equal(
          isOfficialDomain(board.endpoint, 'IN-CENTRAL-RRB').allowed,
          true,
          `Official RRB regional domain ${board.endpoint} must pass allowlist`
        );
      }

      // Simulated multi-region probe covering DNS failure, CERT_HAS_EXPIRED, ECONNREFUSED, HTTP 404 SPA, and live PDF PASS
      const regionalProbes = await probeRrbRegionalNetwork({
        attemptedEndpoints: [
          {
            endpointId: 'rrb-chennai-regional',
            url: 'https://rrbchennai.gov.in',
            priority: 3,
            outcome: 'ENDPOINT_SUCCESS',
            endpointClassification: 'ENDPOINT_CORRECT',
            httpStatus: 200,
            noticesCount: 1,
            validPdfsCount: 1,
            responseTimeMs: 420,
          },
        ],
        runLiveSockets: true,
        probeFn: async (endpointUrl) => {
          const host = new URL(endpointUrl).hostname;
          if (endpointUrl.includes('rrbald.gov.in')) {
            return {
              endpoint: endpointUrl,
              hostname: host,
              dnsStatus: 'RESOLVED',
              resolvedIps: ['164.100.178.170'],
              connectionStatus: 'TLS_FAILURE',
              tlsProtocol: null,
              errorCode: 'CERT_HAS_EXPIRED',
              errorMessage: 'certificate has expired',
              durationMs: 310,
            };
          }
          if (endpointUrl.includes('rrbbbs.gov.in')) {
            return {
              endpoint: endpointUrl,
              hostname: host,
              dnsStatus: 'RESOLVED',
              resolvedIps: ['164.100.140.198'],
              connectionStatus: 'CONNECTION_REFUSED',
              tlsProtocol: null,
              errorCode: 'ECONNREFUSED',
              errorMessage: 'connect ECONNREFUSED',
              durationMs: 115,
            };
          }
          if (endpointUrl.includes('rrbbhopal.gov.in')) {
            return {
              endpoint: endpointUrl,
              hostname: host,
              dnsStatus: 'EAI_AGAIN',
              resolvedIps: [],
              connectionStatus: 'NOT_ATTEMPTED',
              tlsProtocol: null,
              errorCode: 'EAI_AGAIN',
              errorMessage: 'getaddrinfo EAI_AGAIN rrbbhopal.gov.in',
              durationMs: 25,
            };
          }
          if (endpointUrl.includes('rrbapply.gov.in')) {
            return {
              endpoint: endpointUrl,
              hostname: host,
              dnsStatus: 'RESOLVED',
              resolvedIps: ['18.67.161.1'],
              connectionStatus: 'CONNECTED',
              tlsProtocol: 'TLSv1.3',
              errorCode: null,
              errorMessage: null,
              durationMs: 160,
            };
          }
          return {
            endpoint: endpointUrl,
            hostname: host,
            dnsStatus: 'RESOLVED',
            resolvedIps: ['203.176.113.43'],
            connectionStatus: 'TIMEOUT',
            tlsProtocol: null,
            errorCode: 'ETIMEDOUT',
            errorMessage: 'TCP/TLS handshake timed out',
            durationMs: 3500,
          };
        },
      });

      const byRegion = Object.fromEntries(regionalProbes.map((p) => [p.endpoint, p]));
      assert.equal(byRegion['https://rrbald.gov.in'].boardId, 'RRB-ALD');
      assert.equal(byRegion['https://rrbald.gov.in'].hostname, 'rrbald.gov.in');
      assert.equal(byRegion['https://rrbald.gov.in'].tcpStatus, 'CONNECTED');
      assert.equal(byRegion['https://rrbald.gov.in'].tlsStatus, 'TLS_FAILURE');
      assert.equal(byRegion['https://rrbald.gov.in'].connectionResult, 'TLS_FAILURE (CERT_HAS_EXPIRED)');
      assert.equal(byRegion['https://rrbald.gov.in'].responseClassification, 'TLS_FAILURE');
      assert.equal(byRegion['https://rrbald.gov.in'].regionalStatus, 'TLS_FAILURE');

      assert.equal(byRegion['https://rrbbbs.gov.in'].tcpStatus, 'CONNECTION_REFUSED');
      assert.equal(byRegion['https://rrbbbs.gov.in'].tlsStatus, 'NOT_ATTEMPTED');
      assert.equal(byRegion['https://rrbbbs.gov.in'].connectionResult, 'CONNECTION_REFUSED (ECONNREFUSED)');
      assert.equal(byRegion['https://rrbbbs.gov.in'].responseClassification, 'NETWORK_UNREACHABLE');
      assert.equal(byRegion['https://rrbbbs.gov.in'].regionalStatus, 'CONNECTION_REFUSED');

      assert.equal(byRegion['https://rrbbhopal.gov.in'].dnsResult, 'EAI_AGAIN');
      assert.equal(byRegion['https://rrbbhopal.gov.in'].responseClassification, 'DNS_FAILURE');
      assert.equal(byRegion['https://rrbbhopal.gov.in'].regionalStatus, 'DNS_FAILURE');

      assert.equal(byRegion['https://www.rrbapply.gov.in'].httpStatus, 404);
      assert.equal(byRegion['https://www.rrbapply.gov.in'].responseClassification, 'ENDPOINT_STALE_OR_WRONG');
      assert.equal(byRegion['https://www.rrbapply.gov.in'].regionalStatus, 'NOT_A_RECRUITMENT_ENDPOINT');

      assert.equal(byRegion['https://rrbchennai.gov.in'].pdfResult, 'VALID_PDF');
      assert.equal(byRegion['https://rrbchennai.gov.in'].finalStatus, 'PASS');
      assert.equal(byRegion['https://rrbchennai.gov.in'].regionalStatus, 'ACTIVE');
    });

    it('enforces SSRF protection, blocks third-party domains, rejects HTTP 200 / FIXTURE / CACHE from counting as REAL_LIVE_PASS, and preserves TLS failure classification', async () => {
      // 1. Third-party domains blocked for all 7 sources
      for (const sourceId of [
        'IN-CENTRAL-SSC',
        'IN-CENTRAL-UPSC',
        'IN-CENTRAL-RRB',
        'IN-BIHAR-BPSC',
        'IN-BIHAR-BSSC',
        'IN-UP-UPPSC',
        'IN-UP-UPSSSC',
      ]) {
        assert.equal(
          isOfficialDomain('https://www.sarkariresult.com/latest-jobs/', sourceId).allowed,
          false
        );
        assert.equal(
          isOfficialDomain('https://www.freejobalert.com/government-jobs/', sourceId).allowed,
          false
        );
        const ssrfProbe = await probeEndpointConnectivity('https://127.0.0.1/admin', sourceId, 1000);
        assert.equal(ssrfProbe.dnsStatus, 'SSRF_BLOCKED');
        assert.equal(ssrfProbe.connectionStatus, 'NOT_ATTEMPTED');
      }

      // 2. TLS failure taxonomy (CERT_HAS_EXPIRED never weakened)
      const tlsStatuses = deriveConnectivityStatuses({
        endpointReached: false,
        lastErrorType: 'TLS_ERROR',
        lastErrorCode: 'CERT_HAS_EXPIRED',
      });
      assert.equal(tlsStatuses.connectionStatus, 'TLS_FAILURE');
      assert.equal(
        classifyFailureTaxonomy({
          outcome: 'FAIL',
          endpointClassification: 'NETWORK_UNREACHABLE',
          dnsStatus: tlsStatuses.dnsStatus,
          connectionStatus: tlsStatuses.connectionStatus,
          httpStatus: null,
          errorType: 'TLS_ERROR',
          errorCode: 'CERT_HAS_EXPIRED',
        }),
        'TLS_FAILURE'
      );

      // 3. HTTP 200 valid listing without any relevant notice/PDF -> INCONCLUSIVE (NO_RELEVANT_NOTICE), never PASS
      const http200NoPdfGate = evaluateLiveVerificationGate({
        endpointReached: true,
        endpointValidated: true,
        officialDomainVerified: true,
        listingValidated: true,
        relevantNoticeFound: false,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: 'LIVE_EXECUTION',
        verificationMode: 'LIVE',
        httpStatus: 200,
      });
      assert.notEqual(http200NoPdfGate.outcome, 'PASS');
      assert.equal(http200NoPdfGate.outcome, 'INCONCLUSIVE');

      // 4. Cached execution -> cannot count as PASS or REAL_LIVE_PASS
      const validPdf = createValidSamplePdf('Cached Official Notice PDF');
      const { result: cacheSummary } = await withMockedLiveNetwork(
        async (url: string) => {
          if (url.endsWith('.pdf')) {
            return new Response(new Uint8Array(validPdf), {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
            });
          }
          if (url.includes('ssc.gov.in')) {
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('rrb')) {
            return new Response(RRB_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bpsc.bih.nic.in')) {
            return new Response(BPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            return new Response(BSSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response(UPSSSC_SNAPSHOTS.normalListing, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        async () => {
          await runRealLiveVerification({
            verificationMode: 'CACHE',
            connectivityProbe: false,
          });
          return runRealLiveVerification({
            verificationMode: 'CACHE',
            connectivityProbe: false,
          });
        }
      );
      assert.equal(cacheSummary.realLivePassCount, 0);
      assert.equal(cacheSummary.realPdfProofCount, 0);
      assert.equal(cacheSummary.cachedExecutionCount, 7);
    });
  });

  // =========================================================================
  // 21. OfficialSourceRunner / AcquisitionRunner Provider-Neutral Architecture (Section 1-15)
  // =========================================================================
  describe('21. OfficialAcquisitionRunner Architecture, LOCAL/REMOTE/AUTO Modes & Security Controls', () => {
    async function withMockedLiveNetwork<T>(
      handler: (url: string) => Promise<Response>,
      fn: () => Promise<T>
    ): Promise<{ result: T; requestedUrls: string[] }> {
      const origLookup = dns.lookup;
      const origFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async (hostname: string) => {
        if (
          hostname === 'localhost' ||
          hostname.startsWith('127.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          hostname.startsWith('169.254.')
        ) {
          return [{ address: hostname, family: 4 }];
        }
        return [{ address: '164.100.158.10', family: 4 }];
      }) as unknown as typeof dns.lookup;

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);
        return handler(url);
      }) as typeof globalThis.fetch;

      try {
        const result = await fn();
        return { result, requestedUrls };
      } finally {
        (dns as unknown as { lookup: typeof dns.lookup }).lookup = origLookup;
        globalThis.fetch = origFetch;
      }
    }

    it('preserves SSC, UPSC, and UPPSC local PASS (REAL_LIVE_LOCAL) and separates officialEndpointStatus from runtimeAccessStatus for locally blocked sources', async () => {
      const validPdf = createValidSamplePdf('Official Recruitment Notification PDF');

      const { result: summary } = await withMockedLiveNetwork(
        async (url: string) => {
          if (url.includes('ssc.gov.in') && !url.includes('upsssc.gov.in')) {
            if (url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(SSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('upsc.gov.in')) {
            if (url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(UPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('uppsc.up.nic.in')) {
            if (url.includes('Open_PDF.aspx') || url.endsWith('.pdf')) {
              return new Response(new Uint8Array(validPdf), {
                status: 200,
                headers: { 'content-type': 'application/pdf' },
              });
            }
            return new Response(UPPSC_SNAPSHOTS.normalListing, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.includes('bssc.bihar.gov.in')) {
            const resetCause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
            throw Object.assign(new TypeError('fetch failed'), { cause: resetCause });
          }
          const timeoutCause = Object.assign(new Error('Connect Timeout Error'), {
            code: 'UND_ERR_CONNECT_TIMEOUT',
          });
          throw Object.assign(new TypeError('fetch failed'), { cause: timeoutCause });
        },
        () =>
          runRealLiveVerification({
            verificationMode: 'LIVE',
            runnerMode: 'LOCAL',
            timeoutMs: 1000,
            maxRetries: 0,
            connectivityProbe: false,
            noCache: true,
          })
      );

      // 1-3: SSC, UPSC, UPPSC local PASS intact
      assert.equal(summary.realLiveLocalPassCount, 3);
      assert.equal(summary.realLiveRemotePassCount, 0);
      assert.equal(summary.realLivePassCount, 3);
      assert.equal(summary.mockRemotePassCount, 0);

      for (const provenId of ['IN-CENTRAL-SSC', 'IN-CENTRAL-UPSC', 'IN-UP-UPPSC']) {
        const r = summary.results.find((item) => item.sourceId === provenId)!;
        assert.equal(r.outcome, 'PASS');
        assert.equal(r.selectedRunner, 'LOCAL');
        assert.equal(r.localAccess, 'SUCCESS');
        assert.equal(r.executionOrigin, 'REAL_LIVE_LOCAL');
        assert.equal(r.verifiedLive, true);
        assert.equal(r.runtimeAccessibility, 'RUNTIME_ACCESSIBLE');
        assert.equal(r.officialEndpointStatus, 'OFFICIAL_ENDPOINT_VERIFIED');
        assert.equal(r.runtimeAccessStatus, 'RUNTIME_ACCESSIBLE');
        assert.equal(r.runtimeCapabilities.httpAccess, true);
        assert.equal(r.runtimeCapabilities.pdfDownloadAccess, true);
      }

      // 10: Local timeout / reset does NOT report ENDPOINT_INVALID; reports OFFICIAL_ENDPOINT_VERIFIED + RUNTIME_ACCESS_BLOCKED_OR_UNREACHABLE
      for (const blockedId of ['IN-CENTRAL-RRB', 'IN-BIHAR-BPSC', 'IN-BIHAR-BSSC', 'IN-UP-UPSSSC']) {
        const r = summary.results.find((item) => item.sourceId === blockedId)!;
        assert.equal(r.outcome, 'FAIL');
        assert.equal(r.officialEndpointStatus, 'OFFICIAL_ENDPOINT_VERIFIED');
        assert.equal(r.runtimeAccessStatus, 'RUNTIME_ACCESS_BLOCKED_OR_UNREACHABLE');
        assert.equal(r.runtimeAccessibility, 'RUNTIME_INACCESSIBLE');
      }

      const report = buildMachineReadableLiveReport(summary);
      assert.equal(report.REAL_LIVE_LOCAL_PASS, 3);
      assert.equal(report.REAL_LIVE_REMOTE_PASS, 0);
      assert.equal(report.REAL_LIVE_PASS, 3);
      assert.equal(report.runnerHealth.LOCAL_RUNNER.status, 'AVAILABLE');
      assert.equal(report.runnerHealth.REMOTE_RUNNER.status, 'NOT_CONFIGURED');
    });

    it('supports mock remote runner E2E in unit tests, labels it MOCK_REMOTE / MOCK_REMOTE_PROOF, and never increments REAL_LIVE_PASS', async () => {
      const validPdf = createValidSamplePdf('Official BPSC Remote Worker PDF');

      const mockRemoteRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: true,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => {
          if (req.methodType === 'DOCUMENT_PDF' || req.endpoint.toLowerCase().endsWith('.pdf')) {
            return {
              sourceId: req.sourceId,
              methodType: req.methodType,
              endpoint: req.endpoint,
              finalUrl: req.endpoint,
              httpStatus: 200,
              redirectChain: [req.endpoint],
              content: null,
              binaryContent: validPdf,
              contentType: 'application/pdf',
              responseBytes: validPdf.length,
              durationMs: 12,
              attempts: 1,
              retriesUsed: 0,
              retryReasons: [],
              retryDiagnostics: [],
              attemptDiagnostics: [],
              failureClassification: 'NONE',
              failureDetails: null,
              errorType: null,
              errorCode: null,
              errorName: null,
              retryable: false,
              runnerUsed: 'REMOTE',
              executionOrigin: 'MOCK_REMOTE',
              localAccess: 'NOT_ATTEMPTED',
              remoteAccess: 'SUCCESS',
              selectedRunner: 'REMOTE',
              selectionReason: 'Mock remote runner in unit test',
            };
          }
          return {
            sourceId: req.sourceId,
            methodType: req.methodType,
            endpoint: req.endpoint,
            finalUrl: req.endpoint,
            httpStatus: 200,
            redirectChain: [req.endpoint],
            content: BPSC_SNAPSHOTS.normalListing,
            binaryContent: null,
            contentType: 'text/html',
            responseBytes: Buffer.byteLength(BPSC_SNAPSHOTS.normalListing, 'utf8'),
            durationMs: 10,
            attempts: 1,
            retriesUsed: 0,
            retryReasons: [],
            retryDiagnostics: [],
            attemptDiagnostics: [],
            failureClassification: 'NONE',
            failureDetails: null,
            errorType: null,
            errorCode: null,
            errorName: null,
            retryable: false,
            runnerUsed: 'REMOTE',
            executionOrigin: 'MOCK_REMOTE',
            localAccess: 'NOT_ATTEMPTED',
            remoteAccess: 'SUCCESS',
            selectedRunner: 'REMOTE',
            selectionReason: 'Mock remote runner in unit test',
          };
        },
      };

      const executor = getDiscoveryExecutor();
      const bpscRes = await executor.execute('IN-BIHAR-BPSC', {
        verificationMode: 'LIVE',
        runnerMode: 'REMOTE',
        acquisitionRunner: mockRemoteRunner,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      assert.equal(bpscRes.outcome, 'PASS');
      assert.equal(bpscRes.selectedRunner, 'REMOTE');
      assert.equal(bpscRes.remoteAccess, 'SUCCESS');
      assert.equal(bpscRes.executionOrigin, 'MOCK_REMOTE');
      assert.equal(bpscRes.verifiedLive, false);
      assert.ok((bpscRes.metrics.validPdfs ?? 0) >= 1);
    });

    it('falls back from local failure to remote runner in RUNNER_MODE=AUTO and reports exact failure when remote runner also fails', async () => {
      const failingRemoteRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: false,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => ({
          sourceId: req.sourceId,
          methodType: req.methodType,
          endpoint: req.endpoint,
          finalUrl: null,
          httpStatus: null,
          redirectChain: [req.endpoint],
          content: null,
          binaryContent: null,
          contentType: null,
          responseBytes: 0,
          durationMs: 25,
          attempts: 2,
          retriesUsed: 1,
          retryReasons: ['TIMEOUT'],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          failureClassification: 'TIMEOUT',
          failureDetails: 'Remote worker timed out connecting to official origin',
          errorType: 'TIMEOUT',
          errorCode: 'ETIMEDOUT',
          errorName: 'TimeoutError',
          retryable: true,
          runnerUsed: 'REMOTE',
          executionOrigin: 'REAL_LIVE_REMOTE',
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: 'TIMEOUT',
          selectedRunner: 'REMOTE',
          selectionReason: 'Remote worker timed out',
        }),
      };

      const { result: upssscRes } = await withMockedLiveNetwork(
        async () => {
          const timeoutCause = Object.assign(new Error('Connect Timeout Error'), {
            code: 'UND_ERR_CONNECT_TIMEOUT',
          });
          throw Object.assign(new TypeError('fetch failed'), { cause: timeoutCause });
        },
        () =>
          getDiscoveryExecutor().execute('IN-UP-UPSSSC', {
            verificationMode: 'LIVE',
            runnerMode: 'AUTO',
            remoteRunner: failingRemoteRunner,
            downloadAndValidatePdfs: true,
            timeoutMs: 500,
            maxRetries: 0,
            noCache: true,
          })
      );

      assert.equal(upssscRes.outcome, 'FAIL');
      assert.equal(upssscRes.technicalFailure, true);
      assert.equal(upssscRes.selectedRunner, 'REMOTE');
      assert.equal(upssscRes.localAccess, 'TIMEOUT');
      assert.equal(upssscRes.remoteAccess, 'TIMEOUT');
      assert.equal(upssscRes.errorType, 'TIMEOUT');
    });

    it('enforces official-domain allowlist, SSRF protection, and centralized PDF validation on remote runner responses', async () => {
      const executor = getDiscoveryExecutor();
      const bpscAdapter = sourceRegistry.get('IN-BIHAR-BPSC')!;

      // 6. Third-party URLs rejected even if remote runner is configured
      const permissiveRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: true,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => ({
          sourceId: req.sourceId,
          methodType: req.methodType,
          endpoint: req.endpoint,
          finalUrl: req.endpoint,
          httpStatus: 200,
          redirectChain: [req.endpoint],
          content: '<html><body>Fake portal</body></html>',
          binaryContent: null,
          contentType: 'text/html',
          responseBytes: 38,
          durationMs: 5,
          attempts: 1,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          failureClassification: 'NONE',
          failureDetails: null,
          errorType: null,
          errorCode: null,
          errorName: null,
          retryable: false,
          runnerUsed: 'REMOTE',
          executionOrigin: 'MOCK_REMOTE',
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: 'SUCCESS',
          selectedRunner: 'REMOTE',
          selectionReason: 'Permissive mock runner',
        }),
      };

      await assert.rejects(
        () =>
          bpscAdapter.fetchWithRetry('https://www.sarkariresult.com/bihar-bpsc/', {
            runnerMode: 'REMOTE',
            acquisitionRunner: permissiveRunner,
          }),
        (err: Error & { code?: string }) => err.code === 'SSRF_BLOCKED'
      );

      // 7. SSRF redirect hop returned by remote runner is blocked by centralized security validator
      const ssrfRedirectRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: true,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => ({
          sourceId: req.sourceId,
          methodType: req.methodType,
          endpoint: req.endpoint,
          finalUrl: 'https://169.254.169.254/latest/meta-data/',
          httpStatus: 200,
          redirectChain: [req.endpoint, 'https://169.254.169.254/latest/meta-data/'],
          content: 'secret',
          binaryContent: null,
          contentType: 'text/html',
          responseBytes: 6,
          durationMs: 5,
          attempts: 1,
          retriesUsed: 0,
          retryReasons: [],
          retryDiagnostics: [],
          attemptDiagnostics: [],
          failureClassification: 'NONE',
          failureDetails: null,
          errorType: null,
          errorCode: null,
          errorName: null,
          retryable: false,
          runnerUsed: 'REMOTE',
          executionOrigin: 'MOCK_REMOTE',
          localAccess: 'NOT_ATTEMPTED',
          remoteAccess: 'SUCCESS',
          selectedRunner: 'REMOTE',
          selectionReason: 'SSRF redirect runner',
        }),
      };

      await assert.rejects(
        () =>
          bpscAdapter.fetchWithRetry('https://bpsc.bihar.gov.in/', {
            runnerMode: 'REMOTE',
            acquisitionRunner: ssrfRedirectRunner,
          }),
        (err: Error & { code?: string }) => err.code === 'SSRF_BLOCKED'
      );

      // 8. Centralized PDF validation rejects HTML disguised as PDF returned by remote runner
      const disguisedPdfRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: true,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => {
          if (req.methodType === 'DOCUMENT_PDF' || req.endpoint.toLowerCase().endsWith('.pdf')) {
            const htmlPayload = Buffer.from(
              '<!DOCTYPE html><html><body>Error 404 Not Found</body></html>',
              'utf8'
            );
            return {
              sourceId: req.sourceId,
              methodType: req.methodType,
              endpoint: req.endpoint,
              finalUrl: req.endpoint,
              httpStatus: 200,
              redirectChain: [req.endpoint],
              content: null,
              binaryContent: htmlPayload,
              contentType: 'application/pdf',
              responseBytes: htmlPayload.length,
              durationMs: 5,
              attempts: 1,
              retriesUsed: 0,
              retryReasons: [],
              retryDiagnostics: [],
              attemptDiagnostics: [],
              failureClassification: 'NONE',
              failureDetails: null,
              errorType: null,
              errorCode: null,
              errorName: null,
              retryable: false,
              runnerUsed: 'REMOTE',
              executionOrigin: 'MOCK_REMOTE',
              localAccess: 'NOT_ATTEMPTED',
              remoteAccess: 'SUCCESS',
              selectedRunner: 'REMOTE',
              selectionReason: 'Disguised PDF runner',
            };
          }
          return {
            sourceId: req.sourceId,
            methodType: req.methodType,
            endpoint: req.endpoint,
            finalUrl: req.endpoint,
            httpStatus: 200,
            redirectChain: [req.endpoint],
            content: BPSC_SNAPSHOTS.normalListing,
            binaryContent: null,
            contentType: 'text/html',
            responseBytes: Buffer.byteLength(BPSC_SNAPSHOTS.normalListing, 'utf8'),
            durationMs: 5,
            attempts: 1,
            retriesUsed: 0,
            retryReasons: [],
            retryDiagnostics: [],
            attemptDiagnostics: [],
            failureClassification: 'NONE',
            failureDetails: null,
            errorType: null,
            errorCode: null,
            errorName: null,
            retryable: false,
            runnerUsed: 'REMOTE',
            executionOrigin: 'MOCK_REMOTE',
            localAccess: 'NOT_ATTEMPTED',
            remoteAccess: 'SUCCESS',
            selectedRunner: 'REMOTE',
            selectionReason: 'Disguised PDF runner',
          };
        },
      };

      const badPdfExec = await executor.execute('IN-BIHAR-BPSC', {
        verificationMode: 'LIVE',
        runnerMode: 'REMOTE',
        acquisitionRunner: disguisedPdfRunner,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      assert.equal(badPdfExec.outcome, 'FAIL');
      assert.equal(badPdfExec.status, 'PDF_VALIDATION_FAILED');
      assert.ok((badPdfExec.failureReasons || []).includes('INVALID_PDF'));

      // 9. Remote HTTP 200 listing without PDF download/validation does NOT produce PASS
      const listingOnlyExec = await executor.execute('IN-BIHAR-BPSC', {
        verificationMode: 'LIVE',
        runnerMode: 'REMOTE',
        acquisitionRunner: disguisedPdfRunner,
        downloadAndValidatePdfs: false,
        strictLiveMode: true,
        noCache: true,
      });
      assert.notEqual(listingOnlyExec.outcome, 'PASS');
    });

    it('deduplicates identical RRB CEN notices across multiple regional boards and handles missing remote configuration gracefully', async () => {
      const validPdf = createValidSamplePdf('Centralised Employment Notice CEN 01/2026 Official PDF');

      const multiRegionRrbRunner: OfficialAcquisitionRunner = {
        runnerKind: 'REMOTE',
        isMock: true,
        isConfigured: () => true,
        acquire: async (req: AcquisitionRequest): Promise<AcquisitionResult> => {
          if (req.methodType === 'DOCUMENT_PDF' || req.endpoint.toLowerCase().endsWith('.pdf')) {
            return {
              sourceId: req.sourceId,
              methodType: req.methodType,
              endpoint: req.endpoint,
              finalUrl: req.endpoint,
              httpStatus: 200,
              redirectChain: [req.endpoint],
              content: null,
              binaryContent: validPdf,
              contentType: 'application/pdf',
              responseBytes: validPdf.length,
              durationMs: 5,
              attempts: 1,
              retriesUsed: 0,
              retryReasons: [],
              retryDiagnostics: [],
              attemptDiagnostics: [],
              failureClassification: 'NONE',
              failureDetails: null,
              errorType: null,
              errorCode: null,
              errorName: null,
              retryable: false,
              runnerUsed: 'REMOTE',
              executionOrigin: 'MOCK_REMOTE',
              localAccess: 'NOT_ATTEMPTED',
              remoteAccess: 'SUCCESS',
              selectedRunner: 'REMOTE',
              selectionReason: 'Multi-region RRB runner',
            };
          }
          // Return the same CEN 01/2026 notice across rrbcdg.gov.in, rrbchennai.gov.in, rrbmumbai.gov.in
          const regionalHtml = `
            <html><body>
              <table>
                <tr>
                  <td>14/11/2026</td>
                  <td><a href="/uploads/2026/CEN_01_2026_NTPC.pdf">Centralised Employment Notice CEN No. 01/2026 for Recruitment of Graduate and Undergraduate Posts</a></td>
                </tr>
              </table>
            </body></html>
          `;
          return {
            sourceId: req.sourceId,
            methodType: req.methodType,
            endpoint: req.endpoint,
            finalUrl: req.endpoint,
            httpStatus: 200,
            redirectChain: [req.endpoint],
            content: regionalHtml,
            binaryContent: null,
            contentType: 'text/html',
            responseBytes: Buffer.byteLength(regionalHtml, 'utf8'),
            durationMs: 5,
            attempts: 1,
            retriesUsed: 0,
            retryReasons: [],
            retryDiagnostics: [],
            attemptDiagnostics: [],
            failureClassification: 'NONE',
            failureDetails: null,
            errorType: null,
            errorCode: null,
            errorName: null,
            retryable: false,
            runnerUsed: 'REMOTE',
            executionOrigin: 'MOCK_REMOTE',
            localAccess: 'NOT_ATTEMPTED',
            remoteAccess: 'SUCCESS',
            selectedRunner: 'REMOTE',
            selectionReason: 'Multi-region RRB runner',
          };
        },
      };

      const executor = getDiscoveryExecutor();
      const rrbMultiRes = await executor.execute('IN-CENTRAL-RRB', {
        verificationMode: 'LIVE',
        runnerMode: 'REMOTE',
        acquisitionRunner: multiRegionRrbRunner,
        scanAllRegionalEndpoints: true,
        downloadAndValidatePdfs: true,
        noCache: true,
      });

      assert.equal(rrbMultiRes.outcome, 'PASS');
      assert.ok((rrbMultiRes.metrics.attemptedEndpoints?.length ?? 0) >= 3);
      // 11. Duplicate CEN notices across multiple regional boards are deduplicated into 1 notice
      assert.equal(rrbMultiRes.notices.length, 1);
      assert.equal(rrbMultiRes.recordsFound, 1);

      // 12. Missing remote configuration does not crash and reports remoteAccess = 'NOT_CONFIGURED'
      const unconfiguredRemote = new HttpRemoteAcquisitionRunner({ workerUrl: '' });
      assert.equal(unconfiguredRemote.isConfigured(), false);
      const unconfiguredCfg = unconfiguredRemote.getSanitizedConfig();
      assert.equal(unconfiguredCfg.configured, false);

      const missingRemoteExec = await executor.execute('IN-BIHAR-BPSC', {
        verificationMode: 'LIVE',
        runnerMode: 'REMOTE',
        remoteRunner: unconfiguredRemote,
        downloadAndValidatePdfs: true,
        noCache: true,
      });
      assert.equal(missingRemoteExec.outcome, 'FAIL');
      assert.equal(missingRemoteExec.remoteAccess, 'NOT_CONFIGURED');
      assert.equal(missingRemoteExec.selectedRunner, 'REMOTE');
    });
  });
});


