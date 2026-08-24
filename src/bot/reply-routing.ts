/**
 * Routing for admin replies.
 *
 * Every message forwarded to the admin chat carries a visible marker such as
 * `#sw1234567`. When the admin replies to that message, we resolve the target
 * user in two ways:
 *
 *   1. an in-memory map from the forwarded message_id to the user's chat_id
 *      (exact, but lost on restart), then
 *   2. parsing the marker out of the quoted message text (survives restarts).
 *
 * Either path alone is enough; together they make reply routing robust.
 */

const MARKER_PREFIX = '#sw';
const MARKER_RE = /#sw(-?\d{1,19})\b/;

export function buildMarker(chatId: number): string {
  return `${MARKER_PREFIX}${chatId}`;
}

export function parseMarker(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = MARKER_RE.exec(text);
  if (!match || match[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Bounded map of forwarded admin message_id -> user chat_id. */
export class ForwardIndex {
  private readonly entries = new Map<number, number>();

  constructor(private readonly maxEntries = 5000) {}

  remember(adminMessageId: number, userChatId: number): void {
    if (this.entries.has(adminMessageId)) this.entries.delete(adminMessageId);
    this.entries.set(adminMessageId, userChatId);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  lookup(adminMessageId: number): number | null {
    return this.entries.get(adminMessageId) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}
