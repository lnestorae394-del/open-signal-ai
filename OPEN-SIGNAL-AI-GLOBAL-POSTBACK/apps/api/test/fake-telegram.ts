/** Test double of the Telegram Bot API: records every call, knows a set of valid tokens. */
export interface TgCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

export function fakeTelegram() {
  const bots = new Map<string, { id: number; username: string }>();
  const calls: TgCall[] = [];
  const failures = new Map<string, string>();
  const webhooks = new Map<string, string>();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return new Response('{}', { status: 404 });
    const [, token, method] = m as unknown as [string, string, string];
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) body[k] = typeof v === 'string' ? v : `<file ${(v as Blob).size}B ${(v as Blob).type}>`;
    } else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ token, method, body });
    const bot = bots.get(token);
    if (!bot) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' });
    const failure = failures.get(method);
    if (failure) return Response.json({ ok: false, error_code: 400, description: failure });
    if (method === 'getMe') return Response.json({ ok: true, result: { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username } });
    if (method === 'setWebhook') webhooks.set(token, String(body['url'] ?? ''));
    if (method === 'deleteWebhook') webhooks.delete(token);
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: webhooks.get(token) ?? '', pending_update_count: 0 } });
    if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: calls.length } });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    addBot(token: string, id: number, username: string) {
      bots.set(token, { id, username });
    },
    /** Makes Telegram answer ok:false for a method (null restores it). */
    fail(method: string, description: string | null) {
      if (description === null) failures.delete(method);
      else failures.set(method, description);
    },
    callsOf(method: string) {
      return calls.filter((c) => c.method === method);
    },
  };
}
