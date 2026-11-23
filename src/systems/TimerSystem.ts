/**
 * 计时系统。
 * 累计存活时间，每到 10 秒发放 1 尸币。
 */

import { TIMER } from '../config';

export class TimerSystem {
  /** 累计存活毫秒 */
  private elapsedMs = 0;
  /** 已发放尸币 */
  private coins = 0;
  /** 距离下次发币的累计时间 */
  private coinAccumulator = 0;
  /** 是否暂停（玩家死亡后停止计时） */
  private paused = false;

  /** 发币回调 */
  onCoin?: (totalCoins: number) => void;

  /**
   * 每帧推进。
   *
   * 存活计时只依赖 delta 累加，不做任何基于帧数的推算。
   * 死亡后由 pause() 冻结，数值不归零，供结算读取。
   *
   * @param delta 帧间隔毫秒（调用方已 clamp）
   */
  update(delta: number): void {
    if (this.paused) return;
    if (!Number.isFinite(delta) || delta <= 0) return;

    this.elapsedMs += delta;
    this.coinAccumulator += delta;

    // 单帧最多补发 MAX_COINS_PER_FRAME 枚，防止异常大 delta 造成长循环卡帧
    const MAX_COINS_PER_FRAME = 10;
    let issued = 0;
    while (
      this.coinAccumulator >= TIMER.coinIntervalMs &&
      issued < MAX_COINS_PER_FRAME
    ) {
      this.coinAccumulator -= TIMER.coinIntervalMs;
      this.coins += 1;
      issued += 1;
      try {
        this.onCoin?.(this.coins);
      } catch (err) {
        // 发币回调出错不得中断计时
        console.error('[TimerSystem] onCoin 回调异常:', err);
      }
    }

    // 兜底：若仍有超量累积（极端情况），直接丢弃避免下一帧继续爆
    if (this.coinAccumulator > TIMER.coinIntervalMs * MAX_COINS_PER_FRAME) {
      this.coinAccumulator = 0;
    }
  }

    /**
   * 花费尸币。
   *
   * 余额不足时返回 false 且不做任何改动；成功则扣减并返回 true。
   * 商店购买统一走这里，保证「扣币」只有一个入口、不会出现负数。
   */
  /** 直接增加尸币（石墙奖励等），返回最新余额 */
  addCoins(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return this.coins;
    this.coins += Math.floor(amount);
    return this.coins;
  }

  spend(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (this.coins < amount) return false;
    this.coins -= amount;
    return true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  reset(): void {
    this.elapsedMs = 0;
    this.coins = 0;
    this.coinAccumulator = 0;
    this.paused = false;
  }

  get elapsed(): number {
    return this.elapsedMs;
  }

  get coinCount(): number {
    return this.coins;
  }

  /** 距下次发币剩余毫秒 */
  get msToNextCoin(): number {
    return Math.max(0, TIMER.coinIntervalMs - this.coinAccumulator);
  }
}
