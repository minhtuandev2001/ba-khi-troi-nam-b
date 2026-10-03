/**
 * Integration test for duo/squad parties against a running backend (`npm run dev`): invites,
 * leader rights, queueing as a party and cancelling. Test users are deleted afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import type { PartyInviteMsg, PartyStateMsg, QueueStatusMsg, SocialAck } from '../src/shared';

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

/** Emits `event` and waits for the error toast the server answers with. */
async function expectError(p: Player, event: string, arg: unknown, pattern: RegExp) {
  const err = next<{ text: string }>(p, 'error:msg');
  p.socket.emit(event, arg);
  assert.match((await err).text, pattern);
}

const stateWith = (pred: (s: PartyStateMsg) => boolean) => (s: PartyStateMsg) => pred(s);

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
  players.a = await connect(`zp${TAG}a`);
  players.b = await connect(`zp${TAG}b`);
  players.c = await connect(`zp${TAG}c`);
  // a and b are friends, c is a stranger
  const { a, b } = players;
  const req: SocialAck<unknown> = await a.socket.timeout(5000).emitWithAck('friend:request', { username: b.name });
  assert.ok(req.ok);
  const res: SocialAck<unknown> = await b.socket.timeout(5000).emitWithAck('friend:respond', { userId: a.id, accept: true });
  assert.ok(res.ok);
});

