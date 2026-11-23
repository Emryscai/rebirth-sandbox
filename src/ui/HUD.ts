/**
 * HUD：存活时间、血量、进化阶段、尸币、啃食进度。
 * 全部使用 Phaser Text / Graphics，不依赖 DOM。
 */

import Phaser from 'phaser';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  BOARD_TOP,
  BOARD_BOTTOM,
  HAS_TOP_BAR,
  HAS_BOTTOM_BAR,
  COLORS,
  EVOLUTION_STAGES
} from '../config';
import { formatTime, clamp } from '../utils';
import { t, tf, onLanguageChange } from '../i18n';
import { drawGear } from './gear';
import { IS_TOUCH, getSafeArea, getScreenSize } from '../platform/env';

export interface HudData {
  elapsedMs: number;
  hp: number;
  maxHp: number;
  /** 铁板护盾剩余量；0/undefined = 无护盾 */
  shieldHp?: number;
  stageLabel: string;
  stageIndex: number;
  evolutionPoints: number;
  nextRequirement: number | null;
  coins: number;
  plantCount: number;
  eatRatio: number;
  eating: boolean;
}

export class HUD {
  private scene: Phaser.Scene;

  private timeLabel: Phaser.GameObjects.Text;
  private timeText: Phaser.GameObjects.Text;
  private hpLabel: Phaser.GameObjects.Text;
  private hpText: Phaser.GameObjects.Text;
  private shieldText: Phaser.GameObjects.Text;
  private coinLabel: Phaser.GameObjects.Text;
  private stageText: Phaser.GameObjects.Text;
  private coinText: Phaser.GameObjects.Text;
  private plantText: Phaser.GameObjects.Text;
  private hintText: Phaser.GameObjects.Text;

  private hpBarBg: Phaser.GameObjects.Graphics;
  private hpBarFill: Phaser.GameObjects.Graphics;
  private evoBarBg: Phaser.GameObjects.Graphics;
  private evoBarFill: Phaser.GameObjects.Graphics;
  private eatRing: Phaser.GameObjects.Graphics;

  /**
   * HUD 顶部基准 Y。
   *
   * 桌面端叠在棋盘左上角；竖屏端把状态面板放到棋盘上方的留白里，
   * 不再遮挡最上面两行格子（否则植物会被 HUD 盖住）。
   */
  private readonly top = HAS_TOP_BAR ? BOARD_TOP - 170 : 12;

  /** 竖屏大屏布局：按钮和字号都要放大，否则 640 设计稿缩到 390 手机上过小 */
  private readonly big = HAS_TOP_BAR || HAS_BOTTOM_BAR;

  /**
   * 底部安全区（换算成 640 设计坐标）。
   *
   * iPhone Home 条 / Android 手势条会盖住底部按钮，这里把按钮整体上移；
   * 桌面端为 0。
   */
  private readonly bottomSafe = (() => {
    if (!HAS_BOTTOM_BAR) return 0;
    const screen = getScreenSize();
    const scale = screen.width > 0 ? 640 / screen.width : 1;
    return Math.min(150, Math.round(getSafeArea().bottom * scale));
  })();

  /** 大布局下各行的纵向位置（统一在这里算，update 与构造共用） */
  private get timeValueY(): number {
    return this.top + (this.big ? 24 : 18);
  }
  private get hpLabelY(): number {
    return this.top + (this.big ? 58 : 52);
  }
  private get hpValueY(): number {
    return this.top + (this.big ? 78 : 70);
  }
  private get hpBarY(): number {
    return this.top + (this.big ? 108 : 96);
  }
  private get hpBarW(): number {
    return this.big ? 196 : 140;
  }
  private get stageY(): number {
    return this.top + (this.big ? 120 : 112);
  }
  private get evoBarY(): number {
    return this.top + (this.big ? 152 : 136);
  }
  private get evoBarW(): number {
    return this.big ? 196 : 140;
  }

