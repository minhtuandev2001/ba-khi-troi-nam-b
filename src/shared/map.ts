import { CHEST_SIZE, DOOR_WIDTH, WALL_THICKNESS } from './constants';
import { type Circle, type Rect, rectContains, rectsOverlap, dist } from './geometry';
import { DEFAULT_CELL_H, DEFAULT_CELL_W, MAP_DEFS, ringWalls, type MapArea, type MapDef, type MapId, type Side } from './maps';
import { createRng, randInt, pick, type Rng } from './rng';

function randRange(min: number, max: number, rng: Rng): number {
  return min + rng() * (max - min);
}

export interface Tree { id: number; x: number; y: number; r: number }
export interface Rock { id: number; x: number; y: number; r: number }
export interface Wall extends Rect { id: number; houseId: number }
export interface Door extends Rect { id: number; houseId: number; vertical: boolean }
export interface Room extends Rect { id: number; houseId: number }
export interface House extends Rect { id: number; roomIds: number[]; floor: number; roof: number }
export interface Chest { id: number; x: number; y: number }
export interface Decor { x: number; y: number; r: number; color: number }

export interface GameMap {
  id: MapId;
  name: string;
  size: number;
  trees: Tree[];
  rocks: Rock[];
  walls: Wall[];
  doors: Door[];
  rooms: Room[];
  houses: House[];
  chests: Chest[];
  decor: Decor[];
  areas: MapArea[];
  wild: string;
}

/** Bamboo-slat floors. */
const FLOORS = [0xd8b47a, 0xc9a064, 0xe2c28a, 0xbf9660];
/** Thatch tints: fresh straw, old straw, rice stalk, dried palm leaf, sun-bleached. */
const ROOFS = [0xe0b85a, 0xc0904a, 0xd2ae68, 0xa4804a, 0xe8cf8a];

const FILLER_LAYOUTS: [number, number][] = [[1, 1], [1, 1], [2, 1], [1, 2], [2, 2]];
const HEDGE_SPACING = 78;
const HEDGE_GATE = 230;

export function chestRect(c: Chest): Rect {
  return { x: c.x - CHEST_SIZE / 2, y: c.y - CHEST_SIZE / 2, w: CHEST_SIZE, h: CHEST_SIZE };
}

function inClear(def: MapDef, x: number, y: number, r: number): boolean {
  return def.clear.some((c) =>
    'r' in c ? dist(c.x, c.y, x, y) < c.r + r : rectsOverlap(c, { x: x - r, y: y - r, w: r * 2, h: r * 2 }),
  );
}

