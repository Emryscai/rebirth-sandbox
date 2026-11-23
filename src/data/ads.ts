/**
 * 广告配置（商业参数集中在这里，改完重新构建即可）。
 *
 * ---- 上线前必须做 ----
 * 1. 微信公众平台 → 流量主 → 广告管理，分别创建：
 *      - 激励视频广告位（用于「看广告复活」）
 *      - 插屏广告位（用于每 N 局一次的结算插屏）
 * 2. 把下面的 adUnitId 换成真实值（形如 adunit-xxxxxxxxxxxxxxxx）。
 * 3. 广告位 ID 为空时，游戏会自动隐藏对应入口，不会弹错误。
 *
 * 注意：广告位不是「创建即生效」，新 adUnitId 通常需要等审核/填充，
 * 开发期可以先用测试广告位或留空跑无广告流程。
 */

const ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const AD_CONFIG = {
  /** 微信小游戏广告位（可用构建环境变量覆盖，见 docs/提审填写模板.md） */
  wx: {
    rewardedUnitId: ENV.VITE_WX_REWARDED_UNIT_ID || '',
    interstitialUnitId: ENV.VITE_WX_INTERSTITIAL_UNIT_ID || ''
  },

  /** 抖音小游戏广告位（预留，接入时填写） */
  tt: {
    rewardedUnitId: ENV.VITE_TT_REWARDED_UNIT_ID || '',
    interstitialUnitId: ENV.VITE_TT_INTERSTITIAL_UNIT_ID || ''
  },

  /** 插屏频控 */
  frequency: {
    /** 每完成多少局尝试一次插屏 */
    interstitialEveryRuns: 3,
    /** 两次插屏之间的最小间隔（毫秒） */
    interstitialMinIntervalMs: 3 * 60 * 1000,
    /** 首局是否允许插屏（false = 至少玩过 2 局才出） */
    allowOnFirstRun: false
  },

  /** 激励视频超时（毫秒）：超时按「未完成」处理，避免卡死结算 */
  rewardedTimeoutMs: 90 * 1000,

  /** 是否允许在 URL 带 ?adtest=1 时使用网页模拟广告（仅供测试） */
  allowWebTestAds: true
} as const;

/** 单局最多可看激励视频复活的次数 */
export const MAX_REVIVE_PER_RUN = 1;

/** 复活时恢复的血量比例 */
export const REVIVE_HP_RATIO = 0.6;

/** 复活后的无敌时间（毫秒） */
export const REVIVE_INVULNERABLE_MS = 3000;
