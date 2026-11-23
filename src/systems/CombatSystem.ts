/**
 * 战斗系统：啃食判定。
 * 条件：按住/按下空格 + 50px 内存在最近植物 + 啃食计时完成。
 * 成功后：加进化点、回血、释放格子、移除植物。
 */

import Phaser from 'phaser';
import { PlayerZombie } from '../entities/PlayerZombie';
import { Plant } from '../entities/Plant';
import { PlantSpawner } from './PlantSpawner';
import { GridSystem } from './GridSystem';
import { PLAYER_ZOMBIE } from '../data/zombies';
import { PLANT_BITE_DAMAGE, PLANT_BITE_INTERVAL } from '../data/plants';

export interface EatResult {
  plant: Plant;
  pointsGained: number;
  healed: number;
}

export class CombatSystem {
  private scene: Phaser.Scene;
  private player: PlayerZombie;
  private spawner: PlantSpawner;
  private grid: GridSystem;

  /** 当前正在啃食的目标 */
  private currentTarget: Plant | null = null;
  /** 当前啃食进度（毫秒） */
  private eatProgress = 0;

  /**
   * 距离下一次「咬一口」的剩余毫秒。
   *
   * 啃食不再是「攒满一整条进度条再一次性吃掉」，
   * 而是每 PLANT_BITE_INTERVAL 咬一口、扣 PLANT_BITE_DAMAGE 点血，
   * 血归零植物才消失。这样植物头顶的血条才有意义。
   */
  private biteTimer = 0;

  /**
   * 啃食间隔倍率（狂暴链锯道具生效时为 0.5 = 间隔减半 = 频率翻倍）。
   * 由 GameScene 通过 setBiteIntervalMul 注入，默认 1。
   */
  private biteIntervalMul = 1;

  /** 当前实际咬合间隔（毫秒），受倍率影响，至少 60ms 防止异常 */
  private get biteInterval(): number {
    return Math.max(60, PLANT_BITE_INTERVAL * this.biteIntervalMul);
  }

  /** 啃食完成回调 */
  onEat?: (result: EatResult) => void;

  /** 啃食进度变化回调（用于 HUD 显示） */
  onProgress?: (ratio: number, active: boolean) => void;

  constructor(
    scene: Phaser.Scene,
    player: PlayerZombie,
    spawner: PlantSpawner,
    grid: GridSystem
  ) {
    this.scene = scene;
    this.player = player;
    this.spawner = spawner;
    this.grid = grid;
  }

