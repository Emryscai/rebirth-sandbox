/**
 * 道具系统：地面掉落 + 拾取 + 手持道具槽（单槽、不可叠加、后来的替换先前的）。
 *
 * 职责边界（重要）：
 *   - 本系统只管理「掉落物生命、拾取、当前道具的计时与切换」；
 *   - 道具的**具体效果**（加护盾/加速度/生成弹球/回力镖/换锯子）由 GameScene
 *     通过 onActivate / onDeactivate 回调执行。
 *     这样道具系统与玩家、战斗、渲染解耦，改动单向、不易耦合出错。
 *
 * 单槽规则：
 *   - 同一时刻只生效一个道具；
 *   - 拾取新道具时，先触发旧道具的 onDeactivate（回退其效果），再触发新道具的 onActivate；
 *   - 有持续时间道具（靴子/锯子/弹球/回力镖）到期自动失效；
 *   - 铁板是一次性护盾，onActivate 后立即视为「已用掉」，不占槽、无计时。
 */

import Phaser from 'phaser';
import { GroundItem } from '../entities/GroundItem';
import { ITEMS, ALL_ITEM_IDS, type ItemDef, type ItemId } from '../data/items';
import { ITEM } from '../config';

export interface ItemSystemCallbacks {
  /** 道具生效时 */
  onActivate: (def: ItemDef) => void;
  /** 道具失效时（替换 / 到期） */
  onDeactivate: (def: ItemDef) => void;
  /** 拾取到道具时（UI 反馈） */
  onPickup: (def: ItemDef) => void;
  /** 持有锯子时捡到不能覆盖锯子的道具：转化为永久生命成长 */
  onChainsawBlocked?: (def: ItemDef) => void;
  /** 道具到期提示 */
  onExpire: (def: ItemDef) => void;
}

export class ItemSystem {
  private scene: Phaser.Scene;
  private cb: ItemSystemCallbacks;

  /** 地面掉落物 */
  private readonly ground: GroundItem[] = [];

  /** 当前生效道具 id（null = 无） */
  private activeId: ItemId | null = null;

  /** 当前道具剩余时间（毫秒）；一次性道具为 0 */
  private activeRemaining = 0;

  /** 是否已销毁 */
  private disposed = false;

  constructor(scene: Phaser.Scene, cb: ItemSystemCallbacks) {
    this.scene = scene;
    this.cb = cb;
  }

  // ------------------------------------------------------------ 掉落

  /** 在指定世界坐标掉落一个随机道具（15% 概率由调用方判定） */
  /** 调试用：随机掉一件（正式掉落由 GameScene 按植物类型判定） */
  dropRandom(x: number, y: number): void {
    if (this.disposed) return;
    const id = ALL_ITEM_IDS[Math.floor(Math.random() * ALL_ITEM_IDS.length)];
    this.dropAt(x, y, id);
  }

  /** 在指定坐标掉落指定道具 */
  dropAt(x: number, y: number, id: ItemId): void {
    if (this.disposed) return;
    if (!ITEMS[id]) return;

    // 限制地面道具数量，避免极端情况堆积
    if (this.ground.length >= 12) {
      const oldest = this.ground.shift();
      oldest?.safeDestroy();
    }

    const item = new GroundItem(this.scene, x, y, id);
    this.ground.push(item);
  }

  // ------------------------------------------------------------ 每帧

  /**
   * 每帧更新。
   *
   * @param delta 毫秒
   * @param playerX 玩家世界坐标 X
   * @param playerY 玩家世界坐标 Y
   * @param canPickup 是否允许拾取（死亡/结束时为 false）
   */
  update(delta: number, playerX: number, playerY: number, canPickup: boolean): void {
    if (this.disposed) return;

    // ---- 地面道具 ----
    const r = ITEM.pickupRadius;
    const r2 = r * r;
    for (let i = this.ground.length - 1; i >= 0; i--) {
      const gi = this.ground[i];
      if (!gi) {
        this.ground.splice(i, 1);
        continue;
      }

      if (!gi.active || gi.isConsumed) {
        this.ground.splice(i, 1);
        continue;
      }

      gi.update(delta);

      // 过期（update 内部会淡出并标记 consumed）
      if (gi.isConsumed) {
        this.ground.splice(i, 1);
        continue;
      }

      if (!canPickup) continue;

      const dx = gi.x - playerX;
      const dy = gi.y - playerY;
      if (dx * dx + dy * dy <= r2) {
        if (this.pickup(gi)) this.ground.splice(i, 1);
      }
    }

    // ---- 当前道具计时（一次性道具不进入此逻辑）----
    if (this.activeId) {
      const def = ITEMS[this.activeId];
      if (def && def.durationMs > 0) {
        this.activeRemaining -= delta;
        if (this.activeRemaining <= 0) {
          this.deactivateCurrent(true);
        }
      }
    }
  }

