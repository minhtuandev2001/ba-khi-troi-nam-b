/**
 * Integration test for the admin's live match tools against a running backend (`npm run dev`):
 * the admin-only match list, watching a match without playing, and kicking the watched player.
 * Test users (one of them promoted to admin) and their matches are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import type { GameEvent, LiveMatchSummary, MatchStartMsg, RoomStateMsg, SnapshotMsg } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Client {
  id: string;
  name: string;
  socket: Socket;
}

const users: Record<'admin' | 'player' | 'stranger', Client> = {} as never;
const createdIds: string[] = [];
const matchIds: string[] = [];

function next<T>(c: Client, event: string, accept: (v: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.socket.off(event, handler);
      reject(new Error(`${c.name} không nhận được ${event}`));
    }, ms);
    const handler = (v: T) => {
      if (!accept(v)) return;
      clearTimeout(timer);
      c.socket.off(event, handler);
      resolve(v);
    };
    c.socket.on(event, handler);
  });
}

/** Resolves true if no matching `event` arrives within `ms`. */
function silence<T>(c: Client, event: string, accept: (v: T) => boolean = () => true, ms = 900): Promise<boolean> {
  return next(c, event, accept, ms).then(() => false, () => true);
}

async function connect(name: string, admin = false): Promise<Client> {
  const row = await createUser(name, 'x', '🐭');
  assert.ok(row, `không tạo được ${name}`);
  createdIds.push(row.id);
  if (admin) await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [row.id]);
  const socket = io(SERVER, { auth: { token: signToken(row.id) }, parser: msgpackParser, transports: ['websocket'], reconnection: false });
  const c = { id: row.id, name, socket };
  await next(c, 'lobby:ready', () => true, 8000);
  return c;
}

const kickEvent = (s: SnapshotMsg, pid: number) =>
  s.e?.some((e: GameEvent) => e.k === 'kill' && e.w === 'kick' && e.victim === pid) ?? false;

before(async () => {
  users.admin = await connect(`zo${TAG}adm`, true);
  users.player = await connect(`zo${TAG}p`);
  users.stranger = await connect(`zo${TAG}s`);
});

