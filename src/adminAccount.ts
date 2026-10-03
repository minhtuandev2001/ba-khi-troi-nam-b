import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashPassword, verifyPassword } from './auth';
import { config } from './config';

/** Reserved by `validateUsername`, so nobody can sign up as it. */
export const ADMIN_USERNAME = 'admin';

export type AdminOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Runs on every migrate (so on every server start). Creates the admin account if it is missing; otherwise sets
 * its password to `ADMIN_PASSWORD` only when it differs from the stored one, and then raises `token_version` so
 * every session signed in with the old password ends. Name, avatar, XP and history are left alone.
 * Without `ADMIN_PASSWORD` (allowed in development only) an existing admin keeps its password, and a new one
 * gets a random password printed once to the server log.
 */
export async function ensureAdminAccount(db: PoolClient, password = config.adminPassword): Promise<AdminOutcome> {
  const { rows } = await db.query<{ id: string; password_hash: string; role: string }>(
    'SELECT id, password_hash, role FROM users WHERE lower(username) = $1 FOR UPDATE',
    [ADMIN_USERNAME],
  );
  const row = rows[0];
  if (!row) {
    const initial = password ?? randomBytes(12).toString('base64url');
    await db.query(
      `INSERT INTO users (username, password_hash, avatar, role) VALUES ($1, $2, '🐲', 'admin')`,
      [ADMIN_USERNAME, await hashPassword(initial)],
    );
    if (!password) console.warn(`[db] mật khẩu tạm của tài khoản ${ADMIN_USERNAME}: ${initial} (đặt ADMIN_PASSWORD trong backend/.env để cố định)`);
    return 'created';
  }
  if (row.role !== 'admin') await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [row.id]);
  if (!password || (await verifyPassword(password, row.password_hash)).ok) return 'unchanged';
  await db.query('UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [row.id, await hashPassword(password)]);
  return 'updated';
}
