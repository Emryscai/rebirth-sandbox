

﻿/**
 * 全局配置：所有可调数值集中于此。
 * 修改数值优先改这里，不要散落到各系统。
 */

import { IS_MINIGAME, IS_TOUCH, getScreenSize } from './platform/env';

/**
 * 画布尺寸（动态适配手机竖屏）。
 *
 * 设计宽度固定 640（10 格 x 64px 的棋盘），高度按屏幕比例扩展：
 *   - 桌面 16:9 / 4:3：保持 640×640 正方形
 *   - 手机竖屏（如 390×844）：高度约 1385，棋盘居中，
 *     上方留给标题/品牌，下方留给触控按钮与提示
 *
 * 这样手机屏幕上不会出现「正方形游戏缩在中间、上下大片黑边」的问题。
 */

export const GAME_WIDTH = 640;

/** 屏幕宽高比（以逻辑像素计算） */
const SCREEN = getScreenSize();
const SCREEN_ASPECT =
  SCREEN.width > 0 && SCREEN.height > 0 ? SCREEN.height / SCREEN.width : 1;

/**
 * 是否启用竖屏扩展布局。
 *
 * 只有「触摸设备 + 竖屏比例」才扩展；桌面浏览器保持正方形，
 * 避免把桌面玩家熟悉的 640×640 场地拉成竖条。
 */
export const WIDE_LAYOUT = IS_MINIGAME || (IS_TOUCH && SCREEN_ASPECT > 1.15);

/** 竖屏时允许的最大设计高度（防止超长屏把 UI 拉得过于稀疏） */
const MAX_VIEW_HEIGHT = 1500;

export const GAME_HEIGHT = WIDE_LAYOUT
  ? Math.min(MAX_VIEW_HEIGHT, Math.max(640, Math.round(GAME_WIDTH * SCREEN_ASPECT)))
  : 640;

/** 棋盘在设计区里的垂直位置（竖屏时居中） */
export const BOARD_TOP = Math.round((GAME_HEIGHT - 640) / 2);
export const BOARD_BOTTOM = BOARD_TOP + 640;
/** 上下留白是否足够放品牌区 / 控制区 */
export const HAS_TOP_BAR = BOARD_TOP >= 72;
export const HAS_BOTTOM_BAR = GAME_HEIGHT - BOARD_BOTTOM >= 96;

/** 网格参数：10 列 x 10 行正方形场地，每格 64px */
export const GRID_COLS = 10;
export const GRID_ROWS = 10;
export const TILE_SIZE = 64;
export const GRID_OFFSET_X = 0;
export const GRID_OFFSET_Y = BOARD_TOP;

/**
 * 格点冲刺（Grid-Snap Dash）参数。
 *
 * 设计动机：早期版本用「速度 × delta」推进格子间的插值，
 * 一格 64px、基础速度 29.1px/s，走完一格要 2.2 秒。
 * 这么长的时间里玩家可以随意松手续停，于是出现
 * 「停在格子边缘的射击盲区 → 植物永远打不到 → 无敌挂机」。
 *
 * 改成定长冲刺后，每次位移是一次不可中断的原子操作：
 * 要么在格心 A，要么在格心 B，中间那 120ms 只是「过渡态」。
 * 玩家在结构上就不可能停在半格上。
 */
export const DASH = {
  /** 冲刺耗时（毫秒）。够快才有「哒哒哒」的节奏感，又不至于看不清 */
  durationMs: 120,

  /**
   * 输入缓冲窗口（毫秒）。
   *
   * 冲刺过程中按住方向键，若在当前冲刺结束前 60ms 内按下，
   * 下一格会无缝接上，形成连续突进。
   * 太短会导致快速连按丢输入，太长会让「点一下走两格」。
   */
  inputBufferMs: 60,

  /**
   * 缓动函数。
   *
   * Sine.easeOut：起步稍快、收尾减速，落地有「顿」的感觉，
   * 比线性更像一格一格地跳。用 Quad 会显得冲得太猛。
   */
  ease: 'Sine.easeOut'
} as const;

/**
 * 房屋所在格（不可放置植物，可阻挡子弹）。
 * 放在左上角 2x2，与《植物大战僵尸》的房子位置一致。
 */
export const HOUSE_CELLS: ReadonlyArray<{ col: number; row: number }> = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 }
];

// 注：玩家（僵尸）的具体数值统一放在 src/data/zombies.ts 的 PLAYER_ZOMBIE，
// 此处不再重复定义，避免两处改不同步。

