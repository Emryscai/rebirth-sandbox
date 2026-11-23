/**
 * PlantAI —— 战术型植物种植「电脑」。
 *
 * 原有的 PlantSpawner 是「随机挑一个空格 + 加权随机挑类型」，
 * 布阵毫无章法：火力既挡不住僵尸，也从不针对玩家当前位置。
 * 本模块把「种什么、种在哪」交给一台会思考的电脑：
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ 目标：尽最大可能把玩家（僵尸）弄死。                        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 具体战术（按优先级叠加，全部体现在「格 × 类型」的评分里）：
 *
 *   1. 十字火力点 —— 植物是十字判定（整行 + 整列都会开火）。
 *      玩家所在的行与列，是天然的火力走廊。把射手/冰射放上去，
 *      玩家一踏入这条线就会挨打，且没处可躲。
 *
 *   2. 卡位封路  —— 玩家是「逐格冲刺」。在玩家身边的方向上留墙，
 *      能逼它绕路、把它逼进火线；墙还会吃掉射向它的豌豆（不划算），
 *      所以墙只放在「玩家想跑的方向」而不挡自家火力线。
 *
 *   3. 减速泥潭  —— 冷雾苔在范围内减速。铺在玩家四周，
 *      让玩家逃不动、被火线多打几轮。这是「更容易杀死」的关键一环。
 *
 *   4. 预判下一格 —— 记住玩家上一帧的格子，推断它正在往哪个方向移动，
 *      把高威胁植物（冰射 / 剑士）放到它「下一秒会到」的格附近。
 *
 *   5. 剑士点杀  —— 解锁后剑士全屏追踪、单发 50 伤。
 *      数量稀少时，优先放在离玩家最近的空格。
 *
 *   6. 类型配比  —— 不做成「全是同一种」。缺什么补什么，
 *      保持 射手:冰射:墙:苔 的健康比例，让局面既有火力又有控制。
 *
 * 设计上「纯函数式」：decide() 只读 context，返回一个决策，
 * 不碰 Phaser 对象、不产生副作用。真正的落子仍由 PlantSpawner 执行，
 * 这样占格回滚、异常兜底都沿用既有逻辑，风险最小。
 */

import type { GridSystem } from './GridSystem';
import { PLANT_TYPES, type PlantType } from '../data/plants';
import { PLANT } from '../config';

/** 玩家供 AI 决策所需的只读快照 */
export interface AIPlayerSnapshot {
  /** 当前格 */
  col: number;
  row: number;
  /** 上一帧所在格（用于推断移动方向；没有则等于当前格） */
  prevCol: number;
  prevRow: number;
  /** 世界像素坐标 */
  x: number;
  y: number;
  /** 是否死亡（死亡后 AI 不再行动） */
  isDead: boolean;
}

/** 场上已有植物（只读，用于配比与占格判断） */
export interface AIPlantSnapshot {
  col: number;
  row: number;
  type: PlantType;
}

/** 决策上下文 */
export interface AIContext {
  grid: GridSystem;
  player: AIPlayerSnapshot;
  plants: ReadonlyArray<AIPlantSnapshot>;
  /** 本局已运行毫秒，用于解锁判定 */
  elapsedMs: number;
  /** 注入随机源，便于测试；返回 [0,1) */
  rng?: () => number;
}

/** AI 的落子决策 */
export interface AIDecision {
  col: number;
  row: number;
  type: PlantType;
}

// ---- 调参区（集中在这里，方便平衡性微调）----

/**
 * AI 允许在离玩家多近的地方落子。
 *
 * 原随机生成器是 150px（约 2.3 格），目的是「别贴脸秒刷」。
 * AI 要更凶，缩到 96px（1.5 格）：允许贴着玩家布减速苔与近战火线，
 * 但不至于 0 距离直接糊脸（那样太假、也违反网格可走性）。
 */
const AI_MIN_DIST_TO_PLAYER = 96;

/**
 * 理想类型配比（权重）。
 * AI 会按「场上现状 vs 该配比」的缺口，优先补最缺的类型。
 *
 * 注意：冷雾苔（slow）已从生成池移除 —— 它是早期占位版植物，
 * 视觉单薄、玩法冗余，不再让 AI 种它。这里只保留四种正式植物，
 * 原本 slow 的 20% 份额分给射手与冰射（火力更实在）。
 */
const TYPE_TARGET: Array<{ type: PlantType; share: number }> = [
  { type: 'shooter', share: 0.5 },
  { type: 'ice', share: 0.3 },
  { type: 'wall', share: 0.12 },
  { type: 'swordsman', share: 0.08 }
];

