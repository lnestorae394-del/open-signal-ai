import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { partnerLinkSchema, renderPartnerLink } from '@open-signal/shared';

export interface RedirectHop {
  /** Address of this step, with query values other than the test click_id hidden. */
  url: string;
  status: number | null;
  /** The test click_id value is present in this address. */
  clickIdInUrl: boolean;
}

export interface PartnerLinkCheck {
  /** Format is valid and the link can be saved. */
  valid: boolean;
  https: boolean;
  hasClickId: boolean;
  /** Example of what one user will open (with a sample click_id). */
  sample: string | null;
  /** Result of real requests to the partner site (null = not attempted). */
  reachable: boolean | null;
  httpStatus: number | null;
  /** First redirect target (kept for older admin builds). */
  redirectTo: string | null;
  /** Every step of the redirect chain, starting with the link itself. */
  chain: RedirectHop[];
  /**
   * Is the test click_id still visible in the address of the last step?
   * null = not checked. false does NOT prove it is lost: a tracker may keep it on its
   * own server and drop it from the address. Only a test registration proves it.
   */
  clickIdInFinalUrl: boolean | null;
  problems: string[];
}

export const SAMPLE_CLICK = 'TEST_CLICK_ID_0000000000000000';
const MAX_HOPS = 8;

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/** Hides every query value except the test click_id (partner tokens are not shown in the admin). */
function sanitize(u: URL): string {
  const copy = new URL(u.toString());
  for (const k of [...copy.searchParams.keys()]) {
    const vals = copy.searchParams.getAll(k);
    copy.searchParams.delete(k);
    for (const v of vals) copy.searchParams.append(k, v.includes(SAMPLE_CLICK) ? v : '…');
  }
  copy.hash = '';
  return copy.toString().replaceAll('%E2%80%A6', '…');
}

const hasClick = (u: URL) => decodeURIComponent(u.toString()).includes(SAMPLE_CLICK);

/**
 * Checks a partner link from the admin panel: format, https, {click_id}
 * placeholder and — for public hosts only — real requests along the redirect
 * chain (up to 8 steps, every step re-checked against private addresses).
 */
export async function checkPartnerLink(
  template: string,
  v: { botId: string; partnerId: string | null },
  opts: { fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {},
): Promise<PartnerLinkCheck> {
  const problems: string[] = [];
  const parsed = partnerLinkSchema.safeParse(template);
  const out: PartnerLinkCheck = {
    valid: parsed.success, https: false, hasClickId: template.includes('{click_id}'), sample: null,
    reachable: null, httpStatus: null, redirectTo: null, chain: [], clickIdInFinalUrl: null, problems,
  };
  if (!parsed.success) {
    problems.push('format');
    return out;
  }
  out.https = true;
  if (!out.hasClickId) problems.push('no_click_id');
  if (template.includes('{partner_id}') && !v.partnerId) problems.push('partner_id_empty');
  const sample = renderPartnerLink(parsed.data, { clickId: SAMPLE_CLICK, botId: v.botId, partnerId: v.partnerId });
  out.sample = sample;

  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  const doFetch = opts.fetchImpl ?? fetch;
  let url = new URL(sample);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push('bad_redirect');
      break;
    }
    let addrs: string[];
    try {
      addrs = isIP(url.hostname) ? [url.hostname] : await resolve(url.hostname);
    } catch {
      problems.push('dns');
      out.reachable = false;
      break;
    }
    if (!addrs.length || addrs.some(isPrivateAddress)) {
      problems.push('private_host');
      out.reachable = false;
      break;
    }
    const step: RedirectHop = { url: sanitize(url), status: null, clickIdInUrl: hasClick(url) };
    out.chain.push(step);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
        headers: { 'user-agent': 'OpenSignalAI-LinkCheck/1.0' },
      });
    } catch {
      out.reachable = false;
      problems.push('unreachable');
      break;
    }
    step.status = res.status;
    await res.body?.cancel().catch(() => undefined);
    if (hop === 0) out.httpStatus = res.status;
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (hop === 0) out.redirectTo = location;
    if (!location) {
      out.reachable = res.status < 400 || res.status === 403 || res.status === 405;
      if (!out.reachable) problems.push('http_error');
      break;
    }
    try {
      url = new URL(location, url);
    } catch {
      problems.push('bad_redirect');
      break;
    }
    if (hop === MAX_HOPS - 1) problems.push('too_many_redirects');
  }
  const last = out.chain[out.chain.length - 1];
  if (last && out.hasClickId) {
    out.clickIdInFinalUrl = last.clickIdInUrl;
    if (!last.clickIdInUrl) problems.push('click_id_not_in_final_url');
  }
  return out;
}
