/** Unit tests for picking up loot: the auto-pickup setting and clicking an item; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, type Participant } from '../src/game/Match';
import { PICKUP_RANGE } from '../src/shared';

const people: Participant[] = [
  { userId: 'u1', name: 'Người', avatar: '🐯', level: 1, isBot: false },
  { userId: null, name: 'Bot 1', avatar: '🐭', level: 1, isBot: true },
];
const noop = { onEnd() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openDirection(m: Match, x: number, y: number, dist: number): number {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    if (m.world.lineClear(x, y, x + Math.cos(a) * dist, y + Math.sin(a) * dist)) return a;
  }
  throw new Error('không tìm được hướng trống');
}

describe('nhặt đồ', () => {
  test('người chơi mặc định không tự nhặt, bot thì có', () => {
    const m = new Match('p1', 'bots', people, noop, 'coloa', 1, 1, 0);
    try {
      assert.equal(m.players[0].autoPickup, false);
      assert.equal(m.players[1].autoPickup, true);
    } finally {
      m.dispose();
    }
  });

  test('tắt tự nhặt thì đi qua không nhặt, bật lên thì nhặt', async () => {
    const m = new Match('p2', 'bots', people, noop, 'coloa', 1, 1, 0);
    try {
      const me = m.players[0];
      const first = m.spawnLoot('medkit', me.x, me.y);
      await sleep(250);
      assert.ok(m.loot.has(first.id), 'tự nhặt dù đang tắt');
      assert.equal(me.med, 0);

      m.handleAction(0, { t: 'autoPickup', on: true });
      await sleep(250);
      assert.ok(!m.loot.has(first.id), 'bật tự nhặt mà không nhặt');
      assert.equal(me.med, 1);

      m.handleAction(0, { t: 'autoPickup', on: false });
      const second = m.spawnLoot('medkit', me.x, me.y);
      await sleep(250);
      assert.ok(m.loot.has(second.id), 'tắt lại mà vẫn tự nhặt');
    } finally {
      m.dispose();
    }
  });

  test('bấm vào món đồ trong tầm thì nhặt đúng món đó, ngoài tầm thì không', () => {
    const m = new Match('p3', 'bots', people, noop, 'coloa', 1, 1, 0);
    try {
      const me = m.players[0];
      const a = openDirection(m, me.x, me.y, PICKUP_RANGE + 60);
      const at = (d: number) => [me.x + Math.cos(a) * d, me.y + Math.sin(a) * d] as const;
      const near = m.spawnLoot('medkit', ...at(PICKUP_RANGE - 10));
      const other = m.spawnLoot('smoke', ...at(PICKUP_RANGE - 20));
      const far = m.spawnLoot('medkit', ...at(PICKUP_RANGE + 40));

      m.handleAction(0, { t: 'pickup', id: near.id });
      assert.ok(!m.loot.has(near.id), 'không nhặt được món đã bấm');
      assert.ok(m.loot.has(other.id), 'nhặt nhầm món bên cạnh');
      assert.equal(me.med, 1);

      m.handleAction(0, { t: 'pickup', id: far.id });
      assert.ok(m.loot.has(far.id), 'nhặt được đồ ngoài tầm');
      m.handleAction(0, { t: 'pickup', id: 99_999 });
    } finally {
      m.dispose();
    }
  });
});
