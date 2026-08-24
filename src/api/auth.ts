import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config';

export const ADMIN_COOKIE = 'sw_admin';

/** Constant-time comparison that tolerates differing lengths. */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still compare something of equal length so timing does not leak the length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const header = req.get('x-admin-token');
  if (header && header.trim() !== '') return header.trim();

  const authorization = req.get('authorization');
  if (authorization && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim();
  }

  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const cookie = cookies?.[ADMIN_COOKIE];
  if (typeof cookie === 'string' && cookie !== '') return cookie;

  return null;
}

export function isAuthorized(req: Request, config: Config): boolean {
  const token = presentedToken(req);
  return token !== null && tokensMatch(token, config.adminToken);
}

/** Guards the admin JSON API. */
export function requireAdmin(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthorized(req, config)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

export function adminCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
