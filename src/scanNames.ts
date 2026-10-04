import { pool } from './db';
import { nameHasProfanity } from './shared';

/** Read only: lists accounts whose name the profanity filter would refuse today (it only checks new sign-ups). */
const { rows } = await pool.query<{ username: string; created_at: Date; last_login_at: Date | null; chat_muted_until: Date | null }>(
  'SELECT username, created_at, last_login_at, chat_muted_until FROM users ORDER BY created_at',
);
const flagged = rows.filter((r) => nameHasProfanity(r.username));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');
console.log(`Đã quét ${rows.length} tài khoản, ${flagged.length} tên chứa từ ngữ không phù hợp.`);
for (const r of flagged) {
  const muted = r.chat_muted_until && r.chat_muted_until.getTime() > Date.now() ? ' · đang bị cấm chat' : '';
  console.log(`- ${r.username} · tạo ${day(r.created_at)} · đăng nhập gần nhất ${day(r.last_login_at)}${muted}`);
}
await pool.end();
