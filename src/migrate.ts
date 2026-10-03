import { migrate, pool } from './db';

const applied = await migrate();
console.log(applied.length ? `Đã tạo / cập nhật bảng và chạy ${applied.length} migration mới.` : 'Đã tạo / cập nhật bảng, không có migration mới.');
await pool.end();
