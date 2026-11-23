/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

export interface RecruitmentIdentityInput {
  authority: string;
  advertisementNumber?: string | null;
  cenNumber?: string | null;
  title: string;
  postName?: string | null;
  documentUrl?: string | null;
  publishedDate?: string | null;
}

export interface DeterministicRecruitmentIdentity {
  identityKey: string;
  canonicalId: string;
  normalizedAuthority: string;
  normalizedAdvertisement: string | null;
  normalizedTitle: string;
  deterministicSlug: string;
}

/**
 * Normalizes title by removing noise, extra spaces, dates, file extensions, and casing.
 */
function normalizeRecruitmentTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/\.pdf(?:\?.*)?$/i, '')
    .replace(/\b(?:notice|notification|advertisement|detailed|download|view|file)\b/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes authority name for deterministic cross-region deduplication.
 * Crucially normalizes all regional RRB boards (e.g. RRB Mumbai, RRB Patna, IN-CENTRAL-RRB)
 * to 'RRB' when dealing with Centralized Employment Notices (CEN).
 */
export function normalizeAuthority(authority: string, advtOrCen?: string | null): string {
  const upper = (authority || 'UNKNOWN').trim().toUpperCase();
  if (
    upper === 'IN-CENTRAL-RRB' ||
    upper.startsWith('RRB') ||
    upper.includes('RAILWAY RECRUITMENT') ||
    (advtOrCen && /^CEN/i.test(advtOrCen.trim()))
  ) {
    return 'RRB';
  }
  return upper;
}

/**
 * Normalizes advertisement or CEN number for deterministic equality.
 */
function normalizeAdvt(advt?: string | null): string | null {
  if (!advt) return null;
  return advt
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9/_-]/g, '');
}

/**
 * Generates a deterministic recruitment identity to prevent duplicate job creation across
 * listing pages, detail pages, PDFs, pagination, and repeated crawls.
 * PRIORITY: (advt / CEN + authority + postName) -> (authority + normalized title)
 */
export function generateRecruitmentIdentity(
  input: RecruitmentIdentityInput
): DeterministicRecruitmentIdentity {
  const normalizedAdvt = normalizeAdvt(input.advertisementNumber || input.cenNumber);
  const normalizedAuthority = normalizeAuthority(input.authority, normalizedAdvt);
  const normalizedTitle = normalizeRecruitmentTitle(input.title);
  const normalizedPost = input.postName ? normalizeRecruitmentTitle(input.postName) : null;

  // If a well-formed advertisement / CEN number exists, it is the primary deterministic anchor
  let identityBasis: string;
  let deterministicSlug: string;

  if (normalizedAdvt && normalizedAdvt.length >= 3) {
    if (normalizedPost && normalizedPost.length >= 2) {
      identityBasis = `${normalizedAuthority}::ADVT::${normalizedAdvt}::POST::${normalizedPost}`;
      deterministicSlug = `${normalizedAuthority.toLowerCase()}-${normalizedAdvt.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${normalizedPost.slice(0, 15).replace(/\s+/g, '-')}`;
    } else {
      identityBasis = `${normalizedAuthority}::ADVT::${normalizedAdvt}`;
      deterministicSlug = `${normalizedAuthority.toLowerCase()}-${normalizedAdvt.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    }
  } else {
    // Fall back to authority + normalized title keywords
    const postSuffix = normalizedPost ? `::${normalizedPost}` : '';
    identityBasis = `${normalizedAuthority}::TITLE::${normalizedTitle.slice(0, 80)}${postSuffix}`;
    const slugTitle = normalizedTitle.slice(0, 40).replace(/\s+/g, '-');
    deterministicSlug = `${normalizedAuthority.toLowerCase()}-${slugTitle}`;
  }

  const identityKey = crypto
    .createHash('sha256')
    .update(identityBasis)
    .digest('hex');

  const canonicalId = `rec-${deterministicSlug.slice(0, 36)}-${identityKey.slice(0, 8)}`;

  return {
    identityKey,
    canonicalId,
    normalizedAuthority,
    normalizedAdvertisement: normalizedAdvt,
    normalizedTitle,
    deterministicSlug,
  };
}
