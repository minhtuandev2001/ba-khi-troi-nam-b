import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  AVATARS,
  BOT_MODE_BOTS,
  MAX_ACTIVE_MATCHES,
  MAX_PLAYERS,
  MAX_PRIVATE_ROOMS,
  MIN_PRIVATE_ROOM_PLAYERS,
  QUEUE_NOTICE_AFTER_MS,
  isUuid,
  type ActionMsg,
  type GameMode,
  type PublicUser,
  type QueueStatusMsg,
  type RoomMember,
  type RoomStateMsg,
} from '../shared';
import { verifyToken } from '../auth';
import { findUserById, saveMatch, toPublicUser } from '../db';
import { botNames } from './Bot';
import { Match, type MatchResultPlayer, type Participant } from './Match';
import { TokenBucket } from './rateLimit';

interface OnlineUser {
  user: PublicUser;
  socket: Socket;
}

interface RoomBot {
  id: string;
  name: string;
  avatar: string;
  level: number;
}

interface PrivateRoom {
  id: string;
  hostId: string;
  humans: string[];
  bots: RoomBot[];
  profiles: Map<string, PublicUser>;
}

const RECONNECT_GRACE_MS = 60_000;

interface QueueEntry {
  userId: string;
  joinedAt: number;
}

export class GameServer {
  private readonly online = new Map<string, OnlineUser>();
  private readonly matches = new Map<string, Match>();
  private readonly userMatch = new Map<string, Match>();
  private queue: QueueEntry[] = [];
  private readonly rooms = new Map<string, PrivateRoom>();
  private readonly userRoom = new Map<string, string>();
  private readonly pendingLeave = new Map<string, NodeJS.Timeout>();

  constructor(private readonly io: Server) {
    io.use(async (socket, next) => {
      const payload = verifyToken(socket.handshake.auth?.token);
      if (!payload) return next(new Error('unauthorized'));
      try {
        const row = await findUserById(payload.sub);
        if (!row) return next(new Error('unauthorized'));
        socket.data.user = toPublicUser(row);
        next();
      } catch (err) {
        console.error('[socket] lỗi xác thực', err);
        next(new Error('server_error'));
      }
    });
    io.on('connection', (socket) => this.onConnection(socket));
    setInterval(() => this.queueTick(), 1000);
  }

  // ---------------------------------------------------------------- public helpers for REST

  isInMatch(userId: string): boolean {
    const m = this.userMatch.get(userId);
    return !!m && !m.ended;
  }

  refreshUser(user: PublicUser) {
    const o = this.online.get(user.id);
    if (o) o.user = user;
    const roomId = this.userRoom.get(user.id);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (room) {
      room.profiles.set(user.id, user);
      this.broadcastRoom(room);
    }
  }

  roomInfo(id: string) {
    const room = this.rooms.get(id);
    if (!room) return null;
    return {
      id: room.id,
      hostName: room.profiles.get(room.hostId)?.username ?? '',
      count: room.humans.length + room.bots.length,
      max: MAX_PLAYERS,
    };
  }

  stats() {
    return { online: this.online.size, matches: this.matches.size, queue: this.queue.length, rooms: this.rooms.size };
  }

  // ---------------------------------------------------------------- connection

