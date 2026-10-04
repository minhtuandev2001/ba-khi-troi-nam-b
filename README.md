# Bá Khí - Trời Nam 2D: Backend

Máy chủ cho game battle royale 2D: REST API (tài khoản, hồ sơ, thống kê, lịch sử) và Socket.IO (ghép trận, phòng, mô phỏng trận đấu). Server có toàn quyền quyết định kết quả, tick 30 Hz, gửi trạng thái 15 Hz.

Dùng Node.js 22.9 trở lên, Express 5, Socket.IO 4, PostgreSQL, TypeScript (chạy dev bằng tsx, build bằng esbuild).

Phần mềm độc quyền, xem `LICENSE` ở thư mục gốc.

## Chạy khi phát triển

```bash
cp .env.example .env   # rồi điền DATABASE_URL và JWT_SECRET
npm install
npm run dev            # http://localhost:3001
```

Cơ sở dữ liệu được cập nhật tự động khi server khởi động. Cũng có thể chạy riêng bằng `npm run migrate`. Có ba bước:

1. Schema gốc trong `src/db.ts` (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), chạy lại bao nhiêu lần cũng được.
2. Các migration đánh số trong `src/migrations/`, mỗi cái chỉ chạy đúng một lần, theo thứ tự, và được ghi vào bảng `schema_migrations`. Tất cả chạy trong một transaction có khoá advisory, nên lỗi giữa chừng thì không ghi gì, và nhiều server khởi động cùng lúc cũng không chạy trùng. Thêm migration mới: tạo file `00N_ten.ts` có hàm `up(db)`, rồi thêm vào cuối danh sách trong `src/migrations/index.ts`. Đừng đổi tên hay sửa migration đã chạy.
3. Tài khoản admin (`src/adminAccount.ts`), chạy **mỗi lần** khởi động, trong cùng transaction với bước 2. Mật khẩu lấy từ biến `ADMIN_PASSWORD`, không có mật khẩu mặc định:
   - Chưa có tài khoản `admin` thì tạo (avatar 🐲) với `ADMIN_PASSWORD`. Khi dev mà chưa đặt biến này thì server tạo một mật khẩu ngẫu nhiên và in ra log một lần.
   - Đã có thì chỉ đổi mật khẩu khi `ADMIN_PASSWORD` khác mật khẩu đang lưu, đồng thời tăng `users.token_version` nên mọi phiên admin đăng nhập bằng mật khẩu cũ bị đăng xuất. Avatar, XP và lịch sử giữ nguyên. Không đặt biến (chỉ được khi dev) thì giữ nguyên mật khẩu đang có.
   - Vì vậy muốn đổi mật khẩu admin thì đổi `ADMIN_PASSWORD` rồi khởi động lại server.

| Migration | Nội dung |
| --- | --- |
| `001_admin_account` | Thêm cột `users.role` (`user` hoặc `admin`) |
| `002_retention` | Bảng `user_stats_archive` (thống kê cộng dồn của các trận đã bị job dọn dữ liệu xoá) và `job_runs` (lần chạy gần nhất của job) |
| `003_security` | Thêm cột `users.token_version` (tăng lên để thu hồi mọi token đã cấp của tài khoản) và `users.chat_muted_until` (admin cấm chat đến thời điểm này) |
| `004_touch_layout` | Thêm cột `users.touch_layout` (`jsonb`, bố cục nút cảm ứng người chơi tự chỉnh; `NULL` là dùng bố cục mặc định) |

### Dọn dữ liệu mỗi ngày

Job trong `src/retention.ts` chạy **24 giờ một lần** để database không phình ra:

| Dữ liệu | Giữ lại |
| --- | --- |
| Lịch sử trận | 20 trận gần nhất của mỗi người chơi |
| Chat thế giới | 100 tin gần nhất |
| Tin nhắn riêng | 150 tin gần nhất của mỗi cuộc trò chuyện |
| Chat hỗ trợ với admin | 150 tin gần nhất của mỗi người chơi |

- Trước khi xoá lịch sử, số trận, trận thắng, số người hạ, kỷ lục và tổng thứ hạng/thời gian sống của các trận bị xoá được cộng vào `user_stats_archive`, nên thống kê trong hồ sơ (`/api/me/stats`) vẫn tính trọn đời. Danh sách lịch sử (`/api/me/history`) chỉ còn tối đa 20 trận.
- Một trận chỉ bị xoá khỏi bảng `matches` khi không còn ai giữ nó trong 20 trận gần nhất.
- Server kiểm tra mỗi giờ (lần đầu sau khi khởi động 1 phút) và chỉ chạy khi lần chạy trước trong `job_runs` đã cách đủ 24 giờ, nên khởi động lại server không làm job chạy dồn. Tất cả nằm trong một transaction có khoá advisory: lỗi giữa chừng thì không xoá gì, và hai server không dọn cùng lúc.
- Chạy ngay bằng tay: `npm run cleanup` (không chờ đủ 24 giờ, và tính lại mốc 24 giờ từ lúc này).

### Xoá sạch database

`npm run db:reset` xoá **toàn bộ dữ liệu** trong mọi bảng (tài khoản kể cả admin, trận đấu, lịch sử, bạn bè, chat, thống kê lưu trữ, `job_runs`), giữ nguyên cấu trúc bảng và danh sách migration đã chạy, rồi tạo lại tài khoản `admin` với `ADMIN_PASSWORD` (chưa đặt thì mật khẩu ngẫu nhiên được in ra). Không hoàn tác được.

