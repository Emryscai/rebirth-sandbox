/**
 * 子弹实体（豌豆）。
 *
 * 设计要点 —— 为什么不用物理引擎推进位置：
 *
 * PvZ 的豌豆是「发射即确定、只走直线、不可逆」的弹道。要做到这点，
 * 位置必须由逻辑线程独占推进，才能保证：
 *   1. 每一帧的 x 都是精确的，扫掠检测不会拿到过期坐标；
 *   2. 帧率波动时弹道速度严格恒定（不会因物理子步进而忽快忽慢）；
 *   3. 命中判定与视觉位置永远一致。
 *
 * 因此本类把物理体设为 moves = false —— 物理体仍然参与 overlap，
 * 但位置完全由 step() 驱动。GameScene 每帧按固定顺序调用：
 *
 *      player.update() -> plants.update() -> bullet.step() -> 命中检测 -> 渲染同步
 *
 * 这样整条链路是可预测的，不依赖 Phaser 内部 update 与物理步进的先后关系。
 */

import Phaser from 'phaser';
import { BULLET, ASSET_KEYS, ASSET_SIZES } from '../config';

export class Bullet extends Phaser.Physics.Arcade.Image {
  /** 携带伤害 */
  damage: number;

  /** 飞行方向：1 向右 / -1 向左 */
  direction: 1 | -1 = 1;

  /**
   * 飞行轴：'h' 水平 / 'v' 垂直。
   *
   * 十字判定里，僵尸在同一「列」时植物要竖直向上/下打，
   * 所以子弹不能只会沿 x 轴飞。
   */
  axis: 'h' | 'v' = 'h';

  /**
   * 是否已结算过命中。
   * 命中后立即置 true，后续任何检测（overlap / 扫掠）都会跳过，
   * 保证「一颗豌豆只结算一次伤害」。
   */
  hasHit = false;

  /** 是否正在播放命中动画（此期间不可再命中，也不再移动） */
  private shattering = false;

  /** 世界边界，出界即销毁 */
  private worldBounds: Phaser.Geom.Rectangle;

  /** 累计飞行距离 */
  private travelled = 0;

  /** 上一帧的 x，供扫掠检测读取 */
  prevX: number;

  /** 上一帧的 y（垂直飞行时用于扫掠检测） */
  prevY = 0;

  /**
   * 命中后的减速比例（0 表示不减速）。
   * 寒冰射手的豌豆会带这个值，命中时交给僵尸施加限时减速。
   */
  slowFactor = 0;
  /** 减速持续时间（毫秒） */
  slowDuration = 0;

  /** 是否为冰豌豆（用于视觉区分：冰蓝色 + 拖尾） */
  isIcy = false;

