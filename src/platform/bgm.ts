/**
 * 背景音乐（BGM）管理器。
 *
 * ---- 为什么用 HTMLAudioElement 而不是 Phaser 的 sound ----
 *
 * Phaser 3 的 SoundManager.play(key) 要求音频事先通过 load.audio 进缓存。
 * 本作有 10 首 mp3 共 ~30MB，全部塞进 BootScene 会让开局加载条卡很久。
 * 而 BGM 是「按需懒加载」的，用原生 <audio> 元素直接给 src 播放最简单：
 *   - 浏览器负责流式加载，只缓冲够播放的部分
 *   - 天然支持 loop / fade（调 volume）
 *   - 与 Phaser 的场景生命周期解耦（重开场景时 BGM 不中断、也不叠加）
 *
 * ---- 状态机（谁该在响）----
 *
 *   优先级从高到低：
 *     menu  —— 暂停 / 商店覆盖层打开时，临时压过其它
 *     fail  —— 玩家死亡后，一次性播放（loop=false），直到重开
 *     revenge —— 全局累计重开 ≥ 20 次后，循环
 *     overtime —— 本局计时 ≥ 3 分钟后，循环
 *     normal —— 默认循环
 *
 * 「上下文音乐」= 当前本应循环的那一类（normal / overtime / revenge）。
 * 打开菜单时把上下文音乐暂停、改播 menu；关闭菜单时恢复上下文音乐，
 * 因此菜单不会打乱本来的进度（用 audio.currentTime 续播，而不是从头来）。
 *
 * ---- 自动播放策略 ----
 *
 * 现代浏览器禁止无用户手势的音频自动播放。Phaser 的 SoundManager 会
 * 监听首次点击/按键来 unlock，但原生 <audio>.play() 仍会被拒。
 * 所以这里：play() 返回的 Promise 若 reject（NotAllowedError），
 * 就挂一个「一次性用户手势监听」，等用户第一次点击/按键时再补播。
 */

import {
  BGM_TRACKS,
  BGM_OVERTIME_MS,
  BGM_REVENGE_RESTARTS,
  BGM_VOLUME_SCALE,
  BGM_FADE_MS,
  type BgmGroup
} from '../data/bgm';
import { getVolume } from './sound';
import { IS_MINIGAME, loadBgmSubpackage } from './env';

/** 随机取一首 */
function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 安全设置 HTMLAudioElement 音量。
 *
 * 浏览器对 volume 的合法区间是 [0, 1]，越界会抛 IndexSizeError。
 * 淡变插值与多路音量混算时浮点误差可能产生 -0.003 这种值，
 * 因此所有写入都必须经过这里夹取，绝不允许把异常抛进 rAF 回调。
 */
function safeSetVolume(audio: HTMLAudioElement, value: number): number {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  try {
    audio.volume = v;
  } catch {
    /* 某些宿主（如小游戏 InnerAudioContext 适配层）可能不支持，静默忽略 */
  }
  return v;
}

export class BgmManager {
  /** 单例（跨场景、跨重开保持同一实例，避免重叠播放） */
  private static instance: BgmManager | null = null;

  /** 当前实际在播放的 <audio> 元素；null 表示没有声音 */
  private current: HTMLAudioElement | null = null;
  /** 当前曲目路径（用于判断「已经在放同一首」时不必重载） */
  private currentSrc = '';
  /** 当前曲目所属分组 */
  private currentGroup: BgmGroup | null = null;

  /**
   * 「上下文音乐」——当前本应循环播放的核心曲目分组（normal / overtime / revenge）。
   * 打开菜单时用它来决定关闭后恢复哪一类。
   */
  private contextGroup: Exclude<BgmGroup, 'menu' | 'fail'> = 'normal';
  /** 上下文音乐当前的播放进度（打开菜单前保存，关闭后恢复） */
  private contextTime = 0;
  /** 上下文音乐路径（恢复时按同一首继续） */
  private contextSrc = '';

  /** 上下文切换标志：revenge 一旦开启，优先级高于 overtime */
  private revengeUnlocked = false;
  /** overtime 是否已触发 */
  private overtimeUnlocked = false;

