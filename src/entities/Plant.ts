/**
 * 植物实体。
 * 承担三种类型的行为差异：射手定时开火、墙阻挡子弹、减速提供范围减速。
 * 开火通过回调交给 GameScene 生成子弹，实体本身不直接操作场景中的其他对象。
 */

import Phaser from 'phaser';
import { PLANT_TYPES, type PlantConfig, type PlantType } from '../data/plants';
import { PLANT_RIG_ASSETS, PlantRig } from './PlantRig';
import { PLANT_SINGLE_TEX_WIDTH } from '../config';

export interface PlantSpawnArgs {
  scene: Phaser.Scene;
  x: number;
  y: number;
  type: PlantType;
  col: number;
  row: number;
    /** 计时器回调：请求发射子弹 */
  onFire: (plant: Plant) => void;
  /** 植物被摧毁（血归零）时的回调：用于掉落道具等 */
  onDestroyed?: (plant: Plant) => void;
}

export class Plant extends Phaser.Physics.Arcade.Sprite {
  readonly type: PlantType;
  readonly config: PlantConfig;
  /** 所在格 */
  readonly col: number;
  readonly row: number;

    hp: number;
  maxHp: number;

  /**
   * 基础最大血量（不含随时间成长的加成）。
   * maxHp = baseMaxHp + 当前时间档位的 HP 加成，见 applyHpRamp。
   */
  private baseMaxHp: number;

  /** 当前已应用的「时间成长」血量加成（避免重复叠加） */
  private hpRampBonus = 0;
  /** 是否为特殊个体（每 30 秒强化一株） */
  private elite = false;
  /** 特殊个体额外生命值 */
  private eliteHpBonus = 0;

  /** 剩余开火冷却（毫秒） */
  protected fireCooldown = 0;

  /**
   * 朝向：1 朝右 / -1 朝左。
   * PvZ 的豌豆射手只攻击「同一行、位于自己前方」的僵尸。
   * 素材默认朝右，因此朝左时 flipX = true。
   */
  facing: 1 | -1 = 1;

  /** 当前是否处于「发现目标、准备开火」姿态（用于开火动画节流） */
  protected aiming = false;

  /** 是否已进入销毁流程（阻止开火 tween 抢占 scale） */
  protected dying = false;

  protected onFire: (plant: Plant) => void;

  /** 被摧毁回调（掉落道具用） */
  protected onDestroyed?: (plant: Plant) => void;

    /** 是否已经触发过 onDestroyed（保证只触发一次） */
  private destroyedNotified = false;

  /**
   * 本次销毁是否由「僵尸啃食」造成。
   *
   * 只用来决定掉不掉道具：道具应只在「啃食植物后掉落」，
   * 被弹球/回力镖/链锯等远程打死的植物不掉。
   * 由 CombatSystem 在致命那一口之前打标，然后立即销毁读取。
   */
  private killedByBite = false;

    /** 标记「这次啃食是致命的」，供 onDestroyed 判断是否掉落 */
  markKilledByBite(): void {
    this.killedByBite = true;
  }

  /** 撤销致命标记（这一口没啃死时调用） */
  unmarkKilledByBite(): void {
    this.killedByBite = false;
  }

  /** 是否由啃食致死（onDestroyed 回调里读取） */
  get wasKilledByBite(): boolean {
    return this.killedByBite;
  }

  /**
   * 头顶血条。
   *
   * 用 Graphics 每帧重绘而不是切一张贴图：
   * 血条要随血量实时变化，Graphics 重画只有两次 fillRect，
   * 比来回 setScale/tween 更省事也更直观。
   *
   * 不放倒 Container 里、而是作为独立 Graphics 跟随本体的世界坐标，
   * 是因为 Sprite 自身会被 setScale / setFlipX 影响，
   * 挂子对象的话血条也会跟着缩放翻转，宽度会忽大忽小。
   */
  protected hpBar?: Phaser.GameObjects.Graphics;

  /**
   * 分层骨骼渲染器（有分部件素材的植物才有）。
   *
   * 为什么要有它：
   *   单张贴图只能整株平移，看着像贴纸。拆成 根/茎/头 之后
   *   茎能摇、头能点，整株才会「自己扭动」。
   *
   * 启用 rig 时，本 Sprite 自身的贴图会被隐藏（但仍保留物理体
   * 与血量逻辑），视觉完全交给 rig 输出。
   */
  protected rig?: PlantRig;

