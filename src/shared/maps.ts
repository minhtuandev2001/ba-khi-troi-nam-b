import type { Circle, Rect } from './geometry';
import { BERM_X, FIRING_LINE_X, LANE_Y0, LANE_Y1, RACK_X, RANGE_BOUNDS, TRAINING_LANES, TRAINING_MAP, TRAINING_SIZE, laneX } from './training';

export type MapId = 'vanlang' | 'coloa' | 'nghialinh' | 'lacviet' | 'phongchau' | typeof TRAINING_MAP;
/** The training range map is reachable only through the training mode, so it is left out of `MAP_IDS`. */
export type MapChoice = MapId | 'random';
export const MAP_IDS: readonly MapId[] = ['vanlang', 'coloa', 'nghialinh', 'lacviet', 'phongchau'];
export const DEFAULT_MAP: MapId = 'vanlang';

export function isMapId(v: unknown): v is MapId {
  return typeof v === 'string' && (MAP_IDS as readonly string[]).includes(v);
}

export function isMapChoice(v: unknown): v is MapChoice {
  return v === 'random' || isMapId(v);
}

/** Largest player count any map holds; a random pick holds this many too because it skips maps that are too small. */
export function mapCapacity(choice: MapChoice): number {
  return choice === 'random' ? Math.max(...MAP_IDS.map((id) => MAP_DEFS[id].maxPlayers)) : MAP_DEFS[choice].maxPlayers;
}

/** `random` draws among maps that fit `players`. */
export function resolveMapChoice(choice: MapChoice, players = 1, rng: () => number = Math.random): MapId {
  if (choice !== 'random') return choice;
  const fits = MAP_IDS.filter((id) => MAP_DEFS[id].maxPlayers >= players);
  return fits[Math.floor(rng() * fits.length)] ?? DEFAULT_MAP;
}

export type Side = 'n' | 's' | 'e' | 'w';

/** `lx`/`ly` move the big-map label off the centre for areas that enclose others. */
export interface MapArea { name: string; x: number; y: number; r: number; lx?: number; ly?: number }

export interface HouseSpec {
  x: number;
  y: number;
  cols: number;
  rows: number;
  cw?: number;
  ch?: number;
  /** Exterior doors; omitted = 1–2 picked by the map seed. */
  doors?: Side[];
  /** Omitted = 45% chance by the map seed. */
  chest?: boolean;
}

export interface Cluster { x: number; y: number; r: number; trees?: number; rocks?: number }
/** Straight row of trees; `gaps` are positions along the main axis left open as passages. */
export interface TreeLine { x1: number; y1: number; x2: number; y2: number; gaps?: number[] }

export interface MapTheme {
  /** Ground tone for minimap and big map. */
  ground: string;
  grassTint: number;
  decor: number[];
}

/** Rectangular rampart with `gates` openings per side [n, s, e, w], spaced evenly. */
export interface Ring { x0: number; y0: number; x1: number; y1: number; gates: [number, number, number, number] }

export interface MapDef {
  id: MapId;
  name: string;
  icon: string;
  blurb: string;
  seed: number;
  size: number;
  maxPlayers: number;
  theme: MapTheme;
  houses: HouseSpec[];
  /** Free-standing walls; a rect's shorter side is its thickness. */
  walls: Rect[];
  rings: Ring[];
  treeLines: TreeLine[];
  rocksAt: Circle[];
  clusters: Cluster[];
  /** No scattered trees, rocks or cover in these. */
  clear: (Rect | Circle)[];
  /** [x, y, r, decor index] */
  patches: [number, number, number, number][];
  /** `houses` are extra small houses placed by the map seed, so they never move either. */
  scatter: { trees: number; rocks: number; covers: number; chests: number; patches: number; houses: number };
  areas: MapArea[];
  /** Name shown when no area contains the point. */
  wild: string;
}

const RAMPART = 30;
const GATE = 190;
/** The four themed maps are laid out on this grid, then spread out to their real size by `scaleDef`. */
const DESIGN_SIZE = 4800;
export const DEFAULT_CELL_W = 250;
export const DEFAULT_CELL_H = 230;

function ring(x0: number, y0: number, x1: number, y1: number, gates: [number, number, number, number]): Ring {
  return { x0, y0, x1, y1, gates };
}

export function ringWalls({ x0, y0, x1, y1, gates }: Ring): Rect[] {
  const out: Rect[] = [];
  const t = RAMPART;
  const run = (from: number, to: number, count: number, make: (a: number, b: number) => Rect) => {
    const cuts: number[] = [];
    for (let i = 1; i <= count; i++) cuts.push(from + ((to - from) * i) / (count + 1));
    let a = from;
    for (const c of cuts) {
      if (c - GATE / 2 > a) out.push(make(a, c - GATE / 2));
      a = c + GATE / 2;
    }
    if (to > a) out.push(make(a, to));
  };
  run(x0, x1, gates[0], (a, b) => ({ x: a, y: y0, w: b - a, h: t }));
  run(x0, x1, gates[1], (a, b) => ({ x: a, y: y1 - t, w: b - a, h: t }));
  run(y0 + t, y1 - t, gates[2], (a, b) => ({ x: x1 - t, y: a, w: t, h: b - a }));
  run(y0 + t, y1 - t, gates[3], (a, b) => ({ x: x0, y: a, w: t, h: b - a }));
  return out;
}

