/**
 * SettingsScene：设置覆盖层（齿轮按钮打开）。
 *
 * 与 PauseScene / ShopScene 同样的「覆盖层」模式：GameScene 被 pause，
 * 本场景 launch 叠加；关闭时 resume。
 *
 * 提供两项设置：
 *   1) 语言切换（中文 / English）——立即生效并持久化，并通知外部刷新界面。
 *   2) 主音量滑块（0~100%）——实时应用到 Phaser 声音管理器并持久化。
 *
 * 关闭方式：Esc / 点击 × / 点击遮罩外。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, SCENE_KEYS, COLORS } from '../config';
import { getLanguage, setLanguage, LANGUAGES, t, type Language } from '../i18n';
import { getVolume, setVolume, applyVolume } from '../platform/sound';
import { bgm } from '../platform/bgm';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';
import { drawGear } from '../ui/gear';

const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

export interface SettingsSceneData {
  /** 关闭回调（GameScene 用来恢复游戏 / 刷新界面） */
  onClose: () => void;
  /** 语言改变时通知外部（让下层界面即时刷新，即使不重开场景） */
  onLanguageChanged?: (lang: Language) => void;
  /** 音量改变时通知外部（一般用于即时应用 / 提示） */
  onVolumeChanged?: (v: number) => void;
}

interface LangButton {
  id: Language;
  bg: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  redraw: () => void;
}

export class SettingsScene extends Phaser.Scene {
  private settingsData!: SettingsSceneData;
  private closing = false;

  /** 语言按钮（用于高亮当前语言） */
  private langButtons: LangButton[] = [];

  /** 音量滑块 */
  private sliderKnob?: Phaser.GameObjects.Graphics;
  private volumeText?: Phaser.GameObjects.Text;
  private dragging = false;

  constructor() {
    super(SCENE_KEYS.settings);
  }

  init(data: SettingsSceneData): void {
    this.settingsData = data;
    this.closing = false;
    this.langButtons = [];
    this.dragging = false;
  }