  /**
   * 血条相对植物的垂直偏移（像素，负值向上）。
   *
   * 分层立绘整株约 45.6px 高；rig 的原点在根底、又整体下压 14px，
   * 于是头顶大致落在「格心 - 32」处。血条再往上抬 10px 悬在头顶上方，
   * 既不会压住叶子，也不会飘得离植物太远。
   */
  private static readonly HP_BAR_OFFSET_Y = -42;

  /** 血条尺寸 */
  private static readonly HP_BAR_WIDTH = 44;
  private static readonly HP_BAR_HEIGHT = 5;

  constructor(args: PlantSpawnArgs) {
    super(args.scene, args.x, args.y, PLANT_TYPES[args.type].textureKey);

    this.type = args.type;
    this.config = PLANT_TYPES[args.type];
    this.col = args.col;
    this.row = args.row;
    this.onFire = args.onFire;
    this.onDestroyed = args.onDestroyed;

        this.hp = this.config.hp;
    this.maxHp = this.config.hp;
    this.baseMaxHp = this.config.hp;

    args.scene.add.existing(this);
    args.scene.physics.add.existing(this, true); // 静态体

        this.setOrigin(0.5, 0.5);
    this.setDepth(10);

    // ---- 可选的垂直微调（仅视觉，不影响占格）----
    // 少数素材（如石墙）底座留白较多，按格心对齐会显得「浮」。
    // 这里按配置整体下移一点，并同步静态物理体，保证碰撞盒跟随视觉。
    const yOffset = this.config.yOffsetPx ?? 0;
    if (yOffset !== 0) {
      this.y += yOffset;
      const staticBody = this.body as Phaser.Physics.Arcade.StaticBody | null;
      staticBody?.updateFromGameObject();
    }


    // ---- 单贴图植物的尺寸归一化 ----
    //
    // 素材是 199x256 这种「原始像素」尺寸，如果只靠 config.scale=1，
    // 整株会按 1:1 画出来，比格子还大一大截（石墙、冷雾苔就是这样）。
    //
    // 所以这里统一用 setDisplaySize 压到 SINGLE_TEX_SIZE：
    // 按各自原始宽高比等比缩放，宽度对齐目标宽度，高度由比例决定。
    // 这样无论以后换什么尺寸的素材，都不会再出现「原图直接怼上去」。
    const tex = this.texture.getSourceImage() as { width: number; height: number };
    if (tex && tex.width > 0 && tex.height > 0) {
      const k = PLANT_SINGLE_TEX_WIDTH / tex.width;
      this.setDisplaySize(tex.width * k, tex.height * k);
    } else {
      // 兜底：拿不到原始尺寸时退回 config.scale
      this.setScale(this.config.scale);
    }

    // ---- 分层骨骼 ----
    //
    // 有分部件素材的类型（基础射手 / 冻蔓射手）走 rig：
    // 隐藏本 Sprite 的贴图（它只留作物理体与血量载体），
    // 由 PlantRig 用 根/茎/头 三张图拼出会扭动的植株。
    //
    // 没有部件素材的类型（墙 / 冷雾苔）保持单张贴图，逻辑不变。
    const rigAssets = PLANT_RIG_ASSETS[this.type];
    if (rigAssets) {
      this.setVisible(false);
      this.rig = new PlantRig(
        args.scene,
        args.x,
        args.y,
        rigAssets.layout,
        rigAssets.textures
      );
      this.rig.syncBase(args.x, args.y);
    } else {
      // 出生动画（仅单贴图类型需要；rig 自带生长后的稳态姿态）
      //
      // 这里不能再用 config.scale：经过上面的 setDisplaySize 归一化后，
      // 当前 scaleX/scaleY 已经是「归一化后的值」，直接拿 config.scale
      // 当目标是错的。记下归一化结果，再从 20% 弹回 100%。
      const targetX = this.scaleX;
      const targetY = this.scaleY;
      this.setScale(targetX * 0.2, targetY * 0.2);
      args.scene.tweens.add({
        targets: this,
        scaleX: targetX,
        scaleY: targetY,
        duration: 260,
        ease: 'Back.easeOut'
      });
    }

    // 射手初始冷却随机偏移，避免所有植物同时开火
    if (this.config.fireInterval > 0) {
      this.fireCooldown = Phaser.Math.Between(
        200,
        this.config.fireInterval
      );
    }

    this.createHpBar();
  }

