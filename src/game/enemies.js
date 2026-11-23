// ============================================================
// enemies.js —— 3 种敌人 + 视觉/听觉感知 + 状态机
//   浪人 ronin ：近战冲锋，蓄力后横斩
//   枪手 gunner：远程，瞄准激光 → 三连点射，近身会后撤
//   铁卫 shield：持盾推进，正面免疫近战，转身慢 → 绕背可杀
// 全部一击必杀：hurt() 即死。死亡后尸体永久留在场景里。
// ============================================================
import { T } from './const.js';
import {
  clamp,
  sign,
  angleDiff,
  dist,
  raycastSolids,
  makeSector,
  sectorHitsRect,
  rnd,
  TAU,
} from '../core/math.js';
import { bodyAABB, moveBody, probeGround, groundAhead } from './physics.js';
import { drawRonin, drawGunner, drawShield } from '../core/sprites.js';

const noop = () => {};

class EnemyBase {
  constructor(world, def) {
    this.w = 26;
    this.h = 50;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.alive = false;
    this.state = 'idle';
    this.stateT = 0;
    this.animT = 0;
    this.grounded = false;
    this.patrolMin = 0;
    this.patrolMax = 0;
    this.patrolDir = 1;
    this.alertPulse = 0;
    this.aimAngle = 0;
    this.windup = 0;
    this.blockFlash = 0;
    this.shieldUp = 1;
    this.lastSeenX = 0;
    this.lastSeenY = 0;
    this.searchT = 0;
    this.cooldown = 0;
    this.type = 'ronin';
    this.world = world;
    this.flankSide = 0;
    this.heard = 0;
    this.reset(def, world);
  }

  reset(def, world) {
    this.world = world;
    this.def = def;
    this.type = def.type;
    this.x = def.x;
    this.y = def.y;
    this.px = def.x;
    this.py = def.y;
    this.vx = 0;
    this.vy = 0;
    this.alive = true;
    this.state = 'patrol';
    this.stateT = 0;
    this.animT = rnd(0, 10);
    this.facing = def.x > world.level.width * 0.5 ? -1 : 1;
    this.patrolMin = def.patrol ? def.patrol[0] : def.x - 80;
    this.patrolMax = def.patrol ? def.patrol[1] : def.x + 80;
    this.patrolDir = this.facing;
    this.alertPulse = 0;
    this.cooldown = 0;
    this.searchT = 0;
    this.windup = 0;
    this.shieldUp = 1;
    this.blockFlash = 0;
    this.grounded = false;
    this.lastSeenX = 0;
    this.lastSeenY = 0;
    this.flankSide = 0;
    this.heard = 0;
  }

  get eyeY() {
    return this.y - this.h * 0.86;
  }
  get centerY() {
    return this.y - this.h * 0.5;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
  }

  // ---------------- 感知 ----------------

  /** 视觉：视锥 + 距离 + 视线遮挡 */
  canSee(player, level) {
    if (!player || !player.alive) return false;
    const d = dist(this.x, this.eyeY, player.x, player.y - player.h * 0.5);
    if (d > T.visionRange) return false;
    // 近距离"背刺也能察觉"（但转身需要时间，所以仍然可被偷袭）
    const closeAware = d < 96;
    if (!closeAware) {
      const a = Math.atan2(player.y - T.playerHurtH * 0.5 - this.eyeY, player.x - this.x);
      const faceAngle = this.facing > 0 ? 0 : Math.PI;
      if (Math.abs(angleDiff(a, faceAngle)) > T.visionHalfAngle) return false;
    }
    // 视线遮挡
    const ex = this.x;
    const ey = this.eyeY;
    const tx = player.x;
    const ty = player.y - player.h * 0.45;
    const dx = tx - ex;
    const dy = ty - ey;
    const len = Math.hypot(dx, dy) || 1;
    const hit = raycastSolids(ex, ey, dx / len, dy / len, len - 2, level.solids);
    return hit >= len - 2;
  }

  onHear(noise, world) {
    if (!this.alive) return;
    const d = dist(this.x, this.centerY, noise.x, noise.y);
    if (d > noise.radius) return;
    this.heard = 1.2;
    if (this.state === 'patrol' || this.state === 'idle' || this.state === 'search') {
      this.lastSeenX = noise.x;
      this.lastSeenY = noise.y;
      this.searchT = 2.6;
      this.setState('search');
      this.facing = sign(noise.x - this.x) || this.facing;
    }
  }