  private onConnection(socket: Socket) {
    const user = socket.data.user as PublicUser;
    const previous = this.online.get(user.id);
    if (previous && previous.socket.id !== socket.id) {
      previous.socket.emit('session:replaced');
      previous.socket.disconnect(true);
    }
    this.online.set(user.id, { user, socket });

    const lobby = new TokenBucket(20, 10);
    const inputs = new TokenBucket(120, 80);
    const actions = new TokenBucket(30, 20);
    const guard = <T extends unknown[]>(bucket: TokenBucket, fn: (...args: T) => void) => (...args: T) => {
      if (!bucket.take()) return;
      try {
        fn(...args);
      } catch (err) {
        console.error('[socket] lỗi xử lý', err);
      }
    };

    socket.on('ping:c', guard(actions, (t: unknown, ack: unknown) => {
      if (typeof ack === 'function') ack(t);
    }));
    socket.on('queue:join', guard(lobby, () => this.joinQueue(user.id)));
    socket.on('queue:leave', guard(lobby, () => this.leaveQueue(user.id, true)));
    socket.on('bot:start', guard(lobby, () => this.startBotMatch(user.id)));
    socket.on('room:create', guard(lobby, () => this.createRoom(user.id)));
    socket.on('room:join', guard(lobby, (id: unknown) => this.joinRoom(user.id, id)));
    socket.on('room:leave', guard(lobby, () => this.leaveRoom(user.id)));
    socket.on('room:addBot', guard(lobby, () => this.addRoomBot(user.id)));
    socket.on('room:removeBot', guard(lobby, (botId: unknown) => this.removeRoomBot(user.id, botId)));
    socket.on('room:start', guard(lobby, () => this.startRoom(user.id)));

    socket.on('input', guard(inputs, (msg: unknown) => {
      const m = this.userMatch.get(user.id);
      if (m && !m.ended) m.handleInput(m.pidOfUser(user.id), msg);
    }));
    socket.on('action', guard(actions, (msg: ActionMsg) => {
      const m = this.userMatch.get(user.id);
      if (m && !m.ended) m.handleAction(m.pidOfUser(user.id), msg);
    }));
    socket.on('spectate', guard(actions, (target: unknown) => {
      const m = this.userMatch.get(user.id);
      if (m && !m.ended) m.spectate(m.pidOfUser(user.id), target === 'killer' ? 'killer' : 'next');
    }));
    socket.on('match:leave', guard(lobby, () => {
      const m = this.userMatch.get(user.id);
      if (m) {
        if (!m.ended) m.leave(m.pidOfUser(user.id));
        this.userMatch.delete(user.id);
      }
      socket.emit('match:left');
    }));

    socket.on('disconnect', () => {
      if (this.online.get(user.id)?.socket !== socket) return;
      this.online.delete(user.id);
      // phones drop the socket when the user switches app (e.g. to send the invite link), so keep their place for a while
      this.cancelLeave(user.id);
      this.pendingLeave.set(
        user.id,
        setTimeout(() => {
          this.pendingLeave.delete(user.id);
          if (this.online.has(user.id)) return;
          this.leaveQueue(user.id, false);
          this.leaveRoom(user.id);
        }, RECONNECT_GRACE_MS),
      );
      const m = this.userMatch.get(user.id);
      if (m && !m.ended) m.detachSocket(m.pidOfUser(user.id));
    });

    this.cancelLeave(user.id);
    const match = this.userMatch.get(user.id);
    if (match && !match.ended) {
      match.attachSocket(match.pidOfUser(user.id), socket);
    } else {
      socket.emit('lobby:ready');
      this.resyncLobby(user.id, socket);
    }
  }

  private cancelLeave(userId: string) {
    const t = this.pendingLeave.get(userId);
    if (t) clearTimeout(t);
    this.pendingLeave.delete(userId);
  }

  /** Tells a (re)connected client whether it still has a room or queue place. */
  private resyncLobby(userId: string, socket: Socket) {
    const roomId = this.userRoom.get(userId);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (room) {
      const o = this.online.get(userId);
      if (o) room.profiles.set(userId, o.user);
      socket.emit('room:state', this.roomState(room));
    } else {
      socket.emit('room:closed', { reason: 'gone' });
    }
    if (this.queue.some((q) => q.userId === userId)) this.sendQueueStatus();
    else socket.emit('queue:status', { inQueue: false, count: this.queue.length, needed: MAX_PLAYERS, waitedMs: 0, notice: false } satisfies QueueStatusMsg);
  }

  private emitError(userId: string, text: string) {
    this.online.get(userId)?.socket.emit('error:msg', { text });
  }

  private isBusy(userId: string): string | null {
    if (this.isInMatch(userId)) return 'Bạn đang ở trong một trận đấu.';
    if (this.queue.some((q) => q.userId === userId)) return 'Bạn đang trong hàng chờ ghép trận.';
    if (this.userRoom.has(userId)) return 'Bạn đang ở trong phòng chờ.';
    return null;
  }

  private participantOf(user: PublicUser): Participant {
    return { userId: user.id, name: user.username, avatar: user.avatar, level: user.level, isBot: false };
  }

