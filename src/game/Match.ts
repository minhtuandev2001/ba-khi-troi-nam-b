import type { Socket } from 'socket.io';
import {
  AIRDROP_ANNOUNCE_MS,
  AIRDROP_INTERVAL_MS,
  AIRDROP_SIZE,
  AMMO_PICKUP_AMOUNT,
  ARMOR,
  BAG_CAPACITY,
  CHEST_HP,
  CHEST_LOOT_TABLE,
  CollisionWorld,
  GROUND_LOOT_TABLE,
  INTERACT_RANGE,
  ITEMS,
  MAP_SIZE,
  MAX_HP,
  MEDKIT,
  PICKUP_RANGE,
  PLAYER_RADIUS,
  SCOPE_LEVELS,
  SNAPSHOT_EVERY_TICKS,
  SPAWN_MIN_DISTANCE,
  THROWABLE,
  TICK_MS,
  WEAPONS,
  ZONE_PHASES,
  ZONE_TOTAL_MS,
  ammoItemFor,
  angleDiff,
  chestRect,
  circleRectOverlap,
  clamp,
  createRng,
  generateMap,
  isOutsideZone,
  pickWeighted,
  playerSpeed,
  rectContains,
  roomAt,
  scopeOfItem,
  segmentCircle,
  stepMovement,
  viewRadius,
  zoneAt,
  PFLAG_DISCONNECTED,
  PFLAG_HEALING,
  PFLAG_RELOADING,
  type ActionMsg,
  type AirdropNet,
  type AmmoType,
  type ArmorLevel,
  type BagLevel,
  type DeathMsg,
  type GameEvent,
  type GameMap,
  type GameMode,
  type InputMsg,
  type ItemId,
  type LeaderboardEntry,
  type LootNet,
  type MatchEndMsg,
  type MatchStartMsg,
  type PlayerNet,
  type RosterEntry,
  type ScopeLevel,
  type SelfNet,
  type SlotName,
  type SnapshotMsg,
  type WeaponId,
  type ZoneCircle,
  type ZoneState,
  AMMO_TYPES,
  xpForMatch,
} from '../shared';
import { Bot } from './Bot';

export interface Participant {
  userId: string | null;
  name: string;
  avatar: string;
  level: number;
  isBot: boolean;
}

export interface WeaponSlot {
  w: WeaponId;
  mag: number;
}

export interface Player extends Participant {
  pid: number;
  socket: Socket | null;
  connected: boolean;
  left: boolean;
  x: number;
  y: number;
  a: number;
  hp: number;
  armor: ArmorLevel;
  armorDur: number;
  bag: BagLevel;
  scope: ScopeLevel;
  scopes: Set<ScopeLevel>;
  p1: WeaponSlot | null;
  p2: WeaponSlot | null;
  pistol: WeaponSlot | null;
  melee: WeaponId;
  active: SlotName;
  lastWeaponSlot: SlotName;
  ammo: Record<AmmoType, number>;
  med: number;
  gren: number;
  smoke: number;
  alive: boolean;
  deathTime: number;
  placement: number;
  kills: number;
  damage: number;
  killer: number;
  killWeapon: string;
  mx: number;
  my: number;
  fire: boolean;
  prevFire: boolean;
  td: number;
  moving: boolean;
  inputQueue: InputMsg[];
  lastSeq: number;
  inputTokens: number;
  nextFireAt: number;
  reloadUntil: number;
  reloadSlot: SlotName | null;
  healUntil: number;
  room: number;
  knownLoot: Set<number>;
  events: GameEvent[];
  spectating: number;
  bot: Bot | null;
}

export interface Loot {
  id: number;
  item: ItemId;
  x: number;
  y: number;
  amount: number;
  room: number;
}

interface Bullet {
  id: number;
  owner: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  traveled: number;
  range: number;
  damage: number;
  weapon: WeaponId;
  falloffStart: number;
  falloffMin: number;
}

interface Throwable {
  id: number;
  kind: 0 | 1;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  flightLeft: number;
  triggerAt: number;
}

export interface Smoke {
  id: number;
  x: number;
  y: number;
  startAt: number;
  endAt: number;
}

interface Airdrop {
  id: number;
  x: number;
  y: number;
  landAt: number;
}

export interface MatchResultPlayer {
  userId: string;
  placement: number;
  kills: number;
  damage: number;
  survivalMs: number;
  xpGained: number;
}

export interface MatchCallbacks {
  onEnd(match: Match, players: MatchResultPlayer[], winnerName: string): void;
}

const TICK_S = TICK_MS / 1000;
const SWAP_DELAY_MS = 250;

export class Match {
  readonly map: GameMap;
  readonly world: CollisionWorld;
  readonly players: Player[] = [];
  readonly loot = new Map<number, Loot>();
  readonly smokes: Smoke[] = [];
  readonly startedAt = new Date();
  zone: ZoneState;
  ended = false;

  private readonly seed: number;
  private readonly rng = Math.random;
  private readonly zoneCircles: ZoneCircle[];
  private readonly chestHp: number[];
  private bullets: Bullet[] = [];
  private throwables: Throwable[] = [];
  private airdrops: Airdrop[] = [];
  private nextAirdropAt = AIRDROP_INTERVAL_MS;
  private airdropAnnounced = false;
  private nextId = 1;
  private simTime = 0;
  private tickCount = 0;
  private lastRealTime = performance.now();
  private pendingDeaths: Player[] = [];
  private timer: NodeJS.Timeout;

  constructor(
    readonly id: string,
    readonly mode: GameMode,
    participants: Participant[],
    private readonly callbacks: MatchCallbacks,
  ) {
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.map = generateMap(this.seed);
    this.world = new CollisionWorld(this.map);
    this.chestHp = this.map.chests.map(() => CHEST_HP);
    this.zoneCircles = this.buildZoneCircles();
    this.zone = zoneAt(this.zoneCircles, 0);

    participants.forEach((part, pid) => this.players.push(this.createPlayer(part, pid)));
    this.spawnPlayers();
    this.spawnInitialLoot();

    this.timer = setInterval(() => this.loop(), TICK_MS);
  }

  get now(): number {
    return this.simTime;
  }

  get aliveCount(): number {
    let n = 0;
    for (const p of this.players) if (p.alive) n++;
    return n;
  }

  // ---------------------------------------------------------------- setup

