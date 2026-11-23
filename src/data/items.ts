/**
 * 道具数据表（纯数据，无 Phaser 依赖）。
 *
 * 五件可拾取/可购买道具（均在「攻击植物后掉落、拾取后生效」）：
 *   - 铁板   ：一次性护盾 +125，并挂在变异体左手当盾牌。
 *   - 靴子   ：60 秒内移动速度 +25，左右脚各穿一只。
 *   - 锯子   ：60 秒内自动对附近植物造成锯伤，并挂在变异体右手。
 *   - 弹球   ：60 秒内每隔 1.5s 甩手投出一颗弹跳球。
 *   - 回力镖 ：60 秒内每隔 1.6s 甩手掷出回旋镖（去/回各结算一次）。
 *
 * 弹球与回力镖**不是**常驻普攻：必须拾取到对应道具后才会发射。
 *
 * 掉落、拾取、存档都不在这里，这里只描述「是什么」，
 * 具体的生效逻辑在 ItemSystem / GameScene 里分派。
 */

import { ASSET_KEYS, ITEM } from '../config';

export type ItemId = 'iron-plate' | 'boots' | 'chainsaw' | 'bouncing-orb' | 'boomerang';

/** 道具是否为「有持续时间」型（false = 一次性，如铁板） */
export interface ItemDef {
  id: ItemId;
  name: string;
  /** 图标纹理键（掉落/商店/手持用） */
  textureKey: string;
  /** 简短描述（商店） */
  desc: string;
  /** 风味文本（显示在游戏正上方的一行小字） */
  flavor: string;
  /** 持续时长（毫秒）；0 表示一次性道具（如铁板） */
  durationMs: number;
  /** 商店售价 */
  price: number;
  /** 主题色 */
  accent: number;
}

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  'iron-plate': {
    id: 'iron-plate',
    name: '铁板',
    textureKey: ASSET_KEYS.itemIronPlate,
    desc: '获得 125 点护盾生命值（优先扣除护盾）',
    flavor: '变异体的肉身是脆弱的，但人类留下的工业废铁不是。把它绑在胸口，你就是一辆人形坦克。',
    durationMs: 0,
    price: 6,
    accent: 0x9aa7b4
  },
  boots: {
    id: 'boots',
    name: '疾风残靴',
    textureKey: ASSET_KEYS.itemBoots,
    desc: '60 秒内移动速度 +25',
    flavor: '只要跑得比队友快，植物的弹丸就打不到我。',
    durationMs: ITEM.durationMs,
    price: 7,
    accent: 0xc9873f
  },
  chainsaw: {
    id: 'chainsaw',
    name: '合金切割器',
    textureKey: ASSET_KEYS.itemChainsaw,
    desc: '60 秒内自动攻击附近植物',
    flavor: '别用牙齿啃了，那太文明了。让切割刃来告诉你什么叫效率。',
    durationMs: ITEM.durationMs,
    price: 9,
    accent: 0xd94b4b
  },
  'bouncing-orb': {
    id: 'bouncing-orb',
    name: '弹射异球',
    textureKey: ASSET_KEYS.itemBouncingOrb,
    desc: '60 秒内每 1.5 秒甩手投出一颗弹跳球，碰到植物/墙壁反弹',
    flavor: '就像在打一场致命的台球，而满地的植物就是你的球袋。',
    durationMs: ITEM.durationMs,
    price: 9,
    accent: 0x9b6bf2
  },
  boomerang: {
    id: 'boomerang',
    name: '回旋骨镖',
    textureKey: ASSET_KEYS.itemBoomerang,
    desc: '60 秒内每 1.6 秒甩手掷出回旋镖，穿透植物、去回各造成一次伤害',
    flavor: '扔出去，不管有没有打中，它总会带着植物的残渣回到你手里。',
    durationMs: ITEM.durationMs,
    price: 9,
    accent: 0xe0c07a
  }
};

/** 全部道具 id（用于掉落时随机抽取） */
export const ALL_ITEM_IDS: ReadonlyArray<ItemId> = [
  'iron-plate',
  'boots',
  'chainsaw',
  'bouncing-orb',
  'boomerang'
];

/**
 * **仅石墙**使用的掉落权重。
 *
 * 普通植物仍按旧版：铁板 1/3、靴子 1/3、切割器/弹球/回力镖各 1/9。
 * 石墙：切割器、回力镖各 +20%（相对值，1/9 → 约 13.33%），
 * 弹球相应略降，铁板/靴子仍各约 32%。
 */


export function getItem(id: ItemId): ItemDef {
  return ITEMS[id];
}
