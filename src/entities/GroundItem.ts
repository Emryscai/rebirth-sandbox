/**
 * 地面道具（掉落物）。
 *
 * 表现：一个非常小的方块图标（约植物一半大小），
 *  - 轻微上下浮动，便于在草地上被注意到；
 *  - 存在 15 秒后自动淡出消失；
 *  - 玩家靠近即拾取（拾取判定由 ItemSystem 统一做，本类只管显示与寿命）。
 *
 * 设计上不挂物理体：道具不是障碍物，玩家也不该被它挡住。
 * 用纯像素距离判定拾取，逻辑更稳、也更容易调。
 */

import Phaser from 'phaser';
import { ITEM } from '../config';
import type { ItemId } from '../data/items';
import { ITEMS } from '../data/items';

export class GroundItem extends Phaser.GameObjects.Container {
  readonly itemId: ItemId;

  /** 剩余存活时间（毫秒） */
  private life = ITEM.groundLifetimeMs;

  /** 浮动动画时钟 */
  private t = 0;

  /** 图标本体（用于浮动） */
  private readonly icon: Phaser.GameObjects.Image;

  /** 是否已被拾取/过期（外部据此移除） */
  private consumed = false;

  constructor(scene: Phaser.Scene, x: number, y: number, itemId: ItemId) {
    super(scene, x, y);
    this.itemId = itemId;

    const def = ITEMS[itemId];
    const size = ITEM.groundIconSize;

    // 底板：深色圆角方块 + 道具主题色描边，保证在任何草地上都能看清
    const base = scene.add.graphics();
    base.fillStyle(0x0b0f14, 0.85);
    base.fillRoundedRect(-size / 2 - 2, -size / 2 - 2, size + 4, size + 4, 6);
    base.lineStyle(2, def.accent, 0.95);
    base.strokeRoundedRect(-size / 2 - 2, -size / 2 - 2, size + 4, size + 4, 6);

    // 图标：等比缩放到方块内
    const key = def.textureKey;
    this.icon = scene.add.image(0, 0, key);
    const tex = scene.textures.exists(key)
      ? (scene.textures.get(key).getSourceImage() as { width: number; height: number })
      : null;
    if (tex && tex.width > 0 && tex.height > 0) {
      const k = Math.min(size / tex.width, size / tex.height);
      this.icon.setDisplaySize(tex.width * k, tex.height * k);
    } else {
      this.icon.setDisplaySize(size, size);
    }

    this.add([base, this.icon]);
    this.setDepth(15);

    // 出生：从地面弹起
    this.setScale(0.3);
    scene.tweens.add({
      targets: this,
      scale: 1,
      duration: 240,
      ease: 'Back.easeOut'
    });

    scene.add.existing(this);
  }

  /** 每帧：浮动 + 临近过期闪烁 */
  update(delta: number): void {
    if (this.consumed) return;

    this.t += delta;
    this.life -= delta;

    // 上下轻微浮动
    this.icon.y = Math.sin(this.t / 260) * 2.5;

    // 最后 3 秒：闪烁提示即将消失
    if (this.life <= 3000) {
      const blink = (Math.sin(this.t / 90) + 1) / 2;
      this.setAlpha(this.life <= 1200 ? 0.35 + blink * 0.5 : 0.7 + blink * 0.3);
    }

    if (this.life <= 0) {
      this.fadeOutAndDestroy();
    }
  }

  /** 剩余寿命（毫秒） */
  get remainingMs(): number {
    return Math.max(0, this.life);
  }

  /** 是否已被消费 */
  get isConsumed(): boolean {
    return this.consumed;
  }

  /** 标记为已拾取并播放拾取动画后销毁 */
  pickup(): void {
    if (this.consumed) return;
    this.consumed = true;

    if (!this.scene) {
      this.destroy();
      return;
    }
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      scale: 1.6,
      alpha: 0,
      duration: 160,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (this.active) this.destroy();
      }
    });
  }

  private fadeOutAndDestroy(): void {
    if (this.consumed) return;
    this.consumed = true;
    if (!this.scene) {
      this.destroy();
      return;
    }
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 220,
      onComplete: () => {
        if (this.active) this.destroy();
      }
    });
  }

  /** 安全销毁：清理所有 tween，防止回调作用在已销毁对象上 */
  safeDestroy(): void {
    this.scene?.tweens.killTweensOf(this);
    if (this.active) this.destroy();
  }
}
