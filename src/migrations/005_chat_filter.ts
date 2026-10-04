import type { PoolClient } from 'pg';

/** What the sender typed when the profanity filter masked part of a message; admins read it when handling reports. */
export async function up(db: PoolClient): Promise<void> {
  await db.query('ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS raw_body text');
}
