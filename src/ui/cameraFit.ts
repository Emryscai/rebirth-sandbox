/**
 * 相机适配：保证 640×640 的设计稿在任何屏幕上完整可见。
 *
 * - Web：Phaser Scale.FIT 已经把 640 画布等比缩放到窗口，zoom 恒为 1。
 * - 微信/抖音小游戏：Canvas 就是整块屏幕，没有 CSS 缩放；
 *   这里把游戏尺寸设为「屏幕物理像素」，再用相机 zoom 把 640×640
 *   的设计区域居中显示，四周留出的空间由相机背景色填充。
 *
 * 输入坐标由 Phaser 自动按相机反算，因此点击/滑动判定不需要额外换算。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, COLORS } from '../config';

/**
 * @param opaque 是否给相机设置不透明背景。
 *   覆盖层（暂停/商店/设置）必须传 false，否则相机会盖住下层游戏画面，
 *   暂停菜单会变成一块纯黑背景。
 */
export function fitSceneCamera(scene: Phaser.Scene, opaque = true): void {
  const cam = scene.cameras.main;
  const sw = scene.scale.width;
  const sh = scene.scale.height;
  if (!sw || !sh) return;

  const zoom = Math.min(sw / GAME_WIDTH, sh / GAME_HEIGHT);
  cam.setZoom(zoom);
  // camera.worldView 会额外加上 (viewport - displaySize)/2，
  // 因此要让它从设计区左上角开始：scroll = (设计宽 - 屏幕宽)/2。
  // 这样 640×GAME_HEIGHT 的设计区才真正居中。
  cam.setScroll(
    (GAME_WIDTH - sw) / 2,
    (GAME_HEIGHT - sh) / 2
  );

  if (opaque) {
    cam.setBackgroundColor(COLORS.bg);
  } else {
    cam.transparent = true;
  }
}

/**
 * 绑定一次相机适配，并在窗口尺寸变化（横竖屏切换）时重新计算。
 *
 * 返回取消函数（场景 shutdown 时自动清理，无需调用方关心）。
 */
export function installCameraFit(scene: Phaser.Scene, opaque = true): () => void {
  fitSceneCamera(scene, opaque);

  const onResize = () => fitSceneCamera(scene, opaque);
  scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);

  const off = () => {
    scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
  return off;
}
