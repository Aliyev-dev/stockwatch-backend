import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { UserRow } from '../db/types';
import { createLogger, describeError } from '../logger';
import { Notifier, escapeHtml, truncateForTelegram } from './notifier';
import { ForwardIndex, buildMarker, parseMarker } from './reply-routing';
import { DEFAULT_LANGUAGE, isLanguage, languageKeyboard, normaliseLanguage, t, type Language } from './i18n';

const log = createLogger('bot');

export interface BotDeps {
  config: Config;
  repo: Repo;
}

export interface BotService {
  bot: Telegraf;
  notifier: Notifier;
  /** Starts long polling. Resolves once Telegram has accepted the connection. */
  launch(): Promise<void>;
  stop(reason: string): void;
}

function displayName(user: { first_name?: string | null; username?: string | null; chat_id?: number }): string {
  if (user.first_name && user.first_name.trim() !== '') return user.first_name;
  if (user.username && user.username.trim() !== '') return `@${user.username}`;
  return `chat ${user.chat_id ?? 'unknown'}`;
}

export function createBot(deps: BotDeps): BotService {
  const { config, repo } = deps;
  const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 30_000 });
  const notifier = new Notifier(bot, repo);
  const forwardIndex = new ForwardIndex();

  const isAdminChat = (ctx: Context): boolean => ctx.chat?.id === config.adminChatId;

  /**
   * Deep-link payload (`https://t.me/<bot>?start=help`) parked until the user has
   * picked a language, so the onboarding order stays: register -> language -> code.
   */
  const pendingPayload = new Map<number, string>();

  /** The optional support group; replies typed there are relayed to the user too. */
  const isSupportGroup = (ctx: Context): boolean =>
    config.supportGroupId !== null && ctx.chat?.id === config.supportGroupId;

  /** Either place staff can answer from. */
  const isStaffChat = (ctx: Context): boolean => isAdminChat(ctx) || isSupportGroup(ctx);

  /** Answers a user without letting a failed reply bubble up into the polling loop. */
  const safeReply = async (ctx: Context, html: string): Promise<void> => {
    try {
      await ctx.reply(truncateForTelegram(html), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      log.warn(`reply to chat ${ctx.chat?.id ?? 'unknown'} failed: ${describeError(err)}`);
    }
  };

  const registerUser = async (ctx: Context): Promise<{ user: UserRow; created: boolean } | null> => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || chatId === undefined) return null;
    try {
      const { user, created } = await repo.upsertUser({
        chatId,
        username: from.username ?? null,
        firstName: from.first_name ?? null,
      });
      return { user, created };
    } catch (err) {
      log.error(`upsertUser failed for chat ${chatId}: ${describeError(err)}`);
      return null;
    }
  };

  /** The user's language, defaulting to Azerbaijani for anything unknown. */
  const languageOf = (user: UserRow): Language => normaliseLanguage(user.language);

  /** Reads the language of a chat we only know by id (support replies). */
  const languageOfChat = async (chatId: number): Promise<Language> => {
    try {
      const user = await repo.findUserByChatId(chatId);
      return user ? languageOf(user) : normaliseLanguage(null);
    } catch (err) {
      log.warn(`could not read language for chat ${chatId}: ${describeError(err)}`);
      return normaliseLanguage(null);
    }
  };

  /**
   * The five-language picker, shown on /start and on /language. The prompt text
   * is identical in every language, so it can go out before the database is
   * touched — the keyboard appears instantly.
   */
  const askForLanguage = async (ctx: Context, lang: Language = DEFAULT_LANGUAGE): Promise<void> => {
    try {
      await ctx.reply(t(lang, 'lang_prompt'), {
        reply_markup: { inline_keyboard: languageKeyboard() },
      });
    } catch (err) {
      log.warn(`language prompt to chat ${ctx.chat?.id ?? 'unknown'} failed: ${describeError(err)}`);
    }
  };

  /** Welcome + link code, sent once the language is settled. */
  const sendOnboarding = async (chatId: number, user: UserRow): Promise<void> => {
    const lang = languageOf(user);
    await notifier.sendToUser(
      chatId,
      `${t(lang, 'welcome')}\n\n${t(lang, 'link_code_info', escapeHtml(user.link_code))}`,
    );

    // A deep link such as ?start=help asked for the support flow; honour it now
    // that onboarding is done.
    const payload = pendingPayload.get(chatId);
    pendingPayload.delete(chatId);
    if (payload === 'help') {
      await notifier.sendToUser(chatId, t(lang, 'help_prompt'));
    }
  };

  // --- /start -------------------------------------------------------------
  bot.start(async (ctx) => {
    // Parked before anything is awaited, so it is already there even if the user
    // taps a language button immediately.
    const payload = typeof ctx.payload === 'string' ? ctx.payload.trim() : '';
    if (payload !== '' && ctx.chat) {
      // Only the support deep link is acted on. A link code in the payload is
      // ignored on purpose: rebinding an account from a URL would let anyone
      // claim someone else's code.
      if (payload.toLowerCase() === 'help') pendingPayload.set(ctx.chat.id, 'help');
      else log.info(`ignoring unrecognised start payload from chat ${ctx.chat.id}`);
    }

    // Keyboard first, registration after: the user sees the picker without
    // waiting for the database.
    await askForLanguage(ctx);

    const result = await registerUser(ctx);
    if (!result) {
      await safeReply(ctx, t(null, 'error_generic'));
      return;
    }
    log.info(`${result.created ? 'registered' : 'returning'} user chat ${result.user.chat_id} (${result.user.link_code})`);
  });

  // --- language picker button ---------------------------------------------
  bot.action(/^setlang:(\w{2})$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const chosen = ctx.match[1];

    // FIRST, before any database work: Telegram spins the button's loading
    // indicator until the callback query is answered, so acknowledging it up
    // front is what makes the tap feel instant.
    try {
      await ctx.answerCbQuery();
    } catch (err) {
      log.warn(`answerCbQuery failed for chat ${chatId ?? 'unknown'}: ${describeError(err)}`);
    }

    if (chatId === undefined || !isLanguage(chosen)) return;

    let user: UserRow | null = null;
    try {
      user = await repo.setUserLanguage(chatId, chosen);
    } catch (err) {
      log.error(`failed to store language ${chosen} for chat ${chatId}: ${describeError(err)}`);
    }

    // A user who somehow has no row yet (a very old chat, a wiped table) is
    // registered here rather than being left without a code.
    if (!user) {
      const fallback = await registerUser(ctx);
      if (fallback) {
        try {
          user = (await repo.setUserLanguage(chatId, chosen)) ?? fallback.user;
        } catch {
          user = fallback.user;
        }
      }
    }

    if (!user) {
      await safeReply(ctx, t(chosen, 'error_generic'));
      return;
    }

    try {
      await ctx.editMessageText(t(chosen, 'lang_set'), { parse_mode: 'HTML' });
    } catch (err) {
      // The message may be too old to edit, or unchanged; say it plainly instead.
      log.debug(`editMessageText failed for chat ${chatId}: ${describeError(err)}`);
      await safeReply(ctx, t(chosen, 'lang_set'));
    }

    log.info(`chat ${chatId} chose language ${chosen}`);
    await sendOnboarding(chatId, user);
  });

  // --- /language ----------------------------------------------------------
  bot.command('language', async (ctx) => {
    await askForLanguage(ctx);
    // Refreshes the row (and last_seen) once the keyboard is already on screen.
    await registerUser(ctx);
  });

  // --- /code --------------------------------------------------------------
  bot.command('code', async (ctx) => {
    const result = await registerUser(ctx);
    if (!result) {
      await safeReply(ctx, t(null, 'error_generic'));
      return;
    }
    await safeReply(ctx, t(languageOf(result.user), 'code_reminder', escapeHtml(result.user.link_code)));
  });

  // --- /help --------------------------------------------------------------
  bot.command('help', async (ctx) => {
    const result = await registerUser(ctx);
    const lang = result ? languageOf(result.user) : normaliseLanguage(null);
    await safeReply(ctx, `${t(lang, 'help_body')}\n\n${t(lang, 'help_prompt')}`);
  });

  // --- /reply <chat_id> <text> (admin chat only) --------------------------
  // A manual escape hatch for answering a user without quoting a forwarded message.
  bot.command('reply', async (ctx) => {
    if (!isStaffChat(ctx)) return;
    const raw = 'text' in ctx.message ? ctx.message.text : '';
    const match = /^\/reply(?:@\S+)?\s+(-?\d{1,19})\s+([\s\S]+)$/.exec(raw);
    if (!match || match[1] === undefined || match[2] === undefined) {
      await safeReply(ctx, 'Usage: <code>/reply &lt;chat_id&gt; &lt;message&gt;</code>');
      return;
    }
    await relayToUser(ctx, Number(match[1]), match[2].trim());
  });

  /** Sends an admin answer to a user and records it as an outgoing message. */
  const relayToUser = async (ctx: Context, userChatId: number, text: string): Promise<void> => {
    if (!Number.isSafeInteger(userChatId)) {
      await safeReply(ctx, 'That does not look like a valid chat id.');
      return;
    }
    const lang = await languageOfChat(userChatId);
    const result = await notifier.sendToUser(
      userChatId,
      `<b>${t(lang, 'support_reply_prefix')}</b>\n\n${escapeHtml(text)}`,
    );
    if (!result.ok) {
      await safeReply(
        ctx,
        result.unreachable
          ? `Could not deliver: the user (chat ${userChatId}) has blocked the bot. Marked as blocked.`
          : `Could not deliver to chat ${userChatId}: ${escapeHtml(result.error ?? 'unknown error')}`,
      );
      return;
    }
    try {
      await repo.recordMessage(userChatId, 'out', text);
    } catch (err) {
      log.error(`failed to record outgoing message for chat ${userChatId}: ${describeError(err)}`);
    }

    // Close the support thread this answer belongs to, so the admin panel and the
    // group stay in sync no matter which side replied.
    try {
      const thread = await repo.findLatestOpenSupportMessage(userChatId);
      if (thread) await repo.markSupportAnswered(thread.id, text);
    } catch (err) {
      log.error(`failed to close support thread for chat ${userChatId}: ${describeError(err)}`);
    }

    await safeReply(ctx, `Sent to chat ${userChatId}. ✅`);
  };

  /**
   * Forwards a user's support message to the admin chat and, when configured, to
   * the support group. Both copies carry the routing marker, and both message ids
   * are remembered, so a reply from either place finds its way back to the user.
   *
   * Telegram's group privacy mode does not get in the way: the copy is sent BY the
   * bot, and replies to the bot's own messages are always delivered to it.
   */
  const forwardToSupport = async (user: UserRow, text: string): Promise<void> => {
    const header = [
      `<b>${escapeHtml(displayName(user))}</b>`,
      user.username ? `@${escapeHtml(user.username)}` : null,
      `chat <code>${user.chat_id}</code>`,
      `code <code>${escapeHtml(user.link_code)}</code>`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');

    const body = [
      `📩 ${header}`,
      '',
      escapeHtml(text),
      '',
      `<i>Reply to this message to answer. ${buildMarker(user.chat_id)}</i>`,
    ].join('\n');

    const targets: Array<{ label: string; chatId: number }> = [{ label: 'admin chat', chatId: config.adminChatId }];
    if (config.supportGroupId !== null && config.supportGroupId !== config.adminChatId) {
      targets.push({ label: 'support group', chatId: config.supportGroupId });
    }

    for (const target of targets) {
      const result = await notifier.sendToAdmin(target.chatId, body);
      if (result.ok && result.messageId !== undefined) {
        forwardIndex.remember(result.messageId, user.chat_id);
      } else if (!result.ok) {
        log.error(
          `failed to forward message from chat ${user.chat_id} to ${target.label} (${target.chatId}): ` +
            `${result.error ?? 'unknown error'}`,
        );
      }
    }
  };

  /** Stores the incoming support message so the admin panel can show and answer it. */
  const recordSupportMessage = async (user: UserRow, text: string): Promise<void> => {
    try {
      await repo.createSupportMessage({ chatId: user.chat_id, username: user.username, message: text });
    } catch (err) {
      log.error(`failed to store support message from chat ${user.chat_id}: ${describeError(err)}`);
    }
  };

  // --- plain text ---------------------------------------------------------
  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      // An unknown command: nudge the user rather than forwarding it as a report.
      if (!isStaffChat(ctx)) {
        await safeReply(ctx, t(await languageOfChat(ctx.chat?.id ?? 0), 'unknown_command'));
      }
      return;
    }

    if (isStaffChat(ctx)) {
      const quoted = ctx.message.reply_to_message;
      if (!quoted) {
        // Staff talking among themselves in the group is not an answer to anyone.
        if (isAdminChat(ctx)) {
          await safeReply(
            ctx,
            'Reply to a forwarded message to answer that user, or use <code>/reply &lt;chat_id&gt; &lt;message&gt;</code>.',
          );
        }
        return;
      }
      const quotedText = 'text' in quoted ? quoted.text : undefined;
      const target = forwardIndex.lookup(quoted.message_id) ?? parseMarker(quotedText);
      if (target === null) {
        if (isAdminChat(ctx) || quoted.from?.id === ctx.botInfo?.id) {
          await safeReply(
            ctx,
            'I could not tell which user that message belongs to. Use <code>/reply &lt;chat_id&gt; &lt;message&gt;</code> instead.',
          );
        }
        return;
      }
      await relayToUser(ctx, target, text);
      return;
    }

    const result = await registerUser(ctx);
    if (!result) {
      await safeReply(ctx, t(null, 'error_generic'));
      return;
    }

    try {
      await repo.recordMessage(result.user.chat_id, 'in', text);
    } catch (err) {
      log.error(`failed to record incoming message from chat ${result.user.chat_id}: ${describeError(err)}`);
    }

    await recordSupportMessage(result.user, text);
    await forwardToSupport(result.user, text);
    await safeReply(ctx, t(languageOf(result.user), 'help_sent'));
  });

  // --- anything else (photos, stickers, voice, ...) -----------------------
  bot.on('message', async (ctx) => {
    if (isStaffChat(ctx)) return;
    const result = await registerUser(ctx);
    if (result) {
      const note = '[non-text message]';
      try {
        await repo.recordMessage(result.user.chat_id, 'in', note);
      } catch (err) {
        log.error(`failed to record non-text message from chat ${result.user.chat_id}: ${describeError(err)}`);
      }
      await recordSupportMessage(result.user, note);
      await forwardToSupport(result.user, note);
    }
    await safeReply(ctx, t(await languageOfChat(ctx.chat?.id ?? 0), 'text_only'));
  });

  // A handler that throws must never take the polling loop down with it.
  bot.catch((err, ctx) => {
    log.error(`unhandled error while processing update ${ctx.update.update_id}: ${describeError(err)}`);
  });

  return {
    bot,
    notifier,
    async launch(): Promise<void> {
      // The blue command menu in Telegram. /help is the support entry point.
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Qeydiyyat və link kodu / Register' },
        { command: 'code', description: 'Link kodumu göstər / Show my link code' },
        { command: 'help', description: 'Kömək və dəstək / Help and support' },
        { command: 'language', description: 'Dili dəyiş / Change language' },
      ]);
      // `launch()` only resolves when polling stops, so we start it in the
      // background and surface startup failures through the error log.
      // To move to webhooks later, replace this with:
      //   app.use(await bot.createWebhook({ domain: config.publicUrl! }))
      void bot.launch({ dropPendingUpdates: false }).catch((err) => {
        log.error(`long polling stopped: ${describeError(err)}`);
      });
      log.info('bot started (long polling)');
    },
    stop(reason: string): void {
      try {
        bot.stop(reason);
      } catch (err) {
        log.warn(`error while stopping bot: ${describeError(err)}`);
      }
    },
  };
}
