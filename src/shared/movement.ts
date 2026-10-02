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

export function stepMovement(
  world: CollisionWorld, x: number, y: number, mx: number, my: number, speed: number, dt: number,
): { x: number; y: number } {
  const [nx, ny] = normalizeMove(mx, my);
  if (nx === 0 && ny === 0) return { x, y };
  return world.moveCircle(x, y, nx * speed * dt, ny * speed * dt, PLAYER_RADIUS);
}
