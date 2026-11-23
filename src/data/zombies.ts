/**
 * 僵尸数据表。
 * 第一版只有玩家一种僵尸，但数据独立放置便于后续扩展。
 */

export interface ZombieConfig {
  /** 基础血量 */
  hp: number;
  /** 基础移动速度（像素/秒） */
  speed: number;
  /** 啃食时速度倍率 */
  eatSpeedMultiplier: number;
  /** 啃食判定距离 */
  eatRange: number;



    /** 一次啃食耗时（毫秒） */
  eatDuration: number;
  /** 吃掉一株植物回复的血量 */
  eatHeal: number;
  /**
   * 吃掉一株植物提升的最大生命值上限。
   *
   * 吃植物是核心成长循环：既回一小口血（eatHeal），又永久抬高上限。
   * 上限涨的同时当前血量也等量抬升（但不会灌满），见 growMaxHp。
   */
  eatMaxHpGain: number;
  /** 碰撞体宽度 */
  bodyWidth: number;
  /** 碰撞体高度 */
  bodyHeight: number;
  /** 待机帧素材键 */
  idleTexture: string;
  /** 啃食帧素材键 */
  eatTexture: string;
}

export const PLAYER_ZOMBIE: ZombieConfig = {
  hp: 100,
  /**
   * 移动速度（像素/秒）。
   *
   * 本作一格 64px。当前设定为「2.2 秒走完一格」：
   * 移动采用格点步进（见 PlayerZombie.advanceStep），速度只影响走完一格的耗时。
   */
  speed: 29.1,
  eatSpeedMultiplier: 0.6,
  /** 啃食判定距离：一格之内即可啃 */
  eatRange: 68,


    eatDuration: 700,
  eatHeal: 5,
  /** 吃掉一株植物：最大生命值 +10，同时回 5 点血（不满血） */
  eatMaxHpGain: 10,
  /**
   * 碰撞体尺寸：只包裹「躯干」。
   *
   * 立绘是手脚张开的姿势。如果按整张贴图（46 x 108）做判定，
   * 会出现明显的「空气碰撞」：
   *   - 离植物还有半个身位就被判定为啃食
   *   - 视觉上离子弹挺远却被打中
   *
   * 实测素材各部位的像素分布后取躯干核心：
   *   横向 素材 x 10..36  -> 显示 25px，取 26
   *   纵向 素材 y 30..84  -> 显示 52px
   * 纵向没有取到脚底，是因为脚会随动画左右偏移；
   * 判定跟随脚会让「贴墙/贴植物」的手感忽远忽近。
   */
  bodyWidth: 26,
  bodyHeight: 52,
  idleTexture: 'zombie-idle',
  eatTexture: 'zombie-eat'
};