/** Same id always yields the same terrain; only loot is rolled per match. */
export function generateMap(id: MapId): GameMap {
  const def = MAP_DEFS[id];
  const size = def.size;
  const rng = createRng(def.seed);
  const map: GameMap = {
    id, name: def.name, size,
    trees: [], rocks: [], walls: [], doors: [], rooms: [], houses: [], chests: [], decor: [],
    areas: def.areas, wild: def.wild,
  };
  const palette = def.theme.decor;

  for (const [x, y, r, c] of def.patches) map.decor.push({ x, y, r, color: palette[c % palette.length] });
  for (let i = 0; i < def.scatter.patches; i++) {
    map.decor.push({ x: rng() * size, y: rng() * size, r: randRange(80, 260, rng), color: pick(rng, palette) });
  }

  for (const h of def.houses) {
    const cw = h.cw ?? DEFAULT_CELL_W;
    const ch = h.ch ?? DEFAULT_CELL_H;
    buildHouse(map, rng, { x: h.x, y: h.y, w: h.cols * cw, h: h.rows * ch }, h.cols, h.rows, cw, ch, h.doors, h.chest);
  }
  for (const w of def.walls) map.walls.push({ id: map.walls.length, houseId: -1, ...w });
  for (const r of def.rings) for (const w of ringWalls(r)) map.walls.push({ id: map.walls.length, houseId: -1, ...w });

  const nearLine = (rect: Rect, margin: number) => def.treeLines.some((l) => {
    const lx0 = Math.min(l.x1, l.x2) - margin;
    const ly0 = Math.min(l.y1, l.y2) - margin;
    return rectsOverlap(rect, { x: lx0, y: ly0, w: Math.abs(l.x2 - l.x1) + margin * 2, h: Math.abs(l.y2 - l.y1) + margin * 2 });
  });
  let fillers = 0;
  for (let attempt = 0; attempt < 8000 && fillers < def.scatter.houses; attempt++) {
    const [cols, rows] = pick(rng, FILLER_LAYOUTS);
    const w = cols * DEFAULT_CELL_W;
    const h = rows * DEFAULT_CELL_H;
    const rect = { x: Math.round(randRange(300, size - 300 - w, rng)), y: Math.round(randRange(300, size - 300 - h, rng)), w, h };
    const cx = rect.x + w / 2;
    const cy = rect.y + h / 2;
    if (map.houses.some((o) => rectsOverlap(o, rect, 260))) continue;
    if (map.walls.some((wl) => wl.houseId < 0 && rectsOverlap(wl, rect, 170))) continue;
    if (nearLine(rect, 180) || inClear(def, cx, cy, Math.max(w, h) / 2 + 60)) continue;
    if (def.rocksAt.some((r) => rectsOverlap(rect, { x: r.x - r.r, y: r.y - r.r, w: r.r * 2, h: r.r * 2 }, 120))) continue;
    buildHouse(map, rng, rect, cols, rows, DEFAULT_CELL_W, DEFAULT_CELL_H);
    fillers++;
  }

  const box = (x: number, y: number, r: number): Rect => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  const hitsStructure = (x: number, y: number, r: number, houseMargin: number) =>
    map.houses.some((hs) => rectsOverlap(hs, box(x, y, r), houseMargin)) ||
    map.walls.some((wl) => wl.houseId < 0 && rectsOverlap(wl, box(x, y, r), 50));
  const blocked = (x: number, y: number, r: number, houseMargin: number, gap = 60) =>
    hitsStructure(x, y, r, houseMargin) ||
    map.trees.some((t) => dist(t.x, t.y, x, y) < t.r + r + gap) ||
    map.rocks.some((o) => dist(o.x, o.y, x, y) < o.r + r + gap) ||
    map.chests.some((c) => dist(c.x, c.y, x, y) < r + 80);
  const inBounds = (x: number, y: number, pad: number) => x > pad && y > pad && x < size - pad && y < size - pad;

  for (const line of def.treeLines) placeLine(map, rng, line.x1, line.y1, line.x2, line.y2, line.gaps ?? [], hitsStructure);
  for (const r of def.rocksAt) map.rocks.push({ id: map.rocks.length, x: r.x, y: r.y, r: r.r });

  const scatterIn = (c: Circle | null, kind: 'tree' | 'rock', want: number, gap: number) => {
    const list = kind === 'tree' ? map.trees : map.rocks;
    const target = list.length + want;
    for (let i = 0; i < want * 40 && list.length < target; i++) {
      const r = kind === 'tree' ? randInt(rng, 24, 34) : randInt(rng, 30, 62);
      let x: number;
      let y: number;
      if (c) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * c.r;
        x = c.x + Math.cos(a) * d;
        y = c.y + Math.sin(a) * d;
      } else {
        x = randRange(80, size - 80, rng);
        y = randRange(80, size - 80, rng);
      }
      if (!inBounds(x, y, 80) || inClear(def, x, y, r) || blocked(x, y, r, 70, gap)) continue;
      list.push({ id: list.length, x, y, r });
    }
  };

  for (const c of def.clusters) {
    if (c.trees) scatterIn(c, 'tree', c.trees, 45);
    if (c.rocks) scatterIn(c, 'rock', c.rocks, 50);
  }
  scatterIn(null, 'tree', Math.max(0, def.scatter.trees - map.trees.length), 60);
  scatterIn(null, 'rock', Math.max(0, def.scatter.rocks - map.rocks.length), 60);

  let coverWalls = 0;
  for (let i = 0; i < 1500 && coverWalls < def.scatter.covers; i++) {
    const vertical = rng() < 0.5;
    const len = randInt(rng, 110, 220);
    const thick = 22;
    const x = randRange(150, size - 150 - len, rng);
    const y = randRange(150, size - 150 - len, rng);
    const rect = vertical ? { x, y, w: thick, h: len } : { x, y, w: len, h: thick };
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (inClear(def, cx, cy, len / 2) || blocked(cx, cy, len / 2, 60)) continue;
    map.walls.push({ id: map.walls.length, houseId: -1, ...rect });
    coverWalls++;
  }

  let outsideChests = 0;
  for (let i = 0; i < 800 && outsideChests < def.scatter.chests; i++) {
    const x = randRange(200, size - 200, rng);
    const y = randRange(200, size - 200, rng);
    if (blocked(x, y, CHEST_SIZE, 60)) continue;
    map.chests.push({ id: map.chests.length, x, y });
    outsideChests++;
  }

  return map;
}

function placeLine(
  map: GameMap, rng: Rng, x1: number, y1: number, x2: number, y2: number, gaps: number[],
  hitsStructure: (x: number, y: number, r: number, margin: number) => boolean,
) {
  const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.round(len / HEDGE_SPACING));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    const along = horizontal ? x : y;
    if (gaps.some((g) => Math.abs(g - along) < HEDGE_GATE / 2)) continue;
    const r = randInt(rng, 26, 30);
    if (hitsStructure(x, y, r, 40)) continue;
    if (map.trees.some((o) => dist(o.x, o.y, x, y) < 30)) continue;
    map.trees.push({ id: map.trees.length, x, y, r });
  }
}

