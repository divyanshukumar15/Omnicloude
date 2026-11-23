/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection.ts';
import { SqliteSourceRepository } from './repositories/sqlite-repositories.ts';
import type { SourceEntity, SourceType } from './types.ts';
import { logger } from '../config/logger.ts';

export interface OfficialSourceBootstrapDefinition {
  id: string;
  name: string;
  authority: string;
  jurisdiction: 'CENTRAL' | 'STATE';
  state?: string;
  type: SourceType;
  baseUrl: string;
  officialDomains: string[];
  adapterType: string;
  isActive: number;
  checkIntervalMinutes: number;
  discoveryConfig: {
    listingPath: string;
    supportsDirectPdf: boolean;
    supportsDetailFollow: boolean;
  };
}

/**
 * Authoritative registry of the 7 official Indian government recruitment portals
 * bootstrapped idempotently on fresh databases so SourceDiscoverySeeder never sits idle.
 */
export const OFFICIAL_BOOTSTRAP_SOURCES: readonly OfficialSourceBootstrapDefinition[] = [
  {
    id: 'IN-CENTRAL-SSC',
    name: 'Staff Selection Commission (SSC)',
    authority: 'Staff Selection Commission, Government of India',
    jurisdiction: 'CENTRAL',
    type: 'PORTAL',
    baseUrl: 'https://ssc.gov.in',
    officialDomains: ['ssc.gov.in', 'ssc.nic.in'],
    adapterType: 'SscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/api/general-website/portal/notice-boards',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-CENTRAL-UPSC',
    name: 'Union Public Service Commission (UPSC)',
    authority: 'Union Public Service Commission, Government of India',
    jurisdiction: 'CENTRAL',
    type: 'PORTAL',
    baseUrl: 'https://upsc.gov.in',
    officialDomains: ['upsc.gov.in', 'upsconline.nic.in', 'upsconline.gov.in'],
    adapterType: 'UpscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/examinations/active-exams',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-CENTRAL-RRB',
    name: 'Railway Recruitment Boards (RRB)',
    authority: 'Ministry of Railways, Government of India',
    jurisdiction: 'CENTRAL',
    type: 'PORTAL',
    baseUrl: 'https://www.rrbcdg.gov.in',
    officialDomains: ['rrbcdg.gov.in', 'indianrailways.gov.in', 'rrbapply.gov.in'],
    adapterType: 'RrbSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-BIHAR-BPSC',
    name: 'Bihar Public Service Commission (BPSC)',
    authority: 'Bihar Public Service Commission, Government of Bihar',
    jurisdiction: 'STATE',
    state: 'Bihar',
    type: 'PORTAL',
    baseUrl: 'https://www.bpsc.bih.nic.in',
    officialDomains: ['bpsc.bih.nic.in', 'bpsc.bihar.gov.in', 'onlinebpsc.bihar.gov.in'],
    adapterType: 'BpscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-BIHAR-BSSC',
    name: 'Bihar Staff Selection Commission (BSSC)',
    authority: 'Bihar Staff Selection Commission, Government of Bihar',
    jurisdiction: 'STATE',
    state: 'Bihar',
    type: 'PORTAL',
    baseUrl: 'https://bssc.bihar.gov.in',
    officialDomains: ['bssc.bihar.gov.in', 'onlinebssc.com'],
    adapterType: 'BsscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/NoticeBoard.htm',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-UP-UPPSC',
    name: 'Uttar Pradesh Public Service Commission (UPPSC)',
    authority: 'Uttar Pradesh Public Service Commission, Government of Uttar Pradesh',
    jurisdiction: 'STATE',
    state: 'Uttar Pradesh',
    type: 'PORTAL',
    baseUrl: 'https://uppsc.up.nic.in',
    officialDomains: ['uppsc.up.nic.in'],
    adapterType: 'UppscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/AllNotifications.aspx',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
  {
    id: 'IN-UP-UPSSSC',
    name: 'Uttar Pradesh Subordinate Services Selection Commission (UPSSSC)',
    authority: 'UPSSSC, Government of Uttar Pradesh',
    jurisdiction: 'STATE',
    state: 'Uttar Pradesh',
    type: 'PORTAL',
    baseUrl: 'https://upsssc.gov.in',
    officialDomains: ['upsssc.gov.in'],
    adapterType: 'UpssscSourceAdapter',
    isActive: 1,
    checkIntervalMinutes: 60,
    discoveryConfig: {
      listingPath: '/Default.aspx',
      supportsDirectPdf: true,
      supportsDetailFollow: true,
    },
  },
];

export interface SourceBootstrapResult {
  totalDefined: number;
  insertedCount: number;
  preservedCount: number;
  insertedIds: string[];
  preservedIds: string[];
  activeSourceCount: number;
  totalSourceCount: number;
  sources: SourceEntity[];
}

/**
 * Idempotently bootstraps all 7 official recruitment sources into the `sources` table.
 * - Inserts missing sources with canonical authority, domain, adapter, interval, and active flag.
 * - NEVER overwrites existing source configurations or re-enables manually disabled sources (is_active = 0).
 */
export function bootstrapOfficialSources(db?: DatabaseSync): SourceBootstrapResult {
  const database = db ?? getDatabase();
  const repo = new SqliteSourceRepository(database);
  const insertedIds: string[] = [];
  const preservedIds: string[] = [];

  for (const def of OFFICIAL_BOOTSTRAP_SOURCES) {
    const existing = repo.findById(def.id);
    if (existing) {
      preservedIds.push(def.id);
      continue;
    }

    const configJson = JSON.stringify({
      authority: def.authority,
      jurisdiction: def.jurisdiction,
      state: def.state ?? null,
      officialDomains: def.officialDomains,
      adapterType: def.adapterType,
      discoveryConfig: def.discoveryConfig,
      bootstrapped: true,
    });

    repo.create({
      id: def.id,
      name: def.name,
      type: def.type,
      base_url: def.baseUrl,
      is_active: def.isActive,
      check_interval_minutes: def.checkIntervalMinutes,
      config_json: configJson,
    });
    insertedIds.push(def.id);
  }

  const allSources = repo.listAll();
  const activeSources = repo.listActive();

  if (insertedIds.length > 0) {
    logger.info('Bootstrapped official recruitment sources into database', {
      insertedCount: insertedIds.length,
      preservedCount: preservedIds.length,
      insertedIds,
      activeSourceCount: activeSources.length,
    });
  }

  return {
    totalDefined: OFFICIAL_BOOTSTRAP_SOURCES.length,
    insertedCount: insertedIds.length,
    preservedCount: preservedIds.length,
    insertedIds,
    preservedIds,
    activeSourceCount: activeSources.length,
    totalSourceCount: allSources.length,
    sources: allSources,
  };
}
