/**
 * 植物生成器（由 AI 战术操控）。
 *
 * 节奏沿用原设定：
 *  - 初始每 3 秒生成一株，随时间线性缩短到 1.2 秒
 *  - 场上上限 30
 *
 * 但「种什么、种在哪」不再随机，而是交给 PlantAI 这台「电脑」：
 * 它会针对玩家当前位置与移动方向，布下十字火线、减速泥潭、
 * 卡位墙与点杀剑士，目的是**尽最大可能把玩家弄死**。
 * 本类只负责执行 AI 的决策（占格、建实体、异常回滚），
 * 并保留「防死角」这道安全阀，避免玩家被围成无敌挂机点。
 */

import Phaser from 'phaser';
import { Plant } from '../entities/Plant';
import { SwordsmanPlant, type SwordsmanFireCallback } from '../entities/SwordsmanPlant';
import { GridSystem } from './GridSystem';
import { type PlantType } from '../data/plants';
import { PLANT } from '../config';
import { clamp } from '../utils';
import {
  decide as decidePlant,
  AI_TUNING,
  type AIPlayerSnapshot,
  type AIPlantSnapshot
} from './PlantAI';

/**
 * AI 落子时「离玩家的最小像素距离」的平方。
 * 与 PlantAI 内部保持同一数值，避免安全阀补位时把植物贴到玩家脸上。
 */
const AI_MIN_PLACE_DIST_SQ =
  AI_TUNING.minDistToPlayer * AI_TUNING.minDistToPlayer;

export class PlantSpawner {
  private scene: Phaser.Scene;
  private grid: GridSystem;
  private onFire: (plant: Plant) => void;
  private onSwing: SwordsmanFireCallback;
  /** 植物被摧毁回调（掉落道具） */
  private onPlantDestroyed?: (plant: Plant) => void;

  /**
   * 植物生成成功回调（在 spawnAt 内、植物已入列表后触发）。
   * GameScene 用它在石墙落成时铺设壁垒。
   */
  private onPlantSpawned?: (plant: Plant) => void;

  /** 场上植物列表 */
  readonly plants: Plant[] = [];

  /** 距下次生成的剩余时间 */
  private countdown = 0;
  /** 已运行时间，用于计算间隔缩短 */
  private elapsed = 0;
  /** 距下一次特殊个体升级的剩余时间 */
  private eliteCountdown = PLANT.eliteIntervalMs;
  /** 已产生的特殊个体数量 */
  private eliteCount = 0;

  /**
   * 玩家「上一帧」所在格。
   *
   * AI 用它推断玩家正在往哪个方向移动，从而预判它「下一秒会到哪」，
   * 把火力/减速提前铺到那个方向。首次更新时与当前格相同（视为静止）。
   */
  private prevPlayerCol = -1;
  private prevPlayerRow = -1;

  constructor(
    scene: Phaser.Scene,
    grid: GridSystem,
    onFire: (plant: Plant) => void,
    onSwing: SwordsmanFireCallback
  ) {
    this.scene = scene;
    this.grid = grid;
    this.onFire = onFire;
    this.onSwing = onSwing;
    this.countdown = PLANT.spawnIntervalStart;
  }

  /** 注入「植物被摧毁」回调（GameScene 创建后调用，用于道具掉落） */
  setPlantDestroyedCallback(cb: (plant: Plant) => void): void {
    this.onPlantDestroyed = cb;
  }

  /** 注入「植物生成成功」回调（GameScene 创建后调用，用于石墙壁垒） */
  setPlantSpawnedCallback(cb: (plant: Plant) => void): void {
    this.onPlantSpawned = cb;
  }

  /** 当前生成间隔（毫秒） */
  get currentInterval(): number {
    const t = clamp(this.elapsed / PLANT.spawnRampDuration, 0, 1);
    return Phaser.Math.Linear(
      PLANT.spawnIntervalStart,
      PLANT.spawnIntervalEnd,
      t
    );
  }

  /**
   * 当前时间档位下的「植物最大血量加成」。
   *
   * 需求：所有植物每 30 秒 +50 生命。
   * 例如 0~30s 为 0，30~60s 为 50，60~90s 为 100……
   */
  private currentHpBonus(): number {
    if (PLANT.hpGrowthIntervalMs <= 0) return 0;
    const steps = Math.floor(this.elapsed / PLANT.hpGrowthIntervalMs);
    return Math.max(0, steps) * PLANT.hpGrowthAmount;
  }

