export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) ** 2 * 100;
}

export function xpForMatch(r: { placement: number; kills: number; survivalMs: number; playerCount: number }): number {
  const placementBonus = Math.max(0, r.playerCount - r.placement) * 10;
  const winBonus = r.placement === 1 ? 100 : 0;
  return 20 + r.kills * 30 + placementBonus + Math.floor(r.survivalMs / 60000) * 5 + winBonus;
}
