// ============================================================
// loop.js —— 时间基准 / 时间缩放 / 固定步长 / FPS 统计
//
// 时间缩放方案：
//   dtReal                       真实帧间隔（wall clock），钳制在 50ms 内
//   worldScale / playerScale     平滑逼近 SLOW_WORLD / SLOW_PLAYER（或 1 / 1）
//   世界物理用固定步长 FIXED_DT  累加，所以减速时只是"每帧积攒的步数变少"，
//                                物理方程与碰撞精度都不变
//   玩家的物理步 dtPlayer        = FIXED_DT × (playerScale / worldScale)
//   → 玩家相对敌人的时间优势      = playerScale / worldScale
//
// ⚠ 关键不变式（改这里之前请先读）：
//   "秒"缩放对位置是线性的，但对速度是**二次**的（v ∝ g·t）。
//   因此在子弹时间里，玩家如果只把 dt 乘 X（同时在同样的真实时间里位移 ×X），
//   速度就必须不变，重力必须乘 1/X，否则跳跃高度会变 X² 倍。
//   具体换算见 director.js 的 step() 注释与 player.js 的 update() 参数。
// ============================================================

export const FIXED_DT = 1 / 120;

// 子弹时间的两个系数（改这两个数就能调强度）：
//   SLOW_WORLD  : 敌人 / 子弹 / 粒子 / 机关 / 背景动画按真实时间缩放到这个比例
//   SLOW_PLAYER : 玩家自身的动作节奏缩放到这个比例（数值越小，玩家也越慢）
// 玩家相对世界的优势 = SLOW_PLAYER / SLOW_WORLD（默认 0.6 / 0.15 = 4 倍）
export const SLOW_WORLD = 0.15;
export const SLOW_PLAYER = 0.6;

const MAX_FRAME_DT = 0.05; // 单帧最多补 50ms，避免切标签页回来时"死亡螺旋"
const MAX_STEPS = 8;

export class FrameStats {
  constructor(capacity = 900) {
    this.cap = capacity;
    this.buf = new Float32Array(capacity);
    this.count = 0;
    this.idx = 0;
    this.frames = 0;
    this.windowStart = 0;
    this.windowFrames = 0;
    this.fps = 60;
    this.minFps = 999;
    this.maxFrameMs = 0;
  }
  push(dt) {
    const ms = dt * 1000;
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.frames++;
    this.windowFrames++;
    if (ms > this.maxFrameMs) this.maxFrameMs = ms;
  }
  /** 每帧调用一次，内部按 250ms 窗口更新 fps，避免数字乱跳 */
  update(nowSec) {
    if (nowSec - this.windowStart >= 0.25) {
      const span = nowSec - this.windowStart;
      if (span > 0) {
        const f = this.windowFrames / span;
        this.fps = this.fps * 0.35 + f * 0.65; // 一阶低通：显示更稳但仍如实反映掉帧
        if (f < this.minFps && this.frames > 30) this.minFps = f;
      }
      this.windowStart = nowSec;
      this.windowFrames = 0;
    }
  }
  reset() {
    this.count = 0;
    this.idx = 0;
    this.frames = 0;
    this.windowFrames = 0;
    this.minFps = 999;
    this.maxFrameMs = 0;
    this.windowStart = 0;
  }
  /** 百分位统计（用于压测报告，都是实测值） */
  percentiles() {
    if (this.count === 0) return { p50: 0, p95: 0, p99: 0, max: 0, n: 0 };
    const arr = Array.prototype.slice.call(this.buf, 0, this.count).sort((a, b) => a - b);
    const at = (p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: arr[arr.length - 1], n: arr.length };
  }
  /** 最近 n 帧的平均 FPS */
  recentFps(n = 120) {
    const c = Math.min(n, this.count);
    if (c === 0) return 0;
    let sum = 0;
    for (let i = 0; i < c; i++) {
      const k = (this.idx - 1 - i + this.cap * 2) % this.cap;
      sum += this.buf[k];
    }
    const avgMs = sum / c;
    return avgMs > 0 ? 1000 / avgMs : 0;
  }
}

export class TimeKeeper {
  constructor() {
    this.dtReal = 0;
    this.elapsedReal = 0; // 从游戏启动起的真实秒数
    this.worldScale = 1; // 当前（平滑后）世界时间缩放
    this.playerScale = 1;
    this.targetWorldScale = 1;
    this.targetPlayerScale = 1;
    // 测试钩子用：非 null 时直接当成目标缩放（用来复现任意缩放比）
    this.worldScaleOverride = null;
    this.playerScaleOverride = null;
    this.acc = 0;
    this.alpha = 0;
    this.stepsLastFrame = 0;
    this.hitstopLeft = 0; // 剩余 hitstop（真实秒）
    this.hitstopScale = 0.02;
    this.slowActive = false;
    this.slowBlend = 0; // 0..1，给视觉用
    this.stats = new FrameStats();
    this.lastNow = 0;
    this.started = false;
  }

