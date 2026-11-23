/**
 * 广告平台收口。
 *
 * 设计目标：
 *   1. 业务层只关心「有没有广告」「看完没有」，不关心平台 API；
 *   2. 没有广告能力（itch.io、无广告位、加载失败）时，所有入口自动降级，
 *      绝不出现「点了没反应」或卡死结算；
 *   3. 插屏有频控，激励视频有超时，广告永远不是「强制」的。
 *
 * 支持的平台：
 *   - 微信小游戏：wx.createRewardedVideoAd / createInterstitialAd
 *   - 抖音小游戏：预留（tt.createRewardedVideoAd，接口同微信）
 *   - Poki SDK：PokiSDK.rewardedBreak / commercialBreak
 *   - CrazyGames SDK：CrazyGames.SDK.ad.requestAd
 *   - Web 测试：URL 带 ?adtest=1 时弹出模拟广告，便于全流程验收
 */

import { AD_CONFIG } from '../data/ads';
import { IS_MINIGAME, PLATFORM } from './env';
import { loadAdState, saveAdState } from './storage';

export type RewardedOutcome = 'rewarded' | 'skipped' | 'unavailable' | 'error';

interface WxAd {
  load: () => Promise<void>;
  show: () => Promise<void>;
  onLoad: (cb: () => void) => void;
  onError: (cb: (err: unknown) => void) => void;
  onClose: (cb: (res?: { isEnded?: boolean }) => void) => void;
  offClose?: (cb?: (res?: { isEnded?: boolean }) => void) => void;
}

interface WxLikeAds {
  createRewardedVideoAd?: (opts: { adUnitId: string }) => WxAd;
  createInterstitialAd?: (opts: { adUnitId: string }) => WxAd;
}

interface PokiSdk {
  init?: () => Promise<void>;
  gameLoadingFinished?: () => void;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  commercialBreak?: () => Promise<void>;
  rewardedBreak?: () => Promise<boolean>;
}

interface CrazySdk {
  init?: () => Promise<void>;
  game?: { gameplayStart?: () => void; gameplayStop?: () => void };
  ad?: {
    requestAd?: (
      type: 'rewarded' | 'midgame',
      callbacks?: {
        adStarted?: () => void;
        adFinished?: () => void;
        adError?: (err: unknown) => void;
      }
    ) => Promise<void>;
  };
}

type Win = Window & {
  PokiSDK?: PokiSdk;
  CrazyGames?: { SDK?: CrazySdk };
};

function win(): Win | undefined {
  return typeof window !== 'undefined' ? (window as unknown as Win) : undefined;
}

function wxAds(): WxLikeAds | undefined {
  if (!IS_MINIGAME) return undefined;
  const g = globalThis as unknown as { wx?: WxLikeAds; tt?: WxLikeAds };
  return PLATFORM === 'wx' ? g.wx : g.tt;
}

/**
 * 测试用广告位覆盖（仅本地 mock / 自动化测试注入，生产不会设置）。
 * 便于在不改源码、不重新构建的情况下验证微信广告回调链路。
 */
function overrideUnitId(kind: 'rewarded' | 'interstitial'): string {
  const o = (globalThis as unknown as {
    __AD_UNIT_OVERRIDE__?: { rewarded?: string; interstitial?: string };
  }).__AD_UNIT_OVERRIDE__;
  return (kind === 'rewarded' ? o?.rewarded : o?.interstitial) || '';
}

function wxRewardedUnitId(): string {
  return overrideUnitId('rewarded') ||
    (PLATFORM === 'wx' ? AD_CONFIG.wx.rewardedUnitId : AD_CONFIG.tt.rewardedUnitId);
}

function wxInterstitialUnitId(): string {
  return overrideUnitId('interstitial') ||
    (PLATFORM === 'wx' ? AD_CONFIG.wx.interstitialUnitId : AD_CONFIG.tt.interstitialUnitId);
}

function isTestMode(): boolean {
  if (!AD_CONFIG.allowWebTestAds || IS_MINIGAME) return false;
  try {
    return new URLSearchParams(window.location.search).get('adtest') === '1';
  } catch {
    return false;
  }
}

