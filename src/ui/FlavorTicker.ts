/**
 * FlavorTicker —— 屏幕最上方的一行「风味文本」跑马灯。
 *
 * 用途：拾取/购买道具时，用一行小字展示该道具的黑色幽默风味文案，
 * 以「从左向右缓慢滚动」的形式呈现，不打断操作、不遮挡战场。
 *
 * 实现：
 *   - 一个固定宽度的容器作为遮罩裁剪区（用 mask），内部放一段 Text；
 *   - 文本从右边缘进入，匀速向左滚出，滚完自动隐藏；
 *   - 再次展示时重置位置与内容（后到者覆盖先到者，避免排队堆积）。
 *
 * 为什么放最顶：HUD 的存活/血量面板在左中段，道具栏在右下，
 * 顶端这一条基本是空的，用来做氛围文案最不打扰。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, BOARD_TOP } from '../config';

export class FlavorTicker {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private text: Phaser.GameObjects.Text;
  private maskShape: Phaser.GameObjects.Graphics;
  private tween?: Phaser.Tweens.Tween;
  private destroyed = false;

  /** 高度（像素） */
  private readonly h = 28;
  /** 滚动速度（像素/秒） */
  private readonly speed = 46;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    // 竖屏布局下顶部是品牌区，跑马灯贴到棋盘上沿；桌面端仍在最顶部
    // 放在品牌标题下方、HUD 数据面板上方的窄条里，不压血条/尸币
    // 屏幕最顶部的独立窄条：在品牌标题上方，不压 HUD 数据
    const y = 8;
    this.container = scene.add.container(0, y).setDepth(103);

    // 顶部暗条，保证文字在任何背景上可读
    const bar = scene.add.graphics();
    bar.fillStyle(0x05080d, 0.72);
    bar.fillRect(0, 0, GAME_WIDTH, this.h);
    this.container.add(bar);

    this.text = scene.add
      .text(GAME_WIDTH, this.h / 2, '', {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '17px',
        color: '#cfd8e3',
        fontStyle: 'italic'
      })
      .setOrigin(0, 0.5);
    this.container.add(this.text);

    // 用几何遮罩把文字裁在 [0, GAME_WIDTH] 内，防止溢出到屏幕外
    this.maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    this.maskShape.fillStyle(0xffffff, 1);
    this.maskShape.fillRect(0, y, GAME_WIDTH, this.h);
    // 不用 GeometryMask：相机 zoom≠1 时遮罩不跟随相机，会把整条跑马灯裁没。
    // Canvas 本身会裁掉屏幕外内容，这里保留 maskShape 仅作兼容清理。

    this.container.setVisible(false);
  }

  /**
   * 展示一条风味文本。
   *
   * @param msg 文案（建议单行）
   * @param color 文字颜色
   */
  show(msg: string, color = '#cfd8e3', speed = this.speed): void {
    if (this.destroyed || !this.scene) return;
    if (!msg) {
      this.hide();
      return;
    }

    // 覆盖上一条：停掉旧动画、重置内容与位置
    this.tween?.remove();
    this.tween = undefined;

    this.text.setText(msg).setColor(color);
    this.text.x = GAME_WIDTH;
    this.container.setVisible(true);
    this.text.setAlpha(1);

    // 文本宽度 + 屏幕宽度 = 需要滚动的总距离，保证完全滚出后才结束
    const distance = GAME_WIDTH + this.text.width;
    const duration = (distance / Math.max(1, speed)) * 1000;

    this.tween = this.scene.tweens.add({
      targets: this.text,
      x: -this.text.width,
      duration,
      ease: 'Linear',
      onComplete: () => {
        this.tween = undefined;
        this.hide();
      }
    });
  }

  /** 隐藏 */
  hide(): void {
    if (this.destroyed) return;
    this.tween?.remove();
    this.tween = undefined;
    this.container.setVisible(false);
  }

  /** 销毁 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tween?.remove();
    this.tween = undefined;
    try {
      this.text?.clearMask();
    } catch {
      /* 忽略 */
    }
    this.maskShape?.destroy();
    this.container?.destroy(true);
  }
}
