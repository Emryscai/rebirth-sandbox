/**
 * GameScene：主循环。
 * 负责组装各系统、处理输入、物理碰撞、减速判定、胜负流转。
 */

import Phaser from 'phaser';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  TILE_SIZE,
  GRID_OFFSET_X,
  GRID_OFFSET_Y,
  GRID_COLS,
  GRID_ROWS,
  COLORS,
  ASSET_KEYS,
  SCENE_KEYS,
  HOUSE_CELLS,
  SWORDSMAN
} from '../config';
import { GridSystem } from '../systems/GridSystem';
import { PlantSpawner } from '../systems/PlantSpawner';
import { CombatSystem } from '../systems/CombatSystem';
import { EvolutionSystem } from '../systems/EvolutionSystem';
import { TimerSystem } from '../systems/TimerSystem';
import { PlayerZombie } from '../entities/PlayerZombie';
import { Bullet } from '../entities/Bullet';
import { Plant } from '../entities/Plant';
import { SwordsmanPlant } from '../entities/SwordsmanPlant';
import { SwordBullet } from '../entities/SwordBullet';
import { HUD } from '../ui/HUD';
import { TutorialPanel } from '../ui/TutorialPanel';
import { saveBestTime, loadBestTime } from '../platform/storage';
import { SHOP_ITEMS, buildGrowthItems, GROWTH_PER_LEVEL, type ShopItem } from '../data/shop';
import { ItemSystem } from '../systems/ItemSystem';
import { FlavorTicker } from '../ui/FlavorTicker';
import { SawRig } from '../entities/SawRig';
import { Barrier, type BarrierOrientation } from '../entities/Barrier';
import { BouncingOrb, type OrbHitTarget } from '../entities/BouncingOrb';
import { Boomerang, type BoomerangHitTarget } from '../entities/Boomerang';
import { ITEM, BASIC_ATTACK } from '../config';
import { type ItemDef, type ItemId, ITEMS } from '../data/items';
import { rollPlantDrops } from '../data/drops';
import {
  PLANT_BITE_INTERVAL,
  PLANT_BITE_DAMAGE,
  PLANT_COIN_REWARDS,
  type PlantType
} from '../data/plants';
import { t, tf } from '../i18n';
import { bgm } from '../platform/bgm';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';
import { RevivePanel } from '../ui/RevivePanel';
import { ads } from '../platform/ads';
import { REVIVE_HP_RATIO, REVIVE_INVULNERABLE_MS } from '../data/ads';
import { hasSeenTutorial, markTutorialSeen } from '../platform/storage';
import { IS_MINIGAME, IS_TOUCH, vibrateShort } from '../platform/env';

interface WxTouchPoint {
  identifier?: number;
  pageX?: number;
  pageY?: number;
  clientX?: number;
  clientY?: number;
  x?: number;
  y?: number;
}

interface WxTouchEvent {
  touches?: WxTouchPoint[];
  changedTouches?: WxTouchPoint[];
}

export class GameScene extends Phaser.Scene {
  private grid!: GridSystem;
  private spawner!: PlantSpawner;
  private combat!: CombatSystem;
  private evolution!: EvolutionSystem;
  private timer!: TimerSystem;
  private player!: PlayerZombie;
  private hud!: HUD;

  /** 子弹组 */
  private bullets!: Phaser.Physics.Arcade.Group;

  /**
   * 追踪剑（宗门剑士）。
   *
   * 单独一个组而不是塞进 bullets：
   *   - 命中判定完全不同（豌豆走直线扫掠，剑走弧线要按圆距判）
   *   - 剑没有 axis 概念，混在一起会让 stepBulletsAndResolveHits
   *     的假设（axis 为 h 或 v）全部失效
   */
  private swords!: Phaser.Physics.Arcade.Group;

  /** 网格区域像素矩形 */
  private gridRect!: Phaser.Geom.Rectangle;

  /** 输入按键 */
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyUp!: Phaser.Input.Keyboard.Key;
  private keyLeft!: Phaser.Input.Keyboard.Key;
  private keyDown!: Phaser.Input.Keyboard.Key;
  private keyRight!: Phaser.Input.Keyboard.Key;
  private keySpace!: Phaser.Input.Keyboard.Key;
  private keyEsc!: Phaser.Input.Keyboard.Key;
  private keyB!: Phaser.Input.Keyboard.Key;

  // ------------------------------------------------------------ 触控输入
  //
  // 移动端没有键盘，操作方案：
  //   - 在棋盘上滑动 = 朝滑动方向冲刺一格（连续滑动可连续突进）
  //   - 按住棋盘任意处 / 按住右下角「啃食」按钮 = 持续啃食
  // 两个手指可同时工作（一手按住啃食、一手滑动逃跑）。

  /** 当前是否有手指/鼠标按在棋盘或啃食按钮上 */
  private eatHeld = false;
  /** 按在棋盘上的指针 id 集合（多指） */
  private boardPointers = new Set<number>();
  /** 当前负责滑动判定的指针 id（只取第一根） */
  private swipeId: number | null = null;
  private swipeLastX = 0;
  private swipeLastY = 0;
  private swipeLastDashAt = 0;
  /** 小游戏里直接监听 wx 触摸，绕过 Phaser 触摸桥接的兼容问题 */
  private wxTouchBound = false;
  private wxTouchCleanup?: () => void;
  /** 啃食按钮是否被按住 */
  private eatButtonHeld = false;

  /** 本局是否已经用过广告复活 */
  private revivedThisRun = false;
  /** 复活无敌截止时刻（scene time，毫秒） */
  private invulnerableUntil = 0;
  /** 商店无敌星剩余游戏时间（毫秒；只在场景实际运行时递减） */
  private starInvincibleRemainingMs = 0;
  /** 商店购买的无敌时长，关闭商店后生效 */
  private pendingStarInvincibleMs = 0;
  /** 无敌星头顶倒计时/光效 */
  private starCountdown?: Phaser.GameObjects.Text;
  private starAura?: Phaser.GameObjects.Star;
  /** 死亡后的复活面板（GameScene 内 UI，不另开 Scene） */
  private revivePanel?: RevivePanel;
  /** 首次操作引导打开时，冻结计时/生成/输入 */
  private tutorialOpen = false;
  private tutorialPanel?: TutorialPanel;

  /** 房屋碰撞矩形（用于子弹判定） */
  private houseRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  /**
   * 本局是否存活。死亡或场景关闭后置 false。
   * 作为主循环和所有子系统的统一短路开关。
   */
  private alive = false;

  /** 是否已结束（进入结算流转中） */
  private gameOver = false;

  /** 上次记录异常的时间戳（日志限流） */
  private lastErrorAt = 0;

  /** 开局延迟生成计时器的引用，便于清理 */
  private openingSpawnEvent?: Phaser.Time.TimerEvent;

  /** 玩家与子弹的重叠检测器（重开时需销毁，避免回调叠加） */
  private playerBulletCollider?: Phaser.Physics.Arcade.Collider;

  /** 当前啃食进度 0..1（由 CombatSystem 回调更新） */
  private eatRatio = 0;
  /** 当前是否处于啃食中 */
  private isEatingNow = false;

  /**
   * 护盾：剩余可吸收伤害点数。>0 时，玩家受到的伤害先从这里扣除。
   * 商店「铁皮护盾」购买后置位；吸满后自动归零。
   */
  private shieldHp = 0;
  /** 护盾到期时刻（scene 时间，毫秒）；0 表示无到期限制 */
  private shieldUntil = 0;

  /** 已拥有的「不可重复」商店商品 id 集合 */
  private ownedShopItems: string[] = [];

  /**
   * 满级后「永久成长」的购买等级。
   *
   * key 为成长商品 id（growth-hp / growth-atk / growth-speed），value 为已购次数。
   * 价格 = GROWTH_BASE_PRICE + GROWTH_PRICE_STEP × level；
   * 属性 = 满级基准值 × (1 + GROWTH_PER_LEVEL × level)。
   */
  private growthLevels: Record<string, number> = {};
  /** 道具页每种道具已购买次数：每次购买后价格 +5 */
  private itemPurchaseCounts: Partial<Record<ItemId, number>> = {};

  /** 满级时记录的基准属性（用于按等级重算，避免反复累乘漂移） */
  private growthBase = { maxHp: 0, speed: 0, bite: 0 };

  // ------------------------------------------------------------ 道具系统

  /** 地面掉落 + 手持道具槽 */
  private itemSystem?: ItemSystem;
  /** 顶部风味文本跑马灯 */
  private flavorTicker?: FlavorTicker;
  /** 手持电锯视觉体（挂在右手） */
  private sawRig?: SawRig;
  /** 铁板盾牌视觉体（挂在左手） */
  private ironPlateProp?: Phaser.GameObjects.Image;
  /** 靴子视觉体（左右脚各一） */
  private bootsPropL?: Phaser.GameObjects.Image;
  private bootsPropR?: Phaser.GameObjects.Image;
  /** 当前生效的飞行道具（弹球 / 回力镖） */
  private orbs: BouncingOrb[] = [];
  private boomerangs: Boomerang[] = [];

  /** 普攻间隔计时 */
  private attackTimer = 0;
  /** 普攻阶段：idle 空档 / windup 举图蓄力中 */
  private attackPhase: 'idle' | 'windup' = 'idle';
  /** 蓄力剩余时间（毫秒），归零时「出手」 */
  private windupTimer = 0;
  /** 当前蓄力的投掷物类型（决定脱手后生成弹球还是回力镖） */
  private pendingKind: 'orb' | 'boomerang' | null = null;
  /** 蓄力时握在手上的图标（出手瞬间摘掉，变成真正的弹体） */
  private heldIcon?: Phaser.GameObjects.Image;
  /** 链锯自动锯伤计时 */
  private chainsawTimer = 0;
  /** 空格链锯重击冷却（毫秒） */
  private chainsawSlamCd = 0;
  /** 防治植物全缩在打不到的死角：静止且无可攻击植物计时 */
  private stuckNoAttackMs = 0;
  private stuckRelocateCd = 0;
  private lastStuckCol = -1;
  private lastStuckRow = -1;
  /** 靴子生效期间的额外速度（失效时扣回） */
  private bootSpeedBonus = 0;
  /** 铁板护盾是否来自道具（用于移除时扣减剩余护盾） */
  private ironPlateActive = false;

  /** 僵尸待机音效计时（毫秒），累积到阈值且玩家闲置时播放一次 */
  private idleSfxTimer = 0;
  /** 待机音效触发间隔（毫秒），带随机抖动 */
  private idleSfxInterval = 0;

  /**
   * 石墙壁垒：记录每株石墙生成时铺设的壁垒，石墙被摧毁时据此清除。
   * key 为石墙植物实例。
   */
  private wallBarriers = new Map<Plant, Barrier[]>();


  constructor() {
    super(SCENE_KEYS.game);
  }

  // ------------------------------------------------------------ 初始化

