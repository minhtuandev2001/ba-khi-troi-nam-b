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
    id: 'fists', name: 'Tay không', slot: 'melee', damage: 18, fireRate: 2, auto: true, pellets: 1,
    magSize: 0, reloadMs: 0, range: 54, spread: 35, moveSpread: 0, bulletSpeed: 0, ammo: null,
    moveMultiplier: 1.05, falloffStart: 1, falloffMin: 1, color: 0xf2c79b,
    desc: 'Đấm trong tầm gần. Dùng được để phá rương đồ.',
  },
  knife: {
    id: 'knife', name: 'Dao', slot: 'melee', damage: 34, fireRate: 2, auto: true, pellets: 1,
    magSize: 0, reloadMs: 0, range: 66, spread: 35, moveSpread: 0, bulletSpeed: 0, ammo: null,
    moveMultiplier: 1.08, falloffStart: 1, falloffMin: 1, color: 0xc0c7d0,
    desc: 'Cận chiến mạnh gần gấp đôi tay không, chạy nhanh hơn một chút.',
  },
  pistol: {
    id: 'pistol', name: 'Ống thổi', slot: 'pistol', damage: 24, fireRate: 5, auto: false, pellets: 1,
    magSize: 15, reloadMs: 1600, range: 450, spread: 3, moveSpread: 3, bulletSpeed: 1500, ammo: '9mm',
    moveMultiplier: 1, falloffStart: 0.5, falloffMin: 0.7, color: 0xc9b26a,
    desc: 'Ống tre thổi từng mũi kim, nạp lại nhanh. Dùng kim tre.',
  },
  rifle: {
    id: 'rifle', name: 'Cung tên', slot: 'primary', damage: 28, fireRate: 9, auto: true, pellets: 1,
    magSize: 30, reloadMs: 2400, range: 600, spread: 3, moveSpread: 5, bulletSpeed: 1900, ammo: '556',
    moveMultiplier: 0.95, falloffStart: 0.6, falloffMin: 0.8, color: 0x8a5a2b,
    desc: 'Cung tre giương liên tục, bắn tên dồn dập, mạnh ở tầm trung. Dùng mũi tên.',
  },
  shotgun: {
    id: 'shotgun', name: 'Nỏ', slot: 'primary', damage: 14, fireRate: 1, auto: false, pellets: 9,
    magSize: 5, reloadMs: 2800, range: 380, spread: 14, moveSpread: 4, bulletSpeed: 1300, ammo: '12g',
    moveMultiplier: 0.95, falloffStart: 0.3, falloffMin: 0.4, color: 0x7a4a22,
    desc: 'Nỏ liên châu, mỗi lần lẫy bung ra chùm 9 mũi tên ngắn, cực mạnh ở tầm gần. Dùng tên nỏ.',
  },
  sniper: {
    id: 'sniper', name: 'Thần tiễn', slot: 'primary', damage: 140, fireRate: 1, auto: false, pellets: 1,
    magSize: 5, reloadMs: 3200, range: 1300, spread: 0.3, moveSpread: 6, bulletSpeed: 3200, ammo: '762',
    moveMultiplier: 0.9, falloffStart: 1, falloffMin: 1, color: 0xd4a02a,
    desc: 'Cây cung thần bọc đồng vàng, bắn tên móng Rùa Vàng bay cực xa, sát thương cực lớn. Nên đứng yên khi bắn.',
  },
};

/** Drawn length of each ranged weapon; it starts GUN_OFFSET in front of the player's centre and the shot leaves its tip. */
export const GUN_LENGTH: Partial<Record<WeaponId, number>> = { pistol: 32, rifle: 28, shotgun: 36, sniper: 36 };
export const GUN_OFFSET = 16;

/** Distance from the player's centre to the muzzle, or 0 for melee. */
export function muzzleDistance(w: WeaponId): number {
  const len = GUN_LENGTH[w];
  return len === undefined ? 0 : GUN_OFFSET + len;
}