  /** 全局累计重开次数（用于 revenge 解锁；刷新页面才清零） */
  private revengeRestartCount = 0;

  /** 是否已经开过局（用于区分首局与重开；首局不计入重开数） */
  private hasStartedOnce = false;

  /** 是否处于菜单覆盖态（暂停/商店） */
  private menuActive = false;

  /** 是否因展示广告而临时暂停 */
  private adSuspended = false;

  /**
   * 小游戏 BGM 分包状态。
   *
   * Web 恒为 ready；小游戏需要先 wx.loadSubpackage('bgm')，
   * 加载完成前把「应该播哪一组」记在 pending 里，完成后补播。
   */
  private bgmReady = !IS_MINIGAME;
  private bgmLoading = false;
  private bgmFailed = false;
  private pendingPlay: { group: BgmGroup; opts: { loop: boolean; restart: boolean } } | null = null;

  /** 是否已被用户手势解锁（浏览器自动播放策略） */
  private gestureUnlocked = false;
  /** 待补播的意图：user 手势到来后执行 */
  private pendingGesturePlay = false;

  /**
   * 所有「曾创建、可能仍在发声」的 audio 元素。
   *
   * 关键防重叠手段：任何时刻开始播放新曲前，先遍历这个集合，
   * 把所有「不是即将播放的这一首」的元素强制 pause + 清 src。
   * 这样即便有淡出中途被中断、脱管的元素，也会被兜底停掉，
   * 从根上杜绝多首 BGM 同时出声。
   */
  private liveAudio = new Set<HTMLAudioElement>();

  /** 每个 audio 正在进行的淡变（用于独立取消，互不干扰） */
  private fadeState = new Map<HTMLAudioElement, { cancel: () => void }>();

  private constructor() {
    this.installGestureUnlock();
  }

  static get(): BgmManager {
    if (!BgmManager.instance) BgmManager.instance = new BgmManager();
    return BgmManager.instance;
  }

  // ------------------------------------------------------------ 公共 API

  /**
   * 开局：进入 GameScene 时调用。
   *
   * 首次调用视为「首局」；之后每次调用（死亡/暂停后重新进入 GameScene）
   * 都算一次「重开」，用于累计 revenge 解锁次数（仅存内存，刷新清零）。
   */
  startRun(): void {
    this.menuActive = false;

    if (this.hasStartedOnce) {
      this.revengeRestartCount += 1;
      if (this.revengeRestartCount >= BGM_REVENGE_RESTARTS) {
        this.revengeUnlocked = true;
      }
    } else {
      this.hasStartedOnce = true;
    }

    this.overtimeUnlocked = false;

    // 上下文：revenge 优先级最高，其次 normal
    this.contextGroup = this.revengeUnlocked ? 'revenge' : 'normal';
    this.contextTime = 0;
    this.contextSrc = '';

    this.playGroup(this.contextGroup, { loop: true, restart: true });
  }

  /**
   * 每帧驱动：根据本局已进行的毫秒数，判断是否该切到 overtime。
   *
   * 由 GameScene 在 update 里调用（只在存活时调用，死亡后不再推进）。
   * 若 revenge 已解锁，则 overtime 不抢占（revenge 优先级更高）。
   */
  tick(elapsedMs: number): void {
    if (this.revengeUnlocked) return; // revenge 优先，锁定
    if (this.menuActive) return; // 菜单态不切换上下文
    if (this.overtimeUnlocked) return;
    if (elapsedMs >= BGM_OVERTIME_MS) {
      this.overtimeUnlocked = true;
      this.contextGroup = 'overtime';
      this.playGroup('overtime', { loop: true, restart: true });
    }
  }

  /** 预加载 BGM 分包（小游戏）；Web 为 no-op */
  preload(): void {
    if (!this.bgmReady && !this.bgmFailed) this.loadBgmSubpackage();
  }

