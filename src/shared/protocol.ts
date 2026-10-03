import type { AmmoType, ArmorLevel, BagLevel, ItemId, WeaponId } from './items';
import type { MapChoice, MapId } from './maps';
import type { ZoneStage } from './zone';

export type GameMode = 'pvp' | 'bots' | 'private' | 'training';

export const MODE_NAMES: Record<GameMode, string> = {
  pvp: 'Đấu người (ghép trận)',
  bots: 'Đấu với bot',
  private: 'Phòng bạn bè',
  training: 'Trường tập bắn',
};

export type UserRole = 'user' | 'admin';

export interface PublicUser {
  id: string;
  username: string;
  avatar: string;
  xp: number;
  level: number;
  role: UserRole;
  createdAt: string;
}

export interface UserStats {
  matches: number;
  wins: number;
  kills: number;
  /** Highest damage dealt in a single match. */
  bestDamage: number;
  avgPlacement: number | null;
  avgSurvivalMs: number | null;
  bestKills: number;
}

export interface MatchHistoryEntry {
  matchId: string;
  mode: GameMode;
  /** null for matches played before fixed maps. */
  mapId: MapId | null;
  placement: number;
  playerCount: number;
  /** 1 for solo; placement is then the team's rank. */
  teamSize: number;
  kills: number;
  damage: number;
  survivalMs: number;
  xpGained: number;
  endedAt: string;
}

export interface RosterEntry {
  pid: number;
  name: string;
  avatar: string;
  level: number;
  isBot: boolean;
  /** Team id, only in team matches. */
  team?: number;
  /** Set only for admin accounts; their name is drawn in a distinct style. */
  admin?: boolean;
}

export type SlotName = 'p1' | 'p2' | 'pistol' | 'melee' | 'grenade' | 'smoke';

export interface WeaponSlotNet {
  w: WeaponId;
  mag: number;
}

export interface SelfNet {
  pid: number;
  x: number;
  y: number;
  a: number;
  hp: number;
  armor: ArmorLevel;
  armorDur: number;
  bag: BagLevel;
  scope: number;
  scopes: number[];
  p1: WeaponSlotNet | null;
  p2: WeaponSlotNet | null;
  pistol: WeaponSlotNet | null;
  melee: WeaponId;
  active: SlotName;
  ammo: Record<AmmoType, number>;
  med: number;
  gren: number;
  smoke: number;
  /** Remaining ms of the current reload / heal, 0 when idle. */
  reloadLeft: number;
  healLeft: number;
  /** Remaining ms before the grenade in hand explodes, 0 when not holding one. */
  fuseLeft: number;
  kills: number;
  damage: number;
  room: number;
  alive: boolean;
}

/** [pid, x, y, angle, weapon, armor, bag, flags] */
export type PlayerNet = [number, number, number, number, WeaponId, ArmorLevel, BagLevel, number];
export const PFLAG_HEALING = 1;
export const PFLAG_DISCONNECTED = 2;
export const PFLAG_RELOADING = 4;

/** [lootId, item, x, y, amount] */
export type LootNet = [number, ItemId, number, number, number];
/** [id, kind (0 grenade, 1 smoke), x, y] */
export type ThrowableNet = [number, 0 | 1, number, number];
/** [id, x, y, radius] */
export type SmokeNet = [number, number, number, number];
/** [id, x, y, landed (0/1), msUntilLanding] */
export type AirdropNet = [number, number, number, 0 | 1, number];
/** [x, y, r, tx, ty, tr, phase, stage, stageLeftMs, dps] */
export type ZoneNet = [number, number, number, number, number, number, number, ZoneStage, number, number];
/** Teammate, wherever they are on the map: [pid, x, y, hp percent, alive (0/1), disconnected (0/1)] */
export type TeammateNet = [number, number, number, number, 0 | 1, 0 | 1];
/** A map marker: [owner pid, x, y] */
export type MarkerNet = [number, number, number];
/** Training-range target: [id, x, y, vy (px/s), hp percent] */
export type BoarNet = [number, number, number, number, number];
/** Pre-match waiting area: [ms until the fight, x, y, radius] */
export type LobbyNet = [number, number, number, number];

export interface TrainingStatsNet {
  /** Bullets fired (each shotgun pellet counts). */
  shots: number;
  hits: number;
  kills: number;
  /** Longest distance of a hit, and the distance of the latest one. */
  best: number;
  last: number;
}

export type GameEvent =
  | { k: 'shot'; id: number; pid: number; x: number; y: number; a: number; spd: number; rng: number; w: WeaponId }
  | { k: 'bulletEnd'; id: number; x: number; y: number; blood: boolean }
  | { k: 'melee'; pid: number; w: WeaponId }
  | { k: 'kill'; killer: number; victim: number; w: string }
  | { k: 'door'; id: number; open: boolean }
  | { k: 'chest'; id: number }
  | { k: 'boom'; x: number; y: number }
  | { k: 'throw'; pid: number }
  | { k: 'dmg'; x: number; y: number; n: number }
  | { k: 'hurt'; n: number }
  | { k: 'reload'; pid: number }
  | { k: 'pickup'; item: ItemId; amount: number }
  | { k: 'notice'; text: string }
  | { k: 'airdrop'; x: number; y: number }
  /** The waiting area closed: everyone was moved to their spawn and the fight is on. */
  | { k: 'go' }
  | { k: 'boarDown'; x: number; y: number; d: number };

