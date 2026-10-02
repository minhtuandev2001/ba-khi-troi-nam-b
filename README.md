# Bá Khí - Trời Nam 2D: Backend

Máy chủ cho game battle royale 2D: REST API (tài khoản, hồ sơ, thống kê, lịch sử) và Socket.IO (ghép trận, phòng, mô phỏng trận đấu). Server có toàn quyền quyết định kết quả, tick 30 Hz, gửi trạng thái 15 Hz.

Dùng Node.js 22.9 trở lên, Express 5, Socket.IO 4, PostgreSQL, TypeScript (chạy dev bằng tsx, build bằng esbuild).

## Chạy khi phát triển

```bash
cp .env.example .env   # rồi điền DATABASE_URL và JWT_SECRET
npm install
npm run dev            # http://localhost:3001
```

Bảng trong cơ sở dữ liệu được tạo tự động khi server khởi động. Cũng có thể tạo riêng bằng `npm run migrate`.

Kiểm tra kiểu: `npm run typecheck`.

## Deploy

Cần nền tảng hỗ trợ WebSocket và chạy liên tục (Render, Railway, Fly.io, VPS...), không dùng serverless. Server giữ trạng thái trận đấu trong bộ nhớ, nên chỉ chạy **một instance**.

| Mục | Giá trị |
| --- | --- |
| Build | `npm ci && npm run build`, tạo ra một file `dist/index.js` |
| Start | `npm start` |
| Health check | `GET /api/health` |

Biến môi trường:

| Biến | Ý nghĩa |
| --- | --- |
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL |
| `JWT_SECRET` | Chuỗi ngẫu nhiên dài để ký token |
| `PORT` | Cổng lắng nghe, mặc định 3001 (thường do nền tảng tự đặt) |
| `CLIENT_ORIGIN` | Domain của frontend, ví dụ `https://game.example.com`. Nhiều domain thì cách nhau bằng dấu phẩy |

Bước build cần các gói devDependencies (`esbuild`, `typescript`), nên đừng cài với `--omit=dev` ở bước này. File `.env` không bắt buộc, có biến môi trường của nền tảng là đủ.

## Cấu trúc

```
src/index.ts        Express + Socket.IO, CORS, helmet
src/routes.ts       REST: /api/auth/register, /api/auth/login, /api/me, /api/me/stats, /api/me/history, /api/rooms/:id
src/db.ts           PostgreSQL: schema, truy vấn, lưu kết quả trận (có thử lại khi mất kết nối)
src/auth.ts         bcrypt, JWT
src/game/GameServer.ts  xác thực socket, ghép trận, chế độ bot, phòng bạn bè, kết nối lại
src/game/Match.ts   mô phỏng trận: di chuyển, bắn, nhặt đồ, nhà, bo, thính, rương, lựu đạn, khói, xếp hạng
src/game/Bot.ts     AI của bot
src/shared/         hằng số, vật phẩm, bản đồ, va chạm, giao thức mạng
```

`src/shared` có một bản giống hệt trong project frontend. Hai bên dùng chung giao thức mạng, cùng sinh bản đồ từ một seed và cùng tính va chạm để dự đoán di chuyển, nên khi sửa một file trong `src/shared` thì phải sửa y hệt ở frontend.

## Chế độ chơi

| Chế độ | Cách hoạt động |
| --- | --- |
| Ghép trận | Chờ đủ 10 người. Sau 3 phút sẽ báo chế độ đang ít người và gợi ý đổi chế độ, nhưng vẫn cho chờ tiếp. |
| Đấu với bot | Người chơi và 9 bot, vào trận ngay. |
| Phòng bạn bè | Mã phòng là UUID. Từ 2 đến 10 người (bot cũng tính). Chủ phòng thêm bot và bấm bắt đầu. Chủ phòng rời đi thì quyền chủ phòng chuyển cho người khác. |

Mỗi server mở tối đa 50 trận và 100 phòng cùng lúc.

## Thông số thiết kế

**Bản đồ:** 4800 × 4800 px, gồm 16 ngôi nhà nhiều phòng, khoảng 230 cây, 110 tảng đá, 55 bức tường và các rương đồ. Người ngoài không nhìn thấy người trong nhà, người ở hai phòng khác nhau cũng không thấy nhau.

**Nhân vật:** 200 máu, tốc độ 230 px/s (chậm hơn khi cầm súng nặng, còn một nửa khi đang dùng túi cứu thương). Xuất hiện tay không, ở vị trí cách tường và cách người khác ít nhất 450 px.

**Vũ khí** (mỗi loại súng dùng một loại đạn riêng):

