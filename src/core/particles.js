// ============================================================
// particles.js —— 池化粒子系统（血液 / 火花 / 尘土 / 烟 / 断肢）
// 预先分配对象，运行期不再 new，避免 GC 抖动掉帧。
// 渲染按"颜色组"合批：同一组的圆点用一条 Path 一次性 fill。
// ============================================================
import { rect, clamp, rnd, rndInt, rndSign } from './math.js';

// 颜色组表：index 对应 Particle.g
// [颜色, 是否发光(叠加), 基础大小]
const GROUPS = [
  ['#7d0a1e', false, 3.0], // 0 暗血
  ['#c81240', false, 2.4], // 1 亮血
  ['#ffe9c9', true, 2.0], // 2 白热火花
  ['#8ef2ff', true, 2.2], // 3 青色电火花
  ['#6f6884', false, 2.6], // 4 尘土
  ['#ff9a3c', true, 2.4], // 5 火星
  ['#3a3350', false, 5.0], // 6 烟
  ['#ff3ea5', true, 2.0], // 7 粉色能量
  ['#c9a0ff', true, 2.0], // 8 紫色
];

const MAX_PARTICLES = 3200;

class Particle {
  constructor() {
    this.alive = false;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.life = 0;
    this.maxLife = 1;
    this.size = 2;
    this.g = 0;
    this.gravity = 0;
    this.drag = 0;
    this.spin = 0;
    this.rot = 0;
    this.streak = false; // 是否画成短线（火花拖尾）
    this.sticky = false; // 碰到地面是否变成血迹
    this.persist = false; // 断肢：不自动消失
  }
}

export class Particles {
  constructor(max = MAX_PARTICLES) {
    this.pool = new Array(max);
    for (let i = 0; i < max; i++) this.pool[i] = new Particle();
    this.cursor = 0;
    this.count = 0;
    this.max = max;
    this.enabled = true;
    this.spawnedThisSec = 0;
    this._sec = 0;
  }

  reset() {
    for (let i = 0; i < this.max; i++) this.pool[i].alive = false;
    this.count = 0;
  }

  _alloc() {
    // 环形扫描找空位；找不到就复用最老的一个（保证永不爆）
    const pool = this.pool;
    for (let i = 0; i < this.max; i++) {
      const p = pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
      if (!p.alive) {
        p.alive = true;
        this.count++;
        return p;
      }
    }
    const p = pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    return p;
  }

  spawn(o) {
    if (!this.enabled) return null;
    const p = this._alloc();
    p.x = o.x;
    p.y = o.y;
    p.px = o.x;
    p.py = o.y;
    p.vx = o.vx || 0;
    p.vy = o.vy || 0;
    p.life = o.life === undefined ? 0.5 : o.life;
    p.maxLife = p.life;
    p.size = o.size === undefined ? GROUPS[o.g || 0][2] : o.size;
    p.g = o.g || 0;
    p.gravity = o.gravity === undefined ? 0 : o.gravity;
    p.drag = o.drag === undefined ? 0 : o.drag;
    p.spin = o.spin || 0;
    p.rot = o.rot || 0;
    p.streak = !!o.streak;
    p.sticky = !!o.sticky;
    p.persist = !!o.persist;
    if (p.persist) p.life = 1e9;
    return p;
  }

  // ---------------- 预设特效 ----------------