- Lệnh in ra database đích (chỉ host và tên database) cùng số dòng của từng bảng, rồi bắt gõ `XOA HET` để xác nhận. Gõ khác thì huỷ.
- `npm run db:reset -- --yes` bỏ qua câu hỏi (dùng trong script). Không có terminal để hỏi mà thiếu `--yes` thì lệnh từ chối.
- Khi `NODE_ENV=production` phải thêm `--production`, tránh lỡ tay xoá database thật.
- Nên tắt server trước khi chạy, hoặc khởi động lại sau đó, để xoá các phiên đăng nhập, phòng và trận còn trong bộ nhớ.

Kiểm tra kiểu: `npm run typecheck`.

Test (chat/bạn bè, chat hỗ trợ với admin, admin cấm chat và các giới hạn chống spam, giới hạn trận/phòng theo mạng, khoá đăng nhập, mật khẩu admin, phòng tập treo máy, nhóm ghép trận, phòng chia đội, danh sách phòng ở sảnh, migration và tài khoản admin, phòng chờ đầu trận, nhặt đồ, bot chọn mục tiêu, cờ đánh dấu, xem trận sau khi bị loại, admin xem trận và kích người chơi, job dọn dữ liệu, các hàm ghép đội và lưu bố cục nút cảm ứng): `npm test`, chạy khi server dev đang bật. Test tự tạo tài khoản và tin nhắn tạm rồi xoá sạch sau khi chạy. Test job dọn dữ liệu chạy job thật nên cũng dọn dữ liệu của mọi tài khoản trên database dev, như job hằng ngày vẫn làm. Test admin kết nối bằng tài khoản `admin` (tạm đổi mật khẩu rồi trả lại như cũ), nên phiên admin đang mở trên trình duyệt sẽ bị đẩy ra. Mọi client test kết nối từ cùng một máy nên dùng chung các giới hạn theo IP; chạy hai lần sát nhau có thể vướng giới hạn kết nối socket, đợi khoảng một phút rồi chạy lại.

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
| `JWT_SECRET` | Chuỗi ngẫu nhiên ít nhất 32 ký tự để ký token. Ở production server từ chối khởi động nếu ngắn hơn hoặc còn là chuỗi mẫu. Tạo bằng `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `PORT` | Cổng lắng nghe, mặc định 3001 (thường do nền tảng tự đặt) |
| `CLIENT_ORIGIN` | Domain của frontend, ví dụ `https://game.example.com`. Nhiều domain thì cách nhau bằng dấu phẩy |
| `NODE_ENV` | Đặt `production` khi deploy để bật các kiểm tra bảo mật bên dưới |
| `TRUST_PROXY` | Số reverse proxy đứng trước server, dùng để lấy đúng IP người chơi. Mặc định `1` ở production (Render, Railway, Fly.io...), `0` khi dev. Chạy thẳng trên VPS không có Nginx thì đặt `0`, nếu không người dùng có thể giả IP để lách giới hạn |
| `REQUIRE_HTTPS` | Mặc định bật ở production: trang tải qua http được chuyển sang https, API và socket qua http bị từ chối. Đặt `false` chỉ khi nền tảng không có HTTPS |
| `ADMIN_PASSWORD` | Mật khẩu tài khoản `admin`: ít nhất 12 ký tự, có chữ hoa, chữ thường, số và ký tự đặc biệt, không khoảng trắng, không chứa chữ `admin`. **Bắt buộc ở production**: thiếu hoặc quá yếu thì server từ chối khởi động. Khi dev thì chỉ cảnh báo. Đổi giá trị này rồi khởi động lại là đổi mật khẩu admin và đăng xuất mọi phiên admin cũ |

Bước build cần các gói devDependencies (`esbuild`, `typescript`), nên đừng cài với `--omit=dev` ở bước này. File `.env` không bắt buộc, có biến môi trường của nền tảng là đủ.

## Cấu trúc

```
src/index.ts        Express + Socket.IO, CORS, helmet
src/routes.ts       REST: /api/auth/register, /api/auth/login, /api/me, /api/me/stats, /api/me/history, /api/me/touch-layout, /api/rooms/:id
src/security.ts     khoá đăng nhập theo tài khoản + IP, giới hạn kết nối socket theo IP, bắt buộc HTTPS
src/db.ts           PostgreSQL: schema gốc, chạy migration, truy vấn, lưu kết quả trận (có thử lại khi mất kết nối)
src/retention.ts    job dọn dữ liệu mỗi 24 giờ (lịch sử trận, chat thế giới, tin nhắn riêng, chat hỗ trợ); src/cleanup.ts chạy tay
src/migrations/     migration đánh số, mỗi cái chạy một lần (001: vai trò người dùng, 002: lưu trữ thống kê, 003: thu hồi token và cấm chat, 004: bố cục nút cảm ứng)
src/adminAccount.ts tạo tài khoản admin hoặc đổi mật khẩu theo ADMIN_PASSWORD, chạy mỗi lần khởi động
src/auth.ts         băm mật khẩu scrypt, JWT (kèm token_version để thu hồi)
src/game/GameServer.ts  xác thực socket, ghép trận, nhóm, chế độ bot, phòng bạn bè, kết nối lại
src/game/matchmaking.ts xếp vé hàng chờ thành đội và chọn đội cho một trận, chia ô/đội trong phòng bạn bè (hàm thuần, có test)
src/game/Match.ts   mô phỏng trận: phòng chờ đầu trận, di chuyển, bắn, nhặt đồ, nhà, bo, thính, rương, hũ lửa, khói, xếp hạng
src/game/Bot.ts     AI của bot
src/game/NavGrid.ts lưới dẫn đường A* cho bot (dựng một lần cho mỗi bản đồ)
src/social/SocialServer.ts  chat thế giới, chat riêng, chat hỗ trợ với admin, bạn bè, tìm người chơi, trạng thái online (sự kiện socket chat:*, support:*, friend:*, user:search)
src/social/store.ts truy vấn bảng friendships, chat_messages, chat_reads (kèm cờ admin của người gửi) và hộp thư hỗ trợ của admin
src/shared/         hằng số, vật phẩm, bản đồ (maps.ts: 5 bản đồ cố định + trường bắn), training.ts (bố cục trường bắn), va chạm, giao thức mạng
```