/** Bamboo hedge around a rectangle; gate positions per side. */
function hedge(x0: number, y0: number, x1: number, y1: number, g: { n?: number[]; s?: number[]; e?: number[]; w?: number[] }): TreeLine[] {
  return [
    { x1: x0, y1: y0, x2: x1, y2: y0, gaps: g.n },
    { x1: x0, y1: y1, x2: x1, y2: y1, gaps: g.s },
    { x1: x1, y1: y0, x2: x1, y2: y1, gaps: g.e },
    { x1: x0, y1: y0, x2: x0, y2: y1, gaps: g.w },
  ];
}

function circleOf(cx: number, cy: number, radius: number, count: number, r: number): Circle[] {
  const out: Circle[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: Math.round(cx + Math.cos(a) * radius), y: Math.round(cy + Math.sin(a) * radius), r });
  }
  return out;
}

const COLOA: MapDef = {
  id: 'coloa',
  name: 'Thành Cổ Loa',
  icon: '🏯',
  blurb: 'Ba vòng thành xoáy ốc của An Dương Vương. Càng vào trong càng giàu đồ, nhưng cổng thành hẹp.',
  seed: 1101,
  size: DESIGN_SIZE,
  maxPlayers: 50,
  theme: { ground: '#9aab58', grassTint: 0xffffff, decor: [0xb8c470, 0x6f8a38, 0xd2c47a, 0xb88a52, 0x8f7a55] },
  houses: [
    { x: 2150, y: 1990, cols: 2, rows: 1, doors: ['s'], chest: true },
    { x: 2025, y: 2330, cols: 3, rows: 2, ch: 230, doors: ['n', 's'], chest: true },
    { x: 1300, y: 1330, cols: 3, rows: 1, doors: ['s'] },
    { x: 3200, y: 1950, cols: 1, rows: 2, doors: ['w'], chest: true },
    { x: 1350, y: 2250, cols: 1, rows: 2, doors: ['e'] },
    { x: 2900, y: 3150, cols: 1, rows: 1, doors: ['n'] },
    { x: 1450, y: 3150, cols: 2, rows: 1, doors: ['n'] },
    { x: 2150, y: 700, cols: 2, rows: 1, doors: ['n', 's'] },
    { x: 650, y: 1500, cols: 1, rows: 1 },
    { x: 750, y: 1950, cols: 1, rows: 1 },
    { x: 650, y: 2500, cols: 1, rows: 2 },
    { x: 720, y: 3300, cols: 1, rows: 1 },
    { x: 3850, y: 1350, cols: 1, rows: 1 },
    { x: 3850, y: 1750, cols: 1, rows: 1 },
    { x: 3850, y: 2200, cols: 1, rows: 2 },
    { x: 2150, y: 3850, cols: 2, rows: 1, doors: ['n'] },
    { x: 2900, y: 3850, cols: 1, rows: 1 },
    { x: 700, y: 3850, cols: 2, rows: 1 },
    { x: 3800, y: 700, cols: 1, rows: 1 },
    { x: 800, y: 750, cols: 1, rows: 1 },
  ],
  walls: [],
  rings: [
    ring(1800, 1850, 3000, 2950, [1, 1, 1, 1]),
    ring(1150, 1200, 3650, 3600, [2, 2, 2, 2]),
    ring(450, 450, 4350, 4350, [3, 3, 3, 3]),
  ],
  treeLines: [],
  rocksAt: circleOf(2400, 3270, 165, 6, 34),
  clusters: [
    { x: 225, y: 1200, r: 320, trees: 12 },
    { x: 225, y: 3400, r: 320, trees: 12 },
    { x: 4575, y: 1600, r: 320, trees: 12 },
    { x: 4575, y: 3500, r: 320, trees: 12 },
    { x: 1500, y: 225, r: 320, trees: 12 },
    { x: 3400, y: 225, r: 320, trees: 12 },
    { x: 1300, y: 4575, r: 320, trees: 12 },
    { x: 3600, y: 4575, r: 320, trees: 12 },
    { x: 1700, y: 2950, r: 250, rocks: 4 },
  ],
  clear: [{ x: 2400, y: 3270, r: 170 }, { x: 1830, y: 1880, w: 1140, h: 1040 }],
  patches: [
    [2400, 2400, 420, 4],
    [2400, 3270, 200, 2],
    [3975, 1800, 260, 3],
    [2525, 3965, 300, 0],
  ],
  scatter: { trees: 200, rocks: 60, covers: 18, chests: 8, patches: 50, houses: 14 },
  areas: [
    { name: 'Thành Nội', x: 2400, y: 2400, r: 600, ly: 1800 },
    { name: 'Đền Thượng', x: 2400, y: 2105, r: 190 },
    { name: 'Điện Ngự Triều', x: 2400, y: 2560, r: 290 },
    { name: 'Thành Trung', x: 2400, y: 2400, r: 1280, ly: 1150 },
    { name: 'Trại Lính', x: 1675, y: 1445, r: 380 },
    { name: 'Kho Nỏ Thần', x: 3325, y: 2180, r: 280 },
    { name: 'Kho Lương', x: 1475, y: 2480, r: 280 },
    { name: 'Giếng Ngọc', x: 2400, y: 3270, r: 200 },
    { name: 'Am Bà Chúa', x: 3025, y: 3265, r: 230 },
    { name: 'Xưởng Nỏ', x: 1700, y: 3265, r: 280 },
    { name: 'Thành Ngoại', x: 2400, y: 2400, r: 2000, ly: 400 },
    { name: 'Đồn Bắc', x: 2400, y: 815, r: 330 },
    { name: 'Làng Cổ Loa', x: 780, y: 2450, r: 620 },
    { name: 'Chợ Cổ Loa', x: 3975, y: 1850, r: 560 },
    { name: 'Bến Đầm Cả', x: 2650, y: 3965, r: 500 },
    { name: 'Đình Cổ Loa', x: 950, y: 3965, r: 350 },
    { name: 'Trạm Gác Đông Bắc', x: 3925, y: 815, r: 300 },
    { name: 'Đồn Tây Bắc', x: 925, y: 865, r: 300 },
  ],
  wild: 'Rừng Ngoài Thành',
};

