/**
 * Integration test for team rooms against a running backend (`npm run dev`): picking the team size,
 * keeping slots when it changes, moving between slots and the two-team start rule. Test users are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import type { RoomStateMsg } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

const players: Record<'a' | 'b', Player> = {} as never;
const createdIds: string[] = [];

function next<T>(p: Player, event: string, accept: (v: T) => boolean = () => true, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.socket.off(event, handler);
      reject(new Error(`${p.name} không nhận được ${event}`));
    }, ms);
    const handler = (v: T) => {
      if (!accept(v)) return;
      clearTimeout(timer);
      p.socket.off(event, handler);
      resolve(v);
    };
    p.socket.on(event, handler);
  });
}

async function expectError(p: Player, event: string, arg: unknown, pattern: RegExp) {
  const err = next<{ text: string }>(p, 'error:msg');
  p.socket.emit(event, arg);
  assert.match((await err).text, pattern);
}

const slotOf = (s: RoomStateMsg, id: string) => s.members.find((m) => m.id === id)?.slot;

async function connect(name: string): Promise<Player> {
  const row = await createUser(name, 'x', '🐭');
  assert.ok(row, `không tạo được ${name}`);
  createdIds.push(row.id);
  const socket = io(SERVER, { auth: { token: signToken(row.id) }, parser: msgpackParser, transports: ['websocket'], reconnection: false });
  const p = { id: row.id, name, socket };
  await next(p, 'lobby:ready', () => true, 8000);
  return p;
}

before(async () => {
  players.a = await connect(`zr${TAG}a`);
  players.b = await connect(`zr${TAG}b`);
});

after(async () => {
  for (const p of Object.values(players)) p?.socket.disconnect();
  if (createdIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>('SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('phòng bạn bè chia đội', () => {
  let roomId = '';

  test('tạo phòng nhóm 2; người vào sau chưa được xếp đội', async () => {
    const { a, b } = players;
    const created = next<RoomStateMsg>(a, 'room:state');
    a.socket.emit('room:create', 2);
    const s = await created;
    roomId = s.id;
    assert.equal(s.teamSize, 2);
    assert.equal(slotOf(s, a.id), 0);
    const joined = next<RoomStateMsg>(a, 'room:state', (r) => r.members.length === 2);
    b.socket.emit('room:join', roomId);
    assert.equal(slotOf(await joined, b.id), null);
    await expectError(a, 'room:start', undefined, /chưa chọn đội/);
  });

  test('tự chọn ô; ô đã có người thì không vào được; cả phòng chung một đội thì không bắt đầu được', async () => {
    const { a, b } = players;
    await expectError(b, 'room:move', 0, /đã có người/);
    const sameTeam = next<RoomStateMsg>(a, 'room:state', (r) => slotOf(r, b.id) === 1);
    b.socket.emit('room:move', 1);
    await sameTeam;
    await expectError(a, 'room:start', undefined, /2 đội/);
    const moved = next<RoomStateMsg>(a, 'room:state', (r) => slotOf(r, b.id) === 3);
    b.socket.emit('room:move', 3);
    await moved;
  });

  test('đổi sang nhóm 4 giữ nguyên ô, các ô gộp lại thành đội mới', async () => {
    const { a, b } = players;
    await expectError(b, 'room:setTeamSize', 4, /chủ phòng/);
    const four = next<RoomStateMsg>(b, 'room:state', (r) => r.teamSize === 4);
    a.socket.emit('room:setTeamSize', 4);
    const s = await four;
    assert.equal(slotOf(s, a.id), 0);
    assert.equal(slotOf(s, b.id), 3);
    // slots 0 and 3 are now one squad
    await expectError(a, 'room:start', undefined, /2 đội/);
  });

  test('bot ngồi vào ô trống đầu tiên, xóa bot thì trả ô', async () => {
    const { a } = players;
    const withBot = next<RoomStateMsg>(a, 'room:state', (r) => r.members.some((m) => m.isBot));
    a.socket.emit('room:addBot');
    const s = await withBot;
    const bot = s.members.find((m) => m.isBot)!;
    assert.equal(bot.slot, 1);
    const gone = next<RoomStateMsg>(a, 'room:state', (r) => !r.members.some((m) => m.isBot));
    a.socket.emit('room:removeBot', bot.id);
    await gone;
  });

  test('rời phòng', async () => {
    const { a, b } = players;
    const closedB = next<{ reason: string }>(b, 'room:closed');
    b.socket.emit('room:leave');
    await closedB;
    const closedA = next<{ reason: string }>(a, 'room:closed');
    a.socket.emit('room:leave');
    await closedA;
    await expectError(b, 'room:join', roomId, /không tồn tại/);
  });
});