  /** 每帧更新 */
  update(delta: number, player: Phaser.GameObjects.Sprite): void {
    this.elapsed += delta;

    // 到达生成间隔才让 AI 落子；但无论是否生成，都要维护「上一帧玩家格」，
    // 否则 AI 的方向预判会一直是静止的。
    if (this.plants.length < PLANT.maxOnField) {
      this.countdown -= delta;
      if (this.countdown <= 0) {
        this.countdown = this.currentInterval;
        this.trySpawn(player);
      }
    }

    // 每 30 秒从场上现有植物里升级一株为特殊个体
    this.eliteCountdown -= delta;
    if (this.eliteCountdown <= 0) {
      this.eliteCountdown += PLANT.eliteIntervalMs;
      const candidates = this.plants.filter(
        (p) => p && p.active && !p.isDying && !p.isElite
      );
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        if (pick.makeElite()) this.eliteCount++;
      }
    }

    this.rememberPlayerCell(player);
  }

  /** 已产生的特殊个体数量（测试/调试用） */
  get eliteTotal(): number {
    return this.eliteCount;
  }

  /** 本局已运行时间（毫秒） */
  get elapsedMs(): number {
    return this.elapsed;
  }

  /** 记录玩家当前格，供下一帧 AI 做方向预判 */
  private rememberPlayerCell(player: Phaser.GameObjects.Sprite): void {
    const anyP = player as unknown as { cellCol?: number; cellRow?: number };
    if (typeof anyP.cellCol === 'number' && typeof anyP.cellRow === 'number') {
      this.prevPlayerCol = anyP.cellCol;
      this.prevPlayerRow = anyP.cellRow;
    }
  }

  /**
   * 让 AI 决定「种什么、种在哪」，然后执行落子。
   *   1. 快照玩家当前格 + 上一帧格，推断移动方向；
   *   2. 快照场上植物（供类型配比）；
   *   3. 调 PlantAI.decide() 得到 {col,row,type}；
   *   4. 防死角校验：若 AI 选的格四周被房屋/植物包死，换一个可达格；
   *   5. spawnAt 落地（占格、建实体、异常回滚都在那里）。
   */
  private trySpawn(player: Phaser.GameObjects.Sprite): Plant | null {
    this.prunePlants();

    if (!player || !player.active) return null;

    const anyP = player as unknown as {
      cellCol?: number;
      cellRow?: number;
      isDead?: boolean;
    };
    if (anyP.isDead) return null;

    // 玩家必须具备格坐标，否则 AI 无法做战术判断
    if (typeof anyP.cellCol !== 'number' || typeof anyP.cellRow !== 'number') {
      return null;
    }

    const curCol = anyP.cellCol;
    const curRow = anyP.cellRow;

    // 首次更新时 prev 未初始化：视为与当前格相同（静止），避免方向误判
    const prevCol = this.prevPlayerCol < 0 ? curCol : this.prevPlayerCol;
    const prevRow = this.prevPlayerRow < 0 ? curRow : this.prevPlayerRow;

    const playerSnap: AIPlayerSnapshot = {
      col: curCol,
      row: curRow,
      prevCol,
      prevRow,
      x: player.x,
      y: player.y,
      isDead: false // 上面已排除 isDead，走到这里一定是活的
    };

    const plantSnap: AIPlantSnapshot[] = this.plants
      .filter((p) => p && p.active)
      .map((p) => ({ col: p.col, row: p.row, type: p.type }));

    // 让 AI 出招
    const aiDecision = decidePlant({
      grid: this.grid,
      player: playerSnap,
      plants: plantSnap,
      elapsedMs: this.elapsed
    });

    if (!aiDecision) return null;

    // ---- 防死角安全阀 ----
    //
    // 植物占格不阻挡移动（僵尸能踩上去啃），但如果某格四周被房屋
    // 和植物包死，玩家冲进去就出不来 —— 会变成无敌挂机点。
    // AI 侧重进攻，可能挑到这种格；这里做最后一道校验，不安全就换格。
    let { col, row } = aiDecision;
    const safeCell = this.pickSafeCellNear(col, row, player);
    if (safeCell) {
      col = safeCell.col;
      row = safeCell.row;
    } else if (!this.grid.hasWalkableNeighbor(col, row)) {
      // 连附近都找不到安全格，这轮干脆放弃，别造死角
      return null;
    }

    return this.spawnAt(col, row, aiDecision.type);
  }

  /**
   * 给定 AI 的首选格，返回一个「本身安全（有可走邻格）」的格。
   *
   * 优先原格；原格不安全则在同类（尽量靠近原格、且远离玩家）的
   * 空闲格里找一个安全的。找不到返回 null（交由调用方决定放弃）。
   */
  private pickSafeCellNear(
    col: number,
    row: number,
    player: Phaser.GameObjects.Sprite
  ): { col: number; row: number } | null {
    if (this.grid.isFree(col, row) && this.grid.hasWalkableNeighbor(col, row)) {
      return { col, row };
    }

    let best: { col: number; row: number } | null = null;
    let bestCost = Infinity;
    for (let r = 0; r < this.grid.rows; r++) {
      for (let c = 0; c < this.grid.cols; c++) {
        if (!this.grid.isFree(c, r)) continue;
        if (!this.grid.hasWalkableNeighbor(c, r)) continue;
        const center = this.grid.cellToCenter(c, r);
        const dx = center.x - player.x;
        const dy = center.y - player.y;
        if (dx * dx + dy * dy < AI_MIN_PLACE_DIST_SQ) continue;

        // 代价 = 距离 AI 首选格的格距（越小越好）
        const cost = Math.abs(c - col) + Math.abs(r - row);
        if (cost < bestCost) {
          bestCost = cost;
          best = { col: c, row: r };
        }
      }
    }
    return best;
  }

  /**
   * 在指定格生成指定类型植物。
   *
   * 关键：先占格，若创建实体过程中抛异常，必须回滚占格，
   * 否则该格会永久处于「已占用但无植物」状态，格子耗尽后生成器死锁。
   */
  spawnAt(col: number, row: number, type: PlantType): Plant | null {
    // 生成校验：越界 / 房屋 / 已占用 一律拒绝，且不改变占用状态
    if (!this.grid.isFree(col, row)) return null;

    if (!this.grid.occupy(col, row)) return null;

    try {
      const center = this.grid.cellToCenter(col, row);
      const args = {
        scene: this.scene,
        x: center.x,
        y: center.y,
        type,
        col,
        row,
        onFire: this.onFire,
        onDestroyed: this.onPlantDestroyed
      };

      // 宗门剑士需要分层贴图 + 挥剑动画，用专门子类；
      // 其它植物都是单贴图，走基类即可。
      const plant =
        type === 'swordsman'
          ? new SwordsmanPlant(args, this.onSwing)
          : new Plant(args);

      this.plants.push(plant);
      // 新植物立即享受当前时间档位的血量加成
      plant.applyHpRamp(this.currentHpBonus());
      // 通知外部（石墙铺设壁垒等）。用 try/catch 兜底，
      // 避免回调异常导致「植物已入队却抛错→回滚占格」的错乱。
      try {
        this.onPlantSpawned?.(plant);
      } catch (err) {
        console.error('[PlantSpawner] onPlantSpawned 回调异常:', err);
      }
      return plant;
    } catch (err) {
      // 创建失败：回滚占格，保证格子一致性
      this.grid.release(col, row);
      console.error('[PlantSpawner] 植物创建失败，已回滚格子:', col, row, err);
      return null;
    }
  }

  /** 每帧推进所有植物（倒序遍历，允许中途移除） */
  updatePlants(
    delta: number,
    player: Phaser.GameObjects.Sprite,
    cellSize: number = 64
  ): void {
    for (let i = this.plants.length - 1; i >= 0; i--) {
      const p = this.plants[i];
      if (!p) continue;
      if (!p.active) continue;
      p.update(delta, player, cellSize);
    }
  }

  /** 移除已销毁植物的引用 */
  prunePlants(): void {
    for (let i = this.plants.length - 1; i >= 0; i--) {
      if (!this.plants[i].active) {
        this.plants.splice(i, 1);
      }
    }
  }

  /** 找到距离玩家最近的植物（含距离） */
  findNearest(player: Phaser.GameObjects.Sprite): { plant: Plant; dist: number } | null {
    let best: Plant | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    if (!player || !player.active) return null;

    for (const p of this.plants) {
      if (!p.active || p.isDying) continue;   // 已在销毁中的植物不可再被选为啣食目标
      const dx = p.x - player.x;
      const dy = p.y - player.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = p;
      }
    }

    if (!best) return null;
    return { plant: best, dist: Math.sqrt(bestDistSq) };
  }

  /** 从场上移除一株（被吃掉），幂等 */
  remove(plant: Plant): void {
    if (!plant) return;
    const idx = this.plants.indexOf(plant);
    if (idx >= 0) this.plants.splice(idx, 1);
  }

  get count(): number {
    return this.plants.filter((p) => p.active).length;
  }

  /** 清空所有植物（重开 / 场景关闭时） */
  destroyAll(): void {
    // 倒序遍历，避免销毁过程中数组变化导致跳过
    for (let i = this.plants.length - 1; i >= 0; i--) {
      const p = this.plants[i];
      if (!p) continue;
      try {
        // 先释放格子，保证 GridSystem 与实际植物数量一致
        if (this.grid.isOccupied(p.col, p.row)) {
          this.grid.release(p.col, p.row);
        }
        if (p.active) p.destroy();
      } catch {
        /* 单个植物销毁失败不影响整体清理 */
      }
    }
    this.plants.length = 0;
  }
}