const NGHIALINH: MapDef = {
  id: 'nghialinh',
  name: 'Núi Nghĩa Lĩnh',
  icon: '⛰️',
  blurb: 'Đường bậc đá dẫn lên các đền thờ Vua Hùng. Sườn núi lởm chởm đá, rừng cọ và đồi chè bao quanh.',
  seed: 2202,
  size: DESIGN_SIZE,
  maxPlayers: 50,
  theme: { ground: '#8fa552', grassTint: 0xe8f2dc, decor: [0x6f8a38, 0x5d7a30, 0xa0a860, 0x9c7a4a, 0xb8c470] },
  houses: [
    { x: 2150, y: 1450, cols: 2, rows: 1, doors: ['s'], chest: true },
    { x: 2850, y: 1300, cols: 1, rows: 1, doors: ['w'], chest: true },
    { x: 2150, y: 2350, cols: 2, rows: 1, doors: ['n', 's'] },
    { x: 2800, y: 2750, cols: 1, rows: 2, doors: ['w'] },
    { x: 2150, y: 3300, cols: 2, rows: 1, doors: ['n', 's'] },
    { x: 3350, y: 3600, cols: 1, rows: 1, doors: ['w'] },
    { x: 1700, y: 2850, cols: 1, rows: 1, doors: ['e'] },
    { x: 3700, y: 700, cols: 1, rows: 1 },
    { x: 4100, y: 900, cols: 1, rows: 1 },
    { x: 3650, y: 1250, cols: 2, rows: 1 },
    { x: 4150, y: 1650, cols: 1, rows: 1 },
    { x: 700, y: 1800, cols: 1, rows: 1 },
    { x: 1050, y: 2150, cols: 1, rows: 1 },
    { x: 650, y: 2600, cols: 1, rows: 2 },
    { x: 700, y: 3800, cols: 2, rows: 1 },
    { x: 1400, y: 4100, cols: 1, rows: 1 },
  ],
  walls: [
    { x: 2150, y: 1800, w: RAMPART, h: 430 },
    { x: 2620, y: 1800, w: RAMPART, h: 430 },
    { x: 2150, y: 2680, w: RAMPART, h: 520 },
    { x: 2620, y: 2680, w: RAMPART, h: 520 },
    { x: 1950, y: 4000, w: 300, h: RAMPART },
    { x: 2550, y: 4000, w: 300, h: RAMPART },
  ],
  rings: [],
  treeLines: [],
  rocksAt: [],
  clusters: [
    { x: 900, y: 800, r: 600, trees: 40 },
    { x: 3900, y: 2900, r: 550, trees: 35 },
    { x: 2400, y: 2200, r: 1000, trees: 25, rocks: 60 },
    { x: 850, y: 2300, r: 500, rocks: 8 },
  ],
  clear: [{ x: 2100, y: 1380, w: 600, h: 2800 }, { x: 2400, y: 4150, r: 220 }],
  patches: [
    [2400, 2200, 900, 3],
    [850, 2300, 420, 4],
    [3900, 2900, 420, 1],
    [900, 800, 450, 1],
  ],
  scatter: { trees: 250, rocks: 100, covers: 12, chests: 8, patches: 45, houses: 16 },
  areas: [
    { name: 'Đỉnh Nghĩa Lĩnh', x: 2400, y: 1500, r: 480, ly: 1250 },
    { name: 'Đền Thượng', x: 2400, y: 1565, r: 220 },
    { name: 'Lăng Hùng Vương', x: 2975, y: 1415, r: 220 },
    { name: 'Đền Trung', x: 2400, y: 2465, r: 250 },
    { name: 'Đường Bậc Đá', x: 2400, y: 2950, r: 330 },
    { name: 'Chùa Thiên Quang', x: 2925, y: 2980, r: 280 },
    { name: 'Nhà Bia', x: 1825, y: 2965, r: 230 },
    { name: 'Đền Hạ', x: 2400, y: 3415, r: 250 },
    { name: 'Đền Giếng', x: 3475, y: 3715, r: 260 },
    { name: 'Cổng Đền', x: 2400, y: 4060, r: 300 },
    { name: 'Sườn Núi', x: 2400, y: 2300, r: 1050, lx: 1750, ly: 1900 },
    { name: 'Làng Hy Cương', x: 3950, y: 1200, r: 600 },
    { name: 'Đồi Chè', x: 850, y: 2350, r: 620 },
    { name: 'Trại Săn', x: 1000, y: 3980, r: 480 },
    { name: 'Rừng Cọ', x: 3900, y: 2900, r: 600 },
    { name: 'Rừng Già', x: 900, y: 800, r: 650 },
  ],
  wild: 'Chân Núi',
};

