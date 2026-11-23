/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type LiveVerificationOutcome = 'PASS' | 'INCONCLUSIVE' | 'FAIL';

export type VerificationExecutionMode = 'LIVE' | 'FIXTURE' | 'CACHE';

export type EndpointClassification =
  | 'ENDPOINT_CORRECT'
  | 'ENDPOINT_STALE_OR_WRONG'
  | 'NETWORK_UNREACHABLE'
  | 'ACCESS_BLOCKED'
  | 'RESPONSE_STRUCTURE_CHANGED'
  | 'PARSER_FAILURE'
  | 'DOCUMENT_FLOW_FAILURE'
  | 'UNKNOWN';

export type VerificationProofStatus =
  | 'LIVE_VERIFIED'
  | 'FIXTURE_VERIFIED'
  | 'CACHED_UNVERIFIED'
  | 'UNVERIFIED'
  | 'FAILED';

export type StrictVerificationFailureReason =
  | 'ENDPOINT_REACH_FAILED'
  | 'LISTING_VALIDATION_FAILED'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'NETWORK_UNAVAILABLE'
  | 'UNKNOWN_NETWORK_ERROR'
  | 'ACCESS_BLOCKED'
  | 'WRONG_CONTENT'
  | 'PARSE_FAILED'
  | 'PARSER_FAILED'
  | 'NO_RELEVANT_NOTICE'
  | 'DETAIL_REQUIRED'
  | 'DETAIL_NOT_RESOLVED'
  | 'DETAIL_RESOLUTION_FAILED'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_DISCOVERY_FAILED'
  | 'DOCUMENT_DOWNLOAD_FAILED'
  | 'INVALID_DOCUMENT'
  | 'INVALID_MIME'
  | 'INVALID_MAGIC_BYTES'
  | 'INVALID_PDF'
  | 'SOURCE_STRUCTURE_CHANGED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CACHED_RESULT';

export type StrictEmptyOrExecutionStatus =
  | 'SUCCESS_WITH_VALID_DOCUMENT'
  | 'SUCCESS_NO_RELEVANT_NOTICES'
  | 'ENDPOINT_WRONG_CONTENT'
  | 'ENDPOINT_PARSE_FAILED'
  | 'DOCUMENT_DISCOVERY_FAILED'
  | 'DOCUMENT_DOWNLOAD_FAILED'
  | 'PDF_VALIDATION_FAILED'
  | 'ADAPTER_STRUCTURE_CHANGED'
  | 'ACCESS_BLOCKED'
  | 'SOURCE_UNAVAILABLE'
  | 'INCONCLUSIVE';

export interface LiveVerificationEvidenceArtifacts {
  endpointUrl?: string;
  listingUrl?: string;
  noticeUrl?: string;
  detailUrl?: string;
  documentUrl?: string;
  documentSha256?: string;
  pdfPageCount?: number;
}

export interface LiveVerificationGateInput {
  endpointReached: boolean;
  endpointValidated?: boolean;
  officialDomainVerified?: boolean;
  listingValidated: boolean;
  relevantNoticeFound: boolean;
  detailRequired?: boolean;
  detailResolved?: boolean | null;
  detailPagesFetched?: number;
  documentDiscovered: boolean;
  documentDownloaded: boolean;
  pdfValidated: boolean;
  responseSource?: 'LIVE_EXECUTION' | 'CACHED_RESULT' | 'LIVE' | 'CACHE' | 'STALE';
  verificationMode?: VerificationExecutionMode;
  httpStatus?: number | null;
  finalUrl?: string | null;
  emptyPage?: boolean;
  wrongContent?: boolean;
  parseFailed?: boolean;
  structureChanged?: boolean;
  accessBlocked?: boolean;
  timeoutOccurred?: boolean;
  httpError?: boolean;
  networkErrorType?:
    | 'DNS_ERROR'
    | 'TLS_ERROR'
    | 'CONNECTION_RESET'
    | 'CONNECTION_REFUSED'
    | 'NETWORK_UNAVAILABLE'
    | 'UNKNOWN_NETWORK_ERROR'
    | null;
  networkUnreachableInSandbox?: boolean;
  downloadAttempted?: boolean;
  downloadFailed?: boolean;
  invalidDocument?: boolean;
  invalidMime?: boolean;
  invalidMagicBytes?: boolean;
  invalidPdf?: boolean;
  evidence?: LiveVerificationEvidenceArtifacts;
}

