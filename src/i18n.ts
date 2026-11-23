/**
 * 轻量国际化（i18n）模块。
 *
 * 目标：支持切换「界面语言」，先提供中文 / 英文两套，
 * 便于面向海外常见国家发行。所有可见文案统一从这里取，
 * 避免散落硬编码。
 *
 * 设计要点：
 *   - 纯数据 + 纯函数，无 Phaser 依赖，任何场景/UI 都能引入。
 *   - 语言状态是「全局单例」，持久化到 localStorage（经 platform/storage）。
 *   - 提供 t(key) 与 tf(key, params) 两种取词方式（后者支持 {name} 占位）。
 *   - 语言切换后，由调用方负责刷新界面（或在切换时回调订阅者）。
 */

import { loadSettings, saveSettings } from './platform/storage';

export type Language = 'zh' | 'en';

/** 支持的语言（顺序即设置界面里的排列顺序） */
export const LANGUAGES: ReadonlyArray<{ id: Language; label: string; nativeLabel: string }> = [
  { id: 'zh', label: '中文', nativeLabel: '中文' },
  { id: 'en', label: 'English', nativeLabel: 'English' }
];

type Dict = Record<string, string>;

/** 中文文案 */
const ZH: Dict = {
  'common.confirm': '确定',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.back': '返回',

  'boot.title': '重生沙盘',
  'boot.loading': '加载中…',

  'hud.survival': '存活',
  'hud.coins': '金币',
  'hud.hp': '生命值',
  'hud.plants': '植物',
  'hud.maxed': '满级',
  'hud.coinsValue': '金币 {n}',
  'hud.plantsValue': '植物 {n}',
  'hud.hint': 'WASD / 方向键 移动　空格 攻击　Esc 暂停',
  'hud.hintTouch': '滑动屏幕移动　按住屏幕攻击',
  'hud.tutorial': '滑动屏幕移动，按住屏幕攻击植物',
  'tutorial.title': '十格求生',
  'tutorial.move': '滑动屏幕 / 方向键移动',
  'tutorial.eat': '按住棋盘或「攻击」吃掉植物',
  'tutorial.survive': '躲开弹丸，活得越久越强',
  'tutorial.start': '开始',
  'ticker.rules': '规则：滑动/方向键移动 · 按住攻击 · 越活越强',
  'hud.shield': '护盾 {n}',
  'flash.shieldAbsorb': '护盾吸收 -{n}',
  'leaderboard.title': '排行榜',
  'leaderboard.tab.friends': '好友 Top10',
  'leaderboard.tab.global': '全服 Top10',
  'leaderboard.tab.local': '本机 Top10',
  'leaderboard.empty.friends': '好友榜暂未接入\n接入微信开放数据域后显示',
  'leaderboard.empty.global': '全服榜暂未接入\n配置服务器 API 后显示',
  'leaderboard.empty.local': '还没有记录\n完成一局后自动上榜',
  'leaderboard.loading': '加载中…',
  'leaderboard.hint': '按 ESC 关闭',
  'hud.shop': '商店',
  'hud.settings': '设置',
  'hud.pause': '暂停',
  'hud.eat': '攻击',

  'stage.0': '幼体',
  'stage.1': '成体',
  'stage.2': '强化体',
  'stage.3': '完全体',

  'pause.title': '暂停',
  'pause.cancel': '取消',
  'pause.continue': '继续',
  'pause.restart': '重开',

  'result.title': '挑战失败',
  'result.survival': '存活时间',
  'result.newBest': '新纪录！',
  'result.best': '最高纪录',
  'result.stats': '金币 {coins}　　进化点 {points}　　{stage}',
  'result.restart': '按 R 重新开始',
  'result.restartButton': '再来一局',
  'result.share': '分享',
  'result.credit': '作者：JiahaoCai',

  'revive.title': '挑战失败',
  'revive.desc': '看一段广告，立刻重返棋盘并恢复 60% 生命值（本局仅一次）',
  'revive.watch': '看广告继续挑战',
  'revive.giveUp': '放弃，查看结算',
  'revive.loading': '广告加载中…',
  'revive.failed': '广告暂不可用，请稍后再试',
  'revive.revived': '继续挑战！',
  'revive.remaining': '本局还可继续挑战 {n} 次',
  'revive.noMore': '本局的继续机会已经用过了，下次跑得更远一点吧。',
  'revive.noReviveLeft': '本局继续次数已用完',
  'revive.needFull': '需要完整看完广告才能继续',

  'ad.loading': '加载中…',
  'ad.unavailable': '当前平台暂无广告',
  'ad.failed': '广告加载失败',

  'shop.title': '商店',
  'shop.tab.buff': '增益',
  'shop.tab.item': '道具',
  'shop.tab.super': '超级商店',
  'shop.buy': '购买',
  'shop.buyHighlight': '▶ 购买',
  'shop.owned': '已拥有',
  'shop.notEnough': '金币不足',
  'shop.locked': '未解锁',
  'shop.toast.locked': '达到最高进化阶段后开放',
  'shop.toast.owned': '已经购买过了',
  'shop.toast.notEnough': '金币不足',
  'shop.toast.failed': '购买失败',
  'shop.toast.bought': '已购买：{name}',
  'shop.price': '{n} 金币',
  'shop.balance': '金币 {n}',
  'shop.hint': '↑/↓ 选择　Enter/空格 购买　Tab 切换页　Esc 关闭',
  'shop.hintTouch': '点击卡片购买　点击标签切页',
  'shop.cannotBuy': '无法购买',

  'settings.title': '设置',
  'settings.language': '语言 / Language',
  'settings.volume': '音量',
  'settings.volumeValue': '{n}%',
  'settings.hint': '点击切换语言　拖动滑块调整音量　Esc 关闭',

  'flash.points': '+{n} 进化',
  'flash.levelUp': '进化：{stage}',
  'flash.coin': '+1 金币',
  'flash.coinWall': '石墙碎裂，+{n} 金币',
  'flash.plantCoin': '植物掉落，+{n} 金币',
  'flash.pickup': '拾取：{name}',
  'flash.sawAbsorb': '切割器挡下 {name}：最大生命 +25',
  'flash.itemExpire': '{name} 效果结束',
  'flash.bought': '购买：{name}',

  'shopitem.heal-small.name': '快速回复',
  'shopitem.heal-small.desc': '立即恢复 25 点生命值',
  'shopitem.heal-full.name': '大快朵颐',
  'shopitem.heal-full.desc': '生命值回满',
  'shopitem.max-hp.name': '强壮体魄',
  'shopitem.max-hp.desc': '最大生命值 +25（并回满）',
  'shopitem.shield.name': '铁皮护盾',
  'shopitem.shield.desc': '持续 8 秒，免疫下一次伤害',
  'shopitem.speed.name': '疾行',
  'shopitem.speed.desc': '移动速度永久 +6',
  'shopitem.evolution.name': '进化结晶',
  'shopitem.evolution.desc': '进化点 +5',
  'shopitem.invincible.name': '星辉庇护',
  'shopitem.invincible.desc': '关闭商店后 5 秒内免疫伤害，头顶显示倒计时',
  'shopitem.growth-hp.name': '不灭体魄',
  'shopitem.growth-hp.desc': '永久提升生命值 +25%',
  'shopitem.growth-atk.name': '锋利之牙',
  'shopitem.growth-atk.desc': '永久提升攻击力 +25%',
  'shopitem.growth-speed.name': '疾风之躯',
  'shopitem.growth-speed.desc': '永久提升移动速度 +25%',

  'item.iron-plate.name': '铁板',
  'item.iron-plate.desc': '一次性护盾 +125，挂在左手当盾牌',
  'item.iron-plate.flavor': '把家里的锅盖拆下来了，挡一挡弹丸刚刚好。',
  'item.boots.name': '疾风残靴',
  'item.boots.desc': '60 秒内移动速度 +25',
  'item.boots.flavor': '虽然只剩半只，但跑起来还真快。',
  'item.chainsaw.name': '合金切割器',
  'item.chainsaw.desc': '60 秒内自动攻击附近植物',
  'item.chainsaw.flavor': '别用牙齿了，那太文明。让切割器来告诉你什么叫效率。',
  'item.bouncing-orb.name': '弹射异球',
  'item.bouncing-orb.desc': '60 秒内每 1.5 秒甩手投出一颗弹跳球，碰到植物/墙壁反弹',
  'item.bouncing-orb.flavor': '就像在打一场致命的台球，而满地的植物就是你的球袋。',
  'item.boomerang.name': '回旋骨镖',
  'item.boomerang.desc': '60 秒内每 1.6 秒甩手掷出回旋镖，穿透植物、去回各造成一次伤害',
  'item.boomerang.flavor': '扔出去，不管有没有打中，它总会带着植物的残渣回到你手里。'
};