const LACVIET: MapDef = {
  id: 'lacviet',
  name: 'Làng Lạc Việt',
  icon: '🛖',
  blurb: 'Làng cổ giữa đồng lúa, quây kín bằng lũy tre với bốn cổng. Đình làng ở trung tâm, bến sông ở phía nam.',
  seed: 3303,
  size: DESIGN_SIZE,
  maxPlayers: 50,
  theme: { ground: '#a3b05c', grassTint: 0xfff6e4, decor: [0xd8cc6a, 0xb8c470, 0x8ca448, 0xc49a5a, 0xd8c08a] },
  houses: [
    { x: 2025, y: 2000, cols: 3, rows: 2, doors: ['n', 's'], chest: true },
    { x: 1550, y: 1500, cols: 1, rows: 1 },
    { x: 1950, y: 1500, cols: 1, rows: 1 },
    { x: 2600, y: 1500, cols: 1, rows: 1 },
    { x: 3000, y: 1500, cols: 1, rows: 1 },
    { x: 1500, y: 2000, cols: 1, rows: 1 },
    { x: 1500, y: 2450, cols: 1, rows: 2 },
    { x: 3050, y: 1950, cols: 1, rows: 1 },
    { x: 3050, y: 2450, cols: 1, rows: 2 },
    { x: 1900, y: 2900, cols: 2, rows: 1, doors: ['n'], chest: true },
    { x: 2650, y: 2900, cols: 1, rows: 1, doors: ['n'] },
    { x: 1000, y: 600, cols: 1, rows: 1 },
    { x: 3600, y: 600, cols: 1, rows: 1 },
    { x: 1700, y: 3950, cols: 2, rows: 1 },
    { x: 2650, y: 4050, cols: 1, rows: 1 },
    { x: 3150, y: 3950, cols: 1, rows: 1 },
    { x: 4100, y: 2150, cols: 1, rows: 1 },
  ],
  walls: [],
  rings: [],
  treeLines: hedge(1300, 1300, 3500, 3300, { n: [2400], s: [2400], w: [2300], e: [2000, 2900] }),
  rocksAt: circleOf(3900, 3700, 280, 8, 38),
  clusters: [
    { x: 650, y: 2600, r: 560, trees: 45 },
    { x: 4150, y: 2300, r: 520, rocks: 25, trees: 8 },
    { x: 4400, y: 1100, r: 350, trees: 10 },
    { x: 400, y: 4300, r: 380, trees: 12 },
  ],
  clear: [
    { x: 250, y: 250, w: 4300, h: 850 },
    { x: 1330, y: 1330, w: 2140, h: 1940 },
    { x: 3900, y: 3700, r: 330 },
    { x: 0, y: 4350, w: 4800, h: 450 },
  ],
  patches: [
    [700, 500, 380, 0], [1500, 700, 360, 1], [2300, 550, 400, 0], [3100, 700, 380, 1], [4000, 520, 380, 0],
    [1100, 1050, 260, 1], [3700, 1050, 260, 0],
    [2400, 2680, 180, 4], [3900, 3700, 260, 3],
    [800, 4600, 380, 4], [1800, 4650, 420, 4], [2900, 4600, 420, 4], [4000, 4650, 380, 4],
    [4150, 2300, 400, 3],
  ],
  scatter: { trees: 230, rocks: 60, covers: 14, chests: 8, patches: 30, houses: 14 },
  areas: [
    { name: 'Đình Làng', x: 2400, y: 2230, r: 330 },
    { name: 'Sân Đình', x: 2400, y: 2680, r: 170 },
    { name: 'Xóm Bắc', x: 2400, y: 1620, r: 600 },
    { name: 'Xóm Tây', x: 1625, y: 2480, r: 430 },
    { name: 'Xóm Đông', x: 3175, y: 2430, r: 430 },
    { name: 'Nhà Già Làng', x: 2150, y: 3015, r: 280 },
    { name: 'Kho Thóc', x: 2775, y: 3015, r: 220 },
    { name: 'Trong Lũy Tre', x: 2400, y: 2300, r: 1150, ly: 1220 },
    { name: 'Cánh Đồng Lúa', x: 2400, y: 650, r: 1300 },
    { name: 'Bến Sông', x: 2400, y: 4400, r: 750 },
    { name: 'Nương Rẫy', x: 4150, y: 2300, r: 560 },
    { name: 'Rừng Già', x: 650, y: 2600, r: 620 },
    { name: 'Bãi Trống Đồng', x: 3900, y: 3700, r: 380 },
  ],
  wild: 'Đồng Quê',
};

