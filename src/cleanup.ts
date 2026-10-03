import { pool } from './db';
import { describeCleanup, runCleanup } from './retention';

const result = await runCleanup(true);
console.log(result ? `Đã dọn dữ liệu: ${describeCleanup(result)}.` : 'Một server khác đang dọn dữ liệu, thử lại sau.');
await pool.end();
