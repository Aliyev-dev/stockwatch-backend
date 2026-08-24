import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config';
import type { Database } from './types';

export type Db = SupabaseClient<Database>;

/**
 * Service-role Supabase client. The key never leaves this process: no route ever
 * returns it, and the client is only constructed here.
 */
export function createDb(config: Config): Db {
  return createClient<Database>(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'stockwatch-backend' } },
  });
}

/** Raised when Supabase returns an error; carries a message safe to log. */
export class DbError extends Error {
  constructor(operation: string, cause: { message: string; code?: string } | null) {
    super(`db ${operation} failed: ${cause?.message ?? 'unknown error'}${cause?.code ? ` (${cause.code})` : ''}`);
    this.name = 'DbError';
  }
}