const PHONGCHAU: MapDef = {
  id: 'phongchau',
  name: 'Kinh Đô Phong Châu',
  icon: '🥁',
  blurb: 'Kinh đô Văn Lang: điện Hùng Vương trong lũy gỗ, chợ đông đúc, xưởng đúc đồng và bến Bạch Hạc.',
  seed: 4404,
  size: DESIGN_SIZE,
  maxPlayers: 50,
  theme: { ground: '#9aab58', grassTint: 0xf4fff0, decor: [0xb8c470, 0x6f8a38, 0xd2c47a, 0xb88a52, 0xcdb68a] },
  houses: [
    { x: 2150, y: 1050, cols: 2, rows: 2, doors: ['s'], chest: true },
    { x: 1750, y: 1000, cols: 1, rows: 1, doors: ['s'], chest: true },
    { x: 2800, y: 1000, cols: 1, rows: 1, doors: ['s'] },
    { x: 1750, y: 1750, cols: 2, rows: 1, doors: ['n'] },
    { x: 2550, y: 1750, cols: 2, rows: 1, doors: ['n'] },
    { x: 1850, y: 2550, cols: 1, rows: 1 },
    { x: 2275, y: 2550, cols: 1, rows: 1, doors: ['s'] },
    { x: 2700, y: 2550, cols: 1, rows: 1 },
    { x: 1850, y: 3050, cols: 1, rows: 1 },
    { x: 2700, y: 3050, cols: 1, rows: 1 },
    { x: 600, y: 1700, cols: 2, rows: 2, chest: true },
    { x: 700, y: 2450, cols: 1, rows: 1 },
    { x: 3600, y: 3900, cols: 2, rows: 1 },
    { x: 3200, y: 4250, cols: 1, rows: 1 },
    { x: 3650, y: 650, cols: 1, rows: 1 },
    { x: 4100, y: 850, cols: 1, rows: 1 },
    { x: 3700, y: 1150, cols: 1, rows: 2 },
    { x: 1250, y: 3500, cols: 1, rows: 1 },
  ],
  walls: [],
  rings: [ring(1600, 800, 3200, 2200, [1, 1, 1, 1])],
  treeLines: [],
  rocksAt: [{ x: 3800, y: 2600, r: 50 }, { x: 4200, y: 3000, r: 46 }, { x: 3700, y: 3100, r: 40 }],
  clusters: [
    { x: 700, y: 700, r: 560, trees: 40 },
    { x: 800, y: 3900, r: 650, trees: 45 },
    { x: 850, y: 2050, r: 450, rocks: 6 },
  ],
  clear: [
    { x: 1630, y: 830, w: 1540, h: 1340 },
    { x: 2400, y: 2950, r: 190 },
    { x: 3450, y: 2300, w: 1100, h: 1000 },
    { x: 4500, y: 4500, r: 450 },
  ],
  patches: [
    [2400, 1500, 500, 3],
    [2400, 2850, 330, 2],
    [850, 2050, 360, 3],
    [4000, 2800, 520, 2],
    [4500, 4500, 460, 4], [4000, 4650, 320, 4], [4650, 4000, 320, 4],
  ],
  scatter: { trees: 210, rocks: 80, covers: 16, chests: 8, patches: 45, houses: 14 },
  areas: [
    { name: 'Kinh Thành', x: 2400, y: 1500, r: 900, ly: 740 },
    { name: 'Điện Hùng Vương', x: 2400, y: 1280, r: 300 },
    { name: 'Kho Báu', x: 1875, y: 1115, r: 200 },
    { name: 'Đền Tổ', x: 2925, y: 1115, r: 200 },
    { name: 'Nhà Lạc Hầu', x: 2000, y: 1865, r: 270 },
    { name: 'Nhà Lạc Tướng', x: 2800, y: 1865, r: 270 },
    { name: 'Chợ Phong Châu', x: 2400, y: 2850, r: 560 },
    { name: 'Xưởng Đúc Đồng', x: 850, y: 2100, r: 520 },
    { name: 'Bãi Tập Voi', x: 4000, y: 2800, r: 620 },
    { name: 'Ngã Ba Bạch Hạc', x: 4400, y: 4400, r: 560 },
    { name: 'Bến Thuyền', x: 3600, y: 4100, r: 420 },
    { name: 'Đồi Cọ', x: 700, y: 700, r: 620 },
    { name: 'Rừng Lim', x: 850, y: 3850, r: 720 },
    { name: 'Làng Văn Lang', x: 3900, y: 1050, r: 560 },
  ],
  wild: 'Ngoại Ô',
};

