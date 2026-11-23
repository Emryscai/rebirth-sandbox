/**
 * ZombieRig —— 僵尸的「骨骼式」分层渲染器。
 *
 * 为什么单独抽一个类：
 *   PlayerZombie 已经负责移动、碰撞、血量等玩法逻辑，如果再塞进
 *   「六个部件各自旋转多少度」的数学，这个类会膨胀到难以维护。
 *   渲染与玩法分离后，两边都能单独读、单独改。
 *
 * 设计要点：
 *
 *   1. 六个部件是六个独立的 Phaser 贴图，各自有独立旋转轴（pivot）。
 *      腿绕胯转、手臂绕肩转、头绕脖子转 —— 这样摆动才是「关节动」，
 *      而不是整张图晃悠。
 *
 *   2. 所有部件的锚点都在 config 里以「脚底中心」为公共原点给出，
 *      所以创建时直接按 x/y 摆放即可对齐，运行时不需要任何位置反推。
 *      缩放统一（都是 108/2392），也不会出现部件大小对不上的问题。
 *
 *   3. 动画全部由 sin/cos 驱动，没有序列帧。
 *      好处：永远不会帧间形变、可以任意调节速度与幅度、
 *      而且站立/走路/啃食/死亡只是不同的参数组合，不用准备四套素材。
 *
 *   4. 容器负责整体位移与倾斜（前倾、颠簸、摇摆），
 *      部件只负责自己的关节角度。两层各管一件事，不互相干扰。
 */

import Phaser from 'phaser';
import {
  ASSET_KEYS,
  ZOMBIE_PART_LAYOUT,
  ZOMBIE_PART_ORDER,
  ZOMBIE_TIE_LAYOUT,
  ZOMBIE_ANIM,
  type ZombiePartName
} from '../config';

/** 部件名 -> 纹理键 */
const PART_TEXTURE: Record<ZombiePartName, string> = {
  head: ASSET_KEYS.partHead,
  torso: ASSET_KEYS.partTorso,
  armL: ASSET_KEYS.partArmL,
  armR: ASSET_KEYS.partArmR,
  legL: ASSET_KEYS.partLegL,
  legR: ASSET_KEYS.partLegR
};

/**
 * 每个部件的旋转轴位置（相对部件自身，0~1）。
 *
 *   pivotX —— 水平轴：胳膊腿都在部件中线附近摆动，取 0.5
 *   pivotY —— 垂直轴：取 0 = 部件顶端，1 = 部件底端。
 *   这个值决定了 setOrigin 的 y 分量。
 */
const PART_PIVOT: Record<ZombiePartName, { x: number; y: number }> = {
  // 头绕脖子转：脖子在头部图片的底边中心
  head: { x: 0.127, y: 1.0 },
  // 躯干固定不转（表里仍给一个值，保持类型完整）
  torso: { x: 0.435, y: 1.0 },

  // ---- 手臂：轴心落在「贴图内侧那一条边」----
  //
  // 左右臂的切法天然不对称：
  //   左臂贴在躯干左侧，内容集中在贴图右缘
  //   右臂贴在躯干右侧，内容集中在贴图左缘
  //
  // 数值取自各块贴图「最顶一行」的横向中心（即与肩膀相接处），
  // 见 ZOMBIE_PART_LAYOUT 的 pivotX 字段来源。
  // 若沿用 0.5，旋转时会把整条手臂甩离躯干，看起来像零件脱落。
  armL: { x: 0.873, y: 0.0 },
  // armR 现在只包含绿色手部，旋转轴放在手腕（顶部中心）
  armR: { x: 0.5, y: 0.0 },

  // ---- 腿：轴心落在胯部 ----
  // 同样取自内容最顶一行的横向中心。
  legL: { x: 0.664, y: 0.0 },
  legR: { x: 0.310, y: 0.0 }
};

/**
 * 各部件的基础角度（度）。
 *
 * 头部：PvZ 普通僵尸永远是歪着头的 —— 这是它「丧尸感」的关键。
 *   素材本身画的是正头，所以这里给一个固定的基准倾斜，
 *   动画再在此之上叠加小幅摆动。
 *   负角 = 逆时针 = 头往右倒（素材朝向是右）。
 */
const PART_BASE_ANGLE: Record<ZombiePartName, number> = {
  // 头部：PvZ 普通僵尸永远是歪着头的。素材画的是正头，
  // 给一个固定倾斜（负角=逆时针=朝右倒，素材朝右），动画在其上叠加微摆。
  head: -26,
  torso: 0,

  // 手臂：保持素材原始姿势（斜垂前伸），不做任何基础旋转。
  // 之前试过给 -30/+30 想「收拢手臂」，结果把胳膊转得看不见了。
  armL: 0,
  armR: 0,

  legL: 0,
  legR: 0
};

