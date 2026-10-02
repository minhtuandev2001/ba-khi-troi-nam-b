import type { AmmoType, ArmorLevel, BagLevel, ItemId, WeaponId } from './items';
import type { ZoneStage } from './zone';

export type GameMode = 'pvp' | 'bots' | 'private';

export const MODE_NAMES: Record<GameMode, string> = {
  pvp: 'Đấu người (ghép trận)',
  bots: 'Đấu với bot',
  private: 'Phòng bạn bè',
};

export interface PublicUser {
  id: string;
  username: string;
  avatar: string;
  xp: number;
  level: number;
  createdAt: string;
}

export interface UserStats {
  matches: number;
  wins: number;
  kills: number;
  damage: number;
  avgPlacement: number | null;
  totalSurvivalMs: number;
  avgSurvivalMs: number | null;
  bestKills: number;
}

export interface MatchHistoryEntry {
  matchId: string;
  mode: GameMode;
  placement: number;
  playerCount: number;
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
  | { k: 'airdrop'; x: number; y: number };

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
}

export interface MatchStartMsg {
  matchId: string;
  mode: GameMode;
  seed: number;
  you: number;
  roster: RosterEntry[];
  doorsOpen: boolean[];
  chestsAlive: boolean[];
  elapsedMs: number;
}

export interface DeathMsg {
  placement: number;
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
}

export interface MatchEndMsg {
  mode: GameMode;
  placement: number;
  playerCount: number;
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
  | { t: 'equip'; slot: SlotName }
  | { t: 'heal' }
  | { t: 'scope'; level: number }
  | { t: 'drop'; what: SlotName | 'armor' | 'bag' | 'medkit' | `ammo_${AmmoType}` | `scope${number}` };

export interface QueueStatusMsg {
  inQueue: boolean;
  count: number;
  needed: number;
  waitedMs: number;
  notice: boolean;
}

export interface RoomMember {
  id: string;
  name: string;
  avatar: string;
  level: number;
  isBot: boolean;
}

export interface RoomStateMsg {
  id: string;
  hostId: string;
  members: RoomMember[];
  max: number;
  min: number;
}
