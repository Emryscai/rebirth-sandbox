/**
 * 音效播放调度器（单例）。
 *
 * 目标：
 *   1. 一行调用即可播放任意语义音效：`sfx.play('shooterFire')`；
 *   2. 高频音效不爆音、不断裂 —— 通过「实例池 + 节流 + 速率扰动」实现；
 *   3. 音量自动跟随主音量 —— 各音效只设置自身相对音量，
 *      绝对音量由 Phaser SoundManager 的 volume（=主音量）统一乘算；
 *   4. 素材缺失时安全降级 —— 缺哪个 key 就静默跳过，绝不抛错中断游戏主循环。
 *
 * 为什么用 Phaser 声音管理器而不是像 bgm 那样直接用 HTMLAudio：
 *   - 音效短、数量多，需要实例池、并发与精确节流，Phaser 的 SoundManager 已内建；
 *   - Phaser 会自动处理音频上下文解锁（浏览器自动播放策略）；
 *   - 主音量 applyVolume 已经在调 game.sound.volume，音效天然共享这一通道。
 *
 * 注意：加载在 BootScene 里完成（load.audio），本类只负责播放。
 */

import Phaser from 'phaser';
import { SFX_DEFS, ALL_SFX_IDS, type SfxDef, type SfxId } from '../data/sfx';
import { IS_MINIGAME } from './env';
import { getVolume } from './sound';

export type { SfxId } from '../data/sfx';

/**
 * 音效实例的最小接口。
 *
 * Phaser 的 BaseSound 与微信 InnerAudioContext 包装都实现它，
 * 这样「池化 / 节流 / 音量」逻辑可以完全复用，不必写两套调度。
 */
interface SoundHandle {
  readonly isPlaying: boolean;
  play(opts?: { rate?: number }): void;
  stop(): void;
  setVolume(v: number): void;
  destroy(): void;
}

interface Pool {
  def: SfxDef;
  sounds: SoundHandle[];
  /** 轮换游标：每次播放取下一个实例，实现叠音 */
  cursor: number;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** 小游戏音频统一转成 mp3（构建时由 tools/build-minigame 的转码步骤生成） */
function miniGameFile(def: SfxDef): string {
  return def.file.replace(/\.(ogg|wav)$/i, '.mp3');
}

/**
 * 微信/抖音 InnerAudioContext 包装。
 *
 * 为什么不走 Phaser SoundManager：
 *   - 小游戏没有 DOM/HTMLAudioElement，Phaser 的 WebAudio/HTML5 通道都不可用；
 *   - InnerAudioContext 原生支持本地包内路径、并发实例与音量，足够覆盖音效需求。
 */
class MiniGameSound implements SoundHandle {
  private ctx: {
    src: string;
    volume: number;
    loop: boolean;
    autoplay: boolean;
    play: () => void;
    pause: () => void;
    stop: () => void;
    seek?: (t: number) => void;
    destroy: () => void;
    onError?: (cb: (err: unknown) => void) => void;
  };
  private playing = false;
  private def: SfxDef;

  constructor(def: SfxDef) {
    this.def = def;
    const g = globalThis as unknown as {
      wx?: { createInnerAudioContext?: () => MiniGameSound['ctx'] };
      tt?: { createInnerAudioContext?: () => MiniGameSound['ctx'] };
    };
    const api = g.wx?.createInnerAudioContext ? g.wx : g.tt;
    if (!api?.createInnerAudioContext) throw new Error('no InnerAudioContext');
    const ctx = api.createInnerAudioContext();
    ctx.src = miniGameFile(def);
    ctx.loop = false;
    ctx.autoplay = false;
    ctx.volume = clamp01(def.volume * getVolume());
    ctx.onError?.(() => {
      this.playing = false;
    });
    this.ctx = ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  play(opts?: { rate?: number }): void {
    try {
      // InnerAudioContext 没有 playbackRate；rateJitter 在小游戏端退化为无扰动
      void opts;
      if (this.playing) {
        this.ctx.stop();
      }
      try {
        this.ctx.seek?.(0);
      } catch {
        /* 某些基础库 seek 前需要 canplay */
      }
      this.ctx.play();
      this.playing = true;
    } catch {
      this.playing = false;
    }
  }

  stop(): void {
    try {
      this.ctx.stop();
    } catch {
      /* ignore */
    }
    this.playing = false;
  }

  setVolume(v: number): void {
    try {
      this.ctx.volume = clamp01(v);
    } catch {
      /* ignore */
    }
  }

  destroy(): void {
    try {
      this.ctx.stop();
      this.ctx.destroy();
    } catch {
      /* ignore */
    }
    this.playing = false;
  }

  /** 需求里只在构造时读取一次 def，这里保留引用避免被 tree-shake 掉语义 */
  get defId(): string {
    return this.def.key;
  }
}

/** Phaser BaseSound 适配为统一接口 */
class PhaserSoundHandle implements SoundHandle {
  constructor(private sound: Phaser.Sound.BaseSound) {}

