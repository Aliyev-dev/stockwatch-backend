export type UserStatus = 'active' | 'blocked';
export type MessageDirection = 'in' | 'out';

export type UserRow = {
  id: string;
  chat_id: number;
  username: string | null;
  first_name: string | null;
  link_code: string;
  status: string;
  joined_at: string;
  last_seen: string | null;
};

export type MessageRow = {
  id: string;
  chat_id: number;
  direction: MessageDirection;
  text: string | null;
  created_at: string;
};

export type NotificationRow = {
  id: string;
  chat_id: number;
  text: string | null;
  created_at: string;
};

/** Row shape of the admin_user_overview view created by schema.sql. */
export type UserOverviewRow = UserRow & {
  message_count: number;
  notification_count: number;
};

/** Minimal typed schema covering exactly the tables and view this service touches. */
export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: Omit<UserRow, 'id' | 'joined_at' | 'status'> & {
          id?: string;
          joined_at?: string;
          status?: string;
        };
        Update: Partial<Omit<UserRow, 'id'>>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: Omit<MessageRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<MessageRow, 'id'>>;
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: Omit<NotificationRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<NotificationRow, 'id'>>;
        Relationships: [];
      };
    };
    Views: {
      admin_user_overview: {
        Row: UserOverviewRow;
        Relationships: [];
      };
    };
    // Deliberately empty object types: an index signature here would make
    // postgrest-js treat every selected column as a computed function field.
    // eslint-disable-next-line @typescript-eslint/ban-types
    Functions: {};
    // eslint-disable-next-line @typescript-eslint/ban-types
    Enums: {};
    // eslint-disable-next-line @typescript-eslint/ban-types
    CompositeTypes: {};
  };
};
