// ============================================================
// const.js —— 全部手感/平衡参数集中在这里，方便反复调
// 单位：像素、秒（除特别标注）
// ============================================================

export const T = {
  // ---------------- 玩家：水平移动 ----------------
  maxSpeed: 340,
  groundAccel: 2600,
  airAccel: 1750,
  groundFriction: 3500,
  airDrag: 620,
  turnBoost: 1.7, // 反向输入时加速度加成，转向更跟手

  // ---------------- 玩家：跳跃 ----------------
  gravity: 2300,
  gravityRiseHeld: 1620, // 按住跳跃上升时更飘
  gravityFall: 2700, // 下落更沉，落地干脆
  maxFallSpeed: 1080,
  jumpVel: 720,
  doubleJumpVel: 640,
  jumpCutFactor: 0.42, // 松手把上升速度削掉
  coyoteTime: 0.09,
  jumpBuffer: 0.11,
  // 蹬墙跳
  wallSlideMax: 230,
  wallJumpX: 440,
  wallJumpY: 690,
  wallJumpLock: 0.12, // 蹬墙后短暂锁住水平输入方向
  doubleJumpMinHeight: 18,
  doubleJumpDelay: 0.08, // 离地多久之后才允许二段跳

  // ---------------- 玩家：冲刺 ----------------
  dashSpeed: 990,
  dashTime: 0.14,
  dashCooldown: 0.34,
  dashEndKeep: 0.62, // 冲刺结束保留的速度比例
  dashInvuln: 0.16, // 无敌时长（略长于冲刺本身，收尾也安全）

  // ---------------- 玩家：劈砍 ----------------
  slashActive: 0.1, // 判定持续时间（玩家时间）
  slashRecover: 0.15,
  slashRadius: 78,
  slashHalfAngle: 1.082, // 62°
  slashOffset: 14, // 扇形圆心朝瞄准方向偏移
  slashBuffer: 0.12,
  slashCancelWindow: 0.06, // 后摇超过这个时间后可以被冲刺取消

  // ---------------- 玩家：尺寸 ----------------
  playerW: 22,
  playerH: 52,
  playerHurtW: 18,
  playerHurtH: 44,

  // ---------------- 手雷（只作为"爆炸"这个效果存在，玩家不再能投掷） ----------------
  grenadeRadius: 96,

  // ---------------- 时间控制 ----------------
  slowWorld: 0.15,
  slowPlayer: 0.6,
  energyMax: 100,
  energyDrain: 42, // 每秒（真实时间）
  energyRegen: 17,
  energyRegenDelay: 0.45,
  energyMinStart: 10, // 低于这个值不能再进入减缓
  slowExitLock: 0.45, // 能量耗尽后强制锁定时长

  // ---------------- 打击感 ----------------
  hitstopKill: 0.055,
  hitstopHit: 0.028,
  shakeKill: 7.5,
  shakeHit: 3.2,
  shakeBlock: 5,

  // ---------------- 死亡 / 重试 ----------------
  deathFlashTime: 0.055, // 红闪持续时间
  deathHoldTime: 2.0, // 死亡后停留「任务失败」的时长，然后无缝重置本关
  respawnFreeze: 0.02,

  // ---------------- 摄像机 ----------------
  camLambdaX: 7.5,
  camLambdaY: 5.2,
  camBaseZoom: 1.5, // 像素风下镜头更近一点，角色才够大
  camDashZoom: 0.965,

  // ---------------- 关卡切换 ----------------
  doorOpenTime: 0.35,
  transitionTime: 0.24,

  // ---------------- 敌人通用 ----------------
  enemyGravity: 2100,
  enemyMaxFall: 1000,
  visionRange: 400,
  visionHalfAngle: 0.73, // 42°
  alertTime: 0.18,
  corpseLimit: 24,

  // 浪人（近战）
  ronin: {
    w: 26,
    h: 56,
    speed: 130,
    chaseSpeed: 232,
    windup: 0.42, // 蓄力时间：给玩家反应/抢先手
    attackTime: 0.12,
    recover: 0.55,
    // 浪人的手比玩家短（玩家扇形能到 ~92px），所以"抢先一刀"永远成立
    slashRadius: 58,
    slashHalfAngle: 0.85,
    attackRange: 74,
    attackCooldown: 0.75,
  },
  // 枪手（远程）
  gunner: {
    w: 24,
    h: 54,
    speed: 95,
    retreatSpeed: 165,
    aimTime: 0.55, // 激光瞄准更久，减速下看得清
    burst: 2,
    burstGap: 0.13,
    reload: 1.5,
    bulletSpeed: 560,
    keepMin: 200,
    keepMax: 430,
  },
  // 铁卫（护盾）
  shield: {
    w: 34,
    h: 62,
    speed: 82,
    chaseSpeed: 118,
    turnSpeed: 5.2, // 护盾转向速率 → 转身慢是玩家的破绽窗口
    bashWindup: 0.36,
    bashTime: 0.22,
    bashSpeed: 400,
    blockHalfAngle: 1.22, // ±70°：正面免疫近战
    blockRecover: 0.35,
  },

  // ---------------- 性能 ----------------
  maxBullets: 160,
  bodySplitPieces: 2,
};

export const COLORS = {
  bg: '#050409',
  neonPink: '#ff2e88',
  neonCyan: '#22e0ff',
  neonViolet: '#7b3cff',
  neonAmber: '#ffb347',
  bone: '#e8e6f2',
  blood: '#c81240',
  steel: '#9fd8ff',
};
