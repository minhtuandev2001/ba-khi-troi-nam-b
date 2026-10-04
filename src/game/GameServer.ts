import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  AVATARS,
  BOT_SPEED_MULTIPLIER,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_MAP,
  MAP_DEFS,
  MAX_ACTIVE_MATCHES,
  MAX_PARTIES,
  MAX_PRIVATE_ROOMS,
  MIN_PRIVATE_ROOM_PLAYERS,
  PREMATCH_LOBBY_MS,
  QUEUE_NOTICE_AFTER_MS,
  ROOM_LIST_MAX,
  ROOM_NAME_MAX_LENGTH,
  TEAM_SIZES,
  TRAINING_MAP,
  cleanText,
  isBotDifficulty,
  isMapChoice,
  isPartySize,
  isTeamSize,
  isUuid,
  mapCapacity,
  resolveMapChoice,
  validateRoomName,
  type ActionMsg,
  type GameMode,
  type LiveMatchSummary,
  type MapChoice,
  type PartyInviteMsg,
  type PartySize,
  type PartyStateMsg,
  type Presence,
  type PublicUser,
  type QueueStatusMsg,
  type RoomMember,
  type RoomStateMsg,
  type RoomSummary,
  type TeamSize,
} from '../shared';
import { isCurrentToken, verifyToken } from '../auth';
import { findUserById, saveMatch, toPublicUser } from '../db';
import { areFriends } from '../social/store';
import { botNames } from './Bot';
import { Match, type MatchResultPlayer, type Participant } from './Match';
import { fitSlots, freeSlot, packMatch, roomTeams, type QueueTicket } from './matchmaking';
import { TokenBucket } from './rateLimit';
import { clientIp } from '../security';

interface OnlineUser {
  user: PublicUser;
  socket: Socket;
  ip: string;
}

interface RoomBot {
  id: string;
  name: string;
  avatar: string;
  level: number;
}

interface PrivateRoom {
  id: string;
  name: string;
  listed: boolean;
  createdAt: number;
  hostId: string;
  humans: string[];
  bots: RoomBot[];
  profiles: Map<string, PublicUser>;
  map: MapChoice;
  teamSize: TeamSize;
  /** Seat of every bot and of the humans who picked one, by user or bot id. */
  slots: Map<string, number>;
}

/** A group of friends who queue together for duo or squad matches; it survives the matches it plays. */
interface Party {
  id: string;
  leaderId: string;
  size: PartySize;
  fill: boolean;
  members: string[];
  profiles: Map<string, PublicUser>;
  /** Last invite time per invited user, to stop invite spam. */
  invitedAt: Map<string, number>;
}

interface QueueEntry extends QueueTicket {
  teamSize: TeamSize;
  /** null for a solo player. */
  partyId: string | null;
}

const RECONNECT_GRACE_MS = 60_000;
const INVITE_COOLDOWN_MS = 10_000;
/** Socket.IO room of the clients looking at the lobby room list. */
const ROOM_WATCHERS = 'lobby:rooms';
/** Bursts of room changes (bots filled one by one, a crowd joining) go out as one list update. */
const ROOM_LIST_DELAY_MS = 300;
/** Socket.IO room of the admins looking at the live match list. */
const MATCH_WATCHERS = 'admin:matches';
/** Alive counts and clocks change all the time, so watchers also get the list on this beat. */
const MATCH_LIST_REFRESH_MS = 3000;

/** Bot matches stop below the match cap, so ranked matches and friends' rooms always have places left. */
const MAX_BOT_MATCHES = MAX_ACTIVE_MATCHES - 15;
/** Practice sessions have their own cap and do not use up match places. */
const MAX_TRAINING_SESSIONS = 30;
/** Bot matches plus practice sessions one address may run at once; a family or a café shares one address. */
const SOLO_SESSIONS_PER_IP = 6;
/** Waiting rooms hosted from one address at once. */
const ROOMS_PER_IP = 6;
const BUSY_NETWORK = 'Mạng của bạn đang mở quá nhiều trận cùng lúc, hãy chờ các trận đó kết thúc rồi thử lại.';

const adminFlag = (u: PublicUser) => (u.role === 'admin' ? { admin: true } : {});
const roomHost = (room: PrivateRoom) => room.profiles.get(room.hostId);
/** Ranked matches only start with a full big map of real players. */
const PVP_PLAYERS = MAP_DEFS[DEFAULT_MAP].maxPlayers;

export interface GameServerOptions {
  /** Players per ranked match; only lowered by tests. */
  pvpPlayers?: number;
}

/** Optional listener for features layered on top of the lobby connection (chat, friends…). */
export interface ConnectionHooks {
  attach(socket: Socket, me: () => PublicUser): void;
  presenceChanged(userId: string): void;
}

export class GameServer {
  private hooks: ConnectionHooks | null = null;
  private readonly online = new Map<string, OnlineUser>();
  private readonly matches = new Map<string, Match>();
  private readonly userMatch = new Map<string, Match>();
  private queue: QueueEntry[] = [];
  private readonly rooms = new Map<string, PrivateRoom>();
  private readonly userRoom = new Map<string, string>();
  private readonly parties = new Map<string, Party>();
  private readonly userParty = new Map<string, string>();
  private readonly pendingLeave = new Map<string, NodeJS.Timeout>();
  private roomListTimer: NodeJS.Timeout | null = null;
  /** Admins watching a match as observers. */
  private readonly userObserve = new Map<string, Match>();
  private matchListTimer: NodeJS.Timeout | null = null;
  private readonly pvpPlayers: number;

