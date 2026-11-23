/**
 * 商店商品数据表。
 *
 * 设计目标：
 *   - **纯数据**：这里只描述「买什么、多少钱、效果是什么」，
 *     不包含任何 Phaser / 场景依赖，方便单元测试与后续扩展。
 *   - **效果用枚举描述**，真正的施加逻辑放在 GameScene.applyShopEffect，
 *     通过 shopItem 的 effect 字段分派。
 *   - **可消耗 vs 一次性**：repeatable = false 的商品（如永久提升）
 *     买过就置灰；repeatable = true 的商品（如回复生命值、一次性护盾）可反复购买。
 *
 * 新增商品只需要往 SHOP_ITEMS 里加一条，并在 GameScene 里实现对应效果的 case。
 */

/** 商品效果类型（GameScene 据此施加具体增益） */
export type ShopEffect =
  /** 立即回复生命值（amount） */
  | 'heal'
  /** 提升最大生命值并存满（amount） */
  | 'max-hp'
  /** 临时护盾：吸收接下来 amount 点伤害，持续 durationMs */
  | 'shield'
  /** 关闭商店后无敌 amount 毫秒 */
  | 'invincible'
  /** 永久提速（speedBonus 像素/秒） */
  | 'speed'
  /** 进化点 +amount */
  | 'evolution'
  /** 满级后：永久提升生命值（每次 +25%） */
  | 'growth-hp'
  /** 满级后：永久提升攻击力（每次 +25%） */
  | 'growth-atk'
  /** 满级后：永久提升移动速度（每次 +25%） */
  | 'growth-speed'
  /** 道具页：购买并立即激活一个道具（`item:<ItemId>`） */
  | `item:${string}`;

export interface ShopItem {
  /** 唯一 id */
  id: string;
  /** 显示名 */
  name: string;
  /** 简短描述（显示在卡片上） */
  desc: string;
  /** 价格（金币） */
  price: number;
  /** 效果类型 */
  effect: ShopEffect;
  /** 效果数值（含义随 effect 变化） */
  amount: number;
  /** 效果持续时长（毫秒，仅部分 effect 使用） */
  durationMs?: number;
  /** 是否可重复购买 */
  repeatable: boolean;
  /** 未达到解锁条件时置灰且不可购买（超级商店） */
  locked?: boolean;
  /** 主题色（卡片描边 / 价格文字），便于一眼区分品类 */
  accent: number;
}

/**
 * 商品列表（顺序即展示顺序）。
 *
 * 这是「模板」，具体数值后续按手感平衡调整。
 */
export const SHOP_ITEMS: ReadonlyArray<ShopItem> = [
  {
    id: 'heal-small',
    name: '快速回复',
    desc: '立即恢复 25 点生命值',
    price: 1,
    effect: 'heal',
    amount: 25,
    repeatable: true,
    accent: 0x4ade80
  },
  {
    id: 'heal-full',
    name: '大快朵颐',
    desc: '生命值回满',
    price: 2,
    effect: 'heal',
    amount: 9999,
    repeatable: true,
    accent: 0x22c55e
  },
  {
    id: 'max-hp',
    name: '强壮体魄',
    desc: '最大生命值 +25（并回满）',
    price: 3,
    effect: 'max-hp',
    amount: 25,
    repeatable: true,
    accent: 0x38bdf8
  },
  {
    id: 'shield',
    name: '铁皮护盾',
    desc: '持续 8 秒，免疫下一次伤害',
    price: 2,
    effect: 'shield',
    amount: 1,
    durationMs: 8000,
    repeatable: true,
    accent: 0x7fe3ff
  },
  {
    id: 'invincible',
    name: '星辉庇护',
    desc: '关闭商店后 5 秒内免疫伤害，头顶显示倒计时',
    price: 15,
    effect: 'invincible',
    amount: 5000,
    repeatable: true,
    accent: 0xffd54a
  },
  {
    id: 'speed',
    name: '疾行',
    desc: '移动速度永久 +6',
    price: 4,
    effect: 'speed',
    amount: 6,
    repeatable: true,
    accent: 0xfbbf24
  },
  {
    id: 'evolution',
    name: '进化结晶',
    desc: '进化点 +5',
    price: 3,
    effect: 'evolution',
    amount: 5,
    repeatable: true,
    accent: 0xc084fc
  }
] as const;

// ------------------------------------------------------------ 满级后的永久成长

/** 满级成长商品的基础价格（金币） */
export const GROWTH_BASE_PRICE = 20;
/** 每购买一次同一项，价格增加多少金币 */
export const GROWTH_PRICE_STEP = 5;
/** 每次购买提升的属性比例（+25%） */
export const GROWTH_PER_LEVEL = 0.25;

/** 满级成长项的种类定义（与已购买等级配合生成实际商品） */
interface GrowthDef {
  id: string;
  name: string;
  desc: string;
  effect: ShopEffect;
  accent: number;
}

const GROWTH_DEFS: ReadonlyArray<GrowthDef> = [
  {
    id: 'growth-hp',
    name: '不灭体魄',
    desc: '永久提升生命值 +25%',
    effect: 'growth-hp',
    accent: 0xf87171
  },
  {
    id: 'growth-atk',
    name: '锋利之牙',
    desc: '永久提升攻击力 +25%',
    effect: 'growth-atk',
    accent: 0xfb923c
  },
  {
    id: 'growth-speed',
    name: '疾风之躯',
    desc: '永久提升移动速度 +25%',
    effect: 'growth-speed',
    accent: 0xfacc15
  }
];

/**
 * 生成满级商店的商品列表。
 *
 * 价格随「该项已购次数」递增：price = BASE + STEP × level。
 * 每次购买都会让 GameScene 重新调用本函数，以刷新界面上的价格。
 *
 * @param levels 各项已购等级（key = 商品 id，如 'growth-hp'）
 */
export function buildGrowthItems(
  levels: Readonly<Record<string, number>>,
  locked = false
): ShopItem[] {
  return GROWTH_DEFS.map((def) => {
    const lv = Math.max(0, Math.floor(levels[def.id] ?? 0));
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      price: GROWTH_BASE_PRICE + GROWTH_PRICE_STEP * lv,
      effect: def.effect,
      amount: lv, // 表示购买前等级，供 UI/调试参考
      repeatable: true,
      accent: def.accent,
      locked
    };
  });
}
