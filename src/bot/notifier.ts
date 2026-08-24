import { Telegraf } from 'telegraf';
import type { Repo } from '../db/repo';
import { createLogger, describeError } from '../logger';

const log = createLogger('bot:notifier');

export interface SendResult {
  ok: boolean;
  /** True when Telegram told us this chat can no longer be reached (blocked / deleted / deactivated). */
  unreachable: boolean;
  error?: string;
}

export interface AdminSendResult extends SendResult {
  /** message_id of the delivered message, used to route admin replies back to a user. */
  messageId?: number;
}

interface TelegramApiError {
  response?: { error_code?: number; description?: string };
  description?: string;
  code?: number;
}

/** Escapes text so it is safe inside `parse_mode: 'HTML'`. */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function truncateForTelegram(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function classify(err: unknown): { unreachable: boolean; description: string } {
  const api = err as TelegramApiError;
  const code = api?.response?.error_code ?? api?.code;
  const description = api?.response?.description ?? api?.description ?? describeError(err);
  const lowered = description.toLowerCase();
  const unreachable =
    code === 403 ||
    lowered.includes('bot was blocked by the user') ||
    lowered.includes('user is deactivated') ||
    lowered.includes('chat not found') ||
    lowered.includes('bot was kicked');
  return { unreachable, description };
}

/**
 * Sends messages through the bot without ever throwing: every failure is reported
 * as a result, and users who blocked the bot are marked `blocked` in the database.
 */
export class Notifier {
  constructor(
    private readonly bot: Telegraf,
    private readonly repo: Repo,
  ) {}

  async sendToUser(chatId: number, html: string): Promise<SendResult> {
    try {
      await this.bot.telegram.sendMessage(chatId, truncateForTelegram(html), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { ok: true, unreachable: false };
    } catch (err) {
      const { unreachable, description } = classify(err);
      if (unreachable) {
        log.warn(`chat ${chatId} unreachable, marking blocked: ${description}`);
        try {
          await this.repo.setUserStatus(chatId, 'blocked');
        } catch (dbErr) {
          log.error(`failed to mark chat ${chatId} blocked: ${describeError(dbErr)}`);
        }
      } else {
        log.error(`send to chat ${chatId} failed: ${description}`);
      }
      return { ok: false, unreachable, error: description };
    }
  }

  /** Sends to the admin chat. Never marks the admin blocked. */
  async sendToAdmin(adminChatId: number, html: string): Promise<AdminSendResult> {
    try {
      const sent = await this.bot.telegram.sendMessage(adminChatId, truncateForTelegram(html), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { ok: true, unreachable: false, messageId: sent.message_id };
    } catch (err) {
      const { unreachable, description } = classify(err);
      log.error(`send to admin chat ${adminChatId} failed: ${description}`);
      return { ok: false, unreachable, error: description };
    }
  }
}
