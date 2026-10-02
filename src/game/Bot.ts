import {
  BAG_CAPACITY,
  BOT_HUMAN_GRACE_MS,
  INTERACT_RANGE,
  ITEMS,
  MAX_HP,
  PICKUP_RANGE,
  PLAYER_RADIUS,
  WEAPONS,
  angleDiff,
  chestRect,
  clamp,
  scopeOfItem,
  type AmmoType,
  type ItemId,
  type SlotName,
  type WeaponId,
} from '../shared';
import type { Loot, Match, Player } from './Match';

const BOT_NAMES = [
  'Sói Xám', 'Hổ Báo', 'Đại Bàng', 'Rồng Lửa', 'Báo Đêm', 'Cáo Già', 'Gấu Nâu', 'Kền Kền', 'Mèo Rừng',
  'Thợ Săn', 'Bóng Ma', 'Tia Chớp', 'Sấm Sét', 'Bão Cát', 'Rắn Hổ', 'Cá Mập', 'Diều Hâu', 'Lốc Xoáy',
];

export function botNames(count: number): string[] {
  const pool = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  return Array.from({ length: count }, (_, i) => `[BOT] ${pool[i % pool.length]}`);
}

export class Bot {
  private target = -1;
  private targetSince = 0;
  private lootTarget = -1;
  private chestTarget = -1;
  private destination: { x: number; y: number } | null = null;
  private nextThink = 0;
  private strafe = 1;
  private nextStrafeSwitch = 0;
  private aimError = 0;
  private reactionMs: number;
  private lastAttacker = -1;
  private lastHurtAt = -99999;
  private lastPos = { x: 0, y: 0 };
  private nextStuckCheck = 0;
  private stuckUntil = 0;
  private stuckAngle = 0;
  private throwing = 0;
  private readonly skill: number;

  constructor(private readonly rng: () => number) {
    this.skill = 0.55 + rng() * 0.4;
    this.reactionMs = 350 + (1 - this.skill) * 500;
  }

  onHurt(attacker: Player | null) {
    if (attacker) this.lastAttacker = attacker.pid;
    this.lastHurtAt = Date.now();
  }

  update(m: Match, p: Player) {
    const now = m.now;
    if (now >= this.nextThink) {
      this.think(m, p);
      this.nextThink = now + 220 + this.rng() * 160;
    }

    p.fire = false;
    let moveAngle: number | null = null;
    const target = this.target >= 0 ? m.players[this.target] : null;

    if (this.throwing > 0) {
      this.throwing--;
      p.fire = this.throwing === 1;
      p.mx = 0;
      p.my = 0;
      return;
    }

    if (target && target.alive) {
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const d = Math.hypot(dx, dy);
      const toTarget = Math.atan2(dy, dx);
      this.aimError += (this.rng() * 2 - 1) * 0.03;
      this.aimError = clamp(this.aimError * 0.96, -0.2, 0.2);
      p.a = toTarget + this.aimError * (1.3 - this.skill);

      const weapon = m.activeWeapon(p);
      const def = WEAPONS[weapon];
      const melee = def.slot === 'melee';
      const ideal = melee ? 0 : weapon === 'shotgun' ? 140 : weapon === 'sniper' ? 650 : weapon === 'pistol' ? 280 : 380;
      const range = melee ? PLAYER_RADIUS * 2 + def.range : def.range * 0.92;

      if (now >= this.nextStrafeSwitch) {
        this.strafe = this.rng() < 0.5 ? -1 : 1;
        this.nextStrafeSwitch = now + 600 + this.rng() * 1200;
      }
      let ang: number;
      if (melee || d > ideal + 90) ang = toTarget + (melee ? 0 : this.strafe * 0.5);
      else if (d < ideal - 90) ang = toTarget + Math.PI - this.strafe * 0.4;
      else ang = toTarget + (Math.PI / 2) * this.strafe;
      moveAngle = ang;

      const outside = Math.hypot(p.x - m.zone.x, p.y - m.zone.y) > m.zone.r - 30;
      if (outside) moveAngle = Math.atan2(m.zone.y - p.y, m.zone.x - p.x);

      const ready = now - this.targetSince > this.reactionMs;
      if (ready && d <= range && this.hasLineOfSight(m, p, target.x, target.y, d)) p.fire = true;
    } else {
      this.aimError *= 0.9;
      let dest = this.destination;
      if (this.chestTarget >= 0 && m.world.chestAlive[this.chestTarget]) {
        const c = m.map.chests[this.chestTarget];
        dest = { x: c.x, y: c.y };
        const r = chestRect(c);
        const px = clamp(p.x, r.x, r.x + r.w);
        const py = clamp(p.y, r.y, r.y + r.h);
        const dd = Math.hypot(px - p.x, py - p.y);
        const def = WEAPONS[m.activeWeapon(p)];
        const reach = def.slot === 'melee' ? PLAYER_RADIUS + def.range - 6 : 260;
        if (dd < reach) {
          p.a = Math.atan2(c.y - p.y, c.x - p.x);
          p.fire = true;
          dest = null;
        }
      } else if (this.lootTarget >= 0) {
        const l = m.loot.get(this.lootTarget);
        if (!l) {
          this.lootTarget = -1;
        } else {
          dest = { x: l.x, y: l.y };
          if (Math.hypot(l.x - p.x, l.y - p.y) < PICKUP_RANGE - 15) {
            m.interact(p);
            this.lootTarget = -1;
            this.nextThink = now;
          }
        }
      }
      if (dest) {
        const d = Math.hypot(dest.x - p.x, dest.y - p.y);
        if (d > 20) moveAngle = Math.atan2(dest.y - p.y, dest.x - p.x);
        else this.destination = null;
      }
      if (moveAngle !== null && !p.fire) p.a += angleDiff(p.a, moveAngle) * 0.25;
    }

    if (moveAngle === null) {
      p.mx = 0;
      p.my = 0;
      return;
    }

    if (now >= this.nextStuckCheck) {
      const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
      if (moved < 25) {
        this.stuckUntil = now + 700;
        this.stuckAngle = moveAngle + (this.rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + this.rng());
        this.tryOpenDoor(m, p);
      }
      this.lastPos = { x: p.x, y: p.y };
      this.nextStuckCheck = now + 1000;
    }
    const finalAngle = now < this.stuckUntil ? this.stuckAngle : this.steer(m, p, moveAngle);
    p.mx = Math.cos(finalAngle);
    p.my = Math.sin(finalAngle);
  }