  create(): void {
    installCameraFit(this, false);
    const cx = GAME_WIDTH / 2;

    // ---- 全屏暗化遮罩（吞点击）----
    const dim = this.add.graphics().setDepth(0);
    dim.fillStyle(0x000000, 0.6);
    dim.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );
    dim.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _lx: number, _ly: number, event: Phaser.Types.Input.EventData) => {
        // 点击遮罩本身（非面板）时关闭
        event?.stopPropagation?.();
        this.close();
      }
    );

    // ---- 面板 ----
    const panelW = 460;
    const panelH = 300;
    const panelX = cx - panelW / 2;
    const panelY = (GAME_HEIGHT - panelH) / 2;

    const panel = this.add.graphics().setDepth(1);
    panel.fillStyle(0x000000, 0.45);
    panel.fillRoundedRect(panelX + 6, panelY + 8, panelW, panelH, 18);
    panel.fillStyle(0x2a1d33, 1);
    panel.fillRoundedRect(panelX, panelY, panelW, panelH, 18);
    panel.fillStyle(0x140f1c, 1);
    panel.fillRoundedRect(panelX + 6, panelY + 6, panelW - 12, panelH - 12, 14);
    panel.lineStyle(3, 0xc9a227, 0.95);
    panel.strokeRoundedRect(panelX, panelY, panelW, panelH, 18);

    // 面板自身吞掉点击，避免冒泡到遮罩关闭
    const panelHit = this.add.zone(cx, panelY + panelH / 2, panelW, panelH).setInteractive();
    panelHit.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
        e?.stopPropagation?.();
      }
    );

    // ---- 标题（带小齿轮）----
    const titleGear = this.add.graphics().setDepth(3);
    drawGear(titleGear, panelX + 40, panelY + 40, 13, {
      color: 0xffe6a3,
      holeColor: 0x140f1c,
      strokeColor: 0x8a6e1e,
      teeth: 8
    });
    this.add
      .text(panelX + 62, panelY + 26, t('settings.title'), {
        fontFamily: FONT,
        fontSize: '26px',
        color: '#ffe6a3',
        fontStyle: 'bold',
        stroke: '#1a0f06',
        strokeThickness: 4
      })
      .setDepth(3);

    // ---- 关闭按钮 × ----
    this.createCloseButton(panelX + panelW - 30, panelY + 34);

    // ---- 语言 ----
    this.add
      .text(panelX + 36, panelY + 86, t('settings.language'), {
        fontFamily: FONT,
        fontSize: '17px',
        color: COLORS.text,
        fontStyle: 'bold'
      })
      .setDepth(3);

    const langBtnW = 120;
    const langBtnH = 40;
    const langGap = 16;
    const totalW = LANGUAGES.length * langBtnW + (LANGUAGES.length - 1) * langGap;
    let lx = cx - totalW / 2;
    const ly = panelY + 122;
    for (const lang of LANGUAGES) {
      this.createLangButton(lx + langBtnW / 2, ly + langBtnH / 2, langBtnW, langBtnH, lang.id, lang.nativeLabel);
      lx += langBtnW + langGap;
    }

    // ---- 音量 ----
    this.add
      .text(panelX + 36, panelY + 194, t('settings.volume'), {
        fontFamily: FONT,
        fontSize: '17px',
        color: COLORS.text,
        fontStyle: 'bold'
      })
      .setDepth(3);

    this.volumeText = this.add
      .text(panelX + panelW - 36, panelY + 194, '', {
        fontFamily: FONT,
        fontSize: '17px',
        color: COLORS.accent,
        fontStyle: 'bold'
      })
      .setOrigin(1, 0)
      .setDepth(3);

    this.createVolumeSlider(panelX + 36, panelY + 232, panelW - 72);

    // ---- 底部提示 ----
    this.add
      .text(cx, panelY + panelH - 22, t('settings.hint'), {
        fontFamily: FONT,
        fontSize: '13px',
        color: COLORS.textDim
      })
      .setOrigin(0.5)
      .setDepth(3);

    // ---- 键盘：Esc 关闭 ----
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.close();
      });
      kb.addCapture([Phaser.Input.Keyboard.KeyCodes.ESC]);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.removeAllListeners();
    });

    // 初始应用一次音量到声音管理器
    applyVolume(this.game);
  }

  // ------------------------------------------------------------ 语言

  private createLangButton(
    cx: number,
    cy: number,
    w: number,
    h: number,
    id: Language,
    label: string
  ): void {
    const bg = this.add.graphics().setDepth(2);
    const text = this.add
      .text(cx, cy, label, {
        fontFamily: FONT,
        fontSize: '17px',
        color: '#cfd8e3',
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setDepth(3);

    const redraw = () => {
      const active = getLanguage() === id;
      bg.clear();
      bg.fillStyle(active ? 0xc9a227 : 0x241a2e, active ? 0.95 : 0.9);
      bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 10);
      bg.lineStyle(2, active ? 0xffe6a3 : 0x5a4a2a, 0.9);
      bg.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 10);
      text.setColor(active ? '#241708' : '#cfd8e3');
    };
    redraw();

    const hit = this.add.zone(cx, cy, w, h).setInteractive({ useHandCursor: true }).setDepth(3);
    hit.on('pointerover', () => {
      if (getLanguage() !== id) text.setColor('#ffe6a3');
    });
    hit.on('pointerout', () => redraw());
    hit.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
        e?.stopPropagation?.();
        if (getLanguage() === id) return;
        setLanguage(id);
        // 通知外部（下层界面即时刷新）
        this.settingsData.onLanguageChanged?.(id);
        // 设置面板自身文案随语言更新：直接重建本场景最省事
        this.scene.restart({ ...this.settingsData });
      }
    );

    this.langButtons.push({ id, bg, label: text, redraw });
  }

  // ------------------------------------------------------------ 音量滑块

  private createVolumeSlider(x: number, y: number, w: number): void {
    // 轨道
    const track = this.add.graphics().setDepth(2);
    track.fillStyle(0x241a2e, 1);
    track.fillRoundedRect(x - 2, y - 6, w + 4, 12, 6);
    track.lineStyle(1.5, 0x5a4a2a, 0.9);
    track.strokeRoundedRect(x - 2, y - 6, w + 4, 12, 6);

    // 已填充部分
    const fill = this.add.graphics().setDepth(2);
    // 旋钮
    this.sliderKnob = this.add.graphics().setDepth(3);
    const knob = this.sliderKnob;

    const redraw = () => {
      const v = getVolume();
      fill.clear();
      fill.fillStyle(0xc9a227, 0.95);
      fill.fillRoundedRect(x, y - 4, Math.max(2, w * v), 8, 4);

      knob.clear();
      const kx = x + w * v;
      knob.fillStyle(0xffe6a3, 1);
      knob.fillCircle(kx, y, 10);
      knob.lineStyle(2, 0x8a6e1e, 1);
      knob.strokeCircle(kx, y, 10);

      this.volumeText?.setText(`${Math.round(v * 100)}%`);
    };
    redraw();

    // 交互：点击 / 拖动轨道区域设置音量
    const hit = this.add
      .zone(x + w / 2, y, w + 28, 40)
      .setInteractive({ useHandCursor: true })
      .setDepth(3);

    const setFromPointer = (px: number) => {
      const rel = Phaser.Math.Clamp((px - x) / w, 0, 1);
      setVolume(rel);
      applyVolume(this.game);
      // BGM 独立于 Phaser SoundManager，需单独通知其跟随新主音量
      bgm().onVolumeChanged();
      redraw();
      this.settingsData.onVolumeChanged?.(rel);
    };

    hit.on(
      'pointerdown',
      (p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
        e?.stopPropagation?.();
        this.dragging = true;
        setFromPointer(p.worldX);
      }
    );
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      setFromPointer(p.worldX);
    });
    this.input.on('pointerup', () => {
      this.dragging = false;
    });
    this.input.on('gameout', () => {
      this.dragging = false;
    });
  }

  // ------------------------------------------------------------ 关闭

  private createCloseButton(x: number, y: number): void {
    const c = this.add.container(x, y).setDepth(3);
    const g = this.add.graphics();
    g.fillStyle(0x3a1d1d, 1);
    g.fillCircle(0, 0, 15);
    g.lineStyle(2, 0xff7b7b, 0.9);
    g.strokeCircle(0, 0, 15);
    const tx = this.add
      .text(0, 0, '×', {
        fontFamily: FONT,
        fontSize: '22px',
        color: '#ffd0d0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    c.add([g, tx]);
    c.setSize(30, 30);
    // 注意：Container 的命中区采用「以左上角为原点」的坐标（与 Sprite 一致）。
    // 输入系统会把本地坐标加上 displayOrigin 再判定，因此这里必须用 (0,0,w,h)，
    // 而不是以中心为原点的 (-15,-15,30,30) —— 否则中心点恰好落在判定边界外，
    // 导致点击按钮正中没有反应。
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, 30, 30), Phaser.Geom.Rectangle.Contains);
    c.on('pointerover', () => tx.setColor('#ffffff'));
    c.on('pointerout', () => tx.setColor('#ffd0d0'));
    c.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
        e?.stopPropagation?.();
        this.close();
      }
    );
  }

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    try {
      this.settingsData?.onClose?.();
    } catch {
      /* 关闭回调异常不应阻止关闭 */
    }
    this.scene.stop();
  }
}
