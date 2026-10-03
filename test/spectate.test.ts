/** Unit tests for who the dead may watch in team matches; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, type Participant, type Player } from '../src/game/Match';
import type { MapId } from '../src/shared';

const MAP: MapId = 'coloa';
const noop = { onEnd() {} };
const human = (id: string, team: number): Participant => ({ userId: id, name: id, avatar: '🐯', level: 1, isBot: false, team });
const bot = (team: number): Participant => ({ userId: null, name: 'Bot', avatar: '🐭', level: 1, isBot: true, team });

/** Kills `victim` by `killer` and runs the end-of-tick death handling. */
function kill(m: Match, victim: Player, killer: Player) {
  const inner = m as unknown as { kill(p: Player, killer: number, w: string): void; resolveDeaths(): void };
  inner.kill(victim, killer.pid, 'bow');
  inner.resolveDeaths();
}

describe('xem trận sau khi bị loại (đấu nhóm)', () => {
  test('đội còn người: chỉ được xem đồng đội, mọi nút chuyển đều quay vòng trong đội', () => {
    // team 0: a, b, c · team 1: x, y
    const m = new Match('sp1', 'private', [human('a', 0), human('b', 0), bot(0), bot(1), bot(1)], noop, MAP, 1, 3, 0);
    try {
      const [a, b, c, x] = m.players;
      kill(m, a, x);
      assert.ok([b.pid, c.pid].includes(a.spectating), 'vừa chết không xem đồng đội');
      for (let i = 0; i < 6; i++) {
        m.spectate(a.pid, i % 2 ? 'next' : 'killer');
        assert.ok([b.pid, c.pid].includes(a.spectating), `lần ${i + 1} chuyển sang xem người ngoài đội`);
      }
      // the watched teammate falls: the view moves to the last one standing, not the enemy
      a.spectating = b.pid;
      kill(m, b, x);
      assert.equal(a.spectating, c.pid);
      assert.equal(b.spectating, c.pid);
      m.spectate(a.pid, 'killer');
      assert.equal(a.spectating, c.pid);
    } finally {
      m.dispose();
    }
  });

  test('cả đội bị diệt thì được xem người khác', () => {
    const m = new Match('sp2', 'private', [human('a', 0), bot(0), bot(1), bot(1), bot(2)], noop, MAP, 1, 2, 0);
    try {
      const [a, mate, x, y] = m.players;
      kill(m, a, x);
      assert.equal(a.spectating, mate.pid);
      kill(m, mate, y);
      assert.ok(m.players[a.spectating].alive && m.players[a.spectating].team !== a.team, 'đội bị diệt mà không được xem người khác');
      m.spectate(a.pid, 'killer');
      assert.equal(a.spectating, x.pid, 'không xem được người đã hạ mình');
      m.spectate(a.pid, 'next');
      assert.notEqual(m.players[a.spectating].team, a.team);
    } finally {
      m.dispose();
    }
  });

  test('góc nhìn lỡ rơi vào người đội khác thì tick sau được đưa về đồng đội', () => {
    const m = new Match('sp3', 'private', [human('a', 0), human('b', 0), bot(1), bot(1)], noop, MAP, 1, 2, 0);
    try {
      const [a, b, x] = m.players;
      kill(m, a, x);
      a.spectating = x.pid;
      (m as unknown as { tick(): void }).tick();
      assert.equal(a.spectating, b.pid);
    } finally {
      m.dispose();
    }
  });
});
