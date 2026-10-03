/**
 * Integration test for the numbered migrations and the built-in admin account against a running backend (`npm run dev`):
 * the migration is recorded and never re-applied, a new ADMIN_PASSWORD replaces the stored one and ends old admin
 * sessions, the admin can log in, and the admin flag reaches chat, rooms and the room list.
 * The admin's socket replaces any open admin session in a browser. The admin's real password and session version
 * are put back, and messages and test users are deleted afterwards.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { io, type Socket } from "socket.io-client";
import * as msgpackParser from "socket.io-msgpack-parser";
import { ADMIN_USERNAME, ensureAdminAccount } from "../src/adminAccount";
import { signToken, verifyPassword } from "../src/auth";
import { createUser, findUserByName, migrate, pool } from "../src/db";
import {
  validateUsername,
  type ChatMessage,
  type RoomStateMsg,
  type RoomSummary,
  type SocialAck,
} from "../src/shared";

const SERVER =
  process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString("hex");
const TEST_PASSWORD = `Kiem-Tra-${TAG}-9x`;

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

let admin: Player;
let user: Player;
const createdIds: string[] = [];
const messageIds: string[] = [];
let original: { id: string; password_hash: string; token_version: number } | null = null;

function next<T>(
  p: Player,
  event: string,
  accept: (v: T) => boolean = () => true,
  ms = 3000,
): Promise<T> {
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

async function say(p: Player, text: string): Promise<ChatMessage> {
  const res: SocialAck<{ message: ChatMessage }> = await p.socket
    .timeout(5000)
    .emitWithAck("chat:send", { text });
  assert.ok(res.ok, `gửi tin lỗi: ${"error" in res ? res.error : ""}`);
  messageIds.push(res.message.id);
  return res.message;
}

before(async () => {
  const row = await createUser(`za${TAG}u`, "x", "🐭");
  assert.ok(row);
  createdIds.push(row.id);
  user = await open(row.id, row.username);
  const adminRow = await findUserByName(ADMIN_USERNAME);
  assert.ok(adminRow, "chưa có tài khoản admin, server chưa chạy migrate?");
  original = { id: adminRow.id, password_hash: adminRow.password_hash, token_version: adminRow.token_version };
  admin = await open(adminRow.id, adminRow.username, adminRow.token_version);
});

after(async () => {
  admin?.socket.disconnect();
  user?.socket.disconnect();
  if (original)
    await pool.query(
      "UPDATE users SET password_hash = $2, token_version = $3 WHERE id = $1",
      [original.id, original.password_hash, original.token_version],
    );
  if (messageIds.length)
    await pool.query("DELETE FROM chat_messages WHERE id = ANY($1::bigint[])", [
      messageIds,
    ]);
  if (createdIds.length)
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      createdIds,
    ]);
  const left = await pool.query<{ n: number }>(
    "SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[])) + (SELECT count(*) FROM chat_messages WHERE id = ANY($2::bigint[])) AS n",
    [createdIds, messageIds],
  );
  assert.equal(Number(left.rows[0].n), 0, "còn sót dữ liệu test");
  await pool.end();
});

describe("migration và tài khoản admin", () => {
  test("migration 001 được ghi lại; chạy migrate lần nữa không áp dụng lại", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations",
    );
    assert.ok(rows.some((r) => r.id === "001_admin_account"));
    assert.deepEqual(await migrate(), []);
    const admins = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE lower(username) = $1 AND role = 'admin'",
      [ADMIN_USERNAME],
    );
    assert.equal(admins.rows[0].n, 1);
  });

  test("ADMIN_PASSWORD mới: đổi mật khẩu, giữ tài khoản, thu hồi token cũ; chạy lại khi đã khớp hoặc để trống thì không đổi", async () => {
    const before = await findUserByName(ADMIN_USERNAME);
    assert.ok(before);
    const oldToken = signToken(before.id, before.token_version);
    const me = (token: string) =>
      fetch(`${SERVER}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
    assert.equal(await me(oldToken), 200);

    const client = await pool.connect();
    try {
      assert.equal(await ensureAdminAccount(client, TEST_PASSWORD), "updated");
      assert.equal(await ensureAdminAccount(client, TEST_PASSWORD), "unchanged");
      assert.equal(await ensureAdminAccount(client, null), "unchanged");
    } finally {
      client.release();
    }
    const after = await findUserByName(ADMIN_USERNAME);
    assert.ok(after);
    assert.equal(after.id, before.id, "tạo tài khoản admin mới thay vì cập nhật");
    assert.equal(after.avatar, before.avatar);
    assert.equal(after.xp, before.xp);
    assert.equal(after.role, "admin");
    assert.equal(after.token_version, before.token_version + 1);
    assert.ok((await verifyPassword(TEST_PASSWORD, after.password_hash)).ok, "mật khẩu chưa đổi");

    assert.equal(await me(oldToken), 401, "token cũ vẫn dùng được");
    assert.equal(await me(signToken(after.id, after.token_version)), 200);
    const stale = io(SERVER, { auth: { token: oldToken }, parser: msgpackParser, transports: ["websocket"], reconnection: false });
    const err = await new Promise<Error>((resolve) => stale.on("connect_error", resolve));
    stale.disconnect();
    assert.equal(err.message, "unauthorized");
  });

  test("không ai đăng ký được tên admin", () => {
    assert.ok(validateUsername("admin").length > 0);
    assert.ok(validateUsername("Admin_2").length > 0);
  });

  test("đăng nhập admin bằng mật khẩu đã đặt, /me trả về role admin; người thường là user", async () => {
    const res = await fetch(`${SERVER}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: ADMIN_USERNAME,
        password: TEST_PASSWORD,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      token: string;
      user: { role: string };
    };
    assert.equal(body.user.role, "admin");
    const me = (await (
      await fetch(`${SERVER}/api/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      })
    ).json()) as { user: { role: string } };
    assert.equal(me.user.role, "admin");
    const other = (await (
      await fetch(`${SERVER}/api/me`, {
        headers: { authorization: `Bearer ${signToken(user.id)}` },
      })
    ).json()) as { user: { role: string } };
    assert.equal(other.user.role, "user");
  });

  test("tin nhắn của admin mang cờ admin, cả lúc gửi lẫn trong lịch sử; tin người thường thì không", async () => {
    const got = next<ChatMessage>(
      user,
      "chat:msg",
      (m) => m.from.id === admin.id,
    );
    const sent = await say(admin, `admin test ${TAG}`);
    assert.equal(sent.from.admin, true);
    assert.equal((await got).from.admin, true);
    const mine = await say(user, `user test ${TAG}`);
    assert.equal(mine.from.admin, undefined);
    const history: SocialAck<{ messages: ChatMessage[] }> = await user.socket
      .timeout(5000)
      .emitWithAck("chat:history", {});
    assert.ok(history.ok);
    assert.equal(
      history.messages.find((m) => m.id === sent.id)?.from.admin,
      true,
    );
  });

  test("phòng do admin tạo: thành viên và danh sách phòng đều có cờ admin", async () => {
    const first = next<RoomSummary[]>(user, "rooms:list");
    user.socket.emit("rooms:watch");
    await first;
    const listed = next<RoomSummary[]>(user, "rooms:list", (l) =>
      l.some((r) => r.host.name === admin.name),
    );
    const state = next<RoomStateMsg>(admin, "room:state");
    admin.socket.emit("room:create", {
      teamSize: 1,
      name: `Admin ${TAG}`,
      listed: true,
    });
    const s = await state;
    assert.equal(s.members.find((m) => m.id === admin.id)?.admin, true);
    assert.equal((await listed).find((r) => r.id === s.id)?.host.admin, true);
    const closed = next(admin, "room:closed");
    admin.socket.emit("room:leave");
    await closed;
  });
});
