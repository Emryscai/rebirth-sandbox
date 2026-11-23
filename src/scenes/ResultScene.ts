/**
 * ResultScene：结算界面。
 *
 * 与旧版相比：
 *   - 不再「点屏幕任意位置就重开」（手机上极易误触），改成明确的按钮；
 *   - 增加分享入口（微信小游戏分享是自然量来源）；
 *   - 底部加作者署名 JiahaoCai；
 *   - 结算出现后按频控尝试一次插屏广告，不打断本局游玩。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, BOARD_TOP, COLORS, SCENE_KEYS } from '../config';
import { formatTime } from '../utils';
import { t, tf } from '../i18n';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';
import { ads } from '../platform/ads';
import { shareGame, canShare } from '../platform/env';

export interface ResultData {
  timeMs: number;
  coins: number;
  stage: string;
  points: number;
  isNewBest: boolean;
  bestMs: number;
}

const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

export class ResultScene extends Phaser.Scene {
  private payload!: ResultData;
  private restarted = false;

  constructor() {
    super(SCENE_KEYS.result);
  }

  init(data: ResultData): void {
    this.payload = data;
    this.restarted = false;
  }

  create(): void {
    installCameraFit(this);
    const d = this.payload;
    const cx = GAME_WIDTH / 2;
    const top = BOARD_TOP;

    this.cameras.main.setBackgroundColor(0x07060f);

    // 暗紫雾气氛围
    const g = this.add.graphics();
    for (let i = 0; i < 14; i++) {
      const rad = 320 - i * 20;
      g.fillStyle(0x2a1040, 0.05 + i * 0.006);
      g.fillEllipse(cx, GAME_HEIGHT - 90, rad * 2.1, rad * 0.5);
    }

    // 主标题
    this.add
      .text(cx, top + 96, t('result.title'), {
        fontFamily: FONT,
        fontSize: '50px',
        color: '#e8eef4',
        fontStyle: 'bold',
        stroke: '#05060a',
        strokeThickness: 8
      })
      .setOrigin(0.5);

    // 存活时间
    this.add
      .text(cx, top + 166, t('result.survival'), {
        fontFamily: FONT,
        fontSize: '15px',
        color: COLORS.textDim
      })
      .setOrigin(0.5);

    const timeText = this.add
      .text(cx, top + 210, formatTime(d.timeMs), {
        fontFamily: FONT,
        fontSize: '62px',
        color: '#7fe3ff',
        fontStyle: 'bold',
        stroke: '#05060a',
        strokeThickness: 6
      })
      .setOrigin(0.5);

    timeText.setScale(0.7);
    this.tweens.add({
      targets: timeText,
      scale: 1,
      duration: 420,
      ease: 'Back.easeOut'
    });

    // 最高纪录
    const bestLabel = d.isNewBest ? t('result.newBest') : t('result.best');
    const bestColor = d.isNewBest ? '#ffd84a' : '#a8c0d0';

    const bestText = this.add
      .text(cx, top + 272, `${bestLabel}　${formatTime(d.bestMs)}`, {
        fontFamily: FONT,
        fontSize: '21px',
        color: bestColor,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    if (d.isNewBest) {
      this.tweens.add({
        targets: bestText,
        scale: 1.06,
        duration: 620,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }

    // 本局统计
    this.add
      .text(cx, top + 322, tf('result.stats', { coins: d.coins, points: d.points, stage: d.stage }), {
        fontFamily: FONT,
        fontSize: '16px',
        color: COLORS.textDim
      })
      .setOrigin(0.5);

    // 分隔线
    const line = this.add.graphics();
    line.lineStyle(1, 0x2f4a63, 0.8);
    line.lineBetween(cx - 150, top + 350, cx + 150, top + 350);

    // 主按钮：再来一局
    this.createButton(cx, top + 414, 260, 54, t('result.restartButton'), true, () => this.restart());

    // 次按钮：分享（平台不支持时隐藏）
    if (canShare()) {
      this.createButton(cx, top + 480, 200, 42, t('result.share'), false, () => this.share());
    }

    // 键盘 R：老玩家快捷重开（不影响按钮）
    const kb = this.input.keyboard;
    if (kb) {
      kb.once('keydown-R', () => this.restart());
    }

    // 作者署名
    this.add
      .text(cx, GAME_HEIGHT - 28, t('result.credit'), {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#5f7386'
      })
      .setOrigin(0.5);

    // 插屏：等 1.4 秒，玩家已经看清结算再出；有频控，且重开后会取消
    this.time.delayedCall(1400, () => {
      if (this.restarted) return;
      void ads.maybeShowInterstitial();
    });
  }

  private createButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    primary: boolean,
    onClick: () => void
  ): void {
    const container = this.add.container(x, y).setDepth(10);
    const base = this.add.graphics();
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

    const text = this.add
      .text(0, 0, label, {
        fontFamily: FONT,
        fontSize: primary ? '23px' : '17px',
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
      if (this.restarted) return;
      onClick();
    });
  }

  private restart(): void {
    if (this.restarted) return;
    this.restarted = true;
    sfx.play('uiClick');
    ads.gameplayStart();
    this.cameras.main.fadeOut(160, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start(SCENE_KEYS.game);
    });
  }

  private share(): void {
    sfx.play('uiClick');
    const ok = shareGame({
      title: t('boot.title'),
      imageUrl: 'assets/cover-share.png',
      text: `${t('result.survival')} ${formatTime(this.payload.timeMs)} · ${t('boot.title')}`,
      query: `best=${Math.floor(this.payload.bestMs / 1000)}`,
      url: typeof location !== 'undefined' ? location.href : undefined
    });
    if (!ok) {
      // 浏览器不支持分享时退化为「复制口令」提示（不打断游戏）
      this.cameras.main.flash(120, 80, 160, 220, false);
    }
  }
}