  /**
   * 创建头顶血条。
   *
   * 满血时不显示 —— 只有挨过咬之后才出现，
   * 避免整片草地上一排血条糊成一片。
   */
  protected createHpBar(): void {
    const scene = this.scene;
    if (!scene) return;

    this.hpBar = scene.add.graphics();
    // 血条画在本体之上，但低于 HUD
    this.hpBar.setDepth(this.depth + 1);
    this.hpBar.setVisible(false);
    this.drawHpBar();
  }

  /** 重画血条（位置 + 填充长度） */
  protected drawHpBar(): void {
    const g = this.hpBar;
    if (!g) return;

    const w = Plant.HP_BAR_WIDTH;
    const h = Plant.HP_BAR_HEIGHT;
    const x = this.x - w / 2;
    const y = this.y + Plant.HP_BAR_OFFSET_Y;

    g.clear();

    // 背板：深色半透明，保证任何背景下都看得清
    g.fillStyle(0x000000, 0.55);
    g.fillRect(x - 1, y - 1, w + 2, h + 2);

    // 底槽
    g.fillStyle(0x3a1a1a, 1);
    g.fillRect(x, y, w, h);

    // 血量比例
    const ratio = Phaser.Math.Clamp(this.hp / Math.max(1, this.maxHp), 0, 1);
    if (ratio > 0) {
      // 颜色随血量变化：绿 -> 黄 -> 红
      let color = 0x4ade80;
      if (ratio <= 0.3) color = 0xef4444;
      else if (ratio <= 0.6) color = 0xfacc15;

      g.fillStyle(color, 1);
      g.fillRect(x, y, w * ratio, h);
    }

    // 描边：让血条边缘更利落
    g.lineStyle(1, 0x000000, 0.7);
    g.strokeRect(x, y, w, h);
  }

  /** 血条跟随本体（销毁动画期间本体在缩放/位移，血条要跟着走） */
  protected syncHpBar(): void {
    if (!this.hpBar) return;
    // 满血且从未受伤：不显示
    const damaged = this.hp < this.maxHp;
    this.hpBar.setVisible(damaged && this.active && !this.dying);
    if (this.hpBar.visible) this.drawHpBar();
  }

  /**
   * 每帧更新。
   *
   * 射手逻辑（对齐 PvZ 豌豆射手）：
   *  1. 只要僵尸落在「同一行」或「同一列」（十字形）就开火；
   *  2. 开火前把自己的朝向转向僵尸所在方向；
   *  3. 冷却只在有目标时才推进，没目标时保持满冷却立即响应。
   *
   * @param delta 帧间隔毫秒
   * @param player 玩家（僵尸），可为空
   * @param cellSize 单格像素，用于判定「同一行」
   */
  update(delta: number, player: Phaser.GameObjects.Sprite, cellSize = 64): void {
    // 骨骼动画每帧推进（哪怕没目标也要推进，待机时它在慢慢扭）
    this.rig?.syncBase(this.x, this.y);
    this.rig?.update(delta);

    // 血条每帧跟随本体位置（本体可能被 tween 移动/缩放）
    this.syncHpBar();

    if (!this.active) return;

    // 销毁中：不再开火，避免开火 tween 与销毁 tween 互相抢 scale
    if (this.dying) return;

    // 墙 / 减速苔不攻击
    if (this.config.fireInterval <= 0) return;
    if (!player || !player.active) return;

    // ---- 永远正对僵尸 ----
    //
    // 不管僵尸在不在同一行/同一列，都先转头面向它：
    // 植物是「活物」，眼神/发射口跟着目标走才不显得呆。
    // 这一步放在 hasTarget 判定之前，所以即使不在射程内也会朝向。
    this.updateFacing(player);

    // 目标判定：十字形（整行 + 整列）
    const hasTarget = this.hasTargetInCross(player, cellSize);

    if (!hasTarget) {
      // 无目标：冷却保持在就绪状态
      this.fireCooldown = 0;
      this.aiming = false;
      return;
    }

    // 首次发现目标：给一个短暂的「预备」延迟，避免瞬发
    if (!this.aiming) {
      this.aiming = true;
      this.fireCooldown = Math.max(this.fireCooldown, 120);
      return;
    }

    this.fireCooldown -= delta;
    if (this.fireCooldown > 0) return;

    // 重置冷却并开火
    this.fireCooldown = this.config.fireInterval;
    this.onFire(this);

    // 开火反馈
    if (this.rig) {
      // 分层植物：整株前倾 + 快速点头，比拉缩放自然得多
      this.rig.playFire();
    } else {
      // 单贴图植物：只能靠轻微缩放表达「发力」
      this.scene.tweens.add({
        targets: this,
        scaleX: this.scaleX * 0.88,
        scaleY: this.scaleY * 1.1,
        duration: 80,
        yoyo: true,
        ease: 'Quad.easeOut'
      });
    }
  }

