import { CHEST_SIZE, type GameMap, type MapId, type Vec } from '../shared';

const CELL = 20;
/** Narrower than a player so door gaps register as open; local steering absorbs the difference. */
const CLEARANCE = 16;
/** Search budget as a share of all cells; covers any reachable goal on the open maps. */
const BUDGET_SHARE = 0.43;
/** Slightly inflated heuristic: paths stay near-shortest while open ground stops flooding the search. */
const H_WEIGHT = 1.2;
const SQRT2 = Math.SQRT2;

const cache = new Map<MapId, NavGrid>();

/** Static walkability grid for bot pathfinding. Doors count as open; bots push them when they bump into one. */
export class NavGrid {
  private readonly N: number;
  private readonly maxExpanded: number;
  private readonly free: Uint8Array;
  private readonly g: Float32Array;
  private readonly from: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private stamp = 0;

  static for(map: GameMap): NavGrid {
    let nav = cache.get(map.id);
    if (!nav) {
      nav = new NavGrid(map);
      cache.set(map.id, nav);
    }
    return nav;
  }

  private constructor(map: GameMap) {
    const N = (this.N = Math.ceil(map.size / CELL));
    this.maxExpanded = Math.round(N * N * BUDGET_SHARE);
    this.free = new Uint8Array(N * N).fill(1);
    this.g = new Float32Array(N * N);
    this.from = new Int32Array(N * N);
    this.seen = new Uint32Array(N * N);
    this.closed = new Uint32Array(N * N);
    const blockRect = (x: number, y: number, w: number, h: number) => {
      const x0 = Math.max(0, Math.floor((x - CLEARANCE) / CELL));
      const y0 = Math.max(0, Math.floor((y - CLEARANCE) / CELL));
      const x1 = Math.min(N - 1, Math.floor((x + w + CLEARANCE) / CELL));
      const y1 = Math.min(N - 1, Math.floor((y + h + CLEARANCE) / CELL));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cx = gx * CELL + CELL / 2;
          const cy = gy * CELL + CELL / 2;
          const px = Math.min(Math.max(cx, x), x + w);
          const py = Math.min(Math.max(cy, y), y + h);
          if ((cx - px) ** 2 + (cy - py) ** 2 < CLEARANCE * CLEARANCE) this.free[gy * N + gx] = 0;
        }
      }
    };
    const blockCircle = (x: number, y: number, r: number) => {
      const rr = r + CLEARANCE;
      const x0 = Math.max(0, Math.floor((x - rr) / CELL));
      const y0 = Math.max(0, Math.floor((y - rr) / CELL));
      const x1 = Math.min(N - 1, Math.floor((x + rr) / CELL));
      const y1 = Math.min(N - 1, Math.floor((y + rr) / CELL));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cx = gx * CELL + CELL / 2;
          const cy = gy * CELL + CELL / 2;
          if ((cx - x) ** 2 + (cy - y) ** 2 < rr * rr) this.free[gy * N + gx] = 0;
        }
      }
    };
    for (const w of map.walls) blockRect(w.x, w.y, w.w, w.h);
    for (const t of map.trees) blockCircle(t.x, t.y, t.r);
    for (const r of map.rocks) blockCircle(r.x, r.y, r.r);
    for (const c of map.chests) blockRect(c.x - CHEST_SIZE / 2, c.y - CHEST_SIZE / 2, CHEST_SIZE, CHEST_SIZE);
    for (let i = 0; i < N; i++) {
      this.free[i] = this.free[(N - 1) * N + i] = this.free[i * N] = this.free[i * N + N - 1] = 0;
    }
  }

  isFree(x: number, y: number): boolean {
    const N = this.N;
    const gx = Math.floor(x / CELL);
    const gy = Math.floor(y / CELL);
    return gx >= 0 && gy >= 0 && gx < N && gy < N && this.free[gy * N + gx] === 1;
  }

  private nearestFree(x: number, y: number): number {
    const N = this.N;
    const gx0 = Math.min(N - 1, Math.max(0, Math.floor(x / CELL)));
    const gy0 = Math.min(N - 1, Math.max(0, Math.floor(y / CELL)));
    for (let r = 0; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = gx0 + dx;
          const gy = gy0 + dy;
          if (gx >= 0 && gy >= 0 && gx < N && gy < N && this.free[gy * N + gx]) return gy * N + gx;
        }
      }
    }
    return -1;
  }

  /** Straight segment stays on walkable cells. */
  private clearLine(ax: number, ay: number, bx: number, by: number): boolean {
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isFree(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  /** Waypoints from start to goal (start excluded), or null when unreachable within the search budget. */
  findPath(sx: number, sy: number, tx: number, ty: number): Vec[] | null {
    const N = this.N;
    const start = this.nearestFree(sx, sy);
    const goal = this.nearestFree(tx, ty);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: tx, y: ty }];

    const stamp = ++this.stamp;
    const gx = goal % N;
    const gy = (goal / N) | 0;
    const h = (i: number) => {
      const dx = Math.abs((i % N) - gx);
      const dy = Math.abs(((i / N) | 0) - gy);
      return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * H_WEIGHT;
    };
    const heap = new MinHeap();
    this.seen[start] = stamp;
    this.g[start] = 0;
    this.from[start] = -1;
    heap.push(start, h(start));
    let expanded = 0;
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (this.closed[cur] === stamp) continue;
      this.closed[cur] = stamp;
      if (++expanded > this.maxExpanded) return null;
      const cx = cur % N;
      const cy = (cur / N) | 0;
      const base = this.g[cur];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const ni = ny * N + nx;
          if (!this.free[ni] || this.closed[ni] === stamp) continue;
          if (dx && dy && (!this.free[cy * N + nx] || !this.free[ny * N + cx])) continue;
          const ng = base + (dx && dy ? SQRT2 : 1);
          if (this.seen[ni] === stamp && ng >= this.g[ni]) continue;
          this.seen[ni] = stamp;
          this.g[ni] = ng;
          this.from[ni] = cur;
          heap.push(ni, ng + h(ni));
        }
      }
    }
    if (!found) return null;

    const cells: Vec[] = [];
    for (let i = goal; i !== start && i >= 0; i = this.from[i]) {
      cells.push({ x: (i % N) * CELL + CELL / 2, y: ((i / N) | 0) * CELL + CELL / 2 });
    }
    cells.reverse();
    cells[cells.length - 1] = { x: tx, y: ty };

    const out: Vec[] = [];
    let ax = sx;
    let ay = sy;
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.clearLine(ax, ay, cells[j].x, cells[j].y)) j--;
      out.push(cells[j]);
      ax = cells[j].x;
      ay = cells[j].y;
      i = j + 1;
    }
    return out;
  }
}

class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number) {
    const a = this.items;
    const k = this.keys;
    let i = a.length;
    a.push(item);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      a[i] = a[p];
      k[i] = k[p];
      i = p;
    }
    a[i] = item;
    k[i] = key;
  }

  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastItem = a.pop()!;
    const lastKey = k.pop()!;
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastKey) break;
        a[i] = a[c];
        k[i] = k[c];
        i = c;
      }
      a[i] = lastItem;
      k[i] = lastKey;
    }
    return top;
  }
}
