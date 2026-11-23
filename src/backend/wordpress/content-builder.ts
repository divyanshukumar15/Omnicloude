/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { ApplicationFeeStructure } from '../extraction/types.ts';
import type {
  FormattedWordPressJobPost,
  WordPressBuildContentInput,
  WordPressIdentityInput,
} from './types.ts';

function sanitizeSlugSegment(input: string, maxLen = 36): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen) || 'entity'
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatApplicationFee(fee: ApplicationFeeStructure | string | null | undefined): string {
  if (!fee) return 'As per Official Notification';
  if (typeof fee === 'string') return fee.trim() || 'As per Official Notification';

  const parts: string[] = [];
  if (fee.unreserved !== null && fee.unreserved !== undefined) parts.push(`UR/General: ₹${fee.unreserved}`);
  if (fee.obc !== null && fee.obc !== undefined) parts.push(`OBC: ₹${fee.obc}`);
  if (fee.ews !== null && fee.ews !== undefined) parts.push(`EWS: ₹${fee.ews}`);
  if (fee.sc !== null && fee.sc !== undefined) parts.push(`SC: ₹${fee.sc}`);
  if (fee.st !== null && fee.st !== undefined) parts.push(`ST: ₹${fee.st}`);
  if (fee.female !== null && fee.female !== undefined) parts.push(`Female: ₹${fee.female}`);
  if (fee.pwd !== null && fee.pwd !== undefined) parts.push(`PwD: ₹${fee.pwd}`);
  if (fee.exemptionDetails) parts.push(fee.exemptionDetails);

  if (parts.length > 0) return parts.join(' | ');
  if (fee.rawSnippet) return fee.rawSnippet;
  return 'As per Official Notification';
}

export function normalizeCanonicalUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Computes a deterministic external job/recruitment identity key from:
 * sourceId + recruitmentId/jobId + canonical official URL hash.
 * Ensures the same recruitment/job never creates duplicate WordPress posts on retry.
 */
export function computeDeterministicExternalIdentity(input: WordPressIdentityInput): {
  externalIdentityKey: string;
  urlHash: string;
} {
  const normalizedSource = sanitizeSlugSegment(input.sourceId, 24);
  const entityId =
    input.jobId && input.jobId.trim() ? input.jobId.trim() : input.recruitmentId.trim();
  const normalizedEntity = sanitizeSlugSegment(entityId, 32);

  const canonicalUrl = normalizeCanonicalUrl(
    input.officialNotificationUrl || input.canonicalSourceUrl || ''
  );

  const canonicalDigestInput = [
    input.sourceId.trim().toUpperCase(),
    entityId,
    canonicalUrl,
  ].join('|');

  const urlHash = crypto
    .createHash('sha256')
    .update(canonicalDigestInput)
    .digest('hex')
    .slice(0, 12);
  const externalIdentityKey = `omnihub-${normalizedSource}-${normalizedEntity}-${urlHash}`;

  return {
    externalIdentityKey,
    urlHash,
  };
}

export function resolveWordPressSectionCategory(noticeCategory?: string | null): string {
  const normalized = (noticeCategory || 'NOTIFICATION').trim().toUpperCase();
  if (normalized === 'ADMIT_CARD' || normalized === 'ADMIT CARD') {
    return 'Admit Card';
  }
  if (normalized === 'RESULT' || normalized === 'RESULTS') {
    return 'Results';
  }
  if (normalized === 'ANSWER_KEY') {
    return 'Answer Key';
  }
  if (normalized === 'CORRIGENDUM') {
    return 'Corrigendum';
  }
  return 'Latest Jobs';
}

/**
 * Builds structured, semantic HTML job content, category names, canonical links,
 * and embedded deterministic external identity markers for WordPress publishing.
 */