    /** HUD 半透明底板（场地铺满画布后用于保证文字可读） */
  private backdrop: Phaser.GameObjects.Graphics;

  /** 右下角商店按钮（可点击） */
  private shopBtn?: Phaser.GameObjects.Container;
  private shopLabel?: Phaser.GameObjects.Text;

  /** 设置齿轮按钮（可点击） */
  private settingsBtn?: Phaser.GameObjects.Container;
  private settingsGear?: Phaser.GameObjects.Graphics;

  /** 暂停按钮（移动端必需，桌面端也保留） */
  private pauseBtn?: Phaser.GameObjects.Container;
  /** 右下角啃食按钮（按住生效） */
  private eatBtn?: Phaser.GameObjects.Container;
  private eatLabel?: Phaser.GameObjects.Text;
  /** 竖屏底部留白里的作者署名 */
  private creditText?: Phaser.GameObjects.Text;

  /** 点击商店按钮的回调（由 GameScene 注入） */
  private onOpenShop?: () => void;
  /** 点击设置按钮的回调（由 GameScene 注入） */
  private onOpenSettings?: () => void;
  /** 点击暂停按钮的回调（由 GameScene 注入） */
  private onPause?: () => void;
  /** 啃食按钮按下/松开（由 GameScene 注入） */
  private onEatDown?: () => void;
  private onEatUp?: () => void;

  /** 是否已销毁（场景 shutdown 后禁止任何 setText，否则会崩） */
  private destroyed = false;

  /** 语言变化取消订阅 */
  private offLang?: () => void;

  /** 最近一次 update 数据（语言切换时用于刷新数值文案） */
  private lastData?: HudData;

  /** 是否仍然可用（供外部调用前判断） */
  get isAlive(): boolean {
    return !this.destroyed;
  }

  constructor(
    scene: Phaser.Scene,
    onOpenShop?: () => void,
    onOpenSettings?: () => void,
    onPause?: () => void,
    onEatDown?: () => void,
    onEatUp?: () => void
  ) {
    this.scene = scene;
    this.onOpenShop = onOpenShop;
    this.onOpenSettings = onOpenSettings;
    this.onPause = onPause;
    this.onEatDown = onEatDown;
    this.onEatUp = onEatUp;

    const labelStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
      fontSize: this.big ? '19px' : '15px',
      color: COLORS.textDim
    };