  /** 请求进入/退出减缓 */
  setSlow(on) {
    this.slowActive = !!on;
  }

  /** 触发一次 hitstop（真实秒）。取最大值，不累加，避免长时间卡住 */
  hitstop(seconds) {
    if (seconds > this.hitstopLeft) this.hitstopLeft = seconds;
  }

  reset() {
    this.acc = 0;
    this.alpha = 0;
    this.dtReal = 0;
    this.hitstopLeft = 0;
  }

  /** 每帧开头调用：返回真实帧间隔（秒） */
  begin(nowMs) {
    if (!this.started) {
      this.started = true;
      this.lastNow = nowMs;
      this.dtReal = 1 / 60;
      this.stats.windowStart = 0;
      return this.dtReal;
    }
    let dt = (nowMs - this.lastNow) / 1000;
    this.lastNow = nowMs;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    this.dtReal = dt;
    this.elapsedReal += dt;
    this.stats.push(dt);
    this.stats.update(this.elapsedReal);
    return dt;
  }

  /**
   * 在"能量/减缓意愿"确定之后调用一次，算本帧的时间缩放。
   * 必须和 begin() 分开：能量用真实时间推进，缩放由它决定。
   */
  updateScales(dt) {
    if (this.worldScaleOverride !== null && this.playerScaleOverride !== null) {
      // 测试钩子：直接指定缩放
      this.targetWorldScale = this.worldScaleOverride;
      this.targetPlayerScale = this.playerScaleOverride;
    } else if (this.hitstopLeft > 0) {
      this.hitstopLeft -= dt;
      // hitstop 期间世界和玩家一起几乎冻结（手感：刀砍进肉里的顿挫）
      this.targetWorldScale = this.hitstopScale;
      this.targetPlayerScale = this.hitstopScale;
    } else if (this.slowActive) {
      this.targetWorldScale = SLOW_WORLD;
      this.targetPlayerScale = SLOW_PLAYER;
    } else {
      this.targetWorldScale = 1;
      this.targetPlayerScale = 1;
    }

    // ---- 指数平滑过渡（90ms 时间常数），避免缩放跳变导致画面抽搐 ----
    const k = 1 - Math.exp(-dt / 0.09);
    this.worldScale += (this.targetWorldScale - this.worldScale) * k;
    this.playerScale += (this.targetPlayerScale - this.playerScale) * k;
    if (Math.abs(this.worldScale - this.targetWorldScale) < 1e-4) this.worldScale = this.targetWorldScale;
    if (Math.abs(this.playerScale - this.targetPlayerScale) < 1e-4) this.playerScale = this.targetPlayerScale;

    // 视觉用的 0..1 混合量
    const blendTarget = this.slowActive ? 1 : 0;
    this.slowBlend += (blendTarget - this.slowBlend) * (1 - Math.exp(-dt / 0.07));
  }

  /**
   * 本物理步里玩家"动作节奏"相对正常快慢的比例（= s）。
   * 定义：一个世界物理步（1/120 世界秒）对应的**真实秒数** = FIXED_DT × s。
   * 所以 s = playerScale / worldScale（正常 = 1，子弹时间 = 0.6/0.15 = 4）。
   * 各种计时器（土狼时间、攻击窗口、冷却、动画相位）都用它。
   */
  get playerStepDt() {
    return FIXED_DT * (this.playerScale / Math.max(this.worldScale, 1e-4));
  }

  /**
   * 每个物理步里玩家推进的真实秒数（和 playerStepDt 是同一个量，保留别名便于阅读）。
   * 速度量全部按"每真实秒"计，乘上它即得本步位移。
   */
  get playerPosFactor() {
    return this.playerStepDt;
  }

  /**
   * 消费累加器，返回本帧要跑多少个固定步。
   * 世界时间推进 FIXED_DT * 步数 = dtReal * worldScale。
   */
  takeSteps() {
    this.acc += this.dtReal * this.worldScale;
    let n = Math.floor(this.acc / FIXED_DT);
    if (n > MAX_STEPS) {
      n = MAX_STEPS;
      this.acc = 0;
    } else {
      this.acc -= n * FIXED_DT;
    }
    this.alpha = clamp01(this.acc / FIXED_DT);
    this.stepsLastFrame = n;
    return n;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
