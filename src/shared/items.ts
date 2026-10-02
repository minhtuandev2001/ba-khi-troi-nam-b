export type WeaponId = 'fists' | 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type GunId = 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type AmmoType = '9mm' | '556' | '12g' | '762';
export type WeaponSlotKind = 'melee' | 'pistol' | 'primary';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: WeaponSlotKind;
  damage: number;
  /** Shots per second. */
  fireRate: number;
  auto: boolean;
  pellets: number;
  magSize: number;
  reloadMs: number;
  range: number;
  /** Half-angle in degrees while standing still. */
  spread: number;
  /** Extra half-angle in degrees while moving. */
  moveSpread: number;
  bulletSpeed: number;
  ammo: AmmoType | null;
  moveMultiplier: number;
  /** Fraction of range after which damage starts to fall off. */
  falloffStart: number;
  /** Damage multiplier at max range. */
  falloffMin: number;
  color: number;
  desc: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists', name: 'Tay không', slot: 'melee', damage: 18, fireRate: 2.2, auto: true, pellets: 1,
    magSize: 0, reloadMs: 0, range: 54, spread: 35, moveSpread: 0, bulletSpeed: 0, ammo: null,
    moveMultiplier: 1.05, falloffStart: 1, falloffMin: 1, color: 0xf2c79b,
    desc: 'Đấm trong tầm gần. Dùng được để phá rương đồ.',
  },
  knife: {
    id: 'knife', name: 'Dao', slot: 'melee', damage: 34, fireRate: 2.5, auto: true, pellets: 1,
    magSize: 0, reloadMs: 0, range: 66, spread: 35, moveSpread: 0, bulletSpeed: 0, ammo: null,
    moveMultiplier: 1.08, falloffStart: 1, falloffMin: 1, color: 0xc0c7d0,
    desc: 'Cận chiến mạnh gần gấp đôi tay không, chạy nhanh hơn một chút.',
  },
  pistol: {
    id: 'pistol', name: 'Súng lục', slot: 'pistol', damage: 24, fireRate: 5, auto: false, pellets: 1,
    magSize: 15, reloadMs: 1600, range: 650, spread: 3, moveSpread: 3, bulletSpeed: 1500, ammo: '9mm',
    moveMultiplier: 1, falloffStart: 0.5, falloffMin: 0.7, color: 0x9aa4ad,
    desc: 'Bắn từng phát, thay đạn nhanh. Dùng đạn 9mm.',
  },
  rifle: {
    id: 'rifle', name: 'Súng trường', slot: 'primary', damage: 28, fireRate: 9.5, auto: true, pellets: 1,
    magSize: 30, reloadMs: 2400, range: 950, spread: 3, moveSpread: 5, bulletSpeed: 1900, ammo: '556',
    moveMultiplier: 0.95, falloffStart: 0.6, falloffMin: 0.8, color: 0x6b8e4e,
    desc: 'Bắn liên thanh, mạnh ở tầm trung. Dùng đạn 5.56mm.',
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', slot: 'primary', damage: 14, fireRate: 1.2, auto: false, pellets: 9,
    magSize: 5, reloadMs: 2800, range: 380, spread: 14, moveSpread: 4, bulletSpeed: 1300, ammo: '12g',
    moveMultiplier: 0.95, falloffStart: 0.3, falloffMin: 0.4, color: 0xa0522d,
    desc: 'Bắn 9 viên chì một lúc, cực mạnh ở tầm gần. Dùng đạn 12 Gauge.',
  },
  sniper: {
    id: 'sniper', name: 'Súng bắn tỉa', slot: 'primary', damage: 140, fireRate: 0.75, auto: false, pellets: 1,
    magSize: 5, reloadMs: 3200, range: 1900, spread: 0.3, moveSpread: 6, bulletSpeed: 3200, ammo: '762',
    moveMultiplier: 0.9, falloffStart: 1, falloffMin: 1, color: 0x3b4b5c,
    desc: 'Sát thương cực lớn, tầm rất xa. Nên đứng yên khi bắn. Dùng đạn 7.62mm.',
  },
};

export const AMMO_NAMES: Record<AmmoType, string> = {
  '9mm': 'Đạn 9mm',
  '556': 'Đạn 5.56mm',
  '12g': 'Đạn 12 Gauge',
  '762': 'Đạn 7.62mm',
};

export const AMMO_TYPES: AmmoType[] = ['9mm', '556', '12g', '762'];

export const AMMO_PICKUP_AMOUNT: Record<AmmoType, number> = {
  '9mm': 30,
  '556': 30,
  '12g': 10,
  '762': 10,
};

export type ArmorLevel = 0 | 1 | 2 | 3;
export type BagLevel = 0 | 1 | 2 | 3;

export const ARMOR: Record<1 | 2 | 3, { reduction: number; durability: number }> = {
  1: { reduction: 0.25, durability: 60 },
  2: { reduction: 0.4, durability: 90 },
  3: { reduction: 0.55, durability: 130 },
};

