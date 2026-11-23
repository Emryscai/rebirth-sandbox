/**
 * PauseScene：仿《植物大战僵尸》的暂停菜单。
 *
 * 以透明覆盖层的方式叠加在 GameScene 之上（scene.launch），
 * GameScene 本身被 scene.pause 冻住（update 停止、计时停止）。
 *
 * 只有三个按键，顺序与 PvZ 一致：
 *   取消   —— 回到游戏（等价于「继续」）
 *   继续   —— 回到主菜单（本作没有独立主菜单，回到游戏开局）
 *   重开   —— 重新开始本局
 *
 * 为什么「取消」和「继续」都要保留：这是 PvZ 菜单的原样结构，
 * 用户明确要求照做，因此保持三个按键不合并。
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, SCENE_KEYS, COLORS } from '../config';
import { t } from '../i18n';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';

type MenuAction = 'cancel' | 'continue' | 'restart';

interface MenuItem {
  action: MenuAction;
  /** 取词 key（运行时再 t()，保证语言切换后即时生效） */
  labelKey: string;
}

const ITEMS: ReadonlyArray<MenuItem> = [
  { action: 'cancel', labelKey: 'pause.cancel' },
  { action: 'continue', labelKey: 'pause.continue' },
  { action: 'restart', labelKey: 'pause.restart' }
];

export class PauseScene extends Phaser.Scene {
  /** 键盘焦点索引 */
  private focusIndex = 0;
  /** 按键对象集合：{ action: GameObject } */
  private buttons: Phaser.GameObjects.Container[] = [];
  /** 背景木板 */
  private panel?: Phaser.GameObjects.Graphics;
  /** 已处理过选择，防止连点触发多次 */
  private chosen = false;

  constructor() {
    super(SCENE_KEYS.pause);
  }

  create(): void {
    installCameraFit(this, false);
    this.chosen = false;
    this.focusIndex = 0;
    this.buttons = [];

    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    // 全屏暗化遮罩（同时吞掉点击，避免穿透到下层游戏）
    const dim = this.add.graphics().setDepth(0);
    dim.fillStyle(0x000000, 0.55);
    dim.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );

    // 暂停面板
    const panelW = 300;
    const panelH = 260;
    const panelX = cx - panelW / 2;
    const panelY = cy - panelH / 2;

    this.panel = this.add.graphics().setDepth(1);
    // 阴影
    this.panel.fillStyle(0x000000, 0.45);
    this.panel.fillRoundedRect(panelX + 6, panelY + 8, panelW, panelH, 16);
    // 木板底色
    this.panel.fillStyle(0x4a2f18, 1);
    this.panel.fillRoundedRect(panelX, panelY, panelW, panelH, 16);
    // 内层深色
    this.panel.fillStyle(0x2b1a0d, 1);
    this.panel.fillRoundedRect(panelX + 6, panelY + 6, panelW - 12, panelH - 12, 12);
    // 金色描边
    this.panel.lineStyle(3, 0xc9a227, 0.9);
    this.panel.strokeRoundedRect(panelX, panelY, panelW, panelH, 16);

    // 标题
    this.add
      .text(cx, panelY + 34, t('pause.title'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '30px',
        color: '#ffe6a3',
        fontStyle: 'bold',
        stroke: '#1a0f06',
        strokeThickness: 5
      })
      .setOrigin(0.5)
      .setDepth(2);

    // 三个按键
    const btnW = 190;
    const btnH = 46;
    const gap = 14;
    const firstY = panelY + 86;

    ITEMS.forEach((item, i) => {
      const y = firstY + i * (btnH + gap);
      const container = this.createButton(
        cx,
        y,
        btnW,
        btnH,
        t(item.labelKey),
        item.action,
        i
      );
      this.buttons.push(container);
    });

    this.refreshFocus();

    // ---- 输入 ----
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.choose('cancel');
      });
      kb.on('keydown-P', () => this.choose('cancel'));
      kb.on('keydown-UP', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.moveFocus(-1);
      });
      kb.on('keydown-W', () => this.moveFocus(-1));
      kb.on('keydown-DOWN', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.moveFocus(1);
      });
      kb.on('keydown-S', () => this.moveFocus(1));
      kb.on('keydown-ENTER', () => this.choose(ITEMS[this.focusIndex].action));
      kb.on('keydown-SPACE', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.choose(ITEMS[this.focusIndex].action);
      });
    }

    // 阻止事件穿透到 GameScene，并吞掉页面滚动
    this.input.keyboard?.addCapture([
      Phaser.Input.Keyboard.KeyCodes.ESC,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.SPACE
    ]);

    // 场景关闭时解绑键盘监听，避免重开后叠加
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.removeAllListeners();
    });
  }

  /** 创建一个菜单按键 */
  private createButton(
    cx: number,
    y: number,
    w: number,
    h: number,
    label: string,
    action: MenuAction,
    index: number
  ): Phaser.GameObjects.Container {
    const container = this.add.container(cx, y).setDepth(2);

    const bg = this.add.graphics();
    bg.fillStyle(0x1d2b12, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
    bg.lineStyle(2, 0x6f8f3a, 1);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);

    // 高亮层（默认隐藏）
    const highlight = this.add.graphics();
    highlight.fillStyle(0x8fbe3a, 1);
    highlight.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
    highlight.lineStyle(3, 0xffe6a3, 1);
    highlight.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);
    highlight.setVisible(false);

    const text = this.add
      .text(0, 0, label, {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '22px',
        color: '#e8f3d0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    container.add([bg, highlight, text]);
    container.setSize(w, h);
    // Container 命中区以左上角为原点（输入系统会加 displayOrigin 再判定）。
    // 必须用 (0,0,w,h)，否则以中心为原点的矩形会让按钮的右/下缘与正中偏角
    // 落在判定边界之外，出现「点了没反应」。
    container.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, w, h),
      Phaser.Geom.Rectangle.Contains
    );

    container.on('pointerover', () => {
      this.focusIndex = index;
      this.refreshFocus();
    });
    container.on('pointerdown', () => {
      this.focusIndex = index;
      this.refreshFocus();
      this.choose(action);
    });

    // 把高亮层挂到容器上，供 refreshFocus 访问
    (container as unknown as { __highlight: Phaser.GameObjects.Graphics }).__highlight =
      highlight;

    return container;
  }

  /** 刷新高亮 */
  private refreshFocus(): void {
    this.buttons.forEach((c, i) => {
      const hl = (c as unknown as { __highlight?: Phaser.GameObjects.Graphics })
        .__highlight;
      if (hl) hl.setVisible(i === this.focusIndex);
    });
  }

  /** 上下切换焦点（循环） */
  private moveFocus(delta: number): void {
    const n = this.buttons.length;
    if (n === 0) return;
    this.focusIndex = (this.focusIndex + delta + n) % n;
    this.refreshFocus();
  }

  /** 执行菜单选择 */
  private choose(action: MenuAction): void {
    if (this.chosen) return;
    this.chosen = true;

    const gameScene = this.scene.get(SCENE_KEYS.game);

    // 先关闭自己
    this.scene.stop();

    if (!gameScene) return;

    if (action === 'cancel') {
      // 取消：回到游戏，恢复计时
      this.scene.resume(SCENE_KEYS.game);
      return;
    }

    // 继续（回主菜单）/ 重开：都重开一局
    // 本作没有独立主菜单，「继续」回到开局界面即等价于重开
    this.scene.stop(SCENE_KEYS.game);
    this.scene.start(SCENE_KEYS.game);
  }
}
