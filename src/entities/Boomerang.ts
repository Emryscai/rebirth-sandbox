/**
 * 回旋骨镖（Boomerang）。
 *
 * 行为：从玩家手中向面朝方向飞出，穿透植物（去程），
 * 到达最远距离后掉头飞回（回程），回到玩家附近消失。
 * 去程与回程各结算一次伤害 —— 同一株植物在一趟里最多被这两次打中。
 *
 * 实现：不依赖物理，纯数学推进。
 *   - phase = 'out'：直线前进，累计行程达到 range 后切 'in'；
 *   - phase = 'in'：朝当前玩家位置归位，足够近或超时则消失。
 *   - 命中用「圆-圆」判定，去程/回程各维护一个已命中集合。
 */

import Phaser from 'phaser';
import { ITEM, ASSET_KEYS } from '../config';

export interface BoomerangHitTarget {
  x: number;
  y: number;
  radius: number;
  alive: () => boolean;
  apply: (damage: number) => void;
}

export class Boomerang extends Phaser.GameObjects.Image {
  private live = true;
  private phase: 'out' | 'in' = 'out';

  /** 去程已飞行距离 */
  private traveled = 0;

  /** 更新玩家位置的取点函数（回程归位用） */
  private readonly getPlayerPos: () => { x: number; y: number } | null;

  /** 去程已命中的目标 */
  private readonly hitOut = new Set<BoomerangHitTarget>();
  /** 回程已命中的目标 */
  private readonly hitIn = new Set<BoomerangHitTarget>();

  private readonly radius = 16;

  /** 超时兜底 */
  private life = 4000;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    getPlayerPos: () => { x: number; y: number } | null
  ) {
    super(scene, x, y, ASSET_KEYS.itemBoomerang);
    this.getPlayerPos = getPlayerPos;

    this.setDisplaySize(34, 30);
    this.setDepth(30);

    // 朝向与初始方向对齐（贴图默认偏横向，这里简单按方向旋转）
    this.setRotation(Math.atan2(dirY, dirX));

    this.dirX = dirX;
    this.dirY = dirY;

    scene.add.existing(this);
  }

  private dirX = 1;
  private dirY = 0;

  get isLive(): boolean {
    return this.live;
  }

  /** 当前阶段（供调试） */
  get phaseName(): 'out' | 'in' {
    return this.phase;
  }

  /**
   * 推进一帧。返回本帧新命中的目标（外部据此扣血）。
   *
   * @param delta 毫秒
   * @param targets 候选植物
   */
  step(delta: number, targets: ReadonlyArray<BoomerangHitTarget>): BoomerangHitTarget[] {
    if (!this.live) return [];

    const dt = Math.min(delta, 50) / 1000;
    this.life -= delta;
    if (this.life <= 0) {
      this.kill();
      return [];
    }

    // 旋转表现
    this.rotation += dt * 18;

    const step = ITEM.boomerangSpeed * dt;

    if (this.phase === 'out') {
      this.x += this.dirX * step;
      this.y += this.dirY * step;
      this.traveled += step;
      if (this.traveled >= ITEM.boomerangRange) {
        this.phase = 'in';
      }
    } else {
      const p = this.getPlayerPos();
      if (!p) {
        this.kill();
        return [];
      }
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const dist = Math.hypot(dx, dy) || 1;
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
      // 回到玩家身边：消失
      if (dist <= 26) {
        this.kill();
        return [];
      }
    }

    // ---- 命中判定 ----
    const hitSet = this.phase === 'out' ? this.hitOut : this.hitIn;
    const hits: BoomerangHitTarget[] = [];
    for (const t of targets) {
      if (hitSet.has(t)) continue;
      if (!t.alive()) continue;
      const dx = t.x - this.x;
      const dy = t.y - this.y;
      const rr = t.radius + this.radius;
      if (dx * dx + dy * dy > rr * rr) continue;
      hitSet.add(t);
      hits.push(t);
    }
    return hits;
  }

  kill(): void {
    if (!this.live) return;
    this.live = false;
    this.scene?.tweens.killTweensOf(this);
    if (this.active) this.destroy();
  }
}