after(async () => {
  for (const c of Object.values(users)) c?.socket.disconnect();
  if (matchIds.length) await pool.query('DELETE FROM matches WHERE id = ANY($1::uuid[])', [matchIds]);
  if (createdIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>('SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('quản trị viên xem trận đang đấu', () => {
  let match: MatchStartMsg;
  let playerPid = -1;

  test('người chơi vào trận đấu bot', async () => {
    const started = next<MatchStartMsg>(users.player, 'match:start');
    users.player.socket.emit('bot:start', { map: 'random', difficulty: 'easy' });
    match = await started;
    matchIds.push(match.matchId);
    playerPid = match.you;
    assert.equal(match.observer, undefined);
  });

  test('người thường không nhận được danh sách trận đang đấu và không vào xem được', async () => {
    const { stranger } = users;
    const quiet = silence(stranger, 'matches:list');
    stranger.socket.emit('matches:watch');
    assert.ok(await quiet, 'người thường vẫn nhận được danh sách trận');
    const denied = next<{ text: string }>(stranger, 'error:msg');
    const noStart = silence(stranger, 'match:start');
    stranger.socket.emit('observe:start', match.matchId);
    assert.match((await denied).text, /quản trị/);
    assert.ok(await noStart, 'người thường vào xem được trận');
  });

  test('admin thấy trận trong danh sách kèm chế độ, số người và số còn sống', async () => {
    const list = next<LiveMatchSummary[]>(users.admin, 'matches:list', (l) => l.some((m) => m.id === match.matchId));
    users.admin.socket.emit('matches:watch');
    const row = (await list).find((m) => m.id === match.matchId)!;
    assert.equal(row.mode, 'bots');
    assert.equal(row.mapId, match.mapId);
    assert.equal(row.humans, 1);
    assert.equal(row.players, match.roster.length);
    assert.ok(row.alive > 0 && row.alive <= row.players);
    assert.equal(row.observers, 0);
  });

  test('admin vào xem: chỉ quan sát, góc nhìn theo người chơi thật, không điều khiển được ai', async () => {
    const { admin } = users;
    const started = next<MatchStartMsg>(admin, 'match:start');
    const firstSnap = next<SnapshotMsg>(admin, 'snap');
    admin.socket.emit('observe:start', match.matchId);
    const msg = await started;
    assert.equal(msg.observer, true);
    assert.equal(msg.you, -1);
    assert.equal(msg.matchId, match.matchId);
    assert.ok(!msg.roster.some((r) => r.name === admin.name), 'admin không được xuất hiện trong trận');
    const snap = await firstSnap;
    assert.equal(snap.spectating, true);
    assert.equal(snap.me.pid, playerPid, 'admin phải xem người chơi thật trước');

    // input and actions from the observer never reach the simulation
    const before = snap.me;
    admin.socket.emit('input', { s: 1, mx: 1, my: 1, a: 0, f: true, td: 0 });
    admin.socket.emit('action', { t: 'heal' });
    await new Promise((r) => setTimeout(r, 400));
    const later = await next<SnapshotMsg>(admin, 'snap', (s) => s.me.pid === playerPid);
    assert.equal(later.me.kills, before.kills);

    const counted = next<LiveMatchSummary[]>(admin, 'matches:list', (l) => l.find((m) => m.id === match.matchId)?.observers === 1);
    await counted;
  });

  test('đang xem thì không vào hàng chờ hay tạo phòng được', async () => {
    const busy = next<{ text: string }>(users.admin, 'error:msg');
    users.admin.socket.emit('queue:join');
    assert.match((await busy).text, /đang xem/);
  });

  test('chuyển người xem sang người khác rồi quay lại', async () => {
    const { admin } = users;
    const moved = next<SnapshotMsg>(admin, 'snap', (s) => s.me.pid !== playerPid);
    admin.socket.emit('observe:step', 1);
    const other = await moved;
    assert.ok(other.me.alive);
    const back = next<SnapshotMsg>(admin, 'snap', (s) => s.me.pid === playerPid, 6000);
    admin.socket.emit('observe:step', -1);
    await back;
  });

  test('chỉ kích được đúng người đang xem; người thường không kích được ai', async () => {
    const { admin, stranger, player } = users;
    const wrong = next<{ text: string }>(admin, 'error:msg');
    admin.socket.emit('observe:kick', playerPid + 1);
    assert.match((await wrong).text, /Không kích được/);
    const notKicked = silence(player, 'match:kicked');
    stranger.socket.emit('observe:kick', playerPid);
    assert.ok(await notKicked, 'người thường kích được người chơi');
  });

  test('kích người chơi duy nhất của trận bot: người đó về sảnh, trận kết thúc và admin được báo', async () => {
    const { admin, player } = users;
    const kicked = next(player, 'match:kicked');
    const ended = next<{ winnerName: string }>(admin, 'observe:ended', () => true, 8000);
    admin.socket.emit('observe:kick', playerPid);
    await kicked;
    assert.ok((await ended).winnerName);

    const gone = next<LiveMatchSummary[]>(admin, 'matches:list', (l) => !l.some((m) => m.id === match.matchId));
    await gone;

    // the kicked player is free again: a new practice session starts right away
    const training = next<MatchStartMsg>(player, 'match:start');
    player.socket.emit('training:start');
    const t = await training;
    matchIds.push(t.matchId);
    assert.equal(t.mode, 'training');
    const left = next(player, 'match:left');
    player.socket.emit('match:leave');
    await left;
  });

  test('phòng bạn bè: danh sách có tên phòng; kích một người thì người còn lại và admin đều thấy thông báo', async () => {
    const { admin, player, stranger } = users;
    const created = next<RoomStateMsg>(player, 'room:state');
    player.socket.emit('room:create', { teamSize: 1, name: 'Trận thử kích', listed: false });
    const room = await created;
    const joined = next<RoomStateMsg>(stranger, 'room:state', (s) => s.id === room.id);
    stranger.socket.emit('room:join', room.id);
    await joined;
    // bots keep the match going after the kick
    const filled = next<RoomStateMsg>(player, 'room:state', (s) => s.members.filter((x) => x.isBot).length === 2);
    player.socket.emit('room:addBot');
    player.socket.emit('room:addBot');
    await filled;
    const starts = [next<MatchStartMsg>(player, 'match:start'), next<MatchStartMsg>(stranger, 'match:start')];
    player.socket.emit('room:start');
    const [m] = await Promise.all(starts);
    matchIds.push(m.matchId);

    const list = await next<LiveMatchSummary[]>(admin, 'matches:list', (l) => l.some((x) => x.id === m.matchId), 5000);
    const row = list.find((x) => x.id === m.matchId)!;
    assert.equal(row.name, 'Trận thử kích');
    assert.equal(row.mode, 'private');
    assert.equal(row.lobby, true);
    assert.equal(row.humans, 2);

    const first = next<SnapshotMsg>(admin, 'snap');
    admin.socket.emit('observe:start', m.matchId);
    const victimPid = (await first).me.pid;
    const victimName = m.roster.find((r) => r.pid === victimPid)!.name;
    const [victim, witness] = victimName === player.name ? [player, stranger] : [stranger, player];
    assert.equal(victimName, victim.name, 'admin phải xem một người chơi thật');

    const kicked = next(victim, 'match:kicked');
    const seenByWitness = next<SnapshotMsg>(witness, 'snap', (s) => kickEvent(s, victimPid));
    const seenByAdmin = next<SnapshotMsg>(admin, 'snap', (s) => kickEvent(s, victimPid));
    const victimQuiet = silence(victim, 'snap', () => true, 700);
    admin.socket.emit('observe:kick', victimPid);
    await kicked;
    await Promise.all([seenByWitness, seenByAdmin]);
    assert.ok(await victimQuiet, 'người bị kích vẫn nhận snapshot của trận');
    const after = await next<LiveMatchSummary[]>(admin, 'matches:list', (l) => l.find((x) => x.id === m.matchId)?.humans === 1, 5000);
    assert.ok(after);

    const ended = next(admin, 'observe:ended', () => true, 8000);
    const left = next(witness, 'match:left');
    witness.socket.emit('match:leave');
    await left;
    await ended;
  });

  test('trận tập bắn không hiện trong danh sách và admin không vào xem được', async () => {
    const { admin, player } = users;
    const started = next<MatchStartMsg>(player, 'match:start');
    player.socket.emit('training:start');
    const t = await started;
    matchIds.push(t.matchId);
    const list = await next<LiveMatchSummary[]>(admin, 'matches:list', () => true, 5000);
    assert.equal(list.find((m) => m.id === t.matchId), undefined);
    const denied = next<{ text: string }>(admin, 'error:msg');
    admin.socket.emit('observe:start', t.matchId);
    assert.match((await denied).text, /kết thúc/);
    const left = next(player, 'match:left');
    player.socket.emit('match:leave');
    await left;
  });

  test('rời xem thì quay về, hết trận để xem', async () => {
    const { admin, player } = users;
    const started = next<MatchStartMsg>(player, 'match:start');
    player.socket.emit('bot:start', { map: 'random', difficulty: 'easy' });
    const m = await started;
    matchIds.push(m.matchId);
    const watching = next<MatchStartMsg>(admin, 'match:start');
    admin.socket.emit('observe:start', m.matchId);
    await watching;
    const left = next(admin, 'match:left');
    admin.socket.emit('observe:stop');
    await left;
    const quiet = silence(admin, 'snap', () => true, 600);
    assert.ok(await quiet, 'rời xem rồi vẫn nhận snapshot');
    const done = next(player, 'match:left');
    player.socket.emit('match:leave');
    await done;
  });
});
