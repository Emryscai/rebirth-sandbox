/**
 * 宗门剑士掷出的追踪剑。
 *
 * 与豌豆（Bullet）的区别：
 *
 *   豌豆：发射即定线，只走直线，不可逆。
 *   这套「直线弹道」是豌豆的设计核心 —— 它让走位躲子弹成为可能。
 *
 *   但宗门剑士的定位是「全屏追踪」，也就是**躲不掉**。
 *   所以两者不能共用一个类：追踪需要每帧读取目标位置并调整朝向，
 *   而豌豆类里根本没有「目标」这个概念。
 *
 * 追踪模型（猫尾香蒲式「必中」，分三层叠加）：
 *
 *   1) 远距离：提前量拦截 —— 用目标最近的速度，瞄准「目标稍后将要到的位置」，
 *      而不是当前位置。僵尸横移/冲刺时剑会迎头撞上，而不是追着尾巴跑。
 *      转向仍限速（turnRate），飞行轨迹是一段平滑弧线，观感自然。
 *   2) 近距离：直接对准 —— 与目标距离小于 closeLockRadius 时跳过限速，
 *      瞬间把朝向对准目标中心，杜绝「高速贴身时绕着目标画圈打不中」。
 *   3) 兜底：飞满 lifeMs 仍未命中且目标仍存活时，把剑瞬移到目标身上并置
 *      forceHit，交由 GameScene 直接结算命中 —— 从机制上保证「无论僵尸怎么跑，
 *      剑终将命中」（剑速 560 > 玩家最大冲刺速度，正常情况下第 1、2 层早就命中，
 *      第 3 层只是极端情况的保险丝）。
 *
 * 位置推进与 Bullet 一致：物理体设 moves = false，
 * 坐标由 step() 独占推进，保证「视觉位置 == 判定位置」。
 */

import Phaser from 'phaser';
import { ASSET_KEYS, SWORDSMAN } from '../config';

export class SwordBullet extends Phaser.Physics.Arcade.Image {
  /** 携带伤害 */
  damage: number;

  /** 当前朝向（弧度）。贴图默认朝右，所以 0 = 朝右 */
  private heading = 0;

  /** 飞行速度（像素/秒） */
  private speed: number;

  /** 已飞行时间（毫秒），用于超时自毁 */
  private age = 0;

  /** 是否已命中/销毁 */
  hasHit = false;
  private destroyed = false;

  /** 世界边界 */
  private worldBounds: Phaser.Geom.Rectangle;

  /** 上一帧位置，供扫掠检测使用 */
  prevX: number;
  prevY: number;

  /**
   * 目标提供者。
   *
   * 不在构造时锁死目标引用 —— 目标是玩家的 Sprite，
   * 它会动，而且可能中途失效（死亡/场景重启）。
   * 用回调每帧现取，拿到 null 就说明目标没了，
   * 此时剑沿当前朝向惯性飞出去，自然消失。
   */
  private getTarget: () => { x: number; y: number } | null;

  /** 上一帧目标位置，用于差分估算目标速度（提前量用） */
  private lastTargetX: number | null = null;
  private lastTargetY: number | null = null;

  /** 平滑后的目标速度（像素/秒），用于预测拦截点 */
  private targetVX = 0;
  private targetVY = 0;