  private makeBots(count: number): RoomBot[] {
    return botNames(count).map((name) => ({
      id: randomUUID(),
      name,
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      level: 1 + Math.floor(Math.random() * 20),
    }));
  }

  // ---------------------------------------------------------------- matches

  private createMatch(mode: GameMode, participants: Participant[]): Match | null {
    if (this.matches.size >= MAX_ACTIVE_MATCHES) {
      for (const p of participants) if (p.userId) this.emitError(p.userId, 'Máy chủ đang đầy trận, vui lòng thử lại sau ít phút.');
      return null;
    }
    const match = new Match(randomUUID(), mode, participants, {
      onEnd: (m, results, winnerName) => this.onMatchEnd(m, results, winnerName),
    });
    this.matches.set(match.id, match);
    for (const p of match.players) {
      if (!p.userId) continue;
      this.userMatch.set(p.userId, match);
      const o = this.online.get(p.userId);
      if (o) match.attachSocket(p.pid, o.socket);
    }
    console.log(`[match] bắt đầu ${match.id} (${mode}, ${participants.length} người)`);
    return match;
  }

  private onMatchEnd(match: Match, results: MatchResultPlayer[], winnerName: string) {
    this.matches.delete(match.id);
    for (const p of match.players) {
      if (p.userId && this.userMatch.get(p.userId) === match) this.userMatch.delete(p.userId);
    }
    console.log(`[match] kết thúc ${match.id}, người thắng: ${winnerName}`);
    if (!results.length) return;
    saveMatch({
      id: match.id,
      mode: match.mode,
      playerCount: match.players.length,
      winnerName,
      startedAt: match.startedAt,
      endedAt: new Date(),
      players: results,
    }).catch((err) => console.error('[db] không lưu được kết quả trận', err));
  }

