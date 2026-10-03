import pg from 'pg';
import {
  isMapId,
  levelFromXp,
  type GameMode,
  type MapId,
  type MatchHistoryEntry,
  type PublicUser,
  type UserRole,
  type UserStats,
} from './shared';
import { ADMIN_USERNAME, ensureAdminAccount, type AdminOutcome } from './adminAccount';
import { config } from './config';
import { MIGRATIONS } from './migrations';

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
  avatar text NOT NULL DEFAULT '🐭',
  xp integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
ALTER TABLE users ALTER COLUMN avatar SET DEFAULT '🐭';
-- avatars from before the zodiac set map to the closest zodiac animal
UPDATE users SET avatar = CASE avatar
  WHEN '🐺' THEN '🐶' WHEN '🦊' THEN '🐱' WHEN '🦁' THEN '🐯' WHEN '🐻' THEN '🐃'
  WHEN '🐼' THEN '🐷' WHEN '🐸' THEN '🐭' WHEN '🦅' THEN '🐔' WHEN '🤖' THEN '🐵'
  WHEN '👽' THEN '🐍' WHEN '💀' THEN '🐐' END
  WHERE avatar IN ('🐺', '🦊', '🦁', '🐻', '🐼', '🐸', '🦅', '🤖', '👽', '💀');

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('pvp', 'bots', 'private')),
  player_count integer NOT NULL,
  winner_name text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_ms integer NOT NULL
);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS map_id text;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS team_size integer NOT NULL DEFAULT 1;

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

CREATE TABLE IF NOT EXISTS friendships (
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_idx ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON friendships (addressee_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages (channel, id DESC);
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx ON chat_messages (sender_id);

CREATE TABLE IF NOT EXISTS chat_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  last_read_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Any constant works; it only has to be the same for every server sharing the database. */
const MIGRATION_LOCK = 72_011_902;

/** Built on call: `adminAccount` imports this module back (through `auth`), so its exports are not ready at load. */
function adminLog(outcome: AdminOutcome): string {
  if (outcome === 'created') return `[db] đã tạo tài khoản ${ADMIN_USERNAME}`;
  if (outcome === 'updated') return `[db] đã đổi mật khẩu tài khoản ${ADMIN_USERNAME} theo ADMIN_PASSWORD, các phiên đăng nhập cũ của admin đã bị thu hồi`;
  return '';
}

/**
 * Creates the base schema, applies the numbered migrations not run yet, then creates the admin account or
 * brings its password in line with `ADMIN_PASSWORD`. Returns the ids of the migrations applied.
 */
export async function migrate(): Promise<string[]> {
  await withRetry(() => rawPool.query(SCHEMA), 8);
  const { applied, admin } = await withRetry(runMigrations);
  if (applied.length) console.log(`[db] đã chạy migration: ${applied.join(', ')}`);
  const log = adminLog(admin);
  if (log) console.log(log);
  return applied;
}

async function runMigrations(): Promise<{ applied: string[]; admin: AdminOutcome }> {
  const client = await rawPool.connect();
  try {
    await client.query('BEGIN');
    // servers booting together wait here; the later ones then find nothing left to apply
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await m.up(client);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      applied.push(m.id);
    }
    const admin = await ensureAdminAccount(client);
    await client.query('COMMIT');
    return { applied, admin };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  avatar: string;
  xp: number;
  role: UserRole;
  created_at: Date;
  token_version: number;
  chat_muted_until: Date | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar,
    xp: row.xp,
    level: levelFromXp(row.xp),
    role: row.role,
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

export async function updatePasswordHash(id: string, passwordHash: string): Promise<void> {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
}

export async function updateAvatar(id: string, avatar: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('UPDATE users SET avatar = $2 WHERE id = $1 RETURNING *', [id, avatar]);
  return rows[0] ?? null;
}

/** Lifetime stats: the history still kept plus the totals the cleanup job archived when it deleted older matches. */
export async function getStats(userId: string): Promise<UserStats> {
  const { rows } = await pool.query(
    `WITH live AS (
       SELECT count(*) AS matches,
              count(*) FILTER (WHERE placement = 1) AS wins,
              coalesce(sum(kills), 0) AS kills,
              coalesce(max(damage), 0) AS best_damage,
              coalesce(max(kills), 0) AS best_kills,
              coalesce(sum(placement), 0) AS placement_sum,
              coalesce(sum(survival_ms), 0) AS survival_sum
         FROM match_players WHERE user_id = $1
     )
     SELECT (l.matches + coalesce(a.matches, 0))::int AS matches,
            (l.wins + coalesce(a.wins, 0))::int AS wins,
            (l.kills + coalesce(a.kills, 0))::int AS kills,
            GREATEST(l.best_damage, coalesce(a.best_damage, 0))::int AS best_damage,
            GREATEST(l.best_kills, coalesce(a.best_kills, 0))::int AS best_kills,
            (l.placement_sum + coalesce(a.placement_sum, 0))::float AS placement_sum,
            (l.survival_sum + coalesce(a.survival_sum, 0))::float AS survival_sum
       FROM live l LEFT JOIN user_stats_archive a ON a.user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    matches: r.matches,
    wins: r.wins,
    kills: r.kills,
    bestDamage: r.best_damage,
    avgPlacement: r.matches ? r.placement_sum / r.matches : null,
    avgSurvivalMs: r.matches ? r.survival_sum / r.matches : null,
    bestKills: r.best_kills,
  };
}

export async function getHistory(userId: string, limit: number, offset: number): Promise<{ items: MatchHistoryEntry[]; total: number }> {
  const [list, count] = await Promise.all([
    pool.query(
      `SELECT m.id, m.mode, m.map_id, m.player_count, m.team_size, m.ended_at, mp.placement, mp.kills, mp.damage, mp.survival_ms, mp.xp_gained
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
      mapId: isMapId(r.map_id) ? r.map_id : null,
      placement: r.placement,
      playerCount: r.player_count,
      teamSize: r.team_size,
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
  mapId: MapId;
  playerCount: number;
  teamSize: number;
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
      `INSERT INTO matches (id, mode, map_id, player_count, team_size, winner_name, started_at, ended_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.id, m.mode, m.mapId, m.playerCount, m.teamSize, m.winnerName, m.startedAt, m.endedAt, m.endedAt.getTime() - m.startedAt.getTime()],
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
