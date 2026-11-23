/**
 * 宗门剑士：全屏追踪型远程植物。
 *
 * ---- 为什么单独一个类 ----
 *
 * 其它植物（射手/墙/减速苔）都是「一张贴图 + 定时逻辑」，
 * 直接复用 Plant 的 update 就够了。
 *
 * 剑士需要「举剑 -> 劈下 -> 掷剑」的三段动作，而动作是靠
 * **独立的手臂贴图绕肩膀旋转** 实现的 —— 这要求：
 *   1. 身体和手臂是两张贴图，分别摆放；
 *   2. 手臂要能独立旋转，身体不能跟着转；
 *   3. 旋转轴心在肩膀，不在贴图中心。
 *
 * Plant 用的是单张 Sprite，无法承载「分层 + 独立旋转」，
 * 所以这里继承它只为了复用血量/血条/承伤/销毁这些通用逻辑，
 * update() 与贴图构成整体覆写。
 *
 * ---- 动作时序 ----
 *
 *   0ms       开始挥剑（手臂从举剑位转到劈下位）
 *   250ms     挥剑到位，掷出剑
 *   1000ms    冷却结束，回到举剑位，准备下一轮
 *
 * 也就是说：挥剑 0.25 秒，「举着等」0.75 秒，然后再次挥。
 * 这个节奏让 1 秒一发看起来有余裕，而不是连珠炮。
 */

import Phaser from 'phaser';
import { Plant, type PlantSpawnArgs } from './Plant';
import { ASSET_KEYS, SWORDSMAN } from '../config';

/** 剑士掷剑时的回调：给出出手位置与角度 */
export type SwordsmanFireCallback = (
  plant: SwordsmanPlant,
  x: number,
  y: number,
  angle: number
) => void;

export class SwordsmanPlant extends Plant {
  /** 手臂贴图 */
  private arm?: Phaser.GameObjects.Image;

  /** 掷剑回调（与基类的 onFire 分开：两者参数不同） */
  private onSwing: SwordsmanFireCallback;

  /** 冷却计时（剑士用自己的节奏，不复用基类 fireCooldown） */
  private cooldown = 0;

  /** 本轮是否已掷出剑（防止一次冷却内重复发射） */
  private thrown = false;

  /** 挥剑补间，切换时需要打断 */
  private swingTween?: Phaser.Tweens.Tween;

  /**
   * 肩膀在身体贴图上的相对位置（0~1）。
   *
   * swordsman-body.png 是 160x256，右肩大约在 (0.86, 0.72)。
   * 手臂的旋转轴心就落在这里。
   */
  private static readonly SHOULDER = { x: 0.86, y: 0.72 };

  /**
   * 手臂贴图的旋转轴心（0~1）。
   *
   * swordsman-arm.png 是 108x192，胳膊根部（与身体相接处）
   * 在左下方的 (0.23, 0.86)。
   */
  private static readonly ARM_PIVOT = { x: 0.23, y: 0.86 };

  /**
   * 手臂相对身体的缩放。
   *
   * 手臂贴图是按原图切出来的，和身体不是同一比例，
   * 这里缩到 0.72 让它和身体衔接自然。
   */
  private static readonly ARM_SCALE = 0.72;

  constructor(args: PlantSpawnArgs, onSwing: SwordsmanFireCallback) {
    // 先用基类构造把血量/血条/承伤这套通用逻辑搭起来
    super(args);

    this.onSwing = onSwing;

    // 换成本作的剑士身体贴图。
    //
    // 注意：换贴图后**不要再手动 setScale(config.scale)**。
    // 基类 Plant 构造时已按 body 贴图原始宽度（160px）把它归一化到
    // PLANT_SINGLE_TEX_WIDTH（48px）—— scaleX/scaleY 约 0.3，并做了
    // 从 20% 弹回的出生动画。早先这里又 setScale(1) 覆盖回去，
    // 等于让 160×256 的原图按原始像素显示，比格子还大两圈，所以「剑士大得离谱」。
    // 现在直接沿用基类的归一化结果即可。
    this.setTexture(ASSET_KEYS.swordsmanBody);

    this.createArm();

    // 初始冷却随机，避免同屏几株同时挥剑
    this.cooldown = Phaser.Math.Between(300, SWORDSMAN.fireIntervalMs);
  }

