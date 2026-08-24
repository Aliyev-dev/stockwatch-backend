import { randomInt } from 'node:crypto';
import { DbError, type Db } from './client';
import type { MessageDirection, MessageRow, NotificationRow, UserRow, UserStatus } from './types';

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
  joined_at: string;
  last_seen: string | null;
  message_count: number;
  notification_count: number;
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

    const [messages, notifications] = await Promise.all([
      this.db.from('messages').select('chat_id').in('chat_id', chatIds),
      this.db.from('notifications').select('chat_id').in('chat_id', chatIds),
    ]);
    if (messages.error) throw new DbError('listUsers.messages', messages.error);
    if (notifications.error) throw new DbError('listUsers.notifications', notifications.error);

    const tally = (rows: { chat_id: number }[]): Map<number, number> => {
      const counts = new Map<number, number>();
      for (const row of rows) counts.set(row.chat_id, (counts.get(row.chat_id) ?? 0) + 1);
      return counts;
    };
    const messageCounts = tally(messages.data ?? []);
    const notificationCounts = tally(notifications.data ?? []);

    return (users ?? []).map((u) => ({
      id: u.id,
      chat_id: u.chat_id,
      username: u.username,
      first_name: u.first_name,
      status: u.status,
      joined_at: u.joined_at,
      last_seen: u.last_seen,
      message_count: messageCounts.get(u.chat_id) ?? 0,
      notification_count: notificationCounts.get(u.chat_id) ?? 0,
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