  private think(m: Match, p: Player) {
    const now = m.now;
    const cap = BAG_CAPACITY[p.bag];

    const hasGun = (['p1', 'p2', 'pistol'] as const).some((s) => {
      const slot = p[s];
      return !!slot && (slot.mag > 0 || p.ammo[WEAPONS[slot.w].ammo!] > 0);
    });
    const recentlyHurt = Date.now() - this.lastHurtAt < 4000;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const o of m.players) {
      if (o === p || !o.alive || !m.canSee(p, o)) continue;
      const provoked = recentlyHurt && o.pid === this.lastAttacker;
      if (o.userId && now < BOT_HUMAN_GRACE_MS && !provoked) continue;
      let d = Math.hypot(o.x - p.x, o.y - p.y);
      if (!hasGun && d > 220 && !(recentlyHurt && o.pid === this.lastAttacker)) continue;
      if (o.pid === this.lastAttacker && recentlyHurt) d *= 0.5;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    const newTarget = best ? best.pid : -1;
    if (newTarget !== this.target) {
      this.target = newTarget;
      this.targetSince = now;
    }

    if (best) {
      this.chooseWeapon(m, p, Math.hypot(best.x - p.x, best.y - p.y));
      if (p.gren > 0 && bestD > 180 && bestD < 420 && this.rng() < 0.04 && p.healUntil === 0) {
        m.equip(p, 'grenade');
        p.td = bestD;
        p.a = Math.atan2(best.y - p.y, best.x - p.x);
        this.throwing = 10;
      }
      return;
    }

    if (p.med > 0 && p.hp < MAX_HP * 0.6 && p.healUntil === 0) {
      m.heal(p);
      return;
    }
    const slot = m.slotWeapon(p, p.active);
    if (slot && p.reloadUntil === 0) {
      const def = WEAPONS[slot.w];
      if (slot.mag < def.magSize * 0.6 && p.ammo[def.ammo!] > 0) m.reload(p);
    }
    this.chooseWeapon(m, p, 400);

    const z = m.zone;
    const outsideNow = Math.hypot(p.x - z.x, p.y - z.y) > z.r - 60;
    const outsideNext = Math.hypot(p.x - z.tx, p.y - z.ty) > z.tr - 40;
    const urgent = outsideNow || (outsideNext && (z.stage === 'shrink' || z.stageLeftMs < 45_000));
    if (urgent) {
      this.lootTarget = -1;
      this.chestTarget = -1;
      this.destination = this.randomPointIn(z.tx, z.ty, Math.max(40, z.tr * 0.6));
      return;
    }

    if (this.lootTarget < 0 || !m.loot.has(this.lootTarget)) {
      let bestLoot: Loot | null = null;
      let bestScore = Infinity;
      const searchRadius = hasGun ? 650 : 1400;
      for (const l of m.loot.values()) {
        const d = Math.hypot(l.x - p.x, l.y - p.y);
        if (d > searchRadius || (l.room !== -1 && l.room !== p.room && d > 260 && hasGun)) continue;
        const value = this.lootValue(p, l.item, cap);
        if (value <= 0) continue;
        const score = d / value;
        if (score < bestScore) {
          bestScore = score;
          bestLoot = l;
        }
      }
      this.lootTarget = bestLoot ? bestLoot.id : -1;
    }

    if (this.lootTarget < 0 && (this.chestTarget < 0 || !m.world.chestAlive[this.chestTarget])) {
      this.chestTarget = -1;
      for (const c of m.map.chests) {
        if (m.world.chestAlive[c.id] && Math.hypot(c.x - p.x, c.y - p.y) < 380) {
          this.chestTarget = c.id;
          break;
        }
      }
    }

    if (this.lootTarget < 0 && this.chestTarget < 0 && !this.destination) {
      this.destination = this.randomPointIn(z.tx, z.ty, Math.max(60, z.tr * 0.85));
    }
  }

