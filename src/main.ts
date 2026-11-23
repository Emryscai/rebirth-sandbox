/**
 * 游戏入口。
 * 创建 Phaser.Game 实例并注册六个场景。
 *
 * 平台差异：
 *   - Web：640×640 画布，Scale.FIT 等比缩放
 *   - 微信/抖音小游戏：画布铺满屏幕物理像素，相机 zoom 居中显示 640 设计区
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, COLORS } from './config';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { PauseScene } from './scenes/PauseScene';
import { ShopScene } from './scenes/ShopScene';
import { SettingsScene } from './scenes/SettingsScene';
import { ResultScene } from './scenes/ResultScene';
import { initI18n, t } from './i18n';
import { applyVolume } from './platform/sound';
import { bgm } from './platform/bgm';
import { sfx } from './platform/sfx';
import { rollPlantDrops } from './data/drops';
import { ads } from './platform/ads';
import {
  IS_MINIGAME,
  PLATFORM,
  getPixelRatio,
  getScreenSize,
  keepScreenOn
} from './platform/env';
import { installMiniTouchRouter } from './platform/miniTouch';

// 初始化国际化（从存档恢复语言），保证首个场景就按正确语言渲染
initI18n();

// BGM 单例在游戏启动时就介入：它负责在用户首次手势后补播（浏览器自动播放策略），
// 真正的「开局播放」由 GameScene.create 调用 bgm().startRun() 触发。
// 这里提前 get() 一次，注册手势解锁监听。
bgm();

// Web：阻止长按菜单 / 右键菜单，避免移动端误触打断游戏
if (!IS_MINIGAME && typeof window !== 'undefined') {
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  // 切后台/失焦时立即停掉循环啃食音，避免声音留在后台
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sfx.setEating(false);
  });
  window.addEventListener('blur', () => sfx.setEating(false));
}

// 小游戏：保持常亮，避免玩家思考时息屏
keepScreenOn();

const screen = getScreenSize();
// 小游戏用物理像素做画布缓冲区，文字/线条才清晰；上限 2 倍兼顾低端机性能
const renderScale = IS_MINIGAME ? Math.min(2, getPixelRatio()) : 1;
const gameWidth = IS_MINIGAME ? Math.round(screen.width * renderScale) : GAME_WIDTH;
const gameHeight = IS_MINIGAME ? Math.round(screen.height * renderScale) : GAME_HEIGHT;

// 小游戏没有 DOM，adapter 会预先创建主 Canvas 并挂到 GameGlobal.canvas
const mainCanvas = IS_MINIGAME
  ? ((globalThis as unknown as {
      canvas?: HTMLCanvasElement;
      __WX_ADAPTER__?: { canvas?: HTMLCanvasElement };
    }).canvas ??
    (globalThis as unknown as { __WX_ADAPTER__?: { canvas?: HTMLCanvasElement } })
      .__WX_ADAPTER__?.canvas)
  : undefined;

/**
 * 小游戏环境必须显式指定渲染器。
 *
 * Phaser 在「没有完整 DOM 的自定义环境」里会拒绝 AUTO，直接抛
 * `Must set explicit renderType in custom environment`。
 * 这里先用一张离屏 canvas 探测 WebGL，成功就用 WEBGL，否则退回 CANVAS。
 */
function isHarmonyOS(): boolean {
  try {
    const wxApi = (globalThis as unknown as {
      wx?: { getSystemInfoSync?: () => { system?: string; platform?: string } };
    }).wx;
    const info = wxApi?.getSystemInfoSync?.();
    const system = String(info?.system ?? '').toLowerCase();
    const platform = String(info?.platform ?? '').toLowerCase();
    return (
      system.includes('harmony') ||
      system.includes('openharmony') ||
      platform.includes('harmony') ||
      platform === 'ohos'
    );
  } catch {
    return false;
  }
}

