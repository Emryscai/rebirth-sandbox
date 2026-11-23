/**
 * 进化系统。
 * 三阶段进阶（含初始共四级数据），需求 5 / 12 / 25 进化点。
 * 升级时修改速度、血量上限、缩放。
 */

import { EVOLUTION_STAGES, type EvolutionStage } from '../config';
import { PlayerZombie } from '../entities/PlayerZombie';

export class EvolutionSystem {
  private player: PlayerZombie;

  /** 已累计进化点 */
  private points = 0;

  /** 升级回调 */
  onLevelUp?: (stage: EvolutionStage, index: number) => void;

  constructor(player: PlayerZombie) {
    this.player = player;
    this.points = 0;
  }

  /** 增加进化点，返回本次是否升级 */
  addPoints(n: number): boolean {
    this.points += n;
    const nextIndex = this.player.evolutionIndex + 1;
    const nextStage = EVOLUTION_STAGES[nextIndex];

    if (!nextStage) return false;
    if (this.points < nextStage.requiredPoints) return false;

    this.player.applyEvolution(nextIndex);
    this.onLevelUp?.(nextStage, nextIndex);
    return true;
  }

  get currentPoints(): number {
    return this.points;
  }

  get stageIndex(): number {
    return this.player.evolutionIndex;
  }

  get stage(): EvolutionStage {
    return EVOLUTION_STAGES[this.player.evolutionIndex];
  }

  /** 下一阶段，已满级返回 null */
  get nextStage(): EvolutionStage | null {
    return EVOLUTION_STAGES[this.player.evolutionIndex + 1] ?? null;
  }

  /** 距下一阶段的进度 0..1，满级返回 1 */
  get progressToNext(): number {
    const next = this.nextStage;
    if (!next) return 1;
    const cur = this.stage.requiredPoints;
    const span = next.requiredPoints - cur;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (this.points - cur) / span));
  }

  /** 是否已满级 */
  get isMaxStage(): boolean {
    return this.nextStage === null;
  }
}