  /**
   * 创建手臂贴图并摆到肩膀位置。
   *
   * 手臂是独立 Image，不挂在植物下面（不 add 到 Container），
   * 而是每帧手动跟随植物的世界坐标 ——
   * 因为 Sprite 自身的 setScale / setFlipX / 血条偏移 都会
   * 连带影响子对象，手动跟随最可控。
   */
  private createArm(): void {
    const scene = this.scene;
    if (!scene) return;

    this.arm = scene.add.image(this.x, this.y, ASSET_KEYS.swordsmanArm);
    this.arm.setOrigin(
      SwordsmanPlant.ARM_PIVOT.x,
      SwordsmanPlant.ARM_PIVOT.y
    );
    this.arm.setDepth(this.depth + 1);
    this.arm.setRotation(Phaser.Math.DegToRad(SWORDSMAN.swingFromDeg));

    // 手臂的「稳态缩放」：ARM_SCALE 是相对身体贴图的比例，
    // 而身体此刻已被基类归一化缩放（this.scale ≈ 0.3），手臂须同比缩放，
    // 否则手臂会按 0.72 的原始比例画出来、比缩小后的身体还大。
    // 这里直接用与 syncArmPosition 相同的换算，出生 tween 的终值才不会跳变。
    const armRestScale = this.getArmRestScale();

    // 出生时和本体一起弹出
    this.arm.setScale(armRestScale * 0.2);
    scene.tweens.add({
      targets: this.arm,
      scaleX: armRestScale,
      scaleY: armRestScale,
      duration: 260,
      delay: 20,
      ease: 'Back.easeOut'
    });

    this.syncArmPosition();
  }

  /** 手臂的稳态缩放（相对身体贴图比例 × 身体当前缩放） */
  private getArmRestScale(): number {
    return SwordsmanPlant.ARM_SCALE * (this.scale / Math.max(this.config.scale, 0.001));
  }

  /** 把手臂摆到肩膀处（每帧调用） */
  private syncArmPosition(): void {
    const arm = this.arm;
    if (!arm || !arm.active) return;

    const left = this.x - this.displayWidth / 2;
    const top = this.y - this.displayHeight / 2;

    const sx = left + this.displayWidth * SwordsmanPlant.SHOULDER.x;
    const sy = top + this.displayHeight * SwordsmanPlant.SHOULDER.y;

    arm.setPosition(sx, sy);
    arm.setScale(this.getArmRestScale());
  }

  /**
   * 每帧更新。
   *
   * 与基类的最大区别：不看行、不看列，只要场上有活着的僵尸就锁定。
   */
  override update(delta: number, player: Phaser.GameObjects.Sprite, cellSize = 64): void {
    // 剑士不按行列判定，cellSize 用不到；保留参数只为与基类签名一致
    void cellSize;

    // 血条跟随（基类逻辑）
    this.syncHpBar();

    if (!this.active) return;
    if (this.isDying) return;
    if (this.config.fireInterval <= 0) return;

    this.syncArmPosition();

    if (!player || !player.active) return;
    const anyPlayer = player as unknown as { isDead?: boolean };
    if (anyPlayer.isDead) return;

    // 全屏追踪：只要有目标就在行列之外也能出手
    if (!this.aiming) {
      this.aiming = true;
      this.cooldown = Math.min(this.cooldown, 200);
    }

    if (this.thrown) {
      // 已掷出，等冷却结束再回到举剑位
      this.cooldown -= delta;
      if (this.cooldown <= 0) {
        this.cooldown = SWORDSMAN.fireIntervalMs;
        this.thrown = false;
        this.raiseSword();
      }
      return;
    }

    this.cooldown -= delta;
    if (this.cooldown > 0) return;

    // 冷却结束且尚未掷出 -> 开始挥剑
    this.startSwing(player);
  }

