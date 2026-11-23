// ============================================================
// projectiles.js —— 子弹（敌人开枪 + 被玩家反弹回去的子弹）
// 全部走对象池；高速子弹用"线段 vs AABB"的扫掠检测，绝不靠点判定，
// 因此再快的子弹也不会穿过敌人或墙。
// 说明：拾取/投掷（飞刀、手雷、手枪）系统已按需求移除，这里只剩子弹。
// ============================================================
import { T } from './const.js';
import { raySegmentRect, TAU } from '../core/math.js';
import { bodyAABB } from './physics.js';

const TYPE = {
  EBULLET: 0, // 敌人子弹（金色颗粒）
  PBULLET: 1, // 被玩家反弹回去的子弹
};

class Projectile {
  constructor() {
    this.active = false;
    this.kind = 0;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.r = 3;
    this.life = 0;
    this.rot = 0;
    this.spin = 0;
    this.owner = 'enemy'; // 'enemy' | 'player'
    this.deflected = false;
    this.trailLen = 0;
  }
}

export class ProjectileSystem {
  constructor(max = T.maxBullets) {
    this.pool = new Array(max);
    for (let i = 0; i < max; i++) this.pool[i] = new Projectile();
    this.max = max;
    this.count = 0;
  }

  reset() {
    for (let i = 0; i < this.max; i++) this.pool[i].active = false;
    this.count = 0;
  }

  _alloc() {
    for (let i = 0; i < this.max; i++) {
      if (!this.pool[i].active) {
        this.pool[i].active = true;
        this.count++;
        return this.pool[i];
      }
    }
    return null; // 池满：直接丢弃新子弹（保证不爆）
  }

  spawnEnemyBullet(x, y, angle, speed = T.gunner.bulletSpeed) {
    const p = this._alloc();
    if (!p) return null;
    p.kind = TYPE.EBULLET;
    p.x = p.px = x;
    p.y = p.py = y;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.r = 3;
    p.life = 4.5;
    p.owner = 'enemy';
    p.deflected = false;
    p.rot = angle;
    p.trailLen = 26;
    return p;
  }

