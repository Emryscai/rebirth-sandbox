/**
 * 齿轮（设置）图标绘制工具。
 *
 * 用 Phaser.GameObjects.Graphics 程序化画出齿轮：
 * 外圈齿 + 主体圆盘 + 中心孔。不依赖任何贴图资源。
 *
 * 画法：先在「齿」的角度区间画外接方块（用多边形近似齿），
 * 再覆盖一个圆盘，最后挖一个中心孔（用背景色圆覆盖）。
 * 这样得到的是实心齿轮轮廓，简单且清晰。
 */

import Phaser from 'phaser';

export interface GearStyle {
  /** 齿轮主体颜色 */
  color: number;
  /** 中心孔颜色（应与背景一致，形成「挖空」视觉） */
  holeColor: number;
  /** 描边颜色（可选） */
  strokeColor?: number;
  /** 齿数 */
  teeth?: number;
  /** 整体透明度 */
  alpha?: number;
}

/**
 * 在给定 Graphics 上绘制一个齿轮，圆心 (cx, cy)。
 *
 * @param g     目标 Graphics（会先 clear）
 * @param cx    圆心 x
 * @param cy    圆心 y
 * @param radius 外半径（到齿尖）
 * @param style 样式
 */
export function drawGear(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  radius: number,
  style: GearStyle
): void {
  const teeth = Math.max(4, Math.floor(style.teeth ?? 8));
  const alpha = style.alpha ?? 1;
  const rOuter = radius;
  // 齿根半径：齿高约占半径 18%
  const rRoot = radius * 0.82;
  // 中心孔半径
  const rHole = radius * 0.34;

  g.clear();

  // ---- 齿 ----
  // 每个齿是一个「从 rRoot 延伸到 rOuter」的梯形段（用四点多边形）。
  // 齿占每段角度的 45%，其余是齿间空隙。
  g.fillStyle(style.color, alpha);
  const step = (Math.PI * 2) / teeth;
  const toothHalf = step * 0.45 * 0.5; // 齿在角度上的半宽
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const a1 = a - toothHalf;
    const a2 = a + toothHalf;
    // 齿根宽一点、齿尖窄一点，形成梯形
    const rootHalf = toothHalf * 1.5;
    const b1 = a - rootHalf;
    const b2 = a + rootHalf;

    const p1 = { x: cx + Math.cos(b1) * rRoot, y: cy + Math.sin(b1) * rRoot };
    const p2 = { x: cx + Math.cos(a1) * rOuter, y: cy + Math.sin(a1) * rOuter };
    const p3 = { x: cx + Math.cos(a2) * rOuter, y: cy + Math.sin(a2) * rOuter };
    const p4 = { x: cx + Math.cos(b2) * rRoot, y: cy + Math.sin(b2) * rRoot };
    g.fillPoints([p1, p2, p3, p4], true);
  }

  // ---- 主体圆盘 ----
  g.fillCircle(cx, cy, rRoot);

  // ---- 中心孔（用背景色覆盖，形成挖空） ----
  g.fillStyle(style.holeColor, alpha);
  g.fillCircle(cx, cy, rHole);

  // ---- 描边 ----
  if (style.strokeColor !== undefined) {
    g.lineStyle(1.5, style.strokeColor, alpha);
    g.strokeCircle(cx, cy, rRoot);
    g.strokeCircle(cx, cy, rHole);
  }
}
