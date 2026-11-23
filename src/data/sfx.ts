/**
 * 音效目录（纯数据，无 Phaser 依赖）。
 *
 * 每个条目描述一段音效：加载键、文件路径、音量、并发实例数、最小触发间隔。
 * 具体的播放调度在 src/platform/sfx.ts，这里只管「有哪些音效、各自怎么配」。
 *
 * 设计说明：
 *   - key  = Phaser 资源加载/缓存的唯一键（与文件一一对应）。
 *   - file = 相对 public 的路径（ASCII 命名，源素材中文目录已复制改名）。
 *   - volume = 该音效相对主音量的缩放（0~1）。主音量由 SoundManager 统一乘算，
 *     所以玩家在设置里调主音量时，所有音效会自动同步变化。
 *   - pool = 允许同时发声的实例数。像射手开火、子弹命中这类高频音效，
 *     单个实例会被下一次播放「打断重启」，听起来会断断续续，
 *     需要多实例轮换才能自然叠音。低频音效给 1 即可。
 *   - throttleMs = 同一音效的最小触发间隔。用于兜住「同一帧里几十株植物
 *     一起开火」这种爆音场景，保证听感稳定、不糊成噪音。
 *   - rateJitter = 播放速率随机扰动的幅度（±），为高频重复音效增加细微差异，
 *     避免「机关枪一样完全一样」的机械感。
 */

export type SfxId =
  // ---- UI ----
  | 'uiClick'
  | 'uiClose'
  | 'uiBuy'
  // ---- 僵尸 ----
  | 'zombieHaste'
  | 'zombieEat'
  | 'zombiePickup'
  | 'zombieDie'
  | 'zombieMove'
  | 'zombieIdle'
  | 'boomerangThrow'
  | 'orbThrow'
  | 'boomerangHit'
  | 'orbBounce'
  | 'chainsaw'
  // ---- 道具 / 尸币 ----
  | 'itemDrop'
  | 'coinPickup'
  | 'coinDrop'
  // ---- 植物 ----
  | 'iceFire'
  | 'iceHit'
  | 'iceHitArmored'
  | 'shooterFire'
  | 'shooterHit'
  | 'shooterHitArmored'
  | 'swordFire'
  | 'swordHit'
  | 'swordHitArmored'
  | 'plantPlace';

export interface SfxDef {
  key: string;
  file: string;
  /** 相对主音量的缩放（0~1） */
  volume: number;
  /** 并发实例数（默认 1） */
  pool?: number;
  /** 最小触发间隔（毫秒，默认 0 表示不限制） */
  throttleMs?: number;
  /** 播放速率随机扰动幅度（默认 0） */
  rateJitter?: number;
}

const DIR = 'assets/sfx/';