export const AMMO_NAMES: Record<AmmoType, string> = {
  '9mm': 'Kim tre',
  '556': 'Mũi tên',
  '12g': 'Tên nỏ',
  '762': 'Tên móng rùa',
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
  pistol: { id: 'pistol', kind: 'weapon', name: W.pistol.name, desc: W.pistol.desc, color: W.pistol.color, icon: '🎋', source: 'Mặt đất' },
  rifle: { id: 'rifle', kind: 'weapon', name: W.rifle.name, desc: W.rifle.desc, color: W.rifle.color, icon: '🏹', source: 'Rương đồ' },
  shotgun: { id: 'shotgun', kind: 'weapon', name: W.shotgun.name, desc: W.shotgun.desc, color: W.shotgun.color, icon: '🏹', source: 'Mặt đất' },
  sniper: { id: 'sniper', kind: 'weapon', name: W.sniper.name, desc: W.sniper.desc, color: W.sniper.color, icon: '🏹', source: 'Thính' },
  knife: { id: 'knife', kind: 'weapon', name: W.knife.name, desc: W.knife.desc, color: W.knife.color, icon: '🔪', source: 'Mặt đất' },
  ammo_9mm: { id: 'ammo_9mm', kind: 'ammo', name: AMMO_NAMES['9mm'], desc: `Bó ${AMMO_PICKUP_AMOUNT['9mm']} mũi kim tre gắn bông gạo cho ống thổi.`, color: 0xe0c27a, icon: '🎋', source: 'Mặt đất' },
  ammo_556: { id: 'ammo_556', kind: 'ammo', name: AMMO_NAMES['556'], desc: `Ống ${AMMO_PICKUP_AMOUNT['556']} mũi tên đầu đồng, đuôi lông chim cho cung tên.`, color: 0x8a5a2b, icon: '🏹', source: 'Mặt đất' },
  ammo_12g: { id: 'ammo_12g', kind: 'ammo', name: AMMO_NAMES['12g'], desc: `Bó ${AMMO_PICKUP_AMOUNT['12g']} lượt tên nỏ ngắn, mỗi lượt lẫy bung cả chùm.`, color: 0xb5651d, icon: '🏹', source: 'Mặt đất' },
  ammo_762: { id: 'ammo_762', kind: 'ammo', name: AMMO_NAMES['762'], desc: `${AMMO_PICKUP_AMOUNT['762']} mũi tên mạ vàng gắn móng Rùa Vàng, chỉ Thần tiễn mới bắn được.`, color: 0xffc21a, icon: '🐢', source: 'Mặt đất, thính' },
  medkit: { id: 'medkit', kind: 'medkit', name: 'Thuốc nam', desc: `Đắp lá thuốc hồi ${MEDKIT.heal} máu trong ${MEDKIT.useMs / 1000} giây. Đi chậm khi đang đắp, bắn hoặc đổi vũ khí sẽ hủy.`, color: 0x5fae3a, icon: '🌿', source: 'Mặt đất, rương đồ, thính' },
  grenade: { id: 'grenade', kind: 'grenade', name: 'Hũ lửa', desc: `Hũ gốm đựng dầu, châm ngòi ngay khi cầm lên và nổ sau ${THROWABLE.grenade.fuseMs / 1000} giây (cầm quá lâu sẽ nổ trên tay, cất đi thì dập ngòi). Gây tối đa ${THROWABLE.grenade.maxDamage} sát thương trong bán kính ${THROWABLE.grenade.radius}.`, color: 0xb5562a, icon: '🔥', source: 'Rương đồ' },
  smoke: { id: 'smoke', kind: 'smoke', name: 'Bầu khói', desc: `Quả bầu khô nhồi ngải cứu ủ lửa, vỡ ra tạo màn khói bán kính ${THROWABLE.smoke.radius} trong ${THROWABLE.smoke.durationMs / 1000} giây. Người trong khói không bị nhìn thấy từ bên ngoài, kể cả bot.`, color: 0xbfbfbf, icon: '💨', source: 'Mặt đất' },
  armor1: { id: 'armor1', kind: 'armor', name: 'Giáp mây', desc: `Giáp cấp 1 đan bằng mây. Giảm ${ARMOR[1].reduction * 100}% sát thương, độ bền ${ARMOR[1].durability}.`, color: 0xc9a46a, icon: '🦺', source: 'Mặt đất' },
  armor2: { id: 'armor2', kind: 'armor', name: 'Giáp da', desc: `Giáp cấp 2 bằng da trâu thuộc. Giảm ${ARMOR[2].reduction * 100}% sát thương, độ bền ${ARMOR[2].durability}.`, color: 0x8a5a32, icon: '🦺', source: 'Rương đồ' },
  armor3: { id: 'armor3', kind: 'armor', name: 'Giáp đồng', desc: `Giáp cấp 3 ghép tấm đồng Đông Sơn. Giảm ${ARMOR[3].reduction * 100}% sát thương, độ bền ${ARMOR[3].durability}.`, color: 0xd4a02a, icon: '🦺', source: 'Thính' },
  bag1: { id: 'bag1', kind: 'bag', name: 'Gùi nhỏ', desc: 'Gùi cấp 1. Tăng gấp đôi sức chứa tên và vật phẩm so với đi tay không.', color: 0xc98a3d, icon: '🧺', source: 'Mặt đất' },
  bag2: { id: 'bag2', kind: 'bag', name: 'Gùi lớn', desc: 'Gùi cấp 2. Sức chứa gấp 3 lần so với đi tay không.', color: 0x8a5a2b, icon: '🧺', source: 'Rương đồ' },
  bag3: { id: 'bag3', kind: 'bag', name: 'Gùi hoa văn', desc: 'Gùi cấp 3 đan hoa văn Đông Sơn. Sức chứa tối đa.', color: 0x6b2f1a, icon: '🧺', source: 'Mặt đất (hiếm)' },
  scope2: { id: 'scope2', kind: 'scope', name: 'Chim sẻ', desc: 'Thuần phục chim sẻ trinh sát, mở rộng tầm nhìn thêm 15% (x2).', color: 0x9a6a3a, icon: '🐦', source: 'Mặt đất' },
  scope3: { id: 'scope3', kind: 'scope', name: 'Chim sáo', desc: 'Thuần phục chim sáo trinh sát, mở rộng tầm nhìn thêm 30% (x3).', color: 0x2b2b2b, icon: '🐦', source: 'Mặt đất' },
  scope4: { id: 'scope4', kind: 'scope', name: 'Chim cắt', desc: 'Thuần phục chim cắt trinh sát, mở rộng tầm nhìn thêm 45% (x4).', color: 0x5a6b7a, icon: '🦅', source: 'Rương đồ' },
  scope6: { id: 'scope6', kind: 'scope', name: 'Đại bàng', desc: 'Thuần phục đại bàng trinh sát, mở rộng tầm nhìn thêm 70% (x6).', color: 0x5a3a1a, icon: '🦅', source: 'Thính' },
  scope8: { id: 'scope8', kind: 'scope', name: 'Chim Lạc', desc: 'Thuần phục chim Lạc thần trinh sát, tầm nhìn rộng gấp đôi (x8).', color: 0xf2e6cc, icon: '🕊️', source: 'Thính' },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

// rare items (rifle, armor2, bag2, scope4) only come from chests; legendary ones (sniper, armor3, scope8) only from airdrops
export const GROUND_LOOT_TABLE: readonly (readonly [ItemId, number])[] = [
  ['pistol', 8], ['shotgun', 6], ['knife', 4],
  ['ammo_9mm', 10], ['ammo_556', 10], ['ammo_12g', 7], ['ammo_762', 2],
  ['medkit', 10], ['grenade', 5], ['smoke', 5],
  ['armor1', 6],
  ['bag1', 6], ['bag3', 1],
  ['scope2', 4], ['scope3', 3],
];

export const CHEST_LOOT_TABLE: readonly (readonly [ItemId, number])[] = [
  ['rifle', 3], ['armor2', 3], ['bag2', 2], ['scope4', 2], ['grenade', 3], ['medkit', 3],
];

export function ammoItemFor(ammo: AmmoType): ItemId {
  return `ammo_${ammo}` as ItemId;
}

export function scopeOfItem(id: ItemId): number {
  return Number(id.replace('scope', ''));
}

/** Name of the scout bird behind a scope level; level 1 is the naked eye. */
export function scopeName(level: number): string {
  return ITEMS[`scope${level}` as ItemId]?.name ?? 'Mắt thường';
}

export function weaponName(id: string): string {
  if (id in WEAPONS) return WEAPONS[id as WeaponId].name;
  if (id === 'grenade') return ITEMS.grenade.name;
  if (id === 'zone') return 'Vòng bo';
  if (id === 'leave') return 'Rời trận';
  if (id === 'kick') return 'Bị admin kích';
  return id;
}