| Vũ khí | Sát thương | Tốc độ bắn | Băng đạn | Thay đạn | Tầm bắn | Đạn |
| --- | --- | --- | --- | --- | --- | --- |
| Tay không | 18 | 2.2/s | – | – | cận chiến | – |
| Dao | 34 | 2.5/s | – | – | cận chiến | – |
| Súng lục | 24 | 5/s | 15 | 1.6 s | 650 | 9mm |
| Súng trường | 28 | 9.5/s | 30 | 2.4 s | 950 | 5.56mm |
| Shotgun | 9 × 14 viên | 1.2/s | 5 | 2.8 s | 380 | 12 Gauge |
| Súng bắn tỉa | 140 | 0.75/s | 5 | 3.2 s | 1900 | 7.62mm |

Mang tối đa 2 súng chính, cộng thêm 1 súng lục và 1 vũ khí cận chiến. Sát thương giảm dần theo khoảng cách.

**Giáp:** cấp 1 giảm 25% sát thương (độ bền 60), cấp 2 giảm 40% (độ bền 90), cấp 3 giảm 55% (độ bền 130). Giáp không chặn sát thương của bo.

**Túi đồ** (sức chứa tối đa):

| Túi | 9mm | 5.56 | 12G | 7.62 | Cứu thương | Lựu đạn | Khói |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Không có | 60 | 90 | 20 | 15 | 2 | 1 | 1 |
| Cấp 1 | 120 | 180 | 40 | 30 | 4 | 2 | 2 |
| Cấp 2 | 180 | 240 | 60 | 45 | 6 | 3 | 3 |
| Cấp 3 | 240 | 300 | 80 | 60 | 8 | 4 | 4 |

**Vật phẩm tiêu hao:** túi cứu thương hồi 75 máu trong 3 giây. Lựu đạn ném xa tối đa 450 px, nổ sau 2.5 giây, bán kính 170 px, sát thương từ 130 (ở tâm) giảm còn 25 (ở rìa). Bom khói tạo vùng khói bán kính 210 px trong 15 giây, che tầm nhìn của cả người chơi lẫn bot.

**Ống nhắm:** x2, x3, x4, x6, x8 mở rộng tầm nhìn lần lượt 1.15, 1.3, 1.45, 1.7 và 2 lần. Ngay cả x8 cũng không thấy hết bản đồ.

**Vòng bo** (khoảng 14 phút, 6 giai đoạn):

| Giai đoạn | Chờ | Thu nhỏ | Bán kính còn lại | Sát thương/giây |
| --- | --- | --- | --- | --- |
| 1 | 150 s | 75 s | 32% | 2 |
| 2 | 120 s | 60 s | 20% | 4 |
| 3 | 90 s | 50 s | 12% | 7 |
| 4 | 75 s | 45 s | 6.5% | 10 |
| 5 | 60 s | 40 s | 2.5% | 15 |
| 6 | 45 s | 30 s | 0 | 25 |

**Thính:** cứ 3 phút rơi một lần, được báo trên bản đồ trước 20 giây, luôn rơi bên trong vòng bo kế tiếp. Bên trong có ống nhắm x6 hoặc x8, giáp cấp 3 và súng bắn tỉa.

**Rương:** mở bằng cách đánh tay không hoặc bắn cho nổ (60 máu). Bên trong ngẫu nhiên có lựu đạn, giáp cấp 3, ống nhắm x4, túi cứu thương hoặc súng trường.

**Kết thúc trận:** người còn sống cuối cùng thắng. Nếu nhiều người chết gần như cùng lúc, thứ hạng xếp theo thời điểm chết tính đến mili giây, trùng thì chọn ngẫu nhiên. Người rời trận khi còn sống bị tính là đã chết. Người bị mất kết nối thì nhân vật đứng yên tại chỗ và có thể vào lại trận.

## Chống gian lận

- Server giữ toàn bộ trạng thái và tự tính đạn, sát thương, nhặt đồ. Client chỉ gửi phím bấm và hướng ngắm.
- Mỗi người chỉ nhận dữ liệu về những gì mình được phép thấy (trong tầm nhìn, không bị nhà hay khói che), nên hack nhìn xuyên tường không có tác dụng.
- Giới hạn tần suất input và mọi sự kiện socket, giới hạn số lần đăng nhập, mỗi tài khoản chỉ được kết nối một phiên.
- Mật khẩu băm bằng bcrypt, xác thực bằng JWT, có helmet và kiểm tra dữ liệu đầu vào bằng zod.

## Tài khoản

- Tên đăng nhập dài 3–16 ký tự, bắt đầu bằng chữ cái, chỉ gồm chữ, số và dấu `_`.
- Mật khẩu dài 8–64 ký tự, phải có chữ hoa, chữ thường, số và ký tự đặc biệt, không chứa khoảng trắng và không chứa tên đăng nhập.
- Thống kê gồm số trận, số trận thắng, số người đã hạ, sát thương, thứ hạng trung bình và thời gian sống. Lịch sử lưu chế độ, thứ hạng, số người hạ và thời gian của từng trận. Cấp độ tăng theo XP và không ảnh hưởng đến lối chơi.
