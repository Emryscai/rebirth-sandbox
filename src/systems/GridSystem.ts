/**
 * 网格系统：坐标转换、占用判定、房屋格查询。
 * 网格为 10 列 x 14 行，每格 48px，整体偏移 (120, 60)。
 */

import {
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  GRID_OFFSET_X,
  GRID_OFFSET_Y,
  HOUSE_CELLS
} from '../config';

export interface Cell {
  col: number;
  row: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export class GridSystem {
  readonly cols = GRID_COLS;
  readonly rows = GRID_ROWS;
  readonly tileSize = TILE_SIZE;
  readonly offsetX = GRID_OFFSET_X;
  readonly offsetY = GRID_OFFSET_Y;

  /** 占用表：true 表示该格已被植物占据 */
  private occupied: boolean[][];

  /**
   * 壁垒封锁表：true 表示该格被「石墙壁垒」封死，僵尸无法穿过。
   *
   * 与 occupied 的区别：
   *   - occupied 是「有植物」，僵尸仍可踩上去啃；
   *   - blocked 是「不可通行」，连僵尸都不能进入（真正的墙）。
   * 壁垒由石墙生成时随机铺设（横排左右 或 竖排上下），石墙被摧毁时一并清除。
   */
  private blocked: boolean[][];

  /** 房屋格集合，键形如 "col,row" */
  private houseSet: Set<string>;

  constructor() {
    this.occupied = [];
    this.blocked = [];
    for (let r = 0; r < this.rows; r++) {
      this.occupied.push(new Array<boolean>(this.cols).fill(false));
      this.blocked.push(new Array<boolean>(this.cols).fill(false));
    }

    this.houseSet = new Set<string>();
    for (const c of HOUSE_CELLS) {
      if (this.isInside(c.col, c.row)) {
        this.houseSet.add(`${c.col},${c.row}`);
      }
    }
  }

  // ------------------------------------------------------------ 边界判定

  /** 格子索引是否在网格内 */
  isInside(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /** 是否为房屋格 */
  isHouse(col: number, row: number): boolean {
    return this.houseSet.has(`${col},${row}`);
  }

  // ------------------------------------------------------------ 壁垒封锁

  /** 该格是否被壁垒封锁（僵尸不可通行） */
  isBlocked(col: number, row: number): boolean {
    if (!this.isInside(col, row)) return false;
    return this.blocked[row][col];
  }

  /**
   * 设置某格为壁垒封锁格，返回是否成功。
   *
   * 拒绝条件：越界 / 房屋格 / 已有植物占据 / 已封锁。
   * 壁垒是「纯阻挡物」，不和植物共用格子，避免与啃食、子弹阻挡逻辑打架。
   */
  setBlocked(col: number, row: number): boolean {
    if (!this.isInside(col, row)) return false;
    if (this.isHouse(col, row)) return false;
    if (this.occupied[row][col]) return false; // 有植物的格子不封
    if (this.blocked[row][col]) return true;   // 已封锁视为成功（幂等）
    this.blocked[row][col] = true;
    return true;
  }

  /** 解除某格的壁垒封锁 */
  unblock(col: number, row: number): void {
    if (!this.isInside(col, row)) return;
    this.blocked[row][col] = false;
  }

  // ------------------------------------------------------------ 坐标转换

  /** 格子中心点像素坐标 */
  cellToCenter(col: number, row: number): PixelPoint {
    return {
      x: this.offsetX + col * this.tileSize + this.tileSize / 2,
      y: this.offsetY + row * this.tileSize + this.tileSize / 2
    };
  }

  /** 格子左上角像素坐标 */
  cellToTopLeft(col: number, row: number): PixelPoint {
    return {
      x: this.offsetX + col * this.tileSize,
      y: this.offsetY + row * this.tileSize
    };
  }

  /** 像素坐标转格子索引（可能越界，用 isInside 校验） */
  pixelToCell(x: number, y: number): Cell {
    return {
      col: Math.floor((x - this.offsetX) / this.tileSize),
      row: Math.floor((y - this.offsetY) / this.tileSize)
    };
  }

  /** 像素坐标是否落在整个网格区域内 */
  isPixelInsideGrid(x: number, y: number): boolean {
    return (
      x >= this.offsetX &&
      x < this.offsetX + this.cols * this.tileSize &&
      y >= this.offsetY &&
      y < this.offsetY + this.rows * this.tileSize
    );
  }

  /**
   * 世界坐标 -> 最近的格子（四舍五入到最近格心，而不是向下取整）。
   *
   * 与 pixelToCell 的区别：
   *   pixelToCell 用 floor，返回「点在哪个格子里」；
   *   pixelToNearestCell 返回「离哪个格心最近」。
   *
   * 格点冲刺必须用后者：僵尸的锚点理论上永远在格心上，
   * 但浮点误差 / 视觉偏移会让它偏几个像素。用 floor 会偶尔
   * 判到隔壁格，导致「原地抽搐」或者「隔空跳一格」。
   * 取最近格心可以吃掉这点误差。
   */
  pixelToNearestCell(x: number, y: number): Cell {
    return {
      col: Math.round((x - this.offsetX - this.tileSize / 2) / this.tileSize),
      row: Math.round((y - this.offsetY - this.tileSize / 2) / this.tileSize)
    };
  }

  /**
   * 世界坐标是否恰好（在容差内）落在某个格心上。
   *
   * 用于落脚点校验：冲刺结束时若不在格心，说明这一格算错了，
   * 应该强制吸附回去，绝不能把玩家留在格子边缘。
   */
  isOnCellCenter(x: number, y: number, tolerance = 1.5): boolean {
    const c = this.pixelToNearestCell(x, y);
    if (!this.isInside(c.col, c.row)) return false;
    const center = this.cellToCenter(c.col, c.row);
    return (
      Math.abs(x - center.x) <= tolerance && Math.abs(y - center.y) <= tolerance
    );
  }

  /**
   * 把一个格子整理成「合法的落脚点」。
   *
   * 合法 = 在网格内 且 不是房屋格。
   * 注意这里不检查植物占用：植物是僵尸的食物，踩进去是允许的。
   *
   * @returns 合法则返回该格中心的世界坐标；非法返回 null
   */
  resolveWalkableCenter(col: number, row: number): PixelPoint | null {
    if (!this.isInside(col, row)) return null;
    if (this.isHouse(col, row)) return null;
    return this.cellToCenter(col, row);
  }

  /**
   * 该格四个方向里是否存在至少一个可走的相邻格。
   *
   * PlantSpawner 用它避开「被房屋三面包死」的死角：
   * 玩家一旦进得去出不来，就会变成无敌挂机点。
   */
  hasWalkableNeighbor(col: number, row: number): boolean {
    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (const [dc, dr] of dirs) {
      if (this.resolveWalkableCenter(col + dc, row + dr)) return true;
    }
    return false;
  }

  /** 网格整体像素宽高 */
  get pixelWidth(): number {
    return this.cols * this.tileSize;
  }

  get pixelHeight(): number {
    return this.rows * this.tileSize;
  }

  // ------------------------------------------------------------ 占用

  /** 该格是否空闲且可放置（非房屋、未占用） */
  isFree(col: number, row: number): boolean {
    if (!this.isInside(col, row)) return false;
    if (this.isHouse(col, row)) return false;
    return !this.occupied[row][col];
  }

  /** 标记占用，返回是否成功 */
  occupy(col: number, row: number): boolean {
    if (!this.isFree(col, row)) return false;
    this.occupied[row][col] = true;
    return true;
  }

  /** 释放占用 */
  release(col: number, row: number): void {
    if (!this.isInside(col, row)) return;
    this.occupied[row][col] = false;
  }

  /** 查询占用状态 */
  isOccupied(col: number, row: number): boolean {
    if (!this.isInside(col, row)) return false;
    return this.occupied[row][col];
  }

  /** 当前已占用格数量 */
  get occupiedCount(): number {
    let n = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.occupied[r][c]) n++;
      }
    }
    return n;
  }

  /** 清空所有占用（重开时调用） */
  reset(): void {
    for (let r = 0; r < this.rows; r++) {
      this.occupied[r].fill(false);
    }
  }

  /** 收集所有空闲可放置格 */
  getFreeCells(): Cell[] {
    const cells: Cell[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.isFree(c, r)) cells.push({ col: c, row: r });
      }
    }
    return cells;
  }

  /**
   * 房屋格像素矩形，用于子弹碰撞判定。
   */
  getHouseRects(): Array<{ x: number; y: number; w: number; h: number }> {
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const c of HOUSE_CELLS) {
      if (!this.isInside(c.col, c.row)) continue;
      const tl = this.cellToTopLeft(c.col, c.row);
      rects.push({ x: tl.x, y: tl.y, w: this.tileSize, h: this.tileSize });
    }
    return rects;
  }
}
