// ============================================================
// physics.js —— 角色与场景的碰撞解算（分轴扫掠，防高速穿透）
// 约定：body 的 (x, y) 是"脚底中心"，w/h 是碰撞盒尺寸
// ============================================================
import { sweepX, sweepY, pointInRect } from '../core/math.js';

/** body 的 AABB（左上角 + 宽高） */
export function bodyAABB(b) {
  return { x: b.x - b.w * 0.5, y: b.y - b.h, w: b.w, h: b.h };
}

/**
 * 移动一个 body，并按轴解算与实心盒/单向平台的碰撞。
 * 单向平台：只在下落且脚底原本在平台顶面之上时才挡住。
 * @returns {{hitX:boolean, hitY:boolean, grounded:boolean, ceiling:boolean}}
 */
export function moveBody(b, dx, dy, level) {
  let hitX = false;
  let hitY = false;
  let ceiling = false;

  // ---------- X 轴 ----------
  if (dx !== 0) {
    const r = bodyAABB(b);
    const allow = sweepX(r, dx, level.solids);
    if (Math.abs(allow - dx) > 1e-4) hitX = true;
    b.x += allow;
  }

  // ---------- Y 轴 ----------
  if (dy !== 0) {
    const r = bodyAABB(b);
    let allow = sweepY(r, dy, level.solids);

    // 单向平台
    if (dy > 0 && level.oneway.length) {
      const feet = r.y + r.h;
      for (let i = 0; i < level.oneway.length; i++) {
        const ow = level.oneway[i];
        if (r.x + r.w <= ow.x || r.x >= ow.x + ow.w) continue;
        // 脚底必须在平台顶面之上（留一点容差）
        if (feet > ow.y + 1.5) continue;
        const reach = ow.y - feet;
        if (reach <= 0) continue;
        if (reach <= dy && reach < allow) allow = reach;
      }
    }

    if (Math.abs(allow - dy) > 1e-4) {
      hitY = true;
      if (dy < 0) ceiling = true;
    }
    b.y += allow;

    if (dy > 0 && hitY) {
      b.vy = 0;
      return { hitX, hitY, grounded: true, ceiling };
    }
  }

  return { hitX, hitY, grounded: false, ceiling };
}

/** 探测脚下是否有地面 */
export function probeGround(b, level, dist = 2) {
  const r = bodyAABB(b);
  const test = { x: r.x + 0.5, y: r.y + r.h + 0.2, w: r.w - 1, h: dist };
  for (let i = 0; i < level.solids.length; i++) {
    const s = level.solids[i];
    if (test.x < s.x + s.w && test.x + test.w > s.x && test.y < s.y + s.h && test.y + test.h > s.y)
      return true;
  }
  // 单向平台
  for (let i = 0; i < level.oneway.length; i++) {
    const ow = level.oneway[i];
    if (test.x < ow.x + ow.w && test.x + test.w > ow.x && test.y < ow.y + 6 && test.y + test.h > ow.y - 1)
      return true;
  }
  return false;
}

/** body 是否与某个矩形重叠 */
export function bodyHitsRect(b, r) {
  const a = bodyAABB(b);
  return a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y;
}

/** 点是否在 body 内 */
export function pointInBody(px, py, b) {
  const a = bodyAABB(b);
  return pointInRect(px, py, a);
}

/** body 中心 */
export function bodyCenter(b) {
  return { x: b.x, y: b.y - b.h * 0.5 };
}

/** 判断脚下前方是否有地面（AI 防掉崖用） */
export function groundAhead(b, level, dirX, dist = 24) {
  const px = b.x + dirX * dist;
  const py = b.y + 6;
  for (let i = 0; i < level.solids.length; i++) {
    const s = level.solids[i];
    if (px >= s.x && px <= s.x + s.w && py >= s.y - 8 && py <= s.y + s.h) return true;
  }
  for (let i = 0; i < level.oneway.length; i++) {
    const ow = level.oneway[i];
    if (px >= ow.x && px <= ow.x + ow.w && py >= ow.y - 8 && py <= ow.y + ow.h) return true;
  }
  return false;
}
