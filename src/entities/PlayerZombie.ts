/**
 * 玩家僵尸。
 * 负责移动、朝向、啃食状态与帧切换、受伤与进化后的属性刷新。
 * 状态用简单枚举 + switch，不引入通用状态机。
 */

import Phaser from 'phaser';
import { PLAYER_ZOMBIE } from '../data/zombies';
import { ASSET_KEYS, ASSET_SIZES, DASH, EVOLUTION_STAGES, ZOMBIE_ANIM } from '../config';
import { clamp } from '../utils';
import { ZombieRig } from './ZombieRig';

export enum ZombieState {
  Idle = 'idle',
  Moving = 'moving',
  Eating = 'eating',
  Dead = 'dead'
}

export class PlayerZombie extends Phaser.Physics.Arcade.Sprite {
  /** 当前血量 */
  hp = PLAYER_ZOMBIE.hp;
  /** 最大血量（= maxHpBase + maxHpBonus） */
  maxHp = PLAYER_ZOMBIE.hp;
  /**
   * 基础最大血量：进化阶段血量 / 满级成长后的基准值。
   * 与 maxHpBonus 之和即为当前 maxHp。
   */
  private maxHpBase = PLAYER_ZOMBIE.hp;
  /**
   * 基础上限之外的额外上限（吃植物成长累计而来）。
   *
   * maxHp = maxHpBase + maxHpBonus。
   * 进化/成长只改 maxHpBase，bonus 恒被保留，因此吃出来的上限不会被覆盖。
   */
  private maxHpBonus = 0;
  /** 当前移动速度 */
  speed = PLAYER_ZOMBIE.speed;
  /**
   * 啃食单口伤害（「攻击力」）。
   *
   * 默认 25，与 data/plants.ts 的 PLANT_BITE_DAMAGE 一致（不在此直接 import
   * 以免实体层与植物数据层耦合）。商店「永久攻击力」会提升它，
   * CombatSystem 每口读取此值作为伤害。
   */
  biteDamage = 25;
  /** 进化前的基础啃食伤害（商店成长只改这里，进化倍率单独乘） */
  private biteBaseDamage = 25;
  /** 每次进化 +50% 的啃食伤害倍率 */
  private evolutionBiteMultiplier = 1;
  /** 当前进化阶段索引（0 起） */
  evolutionIndex = 0;
  /** 当前状态 */
  state: ZombieState = ZombieState.Idle;

  /**
   * 最近一次的水平朝向：1 右 / -1 左
   * 注意：素材 artwork 本身画的是“朝右”（耳朵在 x=41~45）。
   * 因此朝右时不翻转，朝左时 flipX=true。
   */
  facing: 1 | -1 = 1;

  /** 最近一次方向输入（用于前方两格攻击；支持上下左右） */
  private facingDc = 1;
  private facingDr = 0;

  /** 啃食剩余时间（毫秒），>0 表示正在啃 */
  private eatingTimer = 0;
  /** 被动光环减速倍率（由周围减速植物决定），1 表示不受影响 */
  private auraSlowMultiplier = 1;

  /**
   * 子弹（寒冰射手）造成的限时减速。
   *
   * 与被动光环的区别：
   *   - 光环：只要在范围内就持续生效，每帧由 GameScene.applySlow() 写入；
   *   - 子弹：命中后独立计时，到期自动解除，期间即使离开光环也仍然减速。
   *
   * 两者取「更强」的一个叠加，而不是相乘 —— 否则寒冰豌豆同时吃到
   * 冷雾苔光环会出现 0.5 * 0.6 = 0.3 这种超预期减速。
   */
  private bulletSlowMultiplier = 1;
  /** 子弹减速剩余时间（毫秒） */
  private bulletSlowTimer = 0;

  /**
   * 「冻蓝闪光」的请求序号。
   * 连续命中时用它判断哪一次闪蓝是「最新」的，避免旧定时器提前清掉新闪光。
   */
  private freezeFlashToken = 0;

  /** 最终生效的减速倍率（每帧按上面两者计算） */
  private slowMultiplier = 1;

  // ---------------------------------------------------------- 格点步进移动
  //
  // 灵感来自《植物大战僵尸》：僵尸不会「斜着走」，也不会在格子里自由乱窜，
  // 而是沿着格子一路直行，一次只朝一个方向。
  //
  // 实现：玩家始终锚定在某个格心（from 格），按键决定目标格（to 格）；
  // 只有在两格之间的插值完成后才允许下一次转向。
  //   - 同时按下两个方向键时，只取「优先级更高」的那一个（水平优先），
  //     因此天然不可能出现斜向速度。
  //   - 移动速度只线性影响走完一格的耗时，不影响判定。

  /** 当前所处格（冲刺期间指「出发格」，冲刺结束才更新为目标格） */
  private fromCol = 0;
  private fromRow = 0;
  /** 本次冲刺目标格（用于中途快速转向时判断离哪一端更近） */
  private toCol = 0;
  private toRow = 0;
  /** 本次冲刺方向 */
  private dashDc = 0;
  private dashDr = 0;
  /** 本次冲刺开始时间（scene time），用于过滤同帧抖动 */
  private dashStartedAt = 0;

  /**
   * 移动锁：true 表示正在冲刺途中。
   *
   * 这是「不允许停在半格」的核心保证 —— 冲刺是不可中断的原子操作，
   * 期间一律忽略新的方向输入。玩家不可能靠松手/反向卡在格子边缘。
   */
  private isMoving = false;

  /** 当前冲刺的 Tween（用于被打断/销毁时清理，避免回调操作已死对象） */
  private dashTween?: Phaser.Tweens.Tween;

  /**
   * 输入缓冲：冲刺途中按下的方向，等本次冲刺落地后立即接上。
   *
   * 没有它的话，连按两次方向键时第二次会被 isMoving 直接吞掉，
   * 手感会变成「按十下走五格」。有了缓冲，按住不放就能连续突进。
   */
  private bufferedDir: { dc: number; dr: number } | null = null;

  /** 本次冲刺实际耗时（毫秒），受减速/进化影响 */
  private dashDuration: number = DASH.durationMs;

  /** 该格是否可通行（由外部注入，防止走进房屋 / 越界） */
  private canEnter: (col: number, row: number) => boolean;

  /** 该格是否有植物碰撞体积（由外部注入；穿过时减速 25%） */
  private isPlantAt?: (col: number, row: number) => boolean;

