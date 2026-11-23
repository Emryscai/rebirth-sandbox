/**
 * 植物数据表。
 * 第一版只有三种：射手 / 墙 / 减速。
 */

export type PlantType = 'shooter' | 'ice' | 'wall' | 'slow' | 'swordsman';

export interface PlantConfig {
  type: PlantType;
  /** 显示名 */
  name: string;
  /** 素材键名 */
  textureKey: string;
  /** 生命值 */
  hp: number;
  /** 缩放 */
  scale: number;
  /** 发射间隔（毫秒），<=0 表示不攻击 */
  fireInterval: number;
  /** 弹丸伤害 */
  bulletDamage: number;
  /** 减速半径（像素），0 表示无减速 */
  slowRadius: number;
  /** 减速比例（0.35 表示降到 65% 速度） */
  slowFactor: number;
  /** 是否阻挡弹丸 */
  blocksBullet: boolean;
  /** 刷出权重 */
  weight: number;

  /**
   * 弹丸命中后的减速比例（0 表示不减速）。
   * 仅对会开火的植物（fireInterval > 0）有意义。
   * 0.5 表示命中后僵尸速度降到 50%。
   */
    bulletSlowFactor: number;
  /** 弹丸减速持续时间（毫秒） */
  bulletSlowDuration: number;

  /**
   * 解锁时间（毫秒）。到达游戏该时刻后才允许生成。
   * 不填（undefined）= 开局即可生成。
   * 目前只有宗门术士用到（测试期临时设为 30 秒）。
   */
  unlockAtMs?: number;

  /**
   * 渲染用的垂直微调（像素，正值下移）。
   *
   * 仅仅影响「视觉位置」，不影响占格与碰撞（碰撞仍按格心）。
   * 用于个别人工素材底部留白较多、看起来「浮在格子上方」的情况，
   * 比如石墙底座偏高，需要整体往下压一点点才像踩在地上。
   */
  yOffsetPx?: number;
}

/**
 * 植物基础生命值。
 *
 * 所有植物类型默认使用这个值。
 * 单独的类型需要更耐打/更脆时，在它的配置里写 hp: PLANT_BASE_HP * 2 之类即可，
 * 不用改这里的基数。
 */
export const PLANT_BASE_HP = 100;

/**
 * 僵尸啃食：每 BITE_INTERVAL 毫秒造成 BITE_DAMAGE 点伤害。
 *
 * 100 血 ÷ 25 伤害 = 4 口，即 2 秒啃掉一株。
 * 这两个值和 PLANT_BASE_HP 相互独立，调其中一个不影响另外两个。
 */