  /**
   * 把射向玩家的子弹反弹回去（归属翻转、加速、指向最近敌人）
   * @returns {boolean} 是否成功反弹
   */
  deflect(p, entities) {
    if (p.kind !== TYPE.EBULLET || p.deflected) return false;
    const speed = Math.hypot(p.vx, p.vy) * 1.55;
    const backAngle = Math.atan2(-p.vy, -p.vx);
    let best = null;
    let bestD = 1e9;
    if (entities) {
      for (const e of entities) {
        if (!e.alive) continue;
        const dx = e.x - p.x;
        const dy = e.y - e.h * 0.5 - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 760) continue;
        const a = Math.atan2(dy, dx);
        let diff = Math.abs(((a - backAngle + Math.PI * 3) % TAU) - Math.PI);
        if (diff > 0.87) continue; // ±50° 内才吸附
        if (d < bestD) {
          bestD = d;
          best = { dx, dy };
        }
      }
    }
    let a = backAngle;
    if (best) a = Math.atan2(best.dy, best.dx);
    p.vx = Math.cos(a) * speed;
    p.vy = Math.sin(a) * speed;
    p.owner = 'player';
    p.deflected = true;
    p.life = Math.max(p.life, 2.2);
    p.trailLen = 46;
    p.rot = a;
    return true;
  }

  update(dt, world) {
    const level = world.level;
    const player = world.player;

    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.px = p.x;
      p.py = p.y;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }

      const dx = p.vx * dt;
      const dy = p.vy * dt;

      // ---------- 扫掠：实心墙 ----------
      let bestT = 1.0;
      let hitSolid = false;
      for (let s = 0; s < level.solids.length; s++) {
        const t = raySegmentRect(p.x, p.y, dx, dy, level.solids[s]);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitSolid = true;
        }
      }

      // ---------- 扫掠：目标 ----------
      let hitEnt = null;
      if (p.owner === 'enemy' && player && player.alive) {
        const hr = player.hurtRect();
        const t = raySegmentRect(p.x, p.y, dx, dy, hr);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitEnt = player;
          hitSolid = false;
        }
      } else if (p.owner === 'player') {
        for (let k = 0; k < world.enemies.length; k++) {
          const e = world.enemies[k];
          if (!e.alive) continue;
          const hr = bodyAABB(e);
          const t = raySegmentRect(p.x, p.y, dx, dy, hr);
          if (t >= 0 && t < bestT) {
            bestT = t;
            hitEnt = e;
            hitSolid = false;
          }
        }
      }

      // 手雷分支已移除：现在场上只会飞着敌人子弹（以及被反弹回去的敌人的子弹）
      if (bestT < 1.0) {
        p.x = p.px + dx * bestT;
        p.y = p.py + dy * bestT;
        if (hitEnt) {
          this._onHitEntity(p, hitEnt, world);
          p.active = false;
        } else if (hitSolid) {
          this._onHitSolid(p, world);
          p.active = false;
        }
      } else {
        p.x += dx;
        p.y += dy;
      }
    }
    let c = 0;
    for (let i = 0; i < this.max; i++) if (this.pool[i].active) c++;
    this.count = c;
  }

  _onHitEntity(p, ent, world) {
    if (ent === world.player) {
      world.killPlayer('shot', p.x, p.y);
      return;
    }
    ent.hurt(p.deflected ? 2 : 1, p.vx, p.vy, world);
  }

  _onHitSolid(p, world) {
    if (p.deflected) {
      world.particles.sparks(p.x, p.y, 10, 3, 260, -p.vx, -p.vy);
      world.audio.play('bulletRicochet', { gain: 0.35 });
    } else {
      world.particles.sparks(p.x, p.y, 5, 5, 180, -p.vx, -p.vy);
      world.audio.play('bulletRicochet', { gain: 0.18, pitch: -3 });
    }
  }

  draw(ctx, slow, onScreen) {
    // ---------- 子弹：按归属分组合批 ----------
    // 敌人子弹是"金色颗粒"：一颗亮金色的小菱形 + 一圈很淡的光晕，**没有拖尾**，
    // 这样在暗背景上一眼就能认出来（也方便在减缓时间时看清轨迹）。
    // 被反弹回去的子弹改成青色 + 短尾迹，和敌人的金色颗粒区分开。
    const gEnemy = [];
    const gPlayer = [];
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      if (onScreen && !onScreen(p.x, p.y)) continue;
      if (p.owner === 'enemy') gEnemy.push(p);
      else gPlayer.push(p);
    }
    if (gEnemy.length === 0 && gPlayer.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // ---- 敌人子弹：金色颗粒，无拖尾 ----
    if (gEnemy.length) {
      // 外层光晕（一粒粒的柔光，不是拖尾）
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#ffb020';
      ctx.beginPath();
      for (let k = 0; k < gEnemy.length; k++) {
        const p = gEnemy[k];
        ctx.moveTo(p.x + 7, p.y);
        ctx.arc(p.x, p.y, 7, 0, TAU);
      }
      ctx.fill();
      // 颗粒本体：金色菱形
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffd54a';
      ctx.beginPath();
      for (let k = 0; k < gEnemy.length; k++) {
        const p = gEnemy[k];
        const r = 4.4;
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
      }
      ctx.fill();
      // 芯：偏白，保证辨识度
      ctx.fillStyle = '#fff8d8';
      ctx.beginPath();
      for (let k = 0; k < gEnemy.length; k++) {
        const p = gEnemy[k];
        const r = 2.1;
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, TAU);
      }
      ctx.fill();
    }

    // ---- 玩家/反弹子弹：青色短尾迹 ----
    if (gPlayer.length) {
      const trailLen = slow > 0.4 ? 1.9 : 1;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = '#bff4ff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      for (let k = 0; k < gPlayer.length; k++) {
        const p = gPlayer[k];
        const len = p.trailLen * trailLen;
        const ang = Math.atan2(p.vy, p.vx);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let k = 0; k < gPlayer.length; k++) {
        const p = gPlayer[k];
        const len = p.trailLen * trailLen;
        const ang = Math.atan2(p.vy, p.vx);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let k = 0; k < gPlayer.length; k++) {
        const p = gPlayer[k];
        const r = p.deflected ? 2.8 : 2.1;
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, TAU);
      }
      ctx.fill();
    }

    ctx.restore();
  }

  stats() {
    let eb = 0;
    let pb = 0;
    let deflected = 0;
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      if (p.deflected) {
        deflected++;
        pb++;
      } else {
        eb++;
      }
    }
    return { enemyBullets: eb, playerBullets: pb, thrown: 0, deflected, total: this.count };
  }

  /** 供测试/调试读取的子弹快照 */
  list() {
    const out = [];
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      out.push({
        kind: p.kind,
        x: Math.round(p.x),
        y: Math.round(p.y),
        vx: Math.round(p.vx),
        vy: Math.round(p.vy),
        owner: p.owner,
        deflected: p.deflected,
      });
    }
    return out;
  }
}

export { TYPE as PROJECTILE_TYPE };