  /** 植物碰撞减速倍率：1 = 不受影响，0.75 = 穿过植物减速 25% */
  private plantSlowMultiplier = 1;

  /** 边界限制矩形（世界像素） */
  private boundsRect: Phaser.Geom.Rectangle;

  // ---------------------------------------------------------- 程序化动画
  //
  // 不切图、不用序列帧。原因：
  //   1. 只有一张完整立绘，切图会切断手臂/腿的连续性，产生接缝；
  //   2. AI 生成的序列帧会导致体型漂移、细节崩坏；
  //   3. PvZ 僵尸本身就是「木偶式」动作 —— 摇摆、颠簸、点头，
  //      这些用 sin/cos 表达比手绘帧更精确，且永远不会形变。
  //
  // 这里的变换只作用于「视觉」，不写回 this.x / this.y，
  // 因此格点步进逻辑与物理判定完全不受影响。

  /** 动画时钟（毫秒）。按减速倍率缩放，所以被冰冻时动起来也会变慢 */
  private animTime = 0;

  /**
   * 视觉垂直偏移（像素）。
   *
   * 上下颠簸用 setY 直接改坐标会污染步进逻辑，
   * 所以单独记一份偏移，只在渲染时叠加，并在 syncBodyPosition 里补偿掉。
   */
  private visualOffsetY = 0;

  /** 当前摇摆角度（度），供死亡等状态平滑接管 */
  private currentSwayDeg = 0;

  /** 死亡动画的进度 0..1 */
  private deathProgress = 0;

  /** 快速操作时的动画加速截止时间（scene time） */
  private animBoostUntil = 0;
  /** 上一次方向输入时间，用于判断是否“连点” */
  private lastInputAt = 0;
  /** 快速操作时动画/摇摆频率倍率 */
  private static readonly RAPID_ANIM_RATE = 1.4;

  /**
   * 逻辑位置（动画偏移之前的真实坐标）。
   *
   * 步进逻辑只读写这两个值；this.x / this.y 是「逻辑位置 + 视觉偏移」，
   * 纯渲染用途。两者分离后，摇摆与颠簸永远不会污染路径判定。
   */
  private logicalX = 0;
  private logicalY = 0;

  /** 本帧的视觉偏移（像素），由动画计算 */
  private renderOffsetX = 0;
  private renderOffsetY = 0;

  /** 进化带来的基准缩放（不含呼吸缩放） */
  private baseScaleX = 1;
  private baseScaleY = 1;

  /**
   * 分部件骨骼渲染器。
   *
   * 本实体自身不再显示贴图（setVisible(false)），只作为物理体与逻辑坐标载体；
   * 真正画出来的是这个 rig —— 六个部件各自绕关节旋转，做出「真走路」的姿态。
   * rig 每帧跟随 logicalX / logicalY 摆放。
   */
  private rig!: ZombieRig;

