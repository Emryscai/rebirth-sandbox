/**
 * 排行榜数据层（框架）。
 *
 * 现在可用：
 *   - 本机 Top10（storage.local）
 *
 * 预留：
 *   - 好友 Top10：微信开放数据域（openDataContext）接入后返回
 *   - 全服 Top10：配置 LEADERBOARD.apiBaseUrl 后通过 HTTP 拉取/提交
 *
 * 上架前如果不接后端，好友/全服页会显示「暂未接入」，不影响游戏。
 */

import { LEADERBOARD } from '../config';
import {
  loadLocalLeaderboard,
  type LeaderboardEntry
} from './storage';

export type LeaderboardKind = 'friends' | 'global' | 'local';

export interface LeaderboardData {
  kind: LeaderboardKind;
  entries: LeaderboardEntry[];
  /** 数据源暂未配置/无权限 */
  unavailable?: boolean;
}

interface MiniWx {
  setUserCloudStorage?: (opts: {
    KVDataList: Array<{ key: string; value: string }>;
    success?: () => void;
    fail?: (err: unknown) => void;
  }) => void;
  getOpenDataContext?: () => unknown;
}

function wxApi(): MiniWx | undefined {
  return (globalThis as unknown as { wx?: MiniWx }).wx;
}

/** 本机 Top10（框架内已可用） */
export function getLocalLeaderboard(): LeaderboardData {
  return { kind: 'local', entries: loadLocalLeaderboard() };
}

/**
 * 好友 Top10。
 *
 * 真正接入时在 openDataContext 里调用 wx.getFriendCloudStorage，
 * 把结果绘制到 sharedCanvas；这里保留异步接口，当前返回未接入。
 */
export async function getFriendLeaderboard(): Promise<LeaderboardData> {
  return { kind: 'friends', entries: [], unavailable: true };
}

/** 全服 Top10：未配置 apiBaseUrl 时返回未接入 */
export async function getGlobalLeaderboard(): Promise<LeaderboardData> {
  const base = LEADERBOARD.apiBaseUrl.trim();
  if (!base) return { kind: 'global', entries: [], unavailable: true };

  try {
    const res = await fetch(
      `${base.replace(/\/$/, '')}/top?limit=${LEADERBOARD.maxEntries}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { entries?: unknown }).entries)
        ? (raw as { entries: unknown[] }).entries
        : [];
    const entries = arr
      .map(normalizeEntry)
      .filter((it): it is LeaderboardEntry => it !== null)
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, LEADERBOARD.maxEntries);
    return { kind: 'global', entries };
  } catch (err) {
    console.warn('[leaderboard] global fetch failed', err);
    return { kind: 'global', entries: [], unavailable: true };
  }
}

function normalizeEntry(raw: unknown): LeaderboardEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as {
    name?: unknown;
    nickname?: unknown;
    timeMs?: unknown;
    time?: unknown;
    score?: unknown;
    avatarUrl?: unknown;
  };
  const name = String(it.name ?? it.nickname ?? '').trim().slice(0, 20);
  const timeMs = Number(it.timeMs ?? it.time ?? it.score);
  if (!name || !Number.isFinite(timeMs) || timeMs <= 0) return null;
  return {
    name,
    timeMs: Math.floor(timeMs),
    avatarUrl:
      typeof it.avatarUrl === 'string' && it.avatarUrl
        ? it.avatarUrl
        : undefined
  };
}

/**
 * 每局结束提交成绩。
 *
 * - 微信好友榜：写入 setUserCloudStorage；需要开放数据域读取 bestTime
 * - 全服榜：配置 apiBaseUrl 后 POST /score
 */
export async function submitLeaderboardScore(
  timeMs: number
): Promise<void> {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return;
  const score = Math.floor(timeMs);

  // 微信好友榜：开放数据域约定 key = bestTime
  try {
    wxApi()?.setUserCloudStorage?.({
      KVDataList: [{ key: 'bestTime', value: String(score) }]
    });
  } catch {
    /* 非微信环境/未授权时忽略 */
  }

  const base = LEADERBOARD.apiBaseUrl.trim();
  if (!base) return;
  try {
    await fetch(`${base.replace(/\/$/, '')}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMs: score })
    });
  } catch (err) {
    console.warn('[leaderboard] global submit failed', err);
  }
}