function resolveMiniRenderType(): number {
  try {
    // HarmonyOS 的 WebGL 实现不完整，Phaser WebGL 初始化会直接黑屏/报错，
    // 统一走 Canvas 渲染器；其余平台继续探测 WebGL。
    if (isHarmonyOS()) return Phaser.CANVAS;
    const wxApi = (globalThis as unknown as { wx?: { createCanvas?: () => HTMLCanvasElement } }).wx;
    const probe = wxApi?.createCanvas?.();
    if (!probe) return Phaser.CANVAS;
    const gl =
      (probe.getContext('webgl') as WebGLRenderingContext | null) ||
      (probe.getContext('experimental-webgl') as WebGLRenderingContext | null);
    return gl ? Phaser.WEBGL : Phaser.CANVAS;
  } catch {
    return Phaser.CANVAS;
  }
}

function installMiniErrorLogger(): void {
  if (!IS_MINIGAME) return;
  const wxApi = (globalThis as unknown as {
    wx?: {
      onError?: (cb: (err: { message?: string }) => void) => void;
      onUnhandledRejection?: (cb: (e: { reason?: unknown }) => void) => void;
    };
  }).wx;
  if (!wxApi) return;
  // 只写控制台，不弹“游戏启动异常”打断玩家。
  // 广告、音频、网络等非致命错误不应阻塞游戏。
  try {
    wxApi.onError?.((err) => {
      console.error('[wx error]', err?.message ?? err);
    });
    wxApi.onUnhandledRejection?.((e) => {
      console.error('[wx unhandled rejection]', e?.reason ?? e);
    });
  } catch {
    /* 旧基础库不支持时忽略 */
  }
}
installMiniErrorLogger();

const renderType = IS_MINIGAME ? resolveMiniRenderType() : Phaser.AUTO;

const config: Phaser.Types.Core.GameConfig = {
  type: renderType,
  ...(mainCanvas ? { canvas: mainCanvas } : { parent: 'game-root' }),
  width: gameWidth,
  height: gameHeight,
  backgroundColor: COLORS.bg,
  pixelArt: false,
  antialias: true,
  ...(IS_MINIGAME ? { audio: { noAudio: true } } : {}),
  // 小游戏没有可用的 XHR/Blob：Phaser 默认把图片当 blob 下载，会永远卡在 loading。
  // 改为直接走 Image 元素（wx.createImage）加载本地包内路径。
  ...(IS_MINIGAME ? { loader: { imageLoadType: 'HTMLImageElement' } } : {}),
  scale: IS_MINIGAME
    ? {
        mode: Phaser.Scale.NONE,
        autoCenter: Phaser.Scale.NO_CENTER,
        width: gameWidth,
        height: gameHeight
      }
    : {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: GAME_WIDTH,
        height: GAME_HEIGHT
      },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false
    }
  },
  input: {
    // 手机需要同时识别「按住啃食 + 另一根手指滑动」，默认 2 个指针不够
    activePointers: 4
  },
  scene: [
    BootScene,
    GameScene,
    PauseScene,
    ShopScene,
    SettingsScene,
    ResultScene
  ]
};

const game = new Phaser.Game(config);
if (IS_MINIGAME) {
  // 微信/鸿蒙部分基础库的 canvas 触摸桥接不稳定；UI 点击改走原生触摸路由
  installMiniTouchRouter(game);
}

// 诊断入口：线上排查时可在控制台/vConsole 里读取场景/纹理状态。
// 单机游戏，暴露 game 实例不会影响公平性；自动化测试也依赖它。
(globalThis as unknown as { __GAME__?: Phaser.Game }).__GAME__ = game;

// Web 首屏加载层：游戏启动后淡出，避免玩家看到长时间白屏/黑屏
if (!IS_MINIGAME && typeof document !== 'undefined') {
  const splash = document.getElementById('boot-splash');
  const hideSplash = () => {
    if (!splash || splash.classList.contains('hide')) return;
    splash.classList.add('hide');
    window.setTimeout(() => splash.remove(), 500);
  };
  game.events.once(Phaser.Core.Events.READY, () => window.setTimeout(hideSplash, 350));
  // 兜底：任何异常导致 ready 不触发时，最多 8 秒也把加载层收掉
  window.setTimeout(hideSplash, 8000);
}