export function buildWordPressJobContent(input: WordPressBuildContentInput): FormattedWordPressJobPost {
  const { fields } = input;

  const organization = String(
    fields.organization?.value || 'Official Government Organization'
  ).trim();
  const recruitmentTitle = String(
    fields.recruitment_title?.value || 'Official Recruitment Notification'
  ).trim();
  const advtNumber = fields.advertisement_number?.value
    ? String(fields.advertisement_number.value).trim()
    : 'Refer Official Notification';
  const totalVacancies =
    fields.total_vacancies?.value !== null && fields.total_vacancies?.value !== undefined
      ? String(fields.total_vacancies.value)
      : 'As per Official Notification';

  const startDate = fields.application_start_date?.value
    ? String(fields.application_start_date.value).trim()
    : 'Not Specified';
  const lastDate = fields.application_last_date?.value
    ? String(fields.application_last_date.value).trim()
    : 'Refer Official Notification';
  const examDate = fields.exam_date?.value
    ? String(fields.exam_date.value).trim()
    : 'To Be Notified';

  const qualification = fields.educational_qualification?.value
    ? String(fields.educational_qualification.value).trim()
    : 'Refer Official Notification';

  const ageMin =
    fields.age_min?.value !== null && fields.age_min?.value !== undefined
      ? `${fields.age_min.value} Years`
      : null;
  const ageMax =
    fields.age_max?.value !== null && fields.age_max?.value !== undefined
      ? `${fields.age_max.value} Years`
      : null;
  const ageLimitText =
    ageMin && ageMax
      ? `${ageMin} to ${ageMax}`
      : ageMax
      ? `Up to ${ageMax}`
      : ageMin
      ? `Minimum ${ageMin}`
      : 'As per Official Rules';

  const applicationFee = formatApplicationFee(fields.application_fee?.value);

  const payScale = fields.salary_pay_level?.value
    ? String(fields.salary_pay_level.value).trim()
    : 'As per Government Pay Matrix';

  const experience = fields.experience?.value
    ? String(fields.experience.value).trim()
    : null;

  const selectionProcessList = Array.isArray(fields.selection_process?.value)
    ? fields.selection_process.value.map((s) => String(s).trim()).filter(Boolean)
    : typeof fields.selection_process?.value === 'string' &&
      fields.selection_process.value.trim()
    ? [fields.selection_process.value.trim()]
    : [];

  const officialNotificationUrl = String(
    input.officialNotificationUrl ||
      fields.official_notification_url?.value ||
      input.canonicalSourceUrl ||
      ''
  ).trim();

  const canonicalSourceUrl = String(
    input.canonicalSourceUrl ||
      fields.official_application_url?.value ||
      officialNotificationUrl ||
      ''
  ).trim();

  const { externalIdentityKey } = computeDeterministicExternalIdentity({
    sourceId: input.sourceId,
    recruitmentId: input.recruitmentId,
    jobId: input.jobId,
    canonicalSourceUrl,
    officialNotificationUrl,
  });

  const postTitle = `${organization}: ${recruitmentTitle}${
    fields.advertisement_number?.value ? ` (${fields.advertisement_number.value})` : ''
  }`;

  const excerpt = `${organization} has released official notification ${advtNumber} for ${recruitmentTitle} (${totalVacancies} vacancies). Last date to apply: ${lastDate}.`;

  // Category-wise vacancy breakdown rows if present
  const categoryBreakdown = fields.category_wise_vacancies?.value;
  const categoryEntries: Array<[string, number]> = [];
  if (categoryBreakdown && typeof categoryBreakdown === 'object') {
    for (const [key, val] of Object.entries(categoryBreakdown)) {
      if (key === 'other' && val && typeof val === 'object') {
        for (const [otherKey, otherVal] of Object.entries(val as Record<string, number>)) {
          if (typeof otherVal === 'number') {
            categoryEntries.push([otherKey.toUpperCase(), otherVal]);
          }
        }
      } else if (typeof val === 'number') {
        categoryEntries.push([key.toUpperCase(), val]);
      }
    }
  }

  const categoryBreakdownRowsHtml = categoryEntries
    .map(
      ([cat, count]) =>
        `<tr><td><strong>${escapeHtml(cat)}</strong></td><td>${escapeHtml(String(count))}</td></tr>`
    )
    .join('\n');

  const htmlSections: string[] = [
    `<!-- omnihub-external-identity:${escapeHtml(externalIdentityKey)} -->`,
    `<article class="omnihub-govjob-notification" data-external-identity="${escapeHtml(externalIdentityKey)}" data-source-id="${escapeHtml(input.sourceId)}" data-recruitment-id="${escapeHtml(input.recruitmentId)}">`,
    `  <p class="omnihub-lead">${escapeHtml(excerpt)}</p>`,
    `  <h2>Recruitment Overview</h2>`,
    `  <table class="omnihub-overview-table">`,
    `    <tbody>`,
    `      <tr><th>Recruiting Organization</th><td>${escapeHtml(organization)}</td></tr>`,
    `      <tr><th>Recruitment / Examination</th><td>${escapeHtml(recruitmentTitle)}</td></tr>`,
    `      <tr><th>Advertisement Number</th><td>${escapeHtml(advtNumber)}</td></tr>`,
    `      <tr><th>Total Vacancies</th><td>${escapeHtml(totalVacancies)}</td></tr>`,
    `      <tr><th>Pay Scale / Salary Level</th><td>${escapeHtml(payScale)}</td></tr>`,
    `    </tbody>`,
    `  </table>`,
  ];

  if (categoryBreakdownRowsHtml) {
    htmlSections.push(
      `  <h2>Category-Wise Vacancy Details</h2>`,
      `  <table class="omnihub-vacancy-table">`,
      `    <thead><tr><th>Category</th><th>Vacancies</th></tr></thead>`,
      `    <tbody>`,
      categoryBreakdownRowsHtml,
      `    </tbody>`,
      `  </table>`
    );
  }

  htmlSections.push(
    `  <h2>Important Dates</h2>`,
    `  <table class="omnihub-dates-table">`,
    `    <tbody>`,
    `      <tr><th>Application Start Date</th><td>${escapeHtml(startDate)}</td></tr>`,
    `      <tr><th>Application Last Date</th><td>${escapeHtml(lastDate)}</td></tr>`,
    `      <tr><th>Examination Date</th><td>${escapeHtml(examDate)}</td></tr>`,
    `    </tbody>`,
    `  </table>`,
    `  <h2>Eligibility Criteria &amp; Age Limit</h2>`,
    `  <ul>`,
    `    <li><strong>Educational Qualification:</strong> ${escapeHtml(qualification)}</li>`,
    ...(experience ? [`    <li><strong>Experience:</strong> ${escapeHtml(experience)}</li>`] : []),
    `    <li><strong>Age Limit:</strong> ${escapeHtml(ageLimitText)}</li>`,
    `    <li><strong>Application Fee:</strong> ${escapeHtml(applicationFee)}</li>`,
    `  </ul>`
  );

  if (selectionProcessList.length > 0) {
    htmlSections.push(
      `  <h2>Selection Process</h2>`,
      `  <ol>`,
      ...selectionProcessList.map((step) => `    <li>${escapeHtml(step)}</li>`),
      `  </ol>`
    );
  }

  htmlSections.push(
    `  <h2>Official Links &amp; Verification Provenance</h2>`,
    `  <table class="omnihub-links-table">`,
    `    <tbody>`,
    `      <tr><th>Official Notification PDF</th><td><a href="${escapeHtml(officialNotificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(officialNotificationUrl)}</a></td></tr>`,
    `      <tr><th>Canonical Official Source URL</th><td><a href="${escapeHtml(canonicalSourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(canonicalSourceUrl)}</a></td></tr>`,
    `      <tr><th>Verification Identity Key</th><td><code>${escapeHtml(externalIdentityKey)}</code></td></tr>`,
    `    </tbody>`,
    `  </table>`,
    `</article>`
  );

  const htmlContent = htmlSections.join('\n');

  const sectionCategory = resolveWordPressSectionCategory(input.noticeCategory);
  const defaultCategories = [
    sectionCategory,
    'Government Jobs',
    organization,
    input.sourceId.includes('CENTRAL') ? 'Central Government Jobs' : 'State Government Jobs',
  ];

  const categoryNames = Array.from(
    new Set(
      (input.categoryNames && input.categoryNames.length > 0
        ? input.categoryNames
        : defaultCategories
      )
        .map((c) => c.trim())
        .filter(Boolean)
    )
  );

  const payloadHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        externalIdentityKey,
        title: postTitle,
        htmlContent,
        canonicalSourceUrl,
        officialNotificationUrl,
        categoryNames,
      })
    )
    .digest('hex');

  return {
    externalIdentityKey,
    slug: externalIdentityKey,
    title: postTitle,
    excerpt,
    htmlContent,
    categoryNames,
    canonicalSourceUrl,
    officialNotificationUrl,
    payloadHash,
  };
}
