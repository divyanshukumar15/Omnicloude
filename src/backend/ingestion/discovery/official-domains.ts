/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { URL } from 'node:url';
import type { DomainTrustCategory } from '../adapters/source-adapter.interface.ts';

/**
 * Strict Official Government Source Domain Registry.
 *
 * Ensures the GovJobs Automation system ONLY extracts and ingests notices/documents
 * from genuine verified government endpoints, rejecting aggregator sites and lookalikes.
 */

export interface SourceDomainConfig {
  sourceId: string;
  name: string;
  category: 'CENTRAL' | 'STATE_BIHAR' | 'STATE_UP';
  primaryDomains: string[];
  regionalOrSubdomains: string[];
  allowedCdnsOrStorage: string[];
}

export const OFFICIAL_SOURCE_DOMAINS: Record<string, SourceDomainConfig> = {
  'IN-CENTRAL-SSC': {
    sourceId: 'IN-CENTRAL-SSC',
    name: 'Staff Selection Commission',
    category: 'CENTRAL',
    primaryDomains: ['ssc.gov.in', 'ssc.nic.in'],
    regionalOrSubdomains: [
      'ssc-cr.org',
      'sscsr.gov.in',
      'sscner.org.in',
      'sscnwr.org',
      'sscmpr.org',
      'ssckkr.kar.nic.in',
      'sscwr.net',
      'sscer.org',
    ],
    allowedCdnsOrStorage: ['ssc.gov.in', 'ssc.nic.in'],
  },
  'IN-CENTRAL-UPSC': {
    sourceId: 'IN-CENTRAL-UPSC',
    name: 'Union Public Service Commission',
    category: 'CENTRAL',
    primaryDomains: ['www.upsc.gov.in', 'upsc.gov.in', 'upsconline.nic.in', 'upsconline.gov.in'],
    regionalOrSubdomains: ['www.upsc.gov.in'],
    allowedCdnsOrStorage: ['www.upsc.gov.in', 'upsc.gov.in', 'upsconline.nic.in', 'upsconline.gov.in'],
  },
  'IN-CENTRAL-RRB': {
    sourceId: 'IN-CENTRAL-RRB',
    name: 'Railway Recruitment Boards',
    category: 'CENTRAL',
    primaryDomains: ['rrbcdg.gov.in', 'rrbapply.gov.in', 'www.rrbapply.gov.in', 'indianrailways.gov.in'],
    regionalOrSubdomains: [
      'rrbcdg.gov.in',
      'rrbmumbai.gov.in',
      'rrbkolkata.gov.in',
      'rrbsecunderabad.gov.in',
      'rrbchennai.gov.in',
      'rrbpatna.gov.in',
      'rrbahmedabad.gov.in',
      'rrbbhopal.gov.in',
      'rrbajmer.gov.in',
      'rrbbnc.gov.in',
      'rrbgkp.gov.in',
      'rrbguwahati.gov.in',
      'rrbjammu.nic.in',
      'rrbmalda.gov.in',
      'rrbmuzaffarpur.gov.in',
      'rrbranchi.gov.in',
      'rrbsiliguri.gov.in',
      'rrbthiruvananthapuram.gov.in',
      'rrbald.gov.in',
      'rrbpryj.gov.in',
      'rrbprayagraj.gov.in',
      'rrbgorakhpur.gov.in',
      'rrbpes.gov.in',
      'rrballahabad.gov.in',
      'rrbbbs.gov.in',
      'rrbbilaspur.gov.in',
      'rrb.indianrailways.gov.in',
    ],
    allowedCdnsOrStorage: [
      'rrbcdg.gov.in',
      'indianrailways.gov.in',
      'rrbapply.gov.in',
      'www.rrbapply.gov.in',
      'railnet.gov.in',
    ],
  },
  'IN-BIHAR-BPSC': {
    sourceId: 'IN-BIHAR-BPSC',
    name: 'Bihar Public Service Commission',
    category: 'STATE_BIHAR',
    primaryDomains: ['bpsc.bih.nic.in', 'bpsc.bihar.gov.in'],
    regionalOrSubdomains: [],
    allowedCdnsOrStorage: ['bpsc.bih.nic.in', 'bpsc.bihar.gov.in'],
  },
  'IN-BIHAR-BSSC': {
    sourceId: 'IN-BIHAR-BSSC',
    name: 'Bihar Staff Selection Commission',
    category: 'STATE_BIHAR',
    primaryDomains: ['bssc.bihar.gov.in', 'bssc.bih.nic.in'],
    regionalOrSubdomains: [],
    allowedCdnsOrStorage: ['bssc.bihar.gov.in', 'bssc.bih.nic.in'],
  },
  'IN-UP-UPPSC': {
    sourceId: 'IN-UP-UPPSC',
    name: 'Uttar Pradesh Public Service Commission',
    category: 'STATE_UP',
    primaryDomains: ['uppsc.up.nic.in'],
    regionalOrSubdomains: [],
    allowedCdnsOrStorage: ['uppsc.up.nic.in'],
  },
  'IN-UP-UPSSSC': {
    sourceId: 'IN-UP-UPSSSC',
    name: 'Uttar Pradesh Subordinate Services Selection Commission',
    category: 'STATE_UP',
    primaryDomains: ['upsssc.gov.in'],
    regionalOrSubdomains: [],
    allowedCdnsOrStorage: ['upsssc.gov.in'],
  },
};

/**
 * Universal trusted Indian Government suffixes.
 * Official government websites in India terminate in `.gov.in` or `.nic.in`.
 */
const TRUSTED_GOV_SUFFIXES = ['.gov.in', '.nic.in'];

/**
 * Known third-party aggregator domains to unconditionally reject.
 */