    const valueStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
      fontSize: this.big ? '28px' : '20px',
      color: COLORS.text,
      fontStyle: 'bold'
    };

    const panelW = this.big ? 236 : 168;
    const panelH = this.big ? 166 : 104;
    // 底部提示：竖屏时贴着棋盘下方，桌面端在按钮行上方
    const hintY = HAS_BOTTOM_BAR ? BOARD_BOTTOM + 64 : GAME_HEIGHT - 75;

    // HUD 底板：场地铺满画布，HUD 必须叠在上方并保证可读
    this.backdrop = scene.add.graphics().setDepth(99);
    this.backdrop.fillStyle(0x05080d, 0.62);
    this.backdrop.fillRoundedRect(6, this.top - 6, panelW, panelH, 8);
    this.backdrop.fillRoundedRect(GAME_WIDTH - (this.big ? 180 : 150), this.top - 6, this.big ? 174 : 144, this.big ? 50 : 40, 8);
    // 底部操作提示底板（放在按钮行上方，避免和手机端按钮重叠）
    this.backdrop.fillStyle(0x05080d, 0.5);
    this.backdrop.fillRoundedRect(
      GAME_WIDTH / 2 - (this.big ? 240 : 210),
      hintY - 16,
      this.big ? 480 : 420,
      this.big ? 32 : 26,
      8
    );

    // 竖屏顶部品牌区：把棋盘上方的留白填满，避免「游戏缩在中间」的廉价感
    if (HAS_TOP_BAR) {
      const brandY = Math.max(48, BOARD_TOP * 0.24);
      this.backdrop.fillStyle(0x000000, 0);
      scene.add
        .text(GAME_WIDTH / 2, brandY, t('boot.title'), {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: '48px',
          color: '#e8eef4',
          fontStyle: 'bold',
          stroke: '#05060a',
          strokeThickness: 8
        })
        .setOrigin(0.5)
        .setDepth(100);
      scene.add
        .text(GAME_WIDTH / 2, brandY + 44, 'REBIRTH SANDBOX', {
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: '15px',
          color: '#7f96a8',
          letterSpacing: 6
        })
        .setOrigin(0.5)
        .setDepth(100);
      this.backdrop.lineStyle(1, 0x2f4a63, 0.7);
      this.backdrop.lineBetween(GAME_WIDTH / 2 - 120, brandY + 70, GAME_WIDTH / 2 + 120, brandY + 70);
    }

    const pad = this.big ? 22 : 20;

    // 存活时间（左上）
    this.timeLabel = scene.add.text(pad, this.top, t('hud.survival'), labelStyle).setDepth(100);
    this.timeText = scene.add
      .text(pad, this.timeValueY, '00:00', valueStyle)
      .setDepth(100);

    // 尸币（右上）
    this.coinText = scene.add
      .text(GAME_WIDTH - pad, this.timeValueY, tf('hud.coinsValue', { n: 0 }), valueStyle)
      .setOrigin(1, 0)
      .setColor(COLORS.coin)
      .setDepth(100);
    this.coinLabel = scene.add
      .text(GAME_WIDTH - pad, this.top, t('hud.coins'), labelStyle)
      .setOrigin(1, 0)
      .setDepth(100);

    // 血量（左侧中段）
    this.hpLabel = scene.add.text(pad, this.hpLabelY, t('hud.hp'), labelStyle).setDepth(100);
    this.hpText = scene.add
      .text(pad, this.hpValueY, '100 / 100', valueStyle)
      .setDepth(100);

    this.hpBarBg = scene.add.graphics().setDepth(100);
    this.hpBarBg.fillStyle(0x1b2430, 1);
    this.hpBarBg.fillRect(pad, this.hpBarY, this.hpBarW, this.big ? 10 : 8);

    this.hpBarFill = scene.add.graphics().setDepth(101);

    // 铁板护盾：明确显示剩余量，避免“攻击穿模”的错觉
    this.shieldText = scene.add
      .text(pad + this.hpBarW + 12, this.hpBarY - 4, '', {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: this.big ? '17px' : '12px',
        color: '#9fd8ff',
        fontStyle: 'bold'
      })
      .setDepth(100);

        // 进化（左侧下方）
    this.stageText = scene.add
      .text(pad, this.stageY, t('stage.0'), {
        ...valueStyle,
        fontSize: this.big ? '24px' : '18px',
        color: COLORS.accent
      })
      .setDepth(100);

    this.evoBarBg = scene.add.graphics().setDepth(100);
    this.evoBarBg.fillStyle(0x1b2430, 1);
    this.evoBarBg.fillRect(pad, this.evoBarY, this.evoBarW, this.big ? 8 : 6);

    this.evoBarFill = scene.add.graphics().setDepth(101);

        // 场上植物数（右上，尸币下方）
    this.plantText = scene.add
      .text(GAME_WIDTH - pad, this.hpLabelY, tf('hud.plantsValue', { n: 0 }), {
        ...labelStyle,
        fontSize: this.big ? '17px' : '14px'
      })
      .setOrigin(1, 0)
      .setDepth(100);

    // 底部操作提示：手机端换成「滑动/按住」，桌面端保留键盘提示
    this.hintText = scene.add
      .text(
        GAME_WIDTH / 2,
        HAS_BOTTOM_BAR ? BOARD_BOTTOM + 64 : GAME_HEIGHT - 75,
        IS_TOUCH ? t('hud.hintTouch') : t('hud.hint'),
        {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: this.big ? '18px' : '13px',
          color: COLORS.textDim
        }
      )
      .setOrigin(0.5, 0.5)
      .setDepth(100);

        // 啃食进度环（跟随玩家，由 update 定位）
    this.eatRing = scene.add.graphics().setDepth(50);

    // 底部按钮行：暂停 / 商店 / 设置（居中排列，给右下角啃食键让位）
    this.createPauseButton(scene);
    this.createShopButton(scene);
    this.createSettingsButton(scene);
    // 右下角：按住啃食
    this.createEatButton(scene);

    // 竖屏底部留白：作者署名（桌面端没有这块留白，不显示）
    if (HAS_BOTTOM_BAR) {
      this.creditText = scene.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT - 8 - this.bottomSafe, t('result.credit'), {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: '14px',
          color: '#4f6274'
        })
        .setOrigin(0.5)
        .setDepth(100);
    }

    // 语言切换时刷新所有静态标签（不重开场景）
    this.offLang = onLanguageChange(() => this.refreshTexts());
  }

  /** 语言切换后刷新静态标签与动态数值文案 */
  private refreshTexts(): void {
    if (this.destroyed) return;
    this.timeLabel.setText(t('hud.survival'));
    this.hpLabel.setText(t('hud.hp'));
    this.coinLabel.setText(t('hud.coins'));
    this.hintText.setText(IS_TOUCH ? t('hud.hintTouch') : t('hud.hint'));
    this.shopLabel?.setText(t('hud.shop'));
    this.settingsBtn?.setName(t('hud.settings'));
    this.pauseBtn?.setName(t('hud.pause'));
    this.eatLabel?.setText(t('hud.eat'));
    this.creditText?.setText(t('result.credit'));
    // 动态值用最近一次数据重算
    if (this.lastData) {
      this.coinText.setText(tf('hud.coinsValue', { n: this.lastData.coins }));
      this.plantText.setText(tf('hud.plantsValue', { n: this.lastData.plantCount }));
      this.updateStageText(this.lastData);
    }
  }

  /**
   * 右下角「商店」按钮。
   *
   * 用一个 Container 承载底色 + 文字，方便整体点击与 hover 反馈。
   * 点击回调交给 GameScene（打开商店场景）。
   */
  private createShopButton(scene: Phaser.Scene): void {
    const w = this.big ? 132 : 88;
    const h = this.big ? 56 : 36;
    const x = GAME_WIDTH / 2;
    const y = this.big ? GAME_HEIGHT - 70 - this.bottomSafe : GAME_HEIGHT - 26;

    const container = scene.add.container(x, y).setDepth(102);

    const base = scene.add.graphics();
    const drawBase = (hover: boolean) => {
      base.clear();
      base.fillStyle(hover ? 0x2a3a1c : 0x1d2b12, 1);
      base.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
      base.lineStyle(2, hover ? 0xffe6a3 : 0x6f8f3a, 1);
      base.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);
    };
    drawBase(false);

        const label = scene.add
      .text(0, 0, t('hud.shop'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: this.big ? '24px' : '18px',
        color: '#e8f3d0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    this.shopLabel = label;

        container.add([base, label]);
    container.setSize(w, h);
    // Container 命中区以左上角为原点（输入系统会加 displayOrigin 再判定）。
    // 必须用 (0,0,w,h)，否则以中心为原点的矩形会让点击正中没有反应。
    container.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, w, h),
      Phaser.Geom.Rectangle.Contains
    );

    container.on('pointerover', () => drawBase(true));
    container.on('pointerout', () => drawBase(false));
    container.on('pointerdown', () => {
      if (this.destroyed) return;
      this.onOpenShop?.();
    });

    this.shopBtn = container;
  }

  /**
   * 设置齿轮按钮：放在商店按钮左侧，圆形底 + 程序化齿轮图标。
   * 点击回调交给 GameScene（打开设置场景）。
   */
  private createSettingsButton(scene: Phaser.Scene): void {
    const d = this.big ? 56 : 36; // 直径
    // 与商店按钮同高，位于其右侧
    const x = GAME_WIDTH / 2 + (this.big ? 112 : 72);
    const y = this.big ? GAME_HEIGHT - 70 - this.bottomSafe : GAME_HEIGHT - 26;

    const container = scene.add.container(x, y).setDepth(102);

    // 圆形底
    const base = scene.add.graphics();
    const drawBase = (hover: boolean) => {
      base.clear();
      base.fillStyle(hover ? 0x2a3a1c : 0x1d2b12, 1);
      base.fillCircle(0, 0, d / 2);
      base.lineStyle(2, hover ? 0xffe6a3 : 0x6f8f3a, 1);
      base.strokeCircle(0, 0, d / 2);
    };
    drawBase(false);

    // 齿轮图标（居中）
    const gear = scene.add.graphics();
    drawGear(gear, 0, 0, this.big ? 18 : 12, {
      color: 0xe8f3d0,
      holeColor: 0x1d2b12,
      strokeColor: 0x6f8f3a,
      teeth: 8
    });

        container.add([base, gear]);
    container.setSize(d, d);
    // Container 命中区以左上角为原点（输入系统会加 displayOrigin=直径一半）。
    // 圆心必须落在 (d/2, d/2)，即 Circle(d/2, d/2, d/2)，否则点击正中无反应。
    container.setInteractive(
      new Phaser.Geom.Circle(d / 2, d / 2, d / 2),
      Phaser.Geom.Circle.Contains
    );
    container.setName(t('hud.settings'));

    container.on('pointerover', () => {
      drawBase(true);
      // hover 时齿轮随底色重画（中心孔用当前底色）
      drawGear(gear, 0, 0, this.big ? 18 : 12, {
        color: 0xffe6a3,
        holeColor: 0x2a3a1c,
        strokeColor: 0xffe6a3,
        teeth: 8
      });
    });
    container.on('pointerout', () => {
      drawBase(false);
      drawGear(gear, 0, 0, this.big ? 18 : 12, {
        color: 0xe8f3d0,
        holeColor: 0x1d2b12,
        strokeColor: 0x6f8f3a,
        teeth: 8
      });
    });
    container.on('pointerdown', () => {
      if (this.destroyed) return;
      this.onOpenSettings?.();
    });

    this.settingsBtn = container;
    this.settingsGear = gear;
  }

  /** 暂停按钮：两根竖条，放在底部按钮行左侧 */
  private createPauseButton(scene: Phaser.Scene): void {
    const d = this.big ? 56 : 36;
    const x = GAME_WIDTH / 2 - (this.big ? 112 : 72);
    const y = this.big ? GAME_HEIGHT - 70 - this.bottomSafe : GAME_HEIGHT - 26;
    const container = scene.add.container(x, y).setDepth(102);

    const base = scene.add.graphics();
    const drawBase = (hover: boolean) => {
      base.clear();
      base.fillStyle(hover ? 0x2a3a1c : 0x1d2b12, 1);
      base.fillCircle(0, 0, d / 2);
      base.lineStyle(2, hover ? 0xffe6a3 : 0x6f8f3a, 1);
      base.strokeCircle(0, 0, d / 2);
    };
    drawBase(false);

    const icon = scene.add.graphics();
    const iw = this.big ? 9 : 6;
    const ih = this.big ? 26 : 18;
    const gap = this.big ? 6 : 4;
    icon.fillStyle(0xe8f3d0, 1);
    icon.fillRoundedRect(-gap / 2 - iw, -ih / 2, iw, ih, 2);
    icon.fillRoundedRect(gap / 2, -ih / 2, iw, ih, 2);

    container.add([base, icon]);
    container.setSize(d, d);
    container.setInteractive(new Phaser.Geom.Circle(d / 2, d / 2, d / 2), Phaser.Geom.Circle.Contains);
    container.setName(t('hud.pause'));
    container.on('pointerover', () => drawBase(true));
    container.on('pointerout', () => drawBase(false));
    container.on('pointerdown', () => {
      if (this.destroyed) return;
      this.onPause?.();
    });

    this.pauseBtn = container;
  }

  /**
   * 右下角啃食键：按住持续啃食，松手停止。
   *
   * 棋盘上任意位置按住也能啃，这个按钮主要是「一眼知道能啃」的可见入口，
   * 同时让玩家可以一手按住啃食、另一手在棋盘上滑动逃跑。
   */
  private createEatButton(scene: Phaser.Scene): void {
    const r = this.big ? 52 : 32;
    const x = GAME_WIDTH - (this.big ? 76 : 52);
    const y = GAME_HEIGHT - (this.big ? 76 : 52) - this.bottomSafe;
    const container = scene.add.container(x, y).setDepth(103);

    const base = scene.add.graphics();
    const drawBase = (active: boolean) => {
      base.clear();
      base.fillStyle(active ? 0x5a2a1e : 0x2a1a12, active ? 0.92 : 0.72);
      base.fillCircle(0, 0, r);
      base.lineStyle(active ? 3 : 2, active ? 0xffc46b : 0xb07a3a, 0.95);
      base.strokeCircle(0, 0, r);
    };
    drawBase(false);

    const label = scene.add
      .text(0, 0, t('hud.eat'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: this.big ? '23px' : '16px',
        color: '#ffe6c0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    this.eatLabel = label;

    container.add([base, label]);
    container.setSize(r * 2, r * 2);
    container.setInteractive(
      new Phaser.Geom.Circle(r, r, r),
      Phaser.Geom.Circle.Contains
    );

    let held = false;
    const press = () => {
      if (this.destroyed || held) return;
      held = true;
      drawBase(true);
      this.onEatDown?.();
    };
    const release = () => {
      if (!held) return;
      held = false;
      drawBase(false);
      this.onEatUp?.();
    };

    container.on('pointerdown', press);
    container.on('pointerup', release);
    container.on('pointerout', release);
    // 手指在按钮外松开时 pointerup 不会落到 container 上，这里兜底
    scene.input.on('pointerup', release);

    this.eatBtn = container;
    // 把释放函数挂到容器上，destroy 时可用于清理全局监听
    (container as unknown as { __releaseEat?: () => void }).__releaseEat = release;
  }

    /** 刷新所有 HUD 元素 */
  update(data: HudData, playerPos?: { x: number; y: number }): void {
    // 场景已销毁时禁止任何 setText，否则 Phaser 会抛 setText on destroyed
    if (this.destroyed) return;
    if (!this.timeText?.active) return;

    this.lastData = data;

        this.timeText.setText(formatTime(data.elapsedMs));
    // 血量取整显示：进化/成长会让 maxHp 带上小数（如 ×1.25），
    // 这里对当前值与上限都做取整，避免出现一长串小数。
    this.hpText.setText(`${Math.ceil(data.hp)} / ${Math.ceil(data.maxHp)}`);
    const shield = Math.max(0, Math.ceil(data.shieldHp ?? 0));
    this.shieldText.setText(shield > 0 ? tf('hud.shield', { n: shield }) : '');
    this.coinText.setText(tf('hud.coinsValue', { n: data.coins }));
    this.plantText.setText(tf('hud.plantsValue', { n: data.plantCount }));

    // 血量条
    const ratio = clamp(data.hp / Math.max(1, data.maxHp), 0, 1);
    const barColor = ratio > 0.5 ? COLORS.hpFull : ratio > 0.25 ? 0xfbbf24 : COLORS.hpLow;
    this.hpBarFill.clear();
    this.hpBarFill.fillStyle(barColor, 1);
    const pad = this.big ? 22 : 20;
    this.hpBarFill.fillRect(pad, this.hpBarY, this.hpBarW * ratio, this.big ? 10 : 8);

    // 进化条
    this.updateStageText(data);

    let evoRatio = 1;
    if (data.nextRequirement !== null) {
      const base = this.getStageBase(data.stageIndex);
      const span = data.nextRequirement - base;
      evoRatio = span > 0 ? clamp((data.evolutionPoints - base) / span, 0, 1) : 1;
    }
    this.evoBarFill.clear();
    this.evoBarFill.fillStyle(0x4fd1e0, 1);
    this.evoBarFill.fillRect(pad, this.evoBarY, this.evoBarW * evoRatio, this.big ? 8 : 6);

    // 啃食进度环
    this.eatRing.clear();
    if (data.eating && playerPos) {
      this.eatRing.lineStyle(3, 0x7fe3ff, 0.9);
      this.eatRing.beginPath();
      this.eatRing.arc(
        playerPos.x,
        playerPos.y - 40,
        22,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * data.eatRatio,
        false
      );
      this.eatRing.strokePath();
    }
  }

  /** 进化阶段文案：本地化阶段名 + 进度 / 满级 */
  private updateStageText(data: HudData): void {
    const baseLabel =
      data.stageIndex >= 0 && data.stageIndex <= 3 ? t(`stage.${data.stageIndex}`) : data.stageLabel;
    const evoText =
      data.nextRequirement === null
        ? `${baseLabel} （${t('hud.maxed')}）`
        : `${baseLabel}　${data.evolutionPoints} / ${data.nextRequirement}`;
    this.stageText.setText(evoText);
  }

  /** 阶段对应的起始需求点数（从统一配置读取，避免硬编码不同步） */
  private getStageBase(index: number): number {
    return EVOLUTION_STAGES[index]?.requiredPoints ?? 0;
  }

  /** 显示一条居中提示（升级、吃植物等反馈） */
  flashMessage(text: string, color: string = COLORS.accent): void {
    if (this.destroyed || !this.scene) return;

        const msg = this.scene.add
      .text(GAME_WIDTH / 2, BOARD_TOP + 200, text, {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '30px',
        color,
        fontStyle: 'bold',
        stroke: '#05060a',
        strokeThickness: 6
      })
      .setOrigin(0.5)
      .setDepth(120)
      .setAlpha(0);

    this.scene.tweens.add({
      targets: msg,
      alpha: 1,
      y: BOARD_TOP + 176,
      duration: 220,
      ease: 'Quad.easeOut',
      onComplete: () => {
        // 场景可能已切换，tweens / targets 都可能已失效
        if (this.destroyed || !this.scene || !msg.active) return;
        this.scene.tweens.add({
          targets: msg,
          alpha: 0,
          duration: 500,
          delay: 520,
          onComplete: () => {
            if (msg.active) msg.destroy();
          }
        });
      }
    });
  }

    /** 销毁所有 HUD 元素 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.offLang?.();
    this.offLang = undefined;

    // 解绑啃食键挂在场景上的全局 pointerup 兜底
    const releaseEat = this.eatBtn
      ? (this.eatBtn as unknown as { __releaseEat?: () => void }).__releaseEat
      : undefined;
    if (releaseEat) this.scene.input.off('pointerup', releaseEat);

    const targets: Array<Phaser.GameObjects.GameObject | undefined> = [
      this.timeLabel,
      this.timeText,
      this.hpLabel,
      this.hpText,
      this.shieldText,
      this.coinLabel,
      this.stageText,
      this.coinText,
      this.plantText,
      this.hintText,
      this.hpBarBg,
      this.hpBarFill,
      this.evoBarBg,
      this.evoBarFill,
            this.eatRing,
      this.backdrop,
      this.shopBtn,
      this.settingsBtn,
      this.pauseBtn,
      this.eatBtn,
      this.creditText
    ];
    for (const t of targets) {
      try { t?.destroy(); } catch { /* 已销毁则忽略 */ }
    }
  }
}