export type PreciseVerificationStage =
  | 'NONE'
  | 'ENDPOINT_REQUEST'
  | 'LISTING_FETCH'
  | 'LISTING_PARSE'
  | 'NOTICE_CLASSIFICATION'
  | 'DETAIL_FETCH'
  | 'DETAIL_PARSE'
  | 'DOCUMENT_DISCOVERY'
  | 'DOCUMENT_DOWNLOAD'
  | 'PDF_MAGIC_BYTE_VALIDATION'
  | 'PDF_PARSE'
  | 'PDF_CONTENT_VALIDATION'
  | 'STRICT_PASS_GATE';

export interface LiveVerificationGateDecision {
  endpointReached: boolean;
  endpointValidated: boolean;
  endpointClassification: EndpointClassification;
  listingValidated: boolean;
  relevantNoticeFound: boolean;
  detailRequired: boolean;
  detailResolved: boolean | null;
  documentDiscovered: boolean;
  documentDownloaded: boolean;
  pdfValidated: boolean;
  responseSource: 'LIVE_EXECUTION' | 'CACHED_RESULT';
  verificationMode: VerificationExecutionMode;
  verificationStatus: VerificationProofStatus;
  outcome: LiveVerificationOutcome;
  technicalFailure: boolean;
  status: StrictEmptyOrExecutionStatus;
  failedStage: PreciseVerificationStage;
  failureReasons: StrictVerificationFailureReason[];
  evidence: LiveVerificationEvidenceArtifacts;
  diagnostic: string;
}

export interface EndpointConnectivityClassificationInput {
  officialDomainVerified?: boolean;
  endpointReached: boolean;
  httpStatus?: number | null;
  finalUrl?: string | null;
  listingValidated?: boolean;
  relevantNoticeFound?: boolean;
  detailRequired?: boolean;
  detailResolved?: boolean | null;
  documentDiscovered?: boolean;
  documentDownloaded?: boolean;
  pdfValidated?: boolean;
  structureChanged?: boolean;
  wrongContent?: boolean;
  emptyPage?: boolean;
  parseFailed?: boolean;
  accessBlocked?: boolean;
  timeoutOccurred?: boolean;
  errorType?: string | null;
  downloadAttempted?: boolean;
  downloadFailed?: boolean;
  invalidDocument?: boolean;
  invalidMime?: boolean;
  invalidMagicBytes?: boolean;
  invalidPdf?: boolean;
}

/**
 * Separates endpoint correctness from network availability, access blocking,
 * response structure drift, parser errors, and downstream document flow issues.
 */