  // ---------------- 物理 ----------------

  applyGravity(dt, world) {
    this.vy = Math.min(this.vy + T.enemyGravity * dt, T.enemyMaxFall);
    const res = moveBody(this, this.vx * dt, this.vy * dt, world.level);
    if (res.grounded) {
      this.grounded = true;
      this.vy = 0;
    } else if (res.hitY) {
      this.grounded = false;
      if (this.vy < 0) this.vy = 0;
    } else {
      this.grounded = probeGround(this, world.level, 3) && this.vy >= 0;
    }
    if (res.hitX) this.vx = 0;
  }

  /** 水平朝某方向移动（带防掉崖） */
  walkToward(dt, targetX, speed, world, dropOff = true) {
    const dx = targetX - this.x;
    const dir = Math.abs(dx) < 4 ? 0 : sign(dx);
    if (dir === 0) {
      this.vx = clamp(this.vx, -speed, speed) * 0.85;
      return 0;
    }
    this.facing = dir;
    // 前面没地面就停下（站在平台上不会走下悬崖）
    if (dropOff && this.grounded && !groundAhead(this, world.level, dir, 22)) {
      this.vx = 0;
      return 0;
    }
    this.vx = dir * speed;
    this.patrolDir = dir;
    return dir;
  }

  // ---------------- 主更新 ----------------

  update(dt, world) {
    if (!this.alive) return;
    this.px = this.x;
    this.py = this.y;
    this.animT += dt;
    this.stateT += dt;
    if (this.alertPulse > 0) this.alertPulse = Math.max(0, this.alertPulse - dt * 3);
    if (this.blockFlash > 0) this.blockFlash = Math.max(0, this.blockFlash - dt * 4);
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.heard > 0) this.heard -= dt;

    const player = world.player;
    const sees = this.canSee(player, world.level);
    if (sees) {
      this.lastSeenX = player.x;
      this.lastSeenY = player.y;
      this.searchT = 2.8;
    }

    this.behave(dt, world, player, sees);
    this.applyGravity(dt, world);
  }

  behave(dt, world, player, sees) {
    // 子类实现
  }

  /** 被近战/投掷物命中 */
  hurt(src, vx, vy, world) {
    if (!this.alive) return 'hit';
    this.die(vx, vy, world, src);
    return 'hit';
  }

  die(vx, vy, world, src) {
    this.alive = false;
    world.onEnemyKilled(this, vx, vy, src);
  }

  /** 玩家近战扇形是否命中我（含护盾格挡判定） */
  tryHitSector(sector, world) {
    const box = bodyAABB(this);
    return sectorHitsRect(sector, box);
  }

  draw(ctx, world) {}
  drawLaser(ctx, world) {}
}

// ============================================================
// 浪人
// ============================================================
export class Ronin extends EnemyBase {
  constructor(world, def) {
    super(world, def);
    const c = T.ronin;
    this.w = c.w;
    this.h = c.h;
  }

