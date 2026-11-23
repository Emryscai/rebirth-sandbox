/**
 * 弹射异球（Bouncing Orb）。
 *
 * 行为：向面朝方向射出，遇到「植物 / 场地边界」反弹，
 * 每命中一株植物造成一次伤害并继续弹跳，反弹次数耗尽或超时后消失。
 *
 * 实现选择：
 *   不用 Arcade 物理（反弹对圆形植物、场地边界的判定要统一处理，手写反而更可控）。
 *   用纯数学推进：每帧按速度移动，然后：
 *     1) 与场地矩形做反射（撞墙翻符号）；
 *     2) 与每株植物做圆-圆判定，命中则沿法线反射 + 报伤害 + 递增反弹数。
 *
 * 所有更新都在 step() 内完成，外部只负责喂植物列表与结算伤害。
 */

import Phaser from 'phaser';
import { ITEM, ASSET_KEYS } from '../config';

export interface OrbHitTarget {
  x: number;
  y: number;
  radius: number;
  /** 是否仍然可命中（已死的植物不再反弹） */
  alive: () => boolean;
  /** 命中回调（外部扣血） */
  apply: (damage: number) => void;
}

export class BouncingOrb extends Phaser.GameObjects.Image {
  private vx = 0;
  private vy = 0;

  /** 是否存活 */
  private live = true;

  /** 剩余反弹次数 */
  private bounces = ITEM.orbMaxBounces;

  /** 寿命（毫秒）兜底 */
  private life = 5000;

  /** 已经命中过的目标（同一颗球对同一株植物只结算一次） */
  private readonly hitSet = new Set<OrbHitTarget>();

  private readonly bounds: Phaser.Geom.Rectangle;
  private readonly radius: number;

  /** 撞墙反弹回调（每撞一次场地边界触发一次，用于音效等） */
  onWallBounce?: () => void;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    bounds: Phaser.Geom.Rectangle
  ) {
    super(scene, x, y, ASSET_KEYS.itemBouncingOrb);
    this.bounds = bounds;

    // 显示尺寸：约半格
    this.setDisplaySize(22, 22);
    this.setDepth(30);

    // 初始方向归一化
    const len = Math.hypot(dirX, dirY) || 1;
    this.vx = (dirX / len) * ITEM.orbSpeed;
    this.vy = (dirY / len) * ITEM.orbSpeed;
    this.radius = 11;

    scene.add.existing(this);
    scene.tweens.add({
      targets: this,
      angle: 360,
      duration: 600,
      repeat: -1
    });
  }

  get isLive(): boolean {
    return this.live;
  }

  /**
   * 推进一帧。返回本帧命中的目标列表（外部据此扣血/更新）。
   *
   * @param delta 毫秒
   * @param targets 候选植物
   */
  step(delta: number, targets: ReadonlyArray<OrbHitTarget>): OrbHitTarget[] {
    if (!this.live) return [];

    const dt = Math.min(delta, 50) / 1000;
    this.life -= delta;
    if (this.life <= 0) {
      this.kill();
      return [];
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // ---- 场地边界反射 ----
    const left = this.bounds.x + this.radius;
    const right = this.bounds.x + this.bounds.width - this.radius;
    const top = this.bounds.y + this.radius;
    const bottom = this.bounds.y + this.bounds.height - this.radius;

    if (this.x < left) {
      this.x = left;
      this.vx = Math.abs(this.vx);
      this.consumeBounce();
    } else if (this.x > right) {
      this.x = right;
      this.vx = -Math.abs(this.vx);
      this.consumeBounce();
    }
    if (this.y < top) {
      this.y = top;
      this.vy = Math.abs(this.vy);
      this.consumeBounce();
    } else if (this.y > bottom) {
      this.y = bottom;
      this.vy = -Math.abs(this.vy);
      this.consumeBounce();
    }

    if (!this.live) return [];

    // ---- 植物命中 ----
    const hits: OrbHitTarget[] = [];
    for (const t of targets) {
      if (this.hitSet.has(t)) continue;
      if (!t.alive()) continue;

      const dx = t.x - this.x;
      const dy = t.y - this.y;
      const rr = t.radius + this.radius;
      if (dx * dx + dy * dy > rr * rr) continue;

      // 沿「球 -> 植物」法线反射速度
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d;
      const ny = dy / d;
      const dot = this.vx * nx + this.vy * ny;
      this.vx -= 2 * dot * nx;
      this.vy -= 2 * dot * ny;
      // 平移出植物内部，避免下一帧重复判定
      this.x = t.x - nx * rr;
      this.y = t.y - ny * rr;

      this.hitSet.add(t);
      hits.push(t);
      this.consumeBounce();
      if (!this.live) break;
    }

    return hits;
  }

  /** 消耗一次反弹额度 */
  private consumeBounce(): void {
    this.bounces -= 1;
    if (this.bounces <= 0) this.kill();
  }

  /** 消亡 */
  kill(): void {
    if (!this.live) return;
    this.live = false;
    this.scene?.tweens.killTweensOf(this);
    if (this.scene) {
      // 短暂缩放消散
      this.scene.tweens.add({
        targets: this,
        scale: this.scale * 0.2,
        alpha: 0,
        duration: 120,
        onComplete: () => {
          if (this.active) this.destroy();
        }
      });
    } else {
      this.destroy();
    }
  }
}