  /** 拾取一个地面道具；返回是否消耗该掉落物 */
  private pickup(gi: GroundItem): boolean {
    const def = ITEMS[gi.itemId];
    if (!def) return false;

    // 手持锯子时只有锯子/回力镖能替换；其他道具被锯子“吸收”为永久生命
    if (!this.canActivate(def.id)) {
      gi.pickup();
      this.cb.onPickup(def);
      this.cb.onChainsawBlocked?.(def);
      return true;
    }

    gi.pickup();
    this.cb.onPickup(def);

    // 激活新道具（先回退旧道具）
    this.activate(def.id);
    return true;
  }

  // ------------------------------------------------------------ 道具槽

  /**
   * 激活一个道具。
   *
   * 若当前已有其他道具，先失效旧道具（回退其效果）。
   * 铁板为一次性：直接触发 onActivate 后不占槽。
   */
  /** 当前槽位是否允许切换成 id */
  canActivate(id: ItemId): boolean {
    if (this.activeId !== 'chainsaw') return true;
    return id === 'chainsaw' || id === 'boomerang';
  }

  activate(id: ItemId): boolean {
    const def = ITEMS[id];
    if (!def) return false;
    if (!this.canActivate(id)) return false;

    // 先回退旧道具（同 id 也回退后重新施加，保证「刷新时长」语义清晰）
    if (this.activeId) {
      this.deactivateCurrent(false);
    }

    this.cb.onActivate(def);

    // 关键：无论是否有持续时间，都占用槽位记录当前道具 id。
    // 一次性道具（铁板）durationMs=0 不会有计时，但它仍「占着槽」，
    // 这样之后再拾取任何新道具时，会先走 deactivateCurrent → onDeactivate，
    // 把旧道具（含其贴图/外观）彻底移除，实现「新道具覆盖旧道具」。
    this.activeId = id;
    this.activeRemaining = def.durationMs > 0 ? def.durationMs : 0;
    return true;
  }

  /**
   * 失效当前道具。
   * @param expired true = 自然到期（触发 onExpire），false = 被替换
   */
  private deactivateCurrent(expired: boolean): void {
    const id = this.activeId;
    if (!id) return;
    const def = ITEMS[id];
    this.activeId = null;
    this.activeRemaining = 0;

    if (!def) return;
    try {
      this.cb.onDeactivate(def);
    } catch (err) {
      console.error('[ItemSystem] onDeactivate 异常:', err);
    }
    if (expired) {
      try {
        this.cb.onExpire(def);
      } catch (err) {
        console.error('[ItemSystem] onExpire 异常:', err);
      }
    }
  }

  /** 强制清空所有道具与掉落（重开/结束） */
  reset(): void {
    if (this.activeId) {
      const def = ITEMS[this.activeId];
      this.activeId = null;
      this.activeRemaining = 0;
      if (def) {
        try {
          this.cb.onDeactivate(def);
        } catch {
          /* 清理阶段忽略 */
        }
      }
    }
    for (const gi of this.ground) {
      try {
        gi.safeDestroy();
      } catch {
        /* 忽略 */
      }
    }
    this.ground.length = 0;
  }

  /** 场景关闭销毁 */
  destroy(): void {
    this.disposed = true;
    this.reset();
  }

  // ------------------------------------------------------------ 查询

  get currentId(): ItemId | null {
    return this.activeId;
  }

  get currentDef(): ItemDef | null {
    return this.activeId ? ITEMS[this.activeId] : null;
  }

  /** 当前道具剩余毫秒（无则 0） */
  get remainingMs(): number {
    return Math.max(0, this.activeRemaining);
  }

  /** 地面道具数量 */
  get groundCount(): number {
    return this.ground.length;
  }
}