  private startBotMatch(userId: string) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    const o = this.online.get(userId);
    if (!o) return;
    const bots = this.makeBots(BOT_MODE_BOTS).map<Participant>((b) => ({ userId: null, name: b.name, avatar: b.avatar, level: b.level, isBot: true }));
    this.createMatch('bots', [this.participantOf(o.user), ...bots]);
  }

  // ---------------------------------------------------------------- matchmaking

  private joinQueue(userId: string) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    this.queue.push({ userId, joinedAt: Date.now() });
    this.sendQueueStatus();
  }

  private leaveQueue(userId: string, notify: boolean) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.userId !== userId);
    if (before !== this.queue.length) {
      if (notify) this.online.get(userId)?.socket.emit('queue:status', { inQueue: false, count: this.queue.length, needed: MAX_PLAYERS, waitedMs: 0, notice: false } satisfies QueueStatusMsg);
      this.sendQueueStatus();
    }
  }

  private queueTick() {
    while (this.queue.length >= MAX_PLAYERS && this.matches.size < MAX_ACTIVE_MATCHES) {
      const group = this.queue.splice(0, MAX_PLAYERS);
      const parts = group
        .map((q) => this.online.get(q.userId))
        .filter((o): o is OnlineUser => !!o)
        .map((o) => this.participantOf(o.user));
      if (parts.length === MAX_PLAYERS) {
        this.createMatch('pvp', parts);
      } else {
        this.queue.unshift(...group.filter((q) => this.online.has(q.userId)));
        break;
      }
    }
    this.sendQueueStatus();
  }

  private sendQueueStatus() {
    const now = Date.now();
    for (const q of this.queue) {
      const waitedMs = now - q.joinedAt;
      const msg: QueueStatusMsg = {
        inQueue: true,
        count: this.queue.length,
        needed: MAX_PLAYERS,
        waitedMs,
        notice: waitedMs >= QUEUE_NOTICE_AFTER_MS,
      };
      this.online.get(q.userId)?.socket.emit('queue:status', msg);
    }
  }

  // ---------------------------------------------------------------- private rooms

  private roomState(room: PrivateRoom): RoomStateMsg {
    const members: RoomMember[] = [
      ...room.humans.map((id) => {
        const u = room.profiles.get(id)!;
        return { id, name: u.username, avatar: u.avatar, level: u.level, isBot: false };
      }),
      ...room.bots.map((b) => ({ id: b.id, name: b.name, avatar: b.avatar, level: b.level, isBot: true })),
    ];
    return { id: room.id, hostId: room.hostId, members, max: MAX_PLAYERS, min: MIN_PRIVATE_ROOM_PLAYERS };
  }

  private broadcastRoom(room: PrivateRoom) {
    const state = this.roomState(room);
    for (const id of room.humans) this.online.get(id)?.socket.emit('room:state', state);
  }

  private createRoom(userId: string) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    if (this.rooms.size >= MAX_PRIVATE_ROOMS) return this.emitError(userId, 'Đã đạt số phòng tối đa, vui lòng thử lại sau.');
    const o = this.online.get(userId);
    if (!o) return;
    const room: PrivateRoom = { id: randomUUID(), hostId: userId, humans: [userId], bots: [], profiles: new Map([[userId, o.user]]) };
    this.rooms.set(room.id, room);
    this.userRoom.set(userId, room.id);
    this.broadcastRoom(room);
  }

  private joinRoom(userId: string, id: unknown) {
    if (!isUuid(id)) return this.emitError(userId, 'Mã phòng không hợp lệ.');
    const room = this.rooms.get(id);
    if (!room) return this.emitError(userId, 'Phòng không tồn tại hoặc trận đấu đã bắt đầu.');
    if (room.humans.includes(userId)) return this.broadcastRoom(room);
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    if (room.humans.length + room.bots.length >= MAX_PLAYERS) return this.emitError(userId, 'Phòng đã đủ 10 người.');
    const o = this.online.get(userId);
    if (!o) return;
    room.humans.push(userId);
    room.profiles.set(userId, o.user);
    this.userRoom.set(userId, room.id);
    this.broadcastRoom(room);
  }

  private leaveRoom(userId: string) {
    const id = this.userRoom.get(userId);
    if (!id) return;
    this.userRoom.delete(userId);
    const room = this.rooms.get(id);
    this.online.get(userId)?.socket.emit('room:closed', { reason: 'left' });
    if (!room) return;
    room.humans = room.humans.filter((h) => h !== userId);
    room.profiles.delete(userId);
    if (!room.humans.length) {
      this.rooms.delete(id);
      return;
    }
    if (room.hostId === userId) room.hostId = room.humans[0];
    this.broadcastRoom(room);
  }

  private hostRoom(userId: string): PrivateRoom | null {
    const id = this.userRoom.get(userId);
    const room = id ? this.rooms.get(id) : undefined;
    if (!room) return null;
    if (room.hostId !== userId) {
      this.emitError(userId, 'Chỉ chủ phòng mới làm được việc này.');
      return null;
    }
    return room;
  }

  private addRoomBot(userId: string) {
    const room = this.hostRoom(userId);
    if (!room) return;
    if (room.humans.length + room.bots.length >= MAX_PLAYERS) return this.emitError(userId, 'Phòng đã đủ 10 người.');
    const taken = new Set(room.bots.map((b) => b.name));
    const bot = this.makeBots(MAX_PLAYERS).find((b) => !taken.has(b.name)) ?? this.makeBots(1)[0];
    room.bots.push(bot);
    this.broadcastRoom(room);
  }

  private removeRoomBot(userId: string, botId: unknown) {
    const room = this.hostRoom(userId);
    if (!room) return;
    room.bots = room.bots.filter((b) => b.id !== botId);
    this.broadcastRoom(room);
  }

  private startRoom(userId: string) {
    const room = this.hostRoom(userId);
    if (!room) return;
    const total = room.humans.length + room.bots.length;
    if (total < MIN_PRIVATE_ROOM_PLAYERS) {
      return this.emitError(userId, `Cần ít nhất ${MIN_PRIVATE_ROOM_PLAYERS} người (có thể thêm bot) để bắt đầu.`);
    }
    const humans = room.humans.filter((id) => this.online.has(id));
    const parts: Participant[] = [
      ...humans.map((id) => this.participantOf(room.profiles.get(id)!)),
      ...room.bots.map<Participant>((b) => ({ userId: null, name: b.name, avatar: b.avatar, level: b.level, isBot: true })),
    ];
    this.rooms.delete(room.id);
    for (const id of room.humans) this.userRoom.delete(id);
    this.createMatch('private', parts);
  }
}
