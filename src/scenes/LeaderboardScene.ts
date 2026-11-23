import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, COLORS, SCENE_KEYS } from '../config';
import { formatTime } from '../utils';
import { t } from '../i18n';
import { sfx } from '../platform/sfx';
import { installCameraFit } from '../ui/cameraFit';
import {
  getFriendLeaderboard,
  getGlobalLeaderboard,
  getLocalLeaderboard,
  type LeaderboardData,
  type LeaderboardKind
} from '../platform/leaderboard';
import type { LeaderboardEntry } from '../platform/storage';

const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

interface TabDef {
  kind: LeaderboardKind;
  labelKey: string;
}

const TABS: TabDef[] = [
  { kind: 'friends', labelKey: 'leaderboard.tab.friends' },
  { kind: 'global', labelKey: 'leaderboard.tab.global' },
  { kind: 'local', labelKey: 'leaderboard.tab.local' }
];

/**
 * 排行榜框架页。
 *
 * 现在可以直接看本机 Top10；好友/全服页已接好数据层接口，
 * 后续配置开放数据域或 LEADERBOARD.apiBaseUrl 即可显示真实数据。
 */
export class LeaderboardScene extends Phaser.Scene {
  private activeTab = 0;
  private rows?: Phaser.GameObjects.Container;
  private emptyText?: Phaser.GameObjects.Text;
  private tabBgs: Phaser.GameObjects.Graphics[] = [];
  private loading = false;

  constructor() {
    super(SCENE_KEYS.leaderboard);
  }

