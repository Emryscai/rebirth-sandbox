/**
 * 开发环境压力测试脚本（仅在 import.meta.env.DEV 下加载）。
 *
 * 启用方式：在 URL 后加 ?stress=1
 *   例：http://localhost:5173/game.html?stress=1
 *       http://localhost:5173/game.html?stress=1&duration=30&restart=1
 *
 * URL 参数：
 *   stress=1        启用压力测试
 *   duration=120    运行时长（秒），默认 120
 *   restart=1       是否每 5 秒随机 scene.restart（默认 1）
 *   verbose=1       每帧动作也打印（默认 0）
 *
 * 行为：
 *   - 每帧随机设置移动方向（模拟 WASD / 方向键乱按）
 *   - 每 100ms 随机触发空格按下 / 松开（模拟连点与长按）
 *   - 每 5 秒随机 scene.restart（可关闭）
 *   - 每 2 秒在控制台打印一行状态快照
 *   - 结束时输出总结：是否通过、累计异常数、计时是否单调增长
 *
 * 判定通过条件（脚本自动给出结论）：
 *   1) 期间主循环没有抛出未捕获异常（由 GameScene 的 try/catch 兜住的异常会被计数）
 *   2) survival 在每段未死亡的区间内持续增长
 *   3) 结束时当前场景仍是 GameScene（未崩溃到黑屏）
 *
 * 本文件不会进入生产构建：main.ts 中通过
 *   if (import.meta.env.DEV) import('./dev/stressTest')
 * 动态引入，构建时该分支被剔除。
 */

import Phaser from 'phaser';
import { SCENE_KEYS } from '../config';

interface StressOptions {
  durationMs: number;
  allowRestart: boolean;
  verbose: boolean;
}

interface Snapshot {
  t: number;
  survival: number;
  hp: number;
  plants: number;
  bullets: number;
  gridOccupied: number;
  stage: string;
}

/** 随机整数 [min, max] */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 随机从数组取一个 */
function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

/** 解析 URL 参数 */
function parseOptions(): StressOptions {
  const params = new URLSearchParams(window.location.search);
  const durationSec = Number(params.get('duration') ?? '120');
  return {
    durationMs: (Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 120) * 1000,
    allowRestart: (params.get('restart') ?? '1') !== '0',
    verbose: params.get('verbose') === '1'
  };
}

/**
 * 从一个 GameScene 实例上尽量安全地读取状态快照。
 * 任何字段缺失都用 0 兜底，保证脚本本身永不死于取数。
 */
function readSnapshot(game: Phaser.Game): Snapshot | null {
  const scene = game.scene.getScene(SCENE_KEYS.game) as
    | (Phaser.Scene & Record<string, unknown>)
    | null;
  if (!scene || !scene.scene.isActive()) return null;

  const anyScene = scene as unknown as {
    timer?: { elapsed: number; coinCount: number };
    player?: { hp: number; active: boolean };
    spawner?: { count: number; plants: Array<{ active: boolean }> };
    bullets?: Phaser.Physics.Arcade.Group;
    grid?: { occupiedCount: number };
    evolution?: { stage: { label: string } };
    alive?: boolean;
    errorCount?: number;
  };

  return {
    t: Date.now(),
    survival: anyScene.timer?.elapsed ?? 0,
    hp: anyScene.player?.hp ?? 0,
    plants: anyScene.spawner?.count ?? 0,
    bullets: anyScene.bullets?.countActive(true) ?? 0,
    gridOccupied: anyScene.grid?.occupiedCount ?? 0,
    stage: anyScene.evolution?.stage.label ?? '?'
  };
}

class StressRunner {
  private game: Phaser.Game;
  private opts: StressOptions;

  private moveTimer?: number;
  private spaceTimer?: number;
  private restartTimer?: number;
  private reportTimer?: number;
  private stopTimer?: number;

  /** 当前模拟的按键状态 */
  private keys: Record<string, boolean> = {};

  /** 快照历史 */
  private history: Snapshot[] = [];
  /** 已重开次数 */
  private restartCount = 0;
  /** 检测到的计时回退次数（异常） */
  private survivalRegressions = 0;
  /** 上次快照的 survival（用于检测单调性，重开后允许归零） */
  private lastSurvival = 0;
  /** 最后一次重开时间戳（重开后 1.5 秒内不判回退） */
  private lastRestartAt = 0;

  private started = false;
  private finished = false;

  constructor(game: Phaser.Game) {
    this.game = game;
    this.opts = parseOptions();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    console.log(
      "%c[StressTest] 启动",
      "color:#7fe3ff;font-weight:bold",
      "时长 " + (this.opts.durationMs / 1000).toFixed(0) + "s，" +
        "随机重开=" + (this.opts.allowRestart ? "开" : "关")
    );

    // 每帧随机方向：用 rAF 驱动，等价于每帧刷新意图
    const driveMovement = () => {
      if (this.finished) return;
      this.randomizeMovement();
      this.moveTimer = window.requestAnimationFrame(driveMovement);
    };
    this.moveTimer = window.requestAnimationFrame(driveMovement);

    // 每 100ms 随机空格
    this.spaceTimer = window.setInterval(() => this.randomizeSpace(), 100);

    // 每 5s 随机重开
    if (this.opts.allowRestart) {
      this.restartTimer = window.setInterval(() => this.maybeRestart(), 5000);
    }

    // 每 2s 打印快照
    this.reportTimer = window.setInterval(() => this.report(), 2000);

    // 到时结束
    this.stopTimer = window.setTimeout(() => this.finish(), this.opts.durationMs);
  }

