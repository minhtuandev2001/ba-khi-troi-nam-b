import pg from 'pg';
import {
  levelFromXp,
  type GameMode,
  type MatchHistoryEntry,
  type PublicUser,
  type UserStats,
} from './shared';
import { config } from './config';

const rawPool = new pg.Pool({
  connectionString: config.databaseUrl.replace('sslmode=require', 'sslmode=verify-full'),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

rawPool.on('error', (err) => console.error('[db] lỗi kết nối nền:', err.message));

const TRANSIENT = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '57P01']);

function isTransient(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return TRANSIENT.has(e.code ?? '') || /Connection terminated|timeout/i.test(e.message ?? '');
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, 300 * i));
    }
  }
}

export const pool = {
  query: <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) =>
    withRetry(() => rawPool.query<R>(text, params)),
  connect: () => withRetry(() => rawPool.connect()),
  end: () => rawPool.end(),
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(16) NOT NULL,
  password_hash text NOT NULL,
  avatar text NOT NULL DEFAULT '🐺',
  xp integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('pvp', 'bots', 'private')),
  player_count integer NOT NULL,
  winner_name text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_ms integer NOT NULL
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placement integer NOT NULL,
  kills integer NOT NULL DEFAULT 0,
  damage integer NOT NULL DEFAULT 0,
  survival_ms integer NOT NULL DEFAULT 0,
  xp_gained integer NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id);
`;

export async function migrate(): Promise<void> {
  await withRetry(() => rawPool.query(SCHEMA), 8);
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  avatar: string;
  xp: number;
  created_at: Date;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar,
    xp: row.xp,
    level: levelFromXp(row.xp),
    createdAt: row.created_at.toISOString(),
  };
}

export async function findUserByName(username: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Returns null when the username is already taken. */
export async function createUser(username: string, passwordHash: string, avatar: string): Promise<UserRow | null> {
  try {
    const { rows } = await pool.query<UserRow>(
      'INSERT INTO users (username, password_hash, avatar, last_login_at) VALUES ($1, $2, $3, now()) RETURNING *',
      [username, passwordHash, avatar],
    );
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function touchLogin(id: string): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function updateAvatar(id: string, avatar: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('UPDATE users SET avatar = $2 WHERE id = $1 RETURNING *', [id, avatar]);
  return rows[0] ?? null;
}

export async function getStats(userId: string): Promise<UserStats> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS matches,
            count(*) FILTER (WHERE placement = 1)::int AS wins,
            coalesce(sum(kills), 0)::int AS kills,
            coalesce(sum(damage), 0)::int AS damage,
            avg(placement)::float AS avg_placement,
            coalesce(sum(survival_ms), 0)::bigint AS total_survival,
            avg(survival_ms)::float AS avg_survival,
            coalesce(max(kills), 0)::int AS best_kills
       FROM match_players WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    matches: r.matches,
    wins: r.wins,
    kills: r.kills,
    damage: r.damage,
    avgPlacement: r.avg_placement,
    totalSurvivalMs: Number(r.total_survival),
    avgSurvivalMs: r.avg_survival,
    bestKills: r.best_kills,
  };
}

export async function getHistory(userId: string, limit: number, offset: number): Promise<{ items: MatchHistoryEntry[]; total: number }> {
  const [list, count] = await Promise.all([
    pool.query(
      `SELECT m.id, m.mode, m.player_count, m.ended_at, mp.placement, mp.kills, mp.damage, mp.survival_ms, mp.xp_gained
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1
        ORDER BY m.ended_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
    pool.query('SELECT count(*)::int AS n FROM match_players WHERE user_id = $1', [userId]),
  ]);
  return {
    total: count.rows[0].n,
    items: list.rows.map((r) => ({
      matchId: r.id,
      mode: r.mode as GameMode,
      placement: r.placement,
      playerCount: r.player_count,
      kills: r.kills,
      damage: r.damage,
      survivalMs: r.survival_ms,
      xpGained: r.xp_gained,
      endedAt: (r.ended_at as Date).toISOString(),
    })),
  };
}

export interface MatchRecord {
  id: string;
  mode: GameMode;
  playerCount: number;
  winnerName: string;
  startedAt: Date;
  endedAt: Date;
  players: { userId: string; placement: number; kills: number; damage: number; survivalMs: number; xpGained: number }[];
}

export function saveMatch(m: MatchRecord): Promise<void> {
  return withRetry(() => saveMatchOnce(m));
}

async function saveMatchOnce(m: MatchRecord): Promise<void> {
  const client = await rawPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO matches (id, mode, player_count, winner_name, started_at, ended_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [m.id, m.mode, m.playerCount, m.winnerName, m.startedAt, m.endedAt, m.endedAt.getTime() - m.startedAt.getTime()],
    );
    for (const p of m.players) {
      await client.query(
        `INSERT INTO match_players (match_id, user_id, placement, kills, damage, survival_ms, xp_gained)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.id, p.userId, p.placement, p.kills, Math.round(p.damage), Math.round(p.survivalMs), p.xpGained],
      );
      await client.query('UPDATE users SET xp = xp + $2 WHERE id = $1', [p.userId, p.xpGained]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