/** 植物通用 */
export const PLANT = {
  /** 场上植物硬上限 9 株；仍然按原来的随机生成节奏诞生 */
  maxOnField: 9,
  spawnIntervalStart: 3000,
  spawnIntervalEnd: 1200,
  spawnRampDuration: 90000,
  /** 每 30 秒把一株普通植物升级为特殊个体 */
  eliteIntervalMs: 30000,
  minDistanceToPlayer: 150,
  spawnRetryLimit: 24,

  /**
   * 随时间成长的生命值：每满 PLANT_HP_GROWTH_INTERVAL_MS，
   * 所有植物的最大生命值在基础值上 +PLANT_HP_GROWTH_AMOUNT。
   *
   * 需求：所有植物每 30 秒 +50 生命。
   * 注意这是「按游戏时间」成长，新生成与已有植物都会享受当前档位的加成
   * （已有植物在档位提升时会同步补足最大血量）。
   */
  hpGrowthIntervalMs: 30 * 1000,
  hpGrowthAmount: 50
} as const;

/** 道具系统参数 */
export const ITEM = {
  /** 道具掉落后在地面停留的时长（毫秒），5 秒不拾取自动消失 */
  groundLifetimeMs: 5 * 1000,
  /** 拾取判定半径（像素，玩家格心到道具） */
  pickupRadius: 40,
  /** 地上的道具图标边长（像素，约植物一半大小） */
  groundIconSize: 26,

  /** 有持续时间的道具（靴子/锯子/弹球/回力镖）的生效时长 */
  durationMs: 60 * 1000,

  /** 铁板：一次性护盾量 */
  ironPlateShield: 125,
  /** 疾风残靴：移动速度加成（像素/秒，持续期内生效） */
  bootsSpeedBonus: 25,
    /** 狂暴链锯：啃食间隔倍率（0.5 = 间隔减半 = 频率翻倍） */
  chainsawBiteIntervalMul: 0.5,
  /** 狂暴链锯：自动锯伤间隔（毫秒） */
  chainsawHitIntervalMs: 350,
  /** 狂暴链锯：每次自动锯伤伤害 */
  chainsawHitDamage: 12,
  /** 狂暴链锯：自动锯伤范围（像素，以僵尸胸口为圆心） */
  chainsawHitRadius: 46,
  /** 弹射异球：发射间隔（毫秒） */
  orbFireIntervalMs: 1500,
  /** 弹射异球：球伤害 */
  orbDamage: 30,
  /** 弹射异球：球速（像素/秒） */
  orbSpeed: 420,
  /** 弹射异球：单颗球最多反弹次数（防止无限弹跳） */
  orbMaxBounces: 6,
  /** 回力镖：投掷间隔（毫秒） */
  boomerangIntervalMs: 1600,
  /** 回力镖：伤害（去程、回程各结算一次） */
  boomerangDamage: 25,
  /** 回力镖：飞行速度（像素/秒） */
  boomerangSpeed: 460,
    /** 回力镖：去程最大距离（像素） */
  boomerangRange: 220
} as const;

/**
 * 僵尸普攻（弹球 / 回力镖交替）。
 *
 * 弹球与回力镖从「道具」升级为僵尸的常驻普攻：
 * 左右手交替投掷，形成稳定的远程输出节奏。
 */
export const BASIC_ATTACK = {
  /** 两次普攻之间的间隔（毫秒，从「出手帧」开始计） */
  intervalMs: 900,
  /** 首次普攻延迟（出生后多久开始） */
  firstDelayMs: 700,
  /** 甩手动作总时长（毫秒） */
  throwMs: 300,
  /** 从举起到出手的时间占甩手动作的比例（与 ZombieRig 的出手帧一致） */
  releaseAt: 0.42
} as const;

/** 子弹 */
export const BULLET = {
  /**
   * 豌豆飞行速度（像素/秒）。
   *
   * 基准：《植物大战僵尸》的豌豆约 0.9 秒飞过 9 格草坪。
   * 本作一格 64px，折合 9 * 64 / 0.9 ≈ 640 px/s。
   * 之前的 250 px/s 明显偏慢（看起来像"飘"），已按原版标定上调。
   */
  speed: 640,
  size: 20
} as const;

/** 计时与尸币：7 秒一枚（原 10 秒；提高掉落频率） */
export const TIMER = {
  coinIntervalMs: 7000
} as const;

/**
 * 宗门剑士（全屏追踪的远程植物）。
 *
 * 与射手不同，它不对行也不对列，而是**瞄准全屏任意位置的僵尸**。
 * 因此需要一个独立的解锁时间：太早出场会让前期失去「走位躲子弹」的意义。
 */