  /**
   * 十字形射击判定。
   *
   * 判定区域是以本植物为交点的一个「十」字：
   *   ── 横臂：同一整行（row 相同），不论列
   *   │  纵臂：同一整列（col 相同），不论行
   *
   * 只要僵尸落在横臂或纵臂上，就认为有目标、开始射击。
   *
   * 为什么不是「同一行且在前方」：
   *   这样植物只能打到自己正前方的一条线，僵尸从斜边靠近时
   *   会出现明明看得见却不开火的空窗。十字判定让整行整列都覆盖，
   *   交叉点周围不留死角，守起来更符合塔防直觉。
   *
   * 用格坐标判定而非像素距离 —— 僵尸是逐格突进的，
   * 格坐标才是稳定真相；像素 y 在动画颠簸时会抖动。
   * 敌人在两格之间移动时 cellRow/cellCol 已经指向目标格，
   * 所以判定会提前一格生效，不会漏。
   *
   * fallback：若对方没暴露格信息，退化为像素十字（行高/列宽的一半容差）。
   */
  private hasTargetInCross(player: Phaser.GameObjects.Sprite, cellSize: number): boolean {
    const anyPlayer = player as unknown as {
      cellRow?: number;
      cellCol?: number;
      isDead?: boolean;
    };

    if (anyPlayer.isDead || !player.active) return false;

    // ---- 优先用格坐标 ----
    if (typeof anyPlayer.cellRow === 'number' && typeof anyPlayer.cellCol === 'number') {
      const sameRow = anyPlayer.cellRow === this.row;
      const sameCol = anyPlayer.cellCol === this.col;
      // 同一行 或 同一列 —— 就是「十字」的两条臂
      return sameRow || sameCol;
    }

    // ---- 退化：像素十字 ----
    const half = cellSize / 2;
    const sameRowPx = Math.abs(player.y - this.y) <= half;
    const sameColPx = Math.abs(player.x - this.x) <= half;
    return sameRowPx || sameColPx;
  }

  /**
   * 决定射击方向。
   *
   * 有了十字判定之后，植物不再「跟着僵尸转头」——
   * 那样僵尸绕到另一侧时朝向会来回翻，子弹方向也飘。
   *
   * 现在取「僵尸相对本植物所在的方向」，但这只用来决定
   * 沿哪条臂开火：僵尸在同一行就横着打，在同一列就竖着打。
   * 同列时没有左右之分，默认朝左（僵尸来的方向）。
   */
  private updateFacing(player: Phaser.GameObjects.Sprite): void {
    // ---- 只按「僵尸在左还是在右」判断 ----
    //
    // 不再用格坐标：植物要「永远正对」僵尸，而格坐标只在
    // 同一行/列时才稳定，僵尸绕到斜角时反而会僵在原地不转头。
    // 直接用像素 x 比较，任何位置都能立刻转过去。
    //
    // 加一个很小的死区（2px）：僵尸正好压在中线上时不至于每帧来回翻，
    // 否则会出现「抽搐式抖动」。
    const dx = player.x - this.x;
    if (Math.abs(dx) < 2) return;

    const dir: 1 | -1 = dx > 0 ? 1 : -1;

    if (dir !== this.facing) {
      this.facing = dir;
      // 单贴图植物：素材朝左，所以 facing=-1（朝左）时不该翻。
      this.setFlipX(dir === 1);
      // rig 是独立容器，Sprite 的 flipX 管不到它，必须单独通知。
      // rig 内部也按「素材朝左」做了取反，这里传的是「想朝哪边」。
      this.rig?.setFacing(dir);
    }
  }

  /** 当前是否在瞄准（供外部调试） */
  get isAiming(): boolean {
    return this.aiming;
  }

  /** 是否为特殊个体 */
  get isElite(): boolean {
    return this.elite;
  }

  /** 特殊个体攻击加成后的伤害 */
  damageFor(base: number): number {
    return Math.max(1, Math.round(base * (this.elite ? 1.15 : 1)));
  }