export const SFX_DEFS: Readonly<Record<SfxId, SfxDef>> = {
  // ---- UI（一次只响一个，pool=1）----
  uiClick: { key: 'sfx-ui-click', file: DIR + 'ui-click.ogg', volume: 0.6, pool: 2, throttleMs: 40 },
  uiClose: { key: 'sfx-ui-close', file: DIR + 'ui-close.ogg', volume: 0.6, pool: 1, throttleMs: 80 },
  uiBuy: { key: 'sfx-ui-buy', file: DIR + 'ui-buy.ogg', volume: 0.7, pool: 1 },

  // ---- 僵尸 ----
  zombieHaste: { key: 'sfx-zombie-haste', file: DIR + 'zombie-haste.ogg', volume: 0.55, pool: 1 },
  zombieEat: { key: 'sfx-zombie-eat', file: DIR + 'zombie-eat.mp3', volume: 0.5, pool: 2, throttleMs: 120, rateJitter: 0.12 },
  zombiePickup: { key: 'sfx-zombie-pickup', file: DIR + 'zombie-pickup.ogg', volume: 0.6, pool: 1 },
  zombieDie: { key: 'sfx-zombie-die', file: DIR + 'zombie-die.wav', volume: 0.8, pool: 1 },
  zombieMove: { key: 'sfx-zombie-move', file: DIR + 'zombie-move.ogg', volume: 0.3, pool: 2, throttleMs: 90, rateJitter: 0.1 },
  zombieIdle: { key: 'sfx-zombie-idle', file: DIR + 'zombie-idle.wav', volume: 0.4, pool: 1 },
  boomerangThrow: { key: 'sfx-boomerang-throw', file: DIR + 'boomerang-throw.ogg', volume: 0.55, pool: 1 },
  orbThrow: { key: 'sfx-orb-throw', file: DIR + 'orb-throw.ogg', volume: 0.55, pool: 1 },
  boomerangHit: { key: 'sfx-boomerang-hit', file: DIR + 'boomerang-hit.ogg', volume: 0.5, pool: 2, throttleMs: 60, rateJitter: 0.1 },
  orbBounce: { key: 'sfx-orb-bounce', file: DIR + 'orb-bounce.ogg', volume: 0.5, pool: 3, throttleMs: 40, rateJitter: 0.12 },
  chainsaw: { key: 'sfx-chainsaw', file: DIR + 'chainsaw.mp3', volume: 0.45, pool: 2, throttleMs: 260, rateJitter: 0.06 },

  // ---- 道具 / 尸币 ----
  itemDrop: { key: 'sfx-item-drop', file: DIR + 'item-drop.ogg', volume: 0.45, pool: 2, throttleMs: 60 },
  coinPickup: { key: 'sfx-coin-pickup', file: DIR + 'coin-pickup.ogg', volume: 0.72, pool: 2, throttleMs: 60 },
  coinDrop: { key: 'sfx-coin-drop', file: DIR + 'coin-drop.ogg', volume: 0.82, pool: 2, throttleMs: 60 },

  // ---- 植物 ----
  iceFire: { key: 'sfx-ice-fire', file: DIR + 'ice-fire.ogg', volume: 0.4, pool: 4, throttleMs: 50, rateJitter: 0.1 },
  iceHit: { key: 'sfx-ice-hit', file: DIR + 'ice-hit.ogg', volume: 0.45, pool: 4, throttleMs: 40, rateJitter: 0.12 },
  iceHitArmored: { key: 'sfx-ice-hit-armored', file: DIR + 'ice-hit-armored.ogg', volume: 0.5, pool: 4, throttleMs: 40, rateJitter: 0.1 },
  shooterFire: { key: 'sfx-shooter-fire', file: DIR + 'shooter-fire.ogg', volume: 0.4, pool: 4, throttleMs: 45, rateJitter: 0.1 },
  shooterHit: { key: 'sfx-shooter-hit', file: DIR + 'shooter-hit.ogg', volume: 0.45, pool: 4, throttleMs: 40, rateJitter: 0.12 },
  shooterHitArmored: { key: 'sfx-shooter-hit-armored', file: DIR + 'shooter-hit-armored.ogg', volume: 0.5, pool: 4, throttleMs: 40, rateJitter: 0.1 },
  swordFire: { key: 'sfx-sword-fire', file: DIR + 'sword-fire.ogg', volume: 0.5, pool: 2, throttleMs: 80, rateJitter: 0.1 },
  swordHit: { key: 'sfx-sword-hit', file: DIR + 'sword-hit.ogg', volume: 0.55, pool: 3, throttleMs: 50, rateJitter: 0.1 },
  swordHitArmored: { key: 'sfx-sword-hit-armored', file: DIR + 'sword-hit-armored.ogg', volume: 0.55, pool: 3, throttleMs: 50, rateJitter: 0.1 },
  plantPlace: { key: 'sfx-plant-place', file: DIR + 'plant-place.ogg', volume: 0.5, pool: 3, throttleMs: 50, rateJitter: 0.12 }
};

/** 全部音效 id 列表（用于预加载） */
export const ALL_SFX_IDS: ReadonlyArray<SfxId> = Object.keys(SFX_DEFS) as SfxId[];
