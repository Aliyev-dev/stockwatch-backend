import type { Server } from 'node:http';
import { ConfigError, loadConfig, type Config } from './config';
import { createDb } from './db/client';
import { Repo } from './db/repo';
import { createBot } from './bot';
import { assertPanelExists, createServer } from './api/server';
import { describeError, logger } from './logger';

/** Prints a human-readable fatal message and exits without a stack-trace dump. */
function fatal(title: string, details: string[]): never {
  const line = '─'.repeat(72);
  console.error(`\n${line}\nSTOCKWATCH BACKEND CANNOT START — ${title}\n${line}`);
  for (const detail of details) console.error(detail);
  console.error(`${line}\n`);
  process.exit(1);
}

interface TelegramApiError {
  response?: { error_code?: number; description?: string };
  description?: string;
}

/** Confirms the token is accepted by Telegram before we start polling with it. */
async function verifyBotToken(bot: ReturnType<typeof createBot>): Promise<{ username: string }> {
  try {
    const me = await bot.bot.telegram.getMe();
    return { username: me.username ?? 'unknown' };
  } catch (err) {
    const api = err as TelegramApiError;
    const code = api?.response?.error_code;
    const description = api?.response?.description ?? api?.description ?? describeError(err);
    if (code === 401) {
      fatal('the Telegram bot token was rejected', [
        'Telegram replied 401 Unauthorized for TELEGRAM_BOT_TOKEN.',
        '',
        'Fix it by:',
        '  1. Opening @BotFather in Telegram.',
        '  2. Running /mybots -> your bot -> API Token (or /token) to copy the current token.',
        '  3. Putting that value in TELEGRAM_BOT_TOKEN in your .env (or your host\'s env vars).',
        '',
        'Note that /revoke in BotFather invalidates the old token immediately.',
      ]);
    }
    fatal('the Telegram API could not be reached', [
      `Telegram error while calling getMe: ${description}`,
      '',
      'Check this machine\'s network access to api.telegram.org and try again.',
    ]);
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      fatal('the environment is incomplete', [
        ...err.problems.map((p) => `  • ${p}`),
        '',
        'Copy .env.example to .env and fill in the values, or set them in your host\'s dashboard.',
      ]);
    }
    fatal('the configuration could not be read', [describeError(err)]);
  }

  try {
    assertPanelExists();
  } catch (err) {
    fatal('the admin panel asset is missing', [describeError(err)]);
  }

  const repo = new Repo(createDb(config));
  const botService = createBot({ config, repo });

  const me = await verifyBotToken(botService);
  logger.info(`authenticated with Telegram as @${me.username}`);

  // A database that is down at boot is recoverable, so warn loudly and keep going;
  // /health reports the real state and the API answers 503 until it comes back.
  try {
    await repo.ping();
    logger.info('supabase reachable');
  } catch (err) {
    logger.error(
      `supabase is not reachable or the schema is missing: ${describeError(err)}. ` +
        'Run schema.sql in the Supabase SQL editor and check SUPABASE_URL / SUPABASE_SERVICE_KEY.',
    );
  }

  const app = createServer({ config, repo, notifier: botService.notifier });

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(config.port, () => resolve(listening));
      listening.on('error', reject);
    });
  } catch (err) {
    fatal('the HTTP port could not be opened', [
      `Listening on port ${config.port} failed: ${describeError(err)}`,
      'Set PORT to a free port, or stop whatever is already using it.',
    ]);
  }

  logger.info(`http listening on port ${config.port}`);
  logger.info(`admin panel: ${config.publicUrl ?? `http://localhost:${config.port}`}/admin`);

  await botService.launch();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    botService.stop(signal);
    server.close(() => {
      logger.info('http server closed');
      process.exit(0);
    });
    // Do not hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Nothing in a background task is allowed to take the process down.
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled promise rejection: ${describeError(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception: ${describeError(err)}`);
  });
}

void main().catch((err: unknown) => {
  fatal('an unexpected error occurred during startup', [describeError(err)]);
});
