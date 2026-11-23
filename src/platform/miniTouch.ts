/**
 * 小游戏触摸 UI 桥。
 *
 * 部分微信基础库/鸿蒙设备上，Phaser 的 canvas touchstart/touchmove
 * 桥接不可靠：棋盘已经改走 wx.onTouch*，但商店、暂停、结果页等
 * Phaser 按钮仍会出现“点了没反应/过几秒才响应”。
 *
 * 这里直接监听 wx.onTouch*，按游戏设计坐标对当前最上层场景做
 * hitTest，再把 pointerdown/pointerup 事件发给命中的游戏对象。
 * H5 完全不走这里。
 */

import Phaser from 'phaser';

interface MiniTouchPoint {
  identifier?: number;
  pageX?: number;
  pageY?: number;
  clientX?: number;
  clientY?: number;
  x?: number;
  y?: number;
}

interface MiniTouchEvent {
  touches?: MiniTouchPoint[];
  changedTouches?: MiniTouchPoint[];
}

interface MiniWx {
  getSystemInfoSync?: () => {
    screenWidth?: number;
    screenHeight?: number;
    windowWidth?: number;
    windowHeight?: number;
  };
  onTouchStart?: (cb: (e: MiniTouchEvent) => void) => void;
  onTouchMove?: (cb: (e: MiniTouchEvent) => void) => void;
  onTouchEnd?: (cb: (e: MiniTouchEvent) => void) => void;
  onTouchCancel?: (cb: (e: MiniTouchEvent) => void) => void;
}

export function installMiniTouchRouter(game: Phaser.Game): void {
  const wxApi = (globalThis as unknown as { wx?: MiniWx }).wx;
  if (
    !wxApi?.onTouchStart ||
    !wxApi?.onTouchEnd ||
    !game?.input
  ) {
    return;
  }

  // 避免 Phaser 自己再发一遍触摸事件造成按钮双击
  game.input.enabled = false;

  let lastDown: {
    scene: Phaser.Scene;
    object: Phaser.GameObjects.GameObject;
    pointer: Phaser.Input.Pointer;
  } | null = null;

  const screenSize = (): { w: number; h: number } => {
    try {
      const info = wxApi.getSystemInfoSync?.();
      return {
        w: Number(info?.screenWidth || info?.windowWidth || 0),
        h: Number(info?.screenHeight || info?.windowHeight || 0)
      };
    } catch {
      return { w: 0, h: 0 };
    }
  };

  const topScene = (): Phaser.Scene | null => {
    const active = game.scene.getScenes(true);
    for (let i = active.length - 1; i >= 0; i--) {
      const scene = active[i];
      if (scene && scene.input && scene.input.enabled && scene.cameras?.main) {
        return scene;
      }
    }
    return null;
  };

  const makePointer = (
    scene: Phaser.Scene,
    touch: MiniTouchPoint
  ): Phaser.Input.Pointer | null => {
    const { w, h } = screenSize();
    if (!(w > 0) || !(h > 0)) return null;
    const canvas = game.canvas;
    const cx = canvas.width;
    const cy = canvas.height;
    const rawX =
      touch.clientX != null
        ? touch.clientX
        : touch.pageX != null
          ? touch.pageX
          : touch.x || 0;
    const rawY =
      touch.clientY != null
        ? touch.clientY
        : touch.pageY != null
          ? touch.pageY
          : touch.y || 0;
    const x = rawX * (cx / w);
    const y = rawY * (cy / h);
    const camera = scene.cameras.main;
    const world = camera.getWorldPoint(x, y);
    return {
      id: Number(touch.identifier ?? 1),
      x,
      y,
      worldX: world.x,
      worldY: world.y,
      isDown: true,
      camera,
      // 输入命中只用到 x/y/world/camera；其余字段给事件回调兜底
      event: undefined
    } as unknown as Phaser.Input.Pointer;
  };

  const hitTop = (
    scene: Phaser.Scene,
    pointer: Phaser.Input.Pointer
  ): Phaser.GameObjects.GameObject | null => {
    if (!scene.children?.list) return null;
    try {
      const hits = scene.input.manager.hitTest(
        pointer,
        scene.children.list,
        scene.cameras.main
      );
      for (const obj of hits) {
        if (obj?.input?.enabled && obj.listenerCount('pointerdown') > 0) {
          return obj;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  const down = (e: MiniTouchEvent): void => {
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (!touch) return;
    const scene = topScene();
    if (!scene) return;
    const pointer = makePointer(scene, touch);
    if (!pointer) return;
    const object = hitTop(scene, pointer);
    if (!object) return;
    lastDown = { scene, object, pointer };
    object.emit('pointerdown', pointer);
  };

  const up = (e: MiniTouchEvent): void => {
    if (!lastDown) return;
    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    const { scene, object, pointer } = lastDown;
    lastDown = null;
    // 用抬起位置重算一次，保证 pointerup 的世界坐标正确
    if (touch) {
      const p2 = makePointer(scene, touch);
      if (p2) {
        object.emit('pointerup', p2);
        object.emit('pointerout', p2);
        return;
      }
    }
    object.emit('pointerup', pointer);
    object.emit('pointerout', pointer);
  };

  wxApi.onTouchStart(down);
  wxApi.onTouchEnd(up);
  wxApi.onTouchCancel?.(up);
}
