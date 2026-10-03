/**
 * Integration test for the daily cleanup job against the database (no game server needed): it trims match history
 * without changing lifetime stats, keeps shared matches, and trims world and DM chat. Like the real job it cleans
 * every account, not only the test ones. Test users, their matches and messages are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createUser, getStats, pool } from '../src/db';
import { DM_CHAT_KEEP, MATCH_HISTORY_KEEP, WORLD_CHAT_KEEP, runCleanup } from '../src/retention';
import { WORLD_CHANNEL, dmChannel } from '../src/shared';

const TAG = randomBytes(3).toString('hex');
const OWN_MATCHES = MATCH_HISTORY_KEEP + 5;
const DM_SENT = DM_CHAT_KEEP + 5;

let a = '';
let b = '';
const matchIds: string[] = [];

async function addMatch(endedHoursAgo: number, players: { id: string; placement: number; kills: number }[]): Promise<string> {
  const id = randomUUID();
  matchIds.push(id);
  await pool.query(
    `INSERT INTO matches (id, mode, map_id, player_count, team_size, winner_name, started_at, ended_at, duration_ms)
     VALUES ($1, 'bots', 'coloa', 10, 1, 'x', now() - make_interval(hours => $2) - interval '5 minutes', now() - make_interval(hours => $2), 300000)`,
    [id, endedHoursAgo],
  );
  for (const p of players) {
    await pool.query(
      `INSERT INTO match_players (match_id, user_id, placement, kills, damage, survival_ms, xp_gained) VALUES ($1, $2, $3, $4, $5, $6, 10)`,
      [id, p.id, p.placement, p.kills, p.kills * 37, 60_000 + p.kills * 1000],
    );
  }
  return id;
}

const historyOf = async (user: string) =>
  (await pool.query<{ match_id: string }>('SELECT match_id FROM match_players WHERE user_id = $1', [user])).rows.map((r) => r.match_id);

function sameStats(actual: Awaited<ReturnType<typeof getStats>>, expected: Awaited<ReturnType<typeof getStats>>) {
  const { avgPlacement, avgSurvivalMs, ...rest } = actual;
  const { avgPlacement: ep, avgSurvivalMs: es, ...expRest } = expected;
  assert.deepEqual(rest, expRest);
  assert.ok(Math.abs((avgPlacement ?? 0) - (ep ?? 0)) < 1e-6, `hạng trung bình đổi: ${avgPlacement} ≠ ${ep}`);
  assert.ok(Math.abs((avgSurvivalMs ?? 0) - (es ?? 0)) < 1e-3, `thời gian sống trung bình đổi: ${avgSurvivalMs} ≠ ${es}`);
}

before(async () => {
  const ra = await createUser(`zr${TAG}a`, 'x', '🐭');
  const rb = await createUser(`zr${TAG}b`, 'x', '🐭');
  assert.ok(ra && rb);
  a = ra.id;
  b = rb.id;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b].filter(Boolean)]);
  await pool.query('DELETE FROM matches WHERE id = ANY($1::uuid[])', [matchIds]);
  const left = await pool.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
          + (SELECT count(*) FROM matches WHERE id = ANY($2::uuid[]))
          + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[]))
          + (SELECT count(*) FROM user_stats_archive WHERE user_id = ANY($1::uuid[])) AS n`,
    [[a, b], matchIds],
  );
  assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  await pool.end();
});

describe('job dọn dữ liệu mỗi ngày', () => {
  test(`giữ ${MATCH_HISTORY_KEEP} trận gần nhất mỗi người, thống kê trọn đời không đổi, trận còn người giữ thì không xoá`, async () => {
    // the oldest match is shared with b, for whom it is still recent history
    const shared = await addMatch(OWN_MATCHES, [{ id: a, placement: 1, kills: 9 }, { id: b, placement: 2, kills: 1 }]);
    const own: string[] = [];
    for (let i = OWN_MATCHES - 1; i >= 1; i--) own.push(await addMatch(i, [{ id: a, placement: (i % 4) + 1, kills: i % 7 }]));
    const newest = own.slice(-MATCH_HISTORY_KEEP);
    const statsBefore = await getStats(a);
    assert.equal(statsBefore.matches, OWN_MATCHES);

    assert.ok(await runCleanup(true));
    assert.deepEqual((await historyOf(a)).sort(), [...newest].sort(), 'không giữ đúng các trận gần nhất');
    sameStats(await getStats(a), statsBefore);
    assert.deepEqual(await historyOf(b), [shared], 'xoá mất lịch sử của người khác');
    const gone = own.slice(0, own.length - MATCH_HISTORY_KEEP);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM matches WHERE id = ANY($1::uuid[])', [[shared, ...gone]]);
    assert.deepEqual(rows.map((r) => r.id), [shared], 'trận không còn ai giữ chưa bị xoá, hoặc trận dùng chung bị xoá');

    // a second run archives nothing twice
    assert.ok(await runCleanup(true));
    sameStats(await getStats(a), statsBefore);
  });

  test(`tin nhắn riêng giữ ${DM_CHAT_KEEP} tin gần nhất mỗi cuộc trò chuyện, thế giới giữ ${WORLD_CHAT_KEEP} tin`, async () => {
    const channel = dmChannel(a, b);
    const { rows: sent } = await pool.query<{ id: string }>(
      `INSERT INTO chat_messages (channel, sender_id, body)
       SELECT $1, CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END, 'tin ' || i FROM generate_series(1, $4::int) AS i
       RETURNING id::text`,
      [channel, a, b, DM_SENT],
    );
    const { rows: world } = await pool.query<{ id: string }>(
      `INSERT INTO chat_messages (channel, sender_id, body) SELECT $1, $2, 'thế giới ' || i FROM generate_series(1, 3) AS i RETURNING id::text`,
      [WORLD_CHANNEL, a],
    );

    assert.ok(await runCleanup(true));
    const { rows: kept } = await pool.query<{ id: string }>('SELECT id::text FROM chat_messages WHERE channel = $1 ORDER BY id', [channel]);
    assert.deepEqual(kept.map((r) => r.id), sent.map((r) => r.id).sort((x, y) => Number(x) - Number(y)).slice(-DM_CHAT_KEEP));
    const { rows: w } = await pool.query<{ n: number; newest: boolean }>(
      'SELECT count(*)::int AS n, bool_or(id = $2::bigint) AS newest FROM chat_messages WHERE channel = $1',
      [WORLD_CHANNEL, world[world.length - 1].id],
    );
    assert.ok(w[0].n <= WORLD_CHAT_KEEP, `chat thế giới còn ${w[0].n} tin`);
    assert.equal(w[0].newest, true, 'xoá mất tin thế giới mới nhất');
  });

  test('lịch chạy: vừa chạy xong thì chưa tới hạn, chưa đủ 24 giờ không chạy lại', async () => {
    assert.equal(await runCleanup(), null);
  });
});
