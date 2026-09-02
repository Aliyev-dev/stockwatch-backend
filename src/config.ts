import 'dotenv/config';

export interface Config {
  telegramBotToken: string;
  adminChatId: number;
  /** Support group the bot forwards user messages into. Optional. */
  supportGroupId: number | null;
  adminToken: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  port: number;
  allowedExtensionOrigin: string | null;
  publicUrl: string | null;
}

/** Thrown when the environment is not usable. Reported as a clear message, never a stack-trace crash. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function readString(name: string, problems: string[], hint: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    problems.push(`${name} is missing. ${hint}`);
    return '';
  }
  return raw.trim();
}

/**
 * Telegram bot tokens look like `<bot_id>:<35-char secret>`.
 * We only check the shape here; validity is confirmed against the API at startup.
 */
function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const telegramBotToken = readString(
    'TELEGRAM_BOT_TOKEN',
    problems,
    'Create a bot with @BotFather in Telegram and copy the token it gives you.',
  );
  if (telegramBotToken && !looksLikeBotToken(telegramBotToken)) {
    problems.push(
      'TELEGRAM_BOT_TOKEN does not look like a Telegram bot token ' +
        '(expected something like "123456789:AA...", 35+ chars after the colon).',
    );
  }

  const adminChatIdRaw = readString(
    'ADMIN_CHAT_ID',
    problems,
    'Send /start to @userinfobot in Telegram to learn your own numeric chat id.',
  );
  let adminChatId = 0;
  if (adminChatIdRaw) {
    const parsed = Number(adminChatIdRaw);
    if (!Number.isSafeInteger(parsed) || parsed === 0) {
      problems.push(`ADMIN_CHAT_ID must be a numeric Telegram chat id, got "${adminChatIdRaw}".`);
    } else {
      adminChatId = parsed;
    }
  }

  const supportGroupRaw = (env.SUPPORT_GROUP_ID ?? '').trim();
  let supportGroupId: number | null = null;
  if (supportGroupRaw !== '') {
    const parsed = Number(supportGroupRaw);
    if (!Number.isSafeInteger(parsed) || parsed === 0) {
      problems.push(
        `SUPPORT_GROUP_ID must be a numeric Telegram chat id (groups are negative, e.g. -1001234567890), got "${supportGroupRaw}".`,
      );
    } else {
      supportGroupId = parsed;
    }
  }

  const adminToken = readString(
    'ADMIN_TOKEN',
    problems,
    'Pick a long random string; it is the password for /admin and the admin API.',
  );
  if (adminToken && adminToken.length < 12) {
    problems.push('ADMIN_TOKEN must be at least 12 characters long.');
  }

  const supabaseUrl = readString(
    'SUPABASE_URL',
    problems,
    'Supabase Dashboard -> Project Settings -> Data API -> Project URL.',
  );
  if (supabaseUrl && !/^https?:\/\//.test(supabaseUrl)) {
    problems.push(`SUPABASE_URL must start with https://, got "${supabaseUrl}".`);
  }

  const supabaseServiceKey = readString(
    'SUPABASE_SERVICE_KEY',
    problems,
    'Supabase Dashboard -> Project Settings -> API Keys -> service_role key (not the anon key).',
  );

  const portRaw = (env.PORT ?? '8080').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535, got "${portRaw}".`);
  }

  const allowedOriginRaw = (env.ALLOWED_EXTENSION_ORIGIN ?? '').trim();
  const publicUrlRaw = (env.PUBLIC_URL ?? '').trim();

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    telegramBotToken,
    adminChatId,
    supportGroupId,
    adminToken,
    supabaseUrl,
    supabaseServiceKey,
    port,
    allowedExtensionOrigin: allowedOriginRaw === '' ? null : allowedOriginRaw,
    publicUrl: publicUrlRaw === '' ? null : publicUrlRaw.replace(/\/+$/, ''),
  };
}