`src/shared` có một bản giống hệt trong project frontend. Hai bên dùng chung giao thức mạng, cùng dựng bản đồ từ mã bản đồ và cùng tính va chạm để dự đoán di chuyển, nên khi sửa một file trong `src/shared` thì phải sửa y hệt ở frontend.

## Chế độ chơi

| Chế độ | Cách hoạt động |
| --- | --- |
| Ghép trận | Luôn đấu trên Nước Văn Lang với người chơi thật, có ba hàng chờ riêng: Đơn (`queue:join`), Nhóm 2 và Nhóm 4 (qua nhóm, xem dưới). Sau 3 phút sẽ báo chế độ đang ít người và gợi ý đổi chế độ, nhưng vẫn cho chờ tiếp. |
| Đấu với bot | Vào trận ngay, bot lấp đầy bản đồ đã chọn qua `bot:start { map, difficulty }`: 99 bot ở Nước Văn Lang, 49 bot ở bản đồ 50 người. Độ khó Dễ / Vừa / Khó chỉ đổi tốc độ di chuyển của bot (60% / 80% / 100% tốc độ người chơi); bot trong phòng bạn bè luôn chạy 100%. |
| Phòng bạn bè | Mã phòng là UUID. Tạo bằng `room:create { teamSize, name, listed }` (client cũ gửi riêng số người mỗi đội vẫn được). Tên phòng tối đa 24 ký tự, bị bỏ ký tự điều khiển và khoảng trắng thừa; để trống thì thành "Phòng của <tên chủ phòng>". Phòng `listed` (mặc định) hiện ở danh sách phòng ngoài sảnh, phòng kín chỉ vào được bằng mã hoặc link. Từ 2 người đến sức chứa của bản đồ (bot cũng tính), mặc định Nước Văn Lang. Chủ phòng thêm bot (`room:addBot`, `room:fillBots` lấp đầy, `room:clearBots` xóa hết), chọn bản đồ (`room:setMap`, không cho chọn bản đồ nhỏ hơn số người đang có) và bấm bắt đầu. Chọn "ngẫu nhiên" thì chỉ bốc trong các bản đồ đủ chỗ. Kiểu đội Đơn / Nhóm 2 / Nhóm 4 do chủ phòng chọn trong phòng (`room:setTeamSize`, đổi được bất cứ lúc nào; phòng mới mở với kiểu chọn lần trước, `room:create <1\|2\|4>`). Chủ phòng ngồi ô 0, người vào sau ở mục "Chưa chọn đội" cho tới khi tự bấm một ô trống (`room:move <ô>`); bot ngồi vào ô trống đầu tiên. Ô k thuộc đội k / cỡ đội (làm tròn xuống), nên khi đổi kiểu đội ai cũng giữ nguyên ô, chỉ các ô gộp lại thành đội mới. Phòng chia đội chỉ bắt đầu được khi mọi người đã chọn đội và có ít nhất 2 đội có người; đội trống bị bỏ qua, đồng đội không bắn trúng nhau như ghép trận nhóm. Chủ phòng rời đi thì quyền chủ phòng chuyển cho người khác. |
| Trường tập bắn | Một người chơi, vào qua `training:start`, luôn ở bản đồ riêng Trường Tập Bắn (không có trong danh sách chọn bản đồ). Xem phần dưới. |

Mỗi server mở tối đa 50 trận (ghép trận, đấu bot và phòng bạn bè) và 100 phòng cùng lúc. Trong đó đấu với bot chỉ được dùng tối đa 35 trận, để luôn còn chỗ cho trận người thật. Trường tập bắn có trần riêng 30 phiên, không chiếm chỗ của các trận kia. Mỗi IP (tính theo người đang online) chỉ mở được cùng lúc 6 trận bot hoặc phiên tập và làm chủ 6 phòng chờ; vượt quá thì nhận `error:msg`.

### Danh sách phòng ở sảnh

Client gửi `rooms:watch` khi đang ở màn sảnh và `rooms:unwatch` khi rời đi. Server trả ngay `rooms:list`, rồi gửi lại mỗi khi có phòng được tạo, đổi người, đổi bot, đổi bản đồ, đổi kiểu đội, bắt đầu hoặc giải tán. Các thay đổi dồn dập được gộp thành một lần gửi sau 300 ms. Mỗi dòng có mã, tên phòng, chủ phòng (tên, avatar, cờ admin), số người (cả bot), số người thật, sức chứa, bản đồ và kiểu đội. Chỉ gồm phòng `listed`; phòng còn chỗ xếp trước, rồi tới phòng đông người thật hơn, rồi phòng mới hơn; tối đa 50 dòng.