/**
 * 宗门剑士的基础份额（未随时间提升前）。
 */
const BASE_SWORDSMAN_SHARE = 0.08;

/**
 * 按游戏时间给出「剑士目标份额」。
 *
 * 设计（用户需求）：
 *   - 2 分钟：剑士占比提升到 0.28（+20 个百分点）
 *   - 5 分钟：提升到 0.58（+50 个百分点）
 *   - 8 分钟及以后：提升到 0.90（场上基本都是剑士）
 *   - 2 分钟之前：维持基础 0.08
 *
 * 这里用「绝对份额」而不是乘系数，是因为需求要的是「8 分钟后几乎全是剑士」，
 * 用乘系数（0.08 × 1.5）永远到不了那个量级。
 *
 * 返回的是剑士在类型配比中占的目标比例（0..0.9），
 * 剩余份额会按原有相对权重分摊给其它类型（见 pickMostNeededType）。
 */
export function swordsmanShareAt(elapsedMs: number): number {
  const MIN = 60 * 1000;
  if (elapsedMs < 2 * MIN) return BASE_SWORDSMAN_SHARE;
  if (elapsedMs < 5 * MIN) return 0.28;
  if (elapsedMs < 8 * MIN) return 0.58;
  return 0.90;
}

/** 单个类型在「非解锁期」是否可用 */
function isUnlocked(type: PlantType, elapsedMs: number): boolean {
  const cfg = PLANT_TYPES[type];
  if (!cfg) return false;
  if (cfg.unlockAtMs === undefined) return true;
  return elapsedMs >= cfg.unlockAtMs;
}

/** 曼哈顿格距 */
function cellDist(ac: number, ar: number, bc: number, br: number): number {
  return Math.abs(ac - bc) + Math.abs(ar - br);
}

/** 统计场上各类型数量 */
function tallyTypes(plants: ReadonlyArray<AIPlantSnapshot>): Map<PlantType, number> {
  const m = new Map<PlantType, number>();
  for (const p of plants) m.set(p.type, (m.get(p.type) ?? 0) + 1);
  return m;
}

/**
 * 当前最「稀缺」的类型。
 *
 * 计算每种类型相对目标配比的缺口（目标占比 × 总数 - 现有数），
 * 缺口最大的那个就是 AI 这一次优先想补的类型。
 * 只在已解锁类型里挑。
 */
function pickMostNeededType(
  plants: ReadonlyArray<AIPlantSnapshot>,
  elapsedMs: number,
  rng: () => number
): PlantType {
  const counts = tallyTypes(plants);
  const total = plants.length;

  // 动态剑士份额：随时间提升（2/5/8 分钟三档）
  const swordShare = swordsmanShareAt(elapsedMs);
  // 其它类型按原相对权重分摊剩余份额
  const otherBase = TYPE_TARGET
    .filter((t) => t.type !== 'swordsman')
    .reduce((sum, t) => sum + t.share, 0);
  const otherRemain = Math.max(0, 1 - swordShare);

  let bestType: PlantType = 'shooter';
  let bestGap = -Infinity;

  for (const { type, share } of TYPE_TARGET) {
    if (!isUnlocked(type, elapsedMs)) continue;
    // 剑士用动态份额，其余按比例缩放后分摊剩余份额
    const targetShare =
      type === 'swordsman'
        ? swordShare
        : otherBase > 0
          ? (share / otherBase) * otherRemain
          : 0;

    const want = targetShare * (total + 1);
    const have = counts.get(type) ?? 0;
    // 加一点点随机抖动，避免每次决策完全雷同、显得机械
    const gap = want - have + (rng() - 0.5) * 0.35;
    if (gap > bestGap) {
      bestGap = gap;
      bestType = type;
    }
  }
  return bestType;
}

/**
 * 给定「要放的类型」和「某个空格」，算出这个落点的战术价值分。
 * 分越高越优先。
 */
