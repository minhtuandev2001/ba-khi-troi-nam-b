/**
 * The on-screen button layout each player saves: the sanitiser (no server needed) and the `/api/me/touch-layout`
 * endpoints against a running backend (`npm run dev`). The test user is removed afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { signToken } from '../src/auth';
import { createUser, pool } from '../src/db';
import { sanitizeTouchLayouts, TOUCH_SCALE_MAX, TOUCH_SCALE_MIN } from '../src/shared';

const SERVER = process.env.TEST_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const TAG = randomBytes(3).toString('hex');

describe('làm sạch bố cục nút', () => {
  test('bỏ kiểu màn hình, nút và giá trị lạ; kẹp cỡ trong giới hạn', () => {
    const out = sanitizeTouchLayouts({
      phone: {
        heal: { x: 0.5, y: 0.25, s: 1.6 },
        reload: { x: 2, y: 0.5 },
        grenade: { s: 99 },
        smoke: { s: 0.1 },
        map: { x: 0.3 },
        hack: { x: 0.5, y: 0.5 },
        scope: { s: 1 },
      },
      desktop: { heal: { x: 0.1, y: 0.1 } },
      port: 'nope',
    });
    assert.deepEqual(out, {
      phone: { heal: { x: 0.5, y: 0.25, s: 1.6 }, grenade: { s: TOUCH_SCALE_MAX }, smoke: { s: TOUCH_SCALE_MIN } },
    });
  });

  test('dữ liệu không phải object cho ra bố cục trống', () => {
    for (const raw of [null, undefined, 'x', 5, []]) assert.deepEqual(sanitizeTouchLayouts(raw), {});
  });

  test('số được làm tròn 4 chữ số để dữ liệu lưu gọn', () => {
    assert.deepEqual(sanitizeTouchLayouts({ land: { map: { x: 0.123456789, y: 0.987654321 } } }), { land: { map: { x: 0.1235, y: 0.9877 } } });
  });
});

describe('API lưu bố cục nút', () => {
  let userId = '';
  let token = '';

  const call = async (method: string, body?: unknown, auth = true) => {
    const res = await fetch(`${SERVER}/api/me/touch-layout`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as { layouts?: unknown; error?: string } };
  };

  before(async () => {
    const row = await createUser(`zl${TAG}`, 'x', '🐭');
    assert.ok(row);
    userId = row.id;
    token = signToken(row.id);
  });

  after(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    assert.equal(rows.length, 0, 'người dùng test chưa bị xoá');
    await pool.end();
  });

  test('chưa đăng nhập thì bị từ chối', async () => {
    assert.equal((await call('GET', undefined, false)).status, 401);
    assert.equal((await call('PUT', { layouts: {} }, false)).status, 401);
  });

  test('tài khoản mới chưa có bố cục', async () => {
    const r = await call('GET');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.layouts, {});
  });

  test('lưu rồi đọc lại đúng bố cục, phần lạ bị bỏ', async () => {
    const saved = await call('PUT', { layouts: { phone: { heal: { x: 0.7, y: 0.5, s: 1.6 }, evil: { x: 1, y: 1 } }, tv: {} } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.layouts, { phone: { heal: { x: 0.7, y: 0.5, s: 1.6 } } });
    const r = await call('GET');
    assert.deepEqual(r.data.layouts, { phone: { heal: { x: 0.7, y: 0.5, s: 1.6 } } });
    const { rows } = await pool.query('SELECT touch_layout FROM users WHERE id = $1', [userId]);
    assert.deepEqual(rows[0].touch_layout, { phone: { heal: { x: 0.7, y: 0.5, s: 1.6 } } });
  });

  test('lưu bố cục trống thì xoá hẳn, quay về mặc định', async () => {
    assert.equal((await call('PUT', { layouts: {} })).status, 200);
    const { rows } = await pool.query('SELECT touch_layout FROM users WHERE id = $1', [userId]);
    assert.equal(rows[0].touch_layout, null);
    assert.deepEqual((await call('GET')).data.layouts, {});
  });

  test('thân yêu cầu sai kiểu thì báo lỗi', async () => {
    for (const body of [{}, { layouts: 'x' }, { layouts: [1, 2] }]) {
      const r = await call('PUT', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });
});
