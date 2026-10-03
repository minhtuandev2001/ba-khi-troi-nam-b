/**
 * Empties every table of the database: accounts (admin included), matches, history, friends, chat, archives, job runs.
 * Tables and the record of applied migrations stay, then the admin account is created again with `ADMIN_PASSWORD`
 * (or, in development without it, a random password printed to the log).
 *
 *   npm run db:reset                  asks to type the confirmation phrase
 *   npm run db:reset -- --yes         no question (scripts, CI)
 *   npm run db:reset -- --production  also required when NODE_ENV=production
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { config } from './config';
import { migrate, pool } from './db';

const CONFIRM_PHRASE = 'XOA HET';
const args = new Set(process.argv.slice(2));

/** Host and database name only, never the credentials. */
function target(): string {
  try {
    const u = new URL(config.databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(không đọc được DATABASE_URL)';
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main(): Promise<number> {
  if (config.production && !args.has('--production')) {
    console.error('Đang chạy với NODE_ENV=production. Nếu chắc chắn muốn xoá sạch database thật, chạy lại kèm --production.');
    return 1;
  }

  const { rows } = await pool.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables
     WHERE schemaname = current_schema() AND tablename <> 'schema_migrations'
     ORDER BY tablename`,
  );
  if (!rows.length) {
    console.log('Database chưa có bảng nào, không có gì để xoá.');
    return 0;
  }

  console.log(`Database: ${target()}`);
  console.log('Sẽ xoá toàn bộ dữ liệu trong các bảng:');
  for (const { name } of rows) {
    const { rows: [c] } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${quote(name)}`);
    console.log(`  - ${name}: ${c.n} dòng`);
  }

  if (!args.has('--yes')) {
    if (!stdin.isTTY) {
      console.error('Không có terminal để hỏi xác nhận. Chạy lại kèm --yes nếu chắc chắn.');
      return 1;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`Thao tác KHÔNG hoàn tác được. Gõ "${CONFIRM_PHRASE}" để xác nhận: `);
    rl.close();
    if (answer.trim() !== CONFIRM_PHRASE) {
      console.log('Đã huỷ, không xoá gì.');
      return 1;
    }
  }

  await pool.query(`TRUNCATE ${rows.map((r) => quote(r.name)).join(', ')} RESTART IDENTITY CASCADE`);
  console.log(`Đã xoá sạch dữ liệu của ${rows.length} bảng.`);
  await migrate();
  console.log('Xong. Nên khởi động lại server đang chạy để xoá các phiên đăng nhập, phòng và trận còn trong bộ nhớ.');
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('Không xoá được database:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