after(async () => {
  for (const p of Object.values(players)) p?.socket.disconnect();
  if (createdIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdIds]);
    const left = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
            + (SELECT count(*) FROM friendships WHERE requester_id = ANY($1::uuid[]) OR addressee_id = ANY($1::uuid[])) AS n`,
      [createdIds],
    );
    assert.equal(Number(left.rows[0].n), 0, 'còn sót dữ liệu test');
  }
  await pool.end();
});

describe('nhóm ghép trận', () => {
  let partyId = '';

  test('lập nhóm 2, mặc định ghép thêm người lạ', async () => {
    const { a } = players;
    const state = next<PartyStateMsg>(a, 'party:state');
    a.socket.emit('party:create', 2);
    const s = await state;
    partyId = s.id;
    assert.equal(s.leaderId, a.id);
    assert.equal(s.size, 2);
    assert.equal(s.fill, true);
    assert.equal(s.inQueue, false);
    assert.deepEqual(s.members.map((m) => m.id), [a.id]);
    await expectError(a, 'queue:join', undefined, /trong một nhóm/);
    await expectError(a, 'party:create', 4, /trong một nhóm/);
  });

  test('chỉ mời được bạn bè, có thời gian chờ giữa hai lần mời', async () => {
    const { a, b, c } = players;
    await expectError(a, 'party:invite', c.id, /bạn bè/);
    const invite = next<PartyInviteMsg>(b, 'party:invite');
    const ack = next<{ userId: string }>(a, 'party:invited');
    a.socket.emit('party:invite', b.id);
    const msg = await invite;
    assert.equal(msg.partyId, partyId);
    assert.equal(msg.from.id, a.id);
    assert.equal(msg.size, 2);
    assert.equal((await ack).userId, b.id);
    await expectError(a, 'party:invite', b.id, /chờ một chút/);
  });

  test('vào nhóm; người ngoài không vào được nhóm đã đủ', async () => {
    const { a, b, c } = players;
    const seenByA = next<PartyStateMsg>(a, 'party:state', stateWith((s) => s.members.length === 2));
    const seenByB = next<PartyStateMsg>(b, 'party:state', stateWith((s) => s.members.length === 2));
    b.socket.emit('party:join', partyId);
    const [sa, sb] = await Promise.all([seenByA, seenByB]);
    assert.deepEqual(sa.members.map((m) => m.id), [a.id, b.id]);
    assert.ok(sb.members.every((m) => m.online));
    await expectError(c, 'party:join', partyId, /đã đủ 2 người/);
    await expectError(c, 'party:join', 'khong-phai-uuid', /không hợp lệ/);
  });

  test('chỉ trưởng nhóm đổi cỡ, đổi chế độ ghép và tìm trận', async () => {
    const { a, b } = players;
    await expectError(b, 'party:setFill', false, /trưởng nhóm/);
    await expectError(b, 'party:queue', undefined, /trưởng nhóm/);
    const four = next<PartyStateMsg>(b, 'party:state', stateWith((s) => s.size === 4));
    a.socket.emit('party:setSize', 4);
    await four;
    const noFill = next<PartyStateMsg>(b, 'party:state', stateWith((s) => !s.fill));
    a.socket.emit('party:setFill', false);
    await noFill;
    const back = next<PartyStateMsg>(b, 'party:state', stateWith((s) => s.size === 2 && s.fill));
    a.socket.emit('party:setSize', 2);
    a.socket.emit('party:setFill', true);
    await back;
  });

  test('tìm trận cả nhóm; một thành viên hủy thì cả nhóm ra khỏi hàng chờ', async () => {
    const { a, b } = players;
    const qa = next<QueueStatusMsg>(a, 'queue:status', (q) => q.inQueue);
    const qb = next<QueueStatusMsg>(b, 'queue:status', (q) => q.inQueue);
    const queued = next<PartyStateMsg>(b, 'party:state', stateWith((s) => s.inQueue));
    a.socket.emit('party:queue');
    const [sa, sb] = await Promise.all([qa, qb, queued]);
    assert.equal(sa.teamSize, 2);
    assert.deepEqual(sa.party, { members: 2, fill: true, leader: true });
    assert.equal(sb.party?.leader, false);
    assert.ok(sa.count >= 2);
    await expectError(a, 'party:setFill', false, /đang tìm trận/);
    await expectError(players.c, 'party:join', partyId, /đã đủ|đang tìm trận/);

    const outA = next<QueueStatusMsg>(a, 'queue:status', (q) => !q.inQueue);
    const outB = next<QueueStatusMsg>(b, 'queue:status', (q) => !q.inQueue);
    const idle = next<PartyStateMsg>(a, 'party:state', stateWith((s) => !s.inQueue && s.members.length === 2));
    b.socket.emit('queue:leave');
    await Promise.all([outA, outB, idle]);
  });

  test('rời nhóm khi đang tìm thì hủy tìm cho cả nhóm', async () => {
    const { a, b } = players;
    const queued = next<QueueStatusMsg>(a, 'queue:status', (q) => q.inQueue);
    a.socket.emit('party:queue');
    await queued;
    const outA = next<QueueStatusMsg>(a, 'queue:status', (q) => !q.inQueue);
    const closed = next<{ reason: string }>(b, 'party:closed');
    const alone = next<PartyStateMsg>(a, 'party:state', stateWith((s) => !s.inQueue && s.members.length === 1));
    b.socket.emit('party:leave');
    await Promise.all([outA, closed, alone]);
  });

  test('trưởng nhóm mời ra, rồi rời nhóm thì quyền trưởng nhóm được chuyển', async () => {
    const { a, b } = players;
    const rejoined = next<PartyStateMsg>(a, 'party:state', stateWith((s) => s.members.length === 2));
    b.socket.emit('party:join', partyId);
    await rejoined;
    const kicked = next<{ reason: string }>(b, 'party:closed');
    a.socket.emit('party:kick', b.id);
    assert.equal((await kicked).reason, 'kicked');

    const joined = next<PartyStateMsg>(a, 'party:state', stateWith((s) => s.members.length === 2));
    b.socket.emit('party:join', partyId);
    await joined;
    const promoted = next<PartyStateMsg>(b, 'party:state', stateWith((s) => s.leaderId === b.id));
    const left = next<{ reason: string }>(a, 'party:closed');
    a.socket.emit('party:leave');
    assert.equal((await left).reason, 'left');
    const s = await promoted;
    assert.deepEqual(s.members.map((m) => m.id), [b.id]);

    const gone = next<{ reason: string }>(b, 'party:closed');
    b.socket.emit('party:leave');
    await gone;
    await expectError(a, 'party:join', partyId, /không còn tồn tại/);
  });
});