  /**
   * 开始一次挥剑动作。
   *
   * 挥剑 0.25 秒，到「劈下位」的瞬间掷出剑，
   * 这样视觉上剑是从手上飞出去的，而不是凭空出现。
   */
  private startSwing(player: Phaser.GameObjects.Sprite): void {
    const scene = this.scene;
    const arm = this.arm;
    if (!scene || !arm || !arm.active) return;

    this.thrown = true;
    // 关键：进入「已掷出/挥剑中」状态时，必须把冷却重置为整个周期。
    //
    // 否则进入此状态时 cooldown 已经 <= 0（正是它 <= 0 才触发本次挥剑），
    // 下一帧 update 的 thrown 分支会立刻判定「冷却 <= 0」→ 把 thrown 复位、
    // 调 raiseSword()，而这个 raiseSword 里 swingTween?.remove() 会**取消本次挥剑补间**，
    // 补间的 onComplete 永远不执行 → 剑永远掷不出去 → 剑士「站着不动、不攻击」。
    this.cooldown = SWORDSMAN.fireIntervalMs;

    // 打断上一次未完成的挥剑
    this.swingTween?.remove();
    this.swingTween = undefined;

    const toRad = Phaser.Math.DegToRad(SWORDSMAN.swingToDeg);

    this.swingTween = scene.tweens.add({
      targets: arm,
      rotation: toRad,
      duration: SWORDSMAN.swingDurationMs,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        // 挥到位：掷剑
        if (!this.active || this.isDying) return;
        this.throwSword(player);
        this.swingTween = undefined;
      }
    });
  }

  /** 掷出剑：位置取剑尖附近，角度朝目标 */
  private throwSword(player: Phaser.GameObjects.Sprite): void {
    const arm = this.arm;
    if (!arm || !arm.active) return;

    // 出手点：肩膀 + 沿当前手臂朝向前伸一段
    const reach = 34 * this.scale;
    const ax = arm.x + Math.cos(arm.rotation) * reach;
    const ay = arm.y + Math.sin(arm.rotation) * reach;

    // 初始角度朝目标（剑会自动修正，但起点要合理）
    const angle = Phaser.Math.Angle.Between(ax, ay, player.x, player.y);

    this.onSwing(this, ax, ay, angle);
  }

  /** 回到举剑位（冷却结束时调用） */
  private raiseSword(): void {
    const scene = this.scene;
    const arm = this.arm;
    if (!scene || !arm || !arm.active) return;

    this.swingTween?.remove();
    this.swingTween = scene.tweens.add({
      targets: arm,
      rotation: Phaser.Math.DegToRad(SWORDSMAN.swingFromDeg),
      duration: 180,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.swingTween = undefined;
      }
    });
  }


  /** 销毁：连带手臂贴图 */
  override destroy(fromScene?: boolean): void {
    this.swingTween?.remove();
    this.swingTween = undefined;

    if (this.arm) {
      if (this.arm.active) {
        // 让手臂和本体一起消失
        this.scene?.tweens.killTweensOf(this.arm);
        this.arm.destroy();
      }
      this.arm = undefined;
    }

    super.destroy(fromScene);
  }

  /** 带消失动画的销毁（覆写以同时动画手臂） */
  override destroyPlant(): void {
    if (!this.active || this.isDying) return;

    const scene = this.scene;
    const arm = this.arm;

    if (arm && arm.active && scene) {
      scene.tweens.killTweensOf(arm);
      scene.tweens.add({
        targets: arm,
        scaleX: 0,
        scaleY: 0,
        alpha: 0,
        duration: 180,
        ease: 'Quad.easeIn',
        onComplete: () => {
          if (arm.active) arm.destroy();
        }
      });
      this.arm = undefined;
    }

    super.destroyPlant();
  }
}