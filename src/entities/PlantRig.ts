/**
 * PlantRig —— 植物的「骨骼式」分层渲染器。
 *
 * 与 ZombieRig 同一个思路，但更简单：植物只有三块。
 *
 * ---- 为什么不用整张贴图 ----
 *
 * 整株贴图只能整体平移或整体旋转，看起来就是一贴纸。
 * 拆成 根 / 茎 / 头 之后，每块绕自己的关节转：
 *
 *   根   —— 钉在地面，角度恒为 0，是整套动作的定海神针
 *   茎   —— 绕根部（自身底端）左右摇，这是「扭动」的主体
 *   头   —— 绕茎顶（自身底端）摆，相位**滞后**于茎
 *
 * 最后这一条最关键：如果头和茎同相，看起来是根棍子在整体晃；
 * 滞后约 0.6 弧度后，变成「茎先把头带过去，头再跟上来」，
 * 也就是果冻/弹簧那种有余韵的晃动。
 *
 * ---- 坐标系 ----
 *
 * 每个部件的 x/y 都以「根底中心」为原点写在 config 里，
 * 所以创建时直接按表摆放即可对齐，运行时不做任何位置反推。
 *
 * setOrigin 用的是 config 里的 pivot：茎和头 pivotY=1，
 * 即旋转轴在部件**底端** —— 相当于从关节处甩出去。
 */

import Phaser from 'phaser';
import {
  ASSET_KEYS,
  PLANT_ANIM,
  PLANT_RIG_BASE,
  PLANT_RIG_ICE,
  type PlantPartName,
  type PlantRigLayout
} from '../config';

/** 部件绘制顺序（后面的盖住前面的） */
const PART_ORDER: readonly PlantPartName[] = ['root', 'stem', 'head'] as const;

/**
 * 每种植物用哪套布局 + 哪套贴图。
 *
 * 只做「有分层素材」的两种；墙和冷雾苔还是单贴图，
 * 由 Plant 自己判断是否启用 rig。
 */
export const PLANT_RIG_ASSETS: Partial<
  Record<string, { layout: PlantRigLayout; textures: Record<PlantPartName, string> }>
> = {
  shooter: {
    layout: PLANT_RIG_BASE,
    textures: {
      root: ASSET_KEYS.baseRoot,
      stem: ASSET_KEYS.baseStem,
      head: ASSET_KEYS.baseHead
    }
  },
  ice: {
    layout: PLANT_RIG_ICE,
    textures: {
      root: ASSET_KEYS.iceRoot,
      stem: ASSET_KEYS.iceStem,
      head: ASSET_KEYS.iceHead
    }
  }
};

/**
 * 整体垂直补偿。
 *
 * 布局原点在「根底中心」，而植物被摆在格心。
 * 往下压若干像素，让根底落在格子下部 —— 看起来才像种在地里。
 *
 * 取 12：一格 64px、整株 38px，压 12 后视觉重心正好在格子中下部。
 */
const PLANT_SINK_PX = 14;

/**
 * 素材本身的朝向。
 *
 * 植物分部件立绘的发射口是朝**左**画的（-1），
 * 而僵尸贴图朝右 —— 两者相反，所以朝右时必须镜像。
 */
const MATERIAL_FACING = -1;

/** 动画状态 */
export type PlantRigMode = 'idle' | 'fire';

export class PlantRig extends Phaser.GameObjects.Container {
  /** 三个部件贴图，按名字索引 */
  private readonly parts = new Map<PlantPartName, Phaser.GameObjects.Image>();

  /** 布局表（每株植物一份，构造时固定） */
  private readonly layout: PlantRigLayout;

  /** 累计时间（秒），驱动所有 sin/cos */
  private t = 0;

  /** 当前动作模式 */
  private mode: PlantRigMode = 'idle';

  /** 开火动作剩余时间（秒）。>0 时走 fire 动作 */
  private fireLeft = 0;

  /** 朝向：1 右 / -1 左（水平翻转整套部件） */
  private facing: 1 | -1 = 1;