/** 英文文案 */
const EN: Dict = {
  'common.confirm': 'OK',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.back': 'Back',

  'boot.title': 'Rebirth Sandbox',
  'boot.loading': 'Loading…',

  'hud.survival': 'Survived',
  'hud.coins': 'Coins',
  'hud.hp': 'HP',
  'hud.plants': 'Plants',
  'hud.maxed': 'MAX',
  'hud.coinsValue': 'Coins {n}',
  'hud.plantsValue': 'Plants {n}',
  'hud.hint': 'WASD / Arrows to move  Space to attack  Esc to pause',
  'hud.hintTouch': 'Swipe to move  Hold to attack',
  'hud.tutorial': 'Swipe to move. Hold anywhere to attack plants.',
  'tutorial.title': 'Survive the Grid',
  'tutorial.move': 'Swipe / arrow keys to move',
  'tutorial.eat': 'Hold the board or ATTACK to bite plants',
  'tutorial.survive': 'Dodge projectiles. The longer you live, the stronger you get.',
  'tutorial.start': 'Start',
  'ticker.rules': 'How to play: move · hold to attack · survive to evolve',
  'hud.shield': 'Shield {n}',
  'flash.shieldAbsorb': 'Shield absorbed -{n}',
  'leaderboard.title': 'Leaderboard',
  'leaderboard.tab.friends': 'Friends Top10',
  'leaderboard.tab.global': 'Global Top10',
  'leaderboard.tab.local': 'This Device',
  'leaderboard.empty.friends': 'Friends ranking is not connected yet.',
  'leaderboard.empty.global': 'Global ranking is not connected yet.',
  'leaderboard.empty.local': 'No record yet. Finish a run to enter.',
  'leaderboard.loading': 'Loading…',
  'leaderboard.hint': 'ESC to close',
  'hud.shop': 'Shop',
  'hud.settings': 'Settings',
  'hud.pause': 'Pause',
  'hud.eat': 'ATTACK',

  'stage.0': 'Hatchling',
  'stage.1': 'Adult',
  'stage.2': 'Enhanced',
  'stage.3': 'Apex',

  'pause.title': 'Paused',
  'pause.cancel': 'Cancel',
  'pause.continue': 'Continue',
  'pause.restart': 'Restart',

  'result.title': 'Challenge Failed',
  'result.survival': 'Survival Time',
  'result.newBest': 'New Record!',
  'result.best': 'Best',
  'result.stats': 'Coins {coins}　Evo {points}　{stage}',
  'result.restart': 'Press R to Restart',
  'result.restartButton': 'Play Again',
  'result.share': 'Share',
  'result.credit': 'Created by JiahaoCai',

  'revive.title': 'Challenge Failed',
  'revive.desc': 'Watch an ad to continue with 60% HP (once per run)',
  'revive.watch': 'Watch Ad to Continue',
  'revive.giveUp': 'Give Up and See Results',
  'revive.loading': 'Loading ad…',
  'revive.failed': 'Ad unavailable, please try later',
  'revive.revived': 'Back in the Run!',
  'revive.remaining': 'Continues left this run: {n}',
  'revive.noMore': 'You already used your continue this run. Try to go further next time.',
  'revive.noReviveLeft': 'No continues left this run',
  'revive.needFull': 'Watch the full ad to continue',

  'ad.loading': 'Loading…',
  'ad.unavailable': 'No ads on this platform',
  'ad.failed': 'Ad failed to load',

  'shop.title': 'Shop',
  'shop.tab.buff': 'Buffs',
  'shop.tab.item': 'Items',
  'shop.tab.super': 'Super Shop',
  'shop.buy': 'Buy',
  'shop.buyHighlight': '▶ Buy',
  'shop.owned': 'Owned',
  'shop.notEnough': 'Not enough coins',
  'shop.locked': 'Locked',
  'shop.toast.locked': 'Unlocks at max evolution',
  'shop.toast.owned': 'Already purchased',
  'shop.toast.notEnough': 'Not enough coins',
  'shop.toast.failed': 'Purchase failed',
  'shop.toast.bought': 'Bought: {name}',
  'shop.price': '{n} coins',
  'shop.balance': 'Coins {n}',
  'shop.hint': '↑/↓ Select　Enter/Space Buy　Tab Switch page　Esc Close',
  'shop.hintTouch': 'Tap a card to buy　Tap tabs to switch',
  'shop.cannotBuy': 'Cannot buy',

  'settings.title': 'Settings',
  'settings.language': 'Language / 语言',
  'settings.volume': 'Volume',
  'settings.volumeValue': '{n}%',
  'settings.hint': 'Click to switch language　Drag slider for volume　Esc to close',

  'flash.points': '+{n} Evo',
  'flash.levelUp': 'Evolved: {stage}',
  'flash.coin': '+1 Coin',
  'flash.coinWall': 'Wall broken, +{n} coins',
  'flash.plantCoin': 'Plant dropped +{n} coins',
  'flash.pickup': 'Picked up: {name}',
  'flash.sawAbsorb': 'Cutter blocked {name}: max HP +25',
  'flash.itemExpire': '{name} expired',
  'flash.bought': 'Bought: {name}',

  'shopitem.heal-small.name': 'Quick Heal',
  'shopitem.heal-small.desc': 'Restore 25 HP instantly',
  'shopitem.heal-full.name': 'Feast',
  'shopitem.heal-full.desc': 'Restore HP to full',
  'shopitem.max-hp.name': 'Strong Body',
  'shopitem.max-hp.desc': 'Max HP +25 (and heal to full)',
  'shopitem.shield.name': 'Iron Shield',
  'shopitem.shield.desc': 'For 8s, block the next hit',
  'shopitem.speed.name': 'Swift',
  'shopitem.speed.desc': 'Move speed +6 permanently',
  'shopitem.evolution.name': 'Evolution Crystal',
  'shopitem.evolution.desc': 'Evolution +5',
  'shopitem.invincible.name': 'Starlight Ward',
  'shopitem.invincible.desc': 'Damage immunity for 5s after closing the shop, with countdown',
  'shopitem.growth-hp.name': 'Undying Body',
  'shopitem.growth-hp.desc': 'Permanently +25% max HP',
  'shopitem.growth-atk.name': 'Sharpened Fangs',
  'shopitem.growth-atk.desc': 'Permanently +25% attack',
  'shopitem.growth-speed.name': 'Windborne Body',
  'shopitem.growth-speed.desc': 'Permanently +25% move speed',

  'item.iron-plate.name': 'Iron Plate',
  'item.iron-plate.desc': 'One-time +125 shield, held in the left hand',
  'item.iron-plate.flavor': 'Tore the pot lid off at home. Perfect for blocking projectiles.',
  'item.boots.name': 'Worn Boots',
  'item.boots.desc': '+25 move speed for 60s',
  'item.boots.flavor': 'Only half a pair left, but you run surprisingly fast.',
  'item.chainsaw.name': 'Alloy Cutter',
  'item.chainsaw.desc': 'Auto-attacks nearby plants for 60s',
  'item.chainsaw.flavor': 'Stop biting with your teeth. Let the cutter show you efficiency.',
  'item.bouncing-orb.name': 'Bouncing Orb',
  'item.bouncing-orb.desc': 'Throw a bouncing orb every 1.5s for 60s; it bounces off plants and walls',
  'item.bouncing-orb.flavor': 'It is like a deadly game of billiards, and the field of plants is your pocket.',
  'item.boomerang.name': 'Boomerang',
  'item.boomerang.desc': 'Throw a boomerang every 1.6s for 60s; hits plants on the way out and back',
  'item.boomerang.flavor': 'Throw it, and whether it hits or not, it always comes back with plant debris.'
};