  private lootValue(p: Player, item: ItemId, cap: (typeof BAG_CAPACITY)[0]): number {
    const def = ITEMS[item];
    switch (def.kind) {
      case 'weapon': {
        const w = WEAPONS[item as WeaponId];
        if (w.slot === 'melee') return p.melee === 'fists' ? 2 : 0;
        if (w.slot === 'pistol') return p.pistol ? 0 : p.p1 ? 1 : 4;
        const held = [p.p1?.w, p.p2?.w];
        if (held.includes(item as WeaponId)) return 0;
        if (!p.p1) return 6;
        if (!p.p2) return 4;
        return 0;
      }
      case 'ammo': {
        const type = item.slice(5) as AmmoType;
        const uses = [p.p1, p.p2, p.pistol].some((s) => s && WEAPONS[s.w].ammo === type);
        if (!uses || p.ammo[type] >= cap.ammo[type]) return 0;
        return p.ammo[type] < 30 ? 4 : 1.5;
      }
      case 'medkit': return p.med < cap.medkit ? 2.5 : 0;
      case 'grenade': return p.gren < cap.grenade ? 1 : 0;
      case 'smoke': return 0;
      case 'armor': return Number(item.slice(5)) > p.armor ? 3.5 : 0;
      case 'bag': return Number(item.slice(3)) > p.bag ? 2 : 0;
      case 'scope': return p.scopes.has(scopeOfItem(item) as 1) ? 0 : 1.5;
    }
  }

  private chooseWeapon(m: Match, p: Player, d: number) {
    const usable = (s: SlotName): boolean => {
      const slot = m.slotWeapon(p, s);
      return !!slot && (slot.mag > 0 || p.ammo[WEAPONS[slot.w].ammo!] > 0);
    };
    const order: WeaponId[] = d < 220
      ? ['shotgun', 'rifle', 'pistol', 'sniper']
      : d < 700 ? ['rifle', 'sniper', 'pistol', 'shotgun'] : ['sniper', 'rifle', 'pistol', 'shotgun'];
    for (const w of order) {
      const slot = (['p1', 'p2', 'pistol'] as const).find((s) => p[s]?.w === w && usable(s));
      if (slot) {
        if (p.active !== slot && p.reloadUntil === 0) m.equip(p, slot);
        return;
      }
    }
    if (p.active !== 'melee') m.equip(p, 'melee');
  }

  private hasLineOfSight(m: Match, p: Player, tx: number, ty: number, d: number): boolean {
    const hit = m.world.raycast(p.x, p.y, tx, ty, true);
    return !hit || hit.t * d >= d - PLAYER_RADIUS;
  }

  private steer(m: Match, p: Player, angle: number): number {
    const offsets = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];
    for (const off of offsets) {
      const a = angle + off;
      const probe = m.world.moveCircle(p.x, p.y, Math.cos(a) * 40, Math.sin(a) * 40, PLAYER_RADIUS);
      if (Math.hypot(probe.x - p.x, probe.y - p.y) > 28) return a;
    }
    this.tryOpenDoor(m, p);
    return angle;
  }

  private tryOpenDoor(m: Match, p: Player) {
    for (const door of m.map.doors) {
      if (m.world.doorOpen[door.id]) continue;
      if (Math.hypot(door.x + door.w / 2 - p.x, door.y + door.h / 2 - p.y) < INTERACT_RANGE - 10) {
        m.interact(p);
        return;
      }
    }
  }

  private randomPointIn(x: number, y: number, r: number) {
    const ang = this.rng() * Math.PI * 2;
    const d = Math.sqrt(this.rng()) * r;
    return { x: clamp(x + Math.cos(ang) * d, 80, 4720), y: clamp(y + Math.sin(ang) * d, 80, 4720) };
  }
}
