import { config } from '../config'

/**
 * A small client for the Telegram Bot API: sending messages and registering the webhook.
 * Docs: https://core.telegram.org/bots/api
 */

export function isTelegramConfigured(): boolean {
  return Boolean(config.telegram.botToken && config.telegram.botUsername)
}

export interface InlineButton {
  text: string
  url: string
}

/** The chat blocked the bot or no longer exists: stop sending to it. */
export class TelegramChatGoneError extends Error {}

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    result?: T
    description?: string
    error_code?: number
    parameters?: { retry_after?: number }
  }
  if (json.ok) return json.result as T
  // 403: blocked by the user; 400 "chat not found": the chat is gone.
  if (json.error_code === 403 || /chat not found|user is deactivated/i.test(json.description ?? '')) {
    throw new TelegramChatGoneError(json.description ?? 'Chat unavailable')
  }
  const error = new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ''}`) as Error & {
    retryAfter?: number
  }
  error.retryAfter = json.parameters?.retry_after
  throw error
}

/**
 * Sends an HTML message, with optional link buttons underneath. Waits and retries once when
 * Telegram asks to slow down (it allows about one message a second per chat).
 */
export async function sendMessage(chatId: number | string, html: string, buttons: InlineButton[][] = []): Promise<void> {
  const body = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }
  try {
    await call('sendMessage', body)
  } catch (error) {
    const wait = (error as { retryAfter?: number }).retryAfter
    if (!wait || wait > 60) throw error
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000))
    await call('sendMessage', body)
  }
}

/** Points Telegram at the API's webhook. Safe to repeat; Telegram keeps the latest. */
export async function registerWebhook(): Promise<void> {
  const { apiPublicUrl, webhookSecret } = config.telegram
  if (!isTelegramConfigured() || !apiPublicUrl || !webhookSecret) return
  await call('setWebhook', {
    url: `${apiPublicUrl}/api/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  })
  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Link this chat to your WhaleMo account' },
      { command: 'stop', description: 'Stop alerts and unlink this chat' },
      { command: 'status', description: 'Show whether this chat is linked' },
    ],
  })
}
