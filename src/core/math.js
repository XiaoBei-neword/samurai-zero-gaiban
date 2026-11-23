// ============================================================
// math.js —— 纯数学工具：向量、缓动、AABB、扇形判定、扫掠射线
// 不依赖任何东西，也不依赖 Canvas / DOM。
// ============================================================

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const approach = (cur, target, delta) =>
  cur < target ? Math.min(cur + delta, target) : Math.max(cur - delta, target);
export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const wrap = (v, m) => ((v % m) + m) % m;

/** 指数阻尼：把 a 平滑逼近 b。lambda 越大越快（单位 1/秒）。 */
export const damp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);

/** 角度差，结果在 (-PI, PI] */
export function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}
export const angleLerp = (a, b, t) => a + angleDiff(b, a) * t;
export const angleDamp = (a, b, lambda, dt) => a + angleDiff(b, a) * (1 - Math.exp(-lambda * dt));

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

// ------------------------------------------------------------
// 随机数：mulberry32（公开的小型 PRNG，用于程序化美术的确定性生成）
// ------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed = 1) {
    this.f = mulberry32(seed);
  }
  next() {
    return this.f();
  }
  range(a, b) {
    return a + (b - a) * this.f();
  }
  int(a, b) {
    return Math.floor(a + (b - a + 1) * this.f());
  }
  sign() {
    return this.f() < 0.5 ? -1 : 1;
  }
  chance(p) {
    return this.f() < p;
  }
  pick(arr) {
    return arr[Math.floor(this.f() * arr.length) % arr.length];
  }
  angle() {
    return this.f() * TAU;
  }
}
export const makeRng = (seed) => new Rng(seed);

// 游戏逻辑里用的快速随机（不需要确定性）
export const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
export const rndInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const rndSign = () => (Math.random() < 0.5 ? -1 : 1);

// ------------------------------------------------------------
// AABB：统一用 {x, y, w, h}，x/y 是左上角
// ------------------------------------------------------------
export const rect = (x, y, w, h) => ({ x, y, w, h });
export const rectRight = (r) => r.x + r.w;
export const rectBottom = (r) => r.y + r.h;
export const rectCx = (r) => r.x + r.w * 0.5;
export const rectCy = (r) => r.y + r.h * 0.5;

export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 点到矩形的最近点 */
export function closestPointOnRect(px, py, r) {
  return {
    x: px < r.x ? r.x : px > r.x + r.w ? r.x + r.w : px,
    y: py < r.y ? r.y : py > r.y + r.h ? r.y + r.h : py,
  };
}

/** 圆与 AABB 相交 */
export function circleRect(cx, cy, radius, r) {
  const q = closestPointOnRect(cx, cy, r);
  return dist2(cx, cy, q.x, q.y) <= radius * radius;
}

// ------------------------------------------------------------
// 扇形判定（近战判定框用）
// 扇形 = 圆心 + 半径 + 朝向角 + 半角
// ------------------------------------------------------------
export const makeSector = (cx, cy, radius, angle, halfAngle) => ({
  cx,
  cy,
  radius,
  angle,
  halfAngle,
});

/** 点是否在扇形内（带一点额外半径余量，用于把子弹当圆看） */
export function sectorContainsPoint(s, px, py, pad = 0) {
  const dx = px - s.cx;
  const dy = py - s.cy;
  const d2 = dx * dx + dy * dy;
  const rr = s.radius + pad;
  if (d2 > rr * rr) return false;
  if (d2 < 1e-6) return true;
  const a = Math.atan2(dy, dx);
  return Math.abs(angleDiff(a, s.angle)) <= s.halfAngle;
}

/**
 * 扇形 vs AABB。为了不出现"刀扫过去没打到"的漏判，这里做三重检测：
 *  1. 采样点（中心 / 四角 / 四边中点 / 最近点）落在扇形内
 *  2. 扇形两条边界射线在半径内穿过矩形
 *  3. 圆心落在矩形内
 */
export function sectorHitsRect(s, r) {
  if (sectorContainsPoint(s, r.x + r.w * 0.5, r.y + r.h * 0.5)) return true;
  if (pointInRect(s.cx, s.cy, r)) return true;

  const xs = [r.x, r.x + r.w * 0.5, r.x + r.w];
  const ys = [r.y, r.y + r.h * 0.5, r.y + r.h];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (sectorContainsPoint(s, xs[i], ys[j])) return true;
    }
  }
  const q = closestPointOnRect(s.cx, s.cy, r);
  if (sectorContainsPoint(s, q.x, q.y)) return true;

  // 边界射线：把扇形当成一片"刀扫过的面"，边缘射线命中矩形也算
  for (const sgn of [-1, 1]) {
    const a = s.angle + sgn * s.halfAngle;
    const ex = s.cx + Math.cos(a) * s.radius;
    const ey = s.cy + Math.sin(a) * s.radius;
    if (segmentRect(s.cx, s.cy, ex, ey, r)) return true;
  }
  return false;
}

