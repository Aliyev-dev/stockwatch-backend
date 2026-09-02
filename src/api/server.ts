import path from 'node:path';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { Repo } from '../db/repo';
import type { Notifier } from '../bot/notifier';
import { createLogger, describeError } from '../logger';
import { createAdminRouter } from './admin';
import { createNotifyRouter } from './notify';
import { createProductsRouter } from './products';

const log = createLogger('api');

/**
 * Located relative to this module so it resolves both under tsx (src/api -> src/admin)
 * and after a build (dist/api -> dist/admin, copied by scripts/copy-assets.js).
 */
const PANEL_PATH = path.join(__dirname, '..', 'admin', 'panel.html');

export interface ServerDeps {
  config: Config;
  repo: Repo;
  notifier: Notifier;
}

export function createServer(deps: ServerDeps): Application {
  const { config, repo, notifier } = deps;
  const app = express();

  // Railway/Render terminate TLS in front of us; trust one proxy hop so req.ip
  // and req.secure reflect the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await repo.ping();
      res.json({ ok: true, db: 'up' });
    } catch (err) {
      log.warn(`health check failed: ${describeError(err)}`);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.use('/api', createNotifyRouter({ config, repo, notifier }));
  app.use('/api', createProductsRouter({ config, repo, notifier }));
  app.use('/api', createAdminRouter({ config, repo, notifier }));

  // The panel is a static shell with no embedded secrets: it asks for the admin
  // token, exchanges it for the session cookie, and every data call behind it is
  // token-protected. Serving the shell to an unauthenticated visitor is what
  // renders the login form.
  app.get('/admin', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(PANEL_PATH, (err) => {
      if (err) next(err);
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ service: 'stockwatch-backend', admin: '/admin', notify: 'POST /api/notify' });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Final safety net: any error escaping a handler becomes a 500, not a crash.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error(`unhandled request error: ${describeError(err)}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/** Fails fast at startup if the built panel asset is missing. */
export function assertPanelExists(): void {
  if (!fs.existsSync(PANEL_PATH)) {
    throw new Error(
      `Admin panel asset not found at ${PANEL_PATH}. Run "npm run build" (it copies src/admin/panel.html into dist/).`,
    );
  }
}