function buildHouse(
  map: GameMap, rng: Rng, rect: Rect, cols: number, rows: number, cw: number, ch: number,
  doorSides?: Side[], chest?: boolean,
) {
  const houseId = map.houses.length;
  const house: House = {
    id: houseId,
    x: rect.x - WALL_THICKNESS / 2,
    y: rect.y - WALL_THICKNESS / 2,
    w: rect.w + WALL_THICKNESS,
    h: rect.h + WALL_THICKNESS,
    roomIds: [],
    floor: pick(rng, FLOORS),
    roof: pick(rng, ROOFS),
  };
  map.houses.push(house);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const room: Room = { id: map.rooms.length, houseId, x: rect.x + c * cw, y: rect.y + r * ch, w: cw, h: ch };
      map.rooms.push(room);
      house.roomIds.push(room.id);
    }
  }

  type Edge = { vertical: boolean; at: number; from: number; to: number; exterior: boolean; door: boolean; side?: Side };
  const edges: Edge[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      const exterior = r === 0 || r === rows;
      const side: Side | undefined = r === 0 ? 'n' : r === rows ? 's' : undefined;
      edges.push({ vertical: false, at: rect.y + r * ch, from: rect.x + c * cw, to: rect.x + (c + 1) * cw, exterior, door: !exterior, side });
    }
  }
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r < rows; r++) {
      const exterior = c === 0 || c === cols;
      const side: Side | undefined = c === 0 ? 'w' : c === cols ? 'e' : undefined;
      edges.push({ vertical: true, at: rect.x + c * cw, from: rect.y + r * ch, to: rect.y + (r + 1) * ch, exterior, door: !exterior, side });
    }
  }
  const exteriorEdges = edges.filter((e) => e.exterior);
  if (doorSides?.length) {
    for (const s of doorSides) {
      const onSide = exteriorEdges.filter((e) => e.side === s);
      if (onSide.length) onSide[Math.floor(onSide.length / 2)].door = true;
    }
  } else {
    const doorCount = Math.min(exteriorEdges.length, 1 + (rng() < 0.5 ? 1 : 0));
    for (let i = 0; i < doorCount; i++) {
      const candidates = exteriorEdges.filter((e) => !e.door);
      if (candidates.length) pick(rng, candidates).door = true;
    }
  }

  const half = WALL_THICKNESS / 2;
  for (const e of edges) {
    const start = e.vertical ? e.from + half : e.from - half;
    const end = e.vertical ? e.to - half : e.to + half;
    const segments: [number, number][] = [];
    if (e.door) {
      const mid = (e.from + e.to) / 2;
      segments.push([start, mid - DOOR_WIDTH / 2], [mid + DOOR_WIDTH / 2, end]);
      const doorRect = e.vertical
        ? { x: e.at - half, y: mid - DOOR_WIDTH / 2, w: WALL_THICKNESS, h: DOOR_WIDTH }
        : { x: mid - DOOR_WIDTH / 2, y: e.at - half, w: DOOR_WIDTH, h: WALL_THICKNESS };
      map.doors.push({ id: map.doors.length, houseId, vertical: e.vertical, ...doorRect });
    } else {
      segments.push([start, end]);
    }
    for (const [a, b] of segments) {
      if (b - a <= 0) continue;
      const wall = e.vertical
        ? { x: e.at - half, y: a, w: WALL_THICKNESS, h: b - a }
        : { x: a, y: e.at - half, w: b - a, h: WALL_THICKNESS };
      map.walls.push({ id: map.walls.length, houseId, ...wall });
    }
  }

  if (chest ?? rng() < 0.45) {
    const doors = map.doors.filter((d) => d.houseId === houseId);
    let x = 0;
    let y = 0;
    for (let i = 0; i < 16; i++) {
      const room = map.rooms[pick(rng, house.roomIds)];
      x = room.x + randRange(room.w * 0.3, room.w * 0.7, rng);
      y = room.y + randRange(room.h * 0.3, room.h * 0.7, rng);
      if (!doors.some((d) => dist(d.x + d.w / 2, d.y + d.h / 2, x, y) < 100)) break;
    }
    map.chests.push({ id: map.chests.length, x, y });
  }
}

/** Unit vector pointing out of the house for doors in an exterior wall, null for doors between rooms. */
export function doorOutward(map: GameMap, d: Door): { dx: number; dy: number } | null {
  const h = map.houses[d.houseId];
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  if (d.vertical) {
    if (Math.abs(cx - h.x) < WALL_THICKNESS) return { dx: -1, dy: 0 };
    if (Math.abs(cx - (h.x + h.w)) < WALL_THICKNESS) return { dx: 1, dy: 0 };
  } else {
    if (Math.abs(cy - h.y) < WALL_THICKNESS) return { dx: 0, dy: -1 };
    if (Math.abs(cy - (h.y + h.h)) < WALL_THICKNESS) return { dx: 0, dy: 1 };
  }
  return null;
}

/** Room containing the point, or -1 when outdoors. */
export function roomAt(map: GameMap, x: number, y: number): number {
  for (const house of map.houses) {
    if (!rectContains(house, x, y)) continue;
    for (const id of house.roomIds) {
      if (rectContains(map.rooms[id], x, y)) return id;
    }
  }
  return -1;
}

/** Name of the smallest named area containing the point. */
export function areaAt(map: GameMap, x: number, y: number): string {
  let best: MapArea | null = null;
  for (const a of map.areas) {
    if ((x - a.x) ** 2 + (y - a.y) ** 2 > a.r * a.r) continue;
    if (!best || a.r < best.r) best = a;
  }
  return best ? best.name : map.wild;
}