export const SWORDSMAN = {
    /**
     * 解锁时刻（毫秒）。
     * 测试用：30 秒 = 30000ms。到达这个点后才会进入生成池。
     */
    unlockAtMs: 30 * 1000,

  /** 挥剑动作时长（毫秒）。0.25 秒内完成「举 → 劈 → 收」 */
  swingDurationMs: 250,

  /**
   * 挥剑起点/终点角度（度）。
   *
   * 角度以「手臂从肩膀指向右方」为 0 度，逆时针为正。
   * -70：高举过头，剑指右上方
   * +25：劈到前下方
   */
  swingFromDeg: -70,
  swingToDeg: 25,

  /** 剑飞出后延迟多少毫秒再开始下一轮（配合 1 秒一发） */
  fireIntervalMs: 1000,

    /** 剑的追踪速度（像素/秒）。比豌豆略快，否则全屏飞行太拖沓 */
  projectileSpeed: 560,

    /** 每把剑的伤害 */
  damage: 50,

  /**
   * 剑的显示缩放（相对贴图）。
   *
   * 贴图 swordsman-sword.png 已经是「原图按比例缩到 96px 高」的成品，
   * 但玩家觉得飞出的剑仍然偏大，这里再缩 50%。
   */
  swordScale: 0.5,

  /**
   * 追踪转向速率（弧度/秒）。作为「远距离平滑弧线」的下限。
   *
   * 不做「瞬间对准」而是逐渐转向，飞行轨迹才是一条弧线，
   * 视觉上能看出它在追人。数值越大转得越急。
   * 近距离时不再受此限制，改为直接对准（见 SwordBullet.updateHoming），
   * 保证贴脸/贴身时不会绕圈。
   */
  turnRate: 10,

  /**
   * 前置量预测时长（秒）。
   *
   * 剑每帧根据目标「最近的运动速度」估计其速度，瞄准「目标再飞这么久的
   * 未来位置」，而不是当前所在位置 —— 也就是猫尾香蒲式的提前拦截。
   * 这样僵尸横移 / 冲刺时剑不会再追着尾巴跑，而是迎头撞上。
   */
  leadSeconds: 0.18,

  /**
   * 近距直接对准半径（像素）。
   *
   * 当剑与目标的距离小于此值时，跳过「限速转向」，直接把朝向对准目标中心。
   * 这是防止高速近身时因转向不足而绕着目标画圈的关键。
   */
  closeLockRadius: 72,

  /**
   * 命中保底半径（像素）。
   *
   * 命中判定时，剑的有效击中半径至少取这么大，避免缩小后的剑判定框过小、
   * 从僵尸身边「擦过」。相当于给剑一个略微「粘人」的判定。
   */
  hitRadiusMin: 20,

  /**
   * 追踪超时（毫秒）：飞太久还没命中就自毁，防止剑满屏乱飞。
   *
   * 注意：只要目标仍然存活，追踪会一直有效；这里的超时是「兜底自毁」，
   * 到达此时间后若仍未命中，会**直接结算为命中**（如果目标还在），
   * 从而保证「无论僵尸怎么跑，剑终将命中」。
   */
  lifeMs: 4000,
} as const;

/** 进化阶段：需求点数 / 速度 / 血量 / 缩放 / 名称 */
export interface EvolutionStage {
  stage: number;
  requiredPoints: number;
  speed: number;
  hp: number;
  scale: number;
  label: string;
}

/**
 * 进化阶段血量成长。
 *
 * 需求：每升一级，血量额外增加「基础血量的 120%」。
 * 即 hp = BASE_HP × (1 + 1.2 × 阶段序号)，阶段序号从 0 开始：
 *   幼体(0)  : 100         = 100 × 1.0
 *   成体(1)  : 220         = 100 × 2.2
 *   暴食体(2): 340         = 100 × 3.4
 *   灾厄体(3): 460         = 100 × 4.6
 *
 * 之所以用「线性累加 120%」而不是「每级 ×2.2」，
 * 是因为后者到灾厄体已经 100×2.2³≈1064 血，配合满级永久成长会直接失控；
 * 线性累加既满足「每级 +120%」，又让后期血量保持可读、可平衡。
 */
const EVOLUTION_BASE_HP = 100;
const EVOLUTION_HP_GROWTH_PER_STAGE = 1.2;

