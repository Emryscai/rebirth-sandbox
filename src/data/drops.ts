import type { PlantType } from './plants';
import type { ItemId } from './items';

/**
 * 植物专属道具掉落表。
 *
 * 宗门剑士：1/3 链锯
 * 石墙：25% 弹球 + 25% 回力镖
 * 其他植物：20% 铁板 + 20% 靴子
 *
 * 每个条目独立判定，因此石墙/普通植物有机会同时掉两件。
 */
export const PLANT_DROP_RULES: Readonly<
  Record<PlantType, ReadonlyArray<{ id: ItemId; chance: number }>>
> = {
  swordsman: [{ id: 'chainsaw', chance: 1 / 3 }],
  wall: [
    { id: 'bouncing-orb', chance: 0.25 },
    { id: 'boomerang', chance: 0.25 }
  ],
  shooter: [
    { id: 'iron-plate', chance: 0.2 },
    { id: 'boots', chance: 0.2 }
  ],
  ice: [
    { id: 'iron-plate', chance: 0.2 },
    { id: 'boots', chance: 0.2 }
  ],
  slow: [
    { id: 'iron-plate', chance: 0.2 },
    { id: 'boots', chance: 0.2 }
  ]
};

/** 按植物类型和随机源判定本次掉落 */
export function rollPlantDrops(
  type: PlantType,
  rng: () => number = Math.random
): ItemId[] {
  const out: ItemId[] = [];
  for (const rule of PLANT_DROP_RULES[type] ?? []) {
    if (rng() < rule.chance) out.push(rule.id);
  }
  return out;
}