### Admin: trận đang đấu, xem trận, kích người chơi

Mọi sự kiện dưới đây chỉ có tác dụng với tài khoản `role = 'admin'` (server kiểm tra vai trò ở từng sự kiện; người thường gửi lên thì bị bỏ qua hoặc nhận `error:msg`).

- **Danh sách trận đang đấu**: `matches:watch` / `matches:unwatch` (client admin gửi kèm `rooms:watch` khi ở sảnh). Server trả ngay `matches:list`, gửi lại khi có trận bắt đầu, kết thúc, có người bị kích hoặc admin vào/rời xem (gộp sau 300 ms), và cứ 3 giây một lần khi còn admin theo dõi để cập nhật số người còn sống và đồng hồ. Mỗi dòng (`LiveMatchSummary`): mã trận, chế độ, tên phòng (phòng bạn bè; chế độ khác để trống), bản đồ, kiểu đội, số người lúc bắt đầu (cả bot), số người thật còn trong trận, số người còn sống, thời gian đã đấu, đang ở phòng chờ hay không, số admin đang xem. Không gồm trường tập bắn. Trận đông người thật xếp trước.
- **Xem trận**: `observe:start <mã trận>`. Admin không được đang ở trong trận, hàng chờ hay phòng chờ; đang xem thì cũng không vào hàng chờ, tạo hay vào phòng được. Server gửi `match:start` với `observer: true`, `you = -1`; admin không có trong danh sách người chơi, không ai trong trận biết có người xem. Snapshot là góc nhìn của người đang được theo dõi (`spectating: true`, cùng tầm nhìn, đồ đạc, đồng đội và cờ như người đó thấy), kèm sự kiện chung và sự kiện quanh người đó. Mới vào thì theo người chơi thật đầu tiên còn sống; `observe:step 1|-1` chuyển sang người sau / trước; người đang theo bị loại thì tự chuyển sang người còn sống tiếp theo. `input`, `action`, `spectate` từ admin đều bị bỏ qua. `observe:stop` để rời (server trả `match:left`); mất kết nối hoặc đăng nhập nơi khác cũng tự rời. Trận kết thúc thì admin nhận `observe:ended { winnerName }`.
- **Kích người chơi**: `observe:kick <pid>`, chỉ được kích đúng người mình đang theo dõi (nếu góc nhìn vừa chuyển sang người khác thì server từ chối, tránh kích nhầm). Người bị kích bị loại như rời trận (rơi đồ, xếp hạng theo lúc bị loại, kết quả vẫn được lưu), nhận `match:kicked` rồi được trả về sảnh ngay (không còn gắn với trận, vào trận khác được luôn). Cả trận nhận sự kiện `kill` với `w = 'kick'`: client hiện "<tên> đã bị admin kích khỏi map" ở bảng hạ gục và giữa màn hình. Nếu người bị kích là người thật cuối cùng thì trận kết thúc luôn như khi mọi người rời đi.

### Chat hỗ trợ với admin

Mỗi người chơi có một kênh riêng `support:<id người chơi>` để nhắn với **mọi** admin, không cần kết bạn. Dùng chung các sự kiện chat (`chat:send`, `chat:history`, `chat:read`, giới hạn tốc độ như chat riêng) với `to` là:

- `'support'`: người chơi nhắn / đọc kênh của chính mình. Admin gửi `'support'` sẽ bị từ chối (admin không có hộp thư hỗ trợ).
- `'support:<id người chơi>'`: chỉ admin dùng được, để trả lời hoặc chủ động nhắn trước cho một người chơi (không mở được kênh với chính mình hay với admin khác). Người thường gửi lên thì bị từ chối.

Tin `chat:msg` của kênh hỗ trợ được gửi tới người chơi đó và mọi admin đang online (trừ chính người gửi), nên admin nào cũng thấy và trả lời được. Thêm hai sự kiện:

- `support:status` → `{ unread, adminOnline }`: số tin admin trả lời mà người chơi chưa đọc (admin luôn nhận 0), và đang có admin online hay không.
- `support:inbox` (chỉ admin) → `{ threads }`: tối đa 100 cuộc trò chuyện, mới nhất trước. Mỗi dòng (`SupportThread`) gồm người chơi, trạng thái online, tin cuối (`fromAdmin` cho biết do admin gửi) và số tin của người chơi mà admin này chưa đọc. Mốc đã đọc tính riêng cho từng admin.

### Phòng chờ đầu trận (ghép trận và phòng bạn bè)

Ghép xong hoặc chủ phòng bấm bắt đầu thì trận được tạo ngay nhưng mở bằng 30 giây phòng chờ (`PREMATCH_LOBBY_MS`), để mọi người kịp kết nối và dựng xong bản đồ trước khi đánh nhau. Đấu với bot và trường tập bắn vào thẳng.

