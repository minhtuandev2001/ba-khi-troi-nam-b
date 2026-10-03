/**
 * Integration test for room names and the lobby room list against a running backend (`npm run dev`):
 * cleaning names, the default name, hidden rooms, live player counts and unwatching. Test users are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import { ROOM_NAME_MAX_LENGTH, type RoomStateMsg, type RoomSummary } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

const players: Record<'a' | 'b' | 'c', Player> = {} as never;
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

/** Resolves false if a matching `event` arrives within `ms`. */
function silence<T>(p: Player, event: string, accept: (v: T) => boolean = () => true, ms = 900): Promise<boolean> {
  return next(p, event, accept, ms).then(() => false, () => true);
}

async function connect(name: string): Promise<Player> {
  const row = await createUser(name, 'x', '🐭');
  assert.ok(row, `không tạo được ${name}`);
  createdIds.push(row.id);
  const socket = io(SERVER, { auth: { token: signToken(row.id) }, parser: msgpackParser, transports: ['websocket'], reconnection: false });
  const p = { id: row.id, name, socket };
  await next(p, 'lobby:ready', () => true, 8000);
  return p;
}

async function create(p: Player, opts: unknown): Promise<RoomStateMsg> {
  const state = next<RoomStateMsg>(p, 'room:state');
  p.socket.emit('room:create', opts);
  return state;
}

async function leave(p: Player) {
  const closed = next(p, 'room:closed');
  p.socket.emit('room:leave');
  await closed;
}

const find = (list: RoomSummary[], id: string) => list.find((r) => r.id === id);

before(async () => {
  players.a = await connect(`zl${TAG}a`);
  players.b = await connect(`zl${TAG}b`);
  players.c = await connect(`zl${TAG}c`);
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

describe('danh sách phòng ở sảnh', () => {
  let roomId = '';

  test('vừa theo dõi là nhận danh sách ngay', async () => {
    const first = next<RoomSummary[]>(players.b, 'rooms:list');
    players.b.socket.emit('rooms:watch');
    assert.ok(Array.isArray(await first));
  });

  test('tạo phòng có tên: tên được làm sạch và hiện trong danh sách kèm chủ phòng, số người, kiểu đội', async () => {
    const { a, b } = players;
    const listed = next<RoomSummary[]>(b, 'rooms:list', (l) => l.some((r) => r.host.name === a.name));
    const s = await create(a, { teamSize: 2, name: '  Hội \u0000 thi\n Văn Lang  ', listed: true });
    roomId = s.id;
    assert.equal(s.name, 'Hội thi Văn Lang');
    assert.equal(s.listed, true);
    const row = find(await listed, roomId);
    assert.ok(row, 'phòng phải có trong danh sách');
    assert.equal(row.name, 'Hội thi Văn Lang');
    assert.equal(row.players, 1);
    assert.equal(row.humans, 1);
    assert.equal(row.teamSize, 2);
    assert.equal(row.max, s.max);
    assert.equal(row.host.admin, undefined);
  });

  test('tên quá dài bị cắt; để trống hoặc gửi kiểu cũ (chỉ số người mỗi đội) thì dùng tên mặc định', async () => {
    const { c } = players;
    const long = await create(c, { teamSize: 1, name: 'Đ'.repeat(60), listed: true });
    assert.equal(long.name.length, ROOM_NAME_MAX_LENGTH);
    await leave(c);
    const blank = await create(c, { teamSize: 1, name: ' \t ', listed: true });
    assert.equal(blank.name, `Phòng của ${c.name}`);
    await leave(c);
    const legacy = await create(c, 4);
    assert.equal(legacy.teamSize, 4);
    assert.equal(legacy.name, `Phòng của ${c.name}`);
    assert.equal(legacy.listed, true);
    await leave(c);
  });

  test('phòng kín không hiện trong danh sách', async () => {
    const { a, b, c } = players;
    const hidden = await create(c, { teamSize: 1, name: 'Phòng kín', listed: false });
    assert.equal(hidden.listed, false);
    // a bot joining a's room forces a fresh list after the hidden room exists
    const update = next<RoomSummary[]>(b, 'rooms:list', (l) => find(l, roomId)?.players === 2);
    a.socket.emit('room:addBot');
    const list = await update;
    assert.equal(find(list, hidden.id), undefined);
    await leave(c);
  });

  test('vào phòng từ danh sách thì số người cập nhật; phòng giải tán thì biến mất', async () => {
    const { a, b } = players;
    const joined = next<RoomSummary[]>(b, 'rooms:list', (l) => find(l, roomId)?.humans === 2);
    b.socket.emit('room:join', roomId);
    assert.equal(find(await joined, roomId)?.players, 3);
    await leave(b);
    const gone = next<RoomSummary[]>(b, 'rooms:list', (l) => !find(l, roomId));
    await leave(a);
    await gone;
  });

  test('bỏ theo dõi thì không nhận danh sách nữa', async () => {
    const { a, b } = players;
    b.socket.emit('rooms:unwatch');
    await new Promise((r) => setTimeout(r, 100));
    const quiet = silence<RoomSummary[]>(b, 'rooms:list');
    await create(a, { teamSize: 1, name: 'Không ai thấy', listed: true });
    assert.ok(await quiet, 'đã bỏ theo dõi mà vẫn nhận danh sách');
    await leave(a);
  });
});