/** 部件的层级深度（越大越靠前绘制） */
const PART_DEPTH: Record<ZombiePartName, number> = {
  legL: 0,
  legR: 1,
  armL: 2,
  armR: 3,
  torso: 4,
  head: 5
};

/**
 * 各部件轴心在容器内的坐标。
 *
 * 布局表给的是贴图左上角的偏移；但 setOrigin(pivotX, pivotY) 之后，
 * 部件的 (x, y) 指的是「轴心点」的位置，不再是左上角。
 * 所以要把左上角偏移换算成轴心偏移：
 *
 *   pivotX = 左上角X + 宽度 * pivotX比例
 *   pivotY = 左上角Y + 高度 * pivotY比例
 */
function pivotOffset(name: ZombiePartName): { x: number; y: number } {
  const spec = ZOMBIE_PART_LAYOUT[name];
  const pv = PART_PIVOT[name];
  return {
    x: spec.x + spec.w * pv.x,
    y: spec.y + spec.h * pv.y
  };
}

export class ZombieRig extends Phaser.GameObjects.Container {
  /** 部件贴图，按名字索引，方便单独调角度 */
  private readonly parts = new Map<ZombiePartName, Phaser.GameObjects.Image>();

  /** 从 armR 裁出的红色领带，跟随躯干，不跟抬手旋转 */
  private tiePart?: Phaser.GameObjects.Image;
  private tieBaseX = 0;
  private tieBaseY = 0;

  /**
   * 各部件的「基准 y」（相对容器）。
   *
   * 动画会给部件叠加 y 偏移（比如啃食时头部上下点），
   * 必须有一份干净的原值可以恢复，否则每帧叠加会越飘越远。
   */
  private readonly basePartY = new Map<ZombiePartName, number>();

  /**
   * 挂在肢体末端的道具（链锯/盾牌/靴子等）。
   *
   * key 为肢体部件名（armL / armR / legL / legR），每帧根据该肢体的
   * 当前摆动角度把道具摆到「末端」位置，从而与手/脚的动作为同一套节奏，
   * 形成真正的「握在手上」而不是飘在旁边的贴纸。
   */
  private readonly limbProps = new Map<
    ZombiePartName,
    {
      obj: Phaser.GameObjects.GameObject & { x: number; y: number; setRotation?: (r: number) => unknown };
      /** 相对末端的额外偏移（肢体局部像素，未镜像） */
      offsetX: number;
      offsetY: number;
      /** 跟随肢体角度（弧度），0 = 保持自身朝向 */
      rotFollow: number;
      /** 额外基础旋转（弧度） */
      baseRot: number;
      /**
       * 沿肢体长度的锚点位置（0 = 关节/顶端，1 = 末端）。
       * 默认 1，即挂在手/脚最末端（链锯、盾牌等）。
       * 靴子用 <1 的值把锚点落在「脚部区域」而不是脚底，从而覆盖脚。
       */
      alongFrac: number;
    }
  >();

  /** 动画累计时间（秒），用于驱动所有 sin/cos */
  private t = 0;

  /** 当前动作模式 */
  private mode: 'idle' | 'walk' | 'eat' | 'dead' = 'idle';

  // ---------------------------------------------------------------- 投掷动作
  //
  // 普攻出手前的手部动作：先把手臂向后抬起蓄力（windup），
  // 到「出手帧」再快速向前甩出（release），随后手臂自然收回。
  // 手部甩出的瞬间，GameScene 把手上的图标摘掉、生成真正的弹体，
  // 于是视觉上「手里的图甩出去变成了攻击」。
  /** 投掷动作剩余时间（秒），>0 表示正在出招 */
  private throwT = 0;
  /** 投掷动作总时长（秒） */
  private throwDur = 0;
  /** 投掷用的是哪只手 */
  private throwArm: ZombiePartName = 'armR';

  /** 链锯重击抬手动作剩余时间（秒） */
  private sawRaiseT = 0;
  private sawRaiseDur = 0.42;
  private sawRaiseArm: 'armL' | 'armR' = 'armR';
  /** 抬手前手部基准位置，动作结束后恢复 */
  private sawRaiseBaseX = 0;
  private sawRaiseBaseY = 0;
  /** 长按空格时保持抬手 */
  private sawRaiseHeld = false;

  /** 蓄力/出手的时间分界（0~1） */
  private static readonly THROW_RELEASE_AT = 0.42;
  /** 蓄力时手臂向后抬起的角度（度，含朝向符号由应用时乘） */
  private static readonly THROW_WINDUP_DEG = 52;
  /** 甩出时手臂向前下方的最大角度（度） */
  private static readonly THROW_RELEASE_DEG = -78;