- Mọi người (cả bot trong phòng bạn bè, bot đứng yên) xuất hiện trong một vòng tròn giữa bản đồ (bán kính `650 + 140·√số người`, ít nhất 1050 px, nhiều nhất 40% cạnh bản đồ), ngoài nhà, đồng đội đứng gần nhau. Di chuyển bị giữ trong vòng (`stepMovement` nhận vòng tròn này, client dự đoán bằng đúng vòng đó), nhà cửa vẫn vào được và mở được cửa.
- Không có vật phẩm (server không gửi `la`, không cho nhặt), không bắn, không ném, không hồi máu, không có bo, nên không ai gây hay nhận sát thương. Đồng hồ trận (`now`) đứng ở 0: bo, thính, thời gian sống sót và thời lượng trận chỉ tính từ lúc vào đấu.
- Snapshot có `lb = [ms còn lại, x, y, bán kính]`, còn `z` tạm là vòng tròn phòng chờ nên client vẽ viền và bản đồ nhỏ như vẽ bo.
- Hết giờ: cửa về trạng thái ban đầu, mọi người được đưa tới điểm xuất phát như bình thường (đồng đội cạnh nhau), vật phẩm hiện ra, sự kiện `go` báo trận bắt đầu. Ai thoát trong phòng chờ thì bị tính là rời trận.

### Nhóm (Nhóm 2 / Nhóm 4)

- `party:create size` lập nhóm 2 hoặc 4 người, người lập là trưởng nhóm. Vào nhóm bằng `party:join id`: nhận lời mời, hoặc mở link `/?party=<id>`. Thành viên nào cũng mời được bạn bè đang trực tuyến (`party:invite userId`, người được mời nhận `party:invite`, mỗi người chỉ mời lại sau 10 giây). Trưởng nhóm đổi cỡ nhóm (`party:setSize`), bật/tắt ghép thêm người lạ (`party:setFill`), mời ra (`party:kick`) và tìm trận (`party:queue`). Trạng thái nhóm gửi qua `party:state`, rời hoặc bị mời ra thì nhận `party:closed`.
- Nhóm tồn tại qua các trận để chơi tiếp cùng nhau. Mất kết nối quá 60 giây (ngoài trận) thì bị đưa ra khỏi nhóm; trưởng nhóm rời đi thì quyền chuyển cho người tiếp theo.
- Hàng chờ ghép theo vé: một người chơi đơn hoặc cả nhóm là một vé, không bao giờ bị tách. Mỗi lượt (1 giây), vé đủ người hoặc tắt ghép thêm thành một đội riêng, các vé còn lại ghép vào nhau theo thứ tự chờ cho đủ đội (`src/game/matchmaking.ts`). Trận bắt đầu khi số người đã xếp được từ `100 − cỡ đội + 1` trở lên. Một thành viên hủy tìm thì cả nhóm ra khỏi hàng chờ.
- Trong trận nhóm: đồng đội không gây sát thương cho nhau (tên bay xuyên qua đồng đội, hũ lửa của chính mình vẫn trúng mình), xuất hiện cạnh nhau, luôn thấy nhau trong tầm nhìn kể cả qua tường và khói, và snapshot có `tm` (vị trí, % máu, còn sống, mất kết nối của từng đồng đội) cùng `teams` (số đội còn lại). Đội bị loại khi người cuối cùng ngã, cả đội chung một thứ hạng; trận kết thúc khi còn một đội. Người đã ngã chỉ được xem đồng đội còn sống (server kiểm tra lại mỗi tick, nút "xem người hạ bạn" / "người tiếp theo" cũng chỉ quay vòng trong đội); cả đội bị diệt rồi mới được xem người khác. XP tính thưởng thứ hạng theo số đội. Lịch sử lưu `team_size`.

### Trường tập bắn

Bản đồ `truongban` 2400 × 2400 px (`src/shared/training.ts` giữ toàn bộ bố cục). Người chơi đứng ở vạch bắn bên trái, bắn sang phải vào 6 làn bia cách vạch 150, 300, 500, 700, 950 và 1200 px. Cuối bãi có ụ đá chắn tên, ba phía còn lại là hàng cây.

- Vào là có sẵn cung tên, thần tiễn, ống thổi, dao, gùi cấp 3, đủ các loài chim x1–x8, hũ lửa và bầu khói. Tên, hũ lửa và bầu khói được nạp đầy mỗi tick, người chơi không mất máu.
- Giá vũ khí sau vạch bắn có cung tên, nỏ, thần tiễn, ống thổi và dao; lấy xong 1.5 giây sau món đó lại hiện ra. Đổi vũ khí ở đây không làm rơi vũ khí cũ, và chế độ này không cho vứt đồ.
- 11 con lợn rừng (bán kính va chạm 28 px, 100 máu) chạy lên xuống trong làn của mình, thỉnh thoảng đổi hướng, đổi tốc độ hoặc dừng lại. Làn càng xa chạy càng nhanh (70–150 px/s). Bị hạ thì 2.5 giây sau có con mới chạy vào từ đầu làn. Tên, dao và hũ lửa đều trúng được lợn.
- Snapshot có thêm `b` (vị trí, vận tốc và % máu từng con) và `tr` (số viên đã bắn, số viên trúng, số con hạ, khoảng cách của cú trúng xa nhất và của cú trúng gần đây nhất). Client vẽ lợn ở vị trí hiện tại của server (ngoại suy theo vận tốc) thay vì lùi 100 ms như người chơi, để ngắm đúng chỗ nhìn thấy.
- Không có bo, thính hay vật phẩm rơi. Không cộng XP, không lưu vào lịch sử. Phiên tập kết thúc khi người chơi rời đi, mất kết nối quá 60 giây, hoặc không di chuyển, bắn hay thao tác gì trong 10 phút (`TRAINING_IDLE_MS`; chỉ xoay hướng ngắm không tính). Khi đóng vì treo máy, server gửi `match:closed { text }` để client báo lý do và về sảnh.