export interface Capacity {
  ammo: Record<AmmoType, number>;
  medkit: number;
  grenade: number;
  smoke: number;
}

export const BAG_CAPACITY: Record<BagLevel, Capacity> = {
  0: { ammo: { '9mm': 60, '556': 90, '12g': 20, '762': 15 }, medkit: 2, grenade: 1, smoke: 1 },
  1: { ammo: { '9mm': 120, '556': 180, '12g': 40, '762': 30 }, medkit: 4, grenade: 2, smoke: 2 },
  2: { ammo: { '9mm': 180, '556': 240, '12g': 60, '762': 45 }, medkit: 6, grenade: 3, smoke: 3 },
  3: { ammo: { '9mm': 240, '556': 300, '12g': 80, '762': 60 }, medkit: 8, grenade: 4, smoke: 4 },
};

export const MEDKIT = { heal: 75, useMs: 3000 };

export const THROWABLE = {
  maxDistance: 450,
  flightMs: 600,
  grenade: { fuseMs: 2500, radius: 170, maxDamage: 130, minDamage: 25 },
  smoke: { fuseMs: 1200, radius: 210, durationMs: 15000, expandMs: 1200 },
};

export type ItemId =
  | GunId
  | 'knife'
  | 'ammo_9mm'
  | 'ammo_556'
  | 'ammo_12g'
  | 'ammo_762'
  | 'medkit'
  | 'grenade'
  | 'smoke'
  | 'armor1'
  | 'armor2'
  | 'armor3'
  | 'bag1'
  | 'bag2'
  | 'bag3'
  | 'scope2'
  | 'scope3'
  | 'scope4'
  | 'scope6'
  | 'scope8';

export type ItemKind = 'weapon' | 'ammo' | 'medkit' | 'grenade' | 'smoke' | 'armor' | 'bag' | 'scope';

export interface ItemDef {
  id: ItemId;
  kind: ItemKind;
  name: string;
  desc: string;
  color: number;
  icon: string;
  /** Where the item can be found, shown in the in-game item list. */
  source: string;
}

const W = WEAPONS;

