import { randomInt } from 'node:crypto';
import { DbError, type Db } from './client';
import type {
  MessageDirection,
  MessageRow,
  NotificationRow,
  ProductRow,
  SupportMessageRow,
  UserRow,
  UserStatus,
} from './types';
import { diffProduct, type ProductChange } from '../lib/product-changes';
import { normaliseLanguage, type Language } from '../bot/i18n';

/** Unambiguous alphabet: no 0/O/1/I/L, so codes survive being read aloud or retyped. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_MAX_ATTEMPTS = 8;

export function generateLinkCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export interface UpsertUserInput {
  chatId: number;
  username: string | null;
  firstName: string | null;
}

export interface UpsertUserResult {
  user: UserRow;
  created: boolean;
}

export interface AdminUserOverview {
  id: string;
  chat_id: number;
  username: string | null;
  first_name: string | null;
  status: string;
  is_active: boolean;
  language: string;
  joined_at: string;
  last_seen: string | null;
  message_count: number;
  notification_count: number;
  product_count: number;
}

/** One watched product as sent by the extension. */
export interface ProductInput {
  asin: string;
  name: string | null;
  domain: string;
  threshold: number | null;
  status: string | null;
  quantity: number | null;
  price: string | null;
}

export interface SyncProductsResult {
  /** Rows inserted or refreshed. */
  upserted: number;
  /** Rows removed because the owner is no longer watching them. */
  removed: number;
  /** Everything that changed against the previously stored state. */
  changes: ProductChange[];
}

export interface AdminMessage extends MessageRow {
  username: string | null;
  first_name: string | null;
}

export interface AdminStats {
  users: number;
  activeUsers: number;
  blockedUsers: number;
  messagesToday: number;
  notificationsToday: number;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

export class Repo {
  constructor(private readonly db: Db) {}

  /** Cheap round-trip used by /health and by startup validation. */
  async ping(): Promise<void> {
    const { error } = await this.db.from('users').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw new DbError('ping', error);
  }

  async findUserByChatId(chatId: number): Promise<UserRow | null> {
    const { data, error } = await this.db.from('users').select('*').eq('chat_id', chatId).maybeSingle();
    if (error) throw new DbError('findUserByChatId', error);
    return data ?? null;
  }

  async findUserByLinkCode(linkCode: string): Promise<UserRow | null> {
    const { data, error } = await this.db.from('users').select('*').eq('link_code', linkCode).maybeSingle();
    if (error) throw new DbError('findUserByLinkCode', error);
    return data ?? null;
  }

  /**
   * Creates the user on first contact (assigning a unique link_code) or refreshes
   * their profile fields and last_seen. Re-activates a user who had been marked
   * blocked, since talking to the bot proves they have not blocked it.
   */
  async upsertUser(input: UpsertUserInput): Promise<UpsertUserResult> {
    const now = new Date().toISOString();
    const existing = await this.findUserByChatId(input.chatId);

    if (existing) {
      const { data, error } = await this.db
        .from('users')
        .update({
          username: input.username,
          first_name: input.firstName,
          last_seen: now,
          status: 'active',
        })
        .eq('chat_id', input.chatId)
        .select('*')
        .single();
      if (error) throw new DbError('upsertUser.update', error);
      return { user: data, created: false };
    }

    for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt += 1) {
      const { data, error } = await this.db
        .from('users')
        .insert({
          chat_id: input.chatId,
          username: input.username,
          first_name: input.firstName,
          link_code: generateLinkCode(),
          status: 'active',
          last_seen: now,
        })
        .select('*')
        .single();

      if (!error) return { user: data, created: true };

      if (error.code === UNIQUE_VIOLATION) {
        // Either the link_code collided (retry with a new one) or another update
        // for the same chat_id landed first (fall back to reading that row).
        const raced = await this.findUserByChatId(input.chatId);
        if (raced) return { user: raced, created: false };
        continue;
      }
      throw new DbError('upsertUser.insert', error);
    }

    throw new DbError('upsertUser.insert', { message: `could not allocate a unique link_code after ${CODE_MAX_ATTEMPTS} attempts` });
  }

  async touchLastSeen(chatId: number): Promise<void> {
    const { error } = await this.db
      .from('users')
      .update({ last_seen: new Date().toISOString() })
      .eq('chat_id', chatId);
    if (error) throw new DbError('touchLastSeen', error);
  }

  async setUserStatus(chatId: number, status: UserStatus): Promise<void> {
    const { error } = await this.db.from('users').update({ status }).eq('chat_id', chatId);
    if (error) throw new DbError('setUserStatus', error);
  }

  /** Admin on/off switch (DÜZƏLİŞ 6). Returns the updated user, or null if unknown. */
  async setUserActive(chatId: number, isActive: boolean): Promise<UserRow | null> {
    const { data, error } = await this.db
      .from('users')
      .update({ is_active: isActive })
      .eq('chat_id', chatId)
      .select('*')
      .maybeSingle();
    if (error) throw new DbError('setUserActive', error);
    return data ?? null;
  }

