/**
 * 死亡后的「看广告复活」面板。
 *
 * 为什么做成 GameScene 内的 UI，而不是独立 Scene：
 *   - 独立 Scene 需要 pause GameScene，再处理启动顺序/输入穿透，
 *     在 Phaser 3.90 下容易踩到场景队列的时序坑；
 *   - 本面板只需要叠在已经停止逻辑的 GameScene 上（alive=false），
 *     不需要冻结任何东西，输入也天然只落在面板按钮上；
 *   - 复活时直接恢复 GameScene 状态，不需要 resume/重启，最稳。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, BOARD_TOP, COLORS } from '../config';
import { t, tf } from '../i18n';
import { ads } from '../platform/ads';
import { bgm } from '../platform/bgm';
import { sfx } from '../platform/sfx';
import { formatTime } from '../utils';
import { REVIVE_HP_RATIO } from '../data/ads';
import type { ResultData } from '../scenes/ResultScene';

const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

export class RevivePanel {
  private scene: Phaser.Scene;
  private objects: Phaser.GameObjects.GameObject[] = [];
  private busy = false;
  private closed = false;
  private adLabel?: Phaser.GameObjects.Text;
  private toast?: Phaser.GameObjects.Text;
  private readonly canRevive: boolean;
  private readonly hasQuota: boolean;
  private readonly onRevive: () => void;
  private readonly onGiveUp: () => void;
  private readonly payload: ResultData;

  constructor(
    scene: Phaser.Scene,
    payload: ResultData,
    canRevive: boolean,
    onRevive: () => void,
    onGiveUp: () => void
  ) {
    this.scene = scene;
    this.payload = payload;
    this.hasQuota = canRevive;
    this.canRevive = canRevive && ads.rewardedAvailable();
    this.onRevive = onRevive;
    this.onGiveUp = onGiveUp;
    this.build();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private build(): void {
    const scene = this.scene;
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    // 全屏遮罩：吞掉点击，避免穿透到棋盘
    const dim = scene.add.graphics().setDepth(190);
    dim.fillStyle(0x000000, 0.72);
    dim.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );
    this.objects.push(dim);

    const panelW = 400;
    const panelH = 380;
    const px = cx - panelW / 2;
    const py = cy - panelH / 2;

    const panel = scene.add.graphics().setDepth(191);
    panel.fillStyle(0x000000, 0.5);
    panel.fillRoundedRect(px + 6, py + 8, panelW, panelH, 18);
    panel.fillStyle(0x2a1d33, 1);
    panel.fillRoundedRect(px, py, panelW, panelH, 18);
    panel.fillStyle(0x140f1c, 1);
    panel.fillRoundedRect(px + 6, py + 6, panelW - 12, panelH - 12, 14);
    panel.lineStyle(3, 0xc9a227, 0.95);
    panel.strokeRoundedRect(px, py, panelW, panelH, 18);
    this.objects.push(panel);

    this.text(cx, py + 46, t('revive.title'), 36, '#ffb4b4', true);
    this.text(
      cx,
      py + 96,
      `${t('result.survival')}　${formatTime(this.payload.timeMs)}　　${tf('hud.coinsValue', {
        n: this.payload.coins
      })}`,
      17,
      '#a8c0d0'
    );

    const percent = Math.round(REVIVE_HP_RATIO * 100);
    // 区分「有复活次数但广告不可用」和「本局次数已用完」，否则文案会误导玩家
    const desc = this.canRevive
      ? t('revive.desc').replace('{n}', String(percent))
      : this.hasQuota
        ? t('ad.unavailable')
        : t('revive.noMore');
    const descText = this.text(cx, py + 140, desc, 15, this.canRevive ? '#d8c8a8' : '#8fa8b8');
    descText.setWordWrapWidth(panelW - 60);
    descText.setOrigin(0.5, 0);

    if (this.canRevive) {
      const btn = this.button(cx, py + 224, 300, 54, t('revive.watch'), true, () => {
        void this.watchAd();
      });
      this.adLabel = btn.label;
    } else {
      this.button(
        cx,
        py + 224,
        300,
        54,
        this.hasQuota ? t('ad.unavailable') : t('revive.noReviveLeft'),
        false,
        () => {
          /* 无广告能力 / 次数用完：只展示状态 */
        }
      );
    }

    this.button(cx, py + 300, 300, 44, t('revive.giveUp'), false, () => this.giveUp());

    this.toast = this.text(cx, py + 342, '', 14, '#ff9b9b');
  }

  private text(
    x: number,
    y: number,
    value: string,
    size: number,
    color: string,
    bold = false
  ): Phaser.GameObjects.Text {
    const obj = this.scene.add
      .text(x, y, value, {
        fontFamily: FONT,
        fontSize: `${size}px`,
        color,
        fontStyle: bold ? 'bold' : 'normal',
        stroke: bold ? '#1a0f06' : undefined,
        strokeThickness: bold ? 6 : 0
      })
      .setOrigin(0.5)
      .setDepth(192);
    this.objects.push(obj);
    return obj;
  }

  private button(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    primary: boolean,
    onClick: () => void
  ): { container: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text } {
    const container = this.scene.add.container(x, y).setDepth(193);
    const base = this.scene.add.graphics();
    const draw = (hover: boolean) => {
      base.clear();
      if (primary) {
        base.fillStyle(hover ? 0x3d5a1e : 0x2a4014, 1);
        base.lineStyle(3, hover ? 0xffe6a3 : 0x8fbe3a, 1);
      } else {
        base.fillStyle(hover ? 0x2a2030 : 0x1a1420, 1);
        base.lineStyle(2, hover ? 0xc9a227 : 0x5c4a6a, 1);
      }
      base.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
      base.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
    };
    draw(false);

    const text = this.scene.add
      .text(0, 0, label, {
        fontFamily: FONT,
        fontSize: primary ? '22px' : '17px',
        color: primary ? '#f2ffd8' : '#d8c8e8',
        fontStyle: primary ? 'bold' : 'normal'
      })
      .setOrigin(0.5);

    container.add([base, text]);
    container.setSize(w, h);
    container.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains);
    container.on('pointerover', () => draw(true));
    container.on('pointerout', () => draw(false));
    container.on('pointerdown', () => {
      if (this.busy || this.closed) return;
      onClick();
    });

    this.objects.push(container);
    return { container, label: text };
  }

  private async watchAd(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.adLabel?.setText(t('ad.loading'));

    bgm().suspendForAd();
    sfx.stopAll();
    ads.gameplayStop();

    const outcome = await ads.showRewarded();

    bgm().resumeFromAd();
    ads.gameplayStart();

    if (this.closed) return;

    if (outcome === 'rewarded') {
      this.busy = false;
      this.destroy();
      this.onRevive();
      return;
    }

    this.busy = false;
    this.adLabel?.setText(t('revive.watch'));
    this.showToast(outcome === 'skipped' ? t('revive.needFull') : t('ad.failed'));
  }

  private giveUp(): void {
    if (this.busy || this.closed) return;
    this.busy = true;
    sfx.play('uiClose');
    this.destroy();
    this.onGiveUp();
  }

  private showToast(msg: string): void {
    if (!this.toast) return;
    this.toast.setText(msg).setAlpha(1);
    this.scene.tweens.add({
      targets: this.toast,
      alpha: 0,
      duration: 260,
      delay: 1600
    });
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    for (const obj of this.objects) {
      try {
        obj.destroy();
      } catch {
        /* ignore */
      }
    }
    this.objects = [];
    this.adLabel = undefined;
    this.toast = undefined;
  }
}

/** 供 GameScene 判断「面板中心」等布局时复用 */
export const REVIVE_PANEL_CENTER_Y = GAME_HEIGHT / 2;
export const REVIVE_PANEL_TOP = BOARD_TOP;