  /** 基准位置。动画会改写 this.y，必须留干净值防止累加 */
  private baseY = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    layout: PlantRigLayout,
    textures: Record<PlantPartName, string>
  ) {
    super(scene, x, y);
    this.layout = layout;
    this.baseY = y;

    for (const name of PART_ORDER) {
      const spec = layout[name];

      // 用 make.image（不自动加入显示列表），否则贴图会同时挂在
      // Scene 和本 Container 上，位置按两套坐标系走，显示会错乱。
      const img = scene.make.image(
        { x: spec.x, y: spec.y, key: textures[name], add: false },
        false
      );

      // ---- 左上角 -> 轴心 的换算 ----
      //
      // config 里的 x / y 是「贴图左上角」相对根底中心的偏移；
      // 但设了 setOrigin(pivotX, pivotY) 之后，img.x / img.y 指向的是
      // **轴心**而非左上角。若直接把 spec.x / spec.y 赋给 img.x / img.y，
      // 贴图就会整体上移 pivotY*h、左移 pivotX*w —— 茎和头 pivotY=1，
      // 等于被上移了整整一个自身高度，于是三块之间拉开大缝、整株「悬空」。
      //
      // 正确做法：先设 origin 与尺寸，再把轴心位置 = 左上角 + 轴心在贴图内的偏移。
      // 这样无论 pivotY 取 0、0.5 还是 1，贴图左上角都恰好落在 spec.x / spec.y。
      img.setOrigin(spec.pivotX, spec.pivotY);
      img.setDisplaySize(spec.w, spec.h);

      img.x = spec.x + spec.pivotX * spec.w;
      img.y = spec.y + spec.pivotY * spec.h;

      this.parts.set(name, img);
      this.add(img);
    }

    // 容器只做视觉载体，不参与物理
    this.setDepth(5);
    scene.add.existing(this);

    // 初始朝向：默认 facing=1（面向右），素材朝左，需要镜像
    this.applyFacing();
    this.applyPose();
  }

  // ---------------------------------------------------------------- 对外接口

  /** 特殊个体：整株染成金色（不影响普通植物） */
  setTintAll(color: number): void {
    for (const img of this.parts.values()) {
      img.setTintFill(color);
    }
  }

  /** 清除特殊个体染色 */
  clearTintAll(): void {
    for (const img of this.parts.values()) {
      img.clearTint();
    }
  }

  /**
   * 播放一次开火动作。
   *
   * @param durationMs 动作持续多久（毫秒），期间整株前倾 + 快速点头
   */
  playFire(durationMs = 420): void {
    this.mode = 'fire';
    this.fireLeft = Math.max(0.12, durationMs / 1000);
  }

  /**
   * 设置朝向。
   *
   * @param facing 1 = 面向右，-1 = 面向左（均指「朝向僵尸」的方向）
   *
   * ---- 材质朝向取反 ----
   *
   * 植物立绘的发射口是**朝左**画的，而僵尸贴图朝右。
   * 如果直接把 facing 当 scaleX 用（facing=-1 时翻成朝左），
   * 素材本身就朝左，再翻一次反而变成朝右 —— 视觉上就是「背对僵尸」。
   *
   * 所以这里用 **-facing**：
   *   facing = -1（僵尸在左）-> scaleX = +1 -> 素材原样朝左 ✅
   *   facing = +1（僵尸在右）-> scaleX = -1 -> 镜像后朝右 ✅
   */
  setFacing(facing: 1 | -1): void {
    if (this.facing === facing) return;
    this.facing = facing;
    this.applyFacing();
  }

  /**
   * 把朝向应用到三块部件上（镜像）。
   *
   * ---- 为什么不用 container.setScale(-1, 1) ----
   *
   * 原本想直接翻转整个容器，一行搞定。但实测发现：
   * Phaser 的 Container 在 **scaleX 为负** 时，子项的渲染判定
   * （renderFlags / 变换矩阵符号）会失效 —— 三块部件全部画不出来，
   * 植物在屏幕上彻底消失。把 scaleX 改回 +1 立刻恢复。
   *
   * 所以改为逐个部件镜像，容器 scale 始终保持正数：
   *   1. 子项 flipX 取反 —— 水平镜像贴图本身
   *   2. 子项 x 取反      —— 让它在容器里的位置也左右对称
   *   3. 角度在 applyPose 里按 facing 取反
   *
   * 三者合起来，视觉效果与整容器翻转完全一致，但没有负缩放的坑。
   */
  private applyFacing(): void {
    // 素材朝左；facing=1（面向右）时需要镜像
    const needMirror = this.facing !== MATERIAL_FACING;

    for (const name of PART_ORDER) {
      const img = this.parts.get(name);
      const spec = this.layout[name];
      if (!img) continue;

      img.setFlipX(needMirror);
      // 镜像时把部件的轴心位置绕原点 x=0 翻到另一侧。
      // 注意这里用的是「轴心位置」，与构造一致：左上角 + pivotX*w、再取反。
      const axisX = spec.x + spec.pivotX * spec.w;
      img.x = needMirror ? -axisX : axisX;
    }
  }

  /** 设置基准位置（格心）。动画在此之上叠加起伏 */
  syncBase(x: number, y: number): void {
    this.baseY = y;
    this.x = x;
    this.y = y + PLANT_SINK_PX;
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * 推进动画。
   *
   * @param delta 毫秒
   */
  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000; // 帧率抖动保护
    this.t += dt;

    if (this.mode === 'fire') {
      this.fireLeft -= dt;
      if (this.fireLeft <= 0) this.mode = 'idle';
    }

    this.applyPose();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 把当前时间换算成三块部件的角度并写回。
   *
   * 待机时：
   *   茎 = sin(t*stemHz) * stemDeg
   *   头 = sin(t*headHz - headLag) * headDeg      ← 相位滞后，产生果冻感
   * 开火时：
   *   整株前倾，头额外快速点头
   */
  private applyPose(): void {
    const c = PLANT_ANIM;
    const cycle2pi = Math.PI * 2;

    let stemDeg: number;
    let headDeg: number;
    let bobPx: number;

    if (this.mode === 'fire') {
      const lean = c.fire.leanDeg;
      const nod = Math.sin(this.t * cycle2pi * c.fire.headNodHz) * c.fire.headNodDeg;

      // 开火时茎保持前倾（带一点余韵），头快速点头
      stemDeg = lean * 0.55;
      headDeg = lean + nod;
      bobPx = 0;
    } else {
      const stemWave = Math.sin(this.t * cycle2pi * c.idle.stemHz);
      const headWave = Math.sin(this.t * cycle2pi * c.idle.headHz - c.idle.headLag);

      stemDeg = stemWave * c.idle.stemDeg;
      headDeg = headWave * c.idle.headDeg;
      // 上下起伏跟茎同相：茎摆到极限时整株略微下沉
      bobPx = Math.abs(stemWave) * c.idle.bobPx;
    }

    // 根永远不动 —— 它是钉在地上的底座
    this.setPartAngle('root', 0);

    // 茎和头的角度方向要跟镜像保持一致：
    // 素材朝左时，正角度就是「向左倾」；镜像成朝右后，
    // 同样的角度会变成「向右倾」，所以符号要反过来。
    const angleSign = this.facing === MATERIAL_FACING ? 1 : -1;
    this.setPartAngle('stem', stemDeg * angleSign);
    this.setPartAngle('head', headDeg * angleSign);

    this.y = this.baseY + PLANT_SINK_PX + bobPx;
  }

  /** 设置部件角度（度） */
  private setPartAngle(name: PlantPartName, deg: number): void {
    const img = this.parts.get(name);
    if (img) img.setAngle(deg);
  }

  /** 布局表（供调试/外部读取总高） */
  getLayout(): PlantRigLayout {
    return this.layout;
  }

  /** 销毁：部件都挂在本容器上，容器销毁会一并清理 */
  override destroy(fromScene?: boolean): void {
    this.parts.clear();
    super.destroy(fromScene);
  }
}