  constructor(private readonly io: Server, opts: GameServerOptions = {}) {
    this.pvpPlayers = opts.pvpPlayers ?? PVP_PLAYERS;
    io.use(async (socket, next) => {
      const payload = verifyToken(socket.handshake.auth?.token);
      if (!payload) return next(new Error('unauthorized'));
      try {
        const row = await findUserById(payload.sub);
        if (!row || !isCurrentToken(payload, row)) return next(new Error('unauthorized'));
        socket.data.user = toPublicUser(row);
        next();
      } catch (err) {
        console.error('[socket] lỗi xác thực', err);
        next(new Error('server_error'));
      }
    });
    io.on('connection', (socket) => this.onConnection(socket));
    setInterval(() => this.queueTick(), 1000);
    setInterval(() => {
      if (io.sockets.adapter.rooms.get(MATCH_WATCHERS)?.size) this.pushMatchList();
    }, MATCH_LIST_REFRESH_MS);
  }

  // ---------------------------------------------------------------- public helpers for REST

  isInMatch(userId: string): boolean {
    const m = this.userMatch.get(userId);
    return !!m && !m.ended;
  }

  presenceOf(userId: string): Presence {
    if (!this.online.has(userId)) return 'offline';
    return this.isInMatch(userId) ? 'in_match' : 'online';
  }

  setHooks(hooks: ConnectionHooks) {
    this.hooks = hooks;
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
    const party = this.partyOf(user.id);
    if (party) {
      party.profiles.set(user.id, user);
      this.broadcastParty(party);
    }
  }

  /** An admin deleted this account: it leaves its queue, party, room and match at once, and is disconnected. */
  evictUser(userId: string) {
    this.leaveQueue(userId, false);
    this.leaveParty(userId, 'left');
    this.leaveRoom(userId);
    const match = this.userMatch.get(userId);
    if (match) {
      if (!match.ended) match.leave(match.pidOfUser(userId));
      this.userMatch.delete(userId);
      this.matchesChanged();
    }
    const o = this.online.get(userId);
    if (o) {
      o.socket.emit('account:deleted');
      o.socket.disconnect(true);
    }
    // the disconnect would otherwise hold the (now empty) places for a reconnect that cannot happen
    this.cancelLeave(userId);
  }

  roomInfo(id: string) {
    const room = this.rooms.get(id);
    if (!room) return null;
    return {
      id: room.id,
      name: room.name,
      hostName: room.profiles.get(room.hostId)?.username ?? '',
      count: room.humans.length + room.bots.length,
      max: mapCapacity(room.map),
    };
  }

  stats() {
    const queued = this.queue.reduce((n, q) => n + q.userIds.length, 0);
    return { online: this.online.size, matches: this.matches.size, queue: queued, rooms: this.rooms.size, parties: this.parties.size };
  }

  // ---------------------------------------------------------------- connection

