/** Unit tests for the admin password rule, the login lockout and idle practice sessions; no server or database needed. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adminPasswordProblem } from '../src/config';
import { Match, TRAINING_IDLE_MS, type Participant } from '../src/game/Match';
import { LoginGuard } from '../src/security';
import { TRAINING_MAP } from '../src/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mật khẩu admin', () => {
  test('thiếu, ngắn, thiếu loại ký tự hoặc chứa "admin" đều bị từ chối', () => {
    assert.match(adminPasswordProblem(null) ?? '', /Thiếu/);
    assert.match(adminPasswordProblem('') ?? '', /Thiếu/);
    for (const weak of ['Demo@123', 'Ngan-1!a', 'khongcochuhoa-1!', 'KHONGCOCHUTHUONG-1!', 'Khong-Co-So!!', 'KhongCoKyTu123', 'Co Khoang-Trang1', 'Admin-Rat-Manh-2026!']) {
      assert.match(adminPasswordProblem(weak) ?? '', /quá yếu/, `${weak} lẽ ra phải bị chặn`);
    }
  });

  test('mật khẩu đủ mạnh được chấp nhận', () => {
    assert.equal(adminPasswordProblem('Rong-Vang-2026!'), null);
  });
});

describe('khoá đăng nhập', () => {
  test('sai nhiều lần chỉ khoá đúng tài khoản trên đúng địa chỉ đó', () => {
    const guard = new LoginGuard();
    for (let i = 0; i < 8; i++) guard.failed('admin', '1.1.1.1');
    assert.ok(guard.lockedFor('Admin', '1.1.1.1') > 0, 'kẻ dò mật khẩu chưa bị khoá');
    assert.equal(guard.lockedFor('admin', '2.2.2.2'), 0, 'chủ tài khoản ở nơi khác bị khoá lây');
    assert.equal(guard.lockedFor('nguoikhac', '1.1.1.1'), 0);
  });

  test('chưa đủ số lần thì không khoá, đăng nhập đúng thì xoá số lần sai', () => {
    const guard = new LoginGuard();
    for (let i = 0; i < 7; i++) guard.failed('nam', '3.3.3.3');
    assert.equal(guard.lockedFor('nam', '3.3.3.3'), 0);
    guard.succeeded('nam', '3.3.3.3');
    guard.failed('nam', '3.3.3.3');
    assert.equal(guard.lockedFor('nam', '3.3.3.3'), 0);
  });
});

describe('phòng tập treo máy', () => {
  const human: Participant[] = [{ userId: 'u1', name: 'Người', avatar: '🐯', level: 1, isBot: false }];

  function start() {
    const sent: [string, unknown][] = [];
    let ended = 0;
    const m = new Match('tr', 'training', human, { onEnd: () => void ended++ }, TRAINING_MAP);
    const me = m.players[0];
    me.socket = { emit: (event: string, data: unknown) => void sent.push([event, data]) } as never;
    me.connected = true;
    return { m, me, sent, ended: () => ended };
  }

  test('không thao tác quá lâu thì buổi tập tự đóng và báo cho người chơi', async () => {
    const { m, me, sent, ended } = start();
    try {
      me.lastActiveAt = m.now - TRAINING_IDLE_MS;
      await sleep(150);
      assert.equal(m.ended, true, 'buổi tập treo máy vẫn chạy');
      assert.equal(ended(), 1);
      const closed = sent.find(([e]) => e === 'match:closed');
      assert.ok(closed, 'người chơi không được báo');
      assert.match((closed[1] as { text: string }).text, /không thao tác/);
    } finally {
      m.dispose();
    }
  });

  test('di chuyển thì tính lại từ đầu, buổi tập vẫn chạy', async () => {
    const { m, me } = start();
    try {
      me.lastActiveAt = m.now - TRAINING_IDLE_MS + 30_000;
      m.handleInput(me.pid, { s: 1, mx: 1, my: 0, a: 0, f: false, td: 0 });
      assert.equal(me.lastActiveAt, m.now);
      await sleep(150);
      assert.equal(m.ended, false);
    } finally {
      m.dispose();
    }
  });
});
