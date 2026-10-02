import { CHEST_SIZE, DOOR_WIDTH, MAP_SIZE, WALL_THICKNESS } from './constants';
import { type Rect, rectContains, rectsOverlap, dist } from './geometry';
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
  seed: number;
  size: number;
  trees: Tree[];
  rocks: Rock[];
  walls: Wall[];
  doors: Door[];
  rooms: Room[];
  houses: House[];
  chests: Chest[];
  decor: Decor[];
}

const FLOORS = [0xe0b07a, 0xd49a62, 0xe8c48e, 0xc99a6a];
const ROOFS = [0xe8553e, 0x2fa3e0, 0xf2a530, 0x3fbf8f, 0x9b6bd6];

const LAYOUTS: [number, number][] = [
  [1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [2, 2],
];

export function chestRect(c: Chest): Rect {
  return { x: c.x - CHEST_SIZE / 2, y: c.y - CHEST_SIZE / 2, w: CHEST_SIZE, h: CHEST_SIZE };
}

export function generateMap(seed: number): GameMap {
  const rng = createRng(seed);
  const map: GameMap = {
    seed, size: MAP_SIZE, trees: [], rocks: [], walls: [], doors: [], rooms: [], houses: [], chests: [], decor: [],
  };

  for (let i = 0; i < 70; i++) {
    map.decor.push({
      x: rng() * MAP_SIZE,
      y: rng() * MAP_SIZE,
      r: randRange(80, 260, rng),
      color: pick(rng, [0x9be35f, 0x6cc23e, 0xb8e36a, 0xf0d58a]),
    });
  }

  const houseCount = 16;
  for (let attempt = 0; attempt < 600 && map.houses.length < houseCount; attempt++) {
    const [cols, rows] = pick(rng, LAYOUTS);
    const cw = randInt(rng, 230, 290);
    const ch = randInt(rng, 210, 260);
    const w = cols * cw;
    const h = rows * ch;
    const x = randRange(220, MAP_SIZE - 220 - w, rng);
    const y = randRange(220, MAP_SIZE - 220 - h, rng);
    const rect = { x, y, w, h };
    if (map.houses.some((o) => rectsOverlap(o, rect, 260))) continue;
    buildHouse(map, rng, rect, cols, rows, cw, ch);
  }

  const blocked = (x: number, y: number, r: number, houseMargin: number) =>
    map.houses.some((hs) => rectsOverlap(hs, { x: x - r, y: y - r, w: r * 2, h: r * 2 }, houseMargin)) ||
    map.trees.some((t) => dist(t.x, t.y, x, y) < t.r + r + 60) ||
    map.rocks.some((o) => dist(o.x, o.y, x, y) < o.r + r + 60) ||
    map.walls.some((wl) => wl.houseId < 0 && rectsOverlap(wl, { x: x - r, y: y - r, w: r * 2, h: r * 2 }, 50)) ||
    map.chests.some((c) => dist(c.x, c.y, x, y) < r + 80);

  for (let i = 0; i < 1500 && map.trees.length < 230; i++) {
    const r = randInt(rng, 24, 34);
    const x = randRange(80, MAP_SIZE - 80, rng);
    const y = randRange(80, MAP_SIZE - 80, rng);
    if (blocked(x, y, r, 70)) continue;
    map.trees.push({ id: map.trees.length, x, y, r });
  }

  for (let i = 0; i < 1500 && map.rocks.length < 110; i++) {
    const r = randInt(rng, 30, 62);
    const x = randRange(100, MAP_SIZE - 100, rng);
    const y = randRange(100, MAP_SIZE - 100, rng);
    if (blocked(x, y, r, 70)) continue;
    map.rocks.push({ id: map.rocks.length, x, y, r });
  }

  let coverWalls = 0;
  for (let i = 0; i < 1500 && coverWalls < 55; i++) {
    const vertical = rng() < 0.5;
    const len = randInt(rng, 110, 220);
    const thick = 22;
    const x = randRange(150, MAP_SIZE - 150 - len, rng);
    const y = randRange(150, MAP_SIZE - 150 - len, rng);
    const rect = vertical ? { x, y, w: thick, h: len } : { x, y, w: len, h: thick };
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (blocked(cx, cy, len / 2, 60)) continue;
    map.walls.push({ id: map.walls.length, houseId: -1, ...rect });
    coverWalls++;
  }

  let outsideChests = 0;
  for (let i = 0; i < 800 && outsideChests < 8; i++) {
    const x = randRange(200, MAP_SIZE - 200, rng);
    const y = randRange(200, MAP_SIZE - 200, rng);
    if (blocked(x, y, CHEST_SIZE, 60)) continue;
    map.chests.push({ id: map.chests.length, x, y });
    outsideChests++;
  }

  return map;
}

function buildHouse(map: GameMap, rng: Rng, rect: Rect, cols: number, rows: number, cw: number, ch: number) {
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

  type Edge = { vertical: boolean; at: number; from: number; to: number; exterior: boolean; door: boolean };
  const edges: Edge[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      const exterior = r === 0 || r === rows;
      edges.push({ vertical: false, at: rect.y + r * ch, from: rect.x + c * cw, to: rect.x + (c + 1) * cw, exterior, door: !exterior });
    }
  }
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r < rows; r++) {
      const exterior = c === 0 || c === cols;
      edges.push({ vertical: true, at: rect.x + c * cw, from: rect.y + r * ch, to: rect.y + (r + 1) * ch, exterior, door: !exterior });
    }
  }
  const exteriorEdges = edges.filter((e) => e.exterior);
  const doorCount = Math.min(exteriorEdges.length, 1 + (rng() < 0.5 ? 1 : 0));
  for (let i = 0; i < doorCount; i++) {
    const candidates = exteriorEdges.filter((e) => !e.door);
    if (candidates.length) pick(rng, candidates).door = true;
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

  if (rng() < 0.45) {
    const room = map.rooms[pick(rng, house.roomIds)];
    const x = room.x + randRange(room.w * 0.3, room.w * 0.7, rng);
    const y = room.y + randRange(room.h * 0.3, room.h * 0.7, rng);
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