  /** 打开菜单（暂停 / 商店）：保存上下文进度，改播 menu */
  enterMenu(): void {
    if (this.menuActive) return;

    // 保存上下文进度（仅当上下文音乐正在播放时），并真正停掉它
    if (this.current && this.currentGroup === this.contextGroup) {
      this.contextTime = this.current.currentTime || 0;
      this.contextSrc = this.currentSrc;
      this.stopCurrent(0);
    }

    this.menuActive = true;
    this.playGroup('menu', { loop: true, restart: false });
  }

  /** 关闭菜单：恢复之前暂停的上下文音乐（同一首、同一进度） */
  exitMenu(): void {
    if (!this.menuActive) return;
    this.menuActive = false;

    // 立即停掉 menu（resumeContext 内部还会兜底停掉一切非当前曲，
    // 所以这里用 0 立即停，避免淡出与随后的上下文曲交叉）
    this.stopCurrent(0);

    // 恢复上下文音乐：优先按保存的同一首续播
    if (this.contextSrc) {
      this.resumeContext();
    } else {
      this.playGroup(this.contextGroup, { loop: true, restart: true });
    }
  }

  /**
   * 广告复活后继续本局：从失败曲切回当前上下文音乐。
   *
   * 与 startRun 的区别：不累计重开次数、不重置 overtime/revenge 解锁状态。
   */
  resumeRun(): void {
    this.menuActive = false;
    this.adSuspended = false;
    this.playGroup(this.contextGroup, { loop: true, restart: true });
  }

  /** 玩家死亡：停一切，播放一次性失败曲 */
  playFail(): void {
    this.menuActive = false;
    this.contextSrc = '';
    this.playGroup('fail', { loop: false, restart: true });
  }

  /** 设置页改变主音量时调用：让当前 BGM 立即跟随 */
  onVolumeChanged(): void {
    this.applyVolumeToCurrent();
  }

  /**
   * 看广告前暂停当前 BGM（不切歌、不丢进度）。
   *
   * 和 enterMenu 的区别：菜单会切到 menu 曲，广告期间不应该有游戏音乐，
   * 所以这里只 pause，广告结束后原样续播。
   */
  suspendForAd(): void {
    if (!this.current || this.adSuspended) return;
    try {
      this.current.pause();
      this.adSuspended = true;
    } catch {
      /* ignore */
    }
  }

  /** 广告结束：续播当前 BGM */
  resumeFromAd(): void {
    if (!this.adSuspended) return;
    this.adSuspended = false;
    if (!this.current) return;
    this.safePlay(this.current);
    this.applyVolumeToCurrent();
  }

  // ------------------------------------------------------------ 内部：播放

  /**
   * 播放某分组的一首曲目。
   *
   * @param group    音乐分组
   * @param opts.loop    是否循环
   * @param opts.restart 是否从头开始（false 时若同一首已在放则跳过错歌重置）
   */
  private playGroup(group: BgmGroup, opts: { loop: boolean; restart: boolean }): void {
    if (this.bgmFailed) return;

    // 小游戏：BGM 在分包里，先加载再补播
    if (!this.bgmReady) {
      this.pendingPlay = { group, opts };
      this.loadBgmSubpackage();
      return;
    }

    const list = BGM_TRACKS[group];
    if (!list || list.length === 0) return;

    // 选曲：同一分组内随机；若要求「不重开」且正好是当前曲，则复用
    let src = pickRandom(list);
    if (!opts.restart && this.currentGroup === group && list.includes(this.currentSrc)) {
      src = this.currentSrc;
    }

    this.startAudio(this.resolveSrc(src), group, opts.loop);
  }

  /** 小游戏分包内的 BGM 路径要加 `bgm/` 前缀 */
  private resolveSrc(src: string): string {
    return IS_MINIGAME ? `bgm/${src}` : src;
  }

  /** 加载 BGM 分包；完成后补播 pendingPlay */
  private loadBgmSubpackage(): void {
    if (this.bgmLoading || this.bgmReady || this.bgmFailed) return;
    this.bgmLoading = true;
    void loadBgmSubpackage().then((ok) => {
      this.bgmLoading = false;
      this.bgmReady = ok;
      this.bgmFailed = !ok;
      const pending = this.pendingPlay;
      this.pendingPlay = null;
      if (ok && pending) {
        this.playGroup(pending.group, pending.opts);
      }
    });
  }

