import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, BOARD_TOP } from '../config';
import { t } from '../i18n';

/**
 * 首次进入的轻量操作提示。
 *
 * 不再用全屏黑幕和大卡片：提示只占顶部 HUD 的空白区域，
 * 棋盘和战斗效果始终可见；游戏也不会暂停。点「开始」或
 * 8 秒后自动收起，之后正常操作。
 */
export class TutorialPanel {
  private container: Phaser.GameObjects.Container;
  private scene: Phaser.Scene;
  private destroyed = false;
  private startHandler?: (pointer: Phaser.Input.Pointer) => void;
  private autoHide?: Phaser.Time.TimerEvent;
  private startRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(scene: Phaser.Scene, onStart: () => void) {
    this.scene = scene;

    const panelW = 600;
    const panelH = 126;
    const cx = GAME_WIDTH / 2;
    // 优先放在棋盘下方、控制按钮上方的空白区，完全不挡棋盘和 HUD；
    // 方形/矮屏没有这块空间时退回顶部 HUD 空白区。
    const bottomY = BOARD_TOP + 640 + 78;
    const cy =
      bottomY + panelH / 2 < GAME_HEIGHT - 170
        ? bottomY
        : Math.max(96, Math.min(BOARD_TOP - panelH / 2 - 14, 226));

    this.container = scene.add.container(0, 0);
    this.container.setDepth(3000);
    this.container.setScrollFactor(0);

    const g = scene.add.graphics();
    g.fillStyle(0x120d18, 0.94);
    g.fillRoundedRect(cx - panelW / 2, cy - panelH / 2, panelW, panelH, 18);
    g.lineStyle(2, 0x6d5680, 0.95);
    g.strokeRoundedRect(cx - panelW / 2, cy - panelH / 2, panelW, panelH, 18);
    g.lineStyle(3, 0x4fd1c5, 0.35);
    g.beginPath();
    g.moveTo(cx - panelW / 2 + 32, cy - panelH / 2 + 2);
    g.lineTo(cx + panelW / 2 - 32, cy - panelH / 2 + 2);
    g.strokePath();
    this.container.add(g);

    const title = scene.add
      .text(cx - panelW / 2 + 28, cy - 38, t('tutorial.title'), {
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '28px',
        color: '#ffffff',
        stroke: '#05070d',
        strokeThickness: 4
      })
      .setOrigin(0, 0.5);
    this.container.add(title);

    const move = scene.add
      .text(cx - panelW / 2 + 28, cy + 2, t('tutorial.move'), {
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '19px',
        color: '#c9d8e6'
      })
      .setOrigin(0, 0.5);
    this.container.add(move);

    const eat = scene.add
      .text(cx - panelW / 2 + 28, cy + 30, t('tutorial.eat'), {
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '19px',
        color: '#ffe6a3'
      })
      .setOrigin(0, 0.5);
    this.container.add(eat);

    const surface = scene.add
      .text(cx - panelW / 2 + 28, cy + 57, t('tutorial.survive'), {
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '16px',
        color: '#8fb3c9'
      })
      .setOrigin(0, 0.5);
    this.container.add(surface);

    const btnW = 150;
    const btnH = 48;
    const btnX = cx + panelW / 2 - 20 - btnW / 2;
    const btnY = cy + 34;
    this.startRect = { x: btnX, y: btnY, w: btnW, h: btnH };
    const btnBg = scene.add.graphics();
    btnBg.fillStyle(0x5d7d2b, 1);
    btnBg.fillRoundedRect(btnX - btnW / 2, btnY - btnH / 2, btnW, btnH, 12);
    btnBg.lineStyle(2, 0x9ad31a, 1);
    btnBg.strokeRoundedRect(btnX - btnW / 2, btnY - btnH / 2, btnW, btnH, 12);
    this.container.add(btnBg);

    const btnText = scene.add
      .text(btnX, btnY, t('tutorial.start'), {
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '23px',
        color: '#ffffff',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    this.container.add(btnText);

    const hit = scene.add
      .rectangle(btnX, btnY, btnW + 24, btnH + 18, 0x000000, 0.001)
      .setInteractive({ useHandCursor: true });
    this.container.add(hit);

    const start = () => {
      if (this.destroyed) return;
      this.destroy();
      onStart();
    };
    hit.on('pointerdown', start);
    btnText.setInteractive({ useHandCursor: true }).on('pointerdown', start);

    // 输入命中偶发偏移时的兜底：按设计坐标判断是否点在按钮矩形内
    this.startHandler = (pointer: Phaser.Input.Pointer) => {
      const x = pointer.worldX;
      const y = pointer.worldY;
      if (
        x >= btnX - btnW / 2 - 12 &&
        x <= btnX + btnW / 2 + 12 &&
        y >= btnY - btnH / 2 - 9 &&
        y <= btnY + btnH / 2 + 9
      ) {
        start();
      }
    };
    scene.input.on('pointerdown', this.startHandler);

    // 不暂停游戏；最多显示 8 秒，避免长期挡视线
    this.autoHide = scene.time.delayedCall(8000, start);
  }

  /** 设计坐标是否落在开始按钮内（小游戏 wx 触摸兜底用） */
  containsStart(x: number, y: number): boolean {
    const r = this.startRect;
    return (
      x >= r.x - r.w / 2 - 12 &&
      x <= r.x + r.w / 2 + 12 &&
      y >= r.y - r.h / 2 - 9 &&
      y <= r.y + r.h / 2 + 9
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.autoHide?.remove(false);
    this.autoHide = undefined;
    if (this.startHandler) {
      this.scene.input.off('pointerdown', this.startHandler);
      this.startHandler = undefined;
    }
    this.container.destroy(true);
  }
}
