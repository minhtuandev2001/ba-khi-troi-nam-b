/**
 * Profanity filter against the running server: chat masking, the original kept for admins, auto-mute,
 * and refused room/user names.
 *
 * Needs the server up (npm run dev) and the same database: node --env-file-if-exists=.env --import tsx --test test/chatFilter.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import * as msgpackParser from "socket.io-msgpack-parser";
import { ADMIN_USERNAME } from "../src/adminAccount";
import { signToken } from "../src/auth";
import { createUser, findUserByName, pool } from "../src/db";
import { ROOM_NAME_PROFANE, type ChatMessage, type SocialAck } from "../src/shared";

const SERVER =
  process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString("hex");
/** The world channel lets one message through every 2 s once the small burst is spent. */
const WORLD_GAP_MS = 2100;

interface Player {
  id: string;
  name: string;
  socket: Socket;
}

let sender: Player;
let reader: Player;
let admin: Player;
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

type SendAck = SocialAck<{ message: ChatMessage; warn?: string }>;

function send(p: Player, text: string): Promise<SendAck> {
  return p.socket.timeout(5000).emitWithAck("chat:send", { text });
}

async function say(p: Player, text: string) {
  const res = await send(p, text);
  assert.ok(res.ok, `gửi tin lỗi: ${"error" in res ? res.error : ""}`);
  return res;
}

async function history(p: Player): Promise<ChatMessage[]> {
  const res: SocialAck<{ messages: ChatMessage[] }> = await p.socket.timeout(5000).emitWithAck("chat:history", {});
  assert.ok(res.ok);
  return res.messages;
}

before(async () => {
  for (const suffix of ["s", "r"]) {
    const row = await createUser(`zf${TAG}${suffix}`, "x", "🐭");
    assert.ok(row);
    createdIds.push(row.id);
  }
  sender = await open(createdIds[0], `zf${TAG}s`);
  reader = await open(createdIds[1], `zf${TAG}r`);
  const adminRow = await findUserByName(ADMIN_USERNAME);
  assert.ok(adminRow, "chưa có tài khoản admin, server chưa chạy migrate?");
  admin = await open(adminRow.id, adminRow.username, adminRow.token_version);
});

after(async () => {
  for (const p of [sender, reader, admin]) p?.socket.disconnect();
  // chat_messages cascade with their sender
  if (createdIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdIds]);
  const left = await pool.query<{ n: number }>(
    "SELECT (SELECT count(*) FROM users WHERE id = ANY($1::uuid[])) + (SELECT count(*) FROM chat_messages WHERE sender_id = ANY($1::uuid[])) AS n",
    [createdIds],
  );
  assert.equal(Number(left.rows[0].n), 0, "còn sót dữ liệu test");
  await pool.end();
});

describe("bộ lọc từ ngữ tục tĩu (cần server đang chạy)", () => {
  let maskedId = "";

  test("tin tục bị che với người thường, admin thấy bản gốc, người gửi bị cảnh báo", async () => {
    const original = `đm vcl ${TAG}`;
    const toReader = next<ChatMessage>(reader, "chat:msg", (m) => m.from.id === sender.id);
    const toAdmin = next<ChatMessage>(admin, "chat:msg", (m) => m.from.id === sender.id);
    const res = await say(sender, original);
    assert.ok(res.ok);
    assert.equal(res.message.text, `** *** ${TAG}`);
    assert.equal(res.message.raw, undefined, "người gửi không cần bản gốc");
    assert.match(res.warn ?? "", /Thêm 2 lần/);
    maskedId = res.message.id;

    const seen = await toReader;
    assert.equal(seen.text, `** *** ${TAG}`);
    assert.equal(seen.raw, undefined, "người thường không được thấy bản gốc");
    const adminSeen = await toAdmin;
    assert.equal(adminSeen.text, `** *** ${TAG}`);
    assert.equal(adminSeen.raw, original);
  });

  test("tin bình thường giữ nguyên, không cảnh báo, không kèm bản gốc", async () => {
    const text = `các bạn ơi buổi tối vào phòng ${TAG}`;
    const toAdmin = next<ChatMessage>(admin, "chat:msg", (m) => m.from.id === sender.id);
    const res = await say(sender, text);
    assert.ok(res.ok);
    assert.equal(res.message.text, text);
    assert.equal(res.warn, undefined);
    const adminSeen = await toAdmin;
    assert.equal(adminSeen.raw, undefined);
  });

  test("lịch sử chỉ trả bản gốc cho admin", async () => {
    const forReader = (await history(reader)).find((m) => m.id === maskedId);
    assert.ok(forReader, "lịch sử thiếu tin vừa gửi");
    assert.equal(forReader.raw, undefined);
    const forAdmin = (await history(admin)).find((m) => m.id === maskedId);
    assert.ok(forAdmin);
    assert.equal(forAdmin.raw, `đm vcl ${TAG}`);
  });

  test("bị che 3 lần trong 10 phút thì tự động cấm chat", async () => {
    const second = await say(sender, `vcl lần hai ${TAG}`);
    assert.ok(second.ok);
    assert.match(second.warn ?? "", /Thêm 1 lần/);

    await sleep(WORLD_GAP_MS);
    const muted = next<{ until: string | null; auto: boolean }>(sender, "chat:muted");
    const third = await say(sender, `địt lần ba ${TAG}`);
    assert.ok(third.ok);
    assert.equal(third.warn, undefined, "lần thứ ba cấm luôn thay vì cảnh báo");
    const event = await muted;
    assert.equal(event.auto, true);
    assert.ok(event.until && Date.parse(event.until) > Date.now() + 14 * 60_000, "phải cấm khoảng 15 phút");

    await sleep(WORLD_GAP_MS);
    const blocked = await send(sender, `xin chào ${TAG}`);
    assert.equal(blocked.ok, false);
    assert.match("error" in blocked ? blocked.error : "", /cấm chat/);
  });

  test("tên phòng tục bị từ chối", async () => {
    const error = next<{ text: string }>(reader, "error:msg");
    reader.socket.emit("room:create", { teamSize: 1, name: "Phòng đm" });
    assert.equal((await error).text, ROOM_NAME_PROFANE);
  });

  test("đăng ký tên tục bị từ chối", async () => {
    const res = await fetch(`${SERVER}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `DitMe_${TAG.slice(0, 4)}`, password: `Kiem-Tra-${TAG}-9x`, fillMs: 3000 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /không phù hợp/);
  });
});