const VANLANG: MapDef = {
  id: 'vanlang',
  name: 'Nước Văn Lang',
  icon: '🐉',
  blurb: 'Bản đồ lớn cho 100 người: kinh thành Văn Lang ở giữa, thành Cổ Loa, núi Nghĩa Lĩnh, làng Lạc Việt và ngã ba Bạch Hạc ở bốn góc.',
  seed: 5505,
  size: 9600,
  maxPlayers: 100,
  theme: { ground: '#9aab58', grassTint: 0xf8fff0, decor: [0xb8c470, 0x6f8a38, 0xd2c47a, 0xb88a52, 0xd8c08a, 0xd8cc6a] },
  houses: [
    // Kinh Thành Văn Lang
    { x: 4550, y: 4350, cols: 2, rows: 2, doors: ['s'], chest: true },
    { x: 4150, y: 4300, cols: 1, rows: 1, doors: ['s'], chest: true },
    { x: 5200, y: 4300, cols: 1, rows: 1, doors: ['s'] },
    { x: 4150, y: 5050, cols: 2, rows: 1, doors: ['n'] },
    { x: 4950, y: 5050, cols: 2, rows: 1, doors: ['n'] },
    // Chợ Kinh Đô
    { x: 4250, y: 5850, cols: 1, rows: 1 },
    { x: 4675, y: 5850, cols: 1, rows: 1, doors: ['s'] },
    { x: 5100, y: 5850, cols: 1, rows: 1 },
    { x: 4250, y: 6350, cols: 1, rows: 1 },
    { x: 5100, y: 6350, cols: 1, rows: 1 },
    // Thành Cổ Loa
    { x: 1950, y: 1790, cols: 2, rows: 1, doors: ['s'], chest: true },
    { x: 1825, y: 2130, cols: 3, rows: 2, doors: ['n', 's'], chest: true },
    { x: 1100, y: 1130, cols: 3, rows: 1, doors: ['s'] },
    { x: 3000, y: 1750, cols: 1, rows: 2, doors: ['w'], chest: true },
    { x: 1150, y: 2050, cols: 1, rows: 2, doors: ['e'] },
    { x: 2700, y: 2950, cols: 1, rows: 1, doors: ['n'] },
    { x: 1250, y: 2950, cols: 2, rows: 1, doors: ['n'] },
    { x: 350, y: 1500, cols: 1, rows: 1 },
    { x: 350, y: 2300, cols: 1, rows: 2 },
    { x: 400, y: 3000, cols: 1, rows: 1 },
    { x: 1950, y: 450, cols: 2, rows: 1, doors: ['n', 's'] },
    // Núi Nghĩa Lĩnh
    { x: 6950, y: 1450, cols: 2, rows: 1, doors: ['s'], chest: true },
    { x: 7650, y: 1300, cols: 1, rows: 1, doors: ['w'], chest: true },
    { x: 6950, y: 2350, cols: 2, rows: 1, doors: ['n', 's'] },
    { x: 7600, y: 2750, cols: 1, rows: 2, doors: ['w'] },
    { x: 6950, y: 3300, cols: 2, rows: 1, doors: ['n', 's'] },
    { x: 8150, y: 3600, cols: 1, rows: 1, doors: ['w'] },
    { x: 6500, y: 2850, cols: 1, rows: 1, doors: ['e'] },
    { x: 8500, y: 700, cols: 1, rows: 1 },
    { x: 8950, y: 900, cols: 1, rows: 1 },
    { x: 8450, y: 1250, cols: 2, rows: 1 },
    { x: 8950, y: 1650, cols: 1, rows: 1 },
    // Làng Lạc Việt
    { x: 1725, y: 7000, cols: 3, rows: 2, doors: ['n', 's'], chest: true },
    { x: 1250, y: 6500, cols: 1, rows: 1 },
    { x: 1650, y: 6500, cols: 1, rows: 1 },
    { x: 2300, y: 6500, cols: 1, rows: 1 },
    { x: 2700, y: 6500, cols: 1, rows: 1 },
    { x: 1200, y: 7000, cols: 1, rows: 1 },
    { x: 1200, y: 7450, cols: 1, rows: 2 },
    { x: 2750, y: 6950, cols: 1, rows: 1 },
    { x: 2750, y: 7450, cols: 1, rows: 2 },
    { x: 1600, y: 7900, cols: 2, rows: 1, doors: ['n'], chest: true },
    { x: 2350, y: 7900, cols: 1, rows: 1, doors: ['n'] },
    { x: 1400, y: 8850, cols: 2, rows: 1 },
    { x: 2350, y: 8950, cols: 1, rows: 1 },
    { x: 2850, y: 8850, cols: 1, rows: 1 },
    { x: 900, y: 4300, cols: 1, rows: 1 },
    { x: 2600, y: 4900, cols: 1, rows: 1 },
    // Xưởng Đúc Đồng, Làng Văn Lang
    { x: 3750, y: 2600, cols: 2, rows: 2, chest: true },
    { x: 3800, y: 3350, cols: 1, rows: 1 },
    { x: 4300, y: 800, cols: 1, rows: 1 },
    { x: 4800, y: 1000, cols: 2, rows: 1 },
    { x: 5500, y: 800, cols: 1, rows: 1 },
    { x: 4450, y: 1450, cols: 1, rows: 2 },
    { x: 5350, y: 1400, cols: 1, rows: 1 },
    // Làng Chài, Bến Thuyền
    { x: 6000, y: 7000, cols: 1, rows: 1 },
    { x: 6450, y: 7050, cols: 2, rows: 1 },
    { x: 6100, y: 7500, cols: 1, rows: 2 },
    { x: 6750, y: 7600, cols: 1, rows: 1 },
    { x: 7600, y: 8200, cols: 2, rows: 1 },
    { x: 7200, y: 8700, cols: 1, rows: 1 },
    { x: 8100, y: 7700, cols: 1, rows: 1 },
  ],
  walls: [
    { x: 6950, y: 1800, w: RAMPART, h: 430 },
    { x: 7420, y: 1800, w: RAMPART, h: 430 },
    { x: 6950, y: 2680, w: RAMPART, h: 520 },
    { x: 7420, y: 2680, w: RAMPART, h: 520 },
    { x: 6750, y: 4000, w: 300, h: RAMPART },
    { x: 7350, y: 4000, w: 300, h: RAMPART },
  ],
  rings: [
    ring(4000, 4100, 5600, 5500, [1, 1, 1, 1]),
    ring(1600, 1650, 2800, 2750, [1, 1, 1, 1]),
    ring(950, 1000, 3450, 3400, [2, 2, 2, 2]),
  ],
  treeLines: hedge(1000, 6300, 3200, 8300, { n: [2100], s: [2100], w: [7300], e: [7000, 7900] }),
  rocksAt: [
    ...circleOf(2200, 3070, 165, 6, 34),
    ...circleOf(3600, 8700, 280, 8, 38),
    { x: 6500, y: 4800, r: 50 }, { x: 7000, y: 5300, r: 46 }, { x: 6400, y: 5400, r: 40 },
  ],
  clusters: [
    { x: 7200, y: 2200, r: 1000, trees: 25, rocks: 60 },
    { x: 8700, y: 2900, r: 550, trees: 35 },
    { x: 4900, y: 2400, r: 600, trees: 40 },
    { x: 450, y: 8000, r: 420, trees: 25 },
    { x: 8600, y: 6000, r: 700, trees: 50 },
    { x: 600, y: 5900, r: 500, trees: 30 },
    { x: 9300, y: 4300, r: 400, trees: 20 },
    { x: 4900, y: 9200, r: 450, trees: 25 },
  ],
  clear: [
    { x: 4030, y: 4130, w: 1540, h: 1340 },
    { x: 4800, y: 6350, r: 190 },
    { x: 1630, y: 1680, w: 1140, h: 1040 },
    { x: 2200, y: 3070, r: 170 },
    { x: 6900, y: 1380, w: 600, h: 2800 },
    { x: 7200, y: 4150, r: 220 },
    { x: 1030, y: 6330, w: 2140, h: 1940 },
    { x: 3600, y: 8700, r: 330 },
    { x: 250, y: 3800, w: 3300, h: 1700 },
    { x: 0, y: 9250, w: 4000, h: 350 },
    { x: 6100, y: 4500, w: 1300, h: 1100 },
    { x: 9000, y: 9000, r: 550 },
  ],
  patches: [
    [4800, 4800, 520, 3], [4800, 6150, 330, 2], [2200, 2200, 420, 3], [2200, 3070, 200, 2],
    [7200, 2200, 900, 3], [8700, 2900, 420, 1], [2100, 7680, 180, 4], [3600, 8700, 260, 3],
    [700, 4100, 380, 5], [1500, 4400, 380, 1], [2300, 4100, 400, 5], [3100, 4500, 380, 1], [1100, 5100, 360, 5], [2500, 5200, 360, 5],
    [800, 9450, 380, 4], [1800, 9450, 420, 4], [2900, 9450, 420, 4],
    [6750, 5050, 560, 2], [4000, 2830, 360, 3],
    [9000, 9000, 620, 4], [8300, 9300, 400, 4], [9300, 8300, 400, 4], [7700, 8350, 300, 4],
  ],
  scatter: { trees: 900, rocks: 360, covers: 70, chests: 30, patches: 180, houses: 30 },
  areas: [
    { name: 'Kinh Thành Văn Lang', x: 4800, y: 4800, r: 900, ly: 4040 },
    { name: 'Điện Hùng Vương', x: 4800, y: 4580, r: 300 },
    { name: 'Kho Báu', x: 4275, y: 4415, r: 200 },
    { name: 'Đền Tổ', x: 5325, y: 4415, r: 200 },
    { name: 'Nhà Lạc Hầu', x: 4400, y: 5165, r: 270 },
    { name: 'Nhà Lạc Tướng', x: 5200, y: 5165, r: 270 },
    { name: 'Chợ Kinh Đô', x: 4800, y: 6150, r: 560 },
    { name: 'Thành Nội', x: 2200, y: 2200, r: 600, ly: 1600 },
    { name: 'Đền An Dương Vương', x: 2200, y: 1905, r: 190 },
    { name: 'Điện Ngự Triều', x: 2200, y: 2360, r: 290 },
    { name: 'Thành Cổ Loa', x: 2200, y: 2200, r: 1280, ly: 950 },
    { name: 'Trại Lính', x: 1475, y: 1245, r: 380 },
    { name: 'Kho Nỏ Thần', x: 3125, y: 1980, r: 280 },
    { name: 'Kho Lương', x: 1275, y: 2280, r: 280 },
    { name: 'Giếng Ngọc', x: 2200, y: 3070, r: 200 },
    { name: 'Am Bà Chúa', x: 2825, y: 3065, r: 230 },
    { name: 'Xưởng Nỏ', x: 1500, y: 3065, r: 280 },
    { name: 'Làng Cổ Loa', x: 500, y: 2300, r: 560 },
    { name: 'Đồn Bắc', x: 2200, y: 565, r: 300 },
    { name: 'Đỉnh Nghĩa Lĩnh', x: 7200, y: 1500, r: 480, ly: 1250 },
    { name: 'Đền Thượng', x: 7200, y: 1565, r: 220 },
    { name: 'Lăng Hùng Vương', x: 7775, y: 1415, r: 220 },
    { name: 'Đền Trung', x: 7200, y: 2465, r: 250 },
    { name: 'Đường Bậc Đá', x: 7200, y: 2950, r: 330 },
    { name: 'Chùa Thiên Quang', x: 7725, y: 2980, r: 280 },
    { name: 'Nhà Bia', x: 6625, y: 2965, r: 230 },
    { name: 'Đền Hạ', x: 7200, y: 3415, r: 250 },
    { name: 'Đền Giếng', x: 8275, y: 3715, r: 260 },
    { name: 'Cổng Đền', x: 7200, y: 4060, r: 300 },
    { name: 'Núi Nghĩa Lĩnh', x: 7200, y: 2300, r: 1050, lx: 6550, ly: 1900 },
    { name: 'Làng Hy Cương', x: 8750, y: 1200, r: 620 },
    { name: 'Rừng Cọ', x: 8700, y: 2900, r: 600 },
    { name: 'Đình Làng', x: 2100, y: 7230, r: 330 },
    { name: 'Sân Đình', x: 2100, y: 7680, r: 170 },
    { name: 'Xóm Bắc', x: 2100, y: 6620, r: 600 },
    { name: 'Xóm Tây', x: 1325, y: 7480, r: 430 },
    { name: 'Xóm Đông', x: 2875, y: 7430, r: 430 },
    { name: 'Nhà Già Làng', x: 1850, y: 8015, r: 280 },
    { name: 'Kho Thóc', x: 2475, y: 8015, r: 220 },
    { name: 'Làng Lạc Việt', x: 2100, y: 7300, r: 1150, ly: 6220 },
    { name: 'Cánh Đồng Lúa', x: 1900, y: 4650, r: 1050 },
    { name: 'Bến Sông', x: 2100, y: 9250, r: 700 },
    { name: 'Bãi Trống Đồng', x: 3600, y: 8700, r: 380 },
    { name: 'Rừng Già', x: 500, y: 8000, r: 460 },
    { name: 'Xưởng Đúc Đồng', x: 4000, y: 2900, r: 480 },
    { name: 'Làng Văn Lang', x: 4900, y: 1150, r: 650 },
    { name: 'Đồi Cọ', x: 4900, y: 2400, r: 620 },
    { name: 'Bãi Tập Voi', x: 6750, y: 5050, r: 650 },
    { name: 'Làng Chài', x: 6400, y: 7400, r: 560 },
    { name: 'Bến Thuyền', x: 7700, y: 8350, r: 520 },
    { name: 'Ngã Ba Bạch Hạc', x: 8900, y: 8900, r: 700 },
    { name: 'Rừng Lim', x: 8600, y: 6000, r: 720 },
    { name: 'Rừng Tre', x: 600, y: 5900, r: 520 },
  ],
  wild: 'Đồng Quê Văn Lang',
};

