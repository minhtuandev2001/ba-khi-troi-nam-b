import type { Server, Socket } from 'socket.io';
import {
  USER_SEARCH_MIN,
  NAME_MAX_LENGTH,
  SUPPORT_KEY,
  WORLD_CHANNEL,
  cleanChatText,
  dmChannel,
  isMuteMinutes,
  isUuid,
  maskProfanity,
  supportChannel,
  supportOwner,
  type ChatChannel,
  type ChatMessage,
  type FriendsState,
  type Presence,
  type PublicUser,
  type SocialAck,
  type SocialUser,
  type SupportStatus,
  type SupportThread,
  type UserSearchResult,
} from '../shared';
import { deleteAccount, findUserById } from '../db';
import { forgetLeaderboard } from '../leaderboard';
import { TokenBucket } from '../game/rateLimit';
import { clientIp } from '../security';
import {
  areFriends,
  channelHistory,
  chatMutedUntil,
  findSocialUserByName,
  friendIds,
  insertMessage,
  linkedIds,
  listFriendships,
  markRead,
  removeFriendship,
  requestFriend,
  respondFriend,
  searchUsers,
  setChatMute,
  supportInbox,
  unreadByFriend,
  unreadIn,
} from './store';

/** What the social layer needs from the game server. */
export interface PresenceSource {
  presenceOf(userId: string): Presence;
  evictUser(userId: string): void;
}

const WORLD_ROOM = 'chat:world';
/** Every connected admin, who all receive the support threads. */
const ADMIN_ROOM = 'chat:admins';
const userRoom = (id: string) => `user:${id}`;
const DUPLICATE_WINDOW_MS = 15_000;
const SEARCH_RE = /^[A-Za-z0-9_]+$/;

/** Unused rate-limit state is dropped after this long; every bucket has long refilled by then. */
const LIMITS_IDLE_MS = 10 * 60_000;

/** Messages the profanity filter had to mask, within the window, before an automatic chat ban. */
const AUTO_MUTE_STRIKES = 3;
const AUTO_MUTE_WINDOW_MS = 10 * 60_000;
const AUTO_MUTE_MINUTES = 15;

const fail = (error: string) => ({ ok: false, error }) as const;
const TOO_FAST = 'Bạn thao tác quá nhanh, đợi một chút nhé.';

/** Kept per account rather than per socket, so reconnecting does not hand out a fresh allowance. */
interface UserLimits {
  general: TokenBucket;
  send: TokenBucket;
  world: TokenBucket;
  direct: TokenBucket;
  lastWorld: { text: string; at: number };
  /** When recent messages had words masked (the automatic chat ban counts them). */
  strikes: number[];
  seenAt: number;
}

function withoutRaw(message: ChatMessage): ChatMessage {
  if (!message.raw) return message;
  const copy = { ...message };
  delete copy.raw;
  return copy;
}