const KNOWN_AGGREGATOR_PATTERNS = [
  'sarkariresult',
  'freejobalert',
  'jagranjosh',
  'testbook',
  'adda247',
  'careerpower',
  'shiksha',
  'collegedunia',
  'indgovtjobs',
  'fresherslive',
  'rojgarsamachar',
  'safalta',
  'wifistudy',
  'naukri',
  'shine',
  'monster',
  'indeed',
  'glassdoor',
  'apify',
];

/**
 * Registers an additional regional RRB domain dynamically.
 */
export function registerRrbRegionalDomain(domain: string): void {
  const cleanDomain = domain.toLowerCase().trim();
  const rrbConfig = OFFICIAL_SOURCE_DOMAINS['IN-CENTRAL-RRB'];
  if (rrbConfig && !rrbConfig.regionalOrSubdomains.includes(cleanDomain)) {
    rrbConfig.regionalOrSubdomains.push(cleanDomain);
  }
}

export function getAllowedDomainsForSource(sourceId: string): string[] {
  const config = OFFICIAL_SOURCE_DOMAINS[sourceId];
  if (!config) return [];
  return [
    ...config.primaryDomains,
    ...config.regionalOrSubdomains,
    ...config.allowedCdnsOrStorage,
  ];
}

export function getAllOfficialDomains(): string[] {
  const all = new Set<string>();
  for (const config of Object.values(OFFICIAL_SOURCE_DOMAINS)) {
    config.primaryDomains.forEach(d => all.add(d.toLowerCase()));
    config.regionalOrSubdomains.forEach(d => all.add(d.toLowerCase()));
    config.allowedCdnsOrStorage.forEach(d => all.add(d.toLowerCase()));
  }
  return Array.from(all);
}

/**
 * Classifies domain trust into OFFICIAL_DOMAIN, NON_OFFICIAL_DOMAIN, or UNKNOWN_DOMAIN.
 */
export function classifyDomainTrust(
  targetUrl: string,
  sourceId?: string
): {
  category: DomainTrustCategory;
  isOfficial: boolean;
  domain: string;
  reason?: string;
} {
  try {
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname.toLowerCase();

    // Check scheme
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        category: 'UNKNOWN_DOMAIN',
        isOfficial: false,
        domain: hostname,
        reason: `Disallowed protocol: ${parsed.protocol}`,
      };
    }

    // Check against known third-party job aggregators -> NON_OFFICIAL_DOMAIN
    for (const pattern of KNOWN_AGGREGATOR_PATTERNS) {
      if (hostname.includes(pattern)) {
        return {
          category: 'NON_OFFICIAL_DOMAIN',
          isOfficial: false,
          domain: hostname,
          reason: `Rejected third-party job aggregator domain pattern: ${pattern}`,
        };
      }
    }

    // IP addresses or localhost -> UNKNOWN_DOMAIN (SSRF hazard)
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
      return {
        category: 'UNKNOWN_DOMAIN',
        isOfficial: false,
        domain: hostname,
        reason: 'IP addresses and local hostnames are not official domains',
      };
    }

    // If sourceId is provided, check source-specific domains first -> OFFICIAL_DOMAIN
    if (sourceId && OFFICIAL_SOURCE_DOMAINS[sourceId]) {
      const allowedDomains = getAllowedDomainsForSource(sourceId).map(d => d.toLowerCase());
      const isDirectMatch = allowedDomains.some(
        d => hostname === d || hostname.endsWith(`.${d}`)
      );
      if (isDirectMatch) {
        return {
          category: 'OFFICIAL_DOMAIN',
          isOfficial: true,
          domain: hostname,
        };
      }
    }

    // Check all registered official domains across all 7 sources -> OFFICIAL_DOMAIN
    const allRegistered = getAllOfficialDomains();
    const matchesAnyOfficial = allRegistered.some(
      d => hostname === d || hostname.endsWith(`.${d}`)
    );
    if (matchesAnyOfficial) {
      return {
        category: 'OFFICIAL_DOMAIN',
        isOfficial: true,
        domain: hostname,
      };
    }

    // Generic .gov.in or .nic.in official Indian government suffix -> OFFICIAL_DOMAIN
    const isGovSuffix = TRUSTED_GOV_SUFFIXES.some(suffix => hostname.endsWith(suffix));
    if (isGovSuffix) {
      return {
        category: 'OFFICIAL_DOMAIN',
        isOfficial: true,
        domain: hostname,
      };
    }

    // Commercial or untrusted non-government domain -> NON_OFFICIAL_DOMAIN
    if (hostname.endsWith('.com') || hostname.endsWith('.org') || hostname.endsWith('.net') || hostname.endsWith('.io')) {
      return {
        category: 'NON_OFFICIAL_DOMAIN',
        isOfficial: false,
        domain: hostname,
        reason: `Domain ${hostname} is a non-official commercial or untrusted domain`,
      };
    }

    return {
      category: 'UNKNOWN_DOMAIN',
      isOfficial: false,
      domain: hostname,
      reason: `Domain ${hostname} is not verified as an official government source`,
    };
  } catch (err) {
    return {
      category: 'UNKNOWN_DOMAIN',
      isOfficial: false,
      domain: '',
      reason: `Invalid URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Legacy compatibility wrapper around classifyDomainTrust.
 */
export function isOfficialDomain(
  targetUrl: string,
  sourceId?: string
): { allowed: boolean; reason?: string; domain?: string; category: DomainTrustCategory } {
  const result = classifyDomainTrust(targetUrl, sourceId);
  return {
    allowed: result.isOfficial,
    reason: result.reason,
    domain: result.domain,
    category: result.category,
  };
}
