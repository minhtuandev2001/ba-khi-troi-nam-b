/**
 * An admin deleting a player's account, against the running server: who may do it, what goes with the account,
 * and how the player, their friends and everyone else hear about it.
 *
 * Needs the server up (npm run dev) and the same database: node --env-file-if-exists=.env --import tsx --test test/deleteUser.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { io, type Socket } from "socket.io-client";
import * as msgpackParser from "socket.io-msgpack-parser";
import { ADMIN_USERNAME } from "../src/adminAccount";
import { signToken } from "../src/auth";
import { createUser, findUserByName, pool, saveMatch } from "../src/db";
import { type AdminAccountList, type ChatMessage, type RoomStateMsg, type RoomSummary, type SocialAck } from "../src/shared";

const SERVER =
  process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString("hex");

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

let victim: Player;
let friend: Player;
let other: Player;
let admin: Player;
const createdIds: string[] = [];
const matchIds: string[] = [];

function next<T>(p: Player, event: string, accept: (v: T) => boolean = () => true, ms = 4000): Promise<T> {
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

async function open(id: string, name: string, version = 0): Promise<Player> {
  const socket = io(SERVER, {
    auth: { token: signToken(id, version) },
    parser: msgpackParser,
    transports: ["websocket"],
    reconnection: false,
  });
  const p = { id, name, socket };
  await next(p, "lobby:ready", () => true, 8000);
  return p;
}

function ack<T>(p: Player, event: string, arg: object): Promise<SocialAck<T>> {
  return p.socket.timeout(5000).emitWithAck(event, arg);
}

const errorOf = (res: SocialAck<unknown>) => ("error" in res ? res.error : "");

async function newPlayer(suffix: string): Promise<Player> {
  const row = await createUser(`zd${TAG}${suffix}`, "x", "🐭");
  assert.ok(row);
  createdIds.push(row.id);
  return open(row.id, row.username);
}

before(async () => {
  victim = await newPlayer("v");
  friend = await newPlayer("f");
  other = await newPlayer("o");
  const adminRow = await findUserByName(ADMIN_USERNAME);
  assert.ok(adminRow, "chưa có tài khoản admin, server chưa chạy migrate?");
  admin = await open(adminRow.id, adminRow.username, adminRow.token_version);
  await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')", [victim.id, friend.id]);
});

after(async () => {
  for (const p of [victim, friend, other, admin]) p?.socket.disconnect();
  if (matchIds.length) await pool.query("DELETE FROM matches WHERE id = ANY($1::uuid[])", [matchIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdIds]);
  const left = await pool.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[]))
          + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[]) OR channel LIKE $2)
          + (SELECT count(*) FROM matches WHERE id = ANY($3::uuid[])) AS n`,
    [createdIds, `%${victim.id}%`, matchIds],
  );
  assert.equal(Number(left.rows[0].n), 0, "còn sót dữ liệu test");
  await pool.end();
});

function accounts(p: Player, q: string, version = 0) {
  return fetch(`${SERVER}/api/admin/accounts?q=${encodeURIComponent(q)}`, {
    headers: { authorization: `Bearer ${signToken(p.id, version)}` },
  });
}

describe("trang quản lý tài khoản (cần server đang chạy)", () => {
  test("chỉ admin xem được; tìm sai định dạng bị từ chối", async () => {
    assert.equal((await accounts(other, "")).status, 403);
    const adminRow = await findUserByName(ADMIN_USERNAME);
    assert.equal((await accounts(admin, "a%b", adminRow!.token_version)).status, 400);
  });

  test("tìm theo tên trả về thông tin tài khoản và trạng thái online", async () => {
    const adminRow = await findUserByName(ADMIN_USERNAME);
    const res = await accounts(admin, `zd${TAG}`, adminRow!.token_version);
    assert.equal(res.status, 200);
    const body = (await res.json()) as AdminAccountList;
    assert.equal(body.total, 3);
    const v = body.accounts.find((a) => a.id === victim.id);
    assert.ok(v);
    assert.equal(v.username, victim.name);
    assert.equal(v.presence, "online");
    assert.equal(v.matches, 0);
    assert.ok(Date.parse(v.createdAt) > Date.now() - 10 * 60_000);
    // "_" is a literal, not a LIKE wildcard
    const literal = (await (await accounts(admin, `zd_${TAG}`, adminRow!.token_version)).json()) as AdminAccountList;
    assert.equal(literal.total, 0);
  });
});

describe("admin xoá tài khoản (cần server đang chạy)", () => {
  test("người thường không xoá được; admin không xoá được chính mình", async () => {
    assert.match(errorOf(await ack(other, "admin:deleteUser", { userId: victim.id })), /quản trị viên/);
    assert.equal((await ack(admin, "admin:deleteUser", { userId: admin.id })).ok, false);
    assert.equal((await ack(admin, "admin:deleteUser", { userId: "khong-phai-id" })).ok, false);
    assert.equal((await ack(admin, "admin:deleteUser", { userId: randomUUID() })).ok, false);
  });

  test("xoá: người chơi bị đăng xuất, phòng đóng, bạn bè và mọi người được báo, dữ liệu biến mất", async () => {
    const roomState = next<RoomStateMsg>(victim, "room:state");
    victim.socket.emit("room:create", { teamSize: 1, name: `Xoa ${TAG}`, listed: true });
    const room = await roomState;

    const dm = await ack<{ message: ChatMessage }>(friend, "chat:send", { to: victim.id, text: `chào ${TAG}` });
    assert.ok(dm.ok, errorOf(dm));
    const support = await ack<{ message: ChatMessage }>(admin, "chat:send", { to: `support:${victim.id}`, text: `hỗ trợ ${TAG}` });
    assert.ok(support.ok, errorOf(support));
    const world = await ack<{ message: ChatMessage }>(victim, "chat:send", { text: `tin của người sắp bị xoá ${TAG}` });
    assert.ok(world.ok, errorOf(world));

    const firstList = next<RoomSummary[]>(other, "rooms:list");
    other.socket.emit("rooms:watch");
    assert.ok((await firstList).some((r) => r.id === room.id), "phòng phải có trong danh sách trước khi xoá");

    const told = next<unknown>(victim, "account:deleted");
    const dropped = new Promise<string>((resolve) => victim.socket.once("disconnect", resolve));
    const friendChanged = next<unknown>(friend, "friend:changed");
    const purge = next<{ userId: string }>(other, "chat:purge", (e) => e.userId === victim.id);
    const roomGone = next<RoomSummary[]>(other, "rooms:list", (l) => !l.some((r) => r.id === room.id), 6000);

    const res = await ack<{ username: string }>(admin, "admin:deleteUser", { userId: victim.id });
    assert.ok(res.ok, errorOf(res));
    assert.equal(res.username, victim.name);

    await told;
    assert.equal(await dropped, "io server disconnect");
    await friendChanged;
    await purge;
    await roomGone;

    const rows = await pool.query<{ users: number; messages: number; friendships: number }>(
      `SELECT (SELECT count(*)::int FROM users WHERE id = $1) AS users,
              (SELECT count(*)::int FROM chat_messages WHERE sender_id = $1 OR channel = $2 OR channel LIKE $3) AS messages,
              (SELECT count(*)::int FROM friendships WHERE requester_id = $1 OR addressee_id = $1) AS friendships`,
      [victim.id, `support:${victim.id}`, `dm:%${victim.id}%`],
    );
    assert.deepEqual(rows.rows[0], { users: 0, messages: 0, friendships: 0 });

    const friendList = await ack<{ friends: { id: string }[] }>(friend, "friend:list", {});
    assert.ok(friendList.ok && !friendList.friends.some((f) => f.id === victim.id));
  });

  test("token cũ của tài khoản đã xoá không kết nối và không gọi API được", async () => {
    const token = signToken(victim.id, 0);
    const stale = io(SERVER, { auth: { token }, parser: msgpackParser, transports: ["websocket"], reconnection: false });
    const err = await new Promise<Error>((resolve) => stale.on("connect_error", resolve));
    stale.disconnect();
    assert.equal(err.message, "unauthorized");
    const me = await fetch(`${SERVER}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 401);
  });

  test("xoá người đang trong trận: bị đưa ra khỏi trận và đăng xuất, máy chủ vẫn chạy", async () => {
    const player = await newPlayer("m");
    const started = next<{ matchId: string }>(player, "match:start", () => true, 10000);
    player.socket.emit("bot:start", { map: "vanlang" });
    await started;
    const told = next<unknown>(player, "account:deleted");
    const res = await ack<{ username: string }>(admin, "admin:deleteUser", { userId: player.id });
    assert.ok(res.ok, errorOf(res));
    await told;
    const search = await ack<{ users: { id: string }[] }>(admin, "user:search", { q: player.name });
    assert.ok(search.ok && search.users.length === 0, "tài khoản đã xoá không còn trong kết quả tìm kiếm");
  });

  test("trận kết thúc sau khi có người bị xoá vẫn lưu kết quả cho những người còn lại", async () => {
    const id = randomUUID();
    matchIds.push(id);
    const now = new Date();
    await saveMatch({
      id,
      mode: "bots",
      mapId: "vanlang",
      playerCount: 2,
      teamSize: 1,
      winnerName: other.name,
      startedAt: new Date(now.getTime() - 60_000),
      endedAt: now,
      players: [
        { userId: other.id, placement: 1, kills: 1, damage: 50, survivalMs: 60_000, xpGained: 10 },
        { userId: victim.id, placement: 2, kills: 0, damage: 0, survivalMs: 30_000, xpGained: 5 },
      ],
    });
    const saved = await pool.query<{ user_id: string }>("SELECT user_id FROM match_players WHERE match_id = $1", [id]);
    assert.deepEqual(saved.rows.map((r) => r.user_id), [other.id]);
  });
});
