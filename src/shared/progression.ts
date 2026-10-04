export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) ** 2 * 100;
}

/** Match history rows kept per player by the daily cleanup; lifetime stats still count every match. */
export const MATCH_HISTORY_KEEP = 20;

export const LEADERBOARD_KINDS = ['kills', 'level', 'survival', 'kd', 'winrate'] as const;
export type LeaderboardKind = (typeof LEADERBOARD_KINDS)[number];
export const LEADERBOARD_NAMES: Record<LeaderboardKind, string> = {
  kills: 'Hạ gục',
  level: 'Cấp độ',
  survival: 'Sống sót',
  kd: 'K/D',
  winrate: 'Tỉ lệ thắng',
};
/** Averages and ratios only rank players with this many matches, so one lucky game cannot top the board. */
export const LEADERBOARD_MIN_MATCHES = 5;
export const LEADERBOARD_SIZE = 50;

export function isLeaderboardKind(v: unknown): v is LeaderboardKind {
  return typeof v === 'string' && (LEADERBOARD_KINDS as readonly string[]).includes(v);
}

/** A row of the all-time ranking boards (not the end-of-match standings). */
export interface RankEntry {
  rank: number;
  id: string;
  username: string;
  avatar: string;
  admin: boolean;
  level: number;
  matches: number;
  /** kills: total kills, level: XP, survival: average ms alive, kd: kills per death, winrate: 0..1. */
  value: number;
}

export interface RankBoard {
  kind: LeaderboardKind;
  entries: RankEntry[];
  /** The caller's own row, null while they do not qualify for this board. */
  me: RankEntry | null;
  myMatches: number;
  minMatches: number;
}

/** Placement bonus never exceeds this, however crowded the match. */
const MAX_PLACEMENT_BONUS = 150;

export function xpForMatch(r: { placement: number; kills: number; survivalMs: number; playerCount: number }): number {
  // 10 XP per player outranked, scaled down in big matches so the bonus tops out at MAX_PLACEMENT_BONUS
  const perPlayer = Math.min(10, MAX_PLACEMENT_BONUS / Math.max(1, r.playerCount - 1));
  const placementBonus = Math.round(Math.max(0, r.playerCount - r.placement) * perPlayer);
  const winBonus = r.placement === 1 ? 100 : 0;
  return 20 + r.kills * 30 + placementBonus + Math.floor(r.survivalMs / 60000) * 5 + winBonus;
}
