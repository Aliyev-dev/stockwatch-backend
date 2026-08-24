import cors, { type CorsOptions } from 'cors';
import { Router, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { Notifier } from '../bot/notifier';
import { escapeHtml } from '../bot/notifier';
import { createLogger, describeError } from '../logger';
import { RateLimiter } from './rate-limit';

const log = createLogger('api:notify');

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2000;
const CODE_RE = /^[A-Za-z0-9]{4,32}$/;

/** Per-code limits: bursty enough for real alerts, tight enough to stop abuse. */
const PER_MINUTE = new RateLimiter(20, 60_000);
const PER_HOUR = new RateLimiter(200, 60 * 60_000);

interface NotifyBody {
  code?: unknown;
  title?: unknown;
  body?: unknown;
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

export function createNotifyRouter(deps: { config: Config; repo: Repo; notifier: Notifier }): Router {
  const { config, repo, notifier } = deps;
  const router = Router();

  // The Chrome extension calls this from a chrome-extension:// origin, so CORS is
  // opened here — and only here. Every other route stays same-origin.
  const corsOptions: CorsOptions = {
    origin: config.allowedExtensionOrigin ?? true,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 86_400,
  };

  router.options('/notify', cors(corsOptions));
  router.post('/notify', cors(corsOptions), async (req: Request, res: Response) => {
    const payload = (req.body ?? {}) as NotifyBody;

    const rawCode = readText(payload.code, 32);
    if (rawCode === null || !CODE_RE.test(rawCode)) {
      res.status(400).json({ error: 'invalid_request', message: 'Field "code" must be the link code from the bot.' });
      return;
    }

    // Link codes are generated uppercase; normalise so casing cannot split rate-limit
    // buckets or cause a spurious 404.
    const code = rawCode.toUpperCase();

    const title = readText(payload.title, MAX_TITLE_LENGTH);
    const body = readText(payload.body, MAX_BODY_LENGTH);
    if (title === null && body === null) {
      res.status(400).json({ error: 'invalid_request', message: 'At least one of "title" or "body" is required.' });
      return;
    }

    const perMinute = PER_MINUTE.check(code);
    const perHour = perMinute.allowed ? PER_HOUR.check(code) : { allowed: false, retryAfter: 0, remaining: 0 };
    if (!perMinute.allowed || !perHour.allowed) {
      const retryAfter = Math.max(perMinute.retryAfter, perHour.retryAfter);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retry_after: retryAfter });
      return;
    }

    let user;
    try {
      user = await repo.findUserByLinkCode(code);
    } catch (err) {
      log.error(`lookup failed for code: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not reach the database. Try again shortly.' });
      return;
    }

    if (!user) {
      res.status(404).json({ error: 'unknown_code', message: 'No user is linked to that code.' });
      return;
    }

    const html = [title ? `<b>${escapeHtml(title)}</b>` : null, body ? escapeHtml(body) : null]
      .filter((part): part is string => part !== null)
      .join('\n\n');

    const sent = await notifier.sendToUser(user.chat_id, html);
    if (!sent.ok) {
      if (sent.unreachable) {
        res.status(410).json({ error: 'user_unreachable', message: 'The user has blocked the bot.' });
        return;
      }
      res.status(502).json({ error: 'delivery_failed', message: 'Telegram rejected the message.' });
      return;
    }

    const plain = [title, body].filter((part): part is string => part !== null && part !== undefined).join('\n\n');
    try {
      await repo.recordNotification(user.chat_id, plain);
      await repo.touchLastSeen(user.chat_id);
    } catch (err) {
      // The alert was delivered; a bookkeeping failure must not turn into a 5xx.
      log.error(`failed to log notification for chat ${user.chat_id}: ${describeError(err)}`);
    }

    res.status(200).json({ ok: true, delivered: true });
  });

  return router;
}