  /** 创建一个新的 <audio> 并播放（带淡入） */
  private startAudio(src: string, group: BgmGroup, loop: boolean): void {
    // 同一首且已在播放（menu 重入之类）：确保在放即可，不重建
    if (this.current && this.currentSrc === src && group === this.currentGroup) {
      this.applyVolumeToCurrent();
      this.safePlay(this.current);
      return;
    }

    // 先彻底停掉所有其它 audio（含正在淡出的），保证「至多一首在响」
    this.stopOthers(null);

    const audio = this.createAudio(src, group, loop);
    this.current = audio;
    this.currentSrc = src;
    this.currentGroup = group;

    this.safePlay(audio);
    this.fadeTo(audio, this.targetVolume(), BGM_FADE_MS);
  }

  /** 恢复上下文音乐（菜单关闭后）：同一首、同一进度续播 */
  private resumeContext(): void {
    // 先彻底停掉所有其它 audio（尤其是可能还在淡出的 menu）
    this.stopOthers(null);

    const audio = this.createAudio(this.contextSrc, this.contextGroup, true);
    this.current = audio;
    this.currentSrc = this.contextSrc;
    this.currentGroup = this.contextGroup;

    // 尽量从上次暂停的位置续播（元数据就绪后再 seek 一次，覆盖 duration 未知）
    const resumeTime = this.contextTime;
    if (resumeTime > 0) {
      audio.addEventListener(
        'loadedmetadata',
        () => {
          try {
            const dur = Number.isFinite(audio.duration) ? audio.duration : resumeTime;
            audio.currentTime = Math.max(0, Math.min(resumeTime, dur - 0.5));
          } catch {
            /* 忽略 */
          }
        },
        { once: true }
      );
    }

    this.safePlay(audio);
    this.fadeTo(audio, this.targetVolume(), BGM_FADE_MS);
  }

  /**
   * 新建一个 audio 元素并登记到 liveAudio。
   *
   * 统一在这里 attach 一次性失败曲的 ended 处理。
   */
  private createAudio(src: string, group: BgmGroup, loop: boolean): HTMLAudioElement {
    const audio = new Audio();
    audio.src = src;
    audio.loop = loop;
    audio.preload = 'auto';
    safeSetVolume(audio, 0);
    this.liveAudio.add(audio);

    // 一次性失败曲播放完毕后静默（不自动重播）
    if (!loop) {
      audio.addEventListener('ended', () => {
        if (this.current === audio) {
          this.current = null;
          this.currentGroup = null;
          this.currentSrc = '';
        }
        this.releaseAudio(audio);
      });
    }
    return audio;
  }

  /** 立即停止当前曲目（淡出可选，但淡出结束/超时都会强制 pause） */
  private stopCurrent(fadeMs: number): void {
    const audio = this.current;
    this.current = null;
    this.currentGroup = null;
    this.currentSrc = '';

    if (!audio) return;

    if (fadeMs <= 0) {
      this.releaseAudio(audio);
      return;
    }

    // 淡出：先把音量渐降到 0，再释放。
    // 释放由 fadeTo 的 onDone 负责；同时 fadeTo 自带兜底定时器，
    // 即便 rAF 被打断也一定会 pause，绝不会脱管继续响。
    this.fadeTo(audio, 0, fadeMs, () => this.releaseAudio(audio));
  }

  /**
   * 停止除 keep 之外的所有 audio（强制 pause + 清 src 并从集合移除）。
   *
   * 这是「至多一首在响」的兜底闸门，任何开始播放新曲前都必须调用。
   */
  private stopOthers(keep: HTMLAudioElement | null): void {
    for (const audio of Array.from(this.liveAudio)) {
      if (audio === keep) continue;
      this.releaseAudio(audio);
    }
  }

