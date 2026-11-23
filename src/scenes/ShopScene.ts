/**
 * ShopScene：尸币商店。
 *
 * 与 PauseScene 同样以「覆盖层」方式叠加在 GameScene 之上：
 *   GameScene.scene.pause() 冻住游戏 → 本场景 scene.launch() 打开 → 关闭时 resume。
 * 这样不需要在 GameScene 到处加 if(paused)，计时、生成、碰撞全部自动停止。
 *
 * 职责划分（重要）：
 *   - 本场景 **只负责 UI 与交互**：展示商品、处理点击/键盘、更新余额显示。
 *   - 「扣币 + 施加增益」这些游戏逻辑由 GameScene 通过传入的 purchase 回调完成。
 *     => 商店永远不直接改玩家状态，避免出现两套扣币/加血逻辑不同步。
 *
 * 交互：
 *   - 鼠标：悬停高亮，点击卡片即购买
 *   - 键盘：↑/↓（或 W/S）切换，Enter/Space 购买，Esc 关闭
 *   - 余额不足 / 已拥有（不可重复）：卡片置灰、点击无效并提示
 */

import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, SCENE_KEYS, COLORS } from '../config';
import type { ShopItem } from '../data/shop';
import { t, tf } from '../i18n';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';
import { IS_TOUCH } from '../platform/env';

/** GameScene 注入到商店的运行时状态与回调 */
export interface ShopSceneData {
  /** 打开商店时的尸币余额 */
  coins: number;
  /** 商品列表 */
  items: ReadonlyArray<ShopItem>;
  /** 道具页商品列表（第二页：可购买并立即激活的道具） */
  itemOffers?: ReadonlyArray<ShopItem>;
  /** 超级商店：永久成长，未满级时显示但锁定 */
  superItems?: ReadonlyArray<ShopItem>;
  /** 已拥有的「不可重复」商品 id 集合 */
  owned: ReadonlyArray<string>;
  /**
   * 购买回调：由 GameScene 实现「校验→扣币→应用效果」。
   * 返回最新余额与已拥有列表，商店据此刷新。
   */
  purchase: (item: ShopItem) => {
    ok: boolean;
    coins: number;
    owned: ReadonlyArray<string>;
    reason?: string;
    /** 购买后若商品列表变化（如价格刷新），返回新列表以重建界面 */
    items?: ShopItem[];
    /** 超级商店页的最新列表（可能从锁定变为解锁） */
    superItems?: ShopItem[];
  };
  /** 关闭回调（用于 GameScene 恢复计时等） */
  onClose: () => void;
}

/** 单张商品卡片内部的引用集合 */
interface CardView {
  item: ShopItem;
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Graphics;
  highlight: Phaser.GameObjects.Graphics;
  priceText: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
}

export class ShopScene extends Phaser.Scene {
  private shopData!: ShopSceneData;

  /** 焦点索引 */
  private focusIndex = 0;
  /** 卡片视图（与 items 一一对应） */
  private cards: CardView[] = [];
  /** 已在关闭流程中，防止重复触发 */
  private closing = false;

  /**
   * 分页数据：page 0 = 增益，page 1 = 道具（可选）。
   * 每页是一份独立的商品列表；切换页时重建卡片。
   */
  private pages: ShopItem[][] = [];
  /** 与 pages 对应的标签文字 */
  private pageLabels: string[] = [];
  /** 当前页索引 */
  private activePage = 0;
  /** 标签页按钮（用于高亮） */
  private tabButtons: Array<{ bg: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text; index: number }> = [];
  /** 列表区布局参数（重建卡片时复用） */
  private listLayout = { x: 0, top: 0, w: 0, h: 0, gap: 8 };

  /** 顶部余额文本 */
  private balanceText?: Phaser.GameObjects.Text;
  /** 短暂提示（购买失败原因） */
  private toast?: Phaser.GameObjects.Text;

  constructor() {
    super(SCENE_KEYS.shop);
  }

  init(data: ShopSceneData): void {
    this.shopData = data;
  }