  get isPlaying(): boolean {
    return this.sound.isPlaying;
  }

  play(opts?: { rate?: number }): void {
    (this.sound as Phaser.Sound.BaseSound & { play: (o?: { rate?: number }) => void }).play(opts);
  }

  stop(): void {
    this.sound.stop();
  }

  setVolume(v: number): void {
    (
      this.sound as Phaser.Sound.BaseSound & { setVolume: (v: number) => void }
    ).setVolume(clamp01(v));
  }

  destroy(): void {
    this.sound.destroy();
  }
}

/** 可循环、可暂停续播的啃食音效（3 秒内续播，超过 3 秒重置）。 */
class EatLoopSound {
  private ctx?: {
    src: string;
    loop: boolean;
    volume: number;
    paused?: boolean;
    currentTime: number;
    play: () => void | Promise<void>;
    pause: () => void;
    seek?: (t: number) => void;
    destroy?: () => void;
  };
  private playing = false;
  private pausedAt = 0;
  private hasPaused = false;
  private lastAttemptAt = 0;
  private resumeCount = 0;
  private resetCount = 0;

  constructor(private mini: boolean) {}

  private ensure(): boolean {
    if (this.ctx) return true;
    try {
      if (this.mini) {
        const g = globalThis as unknown as {
          wx?: { createInnerAudioContext?: () => NonNullable<EatLoopSound['ctx']> };
          tt?: { createInnerAudioContext?: () => NonNullable<EatLoopSound['ctx']> };
        };
        const api = g.wx?.createInnerAudioContext ? g.wx : g.tt;
        if (!api?.createInnerAudioContext) return false;
        const ctx = api.createInnerAudioContext();
        ctx.src = SFX_DEFS.zombieEat.file;
        ctx.loop = true;
        ctx.volume = clamp01(SFX_DEFS.zombieEat.volume * getVolume());
        this.ctx = ctx;
      } else {
        const AudioCtor = (globalThis as unknown as { Audio?: typeof Audio }).Audio;
        if (!AudioCtor) return false;
        const audio = new AudioCtor();
        audio.src = SFX_DEFS.zombieEat.file;
        audio.loop = true;
        audio.preload = 'auto';
        audio.volume = clamp01(SFX_DEFS.zombieEat.volume * getVolume());
        this.ctx = audio;
      }
      return true;
    } catch {
      return false;
    }
  }

  setVolume(v: number): void {
    if (!this.ctx) return;
    try {
      this.ctx.volume = clamp01(v);
    } catch {
      /* ignore */
    }
  }

  start(): void {
    if (!this.ensure() || !this.ctx) return;
    const now = Date.now();
    const paused = this.ctx.paused !== false;
    if (paused) {
      // 3 秒内继续上次位置；超过 3 秒或从未播放过则从头开始
      if (!this.hasPaused || now - this.pausedAt > 3000) {
        this.seek(0);
        this.resetCount++;
      } else {
        this.resumeCount++;
      }
      if (now - this.lastAttemptAt < 200 && !this.playing) return;
      this.lastAttemptAt = now;
      try {
        const ret = this.ctx.play();
        if (ret && typeof (ret as Promise<void>).catch === 'function') {
          (ret as Promise<void>).catch(() => {
            this.playing = false;
          });
        }
        this.playing = true;
        this.hasPaused = false;
      } catch {
        this.playing = false;
      }
    } else {
      this.playing = true;
    }
  }

  stop(): void {
    if (!this.ctx) return;
    try {
      this.ctx.pause();
    } catch {
      /* ignore */
    }
    this.playing = false;
    this.pausedAt = Date.now();
    this.hasPaused = true;
  }

