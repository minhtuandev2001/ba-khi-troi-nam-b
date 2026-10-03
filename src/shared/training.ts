import type { ItemId, WeaponId } from './items';

/** Map used only by the training range; it is never offered in the map picker or random rotation. */
export const TRAINING_MAP = 'truongban' as const;
export const TRAINING_SIZE = 2400;

/** Players shoot east from this line; lane distances are measured from it. */
export const FIRING_LINE_X = 420;
export const TRAINING_SPAWN = { x: FIRING_LINE_X - 40, y: 1200 };
/** Inner bounds of the fenced range (tree lines on the north, south and west, earth berm on the east). */
export const RANGE_BOUNDS = { x0: 120, y0: 520, x1: 1880, y1: 1880 };
export const BERM_X = 1800;
/** Boars run north–south between these rows. */
export const LANE_Y0 = 680;
export const LANE_Y1 = 1720;

export const BOAR_RADIUS = 28;
export const BOAR_HP = 100;
export const BOAR_RESPAWN_MS = 2500;

export interface TrainingLane {
  /** Distance from the firing line. */
  distance: number;
  boars: number;
  /** Base running speed in px/s; each run varies around it. */
  speed: number;
}

export const TRAINING_LANES: readonly TrainingLane[] = [
  { distance: 150, boars: 1, speed: 70 },
  { distance: 300, boars: 2, speed: 100 },
  { distance: 500, boars: 2, speed: 120 },
  { distance: 700, boars: 2, speed: 140 },
  { distance: 950, boars: 2, speed: 150 },
  { distance: 1200, boars: 2, speed: 130 },
];

export function laneX(lane: TrainingLane): number {
  return FIRING_LINE_X + lane.distance;
}

/** Weapon rack behind the firing line, laid out north to south. */
export const RACK_X = 220;
export const RACK_ITEMS: readonly ItemId[] = ['rifle', 'shotgun', 'sniper', 'pistol', 'knife'];
export const RACK_Y0 = 1000;
export const RACK_STEP = 100;
export const RACK_RESPAWN_MS = 1500;

/** Starting kit; ammo, grenades and smoke are kept topped up for the whole session. */
export const TRAINING_KIT: { p1: WeaponId; p2: WeaponId; pistol: WeaponId; melee: WeaponId } = {
  p1: 'rifle',
  p2: 'sniper',
  pistol: 'pistol',
  melee: 'knife',
};