  create(): void {
    installCameraFit(this, false);
    this.closing = false;
    this.focusIndex = 0;
    this.cards = [];
    this.activePage = 0;
    this.tabButtons = [];

    // 分页：增益 → 道具（可选）→ 超级商店
    this.pages = [[...this.shopData.items]];
    this.pageLabels = [t('shop.tab.buff')];
    if (this.shopData.itemOffers && this.shopData.itemOffers.length > 0) {
      this.pages.push([...this.shopData.itemOffers]);
      this.pageLabels.push(t('shop.tab.item'));
    }
    if (this.shopData.superItems && this.shopData.superItems.length > 0) {
      this.pages.push([...this.shopData.superItems]);
      this.pageLabels.push(t('shop.tab.super'));
    }

    const cx = GAME_WIDTH / 2;

    // ---- 全屏暗化遮罩（吞掉点击，避免穿透到下层游戏）----
    const dim = this.add.graphics().setDepth(0);
    dim.fillStyle(0x000000, 0.62);
    dim.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );

    // ---- 主面板 ----
    const panelW = 560;
    const panelH = 620;
    const panelX = cx - panelW / 2;
    const panelY = (GAME_HEIGHT - panelH) / 2;

    const panel = this.add.graphics().setDepth(1);
    // 投影
    panel.fillStyle(0x000000, 0.45);
    panel.fillRoundedRect(panelX + 6, panelY + 8, panelW, panelH, 18);
    // 外框木色
    panel.fillStyle(0x2a1d33, 1);
    panel.fillRoundedRect(panelX, panelY, panelW, panelH, 18);
    // 内层深色
    panel.fillStyle(0x140f1c, 1);
    panel.fillRoundedRect(panelX + 6, panelY + 6, panelW - 12, panelH - 12, 14);
    // 金边
    panel.lineStyle(3, 0xc9a227, 0.95);
    panel.strokeRoundedRect(panelX, panelY, panelW, panelH, 18);

    // ---- 标题 ----
    this.add
      .text(panelX + 28, panelY + 22, t('shop.title'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '30px',
        color: '#ffe6a3',
        fontStyle: 'bold',
        stroke: '#1a0f06',
        strokeThickness: 5
      })
      .setDepth(2);

    // ---- 余额（右上）----
    this.balanceText = this.add
      .text(panelX + panelW - 60, panelY + 30, '', {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '20px',
        color: COLORS.coin,
        fontStyle: 'bold'
      })
      .setOrigin(1, 0)
      .setDepth(2);
    this.updateBalance(this.shopData.coins);

    // ---- 关闭按钮（右上角 ×）----
    this.createCloseButton(panelX + panelW - 30, panelY + 32);

    // ---- 分页标签（仅当有第二页时显示）----
    const hasTwoPages = this.pages.length > 1;
    if (hasTwoPages) {
      // 标签放左侧，给右上角的余额留出空间（否则「道具」会和「尸币 N」叠在一起）
      this.createTabs(panelX + 170, panelY + 30);
    }

    // ---- 商品卡片列表 ----
    const listX = panelX + 28;
    // 有标签时列表整体下移，给标签腾位置
    const listTop = panelY + (hasTwoPages ? 110 : 78);
    const cardW = panelW - 56;
    const cardH = 56;
    const gap = 5;

    this.listLayout = { x: listX, top: listTop, w: cardW, h: cardH, gap };

    this.buildCurrentPageCards();

    // ---- 底部提示 ----
    this.add
      .text(cx, panelY + panelH - 22, IS_TOUCH ? t('shop.hintTouch') : t('shop.hint'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '14px',
        color: COLORS.textDim
      })
      .setOrigin(0.5, 0.5)
      .setDepth(2);

    // ---- 购买失败 / 成功提示（默认隐藏）----
    this.toast = this.add
      .text(cx, panelY + panelH - 48, '', {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '15px',
        color: '#ff7b7b',
        fontStyle: 'bold'
      })
      .setOrigin(0.5, 0.5)
      .setDepth(3)
      .setAlpha(0);

    this.refreshAll();

