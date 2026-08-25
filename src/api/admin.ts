import { Router, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import { createLogger, describeError } from '../logger';
import { ADMIN_COOKIE, adminCookieOptions, requireAdmin, tokensMatch } from './auth';
import { RateLimiter } from './rate-limit';

const log = createLogger('api:admin');

const DEFAULT_USER_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 100;
const DEFAULT_PRODUCT_LIMIT = 500;
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

export function createAdminRouter(deps: { config: Config; repo: Repo }): Router {
  const { config, repo } = deps;
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