  /** 朝向：1 右 / -1 左 */
  private facing: 1 | -1 = 1;

  /** 最近一次移动方向（用于链锯抬手与朝向统一） */
  private aimDc = 1;
  private aimDr = 0;

  /** 死亡动画计时（秒），仅 dead 模式使用 */
  private deathT = 0;

  /** 脚底基准 y。动画会改写 this.y，必须留一份干净值防止累加。 */
  private baseY = 0;

  /**
   * 整体垂直偏移量（像素），正数=下移，负数=上移。
   *
   * 布局里脚底在 y=0，但格子高 64、格心离地 32，
   * 缩小后的僵尸（高 86.4）脚底正好卡在格下界时，
   * 视觉上会觉得「浮在格子中间」。
   *
   * 往下压 19px，让脚略微探出格子下界 —— 看起来才像踩在地上。
   * 19 = 10（原先的手感值）+ 8.6（在缩小后高度 86.4 的基础上再下移 10%）。
   *
   * 只影响渲染，不参与碰撞：判定框仍按 logicalY（格心）计算。
   */
  private static readonly SINK_PX = 19;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    this.baseY = y;

    for (const name of ZOMBIE_PART_ORDER) {
      const spec = ZOMBIE_PART_LAYOUT[name];
      const pv = PART_PIVOT[name];
      const off = pivotOffset(name);

      // 用 make.image（不自动加入显示列表）而不是 add.image，
      // 否则贴图会被同时挂到 Scene 和本 Container 上，
      // 造成位置计算按两套坐标系走、显示错乱。
      const img = scene.make.image(
        { x: off.x, y: off.y, key: PART_TEXTURE[name], add: false },
        false
      );

      // 轴心决定旋转中心。设了 origin 之后 img.x/img.y 指向的就是轴心，
      // 所以上面的 off 已经换算过，这里不用再补。
      img.setOrigin(pv.x, pv.y);

      // 右手只显示手腕以下的绿色手部；上半段红色领带单独静态绘制。
      // setDisplaySize 按整张 frame 计算，裁剪后必须直接按裁剪尺寸设 scale，
      // 否则宽度对、高度会被压扁（领带“岔开”的根因）。
      if (name === 'armR') {
        img.setCrop(0, 856, 65, 294);
        img.setScale(spec.w / 65, spec.h / 294);
      } else {
        // 贴图原始像素 -> 游戏内显示尺寸
        img.setDisplaySize(spec.w, spec.h);
      }

      img.setDepth(PART_DEPTH[name]);

      this.parts.set(name, img);
      this.add(img);
      this.basePartY.set(name, off.y);
    }

    // 红色领带：从 armR 上半段裁出，保持原位、不参与任何手臂旋转
    const tie = scene.make.image(
      {
        x: ZOMBIE_TIE_LAYOUT.x,
        y: ZOMBIE_TIE_LAYOUT.y,
        key: ASSET_KEYS.partArmR,
        add: false
      },
      false
    );
    tie.setOrigin(0, 0);
    tie.setCrop(0, 0, 182, 856);
    // 裁剪图同样不能用 setDisplaySize（会按未裁剪的 frame 高度压扁）
    tie.setScale(
      ZOMBIE_TIE_LAYOUT.w / 182,
      ZOMBIE_TIE_LAYOUT.h / 856
    );
    // 领带压在衬衫前层，避免抬手后只剩一条悬空的红边
    tie.setDepth(PART_DEPTH.torso + 0.2);
    this.tiePart = tie;
    this.tieBaseX = tie.x;
    this.tieBaseY = tie.y;
    this.add(tie);

