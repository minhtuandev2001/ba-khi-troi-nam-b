import { pool } from './db';
import { MATCH_HISTORY_KEEP, WORLD_CHANNEL } from './shared';

export { MATCH_HISTORY_KEEP };
export const WORLD_CHAT_KEEP = 100;
/** Per private conversation. */
export const DM_CHAT_KEEP = 150;

const JOB = 'cleanup';
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
/** How often the server checks whether a day has passed since the last run (stored in the database). */
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
/** Shared by every server on the database, so only one of them cleans at a time. */
const CLEANUP_LOCK = 72_011_903;

export interface CleanupResult {
  historyRows: number;
  matches: number;
  worldMessages: number;
  dmMessages: number;
}

/**
 * Trims match history and chat: keeps each player's newest matches (their totals are archived so lifetime
 * stats stay right), the newest world messages and the newest messages of every DM and support conversation.
 * Returns null when it was not due yet (unless `force`) or another server is already running it.
 */
export async function runCleanup(force = false): Promise<CleanupResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [CLEANUP_LOCK]);
    if (!lock[0].ok) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!force) {
      const { rows } = await client.query<{ due: boolean }>(
        `SELECT coalesce((SELECT last_run_at FROM job_runs WHERE name = $1) <= now() - make_interval(secs => $2), true) AS due`,
        [JOB, RUN_EVERY_MS / 1000],
      );
      if (!rows[0].due) {
        await client.query('ROLLBACK');
        return null;
      }
    }

    const history = await client.query<{ rows: number }>(
      `WITH ranked AS (
         SELECT mp.match_id, mp.user_id,
                row_number() OVER (PARTITION BY mp.user_id ORDER BY m.ended_at DESC, m.id DESC) AS rn
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
       ), old AS (
         DELETE FROM match_players mp USING ranked r
          WHERE mp.match_id = r.match_id AND mp.user_id = r.user_id AND r.rn > $1
         RETURNING mp.*
       ), archived AS (
         INSERT INTO user_stats_archive AS a (user_id, matches, wins, kills, best_damage, best_kills, placement_sum, survival_sum)
         SELECT user_id, count(*), count(*) FILTER (WHERE placement = 1), sum(kills), max(damage), max(kills), sum(placement), sum(survival_ms)
           FROM old GROUP BY user_id
         ON CONFLICT (user_id) DO UPDATE SET
           matches = a.matches + EXCLUDED.matches,
           wins = a.wins + EXCLUDED.wins,
           kills = a.kills + EXCLUDED.kills,
           best_damage = GREATEST(a.best_damage, EXCLUDED.best_damage),
           best_kills = GREATEST(a.best_kills, EXCLUDED.best_kills),
           placement_sum = a.placement_sum + EXCLUDED.placement_sum,
           survival_sum = a.survival_sum + EXCLUDED.survival_sum
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM old)::int AS rows, (SELECT count(*) FROM archived)::int AS users`,
      [MATCH_HISTORY_KEEP],
    );
    // a match goes once nobody keeps it in their history
    const matches = await client.query(
      'DELETE FROM matches m WHERE NOT EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = m.id)',
    );
    const world = await client.query(
      `DELETE FROM chat_messages
        WHERE channel = $1
          AND id < (SELECT id FROM chat_messages WHERE channel = $1 ORDER BY id DESC OFFSET $2::int - 1 LIMIT 1)`,
      [WORLD_CHANNEL, WORLD_CHAT_KEEP],
    );
    const dm = await client.query(
      `DELETE FROM chat_messages c
        USING (SELECT id, row_number() OVER (PARTITION BY channel ORDER BY id DESC) AS rn
                 FROM chat_messages WHERE channel LIKE 'dm:%' OR channel LIKE 'support:%') r
        WHERE c.id = r.id AND r.rn > $1`,
      [DM_CHAT_KEEP],
    );
    await client.query(
      `INSERT INTO job_runs (name, last_run_at) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
      [JOB],
    );
    await client.query('COMMIT');
    return {
      historyRows: history.rows[0].rows,
      matches: matches.rowCount ?? 0,
      worldMessages: world.rowCount ?? 0,
      dmMessages: dm.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function describeCleanup(r: CleanupResult): string {
  return `xoá ${r.historyRows} dòng lịch sử (${r.matches} trận), ${r.worldMessages} tin thế giới, ${r.dmMessages} tin nhắn riêng`;
}

/** Checks hourly and cleans once a day; the last run is kept in the database, so restarts do not reset the clock. */
export function startCleanupJob(): void {
  const check = () =>
    runCleanup()
      .then((r) => r && console.log(`[cleanup] đã dọn dữ liệu: ${describeCleanup(r)}`))
      .catch((err) => console.error('[cleanup] không dọn được dữ liệu', err));
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
}