  /**
   * 升级为特殊个体：体型 +20%、攻击 +15%、生命 +100。
   * 只在存活且未强化时生效，避免每 30 秒重复叠同一株。
   */
  makeElite(): boolean {
    if (!this.active || this.dying || this.elite) return false;
    this.elite = true;
    this.eliteHpBonus += 100;
    this.baseMaxHp += 100;
    this.maxHp = this.baseMaxHp + this.hpRampBonus;
    this.hp += 100;
    this.syncHpBar();

    if (this.rig) {
      this.rig.setScale(this.rig.scaleX * 1.2, this.rig.scaleY * 1.2);
    } else {
      this.setScale(this.scaleX * 1.2, this.scaleY * 1.2);
    }

    // 特殊个体只用体型区分，不染色；避免和僵尸无敌星的金色混淆
    return true;
  }

    /**
   * 应用「随时间成长」的最大生命加成。
   *
   * @param bonus 目标加成值（例如每 30 秒 +50，则 90 秒时传 150）
   *
   * 只增不减；重复调用同一档位不会重复加血。
   * 加血同时把当前血量也抬高同样的差值（而不是回满），
   * 这样正在被啃的植物不会因为这波成长反而「满血复活」。
   */
  applyHpRamp(bonus: number): void {
    if (!this.active || this.dying) return;
    const target = Math.max(0, Math.floor(bonus));
    if (target === this.hpRampBonus) return;

    const delta = target - this.hpRampBonus;
    this.hpRampBonus = target;
    this.maxHp = this.baseMaxHp + this.eliteHpBonus + target;
    if (delta > 0) this.hp += delta;
    // 立即刷新血条，避免显示延迟
    this.syncHpBar();
  }

  /** 承伤，返回是否被摧毁 */
  takeDamage(amount: number): boolean {
    if (!this.active || this.dying) return false;
    this.hp -= amount;

    this.setTintFill(0xffffff);
    this.scene?.time.delayedCall(60, () => {
      if (this.active) this.clearTint();
    });

    // 立刻刷新血条，不等下一帧，避免视觉延迟
    this.syncHpBar();

    if (this.hp <= 0) {
      this.destroyPlant();
      return true;
    }
    return false;
  }

  /** 被摧毁（带消失动画） */
  destroyPlant(): void {
        if (!this.active || this.dying) return;
    this.dying = true;

    // 通知外部（掉落道具等）。用独立标志保证即使 destroyPlant 被重入也只触发一次。
    if (!this.destroyedNotified) {
      this.destroyedNotified = true;
      try {
        this.onDestroyed?.(this);
      } catch (err) {
        console.error('[Plant] onDestroyed 回调异常:', err);
      }
    }

    const scene = this.scene;

    // 植物被啃掉：血条也没有存在的意义了，立即隐藏并销毁
    this.hpBar?.setVisible(false);
    this.hpBar?.destroy();
    this.hpBar = undefined;

    // 关键：先清掉这个对象上所有已有 tween（尤其是开火缩放），
    // 否则 yoyo 回弹会把 scale 拉回原值，导致植物永远不消失。
    scene.tweens.killTweensOf(this);

    // 分层植物的消失动画作用在 rig 容器上（Sprite 本身是不可见的）
    const visual: Phaser.GameObjects.GameObject = this.rig ?? this;

    scene.tweens.add({
      targets: visual,
      scaleX: 0,
      scaleY: 0,
      alpha: 0,
      duration: 180,
      ease: 'Quad.easeIn',
      onComplete: () => {
        // 可能已被 destroyAll 提前销毁，判空避免二次 destroy
        if (this.active) this.destroy();
      }
    });
  }

  /**
   * 覆写 destroy：确保无论从哪里销毁（啃食 / destroyAll / 场景切换），
   * 头顶那枚独立的 Graphics 都会被一起带走，否则会留在画面上变成鬼影。
   */
  destroy(fromScene?: boolean): void {
    this.hpBar?.destroy();
    this.hpBar = undefined;

    // rig 是独立的 Container，Sprite 销毁不会带走它，必须手动清理，
    // 否则画面上会留下一株不会动的残影。
    this.rig?.destroy(fromScene);
    this.rig = undefined;

    super.destroy(fromScene);
  }

  /** 是否正在销毁中（已被吃或已被子弹击破） */
  get isDying(): boolean {
    return this.dying;
  }

  /** 是否阻挡子弹 */
  get blocksBullet(): boolean {
    return this.config.blocksBullet;
  }

  /** 是否提供减速 */
  get providesSlow(): boolean {
    return this.config.slowRadius > 0;
  }

  /** 获取自身像素半径（用于距离判定） */
  getRadius(): number {
    return (this.displayWidth * 0.5) * 0.8;
  }
}