function scorePlacement(
  type: PlantType,
  col: number,
  row: number,
  ctx: AIContext,
  player: AIPlayerSnapshot,
  distToPlayer: number
): number {
  const cfg = PLANT_TYPES[type];
  if (!cfg) return -Infinity;

  const onSameRow = row === player.row;
  const onSameCol = col === player.col;

  // 玩家正在移动的方向（单位格向量），用于「预判下一格」
  const dCol = Math.sign(player.col - player.prevCol);
  const dRow = Math.sign(player.row - player.prevRow);

  // —— 基础项：离玩家越近，威胁越大 ——
  // 高伤害/控制类对「贴近玩家」更敏感（系数更大）。
  let score = 0;
  const proximityWeight =
    type === 'slow' ? 2.4 :
    type === 'swordsman' ? 2.2 :
    type === 'ice' ? 1.9 :
    type === 'shooter' ? 1.6 : 0.6; // wall 不需要贴脸
  score += proximityWeight * (10 - Math.min(distToPlayer, 10));

  // —— 战术项 1：十字火力走廊（射手/冰射）——
  // 玩家所在行列会被整条打穿，落在这里等于把枪口直接对准玩家。
  if ((type === 'shooter' || type === 'ice')) {
    if (onSameRow || onSameCol) score += 14;

    // 预判：放在玩家「即将进入」的那条线前方，形成提前量
    if (dCol !== 0 && row === player.row &&
        Math.sign(col - player.col) === dCol) score += 5;
    if (dRow !== 0 && col === player.col &&
        Math.sign(row - player.row) === dRow) score += 5;
  }

  // —— 战术项 2：减速泥潭（冷雾苔）——
  // 尽量铺满玩家四周 2 格内，让玩家在火线里挪不动。
  if (type === 'slow') {
    if (distToPlayer <= 3) score += 12;
    if (onSameRow || onSameCol) score += 4;
  }

  // —— 战术项 3：卡位封路（墙）——
  // 放在玩家「想跑的方向」的延线上，逼它进火线。
  // 但不要压在十字火力线上（墙会挡自家豌豆）。
  if (type === 'wall') {
    if (distToPlayer <= 4) score += 6;
    if (dCol !== 0 && row === player.row &&
        Math.sign(col - player.col) === dCol) score += 8;
    if (dRow !== 0 && col === player.col &&
        Math.sign(row - player.row) === dRow) score += 8;
    if (onSameRow || onSameCol) score -= 6; // 别挡火力线
  }

  // —— 战术项 4：剑士点杀 ——
  // 全屏追踪，越靠近玩家越好（出手点离玩家近，飞行时间短）。
  if (type === 'swordsman') {
    if (distToPlayer <= 5) score += 10;
    // 剑士不依赖十字，放在玩家同列/同行反而浪费贴脸机会，轻微不加分
  }

  return score;
}

/**
 * 核心入口：给一个战术决策。
 *
 * @returns 落子方案；若没有合法格（场地全满 / 全被房屋围死）返回 null。
 */
export function decide(ctx: AIContext): AIDecision | null {
  const { grid, player, plants } = ctx;
  const rng = ctx.rng ?? Math.random;

  if (player.isDead) return null;

  // 1) 兜底：若场上完全没植物（开局），先放一个正对玩家的射手，建立基本威胁。
  if (plants.length === 0) {
    const cell = findBestCell(grid, player, (c, r, d) =>
      (r === player.row ? 8 : 0) + (10 - Math.min(d, 10))
    );
    if (cell) return { col: cell.col, row: cell.row, type: 'shooter' };
    return null;
  }

  // 2) 选出这次最该补的类型
  const type = pickMostNeededType(plants, ctx.elapsedMs, rng);

  // 3) 在该类型的可行落点上找全局最高分
  const best = findBestCell(grid, player, (col, row, dist) => {
    const s = scorePlacement(type, col, row, ctx, player, dist);
    // 轻微随机扰动，避免完全 deterministic 的机械感
    return s + (rng() - 0.5) * 1.2;
  });

  if (!best) return null;
  return { col: best.col, row: best.row, type };
}

/**
 * 遍历所有「可放且不贴脸」的空格，用 scoreFn 打分，返回最高分格。
 *
 * 合法性 = 网格内 & 非房屋 & 未占用 & 离玩家不近于 AI_MIN_DIST_TO_PLAYER。
 */
function findBestCell(
  grid: GridSystem,
  player: AIPlayerSnapshot,
  scoreFn: (col: number, row: number, distToPlayer: number) => number
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestScore = -Infinity;

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (!grid.isFree(col, row)) continue;

      const center = grid.cellToCenter(col, row);
      const dx = center.x - player.x;
      const dy = center.y - player.y;
      const pxDist = Math.sqrt(dx * dx + dy * dy);
      if (pxDist < AI_MIN_DIST_TO_PLAYER) continue;

      const dist = cellDist(col, row, player.col, player.row);
      const s = scoreFn(col, row, dist);
      if (s > bestScore) {
        bestScore = s;
        best = { col, row };
      }
    }
  }

  return best;
}

/** 供调试：导出关键常量 */
export const AI_TUNING = {
  minDistToPlayer: AI_MIN_DIST_TO_PLAYER,
  typeTarget: TYPE_TARGET,
  /** 参考既有上限，避免 AI 与配置脱节 */
  maxOnField: PLANT.maxOnField
} as const;