// 把存档中的主音量应用到声音管理器（Web 后续加入音效时自动遵守）
if (!IS_MINIGAME) {
  applyVolume(game);
  // 音效调度器接管 Phaser 声音管理器：之后任意位置调用 sfx.play(id) 即可，
  // 各音效自身音量与主音量（game.sound.volume）自动乘算。
  sfx.init(game.sound);
} else {
  // 小游戏没有 Phaser 音频通道，改用 InnerAudioContext 池
  sfx.initMiniGame();
}

// 调试入口：控制台可检查啃食循环状态（不参与游戏逻辑）
(globalThis as unknown as { __SFX__?: typeof sfx }).__SFX__ = sfx;
(globalThis as unknown as { __ROLL_DROPS__?: typeof rollPlantDrops }).__ROLL_DROPS__ = rollPlantDrops;

// 广告平台初始化（没有广告位时全部降级为不可用）
ads.init();

// 小游戏：打开右上角转发菜单，并配置默认分享卡片
if (IS_MINIGAME) {
  const api = (globalThis as unknown as {
    wx?: {
      showShareMenu?: (o: { withShareTicket?: boolean; menus?: string[] }) => void;
      onShareAppMessage?: (cb: () => { title: string; imageUrl?: string; query?: string }) => void;
      onHide?: (cb: () => void) => void;
      onShow?: (cb: () => void) => void;
      onAudioInterruptionBegin?: (cb: () => void) => void;
      onAudioInterruptionEnd?: (cb: () => void) => void;
      setInnerAudioOption?: (opts: { obeyMuteSwitch?: boolean; mixWithOther?: boolean }) => void;
    };
  }).wx;
  try {
    api?.showShareMenu?.({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    api?.onShareAppMessage?.(() => ({
      title: t('boot.title'),
      imageUrl: 'assets/cover-share.png',
      query: 'from=menu'
    }));

    // 游戏音效不应跟随手机静音键（否则很多玩家会以为游戏没声音）
    api?.setInnerAudioOption?.({ obeyMuteSwitch: false, mixWithOther: true });

    // 切后台 / 来电时暂停 BGM，回来再续播，避免「后台还在响」或恢复后没声音。
    // 广告播放期间也会触发 onHide/onShow，此时不能把 BGM 恢复到广告背后。
    api?.onHide?.(() => {
      sfx.setEating(false);
      bgm().suspendForAd();
    });
    api?.onShow?.(() => {
      if (!ads.isShowingAd()) bgm().resumeFromAd();
    });
    api?.onAudioInterruptionBegin?.(() => {
      sfx.setEating(false);
      bgm().suspendForAd();
    });
    api?.onAudioInterruptionEnd?.(() => {
      if (!ads.isShowingAd()) bgm().resumeFromAd();
    });
  } catch {
    /* 分享/生命周期能力缺失不影响游戏 */
  }
}

// 开发调试钩子：便于在控制台 / 自动化测试中访问游戏实例。
// 生产构建时会被 tree-shake 掉（import.meta.env.DEV 为 false）。
if (import.meta.env.DEV) {
  (window as unknown as { __GAME__: Phaser.Game }).__GAME__ = game;
  (window as unknown as { __PLATFORM__: string }).__PLATFORM__ = PLATFORM;

  // 压力测试：仅在开发环境且 URL 带 ?stress=1 时按需加载。
  // 动态 import + DEV 判断双重保证该模块不会进入生产包。
  if (new URLSearchParams(window.location.search).get('stress') === '1') {
    import('./dev/stressTest')
      .then((m) => m.installStressTest(game))
      .catch((err) => console.error('[main] 压力测试脚本加载失败:', err));
  }
}