const DICTS: Record<Language, Dict> = { zh: ZH, en: EN };

/** 当前语言（默认中文，初始化时从存档恢复） */
let current: Language = 'zh';

/** 语言变化订阅者 */
type Listener = (lang: Language) => void;
const listeners = new Set<Listener>();

/** 初始化：从存档恢复语言（在应用启动时调用一次即可，重复调用安全） */
export function initI18n(): void {
  const s = loadSettings();
  if (s.language === 'zh' || s.language === 'en') {
    current = s.language;
  }
}

/** 当前语言 */
export function getLanguage(): Language {
  return current;
}

/** 切换语言（会持久化并通知订阅者） */
export function setLanguage(lang: Language): void {
  if (lang !== 'zh' && lang !== 'en') return;
  if (lang === current) return;
  current = lang;
  const s = loadSettings();
  saveSettings({ ...s, language: lang });
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch {
      /* 订阅者异常不应影响切换 */
    }
  });
}

/** 订阅语言变化，返回取消订阅函数 */
export function onLanguageChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 取词。找不到时回退到 key 本身，保证界面不会空白/崩溃。 */
export function t(key: string): string {
  const dict = DICTS[current] ?? ZH;
  return dict[key] ?? DICTS.zh[key] ?? key;
}

/** 带占位符替换的取词：tf('shop.price', { n: 3 }) */
export function tf(key: string, params: Record<string, string | number>): string {
  let out = t(key);
  for (const [k, v] of Object.entries(params)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
}
