/**
 * BootScene：加载全部素材，缺失时生成同尺寸色块占位。
 * 加载完成后跳转 GameScene。
 */

import Phaser from 'phaser';
import {
  ASSET_PATHS,
  ASSET_KEYS,
  ASSET_SIZES,
  SCENE_KEYS,
  COLORS,
  GAME_WIDTH,
  GAME_HEIGHT
} from '../config';
import { t } from '../i18n';
import { SFX_DEFS, ALL_SFX_IDS } from '../data/sfx';
import { installCameraFit } from '../ui/cameraFit';
import { runtimeAssetPath, canLoadSvg } from '../platform/assets';
import { IS_MINIGAME } from '../platform/env';
import { ads } from '../platform/ads';

interface AssetDef {
  key: string;
  path: string;
  width: number;
  height: number;
  /** 占位色块颜色 */
  placeholderColor: number;
  /**
   * 素材格式。
   *
   * 主角僵尸改用了位图立绘（抠图后的 PNG），走 load.image；
   * 其余仍是矢量 SVG，走 load.svg 并指定渲染尺寸。
   */
  format?: 'svg' | 'png';
}

export class BootScene extends Phaser.Scene {
  /** 本局缺失的素材键，供调试查看 */
  static missingAssets: string[] = [];

  constructor() {
    super(SCENE_KEYS.boot);
  }