function timeLeft(until: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} phút`;
  if (minutes < 48 * 60) return `${Math.ceil(minutes / 60)} giờ`;
  return `${Math.ceil(minutes / (24 * 60))} ngày`;
}

export class SocialServer {
  private readonly limits = new Map<string, UserLimits>();
  /** World chat shared by every account on one address, so a pile of accounts cannot multiply the allowance. */
  private readonly ipWorld = new Map<string, { bucket: TokenBucket; seenAt: number }>();

  constructor(private readonly io: Server, private readonly presence: PresenceSource) {
    setInterval(() => {
      const old = Date.now() - LIMITS_IDLE_MS;
      for (const [id, l] of this.limits) if (l.seenAt < old) this.limits.delete(id);
      for (const [ip, l] of this.ipWorld) if (l.seenAt < old) this.ipWorld.delete(ip);
    }, LIMITS_IDLE_MS).unref();
  }

  private limitsOf(userId: string): UserLimits {
    let l = this.limits.get(userId);
    if (!l) {
      l = {
        general: new TokenBucket(20, 4),
        send: new TokenBucket(10, 3),
        world: new TokenBucket(3, 0.5),
        direct: new TokenBucket(8, 1.5),
        lastWorld: { text: '', at: 0 },
        strikes: [],
        seenAt: Date.now(),
      };
      this.limits.set(userId, l);
    }
    l.seenAt = Date.now();
    return l;
  }

  private takeIpWorld(ip: string): boolean {
    let l = this.ipWorld.get(ip);
    if (!l) this.ipWorld.set(ip, (l = { bucket: new TokenBucket(8, 1), seenAt: 0 }));
    l.seenAt = Date.now();
    return l.bucket.take();
  }

  /** A new message to every socket in `target` but the sender's; only admins receive the unmasked text. */
  private deliver(socket: Socket, target: string | string[], message: ChatMessage) {
    if (!message.raw) {
      socket.to(target).emit('chat:msg', message);
      return;
    }
    socket.to(target).except(ADMIN_ROOM).emit('chat:msg', withoutRaw(message));
    const rooms = this.io.sockets.adapter.rooms;
    const targets = Array.isArray(target) ? target : [target];
    for (const id of rooms.get(ADMIN_ROOM) ?? []) {
      if (id !== socket.id && targets.some((r) => rooms.get(r)?.has(id))) this.io.to(id).emit('chat:msg', message);
    }
  }

  /** Counts a masked message; enough of them in a short while ban the player from chat. Returns the sender's warning ('' once banned). */
  private async strike(userId: string, limits: UserLimits): Promise<string> {
    const now = Date.now();
    limits.strikes = limits.strikes.filter((t) => now - t < AUTO_MUTE_WINDOW_MS);
    limits.strikes.push(now);
    const left = AUTO_MUTE_STRIKES - limits.strikes.length;
    if (left > 0) {
      return `Tin nhắn có từ ngữ không phù hợp nên đã bị che. Thêm ${left} lần nữa trong ${AUTO_MUTE_WINDOW_MS / 60_000} phút sẽ bị tự động cấm chat ${AUTO_MUTE_MINUTES} phút.`;
    }
    limits.strikes = [];
    const result = await setChatMute(userId, AUTO_MUTE_MINUTES);
    this.io.to(userRoom(userId)).emit('chat:muted', { until: result?.until?.toISOString() ?? null, auto: true });
    console.log(`[automod] cấm chat ${result?.username ?? userId} ${AUTO_MUTE_MINUTES} phút vì dùng từ ngữ không phù hợp ${AUTO_MUTE_STRIKES} lần`);
    return '';
  }

  /** Wires the social events for a freshly connected socket; `me` returns the latest profile. */
  attach(socket: Socket, me: () => PublicUser) {
    const userId = me().id;
    socket.join([WORLD_ROOM, userRoom(userId)]);
    if (me().role === 'admin') socket.join(ADMIN_ROOM);
    const isAdmin = () => me().role === 'admin';
    const ip = clientIp(socket.handshake.headers, socket.handshake.address);
    const limits = this.limitsOf(userId);
    const { general, world, direct } = limits;

    const handle = <A>(event: string, fn: (arg: Record<string, unknown>) => Promise<SocialAck<A>>, bucket = general) => {
      socket.on(event, async (arg: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        if (!bucket.take()) return ack(fail(TOO_FAST));
        try {
          ack(await fn(arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : {}));
        } catch (err) {
          console.error(`[social] lỗi xử lý ${event}`, err);
          ack(fail('Lỗi máy chủ, vui lòng thử lại.'));
        }
      });
    };

    /**
     * Resolves the channel a request refers to: world when `to` is absent, `support` for a player's own thread
     * with the admins, `support:<player id>` for an admin answering a player, otherwise a DM with a friend.
     */
    const channelFor = async (to: unknown): Promise<ChatChannel | string> => {
      if (to === undefined || to === null || to === WORLD_CHANNEL) return WORLD_CHANNEL;
      if (to === SUPPORT_KEY) {
        if (isAdmin()) return 'Quản trị viên trả lời người chơi trong Hộp thư hỗ trợ.';
        return supportChannel(userId);
      }
      const owner = typeof to === 'string' ? supportOwner(to) : null;
      if (owner) {
        if (!isAdmin()) return 'Chỉ quản trị viên mới xem được cuộc trò chuyện này.';
        const player = owner === userId || !isUuid(owner) ? null : await findUserById(owner);
        if (!player) return 'Không tìm thấy người chơi này.';
        if (player.role === 'admin') return 'Quản trị viên không có hộp thư hỗ trợ.';
        return supportChannel(owner);
      }
      if (!isUuid(to) || to === userId) return 'Người nhận không hợp lệ.';
      if (!(await areFriends(userId, to))) return 'Chỉ nhắn riêng được với bạn bè.';
      return dmChannel(userId, to);
    };
    const isChannel = (c: string): c is ChatChannel => c === WORLD_CHANNEL || c.startsWith('dm:') || c.startsWith('support:');

    handle<{ message: ChatMessage; warn?: string }>('chat:send', async ({ to, text }) => {
      const body = cleanChatText(text);
      if (!body) return fail('Tin nhắn trống.');
      const channel = await channelFor(to);
      if (!isChannel(channel)) return fail(channel);
      const owner = supportOwner(channel);
      // a muted player keeps their support thread, so they can still ask an admin about the ban
      if (!owner) {
        const muted = await chatMutedUntil(userId);
        if (muted) return fail(`Bạn đang bị quản trị viên cấm chat, còn ${timeLeft(muted)}. Bạn vẫn nhắn được cho quản trị viên ở tab 🛡️ Admin.`);
      }
      if (channel === WORLD_CHANNEL) {
        if (!world.take()) return fail('Kênh thế giới giới hạn 1 tin mỗi 2 giây.');
        const last = limits.lastWorld;
        if (body === last.text && Date.now() - last.at < DUPLICATE_WINDOW_MS) return fail('Đừng gửi lặp lại cùng một tin nhắn.');
        if (!this.takeIpWorld(ip)) return fail('Mạng của bạn đang gửi quá nhiều tin vào kênh thế giới, đợi một chút nhé.');
        limits.lastWorld = { text: body, at: Date.now() };
      } else if (!direct.take()) {
        return fail(TOO_FAST);
      }
      const u = me();
      const from = { id: u.id, username: u.username, avatar: u.avatar, level: u.level, ...(u.role === 'admin' ? { admin: true } : {}) };
      const masked = maskProfanity(body);
      const message = await insertMessage(channel, from, masked.text, masked.hits ? body : undefined);
      // a support thread reaches its player and every admin; socket.to leaves out the sender
      const target = channel === WORLD_CHANNEL ? WORLD_ROOM : owner ? [userRoom(owner), ADMIN_ROOM] : userRoom(to as string);
      this.deliver(socket, target, message);
      // talking to the admins about a ban never counts towards one
      const warn = masked.hits && !owner && !isAdmin() ? await this.strike(userId, limits) : '';
      return { ok: true, message: isAdmin() ? message : withoutRaw(message), ...(warn ? { warn } : {}) };
    }, limits.send);

    handle<{ messages: ChatMessage[] }>('chat:history', async ({ to, before }) => {
      const channel = await channelFor(to);
      if (!isChannel(channel)) return fail(channel);
      const cursor = typeof before === 'string' && /^\d{1,18}$/.test(before) ? before : null;
      return { ok: true, messages: await channelHistory(channel, cursor, isAdmin()) };
    });

    handle<object>('chat:read', async ({ to, id }) => {
      if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return fail('Tin nhắn không hợp lệ.');
      const channel = await channelFor(to);
      if (!isChannel(channel) || channel === WORLD_CHANNEL) return fail('Chỉ đánh dấu đã đọc cho tin nhắn riêng.');
      await markRead(userId, channel, id);
      return { ok: true };
    });

    handle<SupportStatus>('support:status', async () => ({
      ok: true,
      unread: isAdmin() ? 0 : await unreadIn(userId, supportChannel(userId)),
      adminOnline: (this.io.sockets.adapter.rooms.get(ADMIN_ROOM)?.size ?? 0) > 0,
    }));

    handle<{ threads: SupportThread[] }>('support:inbox', async () => {
      if (!isAdmin()) return fail('Chỉ quản trị viên mới xem được hộp thư hỗ trợ.');
      const rows = await supportInbox(userId);
      return { ok: true, threads: rows.map((t) => ({ ...t, presence: this.presence.presenceOf(t.user.id) })) };
    });

    handle<FriendsState>('friend:list', async () => ({ ok: true, ...(await this.friendsState(userId)) }));

    handle<{ users: UserSearchResult[] }>('user:search', async ({ q }) => {
      const query = typeof q === 'string' ? q.trim() : '';
      if (query.length < USER_SEARCH_MIN || query.length > NAME_MAX_LENGTH || !SEARCH_RE.test(query)) return { ok: true, users: [] };
      return { ok: true, users: await searchUsers(userId, query, isAdmin()) };
    });

    handle<{ until: string | null }>('admin:mute', async ({ userId: target, minutes }) => {
      if (!isAdmin()) return fail('Chỉ quản trị viên mới cấm chat được.');
      if (!isUuid(target) || target === userId) return fail('Người chơi không hợp lệ.');
      if (!isMuteMinutes(minutes)) return fail('Thời hạn cấm chat không hợp lệ.');
      const player = await findUserById(target);
      if (!player) return fail('Không tìm thấy người chơi này.');
      if (player.role === 'admin') return fail('Không cấm chat quản trị viên được.');
      const result = await setChatMute(target, minutes);
      if (!result) return fail('Không tìm thấy người chơi này.');
      const until = result.until?.toISOString() ?? null;
      this.io.to(userRoom(target)).emit('chat:muted', { until });
      console.log(`[admin] ${me().username} ${minutes ? `cấm chat ${result.username} ${minutes} phút` : `bỏ cấm chat ${result.username}`}`);
      return { ok: true, until };
    });

    handle<{ username: string }>('admin:deleteUser', async ({ userId: target }) => {
      if (!isAdmin()) return fail('Chỉ quản trị viên mới xoá được tài khoản.');
      if (!isUuid(target) || target === userId) return fail('Người chơi không hợp lệ.');
      const player = await findUserById(target);
      if (!player) return fail('Không tìm thấy người chơi này.');
      if (player.role === 'admin') return fail('Không xoá được tài khoản quản trị viên.');
      const linked = await linkedIds(target);
      const removed = await deleteAccount(target);
      if (!removed) return fail('Không tìm thấy người chơi này.');
      this.presence.evictUser(target);
      this.limits.delete(target);
      forgetLeaderboard();
      if (linked.length) this.notifyFriendsChanged(...linked);
      this.io.emit('chat:purge', { userId: target });
      console.log(`[admin] ${me().username} xoá tài khoản ${removed.username}`);
      return { ok: true, username: removed.username };
    });

    handle<{ result: 'sent' | 'accepted' }>('friend:request', async ({ username, userId: targetId }) => {
      let target: SocialUser | null = null;
      if (typeof username === 'string' && username.length <= NAME_MAX_LENGTH) target = await findSocialUserByName(username.trim());
      else if (isUuid(targetId)) target = { id: targetId, username: '', avatar: '', level: 0 };
      if (!target) return fail('Không tìm thấy người chơi này.');
      if (target.id === userId) return fail('Không thể tự kết bạn với chính mình.');
      let outcome;
      try {
        outcome = await requestFriend(userId, target.id);
      } catch (err) {
        if ((err as { code?: string }).code === '23503') return fail('Không tìm thấy người chơi này.');
        throw err;
      }
      switch (outcome) {
        case 'already_friends': return fail('Hai bạn đã là bạn bè.');
        case 'already_sent': return fail('Bạn đã gửi lời mời cho người này rồi.');
        case 'limit': return fail('Danh sách bạn bè đã đầy.');
      }
      this.notifyFriendsChanged(userId, target.id);
      return { ok: true, result: outcome };
    });

    handle<object>('friend:respond', async ({ userId: requester, accept }) => {
      if (!isUuid(requester)) return fail('Lời mời không hợp lệ.');
      if (!(await respondFriend(userId, requester, accept === true))) return fail('Lời mời không còn tồn tại.');
      this.notifyFriendsChanged(userId, requester);
      return { ok: true };
    });

    handle<object>('friend:remove', async ({ userId: other }) => {
      if (!isUuid(other)) return fail('Người chơi không hợp lệ.');
      if (!(await removeFriendship(userId, other))) return fail('Hai bạn không còn liên kết nào.');
      this.notifyFriendsChanged(userId, other);
      return { ok: true };
    });
  }

  /** Tells online friends that `userId` came online, went offline or entered/left a match. */
  presenceChanged(userId: string) {
    const presence = this.presence.presenceOf(userId);
    friendIds(userId)
      .then((ids) => {
        if (ids.length) this.io.to(ids.map(userRoom)).emit('friend:presence', { userId, presence });
      })
      .catch((err) => console.error('[social] không gửi được trạng thái', err));
  }

  private async friendsState(userId: string): Promise<FriendsState> {
    const rows = await listFriendships(userId);
    const unread = await unreadByFriend(userId, rows.friends.map((f) => f.id));
    const rank: Record<Presence, number> = { in_match: 0, online: 0, offline: 1 };
    const friends = rows.friends
      .map((f) => ({ ...f, presence: this.presence.presenceOf(f.id), unread: unread.get(f.id) ?? 0 }))
      .sort((a, b) => rank[a.presence] - rank[b.presence]);
    return { friends, incoming: rows.incoming, outgoing: rows.outgoing };
  }

  /** Both sides refetch their lists; the payload stays tiny and the list is always authoritative. */
  private notifyFriendsChanged(...ids: string[]) {
    this.io.to(ids.map(userRoom)).emit('friend:changed');
  }
}