  create(): void {
    // 每次进入场景都重置全部状态，防止上一局残留
    this.resetSceneState();
    // 640 设计区按屏幕做相机适配（Web 为 1:1，小游戏居中缩放）
    installCameraFit(this);

    this.physics.world.setBounds(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.cameras.main.setBackgroundColor(COLORS.bg);

    this.grid = new GridSystem();
    this.gridRect = new Phaser.Geom.Rectangle(
      GRID_OFFSET_X,
      GRID_OFFSET_Y,
      GRID_COLS * TILE_SIZE,
      GRID_ROWS * TILE_SIZE
    );
    this.houseRects = this.grid.getHouseRects();

    this.drawBoard();

    // 玩家出生在网格中心偏下（10x10 时为 (5, 7)）
    const spawnCol = Math.floor(GRID_COLS / 2);
    const spawnRow = Math.min(GRID_ROWS - 2, Math.floor(GRID_ROWS / 2) + 2);
    const spawnCell = this.grid.cellToCenter(spawnCol, spawnRow);

    this.player = new PlayerZombie(
      this,
      spawnCell.x,
      spawnCell.y,
      this.gridRect,
      spawnCol,
      spawnRow,
      // 只允许走进场地内的非房屋格，且未被石墙壁垒封锁：
      // 保证僵尸不会走进房屋、越界，或穿过壁垒。
      (col, row) =>
        this.grid.isInside(col, row) &&
        !this.grid.isHouse(col, row) &&
        !this.grid.isBlocked(col, row),
      // 植物碰撞体积：当前格/目标格有活植物时，本次冲刺减速 25%
      (col, row) =>
        this.spawner?.plants.some(
          (p) =>
            p &&
            p.active &&
            !p.isDying &&
            p.col === col &&
            p.row === row
        ) ?? false
    );

    // 注入格坐标换算，让实体自己按格心对齐
    this.player.setCellMapping(
      (col) => this.grid.cellToCenter(col, 0).x,
      (row) => this.grid.cellToCenter(0, row).y,
      TILE_SIZE
    );

    // 子弹组
    this.bullets = this.physics.add.group({
      runChildUpdate: true,
      classType: Bullet
    });

    // 追踪剑组
    this.swords = this.physics.add.group({
      runChildUpdate: true,
      classType: SwordBullet
    });

    // 各系统
    this.spawner = new PlantSpawner(
      this,
      this.grid,
      (plant) => this.fireBullet(plant),
      (plant, x, y, angle) => this.fireSword(plant, x, y, angle)
    );

    this.combat = new CombatSystem(this, this.player, this.spawner, this.grid);
    this.combat.onProgress = (ratio, active) => {
      this.eatRatio = ratio;
      this.isEatingNow = active;
    };

    this.combat.onEat = (r) => {
      if (!this.alive) return;
      this.evolution.addPoints(r.pointsGained);
      if (this.cameras.main) this.cameras.main.shake(60, 0.002);
      this.hud?.flashMessage(tf('flash.points', { n: r.pointsGained }), COLORS.accent);
    };

    this.evolution = new EvolutionSystem(this.player);
    this.evolution.onLevelUp = (stage) => {
      if (!this.alive) return;
      const idx = this.evolution?.stageIndex ?? 0;
      const stateLabel = t(`stage.${idx}`);
      this.hud?.flashMessage(tf('flash.levelUp', { stage: stateLabel }), '#ffe082');
      this.player.hp = this.player.maxHp;
      // 商店是透明覆盖层：在商店里买进化时，不要在底层 GameScene 上闪屏/爆粒子
      if (!this.scene.isActive(SCENE_KEYS.shop)) {
        if (this.cameras.main) this.cameras.main.flash(200, 120, 220, 255, false);
        this.emitLevelUpBurst();
      }
    };

    this.timer = new TimerSystem();
    this.timer.onCoin = () => {
      if (!this.alive) return;
      sfx.play('coinDrop');
      this.hud?.flashMessage(t('flash.coin'), COLORS.coin);
    };

    this.hud = new HUD(
      this,
      () => this.openShop(),
      () => this.openSettings(),
      () => this.openPauseMenu(),
      () => {
        this.eatButtonHeld = true;
        this.syncEatHeld();
      },
      () => {
        this.eatButtonHeld = false;
        this.syncEatHeld();
      }
    );

    // 道具系统：掉落 / 拾取 / 手持槽（在 HUD 之后，拾取时才能弹提示）
    this.setupItemSystem();

    this.setupInput();
    this.setupCollisions();

    // 初始化完成，正式进入存活状态
    this.alive = true;

    // 广告：累计开局数（插屏频控），并通知平台进入玩法
    ads.beginRun();
    ads.gameplayStart();

    // 首次进入：手机端用操作引导面板暂停开局，点「开始」才真正计时。
    // 桌面端保留原来的轻量提示，避免鼠标玩家被大面板打断。
    if (!hasSeenTutorial()) {
      if (IS_TOUCH) {
        this.tutorialOpen = true;
        // 不暂停游戏：提示只做轻量说明，棋盘和战斗始终可操作
        this.tutorialPanel = new TutorialPanel(this, () => this.startFromTutorial());
      } else {
        markTutorialSeen();
        this.time.delayedCall(900, () => {
          if (!this.alive || this.gameOver) return;
          this.hud?.flashMessage(t('hud.tutorial'), '#ffe6a3');
        });
      }
    }

    // 预建音效实例池，避免首次播放时临时创建造成延迟
    sfx.prewarm();

    // 背景音乐：进入本局（首局随机 normal 循环；重开累计 revenge 解锁）
    bgm().startRun();

    // 开局不立即刷植物
    this.openingSpawnEvent = this.time.delayedCall(600, () => {
      this.openingSpawnEvent = undefined;
      if (!this.alive) return;
      if (!this.spawner || !this.grid) return;
      this.spawner.spawnAt(
        Math.floor(GRID_COLS / 2) - 2,
        GRID_ROWS - 4,
        'shooter'
      );
    });

    // 场景关闭时清理
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);

    // 从暂停/商店/设置覆盖层恢复时，把背景音乐切回上下文曲（同一首续播）
    this.events.on(Phaser.Scenes.Events.RESUME, this.onSceneResume, this);
  }

  /** 覆盖层关闭、本场景恢复运行时：把背景音乐从菜单曲切回游戏上下文曲 */
  private onSceneResume(): void {
    bgm().exitMenu();
    ads.gameplayStart();
  }

  /** 绘制棋盘、草地格与房屋 */
  private drawBoard(): void {
    const g = this.add.graphics().setDepth(0);

    // 整屏底色：竖屏时棋盘上下留白也必须有氛围，不能露出纯黑
    g.fillStyle(COLORS.bg, 1);
    g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // 上下留白区的暗紫雾气 / 光斑（纯 Graphics，不增加贴图体积）
    if (this.gridRect.y > 24) {
      for (let i = 0; i < 5; i++) {
        g.fillStyle(0x2a1040, 0.12 - i * 0.015);
        g.fillEllipse(GAME_WIDTH / 2, this.gridRect.y * 0.45, 520 - i * 70, 150 - i * 18);
      }
    }
    const bottomSpace = GAME_HEIGHT - (this.gridRect.y + this.gridRect.height);
    if (bottomSpace > 24) {
      for (let i = 0; i < 5; i++) {
        g.fillStyle(0x102030, 0.16 - i * 0.02);
        g.fillEllipse(
          GAME_WIDTH / 2,
          GAME_HEIGHT - bottomSpace * 0.45,
          540 - i * 70,
          170 - i * 20
        );
      }
    }

    // 背景底板
    g.fillStyle(0x0d1520, 1);
    g.fillRect(
      this.gridRect.x - 8,
      this.gridRect.y - 8,
      this.gridRect.width + 16,
      this.gridRect.height + 16
    );

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tl = this.grid.cellToTopLeft(c, r);
        const isHouse = this.grid.isHouse(c, r);
        const checker = (c + r) % 2 === 0;

        // 棋格底色
        g.fillStyle(isHouse ? 0x232a33 : checker ? 0x16241c : 0x131f19, 1);
        g.fillRect(tl.x, tl.y, TILE_SIZE, TILE_SIZE);

        // 网格线
        g.lineStyle(1, COLORS.gridLine, 0.55);
        g.strokeRect(tl.x + 0.5, tl.y + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
      }
    }

    // 房屋贴图
    for (const cell of HOUSE_CELLS) {
      const tl = this.grid.cellToTopLeft(cell.col, cell.row);
      if (this.textures.exists(ASSET_KEYS.houseTile)) {
        this.add
          .image(tl.x + TILE_SIZE / 2, tl.y + TILE_SIZE / 2, ASSET_KEYS.houseTile)
          .setDisplaySize(TILE_SIZE, TILE_SIZE)
          .setDepth(2);
      }
    }

