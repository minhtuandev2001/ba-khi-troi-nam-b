import type { PoolClient } from 'pg';

/**
 * `token_version` is signed into every login token; raising it ends all sessions of that account (the admin's
 * whenever its password changes). `chat_muted_until` is set by admins to stop someone posting in world chat and DMs.
 */
export async function up(db: PoolClient): Promise<void> {
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_muted_until timestamptz;
  `);
}
