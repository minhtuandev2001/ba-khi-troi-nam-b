/** Unit tests for the pre-match waiting area of a match; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, type Participant } from '../src/game/Match';
import { PLAYER_RADIUS, type MapId } from '../src/shared';

const MAP: MapId = 'coloa';
const people: Participant[] = [
  { userId: 'u1', name: 'Người', avatar: '🐯', level: 1, isBot: false, team: 0 },
  { userId: null, name: 'Bot 1', avatar: '🐭', level: 1, isBot: true, team: 0 },
  { userId: null, name: 'Bot 2', avatar: '🐭', level: 1, isBot: true, team: 1 },
  { userId: null, name: 'Bot 3', avatar: '🐭', level: 1, isBot: true, team: 1 },
];
const noop = { onEnd() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('phòng chờ đầu trận', () => {
  test('mọi người tập trung giữa bản đồ, không nhặt được đồ, đồng hồ trận đứng yên', async () => {
    const m = new Match('t1', 'private', people, noop, MAP, 1, 2, 30_000);
    try {
      assert.equal(m.inLobby, true);
      const area = m.lobbyArea!;
      assert.deepEqual([area.x, area.y], [m.map.size / 2, m.map.size / 2]);
      assert.ok(area.r >= 1050, 'phòng chờ quá nhỏ');
      for (const p of m.players) assert.ok(Math.hypot(p.x - area.x, p.y - area.y) <= area.r, `${p.name} ở ngoài phòng chờ`);
      // put a piece of loot right under the human and try to pick it up
      const me = m.players[0];
      const loot = m.spawnLoot('medkit', me.x, me.y);
      m.handleAction(0, { t: 'interact' });
      assert.ok(m.loot.has(loot.id), 'nhặt được đồ trong phòng chờ');
      m.applyDamage(me, 0, null, 'zone');
      await sleep(150);
      assert.equal(m.now, 0);
      assert.equal(me.hp, 200);
    } finally {
      m.dispose();
    }
  });

  test('di chuyển bị giữ trong vòng tròn phòng chờ', async () => {
    const m = new Match('t2', 'private', people, noop, MAP, 1, 2, 30_000);
    try {
      const me = m.players[0];
      const area = m.lobbyArea!;
      // start a short run west of the edge, on a row with nothing in the way
      const x = area.x + area.r - 200;
      let y = area.y;
      for (let dy = 0; dy < area.r / 2; dy += 20) {
        const row = [area.y + dy, area.y - dy].find((yy) => !m.world.overlapsCircle(x, yy, PLAYER_RADIUS) && m.world.lineClear(x, yy, area.x + area.r + 100, yy));
        if (row !== undefined) {
          y = row;
          break;
        }
      }
      me.x = x;
      me.y = y;
      // no socket in a unit test: mark the player connected so the match reads their inputs
      me.connected = true;
      // 40 × 3 ticks of running east at full speed is far more than the 200 units to the edge
      for (let i = 0; i < 40; i++) {
        await sleep(40);
        for (let s = 0; s < 3; s++) m.handleInput(0, { s: me.lastSeq + 1 + s, mx: 1, my: 0, a: 0, f: true, td: 0 });
      }
      const d = Math.hypot(me.x - area.x, me.y - area.y);
      assert.ok(d <= area.r - PLAYER_RADIUS + 0.5, 'chạy ra khỏi phòng chờ');
      assert.ok(d >= area.r - PLAYER_RADIUS - 5, 'không chạy tới được mép phòng chờ');
      assert.ok(m.players.every((p) => p.alive && p.hp === 200));
    } finally {
      m.dispose();
    }
  });

  test('hết giờ thì vào trận: đồng hồ chạy, mọi người được đưa tới điểm xuất phát', async () => {
    const m = new Match('t3', 'private', people, noop, MAP, 1, 2, 100);
    try {
      const before = m.players.map((p) => ({ x: p.x, y: p.y }));
      await sleep(400);
      assert.equal(m.inLobby, false);
      assert.ok(m.now > 0);
      assert.ok(m.players.some((p, i) => Math.hypot(p.x - before[i].x, p.y - before[i].y) > 50), 'không ai được đưa đi');
    } finally {
      m.dispose();
    }
  });

  test('đấu bot và tập bắn không có phòng chờ', () => {
    const m = new Match('t4', 'bots', people, noop, MAP, 1, 1, 0);
    try {
      assert.equal(m.inLobby, false);
    } finally {
      m.dispose();
    }
  });
});
