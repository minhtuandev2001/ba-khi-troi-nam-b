export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) ** 2 * 100;
}

/** Match history rows kept per player by the daily cleanup; lifetime stats still count every match. */
export const MATCH_HISTORY_KEEP = 20;

/** Placement bonus never exceeds this, however crowded the match. */
const MAX_PLACEMENT_BONUS = 150;

export function xpForMatch(r: { placement: number; kills: number; survivalMs: number; playerCount: number }): number {
  // 10 XP per player outranked, scaled down in big matches so the bonus tops out at MAX_PLACEMENT_BONUS
  const perPlayer = Math.min(10, MAX_PLACEMENT_BONUS / Math.max(1, r.playerCount - 1));
  const placementBonus = Math.round(Math.max(0, r.playerCount - r.placement) * perPlayer);
  const winBonus = r.placement === 1 ? 100 : 0;
  return 20 + r.kills * 30 + placementBonus + Math.floor(r.survivalMs / 60000) * 5 + winBonus;
}
