import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AVATARS, isUuid, validatePassword, validateUsername } from './shared';
import { hashPassword, requireAuth, signToken, verifyPassword } from './auth';
import {
  createUser,
  findUserById,
  findUserByName,
  getHistory,
  getStats,
  toPublicUser,
  touchLogin,
  updateAvatar,
} from './db';
import type { GameServer } from './game/GameServer';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Bạn thử quá nhiều lần, vui lòng đợi 15 phút rồi thử lại.' },
});

const credentialsSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(256),
});

const registerSchema = credentialsSchema.extend({
  avatar: z.string().max(16).optional(),
});

export function createApiRouter(game: GameServer): Router {
  const router = Router();

  router.get('/healthy', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  router.post('/auth/register', authLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ.' });
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
    res.status(201).json({ token: signToken(user.id), user: toPublicUser(user) });
  });

  router.post('/auth/login', authLimiter, async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ.' });
      return;
    }
    const user = await findUserByName(parsed.data.username.trim());
    const ok = await verifyPassword(parsed.data.password, user?.password_hash ?? null);
    if (!user || !ok) {
      res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      return;
    }
    await touchLogin(user.id);
    res.json({ token: signToken(user.id), user: toPublicUser(user) });
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

  router.get('/me/stats', requireAuth, async (req, res) => {
    res.json({ stats: await getStats(req.userId!) });
  });

  router.get('/me/history', requireAuth, async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(await getHistory(req.userId!, limit, offset));
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
