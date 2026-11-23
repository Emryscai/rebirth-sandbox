/**
 * 素材路径的平台适配。
 *
 * 微信小游戏没有 DOMParser / Blob URL，Phaser 的 load.svg 无法工作；
 * 构建小游戏包时会把少量 SVG（子弹、地砖、冷雾苔）预先栅格化成同名 PNG，
 * 运行时只需把 .svg 后缀换成 .png。
 *
 * Web 端继续使用矢量 SVG（体积小、任意分辨率清晰），不受影响。
 */

import { IS_MINIGAME } from './env';

/** 当前平台真正要加载的素材路径 */
export function runtimeAssetPath(path: string): string {
  if (IS_MINIGAME && /\.svg$/i.test(path)) {
    return path.replace(/\.svg$/i, '.png');
  }
  return path;
}

/** 该素材是否应该走 Phaser 的 SVG 加载器（仅 Web） */
export function canLoadSvg(): boolean {
  return !IS_MINIGAME;
}