  /**
   * 每帧更新啃食逻辑。
   * @param delta 帧间隔
   * @param pressing 本帧是否按住啃食键
   */
  update(delta: number, pressing: boolean): void {
    if (this.player.isDead) {
      this.abort();
      return;
    }

    // 松开按键：立即中断
    if (!pressing) {
      this.abort();
      return;
    }

    // ---- 目标锁定策略 ----
    // 一旦选定目标，只要它仍然有效且仍在啃食范围内，就继续啃它，
    // 不因为附近出现更近的另一株而中途换目标。
    // 否则玩家在两株植物之间移动时，进度会每帧被重置，永远吃不完。
    if (this.currentTarget) {
      const stillValid =
        this.currentTarget.active &&
        !this.currentTarget.isDying &&
        this.spawner.plants.includes(this.currentTarget) &&
        this.distanceTo(this.currentTarget) <= PLAYER_ZOMBIE.eatRange;

      if (!stillValid) {
        this.abort();
        // 落到下面的重新选目标流程
      }
    }

    // 没有锁定目标（首次或刚失效）：挑最近的一株
    if (!this.currentTarget) {
      const nearest = this.spawner.findNearest(this.player);
      if (!nearest || nearest.dist > PLAYER_ZOMBIE.eatRange) {
        this.abort();
        return;
      }
      this.currentTarget = nearest.plant;
      this.eatProgress = 0;
      // 刚咬住目标：第一口立刻生效，不用先等半个间隔
      this.biteTimer = 0;
      this.player.startEating();
    }

    // 让玩家持续保持啃食帧
    if (!this.player.isEating) {
      this.player.startEating();
    }

    const plant = this.currentTarget;

    // ---- 咬合计时 ----
    // 每 PLANT_BITE_INTERVAL 毫秒咬一口，扣 PLANT_BITE_DAMAGE 点血。
    // 用 while 而不是 if：万一某帧 delta 特别大（切后台回来），
    // 能把欠下的几口一次补上，而不是吞掉。
    this.eatProgress += delta;
    this.biteTimer -= delta;

    let guard = 0;
    while (this.biteTimer <= 0 && guard++ < 16) {
      this.biteTimer += this.biteInterval;

      // 目标可能在上一口就被啃死了
      if (!plant.active || plant.isDying) break;

      // 伤害取玩家当前的「攻击力」（商店永久攻击力可提升），
      // 默认等于 PLANT_BITE_DAMAGE，保持原有手感。
      const biteDamage = this.player.biteDamage > 0 ? this.player.biteDamage : PLANT_BITE_DAMAGE;
      // 先假定这一口是致命的（道具「啃食掉落」只认啃食，不认远程击杀）：
      // 若 takeDamage 后植物没死，再撤销标记，避免误伤后续的远程击杀判定。
      plant.markKilledByBite();
      const destroyed = plant.takeDamage(biteDamage);
      if (destroyed) {
        // 血归零 -> 植物消失，本次啃食结束
        this.finishEat(plant);
        return;
      }
      // 没啃死：撤销「致命」标记，避免这株植物之后被远程打死时误判为啃食掉落
      plant.unmarkKilledByBite();
    }

    // 进度条按「这株植物剩余血量的比例」来显示，
    // 这样 HUD 上的进度条等价于血条，不会和头顶血条打架。
    const ratio = Phaser.Math.Clamp(1 - plant.hp / Math.max(1, plant.maxHp), 0, 1);
    this.onProgress?.(ratio, true);
  }

  /** 啃食完成 */
  private finishEat(plant: Plant): void {
    if (!plant) return;

    // 吃掉一株植物：
    //   1) 正常回一小口血（eatHeal，而不是回满）；
    //   2) 永久提升最大生命值上限（eatMaxHpGain），当前血量也随之等量抬升。
    // 这样吃植物是「稳定成长」的正反馈，而不是「一次性灌满」。
    const before = this.player.hp;
    this.player.growMaxHp(PLAYER_ZOMBIE.eatMaxHpGain);
    this.player.heal(PLAYER_ZOMBIE.eatHeal);
    const healed = Math.max(0, this.player.hp - before);

    // 释放格子：只在「该格确实被这株植物占用」时释放，
    // 避免误释放已被其他植物复用的格子（格子一致性）。
    if (this.grid.isOccupied(plant.col, plant.row)) {
      this.grid.release(plant.col, plant.row);
    }

    // 从生成器列表移除并销毁（remove 内部幂等）
    this.spawner.remove(plant);
    plant.destroyPlant();

    const result: EatResult = {
      plant,
      pointsGained: 1,
      healed
    };

    this.currentTarget = null;
    this.eatProgress = 0;
    this.biteTimer = 0;
    this.onProgress?.(0, false);

    this.onEat?.(result);
  }

  /**
   * 设置啃食间隔倍率（狂暴链锯）。
   * @param mul 1 = 正常；0.5 = 间隔减半（频率翻倍）
   */
  setBiteIntervalMul(mul: number): void {
    this.biteIntervalMul = Number.isFinite(mul) && mul > 0 ? mul : 1;
  }

  /** 计算玩家到某株植物的距离 */
  private distanceTo(plant: Plant): number {
    const dx = plant.x - this.player.x;
    const dy = plant.y - this.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 中断啃食 */
  abort(): void {
    if (this.currentTarget) {
      this.currentTarget = null;
      this.eatProgress = 0;
      this.biteTimer = 0;
      this.onProgress?.(0, false);
    }
    if (this.player.isEating) {
      this.player.cancelEating();
    }
  }

  /** 当前是否有啃食目标 */
  get hasTarget(): boolean {
    return this.currentTarget !== null && this.currentTarget.active;
  }

  /** 当前目标植物 */
  get target(): Plant | null {
    return this.currentTarget;
  }
}