    // 容器本身不参与物理，只做视觉载体
    this.setDepth(20);
    scene.add.existing(this);
  }

  // ---------------------------------------------------------------- 对外接口

  /** 切换到某动作模式。重复设置同一模式不会重置进度。 */
  setMode(mode: 'idle' | 'walk' | 'eat' | 'dead'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'dead') this.deathT = 0;
  }

  /** 当前动作模式 */
  getMode(): 'idle' | 'walk' | 'eat' | 'dead' {
    return this.mode;
  }

  /**
   * 开始一次投掷动作（甩手）。
   *
   * @param side   用哪只手甩（默认右手）
   * @param durMs  动作总时长（毫秒）
   */
  startThrow(side: 'armL' | 'armR' = 'armR', durMs = 300): void {
    if (this.mode === 'dead') return;
    this.throwArm = side;
    this.throwDur = Math.max(0.1, durMs / 1000);
    this.throwT = this.throwDur;
  }

  /** 投掷动作是否仍在进行 */
  get isThrowing(): boolean {
    return this.throwT > 0;
  }

  /** 是否正在做链锯重击抬手（测试用） */
  get isSawRaising(): boolean {
    return this.sawRaiseT > 0;
  }

  /** 链锯重击：把持锯手抬起并短暂保持 */
  startSawRaise(side: 'armL' | 'armR' = 'armR', durMs = 420): void {
    if (this.mode === 'dead') return;
    this.sawRaiseHeld = false;
    const arm = this.parts.get(side);
    if (arm) {
      if (this.sawRaiseT > 0) {
        // 连续重击：先把上一次的位移归位，再记录基准
        arm.x = this.sawRaiseBaseX;
        arm.y = this.sawRaiseBaseY;
      }
      this.sawRaiseBaseX = arm.x;
      this.sawRaiseBaseY = arm.y;
    }
    this.sawRaiseArm = side;
    this.sawRaiseDur = Math.max(0.15, durMs / 1000);
    this.sawRaiseT = this.sawRaiseDur;
  }

  /** 长按空格：保持抬手，不再继续下落 */
  holdSawRaise(side: 'armL' | 'armR' = 'armR'): void {
    if (this.mode === 'dead') return;
    if (this.sawRaiseT <= 0) {
      this.startSawRaise(side, this.sawRaiseDur);
    }
    this.sawRaiseHeld = true;
    this.sawRaiseT = Math.max(this.sawRaiseT, this.sawRaiseDur * 0.72);
  }

  /** 松开空格：从当前高度落回 */
  releaseSawRaise(): void {
    this.sawRaiseHeld = false;
    this.sawRaiseT = Math.min(this.sawRaiseT, this.sawRaiseDur * 0.3);
  }

  /** 设置攻击朝向（上下左右），抬手位置跟着它走 */
  setAimDirection(dc: number, dr: number): void {
    if (dc === 0 && dr === 0) return;
    this.aimDc = Math.sign(dc);
    this.aimDr = Math.sign(dr);
  }

  /** 设置朝向（水平翻转整套部件） */
  setFacing(facing: 1 | -1): void {
    if (this.facing === facing) return;
    this.facing = facing;
    // 翻转容器即可，六个部件会一起镜像；
    // 关节角度在各自 animate 里按 facing 修正符号，保证「前摆」始终朝行进方向。
    this.setScale(facing, this.scaleY);
  }

  // ---------------------------------------------------------------- 肢体道具

  /**
   * 把一个显示对象挂到某肢体的末端（手/脚）。
   *
   * 对象会以子对象形式加入容器，因此自动继承整体的位移、摇摆与前倾；
   * 每帧再根据肢体摆角把它摆到肢体末端，并让它跟着肢体旋转。
   *
   * @param limb   肢体部件名（armL / armR / legL / legR）
   * @param obj    要挂上去的显示对象（通常是 Container 或 Image）
   * @param opts   末端偏移 / 旋转跟随量（角度为度）
   */
  attachLimbProp(
    limb: ZombiePartName,
    obj: Phaser.GameObjects.GameObject & { x: number; y: number; setRotation?: (r: number) => unknown },
    opts: { offsetX?: number; offsetY?: number; rotFollow?: number; baseDeg?: number; alongFrac?: number } = {}
  ): void {
    // 先挂到本容器下：道具的 x/y 之后会被 updateLimbProps 按「容器局部坐标」
    // 写到肢体末端。如果不 add 进容器，道具仍留在 Scene 显示列表里，
    // 局部坐标会被当成世界坐标用，视觉上就会「飘到别处而不是贴在手上」。
    // Container.add 会自动把它从原显示列表摘除，无需手动 remove。
    const asChild = obj as unknown as Phaser.GameObjects.GameObject;
    if ((asChild as unknown as { parentContainer?: unknown }).parentContainer !== this) {
      this.add(asChild);
    }

    this.limbProps.set(limb, {
      obj,
      offsetX: opts.offsetX ?? 0,
      offsetY: opts.offsetY ?? 0,
      rotFollow: Phaser.Math.DegToRad(opts.rotFollow ?? 0),
      baseRot: Phaser.Math.DegToRad(opts.baseDeg ?? 0),
      alongFrac: Phaser.Math.Clamp(opts.alongFrac ?? 1, 0, 1)
    });
    // 先摆一次，避免第一帧前出现在容器原点
    this.updateLimbProps();
  }

  /** 摘掉某肢体上的道具（不销毁对象，由调用方决定是否销毁） */
  detachLimbProp(limb: ZombiePartName): void {
    this.limbProps.delete(limb);
  }

  /** 是否挂着道具 */
  hasLimbProp(limb: ZombiePartName): boolean {
    return this.limbProps.has(limb);
  }

  /** 某肢体末端在世界坐标中的位置（供发射物从手部射出） */
  getLimbTipWorld(limb: ZombiePartName): { x: number; y: number } {
    // 容器局部坐标 -> 世界坐标
    const local = this.computeLimbTipLocal(limb);
    const m = this.getWorldTransformMatrix();
    const out = new Phaser.Math.Vector2();
    m.transformPoint(local.x, local.y, out);
    return { x: out.x, y: out.y };
  }

  /** 计算某肢体末端相对容器（脚底中心）的局部坐标 */
  private computeLimbTipLocal(limb: ZombiePartName): { x: number; y: number } {
    const spec = ZOMBIE_PART_LAYOUT[limb];
    const pv = PART_PIVOT[limb];
    const img = this.parts.get(limb);

    // 轴心（肢体与身体连接处）在容器内的局部坐标
    const px = spec.x + spec.w * pv.x;
    const py = spec.y + spec.h * pv.y;

    // 轴心到末端的长度（pivot 在顶端，故长度 = 高度 × (1 - pivotY)）
    const len = spec.h * (1 - pv.y);

    // 当前摆角（含基础角）
    const ang = Phaser.Math.DegToRad(img ? img.angle : PART_BASE_ANGLE[limb]);

    // 绕轴心旋转向量 (0, len)
    return {
      x: px - Math.sin(ang) * len,
      y: py + Math.cos(ang) * len
    };
  }

  /** 每帧把所有肢体道具摆到对应肢体末端 */
  private updateLimbProps(): void {
    for (const [limb, p] of this.limbProps) {
      const spec = ZOMBIE_PART_LAYOUT[limb];
      const pv = PART_PIVOT[limb];
      const img = this.parts.get(limb);

      // 以手部实际位置为锚点；抬手动作会临时平移 img，锯子必须跟着手走
      const px = img ? img.x : spec.x + spec.w * pv.x;
      const py = img ? img.y : spec.y + spec.h * pv.y;
      const len = spec.h * (1 - pv.y);
      const ang = Phaser.Math.DegToRad(img ? img.angle : PART_BASE_ANGLE[limb]);

      // 锚点：沿肢体从关节到末端的 alongFrac 处（1 = 末端/脚底，<1 = 中途/脚部）
      const dist = len * p.alongFrac;
      const tipX = px - Math.sin(ang) * dist;
      const tipY = py + Math.cos(ang) * dist;

      const rx = p.offsetX * Math.cos(ang) - p.offsetY * Math.sin(ang);
      const ry = p.offsetX * Math.sin(ang) + p.offsetY * Math.cos(ang);

      p.obj.x = tipX + rx;
      p.obj.y = tipY + ry;

      if (p.obj.setRotation) {
        p.obj.setRotation(ang * p.rotFollow + p.baseRot);
      }
    }
  }

  /** 设置整体透明度（受伤闪烁等） */
  setAlphaAll(v: number): void {
    this.setAlpha(v);
  }

  /**
   * 给整套部件染色（被冰豌豆命中时的「冻蓝」反馈）。
   *
   * 为什么不能直接对 Container 调 setTint：
   *   ZombieRig 是 Container，只是子对象的载体，tint 不会传递到子 Image，
   *   单独 tint 容器没有任何视觉效果。必须逐个部件设置。
   *
   * 用 setTintFill（填充色）而不是 setTint（乘法叠加）：
   *   僵尸贴图本身是绿色系，乘法叠蓝会发灰、看不出来；
   *   填充纯蓝能让整具躯体明显「冻成蓝色」，反馈更直观。
   *   这里用带一点白的冰蓝，避免过暗把骨骼细节糊掉。
   */
  setTintAll(color: number): void {
    for (const img of this.parts.values()) {
      img.setTintFill(color);
    }
    this.tiePart?.setTintFill(color);
  }

  /** 清除所有部件的染色，恢复原贴图颜色 */
  clearTintAll(): void {
    for (const img of this.parts.values()) {
      img.clearTint();
    }
    this.tiePart?.clearTint();
  }

  // ---------------------------------------------------------------- 每帧更新

  /**
   * 推进动画。
   *
   * @param delta 毫秒
   * @param speedRatio 当前速度 / 基准速度，走得快时摆幅也大
   */
  update(delta: number, speedRatio = 1): void {
    const dt = Math.min(delta, 50) / 1000; // 帧率抖动保护
    this.t += dt;

    switch (this.mode) {
      case 'walk':
        this.animateWalk(speedRatio);
        break;
      case 'eat':
        this.animateEat();
        break;
      case 'dead':
        this.animateDead(dt);
        break;
      case 'idle':
      default:
        this.animateIdle();
        break;
    }

    // 投掷动作覆盖对应手臂的角度（在所有模式动画算完之后）
    this.applyThrow(dt);
    // 链锯重击的抬手动作优先级更高，覆盖同侧手臂
    this.applySawRaise(dt);

    // 领带跟随躯干旋转，啃食/走路时不会从胸口飘开
    this.syncTieToTorso();

    // 肢体道具跟随（在所有关节角度算完之后）
    this.updateLimbProps();
  }

  /**
   * 叠加投掷动作到指定手臂。
   *
   * 曲线（progress 0→1）：
   *   0     ~ 0.42  蓄力：手臂从当前姿势向后抬起；
   *   0.42  ~ 0.62  出手：快速甩向前下方；
   *   0.62  ~ 1     收回：平滑回到正常姿势。
   *
   * 角度含朝向符号（facing），与其它动画一致，保证「往身前甩」。
   */
  private applyThrow(dt: number): void {
    if (this.throwT <= 0) return;
    this.throwT = Math.max(0, this.throwT - dt);

    const total = this.throwDur || 0.3;
    const progress = Phaser.Math.Clamp(1 - this.throwT / total, 0, 1);
    const r = ZombieRig.THROW_RELEASE_AT;

    let deg: number;
    if (progress < r) {
      // 蓄力：0 -> windup（easeOut）
      const p = progress / r;
      const eased = 1 - Math.pow(1 - p, 2);
      deg = eased * ZombieRig.THROW_WINDUP_DEG;
    } else if (progress < r + 0.2) {
      // 出手：windup -> release（快速 easeIn）
      const p = (progress - r) / 0.2;
      const eased = p * p;
      deg = ZombieRig.THROW_WINDUP_DEG +
        (ZombieRig.THROW_RELEASE_DEG - ZombieRig.THROW_WINDUP_DEG) * eased;
    } else {
      // 收回：release -> 0
      const p = (progress - r - 0.2) / (1 - r - 0.2);
      const eased = 1 - Math.pow(1 - p, 3);
      deg = ZombieRig.THROW_RELEASE_DEG * (1 - eased);
    }

    this.setPartAngle(this.throwArm, this.facing * deg);
  }

  /** 链锯重击抬手：快速抬起 → 短暂保持 → 回落 */
  private applySawRaise(dt: number): void {
    if (this.sawRaiseT <= 0) return;
    if (!this.sawRaiseHeld) {
      this.sawRaiseT = Math.max(0, this.sawRaiseT - dt);
    }

    const total = this.sawRaiseDur || 0.42;
    const progress = Phaser.Math.Clamp(1 - this.sawRaiseT / total, 0, 1);
    let lift: number;
    if (this.sawRaiseHeld) {
      lift = 1;
    } else if (progress < 0.22) {
      lift = progress / 0.22;
    } else if (progress > 0.68) {
      lift = Math.max(0, 1 - (progress - 0.68) / 0.32);
    } else {
      lift = 1;
    }

    // 手部不仅旋转，还整体向前上方抬起；领带是独立静态部件，不会被带起来。
    // 容器本身会按 facing 做水平镜像，所以局部偏移 = 攻击方向 × facing。
    const arm = this.parts.get(this.sawRaiseArm);
    if (arm) {
      const forward = this.aimDc !== 0 ? this.aimDc : this.facing;
      arm.x = this.sawRaiseBaseX + forward * this.facing * 16 * lift;
      // 上抬距离从 32px 下调 80%，只保留 6px；主要靠手腕旋转表现“抬手”
      arm.y = this.sawRaiseBaseY - 6 * lift;
    }
    // 旋转角不乘 facing：左朝向由容器镜像统一处理，避免抬到反方向
    this.setPartAngle(this.sawRaiseArm, -120 * lift);

    if (this.sawRaiseT <= 0 && arm) {
      arm.x = this.sawRaiseBaseX;
      arm.y = this.sawRaiseBaseY;
    }
  }

  // ---------------------------------------------------------------- 各动作

  /**
   * 站立：极慢的呼吸 + 几乎察觉不到的歪斜。
   *
   * 完全静止的角色会显得死板，哪怕只有 1 度变化也能让画面活起来，
   * 但又不能大到像在抽搐 —— 所以振幅取很小、频率取很低。
   */
  private animateIdle(): void {
    const c = ZOMBIE_ANIM.idle;
    const breath = Math.sin(this.t * Math.PI * 2 * c.breathHz);
    const sway = Math.sin(this.t * Math.PI * 2 * c.swayHz);

    this.setScale(
      this.facing * (1 + breath * c.breathScale),
      1 + breath * c.breathScale
    );
    this.setRotation((sway * c.swayDeg * Math.PI) / 180);

    this.setPartAngle('legL', 0);
    this.setPartAngle('legR', 0);
    this.setPartAngle('armL', sway * 1.5);
    this.setPartAngle('armR', -sway * 1.5);
    this.setPartAngle('torso', 0);
    this.setPartAngle('head', sway * 1.2);
    // 站立时头部没有上下位移（啃食时才加），归零
    this.setPartOffsetY('head', 0);

    // 站立时脚贴地，不做垂直偏移
    this.y = this.baseY + ZombieRig.SINK_PX;
  }

  /**
   * 走路：这套动作是「魔性」的来源。
   *
   * 四个层次叠加：
   *   1. 躯干前倾      —— 恒定 -7 度，制造扑上来的压迫感
   *   2. 左右摇摆      —— 1 Hz，整个身体像钟摆
   *   3. 上下颠簸      —— 2 Hz，每迈一步身体下沉一次
   *   4. 四肢交替摆动  —— 腿 2 Hz 反相，手臂与同侧腿反相（对侧摆）
   *
   * 关键是相位：左腿前摆时右臂前摆，这是走路的基本协调关系。
   * 如果同侧同相会显得像在跳，而不是走。
   */
  private animateWalk(speedRatio: number): void {
    const c = ZOMBIE_ANIM.walk;
    const amp = Phaser.Math.Clamp(speedRatio, 0.6, 1.8);

    // ---- 身体整体 ----
    const sway = Math.sin(this.t * Math.PI * 2 * c.swayHz);
    const bob = Math.sin(this.t * Math.PI * 2 * c.bobHz);

    const leanRad = (c.leanDeg * Math.PI) / 180;
    const swayRad = (sway * c.swayDeg * Math.PI) / 180;

    this.setRotation(leanRad + swayRad);
    this.setScale(this.facing, 1);
    this.y = this.baseY + ZombieRig.SINK_PX - Math.abs(bob) * c.bobPx;

    // ---- 双腿：PvZ 僵尸是「僵硬地迈大步」----
    //
    // 关键特征：膝盖不打弯，整条腿像钟摆一样从胯部甩出去，
    // 而且两腿完全反相。幅度比写实走路大得多（约 26 度），
    // 看起来才像「僵着腿一步一挪」。
    const legPhase = this.t * Math.PI * 2 * c.stepHz;
    const legA = Math.sin(legPhase);
    const legDeg = 12 * amp;

    // 用「方一点的」波形：让腿在前/后端点停留更久，
    // 而不是正弦那种匀速来回 —— 这是木偶感的来源。
    const shaped = Math.sign(legA) * Math.pow(Math.abs(legA), 0.72);

    this.setPartAngle('legL', this.facing * shaped * legDeg);
    this.setPartAngle('legR', this.facing * -shaped * legDeg);

    // ---- 双臂：PvZ 僵尸平举向前 ----
    //
    // 原素材手臂就是张开的，这里让它们随步伐小幅前后晃，
    // 摆动幅度比腿小（12 度），且与同侧腿反相。
    // 注意：手臂是「举在前面」的，所以角度要加一个负偏置往上抬。
    const armA = Math.sin(legPhase + Math.PI);
    const armDeg = 12 * amp;

    this.setPartAngle('armL', this.facing * armA * armDeg);
    this.setPartAngle('armR', this.facing * -armA * armDeg);

    // ---- 躯干与头 ----
    // 躯干轻微扭转，头带滞后地跟着摆（歪头的基础角度由 PART_BASE_ANGLE 提供）
    const torsoA = Math.sin(this.t * Math.PI * 2 * c.swayHz - 0.4);
    this.setPartAngle('torso', torsoA * 3.0);
    this.setPartAngle('head', Math.sin(this.t * Math.PI * 2 * c.swayHz - 0.9) * 4.0);
    // 走路时头部不做额外垂直位移，归零（防止从啃食切回来时残留偏移）
    this.setPartOffsetY('head', 0);
  }
  private animateEat(): void {
    const c = ZOMBIE_ANIM.eat;
    const chomp = Math.sin(this.t * Math.PI * 2 * c.chompHz);

    // ---- 身体：前倾压低 ----
    // 啃食时整个人「趴」在植物上，比走路时更前倾
    const leanRad = (c.leanDeg * Math.PI) / 180;
    // 朝右啃食时向右倾，朝左时镜像，不要总是往左倒
    this.setRotation(-this.facing * leanRad);
    this.setScale(this.facing, 1);
    // 随撕咬节奏上下顿：咬下去时身体下沉
    this.y = this.baseY + ZombieRig.SINK_PX + Math.abs(chomp) * 1.5;

    // ---- 头：纯垂直咀嚼 ----
    // 只有沿 y 轴的上下来回，**不做任何旋转**。
    //
    // 角度固定回基准值（0 + PART_BASE_ANGLE 的歪头），
    // 这样头保持原本的倾斜，只是整个脑袋上下嚼动，
    // 像在反复咬合，而不是点头或转头。
    //
    // chompHz 是咀嚼频率，nodPx 是上下幅度（像素）。
    const nodOffset = -Math.cos(this.t * Math.PI * 2 * c.chompHz) * c.nodPx;
    this.setPartOffsetY('head', nodOffset);
    this.setPartAngle('head', 0);

    // ---- 躯干：保持素材原样，不做摆动 ----
    this.setPartAngle('torso', 0);

    // ---- 双臂：保持素材原姿势 ----
    // 不做摆动。之前试过让手臂上下扒，但手臂贴图是一整根斜向下的长条，
    // 支点在上端，转起来像整条胳膊在抡，很怪。
    // 这里直接归零，让它们跟着躯干一起动。
    this.setPartAngle('armL', 0);
    this.setPartAngle('armR', 0);

    // ---- 双腿：站定，但随咬合轻微屈伸（重量感）----
    this.setPartAngle('legL', chomp * 2.0);
    this.setPartAngle('legR', chomp * 2.0);
  }
  private animateDead(dt: number): void {
    const c = ZOMBIE_ANIM.death;
    this.deathT += dt;

    const progress = Phaser.Math.Clamp(this.deathT / (c.fallDuration / 1000), 0, 1);
    const eased = 1 - Math.pow(1 - progress, 2);

    const deg = c.fallDeg * eased * -this.facing;
    this.setRotation((deg * Math.PI) / 180);
    this.setScale(this.facing, 1);

    // 倒下时身体略微下沉
    this.y = this.baseY + ZombieRig.SINK_PX + eased * 4;

    // 四肢松垮：死亡瞬间散架的感觉
    this.setPartAngle('head', eased * 20 * -this.facing);
    this.setPartOffsetY('head', 0);
    this.setPartAngle('armL', eased * 35 * -this.facing);
    this.setPartAngle('armR', eased * 25 * -this.facing);
    this.setPartAngle('torso', 0);
    this.setPartAngle('legL', 0);
    this.setPartAngle('legR', 0);
  }

  /** 让领带跟着躯干一起倾斜/摆动 */
  private syncTieToTorso(): void {
    const tie = this.tiePart;
    const torso = this.parts.get('torso');
    if (!tie || !torso) return;

    const angle = torso.rotation;
    const dx = this.tieBaseX - torso.x;
    const dy = this.tieBaseY - torso.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    tie.x = torso.x + dx * cos - dy * sin;
    tie.y = torso.y + dx * sin + dy * cos;
    tie.rotation = angle;
  }

  // ---------------------------------------------------------------- 内部工具

  /** 设置部件角度（度） */
  private setPartAngle(name: ZombiePartName, deg: number): void {
    const img = this.parts.get(name);
    // 基础姿态（歪头）永远保留，动画只是在它之上叠加
    if (img) img.setAngle(deg + PART_BASE_ANGLE[name]);
  }

  /**
   * 在部件基准位置上叠加垂直偏移（像素，正值向下）。
   *
   * 和 setPartAngle 一样，每次传的都是「相对基准的偏移量」而不是绝对位置，
   * 所以动画来回摆动不会累积误差。
   */
  private setPartOffsetY(name: ZombiePartName, dy: number): void {
    const img = this.parts.get(name);
    const base = this.basePartY.get(name);
    if (img && base !== undefined) img.y = base + dy;
  }

  /**
   * 由外部在设置位置后调用，记录「脚底应该在哪」。
   *
   * 动画会改写 this.y 做颠簸/下沉，因此必须留一份干净的基准值，
   * 否则每帧叠加会让角色越陷越深。
   */
  syncBaseY(y: number): void {
    this.baseY = y;
    this.y = y + ZombieRig.SINK_PX;
  }

  /** 当前基准 y（供调试） */
  getBaseY(): number {
    return this.baseY;
  }

  /**
   * 设置水平位置。
   *
   * 单独给一个方法而不是直接改 this.x，是为了让语义清楚：
   * x 永远由玩法逻辑决定，动画不碰。
   */
  syncBaseX(x: number): void {
    this.x = x;
  }
}