    // 草地贴图（低透明度叠加，保留棋盘可读性）
    if (this.textures.exists(ASSET_KEYS.grassTile)) {
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (this.grid.isHouse(c, r)) continue;
          if ((c + r) % 2 !== 0) continue;
          const tl = this.grid.cellToTopLeft(c, r);
          this.add
            .image(tl.x + TILE_SIZE / 2, tl.y + TILE_SIZE / 2, ASSET_KEYS.grassTile)
            .setDisplaySize(TILE_SIZE, TILE_SIZE)
            .setAlpha(0.35)
            .setDepth(1);
        }
      }
    }

    // 外框
    g.lineStyle(2, 0x2f4a63, 0.9);
    g.strokeRect(this.gridRect.x, this.gridRect.y, this.gridRect.width, this.gridRect.height);
  }

  // ------------------------------------------------------------ 输入

  private setupInput(): void {
    // 触控先于键盘注册：小游戏容器里可能没有 KeyboardPlugin
    this.setupTouchInput();

    const kb = this.input.keyboard;
    if (!kb) return;

    this.keyW = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyS = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyUp = kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyDown = kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keySpace = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    // 链锯生效时，空格触发“前方两格”重击；长按保持抬手
    this.keySpace.on('down', () => this.tryChainsawSlam());
    this.keySpace.on('up', () => this.player?.getRig().releaseSawRaise());

    // ESC：暂停
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyEsc.on('down', () => this.openPauseMenu());

    // B：打开商店
    this.keyB = kb.addKey(Phaser.Input.Keyboard.KeyCodes.B);
    this.keyB.on('down', () => this.openShop());

    // 防止空格与方向键滚动页面
    kb.addCapture([
      Phaser.Input.Keyboard.KeyCodes.ESC,
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT
    ]);

    // ---- 格点冲刺的方向键绑定 ----
    //
    // 关键设计：监听 keydown 的「按下瞬间」，而不是在 update 里轮询 isDown。
    //
    // 轮询的问题是：按住方向键时每一帧都读到输入，
    // 冲刺一结束就立刻开下一次 —— 一次按键会连走十几格，完全失控。
    // 监听 down 事件则天然是「一次按下 = 一次冲刺」。
    //
    // 长按连续突进交给 PlayerZombie 内部的输入缓冲 + 键盘重复事件处理，
    // 这里只负责把「按下的方向」丢进去。
    const bindDir = (key: Phaser.Input.Keyboard.Key, dc: number, dr: number) => {
      key.on('down', () => this.requestDash(dc, dr));
    };

    bindDir(this.keyA, -1, 0);
    bindDir(this.keyLeft, -1, 0);
    bindDir(this.keyD, 1, 0);
    bindDir(this.keyRight, 1, 0);
    bindDir(this.keyW, 0, -1);
    bindDir(this.keyUp, 0, -1);
    bindDir(this.keyS, 0, 1);
    bindDir(this.keyDown, 0, 1);
  }

  /**
   * 触控输入：
   *   - 单指按在棋盘上 = 啃食；按住不放持续啃
   *   - 按住后滑动 = 朝滑动方向走一格；持续滑动会连续走
   *   - 右下角「啃食」按钮 = 不遮挡棋盘的第二选择（也方便单手）
   *
   * 所有判定都用 worldX/worldY：小游戏相机有 zoom，屏幕坐标不能直接和
   * 640 设计区的格子比较。
   */
  private setupTouchInput(): void {
    // 小游戏直接读 wx 触摸：不同基础库/鸿蒙下 Phaser 的 canvas 事件桥接
    // 偶尔只收到 touchstart、收不到 touchmove。这里用同一套格点冲刺逻辑，
    // 但输入源换成 wx.onTouch*，H5 仍走 Phaser。
    if (IS_MINIGAME && this.setupWxBoardTouch()) return;

    this.input.on('pointerdown', this.onBoardPointerDown, this);
    this.input.on('pointermove', this.onBoardPointerMove, this);
    this.input.on('pointerup', this.onBoardPointerUp, this);
    this.input.on('gameout', this.clearTouchInput, this);
  }

  /** 返回是否成功绑定 wx 触摸 */
  private setupWxBoardTouch(): boolean {
    const wxApi = (globalThis as unknown as {
      wx?: {
        onTouchStart?: (cb: (e: WxTouchEvent) => void) => void;
        onTouchMove?: (cb: (e: WxTouchEvent) => void) => void;
        onTouchEnd?: (cb: (e: WxTouchEvent) => void) => void;
        onTouchCancel?: (cb: (e: WxTouchEvent) => void) => void;
        offTouchStart?: (cb: (e: WxTouchEvent) => void) => void;
        offTouchMove?: (cb: (e: WxTouchEvent) => void) => void;
        offTouchEnd?: (cb: (e: WxTouchEvent) => void) => void;
        offTouchCancel?: (cb: (e: WxTouchEvent) => void) => void;
      };
    }).wx;
    if (
      !wxApi?.onTouchStart ||
      !wxApi?.onTouchMove ||
      !wxApi?.onTouchEnd ||
      this.wxTouchBound
    ) {
      return false;
    }
    this.wxTouchBound = true;

    const start = (e: WxTouchEvent) => this.onWxTouchStart(e);
    const move = (e: WxTouchEvent) => this.onWxTouchMove(e);
    const end = (e: WxTouchEvent) => this.onWxTouchEnd(e);
    wxApi.onTouchStart(start);
    wxApi.onTouchMove(move);
    wxApi.onTouchEnd(end);
    wxApi.onTouchCancel?.(end);
    this.wxTouchCleanup = () => {
      wxApi.offTouchStart?.(start);
      wxApi.offTouchMove?.(move);
      wxApi.offTouchEnd?.(end);
      wxApi.offTouchCancel?.(end);
      this.wxTouchBound = false;
    };
    return true;
  }

  private wxTouchToWorld(touch: WxTouchPoint): { x: number; y: number } | null {
    const wxApi = (globalThis as unknown as {
      wx?: { getSystemInfoSync?: () => { screenWidth?: number; screenHeight?: number; windowWidth?: number; windowHeight?: number } };
    }).wx;
    let screenW = 0;
    let screenH = 0;
    try {
      const info = wxApi?.getSystemInfoSync?.();
      screenW = Number(info?.screenWidth || info?.windowWidth || 0);
      screenH = Number(info?.screenHeight || info?.windowHeight || 0);
    } catch {
      /* ignore */
    }
    if (!(screenW > 0) || !(screenH > 0)) return null;
    const canvasW = this.game.canvas.width;
    const canvasH = this.game.canvas.height;
    const rawX =
      touch.clientX != null ? touch.clientX : touch.pageX != null ? touch.pageX : touch.x || 0;
    const rawY =
      touch.clientY != null ? touch.clientY : touch.pageY != null ? touch.pageY : touch.y || 0;
    const screenX = rawX * (canvasW / screenW);
    const screenY = rawY * (canvasH / screenH);
    return this.cameras.main.getWorldPoint(screenX, screenY);
  }

  private onWxTouchStart(e: WxTouchEvent): void {
    if (!this.alive || this.gameOver) return;
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    const point = this.wxTouchToWorld(touch);
    if (!point) return;
    if (this.tutorialOpen && this.tutorialPanel?.containsStart(point.x, point.y)) {
      this.startFromTutorial();
      return;
    }
    if (!this.gridRect.contains(point.x, point.y)) return;
    const id = Number(touch.identifier ?? 1);
    this.boardPointers.add(id);
    this.syncEatHeld();
    if (this.swipeId === null) {
      this.swipeId = id;
      this.swipeLastX = point.x;
      this.swipeLastY = point.y;
      this.swipeLastDashAt = 0;
    }
  }

  private onWxTouchMove(e: WxTouchEvent): void {
    if (!this.alive || this.gameOver) return;
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    const id = Number(touch.identifier ?? 1);
    if (this.swipeId !== id || !this.boardPointers.has(id)) return;
    const point = this.wxTouchToWorld(touch);
    if (!point) return;
    const dx = point.x - this.swipeLastX;
    const dy = point.y - this.swipeLastY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < 26) return;
    const now = this.time.now;
    if (now - this.swipeLastDashAt < 70) return;
    this.swipeLastDashAt = now;
    this.swipeLastX = point.x;
    this.swipeLastY = point.y;
    const dc = adx >= ady ? (dx > 0 ? 1 : -1) : 0;
    const dr = adx >= ady ? 0 : dy > 0 ? 1 : -1;
    this.requestDash(dc, dr);
  }

  private onWxTouchEnd(e: WxTouchEvent): void {
    const touches = e.changedTouches ?? e.touches ?? [];
    for (const touch of touches) {
      const id = Number(touch.identifier ?? 1);
      this.boardPointers.delete(id);
      if (this.swipeId === id) this.swipeId = null;
    }
    this.syncEatHeld();
  }

  private onBoardPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.alive || this.gameOver) return;
    // 点在 HUD / 按钮上时不进入棋盘手势
    const over = (pointer as Phaser.Input.Pointer & { currentlyOver?: unknown[] }).currentlyOver;
    if (over && over.length > 0) return;
    if (!this.gridRect.contains(pointer.worldX, pointer.worldY)) return;

    this.boardPointers.add(pointer.id);
    this.syncEatHeld();

    if (this.swipeId === null) {
      this.swipeId = pointer.id;
      this.swipeLastX = pointer.worldX;
      this.swipeLastY = pointer.worldY;
      this.swipeLastDashAt = 0;
    }
  }

  private onBoardPointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.alive || this.gameOver) return;
    if (this.swipeId !== pointer.id) return;
    if (!this.boardPointers.has(pointer.id)) return;

    const dx = pointer.worldX - this.swipeLastX;
    const dy = pointer.worldY - this.swipeLastY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    // 阈值取 26 设计像素：手机上约 16 CSS px，既不会误触，也不用滑很远
    if (Math.max(adx, ady) < 26) return;

    // 同一根手指 70ms 内最多触发一次冲刺，避免一次滑动连走三四格
    const now = this.time.now;
    if (now - this.swipeLastDashAt < 70) return;

    const dc = adx >= ady ? (dx > 0 ? 1 : -1) : 0;
    const dr = adx >= ady ? 0 : dy > 0 ? 1 : -1;

    this.swipeLastDashAt = now;
    this.swipeLastX = pointer.worldX;
    this.swipeLastY = pointer.worldY;
    this.requestDash(dc, dr);
  }

  private onBoardPointerUp(pointer: Phaser.Input.Pointer): void {
    this.boardPointers.delete(pointer.id);
    if (this.swipeId === pointer.id) {
      this.swipeId = null;
    }
    this.syncEatHeld();
  }

  /** 关闭首次引导：恢复场景时钟与输入，本局正式开始计时 */
  private startFromTutorial(): void {
    if (!this.tutorialOpen) return;
    this.tutorialOpen = false;
    this.tutorialPanel?.destroy();
    this.tutorialPanel = undefined;
    markTutorialSeen();
    this.clearTouchInput();
    this.time.paused = false;
  }

  /** 同步「是否按住啃食」：棋盘手指或右下角按钮任一按住即可 */
  private syncEatHeld(): void {
    this.eatHeld = this.eatButtonHeld || this.boardPointers.size > 0;
  }

  /** 清空触控状态（暂停/死亡/场景重开时调用，避免「幽灵按住」） */
  private clearTouchInput(): void {
    this.boardPointers.clear();
    this.eatButtonHeld = false;
    this.swipeId = null;
    this.eatHeld = false;
  }

  /**
   * 请求朝某个方向冲刺一格。
   *
   * 这里只做「能不能动」的前置判断，具体的格子合法性、
   * 移动锁、Tween 都由 PlayerZombie 自己负责。
   */
  private requestDash(dc: number, dr: number): void {
    if (!this.alive || this.gameOver) return;
    if (!this.player || !this.player.active || this.player.isDead) return;

    sfx.play('zombieMove');
    this.player.bufferDirection(dc, dr);
  }

  /**
   * 打开暂停菜单。
   *
   * 做法：把 GameScene 整体 pause（update 与计时器全部冻结），
   * 再用 launch 叠加一个独立的 PauseScene。
   * 这样不需要在各个系统里到处加 if (paused)，也不会漏掉任何子系统。
   */
  private openPauseMenu(): void {
    if (!this.alive || this.gameOver) return;
    if (this.scene.isActive(SCENE_KEYS.pause)) return;

    sfx.setEating(false);
    this.clearTouchInput();
    this.swords?.clear(true, true);
    ads.gameplayStop();
    // 背景音乐：暂停菜单 → 切到菜单曲
    bgm().enterMenu();
    this.scene.pause();
    this.scene.launch(SCENE_KEYS.pause);
  }

  // ------------------------------------------------------------ 道具系统

  /**
   * 初始化道具系统。
   *
   * 三个回调分别负责：生效 / 失效 / 拾取提示。
   * 具体效果全部集中在这里实现，ItemSystem 只做「计时与切换」，
   * 这样道具的生命周期与游戏效果是两个正交维度，互不纠缠。
   */
  private setupItemSystem(): void {
    this.flavorTicker = new FlavorTicker(this);
    // 开局在顶部滚动条播一遍精简规则；比逐条 UI 提示更不挡视野
    this.flavorTicker.show(t('ticker.rules'), '#8fe388', 82);

    // 植物**被僵尸啃食致死** → 15% 概率掉落随机道具
    // （远程弹球/回力镖/链锯打死的不掉，保证「啃食后才掉道具」）
    this.spawner.setPlantDestroyedCallback((plant) => {
      if (!plant) return;
      // 任何击杀路径都要把格子释放，避免链锯/远程击杀后格子永久占用
      if (this.grid?.isOccupied(plant.col, plant.row)) {
        this.grid.release(plant.col, plant.row);
      }
      // 石墙被摧毁：先清掉它铺下的壁垒
      this.clearWallBarriers(plant);
      if (!this.alive || this.gameOver) return;

      // 所有植物死亡都掉尸币：普通 2 / 石墙 5 / 宗门剑士 10
      const reward = PLANT_COIN_REWARDS[plant.type] ?? 2;
      this.timer?.addCoins(reward);
      this.hud?.flashMessage(
        plant.type === 'wall'
          ? tf('flash.coinWall', { n: reward })
          : tf('flash.plantCoin', { n: reward }),
        COLORS.coin
      );
      sfx.play('coinDrop');

      // 植物专属掉落表（见 data/drops.ts）
      const drops = rollPlantDrops(plant.type);
      for (const id of drops) {
        this.itemSystem?.dropAt(plant.x, plant.y, id);
      }
      if (drops.length > 0) sfx.play('itemDrop');
    });

    // 植物生成成功：若是石墙，随机铺一段壁垒
    this.spawner.setPlantSpawnedCallback((plant) => {
      if (!this.alive || this.gameOver) return;
      sfx.play('plantPlace');
      if (plant.type === 'wall') this.spawnWallBarriers(plant);
    });

    this.itemSystem = new ItemSystem(this, {
      onActivate: (def) => this.activateItem(def),
      onDeactivate: (def) => this.deactivateItem(def),
      onPickup: (def) => {
        sfx.play('zombiePickup');
        // 注意：不要在拾取时清空追踪剑——飞行中的剑被清掉会表现为
        // “剑穿过僵尸但没有伤害”。这里只保留死亡/暂停/商店时的清理。
        this.hud?.flashMessage(tf('flash.pickup', { name: t(`item.${def.id}.name`) }), '#ffd166');
        this.flavorTicker?.show(t(`item.${def.id}.flavor`), '#ffd166');
      },
      onChainsawBlocked: (def) => {
        // 锯子持续时间内的其他道具转化为永久最大生命
        this.player?.growMaxHp(25);
        this.hud?.flashMessage(
          tf('flash.sawAbsorb', { name: t(`item.${def.id}.name`) }),
          '#8fe388'
        );
      },
      onExpire: (def) => {
        this.hud?.flashMessage(tf('flash.itemExpire', { name: t(`item.${def.id}.name`) }), COLORS.textDim);
      }
    });

    // 普攻初始延迟
    this.attackTimer = BASIC_ATTACK.firstDelayMs;
    this.chainsawTimer = ITEM.chainsawHitIntervalMs;
  }

  // ------------------------------------------------------------ 石墙壁垒

  /**
   * 石墙生成时，随机挑一个方向（横排左右 / 竖排上下），
   * 把石墙两侧相邻的两格设为「僵尸无法穿过」的壁垒，并铺上视觉。
   *
   * 规则：
   *   - 只在横排、竖排里二选一（满足条件的那个），不会同时铺两条；
   *   - 「左右两格」或「上下两格」必须都在场内、非房屋、非植物、非已封锁，
   *     否则该方向作废，改试另一个方向；两个方向都不可行则不放壁垒；
   *   - 每格壁垒的视觉是 3 块缩小石墙拼成（见 Barrier）。
   */
  private spawnWallBarriers(plant: Plant): void {
    if (!this.grid) return;
    // 幂等：重复调用先清旧的
    this.clearWallBarriers(plant);

    const col = plant.col;
    const row = plant.row;

    // 候选的两个方向：横排左右两格、竖排上下两格
    const horizontal: Array<{ col: number; row: number }> = [
      { col: col - 1, row },
      { col: col + 1, row }
    ];
    const vertical: Array<{ col: number; row: number }> = [
      { col, row: row - 1 },
      { col, row: row + 1 }
    ];

    const pc = this.player?.cellCol;
    const pr = this.player?.cellRow;
    const usable = (cells: Array<{ col: number; row: number }>): boolean =>
      cells.every(
        (c) =>
          this.grid.isInside(c.col, c.row) &&
          !this.grid.isHouse(c.col, c.row) &&
          !this.grid.isBlocked(c.col, c.row) &&
          !this.grid.isOccupied(c.col, c.row) &&
          // 不要把玩家当前所站的格子封死，避免把僵尸困住/穿模
          !(c.col === pc && c.row === pr)
      );

    const canH = usable(horizontal);
    const canV = usable(vertical);
    if (!canH && !canV) return;

    // 两个方向都可行时随机二选一，否则用可行的那个
    let orientation: BarrierOrientation;
    let cells: Array<{ col: number; row: number }>;
    if (canH && canV) {
      if (Math.random() < 0.5) {
        orientation = 'h';
        cells = horizontal;
      } else {
        orientation = 'v';
        cells = vertical;
      }
    } else if (canH) {
      orientation = 'h';
      cells = horizontal;
    } else {
      orientation = 'v';
      cells = vertical;
    }

    const barriers: Barrier[] = [];
    for (const c of cells) {
      if (!this.grid.setBlocked(c.col, c.row)) continue;
      const center = this.grid.cellToCenter(c.col, c.row);
      barriers.push(
        new Barrier(this, c.col, c.row, orientation, center.x, center.y)
      );
    }

    if (barriers.length > 0) this.wallBarriers.set(plant, barriers);
  }

  /** 清除某株石墙铺下的所有壁垒（销毁视觉 + 解除格子封锁） */
  private clearWallBarriers(plant: Plant): void {
    const barriers = this.wallBarriers.get(plant);
    if (!barriers) return;
    this.wallBarriers.delete(plant);
    for (const b of barriers) {
      if (!b) continue;
      if (this.grid) this.grid.unblock(b.cellCol, b.cellRow);
      try {
        b.destroy();
      } catch {
        /* 单个销毁失败不影响整体清理 */
      }
    }
  }

  /** 清空全部壁垒（场景重置/清理时使用） */
  private clearAllWallBarriers(): void {
    for (const [, barriers] of this.wallBarriers) {
      for (const b of barriers) {
        try {
          b.destroy();
        } catch {
          /* 忽略 */
        }
      }
    }
    this.wallBarriers.clear();
  }

  /** 道具生效：按 id 施加对应效果，并把对应外观挂到手上/脚上 */
  private activateItem(def: ItemDef): void {
    if (!this.alive || this.gameOver) return;
    if (!this.player || !this.player.active) return;

    // 防御性：先摘掉任何「不属于当前新道具」的残留外观，
    // 确保拾取新道具时连同上一件道具的贴图一起被覆盖 / 移除，
    // 不会出现电锯、铁板、靴子同时挂在身上的情况。
    this.clearStalePropVisuals(def.id);

    switch (def.id) {
      case 'iron-plate': {
        // 一次性护盾：叠加到统一护盾池，且无到期限制（shieldUntil = 0）
        this.shieldHp += ITEM.ironPlateShield;
        this.ironPlateActive = true;
        this.attachIronPlate();
        break;
      }
      case 'boots': {
        // 临时加速：记录加成，失效时扣回
        this.bootSpeedBonus = ITEM.bootsSpeedBonus;
        this.player.speed += this.bootSpeedBonus;
        this.attachBoots();
        break;
      }
      case 'chainsaw': {
        this.attachChainsaw();
        break;
      }
      case 'bouncing-orb':
      case 'boomerang': {
        // 投掷类道具：拾取后很快先来一发（蓄力由 tickItems 驱动）
        this.attackPhase = 'idle';
        this.attackTimer = BASIC_ATTACK.firstDelayMs * 0.4;
        break;
      }
      default:
        break;
    }
  }

  /** 道具失效：回退其效果并摘除外观（一次性道具不会走到这里） */
  private deactivateItem(def: ItemDef): void {
    switch (def.id) {
      case 'boots': {
        if (this.bootSpeedBonus !== 0 && this.player && this.player.active) {
          this.player.speed = Math.max(1, this.player.speed - this.bootSpeedBonus);
        }
        this.bootSpeedBonus = 0;
        this.detachBoots();
        break;
      }
      case 'chainsaw': {
        this.detachChainsaw();
        break;
      }
      case 'iron-plate': {
        this.detachIronPlate();
        break;
      }
      case 'bouncing-orb':
      case 'boomerang': {
        // 停止投掷：撤掉正在举着的图标
        this.cancelWindup();
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ 手持/穿戴外观

  /** 把电锯挂到右手（带连接件、链条、火花） */
  private attachChainsaw(): void {
    if (!this.player || this.sawRig) return;
    this.sawRig = new SawRig(this);
    this.sawRig.setShown(true);
    // 挂在右手末端：略向前外探，随手臂摆动
    this.player.getRig().attachLimbProp('armR', this.sawRig, {
      offsetX: 4,
      offsetY: 2,
      rotFollow: 0.6,
      baseDeg: 8
    });
    this.chainsawTimer = ITEM.chainsawHitIntervalMs;
    // 装备瞬间先响一声，方便确认拿到锯子
    sfx.play('chainsaw');
  }

  private detachChainsaw(): void {
    if (!this.player) return;
    // 锯子被替换/到期：立即掐断仍在播放的锯子音效
    sfx.stop('chainsaw');
    this.player.getRig().releaseSawRaise();
    this.player.getRig().detachLimbProp('armR');
    try { this.sawRig?.safeDestroy(); } catch { /* 忽略 */ }
    this.sawRig = undefined;
  }

  /** 把铁板盾牌挂到左手 */
  private attachIronPlate(): void {
    if (!this.player || this.ironPlateProp) return;
    const img = this.add.image(0, 0, ASSET_KEYS.itemIronPlate);
    img.setDisplaySize(30, 34);
    img.setDepth(25);
    this.ironPlateProp = img;
    this.player.getRig().attachLimbProp('armL', img, {
      offsetX: 4,
      offsetY: 0,
      rotFollow: 0.5,
      baseDeg: -6
    });
  }

  private detachIronPlate(): void {
    if (!this.player) return;
    this.player.getRig().detachLimbProp('armL');
    this.ironPlateProp?.destroy();
    this.ironPlateProp = undefined;
  }

  /**
   * 左右脚各穿一只靴子。
   *
   * 目标是「靴子覆盖腿部贴图里原本的脚部区域」，而非挂在脚底的小挂饰。
   * 关键实测（见 ZOMBIE_PART_LAYOUT 的贴图坐标）：
   *   - 腿部贴图约 19px 宽、29.5px 高；脚部约占最下方 ~28%，即脚高约 11px；
   *   - 左脚贴图里的脚在轴心「左侧」（约 -6px），右脚在轴心「右侧」（约 +6px），
   *     两条腿是向外撇开的站姿，所以靴子必须带一个水平偏移才能盖到脚上；
   *   - 贴图里左脚脚尖朝左、右脚脚尖朝右：靴子贴图默认朝右，
   *     因此左靴镜像（脚尖朝左）、右靴不镜像（脚尖朝右）。
   * 锚点用 alongFrac 落在脚部区域（腿最下方），并让靴子完整跟随腿部旋转
   * （rotFollow=1），站立 / 走路时都能严丝合缝地贴在脚上。
   */
  private attachBoots(): void {
    if (!this.player || this.bootsPropL) return;
    const rig = this.player.getRig();

    const BOOT_W = 16;
    const BOOT_H = 12;
    // 锚点：腿长最下方（脚部）。0.9 比末端 1.0 略高，使靴子盖住脚踝到脚底，
    // 而不是只贴在脚底那一个点。
    const ALONG = 0.9;

    // 左靴：脚尖朝左（镜像），水平偏移到左脚位置（轴心左侧），略微上移盖住脚
    const l = this.add.image(0, 0, ASSET_KEYS.itemBoots);
    l.setDisplaySize(BOOT_W, BOOT_H);
    l.setFlipX(true);
    l.setVisible(true);
    l.setDepth(24);
    this.bootsPropL = l;
    rig.attachLimbProp('legL', l, { offsetX: -6, offsetY: -4, rotFollow: 1, alongFrac: ALONG });

    // 右靴：脚尖朝右（不镜像），水平偏移到右脚位置（轴心右侧），略微上移盖住脚
    const r = this.add.image(0, 0, ASSET_KEYS.itemBoots);
    r.setDisplaySize(BOOT_W, BOOT_H);
    r.setVisible(true);
    r.setDepth(24);
    this.bootsPropR = r;
    rig.attachLimbProp('legR', r, { offsetX: 6, offsetY: -4, rotFollow: 1, alongFrac: ALONG });
  }

  private detachBoots(): void {
    if (!this.player) return;
    const rig = this.player.getRig();
    rig.detachLimbProp('legL');
    rig.detachLimbProp('legR');
    this.bootsPropL?.destroy();
    this.bootsPropR?.destroy();
    this.bootsPropL = undefined;
    this.bootsPropR = undefined;
  }

  /** 场景清理/重置时摘除所有外观 */
  private clearAllPropVisuals(): void {
    this.detachChainsaw();
    this.detachIronPlate();
    this.detachBoots();
  }

  /**
   * 摘掉所有「不属于 keepId 这件道具」的外观。
   *
   * 用于保证「一次只显示一件道具的外观」：拾取新道具时，
   * 把旧道具的贴图彻底移除，让新道具的贴图覆盖上去。
   */
  private clearStalePropVisuals(keepId: ItemId): void {
    if (keepId !== 'chainsaw') this.detachChainsaw();
    if (keepId !== 'iron-plate') this.detachIronPlate();
    if (keepId !== 'boots') this.detachBoots();
  }

  /**
   * 每帧推进道具相关逻辑：地面掉落拾取、手持槽计时、手持电锯动画、
   * 链锯自动锯伤、僵尸普攻（弹球/回力镖交替）。
   */
  private tickItems(dt: number): void {
    if (!this.itemSystem || !this.player || !this.player.active) return;

    // 地面道具 + 手持槽计时
    this.itemSystem.update(dt, this.player.x, this.player.y, this.alive && !this.gameOver);

    // 手持电锯：滚动链子 + 火花（位置由骨骼系统摆到手上）
    if (this.sawRig && this.itemSystem.currentId === 'chainsaw') {
      this.sawRig.setEating(this.isEatingNow);
      this.sawRig.update(dt);
      this.tickChainsawDamage(dt);
    }

    // 投掷类道具（弹球 / 回力镖）：只有持有对应道具时才甩手出手
    const weapon = this.currentThrowKind();
    if (weapon) {
      this.tickThrowAttack(dt, weapon);
    } else if (this.attackPhase === 'windup') {
      // 持有物中途被换掉（或到期）：撤掉正在举着的图标
      this.cancelWindup();
    }

    this.stepOrbs(dt);
    this.stepBoomerangs(dt);
  }

  /** 当前手持的道具是否是可投掷的武器（弹球/回力镖） */
  private currentThrowKind(): 'orb' | 'boomerang' | null {
    const id = this.itemSystem?.currentId;
    if (id === 'bouncing-orb') return 'orb';
    if (id === 'boomerang') return 'boomerang';
    return null;
  }

  /** 撤掉蓄力中的图标并回到空档 */
  private cancelWindup(): void {
    this.heldIcon?.destroy();
    this.heldIcon = undefined;
    this.attackPhase = 'idle';
    this.windupTimer = 0;
    this.pendingKind = null;
  }

  /**
   * 链锯自动锯伤：对僵尸「面朝的格子」里的植物周期性造成啃食伤害。
   *
   * 需求：
   *   - 只打「正前方那一格」（同排、朝 facing 方向的一格），上下/其他方向无伤害；
   *   - 伤害等同普通啃食（player.biteDamage），并非独立的锯伤数值；
   *   - 频率是正常啃食的 2 倍：间隔 = PLANT_BITE_INTERVAL × 0.5；
   *   - 不改动链锯贴图，也不额外弹火花的攻击表现（沿用现有锯子视觉）。
   *
   * 一击致死时同样标记为「啃食击杀」，使掉落规则与真实啃食一致。
   */
  /**
   * 空格链锯重击：锯子放大、持锯手抬起，攻击朝向前方 1~2 格的植物。
   * 方向取最近一次移动输入，支持上下左右，不再只认左右 facing。
   */
  private tryChainsawSlam(): void {
    if (!this.alive || this.gameOver) return;
    if (!this.player || !this.player.active || this.player.isDead) return;
    if (!this.spawner) return;
    if (this.itemSystem?.currentId !== 'chainsaw' || !this.sawRig) return;
    if (this.chainsawSlamCd > 0) return;

    this.chainsawSlamCd = 650;
    this.sawRig.pulse();
    // 抬手动作放慢到 650ms，确保玩家能看清“手举起”而不是一闪而过
    const dir = this.player.facingDirection;
    this.player.getRig().setAimDirection(dir.dc, dir.dr);
    this.player.getRig().startSawRaise('armR', 650);
    sfx.play('chainsaw');

    const damage = Math.max(1, Math.round(this.player.biteDamage * 2));
    for (let offset = 1; offset <= 2; offset++) {
      const cell = this.player.getForwardCell(offset);
      const target = this.spawner.plants.find(
        (p) =>
          p &&
          p.active &&
          !p.isDying &&
          p.col === cell.col &&
          p.row === cell.row
      );
      if (!target) continue;

      target.markKilledByBite();
      const destroyed = target.takeDamage(damage);
      if (!destroyed) target.unmarkKilledByBite();
    }
  }

  /**
   * 防“植物全挤在死角、打不到站桩僵尸”的救援逻辑：
   * 玩家在同一格静止 6 秒，且场上没有任何植物能攻击到玩家 → 自动淘汰一株，
   * 在更远/更可能形成攻击线的位置补一株；超过 2 分钟必补宗门剑士。
   */
  private tickAntiStuck(dt: number): void {
    if (!this.alive || this.gameOver || !this.player || !this.spawner) return;
    if (this.stuckRelocateCd > 0) this.stuckRelocateCd -= dt;

    const pc = this.player.cellCol;
    const pr = this.player.cellRow;
    const sameCell = pc === this.lastStuckCol && pr === this.lastStuckRow;
    this.lastStuckCol = pc;
    this.lastStuckRow = pr;

    if (!sameCell) {
      this.stuckNoAttackMs = 0;
      return;
    }

    let canAttack = false;
    for (const plant of this.spawner.plants) {
      if (!plant || !plant.active || plant.isDying) continue;
      if (plant.type === 'swordsman') {
        canAttack = true;
        break;
      }
      if (
        (plant.type === 'shooter' || plant.type === 'ice') &&
        (plant.col === pc || plant.row === pr)
      ) {
        canAttack = true;
        break;
      }
    }

    if (canAttack) {
      this.stuckNoAttackMs = 0;
      return;
    }

    this.stuckNoAttackMs += dt;
    if (this.stuckNoAttackMs < 6000 || this.stuckRelocateCd > 0) return;
    this.stuckNoAttackMs = 0;
    this.stuckRelocateCd = 4000;
    this.relocatePlantForStuckPlayer();
  }

  /** 自动淘汰一株打不到人的植物，并在新区域补一株 */
  private relocatePlantForStuckPlayer(): void {
    if (!this.spawner || !this.grid || !this.player) return;
    const plants = this.spawner.plants.filter(
      (p) => p && p.active && !p.isDying
    );
    if (plants.length === 0) return;

    // 优先移走普通/辅助植物，避免误删唯一能攻击的宗门剑士
    const candidates = plants.filter((p) => p.type !== 'swordsman');
    const pool = candidates.length > 0 ? candidates : plants;
    const pc = this.player.cellCol;
    const pr = this.player.cellRow;
    pool.sort((a, b) => {
      const da = Math.abs(a.col - pc) + Math.abs(a.row - pr);
      const db = Math.abs(b.col - pc) + Math.abs(b.row - pr);
      return db - da;
    });
    const target = pool[0];
    if (!target) return;

    this.spawner.remove(target);
    if (this.grid.isOccupied(target.col, target.row)) {
      this.grid.release(target.col, target.row);
    }
    this.clearWallBarriers(target);
    target.destroy();

    const type: PlantType =
      this.spawner.elapsedMs >= 120000
        ? 'swordsman'
        : Phaser.Utils.Array.GetRandom<PlantType>([
            'shooter',
            'ice',
            'slow',
            'wall'
          ]);

    const cell = this.findRelocationCell(target.col, target.row, type);
    if (cell) {
      this.spawner.spawnAt(cell.col, cell.row, type);
    }
  }

  /** 为救援补种找格：优先与玩家同行/列，且远离旧位置和其他植物 */
  private findRelocationCell(
    oldCol: number,
    oldRow: number,
    type: PlantType
  ): { col: number; row: number } | null {
    if (!this.grid) return null;
    const pc = this.player?.cellCol ?? 0;
    const pr = this.player?.cellRow ?? 0;
    const wantsLine = type === 'shooter' || type === 'ice';

    let best: { col: number; row: number } | null = null;
    let bestScore = -Infinity;
    for (let row = 0; row < this.grid.rows; row++) {
      for (let col = 0; col < this.grid.cols; col++) {
        if (col === pc && row === pr) continue;
        if (col === oldCol && row === oldRow) continue;
        if (!this.grid.isFree(col, row)) continue;
        if (this.grid.isHouse(col, row)) continue;
        if (!this.grid.hasWalkableNeighbor(col, row)) continue;

        const aligned = col === pc || row === pr;
        // 优先与玩家同行/列；实在没有时仍选一个空格补种，避免越救越少

        const distOld = Math.abs(col - oldCol) + Math.abs(row - oldRow);
        let nearestPlant = 99;
        for (const plant of this.spawner.plants) {
          if (!plant || !plant.active) continue;
          nearestPlant = Math.min(
            nearestPlant,
            Math.abs(plant.col - col) + Math.abs(plant.row - row)
          );
        }
        const distPlayer = Math.abs(col - pc) + Math.abs(row - pr);
        const score =
          (wantsLine && aligned ? 100 : aligned ? 20 : 0) +
          Math.min(distOld, 8) * 4 +
          Math.min(nearestPlant, 4) * 3 -
          Math.abs(distPlayer - 4) * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { col, row };
        }
      }
    }
    return best;
  }

  private tickChainsawDamage(dt: number): void {
    if (!this.player || !this.spawner) return;
    this.chainsawTimer -= dt;
    if (this.chainsawTimer > 0) return;
    // 2 倍啃食速度 = 间隔减半
    this.chainsawTimer = Math.max(60, PLANT_BITE_INTERVAL * 0.5);

    // 面朝的格子：同排、朝 facing 方向的一格（不处理上下，天然无上下伤害）
    const targetCol = this.player.cellCol + this.player.facing;
    const targetRow = this.player.cellRow;

    // 找到该格上的存活植物
    let target: Plant | null = null;
    for (const p of this.spawner.plants) {
      if (!p || !p.active || p.isDying) continue;
      if (p.col === targetCol && p.row === targetRow) {
        target = p;
        break;
      }
    }
    if (!target) return;

    // 锯子切割音效（每锯到一下响一次，节流由 sfx 配置兜底）
    sfx.play('chainsaw');

    // 伤害与普通啃食一致（含商店永久攻击力）
    const dmg = this.player.biteDamage > 0 ? this.player.biteDamage : PLANT_BITE_DAMAGE;
    // 与 CombatSystem 同一套「啃食击杀」标记，保证掉落判定一致
    target.markKilledByBite();
    const destroyed = target.takeDamage(dmg);
    if (!destroyed) {
      target.unmarkKilledByBite();
    }
  }

  /**
   * 投掷类道具的攻击节奏：弹球 / 回力镖。
   *
   * 分两段，做出「甩手把东西丢出去」的观感：
   *   1) 蓄力（windup）：右手举起一个图标（举着要丢的东西）；
   *   2) 出手（release）：到点瞬间摘掉图标，同时从手部生成真正的弹体，
   *      并让骨骼里的甩手动作为此刻向前甩出。
   *
   * @param kind 当前要投出的武器类型（由当前手持道具决定）
   */
  private tickThrowAttack(dt: number, kind: 'orb' | 'boomerang'): void {
    if (this.attackPhase === 'windup') {
      this.windupTimer -= dt;
      // 举着的图标每帧跟着手走（骨骼每帧更新完手部位置后再摆）
      if (this.heldIcon && this.player) {
        const h = this.player.getRightHandWorld();
        this.heldIcon.setPosition(h.x, h.y);
      }
      if (this.windupTimer <= 0) {
        this.releaseAttack();
      }
      return;
    }

    // 空档：到点开始蓄力
    this.attackTimer -= dt;
    if (this.attackTimer > 0) return;
    this.beginWindup(kind);
  }

  /** 开始蓄力：右手举起图标 + 触发甩手动作 */
  private beginWindup(kind: 'orb' | 'boomerang'): void {
    if (!this.player || !this.player.active) return;
    const isOrb = kind === 'orb';

    // 手上举的图标：用攻击物的贴图，缩小成「握在手里」的尺寸
    const key = isOrb ? ASSET_KEYS.itemBouncingOrb : ASSET_KEYS.itemBoomerang;
    const icon = this.add.image(this.player.x, this.player.y, key);
    icon.setDisplaySize(isOrb ? 20 : 24, isOrb ? 20 : 22);
    icon.setDepth(31);
    this.heldIcon = icon;
    this.pendingKind = kind;

    // 触发骨骼甩手（蓄力 -> 出手 -> 收回）
    this.player.getRig().startThrow('armR', BASIC_ATTACK.throwMs);

    this.attackPhase = 'windup';
    // 出手帧 = 总时长 × releaseAt
    this.windupTimer = BASIC_ATTACK.throwMs * BASIC_ATTACK.releaseAt;
  }

  /** 出手：摘掉手上图标，生成真正弹体，重置空档计时 */
  private releaseAttack(): void {
    const kind = this.pendingKind;
    this.attackPhase = 'idle';
    this.windupTimer = 0;
    this.pendingKind = null;

    // 手上的图「脱手」——直接销毁，视觉上交给新生成的弹体
    this.heldIcon?.destroy();
    this.heldIcon = undefined;

    if (!this.player || !this.player.active) return;

    if (kind === 'orb') {
      this.fireOrb();
    } else if (kind === 'boomerang') {
      this.fireBoomerang();
    }

    // 从「出手帧」开始计下一次攻击的空档
    this.attackTimer = BASIC_ATTACK.intervalMs;
  }

  /** 从右手生成一颗弹射异球（朝面朝方向略偏） */
  private fireOrb(): void {
    if (!this.player || !this.player.active) return;
    const h = this.player.getRightHandWorld();
    const dx = this.player.facing;
    const dy = -0.35;
    const orb = new BouncingOrb(this, h.x, h.y, dx, dy, this.gridRect);
    this.orbs.push(orb);
  }

  /** 从右手投出一枚回力镖 */
  private fireBoomerang(): void {
    if (!this.player || !this.player.active) return;
    sfx.play('boomerangThrow');
    const h = this.player.getRightHandWorld();
    const dx = this.player.facing;
    const b = new Boomerang(this, h.x, h.y, dx, 0, () => {
      const p = this.player;
      if (!p || !p.active || p.isDead) return null;
      return p.getRightHandWorld();
    });
    this.boomerangs.push(b);
  }

  /** 收集当前存活的植物作为可命中目标（弹球 / 回力镖共用结构） */
  private collectPlantTargets(): Array<OrbHitTarget & BoomerangHitTarget> {
    const list: Array<OrbHitTarget & BoomerangHitTarget> = [];
    if (!this.spawner) return list;
    for (const p of this.spawner.plants) {
      if (!p || !p.active || p.isDying) continue;
      const plant = p;
      list.push({
        x: plant.x,
        y: plant.y,
        radius: Math.max(16, plant.getRadius()),
        alive: () => plant.active && !plant.isDying,
        apply: (damage: number) => {
          if (plant.active && !plant.isDying) plant.takeDamage(damage);
        }
      });
    }
    return list;
  }

  /** 推进所有弹球，处理命中 */
  private stepOrbs(dt: number): void {
    if (this.orbs.length === 0) return;
    const targets = this.collectPlantTargets();

    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      if (!orb || !orb.active || !orb.isLive) {
        this.orbs.splice(i, 1);
        continue;
      }

      const hits = orb.step(dt, targets);
      for (const t of hits) {
        t.apply(ITEM.orbDamage);
      }
      if (!orb.isLive) this.orbs.splice(i, 1);
    }
  }

  /** 推进所有回力镖，处理命中 */
  private stepBoomerangs(dt: number): void {
    if (this.boomerangs.length === 0) return;
    const targets = this.collectPlantTargets();

    for (let i = this.boomerangs.length - 1; i >= 0; i--) {
      const b = this.boomerangs[i];
      if (!b || !b.active || !b.isLive) {
        this.boomerangs.splice(i, 1);
        continue;
      }

      const hits = b.step(dt, targets);
      for (const t of hits) {
        t.apply(ITEM.boomerangDamage);
      }
      if (!b.isLive) this.boomerangs.splice(i, 1);
    }
  }

  // ------------------------------------------------------------ 商店

  /**
   * 打开商店。
   *
   * 与暂停菜单同一套机制：pause 本场景（冻结计时/生成/碰撞），
   * 再 launch 一个覆盖层 ShopScene。商店只做 UI，扣币与加成都回调到这里。
   */
  private openShop(): void {
    if (!this.alive || this.gameOver) return;
    if (this.scene.isActive(SCENE_KEYS.shop)) return;
    if (this.scene.isActive(SCENE_KEYS.pause)) return;

    sfx.setEating(false);
    this.clearTouchInput();
    this.swords?.clear(true, true);
    ads.gameplayStop();
    // 背景音乐：商店 → 切到菜单曲
    bgm().enterMenu();
    this.scene.pause();
    this.scene.launch(SCENE_KEYS.shop, {
      coins: this.timer ? this.timer.coinCount : 0,
      items: this.buildShopItems(),
      itemOffers: this.buildItemShopItems(),
      superItems: this.buildSuperItems(),
      owned: [...this.ownedShopItems],
      purchase: (item: ShopItem) => this.purchaseShopItem(item),
      onClose: () => {
        this.scene.resume(SCENE_KEYS.game);
        this.activatePendingStarInvincibility();
      }
    });
  }

  /**
   * 打开设置面板。
   *
   * 与商店/暂停同一套覆盖层机制：pause 本场景再 launch SettingsScene。
   * 语言切换后，HUD 通过 onLanguageChange 自行刷新；商店/设置层重新打开即为新语言。
   */
  private openSettings(): void {
    if (!this.alive || this.gameOver) return;
    if (this.scene.isActive(SCENE_KEYS.settings)) return;

    sfx.setEating(false);
    this.clearTouchInput();
    ads.gameplayStop();
    // 背景音乐：设置面板 → 切到菜单曲
    bgm().enterMenu();
    this.scene.pause();
    this.scene.launch(SCENE_KEYS.settings, {
      onClose: () => this.scene.resume(SCENE_KEYS.game),
      onLanguageChanged: () => {
        // HUD 订阅了 onLanguageChange，会自动刷新；这里仅保留钩子以备扩展
      }
    });
  }

  /**
   * 构建当前商店应展示的商品列表。
   *
   * - 未满级：普通消耗/增益商品（可反复购买）。
   * - 已满级：切换为三种「永久成长」商品（价格随购买次数递增）。
   */
  private buildShopItems(): ShopItem[] {
    // 普通增益页始终显示；超级商店单独一页
    return SHOP_ITEMS.map((it) => ({
      ...it,
      name: t(`shopitem.${it.id}.name`),
      desc: t(`shopitem.${it.id}.desc`)
    }));
  }

  /** 超级商店：永久成长；未满级时显示但锁定 */
  private buildSuperItems(): ShopItem[] {
    return buildGrowthItems(
      this.growthLevels,
      !this.evolution?.isMaxStage
    ).map((it) => ({
      ...it,
      name: t(`shopitem.${it.id}.name`),
      desc: t(`shopitem.${it.id}.desc`)
    }));
  }

  /**
   * 构建商店「道具」页的商品列表。
   *
   * 复用 ShopItem 结构，用 `effect: 'item:<id>'` 标记为道具购买，
   * 这样购买流程（校验→扣币→效果）与增益页完全共用，无需两套扣币逻辑。
   * 道具可重复购买（每次购买立即生效到手持槽）。
   */
  private buildItemShopItems(): ShopItem[] {
    return (Object.keys(ITEMS) as ItemId[]).map((id) => {
      const def = ITEMS[id];
      const bought = this.itemPurchaseCounts[id] ?? 0;
      return {
        id: `item-${id}`,
        name: t(`item.${id}.name`),
        desc: t(`item.${id}.desc`),
        price: def.price + bought * 5,
        effect: `item:${id}` as ShopItem['effect'],
        amount: 0,
        repeatable: true,
        accent: def.accent
      } as ShopItem;
    });
  }

  /** 记录满级基准属性（首次进入满级时调用一次） */
  private ensureGrowthBase(): void {
    if (this.growthBase.maxHp > 0 || !this.player) return;
    this.growthBase.maxHp = this.player.maxHp;
    this.growthBase.speed = this.player.speed;
    this.growthBase.bite = this.player.getBiteBaseDamage();
  }

  /**
   * 商店购买的真实结算：校验 → 扣币 → 施加效果。
   *
   * 返回最新余额与已拥有列表，供商店刷新界面。
   * 任何一步失败都返回 ok=false 且不产生副作用（不扣币）。
   */
  private purchaseShopItem(item: ShopItem): {
    ok: boolean;
    coins: number;
    owned: ReadonlyArray<string>;
    reason?: string;
    items?: ShopItem[];
    superItems?: ShopItem[];
  } {
    const coinsNow = this.timer ? this.timer.coinCount : 0;

    // 不可重复商品：已拥有则拒绝
    if (!item.repeatable && this.ownedShopItems.includes(item.id)) {
      return { ok: false, coins: coinsNow, owned: [...this.ownedShopItems], reason: t('shop.toast.owned') };
    }
    if (coinsNow < item.price) {
      return { ok: false, coins: coinsNow, owned: [...this.ownedShopItems], reason: t('shop.toast.notEnough') };
    }
    // 玩家已死 / 场景已结束：拒绝
    if (!this.alive || this.gameOver || !this.player || !this.player.active || this.player.isDead) {
      return { ok: false, coins: coinsNow, owned: [...this.ownedShopItems], reason: t('shop.cannotBuy') };
    }
    if (item.locked || (item.effect.startsWith('growth-') && !this.evolution?.isMaxStage)) {
      return { ok: false, coins: coinsNow, owned: [...this.ownedShopItems], reason: t('shop.toast.locked') };
    }

    // 先扣币，再应用效果
    if (!this.timer || !this.timer.spend(item.price)) {
      return { ok: false, coins: coinsNow, owned: [...this.ownedShopItems], reason: t('shop.toast.notEnough') };
    }

    this.applyShopEffect(item);

    if (!item.repeatable) this.ownedShopItems.push(item.id);

    // 道具页：购买后该道具涨价，让“反复买同一件”逐渐变贵
    let isItem = false;
    if (item.effect.startsWith('item:')) {
      isItem = true;
      const itemId = item.effect.slice('item:'.length) as ItemId;
      this.itemPurchaseCounts[itemId] =
        (this.itemPurchaseCounts[itemId] ?? 0) + 1;
    }

    // 购买反馈：只走商店自己的 toast。
    // 不要在这里调用 GameScene.cameras.main.flash —— 商店是叠在游戏画面上的
    // 半透明覆盖层，底层相机闪一下会让地图区域整片变色。
    this.hud?.flashMessage(tf('flash.bought', { name: item.name }), '#8fe388');

    // 满级成长商品：返回刷新后的列表（价格已随购买提升）
    const isGrowth = item.effect.startsWith('growth-');
    const superItems = this.buildSuperItems();
    return {
      ok: true,
      coins: this.timer.coinCount,
      owned: [...this.ownedShopItems],
      // 道具页购买后价格变化；成长商品在“超级商店”页刷新
      items: isItem
        ? this.buildItemShopItems()
        : isGrowth
          ? superItems
          : undefined,
      superItems
    };
  }

  /** 把商品效果施加到玩家 / 游戏状态 */
  private applyShopEffect(item: ShopItem): void {
    const p = this.player;
    if (!p || !p.active) return;

    // 道具页：`item:<id>` → 直接放入手持槽并立即生效
    if (item.effect.startsWith('item:')) {
      const itemId = item.effect.slice('item:'.length) as ItemId;
      if (ITEMS[itemId]) {
        const activated = this.itemSystem?.activate(itemId) ?? false;
        if (!activated) {
          this.player.growMaxHp(25);
          this.hud?.flashMessage(
            tf('flash.sawAbsorb', { name: t(`item.${itemId}.name`) }),
            '#8fe388'
          );
        } else {
          this.flavorTicker?.show(t(`item.${itemId}.flavor`), '#ffd166');
        }
      }
      return;
    }

    switch (item.effect) {
      case 'heal':
        p.heal(item.amount);
        break;
      case 'max-hp':
        // 走 growMaxHp，让这份上限与「吃植物成长」一样被记入 maxHpBonus，
        // 从而进化重算 maxHp 时不会被覆盖。商店商品保持「买完回满血」的原手感。
        p.growMaxHp(item.amount, false);
        p.heal(p.maxHp);
        break;
      case 'shield':
        this.shieldHp += Math.max(1, Math.round(item.amount));
        if (item.durationMs && item.durationMs > 0) {
          this.shieldUntil = this.time.now + item.durationMs;
        }
        break;
      case 'invincible':
        // 商店内先记账，关闭商店后再开始 5 秒无敌
        this.pendingStarInvincibleMs = Math.max(
          this.pendingStarInvincibleMs,
          Math.max(1, Math.round(item.amount))
        );
        break;
      case 'speed':
        p.speed += item.amount;
        break;
      case 'evolution':
        this.evolution?.addPoints(item.amount);
        break;
      case 'growth-hp':
      case 'growth-atk':
      case 'growth-speed':
        this.applyGrowth(item);
        break;
      default:
        break;
    }
  }

  /**
   * 施加「永久成长」效果（满级后专属）。
   *
   * 每次购买让对应属性的等级 +1，属性 = 满级基准 × (1 + 0.25 × level)。
   * 用「基准 × 系数」而不是在本值上反复 +25%，避免整数/浮点累积漂移。
   */
  private applyGrowth(item: ShopItem): void {
    const p = this.player;
    if (!p || !p.active) return;

    this.ensureGrowthBase();

    const lv = (this.growthLevels[item.id] ?? 0) + 1;
    this.growthLevels[item.id] = lv;
    const mul = 1 + GROWTH_PER_LEVEL * lv;

    switch (item.effect) {
      case 'growth-hp':
        // 成长只改「基础上限」，吃植物攒下的额外上限（maxHpBonus）保留
        p.setMaxHpBase(Math.round(this.growthBase.maxHp * mul));
        p.hp = p.maxHp;
        break;
      case 'growth-atk':
        p.setBiteBaseDamage(Math.round(this.growthBase.bite * mul));
        break;
      case 'growth-speed':
        p.speed = Math.round(this.growthBase.speed * mul * 10) / 10;
        break;
      default:
        break;
    }
  }

  /**
   * 僵尸闲置待机音效：玩家一段时间没有动作（不在冲刺、不在啃食）时，
   * 每隔一个带随机抖动的间隔播放一次「僵尸待机」音效。
   *
   * 只要玩家有任何动作就把计时清零，保证音效只在真正闲置时出现，
   * 且不会在连续移动/啃食时打扰。
   */
  private tickIdleSfx(dt: number): void {
    const p = this.player;
    const busy = !p || !p.active || p.isDashing || p.isEating;
    if (busy) {
      // 有动作：清零并重新随机下一次的间隔
      this.idleSfxTimer = 0;
      this.idleSfxInterval = 0;
      return;
    }

    if (this.idleSfxInterval <= 0) {
      // 6~11 秒随机
      this.idleSfxInterval = 6000 + Math.random() * 5000;
    }

    this.idleSfxTimer += dt;
    if (this.idleSfxTimer >= this.idleSfxInterval) {
      sfx.play('zombieIdle');
      this.idleSfxTimer = 0;
      this.idleSfxInterval = 6000 + Math.random() * 5000;
    }
  }

  /**
   * 玩家是否「持有铁板或锯子」（用于命中音效区分护甲/肉身）。
   *
   * 铁板以 ironPlateActive 标记；锯子以当前手持道具 id 判断。
   */
  private isPlayerArmored(): boolean {
    return this.ironPlateActive || this.itemSystem?.currentId === 'chainsaw';
  }

  /**
   * 玩家受伤统一入口（带护盾吸收）。
   *
   * 所有伤害来源（豌豆、追踪剑）都走这里，保证护盾逻辑只有一处。
   * 返回玩家是否因这次伤害死亡。
   */
  private dealDamageToPlayer(amount: number): boolean {
    if (!this.player || !this.player.active || this.player.isDead) return false;

    // 复活后的短暂无敌：广告复活不能一落地就被满屏弹幕秒掉
    if (
      (this.invulnerableUntil > 0 && this.time.now < this.invulnerableUntil) ||
      this.starInvincibleRemainingMs > 0
    ) {
      return false;
    }

    let remaining = amount;
    // 护盾：shieldUntil === 0 表示「无到期限制」（铁板道具），否则在有效期内生效
    const shieldValid = this.shieldUntil === 0 || this.time.now <= this.shieldUntil;
    if (this.shieldHp > 0 && shieldValid) {
      const absorbed = Math.min(this.shieldHp, remaining);
      this.shieldHp -= absorbed;
      remaining -= absorbed;
      if (this.shieldHp <= 0) {
        this.shieldHp = 0;
        this.shieldUntil = 0;
        this.ironPlateActive = false;
        // 护盾被打碎：摘掉手上的铁板
        this.detachIronPlate();
      }
    }

    if (remaining <= 0) return false;
    return this.player.takeDamage(remaining);
  }

  /** 护盾吸收反馈：让玩家明确看到「打在铁板上」，而不是穿模 */
  private showShieldAbsorb(amount: number): void {
    const p = this.player;
    if (!p || !p.active || amount <= 0) return;

    const ring = this.add
      .circle(p.x, p.y - 44, 24, 0x9fd8ff, 0.12)
      .setStrokeStyle(3, 0xaee6ff, 0.95)
      .setDepth(31);
    this.tweens.add({
      targets: ring,
      scaleX: 1.7,
      scaleY: 1.7,
      alpha: 0,
      duration: 240,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (ring.active) ring.destroy();
      }
    });

    const float = this.add
      .text(p.x, p.y - 82, tf('flash.shieldAbsorb', { n: amount }), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '18px',
        color: '#9fd8ff',
        fontStyle: 'bold',
        stroke: '#05121c',
        strokeThickness: 4
      })
      .setOrigin(0.5)
      .setDepth(32);
    this.tweens.add({
      targets: float,
      y: float.y - 22,
      alpha: 0,
      duration: 520,
      ease: 'Quad.easeOut',
      onComplete: () => float.destroy()
    });

    this.hud?.flashMessage(
      tf('flash.shieldAbsorb', { n: amount }),
      '#9fd8ff'
    );
  }


  // ------------------------------------------------------------ 碰撞

  private setupCollisions(): void {
    // 先销毁旧检测器，防止重开后回调叠加（同一颗子弹被多次结算）
    if (this.playerBulletCollider) {
      this.playerBulletCollider.destroy();
      this.playerBulletCollider = undefined;
    }

    this.playerBulletCollider = this.physics.add.overlap(
      this.bullets,
      this.player,
      (bulletObj, playerObj) => {
        this.handleBulletHitPlayer(
          bulletObj as Bullet,
          playerObj as PlayerZombie
        );
      },
      undefined,
      this
    );
  }

  /** 子弹命中玩家（Arcade overlap 回调，与扫掠共用同一结算入口） */
  private handleBulletHitPlayer(bullet: Bullet, player: PlayerZombie): void {
    // 只结算当前玩家，忽略任何残留对象
    if (player !== this.player) return;
    this.damagePlayerWithBullet(bullet);
  }

  /**
   * 子弹命中僵尸的统一结算入口。
   *
   * overlap 回调与扫掠检测都走这里，保证：
   *   - 伤害只结算一次（bullet.hasHit 兜底）
   *   - 命中特效与伤害在同一时刻发生（视觉与逻辑不脱节）
   */
  private damagePlayerWithBullet(bullet: Bullet): void {
    if (!this.alive || this.gameOver) return;
    if (!bullet || !bullet.isLive) return;

    const player = this.player;
    if (!player || !player.active || player.isDead) return;
    if (bullet === null) return;

    // 冰豌豆：命中时施加限时减速（在扣血之前，保证本帧后续步进立刻变慢）
    if (bullet.slowFactor > 0 && bullet.slowDuration > 0) {
      player.applyBulletSlow(bullet.slowFactor, bullet.slowDuration);
      this.onPlayerSlowed();
    }

    // 命中音效：区分 冰(冻蔓)/普通(基础射手) × 是否持有铁板或锯子
    const armored = this.isPlayerArmored();
    if (bullet.isIcy) {
      sfx.play(armored ? 'iceHitArmored' : 'iceHit');
    } else {
      sfx.play(armored ? 'shooterHitArmored' : 'shooterHit');
    }

    const shieldBefore = this.shieldHp;
    const died = this.dealDamageToPlayer(bullet.damage);
    const shieldAbsorbed = Math.max(0, shieldBefore - this.shieldHp);
    if (shieldAbsorbed > 0) this.showShieldAbsorb(shieldAbsorbed);
    bullet.kill();

    if (died) {
      this.handlePlayerDeath();
    }
  }

  /**
   * 被冰豌豆命中时的表现：僵尸「自身」闪一下蓝光。
   *
   * 旧实现是 cameras.main.flash 全屏蓝闪 —— 但那是「整个世界被冻」的观感，
   * 与实际只冻住了僵尸本人不符，而且太吵。改成直接给僵尸躯体染蓝，
   * 命中反馈精确落在「被冻的对象」身上。
   */
  private onPlayerSlowed(): void {
    if (!this.player || !this.player.active) return;
    this.player.flashFreeze(200);
  }

  /**
   * 子弹推进 + 扫掠命中。
   *
   * 顺序很关键：先 step() 让每颗子弹更新到本帧位置（并记录 prevX/prevY），
   * 再用「上一帧到本帧」这段区间与僵尸判定框求交。
   *
   * 子弹现在有两个飞行轴（水平 / 垂直），扫掠区间要按轴分别取：
   *   水平轴 -> 用 [prevX, x] 求交，再判 y 是否在框高内
   *   垂直轴 -> 用 [prevY, y] 求交，再判 x 是否在框宽内
   * 一维区间求交就足够，因为子弹只走直线、不拐弯。
   */
  private stepBulletsAndResolveHits(deltaMs: number): void {
    if (!this.bullets) return;

    const children = this.bullets.getChildren().slice() as Bullet[];

    // 僵尸判定框（世界坐标）；玩家已死亡时只推进子弹、不做命中
    const canHit = this.alive && !this.gameOver &&
      !!this.player && this.player.active && !this.player.isDead;
    const body = this.player?.body as Phaser.Physics.Arcade.Body | null;

    let zombieLeft = 0;
    let zombieRight = 0;
    let zombieTop = 0;
    let zombieBottom = 0;
    if (canHit && body && body.enable) {
      // 视觉僵尸比躯干碰撞体宽/高；给判定框一点外扩，避免子弹从
      // 头部、手臂或脚边“看起来打中了”却判不中。
      // 有铁板护盾时进一步覆盖整个视觉轮廓：护盾必须先挡住，
      // 绝不能让子弹从护盾边缘“穿过去”。
      const hasShield = this.shieldHp > 0 && this.ironPlateActive;
      // 常态也要覆盖视觉轮廓：护盾破掉后不能缩回窄躯干判定，
      // 否则同一位置的子弹会突然“穿过去”。
      const padX = hasShield ? 22 : 18;
      const padY = hasShield ? 30 : 26;
      zombieLeft = body.position.x - padX;
      zombieRight = body.position.x + body.width + padX;
      zombieTop = body.position.y - padY;
      zombieBottom = body.position.y + body.height + padY;
    }

    for (const b of children) {
      if (!b || !b.active) continue;
      const wasLive = b.isLive;

      // 推进：内部会更新 prevX 并同步物理体
      if (wasLive) b.step(deltaMs);

      if (!wasLive || !canHit) continue;

      if (b.axis === 'v') {
        // ---- 垂直飞行：沿 y 求交，x 需落在框宽内 ----
        if (b.x < zombieLeft || b.x > zombieRight) continue;

        const lo = Math.min(b.prevY, b.y);
        const hi = Math.max(b.prevY, b.y);
        if (hi < zombieTop || lo > zombieBottom) continue;
      } else {
        // ---- 水平飞行：沿 x 求交，y 需落在框高内 ----
        if (b.y < zombieTop || b.y > zombieBottom) continue;

        const lo = Math.min(b.prevX, b.x);
        const hi = Math.max(b.prevX, b.x);
        if (hi < zombieLeft || lo > zombieRight) continue;
      }

      this.damagePlayerWithBullet(b);

      if (!this.alive) break;
    }
  }

  // ------------------------------------------------------------ 子弹

  /**
   * 宗门剑士掷剑。
   *
   * 与豌豆的最大区别：不看行列，直接把剑射向玩家当前位置，
   * 剑自己会一路追踪过去。
   *
   * 用回调现取目标而不传引用 —— 玩家可能在剑飞行途中死亡或重生，
   * 回调拿到失效引用时返回 null，剑就自然沿惯性飞散。
   */
  private fireSword(
    plant: SwordsmanPlant,
    x: number,
    y: number,
    angle: number
  ): void {
    if (!this.alive || this.gameOver) return;
    if (!plant || !plant.active || plant.isDying) return;
    if (!this.swords) return;

    const player = this.player;
    if (!player || !player.active || player.isDead) return;

    const sword = SwordBullet.fire(
      this,
      x,
      y,
      angle,
      plant.damageFor(plant.config.bulletDamage),
      this.gridRect,
      () => {
        const p = this.player;
        if (!p || !p.active || p.isDead) return null;
        return { x: p.x, y: p.y };
      }
    );

    this.swords.add(sword, true);
  }

  /**
   * 追踪剑的推进与命中。
   *
   * 不能复用 stepBulletsAndResolveHits：那套逻辑依赖 axis（h/v）
   * 做一维区间求交，前提是「子弹只走直线」。剑每帧转向、走弧线，
   * 一维求交在拐弯处会漏判或误判。
   *
   * 这里改用「圆 × 矩形」判定：
   *   剑的判定半径取贴图短边的一半，玩家判定用物理体矩形。
   *   每帧推进后检查一次是否相交。
   *
   * 剑速 560px/s、60fps 下单帧位移约 9.3px，
   * 远小于玩家物理体（~40px 量级），不存在穿模风险，
   * 所以不需要像豌豆那样做扫掠。
   */
  private stepSwordsAndResolveHits(deltaMs: number): void {
    if (!this.swords) return;

    const children = this.swords.getChildren().slice() as SwordBullet[];
    if (children.length === 0) return;

    const canHit =
      this.alive &&
      !this.gameOver &&
      !!this.player &&
      this.player.active &&
      !this.player.isDead;

    const body = this.player?.body as Phaser.Physics.Arcade.Body | null;

    for (const s of children) {
      if (!s || !s.active) continue;
      const live = s.isLive;
      // 保险：命中后进入 fadeOut 但 tween 被打断的剑，不能永久贴在僵尸身上
      if (!live && s.hasHit) {
        s.destroy();
        continue;
      }
      if (live) s.step(deltaMs);

      // 只有「本帧推进过且仍存活」的剑才参与结算。
      // 这既避免 dead 剑被反复结算，也确保 forceHit 的剑（step 里未收尾、
      // 仍 live=true）能在本帧被判定命中。
      if (!live) continue;

      // 无法命中（玩家已死/场景结束）：forceHit 的剑没有结算机会，直接自毁兜底
      if (!canHit || !body || !body.enable) {
        if (s.forceHit) s.kill();
        continue;
      }

      // 圆 × 矩形相交
      // 命中半径取「剑短边一半」与保底半径 hitRadiusMin 的较大值，
      // 避免缩小后的剑判定框过小、从僵尸身边擦过而漏判。
      const r =
        Math.max(
          SWORDSMAN.hitRadiusMin,
          Math.min(s.displayWidth, s.displayHeight) * 0.5
        ) + (this.shieldHp > 0 && this.ironPlateActive ? 14 : 10);
      const cx = Phaser.Math.Clamp(s.x, body.position.x, body.position.x + body.width);
      const cy = Phaser.Math.Clamp(s.y, body.position.y, body.position.y + body.height);
      const dx = s.x - cx;
      const dy = s.y - cy;

      // 点对矩形 + 扫掠线段对矩形：低帧率/高速穿过静止僵尸时也不会漏判
      const sweptLine = new Phaser.Geom.Line(
        s.prevX,
        s.prevY,
        s.x,
        s.y
      );
      const sweptRect = new Phaser.Geom.Rectangle(
        body.position.x - r,
        body.position.y - r,
        body.width + r * 2,
        body.height + r * 2
      );
      const sweptHit = Phaser.Geom.Intersects.LineToRectangle(
        sweptLine,
        sweptRect
      );

      const geometricHit = dx * dx + dy * dy <= r * r || sweptHit;
      // 兜底必中：剑已满寿命且目标仍存活 → 直接结算，无视距离
      const guaranteedHit = s.forceHit;

      if (geometricHit || guaranteedHit) {
        const shieldBefore = this.shieldHp;
        const died = this.dealDamageToPlayer(s.damage);
        const shieldAbsorbed = Math.max(0, shieldBefore - this.shieldHp);
        if (shieldAbsorbed > 0) this.showShieldAbsorb(shieldAbsorbed);
        s.kill();
        // 双保险：即使 destroy 没从物理组移除，也强制从组里摘掉
        try {
          this.swords.remove(s, true, false);
        } catch {
          /* ignore */
        }
        if (died) {
          this.handlePlayerDeath();
          break;
        }
      }
    }
  }

  /**
   * 射手植物开火。
   *
   * PvZ 行为：豌豆只朝「僵尸所在方向」水平射出，不做追踪。
   * 方向由植物朝向决定（Plant.update 已把朝向转向僵尸），
   * 因此这里只需要按 plant.facing 给一个水平速度。
   */
  private fireBullet(plant: Plant): void {
    if (!this.alive || this.gameOver) return;
    if (!plant || !plant.active || plant.isDying) return;
    if (!this.player || !this.player.active || this.player.isDead) return;
    if (!this.bullets) return;

    // 十字判定（双重保险：Plant 内部已判定过一次）
    //   同一行 -> 沿水平轴打
    //   同一列 -> 沿垂直轴打
    const sameRow = this.player.cellRow === plant.row;
    const sameCol = this.player.cellCol === plant.col;
    if (!sameRow && !sameCol) return;

    // 发射音效：寒霜藤(ice) 与 基础射手(shooter) 各一套
    sfx.play(plant.type === 'ice' ? 'iceFire' : 'shooterFire');

    // 同一行时优先横向射击（避免僵尸恰好走到同列时突然改成竖射，弹道看着突兀）
    if (sameRow) {
      const dir: 1 | -1 = plant.facing;

      // 从植物「嘴部」位置射出，而不是正中心
      const muzzleX = plant.x + dir * (TILE_SIZE * 0.32);
      const muzzleY = plant.y - TILE_SIZE * 0.08;

      const b = Bullet.fireHorizontal(
        this,
        muzzleX,
        muzzleY,
        dir,
        plant.damageFor(plant.config.bulletDamage),
        this.gridRect,
        plant.config.bulletSlowFactor,
        plant.config.bulletSlowDuration
      );
      this.bullets.add(b, true);
      return;
    }

    // 同一列：竖直发射，朝僵尸所在的一侧（上或下）
    const vdir: 1 | -1 = this.player.y >= plant.y ? 1 : -1;
    const muzzleY = plant.y + vdir * (TILE_SIZE * 0.32);
    const muzzleX = plant.x;

    const b = Bullet.fire(
      this,
      muzzleX,
      muzzleY,
      vdir,
      plant.damageFor(plant.config.bulletDamage),
      this.gridRect,
      'v',
      plant.config.bulletSlowFactor,
      plant.config.bulletSlowDuration
    );
    this.bullets.add(b, true);
  }

  /** 检查子弹是否撞到房屋或墙植物 */
  private resolveBulletBlockers(): void {
    if (!this.bullets) return;

    // 先快照，避免遍历过程中 group 变更导致跳过或重复
    const children = this.bullets.getChildren().slice() as Bullet[];

    for (const b of children) {
      if (!b || !b.active || b.hasHit) continue;

      // 房屋
      let blocked = false;
      for (const r of this.houseRects) {
        if (b.x >= r.x && b.x <= r.x + r.w && b.y >= r.y && b.y <= r.y + r.h) {
          blocked = true;
          break;
        }
      }

      // 墙类植物（倒序遍历，允许中途移除）
      let hitPlant: Plant | null = null;
      if (!blocked && this.spawner) {
        for (let i = this.spawner.plants.length - 1; i >= 0; i--) {
          const p = this.spawner.plants[i];
          if (!p || !p.active || p.isDying || !p.blocksBullet) continue;
          const dx = b.x - p.x;
          const dy = b.y - p.y;
          const rad = p.getRadius();
          if (dx * dx + dy * dy <= rad * rad) {
            blocked = true;
            hitPlant = p;
            break;
          }
        }
      }

      if (blocked) {
        // 注意顺序：先扣植物血，再调 kill()。
        // 不能提前把 b.hasHit 置 true —— 新的 kill() 内部会检查该标记，
        // 提前置位会导致命中特效被直接跳过。
        if (hitPlant) hitPlant.takeDamage(b.damage);
        b.kill();
      }
    }
  }

  // ------------------------------------------------------------ 减速

  /** 根据范围内减速植物计算玩家速度倍率 */
  /**
   * 减速判定。
   *
   * 僵尸做格点步进后，位置在格间插值，像素距离会随移动抖动。
   * 这里改用「格距」（曼哈顿距离）判定，并把 slowRadius 换算成格数，
   * 保证减速范围稳定、不随帧率或插值变化。
   */
  private applySlow(): void {
    let best = 1;
    if (this.spawner && this.player && this.player.active) {
      const pc = this.player.cellCol;
      const pr = this.player.cellRow;

      for (let i = this.spawner.plants.length - 1; i >= 0; i--) {
        const p = this.spawner.plants[i];
        if (!p || !p.active || p.isDying || !p.providesSlow) continue;

        const cellDist = Math.abs(p.col - pc) + Math.abs(p.row - pr);
        const radiusInCells = Math.max(1, Math.round(p.config.slowRadius / TILE_SIZE));

        if (cellDist <= radiusInCells) {
          const mult = 1 - p.config.slowFactor;
          if (mult < best) best = mult;
        }
      }
      this.player.setSlowMultiplier(best);
    }
  }

  // ------------------------------------------------------------ 无敌星

  /** 关闭商店后真正开始 5 秒无敌 */
  private activatePendingStarInvincibility(): void {
    const ms = this.pendingStarInvincibleMs;
    this.pendingStarInvincibleMs = 0;
    if (!this.alive || this.gameOver || !this.player || this.player.isDead) return;
    if (ms <= 0) return;

    // 用“剩余游戏时间”而不是时间戳：商店暂停期间不扣，关店后完整走 5 秒
    this.starInvincibleRemainingMs = Math.max(
      this.starInvincibleRemainingMs,
      ms
    );
    this.player.getRig().setTintAll(0xffd54a);

    if (!this.starAura) {
      this.starAura = this.add
        .star(0, 0, 5, 22, 54, 0xffd54a, 0.25)
        .setDepth(19);
      this.tweens.add({
        targets: this.starAura,
        angle: 360,
        duration: 1800,
        repeat: -1,
        ease: 'Linear'
      });
    }
    if (!this.starCountdown) {
      this.starCountdown = this.add
        .text(0, 0, '5', {
          fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
          fontSize: '30px',
          color: '#ffd54a',
          fontStyle: 'bold',
          stroke: '#3b2600',
          strokeThickness: 6
        })
        .setOrigin(0.5)
        .setDepth(40);
      this.tweens.add({
        targets: this.starCountdown,
        scaleX: 1.28,
        scaleY: 1.28,
        duration: 170,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }
  }

  /** 每帧更新无敌星倒计时/光效（只扣实际游戏运行时间） */
  private updateStarInvincibility(dt: number): void {
    if (this.starInvincibleRemainingMs <= 0) return;
    if (!this.player || !this.player.active || this.player.isDead) {
      this.endStarInvincibility();
      return;
    }
    this.starInvincibleRemainingMs = Math.max(
      0,
      this.starInvincibleRemainingMs - dt
    );
    if (this.starInvincibleRemainingMs <= 0) {
      this.endStarInvincibility();
      return;
    }
    const sec = Math.ceil(this.starInvincibleRemainingMs / 1000);
    this.starCountdown?.setText(String(sec));
    this.starCountdown?.setPosition(this.player.x, this.player.y - 108);
    this.starAura?.setPosition(this.player.x, this.player.y - 56);
  }

  private endStarInvincibility(): void {
    this.starInvincibleRemainingMs = 0;
    this.player?.getRig().clearTintAll();
    if (this.starCountdown) {
      this.tweens.killTweensOf(this.starCountdown);
      this.starCountdown.destroy();
      this.starCountdown = undefined;
    }
    if (this.starAura) {
      this.tweens.killTweensOf(this.starAura);
      this.starAura.destroy();
      this.starAura = undefined;
    }
  }

  // ------------------------------------------------------------ 主循环

  /**
   * 主循环。
   *
   * 硬目标：任何输入组合下都不抛异常。
   * 两层保护：
   *  1) try/catch 包住全部逻辑，异常只记录不冒泡（否则 Phaser 会停掉该场景的 update）；
   *  2) tick 内部对关键引用判空，缺失时跳过本帧而不是崩溃。
   */
  update(_time: number, delta: number): void {
    // 夹取 delta：防止切后台回来时大跳；非法值兜底为 16。
    // 上限取 100ms（10fps）：低端机掉帧时游戏时间不会明显变慢，
    // 同时仍能挡住切后台几分钟后回来的超大 delta。
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 100) : 16;

    try {
      this.tick(dt);
    } catch (err) {
      this.reportRuntimeError(err);
    }
  }

  /** 单帧实际逻辑（被 update 保护，内部再自行判空） */
  private tick(dt: number): void {
    // 首次引导打开：冻结计时、生成、输入，点「开始」后才进入本局
    // ---- 计时：只依赖 delta 累加，只要 alive 就持续增长 ----
    // 计时器独立于输入与场景对象，放在最前面，保证它永远先跑。
    if (this.timer && this.alive) {
      this.timer.update(dt);
      // 背景音乐：本局计时达到阈值后切到 overtime（revenge 解锁后由其优先）
      bgm().tick(this.timer.elapsed);
    }

    // 已死亡：停止一切游戏逻辑（输入/生成/啃食/进化/子弹），
    // 但仍推进玩家自身的「倒下」动画与耐久条，让尸体自然倒地后消失。
    if (!this.alive) {
      sfx.setEating(false);
      // 死亡时若正在举着图标蓄力，摘掉它，避免图标悬停在原地
      if (this.attackPhase === 'windup') {
        this.cancelWindup();
      }
      if (this.player && this.player.active) {
        this.player.update(dt, { x: 0, y: 0 });
      }
      this.refreshHud();
      return;
    }

    // 核心引用判空：任一缺失都只跳过本帧，绝不让 update 抛出去
    if (!this.player || !this.player.active || !this.player.body) {
      this.refreshHud();
      return;
    }
    if (!this.spawner || !this.grid) {
      this.refreshHud();
      return;
    }

    this.applySlow();
    this.chainsawSlamCd = Math.max(0, this.chainsawSlamCd - dt);

    // 长按空格：保持锯子抬起；松开后由 keyup 放回
    if (
      this.keySpace?.isDown &&
      this.itemSystem?.currentId === 'chainsaw' &&
      this.sawRig
    ) {
      this.player.getRig().holdSawRaise('armR');
    }

    // 移动不再靠轮询：方向键的 down 事件已在 setupInput 里直接
    // 转成一次冲刺（requestDash）。这里只传空输入，
    // player.update 负责推进冲刺 Tween 与动画。
    this.player.update(dt, { x: 0, y: 0 });
    this.updateStarInvincibility(dt);

    // 僵尸闲置待机音效：隔一段时间（带抖动）响一声
    this.tickIdleSfx(dt);

    this.spawner.update(dt, this.player);
    this.spawner.updatePlants(dt, this.player, TILE_SIZE);
    this.spawner.prunePlants();
    this.tickAntiStuck(dt);

    if (this.combat) {
      this.combat.update(dt, this.keySpace?.isDown === true || this.eatHeld);
    }
    // 啃食音效循环：按住时循环；松开/离开植物后 3 秒内续播
    sfx.setEating(this.alive && this.isEatingNow);

    // 先处理阻挡（房屋/墙植物），再推进子弹并结算命中。
    // 顺序保证：一颗子弹本帧若先撞上墙，就不会再打到僵尸。
    this.resolveBulletBlockers();

    // 子弹推进 + 扫掠命中
    this.stepBulletsAndResolveHits(dt);

    // 追踪剑推进 + 命中（独立管线，走弧线）
    this.stepSwordsAndResolveHits(dt);

    // 道具：地面掉落拾取 / 手持槽计时 / 自动弹体
    this.tickItems(dt);

    this.refreshHud();
  }

  /** 记录运行时异常（限流 1 次/秒），保证主循环不中断 */
  private reportRuntimeError(err: unknown): void {
    const now = this.time?.now ?? 0;
    if (now - this.lastErrorAt < 1000) return;
    this.lastErrorAt = now;
    console.error('[GameScene] 捕获到运行时异常，已隔离以保证画面不冻结:', err);
  }

  /** 统一刷新 HUD（内部对所有对象判空） */
  private refreshHud(): void {
    if (!this.hud || !this.hud.isAlive) return;
    if (!this.timer || !this.evolution) return;

    try {
      const next = this.evolution.nextStage;
      const playerOk = !!(this.player && this.player.active);
      const hp = playerOk ? this.player.hp : 0;
      const maxHp = playerOk ? this.player.maxHp : 100;
      const pos = playerOk ? { x: this.player.x, y: this.player.y } : undefined;

      this.hud.update(
        {
          elapsedMs: this.timer.elapsed,
          hp,
          maxHp,
          shieldHp: this.shieldHp,
          stageLabel: this.evolution.stage.label,
          stageIndex: this.evolution.stageIndex,
          evolutionPoints: this.evolution.currentPoints,
          nextRequirement: next ? next.requiredPoints : null,
          coins: this.timer.coinCount,
          plantCount: this.spawner ? this.spawner.count : 0,
          eatRatio: this.alive ? this.eatRatio : 0,
          eating: this.alive ? this.isEatingNow : false
        },
        pos
      );
    } catch (err) {
      this.reportRuntimeError(err);
    }
  }

  // ------------------------------------------------------------ 反馈

  /** 升级时的粒子爆发 */
  private emitLevelUpBurst(): void {
    if (!this.player || !this.player.active) return;

    const g = this.add.graphics().setDepth(60);
    g.lineStyle(3, 0x7fe3ff, 1);
    g.strokeCircle(this.player.x, this.player.y - 30, 10);

    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: 420,
      onUpdate: (tw) => {
        // 玩家可能已死亡或场景已切换，这里必须判空
        if (!g.active || !this.player || !this.player.active) return;
        const p = tw.progress;
        g.clear();
        g.lineStyle(3, 0x7fe3ff, 1 - p);
        g.strokeCircle(this.player.x, this.player.y - 30, 10 + p * 70);
      },
      onComplete: () => {
        if (g.active) g.destroy();
      }
    });
  }

  // ------------------------------------------------------------ 结束

  private handlePlayerDeath(): void {
    if (!this.alive || this.gameOver) return;

    // 先短路：本帧后续逻辑不再处理任何游戏内容
    this.alive = false;
    this.gameOver = true;
    // 死亡时清掉所有追踪剑，避免尸体/结算面板上残留剑贴图
    this.swords?.clear(true, true);
    sfx.setEating(false);
    this.endStarInvincibility();

    // 背景音乐：切到「游戏失败之后」曲目（一次性播放）
    bgm().playFail();

    // 计时冻结：不再累加，但数值保留供结算读取（不归零）
    this.timer?.pause();
    this.combat?.abort();
    if (this.openingSpawnEvent) {
      this.openingSpawnEvent.remove(false);
      this.openingSpawnEvent = undefined;
    }

    const elapsed = this.timer ? this.timer.elapsed : 0;
    const coins = this.timer ? this.timer.coinCount : 0;
    const stageIdx = this.evolution ? this.evolution.stageIndex : 0;
    const stageLabel = t(`stage.${stageIdx}`);
    const points = this.evolution ? this.evolution.currentPoints : 0;

    // localStorage 已由 storage.ts 内部 try/catch 保护，这里再包一层兜底
    let isNewBest = false;
    let best = 0;
    try {
      isNewBest = saveBestTime(elapsed);
      best = loadBestTime();
    } catch (err) {
      this.reportRuntimeError(err);
    }

    if (this.cameras.main) {
      this.cameras.main.shake(220, 0.008);
    }

    this.clearTouchInput();
    ads.gameplayStop();

    const payload = {
      timeMs: elapsed,
      coins,
      stage: stageLabel,
      points,
      isNewBest,
      bestMs: best
    };

    // 延迟弹出复活面板；GameScene 本身不暂停（alive=false 已经冻结全部玩法），
    // 面板用更高的 depth 盖在战场上，输入只落在面板按钮上。
    this.time.delayedCall(900, () => {
      if (!this.scene.isActive() || this.gameOver === false) return;
      if (this.revivePanel?.isOpen) return;
      this.revivePanel = new RevivePanel(
        this,
        payload,
        !this.revivedThisRun,
        () => this.reviveAfterAd(),
        () => this.finishRun(payload)
      );
    });
  }

  /**
   * 看完激励视频后复活。
   *
   * 由复活面板回调；GameScene 从未 pause（只把 alive 置 false），
   * 因此这里直接恢复状态即可。保留本局的计时、尸币、进化点与商店购买，
   * 只清掉屏幕上的敌方弹体，并给 3 秒无敌，避免复活即死。
   */
  private reviveAfterAd(): void {
    this.alive = true;
    this.gameOver = false;
    this.revivedThisRun = true;
    this.clearTouchInput();

    this.timer?.resume();
    this.combat?.abort();

    // 清掉所有敌方弹体/追踪剑：复活瞬间不应被上一秒的弹幕集火
    try {
      this.bullets?.clear(true, true);
    } catch {
      /* ignore */
    }
    try {
      this.swords?.clear(true, true);
    } catch {
      /* ignore */
    }

    this.player?.revive(REVIVE_HP_RATIO);
    this.invulnerableUntil = this.time.now + REVIVE_INVULNERABLE_MS;

    // 普攻从「蓄力前」重新起步，避免死亡瞬间残留的蓄力图标
    this.attackPhase = 'idle';
    this.attackTimer = BASIC_ATTACK.firstDelayMs;
    this.cancelWindup();

    bgm().resumeRun();
    ads.gameplayStart();

    if (this.cameras.main) this.cameras.main.flash(320, 120, 255, 180, false);
    this.hud?.flashMessage(t('revive.revived'), '#8fe388');
    vibrateShort();
  }

  /** 放弃复活：关闭本局并进入结算 */
  private finishRun(payload: {
    timeMs: number;
    coins: number;
    stage: string;
    points: number;
    isNewBest: boolean;
    bestMs: number;
  }): void {
    sfx.setEating(false);
    ads.gameplayStop();
    this.swords?.clear(true, true);
    this.revivePanel?.destroy();
    this.revivePanel = undefined;
    this.scene.stop(SCENE_KEYS.game);
    this.scene.start(SCENE_KEYS.result, payload);
  }

  /** 场景关闭清理：移除监听、清空定时器与组、销毁碰撞器 */
  private cleanup(): void {
    this.alive = false;
    this.wxTouchCleanup?.();
    this.wxTouchCleanup = undefined;
    sfx.setEating(false);
    this.endStarInvincibility();
    this.clearTouchInput();
    ads.gameplayStop();
    this.revivePanel?.destroy();
    this.revivePanel = undefined;
    this.tutorialPanel?.destroy();
    this.tutorialPanel = undefined;
    this.tutorialOpen = false;
    try { this.time.paused = false; } catch { /* 场景销毁阶段忽略 */ }

    // 移除恢复监听，避免重开后叠加
    this.events.off(Phaser.Scenes.Events.RESUME, this.onSceneResume, this);

    // 移除开局计时器
    if (this.openingSpawnEvent) {
      this.openingSpawnEvent.remove(false);
      this.openingSpawnEvent = undefined;
    }

    // 销毁碰撞器，避免重开后回调叠加
    if (this.playerBulletCollider) {
      this.playerBulletCollider.destroy();
      this.playerBulletCollider = undefined;
    }

    try { this.combat?.abort(); } catch { /* 清理阶段异常忽略 */ }
    // 石墙壁垒：先清视觉与封锁，再销毁植物
    try { this.clearAllWallBarriers(); } catch { /* 忽略 */ }
    try { this.spawner?.destroyAll(); } catch { /* 清理阶段异常忽略 */ }
    try { this.bullets?.clear(true, true); } catch { /* 清理阶段异常忽略 */ }
    try { this.hud?.destroy(); } catch { /* 清理阶段异常忽略 */ }

    // ---- 道具与飞行弹体 ----
    try { this.itemSystem?.destroy(); } catch { /* 忽略 */ }
    this.itemSystem = undefined;
    for (const o of this.orbs) { try { o.kill(); } catch { /* 忽略 */ } }
    this.orbs = [];
    for (const b of this.boomerangs) { try { b.kill(); } catch { /* 忽略 */ } }
    this.boomerangs = [];
    try { this.clearAllPropVisuals(); } catch { /* 忽略 */ }
    this.heldIcon?.destroy();
    this.heldIcon = undefined;
    try { this.flavorTicker?.destroy(); } catch { /* 忽略 */ }
    this.flavorTicker = undefined;
  }

  /** 重置所有场景级状态（create 开头调用） */
  private resetSceneState(): void {
    this.alive = false;
    this.gameOver = false;
    this.eatRatio = 0;
    this.isEatingNow = false;
    this.shieldHp = 0;
    this.shieldUntil = 0;
    this.ownedShopItems = [];
    this.itemPurchaseCounts = {};
    this.growthLevels = {};
    this.growthBase = { maxHp: 0, speed: 0, bite: 0 };
    this.lastErrorAt = 0;
    this.houseRects = [];
    this.openingSpawnEvent = undefined;
    this.playerBulletCollider = undefined;

    // 道具相关残留（scene 重建时旧对象已随场景销毁，只清引用）
    this.itemSystem = undefined;
    this.flavorTicker = undefined;
    this.sawRig = undefined;
    this.ironPlateProp = undefined;
    this.bootsPropL = undefined;
    this.bootsPropR = undefined;
    this.orbs = [];
    this.boomerangs = [];
    this.attackTimer = 0;
    this.attackPhase = 'idle';
    this.windupTimer = 0;
    this.pendingKind = null;
    this.heldIcon = undefined;
    this.chainsawTimer = 0;
    this.bootSpeedBonus = 0;
    this.ironPlateActive = false;
    this.idleSfxTimer = 0;
    this.idleSfxInterval = 0;
    // 复活 / 无敌 / 触控状态
    this.revivedThisRun = false;
    this.invulnerableUntil = 0;
    this.starInvincibleRemainingMs = 0;
    this.pendingStarInvincibleMs = 0;
    this.starCountdown = undefined;
    this.starAura = undefined;
    this.chainsawSlamCd = 0;
    this.stuckNoAttackMs = 0;
    this.stuckRelocateCd = 0;
    this.lastStuckCol = -1;
    this.lastStuckRow = -1;
    this.revivePanel = undefined;
    this.tutorialPanel = undefined;
    this.tutorialOpen = false;
    this.boardPointers.clear();
    this.eatButtonHeld = false;
    this.swipeId = null;
    this.eatHeld = false;
    // 石墙壁垒映射（场景重建时旧视觉随场景销毁，只清引用）
    this.wallBarriers = new Map<Plant, Barrier[]>();
  }
}