  behave(dt, world, player, sees) {
    const c = T.ronin;
    this.windup = 0;

    switch (this.state) {
      case 'patrol':
      case 'idle': {
        if (sees) {
          this.setState('alert');
          this.alertPulse = 1;
          world.audio.play('alert', { pan: this.panCam(), gain: 0.5 });
          break;
        }
        // 巡逻
        if (this.x < this.patrolMin) this.patrolDir = 1;
        else if (this.x > this.patrolMax) this.patrolDir = -1;
        if (this.grounded && !groundAhead(this, world.level, this.patrolDir, 20)) {
          this.patrolDir *= -1;
        }
        this.facing = this.patrolDir;
        this.vx = this.patrolDir * c.speed;
        break;
      }

      case 'alert': {
        this.vx *= 0.7;
        this.facing = sign(player.x - this.x) || this.facing;
        if (this.stateT > T.alertTime) {
          this.setState('chase');
          world.audio.play('alertEnd', { gain: 0.25 });
        }
        break;
      }

      case 'search': {
        this.searchT -= dt;
        this.vx = 0;
        const dx = this.lastSeenX - this.x;
        if (Math.abs(dx) > 30) {
          this.facing = sign(dx);
          this.vx = this.facing * c.speed;
          if (this.grounded && !groundAhead(this, world.level, this.facing, 20)) this.vx = 0;
        }
        if (sees) {
          this.setState('chase');
        } else if (this.searchT <= 0) {
          this.setState('patrol');
        }
        break;
      }

      case 'chase': {
        if (!player.alive) {
          this.setState('patrol');
          break;
        }
        const dx = player.x - this.x;
        const dy = player.y - this.y;
        // 包抄：如果没有队友在同侧，就绕到玩家背后
        const side = sign(dx) || 1;
        let targetX = player.x;
        if (world.countEngagers(this) === 0) {
          const behind = player.facing > 0 ? -1 : 1;
          if (sign(behind) !== side && Math.abs(dx) > 90) targetX = player.x + behind * 60;
        }
        // 垂直差太大就尝试跳上去
        if (dy < -70 && Math.abs(dx) < 150 && this.grounded) {
          this.vy = -690;
          this.grounded = false;
        }
        const dir = this.walkToward(dt, targetX, c.chaseSpeed, world, true);
        this.facing = sign(dx) || this.facing;
        if (Math.abs(dx) < c.attackRange && Math.abs(dy) < 52 && this.cooldown <= 0) {
          this.setState('windup');
          this.vx *= 0.3;
          world.audio.play('windup', { pan: this.panCam(), gain: 0.4 });
        } else if (Math.abs(dx) > 620) {
          this.setState('search');
        }
        if (!sees && Math.abs(dx) > 120) {
          this.searchT = 2.2;
          this.setState('search');
        }
        break;
      }

      case 'windup': {
        this.vx *= 0.86;
        this.facing = sign(player.x - this.x) || this.facing;
        this.windup = clamp(this.stateT / c.windup, 0, 1);
        if (this.stateT >= c.windup) {
          this.setState('attack');
          this.slashDone = false;
          this.vx = this.facing * 240;
          world.audio.play('slash', { pan: this.panCam(), gain: 0.55 });
        }
        break;
      }

      case 'attack': {
        this.vx *= 0.9;
        if (!this.slashDone) {
          const s = makeSector(
            this.x + this.facing * 8,
            this.y - this.h * 0.5,
            c.slashRadius,
            this.facing > 0 ? 0 : Math.PI,
            c.slashHalfAngle,
          );
          const pr = world.player.hurtRect();
          if (world.player.alive && sectorHitsRect(s, pr)) {
            world.killPlayer('melee', this.x, this.y - this.h * 0.5);
          }
        }
        if (this.stateT >= c.attackTime) {
          this.slashDone = true;
          this.setState('recover');
          this.cooldown = c.attackCooldown;
        }
        break;
      }

      case 'recover': {
        this.vx *= 0.8;
        if (this.stateT > c.recover) {
          this.setState(sees ? 'chase' : 'search');
          this.searchT = 2.2;
        }
        break;
      }

      default:
        this.setState('patrol');
    }
  }

  panCam() {
    const cam = this.world.camera;
    return clamp((this.x - cam.ix) / 640, -1, 1);
  }