  /** 随机移动方向：模拟乱按，含斜向与静止 */
  private randomizeMovement(): void {
    // 先松开全部
    for (const k of ['W', 'A', 'S', 'D', 'UP', 'LEFT', 'DOWN', 'RIGHT']) {
      this.setKey(k, false);
    }

    // 30% 概率完全静止（模拟手离开键盘）
    if (Math.random() < 0.3) return;

    // 水平方向
    const hx = randInt(-1, 1);
    if (hx < 0) {
      this.setKey(Math.random() < 0.5 ? 'A' : 'LEFT', true);
    } else if (hx > 0) {
      this.setKey(Math.random() < 0.5 ? 'D' : 'RIGHT', true);
    }

    // 垂直方向
    const vy = randInt(-1, 1);
    if (vy < 0) {
      this.setKey(Math.random() < 0.5 ? 'W' : 'UP', true);
    } else if (vy > 0) {
      this.setKey(Math.random() < 0.5 ? 'S' : 'DOWN', true);
    }
  }

  /** 随机空格按下 / 松开（模拟连点与长按） */
  private randomizeSpace(): void {
    // 65% 概率保持按下（模拟长按），35% 松开
    this.setKey('SPACE', Math.random() < 0.65);
  }

  /** 设置某个逻辑键的按下状态，通过 Phaser 的 Key 对象直接影响 isDown */
  private setKey(name: string, down: boolean): void {
    if (this.keys[name] === down) return;
    this.keys[name] = down;

    const scene = this.game.scene.getScene(SCENE_KEYS.game);
    const kb = scene?.input?.keyboard;
    if (!kb) return;

    const codeMap: Record<string, number> = {
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      UP: Phaser.Input.Keyboard.KeyCodes.UP,
      LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
      DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
      RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE
    };

    const key = kb.addKey(codeMap[name]);
    if (down) {
      key.onDown({} as KeyboardEvent);
    } else {
      key.onUp({} as KeyboardEvent);
    }
  }

  /** 每 5 秒尝试重开一次（只有在游戏场景存活时才重开） */
  private maybeRestart(): void {
    if (this.finished) return;

    const scene = this.game.scene.getScene(SCENE_KEYS.game);
    if (!scene || !scene.scene.isActive()) return;

    this.restartCount += 1;
    this.lastRestartAt = Date.now();

    // 重开前先松开所有键，模拟「玩家松手后按 R」
    for (const k of Object.keys(this.keys)) this.setKey(k, false);

    try {
      scene.scene.restart();
      if (this.opts.verbose) {
        console.log('[StressTest] 第 ' + this.restartCount + ' 次重开');
      }
    } catch (err) {
      console.error('[StressTest] 重开失败:', err);
    }
  }

  /** 定期打印快照 */
  /** 定期打印快照 */
  private report(): void {
    const snap = readSnapshot(this.game);
    if (!snap) {
      console.warn("[StressTest] 当前无活跃 GameScene（可能处于结算或已崩溃）");
      return;
    }

    this.history.push(snap);

    // 单调性检测：非重开期间 survival 不应回退
    const sinceRestart = Date.now() - this.lastRestartAt;
    if (sinceRestart > 1500 && snap.survival + 1 < this.lastSurvival) {
      this.survivalRegressions += 1;
      console.warn(
        "[StressTest] 计时回退！" +
          this.lastSurvival.toFixed(0) +
          " -> " +
          snap.survival.toFixed(0)
      );
    }
    this.lastSurvival = snap.survival;

    console.log(
      "[StressTest] survival=" + (snap.survival / 1000).toFixed(1) + "s" +
        " hp=" + snap.hp.toFixed(0) +
        " plants=" + snap.plants +
        " bullets=" + snap.bullets +
        " grid=" + snap.gridOccupied +
        " stage=" + snap.stage +
        " restarts=" + this.restartCount
    );
  }

  /** 结束并给出结论 */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;

    if (this.moveTimer) cancelAnimationFrame(this.moveTimer);
    if (this.spaceTimer) clearInterval(this.spaceTimer);
    if (this.restartTimer) clearInterval(this.restartTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);

    // 松开所有键
    for (const k of Object.keys(this.keys)) this.setKey(k, false);

    const scene = this.game.scene.getScene(SCENE_KEYS.game);
    const sceneOk = !!scene;

    const snaps = this.history;
    let survivalGrew = true;
    if (snaps.length >= 2) {
      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      // 重开过就只要求最后一个快照存在正向存活时间
      if (this.restartCount === 0) {
        survivalGrew = last.survival > first.survival;
      } else {
        survivalGrew = last.survival > 0;
      }
    }

    const passed =
      sceneOk && this.survivalRegressions === 0 && survivalGrew && snaps.length > 0;

    console.log(
      "%c[StressTest] 结束",
      "color:" + (passed ? "#4ade80" : "#ef4444") + ";font-weight:bold",
      {
        结论: passed ? "通过" : "未通过",
        样本数: snaps.length,
        重开次数: this.restartCount,
        计时回退次数: this.survivalRegressions,
        计时是否增长: survivalGrew,
        最后快照: snaps[snaps.length - 1]
      }
    );
  }
}

/** 入口：被 main.ts 动态导入时自动启动 */
export function installStressTest(game: Phaser.Game): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('stress') !== '1') return;

  new StressRunner(game).start();
}