export const EVOLUTION_STAGES: ReadonlyArray<EvolutionStage> = [
  { stage: 1, requiredPoints: 0,  speed: 29.1, hp: EVOLUTION_BASE_HP * (1 + EVOLUTION_HP_GROWTH_PER_STAGE * 0), scale: 1.0,  label: '幼体' },
  { stage: 2, requiredPoints: 5,  speed: 32.7, hp: EVOLUTION_BASE_HP * (1 + EVOLUTION_HP_GROWTH_PER_STAGE * 1), scale: 1.12, label: '成体' },
  { stage: 3, requiredPoints: 12, speed: 37.0, hp: EVOLUTION_BASE_HP * (1 + EVOLUTION_HP_GROWTH_PER_STAGE * 2), scale: 1.25, label: '暴食体' },
  { stage: 4, requiredPoints: 25, speed: 42.0, hp: EVOLUTION_BASE_HP * (1 + EVOLUTION_HP_GROWTH_PER_STAGE * 3), scale: 1.4,  label: '灾厄体' }
];

/** 存档键名（仅在 platform/storage.ts 中使用） */
export const STORAGE_KEYS = {
  bestTime: 'avoid-death-best',
  /** 用户设置（语言 / 音量 / 震动） */
  settings: 'avoid-death-settings',
  /** 广告频控状态（局数 / 上次插屏时间 / 激励次数） */
  ads: 'avoid-death-ads-state',
  /** 新手引导是否已看 */
  tutorial: 'avoid-death-tutorial-seen',
  /** 本机/好友排行榜缓存 */
  leaderboard: 'avoid-death-leaderboard'
} as const;

/** 排行榜框架配置：先留空，接入云开发/HTTP 后填写 */
export const LEADERBOARD = {
  /** 全服榜 HTTP API 根地址；空字符串 = 未接入 */
  apiBaseUrl: '',
  /** 最多显示条数 */
  maxEntries: 10
} as const;

/** 场景键名 */

/** 场景键名 */
export const SCENE_KEYS = {
  boot: 'BootScene',
  game: 'GameScene',
  pause: 'PauseScene',
  shop: 'ShopScene',
  settings: 'SettingsScene',
  result: 'ResultScene',
  leaderboard: 'LeaderboardScene'
} as const;

/** 素材路径（相对 public/） */
export const ASSET_PATHS = {
  /**
   * 主角僵尸站立图。
   *
   * 由 1664x2496 的原始立绘抠白底、紧贴裁剪、等比缩放到 48x112 得到。
   * 走路/啃食不再使用序列帧，而是用数学变换驱动同一张图（见 PlayerZombie）。
   */
  zombieIdle: 'assets/zombie/idle.png',
  /** 啃食复用站立图：动作差异由程序化动画表现，不再维护第二张素材 */
  zombieEat: 'assets/zombie/idle.png',

  // ---- 分部件立绘（骨骼式分层动画）----
  // 由 assets_zombie_cut.png（1277x2401）按解剖边界切出，
  // 每个部件保留原图坐标系下的相对位置，拼装时直接叠加即可对齐。
  partHead: 'assets/zombie/parts/head.png',
  partTorso: 'assets/zombie/parts/torso.png',
  partArmL: 'assets/zombie/parts/armL.png',
  partArmR: 'assets/zombie/parts/armR.png',
  partLegL: 'assets/zombie/parts/legL.png',
  partLegR: 'assets/zombie/parts/legR.png',
    plantShooter: 'assets/plants/shooter.png',
  plantWall: 'assets/plants/wall.png',
  // 冷雾苔用它自己的苔藓立绘。
  // 早先这里错写成 'assets/plants/ice.png'（冻蔓射手的整图），
  // 导致冷雾苔在场上显示成「一张冻蔓射手原图、不攻击、比例也不对」。
  plantSlow: 'assets/plant-slow.svg',
  plantIce: 'assets/plants/ice.png',

  // ---- 植物分部件（骨骼式分层动画：根 / 茎 / 头）----
  // 三张分开的透明底素材，拼装后即为一株完整植物。
  // 分开的意义：茎能摇摆、头能点头，而不是整株一起晃。
  baseRoot: 'assets/plants/base-root.png',
  baseStem: 'assets/plants/base-stem.png',
  baseHead: 'assets/plants/base-head.png',
  iceRoot: 'assets/plants/ice-root.png',
  iceStem: 'assets/plants/ice-stem.png',
  iceHead: 'assets/plants/ice-head.png',

  // ---- 宗门剑士（分层：身体 + 可旋转手臂 + 剑弹道）----
  swordsmanBody: 'assets/plants/swordsman-body.png',
  swordsmanArm: 'assets/plants/swordsman-arm.png',
  swordsmanSword: 'assets/plants/swordsman-sword.png',

    bullet: 'assets/bullet.svg',
  houseTile: 'assets/house-tile.svg',
  grassTile: 'assets/grass-tile.svg',

  // ---- 道具（掉落 / 手持）----
  itemIronPlate: 'assets/items/iron-plate.png',
  itemBoots: 'assets/items/boots.png',
  itemChainsaw: 'assets/items/chainsaw.png',
  itemBouncingOrb: 'assets/items/bouncing-orb.png',
  itemBoomerang: 'assets/items/boomerang.png',
  // 锯子分部件：本体 / 链子 / 与手部连接的部件
  sawBody: 'assets/items/saw-body.png',
  sawChain: 'assets/items/saw-chain.png',
  sawMount: 'assets/items/saw-mount.png'
} as const;

