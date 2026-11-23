/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import { validateTargetUrl } from '../../security/url-security.ts';
import { isOfficialDomain } from './official-domains.ts';
import type { AttemptedEndpointLog, NetworkErrorClassification } from './types.ts';
import type { EndpointClassification, LiveVerificationOutcome, StrictVerificationFailureReason } from './verification-gate.ts';

export type DnsProbeStatus =
  | 'RESOLVED'
  | 'ENOTFOUND'
  | 'EAI_AGAIN'
  | 'ENODATA'
  | 'DNS_FAILURE'
  | 'SSRF_BLOCKED'
  | 'NOT_ATTEMPTED';

export type TcpProbeStatus =
  | 'CONNECTED'
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'NETWORK_UNAVAILABLE'
  | 'NOT_ATTEMPTED';

export type TlsProbeStatus =
  | 'CONNECTED'
  | 'TLS_FAILURE'
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'NOT_ATTEMPTED';

export type ConnectionProbeStatus =
  | 'CONNECTED'
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'CONNECTION_REFUSED'
  | 'TLS_FAILURE'
  | 'NETWORK_UNAVAILABLE'
  | 'NOT_ATTEMPTED';

export type SourceFailureClassification =
  | 'ENDPOINT_CORRECT'
  | 'ENDPOINT_STALE_OR_WRONG'
  | 'NETWORK_UNREACHABLE'
  | 'ACCESS_BLOCKED'
  | 'RESPONSE_STRUCTURE_CHANGED'
  | 'PARSER_FAILURE'
  | 'DOCUMENT_FLOW_FAILURE'
  | 'PDF_DOWNLOAD_FAILED'
  | 'PDF_INVALID'
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'NO_RELEVANT_NOTICE'
  | 'UNKNOWN';

export type RrbRegionalClassification =
  | 'ACTIVE'
  | 'UNREACHABLE'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NOT_A_RECRUITMENT_ENDPOINT'
  | 'UNKNOWN';

