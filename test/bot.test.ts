/** Unit tests for how bots pick targets in team matches; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, type Participant, type Player } from '../src/game/Match';
import { BOT_HUMAN_GRACE_MS, type MapId } from '../src/shared';

const MAP: MapId = 'coloa';
const people: Participant[] = [
  { userId: 'u1', name: 'Người', avatar: '🐯', level: 1, isBot: false, team: 0 },
  { userId: null, name: 'Bot đồng đội', avatar: '🐭', level: 1, isBot: true, team: 0 },
  { userId: null, name: 'Bot đồng đội 2', avatar: '🐭', level: 1, isBot: true, team: 0 },
  { userId: null, name: 'Bot địch', avatar: '🐭', level: 1, isBot: true, team: 1 },
];
const noop = { onEnd() {} };

/** Runs one decision step of `p`'s bot right now and returns the pid it aims at (-1 for none). */
function think(m: Match, p: Player): number {
  const bot = p.bot as unknown as { nextThink: number; target: number };
  bot.nextThink = 0;
  p.bot!.update(m, p);
  return bot.target;
}

describe('bot trong trận đấu đội', () => {
  test('không nhắm vào đồng đội, kể cả người chơi đã bắn nhầm nó', () => {
    const m = new Match('b1', 'private', people, noop, MAP, 1, 2, 0);
    try {
      // past the opening grace period, when bots start hunting humans
      (m as unknown as { simTime: number }).simTime = BOT_HUMAN_GRACE_MS + 1;
      const [me, mate, mate2, foe] = m.players;
      const c = m.map.size / 2;
      for (const p of m.players) p.room = -1;
      Object.assign(mate, { x: c, y: c });
      Object.assign(me, { x: c + 60, y: c });
      Object.assign(mate2, { x: c, y: c + 80 });
      Object.assign(foe, { x: c + 5000, y: c + 5000 });

      m.applyDamage(mate, 10, me, 'pistol');
      assert.equal(mate.hp, 200, 'đồng đội bắn trúng vẫn mất máu');
      assert.equal(think(m, mate), -1, 'bot nhắm vào đồng đội');
      assert.equal(mate.fire, false);

      Object.assign(foe, { x: c - 150, y: c });
      assert.equal(think(m, mate), foe.pid, 'bot không nhắm vào địch ở gần');
      assert.equal(think(m, foe), mate.pid, 'bot địch không nhắm vào đội kia');
    } finally {
      m.dispose();
    }
  });

  test('đấu đơn: bot vẫn coi mọi người khác là địch', () => {
    const solo = people.map(({ team: _team, ...p }) => p);
    const m = new Match('b2', 'bots', solo, noop, MAP, 1, 1, 0);
    try {
      const [, a, b] = m.players;
      const c = m.map.size / 2;
      for (const p of m.players) p.room = -1;
      Object.assign(m.players[0], { x: c + 5000, y: c + 5000 });
      Object.assign(m.players[3], { x: c - 5000, y: c - 5000 });
      Object.assign(a, { x: c, y: c });
      Object.assign(b, { x: c + 100, y: c });
      assert.notEqual(a.team, b.team);
      assert.equal(think(m, a), b.pid);
    } finally {
      m.dispose();
    }
  });
});
