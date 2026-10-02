export interface ZonePhase {
  /** Time the safe circle is shown before it starts shrinking. */
  waitMs: number;
  shrinkMs: number;
  /** Target radius as a fraction of the map size. */
  radiusFraction: number;
  /** Damage per second while outside the circle during this phase. */
  damagePerSecond: number;
}

/** Six phases, ~14 minutes total; the last circle closes completely at about 14:00. */
export const ZONE_PHASES: ZonePhase[] = [
  { waitMs: 150_000, shrinkMs: 75_000, radiusFraction: 0.32, damagePerSecond: 2 },
  { waitMs: 120_000, shrinkMs: 60_000, radiusFraction: 0.2, damagePerSecond: 4 },
  { waitMs: 90_000, shrinkMs: 50_000, radiusFraction: 0.12, damagePerSecond: 7 },
  { waitMs: 75_000, shrinkMs: 45_000, radiusFraction: 0.065, damagePerSecond: 10 },
  { waitMs: 60_000, shrinkMs: 40_000, radiusFraction: 0.025, damagePerSecond: 15 },
  { waitMs: 45_000, shrinkMs: 30_000, radiusFraction: 0, damagePerSecond: 25 },
];

export const ZONE_TOTAL_MS = ZONE_PHASES.reduce((s, p) => s + p.waitMs + p.shrinkMs, 0);

export type ZoneStage = 'wait' | 'shrink' | 'done';

export interface ZoneState {
  x: number;
  y: number;
  r: number;
  tx: number;
  ty: number;
  tr: number;
  phase: number;
  stage: ZoneStage;
  /** Remaining time in the current stage. */
  stageLeftMs: number;
  damagePerSecond: number;
}

export interface ZoneCircle {
  x: number;
  y: number;
  r: number;
}

/**
 * circles[0] is the initial circle covering the whole map, circles[i] is the
 * safe circle at the end of phase i.
 */
export function zoneAt(circles: ZoneCircle[], elapsedMs: number): ZoneState {
  let t = elapsedMs;
  for (let i = 0; i < ZONE_PHASES.length; i++) {
    const p = ZONE_PHASES[i];
    const from = circles[i];
    const to = circles[i + 1];
    if (t < p.waitMs) {
      return {
        x: from.x, y: from.y, r: from.r, tx: to.x, ty: to.y, tr: to.r,
        phase: i + 1, stage: 'wait', stageLeftMs: p.waitMs - t, damagePerSecond: p.damagePerSecond,
      };
    }
    t -= p.waitMs;
    if (t < p.shrinkMs) {
      const k = t / p.shrinkMs;
      return {
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        r: from.r + (to.r - from.r) * k,
        tx: to.x, ty: to.y, tr: to.r,
        phase: i + 1, stage: 'shrink', stageLeftMs: p.shrinkMs - t, damagePerSecond: p.damagePerSecond,
      };
    }
    t -= p.shrinkMs;
  }
  const last = circles[circles.length - 1];
  return {
    x: last.x, y: last.y, r: last.r, tx: last.x, ty: last.y, tr: last.r,
    phase: ZONE_PHASES.length, stage: 'done', stageLeftMs: 0,
    damagePerSecond: ZONE_PHASES[ZONE_PHASES.length - 1].damagePerSecond * 1.5,
  };
}

export function isOutsideZone(z: { x: number; y: number; r: number }, px: number, py: number): boolean {
  return Math.hypot(px - z.x, py - z.y) > z.r;
}