export interface SnapshotMsg {
  t: number;
  seq: number;
  me: SelfNet;
  spectating: boolean;
  p: PlayerNet[];
  la?: LootNet[];
  ld?: number[];
  g: ThrowableNet[];
  sm: SmokeNet[];
  ad: AirdropNet[];
  z: ZoneNet;
  alive: number;
  e?: GameEvent[];
  /** Team matches only: the viewer's teammates, and how many teams are still in the fight. */
  tm?: TeammateNet[];
  teams?: number;
  /** Map markers the viewer may see: their own, plus their teammates' in team matches. */
  mk?: MarkerNet[];
  /** Training range only. */
  b?: BoarNet[];
  tr?: TrainingStatsNet;
  /** Only while the match is still in its waiting area. */
  lb?: LobbyNet;
}

export interface MatchStartMsg {
  matchId: string;
  mode: GameMode;
  mapId: MapId;
  you: number;
  teamSize: number;
  roster: RosterEntry[];
  doorsOpen: boolean[];
  chestsAlive: boolean[];
  elapsedMs: number;
  /** An admin watching without playing (`you` is then -1); the snapshots follow the player they picked. */
  observer?: boolean;
}

export interface DeathMsg {
  /** 0 while teammates are still alive: the team's rank is not known yet. */
  placement: number;
  teamAlive: boolean;
  killer: number;
  weapon: string;
  kills: number;
  damage: number;
  survivalMs: number;
}

export interface LeaderboardEntry {
  name: string;
  avatar: string;
  placement: number;
  kills: number;
  isBot: boolean;
  team?: number;
  admin?: boolean;
}

export interface MatchEndMsg {
  mode: GameMode;
  placement: number;
  playerCount: number;
  teamSize: number;
  /** Number of teams that started (equals playerCount in solo). */
  teamCount: number;
  kills: number;
  damage: number;
  survivalMs: number;
  xpGained: number;
  winnerName: string;
  durationMs: number;
  leaderboard: LeaderboardEntry[];
}

export interface InputMsg {
  /** Sequence number, used for client-side prediction reconciliation. */
  s: number;
  mx: number;
  my: number;
  /** Aim angle in radians. */
  a: number;
  /** Fire / throw button held. */
  f: boolean;
  /** Desired throw distance for grenades. */
  td: number;
}

export type ActionMsg =
  | { t: 'reload' }
  | { t: 'interact' }
  /** Pick up one specific item in reach, sent on a right click. */
  | { t: 'pickup'; id: number }
  /** The player's auto-pickup setting, sent on joining a match and whenever it changes. */
  | { t: 'autoPickup'; on: boolean }
  | { t: 'equip'; slot: SlotName }
  | { t: 'heal' }
  | { t: 'scope'; level: number }
  /** Puts the player's single map marker at a world position, replacing the old one. */
  | { t: 'mark'; x: number; y: number }
  | { t: 'unmark' }
  | { t: 'drop'; what: SlotName | 'armor' | 'bag' | 'medkit' | `ammo_${AmmoType}` | `scope${number}` };

export interface QueueStatusMsg {
  inQueue: boolean;
  /** Players waiting in the same team-size queue. */
  count: number;
  needed: number;
  waitedMs: number;
  notice: boolean;
  teamSize: number;
  /** Set when queued as a party: how many of us, and whether strangers may fill the team. */
  party?: { members: number; fill: boolean; leader: boolean };
}

export interface PartyMember {
  id: string;
  name: string;
  avatar: string;
  level: number;
  online: boolean;
  admin?: boolean;
}

export interface PartyStateMsg {
  id: string;
  leaderId: string;
  size: number;
  /** Fill the remaining slots with random players when matchmaking. */
  fill: boolean;
  members: PartyMember[];
  inQueue: boolean;
}

export interface PartyInviteMsg {
  partyId: string;
  size: number;
  from: { id: string; username: string; avatar: string; admin?: boolean };
}

export interface RoomMember {
  id: string;
  name: string;
  avatar: string;
  level: number;
  isBot: boolean;
  /** Seat in the room, null until the player picks one; in team rooms slot k belongs to team floor(k / teamSize). */
  slot: number | null;
  admin?: boolean;
}

export interface RoomStateMsg {
  id: string;
  name: string;
  /** Shown in the lobby room list; otherwise only reachable with the code or link. */
  listed: boolean;
  hostId: string;
  members: RoomMember[];
  max: number;
  min: number;
  map: MapChoice;
  teamSize: number;
}

/** Payload of `room:create`; older clients send just the team size. */
export interface RoomCreateOptions {
  teamSize: number;
  name: string;
  listed: boolean;
}

/** One row of the lobby room list (`rooms:list`, sent to clients that sent `rooms:watch`). */
export interface RoomSummary {
  id: string;
  name: string;
  host: { name: string; avatar: string; admin?: boolean };
  /** Humans and bots. */
  players: number;
  humans: number;
  max: number;
  map: MapChoice;
  teamSize: number;
}

/** One row of the admin-only live match list (`matches:list`, sent after `matches:watch`). */
export interface LiveMatchSummary {
  id: string;
  mode: GameMode;
  /** The room's name for friend rooms, empty otherwise. */
  name: string;
  mapId: MapId;
  teamSize: number;
  /** Humans and bots who started. */
  players: number;
  /** Humans still in the match (not left or kicked). */
  humans: number;
  alive: number;
  /** Time since the fight began; 0 while the waiting area is open. */
  elapsedMs: number;
  lobby: boolean;
  /** Admins watching it right now. */
  observers: number;
}
