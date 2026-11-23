/**
 * 壁垒：石墙（硬壳垒）生成时随机铺下的「不可通行」阻挡物。
 *
 * 表现：单个格子内用 3 块缩小到 60% 的小石墙拼成一段壁垒，
 *   - 横排：3 块并排，总宽约 90% 格宽、高约 30% 格高；
 *   - 竖排：3 块上下叠放，总宽约 30% 格宽、高约 90% 格高。
 * 三块之间不留缝隙（首尾相接）。
 *
 * 逻辑：真正阻挡僵尸的是 GridSystem 的 blocked 标记，
 * 本类只负责视觉。生成时由 GameScene 调 GridSystem.setBlocked，
 * 石墙被摧毁时调用 destroy() 并解除封锁。
 */

import Phaser from 'phaser';
import { ASSET_KEYS, TILE_SIZE } from '../config';

export type BarrierOrientation = 'h' | 'v';

export class Barrier {
  private scene: Phaser.Scene;
  private parts: Phaser.GameObjects.Image[] = [];
  /** 本壁垒封锁的格子（销毁时据此解除封锁） */
  readonly cellCol: number;
  readonly cellRow: number;

  constructor(
    scene: Phaser.Scene,
    col: number,
    row: number,
    orientation: BarrierOrientation,
    centerX: number,
    centerY: number
  ) {
    this.scene = scene;
    this.cellCol = col;
    this.cellRow = row;

    // 每块小石墙占格子的 30%（3 块首尾相接 = 90%，居中即跨度 90%）。
    // 「缩小 60%」体现在：单块宽高都是格子的 30%，而石墙整图约 0.75 格宽，
    // 相当于石墙立绘再缩到约 0.4 倍；这里直接按格子的目标跨度摆放，
    // 保证三块之间严丝合缝、无缝隙。
    const slotW = TILE_SIZE * 0.3;
    const slotH = TILE_SIZE * 0.3;

    // 三块的排布：横排沿 x 依次偏移，竖排沿 y 依次偏移。
    // 总跨度 90% 格宽/高，以格心为中心。
    const span = TILE_SIZE * 0.9;
    const startOffset = -span / 2 + slotW / 2; // 第一块的中心相对格心偏移

    for (let i = 0; i < 3; i++) {
      let x = centerX;
      let y = centerY;
      if (orientation === 'h') {
        x = centerX + startOffset + i * slotW;
      } else {
        y = centerY + startOffset + i * slotH;
      }

      const img = this.scene.add.image(x, y, ASSET_KEYS.plantWall);
      img.setDepth(9); // 略低于植物(10)，作为地面障碍
      // 用 setDisplaySize 把整块石墙贴图压到目标槽位尺寸。
      // 横向/纵向都用同一套 slotW×slotH，因此「高度也一起缩小」，
      // 不会出现横放却仍占满整格高度的情况。
      img.setDisplaySize(slotW, slotH);

      // 出生弹出动画（轻微）：先记下归一化后的目标 scale，
      // 从 40% 弹回 100%。不能用 config.scale（贴图已被 setDisplaySize 改写）。
      const targetScaleX = img.scaleX;
      const targetScaleY = img.scaleY;
      img.setScale(targetScaleX * 0.4, targetScaleY * 0.4);
      this.scene.tweens.add({
        targets: img,
        scaleX: targetScaleX,
        scaleY: targetScaleY,
        duration: 180,
        ease: 'Back.easeOut'
      });

      this.parts.push(img);
    }
  }

  /** 销毁所有视觉体（解除封锁由调用方负责） */
  destroy(): void {
    for (const p of this.parts) {
      if (p && p.active) {
        this.scene.tweens.killTweensOf(p);
        p.destroy();
      }
    }
    this.parts.length = 0;
  }
}
