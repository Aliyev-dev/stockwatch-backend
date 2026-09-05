import { isLanguage, normaliseLanguage, type Language } from '../bot/i18n';

/**
 * Last language each chat actually picked, kept in memory.
 *
 * `users.language` is the source of truth. This cache only covers the gap when
 * the stored value is missing or unreadable — the column not migrated yet, a
 * stale PostgREST schema cache, or a failed write — so that a user who just
 * tapped 🇩🇪 does not keep getting Azerbaijani until the database catches up.
 *
 * Process-local and lost on restart, by design: it is a safety net, not storage.
 */

const MAX_ENTRIES = 20_000;
const chosen = new Map<number, Language>();

/** Records what the user tapped, before (and regardless of) the database write. */
export function rememberLanguage(chatId: number, language: Language): void {
  if (chosen.has(chatId)) chosen.delete(chatId);
  chosen.set(chatId, language);
  while (chosen.size > MAX_ENTRIES) {
    const oldest = chosen.keys().next();
    if (oldest.done) break;
    chosen.delete(oldest.value);
  }
}

export function cachedLanguage(chatId: number | null | undefined): Language | null {
  if (typeof chatId !== 'number') return null;
  return chosen.get(chatId) ?? null;
}

/**
 * The language to speak to this chat in: the stored value when it is a language
 * we know, otherwise the last one the user picked, otherwise the default.
 */
export function resolveLanguage(chatId: number | null | undefined, stored: unknown): Language {
  if (isLanguage(stored)) return stored;
  return cachedLanguage(chatId) ?? normaliseLanguage(null);
}
