export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_EVERY_TICKS = 2;
export const INTERPOLATION_DELAY_MS = 120;

/** Largest match (the big map); each map has its own `maxPlayers`. */
export const MAX_PLAYERS = 100;
export const MIN_PRIVATE_ROOM_PLAYERS = 2;
export const QUEUE_NOTICE_AFTER_MS = 3 * 60 * 1000;
export const MAX_ACTIVE_MATCHES = 50;
export const MAX_PRIVATE_ROOMS = 100;
export const ROOM_NAME_MAX_LENGTH = 24;
/** Rows sent in the lobby room list; open rooms with the most players come first. */
export const ROOM_LIST_MAX = 50;
/**
 * Ranked and private matches open with a waiting area on the map: no loot, no damage, so every
 * client has time to connect and build the map before the fight starts.
 */
export const PREMATCH_LOBBY_MS = 30_000;

export const PLAYER_RADIUS = 22;
export const PLAYER_SPEED = 230;
export const MAX_HP = 200;
export const HEAL_MOVE_MULTIPLIER = 0.5;
export const SPAWN_MIN_DISTANCE = 450;
/** Minimum spawn gap between a human and anyone else, so nobody is shot in the first seconds. */
export const HUMAN_SPAWN_DISTANCE = 950;
/** Bots ignore human players at the start of a match unless a human shoots them first. */
export const BOT_HUMAN_GRACE_MS = 15000;

/** Difficulty of a "đấu với bot" match; it only changes how fast the bots move. */
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';
export const BOT_DIFFICULTY_NAMES: Record<BotDifficulty, string> = { easy: 'Dễ', normal: 'Vừa', hard: 'Khó' };
export const BOT_SPEED_MULTIPLIER: Record<BotDifficulty, number> = { easy: 0.6, normal: 0.8, hard: 1 };
export function isBotDifficulty(v: unknown): v is BotDifficulty {
  return typeof v === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(v);
}

/** Ranked matchmaking: solo, duo or squad; teammates cannot hurt each other and win together. */
export const TEAM_SIZES = [1, 2, 4] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];
export type PartySize = Exclude<TeamSize, 1>;
export const TEAM_SIZE_NAMES: Record<TeamSize, string> = { 1: 'Đơn', 2: 'Nhóm 2', 4: 'Nhóm 4' };
export function isTeamSize(v: unknown): v is TeamSize {
  return typeof v === 'number' && (TEAM_SIZES as readonly number[]).includes(v);
}
export function isPartySize(v: unknown): v is PartySize {
  return isTeamSize(v) && v > 1;
}
export const MAX_PARTIES = 2000;

export const INTERACT_RANGE = 90;
export const PICKUP_RANGE = 75;

/** Visible world area at 1x; each scope multiplies both dimensions. */
export const BASE_VIEW_WIDTH = 1280;
export const BASE_VIEW_HEIGHT = 720;
export const BASE_VIEW_DIAGONAL = Math.hypot(BASE_VIEW_WIDTH, BASE_VIEW_HEIGHT);

export const SCOPE_LEVELS = [1, 2, 3, 4, 6, 8] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];
export const SCOPE_VIEW_MULTIPLIER: Record<ScopeLevel, number> = {
  1: 1,
  2: 1.15,
  3: 1.3,
  4: 1.45,
  6: 1.7,
  8: 2,
};

/** Radius around a viewer inside which the server sends entities. */
export function viewRadius(scope: ScopeLevel): number {
  return (BASE_VIEW_DIAGONAL / 2) * SCOPE_VIEW_MULTIPLIER[scope] + 120;
}

export const WALL_THICKNESS = 14;
export const DOOR_WIDTH = 72;
export const CHEST_SIZE = 46;
export const CHEST_HP = 60;
export const AIRDROP_SIZE = 64;

export const AIRDROP_INTERVAL_MS = 3 * 60 * 1000;
export const AIRDROP_ANNOUNCE_MS = 20 * 1000;

/** The twelve zodiac animals (12 con giáp) in order; Vietnam uses the cat for Mão and the buffalo for Sửu. */
export const AVATARS = ['🐭', '🐃', '🐯', '🐱', '🐲', '🐍', '🐴', '🐐', '🐵', '🐔', '🐶', '🐷'] as const;
export const AVATAR_NAMES: Record<(typeof AVATARS)[number], string> = {
  '🐭': 'Tý · Chuột',
  '🐃': 'Sửu · Trâu',
  '🐯': 'Dần · Hổ',
  '🐱': 'Mão · Mèo',
  '🐲': 'Thìn · Rồng',
  '🐍': 'Tỵ · Rắn',
  '🐴': 'Ngọ · Ngựa',
  '🐐': 'Mùi · Dê',
  '🐵': 'Thân · Khỉ',
  '🐔': 'Dậu · Gà',
  '🐶': 'Tuất · Chó',
  '🐷': 'Hợi · Lợn',
};

export const NAME_MAX_LENGTH = 16;
export const NAME_MIN_LENGTH = 3;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