  private onConnection(socket: Socket) {
    const user = socket.data.user as PublicUser;
    const previous = this.online.get(user.id);
    if (previous && previous.socket.id !== socket.id) {
      previous.socket.emit('session:replaced');
      previous.socket.disconnect(true);
    }
    this.online.set(user.id, { user, socket, ip: clientIp(socket.handshake.headers, socket.handshake.address) });
    this.hooks?.attach(socket, () => this.online.get(user.id)?.user ?? user);
    this.hooks?.presenceChanged(user.id);

    const lobby = new TokenBucket(20, 10);
    const inputs = new TokenBucket(120, 80);
    const actions = new TokenBucket(30, 20);
    const guard = <T extends unknown[]>(bucket: TokenBucket, fn: (...args: T) => unknown) => (...args: T) => {
      if (!bucket.take()) return;
      const fail = (err: unknown) => console.error('[socket] lỗi xử lý', err);
      try {
        const result = fn(...args);
        if (result instanceof Promise) result.catch(fail);
      } catch (err) {
        fail(err);
      }
    };

    socket.on('ping:c', guard(actions, (t: unknown, ack: unknown) => {
      if (typeof ack === 'function') ack(t);
    }));
    socket.on('queue:join', guard(lobby, () => this.joinQueue(user.id)));
    socket.on('queue:leave', guard(lobby, () => this.leaveQueue(user.id, true)));
    socket.on('party:create', guard(lobby, (size: unknown) => this.createParty(user.id, size)));
    socket.on('party:join', guard(lobby, (id: unknown) => this.joinParty(user.id, id)));
    socket.on('party:leave', guard(lobby, () => this.leaveParty(user.id, 'left')));
    socket.on('party:kick', guard(lobby, (target: unknown) => this.kickFromParty(user.id, target)));
    socket.on('party:invite', guard(lobby, (target: unknown) => this.inviteToParty(user.id, target)));
    socket.on('party:setSize', guard(lobby, (size: unknown) => this.setPartySize(user.id, size)));
    socket.on('party:setFill', guard(lobby, (fill: unknown) => this.setPartyFill(user.id, fill)));
    socket.on('party:queue', guard(lobby, () => this.queueParty(user.id)));
    // { map, difficulty }; a bare map choice (older clients) plays at the default difficulty
    socket.on('bot:start', guard(lobby, (opts: unknown) => {
      const o = typeof opts === 'object' && opts ? (opts as { map?: unknown; difficulty?: unknown }) : { map: opts };
      this.startBotMatch(user.id, o.map, o.difficulty);
    }));
    socket.on('training:start', guard(lobby, () => this.startTraining(user.id)));
    socket.on('room:create', guard(lobby, (opts: unknown) => this.createRoom(user.id, opts)));
    socket.on('rooms:watch', guard(lobby, () => {
      socket.join(ROOM_WATCHERS);
      socket.emit('rooms:list', this.roomList());
    }));
    socket.on('rooms:unwatch', guard(lobby, () => socket.leave(ROOM_WATCHERS)));
    socket.on('room:join', guard(lobby, (id: unknown) => this.joinRoom(user.id, id)));
    socket.on('room:leave', guard(lobby, () => this.leaveRoom(user.id)));
    socket.on('room:addBot', guard(lobby, () => this.addRoomBot(user.id)));
    socket.on('room:fillBots', guard(lobby, () => this.fillRoomBots(user.id)));
    socket.on('room:clearBots', guard(lobby, () => this.clearRoomBots(user.id)));
    socket.on('room:removeBot', guard(lobby, (botId: unknown) => this.removeRoomBot(user.id, botId)));
    socket.on('room:start', guard(lobby, () => this.startRoom(user.id)));
    socket.on('room:setMap', guard(lobby, (map: unknown) => this.setRoomMap(user.id, map)));
    socket.on('room:setTeamSize', guard(lobby, (size: unknown) => this.setRoomTeamSize(user.id, size)));
    socket.on('room:move', guard(lobby, (slot: unknown) => this.moveInRoom(user.id, slot)));

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
        this.hooks?.presenceChanged(user.id);
      }
      socket.emit('match:left');
    }));

    // admins only: the live match list, watching a match without playing, and removing the watched player
    socket.on('matches:watch', guard(lobby, () => {
      if (!this.isAdmin(user.id)) return;
      socket.join(MATCH_WATCHERS);
      socket.emit('matches:list', this.liveMatches());
    }));
    socket.on('matches:unwatch', guard(lobby, () => socket.leave(MATCH_WATCHERS)));
    socket.on('observe:start', guard(lobby, (id: unknown) => this.startObserving(user.id, socket, id)));
    socket.on('observe:step', guard(actions, (dir: unknown) => {
      const m = this.userObserve.get(user.id);
      if (m && !m.ended) m.stepObserver(user.id, dir === -1 ? -1 : 1);
    }));
    socket.on('observe:stop', guard(lobby, () => {
      this.stopObserving(user.id);
      socket.emit('match:left');
    }));
    socket.on('observe:kick', guard(lobby, (pid: unknown) => this.kickWatched(user.id, pid)));

    socket.on('disconnect', () => {
      this.stopObserving(user.id, socket);
      if (this.online.get(user.id)?.socket !== socket) return;
      this.online.delete(user.id);
      this.hooks?.presenceChanged(user.id);
      const party = this.partyOf(user.id);
      if (party) this.broadcastParty(party);
      // phones drop the socket when the user switches app (e.g. to send the invite link), so keep their place for a while
      this.cancelLeave(user.id);
      this.pendingLeave.set(
        user.id,
        setTimeout(() => {
          this.pendingLeave.delete(user.id);
          if (this.online.has(user.id)) return;
          this.leaveQueue(user.id, false);
          this.leaveRoom(user.id);
          // a party member who is still playing keeps their slot until they come back or the match is over
          if (!this.isInMatch(user.id)) this.leaveParty(user.id, 'left');
        }, RECONNECT_GRACE_MS),
      );
      const m = this.userMatch.get(user.id);
      if (m && !m.ended) m.detachSocket(m.pidOfUser(user.id));
    });

    this.cancelLeave(user.id);
    const party = this.partyOf(user.id);
    if (party) {
      party.profiles.set(user.id, user);
      this.broadcastParty(party);
    }
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

  /** Tells a (re)connected client whether it still has a room, party or queue place. */
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
    const party = this.partyOf(userId);
    if (party) socket.emit('party:state', this.partyState(party));
    else socket.emit('party:closed', { reason: 'gone' });
    if (this.ticketOf(userId)) this.sendQueueStatus();
    else socket.emit('queue:status', this.idleQueueStatus());
  }

  private emitError(userId: string, text: string) {
    this.online.get(userId)?.socket.emit('error:msg', { text });
  }

  private isBusy(userId: string, ignoreParty = false): string | null {
    if (this.isInMatch(userId)) return 'Bạn đang ở trong một trận đấu.';
    if (this.userObserve.has(userId)) return 'Bạn đang xem một trận đấu.';
    if (this.ticketOf(userId)) return 'Bạn đang trong hàng chờ ghép trận.';
    if (this.userRoom.has(userId)) return 'Bạn đang ở trong phòng chờ.';
    if (!ignoreParty && this.userParty.has(userId)) return 'Bạn đang ở trong một nhóm, hãy rời nhóm trước.';
    return null;
  }

  private participantOf(user: PublicUser): Participant {
    return { userId: user.id, name: user.username, avatar: user.avatar, level: user.level, isBot: false, ...adminFlag(user) };
  }

  private makeBots(count: number, taken?: ReadonlySet<string>): RoomBot[] {
    return botNames(count, taken).map((name) => ({
      id: randomUUID(),
      name,
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      level: 1 + Math.floor(Math.random() * 20),
    }));
  }

  // ---------------------------------------------------------------- matches

  private countMatches(mode?: GameMode): number {
    let n = 0;
    for (const m of this.matches.values()) if (mode ? m.mode === mode : m.mode !== 'training') n++;
    return n;
  }

  /** Whether another match of this mode fits under the server caps. */
  private hasRoomFor(mode: GameMode): boolean {
    if (mode === 'training') return this.countMatches('training') < MAX_TRAINING_SESSIONS;
    if (mode === 'bots' && this.countMatches('bots') >= MAX_BOT_MATCHES) return false;
    return this.countMatches() < MAX_ACTIVE_MATCHES;
  }

  /** Bot matches and practice sessions played right now by people connected from `ip`. */
  private soloSessionsFrom(ip: string): number {
    let n = 0;
    for (const [id, o] of this.online) {
      const m = this.userMatch.get(id);
      if (o.ip === ip && m && !m.ended && (m.mode === 'bots' || m.mode === 'training')) n++;
    }
    return n;
  }

  private createMatch(mode: GameMode, participants: Participant[], map: MapChoice = 'random', botSpeed = 1, teamSize: TeamSize = 1): Match | null {
    if (!this.hasRoomFor(mode)) {
      for (const p of participants) if (p.userId) this.emitError(p.userId, 'Máy chủ đang đầy trận, vui lòng thử lại sau ít phút.');
      return null;
    }
    const lobbyMs = mode === 'pvp' || mode === 'private' ? PREMATCH_LOBBY_MS : 0;
    const match = new Match(randomUUID(), mode, participants, {
      onEnd: (m, results, winnerName) => this.onMatchEnd(m, results, winnerName),
    }, resolveMapChoice(map, participants.length), botSpeed, teamSize, lobbyMs);
    this.matches.set(match.id, match);
    for (const p of match.players) {
      if (!p.userId) continue;
      this.userMatch.set(p.userId, match);
      const o = this.online.get(p.userId);
      if (o) match.attachSocket(p.pid, o.socket);
      this.hooks?.presenceChanged(p.userId);
    }
    console.log(`[match] bắt đầu ${match.id} (${mode}${teamSize > 1 ? ` nhóm ${teamSize}` : ''}, ${match.mapId}, ${participants.length} người)`);
    this.matchesChanged();
    return match;
  }

  private onMatchEnd(match: Match, results: MatchResultPlayer[], winnerName: string) {
    this.matches.delete(match.id);
    for (const id of match.observerIds()) {
      if (this.userObserve.get(id) === match) this.userObserve.delete(id);
    }
    this.matchesChanged();
    for (const p of match.players) {
      if (p.userId && this.userMatch.get(p.userId) === match) {
        this.userMatch.delete(p.userId);
        this.hooks?.presenceChanged(p.userId);
        // party members who dropped out mid-match and never came back free their slot now
        if (!this.online.has(p.userId) && !this.pendingLeave.has(p.userId)) this.leaveParty(p.userId, 'left');
      }
    }
    console.log(`[match] kết thúc ${match.id}, người thắng: ${winnerName}`);
    if (!results.length) return;
    saveMatch({
      id: match.id,
      mode: match.mode,
      mapId: match.mapId,
      playerCount: match.players.length,
      teamSize: match.teamSize,
      winnerName,
      startedAt: match.startedAt,
      endedAt: new Date(),
      players: results,
    }).catch((err) => console.error('[db] không lưu được kết quả trận', err));
  }

  private startBotMatch(userId: string, map: unknown, difficulty: unknown) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    const o = this.online.get(userId);
    if (!o) return;
    if (this.soloSessionsFrom(o.ip) >= SOLO_SESSIONS_PER_IP) return this.emitError(userId, BUSY_NETWORK);
    const mapId = resolveMapChoice(isMapChoice(map) ? map : 'random');
    const bots = this.makeBots(MAP_DEFS[mapId].maxPlayers - 1).map<Participant>((b) => ({ userId: null, name: b.name, avatar: b.avatar, level: b.level, isBot: true }));
    const speed = BOT_SPEED_MULTIPLIER[isBotDifficulty(difficulty) ? difficulty : DEFAULT_BOT_DIFFICULTY];
    this.createMatch('bots', [this.participantOf(o.user), ...bots], mapId, speed);
  }

  private startTraining(userId: string) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    const o = this.online.get(userId);
    if (!o) return;
    if (this.soloSessionsFrom(o.ip) >= SOLO_SESSIONS_PER_IP) return this.emitError(userId, BUSY_NETWORK);
    this.createMatch('training', [this.participantOf(o.user)], TRAINING_MAP);
  }

  // ---------------------------------------------------------------- matchmaking

  private ticketOf(userId: string): QueueEntry | undefined {
    return this.queue.find((q) => q.userIds.includes(userId));
  }

  private idleQueueStatus(): QueueStatusMsg {
    return { inQueue: false, count: 0, needed: this.pvpPlayers, waitedMs: 0, notice: false, teamSize: 1 };
  }

  /** Solo queue; duo and squad go through a party (`party:queue`). */
  private joinQueue(userId: string) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    this.queue.push({ id: userId, userIds: [userId], fill: true, joinedAt: Date.now(), teamSize: 1, partyId: null });
    this.sendQueueStatus();
  }

  /** Any member cancelling takes the whole ticket (their party too) out of the queue. */
  private leaveQueue(userId: string, notify: boolean) {
    const ticket = this.ticketOf(userId);
    if (!ticket) return;
    this.queue = this.queue.filter((q) => q !== ticket);
    for (const id of ticket.userIds) {
      if (notify || id !== userId) this.online.get(id)?.socket.emit('queue:status', this.idleQueueStatus());
    }
    const party = ticket.partyId ? this.parties.get(ticket.partyId) : undefined;
    if (party) this.broadcastParty(party);
    this.sendQueueStatus();
  }

  private queueTick() {
    for (const teamSize of TEAM_SIZES) {
      while (this.hasRoomFor('pvp')) {
        // tickets with someone offline wait (they keep their place during the reconnect grace)
        const ready = this.queue.filter((q) => q.teamSize === teamSize && q.userIds.every((id) => this.online.has(id)));
        const teams = packMatch(ready, teamSize, this.pvpPlayers);
        if (!teams) break;
        const used = new Set(teams.flat());
        this.queue = this.queue.filter((q) => !used.has(q));
        const parts: Participant[] = teams.flatMap((team, i) =>
          team.flatMap((t) => t.userIds.map((id) => ({ ...this.participantOf(this.online.get(id)!.user), team: i }))),
        );
        for (const t of used) {
          const party = t.partyId ? this.parties.get(t.partyId) : undefined;
          if (party) this.broadcastParty(party);
        }
        this.createMatch('pvp', parts, DEFAULT_MAP, 1, teamSize);
      }
    }
    this.sendQueueStatus();
  }

  private sendQueueStatus() {
    const now = Date.now();
    const counts = new Map<number, number>();
    for (const q of this.queue) counts.set(q.teamSize, (counts.get(q.teamSize) ?? 0) + q.userIds.length);
    for (const q of this.queue) {
      const waitedMs = now - q.joinedAt;
      const party = q.partyId ? this.parties.get(q.partyId) : undefined;
      for (const id of q.userIds) {
        const msg: QueueStatusMsg = {
          inQueue: true,
          count: counts.get(q.teamSize) ?? 0,
          needed: this.pvpPlayers,
          waitedMs,
          notice: waitedMs >= QUEUE_NOTICE_AFTER_MS,
          teamSize: q.teamSize,
          ...(party ? { party: { members: q.userIds.length, fill: q.fill, leader: party.leaderId === id } } : {}),
        };
        this.online.get(id)?.socket.emit('queue:status', msg);
      }
    }
  }

  // ---------------------------------------------------------------- parties (duo / squad)

  private partyOf(userId: string): Party | undefined {
    const id = this.userParty.get(userId);
    return id ? this.parties.get(id) : undefined;
  }

  private partyState(party: Party): PartyStateMsg {
    return {
      id: party.id,
      leaderId: party.leaderId,
      size: party.size,
      fill: party.fill,
      members: party.members.map((id) => {
        const u = party.profiles.get(id)!;
        return { id, name: u.username, avatar: u.avatar, level: u.level, online: this.online.has(id), ...adminFlag(u) };
      }),
      inQueue: this.queue.some((q) => q.partyId === party.id),
    };
  }

  private broadcastParty(party: Party) {
    const state = this.partyState(party);
    for (const id of party.members) this.online.get(id)?.socket.emit('party:state', state);
  }

  /** The caller's party if they lead it and it is not searching; reports why not otherwise. */
  private ledParty(userId: string): Party | null {
    const party = this.partyOf(userId);
    if (!party) return null;
    if (party.leaderId !== userId) {
      this.emitError(userId, 'Chỉ trưởng nhóm mới làm được việc này.');
      return null;
    }
    if (this.queue.some((q) => q.partyId === party.id)) {
      this.emitError(userId, 'Nhóm đang tìm trận, hãy hủy tìm trước.');
      return null;
    }
    return party;
  }

  private createParty(userId: string, size: unknown) {
    if (!isPartySize(size)) return;
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    if (this.parties.size >= MAX_PARTIES) return this.emitError(userId, 'Máy chủ đang quá tải, vui lòng thử lại sau.');
    const o = this.online.get(userId);
    if (!o) return;
    const party: Party = {
      id: randomUUID(), leaderId: userId, size, fill: true, members: [userId],
      profiles: new Map([[userId, o.user]]), invitedAt: new Map(),
    };
    this.parties.set(party.id, party);
    this.userParty.set(userId, party.id);
    this.broadcastParty(party);
  }

  private joinParty(userId: string, id: unknown) {
    if (!isUuid(id)) return this.emitError(userId, 'Mã nhóm không hợp lệ.');
    const party = this.parties.get(id);
    if (!party) return this.emitError(userId, 'Nhóm không còn tồn tại.');
    if (party.members.includes(userId)) return this.broadcastParty(party);
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    if (party.members.length >= party.size) return this.emitError(userId, `Nhóm đã đủ ${party.size} người.`);
    if (this.queue.some((q) => q.partyId === party.id)) return this.emitError(userId, 'Nhóm đang tìm trận, hãy chờ trưởng nhóm hủy tìm.');
    if (party.members.some((m) => this.isInMatch(m))) return this.emitError(userId, 'Nhóm đang trong trận, hãy thử lại sau.');
    const o = this.online.get(userId);
    if (!o) return;
    party.members.push(userId);
    party.profiles.set(userId, o.user);
    party.invitedAt.delete(userId);
    this.userParty.set(userId, party.id);
    this.broadcastParty(party);
  }

  private leaveParty(userId: string, reason: 'left' | 'kicked') {
    const party = this.partyOf(userId);
    if (!party) return;
    if (this.queue.some((q) => q.partyId === party.id)) this.leaveQueue(userId, true);
    this.userParty.delete(userId);
    party.members = party.members.filter((m) => m !== userId);
    party.profiles.delete(userId);
    this.online.get(userId)?.socket.emit('party:closed', { reason });
    if (!party.members.length) {
      this.parties.delete(party.id);
      return;
    }
    if (party.leaderId === userId) party.leaderId = party.members.find((m) => this.online.has(m)) ?? party.members[0];
    this.broadcastParty(party);
  }

  private kickFromParty(userId: string, target: unknown) {
    const party = this.ledParty(userId);
    if (!party || typeof target !== 'string' || target === userId || !party.members.includes(target)) return;
    this.leaveParty(target, 'kicked');
  }

  private async inviteToParty(userId: string, target: unknown) {
    const party = this.partyOf(userId);
    if (!party || typeof target !== 'string' || !isUuid(target) || target === userId) return;
    if (party.members.includes(target)) return;
    if (party.members.length >= party.size) return this.emitError(userId, `Nhóm đã đủ ${party.size} người.`);
    const last = party.invitedAt.get(target) ?? 0;
    if (Date.now() - last < INVITE_COOLDOWN_MS) return this.emitError(userId, 'Bạn vừa mời người này, hãy chờ một chút.');
    party.invitedAt.set(target, Date.now());
    if (!(await areFriends(userId, target))) return this.emitError(userId, 'Chỉ mời được bạn bè.');
    const o = this.online.get(target);
    if (!o) return this.emitError(userId, 'Người này đang ngoại tuyến.');
    if (this.isInMatch(target)) return this.emitError(userId, 'Người này đang trong trận.');
    if (this.userParty.has(target)) return this.emitError(userId, 'Người này đã ở trong một nhóm khác.');
    const me = party.profiles.get(userId);
    if (!me || !this.parties.has(party.id)) return;
    const msg: PartyInviteMsg = { partyId: party.id, size: party.size, from: { id: userId, username: me.username, avatar: me.avatar, ...adminFlag(me) } };
    o.socket.emit('party:invite', msg);
    this.online.get(userId)?.socket.emit('party:invited', { userId: target });
  }

  private setPartySize(userId: string, size: unknown) {
    if (!isPartySize(size)) return;
    const party = this.ledParty(userId);
    if (!party || party.size === size) return;
    if (party.members.length > size) return this.emitError(userId, `Nhóm đang có ${party.members.length} người, không thể đổi sang nhóm ${size}.`);
    party.size = size;
    this.broadcastParty(party);
  }

  private setPartyFill(userId: string, fill: unknown) {
    if (typeof fill !== 'boolean') return;
    const party = this.ledParty(userId);
    if (!party || party.fill === fill) return;
    party.fill = fill;
    this.broadcastParty(party);
  }

  private queueParty(userId: string) {
    const party = this.ledParty(userId);
    if (!party) return;
    for (const id of party.members) {
      const name = party.profiles.get(id)?.username ?? '';
      if (!this.online.has(id)) return this.emitError(userId, `${name} đang mất kết nối.`);
      const busy = this.isBusy(id, true);
      if (busy) return this.emitError(userId, id === userId ? busy : `${name} chưa sẵn sàng (đang trong trận hoặc phòng chờ).`);
    }
    this.queue.push({
      id: party.id, userIds: [...party.members], fill: party.fill, joinedAt: Date.now(), teamSize: party.size, partyId: party.id,
    });
    this.broadcastParty(party);
    this.sendQueueStatus();
  }

  // ---------------------------------------------------------------- private rooms

  private roomState(room: PrivateRoom): RoomStateMsg {
    const members: RoomMember[] = [
      ...room.humans.map((id) => {
        const u = room.profiles.get(id)!;
        return { id, name: u.username, avatar: u.avatar, level: u.level, isBot: false, slot: room.slots.get(id) ?? null, ...adminFlag(u) };
      }),
      ...room.bots.map((b) => ({ id: b.id, name: b.name, avatar: b.avatar, level: b.level, isBot: true, slot: room.slots.get(b.id) ?? null })),
    ];
    return {
      id: room.id, name: room.name, listed: room.listed, hostId: room.hostId, members,
      max: mapCapacity(room.map), min: MIN_PRIVATE_ROOM_PLAYERS, map: room.map, teamSize: room.teamSize,
    };
  }

  /** Listed rooms, open ones with the most players first. */
  private roomList(): RoomSummary[] {
    const full = (r: PrivateRoom) => Number(this.roomFull(r));
    return [...this.rooms.values()]
      .filter((r) => r.listed && roomHost(r))
      .sort((a, b) => full(a) - full(b) || b.humans.length - a.humans.length || b.createdAt - a.createdAt)
      .slice(0, ROOM_LIST_MAX)
      .map((room) => {
        const host = roomHost(room)!;
        return {
          id: room.id,
          name: room.name,
          host: { name: host.username, avatar: host.avatar, ...adminFlag(host) },
          players: room.humans.length + room.bots.length,
          humans: room.humans.length,
          max: mapCapacity(room.map),
          map: room.map,
          teamSize: room.teamSize,
        };
      });
  }

  private roomsChanged() {
    if (this.roomListTimer) return;
    this.roomListTimer = setTimeout(() => {
      this.roomListTimer = null;
      this.io.to(ROOM_WATCHERS).emit('rooms:list', this.roomList());
    }, ROOM_LIST_DELAY_MS);
  }

  private seatBots(room: PrivateRoom, count: number) {
    const bots = this.makeBots(count, new Set(room.bots.map((b) => b.name)));
    for (const b of bots) {
      room.bots.push(b);
      room.slots.set(b.id, freeSlot(room.slots, mapCapacity(room.map)));
    }
  }

  private broadcastRoom(room: PrivateRoom) {
    const state = this.roomState(room);
    for (const id of room.humans) this.online.get(id)?.socket.emit('room:state', state);
    this.roomsChanged();
  }

  private createRoom(userId: string, opts: unknown) {
    const busy = this.isBusy(userId);
    if (busy) return this.emitError(userId, busy);
    const req = typeof opts === 'object' && opts ? (opts as { teamSize?: unknown; name?: unknown; listed?: unknown }) : { teamSize: opts };
    const name = cleanText(req.name, ROOM_NAME_MAX_LENGTH);
    const nameError = validateRoomName(name);
    if (nameError) return this.emitError(userId, nameError);
    if (this.rooms.size >= MAX_PRIVATE_ROOMS) return this.emitError(userId, 'Đã đạt số phòng tối đa, vui lòng thử lại sau.');
    const o = this.online.get(userId);
    if (!o) return;
    let hosted = 0;
    for (const r of this.rooms.values()) if (this.online.get(r.hostId)?.ip === o.ip) hosted++;
    if (hosted >= ROOMS_PER_IP) return this.emitError(userId, 'Mạng của bạn đang mở quá nhiều phòng chờ cùng lúc, hãy vào phòng có sẵn hoặc thử lại sau.');
    const room: PrivateRoom = {
      id: randomUUID(),
      name: name || `Phòng của ${o.user.username}`,
      listed: req.listed !== false,
      createdAt: Date.now(),
      hostId: userId, humans: [userId], bots: [], profiles: new Map([[userId, o.user]]), map: DEFAULT_MAP,
      teamSize: isTeamSize(req.teamSize) ? req.teamSize : 1, slots: new Map([[userId, 0]]),
    };
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
    if (this.roomFull(room)) return this.emitError(userId, `Phòng đã đủ ${mapCapacity(room.map)} người.`);
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
    room.slots.delete(userId);
    if (!room.humans.length) {
      this.rooms.delete(id);
      this.roomsChanged();
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
    if (this.roomFull(room)) return this.emitError(userId, `Phòng đã đủ ${mapCapacity(room.map)} người.`);
    this.seatBots(room, 1);
    this.broadcastRoom(room);
  }

  private fillRoomBots(userId: string) {
    const room = this.hostRoom(userId);
    if (!room) return;
    const free = mapCapacity(room.map) - room.humans.length - room.bots.length;
    if (free <= 0) return this.emitError(userId, `Phòng đã đủ ${mapCapacity(room.map)} người.`);
    this.seatBots(room, free);
    this.broadcastRoom(room);
  }

  private clearRoomBots(userId: string) {
    const room = this.hostRoom(userId);
    if (!room || !room.bots.length) return;
    for (const b of room.bots) room.slots.delete(b.id);
    room.bots = [];
    this.broadcastRoom(room);
  }

  private roomFull(room: PrivateRoom): boolean {
    return room.humans.length + room.bots.length >= mapCapacity(room.map);
  }

  private removeRoomBot(userId: string, botId: unknown) {
    const room = this.hostRoom(userId);
    if (!room || typeof botId !== 'string' || !room.bots.some((b) => b.id === botId)) return;
    room.bots = room.bots.filter((b) => b.id !== botId);
    room.slots.delete(botId);
    this.broadcastRoom(room);
  }

  private setRoomMap(userId: string, map: unknown) {
    if (!isMapChoice(map)) return;
    const room = this.hostRoom(userId);
    if (!room || room.map === map) return;
    const total = room.humans.length + room.bots.length;
    if (total > mapCapacity(map)) {
      return this.emitError(userId, `Bản đồ này tối đa ${mapCapacity(map)} người, phòng đang có ${total}. Hãy bớt bot trước.`);
    }
    room.map = map;
    fitSlots(room.slots, mapCapacity(map));
    this.broadcastRoom(room);
  }

  /** Everyone keeps their slot; the slots just regroup into teams of the new size. */
  private setRoomTeamSize(userId: string, size: unknown) {
    if (!isTeamSize(size)) return;
    const room = this.hostRoom(userId);
    if (!room || room.teamSize === size) return;
    room.teamSize = size;
    this.broadcastRoom(room);
  }

  /** A player moves themselves to an empty slot (another team in team rooms). */
  private moveInRoom(userId: string, slot: unknown) {
    const id = this.userRoom.get(userId);
    const room = id ? this.rooms.get(id) : undefined;
    if (!room || typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= mapCapacity(room.map)) return;
    if (room.slots.get(userId) === slot) return;
    if ([...room.slots.values()].includes(slot)) return this.emitError(userId, 'Ô này đã có người.');
    room.slots.set(userId, slot);
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
    const unseated = humans.filter((id) => !room.slots.has(id)).length;
    if (room.teamSize > 1 && unseated) {
      return this.emitError(userId, `Còn ${unseated} người chưa chọn đội. Mỗi người bấm vào một ô trống để vào đội mình muốn.`);
    }
    const seated = new Map([...room.slots].filter(([id]) => humans.includes(id) || room.bots.some((b) => b.id === id)));
    const teams = roomTeams(seated, room.teamSize);
    if (room.teamSize > 1 && new Set(teams.values()).size < 2) {
      return this.emitError(userId, 'Cần ít nhất 2 đội có người (có thể thêm bot) để bắt đầu.');
    }
    const team = (id: string) => (room.teamSize > 1 ? { team: teams.get(id)! } : {});
    const parts: Participant[] = [
      ...humans.map((id) => ({ ...this.participantOf(room.profiles.get(id)!), ...team(id) })),
      ...room.bots.map<Participant>((b) => ({ userId: null, name: b.name, avatar: b.avatar, level: b.level, isBot: true, ...team(b.id) })),
    ];
    this.rooms.delete(room.id);
    this.roomsChanged();
    for (const id of room.humans) this.userRoom.delete(id);
    const match = this.createMatch('private', parts, room.map, 1, room.teamSize);
    if (match) match.title = room.name;
  }

  // ---------------------------------------------------------------- admin: live matches

  private isAdmin(userId: string): boolean {
    return this.online.get(userId)?.user.role === 'admin';
  }

  /** Matches being played right now (practice sessions excluded), most humans first. */
  private liveMatches(): LiveMatchSummary[] {
    return [...this.matches.values()]
      .filter((m) => !m.ended && m.mode !== 'training')
      .map((m) => m.summary())
      .sort((a, b) => b.humans - a.humans || b.elapsedMs - a.elapsedMs);
  }

  private pushMatchList() {
    this.io.to(MATCH_WATCHERS).emit('matches:list', this.liveMatches());
  }

  private matchesChanged() {
    if (this.matchListTimer) return;
    this.matchListTimer = setTimeout(() => {
      this.matchListTimer = null;
      this.pushMatchList();
    }, ROOM_LIST_DELAY_MS);
  }

  private startObserving(userId: string, socket: Socket, id: unknown) {
    if (!this.isAdmin(userId)) return this.emitError(userId, 'Chỉ quản trị viên mới xem được trận đang đấu.');
    const busy = this.isBusy(userId, true);
    if (busy) return this.emitError(userId, busy);
    const match = typeof id === 'string' ? this.matches.get(id) : undefined;
    if (!match || match.ended || match.mode === 'training') return this.emitError(userId, 'Trận đấu này đã kết thúc.');
    this.userObserve.set(userId, match);
    match.observe(userId, socket);
    this.matchesChanged();
    console.log(`[admin] ${this.online.get(userId)?.user.username} vào xem trận ${match.id}`);
  }

  private stopObserving(userId: string, socket?: Socket) {
    const match = this.userObserve.get(userId);
    if (!match || !match.unobserve(userId, socket)) return;
    this.userObserve.delete(userId);
    this.matchesChanged();
  }

  private kickWatched(adminId: string, pid: unknown) {
    if (!this.isAdmin(adminId)) return;
    const match = this.userObserve.get(adminId);
    if (!match || match.ended) return;
    const p = match.kick(adminId, Number(pid));
    if (!p) return this.emitError(adminId, 'Không kích được: người này đã rời trận hoặc bạn đang xem người khác.');
    if (p.userId && this.userMatch.get(p.userId) === match) {
      this.userMatch.delete(p.userId);
      this.hooks?.presenceChanged(p.userId);
    }
    this.matchesChanged();
    console.log(`[admin] ${this.online.get(adminId)?.user.username} kích ${p.name} khỏi trận ${match.id}`);
  }
}