  /** Stores the language the user picked in the bot. */
  async setUserLanguage(chatId: number, language: Language): Promise<UserRow | null> {
    const { data, error } = await this.db
      .from('users')
      .update({ language })
      .eq('chat_id', chatId)
      .select('*')
      .maybeSingle();
    if (error) throw new DbError('setUserLanguage', error);
    return data ?? null;
  }

  async recordMessage(chatId: number, direction: MessageDirection, text: string): Promise<void> {
    const { error } = await this.db.from('messages').insert({ chat_id: chatId, direction, text });
    if (error) throw new DbError('recordMessage', error);
  }

  async recordNotification(chatId: number, text: string): Promise<void> {
    const { error } = await this.db.from('notifications').insert({ chat_id: chatId, text });
    if (error) throw new DbError('recordNotification', error);
  }

  /**
   * Users plus their message/notification counters. Uses the admin_user_overview
   * view when it exists; otherwise counts in Node so the panel still works on a
   * database created before the view was added.
   */
  async listUsersWithCounts(limit: number): Promise<AdminUserOverview[]> {
    const viaView = await this.db
      .from('admin_user_overview')
      .select('*')
      .order('joined_at', { ascending: false })
      .limit(limit);

    if (!viaView.error) {
      return viaView.data.map((row) => ({
        ...row,
        message_count: Number(row.message_count ?? 0),
        notification_count: Number(row.notification_count ?? 0),
        // Absent on a database still running the pre-products view.
        product_count: Number(row.product_count ?? 0),
        // Absent on a view predating the is_active column; treat those users as active.
        is_active: row.is_active !== false,
        language: normaliseLanguage(row.language),
      }));
    }

    return this.listUsersWithCountsFallback(limit);
  }

  private async listUsersWithCountsFallback(limit: number): Promise<AdminUserOverview[]> {
    const { data: users, error } = await this.db
      .from('users')
      .select('*')
      .order('joined_at', { ascending: false })
      .limit(limit);
    if (error) throw new DbError('listUsers', error);

    const chatIds = (users ?? []).map((u) => u.chat_id);
    if (chatIds.length === 0) return [];

    const [messages, notifications, products] = await Promise.all([
      this.db.from('messages').select('chat_id').in('chat_id', chatIds),
      this.db.from('notifications').select('chat_id').in('chat_id', chatIds),
      this.db.from('products').select('chat_id').in('chat_id', chatIds),
    ]);
    if (messages.error) throw new DbError('listUsers.messages', messages.error);
    if (notifications.error) throw new DbError('listUsers.notifications', notifications.error);
    if (products.error) throw new DbError('listUsers.products', products.error);

    const tally = (rows: { chat_id: number }[]): Map<number, number> => {
      const counts = new Map<number, number>();
      for (const row of rows) counts.set(row.chat_id, (counts.get(row.chat_id) ?? 0) + 1);
      return counts;
    };
    const messageCounts = tally(messages.data ?? []);
    const notificationCounts = tally(notifications.data ?? []);
    const productCounts = tally(products.data ?? []);

    return (users ?? []).map((u) => ({
      id: u.id,
      chat_id: u.chat_id,
      username: u.username,
      first_name: u.first_name,
      status: u.status,
      is_active: u.is_active !== false,
      language: normaliseLanguage(u.language),
      joined_at: u.joined_at,
      last_seen: u.last_seen,
      message_count: messageCounts.get(u.chat_id) ?? 0,
      notification_count: notificationCounts.get(u.chat_id) ?? 0,
      product_count: productCounts.get(u.chat_id) ?? 0,
    }));
  }

  /** Recent support messages in both directions, newest first, joined to the user. */
  async listRecentMessages(limit: number): Promise<AdminMessage[]> {
    const { data, error } = await this.db
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new DbError('listRecentMessages', error);

    const rows = data ?? [];
    const chatIds = [...new Set(rows.map((r) => r.chat_id))];
    if (chatIds.length === 0) return [];

    const { data: users, error: usersError } = await this.db
      .from('users')
      .select('chat_id, username, first_name')
      .in('chat_id', chatIds);
    if (usersError) throw new DbError('listRecentMessages.users', usersError);

    const byChatId = new Map((users ?? []).map((u) => [u.chat_id, u]));
    return rows.map((row) => {
      const user = byChatId.get(row.chat_id);
      return { ...row, username: user?.username ?? null, first_name: user?.first_name ?? null };
    });
  }

  /** Every product a user is watching, most recently updated first. */
  async listProductsByChatId(chatId: number, limit: number): Promise<ProductRow[]> {
    const { data, error } = await this.db
      .from('products')
      .select('*')
      .eq('chat_id', chatId)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new DbError('listProductsByChatId', error);
    return data ?? [];
  }

