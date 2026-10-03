/**
 * Integration test for abuse limits against a running backend (`npm run dev`): admins muting players, chat
 * allowances that survive reconnecting, the world-chat allowance shared by one address, and the per-address caps
 * on bot/practice sessions and waiting rooms. Every test client connects from this machine, i.e. one address.
 * Test users (one promoted to admin), their messages, rooms and sessions are removed afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import type { ChatMessage, MatchStartMsg, RoomStateMsg, UserSearchResult } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Client {
  id: string;
  name: string;
  socket: Socket;
}

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

const createdIds: string[] = [];
const clients: Client[] = [];
let admin: Client;
let player: Client;
let other: Client;

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

function ack<T = object>(c: Client, event: string, arg: object = {}): Promise<Ack<T>> {
  return c.socket.timeout(5000).emitWithAck(event, arg);
}

async function openSocket(id: string, name: string): Promise<Client> {
  const socket = io(SERVER, { auth: { token: signToken(id) }, parser: msgpackParser, transports: ['websocket'], reconnection: false });
  const c = { id, name, socket };
  await next(c, 'lobby:ready', () => true, 8000);
  clients.push(c);
  return c;
}

async function connect(suffix: string, isAdmin = false): Promise<Client> {
  const row = await createUser(`zm${TAG}${suffix}`, 'x', '🐭');
  assert.ok(row, `không tạo được zm${TAG}${suffix}`);
  createdIds.push(row.id);
  if (isAdmin) await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [row.id]);
  return openSocket(row.id, row.username);
}

const world = (c: Client, text: string) => ack<{ message: ChatMessage }>(c, 'chat:send', { text });
const errorOf = (r: Ack<unknown>) => (r.ok ? '' : r.error);

before(async () => {
  admin = await connect('adm', true);
  player = await connect('p');
  other = await connect('o');
});

after(async () => {
  for (const c of clients) c.socket.disconnect();
  if (createdIds.length) {
    await pool.query('DELETE FROM chat_messages WHERE channel = ANY($1::text[])', [createdIds.map((id) => `support:${id}`)]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
            + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[])) AS n`,
      [createdIds],
    );
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('quản trị viên cấm chat', () => {
  test('người thường không cấm chat được; admin không tự cấm mình, thời hạn lạ bị từ chối', async () => {
    assert.match(errorOf(await ack(other, 'admin:mute', { userId: player.id, minutes: 15 })), /quản trị viên/);
    assert.equal((await ack(admin, 'admin:mute', { userId: admin.id, minutes: 15 })).ok, false);
    assert.match(errorOf(await ack(admin, 'admin:mute', { userId: player.id, minutes: 7 })), /Thời hạn/);
  });

  test('bị cấm: không gửi được kênh thế giới nhưng vẫn nhắn được admin; admin thấy hạn cấm khi tìm, người khác thì không', async () => {
    const notice = next<{ until: string | null }>(player, 'chat:muted');
    const res = await ack<{ until: string | null }>(admin, 'admin:mute', { userId: player.id, minutes: 15 });
    assert.ok(res.ok, errorOf(res));
    assert.ok(res.until && Date.parse(res.until) > Date.now() + 14 * 60_000);
    assert.equal((await notice).until, res.until);

    assert.match(errorOf(await world(player, `bị cấm ${TAG}`)), /cấm chat, còn 15 phút/);
    const support = await ack(player, 'chat:send', { to: 'support', text: 'Sao em bị cấm chat ạ?' });
    assert.ok(support.ok, errorOf(support));

    const q = player.name.slice(0, 8);
    const seenByAdmin = await ack<{ users: UserSearchResult[] }>(admin, 'user:search', { q });
    assert.ok(seenByAdmin.ok);
    assert.equal(seenByAdmin.users.find((u) => u.id === player.id)?.mutedUntil, res.until);
    const seenByOther = await ack<{ users: UserSearchResult[] }>(other, 'user:search', { q });
    assert.ok(seenByOther.ok);
    assert.equal(seenByOther.users.find((u) => u.id === player.id)?.mutedUntil, undefined);
  });

  test('bỏ cấm thì gửi lại được', async () => {
    const notice = next<{ until: string | null }>(player, 'chat:muted');
    const res = await ack<{ until: string | null }>(admin, 'admin:mute', { userId: player.id, minutes: 0 });
    assert.ok(res.ok, errorOf(res));
    assert.equal(res.until, null);
    assert.equal((await notice).until, null);
    const sent = await world(player, `hết bị cấm ${TAG}`);
    assert.ok(sent.ok, errorOf(sent));
  });
});

describe('giới hạn chống spam', () => {
  test('lượt gửi kênh thế giới tính theo tài khoản: kết nối lại không được thêm lượt', async () => {
    const x = await connect('x');
    for (let i = 0; i < 3; i++) {
      const r = await world(x, `lượt ${i} ${TAG}`);
      assert.ok(r.ok, errorOf(r));
    }
    x.socket.disconnect();
    const again = await openSocket(x.id, x.name);
    assert.match(errorOf(await world(again, `lượt 4 ${TAG}`)), /giới hạn/);
  });

  test('nhiều tài khoản cùng một mạng dùng chung lượt gửi kênh thế giới', async () => {
    const crowd = [await connect('y1'), await connect('y2'), await connect('y3'), await connect('y4')];
    const results = await Promise.all(crowd.flatMap((c) => [0, 1, 2].map((i) => world(c, `đám đông ${c.name} ${i}`))));
    const errors = results.map(errorOf);
    assert.ok(errors.every((e) => e === '' || /Mạng của bạn/.test(e)), JSON.stringify(errors));
    assert.ok(errors.filter((e) => e !== '').length >= 3, `12 tin cùng lúc từ một mạng gần như đều lọt: ${JSON.stringify(errors)}`);
  });
});

describe('giới hạn theo mạng', () => {
  test('một mạng chỉ mở được 6 trận bot/buổi tập cùng lúc', async () => {
    const outcomes: string[] = [];
    for (const c of clients.filter((c) => c.socket.connected)) {
      const result = Promise.race([
        next<MatchStartMsg>(c, 'match:start').then(() => 'started'),
        next<{ text: string }>(c, 'error:msg').then((e) => e.text),
      ]);
      c.socket.emit('training:start');
      outcomes.push(await result);
    }
    assert.ok(outcomes.length >= 7, 'không đủ người để thử');
    assert.ok(outcomes.filter((o) => o === 'started').length <= 6, 'mở được quá 6 buổi tập');
    assert.ok(outcomes.some((o) => /quá nhiều trận/.test(o)), JSON.stringify(outcomes));
    for (const c of clients) c.socket.emit('match:leave');
    await new Promise((r) => setTimeout(r, 300));
  });

  test('một mạng chỉ mở được 6 phòng chờ cùng lúc', async () => {
    const outcomes: string[] = [];
    for (const c of clients.filter((c) => c.socket.connected)) {
      const result = Promise.race([
        next<RoomStateMsg>(c, 'room:state').then(() => 'created'),
        next<{ text: string }>(c, 'error:msg').then((e) => e.text),
      ]);
      c.socket.emit('room:create', { teamSize: 1, name: `Giới hạn ${TAG}`, listed: false });
      outcomes.push(await result);
    }
    assert.ok(outcomes.filter((o) => o === 'created').length <= 6, 'mở được quá 6 phòng');
    assert.ok(outcomes.some((o) => /quá nhiều phòng/.test(o)), JSON.stringify(outcomes));
    for (const c of clients) c.socket.emit('room:leave');
  });
});