  /**
   * 头顶耐久条（生命值）。
   * 跟随僵尸，展示当前 hp / maxHp，给玩家即时的「还能挨几下」反馈。
   */
  private durabilityBar?: Phaser.GameObjects.Graphics;
  /** 耐久条上一次绘制的百分比，避免每帧重绘 */
  private lastDurabilityRatio = -1;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    bounds: Phaser.Geom.Rectangle,
    startCol: number,
    startRow: number,
    canEnter: (col: number, row: number) => boolean,
    isPlantAt?: (col: number, row: number) => boolean
  ) {
    super(scene, x, y, ASSET_KEYS.zombieIdle);

    this.boundsRect = bounds;
    this.canEnter = canEnter;
    this.isPlantAt = isPlantAt;

    this.fromCol = startCol;
    this.fromRow = startRow;
    this.isMoving = false;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(20);

    // 顺序很重要：先定 origin 与显示尺寸，再配置 body。
    // 否则 setSize/setOffset 会基于默认纹理尺寸计算，导致判定框错位。
    //
    // 锚点放在「脚底中心」：僵尸的 y 坐标即它站立的地面位置，
    // 这样移动/摇摆时脚始终贴着格子，不会看起来飘在空中。
    this.setOrigin(0.5, 1);

    // 用 setScale 而不是 setDisplaySize。
    //
    // setDisplaySize 会把 displayWidth/Height 固定死，
    // 而呼吸动画每帧都要在此基础上乘一个系数；
    // 用缩放表达，动画只是改 scaleX/scaleY，语义清晰且可叠加。
    const texW = this.width || ASSET_SIZES.zombie.width;
    const texH = this.height || ASSET_SIZES.zombie.height;
    const baseSX = ASSET_SIZES.zombie.width / texW;
    const baseSY = ASSET_SIZES.zombie.height / texH;
    this.setScale(baseSX, baseSY);

    this.baseScaleX = baseSX;
    this.baseScaleY = baseSY;

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(PLAYER_ZOMBIE.bodyWidth, PLAYER_ZOMBIE.bodyHeight);

    // offset 相对「贴图左上角」，单位是贴图原始像素。
    //
    // 贴图 48x112，躯干实测范围 x 10..36、y 30..84。
    // 判定框 26x52 水平居中放在躯干上：
    //   x = (48 - 26) / 2 = 11
    //   y = 30              （从肩下开始，跳过张开的双臂）
    // 判定框的纵向位置必须与「子弹飞行高度」对齐。
    //
    // 这里踩过一个坑：原先把 offset 设为 texH * 0.27，
    // 判定框落在贴图 27%~73% 的高度（躯干上部）。
    // 但豌豆是贴着格子中心水平飞行的 —— 换算到贴图坐标是
    // 约 92% 的高度（脚踝附近）。两者差了半个身位，
    // 结果就是子弹从僵尸胯下飞过，永远打不中。
    //
    // 现在把判定框整体下移，覆盖「躯干下部 ~ 脚底」：
    //   offset = texH * 0.5，判定框占贴图 50%~96% 的高度，
    //   下沿正好压在脚底上，上沿到躯干中部。
    //   这样无论是贴地飞的豌豆（贴图 92% 高度），还是略高的攻击，
    //   都能稳定落在判定框内。
    body.setOffset(
      (texW - PLAYER_ZOMBIE.bodyWidth) / 2,
      Math.max(0, texH * 0.5)
    );
    body.setCollideWorldBounds(false);

    // 本实体的位置完全由格点步进驱动，物理引擎不得再对 body 做位置积分，
    // 否则 Arcade 的积分会和 syncBodyPosition 互相覆盖，把僵尸拖到天上。
    (body as unknown as { moves: boolean }).moves = false;

    // 默认九宫格方向的初始贴图
    this.setTexture(ASSET_KEYS.zombieIdle);

    // 记录逻辑坐标：x/y 后续会被视觉偏移临时改写，需要一份基准
    this.logicalX = this.x;
    this.logicalY = this.y;

    // 让物理体立即与初始位置对齐
    this.syncBodyPosition();

    // ---- 视觉交给 ZombieRig ----
    // 自身贴图隐藏：物理体、逻辑坐标、朝向判定都照旧工作，
    // 但画面上呈现的是 rig 的六个部件。
    // 这样原有一整套「格点步进 + 判定」代码一行都不用改。
    this.setVisible(false);

    this.rig = new ZombieRig(scene, this.logicalX, this.logicalY);
    this.rig.syncBaseY(this.logicalY);
    this.rig.setFacing(this.facing);

    // 头顶耐久条：一个 Graphics，每帧在 applyRenderOffset 里重定位与重绘
    this.durabilityBar = scene.add.graphics().setDepth(60);
  }

  // ------------------------------------------------------------ 手持道具挂载

  /** 僵尸的骨骼渲染器（供外部把道具挂到手上/脚上） */
  getRig(): ZombieRig {
    return this.rig;
  }

  /** 右手末端的当前世界坐标（发射弹球/回力镖的出手点） */
  getRightHandWorld(): { x: number; y: number } {
    return this.rig.getLimbTipWorld('armR');
  }

  /** 左手末端的当前世界坐标 */
  getLeftHandWorld(): { x: number; y: number } {
    return this.rig.getLimbTipWorld('armL');
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 每帧更新：格点步进移动 + 状态维护。
   *
   * 关键约束：同一时刻只可能有一个方向分量非零，因此不存在斜向移动。
   */
  update(delta: number, input: { x: number; y: number }): void {
    if (!this.active || !this.body) return;

    // 死亡后仍要跑动画（倒下过程），但不再接受输入、不再冲刺
    if (this.state === ZombieState.Dead) {
      this.updateAnimations(delta);
      this.applyRenderOffset();
      return;
    }

    const body = this.body as Phaser.Physics.Arcade.Body;
    // 坐标完全由冲刺逻辑驱动，物理体只做被动的碰撞容器
    body.setVelocity(0, 0);

    // 子弹减速计时必须每帧推进，与是否移动无关。
    // 否则僵尸站着不动时减速永远不过期，等于被永久减速。
    this.tickBulletSlow(delta);

    // 啃食计时（啃食期间不移动）
    if (this.eatingTimer > 0) {
      this.eatingTimer -= delta;
      if (this.eatingTimer <= 0) {
        this.eatingTimer = 0;
        this.state = ZombieState.Idle;
      }

      // 冲刺途中不能被打断去啃食 —— 等落地再说
      if (!this.isMoving) {
        this.state = ZombieState.Eating;
        this.syncBodyPosition();
        this.updateAnimations(delta);
        this.applyRenderOffset();
        return;
      }
    }

    // ---- 冲刺途中 ----
    //
    // logicalX / logicalY 由 Tween 逐帧推进，这里是「唯一真相源」，
    // 绝对不能被 this.x 覆盖 —— 否则 tween 的努力全部作废。
    // 我们只负责把 body 和渲染跟上。
    if (this.isMoving) {
      // 物理体跟着逻辑位置走 —— 途经的每一帧都能被子弹击中，没有无敌帧
      this.syncBodyPosition();

      this.state = ZombieState.Moving;
      this.updateAnimations(delta);
      this.applyRenderOffset();
      return;
    }

    // ---- 静止在格心 ----
    // 站在植物格里时持续减速；离开后恢复
    const onPlant =
      this.isPlantAt?.(this.fromCol, this.fromRow) ?? false;
    this.setPlantSlowMultiplier(onPlant ? 0.75 : 1);

    // 先接受新输入（若合法则开启一次冲刺）
    this.dashDuration = this.computeDashDuration();
    this.tryStartDash(input);

    if (this.isMoving) {
      this.syncBodyPosition();
      this.state = ZombieState.Moving;
      this.updateAnimations(delta);
      this.applyRenderOffset();
      return;
    }

    // 没动：强制吸附到格心，杜绝任何浮点残留把玩家留在格子边缘
    this.snapToCellCenter();
    this.syncBodyPosition();

    this.state = ZombieState.Idle;
    this.updateAnimations(delta);
    this.applyRenderOffset();
  }
  // ------------------------------------------------------------ 程序化动画

  /**
   * 推进动画时钟并应用视觉变换。
   *
   * 调用时机：update() 末尾，此时 this.x / this.y 已是本帧的最终逻辑位置。
   *
   * 状态差异：
   *   - Moving：左右摇摆（Sway）+ 上下颠簸（Bob）+ 前倾，频率跟着步子走
   *   - Idle  ：极慢的呼吸缩放 + 微幅歪斜，避免「立正」的僵硬
   *   - Eating：高频小幅度颤抖，模拟撕咬，并向前一顿一顿地探
   *   - Dead  ：倒下
   *
   * @param delta 帧间隔（毫秒）
   */
  private updateAnimations(delta: number): void {
    // 快速操作时短暂提高动画/摇摆频率，让手感跟得上连点；
    // 仍然与减速倍率相乘，冰缓时不会因为加速而完全抵消。
    const rapid = this.scene.time.now < this.animBoostUntil;
    const animDelta = delta * this.slowMultiplier * (rapid ? PlayerZombie.RAPID_ANIM_RATE : 1);

    // 动画时钟按减速倍率缩放：
    // 被寒冰减速时不仅走得慢，动作也一并变慢，观感才统一。
    this.animTime += animDelta;

    const t = this.animTime / 1000; // 秒

    // ---- 分部件骨骼动画 ----
    // 把状态映射到 rig 的动作模式，然后交给它自己算关节角度。
    // 减速时动作也一起变慢：delta 乘上 slowMultiplier。
    this.rig.setFacing(this.facing);
    this.rig.setAimDirection(this.facingDc, this.facingDr);
    this.rig.setMode(
      this.state === ZombieState.Moving
        ? 'walk'
        : this.state === ZombieState.Eating
          ? 'eat'
          : this.state === ZombieState.Dead
            ? 'dead'
            : 'idle'
    );
    this.rig.update(animDelta, this.speedRatioForAnim());

    // 骨骼动画已经在上面交给 rig 了，这里只保留一个「整体前探」的位移：
    // 啃食时每咬一口向前顿一下，这个位移作用在整具身体上，
    // 属于容器级别的运动，不适合塞进 rig 内部。
    let offsetX = 0;
    if (this.state === ZombieState.Eating) {
      const cfg = ZOMBIE_ANIM.eat;
      const chomp = Math.sin(t * Math.PI * 2 * cfg.chompHz);
      offsetX = this.facing * Math.abs(chomp) * cfg.lungePx * 0.5;
    }
    // 自身贴图已隐藏，不再需要给它设角度/缩放。
    // 只记录水平前探量，供 applyRenderOffset 叠加到 rig 上。
    this.renderOffsetX = offsetX;
    this.renderOffsetY = 0;
  }

  /**
   * 把视觉偏移实际作用到显示位置。
   *
   * 为什么单独一步：
   *   update() 里先用 this.x/this.y 完成步进与判定，
   *   全部算完后才把「摇摆/颠簸」叠加到显示坐标上。
   *   由于下一次 update() 会先把 x/y 还原回逻辑值，偏移不会累积。
   */
  private applyRenderOffset(): void {
    this.x = this.logicalX + this.renderOffsetX;
    this.y = this.logicalY + this.renderOffsetY;

    // rig 的脚底锚点跟着逻辑坐标走（不含 renderOffset，因为 rig 内部
    // 自己会做颠簸/下沉；只叠加「整体前探」那一项）。
    if (this.rig) {
      this.rig.syncBaseX(this.logicalX + this.renderOffsetX);
      this.rig.syncBaseY(this.logicalY);
    }

    this.updateDurabilityBar();
  }

  /**
   * 更新头顶耐久条的位置与填充。
   *
   * 位置跟随僵尸头顶（logical 坐标上方约一个身高），
   * 宽度随进化缩放略微增大。血量比例变化超过 1% 才重绘。
   */
  private updateDurabilityBar(): void {
    const bar = this.durabilityBar;
    if (!bar) return;

    if (this.state === ZombieState.Dead) {
      bar.setVisible(false);
      return;
    }
    bar.setVisible(true);

    const ratio = this.hpRatio;
    const scale = this.baseScaleY || 1;

    // 头顶位置：脚底( logicalY ) 上方约 90px × 缩放
    const headY = this.logicalY - 92 * scale;
    const cx = this.logicalX + this.renderOffsetX;
    const w = 44 * Math.min(1.25, Math.max(0.9, scale));
    const h = 5;
    const x = cx - w / 2;
    const y = headY;

    // 比例变化很小就跳过重绘（位置变化仍每帧跟随）
    if (Math.abs(ratio - this.lastDurabilityRatio) < 0.01) {
      // 只更新位置：整体平移比较麻烦，这里宁可重绘（成本很低）
    }
    this.lastDurabilityRatio = ratio;

    bar.clear();
    // 背板
    bar.fillStyle(0x000000, 0.55);
    bar.fillRoundedRect(x - 1, y - 1, w + 2, h + 2, 3);
    // 底槽
    bar.fillStyle(0x1b2430, 1);
    bar.fillRoundedRect(x, y, w, h, 2);
    // 填充
    const col = ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfbbf24 : 0xef4444;
    bar.fillStyle(col, 1);
    bar.fillRoundedRect(x, y, w * Math.max(0, Math.min(1, ratio)), h, 2);
    // 边框
    bar.lineStyle(1, 0x0a0f14, 0.8);
    bar.strokeRoundedRect(x, y, w, h, 2);
  }

  /** 是否正在冲刺途中（外部可用于判断「此刻是否可被打断」） */
  get isDashing(): boolean {
    return this.isMoving;
  }

  /**
   * 计算本次冲刺耗时。
   *
   * 基础是一个固定值（DASH.durationMs = 120ms），再按减速倍率放大。
   * 注意这里放大的是「时间」而不是「速度」——
   * 换成速度的话，被减速时一格又要走两秒，玩家又能停在半格上。
   * 时间最坏也就是 120 / 0.1 = 1200ms，仍是有限且可控的原子操作。
   */
  private computeDashDuration(): number {
    const slow = clamp(this.slowMultiplier, 0.1, 1);
    let duration = DASH.durationMs / slow;

    // 啃食残留期间冲得更慢一点，呼应 eatSpeedMultiplier 的语义
    if (this.eatingTimer > 0) duration /= PLAYER_ZOMBIE.eatSpeedMultiplier;

    return duration;
  }

  /**
   * 解析方向输入并尝试开启一次冲刺。
   *
   * 方向优先级：水平 > 垂直。
   * 即同时按下「右 + 下」时只会向右冲刺，不会斜走 ——
   * 这让「只能上下左右」成为结构上的保证，而不是靠约束。
   */
  private tryStartDash(input: { x: number; y: number }): void {
    let dc = 0;
    let dr = 0;

    if (input.x > 0) dc = 1;
    else if (input.x < 0) dc = -1;
    else if (input.y > 0) dr = 1;
    else if (input.y < 0) dr = -1;

    if (dc === 0 && dr === 0) return;

    // 朝向跟随水平方向（素材原本朝右）
    if (dc > 0) {
      this.facing = 1;
      if (this.flipX) this.setFlipX(false);
    } else if (dc < 0) {
      this.facing = -1;
      if (!this.flipX) this.setFlipX(true);
    }

    this.startDash(dc, dr);
  }

  /**
   * 执行一次格点冲刺。
   *
   * 全流程是原子的：
   *   1. 用「当前出发格 + 方向」算出目标格；
   *   2. 目标格非法（房屋/越界）就直接不动，玩家仍停在原格心；
   *   3. 合法则锁 isMoving，Tween 坐标到目标格心；
   *   4. 落地时强制吸附格心、解锁、并把缓冲的输入接上。
   *
   * 由于 2 保证了「不合法就不动」，4 保证了「落地必在格心」，
   * 玩家在任何时刻都只能处于某个格心，或两点之间的直线过渡上。
   */
  private startDash(dc: number, dr: number): void {
    if (this.isMoving) return;

    const nextCol = this.fromCol + dc;
    const nextRow = this.fromRow + dr;

    // 目标格必须可通行：越界、房屋一律拒绝
    if (!this.canEnter(nextCol, nextRow)) {
      this.bufferedDir = null;
      return;
    }

    const targetX = this.cellCenterX(nextCol);
    const targetY = this.cellCenterY(nextRow);

    // 目标格心算不出来（NaN）说明坐标注入有问题，宁可不动也不要把玩家送飞
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      this.bufferedDir = null;
      return;
    }

    this.toCol = nextCol;
    this.toRow = nextRow;
    this.dashDc = dc;
    this.dashDr = dr;
    this.dashStartedAt = this.scene.time.now;

    // 植物碰撞体积：当前格或目标格有植物时，本次冲刺减速 25%
    const currentHasPlant =
      this.isPlantAt?.(this.fromCol, this.fromRow) ?? false;
    const targetHasPlant = this.isPlantAt?.(nextCol, nextRow) ?? false;
    this.setPlantSlowMultiplier(currentHasPlant || targetHasPlant ? 0.75 : 1);
    this.dashDuration = this.computeDashDuration();

    this.isMoving = true;
    this.bufferedDir = null;

    // 起点固定为当前格心：即使因为浮点误差偏了一点，也从正中心出发，
    // 保证轨迹永远是「格心 → 格心」的直线，不会累积偏移。
    const startX = this.cellCenterX(this.fromCol);
    const startY = this.cellCenterY(this.fromRow);
    this.logicalX = startX;
    this.logicalY = startY;

    // 销毁上一次可能残留的 tween（理论上不会，但重开/复活时有概率）
    this.dashTween?.remove();

    // ---- 为什么 tween 驱动 logicalX / logicalY 而不是 this.x / this.y ----
    //
    // this.x / this.y 是「渲染位置 = 逻辑位置 + 视觉偏移」，
    // 每帧末尾都会被 applyRenderOffset() 覆写。
    // 如果 tween 去写 this.x，它写进去的值会立刻被覆写掉 ——
    // 表现为：僵尸看起来没动，但 logicalX 也没变，于是 body 停在原地，
    // 子弹自然永远打不中。
    //
    // 让 tween 只推进 logicalX / logicalY（唯一真相源），
    // 渲染位置由 applyRenderOffset 每帧从它派生，两者就不会打架。
    this.dashTween = this.scene.tweens.add({
      targets: this,
      logicalX: targetX,
      logicalY: targetY,
      duration: this.dashDuration,
      ease: DASH.ease,
      onUpdate: () => {
        // 每帧把 body 拽到当前逻辑位置：
        // 这样子弹在冲刺途中能正常判定命中，不存在无敌帧。
        this.syncBodyPosition();
      },
      onComplete: () => {
        this.dashTween = undefined;
        if (!this.active) return;

        // 落格：目标格成为新的出发格
        this.fromCol = nextCol;
        this.fromRow = nextRow;

        // 强制吸附格心 —— 这是「绝不停在边缘」的最后一道闸
        this.logicalX = this.cellCenterX(nextCol);
        this.logicalY = this.cellCenterY(nextRow);
        this.syncBodyPosition();

        this.isMoving = false;

        // 接上冲刺途中缓冲的方向，实现按住不放的连续突进
        const buffered = this.bufferedDir;
        this.bufferedDir = null;
        if (buffered) {
          this.dashDuration = this.computeDashDuration();
          this.startDash(buffered.dc, buffered.dr);
        }
      }
    });

    // 立即同步一次，让本帧就能参与碰撞判定
    this.syncBodyPosition();
  }

  /**
   * 缓冲一次方向输入（由外部在按键瞬间调用，而不是每帧轮询）。
   *
   * 之所以让 GameScene 在「按键按下那一刻」调用，
   * 是因为 update 是每帧轮询的：按住方向键时每帧都会读到输入，
   * 无法区分「刚按下」和「一直按着」。
   * 冲刺途中收到的新方向先记下来，等落地立刻执行，
   * 既不会丢输入，也不会让一次按键走两格。
   */
  bufferDirection(dc: number, dr: number): void {
    if (this.state === ZombieState.Dead) return;
    if (dc === 0 && dr === 0) return;

    // 方向输入即视为快速操作：连点会持续刷新加速窗口
    this.bumpAnimSpeed();
    this.setFacingDirection(dc, dr);

    if (!this.isMoving) {
      // 没在动：直接尝试，不必进缓冲
      if (dc > 0) {
        this.facing = 1;
        if (this.flipX) this.setFlipX(false);
      } else if (dc < 0) {
        this.facing = -1;
        if (!this.flipX) this.setFlipX(true);
      }
      this.dashDuration = this.computeDashDuration();
      this.startDash(dc, dr);
      return;
    }

    // 同方向连按：保留“落地后继续走”的连续冲刺
    if (dc === this.dashDc && dr === this.dashDr) {
      this.bufferedDir = { dc, dr };
      return;
    }

    // 不同方向：快速点击时允许中途转向，而不是等这一格走完
    if (this.scene.time.now - this.dashStartedAt >= 30) {
      this.tryQuickTurn(dc, dr);
    } else {
      this.bufferedDir = { dc, dr };
    }
  }

  /**
   * 冲刺中途快速转向。
   *
   * 网格移动不能斜着停在半格，所以先吸附到离当前逻辑位置更近的端点
   * （起点或目标格心），再从该格心向新方向冲刺。最多产生半格的位置修正，
   * 但换来了方向键连点时“立刻转向”的手感。
   */
  private tryQuickTurn(dc: number, dr: number): void {
    if (!this.isMoving) return;

    const startX = this.cellCenterX(this.fromCol);
    const startY = this.cellCenterY(this.fromRow);
    const endX = this.cellCenterX(this.toCol);
    const endY = this.cellCenterY(this.toRow);
    const dStart = Math.abs(this.logicalX - startX) + Math.abs(this.logicalY - startY);
    const dEnd = Math.abs(this.logicalX - endX) + Math.abs(this.logicalY - endY);

    // 离目标更近就吸附到目标格，否则回到出发格
    if (dEnd < dStart) {
      this.fromCol = this.toCol;
      this.fromRow = this.toRow;
    }

    this.dashTween?.remove();
    this.dashTween = undefined;
    this.isMoving = false;
    this.bufferedDir = null;
    this.snapToCellCenter();
    this.syncBodyPosition();

    if (dc > 0) {
      this.facing = 1;
      if (this.flipX) this.setFlipX(false);
    } else if (dc < 0) {
      this.facing = -1;
      if (!this.flipX) this.setFlipX(true);
    }

    this.dashDuration = this.computeDashDuration();
    this.startDash(dc, dr);
  }

  /** 取消当前冲刺并把玩家吸附回最近的格心（重开/复活时调用） */
  cancelDash(): void {
    this.dashTween?.remove();
    this.dashTween = undefined;
    this.bufferedDir = null;
    this.isMoving = false;
    this.snapToCellCenter();
    this.syncBodyPosition();
  }
  // ---------------------------------------------------------- 格坐标换算

  /** 单格像素尺寸（由 boundsRect 与格子函数共同决定，默认 64） */
  private cellSize = 64;

  /** 设置单格像素尺寸（GameScene 在创建后注入，保证与网格一致） */
  setCellSize(size: number): void {
    if (Number.isFinite(size) && size > 0) this.cellSize = size;
  }

  /** 由格子函数注入：格心 X */
  private cellCenterX: (col: number) => number = (col) => col * this.cellSize + this.cellSize / 2;
  /** 由格子函数注入：格心 Y */
  private cellCenterY: (row: number) => number = (row) => row * this.cellSize + this.cellSize / 2;

  /** 注入坐标换算函数（来自 GridSystem，避免实体反向依赖系统） */
  setCellMapping(
    centerX: (col: number) => number,
    centerY: (row: number) => number,
    cellSize: number
  ): void {
    this.cellCenterX = centerX;
    this.cellCenterY = centerY;
    this.setCellSize(cellSize);

    // 冲刺途中改换算表会把玩家拽回起点，等落地再对齐
    if (!this.isMoving) {
      this.snapToCellCenter();
      this.syncBodyPosition();
    }
  }

  /**
   * 把自身吸附到当前出发格的格心。
   *
   * 这是防线里的最后一环：无论冲刺结束、坐标注入变更、
   * 还是外部强行改了位置，只要调用它，玩家就必然站在格心上。
   * 只要玩家永远站在格心，就不可能出现「半格死角」。
   */
  private snapToCellCenter(): void {
    const x = this.cellCenterX(this.fromCol);
    const y = this.cellCenterY(this.fromRow);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      // 写逻辑坐标而不是 this.x —— logicalX/Y 是唯一真相源，
      // this.x 每帧由 applyRenderOffset 从它派生。
      this.logicalX = x;
      this.logicalY = y;
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  /**
   * 把自身位置写回物理体。
   *
   * 格点步进由我们自己改 this.x / this.y，必须手动同步 body，
   * 否则 Arcade 的 overlap 判定会用过期坐标，导致子弹打不中。
   *
   * 这里直接按「gameObject 左上角 + origin 偏移 + displaySize」计算 body 左上角。
   * 不用 body.reset()：reset 按 origin (0.5, 0) 语义对齐，而本实体 origin 是 (0.5, 1)，
   * 会整体上移一个贴图高度，造成判定框与视觉脱节。
   */
  /**
   * 当前速度相对基准速度的比值，用于让动画摆幅跟着速度走。
   *
   * 被减速时摆得小、走得快时摆得大，观感才和位移一致。
   * 取 0.6~1.8 区间，避免极端值把四肢甩飞。
   */
  private speedRatioForAnim(): number {
    if (PLAYER_ZOMBIE.speed <= 0) return 1;
    return clamp(this.speed / PLAYER_ZOMBIE.speed, 0.6, 1.8);
  }

  private syncBodyPosition(): void {
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (!body || !body.enable) return;

    // 速度由逻辑驱动，物理体始终保持 0，避免 Arcade 二次积分造成漂移
    if (body.velocity.x !== 0 || body.velocity.y !== 0) {
      body.setVelocity(0, 0);
    }

    // 统一用 originX/originY 取左上角（不要用 origin 常量，避免与缩放混淆）
    const ox = typeof this.originX === 'number' ? this.originX : 0.5;
    const oy = typeof this.originY === 'number' ? this.originY : 1;

    // 用「逻辑位置 + 真实贴图尺寸 × 基准缩放」计算判定框左上角。
    //
    // 这里必须用 this.width / this.height（贴图原始尺寸），
    // 而不是 ASSET_SIZES.zombie —— 后者是旧常量（46×108），
    // 与实际贴图（48×112）不一致，会让判定框整体偏移几个像素，
    // 表现为「子弹擦着身边飞过去却没命中」。
    //
    // 同时不能用 this.x / displayWidth：this.x 在动画阶段会被
    // 摇摆偏移改写，直接用会让判定框跟着抖动、忽大忽小。
    // 判定必须基于稳定的逻辑坐标。
    const texW = this.width || ASSET_SIZES.zombie.width;
    const texH = this.height || ASSET_SIZES.zombie.height;
    const logicW = texW * this.baseScaleX;
    const logicH = texH * this.baseScaleY;

    const goLeft = this.logicalX - ox * logicW;
    const goTop = this.logicalY - oy * logicH;

    // body 左上角 = gameObject 左上角 + body.offset
    //
    // 注意 1：offset 是相对「显示尺寸」度量的（Phaser 在 setDisplaySize 之后
    //         用 displayWidth/Height 计算 body 包围盒），因此这里不能再乘缩放。
    // 注意 2：Phaser 的 Body 只暴露 offset 向量，offsetX/offsetY 是其别名，
    //         只能加一次，否则判定框会整体偏移一倍。
    const offX = body.offset?.x;
    const offY = body.offset?.y;

    const bodyLeft = goLeft + (Number.isFinite(offX) ? offX : 0);
    const bodyTop = goTop + (Number.isFinite(offY) ? offY : 0);

    if (Number.isFinite(bodyLeft) && Number.isFinite(bodyTop)) {
      body.position.x = bodyLeft;
      body.position.y = bodyTop;
    }
  }

  /** 当前所在格（用于外部判定，如啃食） */
  get cellCol(): number {
    return this.fromCol;
  }

  get cellRow(): number {
    return this.fromRow;
  }

  /**
   * 手持点的世界坐标（供道具挂件——如手持电锯——跟随）。
   *
   * 取僵尸躯干前侧、「手抬起」的高度：横向偏向面朝方向、纵向在胸口。
   * 用逻辑坐标而不是渲染坐标，避免走动颠簸让道具抖成筛子；
   * 前探偏移由道具自己按需叠加。
   */
  getHandAnchor(): { x: number; y: number } {
    const forward = 18 * this.facing; // 向面朝方向探出
    const height = 44; // 胸口/抬起的手大致高度
    return { x: this.logicalX + forward, y: this.logicalY - height };
  }

  // ------------------------------------------------------------ 啃食

  /** 开始一次啃食动作，返回是否成功开始 */
  startEating(): boolean {
    if (this.state === ZombieState.Dead) return false;
    if (this.eatingTimer > 0) return false;
    this.eatingTimer = PLAYER_ZOMBIE.eatDuration;
    this.state = ZombieState.Eating;
    // 不切换贴图：啃食动作由 updateAnimations 的高频颤抖表现。
    return true;
  }

  /** 是否正在啃食 */
  get isEating(): boolean {
    return this.eatingTimer > 0;
  }

  /** 中断啃食（例如目标消失） */
  cancelEating(): void {
    if (this.state === ZombieState.Dead) return;
    this.eatingTimer = 0;
    this.state = ZombieState.Idle;
  }

  /** 连点/快速转向时刷新动画加速窗口 */
  private bumpAnimSpeed(): void {
    const now = this.scene.time.now;
    const rapid = now - this.lastInputAt < 260;
    this.lastInputAt = now;
    // 单次操作 280ms，连续操作持续续期；频率最多 1.4 倍
    this.animBoostUntil = now + (rapid ? 450 : 280);
  }

  /** 当前动画/摇摆频率倍率（测试/调试用） */
  get currentAnimationRate(): number {
    return this.scene.time.now < this.animBoostUntil
      ? PlayerZombie.RAPID_ANIM_RATE
      : 1;
  }

  // ------------------------------------------------------------ 属性

  /**
   * 设置被动光环减速倍率（由 GameScene.applySlow 每帧调用，1 = 正常）。
   * 会与子弹减速、植物碰撞减速取更强值后生效。
   */
  setSlowMultiplier(v: number): void {
    this.auraSlowMultiplier = clamp(v, 0.1, 1);
    this.recomputeSlow();
  }

  /**
   * 设置植物碰撞减速：穿过带碰撞体积的植物格时固定 0.75（减速 25%）。
   * 由 startDash 在起手时根据「当前格/目标格是否有植物」调用。
   */
  private setPlantSlowMultiplier(v: number): void {
    this.plantSlowMultiplier = clamp(v, 0.1, 1);
    this.recomputeSlow();
  }

  /** 当前是否因为站在/进入植物格而减速（供测试与 HUD 观察） */
  get isPlantSlowed(): boolean {
    return this.plantSlowMultiplier < 1;
  }

  /**
   * 施加一次子弹减速。
   *
   * 规则（对齐 PvZ 寒冰射手）：
   *   - 重复命中会刷新持续时间，而不是叠加倍率；
   *   - 若新减速比当前更强，则更新倍率。
   *
   * @param factor     减速比例，0.5 表示速度降到 50%
   * @param durationMs 持续时间（毫秒）
   */
  applyBulletSlow(factor: number, durationMs: number): void {
    if (!(factor > 0) || !(durationMs > 0)) return;

    const mult = clamp(1 - factor, 0.1, 1);
    // 刷新计时；若已有更强减速则保留更强的那个
    this.bulletSlowMultiplier = Math.min(this.bulletSlowMultiplier, mult);
    this.bulletSlowTimer = Math.max(this.bulletSlowTimer, durationMs);
    this.recomputeSlow();
  }

  /** 当前是否处于子弹减速状态（供 HUD / 测试观察） */
  get isBulletSlowed(): boolean {
    return this.bulletSlowTimer > 0;
  }

  /**
   * 「被冻住」的视觉反馈：僵尸自身短暂闪一下蓝光。
   *
   * 为什么作用在 rig 上而不是 this.setTint：
   *   玩家本体的 Sprite 早就 setVisible(false) 了（视觉全交给 ZombieRig），
   *   直接给 Sprite 染色根本看不见。必须让 rig 逐个部件染色。
   *
   * 只闪一小段时间（默认 200ms）而不是整个减速期：
   *   减速持续 10 秒，全程蓝脸会很糊、也看不清骨骼动作。
   *   命中瞬间「蓝一下」既明确又能传达「被冰到了」。
   */
  flashFreeze(durationMs = 200): void {
    if (this.state === ZombieState.Dead) return;
    if (!this.rig) return;

    // 冰蓝色（带点白，避免纯蓝把细节糊死）
    const ICE_COLOR = 0x8fd8ff;
    this.rig.setTintAll(ICE_COLOR);

    // 用递增 token 防止多次命中时旧的定时器把新闪蓝提前清掉
    const token = ++this.freezeFlashToken;
    this.scene.time.delayedCall(durationMs, () => {
      if (!this.active) return;
      // 仅当没有更新的闪蓝请求时才恢复
      if (this.freezeFlashToken === token) {
        this.rig?.clearTintAll();
      }
    });
  }

  /** 当前最终减速倍率 */
  get currentSlowMultiplier(): number {
    return this.slowMultiplier;
  }

  /** 推进子弹减速计时 */
  private tickBulletSlow(delta: number): void {
    if (this.bulletSlowTimer <= 0) return;

    this.bulletSlowTimer -= delta;
    if (this.bulletSlowTimer <= 0) {
      this.bulletSlowTimer = 0;
      this.bulletSlowMultiplier = 1;
    }
    this.recomputeSlow();
  }

  /** 合并光环/子弹/植物碰撞减速：取最强的那个，不叠乘 */
  private recomputeSlow(): void {
    this.slowMultiplier = Math.min(
      this.auraSlowMultiplier,
      this.bulletSlowMultiplier,
      this.plantSlowMultiplier
    );
  }

  /** 承伤，返回是否死亡 */
  takeDamage(amount: number): boolean {
    if (this.state === ZombieState.Dead) return false;
    this.hp = Math.max(0, this.hp - amount);

    // 受击白闪
    this.setTintFill(0xffffff);
    this.scene.time.delayedCall(70, () => {
      if (this.active) this.clearTint();
    });

    if (this.hp <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  /** 回血，不超过上限。死亡状态下无效，避免把已死亡玩家拉活 */
  heal(amount: number): void {
    if (this.state === ZombieState.Dead) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /**
   * 永久提升最大血量上限（不是回满血）。
   *
   * @param amount 上限增量
   * @param healNow 是否同时把当前血量抬高等量（默认 true）
   *
   * 吃植物时用它：上限 +amount，当前血量跟着 +amount（但不会超过新上限），
   * 这样「上限涨了、现有血也水涨船高」，而不是把血直接灌满。
   *
   * maxHp = maxHpBase + maxHpBonus：
   *   - maxHpBase 是当前「基础上限」（进化阶段血量，或满级成长后的基准）；
   *   - maxHpBonus 是吃植物累计的额外上限。
   * 进化/成长只改 maxHpBase，bonus 恒被保留。
   */
  growMaxHp(amount: number, healNow = true): void {
    if (this.state === ZombieState.Dead) return;
    if (!(amount > 0)) return;
    this.maxHpBonus += amount;
    this.recomputeMaxHp();
    if (healNow) this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** 设置基础最大血量（进化/满级成长时调用），保留吃植物攒下的 bonus */
  setMaxHpBase(base: number): void {
    if (!Number.isFinite(base)) return;
    this.maxHpBase = base;
    this.recomputeMaxHp();
  }

  /** 按「基础 + 额外」重算当前 maxHp（不改变 hp 现值） */
  private recomputeMaxHp(): void {
    this.maxHp = this.maxHpBase + this.maxHpBonus;
  }

  /** 应用进化阶段属性 */
  applyEvolution(index: number): void {
    // 死亡后不再变更进化属性
    if (this.state === ZombieState.Dead) return;    const stage = EVOLUTION_STAGES[index];
    if (!stage) return;
    this.evolutionIndex = index;
    this.speed = stage.speed;
    // 每次进化提升 50% 啃食伤害（按基础伤害乘算，不覆盖商店成长）
    this.evolutionBiteMultiplier = Math.pow(1.5, index);
    this.recomputeBiteDamage();
    // 进化只改「基础上限」，吃植物攒下的 maxHpBonus 保留
    this.setMaxHpBase(stage.hp);

    // 只记录基准缩放，不直接 setScale ——
    // 实际显示尺寸由 updateAnimations 每帧按「基准 × 呼吸系数」写入，
    // 否则这里设的缩放会在下一帧被动画覆盖掉，表现为进化瞬间体型跳一下就复原。
    this.baseScaleX = stage.scale;
    this.baseScaleY = stage.scale;

    // 进化改变了贴图显示尺寸，判定框需要立即跟上
    this.syncBodyPosition();
  }

  /** 设置进化前的基础啃食伤害（商店成长用），自动乘进化倍率 */
  setBiteBaseDamage(value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.biteBaseDamage = value;
    this.recomputeBiteDamage();
  }

  /** 当前基础啃食伤害（不含进化倍率） */
  getBiteBaseDamage(): number {
    return this.biteBaseDamage;
  }

  private recomputeBiteDamage(): void {
    this.biteDamage = Math.max(
      1,
      Math.round(this.biteBaseDamage * this.evolutionBiteMultiplier)
    );
  }

  /** 设置/读取最近一次方向输入，供前方多格攻击使用 */
  setFacingDirection(dc: number, dr: number): void {
    if (dc === 0 && dr === 0) return;
    this.facingDc = Math.sign(dc);
    this.facingDr = Math.sign(dr);
  }

  get facingDirection(): { dc: number; dr: number } {
    return { dc: this.facingDc, dr: this.facingDr };
  }

  /** 从当前格沿朝向前方 offset 格的格子坐标 */
  getForwardCell(offset: number): { col: number; row: number } {
    return {
      col: this.fromCol + this.facingDc * offset,
      row: this.fromRow + this.facingDr * offset
    };
  }

  /** 死亡处理 */
  die(): void {
    if (this.state === ZombieState.Dead) return;

    // 先掐掉正在进行的冲刺：否则 Tween 还会继续写 x/y，
    // 在倒下动画期间把尸体拖回格心。
    this.dashTween?.remove();
    this.dashTween = undefined;
    this.bufferedDir = null;
    this.isMoving = false;

    this.state = ZombieState.Dead;
    this.hp = 0;
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.enable = false;

    this.setTint(0x6b7280);

    // 倒下交给 updateAnimations 的 Dead 分支按时间推进。
    //
    // 为什么不用 tween：tween 会直接写 angle，而动画系统每帧也在写 angle，
    // 两者互相覆盖会导致倒下过程抽搐。统一由动画时钟驱动更可靠，
    // 且场景暂停/恢复后进度不会错乱。
    this.deathProgress = 0;

    // 缓淡效果仍用 tween：它只改 alpha，不与角度冲突
    this.scene.tweens.add({
      targets: this,
      alpha: 0.55,
      duration: 420,
      ease: 'Quad.easeOut'
    });
  }

  /**
   * 复活：把死亡状态完整复位到「站在当前格心的存活状态」。
   *
   * 注意要复位的不只是 hp：
   *   - 物理体在 die() 里被 disable，必须重新 enable；
   *   - 骨骼 rig 处于 dead 模式，要切回 idle，否则复活后仍躺在地上；
   *   - 冲刺/啃食/输入缓冲等瞬态全部清空，避免带着死亡前的 tween 复活。
   *
   * @param hpRatio 复活后恢复的血量比例（0~1）
   */
  revive(hpRatio = 0.6): void {
    const ratio = clamp(Number.isFinite(hpRatio) ? hpRatio : 0.6, 0.05, 1);

    this.dashTween?.remove();
    this.dashTween = undefined;
    this.bufferedDir = null;
    this.isMoving = false;
    this.eatingTimer = 0;

    this.state = ZombieState.Idle;
    this.deathProgress = 0;
    this.animTime = 0;
    this.hp = Math.max(1, this.maxHp * ratio);
    this.setAlpha(1);
    this.clearTint();
    this.setVisible(false);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.setVelocity(0, 0);

    this.snapToCellCenter();
    this.syncBodyPosition();
    this.applyRenderOffset();

    this.rig?.setMode('idle');
    this.rig?.setFacing(this.facing);
    this.durabilityBar?.setVisible(true);
  }

  /** 是否已死亡 */
  get isDead(): boolean {
    return this.state === ZombieState.Dead;
  }

  /** 血量百分比 0..1 */
  get hpRatio(): number {
    return this.maxHp > 0 ? clamp(this.hp / this.maxHp, 0, 1) : 0;
  }
}

