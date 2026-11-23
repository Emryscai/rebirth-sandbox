/**
 * 手持电锯视觉体（狂暴链锯道具生效时挂在僵尸右手）。
 *
 * 由三张分部件素材拼装：
 *   - mount（锯子与手部连接的部件）：贴在手上，作为握持底座；
 *   - body（锯子本体）：锯刀本体，向前伸出；
 *   - chain（锯子链子）：用 TileSprite 做横向滚动，模拟链条高速转动。
 *
 * 该类现在作为「肢体道具」挂到 ZombieRig 的手部部件上：
 *   - 不再自己设置位置（位置由 ZombieRig.updateLimbProps 每帧摆到手上）；
 *   - 不再自己镜像（父容器已按朝向做 scaleX 镜像，子对象自动跟随）；
 *   - 只在 update 里滚动链子、抖一抖、喷火花。
 *
 * 伤害逻辑仍在 GameScene（链锯自动锯伤附近植物）。
 */

import Phaser from 'phaser';
import { ASSET_KEYS } from '../config';

export class SawRig extends Phaser.GameObjects.Container {
  private readonly mount: Phaser.GameObjects.Image;
  private readonly bladeBody: Phaser.GameObjects.Image;
  private readonly chain: Phaser.GameObjects.TileSprite;

  /** 链子滚动累计（像素） */
  private chainScroll = 0;

  /** 火花冷却（毫秒） */
  private sparkCooldown = 0;

  /** 是否处于啃食（啃食时火花更猛、链子更快） */
  private eating = false;

  /** 空格重击时的放大脉冲 */
  private pulseT = 0;

  /** 锯口相对本容器原点的局部 x（右伸为正，镜像由父容器处理） */
  private readonly bladeTipX = 44;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    super(scene, x, y);

    // ---- 连接部件：在手上 ----
    this.mount = scene.add.image(0, 0, ASSET_KEYS.sawMount);
    this.mount.setDisplaySize(26, 28);

    // ---- 本体：向前伸出 ----
    this.bladeBody = scene.add.image(20, -2, ASSET_KEYS.sawBody);
    this.bladeBody.setDisplaySize(48, 20);

    // ---- 链子：覆盖在本体上方的窄条，横向滚动 ----
    this.chain = scene.add.tileSprite(20, -6, 48, 11, ASSET_KEYS.sawChain);
    this.chain.setOrigin(0.5, 0.5);
    this.chain.setTileScale(0.5, 0.5);

    this.add([this.mount, this.bladeBody, this.chain]);

    this.bladeBody.setAngle(-6);
    this.chain.setAngle(-6);

    this.setDepth(25);
    scene.add.existing(this);
    this.setVisible(false);
  }

  /** 显示/隐藏（道具生效/结束） */
  setShown(shown: boolean): void {
    this.setVisible(shown);
  }

  /** 设置是否处于啃食状态（影响火花密度与链速） */
  setEating(eating: boolean): void {
    this.eating = eating;
  }

  /** 空格重击：锯子贴图短暂放大（由 update 确定性驱动，避免 tween 被场景暂停打断） */
  pulse(): void {
    this.pulseT = 0.42;
  }

  /** 是否正在播放重击放大（测试用） */
  get isPulsing(): boolean {
    return this.pulseT > 0;
  }

  /**
   * 每帧更新：滚动链子、抖一抖、喷火花。位置由父容器负责。
   *
   * @param delta 帧间隔（毫秒）
   */
  update(delta: number): void {
    if (this.pulseT > 0) {
      this.pulseT = Math.max(0, this.pulseT - delta / 1000);
      const elapsed = 0.42 - this.pulseT;
      let k: number;
      if (elapsed < 0.12) k = elapsed / 0.12;
      else if (elapsed < 0.28) k = 1;
      else k = Math.max(0, (0.42 - elapsed) / 0.14);
      const scale = 1 + 0.55 * k;
      this.setScale(scale, scale);
    } else if (this.scaleX !== 1) {
      this.setScale(1, 1);
    }
    if (!this.visible) return;

    const speed = this.eating ? 0.9 : 0.55;
    this.chainScroll += delta * speed;
    this.chain.tilePositionX = this.chainScroll;

    const jitter = this.eating ? 1.2 : 0.5;
    this.bladeBody.y = -2 + Math.sin(this.chainScroll * 0.15) * jitter;
    this.chain.y = -6 + Math.sin(this.chainScroll * 0.15) * jitter;

    this.sparkCooldown -= delta;
    if (this.sparkCooldown <= 0) {
      this.sparkCooldown = this.eating ? 70 : 160;
      this.emitSpark();
    }
  }

  /** 在锯口处喷一小撮火花（世界坐标，由容器世界变换换算） */
  private emitSpark(): void {
    if (!this.scene) return;

    // 锯口在本容器局部坐标下的位置
    const m = this.getWorldTransformMatrix();
    const tip = new Phaser.Math.Vector2();
    m.transformPoint(this.bladeTipX, -8, tip);

    // 抛射方向：沿容器 +x（已含镜像）
    const dirX = Math.sign(this.scaleX || 1);

    const spark = this.scene.add
      .rectangle(tip.x, tip.y, 3, 3, 0xffd166, 1)
      .setDepth(41);

    const life = Phaser.Math.Between(180, 340);
    this.scene.tweens.add({
      targets: spark,
      x: tip.x + dirX * Phaser.Math.Between(10, 26),
      y: tip.y + Phaser.Math.Between(-12, 10),
      alpha: 0,
      duration: life,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (spark.active) spark.destroy();
      }
    });
  }

  /** 安全销毁 */
  safeDestroy(): void {
    this.scene?.tweens.killTweensOf(this);
    if (this.active) this.destroy();
  }
}