  preload(): void {
    // 小游戏画布是整块屏幕，加载界面也要按相机适配居中
    installCameraFit(this);
    this.buildLoadingUI();

    const defs: AssetDef[] = [
      {
        key: ASSET_KEYS.zombieIdle,
        path: ASSET_PATHS.zombieIdle,
        width: ASSET_SIZES.zombie.width,
        height: ASSET_SIZES.zombie.height,
        placeholderColor: 0x7d8f6a,
        format: 'png'
      },
      {
        // 啃食不再用单独素材：同一张立绘，靠动画区分动作。
        // 这里复用 idle 贴图，避免维护两张极易不同步的图。
        key: ASSET_KEYS.zombieEat,
        path: ASSET_PATHS.zombieIdle,
        width: ASSET_SIZES.zombie.width,
        height: ASSET_SIZES.zombie.height,
        placeholderColor: 0x8a9a6b,
        format: 'png'
      },
      {
        key: ASSET_KEYS.plantShooter,
        path: ASSET_PATHS.plantShooter,
        width: ASSET_SIZES.plant.width,
        height: ASSET_SIZES.plant.height,
        placeholderColor: 0x4caf50,
        format: 'png'
      },
      {
        key: ASSET_KEYS.plantWall,
        path: ASSET_PATHS.plantWall,
        width: ASSET_SIZES.plant.width,
        height: ASSET_SIZES.plant.height,
        placeholderColor: 0x8d6e63,
        format: 'png'
      },
      {
        key: ASSET_KEYS.plantSlow,
        path: ASSET_PATHS.plantSlow,
        width: ASSET_SIZES.plant.width,
        height: ASSET_SIZES.plant.height,
        placeholderColor: 0x64b5f6,
        // 冷雾苔用的是矢量立绘（assets/plant-slow.svg），必须走 load.svg，
        // 否则会被当位图加载而失败、退化成占位方块。
        format: 'svg'
      },
      {
        key: ASSET_KEYS.plantIce,
        path: ASSET_PATHS.plantIce,
        width: ASSET_SIZES.plant.width,
        height: ASSET_SIZES.plant.height,
        placeholderColor: 0x8a6ae8,
        format: 'png'
      },
      // ---- 植物分部件（骨骼式分层动画）----
      // 根 / 茎 / 头 三张分开的透明底图，由 PlantRig 拼装并驱动摆动。
      // width/height 只用于「素材缺失时生成同尺寸占位」，取各自的原始像素。
      {
        key: ASSET_KEYS.baseRoot,
        path: ASSET_PATHS.baseRoot,
        width: 1279,
        height: 576,
        placeholderColor: 0x6b8f3f,
        format: 'png'
      },
      {
        key: ASSET_KEYS.baseStem,
        path: ASSET_PATHS.baseStem,
        width: 894,
        height: 858,
        placeholderColor: 0x5a8f3a,
        format: 'png'
      },
      {
        key: ASSET_KEYS.baseHead,
        path: ASSET_PATHS.baseHead,
        width: 834,
        height: 877,
        placeholderColor: 0x4caf50,
        format: 'png'
      },
      {
        key: ASSET_KEYS.iceRoot,
        path: ASSET_PATHS.iceRoot,
        width: 1209,
        height: 519,
        placeholderColor: 0x4f7f9f,
        format: 'png'
      },
      {
        key: ASSET_KEYS.iceStem,
        path: ASSET_PATHS.iceStem,
        width: 868,
        height: 828,
        placeholderColor: 0x5a7fb0,
        format: 'png'
      },
      {
        key: ASSET_KEYS.iceHead,
        path: ASSET_PATHS.iceHead,
        width: 1216,
        height: 1147,
        placeholderColor: 0x64b5f6,
        format: 'png'
      },
      {
        // 宗门剑士：身体 / 手臂 / 剑 三张分开加载
        key: ASSET_KEYS.swordsmanBody,
        path: ASSET_PATHS.swordsmanBody,
        width: 160,
        height: 256,
        placeholderColor: 0x6b7f5a,
        format: 'png'
      },
      {
        key: ASSET_KEYS.swordsmanArm,
        path: ASSET_PATHS.swordsmanArm,
        width: 108,
        height: 192,
        placeholderColor: 0x8a9a6b,
        format: 'png'
      },
      {
        key: ASSET_KEYS.swordsmanSword,
        path: ASSET_PATHS.swordsmanSword,
        width: 51,
        height: 96,
        placeholderColor: 0xd8d8e8,
        format: 'png'
      },
      {
        key: ASSET_KEYS.bullet,
        path: ASSET_PATHS.bullet,
        width: ASSET_SIZES.bullet.width,
        height: ASSET_SIZES.bullet.height,
        placeholderColor: 0xffe082
      },
      {
        key: ASSET_KEYS.houseTile,
        path: ASSET_PATHS.houseTile,
        width: ASSET_SIZES.tile.width,
        height: ASSET_SIZES.tile.height,
        placeholderColor: COLORS.house
      },
      {
        key: ASSET_KEYS.grassTile,
        path: ASSET_PATHS.grassTile,
        width: ASSET_SIZES.tile.width,
        height: ASSET_SIZES.tile.height,
        placeholderColor: 0x2e4a34
      },

      // ---- 分部件立绘 ----
      // 每张都按原始像素加载，显示尺寸由 ZOMBIE_PART_LAYOUT 决定。
      // 占位色块取接近僵尸肤色的绿，缺图时能一眼看出丢了哪块。
      {
        key: ASSET_KEYS.partHead,
        path: ASSET_PATHS.partHead,
        width: 520,
        height: 430,
        placeholderColor: 0x7d8f6a,
        format: 'png'
      },
      {
        key: ASSET_KEYS.partTorso,
        path: ASSET_PATHS.partTorso,
        width: 628,
        height: 1150,
        placeholderColor: 0x6f8260,
        format: 'png'
      },
      {
        key: ASSET_KEYS.partArmL,
        path: ASSET_PATHS.partArmL,
        width: 232,
        height: 1150,
        placeholderColor: 0x778a64,
        format: 'png'
      },
      {
        key: ASSET_KEYS.partArmR,
        path: ASSET_PATHS.partArmR,
        width: 182,
        height: 1150,
        placeholderColor: 0x778a64,
        format: 'png'
      },
      {
        key: ASSET_KEYS.partLegL,
        path: ASSET_PATHS.partLegL,
        width: 495,
        height: 821,
        placeholderColor: 0x657754,
        format: 'png'
      },
      {
        key: ASSET_KEYS.partLegR,
        path: ASSET_PATHS.partLegR,
        width: 480,
        height: 821,
        placeholderColor: 0x657754,
        format: 'png'
      },

      // ---- 道具图标（掉落 / 商店 / 手持）----
      {
        key: ASSET_KEYS.itemIronPlate,
        path: ASSET_PATHS.itemIronPlate,
        width: ASSET_SIZES.itemIronPlate.width,
        height: ASSET_SIZES.itemIronPlate.height,
        placeholderColor: 0x9aa7b4,
        format: 'png'
      },
      {
        key: ASSET_KEYS.itemBoots,
        path: ASSET_PATHS.itemBoots,
        width: ASSET_SIZES.itemBoots.width,
        height: ASSET_SIZES.itemBoots.height,
        placeholderColor: 0xc9873f,
        format: 'png'
      },
      {
        key: ASSET_KEYS.itemChainsaw,
        path: ASSET_PATHS.itemChainsaw,
        width: ASSET_SIZES.itemChainsaw.width,
        height: ASSET_SIZES.itemChainsaw.height,
        placeholderColor: 0xd94b4b,
        format: 'png'
      },
      {
        key: ASSET_KEYS.itemBouncingOrb,
        path: ASSET_PATHS.itemBouncingOrb,
        width: ASSET_SIZES.itemBouncingOrb.width,
        height: ASSET_SIZES.itemBouncingOrb.height,
        placeholderColor: 0x9b6bf2,
        format: 'png'
      },
      {
        key: ASSET_KEYS.itemBoomerang,
        path: ASSET_PATHS.itemBoomerang,
        width: ASSET_SIZES.itemBoomerang.width,
        height: ASSET_SIZES.itemBoomerang.height,
        placeholderColor: 0xe0c07a,
        format: 'png'
      },
      // ---- 锯子分部件（手持电锯，链子动态滚动）----
      {
        key: ASSET_KEYS.sawBody,
        path: ASSET_PATHS.sawBody,
        width: ASSET_SIZES.sawBody.width,
        height: ASSET_SIZES.sawBody.height,
        placeholderColor: 0x8a3b3b,
        format: 'png'
      },
      {
        key: ASSET_KEYS.sawChain,
        path: ASSET_PATHS.sawChain,
        width: ASSET_SIZES.sawChain.width,
        height: ASSET_SIZES.sawChain.height,
        placeholderColor: 0xb0b0b8,
        format: 'png'
      },
      {
        key: ASSET_KEYS.sawMount,
        path: ASSET_PATHS.sawMount,
        width: ASSET_SIZES.sawMount.width,
        height: ASSET_SIZES.sawMount.height,
        placeholderColor: 0x6f6f78,
        format: 'png'
      }
    ];

    // 逐个加载；失败时记录，稍后生成占位。
    //
    // 小游戏环境没有 DOMParser，load.svg 会失败；构建时已把 SVG 栅格化成
    // 同名 PNG，这里按平台选加载器与路径。
    for (const def of defs) {
      const path = runtimeAssetPath(def.path);
      if (def.format === 'png' || !canLoadSvg()) {
        // 位图按原始分辨率加载，显示尺寸交给 setDisplaySize 决定，
        // 这样缩放时不会因为加载期重采样而损失细节。
        this.load.image(def.key, path);
      } else {
        this.load.svg(def.key, path, {
          width: def.width,
          height: def.height
        });
      }
    }

    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      BootScene.missingAssets.push(file.key);
    });

    // ---- 音效 ----
    // Web：音频体积小，随开局一并加载；加载失败不影响游戏。
    // 小游戏：Phaser 音频通道不可用，音效由 InnerAudioContext 直接按路径播放，
    // 不走 Loader（也避免加载器去 decode ogg）。
    if (!IS_MINIGAME) {
      for (const id of ALL_SFX_IDS) {
        const def = SFX_DEFS[id];
        if (!def) continue;
        this.load.audio(def.key, def.file);
      }
    }

    // 加载完成后：为失败的素材生成同尺寸色块
    this.load.once('complete', () => {
      for (const def of defs) {
        if (!this.textures.exists(def.key)) {
          this.createPlaceholder(def);
        }
      }
    });
  }

  /** 生成同尺寸色块占位贴图 */
  private createPlaceholder(def: AssetDef): void {
    // TODO: replace asset —— 该素材文件缺失，当前使用纯色块占位
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.placeholderColor, 1);
    g.fillRect(0, 0, def.width, def.height);
    g.lineStyle(2, 0x000000, 0.45);
    g.strokeRect(1, 1, def.width - 2, def.height - 2);
    g.generateTexture(def.key, def.width, def.height);
    g.destroy();
  }

  /** 简易加载进度条 */
  private buildLoadingUI(): void {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    const title = this.add
      .text(cx, cy - 60, t('boot.title'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '42px',
        color: '#e8eef4',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    const barW = 320;
    const barH = 8;
    const bg = this.add.graphics();
    bg.fillStyle(0x1b2430, 1);
    bg.fillRect(cx - barW / 2, cy, barW, barH);

    const fill = this.add.graphics();
    const label = this.add
      .text(cx, cy + 30, t('boot.loading'), {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: '14px',
        color: '#8fa8b8'
      })
      .setOrigin(0.5);

    this.load.on('progress', (p: number) => {
      fill.clear();
      fill.fillStyle(0x4fd1e0, 1);
      fill.fillRect(cx - barW / 2, cy, barW * p, barH);
    });

    this.load.once('complete', () => {
      fill.destroy();
      bg.destroy();
      label.destroy();
      title.destroy();
    });
  }

  create(): void {
    // Portal（Poki）要求资源加载结束后上报，广告平台才知道可以开始投放
    ads.loadingFinished();

    if (BootScene.missingAssets.length > 0) {
      // 缺失素材已用色块替代，控制台提示便于排查
      console.warn(
        '[BootScene] 以下素材缺失，已使用色块占位:',
        BootScene.missingAssets.join(', ')
      );
    }

    this.scene.start(SCENE_KEYS.game);
  }
}