  /**
   * Replaces a user's watch list with exactly what was sent: rows in `items` are
   * inserted or refreshed, and any of that user's rows not present any more are
   * deleted. An empty `items` array therefore clears the list.
   *
   * Only this owner's rows are ever touched — every statement is scoped by chat_id.
   */
  async syncProducts(chatId: number, items: ProductInput[]): Promise<SyncProductsResult> {
    const now = new Date().toISOString();

    // Read the stored state BEFORE writing, so the incoming report can be diffed
    // against it. This is what drives the stock and price alerts.
    const { data: existing, error: existingError } = await this.db
      .from('products')
      .select('*')
      .eq('chat_id', chatId);
    if (existingError) throw new DbError('syncProducts.list', existingError);

    const key = (asin: string, domain: string): string => `${asin}\u0000${domain}`;
    const previousByKey = new Map((existing ?? []).map((row) => [key(row.asin, row.domain), row]));

    const changes: ProductChange[] = [];
    for (const item of items) {
      const previous = previousByKey.get(key(item.asin, item.domain));
      // A product seen for the first time has nothing to compare against, so it
      // is stored quietly rather than announced as a change.
      if (previous) changes.push(...diffProduct(previous, item));
    }

    if (items.length > 0) {
      const rows = items.map((item) => ({
        chat_id: chatId,
        asin: item.asin,
        name: item.name,
        domain: item.domain,
        threshold: item.threshold,
        last_status: item.status,
        last_quantity: item.quantity,
        last_price: item.price,
        updated_at: now,
      }));

      const { error } = await this.db.from('products').upsert(rows, { onConflict: 'chat_id,asin,domain' });
      if (error) throw new DbError('syncProducts.upsert', error);
    }

    const keep = new Set(items.map((item) => key(item.asin, item.domain)));
    const staleIds = (existing ?? [])
      .filter((row) => !keep.has(key(row.asin, row.domain)))
      .map((row) => row.id);

    if (staleIds.length > 0) {
      const { error } = await this.db.from('products').delete().eq('chat_id', chatId).in('id', staleIds);
      if (error) throw new DbError('syncProducts.delete', error);
    }

    return { upserted: items.length, removed: staleIds.length, changes };
  }

  // --- support inbox (DÜZƏLİŞ 8+9) ----------------------------------------

  async createSupportMessage(input: {
    chatId: number;
    username: string | null;
    message: string;
  }): Promise<SupportMessageRow> {
    const { data, error } = await this.db
      .from('support_messages')
      .insert({ chat_id: input.chatId, username: input.username, message: input.message, reply: null })
      .select('*')
      .single();
    if (error) throw new DbError('createSupportMessage', error);
    return data;
  }

  async listSupportMessages(limit: number): Promise<SupportMessageRow[]> {
    const { data, error } = await this.db
      .from('support_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new DbError('listSupportMessages', error);
    return data ?? [];
  }

  async findSupportMessage(id: string): Promise<SupportMessageRow | null> {
    const { data, error } = await this.db.from('support_messages').select('*').eq('id', id).maybeSingle();
    if (error) throw new DbError('findSupportMessage', error);
    return data ?? null;
  }

  /**
   * The thread a reply belongs to when the answer arrives without an explicit id
   * (a reply typed in the support group): the user's most recent unanswered message.
   */
  async findLatestOpenSupportMessage(chatId: number): Promise<SupportMessageRow | null> {
    const { data, error } = await this.db
      .from('support_messages')
      .select('*')
      .eq('chat_id', chatId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new DbError('findLatestOpenSupportMessage', error);
    return data?.[0] ?? null;
  }

  async markSupportAnswered(id: string, reply: string): Promise<void> {
    const { error } = await this.db
      .from('support_messages')
      .update({ reply, status: 'answered', replied_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw new DbError('markSupportAnswered', error);
  }

  async stats(): Promise<AdminStats> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();

    const [users, activeUsers, blockedUsers, messagesToday, notificationsToday] = await Promise.all([
      this.db.from('users').select('id', { head: true, count: 'exact' }),
      this.db.from('users').select('id', { head: true, count: 'exact' }).eq('status', 'active'),
      this.db.from('users').select('id', { head: true, count: 'exact' }).eq('status', 'blocked'),
      this.db.from('messages').select('id', { head: true, count: 'exact' }).gte('created_at', since),
      this.db.from('notifications').select('id', { head: true, count: 'exact' }).gte('created_at', since),
    ]);

    const unwrap = (
      result: { count: number | null; error: { message: string; code?: string } | null },
      label: string,
    ): number => {
      if (result.error) throw new DbError(`stats.${label}`, result.error);
      return result.count ?? 0;
    };

    return {
      users: unwrap(users, 'users'),
      activeUsers: unwrap(activeUsers, 'activeUsers'),
      blockedUsers: unwrap(blockedUsers, 'blockedUsers'),
      messagesToday: unwrap(messagesToday, 'messagesToday'),
      notificationsToday: unwrap(notificationsToday, 'notificationsToday'),
    };
  }
}