  private seek(t: number): void {
    if (!this.ctx) return;
    try {
      if (this.ctx.seek) this.ctx.seek(t);
      else this.ctx.currentTime = t;
    } catch {
      /* ignore */
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get position(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get counters(): { resume: number; reset: number } {
    return { resume: this.resumeCount, reset: this.resetCount };
  }

  destroy(): void {
    try {
      this.ctx?.pause();
      this.ctx?.destroy?.();
    } catch {
      /* ignore */
    }
    this.ctx = undefined;
    this.playing = false;
  }
}

export class SfxManager {
  private manager?: Phaser.Sound.BaseSoundManager;
  private pools = new Map<SfxId, Pool>();
  /** 每个音效上次播放时间戳（毫秒），用于节流 */
  private lastPlayAt = new Map<SfxId, number>();
  /** 是否已被显式禁用（例如音频不可用） */
  private disabled = false;
  /** 是否运行在小游戏容器（走 InnerAudioContext） */
  private miniGameMode = IS_MINIGAME;
  /** 循环啃食音效：按住时循环，松开/离开植物时暂停，3 秒内续播 */
  private eatLoop?: EatLoopSound;
  private eatActive = false;

  /** 注入 Phaser 声音管理器（main.ts 启动时调用一次） */
  init(manager: Phaser.Sound.BaseSoundManager): void {
    this.manager = manager;
    // 若已存在实例池（极少见的热重载场景），清空重建，避免持有旧上下文
    this.pools.clear();
    this.lastPlayAt.clear();
  }

  /**
   * 小游戏模式初始化。
   *
   * 不注入 Phaser 管理器：小游戏里 Phaser 的音频通道不可用，
   * 所有实例由 InnerAudioContext 自己创建。
   */
  initMiniGame(): void {
    this.miniGameMode = true;
    this.manager = undefined;
    this.pools.clear();
    this.lastPlayAt.clear();
  }

  /** 音频系统是否可用 */
  get available(): boolean {
    if (this.disabled) return false;
    return this.miniGameMode || !!this.manager;
  }

  /** 当前是否为小游戏音频模式 */
  get isMiniGameMode(): boolean {
    return this.miniGameMode;
  }

  /**
   * 播放一个语义音效。
   *
   * @param id  音效 id（见 data/sfx.ts）
   * @param opts.volumeScale 本次播放的额外音量缩放（默认 1），用于「远近/强弱」微调
   * @returns 是否真正触发了一次播放（被节流或缺失时返回 false）
   */
  play(id: SfxId, opts?: { volumeScale?: number }): boolean {
    if (!this.available) return false;
    const def = SFX_DEFS[id];
    if (!def) return false;

    // Web：Phaser 管理器未解锁/被锁定（浏览器策略）时不播
    if (!this.miniGameMode) {
      const mgr = this.manager as Phaser.Sound.BaseSoundManager | undefined;
      if (!mgr) return false;
      if ((mgr as unknown as { locked?: boolean }).locked) return false;
      // 键未加载（素材缺失或加载失败）时静默跳过
      if (!mgr.game.cache.audio.exists(def.key)) return false;
    }

    // ---- 节流：同一音效在最小间隔内只触发一次 ----
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const throttle = def.throttleMs ?? 0;
    if (throttle > 0) {
      const last = this.lastPlayAt.get(id) ?? -Infinity;
      if (now - last < throttle) return false;
    }
    this.lastPlayAt.set(id, now);

    // ---- 取池中下一个空闲实例 ----
    const pool = this.ensurePool(id);
    if (pool.sounds.length === 0) return false;

    const sound = pool.sounds[pool.cursor % pool.sounds.length];
    pool.cursor++;

    // 小游戏：InnerAudioContext 没有 playbackRate，且主音量需要在播放时重新计算
    const vol =
      def.volume *
      (opts?.volumeScale ?? 1) *
      (this.miniGameMode ? getVolume() : 1);
    const jitter = def.rateJitter ?? 0;
    const rate = jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter : 1;

    try {
      // 已在播放（同实例）→ 先停再播，避免叠加延迟；不同实例则互不干扰
      if (sound.isPlaying) sound.stop();
      sound.setVolume(vol);
      sound.play(this.miniGameMode ? undefined : { rate });
      return true;
    } catch {
      return false;
    }
  }

  /** 立即停止某个音效的所有实例（例如锯子被替换时切断残留声） */
  stop(id: SfxId): void {
    const pool = this.pools.get(id);
    if (!pool) return;
    for (const s of pool.sounds) {
      try {
        s.stop();
      } catch {
        /* 忽略 */
      }
    }
    this.lastPlayAt.delete(id);
  }

  /** 主音量变化时无需逐实例处理：SoundManager 会统一缩放各实例音量 */

  /** 懒加载某个音效的实例池 */
  private ensurePool(id: SfxId): Pool {
    let pool = this.pools.get(id);
    if (pool) return pool;

    const def = SFX_DEFS[id];
    const sounds: SoundHandle[] = [];
    // 小游戏同时存在的 InnerAudioContext 有上限，池子最多 2 个实例
    const count = this.miniGameMode
      ? Math.min(2, Math.max(1, def.pool ?? 1))
      : Math.max(1, def.pool ?? 1);

    if (this.miniGameMode) {
      for (let i = 0; i < count; i++) {
        try {
          sounds.push(new MiniGameSound(def));
        } catch {
          /* 单个实例创建失败忽略 */
        }
      }
    } else {
      const mgr = this.manager as Phaser.Sound.BaseSoundManager | undefined;
      if (mgr && mgr.game.cache.audio.exists(def.key)) {
        for (let i = 0; i < count; i++) {
          try {
            // 同名 key 多次 add 会各返回一个独立实例，可并存、可叠音
            const s = mgr.add(def.key, { volume: def.volume });
            sounds.push(new PhaserSoundHandle(s));
          } catch {
            /* 单个实例创建失败忽略 */
          }
        }
      }
    }

    pool = { def, sounds, cursor: 0 };
    this.pools.set(id, pool);
    return pool;
  }

  /**
   * 按住啃食时循环播放 eat 音效；松开/离开植物时暂停。
   * 暂停后 3 秒内再次啃食 → 从上次位置续播；超过 3 秒 → 从头播放。
   */
  setEating(active: boolean): void {
    if (!active) {
      if (this.eatActive) this.eatLoop?.stop();
      this.eatActive = false;
      return;
    }
    if (!this.available) return;
    if (!this.eatLoop) this.eatLoop = new EatLoopSound(this.miniGameMode);
    this.eatLoop.setVolume(SFX_DEFS.zombieEat.volume * getVolume());
    this.eatLoop.start();
    this.eatActive = true;
  }

  /** 当前啃食循环是否在播放（测试/调试用） */
  get isEatingSoundPlaying(): boolean {
    return !!this.eatLoop?.isPlaying;
  }

  /** 当前啃食音效播放位置（秒，测试/调试用） */
  get eatingSoundPosition(): number {
    return this.eatLoop?.position ?? 0;
  }

  /** 啃食音效续播/重置计数（测试/调试用） */
  get eatingSoundCounters(): { resume: number; reset: number } {
    return this.eatLoop?.counters ?? { resume: 0, reset: 0 };
  }

  /** 停止所有音效并清空实例池（场景重开/关闭时调用） */
  stopAll(): void {
    this.eatActive = false;
    this.eatLoop?.stop();
    for (const pool of this.pools.values()) {
      for (const s of pool.sounds) {
        try {
          if (s.isPlaying) s.stop();
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /** 彻底销毁：停止并移除所有实例 */
  destroy(): void {
    this.stopAll();
    this.eatLoop?.destroy();
    this.eatLoop = undefined;
    for (const pool of this.pools.values()) {
      for (const s of pool.sounds) {
        try {
          s.destroy();
        } catch {
          /* 忽略 */
        }
      }
    }
    this.pools.clear();
    this.lastPlayAt.clear();
  }

  /**
   * 预创建全部音效实例池（可选，在进入游戏场景后调用一次）。
   * 提前 add 能避免「第一次播放时临时创建实例」造成的轻微延迟。
   */
  prewarm(): void {
    if (!this.available) return;
    // 小游戏同时存在的 InnerAudioContext 有上限，预创建全部池会挤占音频实例；
    // 这里保持懒加载，第一次播放时再建（延迟可忽略）。
    if (this.miniGameMode) return;
    for (const id of ALL_SFX_IDS) {
      this.ensurePool(id);
    }
  }
}

/** 全局单例 */
export const sfx = new SfxManager();