export function classifyEndpointConnectivity(
  input: EndpointConnectivityClassificationInput
): EndpointClassification {
  if (input.officialDomainVerified === false) {
    return 'ACCESS_BLOCKED';
  }

  const errType = input.errorType || null;
  if (
    input.accessBlocked ||
    input.httpStatus === 401 ||
    input.httpStatus === 403 ||
    input.httpStatus === 429 ||
    errType === 'HTTP_403' ||
    errType === 'HTTP_429' ||
    errType === 'DOMAIN_NOT_ALLOWED' ||
    errType === 'SSRF_BLOCKED' ||
    errType === 'INVALID_URL'
  ) {
    return 'ACCESS_BLOCKED';
  }

  if (
    input.httpStatus === 404 ||
    input.httpStatus === 410 ||
    errType === 'HTTP_404' ||
    (input.finalUrl && /filenotfound|error\.aspx|404\.htm/i.test(input.finalUrl))
  ) {
    return 'ENDPOINT_STALE_OR_WRONG';
  }

  if (!input.endpointReached) {
    if (
      input.timeoutOccurred ||
      errType === 'TIMEOUT' ||
      errType === 'DNS_ERROR' ||
      errType === 'TLS_ERROR' ||
      errType === 'CONNECTION_RESET' ||
      errType === 'CONNECTION_REFUSED' ||
      errType === 'NETWORK_UNAVAILABLE' ||
      errType === 'UNKNOWN_NETWORK_ERROR' ||
      errType === 'HTTP_502' ||
      errType === 'HTTP_503' ||
      errType === 'HTTP_504' ||
      errType === 'HTTP_5XX' ||
      (input.httpStatus !== null && input.httpStatus !== undefined && input.httpStatus >= 500)
    ) {
      return 'NETWORK_UNREACHABLE';
    }
    if (input.httpStatus !== null && input.httpStatus !== undefined && input.httpStatus >= 400) {
      return 'ENDPOINT_STALE_OR_WRONG';
    }
    return 'NETWORK_UNREACHABLE';
  }

  if (input.parseFailed) {
    return 'PARSER_FAILURE';
  }

  if (input.structureChanged) {
    return 'RESPONSE_STRUCTURE_CHANGED';
  }

  if (input.wrongContent || input.emptyPage || !input.listingValidated) {
    return 'ENDPOINT_STALE_OR_WRONG';
  }

  // Listing is validated and structurally intact
  if (!input.relevantNoticeFound) {
    return 'ENDPOINT_CORRECT';
  }

  // Relevant notice was found; check downstream detail & document flow
  const detailRequired = input.detailRequired === true;
  if (detailRequired && input.detailResolved !== true) {
    return 'DOCUMENT_FLOW_FAILURE';
  }

  if (!input.documentDiscovered) {
    return 'DOCUMENT_FLOW_FAILURE';
  }

  if (
    input.downloadFailed ||
    input.invalidDocument ||
    input.invalidMime ||
    input.invalidMagicBytes ||
    input.invalidPdf ||
    (input.downloadAttempted && (!input.documentDownloaded || !input.pdfValidated))
  ) {
    return 'DOCUMENT_FLOW_FAILURE';
  }

  return 'ENDPOINT_CORRECT';
}

/**
 * Centralized, deterministic strict PASS gate for live source and endpoint verification.
 *
 * Guarantees:
 * - HTTP 200 alone NEVER produces PASS
 * - Empty valid listing (0 relevant notices) NEVER produces PASS (returns INCONCLUSIVE)
 * - Notice discovered without downloaded & validated PDF NEVER produces PASS
 * - Document URL discovered without actual download & PDF validation NEVER produces PASS
 * - Cached result NEVER produces live verification PASS
 * - Detail condition:
 *     Either (detailRequired === false && detailResolved === null)
 *     OR     (detailRequired === true  && detailResolved === true)
 * - PASS requires:
 *     endpointValidated === true &&
 *     listingValidated === true &&
 *     relevantNoticeFound === true &&
 *     detailConditionSatisfied === true &&
 *     documentDiscovered === true &&
 *     documentDownloaded === true &&
 *     pdfValidated === true &&
 *     responseSource === 'LIVE_EXECUTION'
 */
