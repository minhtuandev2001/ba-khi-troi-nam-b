import { HEAL_MOVE_MULTIPLIER, PLAYER_RADIUS, PLAYER_SPEED } from './constants';
import { WEAPONS, type WeaponId } from './items';
import type { CollisionWorld } from './physics';

export function playerSpeed(weapon: WeaponId, healing: boolean): number {
  return PLAYER_SPEED * WEAPONS[weapon].moveMultiplier * (healing ? HEAL_MOVE_MULTIPLIER : 1);
}

/** Normalizes a move vector so diagonal / analog input never exceeds length 1. */
export function normalizeMove(mx: number, my: number): [number, number] {
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return [0, 0];
  const len = Math.hypot(mx, my);
  if (len > 1) return [mx / len, my / len];
  return [mx, my];
}

export interface MoveBounds {
  x: number;
  y: number;
  r: number;
}

/** `bounds` keeps the player inside a circle (the pre-match waiting area); client and server must pass the same one. */
export function stepMovement(
  world: CollisionWorld, x: number, y: number, mx: number, my: number, speed: number, dt: number, bounds: MoveBounds | null = null,
): { x: number; y: number } {
  const [nx, ny] = normalizeMove(mx, my);
  if (nx === 0 && ny === 0) return { x, y };
  const pos = world.moveCircle(x, y, nx * speed * dt, ny * speed * dt, PLAYER_RADIUS);
  if (!bounds) return pos;
  const max = bounds.r - PLAYER_RADIUS;
  const d = Math.hypot(pos.x - bounds.x, pos.y - bounds.y);
  if (d <= max) return pos;
  const edge = { x: bounds.x + ((pos.x - bounds.x) / d) * max, y: bounds.y + ((pos.y - bounds.y) / d) * max };
  return world.overlapsCircle(edge.x, edge.y, PLAYER_RADIUS) ? { x, y } : edge;
}