/** Spreads a design-grid map out to `size`: positions grow, while houses, wall thickness, gates and trees keep their real size. */
function scaleDef(def: MapDef, size: number): MapDef {
  const k = size / def.size;
  const area = k * k;
  const S = (v: number) => Math.round(v * k);
  const n = (v: number) => Math.round(v * area);
  return {
    ...def,
    size,
    houses: def.houses.map((h) => {
      const w = h.cols * (h.cw ?? DEFAULT_CELL_W);
      const hh = h.rows * (h.ch ?? DEFAULT_CELL_H);
      return { ...h, x: S(h.x + w / 2) - w / 2, y: S(h.y + hh / 2) - hh / 2 };
    }),
    walls: def.walls.map((w) => {
      const long = w.w >= w.h;
      const nw = long ? S(w.w) : w.w;
      const nh = long ? w.h : S(w.h);
      return { x: S(w.x + w.w / 2) - nw / 2, y: S(w.y + w.h / 2) - nh / 2, w: nw, h: nh };
    }),
    rings: def.rings.map((r) => ({ ...r, x0: S(r.x0), y0: S(r.y0), x1: S(r.x1), y1: S(r.y1) })),
    treeLines: def.treeLines.map((l) => ({ x1: S(l.x1), y1: S(l.y1), x2: S(l.x2), y2: S(l.y2), gaps: l.gaps?.map(S) })),
    rocksAt: def.rocksAt.map((r) => ({ x: S(r.x), y: S(r.y), r: r.r })),
    clusters: def.clusters.map((c) => ({
      x: S(c.x), y: S(c.y), r: S(c.r),
      trees: c.trees && n(c.trees), rocks: c.rocks && n(c.rocks),
    })),
    clear: def.clear.map((c) => ('r' in c ? { x: S(c.x), y: S(c.y), r: S(c.r) } : { x: S(c.x), y: S(c.y), w: S(c.w), h: S(c.h) })),
    patches: def.patches.map(([x, y, r, c]) => [S(x), S(y), S(r), c]),
    scatter: {
      ...def.scatter,
      trees: n(def.scatter.trees), rocks: n(def.scatter.rocks), covers: n(def.scatter.covers),
      chests: n(def.scatter.chests), patches: n(def.scatter.patches),
    },
    areas: def.areas.map((a) => ({
      ...a, x: S(a.x), y: S(a.y), r: S(a.r),
      lx: a.lx === undefined ? undefined : S(a.lx), ly: a.ly === undefined ? undefined : S(a.ly),
    })),
  };
}