export function evaluateLiveVerificationGate(
  input: LiveVerificationGateInput
): LiveVerificationGateDecision {
  const endpointReached = Boolean(input.endpointReached);
  const endpointValidated = Boolean(input.endpointValidated ?? input.endpointReached);
  const listingValidated =
    Boolean(input.listingValidated) &&
    !input.emptyPage &&
    !input.wrongContent &&
    !input.parseFailed &&
    !input.structureChanged;
  const relevantNoticeFound = Boolean(input.relevantNoticeFound);

  const detailRequired = input.detailRequired === true;
  const detailResolved: boolean | null = detailRequired
    ? input.detailResolved === true
    : input.detailResolved === false
    ? false
    : null;

  const detailConditionSatisfied =
    (detailRequired === false && detailResolved === null) ||
    (detailRequired === true && detailResolved === true);

  // Document discovery is accepted only if detail condition is satisfied
  const documentDiscovered = detailConditionSatisfied && Boolean(input.documentDiscovered);
  const documentDownloaded = documentDiscovered && Boolean(input.documentDownloaded);
  const pdfValidated = documentDownloaded && Boolean(input.pdfValidated);

  const endpointClassification = classifyEndpointConnectivity({
    officialDomainVerified: input.officialDomainVerified,
    endpointReached,
    httpStatus: input.httpStatus,
    finalUrl: input.finalUrl,
    listingValidated,
    relevantNoticeFound,
    detailRequired,
    detailResolved,
    documentDiscovered,
    documentDownloaded,
    pdfValidated,
    structureChanged: input.structureChanged,
    wrongContent: input.wrongContent,
    emptyPage: input.emptyPage,
    parseFailed: input.parseFailed,
    accessBlocked: input.accessBlocked,
    timeoutOccurred: input.timeoutOccurred,
    errorType: input.networkErrorType ?? (input.timeoutOccurred ? 'TIMEOUT' : null),
    downloadAttempted: input.downloadAttempted,
    downloadFailed: input.downloadFailed,
    invalidDocument: input.invalidDocument,
    invalidMime: input.invalidMime,
    invalidMagicBytes: input.invalidMagicBytes,
    invalidPdf: input.invalidPdf,
  });

  const isCached =
    input.verificationMode === 'CACHE' ||
    input.responseSource === 'CACHED_RESULT' ||
    input.responseSource === 'CACHE' ||
    input.responseSource === 'STALE';

  const normalizedResponseSource: 'LIVE_EXECUTION' | 'CACHED_RESULT' = isCached
    ? 'CACHED_RESULT'
    : 'LIVE_EXECUTION';

  const verificationMode: VerificationExecutionMode = isCached
    ? 'CACHE'
    : input.verificationMode ?? 'LIVE';

  const evidence: LiveVerificationEvidenceArtifacts = input.evidence ?? {};
  const failureReasons: StrictVerificationFailureReason[] = [];

  // 1. Check cache restriction first
  if (isCached) {
    failureReasons.push('CACHED_RESULT', 'INSUFFICIENT_EVIDENCE');
    return {
      endpointReached,
      endpointValidated,
      endpointClassification,
      listingValidated,
      relevantNoticeFound,
      detailRequired,
      detailResolved,
      documentDiscovered,
      documentDownloaded,
      pdfValidated,
      responseSource: normalizedResponseSource,
      verificationMode: 'CACHE',
      verificationStatus: 'CACHED_UNVERIFIED',
      outcome: 'INCONCLUSIVE',
      technicalFailure: false,
      status: 'INCONCLUSIVE',
      failedStage: 'STRICT_PASS_GATE',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: 'Cached execution result cannot satisfy live verification PASS gate',
    };
  }

  // 2. Endpoint Reachability / Network / HTTP Status Check
  if (!endpointReached || !endpointValidated) {
    failureReasons.push('ENDPOINT_REACH_FAILED');

    if (
      input.accessBlocked ||
      input.httpStatus === 401 ||
      input.httpStatus === 403 ||
      input.httpStatus === 429
    ) {
      failureReasons.push('ACCESS_BLOCKED');
      if (input.httpStatus) failureReasons.push('HTTP_ERROR');
      return {
        endpointReached: false,
        endpointValidated: false,
        endpointClassification: 'ACCESS_BLOCKED',
        listingValidated: false,
        relevantNoticeFound: false,
        detailRequired,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: normalizedResponseSource,
        verificationMode,
        verificationStatus: 'FAILED',
        outcome: 'FAIL',
        technicalFailure: true,
        status: 'ACCESS_BLOCKED',
        failedStage: 'ENDPOINT_REQUEST',
        failureReasons: Array.from(new Set(failureReasons)),
        evidence,
        diagnostic: `Access blocked by official portal (HTTP ${input.httpStatus ?? 'blocked'})`,
      };
    }

    if (input.httpError || (input.httpStatus && input.httpStatus >= 400)) {
      failureReasons.push('HTTP_ERROR');
      return {
        endpointReached: false,
        endpointValidated: false,
        endpointClassification:
          input.httpStatus && input.httpStatus >= 500
            ? 'NETWORK_UNREACHABLE'
            : 'ENDPOINT_STALE_OR_WRONG',
        listingValidated: false,
        relevantNoticeFound: false,
        detailRequired,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: normalizedResponseSource,
        verificationMode,
        verificationStatus: 'FAILED',
        outcome: 'FAIL',
        technicalFailure: true,
        status: 'SOURCE_UNAVAILABLE',
        failedStage: 'ENDPOINT_REQUEST',
        failureReasons: Array.from(new Set(failureReasons)),
        evidence,
        diagnostic: `Official endpoint returned HTTP error ${input.httpStatus ?? 'unknown'}`,
      };
    }

    if (input.timeoutOccurred) {
      failureReasons.push('TIMEOUT');
    } else if (input.networkErrorType) {
      failureReasons.push(input.networkErrorType);
    } else {
      failureReasons.push('HTTP_ERROR');
    }

    if (input.networkUnreachableInSandbox) {
      failureReasons.push('INSUFFICIENT_EVIDENCE');
      return {
        endpointReached: false,
        endpointValidated: false,
        endpointClassification: 'NETWORK_UNREACHABLE',
        listingValidated: false,
        relevantNoticeFound: false,
        detailRequired,
        detailResolved: null,
        documentDiscovered: false,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: normalizedResponseSource,
        verificationMode,
        verificationStatus: 'UNVERIFIED',
        outcome: 'INCONCLUSIVE',
        technicalFailure: false,
        status: 'INCONCLUSIVE',
        failedStage: 'LISTING_FETCH',
        failureReasons: Array.from(new Set(failureReasons)),
        evidence,
        diagnostic: 'Live network access unverified due to connection abort or DNS restriction',
      };
    }

    const specificFailureReason =
      failureReasons.find((r) => r !== 'ENDPOINT_REACH_FAILED') || 'ENDPOINT_REACH_FAILED';

    return {
      endpointReached: false,
      endpointValidated: false,
      endpointClassification: 'NETWORK_UNREACHABLE',
      listingValidated: false,
      relevantNoticeFound: false,
      detailRequired,
      detailResolved: null,
      documentDiscovered: false,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'FAILED',
      outcome: 'FAIL',
      technicalFailure: true,
      status: 'SOURCE_UNAVAILABLE',
      failedStage: 'LISTING_FETCH',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: `Failed to reach official endpoint (${specificFailureReason})`,
    };
  }

  // 3. Listing Validation Check (Empty page, wrong content, parse failure, structure changed)
  if (!listingValidated) {
    failureReasons.push('LISTING_VALIDATION_FAILED');
    let status: StrictEmptyOrExecutionStatus = 'ENDPOINT_WRONG_CONTENT';
    if (input.parseFailed) {
      failureReasons.push('PARSE_FAILED', 'PARSER_FAILED');
      status = 'ENDPOINT_PARSE_FAILED';
    }
    if (input.structureChanged) {
      failureReasons.push('SOURCE_STRUCTURE_CHANGED');
      status = 'ADAPTER_STRUCTURE_CHANGED';
    }
    if (input.emptyPage || input.wrongContent || failureReasons.length === 1) {
      failureReasons.push('WRONG_CONTENT');
      if (!input.parseFailed && !input.structureChanged) {
        status = 'ENDPOINT_WRONG_CONTENT';
      }
    }

    return {
      endpointReached,
      endpointValidated,
      endpointClassification,
      listingValidated: false,
      relevantNoticeFound: false,
      detailRequired,
      detailResolved: null,
      documentDiscovered: false,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'FAILED',
      outcome: 'FAIL',
      technicalFailure: true,
      status,
      failedStage: 'LISTING_PARSE',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: `Official endpoint returned HTTP ${input.httpStatus ?? 200} but listing validation failed (${failureReasons.join(', ')})`,
    };
  }

  // 4. Relevant Notice Check (Empty valid listing -> INCONCLUSIVE, NEVER PASS)
  if (!relevantNoticeFound) {
    failureReasons.push('NO_RELEVANT_NOTICE', 'INSUFFICIENT_EVIDENCE');
    return {
      endpointReached,
      endpointValidated,
      endpointClassification: 'ENDPOINT_CORRECT',
      listingValidated: true,
      relevantNoticeFound: false,
      detailRequired: false,
      detailResolved: null,
      documentDiscovered: false,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'UNVERIFIED',
      outcome: 'INCONCLUSIVE',
      technicalFailure: false,
      status: 'SUCCESS_NO_RELEVANT_NOTICES',
      failedStage: 'NOTICE_CLASSIFICATION',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: 'Listing structure is valid, but 0 relevant recruitment notices were found (insufficient evidence for E2E PASS)',
    };
  }

  // 5. Detail Page Resolution Check (when detailRequired === true)
  if (!detailConditionSatisfied) {
    failureReasons.push('DETAIL_RESOLUTION_FAILED', 'DETAIL_REQUIRED', 'DETAIL_NOT_RESOLVED');
    if (!input.documentDiscovered) {
      failureReasons.push('DOCUMENT_NOT_FOUND', 'DOCUMENT_DISCOVERY_FAILED');
    }
    const detailStage: PreciseVerificationStage =
      (input.detailPagesFetched ?? 0) > 0 ? 'DETAIL_PARSE' : 'DETAIL_FETCH';
    return {
      endpointReached,
      endpointValidated,
      endpointClassification: 'DOCUMENT_FLOW_FAILURE',
      listingValidated: true,
      relevantNoticeFound: true,
      detailRequired: true,
      detailResolved: false,
      documentDiscovered: false,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'FAILED',
      outcome: 'FAIL',
      technicalFailure: true,
      status: 'DOCUMENT_DISCOVERY_FAILED',
      failedStage: detailStage,
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: 'Relevant notice requires a detail page (detailRequired=true), but detail page could not be resolved',
    };
  }

  // 6. Document Discovery Check
  if (!documentDiscovered) {
    failureReasons.push('DOCUMENT_DISCOVERY_FAILED', 'DOCUMENT_NOT_FOUND', 'INSUFFICIENT_EVIDENCE');
    return {
      endpointReached,
      endpointValidated,
      endpointClassification: 'DOCUMENT_FLOW_FAILURE',
      listingValidated: true,
      relevantNoticeFound: true,
      detailRequired,
      detailResolved,
      documentDiscovered: false,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'UNVERIFIED',
      outcome: 'INCONCLUSIVE',
      technicalFailure: false,
      status: 'DOCUMENT_DISCOVERY_FAILED',
      failedStage: 'DOCUMENT_DISCOVERY',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: 'Relevant recruitment notice found, but no official document URL was discovered',
    };
  }

  // 7. Document Download Check
  if (!documentDownloaded) {
    if (input.invalidMime) {
      failureReasons.push('INVALID_MIME', 'INVALID_DOCUMENT');
    }
    if (input.invalidMagicBytes) {
      failureReasons.push('INVALID_MAGIC_BYTES', 'INVALID_DOCUMENT');
    }
    if (input.invalidDocument) {
      failureReasons.push('INVALID_DOCUMENT');
    }
    if (input.wrongContent) {
      failureReasons.push('WRONG_CONTENT');
    }
    if (input.invalidPdf) {
      failureReasons.push('INVALID_PDF', 'INVALID_DOCUMENT');
    }

    const downloadStage: PreciseVerificationStage =
      input.invalidMime || input.invalidMagicBytes
        ? 'PDF_MAGIC_BYTE_VALIDATION'
        : 'DOCUMENT_DOWNLOAD';

    if (
      input.downloadFailed ||
      input.downloadAttempted ||
      input.invalidDocument ||
      input.invalidMime ||
      input.invalidMagicBytes ||
      input.invalidPdf
    ) {
      failureReasons.push('DOCUMENT_DOWNLOAD_FAILED');
      return {
        endpointReached,
        endpointValidated,
        endpointClassification: 'DOCUMENT_FLOW_FAILURE',
        listingValidated: true,
        relevantNoticeFound: true,
        detailRequired,
        detailResolved,
        documentDiscovered: true,
        documentDownloaded: false,
        pdfValidated: false,
        responseSource: normalizedResponseSource,
        verificationMode,
        verificationStatus: 'FAILED',
        outcome: 'FAIL',
        technicalFailure: true,
        status: 'DOCUMENT_DOWNLOAD_FAILED',
        failedStage: downloadStage,
        failureReasons: Array.from(new Set(failureReasons)),
        evidence,
        diagnostic: `Official document download failed (${failureReasons.join(', ')})`,
      };
    }

    // Document URL was discovered, but download was never attempted/executed
    failureReasons.push('DOCUMENT_DOWNLOAD_FAILED', 'INSUFFICIENT_EVIDENCE');
    return {
      endpointReached,
      endpointValidated,
      endpointClassification: 'ENDPOINT_CORRECT',
      listingValidated: true,
      relevantNoticeFound: true,
      detailRequired,
      detailResolved,
      documentDiscovered: true,
      documentDownloaded: false,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'UNVERIFIED',
      outcome: 'INCONCLUSIVE',
      technicalFailure: false,
      status: 'INCONCLUSIVE',
      failedStage: 'DOCUMENT_DOWNLOAD',
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: 'Document URL discovered but never downloaded or validated',
    };
  }

  // 8. PDF Validation Check (Document was downloaded, but failed PDF validation)
  if (!pdfValidated) {
    if (input.invalidMime) {
      failureReasons.push('INVALID_MIME');
    }
    if (input.invalidMagicBytes) {
      failureReasons.push('INVALID_MAGIC_BYTES');
    }
    failureReasons.push('INVALID_DOCUMENT', 'INVALID_PDF');

    const pdfStage: PreciseVerificationStage =
      input.invalidMime || input.invalidMagicBytes
        ? 'PDF_MAGIC_BYTE_VALIDATION'
        : 'PDF_PARSE';

    return {
      endpointReached,
      endpointValidated,
      endpointClassification: 'DOCUMENT_FLOW_FAILURE',
      listingValidated: true,
      relevantNoticeFound: true,
      detailRequired,
      detailResolved,
      documentDiscovered: true,
      documentDownloaded: true,
      pdfValidated: false,
      responseSource: normalizedResponseSource,
      verificationMode,
      verificationStatus: 'FAILED',
      outcome: 'FAIL',
      technicalFailure: true,
      status: 'PDF_VALIDATION_FAILED',
      failedStage: pdfStage,
      failureReasons: Array.from(new Set(failureReasons)),
      evidence,
      diagnostic: `Downloaded document failed PDF validation (${failureReasons.join(', ')})`,
    };
  }

  // 9. All Strict E2E Criteria Met -> PASS
  // Only actual LIVE execution can claim LIVE_VERIFIED; FIXTURE mode reports FIXTURE_VERIFIED
  const verificationStatus: VerificationProofStatus =
    verificationMode === 'LIVE' ? 'LIVE_VERIFIED' : 'FIXTURE_VERIFIED';

  return {
    endpointReached: true,
    endpointValidated: true,
    endpointClassification: 'ENDPOINT_CORRECT',
    listingValidated: true,
    relevantNoticeFound: true,
    detailRequired,
    detailResolved,
    documentDiscovered: true,
    documentDownloaded: true,
    pdfValidated: true,
    responseSource: 'LIVE_EXECUTION',
    verificationMode,
    verificationStatus,
    outcome: 'PASS',
    technicalFailure: false,
    status: 'SUCCESS_WITH_VALID_DOCUMENT',
    failedStage: 'NONE',
    failureReasons: [],
    evidence,
    diagnostic:
      verificationMode === 'LIVE'
        ? 'End-to-end live verification succeeded: official endpoint, listing, relevant notice, download, and PDF validation verified live'
        : 'End-to-end contract verification succeeded using deterministic fixtures',
  };
}