## Thông số thiết kế

**Bản đồ:** 5 bản đồ cố định. Nước Văn Lang 9600 × 9600 px cho 100 người (92 ngôi nhà, 900 cây, 360 tảng đá, 53 khu vực có tên). Bốn bản đồ theo chủ đề 6800 × 6800 px cho tối đa 50 người, mỗi bản đồ 31–34 ngôi nhà, 400–500 cây, 120–200 tảng đá, tường thành hoặc lũy tre, rương đồ và 13–18 khu vực có tên. Bốn bản đồ này được thiết kế trên lưới 4800 rồi giãn ra 6800 (`scaleDef`): vị trí giãn theo tỉ lệ, còn nhà, độ dày tường, cổng và cây giữ nguyên kích thước; mỗi bản đồ có thêm 14–30 nhà phụ đặt theo seed. Mật độ ở cả hai cỡ khoảng một màn hình mỗi người. Vật phẩm ngoài trời rải max(160, sức chứa × 7) món, cộng 1–3 món mỗi phòng. Cây, đá, nhà, tường và rương luôn giống nhau giữa các trận; vật phẩm, điểm xuất hiện, vòng bo và thính thì ngẫu nhiên mỗi trận. Người ngoài không nhìn thấy người trong nhà, người ở hai phòng khác nhau cũng không thấy nhau.

| Bản đồ | Đặc điểm |
| --- | --- |
| Nước Văn Lang (100 người) | Kinh Thành Văn Lang có Điện Hùng Vương ở giữa, Chợ Kinh Đô phía nam; Thành Cổ Loa (tây bắc), Núi Nghĩa Lĩnh (đông bắc), Làng Lạc Việt và Cánh Đồng Lúa (tây nam), Ngã Ba Bạch Hạc, Bến Thuyền, Làng Chài (đông nam); thêm Xưởng Đúc Đồng, Làng Văn Lang, Bãi Tập Voi, Rừng Lim |
| Thành Cổ Loa | Ba vòng thành (Nội, Trung, Ngoại) có cổng; Điện Ngự Triều, Đền Thượng, Kho Nỏ Thần ở trong, rừng bao quanh ngoài thành |
| Núi Nghĩa Lĩnh | Đường bậc đá lên Đền Hạ, Đền Trung, Đền Thượng và Lăng Hùng Vương; sườn núi nhiều đá, Rừng Cọ, Đồi Chè, Làng Hy Cương |
| Làng Lạc Việt | Làng quây lũy tre bốn cổng với Đình Làng ở giữa; Cánh Đồng Lúa phía bắc, Bến Sông phía nam, Bãi Trống Đồng, Nương Rẫy |
| Kinh Đô Phong Châu | Kinh Thành lũy gỗ có Điện Hùng Vương, Kho Báu, Đền Tổ; Chợ Phong Châu, Xưởng Đúc Đồng, Bãi Tập Voi, Ngã Ba Bạch Hạc |

Muốn sửa bố cục thì chỉnh `src/shared/maps.ts` (nhớ chép sang frontend). Bot tìm đường bằng A* trên lưới 20 px nên đi được qua cổng thành, lũy tre và cửa nhà. Bot chỉ chủ động đánh bot khác trong vòng 550 px (trừ khi bị bắn trước), và chỉ bắn rương khi không có tường chắn.

**Nhân vật:** 200 máu, tốc độ 230 px/s (chậm hơn khi cầm vũ khí nặng, còn một nửa khi đang đắp thuốc nam). Xuất hiện tay không, ở vị trí cách người khác ít nhất 450 px (người thật cách mọi người 950 px); mỗi người được chọn điểm xa người gần nhất trong 30 điểm thử nên trận đông vẫn rải đều khắp bản đồ.

**Vật phẩm theo thời Văn Lang – Âu Lạc.** Tên hiển thị, icon, hình cầm trên tay, đường bay và âm thanh đều theo thời Hùng Vương, còn id nội bộ giữ như cũ để không đụng tới giao thức, bot và lịch sử trận: `pistol` là ống thổi, `rifle` là cung tên, `shotgun` là nỏ, `sniper` là thần tiễn; đạn `9mm`/`556`/`12g`/`762` là kim tre, mũi tên, tên nỏ, tên móng rùa; `medkit` là thuốc nam, `grenade` là hũ lửa, `smoke` là bầu khói; `armor1-3` là giáp mây, giáp da, giáp đồng; `bag1-3` là gùi nhỏ, gùi lớn, gùi hoa văn; `scope2/3/4/6/8` là chim sẻ, chim sáo, chim cắt, đại bàng, chim Lạc.

**Vũ khí** (mỗi loại dùng một loại tên riêng):

| Vũ khí | Sát thương | Tốc độ bắn | Mỗi lượt nạp | Nạp lại | Tầm bắn | Tên |
| --- | --- | --- | --- | --- | --- | --- |
| Tay không | 18 | 2/s | – | – | cận chiến | – |
| Dao | 34 | 2/s | – | – | cận chiến | – |
| Ống thổi | 24 | 5/s | 15 | 1.6 s | 450 | Kim tre |
| Cung tên | 28 | 9/s | 30 | 2.4 s | 600 | Mũi tên |
| Nỏ (liên châu) | 9 × 14 mũi | 1/s | 5 | 2.8 s | 380 | Tên nỏ |
| Thần tiễn | 140 | 1/s | 5 | 3.2 s | 1300 | Tên móng rùa |

