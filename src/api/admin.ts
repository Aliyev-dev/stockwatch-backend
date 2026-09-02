import { Router, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { Notifier } from '../bot/notifier';
import { escapeHtml } from '../bot/notifier';
import { createLogger, describeError } from '../logger';
import { ADMIN_COOKIE, adminCookieOptions, requireAdmin, tokensMatch } from './auth';
import { RateLimiter } from './rate-limit';

const log = createLogger('api:admin');

const DEFAULT_USER_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 100;
const DEFAULT_PRODUCT_LIMIT = 500;
const DEFAULT_SUPPORT_LIMIT = 100;
const MAX_REPLY_LENGTH = 2000;
const MAX_LIMIT = 1000;

/** Slows down password guessing against the login form. */
const LOGIN_LIMITER = new RateLimiter(10, 60_000);

function readLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function createAdminRouter(deps: { config: Config; repo: Repo; notifier: Notifier }): Router {
  const { config, repo, notifier } = deps;
  const router = Router();

  // --- login / logout (cookie session) ------------------------------------
  router.post('/admin/login', (req: Request, res: Response) => {
    const limit = LOGIN_LIMITER.check(clientKey(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      res.status(429).json({ error: 'rate_limited', retry_after: limit.retryAfter });
      return;
    }

    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !tokensMatch(token, config.adminToken)) {
      res.status(401).json({ error: 'unauthorized', message: 'Wrong admin token.' });
      return;
    }

    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.cookie(ADMIN_COOKIE, config.adminToken, adminCookieOptions(secure));
    res.json({ ok: true });
  });

  router.post('/admin/logout', (_req: Request, res: Response) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // --- protected data endpoints -------------------------------------------
  const guard = requireAdmin(config);

  router.get('/admin/session', guard, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  router.get('/admin/users', guard, async (req: Request, res: Response) => {
    try {
      const users = await repo.listUsersWithCounts(readLimit(req.query.limit, DEFAULT_USER_LIMIT));
      res.json({ users });
    } catch (err) {
      log.error(`GET /api/admin/users failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read users from the database.' });
    }
  });

  router.get('/admin/messages', guard, async (req: Request, res: Response) => {
    try {
      const messages = await repo.listRecentMessages(readLimit(req.query.limit, DEFAULT_MESSAGE_LIMIT));
      res.json({ messages });
    } catch (err) {
      log.error(`GET /api/admin/messages failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read messages from the database.' });
    }
  });

  router.get('/admin/users/:chatId/products', guard, async (req: Request, res: Response) => {
    const chatId = Number(req.params.chatId);
    if (!Number.isSafeInteger(chatId)) {
      res.status(400).json({ error: 'invalid_request', message: 'chatId must be a numeric Telegram chat id.' });
      return;
    }
    try {
      const products = await repo.listProductsByChatId(chatId, readLimit(req.query.limit, DEFAULT_PRODUCT_LIMIT));
      res.json({ chat_id: chatId, products });
    } catch (err) {
      log.error(`GET /api/admin/users/${chatId}/products failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read products from the database.' });
    }
  });

  // --- activate / deactivate a user (DÜZƏLİŞ 6) ---------------------------
  router.post('/admin/users/:chatId/active', guard, async (req: Request, res: Response) => {
    const chatId = Number(req.params.chatId);
    if (!Number.isSafeInteger(chatId)) {
      res.status(400).json({ error: 'invalid_request', message: 'chatId must be a numeric Telegram chat id.' });
      return;
    }

    const wanted = (req.body as { is_active?: unknown } | undefined)?.is_active;
    if (typeof wanted !== 'boolean') {
      res.status(400).json({ error: 'invalid_request', message: 'Body must be {"is_active": true|false}.' });
      return;
    }

    try {
      const user = await repo.setUserActive(chatId, wanted);
      if (!user) {
        res.status(404).json({ error: 'not_found', message: 'No user with that chat id.' });
        return;
      }
      log.info(`chat ${chatId} ${wanted ? 'activated' : 'deactivated'} by admin`);
      res.json({ ok: true, chat_id: chatId, is_active: user.is_active });
    } catch (err) {
      log.error(`POST /api/admin/users/${chatId}/active failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not update the user.' });
    }
  });

  // --- support inbox (DÜZƏLİŞ 8+9) ----------------------------------------
  router.get('/admin/support', guard, async (req: Request, res: Response) => {
    try {
      const messages = await repo.listSupportMessages(readLimit(req.query.limit, DEFAULT_SUPPORT_LIMIT));
      res.json({ messages });
    } catch (err) {
      log.error(`GET /api/admin/support failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read support messages.' });
    }
  });

  router.post('/admin/support/:id/reply', guard, async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const raw = (req.body as { text?: unknown } | undefined)?.text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Body must be {"text": "your reply"}.' });
      return;
    }
    if (text.length > MAX_REPLY_LENGTH) {
      res.status(400).json({ error: 'invalid_request', message: `Reply must be at most ${MAX_REPLY_LENGTH} characters.` });
      return;
    }

    let thread;
    try {
      thread = await repo.findSupportMessage(id);
    } catch (err) {
      log.error(`support lookup failed for ${id}: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read that message.' });
      return;
    }
    if (!thread) {
      res.status(404).json({ error: 'not_found', message: 'No support message with that id.' });
      return;
    }

    const sent = await notifier.sendToUser(thread.chat_id, `<b>StockWatch dəstək</b>\n\n${escapeHtml(text)}`);
    if (!sent.ok) {
      res.status(sent.unreachable ? 410 : 502).json({
        error: sent.unreachable ? 'user_unreachable' : 'delivery_failed',
        message: sent.unreachable
          ? 'The user has blocked the bot, so the reply could not be delivered.'
          : 'Telegram rejected the reply.',
      });
      return;
    }

    try {
      await repo.markSupportAnswered(thread.id, text);
      await repo.recordMessage(thread.chat_id, 'out', text);
    } catch (err) {
      // Delivered already; only the bookkeeping failed.
      log.error(`failed to record support reply for ${thread.id}: ${describeError(err)}`);
    }

    res.json({ ok: true, chat_id: thread.chat_id });
  });

  router.get('/admin/stats', guard, async (_req: Request, res: Response) => {
    try {
      res.json(await repo.stats());
    } catch (err) {
      log.error(`GET /api/admin/stats failed: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not read stats from the database.' });
    }
  });

  return router;
}