  /**
   * 「兜底必中」标记。
   *
   * 当剑飞满 lifeMs 仍未命中、但目标依然存活时置位：说明极端情况下
   * （目标连续冲刺甩开了追踪），此时剑已被瞬移到目标身上，交给外部
   * （GameScene）直接结算命中，保证「无论怎么跑，终将命中」。
   */
  forceHit = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    angle: number,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle,
    getTarget: () => { x: number; y: number } | null
  ) {
    super(scene, x, y, ASSET_KEYS.swordsmanSword);

    this.damage = damage;
    this.worldBounds = worldBounds;
    this.getTarget = getTarget;
    this.prevX = x;
    this.prevY = y;
    this.heading = angle;
    this.speed = SWORDSMAN.projectileSpeed;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(16);
    this.setScale(SWORDSMAN.swordScale);

    // 剑是斜着画在贴图里的，贴图内部的剑身角度与「朝右」有偏差，
    // 这里在旋转时补偿，让剑尖始终指向飞行方向。
    this.syncRotation();

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setSize(this.width * 0.5, this.height * 0.5);
    body.setVelocity(0, 0);
    (body as unknown as { moves: boolean }).moves = false;

    // 出场小甩尾，让掷剑有力度
    const s = SWORDSMAN.swordScale;
    this.setScale(s * 1.35);
    scene.tweens.add({
      targets: this,
      scaleX: s,
      scaleY: s,
      duration: 90,
      ease: 'Quad.easeOut'
    });
  }

  /**
   * 贴图里的剑身倾角（弧度）。
   *
   * swordsman-sword.png 里的剑是斜放着的，剑尖在右上、剑柄在左下，
   * 用 PCA 对全部实心像素求主轴得到 -61.9 度（比目测精确）。
   * 若直接把 heading 赋给 rotation，剑尖会偏离飞行方向 62 度；
   * 减去这个偏移即可让剑尖对准 heading。
   */
  private static readonly ART_TILT = Phaser.Math.DegToRad(-61.9);

  private syncRotation(): void {
    this.rotation = this.heading - SwordBullet.ART_TILT;
  }

  /** 每帧推进：先更新追踪朝向，再前冲 */
  step(deltaMs: number): void {
    if (!this.isLive) return;

    const dt = deltaMs / 1000;
    this.age += deltaMs;

    this.prevX = this.x;
    this.prevY = this.y;

    // ---- 1. 追踪（提前量 + 近距直接对准）----
    const target = this.getTarget();
    let distToTarget = Infinity;
    if (target) {
      // 1a. 用位置差分估算目标速度，并做平滑（防止单帧抖动）
      if (this.lastTargetX !== null && this.lastTargetY !== null && dt > 0) {
        const instVX = (target.x - this.lastTargetX) / dt;
        const instVY = (target.y - this.lastTargetY) / dt;
        // 指数平滑：0.5 兼顾「跟得上冲刺」与「不抖动」
        this.targetVX = this.targetVX * 0.5 + instVX * 0.5;
        this.targetVY = this.targetVY * 0.5 + instVY * 0.5;
      }
      this.lastTargetX = target.x;
      this.lastTargetY = target.y;

      const dx = target.x - this.x;
      const dy = target.y - this.y;
      distToTarget = Math.hypot(dx, dy);

      // 1b. 预测拦截点：目标当前位置 + 速度 × 前置时间
      const leadX = target.x + this.targetVX * SWORDSMAN.leadSeconds;
      const leadY = target.y + this.targetVY * SWORDSMAN.leadSeconds;

      // 1c. 近距离直接对准目标中心（跳过限速，避免高速贴身绕圈必中）
      let desired: number;
      if (distToTarget <= SWORDSMAN.closeLockRadius) {
        desired = Math.atan2(dy, dx);
        this.heading = Phaser.Math.Angle.Wrap(desired);
      } else {
        // 远距离：朝预测点平滑转向（弧线追踪，观感自然）
        desired = Math.atan2(leadY - this.y, leadX - this.x);
        let diff = Phaser.Math.Angle.Wrap(desired - this.heading);
        const maxTurn = SWORDSMAN.turnRate * dt;
        if (diff > maxTurn) diff = maxTurn;
        else if (diff < -maxTurn) diff = -maxTurn;
        this.heading = Phaser.Math.Angle.Wrap(this.heading + diff);
      }
      this.syncRotation();
    }

    // ---- 2. 沿当前朝向前进 ----
    const move = this.speed * dt;
    this.x += Math.cos(this.heading) * move;
    this.y += Math.sin(this.heading) * move;

    this.syncBody();

    // ---- 3. 超时 / 出界 ----
    const b = this.worldBounds;
    const outOfBounds =
      this.x < b.x - 120 ||
      this.x > b.right + 120 ||
      this.y < b.y - 120 ||
      this.y > b.bottom + 120;

    if (this.age >= SWORDSMAN.lifeMs) {
      // 兜底必中：只要目标仍存活，就不再自毁，而是把剑瞬移到目标身上并置
      // forceHit —— 交由 GameScene 在同一帧直接结算命中（随后 kill 会收尾）。
      // 注意：这里**不调用 fadeOut**，否则 hasHit 会被置 true、使本剑在
      // GameScene 的命中循环里被当成「已死」跳过，导致兜底失效或反复结算。
      if (target) {
        this.x = target.x;
        this.y = target.y;
        this.forceHit = true;
        this.syncBody();
        return;
      }
      // 目标已消失：正常自毁
      this.fadeOut();
      return;
    }

    // 出界：目标已消失（getTarget 返回 null）时才会真正飞出屏幕自毁
    if (outOfBounds && !target) {
      this.fadeOut();
    }
  }

  private syncBody(): void {
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (!body || !body.enable) return;
    body.position.x = this.x - body.width / 2;
    body.position.y = this.y - body.height / 2;
  }

  /** 命中结算：闪光后立即销毁剑体（不再原地淡出吸附在僵尸身上） */
  kill(): void {
    if (!this.active || this.destroyed || this.hasHit) return;
    this.hasHit = true;
    // 先立刻隐藏，避免 destroy 在当前帧末尾才真正移除时视觉残留
    this.setVisible(false);
    this.setActive(false);

    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }

    const scene = this.scene;
    const hx = this.x;
    const hy = this.y;

    // 命中闪光（保留「啪」一下的打击感）
    if (scene?.add) {
      const flash = scene.add
        .circle(hx, hy, 6, 0xfff3c4, 0.9)
        .setDepth(17)
        .setBlendMode(Phaser.BlendModes.ADD);
      scene.tweens.add({
        targets: flash,
        radius: 26,
        alpha: 0,
        duration: 200,
        ease: 'Quad.easeOut',
        onComplete: () => {
          if (flash.active) flash.destroy();
        }
      });
    }

    // 关键：命中后**立刻**销毁剑体贴图。
    //
    // 旧实现是原地 alpha 淡出 130ms —— 但命中点就在僵尸身体上，
    // 剑会在僵尸身上停留一小段时间，看起来像「贴图吸附到僵尸身上没消失」。
    // 这里直接销毁，只留闪光作为反馈，视觉上剑「扎进去就没了」。
    this.destroy();
  }

  /** 淡出销毁（命中与超时共用） */
  private fadeOut(): void {
    if (!this.active || this.destroyed) return;
    this.hasHit = true;

    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }

    const scene = this.scene;
    if (scene?.tweens) {
      scene.tweens.add({
        targets: this,
        alpha: 0,
        duration: 130,
        onComplete: () => this.destroy()
      });
      // 兜底：tween 被打断时也要清掉
      scene.time.delayedCall(260, () => {
        if (this.active && !this.destroyed) this.destroy();
      });
    } else {
      this.destroy();
    }
  }

  get isLive(): boolean {
    return this.active && !this.destroyed && !this.hasHit;
  }

  destroy(fromScene?: boolean): void {
    this.destroyed = true;
    super.destroy(fromScene);
  }

  /** 静态工厂：从 (x,y) 沿 angle 方向掷出，持续追踪 getTarget 返回的位置 */
  static fire(
    scene: Phaser.Scene,
    x: number,
    y: number,
    angle: number,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle,
    getTarget: () => { x: number; y: number } | null
  ): SwordBullet {
    return new SwordBullet(scene, x, y, angle, damage, worldBounds, getTarget);
  }
}