function rangeDef(): MapDef {
  const { x0, y0, x1, y1 } = RANGE_BOUNDS;
  const mid = (LANE_Y0 + LANE_Y1) / 2;
  const patches: [number, number, number, number][] = [[RACK_X, mid, 150, 0]];
  const rocksAt: Circle[] = [];
  for (let y = y0 + 40; y <= y1 - 40; y += 84) rocksAt.push({ x: BERM_X + (rocksAt.length % 2 ? 14 : 0), y, r: 48 });
  return {
    id: TRAINING_MAP,
    name: 'Trường Tập Bắn',
    icon: '🎯',
    blurb: 'Bãi tập bắn có cung, nỏ và tên miễn phí. Lợn rừng chạy qua lại ở sáu làn bia từ 150 đến 1200.',
    seed: 7707,
    size: TRAINING_SIZE,
    maxPlayers: 1,
    theme: { ground: '#9aab58', grassTint: 0xf6ffe6, decor: [0xd8c08a, 0xb88a52, 0x8ca448, 0xa07a4a] },
    houses: [],
    walls: [],
    rings: [],
    treeLines: [
      { x1: x0, y1: y0, x2: x1, y2: y0 },
      { x1: x0, y1: y1, x2: x1, y2: y1 },
      { x1: x0, y1: y0, x2: x0, y2: y1 },
      { x1: x1, y1: y0, x2: x1, y2: y1 },
    ],
    rocksAt,
    clusters: [],
    clear: [{ x: x0 - 30, y: y0 - 30, w: x1 - x0 + 60, h: y1 - y0 + 60 }],
    patches,
    scatter: { trees: 260, rocks: 30, covers: 0, chests: 0, patches: 6, houses: 0 },
    areas: [
      { name: 'Giá Vũ Khí', x: RACK_X, y: mid, r: 110 },
      { name: 'Vạch Bắn', x: FIRING_LINE_X - 50, y: mid, r: 230 },
      ...TRAINING_LANES.map((lane, i) => ({
        name: `Làn ${lane.distance}`, x: laneX(lane), y: mid, r: 70, ly: i % 2 ? y1 - 90 : y0 + 90,
      })),
      { name: 'Ụ Đất Chắn Tên', x: BERM_X + 30, y: mid, r: 90, ly: y0 + 220 },
      { name: 'Bãi Bắn', x: (x0 + x1) / 2, y: mid, r: 900, ly: y1 - 220 },
    ],
    wild: 'Rừng Quanh Trường',
  };
}

const MEDIUM_SIZE = 6800;

export const MAP_DEFS: Record<MapId, MapDef> = {
  vanlang: VANLANG,
  coloa: scaleDef(COLOA, MEDIUM_SIZE),
  nghialinh: scaleDef(NGHIALINH, MEDIUM_SIZE),
  lacviet: scaleDef(LACVIET, MEDIUM_SIZE),
  phongchau: scaleDef(PHONGCHAU, MEDIUM_SIZE),
  [TRAINING_MAP]: rangeDef(),
};
