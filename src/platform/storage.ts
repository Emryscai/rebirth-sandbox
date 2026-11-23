/**
 * 平台存储收口。
 * 所有持久化访问必须经过本文件，其他模块不得直接调用。
 *
 * Web 使用 localStorage；微信/抖音小游戏使用 wx/tt 的同步存储。
 * 任一平台写入失败都静默降级，绝不影响游戏主循环。
 */

import { STORAGE_KEYS } from '../config';
import { IS_MINIGAME, PLATFORM } from './env';

/** 用户设置（语言 / 音量 / 震动等），统一收口在这份快照里 */
export interface Settings {
  /** 界面语言 */
  language: 'zh' | 'en';
  /** 主音量 0~1 */
  volume: number;
  /** 触感反馈（移动端） */
  haptics: boolean;
}

/** 设置默认值 */
const DEFAULT_SETTINGS: Settings = {
  language: 'zh',
  volume: 0.7,
  haptics: true
};

interface MiniStorage {
  getStorageSync?: (key: string) => unknown;
  setStorageSync?: (key: string, value: string) => void;
  removeStorageSync?: (key: string) => void;
}

function miniApi(): MiniStorage | undefined {
  if (!IS_MINIGAME) return undefined;
  const g = globalThis as unknown as { wx?: MiniStorage; tt?: MiniStorage };
  return PLATFORM === 'wx' ? g.wx : g.tt;
}

