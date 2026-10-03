import type { PoolClient } from 'pg';

/** Adds user roles; the admin account itself is created or updated on every migrate by `ensureAdminAccount`. */
export async function up(db: PoolClient): Promise<void> {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'`);
  await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await db.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'))`);
}
