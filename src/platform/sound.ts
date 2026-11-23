/**
 * 音频（音量）控制收口。
 *
 * 本项目目前没有音效/BGM 资源，但需要一个「主音量」设置项，
 * 便于之后加入音效时立即全局限幅。这里把音量状态与 Phaser 的
 * SoundManager 绑定：设置页改变音量时，调用 applyVolume(game) 即可。
 *
 * 音量持久化在 settings（与语言同一份快照）。
 */

import Phaser from 'phaser';
import { loadSettings, saveSettings } from './storage';

/** 读取当前主音量（0~1） */
export function getVolume(): number {
  return loadSettings().volume;
}

/** 写入主音量并持久化（不触碰 Phaser，纯状态） */
export function setVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, Number(volume) || 0));
  const s = loadSettings();
  saveSettings({ ...s, volume: v });
}

/** 把当前音量应用到某个 Phaser.Game 的声音管理器（启动时/改音量时调用） */
export function applyVolume(game: Phaser.Game): void {
  if (!game || !game.sound) return;
  try {
    game.sound.volume = getVolume();
  } catch {
    /* 音频上下文未就绪时忽略 */
  }
}
