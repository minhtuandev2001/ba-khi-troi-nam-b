import type { PoolClient } from 'pg';

/**
 * Tables for the daily cleanup job: lifetime totals of the match history it deletes (so profile stats stay whole),
 * and when each scheduled job last ran (so restarts do not make it run again early).
 */
export async function up(db: PoolClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_stats_archive (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      matches integer NOT NULL DEFAULT 0,
      wins integer NOT NULL DEFAULT 0,
      kills bigint NOT NULL DEFAULT 0,
      best_damage integer NOT NULL DEFAULT 0,
      best_kills integer NOT NULL DEFAULT 0,
      placement_sum bigint NOT NULL DEFAULT 0,
      survival_sum bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      name text PRIMARY KEY,
      last_run_at timestamptz NOT NULL
    );
  `);
}