  private createPlayer(part: Participant, pid: number): Player {
    const p: Player = {
      ...part,
      pid,
      socket: null,
      connected: part.isBot,
      left: false,
      x: 0, y: 0, a: 0,
      hp: MAX_HP,
      armor: 0, armorDur: 0, bag: 0,
      scope: 1, scopes: new Set<ScopeLevel>([1]),
      p1: null, p2: null, pistol: null, melee: 'fists',
      active: 'melee', lastWeaponSlot: 'melee',
      ammo: { '9mm': 0, '556': 0, '12g': 0, '762': 0 },
      med: 0, gren: 0, smoke: 0,
      alive: true, deathTime: 0, placement: 0, kills: 0, damage: 0, killer: -1, killWeapon: '',
      mx: 0, my: 0, fire: false, prevFire: false, td: 200, moving: false,
      inputQueue: [], lastSeq: 0, inputTokens: 3,
      nextFireAt: 0, reloadUntil: 0, reloadSlot: null, healUntil: 0,
      room: -1,
      knownLoot: new Set(),
      events: [],
      spectating: pid,
      bot: null,
    };
    if (part.isBot) p.bot = new Bot(this.rng);
    return p;
  }

  private buildZoneCircles(): ZoneCircle[] {
    const rng = createRng(this.seed ^ 0x5bd1e995);
    const circles: ZoneCircle[] = [{ x: MAP_SIZE / 2, y: MAP_SIZE / 2, r: MAP_SIZE * 0.75 }];
    for (const phase of ZONE_PHASES) {
      const prev = circles[circles.length - 1];
      const r = phase.radiusFraction * MAP_SIZE;
      const maxOffset = Math.max(0, Math.min(prev.r, MAP_SIZE * 0.5) - r) * 0.85;
      let x = prev.x;
      let y = prev.y;
      for (let i = 0; i < 30; i++) {
        const ang = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * maxOffset;
        const cx = prev.x + Math.cos(ang) * d;
        const cy = prev.y + Math.sin(ang) * d;
        const margin = r + 200;
        if (cx > margin && cx < MAP_SIZE - margin && cy > margin && cy < MAP_SIZE - margin) {
          x = cx;
          y = cy;
          break;
        }
      }
      circles.push({ x, y, r });
    }
    return circles;
  }

  private insideHouse(x: number, y: number, margin: number): boolean {
    return this.map.houses.some((h) =>
      rectContains({ x: h.x - margin, y: h.y - margin, w: h.w + margin * 2, h: h.h + margin * 2 }, x, y),
    );
  }

  private freeSpot(x: number, y: number, r: number): { x: number; y: number } {
    for (let i = 0; i < 40; i++) {
      const ang = this.rng() * Math.PI * 2;
      const d = i === 0 ? 0 : 10 + i * 6;
      const px = clamp(x + Math.cos(ang) * d, 60, MAP_SIZE - 60);
      const py = clamp(y + Math.sin(ang) * d, 60, MAP_SIZE - 60);
      if (!this.world.overlapsCircle(px, py, r)) return { x: px, y: py };
    }
    return { x, y };
  }

  private spawnPlayers() {
    const placed: { x: number; y: number }[] = [];
    for (const p of this.players) {
      let best = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
      let bestScore = -1;
      for (let i = 0; i < 300; i++) {
        const x = 200 + this.rng() * (MAP_SIZE - 400);
        const y = 200 + this.rng() * (MAP_SIZE - 400);
        if (this.world.overlapsCircle(x, y, PLAYER_RADIUS + 12) || this.insideHouse(x, y, 30)) continue;
        const nearest = placed.reduce((m, q) => Math.min(m, Math.hypot(q.x - x, q.y - y)), Infinity);
        if (nearest >= SPAWN_MIN_DISTANCE) {
          best = { x, y };
          bestScore = Infinity;
          break;
        }
        if (nearest > bestScore) {
          bestScore = nearest;
          best = { x, y };
        }
      }
      p.x = best.x;
      p.y = best.y;
      p.a = this.rng() * Math.PI * 2;
      placed.push(best);
    }
  }

