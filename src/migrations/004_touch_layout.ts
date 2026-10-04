import type { PoolClient } from 'pg';

/** Where each player put and how big they made their on-screen buttons, per screen shape (`shared/touchLayout.ts`). */
export async function up(db: PoolClient): Promise<void> {
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS touch_layout jsonb');
}