export const PLANT_BITE_DAMAGE = 25;
export const PLANT_BITE_INTERVAL = 500;
/** 植物死亡掉落的尸币数：普通 2、石墙 5、宗门术士 10 */
export const PLANT_COIN_REWARDS: Readonly<Record<PlantType, number>> = {
  shooter: 2,
  ice: 2,
  slow: 2,
  wall: 5,
  swordsman: 10
};
export const PLANT_TYPES: Record<PlantType, PlantConfig> = {
  shooter: {
    type: 'shooter',
    name: '喷口藤',
    textureKey: 'plant-shooter',
    hp: PLANT_BASE_HP,
    scale: 1,
    fireInterval: 2000,
    bulletDamage: 8,
    slowRadius: 0,
    slowFactor: 0,
    blocksBullet: false,
    weight: 5,
    bulletSlowFactor: 0,
    bulletSlowDuration: 0
  },
  /**
   * 寒冰射手：会开火，豌豆命中后使僵尸减速。
   *
   * 对齐 PvZ 的寒冰射手：
   *   - 射速比普通豌豆射手略慢（原版约 1.5 秒 vs 1.4 秒）
   *   - 伤害减半（原版 20 vs 40）
   *   - 命中后减速，持续 10 秒
   *
   * 这里按本作数值等比换算：发射间隔 2200ms、伤害 4、减速 50%、持续 10000ms。
   */
  ice: {
    type: 'ice',
    name: '寒霜藤',
    textureKey: 'plant-ice',
    hp: PLANT_BASE_HP,
    scale: 1,
    fireInterval: 2200,
    bulletDamage: 4,
    slowRadius: 0,
    slowFactor: 0,
    blocksBullet: false,
    weight: 3,
    bulletSlowFactor: 0.5,
    bulletSlowDuration: 10000
  },
    wall: {
    type: 'wall',
    name: '硬壳垒',
    textureKey: 'plant-wall',
    /**
     * 生命值 450 —— 4.5 倍基础生命值。
     * 按每口 25 点算，需 18 口（约 9 秒）才能啃穿，
     * 用来当「缓冲墙」拖延僵尸节奏。
     */
    hp: 450,
    scale: 1,
    fireInterval: 0,
    bulletDamage: 0,
    slowRadius: 0,
    slowFactor: 0,
    blocksBullet: true,
    weight: 3,
    /** 石墙底座偏高，整体下压一点点，视觉上才像踩在格子里 */
    yOffsetPx: 6,
    bulletSlowFactor: 0,
    bulletSlowDuration: 0
  },
  slow: {
    type: 'slow',
    name: '冷雾苔',
    textureKey: 'plant-slow',
    hp: PLANT_BASE_HP,
    scale: 1,
    fireInterval: 0,
    bulletDamage: 0,
    slowRadius: 96,
    slowFactor: 0.4,
        blocksBullet: false,
    weight: 2,
    bulletSlowFactor: 0,
    bulletSlowDuration: 0
  },
  /**
   * 宗门术士：全屏追踪型。
   *
   * 与三种射手的根本区别：
   *   - 不做十字判定，只要场上任何位置有僵尸就锁定
   *   - 不发射豌豆，而是掷出一把会转弯追踪的剑
   *   - 单发 50 伤害（豌豆的 6 倍多），但 1 秒才能出手一次
   *
   * 因为强度远超其它植物，正式版应设 2 分钟解锁 ——
   * 前期靠它会让走位失去意义。（当前为测试临时设为 30 秒）
   */
  swordsman: {
    type: 'swordsman',
    name: '宗门术士',
    // 注意：必须用「真实会被加载」的纹理键。早先这里是 'plant-swordsman'，
    // 但 BootScene 从不加载该键，Plant 基类 super(...) 会拿到不存在的纹理
    // （缺失贴图 / 原图一闪，控制台可能报错）。SwordsmanPlant 随后虽会
    // setTexture(swordsmanBody) 覆盖，但为杜绝「错误贴图闪一帧」，直接指向真实身体贴图。
    textureKey: 'swordsman-body',
    hp: PLANT_BASE_HP,
    scale: 1,
    fireInterval: 1000,
    bulletDamage: 50,
    slowRadius: 0,
    slowFactor: 0,
    blocksBullet: false,
    /**
     * 权重给到 6：一旦解锁就希望玩家能比较频繁地见到它。
     * 基础射手权重 5，术士略高一点。
     */
    weight: 6,
    bulletSlowFactor: 0,
    bulletSlowDuration: 0,
    /** 测试用：30 秒解锁（游戏时间 ≥ 30000ms 后进入生成池） */
    unlockAtMs: 30 * 1000
  }
};

/**
 * 「可被生成/抽取」的植物类型清单。
 *
 * 注意：这里**不含** slow（冷雾苔）—— 它保留在 PLANT_TYPES 里只是为了
 * 让 PlantType 类型定义完整、并兼容 PlantAI 里对 'slow' 的分支判断，
 * 但它已不再进入任何生成池，场上不会再出现紫色小苔藓。
 *
 * swordsman 在列表里，但它的 unlockAtMs（测试期 30 秒 / 正式 2 分钟）会让生成器在前期
 * 把它排除掉 —— 这里只是「有资格出现」的候选集。
 */
export const PLANT_TYPE_LIST: ReadonlyArray<PlantType> = [
  'shooter',
  'ice',
  'wall',
  'swordsman'
];