  /** 是否已经销毁（外部安全访问用） */
  private destroyed = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    direction: 1 | -1,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle
  ) {
    super(scene, x, y, ASSET_KEYS.bullet);

    this.damage = damage;
    this.direction = direction;
    this.worldBounds = worldBounds;
    this.prevX = x;
    this.prevY = y;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(15);
    this.setDisplaySize(ASSET_SIZES.bullet.width, ASSET_SIZES.bullet.height);
    this.setFlipX(direction === -1);

    // 物理体只提供碰撞盒，位置由 step() 独占推进
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setCircle(ASSET_SIZES.bullet.width / 2);
    body.setVelocity(0, 0);
    (body as unknown as { moves: boolean }).moves = false;

    // 豌豆是发光体
    this.setBlendMode(Phaser.BlendModes.ADD);

    // 出生时轻微弹一下，让发射更有手感
    const baseScale = this.scale;
    this.setScale(baseScale * 0.6);
    scene.tweens.add({
      targets: this,
      scaleX: baseScale,
      scaleY: baseScale,
      duration: 70,
      ease: 'Back.easeOut'
    });

    this.syncBody();
  }

  /**
   * 每帧推进位置（由 GameScene 在固定时机调用）。
   * @param deltaMs 帧间隔毫秒
   */
  step(deltaMs: number): void {
    if (!this.isLive) return;

    const dt = deltaMs / 1000;
    const move = BULLET.speed * dt;

    this.prevX = this.x;
    this.prevY = this.y;

    if (this.axis === 'v') {
      // 垂直飞行：沿 y 轴推进，方向沿用 direction（1 向下 / -1 向上）
      this.y += this.direction * move;
    } else {
      this.x += this.direction * move;
    }
    this.travelled += move;

    // 同步物理体包围盒，让 overlap 用到的坐标与实际位置一致
    this.syncBody();

    // 出界销毁（飞出场地外一定距离即回收）
    const b = this.worldBounds;
    if (
      this.x < b.x - 64 ||
      this.x > b.right + 64 ||
      this.y < b.y - 64 ||
      this.y > b.bottom + 64
    ) {
      this.destroy();
    }
  }

  /** 把逻辑坐标写回物理体 */
  private syncBody(): void {
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (!body || !body.enable) return;
    const r = body.radius || ASSET_SIZES.bullet.width / 2;
    body.position.x = this.x - r;
    body.position.y = this.y - r;
  }

  /**
   * 命中结算：播放 PvZ 风格的「豌豆爆开」特效后销毁。
   *
   * 特效构成（贴合原版观感）：
   *   1. 豌豆本体瞬间放大 + 淡出（被打碎的主体）
   *   2. 数颗小碎粒朝不同方向飞散
   *   3. 一圈扩散的冲击环
   */
  kill(): void {
    if (!this.active || this.destroyed) return;
    if (this.hasHit) return;

    this.hasHit = true;
    this.shattering = true;

    // 停止参与一切碰撞
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }

    const hitX = this.x;
    const hitY = this.y;
    const scene = this.scene;
    const baseScale = this.scale;

    // ---- 1) 本体爆开 ----
    //
    // 双保险销毁：
    //   - 正常路径由 tween 的 onComplete 销毁；
    //   - 万一 tween 被中途 kill / 场景暂停 / 补间系统异常，再用一个
    //     定时器兜底，确保命中后的子弹一定会从场上移除。
    // 没有这层兜底时，已命中的子弹会永远以 hasHit=true 的状态挂在组里，
    // 既占内存又会让「场上是否还有子弹」这类判断失真。
    scene.tweens.add({
      targets: this,
      alpha: 0,
      scaleX: baseScale * 2.6,
      scaleY: baseScale * 2.6,
      duration: 110,
      ease: 'Quad.easeOut',
      onComplete: () => this.destroy()
    });

    scene.time.delayedCall(220, () => {
      if (this.active && !this.destroyed) this.destroy();
    });

    if (!scene || !scene.add || !scene.tweens) return;

    // ---- 2) 碎粒飞散（冰豌豆用冰蓝色） ----
    const shardColor = this.isIcy ? 0xaee6ff : 0xbff06a;
    const ringColor = this.isIcy ? 0x9fd8ff : 0xd8f77a;

    const shards = 4;
    for (let i = 0; i < shards; i++) {
      const angle = (Math.PI * 2 * i) / shards + Math.random() * 0.5;
      const dist = 14 + Math.random() * 12;

      const shard = scene.add
        .circle(hitX, hitY, 2.5, shardColor, 1)
        .setDepth(16)
        .setBlendMode(Phaser.BlendModes.ADD);

      scene.tweens.add({
        targets: shard,
        x: hitX + Math.cos(angle) * dist,
        y: hitY + Math.sin(angle) * dist,
        alpha: 0,
        scaleX: 0.3,
        scaleY: 0.3,
        duration: 200 + Math.random() * 80,
        ease: 'Quad.easeOut',
        onComplete: () => {
          if (shard.active) shard.destroy();
        }
      });
    }

    // ---- 3) 冲击环 ----
    const ring = scene.add
      .circle(hitX, hitY, 4, 0xffffff, 0)
      .setStrokeStyle(2, ringColor, 0.9)
      .setDepth(16);

    scene.tweens.add({
      targets: ring,
      radius: 20,
      alpha: 0,
      duration: 180,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (ring.active) ring.destroy();
      }
    });
  }

  /** 当前是否仍可参与命中判定 */
  get isLive(): boolean {
    return this.active && !this.destroyed && !this.hasHit && !this.shattering;
  }

  destroy(fromScene?: boolean): void {
    this.destroyed = true;
    super.destroy(fromScene);
  }

  /**
   * 静态工厂：射手植物朝指定方向水平发射。
   * PvZ 豌豆射手的标准弹道——只走直线，不追踪。
   */
  static fireHorizontal(
    scene: Phaser.Scene,
    fromX: number,
    fromY: number,
    direction: 1 | -1,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle,
    slowFactor = 0,
    slowDuration = 0
  ): Bullet {
    return Bullet.fire(scene, fromX, fromY, direction, damage, worldBounds, 'h', slowFactor, slowDuration);
  }

  /**
   * 通用发射：可指定沿水平或垂直轴飞行。
   *
   * 十字判定里，僵尸落在植物的「同一列」时需要竖直发射，
   * 所以把轴向外提。direction 的含义随轴变化：
   *   水平轴： 1 向右 / -1 向左
   *   垂直轴： 1 向下 / -1 向上
   */
  static fire(
    scene: Phaser.Scene,
    fromX: number,
    fromY: number,
    direction: 1 | -1,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle,
    axis: 'h' | 'v' = 'h',
    slowFactor = 0,
    slowDuration = 0
  ): Bullet {
    const b = new Bullet(scene, fromX, fromY, direction, damage, worldBounds);
    b.axis = axis;
    // 垂直飞行不做左右翻转，否则贴图会歪
    if (axis === 'v') b.setFlipX(false);

    if (slowFactor > 0 && slowDuration > 0) {
      b.slowFactor = slowFactor;
      b.slowDuration = slowDuration;
      b.isIcy = true;
      b.applyIceTint();
    }

    return b;
  }

  /**
   * 冰豌豆的视觉：染成明显的冰蓝色 + 冷气脉动。
   *
   * 普通豌豆贴图是绿色的，单纯 setTint（乘法混合）叠浅蓝只会发灰，
   * 区分不出来。这里改用 setTintFill 直接「填纯蓝」——
   * 贴图是圆形剪影，填充后就是一颗干净的蓝豌豆，
   * 再配合原本的 ADD 发光，就是冰蓝色光球，和绿豌豆一眼可辨。
   */
  private applyIceTint(): void {
    this.setTintFill(0x5cc8ff);

    // 冷气拖尾（轻微脉动，像在冒寒气）
    if (this.scene && this.scene.tweens) {
      this.scene.tweens.add({
        targets: this,
        scaleX: this.scale * 1.12,
        scaleY: this.scale * 1.12,
        duration: 420,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }
  }

  /** 静态工厂：朝目标发射（保留兼容，内部转为水平弹道） */
  static fireAt(
    scene: Phaser.Scene,
    fromX: number,
    fromY: number,
    targetX: number,
    _targetY: number,
    damage: number,
    worldBounds: Phaser.Geom.Rectangle
  ): Bullet {
    const dir: 1 | -1 = targetX >= fromX ? 1 : -1;
    return new Bullet(scene, fromX, fromY, dir, damage, worldBounds);
  }
}