/** 素材键名 */
export const ASSET_KEYS = {
  zombieIdle: 'zombie-idle',
  zombieEat: 'zombie-eat',
  /**
   * 走路循环的 4 帧纹理键。
   *
   * 为什么要 4 帧：PvZ 的普通僵尸不是「滑步」，而是有明确的迈步节奏 ——
   *   接触帧（双脚前后分开，身体下沉）-> 过渡帧（双脚收拢，身体抬起）
   * 左右各一次，构成一个完整循环。只有 2 帧会显得跳跃、缺少起伏。
   */
  // 分部件立绘的纹理键（骨骼式分层动画用）
  partHead: 'part-head',
  partTorso: 'part-torso',
  partArmL: 'part-arm-l',
  partArmR: 'part-arm-r',
  partLegL: 'part-leg-l',
  partLegR: 'part-leg-r',
  plantShooter: 'plant-shooter',
  plantWall: 'plant-wall',
  plantSlow: 'plant-slow',
  plantIce: 'plant-ice',
  baseRoot: 'plant-base-root',
  baseStem: 'plant-base-stem',
  baseHead: 'plant-base-head',
  iceRoot: 'plant-ice-root',
  iceStem: 'plant-ice-stem',
  iceHead: 'plant-ice-head',
  swordsmanBody: 'swordsman-body',
  swordsmanArm: 'swordsman-arm',
  swordsmanSword: 'swordsman-sword',
    bullet: 'bullet',
  houseTile: 'house-tile',
  grassTile: 'grass-tile',

  // ---- 道具 ----
  itemIronPlate: 'item-iron-plate',
  itemBoots: 'item-boots',
  itemChainsaw: 'item-chainsaw',
  itemBouncingOrb: 'item-bouncing-orb',
  itemBoomerang: 'item-boomerang',
  sawBody: 'saw-body',
  sawChain: 'saw-chain',
  sawMount: 'saw-mount'
} as const;

/**
 * 僵尸程序化动画参数（不用序列帧）。
 *
 * 为什么用数学变换而不是序列帧：
 *   原图是一张完整立绘，AI 生成序列帧会导致体型漂移、细节崩坏。
 *   PvZ 的僵尸本来就是「木偶感」——上半身摇摆、手臂钟摆、头部点头，
 *   这些恰好都能用 sin/cos 精确表达，且**永远不会有帧间形变**。
 *
 * 单位说明：
 *   - *Hz 为每秒周期数，数值越大越快
 *   - *Deg 为角度（度）
 *   - *Px 为像素位移
 */
export const ZOMBIE_ANIM = {
  /** ---- 走路 ---- */
  walk: {
    /** 身体左右摇摆频率（Hz）：PvZ 僵尸约 1 秒摆一个来回 */
    swayHz: 1.0,
    /** 摇摆最大角度（度）。超过 6 度会显得像在打醉拳 */
    swayDeg: 4.5,
    /** 上下颠簸频率（Hz）：通常是摇摆的两倍（左右迈步各颠一次） */
    bobHz: 2.0,
    /** 颠簸幅度（像素） */
    bobPx: 2.2,
    /** 前倾角度（度）：负数 = 朝右倒。攻击性的来源 */
    leanDeg: -7,
    /**
     * 脚步节拍频率（Hz）。
     * 与 bobHz 一致，用来驱动「落地瞬间的重压」——踩地时身体略微下沉。
     */
    stepHz: 2.0
  },

  /** ---- 站立 ---- */
  idle: {
    /** 呼吸频率（Hz）：很慢，几乎察觉不到 */
    breathHz: 0.35,
    /** 呼吸缩放幅度（比例） */
    breathScale: 0.012,
    /** 静止时也保留一丝歪斜，避免「立正」的僵硬感 */
    swayDeg: 1.2,
    swayHz: 0.25
  },

  /** ---- 啃食 ---- */
  eat: {
    /** 撕咬颤抖频率（Hz）：很高，制造急促感 */
    chompHz: 7.5,
    /** 撕咬旋转幅度（度） */
    chompDeg: 3.2,
    /** 撕咬时整体前探的位移（像素），随撕咬频率来回 */
    lungePx: 2.5,
    /** 啃食时的前倾角度（度） */
    leanDeg: -12,
    /**
     * 啃食时头部上下窜动的幅度（像素）。
     *
     * 头沿着 y 轴在这个范围内来回，配合 chompHz 的频率，
     * 形成「一啄一啄」的啃食感。3 左右就比较明显了，
     * 超过 6 会显得头要从脖子上飞出去。
     */
    nodPx: 3.5  },

  /** ---- 死亡 ---- */
  death: {
    /** 倒下旋转角度（度） */
    fallDeg: 78,
    /** 倒下耗时（毫秒） */
    fallDuration: 620
  }
} as const;