    // ---- 键盘 ----
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-ESC', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.close();
      });
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
      kb.on('keydown-ENTER', () => this.tryBuy(this.focusIndex));
      kb.on('keydown-SPACE', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        this.tryBuy(this.focusIndex);
      });
      // Tab：在「增益 / 道具」页之间切换
      kb.on('keydown-TAB', (e: KeyboardEvent) => {
        e?.preventDefault?.();
        if (this.pages.length > 1) {
          sfx.play('uiClick');
          this.switchPage((this.activePage + 1) % this.pages.length);
        }
      });
      kb.addCapture([
        Phaser.Input.Keyboard.KeyCodes.ESC,
        Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN,
        Phaser.Input.Keyboard.KeyCodes.SPACE,
        Phaser.Input.Keyboard.KeyCodes.TAB
      ]);
    }

    // 场景关闭时解绑键盘监听，避免重开后叠加
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.removeAllListeners();
    });
  }

  // ------------------------------------------------------------ 卡片

  /** 创建一张商品卡片 */
  private createCard(
    x: number,
    y: number,
    w: number,
    h: number,
    item: ShopItem,
    index: number
  ): CardView {
    const container = this.add.container(x, y).setDepth(2);

    // 卡片底
    const bg = this.add.graphics();
    bg.fillStyle(0x0e1a14, 1);
    bg.fillRoundedRect(0, -h / 2, w, h, 10);
    bg.lineStyle(2, item.accent, 0.7);
    bg.strokeRoundedRect(0, -h / 2, w, h, 10);

    // 高亮层（选中时显示）
    const highlight = this.add.graphics();
    highlight.fillStyle(item.accent, 0.13);
    highlight.fillRoundedRect(0, -h / 2, w, h, 10);
    highlight.lineStyle(3, 0xffe6a3, 1);
    highlight.strokeRoundedRect(0, -h / 2, w, h, 10);
    highlight.setVisible(false);

    // 名称
    const name = this.add
      .text(16, -h / 2 + 10, item.name, {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '19px',
        color: '#f2f7ff',
        fontStyle: 'bold'
      })
      .setOrigin(0, 0);

    // 描述
    const desc = this.add
      .text(16, -h / 2 + 36, item.desc, {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '13px',
        color: COLORS.textDim
      })
      .setOrigin(0, 0);

    // 价格（右侧）
    const priceText = this.add
      .text(w - 16, -h / 2 + 12, tf('shop.price', { n: item.price }), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '17px',
        color: COLORS.coin,
        fontStyle: 'bold'
      })
      .setOrigin(1, 0);

    // 状态/购买按钮提示（右侧下方）
    const statusText = this.add
      .text(w - 16, -h / 2 + 38, t('shop.buy'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '14px',
        color: '#8fe388',
        fontStyle: 'bold'
      })
      .setOrigin(1, 0);

    container.add([bg, highlight, name, desc, priceText, statusText]);

    // 点击区域：Container 的 input 判定会叠加上 displayOrigin，
    // 卡片内容是以左端为原点绘制的，命中区要右移 w/2 才和视觉重合。
    container.setSize(w, h);
    container.setInteractive(
      new Phaser.Geom.Rectangle(w / 2, -h / 2, w, h),
      Phaser.Geom.Rectangle.Contains
    );
    container.on('pointerover', () => {
      this.focusIndex = index;
      this.refreshAll();
    });
    container.on('pointerdown', () => {
      sfx.play('uiClick');
      this.focusIndex = index;
      this.refreshAll();
      this.tryBuy(index);
    });

    return { item, container, bg, highlight, priceText, statusText };
  }

  /** 创建右上角关闭按钮 */
  private createCloseButton(x: number, y: number): void {
    const c = this.add.container(x, y).setDepth(3);
    const g = this.add.graphics();
    g.fillStyle(0x3a1d1d, 1);
    g.fillCircle(0, 0, 15);
    g.lineStyle(2, 0xff7b7b, 0.9);
    g.strokeCircle(0, 0, 15);
    const t = this.add
      .text(0, 0, '×', {
        fontFamily: '"Microsoft YaHei", sans-serif',
        fontSize: '22px',
        color: '#ffd0d0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    c.add([g, t]);
    c.setSize(30, 30);
    // Container 命中区以左上角为原点（输入系统会加 displayOrigin 再判定）。
    // 必须用 (0,0,w,h)，否则以中心为原点的 (-15,-15,30,30) 会让按钮正中落在
    // 判定边界之外，点击看似无反应。
    c.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, 30, 30),
      Phaser.Geom.Rectangle.Contains
    );
    c.on('pointerover', () => t.setColor('#ffffff'));
    c.on('pointerout', () => t.setColor('#ffd0d0'));
    c.on('pointerdown', () => this.close());
  }

  // ------------------------------------------------------------ 分页标签

  /** 创建页签（增益 / 道具 / 超级商店） */
  private createTabs(x: number, y: number): void {
    const labels = this.pageLabels;
    const tabW = 82;
    const tabH = 30;
    const gap = 8;

    labels.slice(0, this.pages.length).forEach((text, i) => {
      const bg = this.add.graphics().setDepth(2);
      const tx = x + i * (tabW + gap);
      const label = this.add
        .text(tx + tabW / 2, y + tabH / 2, text, {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: '16px',
          color: '#cfd8e3',
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
        .setDepth(3);

      const draw = () => {
        bg.clear();
        const active = i === this.activePage;
        bg.fillStyle(active ? 0xc9a227 : 0x241a2e, active ? 0.95 : 0.9);
        bg.fillRoundedRect(tx, y, tabW, tabH, 8);
        bg.lineStyle(2, active ? 0xffe6a3 : 0x5a4a2a, 0.9);
        bg.strokeRoundedRect(tx, y, tabW, tabH, 8);
        label.setColor(active ? '#241708' : '#cfd8e3');
      };
      draw();

      // 用不可见的交互矩形接收点击
      const hit = this.add
        .zone(tx + tabW / 2, y + tabH / 2, tabW, tabH)
        .setInteractive({ useHandCursor: true })
        .setDepth(3);
      hit.on('pointerdown', () => {
        sfx.play('uiClick');
        this.switchPage(i);
      });

      this.tabButtons.push({ bg, label, index: i });
      // 保存 draw 供切页时刷新高亮
      (bg as Phaser.GameObjects.Graphics & { redraw?: () => void }).redraw = draw;
    });
  }

  /** 切换页签 */
  private switchPage(index: number): void {
    if (index === this.activePage) return;
    if (index < 0 || index >= this.pages.length) return;
    this.activePage = index;
    this.focusIndex = 0;
    this.buildCurrentPageCards();
    this.refreshTabs();
  }

  /** 刷新所有标签高亮 */
  private refreshTabs(): void {
    for (const t of this.tabButtons) {
      const bg = t.bg as Phaser.GameObjects.Graphics & { redraw?: () => void };
      bg.redraw?.();
    }
  }

  /** 用当前页数据重建卡片 */
  private buildCurrentPageCards(): void {
    for (const card of this.cards) {
      card.container.destroy();
    }
    this.cards = [];

    const items = this.pages[this.activePage] ?? [];
    const { x, top, w, h, gap } = this.listLayout;

    items.forEach((item, i) => {
      const y = top + i * (h + gap) + h / 2;
      this.cards.push(this.createCard(x, y, w, h, item, i));
    });

    if (this.focusIndex >= this.cards.length) this.focusIndex = 0;
    this.refreshAll();
  }

  // ------------------------------------------------------------ 状态

  /** 是否已拥有（不可重复商品买过即为 true） */
  private isOwned(item: ShopItem): boolean {
    if (item.repeatable) return false;
    return this.shopData.owned.includes(item.id);
  }

  /** 刷新所有卡片 + 余额显示 */
  private refreshAll(): void {
    this.cards.forEach((card, i) => {
      const selected = i === this.focusIndex;
      card.highlight.setVisible(selected);

      const owned = this.isOwned(card.item);
      const affordable = this.shopData.coins >= card.item.price;
      const locked = card.item.locked === true;

      let statusStr: string;
      let statusColor: string;
      if (locked) {
        statusStr = t('shop.locked');
        statusColor = '#d3b46a';
      } else if (owned) {
        statusStr = t('shop.owned');
        statusColor = '#8fa8b8';
      } else if (!affordable) {
        statusStr = t('shop.notEnough');
        statusColor = '#ff8f8f';
      } else {
        statusStr = selected ? t('shop.buyHighlight') : t('shop.buy');
        statusColor = '#8fe388';
      }
      card.statusText.setText(statusStr).setColor(statusColor);

      // 不可购买时整卡降透明度，突出「灰掉」
      const dimmed = locked || owned || !affordable;
      card.container.setAlpha(dimmed ? 0.55 : 1);
    });
  }

  private updateBalance(coins: number): void {
    this.balanceText?.setText(tf('shop.balance', { n: coins }));
  }

  // ------------------------------------------------------------ 交互

  private moveFocus(delta: number): void {
    const n = this.cards.length;
    if (n === 0) return;
    this.focusIndex = (this.focusIndex + delta + n) % n;
    this.refreshAll();
  }

  /** 尝试购买指定索引的商品 */
  private tryBuy(index: number): void {
    const card = this.cards[index];
    if (!card) return;
    this.focusIndex = index;

    if (card.item.locked) {
      this.showToast(t('shop.toast.locked'));
      this.refreshAll();
      return;
    }
    if (this.isOwned(card.item)) {
      this.showToast(t('shop.toast.owned'));
      this.refreshAll();
      return;
    }
    if (this.shopData.coins < card.item.price) {
      this.showToast(t('shop.toast.notEnough'));
      this.refreshAll();
      return;
    }

    // 交给 GameScene 真正扣币 + 应用效果
    const res = this.shopData.purchase(card.item);
    this.shopData.coins = res.coins;
    this.shopData.owned = res.owned;
    this.updateBalance(res.coins);

    if (!res.ok) {
      sfx.play('uiClose');
      this.showToast(res.reason ?? t('shop.toast.failed'));
      this.refreshAll();
      return;
    }

    this.showToast(tf('shop.toast.bought', { name: card.item.name }), '#8fe388');
    sfx.play('uiBuy');

    // 进化到满级后，超级商店页立即从锁定变为可购买
    if (res.superItems) {
      const superPage = this.pageLabels.indexOf(t('shop.tab.super'));
      if (superPage >= 0) this.pages[superPage] = [...res.superItems];
    }

    // 满级成长商品：价格会随购买刷新，需重建卡片列表
    if (res.items && res.items.length) {
      this.rebuildCards(res.items);
    } else {
      this.refreshAll();
    }
  }

  /**
   * 用新的商品列表重建卡片（用于满级后价格动态变化）。
   *
   * 销毁旧卡片容器后按新列表重建，并尽量保持原索引位置的焦点。
   */
  private rebuildCards(items: ShopItem[]): void {
    for (const card of this.cards) {
      card.container.destroy();
    }
    this.cards = [];

    if (this.activePage === 0) this.shopData.items = items;
    this.pages[this.activePage] = items;

    const { x, top, w, h, gap } = this.listLayout;

    items.forEach((item, i) => {
      const y = top + i * (h + gap) + h / 2;
      const card = this.createCard(x, y, w, h, item, i);
      this.cards.push(card);
    });

    if (this.focusIndex >= this.cards.length) this.focusIndex = 0;
    this.refreshAll();
  }

  /** 短暂提示 */
  private showToast(text: string, color = '#ff7b7b'): void {
    if (!this.toast) return;
    this.toast.setText(text).setColor(color).setAlpha(1);
    this.tweens.killTweensOf(this.toast);
    this.tweens.add({
      targets: this.toast,
      alpha: 0,
      delay: 700,
      duration: 400
    });
  }

  /** 关闭商店并恢复游戏 */
  private close(): void {
    if (this.closing) return;
    this.closing = true;
    sfx.play('uiClose');
    try {
      this.shopData?.onClose?.();
    } catch {
      /* 关闭回调异常不应阻止场景关闭 */
    }
    this.scene.stop();
  }
}
