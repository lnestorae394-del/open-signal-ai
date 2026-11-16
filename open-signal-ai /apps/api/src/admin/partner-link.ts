import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { partnerLinkSchema, renderPartnerLink } from '@open-signal/shared';

export interface PartnerLinkCheck {
  /** Format is valid and the link can be saved. */
  valid: boolean;
  https: boolean;
  hasClickId: boolean;
  /** Example of what one user will open (with a sample click_id). */
  sample: string | null;
  /** Result of a real request to the partner site (null = not attempted). */
  reachable: boolean | null;
  httpStatus: number | null;
  redirectTo: string | null;
  problems: string[];
}

const SAMPLE_CLICK = 'TEST_CLICK_ID_0000000000000000';

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/**
 * Checks a partner link from the admin panel: format, https, {click_id}
 * placeholder and — for public hosts only — one real HTTP request (no
 * redirects followed). Internal/private addresses are never requested.
 */
export async function checkPartnerLink(
  template: string,
  v: { botId: string; partnerId: string | null },
  opts: { fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {},
): Promise<PartnerLinkCheck> {
  const problems: string[] = [];
  const parsed = partnerLinkSchema.safeParse(template);
  const out: PartnerLinkCheck = { valid: parsed.success, https: false, hasClickId: template.includes('{click_id}'), sample: null, reachable: null, httpStatus: null, redirectTo: null, problems };
  if (!parsed.success) {
    problems.push('format');
    return out;
  }
  out.https = true;
  if (!out.hasClickId) problems.push('no_click_id');
  if (template.includes('{partner_id}') && !v.partnerId) problems.push('partner_id_empty');
  const sample = renderPartnerLink(parsed.data, { clickId: SAMPLE_CLICK, botId: v.botId, partnerId: v.partnerId });
  out.sample = sample;

  const url = new URL(sample);
  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  let addrs: string[];
  try {
    addrs = isIP(url.hostname) ? [url.hostname] : await resolve(url.hostname);
  } catch {
    problems.push('dns');
    out.reachable = false;
    return out;
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    problems.push('private_host');
    out.reachable = false;
    return out;
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(sample, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      headers: { 'user-agent': 'OpenSignalAI-LinkCheck/1.0' },
    });
    out.httpStatus = res.status;
    out.redirectTo = res.headers.get('location');
    out.reachable = res.status < 400 || res.status === 403 || res.status === 405;
    if (!out.reachable) problems.push('http_error');
    await res.body?.cancel().catch(() => undefined);
  } catch {
    out.reachable = false;
    problems.push('unreachable');
  }
  return out;
}