export const ITEMS: Record<ItemId, ItemDef> = {
  pistol: { id: 'pistol', kind: 'weapon', name: W.pistol.name, desc: W.pistol.desc, color: W.pistol.color, icon: '🔫', source: 'Mặt đất' },
  rifle: { id: 'rifle', kind: 'weapon', name: W.rifle.name, desc: W.rifle.desc, color: W.rifle.color, icon: '🔫', source: 'Mặt đất, rương đồ' },
  shotgun: { id: 'shotgun', kind: 'weapon', name: W.shotgun.name, desc: W.shotgun.desc, color: W.shotgun.color, icon: '🔫', source: 'Mặt đất' },
  sniper: { id: 'sniper', kind: 'weapon', name: W.sniper.name, desc: W.sniper.desc, color: W.sniper.color, icon: '🎯', source: 'Thính (hiếm khi có trên mặt đất)' },
  knife: { id: 'knife', kind: 'weapon', name: W.knife.name, desc: W.knife.desc, color: W.knife.color, icon: '🔪', source: 'Mặt đất' },
  ammo_9mm: { id: 'ammo_9mm', kind: 'ammo', name: 'Băng đạn 9mm', desc: `+${AMMO_PICKUP_AMOUNT['9mm']} viên cho súng lục.`, color: 0xe0b84c, icon: '🟨', source: 'Mặt đất' },
  ammo_556: { id: 'ammo_556', kind: 'ammo', name: 'Băng đạn 5.56mm', desc: `+${AMMO_PICKUP_AMOUNT['556']} viên cho súng trường.`, color: 0x6fbf4a, icon: '🟩', source: 'Mặt đất' },
  ammo_12g: { id: 'ammo_12g', kind: 'ammo', name: 'Băng đạn 12 Gauge', desc: `+${AMMO_PICKUP_AMOUNT['12g']} viên cho shotgun.`, color: 0xd9534f, icon: '🟥', source: 'Mặt đất' },
  ammo_762: { id: 'ammo_762', kind: 'ammo', name: 'Băng đạn 7.62mm', desc: `+${AMMO_PICKUP_AMOUNT['762']} viên cho súng bắn tỉa.`, color: 0x4a90d9, icon: '🟦', source: 'Mặt đất, thính' },
  medkit: { id: 'medkit', kind: 'medkit', name: 'Túi cứu thương', desc: `Hồi ${MEDKIT.heal} máu trong ${MEDKIT.useMs / 1000} giây. Đi chậm khi đang dùng, bắn hoặc đổi súng sẽ hủy.`, color: 0xffffff, icon: '➕', source: 'Mặt đất, rương đồ, thính' },
  grenade: { id: 'grenade', kind: 'grenade', name: 'Lựu đạn', desc: `Nổ sau ${THROWABLE.grenade.fuseMs / 1000} giây, gây tối đa ${THROWABLE.grenade.maxDamage} sát thương trong bán kính ${THROWABLE.grenade.radius}.`, color: 0x556b2f, icon: '💣', source: 'Mặt đất, rương đồ' },
  smoke: { id: 'smoke', kind: 'smoke', name: 'Bom khói', desc: `Tạo màn khói bán kính ${THROWABLE.smoke.radius} trong ${THROWABLE.smoke.durationMs / 1000} giây. Người trong khói không bị nhìn thấy từ bên ngoài, kể cả bot.`, color: 0xbfbfbf, icon: '💨', source: 'Mặt đất' },
  armor1: { id: 'armor1', kind: 'armor', name: 'Giáp cấp 1', desc: `Giảm ${ARMOR[1].reduction * 100}% sát thương, độ bền ${ARMOR[1].durability}.`, color: 0x8fa3b0, icon: '🦺', source: 'Mặt đất' },
  armor2: { id: 'armor2', kind: 'armor', name: 'Giáp cấp 2', desc: `Giảm ${ARMOR[2].reduction * 100}% sát thương, độ bền ${ARMOR[2].durability}.`, color: 0x4a7fb5, icon: '🦺', source: 'Mặt đất' },
  armor3: { id: 'armor3', kind: 'armor', name: 'Giáp cấp 3', desc: `Giảm ${ARMOR[3].reduction * 100}% sát thương, độ bền ${ARMOR[3].durability}.`, color: 0x2b2b2b, icon: '🦺', source: 'Rương đồ, thính' },
  bag1: { id: 'bag1', kind: 'bag', name: 'Túi đồ cấp 1', desc: 'Tăng gấp đôi sức chứa đạn và vật phẩm so với không có túi.', color: 0x8b6b3d, icon: '🎒', source: 'Mặt đất' },
  bag2: { id: 'bag2', kind: 'bag', name: 'Túi đồ cấp 2', desc: 'Sức chứa gấp 3 lần so với không có túi.', color: 0x5d7a3a, icon: '🎒', source: 'Mặt đất' },
  bag3: { id: 'bag3', kind: 'bag', name: 'Túi đồ cấp 3', desc: 'Sức chứa tối đa.', color: 0x2f3e46, icon: '🎒', source: 'Mặt đất (hiếm)' },
  scope2: { id: 'scope2', kind: 'scope', name: 'Ống nhắm x2', desc: 'Mở rộng tầm nhìn thêm 15%.', color: 0x333333, icon: '🔭', source: 'Mặt đất' },
  scope3: { id: 'scope3', kind: 'scope', name: 'Ống nhắm x3', desc: 'Mở rộng tầm nhìn thêm 30%.', color: 0x333333, icon: '🔭', source: 'Mặt đất' },
  scope4: { id: 'scope4', kind: 'scope', name: 'Ống nhắm x4', desc: 'Mở rộng tầm nhìn thêm 45%.', color: 0x333333, icon: '🔭', source: 'Mặt đất (hiếm), rương đồ' },
  scope6: { id: 'scope6', kind: 'scope', name: 'Ống nhắm x6', desc: 'Mở rộng tầm nhìn thêm 70%.', color: 0x333333, icon: '🔭', source: 'Thính' },
  scope8: { id: 'scope8', kind: 'scope', name: 'Ống nhắm x8', desc: 'Mở rộng tầm nhìn gấp đôi.', color: 0x333333, icon: '🔭', source: 'Thính' },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export const GROUND_LOOT_TABLE: readonly (readonly [ItemId, number])[] = [
  ['pistol', 8], ['rifle', 7], ['shotgun', 6], ['sniper', 0.6], ['knife', 4],
  ['ammo_9mm', 10], ['ammo_556', 10], ['ammo_12g', 7], ['ammo_762', 2],
  ['medkit', 10], ['grenade', 5], ['smoke', 5],
  ['armor1', 6], ['armor2', 3],
  ['bag1', 6], ['bag2', 3], ['bag3', 1],
  ['scope2', 4], ['scope3', 3], ['scope4', 1],
];

export const CHEST_LOOT_TABLE: readonly (readonly [ItemId, number])[] = [
  ['grenade', 3], ['armor3', 1], ['scope4', 2], ['medkit', 3], ['rifle', 2],
];

export function ammoItemFor(ammo: AmmoType): ItemId {
  return `ammo_${ammo}` as ItemId;
}

export function scopeOfItem(id: ItemId): number {
  return Number(id.replace('scope', ''));
}

export function weaponName(id: string): string {
  if (id in WEAPONS) return WEAPONS[id as WeaponId].name;
  if (id === 'grenade') return 'Lựu đạn';
  if (id === 'zone') return 'Vòng bo';
  if (id === 'leave') return 'Rời trận';
  return id;
}
