import { Router, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { ProductInput, Repo } from '../db/repo';
import type { UserRow } from '../db/types';
import type { Notifier } from '../bot/notifier';
import { renderChange, summariseChange } from '../bot/messages';
import { resolveLanguage } from '../lib/language-cache';
import type { ProductChange } from '../lib/product-changes';
import { createLogger, describeError } from '../logger';
import { extensionCors } from './extension-cors';
import { RateLimiter } from './rate-limit';

const log = createLogger('api:products');

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const MAX_PRODUCTS = 500;
const MAX_ASIN = 64;
const MAX_DOMAIN = 128;
const MAX_NAME = 300;
const MAX_STATUS = 64;
const MAX_PRICE = 64;

/** Telegram tolerates roughly one message per second to a chat; pace the batch below that. */
const DISPATCH_DELAY_MS = 250;

/** Upper bound on alerts sent from a single sync, so one request cannot run for minutes. */
const MAX_ALERTS_PER_SYNC = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-code limits: a sync replaces the whole list, so it needs far less headroom than an alert. */
const PER_MINUTE = new RateLimiter(30, 60_000);
const PER_HOUR = new RateLimiter(300, 60 * 60_000);

interface SyncBody {
  code?: unknown;
  products?: unknown;
}

class ValidationError extends Error {}

function requireString(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`"${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`"${field}" must not be empty.`);
  if (trimmed.length > max) throw new ValidationError(`"${field}" must be at most ${max} characters.`);
  return trimmed;
}

/** Optional text: missing, null and empty all collapse to null. */
function optionalString(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== 'string') throw new ValidationError(`"${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

/** Optional whole number, also accepting a numeric string as the extension may send one. */
function optionalInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ValidationError(`"${field}" must be a whole number.`);
  }
  const rounded = Math.trunc(parsed);
  if (!Number.isSafeInteger(rounded)) throw new ValidationError(`"${field}" is out of range.`);
  return rounded;
}

/**
 * Validates the payload and collapses duplicate (asin, domain) pairs — the unique
 * index would reject a batch containing the same product twice, so last one wins.
 */
export function parseProducts(raw: unknown): ProductInput[] {
  if (!Array.isArray(raw)) throw new ValidationError('"products" must be an array.');
  if (raw.length > MAX_PRODUCTS) {
    throw new ValidationError(`"products" must contain at most ${MAX_PRODUCTS} items.`);
  }

  const byKey = new Map<string, ProductInput>();
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`"products[${index}]" must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const asin = requireString(item.asin, MAX_ASIN, `products[${index}].asin`);
    const domain = requireString(item.domain, MAX_DOMAIN, `products[${index}].domain`).toLowerCase();

    byKey.set(`${asin}|${domain}`, {
      asin,
      domain,
      name: optionalString(item.name, MAX_NAME, `products[${index}].name`),
      threshold: optionalInt(item.threshold, `products[${index}].threshold`),
      status: optionalString(item.status, MAX_STATUS, `products[${index}].status`),
      quantity: optionalInt(item.quantity, `products[${index}].quantity`),
      price: optionalString(item.price, MAX_PRICE, `products[${index}].price`),
    });
  });

  return [...byKey.values()];
}

/**
 * Sends one alert per change, one after another, in the language the user picked
 * in the bot. Sequential on purpose: a burst of parallel sends to the same chat
 * trips Telegram's flood control, and a user who blocked the bot should stop the
 * batch instead of failing 20 more times.
 */
async function dispatchChanges(
  user: UserRow,
  changes: ProductChange[],
  notifier: Notifier,
  repo: Repo,
): Promise<number> {
  let delivered = 0;
  const language = resolveLanguage(user.chat_id, user.language);

  for (const [index, change] of changes.slice(0, MAX_ALERTS_PER_SYNC).entries()) {
    if (index > 0) await sleep(DISPATCH_DELAY_MS);

    const result = await notifier.sendToUser(user.chat_id, renderChange(change, language));
    if (!result.ok) {
      if (result.unreachable) {
        log.warn(`chat ${user.chat_id} unreachable, dropping ${changes.length - index} remaining alerts`);
        break;
      }
      continue;
    }

    delivered += 1;
    try {
      await repo.recordNotification(user.chat_id, summariseChange(change));
    } catch (err) {
      // The alert reached the user; failing to log it is not worth an error response.
      log.error(`failed to log alert for chat ${user.chat_id}: ${describeError(err)}`);
    }
  }

  if (changes.length > MAX_ALERTS_PER_SYNC) {
    log.warn(`chat ${user.chat_id}: ${changes.length - MAX_ALERTS_PER_SYNC} changes not alerted (per-sync cap)`);
  }

  return delivered;
}

export function createProductsRouter(deps: { config: Config; repo: Repo; notifier: Notifier }): Router {
  const { config, repo, notifier } = deps;
  const router = Router();
  const withCors = extensionCors(config);

  router.options('/products/sync', withCors);
  router.post('/products/sync', withCors, async (req: Request, res: Response) => {
    const payload = (req.body ?? {}) as SyncBody;

    const rawCode = typeof payload.code === 'string' ? payload.code.trim() : '';
    if (!CODE_RE.test(rawCode)) {
      res.status(400).json({ error: 'invalid_request', message: 'Field "code" must be the link code from the bot.' });
      return;
    }
    const code = rawCode.toUpperCase();

    let products: ProductInput[];
    try {
      products = parseProducts(payload.products);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: 'invalid_request', message: err.message });
        return;
      }
      log.error(`unexpected error validating products: ${describeError(err)}`);
      res.status(400).json({ error: 'invalid_request', message: 'Could not read the "products" list.' });
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

    try {
      const result = await repo.syncProducts(user.chat_id, products);
      try {
        await repo.touchLastSeen(user.chat_id);
      } catch (err) {
        // Bookkeeping only: the sync itself succeeded.
        log.warn(`failed to update last_seen for chat ${user.chat_id}: ${describeError(err)}`);
      }

      // A deactivated user still has their list stored, but hears nothing. The
      // flag is echoed back so the extension can stop polling Amazon for them.
      const active = user.is_active !== false;
      const alerts = active ? await dispatchChanges(user, result.changes, notifier, repo) : 0;
      if (!active && result.changes.length > 0) {
        log.info(`chat ${user.chat_id} is deactivated: skipped ${result.changes.length} alerts`);
      }

      res.status(200).json({
        ok: true,
        active,
        synced: result.upserted,
        removed: result.removed,
        changes: result.changes.length,
        alerts,
      });
    } catch (err) {
      log.error(`sync failed for chat ${user.chat_id}: ${describeError(err)}`);
      res.status(503).json({ error: 'unavailable', message: 'Could not save the product list. Try again shortly.' });
    }
  });

  return router;
}