  /** 彻底释放一个 audio：取消其淡变、暂停、清源、移出集合 */
  private releaseAudio(audio: HTMLAudioElement): void {
    this.cancelFadeFor(audio);
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* 忽略 */
    }
    this.liveAudio.delete(audio);
  }

  // ------------------------------------------------------------ 内部：音量 / 淡变

  /** 目标音量 = 主音量 × BGM 系数，并 clamp 到 [0,1] */
  private targetVolume(): number {
    const master = getVolume();
    return Math.min(1, Math.max(0, master * BGM_VOLUME_SCALE));
  }

  private applyVolumeToCurrent(): void {
    if (!this.current) return;
    // 直接设到目标（打断淡变，避免淡变过程中被音量设置覆盖后漂移）
    this.cancelFadeFor(this.current);
    safeSetVolume(this.current, this.targetVolume());
  }

  /**
   * 淡变「某个」audio 的音量到 target。
   *
   * 关键设计：每个 audio 的淡变状态独立存放（挂在元素自身上），
   * 不再用全局单一定时器 —— 否则两个 audio 的淡变会互相取消对方，
   * 导致被取消的那个永远走不到 onDone（= 不会被 pause），从而一直响。
   *
   * 额外加一个 setTimeout 兜底：即便 requestAnimationFrame 因切后台等
   * 原因长时间不回调，到点也会强制把音量设为目标并触发 onDone。
   */
  private fadeTo(
    audio: HTMLAudioElement,
    target: number,
    durationMs: number,
    onDone?: () => void
  ): void {
    this.cancelFadeFor(audio);

    const from = Number.isFinite(audio.volume) ? Math.min(1, Math.max(0, audio.volume)) : 0;
    const clampedTarget = Math.min(1, Math.max(0, target));

    if (durationMs <= 0 || Math.abs(clampedTarget - from) < 0.001) {
      safeSetVolume(audio, clampedTarget);
      onDone?.();
      return;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.cancelFadeFor(audio);
      safeSetVolume(audio, clampedTarget);
      onDone?.();
    };

    const start = performance.now();
    let rafId = 0;
    const step = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / durationMs));
      safeSetVolume(audio, from + (clampedTarget - from) * p);
      if (p < 1) {
        rafId = window.requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    rafId = window.requestAnimationFrame(step);

    // 兜底：durationMs 后再来一刀，保证一定会收尾
    const timeoutId = window.setTimeout(finish, durationMs + 80);

    this.fadeState.set(audio, {
      cancel: () => {
        window.cancelAnimationFrame(rafId);
        window.clearTimeout(timeoutId);
        finished = true;
      }
    });
  }

  /** 取消某个 audio 正在进行（若有）的淡变 */
  private cancelFadeFor(audio: HTMLAudioElement): void {
    const st = this.fadeState.get(audio);
    if (st) {
      st.cancel();
      this.fadeState.delete(audio);
    }
  }

  // ------------------------------------------------------------ 内部：自动播放解锁

  /**
   * 尝试播放，若被浏览器的自动播放策略拒绝，则登记「待手势补播」。
   *
   * try/catch 兜住同步异常；play() 返回的 Promise 也要 catch，
   * 否则会产生一个未处理的 rejection 污染控制台。
   */
  private safePlay(audio: HTMLAudioElement): void {
    try {
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this.gestureUnlocked = true;
        }).catch(() => {
          // 被自动播放策略拦截：等用户手势
          this.pendingGesturePlay = true;
        });
      } else {
        this.gestureUnlocked = true;
      }
    } catch {
      this.pendingGesturePlay = true;
    }
  }

  /**
   * 安装一次性用户手势监听，用于浏览器拦截自动播放后的补播。
   *
   * 任意 pointerdown / keydown / touchstart 都算手势。
   */
  private installGestureUnlock(): void {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      this.gestureUnlocked = true;
      if (this.pendingGesturePlay && this.current) {
        this.pendingGesturePlay = false;
        this.safePlay(this.current);
      }
      // 手势已经足够，之后不再需要监听
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
  }
}

/** 全局便捷入口 */
export function bgm(): BgmManager {
  return BgmManager.get();
}