Mang tối đa 2 vũ khí chính, cộng thêm 1 ống thổi và 1 vũ khí cận chiến. Sát thương giảm dần theo khoảng cách.

**Giáp:** giáp mây (cấp 1) giảm 25% sát thương (độ bền 60), giáp da (cấp 2) giảm 40% (độ bền 90), giáp đồng (cấp 3) giảm 55% (độ bền 130). Giáp không chặn sát thương của bo.

**Gùi** (sức chứa tối đa):

| Gùi | Kim tre | Mũi tên | Tên nỏ | Móng rùa | Thuốc nam | Hũ lửa | Bầu khói |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Không có | 60 | 90 | 20 | 15 | 2 | 1 | 1 |
| Gùi nhỏ | 120 | 180 | 40 | 30 | 4 | 2 | 2 |
| Gùi lớn | 180 | 240 | 60 | 45 | 6 | 3 | 3 |
| Gùi hoa văn | 240 | 300 | 80 | 60 | 8 | 4 | 4 |

**Nhặt đồ:** phím F nhặt món gần nhất trong tầm 75 px (`PICKUP_RANGE`, không bị tường chắn); chuột phải nhặt món đang trỏ chuột, không trỏ thì món gần nhất trong tầm (action `pickup` gửi id món đó, server kiểm tra lại tầm và tường). Đồ trong tầm nhặt có nền sáng trên client. Tự nhặt tên, thuốc nam, hũ lửa, bầu khói và chim khi đi qua chỉ chạy với người đã bật trong cài đặt (action `autoPickup`, mặc định tắt); bot luôn tự nhặt.

**Cờ đánh dấu:** mỗi người có một cờ trên bản đồ (action `mark` với `x`, `y`; `unmark` để gỡ). Server bỏ qua toạ độ không phải số và kẹp vào trong bản đồ. Đặt được cả trong phòng chờ và khi đã bị loại. Snapshot có `mk` (`[pid, x, y]`) gồm cờ của chính mình và của đồng đội; đấu đơn mỗi người là một đội nên chỉ mình thấy cờ của mình. Người rời trận thì cờ biến mất.

**Vật phẩm tiêu hao:** thuốc nam hồi 75 máu trong 3 giây. Hũ lửa châm ngòi ngay khi cầm lên và nổ sau 2.5 giây tính từ lúc đó (ném đi thì hũ bay với thời gian còn lại, cầm quá lâu thì nổ trên tay, đổi vũ khí khác thì dập ngòi), ném xa tối đa 450 px, bán kính 170 px, sát thương từ 130 (ở tâm) giảm còn 25 (ở rìa). Bầu khói tạo vùng khói bán kính 210 px trong 15 giây, che tầm nhìn của cả người chơi lẫn bot.

**Chim trinh sát:** chim sẻ x2, chim sáo x3, chim cắt x4, đại bàng x6, chim Lạc x8 mở rộng tầm nhìn lần lượt 1.15, 1.3, 1.45, 1.7 và 2 lần. Ngay cả x8 cũng không thấy hết bản đồ. Thuần phục được chim tinh mắt hơn con đang dùng thì tự đổi sang; chim kém hơn chỉ theo để dành, tầm nhìn giữ nguyên (đổi bằng phím Z).

**Vòng bo** (khoảng 14 phút, 6 giai đoạn):

| Giai đoạn | Chờ | Thu nhỏ | Bán kính còn lại | Sát thương/giây |
| --- | --- | --- | --- | --- |
| 1 | 150 s | 75 s | 32% | 2 |
| 2 | 120 s | 60 s | 20% | 4 |
| 3 | 90 s | 50 s | 12% | 7 |
| 4 | 75 s | 45 s | 6.5% | 10 |
| 5 | 60 s | 40 s | 2.5% | 15 |
| 6 | 45 s | 30 s | 0 | 25 |

**Thính:** cứ 3 phút rơi một lần, được báo trên bản đồ trước 20 giây, luôn rơi bên trong vòng bo kế tiếp. Bên trong có đại bàng hoặc chim Lạc, giáp đồng và thần tiễn.

**Rương:** mở bằng cách đánh tay không hoặc bắn cho vỡ (60 máu). Bên trong ngẫu nhiên có cung tên, giáp da, gùi lớn, chim cắt, hũ lửa hoặc thuốc nam.

**Độ hiếm:** đồ hiếm (cung tên, giáp da, gùi lớn, chim cắt) chỉ có trong rương. Đồ huyền thoại (thần tiễn, giáp đồng, chim Lạc) chỉ có trong thính.

**Kết thúc trận:** người còn sống cuối cùng thắng. Nếu nhiều người chết gần như cùng lúc, thứ hạng xếp theo thời điểm chết tính đến mili giây, trùng thì chọn ngẫu nhiên. Người rời trận khi còn sống bị tính là đã chết. Người bị mất kết nối thì nhân vật đứng yên tại chỗ và có thể vào lại trận.

## Chống gian lận

