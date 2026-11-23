/**
 * 运行环境探测与平台能力收口。
 *
 * 游戏需要同时跑在：
 *   - 桌面浏览器 / H5 平台（Web）
 *   - 微信小游戏（wx）
 *   - 抖音小游戏（tt，预留）
 *
 * 这里只做「只读能力探测」，不实现具体适配；
 * 存储、音频、广告分别在 storage / bgm+sfx / ads 中收口。
 */

export type PlatformId = 'web' | 'wx' | 'tt';

interface WxLike {
  loadSubpackage?: (opts: {
    name: string;
    success?: () => void;
    fail?: (err: unknown) => void;
    complete?: () => void;
  }) => void;
  getSystemInfoSync?: () => {
    platform?: string;
    system?: string;
    brand?: string;
    model?: string;
    windowWidth?: number;
    windowHeight?: number;
    screenWidth?: number;
    screenHeight?: number;
    pixelRatio?: number;
    safeArea?: { top: number; bottom: number; left: number; right: number };
  };
  shareAppMessage?: (opts: { title: string; imageUrl?: string; query?: string }) => void;
  vibrateShort?: (opts?: { type?: 'heavy' | 'medium' | 'light' }) => void;
  setKeepScreenOn?: (opts: { keepScreenOn: boolean }) => void;
  triggerGC?: () => void;
}

const g = globalThis as unknown as { wx?: WxLike; tt?: WxLike };

function detectPlatform(): PlatformId {
  if (g.wx && typeof g.wx.getSystemInfoSync === 'function') return 'wx';
  if (g.tt && typeof g.tt.getSystemInfoSync === 'function') return 'tt';
  return 'web';
}

/** 当前平台 */
export const PLATFORM: PlatformId = detectPlatform();

/** 是否运行在小游戏容器内 */
export const IS_MINIGAME = PLATFORM !== 'web';

/** 是否触摸优先设备（手机 / 平板 / 小游戏） */
export const IS_TOUCH: boolean = (() => {
  if (IS_MINIGAME) return true;
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  if ((nav.maxTouchPoints ?? 0) > 0) return true;
  if (typeof window !== 'undefined' && 'ontouchstart' in window) return true;
  return false;
})();

/** 屏幕逻辑尺寸（小游戏为逻辑像素；Web 为窗口尺寸） */
export function getScreenSize(): { width: number; height: number } {
  if (IS_MINIGAME) {
    try {
      const info = (PLATFORM === 'wx' ? g.wx : g.tt)?.getSystemInfoSync?.();
      if (info && info.windowWidth && info.windowHeight) {
        return { width: info.windowWidth, height: info.windowHeight };
      }
    } catch {
      /* 取不到时走兜底 */
    }
  }
  if (typeof window !== 'undefined') {
    return { width: window.innerWidth || 640, height: window.innerHeight || 640 };
  }
  return { width: 640, height: 640 };
}

/** 设备像素比（小游戏 Canvas 需要按物理像素分配缓冲区才清晰） */
export function getPixelRatio(): number {
  if (IS_MINIGAME) {
    try {
      const info = (PLATFORM === 'wx' ? g.wx : g.tt)?.getSystemInfoSync?.();
      const r = Number(info?.pixelRatio);
      if (Number.isFinite(r) && r > 0) return Math.min(3, r);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)) {
    return Math.min(3, Math.max(1, window.devicePixelRatio));
  }
  return 1;
}

/**
 * 懒加载 BGM 分包。
 *
 * 音频共 ~8MB，放在主包会超过微信 4MB 主包限制；
 * game.json 里把 assets/bgm 划到名为 bgm 的分包，首次开局时后台加载。
 * 加载失败（未配置分包/开发者工具限制）时静默降级为无 BGM。
 */
export function loadBgmSubpackage(): Promise<boolean> {
  if (!IS_MINIGAME) return Promise.resolve(true);
  const api = (PLATFORM === 'wx' ? g.wx : g.tt) as WxLike | undefined;
  if (!api?.loadSubpackage) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      api.loadSubpackage?.({
        name: 'bgm',
        success: () => done(true),
        fail: () => done(false),
        complete: () => {
          /* success/fail 二选一，无需额外处理 */
        }
      });
      // 兜底：某些基础库不回调 complete 时，最多等 8 秒
      setTimeout(() => done(false), 8000);
    } catch {
      done(false);
    }
  });
}

/** 安全区（逻辑像素，相对屏幕顶部/底部） */
export function getSafeArea(): { top: number; bottom: number; left: number; right: number } {
  if (IS_MINIGAME) {
    try {
      const info = (PLATFORM === 'wx' ? g.wx : g.tt)?.getSystemInfoSync?.();
      const sa = info?.safeArea;
      if (sa && info?.windowHeight) {
        return {
          top: Math.max(0, sa.top),
          bottom: Math.max(0, (info.windowHeight ?? 0) - sa.bottom),
          left: Math.max(0, sa.left),
          right: Math.max(0, (info.windowWidth ?? 0) - sa.right)
        };
      }
    } catch {
      /* ignore */
    }
  }
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

/** 短振动（移动端反馈；Web 不支持时静默） */
export function vibrateShort(): void {
  if (IS_MINIGAME) {
    try {
      (PLATFORM === 'wx' ? g.wx : g.tt)?.vibrateShort?.({ type: 'light' });
      return;
    } catch {
      /* ignore */
    }
  }
  try {
    (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.(10);
  } catch {
    /* ignore */
  }
}

/** 保持屏幕常亮（小游戏） */
export function keepScreenOn(): void {
  if (!IS_MINIGAME) return;
  try {
    (PLATFORM === 'wx' ? g.wx : g.tt)?.setKeepScreenOn?.({ keepScreenOn: true });
  } catch {
    /* ignore */
  }
}

/** 主动 GC（小游戏内存紧张时） */
export function triggerGC(): void {
  if (!IS_MINIGAME) return;
  try {
    g.wx?.triggerGC?.();
  } catch {
    /* ignore */
  }
}

/**
 * 分享。
 *
 * 小游戏走 wx.shareAppMessage；Web 走 navigator.share，失败时返回 false。
 */
export function shareGame(opts: {
  title: string;
  imageUrl?: string;
  query?: string;
  text?: string;
  url?: string;
}): boolean {
  if (IS_MINIGAME) {
    try {
      (PLATFORM === 'wx' ? g.wx : g.tt)?.shareAppMessage?.({
        title: opts.title,
        imageUrl: opts.imageUrl,
        query: opts.query
      });
      return true;
    } catch {
      return false;
    }
  }

  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
    share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  }) : undefined;
  if (nav?.share) {
    nav
      .share({ title: opts.title, text: opts.text, url: opts.url })
      .catch(() => {
        /* 用户取消或浏览器拒绝，静默 */
      });
    return true;
  }
  return false;
}

/** 是否支持分享 */
export function canShare(): boolean {
  if (IS_MINIGAME) return true;
  return typeof navigator !== 'undefined' && typeof (navigator as Navigator & { share?: unknown }).share === 'function';
}
