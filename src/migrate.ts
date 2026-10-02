import { migrate, pool } from './db';

await migrate();
console.log('Đã tạo / cập nhật bảng trong PostgreSQL.');
await pool.end();