- Server giữ toàn bộ trạng thái và tự tính đạn, sát thương, nhặt đồ. Client chỉ gửi phím bấm và hướng ngắm.
- Mỗi người chỉ nhận dữ liệu về những gì mình được phép thấy (trong tầm nhìn, không bị nhà hay khói che), nên hack nhìn xuyên tường không có tác dụng.
- Giới hạn tần suất input và mọi sự kiện socket, mỗi tài khoản chỉ được kết nối một phiên.
- Mật khẩu băm bằng scrypt (tài khoản cũ dùng bcrypt tự chuyển sang khi đăng nhập), xác thực bằng JWT, có helmet và kiểm tra dữ liệu đầu vào bằng zod.

## Bảo mật

- **Đăng nhập:** mỗi IP tối đa 20 lần mỗi 15 phút. Một tài khoản bị sai mật khẩu 8 lần từ cùng một IP thì IP đó bị khoá đăng nhập tài khoản này đến hết 15 phút. Khoá theo cặp tài khoản + IP để người khác không thể cố tình nhập sai mà khoá luôn chủ tài khoản ở nơi khác (kẻ dò mật khẩu bằng nhiều IP vẫn vướng giới hạn 20 lần mỗi IP). Tên không tồn tại cũng bị đếm như vậy để không dò được tài khoản nào có thật.
- **Token:** JWT mang `v` = `users.token_version`. REST và socket đều so khớp với giá trị trong database, nên tăng cột này là thu hồi mọi token đã cấp của tài khoản đó (hiện dùng khi đổi `ADMIN_PASSWORD`). Token cũ không có `v` được coi là `v = 0`.
- **Chat:** giới hạn tốc độ tính theo tài khoản và giữ qua các lần kết nối lại (kênh thế giới: dồn 3 tin rồi 1 tin mỗi 2 giây). Mọi tài khoản trên cùng một IP dùng chung thêm một hạn mức kênh thế giới (dồn 8 tin rồi 1 tin mỗi giây), để không lách được bằng cách mở nhiều tài khoản.
- **Admin cấm chat:** `admin:mute { userId, minutes }` với `minutes` là 15, 60, 1440, 10080, hoặc 0 để bỏ cấm (`MUTE_OPTIONS` trong `src/shared/social.ts`), trả `{ ok, until }`. Không cấm được chính mình hay admin khác. Người bị cấm nhận `chat:muted { until }` (bỏ cấm thì `until = null`), không gửi được kênh thế giới và tin nhắn riêng, nhưng vẫn nhắn được kênh hỗ trợ với admin. Khi admin tìm người chơi (`user:search`), kết quả có thêm `mutedUntil` của người đang bị cấm; người thường không thấy trường này.
- **Lỗi bất đồng bộ:** handler socket trong `GameServer` bị lỗi (kể cả promise bị từ chối, ví dụ mất kết nối database giữa chừng) thì chỉ ghi log, và server có `unhandledRejection` để ghi log thay vì sập.
- **Đăng ký:** có ô bẫy ẩn và kiểm tra thời gian điền form (dưới 1,5 giây là bị từ chối). Mỗi IP tạo tối đa 5 tài khoản mỗi giờ.
- **Socket:** mỗi IP tối đa 20 kết nối cùng lúc, được mở dồn 20 kết nối rồi sau đó 1 kết nối mỗi 2 giây.
- **Production:** bắt buộc HTTPS kèm HSTS, `JWT_SECRET` phải đủ mạnh, `/api/health` chỉ trả `{ ok: true }` (số trận và số người online chỉ hiện khi dev).
- Mọi truy vấn SQL đều dùng tham số. Trình duyệt không truy cập DB trực tiếp, nên không cần Row-Level Security.

## Tài khoản

- Tên đăng nhập dài 3–16 ký tự, bắt đầu bằng chữ cái, chỉ gồm chữ, số và dấu `_`. Tên bắt đầu bằng `admin`, `root`, `system`, `bot`, `moderator`, `support` được hệ thống giữ lại.
- Vai trò `user` hoặc `admin` (cột `users.role`, trả về trong `PublicUser.role`). Hiện chỉ có một tài khoản admin do migration tạo, và vai trò này chỉ để hiển thị: tin nhắn, danh sách bạn bè, phòng, nhóm, danh sách phòng, danh sách người chơi và bảng xếp hạng trong trận đều kèm `admin: true` cho người đó (người thường không có trường này), client vẽ tên và khung tin nhắn theo kiểu riêng. Quyền riêng của admin: xem danh sách trận đang đấu, vào xem trận và kích người đang xem (xem mục "Admin: trận đang đấu, xem trận, kích người chơi"), đọc và trả lời chat hỗ trợ của mọi người chơi (mục "Chat hỗ trợ với admin"), và không bị chặn công cụ nhà phát triển trên web.
- Mật khẩu dài 8–64 ký tự, phải có chữ hoa, chữ thường, số và ký tự đặc biệt, không chứa khoảng trắng và không chứa tên đăng nhập.
- Thống kê gồm số trận, số trận thắng, số người đã hạ, sát thương cao nhất trong một trận và thứ hạng trung bình. Lịch sử lưu chế độ, thứ hạng, số người hạ và thời gian của 20 trận gần nhất (thống kê vẫn tính mọi trận đã chơi). Cấp độ tăng theo XP và không ảnh hưởng đến lối chơi. XP mỗi trận: 20, cộng 30 cho mỗi người hạ, 5 cho mỗi phút sống sót, 100 nếu thắng, cộng thưởng thứ hạng 10 XP cho mỗi người xếp dưới mình (trận đông thì chia nhỏ để thưởng thứ hạng tối đa 150).
