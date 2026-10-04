/** On-screen buttons a phone or tablet player can move and resize. */
export const TOUCH_BUTTONS = ['fire', 'heal', 'reload', 'interact', 'smoke', 'grenade', 'pause', 'scope', 'map', 'inventory'] as const;
export type TouchButtonId = (typeof TOUCH_BUTTONS)[number];

/**
 * Each screen shape keeps its own arrangement: a phone held sideways, any other landscape screen (tablets),
 * and an upright screen. A spot that suits one shape lands under a thumb or off the edge on another.
 */
export const TOUCH_PROFILES = ['phone', 'land', 'port'] as const;
export type TouchProfile = (typeof TOUCH_PROFILES)[number];

export const TOUCH_SCALE_MIN = 0.6;
export const TOUCH_SCALE_MAX = 2;

/** A moved button: its centre as a share of the screen width and height (0..1), and its own scale. */
export interface TouchButtonPlace {
  x?: number;
  y?: number;
  s?: number;
}

export type TouchLayout = Partial<Record<TouchButtonId, TouchButtonPlace>>;
export type TouchLayouts = Partial<Record<TouchProfile, TouchLayout>>;

const round = (v: number) => Math.round(v * 10_000) / 10_000;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keeps only known buttons and in-range values, so stored or received data can always be applied as is. */
export function sanitizeTouchLayout(raw: unknown): TouchLayout {
  const out: TouchLayout = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of TOUCH_BUTTONS) {
    const p = (raw as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') continue;
    const place: TouchButtonPlace = {};
    if (isNum(p.x) && isNum(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      place.x = round(p.x);
      place.y = round(p.y);
    }
    if (isNum(p.s)) {
      const s = round(Math.min(TOUCH_SCALE_MAX, Math.max(TOUCH_SCALE_MIN, p.s)));
      if (s !== 1) place.s = s;
    }
    if (Object.keys(place).length) out[id] = place;
  }
  return out;
}

export function sanitizeTouchLayouts(raw: unknown): TouchLayouts {
  const out: TouchLayouts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const profile of TOUCH_PROFILES) {
    const layout = sanitizeTouchLayout((raw as Record<string, unknown>)[profile]);
    if (Object.keys(layout).length) out[profile] = layout;
  }
  return out;
}
