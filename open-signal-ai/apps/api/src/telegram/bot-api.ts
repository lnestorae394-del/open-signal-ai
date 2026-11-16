/**
 * Thin Telegram Bot API client used by Stage 2/3 (bot creation & webhook
 * registration). Written against the official method names; NOT yet exercised
 * against real Telegram in Stage 1 — there are no bots yet.
 *
 * The token is passed per call and never logged.
 */
export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export class TelegramBotApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl = 'https://api.telegram.org', fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as TelegramApiResult<T>;
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ''}`.trim());
    return json.result as T;
  }

  getMe(token: string) {
    return this.call<BotInfo>(token, 'getMe');
  }

  setWebhook(token: string, url: string, secretToken: string) {
    return this.call<boolean>(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  deleteWebhook(token: string) {
    return this.call<boolean>(token, 'deleteWebhook', { drop_pending_updates: false });
  }

  setMyName(token: string, name: string, languageCode?: string) {
    return this.call<boolean>(token, 'setMyName', { name, ...(languageCode ? { language_code: languageCode } : {}) });
  }

  setMyDescription(token: string, description: string, languageCode?: string) {
    return this.call<boolean>(token, 'setMyDescription', { description, ...(languageCode ? { language_code: languageCode } : {}) });
  }

  setMyShortDescription(token: string, shortDescription: string, languageCode?: string) {
    return this.call<boolean>(token, 'setMyShortDescription', {
      short_description: shortDescription,
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  setMenuButtonWebApp(token: string, text: string, url: string) {
    return this.call<boolean>(token, 'setChatMenuButton', { menu_button: { type: 'web_app', text, web_app: { url } } });
  }

  sendMessage(token: string, chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<unknown>(token, 'sendMessage', { chat_id: chatId, text, ...extra });
  }
  // setMyProfilePhoto requires multipart upload — added in Stage 2 with media uploads.
}