  private spawnInitialLoot() {
    const rng = this.rng;
    const spawnGround = (x: number, y: number) => {
      const item = pickWeighted(rng, GROUND_LOOT_TABLE);
      this.spawnLoot(item, x, y);
      const w = WEAPONS[item as WeaponId];
      if (w?.ammo) this.spawnLoot(ammoItemFor(w.ammo), x + 26, y + 10);
    };
    for (const room of this.map.rooms) {
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        spawnGround(room.x + 40 + rng() * (room.w - 80), room.y + 40 + rng() * (room.h - 80));
      }
    }
    let outdoor = 0;
    for (let i = 0; i < 2000 && outdoor < 160; i++) {
      const x = 100 + rng() * (MAP_SIZE - 200);
      const y = 100 + rng() * (MAP_SIZE - 200);
      if (this.insideHouse(x, y, 20) || this.world.overlapsCircle(x, y, 20)) continue;
      spawnGround(x, y);
      outdoor++;
    }
  }

  spawnLoot(item: ItemId, x: number, y: number, amount?: number): Loot {
    const pos = this.freeSpot(x, y, 14);
    const def = ITEMS[item];
    let amt = amount;
    if (amt === undefined) {
      if (def.kind === 'weapon') amt = WEAPONS[item as WeaponId].magSize;
      else if (def.kind === 'ammo') amt = AMMO_PICKUP_AMOUNT[item.slice(5) as AmmoType];
      else if (def.kind === 'armor') amt = ARMOR[Number(item.slice(5)) as 1 | 2 | 3].durability;
      else amt = 1;
    }
    const loot: Loot = { id: this.nextId++, item, x: pos.x, y: pos.y, amount: amt, room: roomAt(this.map, pos.x, pos.y) };
    this.loot.set(loot.id, loot);
    return loot;
  }

  // ---------------------------------------------------------------- networking

  attachSocket(pid: number, socket: Socket) {
    const p = this.players[pid];
    p.socket = socket;
    p.connected = true;
    p.left = false;
    p.knownLoot.clear();
    p.inputQueue = [];
    p.events = [];
    socket.emit('match:start', this.startMsg(pid));
    if (!p.alive) socket.emit('match:dead', this.deathMsg(p));
  }

  detachSocket(pid: number) {
    const p = this.players[pid];
    p.socket = null;
    p.connected = false;
    p.mx = 0;
    p.my = 0;
    p.fire = false;
    p.inputQueue = [];
  }

  startMsg(pid: number): MatchStartMsg {
    return {
      matchId: this.id,
      mode: this.mode,
      seed: this.seed,
      you: pid,
      roster: this.players.map<RosterEntry>((p) => ({
        pid: p.pid, name: p.name, avatar: p.avatar, level: p.level, isBot: p.isBot,
      })),
      doorsOpen: [...this.world.doorOpen],
      chestsAlive: [...this.world.chestAlive],
      elapsedMs: this.now,
    };
  }

  handleInput(pid: number, raw: unknown) {
    const p = this.players[pid];
    if (!p.alive || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    const s = Number(m.s);
    if (!Number.isInteger(s) || s <= p.lastSeq) return;
    const last = p.inputQueue[p.inputQueue.length - 1];
    if (last && s <= last.s) return;
    const input: InputMsg = {
      s,
      mx: clamp(Number(m.mx) || 0, -1, 1),
      my: clamp(Number(m.my) || 0, -1, 1),
      a: Number.isFinite(Number(m.a)) ? Number(m.a) : p.a,
      f: m.f === true,
      td: clamp(Number(m.td) || 0, 0, THROWABLE.maxDistance),
    };
    p.inputQueue.push(input);
    if (p.inputQueue.length > 8) p.inputQueue.shift();
  }

  handleAction(pid: number, msg: ActionMsg) {
    const p = this.players[pid];
    if (!p.alive || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'reload': this.reload(p); break;
      case 'interact': this.interact(p); break;
      case 'equip': this.equip(p, msg.slot); break;
      case 'heal': this.heal(p); break;
      case 'scope': this.setScope(p, Number(msg.level)); break;
      case 'drop': this.drop(p, String(msg.what)); break;
    }
  }

  spectate(pid: number, target: 'killer' | 'next') {
    const p = this.players[pid];
    if (p.alive) return;
    const alive = this.players.filter((o) => o.alive);
    if (!alive.length) return;
    if (target === 'killer' && this.players[p.killer]?.alive) {
      p.spectating = p.killer;
      return;
    }
    const idx = alive.findIndex((o) => o.pid === p.spectating);
    p.spectating = alive[(idx + 1) % alive.length].pid;
  }

  leave(pid: number) {
    const p = this.players[pid];
    if (p.alive) this.kill(p, -1, 'leave');
    p.left = true;
    this.detachSocket(pid);
  }

  pidOfUser(userId: string): number {
    return this.players.find((p) => p.userId === userId)?.pid ?? -1;
  }

  // ---------------------------------------------------------------- main loop

  private loop() {
    const real = performance.now();
    let ticks = Math.floor((real - this.lastRealTime) / TICK_MS);
    if (ticks <= 0) return;
    if (ticks > 4) {
      ticks = 4;
      this.lastRealTime = real;
    } else {
      this.lastRealTime += ticks * TICK_MS;
    }
    for (let i = 0; i < ticks && !this.ended; i++) {
      try {
        this.tick();
      } catch (err) {
        console.error(`[match ${this.id}] lỗi mô phỏng:`, err);
      }
    }
  }

  private tick() {
    this.simTime += TICK_MS;
    this.tickCount++;
    const now = this.simTime;
    this.zone = zoneAt(this.zoneCircles, now);

    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.bot) {
        p.bot.update(this, p);
        this.applyMovement(p, p.mx, p.my);
      } else if (p.connected) {
        p.inputTokens = Math.min(p.inputTokens + 1, 3);
        let moved = false;
        while (p.inputQueue.length && p.inputTokens >= 1) {
          const input = p.inputQueue.shift()!;
          p.inputTokens--;
          p.a = input.a;
          p.fire = input.f;
          p.td = input.td;
          p.lastSeq = input.s;
          this.applyMovement(p, input.mx, input.my);
          moved = true;
        }
        if (!moved) p.moving = false;
      } else {
        p.moving = false;
        p.fire = false;
      }
      this.updateTimers(p);
      this.updateFiring(p);
      this.autoPickup(p);
    }

    this.updateBullets();
    this.updateThrowables();
    this.updateSmokes();
    this.updateZoneDamage();
    this.updateAirdrops();
    this.resolveDeaths();
    if (this.ended) return;
    this.checkEarlyFinish();
    if (this.ended) return;

    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots();
  }

  private applyMovement(p: Player, mx: number, my: number) {
    const speed = playerSpeed(this.activeWeapon(p), p.healUntil > 0);
    const pos = stepMovement(this.world, p.x, p.y, mx, my, speed, TICK_S);
    p.moving = Math.abs(pos.x - p.x) + Math.abs(pos.y - p.y) > 0.5;
    p.x = pos.x;
    p.y = pos.y;
    p.room = roomAt(this.map, p.x, p.y);
  }

  activeWeapon(p: Player): WeaponId {
    const slot = this.slotWeapon(p, p.active);
    return slot ? slot.w : p.active === 'melee' ? p.melee : 'fists';
  }

  slotWeapon(p: Player, slot: SlotName): WeaponSlot | null {
    if (slot === 'p1' || slot === 'p2' || slot === 'pistol') return p[slot];
    return null;
  }

  private updateTimers(p: Player) {
    const now = this.now;
    if (p.reloadUntil > 0 && now >= p.reloadUntil) {
      const slot = p.reloadSlot ? this.slotWeapon(p, p.reloadSlot) : null;
      if (slot && p.reloadSlot === p.active) {
        const def = WEAPONS[slot.w];
        const take = Math.min(def.magSize - slot.mag, p.ammo[def.ammo!]);
        slot.mag += take;
        p.ammo[def.ammo!] -= take;
      }
      p.reloadUntil = 0;
      p.reloadSlot = null;
    }
    if (p.healUntil > 0 && now >= p.healUntil) {
      p.healUntil = 0;
      if (p.med > 0) {
        p.med--;
        p.hp = Math.min(MAX_HP, p.hp + MEDKIT.heal);
      }
    }
  }

  // ---------------------------------------------------------------- actions

  equip(p: Player, slot: SlotName) {
    if (!['p1', 'p2', 'pistol', 'melee', 'grenade', 'smoke'].includes(slot)) return;
    if ((slot === 'p1' || slot === 'p2' || slot === 'pistol') && !p[slot]) return;
    if (slot === 'grenade' && p.gren <= 0) return;
    if (slot === 'smoke' && p.smoke <= 0) return;
    if (slot === p.active) return;
    p.active = slot;
    if (slot !== 'grenade' && slot !== 'smoke') p.lastWeaponSlot = slot;
    p.reloadUntil = 0;
    p.reloadSlot = null;
    p.healUntil = 0;
    p.nextFireAt = Math.max(p.nextFireAt, this.now + SWAP_DELAY_MS);
  }

  reload(p: Player) {
    const slot = this.slotWeapon(p, p.active);
    if (!slot || p.reloadUntil > 0) return;
    const def = WEAPONS[slot.w];
    if (!def.ammo || slot.mag >= def.magSize || p.ammo[def.ammo] <= 0) return;
    p.healUntil = 0;
    p.reloadUntil = this.now + def.reloadMs;
    p.reloadSlot = p.active;
    this.spatialEvent(p.x, p.y, { k: 'reload', pid: p.pid });
  }

  heal(p: Player) {
    if (p.med <= 0 || p.hp >= MAX_HP || p.healUntil > 0) return;
    p.reloadUntil = 0;
    p.reloadSlot = null;
    p.healUntil = this.now + MEDKIT.useMs;
  }

  setScope(p: Player, level: number) {
    if (p.scopes.has(level as ScopeLevel)) p.scope = level as ScopeLevel;
  }

  interact(p: Player) {
    type Target = { d: number; run: () => void };
    let best: Target | null = null;
    const consider = (d: number, run: () => void) => {
      if (!best || d < best.d) best = { d, run };
    };

    for (const l of this.loot.values()) {
      const d = Math.hypot(l.x - p.x, l.y - p.y);
      if (d <= PICKUP_RANGE) consider(d, () => this.pickup(p, l, true));
    }
    for (const door of this.map.doors) {
      const d = Math.hypot(door.x + door.w / 2 - p.x, door.y + door.h / 2 - p.y);
      if (d <= INTERACT_RANGE) consider(d + 10, () => this.toggleDoor(p, door.id));
    }
    for (const ad of this.airdrops) {
      if (this.now < ad.landAt) continue;
      const d = Math.hypot(ad.x - p.x, ad.y - p.y);
      if (d <= INTERACT_RANGE + AIRDROP_SIZE / 2) consider(d, () => this.openAirdrop(ad));
    }
    (best as Target | null)?.run();
  }

  private toggleDoor(p: Player, id: number) {
    const door = this.map.doors[id];
    const open = !this.world.doorOpen[id];
    if (!open && this.players.some((o) => o.alive && circleRectOverlap(o.x, o.y, PLAYER_RADIUS, door))) {
      this.personal(p, { k: 'notice', text: 'Có người đang đứng ở cửa.' });
      return;
    }
    this.world.doorOpen[id] = open;
    this.globalEvent({ k: 'door', id, open });
  }

  private capacity(p: Player) {
    return BAG_CAPACITY[p.bag];
  }

  /** Returns true when the loot item was (fully or partially) taken. */
  pickup(p: Player, loot: Loot, manual: boolean): boolean {
    const def = ITEMS[loot.item];
    const cap = this.capacity(p);
    const notice = (text: string) => manual && this.personal(p, { k: 'notice', text });
    const take = () => {
      this.loot.delete(loot.id);
      this.personal(p, { k: 'pickup', item: loot.item, amount: loot.amount });
    };

    switch (def.kind) {
      case 'ammo': {
        const type = loot.item.slice(5) as AmmoType;
        const room = cap.ammo[type] - p.ammo[type];
        if (room <= 0) return notice('Túi đã đầy loại đạn này.'), false;
        const n = Math.min(room, loot.amount);
        p.ammo[type] += n;
        loot.amount -= n;
        if (loot.amount <= 0) {
          take();
        } else {
          this.personal(p, { k: 'pickup', item: loot.item, amount: n });
          for (const o of this.players) o.knownLoot.delete(loot.id);
        }
        return true;
      }
      case 'medkit':
      case 'grenade':
      case 'smoke': {
        const key = def.kind === 'medkit' ? 'med' : def.kind === 'grenade' ? 'gren' : 'smoke';
        if (p[key] >= cap[def.kind]) return notice('Túi đã đầy, hãy nâng cấp túi đồ.'), false;
        p[key]++;
        take();
        return true;
      }
      case 'scope': {
        const level = scopeOfItem(loot.item) as ScopeLevel;
        if (p.scopes.has(level)) return notice('Bạn đã có ống nhắm này.'), false;
        p.scopes.add(level);
        if (level > p.scope) p.scope = level;
        take();
        return true;
      }
      case 'bag': {
        if (!manual) return false;
        const level = Number(loot.item.slice(3)) as BagLevel;
        if (level <= p.bag) return notice('Bạn đang có túi đồ tốt hơn hoặc bằng.'), false;
        if (p.bag > 0) this.spawnLoot(`bag${p.bag}` as ItemId, p.x, p.y);
        p.bag = level;
        take();
        return true;
      }
      case 'armor': {
        if (!manual) return false;
        const level = Number(loot.item.slice(5)) as ArmorLevel;
        if (p.armor > 0) this.spawnLoot(`armor${p.armor}` as ItemId, p.x, p.y, Math.ceil(p.armorDur));
        p.armor = level;
        p.armorDur = loot.amount;
        take();
        return true;
      }
      case 'weapon': {
        if (!manual) return false;
        const w = loot.item as WeaponId;
        const wdef = WEAPONS[w];
        if (wdef.slot === 'melee') {
          if (p.melee === w) return notice('Bạn đã có dao.'), false;
          p.melee = w;
          take();
          return true;
        }
        const newSlot: WeaponSlot = { w, mag: loot.amount };
        let target: 'p1' | 'p2' | 'pistol';
        if (wdef.slot === 'pistol') target = 'pistol';
        else if (!p.p1) target = 'p1';
        else if (!p.p2) target = 'p2';
        else target = p.active === 'p2' ? 'p2' : 'p1';
        const old = p[target];
        take();
        if (old) this.spawnLoot(old.w as ItemId, p.x, p.y, old.mag);
        p[target] = newSlot;
        if (p.active === 'melee' || p.active === target || !old) {
          p.active = '' as SlotName;
          this.equip(p, target);
        }
        return true;
      }
    }
    return false;
  }

  private autoPickup(p: Player) {
    if (this.tickCount % 3 !== 0) return;
    for (const l of this.loot.values()) {
      if (Math.abs(l.x - p.x) > PLAYER_RADIUS + 18 || Math.abs(l.y - p.y) > PLAYER_RADIUS + 18) continue;
      const kind = ITEMS[l.item].kind;
      if (kind === 'ammo' || kind === 'medkit' || kind === 'grenade' || kind === 'smoke' || kind === 'scope') {
        this.pickup(p, l, false);
      }
    }
  }

  private drop(p: Player, what: string) {
    const out = (item: ItemId, amount?: number) => {
      const ang = p.a + Math.PI;
      this.spawnLoot(item, p.x + Math.cos(ang) * 40, p.y + Math.sin(ang) * 40, amount);
    };
    if (what === 'p1' || what === 'p2' || what === 'pistol') {
      const slot = p[what];
      if (!slot) return;
      out(slot.w as ItemId, slot.mag);
      p[what] = null;
      if (p.active === what) {
        p.active = 'melee';
        p.lastWeaponSlot = 'melee';
        p.reloadUntil = 0;
      }
    } else if (what === 'melee') {
      if (p.melee === 'fists') return;
      out(p.melee as ItemId);
      p.melee = 'fists';
    } else if (what === 'armor') {
      if (!p.armor) return;
      out(`armor${p.armor}` as ItemId, Math.ceil(p.armorDur));
      p.armor = 0;
      p.armorDur = 0;
    } else if (what === 'bag') {
      if (!p.bag) return;
      out(`bag${p.bag}` as ItemId);
      p.bag = 0;
      this.trimToCapacity(p);
    } else if (what === 'medkit' && p.med > 0) {
      p.med--;
      out('medkit');
    } else if (what === 'grenade' && p.gren > 0) {
      p.gren--;
      out('grenade');
      if (p.gren === 0 && p.active === 'grenade') this.equip(p, p.lastWeaponSlot);
    } else if (what === 'smoke' && p.smoke > 0) {
      p.smoke--;
      out('smoke');
      if (p.smoke === 0 && p.active === 'smoke') this.equip(p, p.lastWeaponSlot);
    } else if (what.startsWith('ammo_')) {
      const type = what.slice(5) as AmmoType;
      if (!AMMO_TYPES.includes(type) || p.ammo[type] <= 0) return;
      const n = Math.min(p.ammo[type], AMMO_PICKUP_AMOUNT[type]);
      p.ammo[type] -= n;
      out(ammoItemFor(type), n);
    } else if (what.startsWith('scope')) {
      const level = Number(what.slice(5)) as ScopeLevel;
      if (level === 1 || !p.scopes.has(level)) return;
      p.scopes.delete(level);
      if (p.scope === level) p.scope = Math.max(...p.scopes) as ScopeLevel;
      out(`scope${level}` as ItemId);
    }
  }

  private trimToCapacity(p: Player) {
    const cap = this.capacity(p);
    for (const t of AMMO_TYPES) {
      const extra = p.ammo[t] - cap.ammo[t];
      if (extra > 0) {
        p.ammo[t] = cap.ammo[t];
        this.spawnLoot(ammoItemFor(t), p.x, p.y, extra);
      }
    }
    while (p.med > cap.medkit) { p.med--; this.spawnLoot('medkit', p.x, p.y); }
    while (p.gren > cap.grenade) { p.gren--; this.spawnLoot('grenade', p.x, p.y); }
    while (p.smoke > cap.smoke) { p.smoke--; this.spawnLoot('smoke', p.x, p.y); }
  }

  // ---------------------------------------------------------------- combat

  private updateFiring(p: Player) {
    const now = this.now;
    const firePressed = p.fire && !p.prevFire;
    p.prevFire = p.fire;
    if (!p.fire) return;

    if (p.active === 'grenade' || p.active === 'smoke') {
      if (firePressed && now >= p.nextFireAt) this.throwItem(p, p.active === 'grenade' ? 0 : 1);
      return;
    }
    if (now < p.nextFireAt) return;

    if (p.active === 'melee') {
      p.healUntil = 0;
      this.meleeAttack(p);
      return;
    }

    const slot = this.slotWeapon(p, p.active);
    if (!slot || p.reloadUntil > 0) return;
    if (slot.mag <= 0) {
      if (firePressed) this.reload(p);
      return;
    }
    p.healUntil = 0;
    this.shoot(p, slot);
    if (slot.mag <= 0) this.reload(p);
  }

  private shoot(p: Player, slot: WeaponSlot) {
    const def = WEAPONS[slot.w];
    p.nextFireAt = this.now + 1000 / def.fireRate;
    slot.mag--;
    const spread = ((def.spread + (p.moving ? def.moveSpread : 0)) * Math.PI) / 180;
    for (let i = 0; i < def.pellets; i++) {
      const ang = p.a + (this.rng() * 2 - 1) * spread;
      const b: Bullet = {
        id: this.nextId++,
        owner: p.pid,
        x: p.x,
        y: p.y,
        dx: Math.cos(ang),
        dy: Math.sin(ang),
        speed: def.bulletSpeed * (def.pellets > 1 ? 0.9 + this.rng() * 0.2 : 1),
        traveled: 0,
        range: def.range * (def.pellets > 1 ? 0.85 + this.rng() * 0.15 : 1),
        damage: def.damage,
        weapon: def.id,
        falloffStart: def.falloffStart,
        falloffMin: def.falloffMin,
      };
      this.bullets.push(b);
      this.spatialEvent(p.x, p.y, { k: 'shot', id: b.id, pid: p.pid, x: p.x, y: p.y, a: ang, spd: b.speed, rng: b.range, w: def.id });
    }
  }

  private meleeAttack(p: Player) {
    const def = WEAPONS[p.melee];
    p.nextFireAt = this.now + 1000 / def.fireRate;
    this.spatialEvent(p.x, p.y, { k: 'melee', pid: p.pid, w: p.melee });
    const reach = PLAYER_RADIUS + def.range;
    const arc = (50 * Math.PI) / 180;
    let bestD = Infinity;
    let hit: (() => void) | null = null;

    for (const o of this.players) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d - PLAYER_RADIUS > reach || d >= bestD) continue;
      if (Math.abs(angleDiff(p.a, Math.atan2(o.y - p.y, o.x - p.x))) > arc) continue;
      const block = this.world.raycast(p.x, p.y, o.x, o.y, true);
      if (block && block.t * d < d - PLAYER_RADIUS) continue;
      bestD = d;
      hit = () => this.applyDamage(o, def.damage, p, p.melee);
    }
    for (const c of this.map.chests) {
      if (!this.world.chestAlive[c.id]) continue;
      const r = chestRect(c);
      const px = clamp(p.x, r.x, r.x + r.w);
      const py = clamp(p.y, r.y, r.y + r.h);
      const d = Math.hypot(px - p.x, py - p.y);
      if (d > reach || d >= bestD) continue;
      if (Math.abs(angleDiff(p.a, Math.atan2(c.y - p.y, c.x - p.x))) > arc * 1.3) continue;
      bestD = d;
      hit = () => this.damageChest(c.id, def.damage);
    }
    hit?.();
  }

  private throwItem(p: Player, kind: 0 | 1) {
    if (kind === 0 && p.gren <= 0) return;
    if (kind === 1 && p.smoke <= 0) return;
    if (kind === 0) p.gren--;
    else p.smoke--;
    p.healUntil = 0;
    p.nextFireAt = this.now + 600;
    const dist = clamp(p.td, 40, THROWABLE.maxDistance);
    const speed = dist / (THROWABLE.flightMs / 1000);
    const fuse = kind === 0 ? THROWABLE.grenade.fuseMs : THROWABLE.smoke.fuseMs;
    this.throwables.push({
      id: this.nextId++,
      kind,
      owner: p.pid,
      x: p.x + Math.cos(p.a) * (PLAYER_RADIUS + 6),
      y: p.y + Math.sin(p.a) * (PLAYER_RADIUS + 6),
      vx: Math.cos(p.a) * speed,
      vy: Math.sin(p.a) * speed,
      flightLeft: THROWABLE.flightMs,
      triggerAt: this.now + fuse,
    });
    this.spatialEvent(p.x, p.y, { k: 'throw', pid: p.pid });
    if ((kind === 0 && p.gren === 0) || (kind === 1 && p.smoke === 0)) {
      const back = p.lastWeaponSlot;
      p.active = '' as SlotName;
      this.equip(p, back === 'p1' || back === 'p2' || back === 'pistol' ? (p[back] ? back : 'melee') : 'melee');
    }
  }

  applyDamage(target: Player, amount: number, attacker: Player | null, weapon: string, ignoreArmor = false) {
    if (!target.alive || amount <= 0) return;
    let dmg = amount;
    if (!ignoreArmor && target.armor > 0) {
      const absorbed = dmg * ARMOR[target.armor as 1 | 2 | 3].reduction;
      dmg -= absorbed;
      target.armorDur -= absorbed;
      if (target.armorDur <= 0) {
        target.armor = 0;
        target.armorDur = 0;
      }
    }
    dmg = Math.min(dmg, target.hp);
    target.hp -= dmg;
    if (attacker && attacker !== target) {
      attacker.damage += dmg;
      this.personal(attacker, { k: 'dmg', x: target.x, y: target.y, n: Math.round(dmg) });
    }
    if (!ignoreArmor) this.personal(target, { k: 'hurt', n: Math.round(dmg) });
    target.bot?.onHurt(attacker);
    if (target.hp <= 0.001) this.kill(target, attacker ? attacker.pid : -1, weapon);
  }

  private kill(target: Player, killer: number, weapon: string) {
    if (!target.alive) return;
    target.alive = false;
    target.hp = 0;
    target.deathTime = Math.floor(this.now);
    target.killer = killer;
    target.killWeapon = weapon;
    target.healUntil = 0;
    target.reloadUntil = 0;
    target.fire = false;
    const k = killer >= 0 ? this.players[killer] : null;
    if (k && k !== target) k.kills++;
    target.spectating = k && k !== target && k.alive ? k.pid : target.pid;
    this.dropAll(target);
    this.globalEvent({ k: 'kill', killer, victim: target.pid, w: weapon });
    this.pendingDeaths.push(target);
  }

  private dropAll(p: Player) {
    const items: [ItemId, number | undefined][] = [];
    for (const s of ['p1', 'p2', 'pistol'] as const) {
      const slot = p[s];
      if (slot) items.push([slot.w as ItemId, slot.mag]);
      p[s] = null;
    }
    if (p.melee !== 'fists') items.push([p.melee as ItemId, undefined]);
    for (const t of AMMO_TYPES) if (p.ammo[t] > 0) items.push([ammoItemFor(t), p.ammo[t]]);
    for (let i = 0; i < p.med; i++) items.push(['medkit', 1]);
    for (let i = 0; i < p.gren; i++) items.push(['grenade', 1]);
    for (let i = 0; i < p.smoke; i++) items.push(['smoke', 1]);
    if (p.armor) items.push([`armor${p.armor}` as ItemId, Math.ceil(p.armorDur)]);
    if (p.bag) items.push([`bag${p.bag}` as ItemId, 1]);
    for (const s of p.scopes) if (s > 1) items.push([`scope${s}` as ItemId, 1]);
    items.forEach(([item, amount], i) => {
      const ang = (i / Math.max(1, items.length)) * Math.PI * 2;
      const r = 30 + (i % 3) * 18;
      this.spawnLoot(item, p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r, amount);
    });
  }

  private damageChest(id: number, amount: number) {
    if (!this.world.chestAlive[id]) return;
    this.chestHp[id] -= amount;
    if (this.chestHp[id] > 0) return;
    this.world.chestAlive[id] = false;
    const c = this.map.chests[id];
    this.globalEvent({ k: 'chest', id });
    const n = 2 + Math.floor(this.rng() * 2);
    for (let i = 0; i < n; i++) {
      const item = pickWeighted(this.rng, CHEST_LOOT_TABLE);
      const ang = (i / n) * Math.PI * 2;
      this.spawnLoot(item, c.x + Math.cos(ang) * 30, c.y + Math.sin(ang) * 30);
      const w = WEAPONS[item as WeaponId];
      if (w?.ammo) this.spawnLoot(ammoItemFor(w.ammo), c.x + Math.cos(ang) * 50, c.y + Math.sin(ang) * 50);
    }
  }

  private updateBullets() {
    const keep: Bullet[] = [];
    for (const b of this.bullets) {
      const step = Math.min(b.speed * TICK_S, b.range - b.traveled);
      const x2 = b.x + b.dx * step;
      const y2 = b.y + b.dy * step;
      let bestT = Infinity;
      let hitPlayer: Player | null = null;
      const obstacle = this.world.raycast(b.x, b.y, x2, y2);
      if (obstacle) bestT = obstacle.t;
      for (const o of this.players) {
        if (!o.alive || o.pid === b.owner) continue;
        const t = segmentCircle(b.x, b.y, x2, y2, o.x, o.y, PLAYER_RADIUS);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitPlayer = o;
        }
      }
      if (bestT === Infinity) {
        b.x = x2;
        b.y = y2;
        b.traveled += step;
        if (b.traveled >= b.range - 0.01) this.spatialEvent(b.x, b.y, { k: 'bulletEnd', id: b.id, x: b.x, y: b.y, blood: false });
        else keep.push(b);
        continue;
      }
      const hx = b.x + (x2 - b.x) * bestT;
      const hy = b.y + (y2 - b.y) * bestT;
      const traveled = b.traveled + step * bestT;
      const frac = traveled / b.range;
      const falloff = frac <= b.falloffStart ? 1 : 1 - ((frac - b.falloffStart) / (1 - b.falloffStart)) * (1 - b.falloffMin);
      const damage = b.damage * falloff;
      if (hitPlayer) {
        this.applyDamage(hitPlayer, damage, this.players[b.owner], b.weapon);
      } else if (obstacle?.collider.kind === 'chest') {
        this.damageChest(obstacle.collider.id, damage);
      }
      this.spatialEvent(hx, hy, { k: 'bulletEnd', id: b.id, x: hx, y: hy, blood: !!hitPlayer });
    }
    this.bullets = keep;
  }

  private updateThrowables() {
    const now = this.now;
    const keep: Throwable[] = [];
    for (const t of this.throwables) {
      if (t.flightLeft > 0) {
        const dt = Math.min(TICK_MS, t.flightLeft);
        t.flightLeft -= dt;
        const nx = t.x + t.vx * (dt / 1000);
        const ny = t.y + t.vy * (dt / 1000);
        const hit = this.world.raycast(t.x, t.y, nx, ny);
        if (hit) {
          t.x += (nx - t.x) * Math.max(0, hit.t - 0.05);
          t.y += (ny - t.y) * Math.max(0, hit.t - 0.05);
          t.flightLeft = 0;
        } else {
          t.x = nx;
          t.y = ny;
        }
      }
      if (now < t.triggerAt) {
        keep.push(t);
        continue;
      }
      if (t.kind === 0) this.explode(t);
      else this.smokes.push({ id: t.id, x: t.x, y: t.y, startAt: now, endAt: now + THROWABLE.smoke.durationMs });
    }
    this.throwables = keep;
  }

  private explode(t: Throwable) {
    const g = THROWABLE.grenade;
    this.spatialEvent(t.x, t.y, { k: 'boom', x: t.x, y: t.y });
    const owner = this.players[t.owner];
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d > g.radius + PLAYER_RADIUS) continue;
      const block = this.world.raycast(t.x, t.y, p.x, p.y, true);
      if (block && block.t * d < d - PLAYER_RADIUS) continue;
      const k = clamp(1 - d / (g.radius + PLAYER_RADIUS), 0, 1);
      this.applyDamage(p, g.minDamage + (g.maxDamage - g.minDamage) * k, owner, 'grenade');
    }
    for (const c of this.map.chests) {
      if (this.world.chestAlive[c.id] && Math.hypot(c.x - t.x, c.y - t.y) < g.radius) this.damageChest(c.id, g.maxDamage);
    }
  }

  smokeRadius(s: Smoke): number {
    const k = clamp((this.now - s.startAt) / THROWABLE.smoke.expandMs, 0, 1);
    return THROWABLE.smoke.radius * k;
  }

  private updateSmokes() {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      if (this.now >= this.smokes[i].endAt) this.smokes.splice(i, 1);
    }
  }

  private updateZoneDamage() {
    const z = this.zone;
    for (const p of this.players) {
      if (p.alive && isOutsideZone(z, p.x, p.y)) this.applyDamage(p, z.damagePerSecond * TICK_S, null, 'zone', true);
    }
  }

  private updateAirdrops() {
    const now = this.now;
    if (this.nextAirdropAt < ZONE_TOTAL_MS - 60_000) {
      if (!this.airdropAnnounced && now >= this.nextAirdropAt - AIRDROP_ANNOUNCE_MS) {
        this.airdropAnnounced = true;
        const z = this.zone;
        const r = Math.max(60, z.tr * 0.75);
        let pos = { x: z.tx, y: z.ty };
        for (let i = 0; i < 40; i++) {
          const ang = this.rng() * Math.PI * 2;
          const d = Math.sqrt(this.rng()) * r;
          const x = clamp(z.tx + Math.cos(ang) * d, 150, MAP_SIZE - 150);
          const y = clamp(z.ty + Math.sin(ang) * d, 150, MAP_SIZE - 150);
          if (!this.world.overlapsCircle(x, y, AIRDROP_SIZE) && !this.insideHouse(x, y, 40)) {
            pos = { x, y };
            break;
          }
        }
        this.airdrops.push({ id: this.nextId++, x: pos.x, y: pos.y, landAt: this.nextAirdropAt });
        this.globalEvent({ k: 'airdrop', x: pos.x, y: pos.y });
        this.globalEvent({ k: 'notice', text: 'Thính sắp rơi! Xem vị trí trên bản đồ.' });
      }
      if (now >= this.nextAirdropAt) {
        this.nextAirdropAt += AIRDROP_INTERVAL_MS;
        this.airdropAnnounced = false;
      }
    }
  }

  private openAirdrop(ad: Airdrop) {
    this.airdrops = this.airdrops.filter((a) => a !== ad);
    const items: [ItemId, number?][] = [
      ['sniper'],
      ['ammo_762'],
      ['ammo_762'],
      ['armor3'],
      [this.rng() < 0.5 ? 'scope6' : 'scope8'],
      ['medkit'],
    ];
    items.forEach(([item, amount], i) => {
      const ang = (i / items.length) * Math.PI * 2;
      this.spawnLoot(item, ad.x + Math.cos(ang) * 40, ad.y + Math.sin(ang) * 40, amount);
    });
  }

  private resolveDeaths() {
    if (!this.pendingDeaths.length) return;
    const deaths = this.pendingDeaths;
    this.pendingDeaths = [];
    const alive = this.aliveCount;
    deaths
      .map((p) => ({ p, r: this.rng() }))
      .sort((a, b) => b.p.deathTime - a.p.deathTime || a.r - b.r)
      .forEach(({ p }, i) => {
        p.placement = alive + 1 + i;
      });
    for (const p of deaths) {
      p.socket?.emit('match:dead', this.deathMsg(p));
    }
    for (const p of this.players) {
      if (!p.alive && !this.players[p.spectating]?.alive) {
        const next = this.players[p.killer]?.alive ? p.killer : this.players.find((o) => o.alive)?.pid;
        if (next !== undefined) p.spectating = next;
      }
    }
    if (alive <= 1) this.finish();
  }

  private deathMsg(p: Player): DeathMsg {
    return {
      placement: p.placement,
      killer: p.killer,
      weapon: p.killWeapon,
      kills: p.kills,
      damage: Math.round(p.damage),
      survivalMs: p.deathTime,
    };
  }

  private checkEarlyFinish() {
    const humans = this.players.filter((p) => !p.isBot);
    if (humans.every((h) => !h.alive && (h.left || !h.connected))) this.finish();
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    const alive = this.players.filter((p) => p.alive);
    if (alive.length === 1) alive[0].placement = 1;
    let rank = 2;
    for (const p of alive.slice(1).sort((a, b) => b.hp - a.hp)) p.placement = rank++;
    const winner = this.players.find((p) => p.placement === 1);
    const winnerName = winner?.name ?? '—';
    const leaderboard: LeaderboardEntry[] = this.players
      .filter((p) => p.placement > 0)
      .sort((a, b) => a.placement - b.placement)
      .map((p) => ({ name: p.name, avatar: p.avatar, placement: p.placement, kills: p.kills, isBot: p.isBot }));

    const results: MatchResultPlayer[] = [];
    for (const p of this.players) {
      if (p.isBot || !p.userId) continue;
      const survivalMs = p.alive ? this.now : p.deathTime;
      const placement = p.placement || this.players.length;
      const xpGained = xpForMatch({ placement, kills: p.kills, survivalMs, playerCount: this.players.length });
      results.push({ userId: p.userId, placement, kills: p.kills, damage: p.damage, survivalMs, xpGained });
      const msg: MatchEndMsg = {
        mode: this.mode,
        placement,
        playerCount: this.players.length,
        kills: p.kills,
        damage: Math.round(p.damage),
        survivalMs,
        xpGained,
        winnerName,
        durationMs: this.now,
        leaderboard,
      };
      if (p.connected && !p.left) p.socket?.emit('match:end', msg);
    }
    this.callbacks.onEnd(this, results, winnerName);
  }

  dispose() {
    clearInterval(this.timer);
    this.ended = true;
  }

  // ---------------------------------------------------------------- visibility

  canSee(viewer: Player, target: { x: number; y: number; room: number }, radius = viewRadius(viewer.scope)): boolean {
    if (viewer === target) return true;
    const dx = target.x - viewer.x;
    const dy = target.y - viewer.y;
    if (dx * dx + dy * dy > radius * radius) return false;
    if (target.room !== -1 && target.room !== viewer.room) return false;
    return !this.blockedBySmoke(viewer.x, viewer.y, target.x, target.y);
  }

  blockedBySmoke(x1: number, y1: number, x2: number, y2: number): boolean {
    if (Math.hypot(x2 - x1, y2 - y1) < 70) return false;
    for (const s of this.smokes) {
      const r = this.smokeRadius(s) * 0.85;
      if (r <= 0) continue;
      const viewerInside = Math.hypot(x1 - s.x, y1 - s.y) < r;
      const targetInside = Math.hypot(x2 - s.x, y2 - s.y) < r;
      if (viewerInside && targetInside) continue;
      if (targetInside || viewerInside) return true;
      if (segmentCircle(x1, y1, x2, y2, s.x, s.y, r) >= 0) return true;
    }
    return false;
  }

  private viewPlayer(p: Player): Player {
    if (p.alive) return p;
    return this.players[p.spectating] ?? p;
  }

  // ---------------------------------------------------------------- events & snapshots

  private personal(p: Player, e: GameEvent) {
    if (!p.isBot && p.connected) p.events.push(e);
  }

  private globalEvent(e: GameEvent) {
    for (const p of this.players) this.personal(p, e);
  }

  private spatialEvent(x: number, y: number, e: GameEvent) {
    for (const p of this.players) {
      if (p.isBot || !p.connected) continue;
      const v = this.viewPlayer(p);
      const r = viewRadius(v.scope) + 200;
      if ((v.x - x) ** 2 + (v.y - y) ** 2 <= r * r) p.events.push(e);
    }
  }

  private selfNet(p: Player): SelfNet {
    const now = this.now;
    return {
      pid: p.pid,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      a: Math.round(p.a * 1000) / 1000,
      hp: Math.round(p.hp * 10) / 10,
      armor: p.armor,
      armorDur: Math.ceil(p.armorDur),
      bag: p.bag,
      scope: p.scope,
      scopes: SCOPE_LEVELS.filter((s) => p.scopes.has(s)),
      p1: p.p1 && { ...p.p1 },
      p2: p.p2 && { ...p.p2 },
      pistol: p.pistol && { ...p.pistol },
      melee: p.melee,
      active: p.active,
      ammo: { ...p.ammo },
      med: p.med,
      gren: p.gren,
      smoke: p.smoke,
      reloadLeft: p.reloadUntil > 0 ? Math.max(0, p.reloadUntil - now) : 0,
      healLeft: p.healUntil > 0 ? Math.max(0, p.healUntil - now) : 0,
      kills: p.kills,
      damage: Math.round(p.damage),
      room: p.room,
      alive: p.alive,
    };
  }

  private playerNet(p: Player): PlayerNet {
    let flags = 0;
    if (p.healUntil > 0) flags |= PFLAG_HEALING;
    if (!p.connected) flags |= PFLAG_DISCONNECTED;
    if (p.reloadUntil > 0) flags |= PFLAG_RELOADING;
    return [p.pid, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.a * 100) / 100, this.activeWeapon(p), p.armor, p.bag, flags];
  }

  private sendSnapshots() {
    const z = this.zone;
    const zoneNet: SnapshotMsg['z'] = [
      Math.round(z.x), Math.round(z.y), Math.round(z.r), Math.round(z.tx), Math.round(z.ty), Math.round(z.tr),
      z.phase, z.stage, Math.round(z.stageLeftMs), z.damagePerSecond,
    ];
    const smokes: SnapshotMsg['sm'] = this.smokes.map((s) => [s.id, Math.round(s.x), Math.round(s.y), Math.round(this.smokeRadius(s))]);
    const airdrops: AirdropNet[] = this.airdrops.map((a) => [
      a.id, Math.round(a.x), Math.round(a.y), this.now >= a.landAt ? 1 : 0, Math.max(0, Math.round(a.landAt - this.now)),
    ]);
    const alive = this.aliveCount;

    for (const c of this.players) {
      if (c.isBot || !c.connected || !c.socket || c.left) continue;
      const v = this.viewPlayer(c);
      const radius = viewRadius(v.scope);
      const visiblePlayers: PlayerNet[] = [];
      for (const o of this.players) {
        if (o.alive && this.canSee(v, o, radius)) visiblePlayers.push(this.playerNet(o));
      }

      const add: LootNet[] = [];
      const visibleLoot = new Set<number>();
      const lootRadius = radius + 100;
      for (const l of this.loot.values()) {
        if (!this.canSeeLoot(v, l, lootRadius)) continue;
        visibleLoot.add(l.id);
        if (!c.knownLoot.has(l.id)) add.push([l.id, l.item, Math.round(l.x), Math.round(l.y), l.amount]);
      }
      const del: number[] = [];
      for (const id of c.knownLoot) {
        if (!visibleLoot.has(id)) del.push(id);
      }
      c.knownLoot = visibleLoot;

      const throwables: SnapshotMsg['g'] = this.throwables
        .filter((t) => (t.x - v.x) ** 2 + (t.y - v.y) ** 2 < radius * radius)
        .map((t) => [t.id, t.kind, Math.round(t.x), Math.round(t.y)]);

      const snap: SnapshotMsg = {
        t: this.now,
        seq: c.lastSeq,
        me: this.selfNet(v),
        spectating: v !== c,
        p: visiblePlayers,
        g: throwables,
        sm: smokes,
        ad: airdrops,
        z: zoneNet,
        alive,
      };
      if (add.length) snap.la = add;
      if (del.length) snap.ld = del;
      if (c.events.length) {
        snap.e = c.events;
        c.events = [];
      }
      c.socket.emit('snap', snap);
    }
  }

  private canSeeLoot(v: Player, l: Loot, radius: number): boolean {
    const dx = l.x - v.x;
    const dy = l.y - v.y;
    if (dx * dx + dy * dy > radius * radius) return false;
    return l.room === -1 || l.room === v.room;
  }
}