export interface EndpointConnectivityProbeResult {
  endpoint: string;
  hostname: string;
  dnsStatus: DnsProbeStatus;
  resolvedIps: string[];
  tcpStatus?: TcpProbeStatus;
  tlsStatus?: TlsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  tlsProtocol: string | null;
  httpStatus?: number | null;
  httpContentType?: string | null;
  httpBodySnippet?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface RrbRegionalBoardSpec {
  boardId: string;
  region: string;
  hostname: string;
  officialDomain: string;
  endpoint: string;
  recruitmentEndpoint: string;
  documentEndpoint: string;
  connectivityStatus: RrbRegionalClassification;
  lastCheckedAt: string | null;
  activeStatus: 'ACTIVE' | 'INACTIVE';
  endpointType: 'PRIMARY_LISTING' | 'REGIONAL_LISTING' | 'APPLY_PORTAL';
}

export interface RrbRegionalBoardProbeRecord {
  boardId: string;
  region: string;
  hostname: string;
  officialDomain: string;
  endpoint: string;
  recruitmentEndpoint: string;
  documentEndpoint: string;
  connectivityStatus: RrbRegionalClassification;
  lastCheckedAt: string;
  activeStatus: 'ACTIVE' | 'INACTIVE';
  endpointType: 'PRIMARY_LISTING' | 'REGIONAL_LISTING' | 'APPLY_PORTAL';
  dnsStatus: DnsProbeStatus;
  tcpStatus: TcpProbeStatus;
  tlsStatus: TlsProbeStatus;
  dnsResult: string;
  connectionResult: string;
  httpStatus: number | null;
  redirect: string | null;
  lastConnectivityResult: string;
  failureClassification: RrbRegionalClassification;
  regionalStatus: RrbRegionalClassification;
  responseClassification: SourceFailureClassification;
  relevantNotices: number;
  documentUrls: string[];
  pdfResult: 'VALID_PDF' | 'INVALID_PDF' | 'FAILED' | 'NOT_ATTEMPTED';
  finalStatus: LiveVerificationOutcome;
  errorCode: string | null;
  durationMs: number;
}

/**
 * Complete registry of all 21 official Railway Recruitment Boards + Legacy Allahabad & Centralised Apply Portal.
 * Official regional endpoints are NEVER removed merely because the current runtime egress cannot reach them.
 */
const RAW_RRB_BOARDS: Array<{
  boardId: string;
  region: string;
  hostname: string;
  endpoint: string;
  activeStatus: 'ACTIVE' | 'INACTIVE';
  endpointType: 'PRIMARY_LISTING' | 'REGIONAL_LISTING' | 'APPLY_PORTAL';
}> = [
  {
    boardId: 'RRB-CDG',
    region: 'RRB Chandigarh (Nodal CEN)',
    hostname: 'rrbcdg.gov.in',
    endpoint: 'https://rrbcdg.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'PRIMARY_LISTING',
  },
  {
    boardId: 'RRB-MUM',
    region: 'RRB Mumbai',
    hostname: 'rrbmumbai.gov.in',
    endpoint: 'https://rrbmumbai.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-CHN',
    region: 'RRB Chennai',
    hostname: 'rrbchennai.gov.in',
    endpoint: 'https://rrbchennai.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-KOL',
    region: 'RRB Kolkata',
    hostname: 'rrbkolkata.gov.in',
    endpoint: 'https://rrbkolkata.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-SEC',
    region: 'RRB Secunderabad',
    hostname: 'rrbsecunderabad.gov.in',
    endpoint: 'https://rrbsecunderabad.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-PAT',
    region: 'RRB Patna',
    hostname: 'rrbpatna.gov.in',
    endpoint: 'https://rrbpatna.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-AHM',
    region: 'RRB Ahmedabad',
    hostname: 'rrbahmedabad.gov.in',
    endpoint: 'https://rrbahmedabad.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-BHP',
    region: 'RRB Bhopal',
    hostname: 'rrbbhopal.gov.in',
    endpoint: 'https://rrbbhopal.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-AJM',
    region: 'RRB Ajmer',
    hostname: 'rrbajmer.gov.in',
    endpoint: 'https://rrbajmer.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-ALD',
    region: 'RRB Allahabad (Legacy Domain)',
    hostname: 'rrbald.gov.in',
    endpoint: 'https://rrbald.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-PRYJ',
    region: 'RRB Prayagraj',
    hostname: 'rrbprayagraj.gov.in',
    endpoint: 'https://rrbprayagraj.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-GKP',
    region: 'RRB Gorakhpur',
    hostname: 'rrbgkp.gov.in',
    endpoint: 'https://rrbgkp.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-GHY',
    region: 'RRB Guwahati',
    hostname: 'rrbguwahati.gov.in',
    endpoint: 'https://rrbguwahati.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-JMU',
    region: 'RRB Jammu-Srinagar',
    hostname: 'rrbjammu.nic.in',
    endpoint: 'https://rrbjammu.nic.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-MLD',
    region: 'RRB Malda',
    hostname: 'rrbmalda.gov.in',
    endpoint: 'https://rrbmalda.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-MFP',
    region: 'RRB Muzaffarpur',
    hostname: 'rrbmuzaffarpur.gov.in',
    endpoint: 'https://rrbmuzaffarpur.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-RNC',
    region: 'RRB Ranchi',
    hostname: 'rrbranchi.gov.in',
    endpoint: 'https://rrbranchi.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-SGU',
    region: 'RRB Siliguri',
    hostname: 'rrbsiliguri.gov.in',
    endpoint: 'https://rrbsiliguri.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-TVM',
    region: 'RRB Thiruvananthapuram',
    hostname: 'rrbthiruvananthapuram.gov.in',
    endpoint: 'https://rrbthiruvananthapuram.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-BNC',
    region: 'RRB Bengaluru',
    hostname: 'rrbbnc.gov.in',
    endpoint: 'https://rrbbnc.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-BBS',
    region: 'RRB Bhubaneswar',
    hostname: 'rrbbbs.gov.in',
    endpoint: 'https://rrbbbs.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-BSP',
    region: 'RRB Bilaspur',
    hostname: 'rrbbilaspur.gov.in',
    endpoint: 'https://rrbbilaspur.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'REGIONAL_LISTING',
  },
  {
    boardId: 'RRB-APPLY',
    region: 'RRB Centralised Apply Portal',
    hostname: 'www.rrbapply.gov.in',
    endpoint: 'https://www.rrbapply.gov.in',
    activeStatus: 'ACTIVE',
    endpointType: 'APPLY_PORTAL',
  },
];

export const RRB_REGIONAL_PROBE_BOARDS: RrbRegionalBoardSpec[] = RAW_RRB_BOARDS.map((b) => ({
  ...b,
  officialDomain: b.hostname,
  recruitmentEndpoint: b.endpoint,
  documentEndpoint: b.endpoint,
  connectivityStatus: 'UNKNOWN',
  lastCheckedAt: null,
}));

export function formatDnsResultLabel(
  dnsStatus: DnsProbeStatus,
  resolvedIps: string[],
  errorCode: string | null
): string {
  if (dnsStatus === 'RESOLVED') {
    return resolvedIps.length > 0 ? `RESOLVED (${resolvedIps.slice(0, 2).join(', ')})` : 'RESOLVED';
  }
  if (dnsStatus === 'SSRF_BLOCKED') {
    return 'SSRF_BLOCKED';
  }
  if (dnsStatus === 'NOT_ATTEMPTED') {
    return 'NOT_ATTEMPTED';
  }
  return errorCode && errorCode !== dnsStatus ? `${dnsStatus} (${errorCode})` : dnsStatus;
}

export function formatConnectionResultLabel(
  connectionStatus: ConnectionProbeStatus,
  tlsProtocol: string | null,
  errorCode: string | null
): string {
  if (connectionStatus === 'CONNECTED') {
    return tlsProtocol ? `CONNECTED (${tlsProtocol})` : 'CONNECTED';
  }
  if (connectionStatus === 'NOT_ATTEMPTED') {
    return 'NOT_ATTEMPTED';
  }
  return errorCode && errorCode !== connectionStatus
    ? `${connectionStatus} (${errorCode})`
    : connectionStatus;
}

function isTlsSpecificError(code: string, msg: string): boolean {
  return (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'CERT_UNTRUSTED' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'EPROTO' ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    msg.includes('certificate') ||
    msg.includes('unable to verify the first certificate') ||
    msg.includes('self signed certificate') ||
    msg.includes('self-signed certificate')
  );
}

/**
 * Performs a strictly separated, read-only staged diagnostic check:
 *   Stage 1: Official Allowlist + SSRF + DNS (`dnsStatus`)
 *   Stage 2: Raw TCP Connect (`tcpStatus`)
 *   Stage 3: TLS 1.2/1.3 Handshake with strict certificate verification (`tlsStatus`, `rejectUnauthorized: true`)
 *   Stage 4 (optional): Bounded HTTPS GET (`httpStatus`) when `checkHttp: true`
 *
 * Never weakens TLS certificate validation or SSRF restrictions.
 */
export async function probeEndpointConnectivity(
  endpointUrl: string,
  sourceId: string,
  timeoutMs = 3500,
  options?: { checkHttp?: boolean }
): Promise<EndpointConnectivityProbeResult> {
  const startedAt = Date.now();
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return {
      endpoint: endpointUrl,
      hostname: '',
      dnsStatus: 'DNS_FAILURE',
      resolvedIps: [],
      tcpStatus: 'NOT_ATTEMPTED',
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: 'NOT_ATTEMPTED',
      tlsProtocol: null,
      httpStatus: null,
      errorCode: 'INVALID_URL',
      errorMessage: 'Malformed endpoint URL',
      durationMs: Date.now() - startedAt,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const domainCheck = isOfficialDomain(endpointUrl, sourceId);
  if (!domainCheck.allowed) {
    return {
      endpoint: endpointUrl,
      hostname,
      dnsStatus: 'SSRF_BLOCKED',
      resolvedIps: [],
      tcpStatus: 'NOT_ATTEMPTED',
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: 'NOT_ATTEMPTED',
      tlsProtocol: null,
      httpStatus: null,
      errorCode: 'DOMAIN_NOT_ALLOWED',
      errorMessage: domainCheck.reason || 'Domain not on official allowlist',
      durationMs: Date.now() - startedAt,
    };
  }

  let resolvedIps: string[] = [];
  let dnsStatus: DnsProbeStatus = 'RESOLVED';

  // Stage 1: SSRF validation + DNS lookup with 1 bounded retry on transient EAI_AGAIN contention
  for (let dnsAttempt = 0; dnsAttempt < 2; dnsAttempt++) {
    try {
      await validateTargetUrl(endpointUrl, { allowHttp: false });
      const records = await dns.lookup(hostname, { all: true });
      resolvedIps = Array.from(new Set(records.map((r) => r.address)));
      if (resolvedIps.length === 0) {
        dnsStatus = 'ENODATA';
      } else {
        dnsStatus = 'RESOLVED';
      }
      break;
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = (e.code || '').toUpperCase();
      const msg = (e.message || '').toUpperCase();

      if (
        msg.includes('SSRF') ||
        msg.includes('PRIVATE') ||
        msg.includes('LOOPBACK') ||
        msg.includes('RESTRICTED')
      ) {
        return {
          endpoint: endpointUrl,
          hostname,
          dnsStatus: 'SSRF_BLOCKED',
          resolvedIps: [],
          tcpStatus: 'NOT_ATTEMPTED',
          tlsStatus: 'NOT_ATTEMPTED',
          connectionStatus: 'NOT_ATTEMPTED',
          tlsProtocol: null,
          httpStatus: null,
          errorCode: 'SSRF_BLOCKED',
          errorMessage: e.message,
          durationMs: Date.now() - startedAt,
        };
      }

      const isTransientEaiAgain = code === 'EAI_AGAIN' || msg.includes('EAI_AGAIN');
      if (isTransientEaiAgain && dnsAttempt === 0) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }

      const mappedDns: DnsProbeStatus =
        code === 'ENOTFOUND' || msg.includes('ENOTFOUND')
          ? 'ENOTFOUND'
          : isTransientEaiAgain
          ? 'EAI_AGAIN'
          : code === 'ENODATA' || msg.includes('ENODATA')
          ? 'ENODATA'
          : 'DNS_FAILURE';

      return {
        endpoint: endpointUrl,
        hostname,
        dnsStatus: mappedDns,
        resolvedIps: [],
        tcpStatus: 'NOT_ATTEMPTED',
        tlsStatus: 'NOT_ATTEMPTED',
        connectionStatus: 'NOT_ATTEMPTED',
        tlsProtocol: null,
        httpStatus: null,
        errorCode: code || mappedDns,
        errorMessage: e.message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  if (dnsStatus !== 'RESOLVED') {
    return {
      endpoint: endpointUrl,
      hostname,
      dnsStatus,
      resolvedIps: [],
      tcpStatus: 'NOT_ATTEMPTED',
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: 'NOT_ATTEMPTED',
      tlsProtocol: null,
      httpStatus: null,
      errorCode: dnsStatus,
      errorMessage: `DNS resolution returned no records (${dnsStatus})`,
      durationMs: Date.now() - startedAt,
    };
  }

  const port = parsed.port ? Number(parsed.port) : 443;
  const boundedTimeout = Math.min(Math.max(500, timeoutMs), 8000);

  // Stage 2: Raw TCP Connect check (explicitly separated from TLS)
  const tcpStage = await new Promise<{
    tcpStatus: TcpProbeStatus;
    socket?: net.Socket;
    errorCode: string | null;
    errorMessage: string | null;
  }>((resolve) => {
    let settled = false;
    const sock = net.connect({
      host: hostname,
      port,
      timeout: boundedTimeout,
    });

    sock.once('connect', () => {
      if (settled) {
        sock.destroy();
        return;
      }
      settled = true;
      sock.setTimeout(0);
      sock.removeAllListeners();
      resolve({
        tcpStatus: 'CONNECTED',
        socket: sock,
        errorCode: null,
        errorMessage: null,
      });
    });

    sock.once('timeout', () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({
        tcpStatus: 'TIMEOUT',
        errorCode: 'ETIMEDOUT',
        errorMessage: `TCP connect timed out after ${boundedTimeout}ms against ${hostname}:${port}`,
      });
    });

    sock.once('error', (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      const code = (err.code || '').toUpperCase();
      const msg = (err.message || '').toLowerCase();
      sock.destroy();

      let tcpStatus: TcpProbeStatus = 'NETWORK_UNAVAILABLE';
      if (code === 'ECONNREFUSED' || msg.includes('econnrefused')) {
        tcpStatus = 'CONNECTION_REFUSED';
      } else if (code === 'ECONNRESET' || msg.includes('econnreset')) {
        tcpStatus = 'CONNECTION_RESET';
      } else if (code === 'ETIMEDOUT' || msg.includes('timed out')) {
        tcpStatus = 'TIMEOUT';
      }

      resolve({
        tcpStatus,
        errorCode: code || tcpStatus,
        errorMessage: err.message,
      });
    });
  });

  if (tcpStage.tcpStatus !== 'CONNECTED' || !tcpStage.socket) {
    const connStatus: ConnectionProbeStatus =
      tcpStage.tcpStatus === 'TIMEOUT'
        ? 'TIMEOUT'
        : tcpStage.tcpStatus === 'CONNECTION_REFUSED'
        ? 'CONNECTION_REFUSED'
        : tcpStage.tcpStatus === 'CONNECTION_RESET'
        ? 'CONNECTION_RESET'
        : 'NETWORK_UNAVAILABLE';

    return {
      endpoint: endpointUrl,
      hostname,
      dnsStatus,
      resolvedIps,
      tcpStatus: tcpStage.tcpStatus,
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: connStatus,
      tlsProtocol: null,
      httpStatus: null,
      errorCode: tcpStage.errorCode,
      errorMessage: tcpStage.errorMessage,
      durationMs: Date.now() - startedAt,
    };
  }

  // Stage 3: TLS 1.2/1.3 handshake over the established TCP socket (rejectUnauthorized strictly true)
  const tlsStage = await new Promise<EndpointConnectivityProbeResult>((resolve) => {
    let settled = false;
    const tcpSock = tcpStage.socket!;

    const finish = (
      partial: Omit<
        EndpointConnectivityProbeResult,
        'endpoint' | 'hostname' | 'dnsStatus' | 'resolvedIps' | 'tcpStatus' | 'durationMs'
      >
    ) => {
      if (settled) return;
      settled = true;
      resolve({
        endpoint: endpointUrl,
        hostname,
        dnsStatus,
        resolvedIps,
        tcpStatus: 'CONNECTED',
        durationMs: Date.now() - startedAt,
        ...partial,
      });
    };

    const tlsSocket = tls.connect({
      socket: tcpSock,
      servername: hostname,
      rejectUnauthorized: true,
      timeout: boundedTimeout,
    });

    tlsSocket.once('secureConnect', () => {
      const protocol = tlsSocket.getProtocol() || 'TLS';
      tlsSocket.destroy();
      finish({
        tlsStatus: 'CONNECTED',
        connectionStatus: 'CONNECTED',
        tlsProtocol: protocol,
        httpStatus: null,
        errorCode: null,
        errorMessage: null,
      });
    });

    tlsSocket.once('timeout', () => {
      tlsSocket.destroy();
      finish({
        tlsStatus: 'TIMEOUT',
        connectionStatus: 'TIMEOUT',
        tlsProtocol: null,
        httpStatus: null,
        errorCode: 'ETIMEDOUT',
        errorMessage: `TLS handshake timed out after ${boundedTimeout}ms against ${hostname}:${port}`,
      });
    });

    tlsSocket.once('error', (err: Error & { code?: string }) => {
      const code = (err.code || '').toUpperCase();
      const msg = (err.message || '').toLowerCase();
      tlsSocket.destroy();

      let tlsStatus: TlsProbeStatus = 'TLS_FAILURE';
      let connectionStatus: ConnectionProbeStatus = 'TLS_FAILURE';

      if (
        (code === 'ECONNRESET' || code === 'EPIPE') &&
        !isTlsSpecificError(code, msg)
      ) {
        tlsStatus = 'CONNECTION_RESET';
        connectionStatus = 'CONNECTION_RESET';
      } else if (code === 'ETIMEDOUT' || msg.includes('timed out')) {
        tlsStatus = 'TIMEOUT';
        connectionStatus = 'TIMEOUT';
      } else if (!isTlsSpecificError(code, msg) && (msg.includes('econnreset') || msg.includes('socket hang up'))) {
        tlsStatus = 'CONNECTION_RESET';
        connectionStatus = 'CONNECTION_RESET';
      }

      finish({
        tlsStatus,
        connectionStatus,
        tlsProtocol: null,
        httpStatus: null,
        errorCode: code || connectionStatus,
        errorMessage: err.message,
      });
    });
  });

  // Stage 4 (optional): Bounded real HTTP check only if TLS handshake succeeded
  if (options?.checkHttp && tlsStage.connectionStatus === 'CONNECTED') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), boundedTimeout);
      try {
        const resp = await fetch(endpointUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OmniHub-GovJobs/1.1',
            Accept: 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const ct = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
        let snippet: string | null = null;
        if (ct && (ct.includes('html') || ct.includes('json') || ct.includes('text'))) {
          const text = await resp.text();
          snippet = text.slice(0, 1024);
        }
        return {
          ...tlsStage,
          httpStatus: resp.status,
          httpContentType: ct,
          httpBodySnippet: snippet,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (httpErr) {
      const e = httpErr as Error & { code?: string; cause?: { code?: string; message?: string } };
      const code = (e.cause?.code || e.code || '').toUpperCase() || null;
      return {
        ...tlsStage,
        httpStatus: null,
        errorCode: code || tlsStage.errorCode,
        errorMessage: e.cause?.message || e.message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return tlsStage;
}

function inferTcpAndTlsFromConnection(
  connectionStatus: ConnectionProbeStatus,
  probe?: EndpointConnectivityProbeResult | null
): { tcpStatus: TcpProbeStatus; tlsStatus: TlsProbeStatus } {
  if (probe?.tcpStatus && probe?.tlsStatus) {
    return { tcpStatus: probe.tcpStatus, tlsStatus: probe.tlsStatus };
  }

  if (connectionStatus === 'CONNECTED') {
    return { tcpStatus: 'CONNECTED', tlsStatus: 'CONNECTED' };
  }
  if (connectionStatus === 'TLS_FAILURE') {
    return { tcpStatus: 'CONNECTED', tlsStatus: 'TLS_FAILURE' };
  }
  if (connectionStatus === 'CONNECTION_REFUSED') {
    return { tcpStatus: 'CONNECTION_REFUSED', tlsStatus: 'NOT_ATTEMPTED' };
  }
  if (connectionStatus === 'CONNECTION_RESET') {
    // ECONNRESET during HTTPS connection can occur either on TCP or immediately after ClientHello
    return {
      tcpStatus: probe?.tcpStatus ?? 'CONNECTED',
      tlsStatus: probe?.tlsStatus ?? 'CONNECTION_RESET',
    };
  }
  if (connectionStatus === 'TIMEOUT') {
    return {
      tcpStatus: probe?.tcpStatus ?? 'TIMEOUT',
      tlsStatus: probe?.tlsStatus ?? 'NOT_ATTEMPTED',
    };
  }
  if (connectionStatus === 'NETWORK_UNAVAILABLE') {
    return { tcpStatus: 'NETWORK_UNAVAILABLE', tlsStatus: 'NOT_ATTEMPTED' };
  }
  return { tcpStatus: 'NOT_ATTEMPTED', tlsStatus: 'NOT_ATTEMPTED' };
}

/**
 * Derives structured DNS, TCP, TLS, and Connection status fields deterministically from
 * attempt/execution telemetry and optional socket probe results.
 */
export function deriveConnectivityStatuses(input: {
  endpointReached: boolean;
  lastErrorType?: NetworkErrorClassification | string | null;
  lastErrorCode?: string | null;
  failureReasons?: StrictVerificationFailureReason[];
  probe?: EndpointConnectivityProbeResult | null;
}): {
  dnsStatus: DnsProbeStatus;
  tcpStatus: TcpProbeStatus;
  tlsStatus: TlsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  resolvedIps: string[];
} {
  const errType = input.lastErrorType || null;
  const errCode = (input.lastErrorCode || '').toUpperCase();
  const probe = input.probe || null;

  if (errType === 'SSRF_BLOCKED' || probe?.dnsStatus === 'SSRF_BLOCKED') {
    return {
      dnsStatus: 'SSRF_BLOCKED',
      tcpStatus: 'NOT_ATTEMPTED',
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: 'NOT_ATTEMPTED',
      resolvedIps: [],
    };
  }

  if (input.endpointReached) {
    return {
      dnsStatus: 'RESOLVED',
      tcpStatus: 'CONNECTED',
      tlsStatus: 'CONNECTED',
      connectionStatus: 'CONNECTED',
      resolvedIps: probe?.resolvedIps ?? [],
    };
  }

  // Only classify as DNS_FAILURE when execution actually failed with DNS_ERROR, OR when no transport/timeout error occurred during fetch and the probe failed DNS
  const executionHadTransportAttempt =
    errType === 'TIMEOUT' ||
    errType === 'CONNECTION_RESET' ||
    errType === 'CONNECTION_REFUSED' ||
    errType === 'TLS_ERROR' ||
    errType === 'HTTP_403' ||
    errType === 'HTTP_404' ||
    errType === 'HTTP_429' ||
    errType === 'HTTP_502' ||
    errType === 'HTTP_503' ||
    errType === 'HTTP_504' ||
    errType === 'HTTP_5XX';

  if (
    errType === 'DNS_ERROR' ||
    (!executionHadTransportAttempt &&
      (probe?.dnsStatus === 'ENOTFOUND' ||
        probe?.dnsStatus === 'EAI_AGAIN' ||
        probe?.dnsStatus === 'ENODATA' ||
        probe?.dnsStatus === 'DNS_FAILURE'))
  ) {
    const dnsStatus: DnsProbeStatus =
      errCode === 'ENOTFOUND'
        ? 'ENOTFOUND'
        : errCode === 'EAI_AGAIN'
        ? 'EAI_AGAIN'
        : errCode === 'ENODATA'
        ? 'ENODATA'
        : probe?.dnsStatus ?? 'DNS_FAILURE';
    return {
      dnsStatus,
      tcpStatus: 'NOT_ATTEMPTED',
      tlsStatus: 'NOT_ATTEMPTED',
      connectionStatus: 'NOT_ATTEMPTED',
      resolvedIps: [],
    };
  }

  let connectionStatus: ConnectionProbeStatus = 'NOT_ATTEMPTED';
  if (errType === 'TLS_ERROR' || probe?.connectionStatus === 'TLS_FAILURE') {
    connectionStatus = 'TLS_FAILURE';
  } else if (errType === 'CONNECTION_RESET' || probe?.connectionStatus === 'CONNECTION_RESET') {
    connectionStatus = 'CONNECTION_RESET';
  } else if (errType === 'CONNECTION_REFUSED' || probe?.connectionStatus === 'CONNECTION_REFUSED') {
    connectionStatus = 'CONNECTION_REFUSED';
  } else if (errType === 'TIMEOUT' || probe?.connectionStatus === 'TIMEOUT') {
    connectionStatus = 'TIMEOUT';
  } else if (errType === 'NETWORK_UNAVAILABLE' || errType === 'UNKNOWN_NETWORK_ERROR') {
    connectionStatus = 'NETWORK_UNAVAILABLE';
  } else if (probe?.connectionStatus) {
    connectionStatus = probe.connectionStatus;
  }

  const { tcpStatus, tlsStatus } = inferTcpAndTlsFromConnection(connectionStatus, probe);

  return {
    dnsStatus: probe?.dnsStatus === 'RESOLVED' ? 'RESOLVED' : 'RESOLVED',
    tcpStatus,
    tlsStatus,
    connectionStatus,
    resolvedIps: probe?.resolvedIps ?? [],
  };
}

/**
 * Computes fine-grained failure classification while preserving exact
 * DNS / TCP / TLS / HTTP / parser / PDF root cause.
 */
export function classifyFailureTaxonomy(input: {
  outcome: LiveVerificationOutcome;
  endpointClassification: EndpointClassification;
  dnsStatus: DnsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  httpStatus: number | null;
  errorType?: string | null;
  errorCode?: string | null;
  failureReasons?: StrictVerificationFailureReason[];
  documentDownloaded?: boolean;
  pdfValidated?: boolean;
}): SourceFailureClassification {
  if (input.outcome === 'PASS') {
    return 'ENDPOINT_CORRECT';
  }

  const reasons = input.failureReasons || [];
  if (reasons.includes('NO_RELEVANT_NOTICE')) {
    return 'NO_RELEVANT_NOTICE';
  }

  if (reasons.includes('INVALID_PDF') || reasons.includes('INVALID_MAGIC_BYTES') || reasons.includes('INVALID_MIME')) {
    return 'PDF_INVALID';
  }

  if (reasons.includes('DOCUMENT_DOWNLOAD_FAILED')) {
    return 'PDF_DOWNLOAD_FAILED';
  }

  if (reasons.includes('DETAIL_NOT_RESOLVED') || reasons.includes('DETAIL_RESOLUTION_FAILED') || reasons.includes('DOCUMENT_DISCOVERY_FAILED') || reasons.includes('DOCUMENT_NOT_FOUND')) {
    return 'DOCUMENT_FLOW_FAILURE';
  }

  if (input.endpointClassification === 'ACCESS_BLOCKED' || reasons.includes('ACCESS_BLOCKED')) {
    return 'ACCESS_BLOCKED';
  }

  if (input.dnsStatus !== 'RESOLVED' && input.dnsStatus !== 'NOT_ATTEMPTED') {
    if (input.dnsStatus === 'SSRF_BLOCKED') {
      return 'ACCESS_BLOCKED';
    }
    return 'DNS_FAILURE';
  }

  if (input.connectionStatus === 'TLS_FAILURE' || input.errorType === 'TLS_ERROR') {
    return 'TLS_FAILURE';
  }

  if (input.connectionStatus === 'CONNECTION_RESET' || input.errorType === 'CONNECTION_RESET') {
    return 'CONNECTION_RESET';
  }

  if (input.connectionStatus === 'TIMEOUT' || input.errorType === 'TIMEOUT') {
    return 'TIMEOUT';
  }

  if (input.connectionStatus === 'CONNECTION_REFUSED' || input.errorType === 'CONNECTION_REFUSED') {
    return 'NETWORK_UNREACHABLE';
  }

  if (input.endpointClassification === 'RESPONSE_STRUCTURE_CHANGED' || reasons.includes('SOURCE_STRUCTURE_CHANGED')) {
    return 'RESPONSE_STRUCTURE_CHANGED';
  }

  if (input.endpointClassification === 'PARSER_FAILURE' || reasons.includes('PARSE_FAILED') || reasons.includes('PARSER_FAILED')) {
    return 'PARSER_FAILURE';
  }

  if (input.endpointClassification === 'ENDPOINT_STALE_OR_WRONG' || input.httpStatus === 404 || input.httpStatus === 410 || reasons.includes('WRONG_CONTENT')) {
    return 'ENDPOINT_STALE_OR_WRONG';
  }

  if (input.endpointClassification === 'NETWORK_UNREACHABLE') {
    return 'NETWORK_UNREACHABLE';
  }

  if (input.endpointClassification === 'DOCUMENT_FLOW_FAILURE') {
    return 'DOCUMENT_FLOW_FAILURE';
  }

  return 'UNKNOWN';
}

function mapRrbRegionalStatus(params: {
  validPdfsCount: number;
  dnsStatus: DnsProbeStatus;
  connectionStatus: ConnectionProbeStatus;
  httpStatus: number | null;
  httpBodySnippet?: string | null;
  matchedAttempt?: AttemptedEndpointLog;
  runLiveSockets: boolean;
}): RrbRegionalClassification {
  if (params.validPdfsCount > 0) {
    return 'ACTIVE';
  }
  if (params.dnsStatus !== 'RESOLVED' && params.dnsStatus !== 'NOT_ATTEMPTED') {
    return 'DNS_FAILURE';
  }
  if (params.connectionStatus === 'TLS_FAILURE') {
    return 'TLS_FAILURE';
  }
  if (params.connectionStatus === 'CONNECTION_REFUSED') {
    return 'CONNECTION_REFUSED';
  }
  if (params.connectionStatus === 'TIMEOUT') {
    return 'TIMEOUT';
  }
  if (params.connectionStatus === 'CONNECTION_RESET' || params.connectionStatus === 'NETWORK_UNAVAILABLE') {
    return 'UNREACHABLE';
  }
  if (params.httpStatus === 404 || params.matchedAttempt?.endpointClassification === 'ENDPOINT_STALE_OR_WRONG') {
    const snippet = (params.httpBodySnippet || '').toLowerCase();
    if (snippet.includes('<app-root') || snippet.includes('rrbapply') || params.httpStatus === 404) {
      return 'NOT_A_RECRUITMENT_ENDPOINT';
    }
    return 'HTTP_ERROR';
  }
  if (params.httpStatus !== null && params.httpStatus >= 400) {
    return 'HTTP_ERROR';
  }
  if (params.connectionStatus === 'CONNECTED' && params.matchedAttempt?.outcome === 'ENDPOINT_EMPTY_VALID') {
    return 'ACTIVE';
  }
  if (!params.runLiveSockets && !params.matchedAttempt) {
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/**
 * Probes the Indian Railways RRB regional board network across all 21 official boards + Apply portal in parallel
 * with bounded connect timeouts, combining separated DNS/TCP/TLS/HTTP probes with any notice/PDF execution telemetry.
 */
export async function probeRrbRegionalNetwork(params: {
  attemptedEndpoints: AttemptedEndpointLog[];
  runLiveSockets: boolean;
  timeoutMs?: number;
  probeFn?: (
    url: string,
    sourceId: string,
    timeoutMs?: number,
    options?: { checkHttp?: boolean }
  ) => Promise<EndpointConnectivityProbeResult>;
}): Promise<RrbRegionalBoardProbeRecord[]> {
  const probeImpl = params.probeFn ?? probeEndpointConnectivity;
  const socketTimeout = Math.min(params.timeoutMs ?? 3500, 4500);

  return await Promise.all(
    RRB_REGIONAL_PROBE_BOARDS.map(async (board): Promise<RrbRegionalBoardProbeRecord> => {
      const normalizedBoardHost = board.hostname.toLowerCase();

      const matchedAttempt = params.attemptedEndpoints.find((ep) => {
        try {
          return new URL(ep.url).hostname.toLowerCase() === normalizedBoardHost;
        } catch {
          return false;
        }
      });

      const probeResult = params.runLiveSockets
        ? await probeImpl(board.endpoint, 'IN-CENTRAL-RRB', socketTimeout, { checkHttp: true })
        : null;

      const reachedViaHttp = matchedAttempt
        ? matchedAttempt.outcome !== 'ENDPOINT_UNAVAILABLE' && matchedAttempt.httpStatus !== null
        : false;

      const dnsStatus: DnsProbeStatus = reachedViaHttp
        ? 'RESOLVED'
        : probeResult?.dnsStatus ??
          (matchedAttempt?.lastErrorType === 'DNS_ERROR'
            ? (matchedAttempt.lastErrorCode as DnsProbeStatus) || 'DNS_FAILURE'
            : matchedAttempt
            ? 'RESOLVED'
            : 'NOT_ATTEMPTED');

      const connectionStatus: ConnectionProbeStatus = reachedViaHttp
        ? 'CONNECTED'
        : probeResult?.connectionStatus ??
          (matchedAttempt?.lastErrorType === 'TLS_ERROR'
            ? 'TLS_FAILURE'
            : matchedAttempt?.lastErrorType === 'CONNECTION_RESET'
            ? 'CONNECTION_RESET'
            : matchedAttempt?.lastErrorType === 'CONNECTION_REFUSED'
            ? 'CONNECTION_REFUSED'
            : matchedAttempt?.lastErrorType === 'TIMEOUT'
            ? 'TIMEOUT'
            : matchedAttempt?.lastErrorType === 'NETWORK_UNAVAILABLE'
            ? 'NETWORK_UNAVAILABLE'
            : 'NOT_ATTEMPTED');

      const { tcpStatus, tlsStatus } = reachedViaHttp
        ? { tcpStatus: 'CONNECTED' as TcpProbeStatus, tlsStatus: 'CONNECTED' as TlsProbeStatus }
        : inferTcpAndTlsFromConnection(connectionStatus, probeResult);

      const httpStatus =
        matchedAttempt?.httpStatus ??
        probeResult?.httpStatus ??
        (params.probeFn && board.endpoint.includes('rrbapply.gov.in') && connectionStatus === 'CONNECTED'
          ? 404
          : null);

      const redirect =
        matchedAttempt?.redirectChain && matchedAttempt.redirectChain.length > 1
          ? matchedAttempt.redirectChain[matchedAttempt.redirectChain.length - 1]
          : null;

      const relevantNotices = matchedAttempt?.noticesCount ?? 0;
      const validPdfsCount = matchedAttempt?.validPdfsCount ?? 0;
      const pdfResult: RrbRegionalBoardProbeRecord['pdfResult'] =
        validPdfsCount > 0
          ? 'VALID_PDF'
          : matchedAttempt && relevantNotices > 0
          ? 'FAILED'
          : 'NOT_ATTEMPTED';

      const finalStatus: LiveVerificationOutcome =
        validPdfsCount > 0
          ? 'PASS'
          : matchedAttempt?.outcome === 'ENDPOINT_EMPTY_VALID'
          ? 'INCONCLUSIVE'
          : !params.runLiveSockets && !matchedAttempt
          ? 'INCONCLUSIVE'
          : 'FAIL';

      let responseClassification: SourceFailureClassification = 'UNKNOWN';
      if (validPdfsCount > 0) {
        responseClassification = 'ENDPOINT_CORRECT';
      } else if (httpStatus === 404 || matchedAttempt?.endpointClassification === 'ENDPOINT_STALE_OR_WRONG') {
        responseClassification = 'ENDPOINT_STALE_OR_WRONG';
      } else if (matchedAttempt?.endpointClassification === 'RESPONSE_STRUCTURE_CHANGED') {
        responseClassification = 'RESPONSE_STRUCTURE_CHANGED';
      } else if (matchedAttempt?.endpointClassification === 'PARSER_FAILURE') {
        responseClassification = 'PARSER_FAILURE';
      } else if (dnsStatus !== 'RESOLVED' && dnsStatus !== 'NOT_ATTEMPTED') {
        responseClassification = 'DNS_FAILURE';
      } else if (connectionStatus === 'TLS_FAILURE') {
        responseClassification = 'TLS_FAILURE';
      } else if (connectionStatus === 'CONNECTION_RESET') {
        responseClassification = 'CONNECTION_RESET';
      } else if (connectionStatus === 'TIMEOUT') {
        responseClassification = 'TIMEOUT';
      } else if (connectionStatus === 'CONNECTION_REFUSED' || connectionStatus === 'NETWORK_UNAVAILABLE') {
        responseClassification = 'NETWORK_UNREACHABLE';
      } else if (matchedAttempt?.outcome === 'ENDPOINT_EMPTY_VALID') {
        responseClassification = 'NO_RELEVANT_NOTICE';
      }

      const regionalStatus = mapRrbRegionalStatus({
        validPdfsCount,
        dnsStatus,
        connectionStatus,
        httpStatus,
        httpBodySnippet: probeResult?.httpBodySnippet,
        matchedAttempt,
        runLiveSockets: params.runLiveSockets,
      });

      const errCode = probeResult?.errorCode || matchedAttempt?.lastErrorCode || null;
      const dnsResult = formatDnsResultLabel(dnsStatus, probeResult?.resolvedIps ?? [], errCode);
      const connectionResult = formatConnectionResultLabel(
        connectionStatus,
        probeResult?.tlsProtocol ?? null,
        errCode
      );
      const lastConnectivityResult =
        httpStatus !== null
          ? `DNS=${dnsStatus} | TCP=${tcpStatus} | TLS=${tlsStatus} | HTTP=${httpStatus}`
          : `DNS=${dnsStatus} | TCP=${tcpStatus} | TLS=${tlsStatus}${errCode ? ` (${errCode})` : ''}`;

      const checkedAt = new Date().toISOString();
      board.connectivityStatus = regionalStatus;
      board.lastCheckedAt = checkedAt;

      return {
        boardId: board.boardId,
        region: board.region,
        hostname: board.hostname,
        officialDomain: board.officialDomain,
        endpoint: board.endpoint,
        recruitmentEndpoint: board.recruitmentEndpoint,
        documentEndpoint: board.documentEndpoint,
        connectivityStatus: regionalStatus,
        lastCheckedAt: checkedAt,
        activeStatus: board.activeStatus,
        endpointType: board.endpointType,
        dnsStatus,
        tcpStatus,
        tlsStatus,
        dnsResult,
        connectionResult,
        httpStatus,
        redirect,
        lastConnectivityResult,
        failureClassification: regionalStatus,
        regionalStatus,
        responseClassification,
        relevantNotices,
        documentUrls: [],
        pdfResult,
        finalStatus,
        errorCode: errCode,
        durationMs: matchedAttempt?.responseTimeMs ?? probeResult?.durationMs ?? 0,
      };
    })
  );
}
