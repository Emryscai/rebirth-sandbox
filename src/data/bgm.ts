/**
 * 背景音乐（BGM）数据表。
 *
 * 音乐资源放在 public/assets/bgm/ 下，按「播放时机」分文件夹：
 *
 *   normal/    正常情况下循环播放       —— 开局随机选一首，一直循环
 *   overtime/  游戏超过三分钟之后       —— 游戏内计时达到阈值后切换过去
 *   revenge/   累计死亡重开 20 次后      —— 全局累计重开数达到阈值后切换过去
 *   fail/      游戏失败之后             —— 玩家死亡后一次性播放（不循环）
 *   menu/      暂停 / 打开商店菜单时     —— 覆盖层出现时播放，关闭后恢复
 *
 * 文件名保留原始长名（含作者/来源信息），此处集中登记，
 * 方便日后替换素材时只改这一个文件。
 */

/** 音乐分组 id */
export type BgmGroup = 'normal' | 'overtime' | 'revenge' | 'fail' | 'menu';

/**
 * 各分组下的曲目列表（相对 public/ 的路径）。
 *
 * 路径经 Phaser 提供给 SoundManager，最终以 URL 形式被浏览器的
 * HTMLAudio / WebAudio 加载，中文目录不会出现在这里（已改为 ASCII 分组名）。
 */
export const BGM_TRACKS: Readonly<Record<BgmGroup, readonly string[]>> = {
  normal: [
    'assets/bgm/normal/desifreemusic-best-background-music-no-copyright-244084.mp3',
    'assets/bgm/normal/echoes_of_lumen-tense-music-597571.mp3',
    'assets/bgm/normal/monume-no-copyright-music-547933.mp3',
    'assets/bgm/normal/arpmedia-no-copyright-music-3-569452.mp3',
    'assets/bgm/normal/solarflex-no-copyright-music-541552.mp3'
  ],
  overtime: [
    'assets/bgm/overtime/studiokolomna-no-copyright-music-483817.mp3'
  ],
  revenge: [
    'assets/bgm/revenge/daynigthmorning-no-copyright-music-425784.mp3'
  ],
  fail: [
    'assets/bgm/fail/cinematic-soul-dark-ambient-background-music-617907.mp3',
    'assets/bgm/fail/no-copyright-music-2026-dark-ambient-633496.mp3'
  ],
  menu: [
    'assets/bgm/menu/cinematic-soul-jazz-piano-627489.mp3'
  ]
};

/**
 * Phaser 预热音频用的「key 前缀」。
 *
 * Phaser 在 play(key) 时要求 key 已经通过 load.audio 加载进缓存，
 * 而我们的 BGM 是在运行时懒加载的 —— 为了让 BgmManager 不必事先
 * 把所有音乐塞进 BootScene（10 首 mp3 共 ~30MB，会拖慢开局），
 * 这里用 HTML5 Audio 元素直接播放（不走 Phaser AudioCache），
 * 因此不需要预加载 key。BGM_TRACKS 里的路径会转成 <audio src>。
 */

/** 游戏进行多少毫秒后切到「超时」曲目（需求：超过三分钟） */
export const BGM_OVERTIME_MS = 3 * 60 * 1000;

/** 累计死亡重开多少次后切到「复仇」曲目（需求：20 次） */
export const BGM_REVENGE_RESTARTS = 20;

/**
 * BGM 相对主音量的系数。
 *
 * 主音量（设置页可控）默认 0.7，BGM 再乘 0.6，
 * 让 BGM 明显低于音效，避免盖过后续加入的音效。
 */
export const BGM_VOLUME_SCALE = 0.6;

/** BGM 切换时的淡入淡出时长（毫秒） */
export const BGM_FADE_MS = 900;
