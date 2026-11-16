/**
 * Telegram Bot API client (https://core.telegram.org/bots/api).
 * The token is passed per call and never logged; errors carry Telegram's
 * error_code/description but never the URL (which contains the token).
 */
export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

export class TelegramApiError extends Error {
  readonly errorCode: number;
  readonly method: string;
  constructor(method: string, errorCode: number, description: string) {
    super(`Telegram ${method}: ${errorCode} ${description}`);
    this.name = 'TelegramApiError';
    this.errorCode = errorCode;
    this.method = method;
  }
}

export interface InlineButton {
  text: string;
  web_app?: { url: string };
  url?: string;
}

export class TelegramBotApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl = 'https://api.telegram.org', fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown> | FormData = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/bot${token}/${method}`, {
          method: 'POST',
          ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        throw new TelegramApiError(method, 0, `network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TelegramApiResult<T>;
      if (json.ok) return json.result as T;
      const retryAfter = json.parameters?.retry_after;
      if (json.error_code === 429 && retryAfter !== undefined && retryAfter <= 5 && attempt < 3) {
        await new Promise((r) => setTimeout(r, (retryAfter + 0.2) * 1000));
        continue;
      }
      throw new TelegramApiError(method, json.error_code ?? res.status, json.description ?? 'unknown error');
    }
  }

  getMe(token: string) {
    return this.call<BotInfo>(token, 'getMe');
  }

  setWebhook(token: string, url: string, secretToken: string) {
    return this.call<boolean>(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 40,
    });
  }

  getWebhookInfo(token: string) {
    return this.call<WebhookInfo>(token, 'getWebhookInfo');
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
    return this.call<boolean>(token, 'setMyShortDescription', { short_description: shortDescription, ...(languageCode ? { language_code: languageCode } : {}) });
  }

  setMenuButtonWebApp(token: string, text: string, url: string) {
    return this.call<boolean>(token, 'setChatMenuButton', { menu_button: { type: 'web_app', text, web_app: { url } } });
  }

  /** Restores the default menu button (used when a bot is removed from the platform). */
  resetMenuButton(token: string) {
    return this.call<boolean>(token, 'setChatMenuButton', { menu_button: { type: 'default' } });
  }

  /** Bot API setMyProfilePhoto: static photo must be a JPEG, uploaded as multipart. */
  setMyProfilePhoto(token: string, jpeg: Buffer) {
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
    form.set('avatar', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'avatar.jpg');
    return this.call<boolean>(token, 'setMyProfilePhoto', form);
  }

  sendMessage(token: string, chatId: number, text: string, buttons?: InlineButton[][]) {
    return this.call<unknown>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }
}
