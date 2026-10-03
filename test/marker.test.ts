/** Unit tests for map markers: who sees them, input checks and removal; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, type Participant, type Player } from '../src/game/Match';
import type { MapId, MarkerNet, SnapshotMsg } from '../src/shared';

const MAP: MapId = 'coloa';
const noop = { onEnd() {} };

const human = (id: string, team?: number): Participant => ({ userId: id, name: id, avatar: '🐯', level: 1, isBot: false, team });
const bot = (team?: number): Participant => ({ userId: null, name: 'Bot', avatar: '🐭', level: 1, isBot: true, team });

/** Gives every human a fake socket that keeps their latest snapshot. */
function watch(m: Match): Map<number, SnapshotMsg> {
  const latest = new Map<number, SnapshotMsg>();
  for (const p of m.players) {
    if (p.isBot) continue;
    p.connected = true;
    p.socket = { emit: (event: string, snap: SnapshotMsg) => event === 'snap' && latest.set(p.pid, snap) } as unknown as Player['socket'];
  }
  return latest;
}

function markersFor(m: Match, latest: Map<number, SnapshotMsg>, pid: number): MarkerNet[] {
  (m as unknown as { sendSnapshots(): void }).sendSnapshots();
  return latest.get(pid)?.mk ?? [];
}

describe('cắm cờ đánh dấu trên bản đồ', () => {
  test('đấu nhóm: cả đội thấy cờ của nhau, đội khác không thấy', () => {
    const m = new Match('mk1', 'private', [human('a', 0), human('b', 0), human('c', 1), bot(1)], noop, MAP, 1, 2, 0);
    try {
      const snaps = watch(m);
      m.handleAction(0, { t: 'mark', x: 1200, y: 900 });
      m.handleAction(2, { t: 'mark', x: 300, y: 400 });
      assert.deepEqual(markersFor(m, snaps, 0), [[0, 1200, 900]]);
      assert.deepEqual(markersFor(m, snaps, 1), [[0, 1200, 900]], 'đồng đội không thấy cờ');
      assert.deepEqual(markersFor(m, snaps, 2), [[2, 300, 400]], 'đội khác thấy cờ, hoặc mất cờ của mình');

      m.handleAction(1, { t: 'mark', x: 50, y: 60 });
      assert.deepEqual(markersFor(m, snaps, 0), [[0, 1200, 900], [1, 50, 60]]);
      m.handleAction(0, { t: 'mark', x: 700, y: 800 });
      assert.deepEqual(markersFor(m, snaps, 1), [[0, 700, 800], [1, 50, 60]], 'cắm chỗ khác không dời cờ cũ');
    } finally {
      m.dispose();
    }
  });

  test('đấu đơn: chỉ mình thấy cờ của mình', () => {
    const m = new Match('mk2', 'bots', [human('a'), human('b'), bot()], noop, MAP, 1, 1, 0);
    try {
      const snaps = watch(m);
      m.handleAction(0, { t: 'mark', x: 1000, y: 1000 });
      assert.deepEqual(markersFor(m, snaps, 0), [[0, 1000, 1000]]);
      assert.deepEqual(markersFor(m, snaps, 1), []);
      assert.equal(snaps.get(1)?.mk, undefined, 'snapshot gửi kèm danh sách cờ rỗng');
    } finally {
      m.dispose();
    }
  });

  test('bỏ qua toạ độ sai, kẹp vào trong bản đồ, gỡ được cờ', () => {
    const m = new Match('mk3', 'bots', [human('a'), bot()], noop, MAP, 1, 1, 0);
    try {
      const snaps = watch(m);
      const size = m.map.size;
      m.handleAction(0, { t: 'mark', x: Number.NaN, y: 5 });
      m.handleAction(0, { t: 'mark', x: 'abc', y: 5 } as never);
      m.handleAction(0, { t: 'mark' } as never);
      assert.deepEqual(markersFor(m, snaps, 0), []);
      m.handleAction(0, { t: 'mark', x: -500, y: size + 999.6 });
      assert.deepEqual(markersFor(m, snaps, 0), [[0, 0, size]]);
      m.handleAction(0, { t: 'mark', x: '120.4', y: 80.6 } as never);
      assert.deepEqual(markersFor(m, snaps, 0), [[0, 120, 81]]);
      m.handleAction(0, { t: 'unmark' });
      assert.deepEqual(markersFor(m, snaps, 0), []);
    } finally {
      m.dispose();
    }
  });

  test('cắm được cờ trong phòng chờ và cả khi đã bị loại; người rời trận thì cờ biến mất', () => {
    const m = new Match('mk4', 'private', [human('a', 0), human('b', 0), human('c', 1)], noop, MAP, 1, 2, 30_000);
    try {
      const snaps = watch(m);
      assert.equal(m.inLobby, true);
      m.handleAction(0, { t: 'mark', x: 500, y: 500 });
      assert.deepEqual(markersFor(m, snaps, 1), [[0, 500, 500]]);
      m.players[0].alive = false;
      m.handleAction(0, { t: 'mark', x: 600, y: 600 });
      assert.deepEqual(markersFor(m, snaps, 1), [[0, 600, 600]]);
      m.players[0].left = true;
      assert.deepEqual(markersFor(m, snaps, 1), []);
    } finally {
      m.dispose();
    }
  });
});