function safeGet(key: string): string | null {
  try {
    const api = miniApi();
    if (api?.getStorageSync) {
      const v = api.getStorageSync(key);
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
    return globalThis.localStorage.getItem(key);
  } catch {
    // 隐私模式或环境不支持时静默降级
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    const api = miniApi();
    if (api?.setStorageSync) {
      api.setStorageSync(key, value);
      return;
    }
    globalThis.localStorage.setItem(key, value);
  } catch {
    // 写入失败不影响游戏运行
  }
}

function safeRemove(key: string): void {
  try {
    const api = miniApi();
    if (api?.removeStorageSync) {
      api.removeStorageSync(key);
      return;
    }
    globalThis.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** 读取最高存活时间（毫秒），无记录返回 0 */
export function loadBestTime(): number {
  const raw = safeGet(STORAGE_KEYS.bestTime);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 写入最高存活时间（毫秒），仅当更优时更新。返回是否刷新纪录 */
export function saveBestTime(ms: number): boolean {
  const prev = loadBestTime();
  if (ms <= prev) return false;
  safeSet(STORAGE_KEYS.bestTime, String(Math.floor(ms)));
  return true;
}

/** 清空最高纪录（调试用） */
export function clearBestTime(): void {
  safeSet(STORAGE_KEYS.bestTime, '0');
}

/** 读取用户设置（损坏/缺失时回退默认值，字段做类型与范围校验） */
export function loadSettings(): Settings {
  const raw = safeGet(STORAGE_KEYS.settings);
  if (!raw) {
    // 首次启动按系统语言选中文/英文；之后以玩家在设置里的选择为准
    let language: Settings['language'] = DEFAULT_SETTINGS.language;
    try {
      const lang = (globalThis.navigator?.language || '').toLowerCase();
      if (lang && !lang.startsWith('zh')) language = 'en';
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_SETTINGS, language };
  }
  try {
    const obj = JSON.parse(raw) as Partial<Settings>;
    const language: Settings['language'] = obj.language === 'en' ? 'en' : 'zh';
    const v = Number(obj.volume);
    const volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_SETTINGS.volume;
    const haptics = obj.haptics === false ? false : true;
    return { language, volume, haptics };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写入用户设置（失败静默） */
export function saveSettings(s: Settings): void {
  try {
    safeSet(
      STORAGE_KEYS.settings,
      JSON.stringify({
        language: s.language === 'en' ? 'en' : 'zh',
        volume: Math.min(1, Math.max(0, Number(s.volume) || 0)),
        haptics: s.haptics !== false
      })
    );
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------ 广告频控

/** 广告频控状态（持久化，避免每次启动都重置） */
export interface AdState {
  /** 累计开局数（用于「每 N 局一次插屏」） */
  runs: number;
  /** 上次插屏时间戳（毫秒） */
  lastInterstitialAt: number;
  /** 累计成功看完的激励视频数（运营数据） */
  rewardedCount: number;
}

const DEFAULT_AD_STATE: AdState = { runs: 0, lastInterstitialAt: 0, rewardedCount: 0 };

export function loadAdState(): AdState {
  const raw = safeGet(STORAGE_KEYS.ads);
  if (!raw) return { ...DEFAULT_AD_STATE };
  try {
    const obj = JSON.parse(raw) as Partial<AdState>;
    const runs = Number(obj.runs);
    const last = Number(obj.lastInterstitialAt);
    const rewarded = Number(obj.rewardedCount);
    return {
      runs: Number.isFinite(runs) && runs >= 0 ? Math.floor(runs) : 0,
      lastInterstitialAt: Number.isFinite(last) && last >= 0 ? Math.floor(last) : 0,
      rewardedCount: Number.isFinite(rewarded) && rewarded >= 0 ? Math.floor(rewarded) : 0
    };
  } catch {
    return { ...DEFAULT_AD_STATE };
  }
}

export function saveAdState(s: AdState): void {
  try {
    safeSet(
      STORAGE_KEYS.ads,
      JSON.stringify({
        runs: Math.max(0, Math.floor(Number(s.runs) || 0)),
        lastInterstitialAt: Math.max(0, Math.floor(Number(s.lastInterstitialAt) || 0)),
        rewardedCount: Math.max(0, Math.floor(Number(s.rewardedCount) || 0))
      })
    );
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ 新手引导

/** 新手引导是否已看 */
export function hasSeenTutorial(): boolean {
  return safeGet(STORAGE_KEYS.tutorial) === '1';
}

/** 标记新手引导已看 */
export function markTutorialSeen(): void {
  safeSet(STORAGE_KEYS.tutorial, '1');
}

/** 重置新手引导（调试 / 设置里「重看操作说明」） */
export function resetTutorial(): void {
  safeRemove(STORAGE_KEYS.tutorial);
}

// ------------------------------------------------------------ 排行榜框架

/** 排行榜条目；云开发/HTTP 接入后可直接复用 */
export interface LeaderboardEntry {
  /** 展示名；本机榜固定为「我」 */
  name: string;
  /** 存活时间（毫秒） */
  timeMs: number;
  /** 记录写入时间（可选） */
  at?: number;
  /** 头像 URL（好友榜/全服榜使用） */
  avatarUrl?: string;
  /** 是否当前玩家 */
  isMe?: boolean;
}

const LOCAL_LEADERBOARD_MAX = 10;

/** 读取本机 Top10；解析失败返回空数组 */
export function loadLocalLeaderboard(): LeaderboardEntry[] {
  const raw = safeGet(STORAGE_KEYS.leaderboard);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (it): it is LeaderboardEntry =>
          !!it &&
          typeof (it as LeaderboardEntry).name === 'string' &&
          Number.isFinite((it as LeaderboardEntry).timeMs)
      )
      .map((it) => ({
        name: String(it.name).slice(0, 20),
        timeMs: Math.max(0, Math.floor(it.timeMs)),
        at: Number.isFinite(it.at) ? Number(it.at) : undefined,
        isMe: it.name === '我'
      }))
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, LOCAL_LEADERBOARD_MAX);
  } catch {
    return [];
  }
}

/** 记录本机最佳成绩；同名只保留最高纪录，返回最新 Top10 */
export function recordLocalScore(
  timeMs: number,
  name = '我'
): LeaderboardEntry[] {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return loadLocalLeaderboard();
  const current = loadLocalLeaderboard();
  const score = Math.floor(timeMs);
  const existing = current.find((it) => it.name === name);
  if (existing && existing.timeMs >= score) return current;

  const next = current.filter((it) => it.name !== name);
  next.push({ name: name.slice(0, 20), timeMs: score, at: Date.now(), isMe: true });
  next.sort((a, b) => b.timeMs - a.timeMs);
  const top = next.slice(0, LOCAL_LEADERBOARD_MAX);
  try {
    safeSet(STORAGE_KEYS.leaderboard, JSON.stringify(top));
  } catch {
    /* 写入失败不影响游戏 */
  }
  return top;
}