/**
 * 分部件布局表（骨骼式分层动画）。
 *
 * 数据来源：assets_zombie_cut.png（1277x2401）按解剖边界切分后，
 * 以「角色总高 108px」（与原 idle.png 一致）为基准统一缩放得到。
 * 缩放系数 = 108 / 2392 ≈ 0.045151。
 *
 * 字段说明：
 *   tex   —— 贴图原始像素尺寸 [宽, 高]
 *   w/h   —— 游戏内显示尺寸（tex × 缩放）
 *   x/y   —— 贴图左上角相对「脚底中心」的偏移（游戏内像素，y 向下为正）
 *
 * 拼装方式：所有部件都以脚底中心为公共原点，直接按 x/y 叠加即对齐，
 * 因此不需要在运行时做任何位置反推。
 */
/**
 * 六张切图的拼装布局。
 *
 * 单位是游戏内显示像素，坐标系原点在「脚底中心」，向上为负 y。
 *
 * ---- 整体缩放 ----
 * 需求：高度压到 80%、宽度压到 85%（原尺寸太高，会占两个格子）。
 * 所以下面所有 x / y 都乘 SCALE_X / SCALE_Y，w / h 同理，
 * 这样整只僵尸等比缩小，部件之间的相对位置也不会散。
 *
 * 原始（未缩放）数值保留在注释里，方便日后微调。
 */
/**
 * 六块部件在「整只僵尸」里的真实位置。
 *
 * ---- 数据来源 ----
 * 全部由 assets_zombie_cut.png（1277x2401）实测切出来，
 * 切完再按下面的 x/y 拼回去，与原图逐像素对比 **0 差异**。
 * 所以这套数值就是原图的 1:1 映射，不存在"估的"成分。
 *
 * ---- 坐标系 ----
 * 原点 = 躯干中线 与 脚底 的交点。
 *   x：向右为正，单位是游戏内显示像素
 *   y：向上为负（头顶约 -108，脚底 0）
 *
 * 缩放比例 ZOMBIE_ART_SCALE = 108 / 2401，把 2401px 的原图映射成 108 单位高。
 *
 * ---- pivotX ----
 * 每块的旋转关节在自身宽度上的相对位置（0~1）。
 * 取自「该块内容最顶一行」的横向中心 —— 也就是它与身体连接的地方：
 *   腿 = 胯部，手臂 = 肩膀，头 = 脖子。
 * 旋转时以这里为轴，肢体就是从关节甩出去的，不会整块平移。
 */
const ZOMBIE_ART_SCALE = 108 / 2401;

/**
 * 整体再缩放：在「原图 1:1 映射」的基础上额外压缩。
 *
 * 原图映射出来高 108、宽 57.4，按 64px 一格算是「高 169%、宽 90%」，
 * 比 PvZ 的僵尸壮太多（原作约 高 135%、宽 60%）。
 * 所以横竖分别压到 85% / 80%，得到 高 86.4 / 宽 39.8 —— 接近原作比例。
 *
 * 注意：x / y / w / h 必须同时乘，否则部件之间会错位。
 */
const SCALE_X = 0.85;
const SCALE_Y = 0.80;

/** 原图中躯干中线的 x 像素（世界 x=0 所在处） */
const ZOMBIE_ART_CENTER_X = 546;

/** 原图高度（世界 y=0 在底部） */
const ZOMBIE_ART_HEIGHT = 2401;