  draw(ctx, world) {
    drawRonin(ctx, {
      x: this.x,
      y: this.y,
      facing: this.facing,
      state: this.state === 'windup' ? 'windup' : this.state === 'attack' ? 'attack' : this.state === 'chase' || this.state === 'search' ? 'chase' : 'idle',
      animT: this.animT,
      windup: this.windup,
      h: this.h,
      px: world.px,
    });
    // 攻击判定提示：一道红色扇光
    if (this.state === 'attack') {
      const c = T.ronin;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * (1 - this.stateT / c.attackTime);
      const a0 = this.facing > 0 ? 0 : Math.PI;
      ctx.fillStyle = '#ff3366';
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - this.h * 0.5);
      ctx.arc(
        this.x,
        this.y - this.h * 0.5,
        c.slashRadius,
        a0 - c.slashHalfAngle,
        a0 + c.slashHalfAngle,
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

// ============================================================
// 枪手
// ============================================================
export class Gunner extends EnemyBase {
  constructor(world, def) {
    super(world, def);
    const c = T.gunner;
    this.w = c.w;
    this.h = c.h;
    this.shotsLeft = 0;
    this.burstT = 0;
    this.flashT = 0;
  }

  reset(def, world) {
    super.reset(def, world);
    this.shotsLeft = 0;
    this.burstT = 0;
    this.flashT = 0;
  }

  behave(dt, world, player, sees) {
    const c = T.gunner;
    this.flashT = Math.max(0, this.flashT - dt);
    if (this.state !== 'aim') this.aimAngle = this.aimAngle || 0;

    switch (this.state) {
      case 'patrol':
      case 'idle': {
        if (sees) {
          this.setState('alert');
          this.alertPulse = 1;
          world.audio.play('alert', { pan: this.panCam(), gain: 0.45, pitch: 3 });
          break;
        }
        if (this.x < this.patrolMin) this.patrolDir = 1;
        else if (this.x > this.patrolMax) this.patrolDir = -1;
        if (this.grounded && !groundAhead(this, world.level, this.patrolDir, 20)) this.patrolDir *= -1;
        this.facing = this.patrolDir;
        this.vx = this.patrolDir * c.speed;
        break;
      }

      case 'alert': {
        this.vx *= 0.8;
        this.facing = sign(player.x - this.x) || this.facing;
        if (this.stateT > T.alertTime) this.setState('aim');
        break;
      }

      case 'aim': {
        const dx = player.x - this.x;
        const dy = this.y - this.h * 0.62 - (player.y - player.h * 0.55);
        this.aimAngle = Math.atan2(-dy, dx);
        this.facing = sign(dx) || this.facing;
        // 保持距离
        const adx = Math.abs(dx);
        if (adx < c.keepMin) {
          this.vx = -sign(dx) * c.retreatSpeed;
          if (this.grounded && !groundAhead(this, world.level, -sign(dx), 20)) this.vx = 0;
        } else if (adx > c.keepMax) {
          this.vx = sign(dx) * c.speed;
          if (this.grounded && !groundAhead(this, world.level, sign(dx), 20)) this.vx = 0;
        } else {
          this.vx *= 0.85;
        }
        if (!sees) {
          this.setState('search');
          this.searchT = 2.2;
          break;
        }
        if (this.stateT >= c.aimTime) {
          this.setState('fire');
          this.shotsLeft = c.burst;
          this.burstT = 0;
        }
        break;
      }

      case 'fire': {
        this.vx *= 0.9;
        this.burstT -= dt;
        if (this.shotsLeft > 0 && this.burstT <= 0) {
          this.shoot(world, player);
          this.shotsLeft--;
          this.burstT = c.burstGap;
        }
        if (this.shotsLeft <= 0 && this.burstT <= -0.06) {
          this.setState('reload');
          this.cooldown = c.reload;
        }
        break;
      }

      case 'reload': {
        this.vx *= 0.86;
        this.facing = sign(player.x - this.x) || this.facing;
        if (this.cooldown <= 0) {
          this.setState(sees ? 'aim' : 'search');
          if (!sees) this.searchT = 2.2;
        }
        break;
      }

      case 'search': {
        this.searchT -= dt;
        this.vx = 0;
        const dx = this.lastSeenX - this.x;
        if (Math.abs(dx) > 40) {
          this.facing = sign(dx);
          this.vx = this.facing * c.speed;
          if (this.grounded && !groundAhead(this, world.level, this.facing, 20)) this.vx = 0;
        }
        if (sees) this.setState('aim');
        else if (this.searchT <= 0) this.setState('patrol');
        break;
      }

      default:
        this.setState('patrol');
    }
  }

  shoot(world, player) {
    const muzzleX = this.x + Math.cos(this.aimAngle) * 20;
    const muzzleY = this.y - this.h * 0.62 + Math.sin(this.aimAngle) * 20;
    // 稍微加一点散布（不是必中，给玩家躲的空间）
    const spread = rnd(-0.045, 0.045);
    world.projectiles.spawnEnemyBullet(muzzleX, muzzleY, this.aimAngle + spread);
    this.flashT = 0.09;
    world.particles.sparks(muzzleX, muzzleY, 4, 5, 180, Math.cos(this.aimAngle), Math.sin(this.aimAngle));
    world.audio.play('enemyShoot', { pan: this.panCam(), gain: 0.5 });
    world.emitNoise(this.x, this.y, 520, 0.12);
  }

  panCam() {
    const cam = this.world.camera;
    return clamp((this.x - cam.ix) / 640, -1, 1);
  }

  /** 瞄准时的红色激光（时间减缓下看得最清楚） */
  drawLaser(ctx, world) {
    if (this.state !== 'aim' && this.state !== 'fire') return;
    const c = T.gunner;
    const t = this.state === 'aim' ? clamp(this.stateT / c.aimTime, 0, 1) : 1;
    const ox = this.x + Math.cos(this.aimAngle) * 16;
    const oy = this.y - this.h * 0.62 + Math.sin(this.aimAngle) * 16;
    const len = 900;
    // 被墙挡住就截断
    const hit = raycastSolids(
      ox,
      oy,
      Math.cos(this.aimAngle),
      Math.sin(this.aimAngle),
      len,
      world.level.solids,
    );
    const endX = ox + Math.cos(this.aimAngle) * hit;
    const endY = oy + Math.sin(this.aimAngle) * hit;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(ox, oy, endX, endY);
    g.addColorStop(0, `rgba(255,60,90,${0.12 + t * 0.4})`);
    g.addColorStop(1, `rgba(255,60,90,${0.05 + t * 0.25})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 0.7 + (1 - t) * 1.6;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    // 收束光环
    ctx.globalAlpha = 0.5 * t;
    ctx.fillStyle = '#ff2e50';
    ctx.beginPath();
    ctx.arc(endX, endY, 2.6 + (1 - t) * 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  draw(ctx, world) {
    drawGunner(ctx, {
      x: this.x,
      y: this.y,
      facing: this.facing,
      state:
        this.state === 'aim'
          ? 'aim'
          : this.flashT > 0
            ? 'fire'
            : this.state === 'chase' || this.state === 'search' || this.state === 'alert'
              ? 'chase'
              : 'idle',
      animT: this.animT,
      aimAngle: this.aimAngle,
      alert: this.state === 'alert' ? clamp(this.stateT / T.alertTime, 0, 1) : 0,
      h: this.h,
      px: world.px,
    });
  }
}

// ============================================================
// 铁卫（护盾）
// ============================================================
export class Shield extends EnemyBase {
  constructor(world, def) {
    super(world, def);
    const c = T.shield;
    this.w = c.w;
    this.h = c.h;
    this.shieldFlash = 0;
  }

  /** 攻击是否被盾牌正面挡下（只有近战会被挡） */
  blocksMeleeFrom(px, py) {
    if (this.shieldUp < 0.5) return false;
    const a = Math.atan2(py - this.centerY, px - this.x);
    const face = this.facing > 0 ? 0 : Math.PI;
    return Math.abs(angleDiff(a, face)) <= T.shield.blockHalfAngle;
  }

  tryHitSector(sector, world) {
    const box = bodyAABB(this);
    if (!sectorHitsRect(sector, box)) return false;
    // 用玩家位置判断"从哪一侧打过来"
    if (this.blocksMeleeFrom(world.player.x, world.player.y - world.player.h * 0.5)) {
      return 'blocked';
    }
    return true;
  }

  behave(dt, world, player, sees) {
    const c = T.shield;
    this.shieldUp = 1;

    switch (this.state) {
      case 'patrol':
      case 'idle': {
        if (sees) {
          this.setState('alert');
          this.alertPulse = 1;
          world.audio.play('alert', { pan: this.panCam(), gain: 0.5, pitch: -4 });
          break;
        }
        if (this.x < this.patrolMin) this.patrolDir = 1;
        else if (this.x > this.patrolMax) this.patrolDir = -1;
        if (this.grounded && !groundAhead(this, world.level, this.patrolDir, 22)) this.patrolDir *= -1;
        this.facing = this.patrolDir;
        this.vx = this.patrolDir * c.speed;
        break;
      }

      case 'alert': {
        this.vx *= 0.6;
        if (this.stateT > T.alertTime * 1.4) this.setState('chase');
        break;
      }

      case 'chase': {
        if (!player.alive) {
          this.setState('patrol');
          break;
        }
        // 慢速转向：转身慢是玩家的破绽窗口
        const targetFace = sign(player.x - this.x) || this.facing;
        const faceAngle = this.facing > 0 ? 0 : Math.PI;
        const targetAngle = targetFace > 0 ? 0 : Math.PI;
        const diff = angleDiff(targetAngle, faceAngle);
        const maxTurn = c.turnSpeed * dt;
        const applied = clamp(diff, -maxTurn, maxTurn);
        // 只在接近正后方时才翻转朝向（模拟"缓慢转身"）
        if (Math.abs(diff) > Math.PI * 0.5 && Math.abs(applied) >= maxTurn) {
          this.turnT = (this.turnT || 0) + dt;
          if (this.turnT > 0.22) {
            this.facing = targetFace;
            this.turnT = 0;
          }
        } else {
          this.turnT = 0;
          if (Math.abs(angleDiff(targetAngle, faceAngle)) < 0.4) this.facing = targetFace;
        }

        const dx = player.x - this.x;
        const dy = player.y - this.y;
        if (dy < -80 && Math.abs(dx) < 130 && this.grounded) {
          this.vy = -640;
          this.grounded = false;
        }
        const distX = Math.abs(dx);
        if (distX > 74) {
          this.vx = sign(dx) * c.chaseSpeed;
          if (this.grounded && !groundAhead(this, world.level, sign(dx), 22)) this.vx = 0;
        } else {
          this.vx *= 0.7;
          // 只有正面对着玩家才能盾撞：背后是玩家辛辛苦苦绕出来的奖励
          const facingPlayer = this.facing === sign(dx);
          if (this.cooldown <= 0 && Math.abs(dy) < 60 && facingPlayer) {
            this.setState('bashWindup');
            world.audio.play('windup', { pan: this.panCam(), gain: 0.45, pitch: -5 });
          }
        }
        if (!sees && distX > 300) this.setState('patrol');
        break;
      }

      case 'bashWindup': {
        this.vx *= 0.8;
        this.windup = clamp(this.stateT / c.bashWindup, 0, 1);
        this.blockFlash = Math.max(this.blockFlash, 0.35);
        if (this.stateT >= c.bashWindup) {
          this.setState('bash');
          this.bashHit = false;
          this.vx = this.facing * c.bashSpeed;
          world.audio.play('dash', { pan: this.panCam(), gain: 0.35, pitch: -8 });
        }
        break;
      }

      case 'bash': {
        if (!this.bashHit) {
          const box = bodyAABB(this);
          const pr = world.player.hurtRect();
          if (
            world.player.alive &&
            box.x < pr.x + pr.w &&
            box.x + box.w > pr.x &&
            box.y < pr.y + pr.h &&
            box.y + box.h > pr.y
          ) {
            this.bashHit = true;
            world.killPlayer('shieldBash', this.x, this.centerY);
          }
        }
        if (this.stateT >= c.bashTime) {
          this.setState('chase');
          this.cooldown = 1.3;
          this.windup = 0;
        }
        break;
      }

      default:
        this.setState('chase');
    }
    if (this.state !== 'bashWindup') this.windup = this.state === 'bash' ? 0.7 : 0;
  }

  panCam() {
    const cam = this.world.camera;
    return clamp((this.x - cam.ix) / 640, -1, 1);
  }

  draw(ctx, world) {
    drawShield(ctx, {
      x: this.x,
      y: this.y,
      facing: this.facing,
      state: this.state === 'bash' ? 'bash' : this.state === 'chase' ? 'chase' : 'idle',
      animT: this.animT,
      shieldUp: 1,
      blockFlash: this.blockFlash,
      h: this.h,
      px: world.px,
    });
    // 蓄力冲撞预警
    if (this.state === 'bashWindup') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * this.windup;
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(this.x + this.facing * 12, this.centerY - 6, this.facing * 46, 12);
      ctx.restore();
    }
  }
}

export function createEnemy(world, def) {
  switch (def.type) {
    case 'gunner':
      return new Gunner(world, def);
    case 'shield':
      return new Shield(world, def);
    default:
      return new Ronin(world, def);
  }
}
