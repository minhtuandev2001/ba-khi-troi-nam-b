import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  ADMIN_ACCOUNTS_PAGE,
  AVATARS,
  NAME_MAX_LENGTH,
  isLeaderboardKind,
  isUuid,
  sanitizeTouchLayouts,
  validatePassword,
  validateUsername,
  type AdminAccountList,
} from './shared';
import { hashPassword, requireAuth, signToken, verifyPassword } from './auth';
import { getLeaderboard } from './leaderboard';
import {
  createUser,
  findUserById,
  findUserByName,
  getHistory,
  getStats,
  getTouchLayout,
  listAccounts,
  setTouchLayout,
  toPublicUser,
  touchLogin,
  updateAvatar,
  updatePasswordHash,
} from './db';
import type { GameServer } from './game/GameServer';
import { LoginGuard } from './security';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Bạn thử quá nhiều lần, vui lòng đợi 15 phút rồi thử lại.' },
});

/** Only successful sign-ups count, so typos in the form never use up the allowance. */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Mạng của bạn đã tạo nhiều tài khoản, vui lòng thử lại sau 1 giờ.' },
});

/** Saving happens once per press of "Lưu" in the button editor, so this only stops scripts hammering the column. */
const layoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Bạn lưu bố cục nút quá nhiều lần, vui lòng đợi một phút.' },
});

/** Real people need a few seconds to fill the form; scripted sign-ups submit almost instantly. */
const MIN_SIGNUP_FILL_MS = 1500;

const credentialsSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(256),
});

const registerSchema = credentialsSchema.extend({
  avatar: z.string().max(16).optional(),
  /** Hidden honeypot input: people never see it, form-filling bots do. */
  website: z.string().max(200).optional(),
  fillMs: z.number().finite(),
});

export function createApiRouter(game: GameServer): Router {
  const router = Router();
  const logins = new LoginGuard();

  router.get('/healthy', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  router.post('/auth/register', authLimiter, signupLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.website) {
      res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ.' });
      return;
    }
    if (parsed.data.fillMs < MIN_SIGNUP_FILL_MS) {
      res.status(400).json({ error: 'Bạn thao tác quá nhanh, vui lòng thử lại.' });
      return;
    }
    const username = parsed.data.username.trim();
    const { password } = parsed.data;
    const errors = [...validateUsername(username), ...validatePassword(password, username)];
    if (errors.length) {
      res.status(400).json({ error: errors[0], errors });
      return;
    }
    const avatar = AVATARS.includes(parsed.data.avatar as (typeof AVATARS)[number]) ? parsed.data.avatar! : AVATARS[0];
    const user = await createUser(username, await hashPassword(password), avatar);
    if (!user) {
      res.status(409).json({ error: 'Tên đăng nhập đã có người sử dụng.' });
      return;
    }
    res.status(201).json({ token: signToken(user.id, user.token_version), user: toPublicUser(user) });
  });

  router.post('/auth/login', authLimiter, async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ.' });
      return;
    }
    const username = parsed.data.username.trim();
    const ip = req.ip ?? '';
    const locked = logins.lockedFor(username, ip);
    if (locked > 0) {
      const minutes = Math.ceil(locked / 60_000);
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      res.status(429).json({ error: `Bạn đã nhập sai mật khẩu tài khoản này nhiều lần nên tạm bị chặn đăng nhập trên mạng này. Thử lại sau ${minutes} phút.` });
      return;
    }
    const user = await findUserByName(username);
    const check = await verifyPassword(parsed.data.password, user?.password_hash ?? null);
    if (!user || !check.ok) {
      logins.failed(username, ip);
      res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      return;
    }
    logins.succeeded(username, ip);
    if (check.rehash) await updatePasswordHash(user.id, await hashPassword(parsed.data.password));
    await touchLogin(user.id);
    res.json({ token: signToken(user.id, user.token_version), user: toPublicUser(user) });
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = await findUserById(req.userId!);
    if (!user) {
      res.status(401).json({ error: 'Tài khoản không tồn tại.' });
      return;
    }
    res.json({ user: toPublicUser(user), inMatch: game.isInMatch(user.id) });
  });

  router.patch('/me/avatar', requireAuth, async (req, res) => {
    const avatar = (req.body as { avatar?: unknown })?.avatar;
    if (!AVATARS.includes(avatar as (typeof AVATARS)[number])) {
      res.status(400).json({ error: 'Ảnh đại diện không hợp lệ.' });
      return;
    }
    const user = await updateAvatar(req.userId!, avatar as string);
    if (!user) {
      res.status(404).json({ error: 'Tài khoản không tồn tại.' });
      return;
    }
    game.refreshUser(toPublicUser(user));
    res.json({ user: toPublicUser(user) });
  });

  router.get('/me/touch-layout', requireAuth, async (req, res) => {
    const layouts = await getTouchLayout(req.userId!);
    if (!layouts) {
      res.status(404).json({ error: 'Tài khoản không tồn tại.' });
      return;
    }
    res.json({ layouts });
  });

  router.put('/me/touch-layout', requireAuth, layoutLimiter, async (req, res) => {
    const raw = (req.body as { layouts?: unknown })?.layouts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      res.status(400).json({ error: 'Bố cục nút không hợp lệ.' });
      return;
    }
    const layouts = sanitizeTouchLayouts(raw);
    if (!(await setTouchLayout(req.userId!, layouts))) {
      res.status(404).json({ error: 'Tài khoản không tồn tại.' });
      return;
    }
    res.json({ layouts });
  });

  router.get('/me/stats', requireAuth, async (req, res) => {
    res.json({ stats: await getStats(req.userId!) });
  });

  router.get('/me/history', requireAuth, async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(await getHistory(req.userId!, limit, offset));
  });

  router.get('/leaderboard', requireAuth, async (req, res) => {
    const kind = req.query.kind;
    if (!isLeaderboardKind(kind)) {
      res.status(400).json({ error: 'Bảng xếp hạng không hợp lệ.' });
      return;
    }
    res.json(await getLeaderboard(kind, req.userId!));
  });

  router.get('/admin/accounts', requireAuth, async (req, res) => {
    const me = await findUserById(req.userId!);
    if (me?.role !== 'admin') {
      res.status(403).json({ error: 'Chỉ quản trị viên mới xem được danh sách tài khoản.' });
      return;
    }
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (raw.length > NAME_MAX_LENGTH || !/^[A-Za-z0-9_]*$/.test(raw)) {
      res.status(400).json({ error: 'Tên người chơi chỉ gồm chữ không dấu, số và dấu _.' });
      return;
    }
    const { accounts, total } = await listAccounts(raw, ADMIN_ACCOUNTS_PAGE);
    const body: AdminAccountList = { total, accounts: accounts.map((a) => ({ ...a, presence: game.presenceOf(a.id) })) };
    res.json(body);
  });

  router.get('/rooms/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      res.status(400).json({ error: 'Mã phòng không hợp lệ.' });
      return;
    }
    const room = game.roomInfo(id);
    if (!room) {
      res.status(404).json({ error: 'Phòng không tồn tại hoặc đã bắt đầu.' });
      return;
    }
    res.json(room);
  });

  return router;
}