/** 把「原图像素坐标」换算成布局条目 */
function part(
  texW: number,
  texH: number,
  srcX: number,
  srcY: number,
  pivotX: number
): {
  tex: readonly [number, number];
  w: number;
  h: number;
  x: number;
  y: number;
  pivotX: number;
} {
  return {
    tex: [texW, texH],
    w: texW * ZOMBIE_ART_SCALE * SCALE_X,
    h: texH * ZOMBIE_ART_SCALE * SCALE_Y,
    x: (srcX - ZOMBIE_ART_CENTER_X) * ZOMBIE_ART_SCALE * SCALE_X,
    y: (srcY - ZOMBIE_ART_HEIGHT) * ZOMBIE_ART_SCALE * SCALE_Y,
    pivotX
  };
}

export const ZOMBIE_PART_LAYOUT = {
  //                     tex宽  tex高   原图x  原图y  pivotX
  legL: part(495, 821, 0, 1580, 0.664),
  legR: part(480, 821, 495, 1580, 0.310),
  armL: part(232, 1150, 0, 430, 0.873),
  // 右手贴图上半段其实是红色领带，不能跟手臂一起转；这里只保留绿色手部
  armR: part(65, 294, 858, 1286, 0.5),
  torso: part(628, 1150, 232, 430, 0.435),
  head: part(520, 430, 480, 0, 0.127)
} as const;

/** 从 armR 上半段裁出的红色领带（静态，不参与抬手；裁到与手部交界处，避免截断） */
export const ZOMBIE_TIE_LAYOUT = part(182, 856, 858, 430, 0);

/**
 * 植物分层布局（骨骼式动画）。
 *
 * ---- 为什么植物也要分层 ----
 * 单张贴图只能整株平移，看起来像「贴纸」。
 * 拆成 根 / 茎 / 头 后：
 *   - 根固定在地面，不参与摆动（它是「底座」）
 *   - 茎绕根部左右摇，是整株「扭动」的主体
 *   - 头绕茎顶摆动，并且相位滞后于茎，形成「梢随枝动」的果冻感
 * 这正是用户要的「自己扭动」。
 *
 * ---- 坐标系 ----
 * 原点 = 根底中心（脚底），向上为负 y、向右为正 x，单位：游戏内像素。
 * 所有数值由三张透明底部件图按解剖连接点拼装后测量得到
 * （拼装脚本见 devtest/_layout.py，拼出的轮廓已逐行核对过）。
 *
 * ---- 尺寸 ----
 * 整株高 45.6px、宽约 34px。一格 64px，所以植物约占 0.7 格高。
 * 早期版本用的是接近 2 格高的整张立绘，把场地糊满了；
 * 之后缩到 38px 高又显得太瘦，于是在此基础上高度 +20%、横向再放宽，
 * 得到现在这个饱满但不占位的比例。
 */
export interface PlantPartLayout {
  /** 显示宽高（游戏内像素） */
  readonly w: number;
  readonly h: number;
  /** 左上角相对「根底中心」的偏移 */
  readonly x: number;
  readonly y: number;
  /**
   * 旋转轴在自身上的相对位置（0~1）。
   *
   *   pivotX：横向，0.5 = 部件水平中心
   *   pivotY：纵向，0 = 顶部，1 = 底部
   *
   * 根不转，pivotY 取 0.5 无影响；
   * 茎绕**底部**转（pivotY=1）；头绕**底部**转（pivotY=1），
   * 这样摇头时是「脖子带着脑袋晃」，而不是脑袋原地转圈。
   */
  readonly pivotX: number;
  readonly pivotY: number;
}

export type PlantPartName = 'root' | 'stem' | 'head';

/**
 * 单贴图植物（石墙 / 冷雾苔 / 剑士身体等没有分部件素材的）的归一化目标宽度。
 *
 * 这些素材原始尺寸都在 185~199px，按 1:1 画出来比 64px 的格子大两倍多，
 * 会把场地糊满。统一按「宽度对齐此处、高度按原比例」缩放。
 * 取 48：与 ASSET_SIZES.plant 一致，约 0.75 格宽。
 */
export const PLANT_SINGLE_TEX_WIDTH = 48;

/** 单株植物的三块布局 */
export type PlantRigLayout = Readonly<Record<PlantPartName, PlantPartLayout>>;

/**
 * 基础射手（shooter）的布局。
 *
 * 数值含义示例：head 的 y = -38 表示头顶恰好在脚底上方 38px 处，
 * 也就是整株高 38px —— 与 PlantRig 的总高完全吻合。
 */
