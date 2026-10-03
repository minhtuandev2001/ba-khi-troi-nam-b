/**
 * Integration test for chat and friends against a running backend (`npm run dev`).
 * Test users are inserted straight into the database and deleted afterwards, which cascades
 * to their friendships, messages and read markers.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import { CHAT_MAX_LENGTH, WORLD_CHANNEL, dmChannel, type ChatMessage, type FriendsState, type SocialAck } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

const players: Record<'a' | 'b' | 'c', Player> = {} as never;
const createdIds: string[] = [];

function call<T>(p: Player, event: string, arg: object = {}): Promise<SocialAck<T>> {
  return p.socket.timeout(5000).emitWithAck(event, arg);
}

async function expectOk<T>(p: Player, event: string, arg: object = {}): Promise<T> {
  const res = await call<T>(p, event, arg);
  assert.ok(res.ok, `${event} lỗi: ${'error' in res ? res.error : ''}`);
  return res as T;
}

async function expectError(p: Player, event: string, arg: object, pattern: RegExp) {
  const res = await call(p, event, arg);
  assert.equal(res.ok, false, `${event} lẽ ra phải bị từ chối`);
  assert.match((res as { error: string }).error, pattern);
}

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

/** Resolves false if `event` arrives within `ms`. */
function silence(p: Player, event: string, accept: (v: any) => boolean, ms = 600): Promise<boolean> {
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

before(async () => {
  players.a = await connect(`zt${TAG}a`);
  players.b = await connect(`zt${TAG}b`);
  players.c = await connect(`zt${TAG}c`);
});

after(async () => {
  for (const p of Object.values(players)) p?.socket.disconnect();
  if (createdIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
            + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM friendships WHERE requester_id = ANY($1::uuid[]) OR addressee_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM chat_reads WHERE user_id = ANY($1::uuid[])) AS n`,
      [createdIds],
    );
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('bạn bè', () => {
  test('tìm kiếm theo tiền tố, bỏ qua ký tự lạ và chính mình', async () => {
    const { a } = players;
    const res = await expectOk<{ users: { username: string; relation: string }[] }>(a, 'user:search', { q: `zt${TAG}` });
    assert.deepEqual(res.users.map((u) => u.username).sort(), [`zt${TAG}b`, `zt${TAG}c`]);
    assert.ok(res.users.every((u) => u.relation === 'none'));
    const odd = await expectOk<{ users: unknown[] }>(a, 'user:search', { q: "z%' OR 1=1 --" });
    assert.equal(odd.users.length, 0);
    const wildcard = await expectOk<{ users: unknown[] }>(a, 'user:search', { q: '__' });
    assert.ok(wildcard.users.length === 0 || wildcard.users.every((u: any) => u.username.startsWith('__')));
  });

  test('chưa là bạn thì không nhắn riêng được', async () => {
    await expectError(players.a, 'chat:send', { to: players.b.id, text: 'chào' }, /bạn bè/);
    await expectError(players.c, 'chat:history', { to: players.a.id }, /bạn bè/);
  });

  test('gửi lời mời, chặn gửi trùng, chấp nhận', async () => {
    const { a, b } = players;
    const notified = next(b, 'friend:changed');
    const sent = await expectOk<{ result: string }>(a, 'friend:request', { username: b.name.toUpperCase() });
    assert.equal(sent.result, 'sent');
    await notified;
    await expectError(a, 'friend:request', { username: b.name }, /đã gửi/);
    await expectError(a, 'friend:request', { username: a.name }, /chính mình/);
    await expectError(a, 'friend:request', { username: 'khongtontai_xyz' }, /Không tìm thấy/);

    const bList = await expectOk<FriendsState>(b, 'friend:list');
    assert.deepEqual(bList.incoming.map((u) => u.id), [a.id]);
    const aList = await expectOk<FriendsState>(a, 'friend:list');
    assert.deepEqual(aList.outgoing.map((u) => u.id), [b.id]);

    const aNotified = next(a, 'friend:changed');
    await expectOk(b, 'friend:respond', { userId: a.id, accept: true });
    await aNotified;
    const after = await expectOk<FriendsState>(a, 'friend:list');
    assert.equal(after.friends.length, 1);
    assert.equal(after.friends[0].id, b.id);
    assert.equal(after.friends[0].presence, 'online');
    assert.equal(after.outgoing.length, 0);
  });

  test('lời mời ngược chiều được tự chấp nhận', async () => {
    const { a, c } = players;
    await expectOk(c, 'friend:request', { userId: a.id });
    const res = await expectOk<{ result: string }>(a, 'friend:request', { username: c.name });
    assert.equal(res.result, 'accepted');
    await expectOk(a, 'friend:remove', { userId: c.id });
    const list = await expectOk<FriendsState>(c, 'friend:list');
    assert.equal(list.friends.length + list.incoming.length + list.outgoing.length, 0);
  });
});

describe('chat', () => {
  test('tin nhắn riêng chỉ tới đúng người, có lịch sử và số chưa đọc', async () => {
    const { a, b, c } = players;
    const channel = dmChannel(a.id, b.id);
    const received = next<ChatMessage>(b, 'chat:msg', (m) => m.channel === channel);
    const cHears = silence(c, 'chat:msg', (m: ChatMessage) => m.channel === channel);
    const sent = await expectOk<{ message: ChatMessage }>(a, 'chat:send', { to: b.id, text: '  xin   chào\u0000 <b>bạn</b>  ' });
    assert.equal(sent.message.text, 'xin chào <b>bạn</b>');
    const got = await received;
    assert.equal(got.id, sent.message.id);
    assert.equal(got.from.id, a.id);
    assert.ok(await cHears, 'người ngoài không được nhận tin riêng');

    let list = await expectOk<FriendsState>(b, 'friend:list');
    assert.equal(list.friends[0].unread, 1);
    await expectOk(b, 'chat:read', { to: a.id, id: got.id });
    list = await expectOk<FriendsState>(b, 'friend:list');
    assert.equal(list.friends[0].unread, 0);

    const history = await expectOk<{ messages: ChatMessage[] }>(b, 'chat:history', { to: a.id });
    assert.deepEqual(history.messages.map((m) => m.id), [sent.message.id]);
  });

  test('kênh thế giới tới mọi người, không lặp lại cho người gửi', async () => {
    const { a, b, c } = players;
    const text = `xin chào thế giới ${TAG}`;
    const aGets = next<ChatMessage>(a, 'chat:msg', (m) => m.channel === WORLD_CHANNEL && m.text === text);
    const bGets = next<ChatMessage>(b, 'chat:msg', (m) => m.channel === WORLD_CHANNEL && m.text === text);
    const echo = silence(c, 'chat:msg', (m: ChatMessage) => m.text === text);
    const sent = await expectOk<{ message: ChatMessage }>(c, 'chat:send', { text });
    assert.equal(sent.message.channel, WORLD_CHANNEL);
    await Promise.all([aGets, bGets]);
    assert.ok(await echo, 'người gửi không nhận lại tin của chính mình');
    await expectError(c, 'chat:send', { text }, /lặp lại/);

    const history = await expectOk<{ messages: ChatMessage[] }>(a, 'chat:history', {});
    assert.ok(history.messages.some((m) => m.id === sent.message.id));
  });

  test('kiểm tra nội dung và giới hạn tốc độ', async () => {
    const { a, b } = players;
    await expectError(a, 'chat:send', { to: b.id, text: '   \n\t ' }, /trống/);
    await expectError(a, 'chat:send', { to: 'not-a-uuid', text: 'x' }, /không hợp lệ/);
    const long = await expectOk<{ message: ChatMessage }>(a, 'chat:send', { to: b.id, text: 'a'.repeat(500) });
    assert.equal(long.message.text.length, CHAT_MAX_LENGTH);

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await call(b, 'chat:send', { text: `spam ${TAG} ${i}` }));
    assert.ok(results.some((r) => !r.ok && /2 giây/.test((r as { error: string }).error)), 'kênh thế giới phải giới hạn tốc độ');
  });

  test('bạn bè thấy trạng thái ngoại tuyến và mất quyền nhắn khi huỷ kết bạn', async () => {
    const { a, b } = players;
    const offline = next<{ userId: string; presence: string }>(a, 'friend:presence', (e) => e.userId === b.id && e.presence === 'offline');
    b.socket.disconnect();
    await offline;
    await expectOk(a, 'friend:remove', { userId: b.id });
    await expectError(a, 'chat:send', { to: b.id, text: 'còn đó không' }, /bạn bè/);
  });
});
