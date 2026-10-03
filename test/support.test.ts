/**
 * Integration test for the player ↔ admin support chat against a running backend (`npm run dev`):
 * players message the admins without being friends, admins answer from their inbox, and nobody else can
 * read a thread. Test users (one of them promoted to admin) and their messages are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import type { ChatMessage, SupportStatus, SupportThread } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

interface Client {
  id: string;
  name: string;
  socket: Socket;
}

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

const users: Record<'admin' | 'player' | 'other', Client> = {} as never;
const createdIds: string[] = [];

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

function silence<T>(c: Client, event: string, accept: (v: T) => boolean = () => true, ms = 900): Promise<boolean> {
  return next(c, event, accept, ms).then(() => false, () => true);
}

function ack<T = object>(c: Client, event: string, arg: object = {}): Promise<Ack<T>> {
  return c.socket.timeout(5000).emitWithAck(event, arg);
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

const threadOf = (c: Client) => `support:${c.id}`;

async function inboxEntry(of: Client): Promise<SupportThread | undefined> {
  const res = await ack<{ threads: SupportThread[] }>(users.admin, 'support:inbox');
  assert.ok(res.ok, !res.ok ? res.error : '');
  return res.threads.find((t) => t.user.id === of.id);
}

before(async () => {
  users.admin = await connect(`zs${TAG}adm`, true);
  users.player = await connect(`zs${TAG}p`);
  users.other = await connect(`zs${TAG}o`);
});

after(async () => {
  for (const c of Object.values(users)) c?.socket.disconnect();
  if (createdIds.length) {
    const channels = createdIds.map((id) => `support:${id}`);
    await pool.query('DELETE FROM chat_messages WHERE channel = ANY($1::text[])', [channels]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
            + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[]) OR channel = ANY($2::text[]))
            + (SELECT count(*) FROM chat_reads WHERE user_id = ANY($1::uuid[])) AS n`,
      [createdIds, channels],
    );
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('chat hỗ trợ giữa người chơi và quản trị viên', () => {
  test('người chơi thấy có quản trị viên trực tuyến', async () => {
    const res = await ack<SupportStatus>(users.player, 'support:status');
    assert.ok(res.ok);
    assert.equal(res.adminOnline, true);
    assert.equal(res.unread, 0);
  });

  test('người chơi nhắn, quản trị viên nhận được dù không là bạn bè; người khác không nhận', async () => {
    const got = next<ChatMessage>(users.admin, 'chat:msg', (m) => m.channel === threadOf(users.player));
    const leak = silence<ChatMessage>(users.other, 'chat:msg', (m) => m.channel.startsWith('support:'));
    const res = await ack<{ message: ChatMessage }>(users.player, 'chat:send', { to: 'support', text: 'Em bị lag quá admin ơi' });
    assert.ok(res.ok, !res.ok ? res.error : '');
    assert.equal(res.message.channel, threadOf(users.player));
    const m = await got;
    assert.equal(m.text, 'Em bị lag quá admin ơi');
    assert.equal(m.from.id, users.player.id);
    assert.ok(await leak, 'người chơi khác nhận được tin hỗ trợ');
  });

  test('hộp thư của quản trị viên có luồng mới với 1 tin chưa đọc', async () => {
    const t = await inboxEntry(users.player);
    assert.ok(t, 'không thấy luồng trong hộp thư');
    assert.equal(t.unread, 1);
    assert.equal(t.last.fromAdmin, false);
    assert.equal(t.user.username, users.player.name);
  });

  test('quản trị viên trả lời, người chơi nhận được và có 1 tin chưa đọc', async () => {
    const got = next<ChatMessage>(users.player, 'chat:msg', (m) => m.channel === threadOf(users.player));
    const res = await ack<{ message: ChatMessage }>(users.admin, 'chat:send', { to: threadOf(users.player), text: 'Bạn thử đổi máy chủ nhé' });
    assert.ok(res.ok, !res.ok ? res.error : '');
    const m = await got;
    assert.equal(m.from.admin, true);
    const status = await ack<SupportStatus>(users.player, 'support:status');
    assert.ok(status.ok);
    assert.equal(status.unread, 1);
    const t = await inboxEntry(users.player);
    assert.equal(t?.last.fromAdmin, true);
  });

  test('đánh dấu đã đọc ở cả hai phía', async () => {
    const hist = await ack<{ messages: ChatMessage[] }>(users.player, 'chat:history', { to: 'support' });
    assert.ok(hist.ok);
    assert.equal(hist.messages.length, 2);
    const last = hist.messages.at(-1)!;
    assert.ok((await ack(users.player, 'chat:read', { to: 'support', id: last.id })).ok);
    const status = await ack<SupportStatus>(users.player, 'support:status');
    assert.ok(status.ok);
    assert.equal(status.unread, 0);

    const adminHist = await ack<{ messages: ChatMessage[] }>(users.admin, 'chat:history', { to: threadOf(users.player) });
    assert.ok(adminHist.ok);
    assert.equal(adminHist.messages.length, 2);
    assert.ok((await ack(users.admin, 'chat:read', { to: threadOf(users.player), id: adminHist.messages.at(-1)!.id })).ok);
    assert.equal((await inboxEntry(users.player))?.unread, 0);
  });

  test('quản trị viên chủ động mở luồng với người chơi chưa từng nhắn', async () => {
    const got = next<ChatMessage>(users.other, 'chat:msg', (m) => m.channel === threadOf(users.other));
    const res = await ack(users.admin, 'chat:send', { to: threadOf(users.other), text: 'Chào bạn, mình là admin' });
    assert.ok(res.ok, !res.ok ? res.error : '');
    await got;
    const status = await ack<SupportStatus>(users.other, 'support:status');
    assert.ok(status.ok);
    assert.equal(status.unread, 1);
  });

  test('người chơi không đọc/gửi được vào luồng của người khác và không xem được hộp thư', async () => {
    const read = await ack(users.other, 'chat:history', { to: threadOf(users.player) });
    assert.equal(read.ok, false);
    const send = await ack(users.other, 'chat:send', { to: threadOf(users.player), text: 'chen ngang' });
    assert.equal(send.ok, false);
    const inbox = await ack(users.other, 'support:inbox');
    assert.equal(inbox.ok, false);
  });

  test('quản trị viên không dùng kênh "support" của người chơi và không mở luồng với chính mình/id bậy', async () => {
    assert.equal((await ack(users.admin, 'chat:send', { to: 'support', text: 'x' })).ok, false);
    assert.equal((await ack(users.admin, 'chat:send', { to: threadOf(users.admin), text: 'x' })).ok, false);
    assert.equal((await ack(users.admin, 'chat:history', { to: 'support:------------------------------------' })).ok, false);
    assert.equal((await ack(users.admin, 'chat:history', { to: 'support:00000000-0000-4000-8000-000000000000' })).ok, false);
  });
});