export class AdManager {
  private initialized = false;
  /** 微信激励视频实例（同一 adUnitId 复用） */
  private rewardedAd?: WxAd;
  private interstitialAd?: WxAd;
  /** 当前正在等待的激励视频回调 */
  private pendingRewarded?: (outcome: RewardedOutcome) => void;
  private pendingInterstitial?: () => void;
  /** 防止并发展示 */
  private showingRewarded = false;
  private showingInterstitial = false;

  /** 标记「本局是否允许出插屏」（由 GameScene 在开始时设置） */
  private interstitialAllowed = true;

  /** 初始化：只做一次，失败不影响游戏 */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const w = win();
    if (!IS_MINIGAME && w?.PokiSDK) {
      Promise.resolve(w.PokiSDK.init?.()).catch(() => {
        /* ignore */
      });
    }
    if (!IS_MINIGAME && w?.CrazyGames?.SDK) {
      Promise.resolve(w.CrazyGames.SDK.init?.()).catch(() => {
        /* ignore */
      });
    }

    this.prepareWxRewarded();
    this.prepareWxInterstitial();
  }

  // ------------------------------------------------------------ 能力判断

  rewardedAvailable(): boolean {
    if (isTestMode()) return true;
    if (IS_MINIGAME) {
      const id = wxRewardedUnitId();
      return !!id && !!wxAds()?.createRewardedVideoAd;
    }
    const w = win();
    if (w?.PokiSDK?.rewardedBreak) return true;
    if (w?.CrazyGames?.SDK?.ad?.requestAd) return true;
    return false;
  }

  interstitialAvailable(): boolean {
    if (isTestMode()) return true;
    if (IS_MINIGAME) {
      const id = wxInterstitialUnitId();
      return !!id && !!wxAds()?.createInterstitialAd;
    }
    const w = win();
    if (w?.PokiSDK?.commercialBreak) return true;
    if (w?.CrazyGames?.SDK?.ad?.requestAd) return true;
    return false;
  }

  /** 本局是否关闭插屏（例如正在看广告 / 首局） */
  setInterstitialAllowed(allowed: boolean): void {
    this.interstitialAllowed = allowed;
  }

  /** 当前是否正在展示广告（用于避免 onShow 时把 BGM 恢复到广告背后） */
  isShowingAd(): boolean {
    return this.showingRewarded || this.showingInterstitial;
  }

  // ------------------------------------------------------------ 激励视频

  /**
   * 展示激励视频。
   *
   * resolve 的四种结果：
   *   rewarded    —— 完整看完，应该发奖
   *   skipped     —— 用户中途关闭，不发奖
   *   unavailable —— 当前平台没有广告能力
   *   error       —— 加载/播放失败，不发奖（调用方提示「广告暂不可用」）
   */
  async showRewarded(): Promise<RewardedOutcome> {
    if (this.showingRewarded) return 'error';
    if (!this.rewardedAvailable()) return 'unavailable';

    this.showingRewarded = true;
    let outcome: RewardedOutcome = 'error';
    try {
      if (isTestMode()) {
        outcome = await this.showTestAd(true);
        return outcome;
      }

      if (IS_MINIGAME) {
        outcome = await this.showWxRewarded();
        return outcome;
      }

      const w = win();
      if (w?.PokiSDK?.rewardedBreak) {
        const ok = await w.PokiSDK.rewardedBreak();
        outcome = ok ? 'rewarded' : 'skipped';
        return outcome;
      }
      if (w?.CrazyGames?.SDK?.ad?.requestAd) {
        await w.CrazyGames.SDK.ad.requestAd('rewarded');
        outcome = 'rewarded';
        return outcome;
      }
      outcome = 'unavailable';
      return outcome;
    } catch (err) {
      console.warn('[ads] 激励视频失败:', err);
      outcome = 'error';
      return outcome;
    } finally {
      this.showingRewarded = false;
      // 只有真正看完才计入运营数据
      if (outcome === 'rewarded') this.bumpRewardCount();
    }
  }

  private prepareWxRewarded(): void {
    const id = wxRewardedUnitId();
    if (!IS_MINIGAME || !id) return;
    const api = wxAds();
    if (!api?.createRewardedVideoAd) return;
    try {
      const ad = api.createRewardedVideoAd({ adUnitId: id });
      ad.onError((err) => {
        console.warn('[ads] 微信激励视频错误:', err);
        const p = this.pendingRewarded;
        this.pendingRewarded = undefined;
        p?.('error');
      });
      ad.onClose((res) => {
        const p = this.pendingRewarded;
        this.pendingRewarded = undefined;
        // 老基础库可能不返回 res；缺失时按「看完」处理，避免误伤用户
        const finished = !res || res.isEnded !== false;
        p?.(finished ? 'rewarded' : 'skipped');
      });
      this.rewardedAd = ad;
    } catch (err) {
      console.warn('[ads] 创建激励视频实例失败:', err);
    }
  }

  private async showWxRewarded(): Promise<RewardedOutcome> {
    const ad = this.rewardedAd;
    if (!ad) return 'unavailable';

    return await new Promise<RewardedOutcome>((resolve) => {
      let settled = false;
      const done = (outcome: RewardedOutcome) => {
        if (settled) return;
        settled = true;
        this.pendingRewarded = undefined;
        clearTimeout(timer);
        resolve(outcome);
      };
      this.pendingRewarded = done;
      const timer = setTimeout(() => done('error'), AD_CONFIG.rewardedTimeoutMs);

      const show = async () => {
        try {
          await ad.load();
        } catch {
          /* load 失败也尝试 show，某些基础库会自动拉取 */
        }
        try {
          await ad.show();
        } catch (err) {
          // 常见于「未加载完」：重试一次 load + show
          try {
            await ad.load();
            await ad.show();
          } catch (err2) {
            console.warn('[ads] 激励视频 show 失败:', err, err2);
            done('error');
          }
        }
      };
      void show();
    });
  }

  // ------------------------------------------------------------ 插屏

  /**
   * 按频控尝试插屏。返回是否真正展示过。
   *
   * 调用时机：结算界面出现后（不要在一局进行中打断玩家）。
   */
  async maybeShowInterstitial(): Promise<boolean> {
    if (!this.interstitialAllowed) return false;
    if (!this.interstitialAvailable()) return false;
    if (this.showingInterstitial || this.showingRewarded) return false;

    const state = loadAdState();
    const f = AD_CONFIG.frequency;
    if (state.runs < 2 && !f.allowOnFirstRun) return false;
    if (state.runs % f.interstitialEveryRuns !== 0) return false;
    const now = Date.now();
    if (now - state.lastInterstitialAt < f.interstitialMinIntervalMs) return false;

    this.showingInterstitial = true;
    try {
      let shown = false;
      if (isTestMode()) {
        await this.showTestAd(false);
        shown = true;
      } else if (IS_MINIGAME) {
        shown = await this.showWxInterstitial();
      } else {
        const w = win();
        if (w?.PokiSDK?.commercialBreak) {
          await w.PokiSDK.commercialBreak();
          shown = true;
        } else if (w?.CrazyGames?.SDK?.ad?.requestAd) {
          await w.CrazyGames.SDK.ad.requestAd('midgame');
          shown = true;
        }
      }
      if (shown) {
        saveAdState({ ...state, lastInterstitialAt: Date.now() });
      }
      return shown;
    } catch (err) {
      console.warn('[ads] 插屏失败:', err);
      return false;
    } finally {
      this.showingInterstitial = false;
    }
  }

  private prepareWxInterstitial(): void {
    const id = wxInterstitialUnitId();
    if (!IS_MINIGAME || !id) return;
    const api = wxAds();
    if (!api?.createInterstitialAd) return;
    try {
      const ad = api.createInterstitialAd({ adUnitId: id });
      ad.onError((err) => {
        console.warn('[ads] 微信插屏错误:', err);
        this.pendingInterstitial?.();
        this.pendingInterstitial = undefined;
      });
      ad.onClose(() => {
        this.pendingInterstitial?.();
        this.pendingInterstitial = undefined;
      });
      this.interstitialAd = ad;
    } catch (err) {
      console.warn('[ads] 创建插屏实例失败:', err);
    }
  }

  private async showWxInterstitial(): Promise<boolean> {
    const ad = this.interstitialAd;
    if (!ad) return false;
    try {
      await ad.load();
    } catch {
      /* ignore */
    }
    try {
      await ad.show();
      return true;
    } catch (err) {
      console.warn('[ads] 插屏 show 失败:', err);
      return false;
    }
  }

  // ------------------------------------------------------------ Web 模拟广告（仅测试）

  private showTestAd(rewarded: boolean): Promise<RewardedOutcome> {
    return new Promise<RewardedOutcome>((resolve) => {
      if (typeof document === 'undefined') {
        resolve('unavailable');
        return;
      }
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:999999',
        'background:rgba(4,6,12,0.94)',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:18px',
        'color:#e8eef4',
        'font-family:system-ui,sans-serif',
        'user-select:none'
      ].join(';');

      const title = document.createElement('div');
      title.textContent = rewarded ? '模拟激励视频' : '模拟插屏广告';
      title.style.cssText = 'font-size:24px;font-weight:700;letter-spacing:2px';

      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:14px;color:#8fa8b8';
      sub.textContent = '这是测试用广告，不会产生真实收益';

      const btn = document.createElement('button');
      btn.style.cssText = [
        'margin-top:8px',
        'padding:12px 28px',
        'border-radius:10px',
        'border:2px solid #7fe3ff',
        'background:#122030',
        'color:#e8eef4',
        'font-size:18px',
        'font-weight:700',
        'cursor:pointer',
        'opacity:0.4',
        'pointer-events:none'
      ].join(';');
      btn.textContent = rewarded ? '看完领取奖励' : '关闭广告';

      let left = 3;
      sub.textContent += `（${left}s 后可操作）`;
      const timer = window.setInterval(() => {
        left -= 1;
        if (left > 0) {
          sub.textContent = `这是测试用广告，不会产生真实收益（${left}s 后可操作）`;
          return;
        }
        window.clearInterval(timer);
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        sub.textContent = '这是测试用广告，不会产生真实收益';
      }, 1000);

      btn.addEventListener('click', () => {
        window.clearInterval(timer);
        overlay.remove();
        resolve(rewarded ? 'rewarded' : 'skipped');
      });

      overlay.append(title, sub, btn);
      document.body.appendChild(overlay);

      // 插屏：3 秒后自动关闭；激励：等待用户点击
      if (!rewarded) {
        window.setTimeout(() => {
          window.clearInterval(timer);
          if (overlay.isConnected) overlay.remove();
          resolve('skipped');
        }, 3000);
      }
    });
  }

  // ------------------------------------------------------------ 数据 / 生命周期

  private bumpRewardCount(): void {
    const s = loadAdState();
    saveAdState({ ...s, rewardedCount: s.rewardedCount + 1 });
  }

  /** 开始一局：累计局数（插屏频控用） */
  beginRun(): number {
    const s = loadAdState();
    const runs = s.runs + 1;
    saveAdState({ ...s, runs });
    return runs;
  }

  /** 资源加载完成（Poki 要求在 loading 结束后调用） */
  loadingFinished(): void {
    try {
      win()?.PokiSDK?.gameLoadingFinished?.();
    } catch {
      /* ignore */
    }
  }

  /** 进入游戏玩法（Poki / CrazyGames 要求上报） */
  gameplayStart(): void {
    try {
      const w = win();
      w?.PokiSDK?.gameplayStart?.();
      w?.CrazyGames?.SDK?.game?.gameplayStart?.();
    } catch {
      /* ignore */
    }
  }

  /** 离开玩法（暂停/结算/广告） */
  gameplayStop(): void {
    try {
      const w = win();
      w?.PokiSDK?.gameplayStop?.();
      w?.CrazyGames?.SDK?.game?.gameplayStop?.();
    } catch {
      /* ignore */
    }
  }
}

/** 全局单例 */
export const ads = new AdManager();
