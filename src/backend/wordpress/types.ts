/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StructuredRecruitmentData } from '../extraction/types.ts';

export type WordPressPublishStatus = 'draft' | 'publish';

export type WordPressReadinessState = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'READY';

export type WordPressVerificationTier =
  | 'CODE_IMPLEMENTED'
  | 'TEST_VERIFIED'
  | 'REAL_WORDPRESS_RUNTIME_VERIFIED'
  | 'REAL_WORDPRESS_PRODUCTION_VERIFIED';

export type WordPressErrorCode =
  | 'WP_NOT_CONFIGURED'
  | 'WP_INVALID_URL'
  | 'WP_INSECURE_URL'
  | 'WP_AUTH_FAILED'
  | 'WP_TIMEOUT'
  | 'WP_RATE_LIMITED'
  | 'WP_SERVER_ERROR'
  | 'WP_NETWORK_ERROR'
  | 'WP_CATEGORY_MAPPING_FAILED'
  | 'WP_MEDIA_UPLOAD_FAILED'
  | 'WP_INVALID_RESPONSE'
  | 'WP_PERMALINK_MISSING'
  | 'WP_STATUS_MISMATCH'
  | 'WP_IDENTITY_MISMATCH'
  | 'WP_POST_VERIFICATION_FAILED'
  | 'WP_PUBLISH_FAILED';

export interface WordPressClientConfig {
  baseUrl?: string;
  username?: string;
  appPassword?: string;
  defaultStatus?: WordPressPublishStatus;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  nodeEnv?: 'development' | 'production' | 'test';
  allowInsecureLocalHttp?: boolean;
}

export interface WordPressCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WordPressMediaUploadInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  altText?: string;
  title?: string;
}

export interface WordPressMediaItem {
  id: number;
  source_url: string;
  title?: { rendered?: string };
  alt_text?: string;
}

export interface WordPressPostWriteInput {
  title: string;
  content: string;
  excerpt?: string;
  status: WordPressPublishStatus;
  slug: string;
  categories?: number[];
  featuredMediaId?: number;
  externalIdentityKey: string;
  canonicalSourceUrl: string;
  officialNotificationUrl: string;
  sourceId: string;
  recruitmentId: string;
  jobId?: string;
  payloadHash: string;
}

export interface WordPressRawPostResponse {
  id?: unknown;
  status?: unknown;
  link?: unknown;
  slug?: unknown;
  title?: { raw?: string; rendered?: string } | string;
  content?: { raw?: string; rendered?: string } | string;
  excerpt?: { raw?: string; rendered?: string } | string;
  categories?: unknown;
  featured_media?: unknown;
  date_gmt?: unknown;
  modified_gmt?: unknown;
  meta?: Record<string, unknown>;
}

export interface VerifiedWordPressPost {
  postId: number;
  status: WordPressPublishStatus;
  permalink: string;
  slug: string;
  externalIdentityKey: string;
  categories: number[];
  featuredMediaId: number | null;
  modifiedAt: string;
  verifiedViaReadback?: boolean;
  verifiedAt?: string;
}

export interface WordPressIdentityInput {
  sourceId: string;
  recruitmentId: string;
  jobId?: string | null;
  canonicalSourceUrl: string;
  officialNotificationUrl?: string | null;
}

export interface FormattedWordPressJobPost {
  externalIdentityKey: string;
  slug: string;
  title: string;
  excerpt: string;
  htmlContent: string;
  categoryNames: string[];
  canonicalSourceUrl: string;
  officialNotificationUrl: string;
  payloadHash: string;
}

export interface WordPressBuildContentInput {
  sourceId: string;
  recruitmentId: string;
  jobId?: string | null;
  canonicalSourceUrl?: string | null;
  officialNotificationUrl?: string | null;
  fields: StructuredRecruitmentData;
  categoryNames?: string[];
  noticeCategory?: string | null;
}

export interface WordPressReadinessReport {
  status: WordPressReadinessState;
  verificationTier: WordPressVerificationTier;
  configured: boolean;
  endpointUrl: string | null;
  httpsEnforced: boolean;
  defaultPostStatus: WordPressPublishStatus;
  reachable: boolean;
  authenticated: boolean;
  latencyMs: number | null;
  errorCode?: WordPressErrorCode | null;
  errorMessage?: string | null;
  checkedAt: string;
}