/** 线段与 AABB 是否相交（粗测，用于扇形边缘射线） */
export function segmentRect(x0, y0, x1, y1, r) {
  const t = raySegmentRect(x0, y0, x1 - x0, y1 - y0, r);
  return t >= 0 && t <= 1;
}

/**
 * 射线 vs AABB（slab 法）。
 * 方向 (dx,dy) 不是单位向量时，返回的 t 是"沿方向的比例"（0..1 表示在线段内）。
 * 未命中返回 -1。
 */
export function raySegmentRect(x0, y0, dx, dy, r) {
  let tmin = 0;
  let tmax = 1;
  // X 轴
  if (Math.abs(dx) < 1e-9) {
    if (x0 < r.x || x0 > r.x + r.w) return -1;
  } else {
    let t1 = (r.x - x0) / dx;
    let t2 = (r.x + r.w - x0) / dx;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Y 轴
  if (Math.abs(dy) < 1e-9) {
    if (y0 < r.y || y0 > r.y + r.h) return -1;
  } else {
    let t1 = (r.y - y0) / dy;
    let t2 = (r.y + r.h - y0) / dy;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** 无限长射线 vs AABB，返回进入距离（>=0），未命中 -1。dir 必须是单位向量。 */
export function rayRect(x0, y0, ux, uy, r, maxDist = 1e9) {
  let tmin = 0;
  let tmax = maxDist;
  if (Math.abs(ux) < 1e-9) {
    if (x0 < r.x || x0 > r.x + r.w) return -1;
  } else {
    let t1 = (r.x - x0) / ux;
    let t2 = (r.x + r.w - x0) / ux;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(uy) < 1e-9) {
    if (y0 < r.y || y0 > r.y + r.h) return -1;
  } else {
    let t1 = (r.y - y0) / uy;
    let t2 = (r.y + r.h - y0) / uy;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** 射线与实心盒列表中最近命中的距离，无命中返回 Infinity */
export function raycastSolids(x0, y0, ux, uy, maxDist, solids) {
  let best = maxDist;
  for (let i = 0; i < solids.length; i++) {
    const t = rayRect(x0, y0, ux, uy, solids[i], best);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

// ------------------------------------------------------------
// 扫掠 AABB：分轴解算，避免高速穿透
// ------------------------------------------------------------

/**
 * 沿 X 轴移动一个 AABB，返回允许移动的距离（被墙挡住时小于 dx）。
 * r 会被当作"当前位置"，不会修改。
 */
export function sweepX(r, dx, solids) {
  if (dx === 0) return 0;
  let allowed = dx;
  const y0 = r.y;
  const y1 = r.y + r.h;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (y1 <= s.y + 1e-6 || y0 >= s.y + s.h - 1e-6) continue; // 垂直不相交
    if (dx > 0) {
      const gap = s.x - (r.x + r.w);
      if (gap >= -1e-6 && gap < allowed) allowed = Math.max(0, gap);
    } else {
      const gap = s.x + s.w - r.x;
      if (gap <= 1e-6 && gap > allowed) allowed = Math.min(0, gap);
    }
  }
  return allowed;
}

/**
 * 沿 Y 轴移动一个 AABB，返回允许移动的距离。
 * 向上（dy<0）只和"身体确实搭在上面"的盒体判定：
 * 只有当前 body 底部 ≥ 盒体顶部 时才算被挡，避免和脚下的地面盒立刻对撞
 * （否则每一帧都会被立即贴回地面，看起来就是"跳不起来"）。
 * 向下（dy>0）的判定保持原样（落地吸附）。
 */
export function sweepY(r, dy, solids) {
  if (dy === 0) return 0;
  let allowed = dy;
  const x0 = r.x;
  const x1 = r.x + r.w;
  const feet = r.y + r.h;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (x1 <= s.x + 1e-6 || x0 >= s.x + s.w - 1e-6) continue;
    if (dy > 0) {
      const gap = s.y - feet;
      if (gap >= -1e-6 && gap < allowed) allowed = Math.max(0, gap);
    } else {
      // 向上：盒体底部必须严格高于脚底，才可能是"头顶的障碍"
      if (s.y + s.h > feet + 0.5) continue;
      const gap = s.y + s.h - r.y;
      if (gap <= 1e-6 && gap > allowed) allowed = Math.min(0, gap);
    }
  }
  return allowed;
}

/** 点是否在实心盒内 */
export function pointInSolids(px, py, solids) {
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) return true;
  }
  return false;
}

// ------------------------------------------------------------
// 杂项
// ------------------------------------------------------------
export function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

export function hashNoise(x) {
  // 伪随机但确定的一维"噪声"，用于闪烁
  const v = Math.sin(x * 127.1) * 43758.5453;
  return v - Math.floor(v);
}