  create(): void {
    installCameraFit(this, false);
    this.activeTab = 0;
    this.rows = undefined;
    this.emptyText = undefined;
    this.tabBgs = [];
    this.loading = false;

    const cx = GAME_WIDTH / 2;
    const panelW = 560;
    const panelH = 640;
    const panelX = cx - panelW / 2;
    const panelY = (GAME_HEIGHT - panelH) / 2;

    const dim = this.add.graphics().setDepth(0);
    dim.fillStyle(0x000000, 0.7);
    dim.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT),
      Phaser.Geom.Rectangle.Contains
    );

    const panel = this.add.graphics().setDepth(1);
    panel.fillStyle(0x000000, 0.4);
    panel.fillRoundedRect(panelX + 6, panelY + 8, panelW, panelH, 18);
    panel.fillStyle(0x1a1420, 1);
    panel.fillRoundedRect(panelX, panelY, panelW, panelH, 18);
    panel.lineStyle(3, 0xc9a227, 0.9);
    panel.strokeRoundedRect(panelX, panelY, panelW, panelH, 18);

    this.add
      .text(cx, panelY + 36, t('leaderboard.title'), {
        fontFamily: FONT,
        fontSize: '30px',
        color: '#ffe6a3',
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setDepth(2);

    // 关闭按钮
    const close = this.add
      .text(panelX + panelW - 28, panelY + 30, '×', {
        fontFamily: FONT,
        fontSize: '30px',
        color: '#ffb0b0',
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setDepth(3)
      .setInteractive({ useHandCursor: true });
    close.on('pointerdown', () => this.close());
    this.input.keyboard?.on('keydown-ESC', () => this.close());

    // 页签
    const tabW = 150;
    const tabH = 38;
    const tabGap = 10;
    const tabsX = cx - (tabW * TABS.length + tabGap * (TABS.length - 1)) / 2;
    TABS.forEach((tab, i) => {
      const x = tabsX + i * (tabW + tabGap);
      const bg = this.add.graphics().setDepth(2);
      this.tabBgs.push(bg);
      const label = this.add
        .text(x + tabW / 2, panelY + 92, t(tab.labelKey), {
          fontFamily: FONT,
          fontSize: '17px',
          color: '#e8f3d0',
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
        .setDepth(3);
      const zone = this.add
        .zone(x + tabW / 2, panelY + 92, tabW, tabH)
        .setInteractive({ useHandCursor: true })
        .setDepth(3);
      zone.on('pointerdown', () => {
        sfx.play('uiClick');
        this.switchTab(i);
      });
      // 用 bg 画页签底
      (bg as Phaser.GameObjects.Graphics & { __label?: Phaser.GameObjects.Text })
        .__label = label;
      (bg as Phaser.GameObjects.Graphics & { __x?: number }).__x = x;
    });

    this.emptyText = this.add
      .text(cx, panelY + panelH / 2 + 40, '', {
        fontFamily: FONT,
        fontSize: '17px',
        color: COLORS.textDim,
        align: 'center',
        wordWrap: { width: panelW - 80 }
      })
      .setOrigin(0.5)
      .setDepth(2);

    this.add
      .text(cx, panelY + panelH - 26, t('leaderboard.hint'), {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#5f7386'
      })
      .setOrigin(0.5)
      .setDepth(2);

    this.refreshTabs();
    void this.loadTab(TABS[this.activeTab].kind);
  }

  private switchTab(index: number): void {
    if (index === this.activeTab) return;
    this.activeTab = index;
    this.refreshTabs();
    void this.loadTab(TABS[index].kind);
  }

  private refreshTabs(): void {
    const panelW = 560;
    const panelX = GAME_WIDTH / 2 - panelW / 2;
    const tabW = 150;
    const tabGap = 10;
    const tabsX =
      GAME_WIDTH / 2 - (tabW * TABS.length + tabGap * (TABS.length - 1)) / 2;
    this.tabBgs.forEach((bg, i) => {
      const x = tabsX + i * (tabW + tabGap);
      const active = i === this.activeTab;
      bg.clear();
      bg.fillStyle(active ? 0xc9a227 : 0x241a2e, active ? 0.95 : 0.9);
      bg.fillRoundedRect(x, (GAME_HEIGHT - 640) / 2 + 73, tabW, 38, 9);
      bg.lineStyle(2, active ? 0xffe6a3 : 0x5a4a2a, 0.9);
      bg.strokeRoundedRect(x, (GAME_HEIGHT - 640) / 2 + 73, tabW, 38, 9);
      const label = (
        bg as Phaser.GameObjects.Graphics & {
          __label?: Phaser.GameObjects.Text;
        }
      ).__label;
      label?.setColor(active ? '#241708' : '#cfd8e3');
    });
  }

  private async loadTab(kind: LeaderboardKind): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.clearRows();
    this.emptyText?.setText(t('leaderboard.loading')).setVisible(true);

    let data: LeaderboardData;
    try {
      if (kind === 'friends') data = await getFriendLeaderboard();
      else if (kind === 'global') data = await getGlobalLeaderboard();
      else data = getLocalLeaderboard();
    } catch {
      data = { kind, entries: [], unavailable: true };
    }

    if (!this.scene.isActive()) return;
    this.loading = false;
    this.renderData(data);
  }

  private renderData(data: LeaderboardData): void {
    this.clearRows();
    const entries: LeaderboardEntry[] = data.entries.slice(0, 10);
    if (entries.length === 0) {
      const msg =
        data.kind === 'friends'
          ? t('leaderboard.empty.friends')
          : data.kind === 'global'
            ? t('leaderboard.empty.global')
            : t('leaderboard.empty.local');
      this.emptyText?.setText(msg).setVisible(true);
      return;
    }

    this.emptyText?.setVisible(false);
    const panelW = 560;
    const panelX = GAME_WIDTH / 2 - panelW / 2;
    const panelY = (GAME_HEIGHT - 640) / 2;
    const rowX = panelX + 34;
    const rowW = panelW - 68;
    const rowH = 42;
    const top = panelY + 140;

    this.rows = this.add.container(0, 0).setDepth(2);
    entries.forEach((entry, i) => {
      const y = top + i * rowH;
      const g = this.add.graphics();
      g.fillStyle(i % 2 === 0 ? 0x241a2e : 0x1e1627, 0.95);
      g.fillRoundedRect(rowX, y, rowW, rowH - 4, 8);
      this.rows?.add(g);

      const rank = this.add
        .text(rowX + 18, y + (rowH - 4) / 2, `${i + 1}`, {
          fontFamily: FONT,
          fontSize: '18px',
          color: i < 3 ? '#ffd84a' : '#9fb4c8',
          fontStyle: 'bold'
        })
        .setOrigin(0.5);
      this.rows?.add(rank);

      const name = this.add
        .text(rowX + 46, y + (rowH - 4) / 2, entry.name, {
          fontFamily: FONT,
          fontSize: '17px',
          color: entry.isMe ? '#8fe388' : '#e8eef4'
        })
        .setOrigin(0, 0.5);
      this.rows?.add(name);

      const time = this.add
        .text(rowX + rowW - 18, y + (rowH - 4) / 2, formatTime(entry.timeMs), {
          fontFamily: FONT,
          fontSize: '17px',
          color: '#7fe3ff',
          fontStyle: 'bold'
        })
        .setOrigin(1, 0.5);
      this.rows?.add(time);
    });
  }

  private clearRows(): void {
    this.rows?.destroy(true);
    this.rows = undefined;
  }

  private close(): void {
    sfx.play('uiClose');
    this.scene.stop();
  }
}