  /** 喷血：dirX/dirY 是主要喷溅方向（可为 0,0 表示四散） */
  bloodBurst(x, y, dirX, dirY, count = 18, power = 340) {
    if (!this.enabled) return;
    const baseAngle = Math.atan2(dirY, dirX);
    const spread = dirX === 0 && dirY === 0 ? Math.PI * 2 : 0.9;
    for (let i = 0; i < count; i++) {
      const a =
        dirX === 0 && dirY === 0 ? rnd(0, Math.PI * 2) : baseAngle + rnd(-spread, spread);
      const sp = power * rnd(0.25, 1.0);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - rnd(20, 140),
        life: rnd(0.35, 0.9),
        size: rnd(1.6, 4.4),
        g: Math.random() < 0.4 ? 1 : 0,
        gravity: 1500,
        drag: 1.6,
        sticky: true,
      });
    }
    // 少量"血雾"
    for (let i = 0; i < 3; i++) {
      this.spawn({
        x: x + rnd(-6, 6),
        y: y + rnd(-6, 6),
        vx: rnd(-60, 60),
        vy: rnd(-70, 10),
        life: rnd(0.3, 0.55),
        size: rnd(6, 13),
        g: 0,
        gravity: -30,
        drag: 3,
      });
    }
  }

  sparks(x, y, count = 10, color = 2, power = 320, dirX = 0, dirY = 0) {
    if (!this.enabled) return;
    const base = Math.atan2(dirY, dirX);
    const spread = dirX === 0 && dirY === 0 ? Math.PI * 2 : 1.4;
    for (let i = 0; i < count; i++) {
      const a = dirX === 0 && dirY === 0 ? rnd(0, Math.PI * 2) : base + rnd(-spread, spread);
      const sp = power * rnd(0.35, 1.2);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: rnd(0.12, 0.42),
        size: rnd(1.2, 2.6),
        g: color,
        gravity: 620,
        drag: 2.4,
        streak: true,
      });
    }
  }

  dust(x, y, count = 6, dirX = 0) {
    if (!this.enabled) return;
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + rnd(-8, 8),
        y: y + rnd(-3, 3),
        vx: rnd(-70, 70) + dirX * 40,
        vy: rnd(-70, -12),
        life: rnd(0.25, 0.55),
        size: rnd(2, 5.5),
        g: 4,
        gravity: 220,
        drag: 3.4,
      });
    }
  }

  smoke(x, y, count = 3, power = 60) {
    if (!this.enabled) return;
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + rnd(-5, 5),
        y: y + rnd(-5, 5),
        vx: rnd(-power, power),
        vy: rnd(-power * 0.8, -power * 0.1),
        life: rnd(0.4, 0.9),
        size: rnd(5, 11),
        g: 6,
        gravity: -40,
        drag: 2.2,
      });
    }
  }

  embers(x, y, count = 8, power = 160) {
    if (!this.enabled) return;
    for (let i = 0; i < count; i++) {
      this.spawn({
        x,
        y,
        vx: rnd(-power, power),
        vy: rnd(-power * 1.2, -20),
        life: rnd(0.3, 0.8),
        size: rnd(1.5, 3),
        g: 5,
        gravity: 180,
        drag: 1.2,
        streak: true,
      });
    }
  }

  /** 断肢：会落地并永久保留（直到关卡重置） */
  limb(x, y, dirX, dirY, size = 9, g = 0) {
    return this.spawn({
      x,
      y,
      vx: dirX * rnd(160, 420) + rnd(-60, 60),
      vy: dirY * rnd(160, 420) - rnd(80, 260),
      life: 1e9,
      size,
      g,
      gravity: 1700,
      drag: 0.6,
      spin: rnd(-14, 14),
      rot: rnd(0, 6.28),
      persist: true,
      sticky: false,
    });
  }

  // ---------------- 更新 ----------------

  /**
   * @param {number} dt 世界时间增量
   * @param {Array<{x,y,w,h}>} solids 实心盒（粒子落地判定）
   * @param {object} decals 血迹画布句柄 { splat(x,y,size,group) }
   */
  update(dt, solids, decals) {
    const pool = this.pool;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const p = pool[i];
      if (!p.alive) continue;

      p.px = p.x;
      p.py = p.y;

      if (p.gravity) p.vy += p.gravity * dt;
      if (p.drag) {
        const f = Math.exp(-p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.spin) p.rot += p.spin * dt;

      if (!p.persist) {
        p.life -= dt;
        if (p.life <= 0) {
          p.alive = false;
          continue;
        }
      }

      // 与地面/墙的碰撞：血点会粘成血迹
      if (p.sticky || p.persist) {
        for (let s = 0; s < solids.length; s++) {
          const r = solids[s];
          if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) {
            // 从上方落下 → 血迹
            if (p.sticky && decals && p.vy > 0) {
              decals.splat(p.x, r.y + 1, p.size * rnd(1.1, 2.2), p.g);
            }
            p.alive = p.persist ? true : false;
            if (p.persist) {
              // 断肢停在表面上，稍微躺平
              p.y = r.y - p.size * 0.3;
              p.vx = 0;
              p.vy = 0;
              p.gravity = 0;
              p.spin = 0;
              p.rot = Math.round(p.rot / 0.4) * 0.4;
            }
            break;
          }
        }
      }

      // 掉出世界下方
      if (p.y > 4000) p.alive = false;
      if (p.alive) alive++;
    }
    this.count = alive;
  }

  /** 画所有粒子。发光组用 'lighter' 叠加。onScreen 可选：视口裁剪。 */
  draw(ctx, onScreen) {
    const pool = this.pool;
    // 两遍：普通 → 叠加
    for (let pass = 0; pass < 2; pass++) {
      const additive = pass === 1;
      ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
      let curG = -1;
      let open = false;
      for (let i = 0; i < this.max; i++) {
        const p = pool[i];
        if (!p.alive) continue;
        if (onScreen && !onScreen(p.x, p.y)) continue;
        const isAdd = GROUPS[p.g][1];
        if (isAdd !== additive) continue;
        if (p.streak) continue; // 短线单独画
        const a = p.persist ? 1 : clamp(p.life / p.maxLife, 0, 1);
        if (p.g !== curG) {
          if (open) {
            ctx.fill();
            open = false;
          }
          ctx.fillStyle = GROUPS[p.g][0];
          ctx.globalAlpha = additive ? clamp(a * 1.2, 0, 1) : clamp(a, 0, 1) * 0.95;
          curG = p.g;
          ctx.beginPath();
          open = true;
        }
        const s = p.persist ? p.size : p.size * (0.4 + a * 0.6);
        ctx.moveTo(p.x + s, p.y);
        ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
      }
      if (open) ctx.fill();

      // 短线火花
      ctx.lineCap = 'round';
      curG = -1;
      for (let i = 0; i < this.max; i++) {
        const p = pool[i];
        if (!p.alive || !p.streak) continue;
        if (onScreen && !onScreen(p.x, p.y)) continue;
        const isAdd = GROUPS[p.g][1];
        if (isAdd !== additive) continue;
        const a = clamp(p.life / p.maxLife, 0, 1);
        if (p.g !== curG) {
          ctx.strokeStyle = GROUPS[p.g][0];
          ctx.globalAlpha = additive ? a : a * 0.9;
          curG = p.g;
        }
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  stats() {
    let persist = 0;
    for (let i = 0; i < this.max; i++) if (this.pool[i].alive && this.pool[i].persist) persist++;
    return { alive: this.count, persist, max: this.max };
  }
}

// ------------------------------------------------------------
// 血迹贴花层：把血迹画进一张世界大小的离屏 canvas，之后每帧一张 drawImage
// ------------------------------------------------------------
export class Decals {
  constructor(worldW, worldH) {
    this.w = Math.max(1, Math.ceil(worldW));
    this.h = Math.max(1, Math.ceil(worldH));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.globalCompositeOperation = 'source-over';
    this.dirty = true;
    this.splats = 0;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.splats = 0;
    this.dirty = true;
  }

  /** 在 (x,y) 铺一摊血 */
  splat(x, y, size, group) {
    if (this.splats > 900) return; // 上限，避免无限画
    const c = this.ctx;
    const dark = group === 1 ? '#6d0a1c' : '#4a0714';
    c.fillStyle = dark;
    c.beginPath();
    const r = size * 0.5;
    for (let i = 0; i < 5; i++) {
      const a = rnd(0, Math.PI * 2);
      const d = rnd(0, r * 0.9);
      c.moveTo(x + Math.cos(a) * d + r, y + Math.sin(a) * d);
      c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * rnd(0.5, 1.2), 0, Math.PI * 2);
    }
    c.globalAlpha = rnd(0.35, 0.7);
    c.fill();
    c.globalAlpha = 1;
    this.splats++;
    this.dirty = true;
  }

  draw(ctx) {
    if (this.splats === 0) return;
    ctx.drawImage(this.canvas, 0, 0);
  }
}