export const PLANT_RIG_BASE: PlantRigLayout = {
  root: { w: 25.77, h: 11.61, x: -7.54,  y: -11.61, pivotX: 0.5, pivotY: 0.5 },
  stem: { w: 18.01, h: 17.29, x: -10.69, y: -28.90, pivotX: 0.5, pivotY: 1.0 },
  head: { w: 16.81, h: 17.67, x: -5.64,  y: -45.60, pivotX: 0.5, pivotY: 1.0 }
} as const;

/** 冻结蔓射手（ice）的布局 */
export const PLANT_RIG_ICE: PlantRigLayout = {
  root: { w: 22.73, h: 9.76,  x: -17.18, y: -9.76,  pivotX: 0.5, pivotY: 0.5 },
  stem: { w: 16.32, h: 15.57, x: -8.38,  y: -25.33, pivotX: 0.5, pivotY: 1.0 },
  head: { w: 22.87, h: 21.57, x: -12.33, y: -45.60, pivotX: 0.5, pivotY: 1.0 }
} as const;

/**
 * 植物扭动动画参数。
 *
 * 全部用 sin/cos 驱动，没有序列帧：
 *   - 永远不会帧间形变
 *   - 三个动作（待机 / 开火 / 受击）只是不同参数组合
 *   - 帧率高低都不影响观感（相位由累计时间算）
 */
export const PLANT_ANIM = {
  /** 待机：极慢的呼吸式摇摆 */
  idle: {
    /** 茎的摇摆频率（Hz） */
    stemHz: 0.45,
    /** 茎的摇摆角度（度）。根 2~3 度就有"活着"的感觉，超过 6 度像抽搐 */
    stemDeg: 2.6,
    /** 头的摆动频率（Hz），比茎略高，形成"梢比枝快"的果冻感 */
    headHz: 0.62,
    /** 头的摆动角度（度） */
    headDeg: 3.2,
    /** 头相对茎的相位滞后（弧度）。0.6≈35ms，看起来像惯性拖拽 */
    headLag: 0.6,
    /** 整株上下起伏幅度（像素） */
    bobPx: 0.8
  },

  /** 开火：整株向前一挺，头明显点头 */
  fire: {
    /** 前倾角度（度），持续到下一发 */
    leanDeg: 6,
    /** 点头幅度（度） */
    headNodDeg: 10,
    /** 点头频率（Hz） */
    headNodHz: 3.0
  }
} as const;

/** 分部件名（顺序即绘制顺序：后面的盖住前面的） */
export const ZOMBIE_PART_ORDER = [
  'legL',
  'legR',
  'armL',
  'armR',
  'torso',
  'head'
] as const;

export type ZombiePartName = keyof typeof ZOMBIE_PART_LAYOUT;

/** 素材期望尺寸，用于加载时指定渲染尺寸 */
export const ASSET_SIZES = {
  /**
   * 僵尸的「逻辑显示尺寸」。
   *
   * 必须与素材原始宽高比一致，否则会被拉伸：
   *   抠图后 idle.png = 48 x 112  (比例 0.4286)
   *   这里取 46 x 108          (比例 0.4259，误差 < 1%)
   *
   * 不能沿用旧的 64 x 96（比例 0.6667）—— 那会把角色横向拉宽 156%，
   * 从修长的僵尸变成矮胖色块。
   *
   * 高度取 108 而非更小的值：立绘细节多，
   * 显示尺寸太小会把脸、领带、胸口裂纹糊成一团。
   */
    zombie: { width: 46, height: 108 },
  plant: { width: 48, height: 48 },
  bullet: { width: 20, height: 20 },
  tile: { width: 64, height: 64 },
  /** 道具原图尺寸（用于缺失占位与加载参考）*/
  itemIronPlate: { width: 270, height: 318 },
  itemBoots: { width: 304, height: 312 },
  itemChainsaw: { width: 330, height: 261 },
  itemBouncingOrb: { width: 209, height: 206 },
  itemBoomerang: { width: 349, height: 291 },
  sawBody: { width: 148, height: 60 },
  sawChain: { width: 147, height: 84 },
  sawMount: { width: 224, height: 242 }
} as const;

/** 配色（HUD 与占位块） */
export const COLORS = {
  bg: 0x0a0918,
  gridLine: 0x1c2a44,
  house: 0x3a3f46,
  hpFull: 0x4ade80,
  hpLow: 0xef4444,
  text: '#e8eef4',
  textDim: '#8fa8b8',
  accent: '#7fe3ff',
  coin: '#ffd84a'
} as const;
