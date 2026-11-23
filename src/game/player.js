// ============================================================
// player.js —— 玩家：移动 / 二段跳 / 蹬墙跳 / 冲刺(无敌) / 劈砍 / 减缓时间
//
// 时间缩放的处理（很重要，改之前先读）：
//   update(dt, world)
//     dt = 一个世界物理步对应的真实秒数（正常 1/120，子弹时间 1/30）。
//     所有"每真实秒"的速度量（水平速度、重力、跳跃初速）都按真实秒推进；
//   因为一步在世界时间里只推进 worldScale 份，而一步的"距离"又固定，所以：
//     计时器（土狼时间/攻击窗口/冷却）  用 s   → 子弹时间里玩家的操作节奏变慢 s 倍
//     位移 = v · s/worldScale             → 每步走的距离缩短，整体速度慢 s/... 见下
//     重力/加速度 = 常量 ÷ (s/worldScale)  → 与位置同量纲地一起缩放
//   代入可得：同一步的位移 = g0·(dtReal·s)²·(f/s²) = g0·dtReal² —— 与时间缩放完全无关，
//   所以**跳跃高度、下落轨迹恒定**，只是全程耗时被拉长 1/s 倍。
//
// 其它约定：
//   * 输入锁存（consume）让一次按键在多个物理子步里只触发一次
//   * 劈砍判定是扇形，且同时对"上一帧位置"和"当前位置"双采样，防穿透
// ============================================================
import { T } from './const.js';
import {
  clamp,
  approach,
  sign,
  lerp,
  dist,
  makeSector,
  sectorHitsRect,
  sectorContainsPoint,
  rnd,
  TAU,
  angleDiff,
} from '../core/math.js';
import { moveBody, probeGround } from './physics.js';
import { drawSamurai } from '../core/sprites.js';
import { PROJECTILE_TYPE } from './projectiles.js';

export class Player {
  constructor(world) {
    this.world = world;
    this.w = T.playerW;
    this.h = T.playerH;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.alive = true;
    this.grounded = false;
    this.wasGrounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpsLeft = 1; // 还能二段跳几次
    this.jumpCut = false;
    this.jumpHeld = false;
    this.wallSlide = false;
    this.wallDir = 0;
    this.wallJumpLock = 0;
    this.dashT = 0;
    this.dashCd = 0;
    this.dashDir = 1;
    this.invulnT = 0;
    this.slashT = -1;
    this.slashAngle = 0;
    this.slashDone = false;
    this.attackBuffer = 0;
    this.energy = T.energyMax;
    this.slowActive = false;
    this.slowLock = 0;
    this.regenDelay = 0;
    this.animT = 0;
    this.state = 'idle';
    this.trail = [];
    this.trailT = 0;
    this.aimX = 0;
    this.aimY = 0;
    this.aimAngle = 0;
    this.landSquash = 0;
    this.lastAttackSource = 'mouse';
    this.deathT = 0;
    this.ix = 0;
    this.iy = 0;
    this.ghostT = 0;
  }

  reset(spawn) {
    this.x = spawn.x;
    this.y = spawn.y;
    this.px = spawn.x;
    this.py = spawn.y;
    this.ix = spawn.x;
    this.iy = spawn.y;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.alive = true;
    this.grounded = true;
    this.wasGrounded = true;
    this.coyote = 0;
    this.airTime = 0;
    this.jumpBuffer = 0;
    this.jumpsLeft = 1;
    this.jumpCut = false;
    this.wallSlide = false;
    this.dashT = 0;
    this.dashCd = 0;
    this.invulnT = 0;
    this.slashT = -1;
    this.slashDone = true;
    this.energy = T.energyMax;
    this.slowActive = false;
    this.slowLock = 0;
    this.regenDelay = 0;
    this.animT = 0;
    this.state = 'idle';
    this.trail.length = 0;
    this.deathT = 0;
    this.landSquash = 0;
    this.attackBuffer = 0;
  }

  get invulnActive() {
    return this.invulnT > 0;
  }

  get centerY() {
    return this.y - this.h * 0.5;
  }

  hurtRect() {
    return {
      x: this.x - T.playerHurtW * 0.5,
      y: this.y - T.playerHurtH,
      w: T.playerHurtW,
      h: T.playerHurtH,
    };
  }

  // ============================================================
  // 能量（用真实时间推进，在帧循环里单独调用一次）
  // ============================================================
  updateEnergy(dtReal, wantSlow, infinite) {
    if (this.slowLock > 0) this.slowLock -= dtReal;
    const canStart = this.slowActive
      ? infinite || this.energy > 0
      : (infinite || this.energy >= T.energyMinStart) && this.slowLock <= 0;

    if (wantSlow && canStart && this.alive) {
      this.slowActive = true;
      if (infinite) {
        this.energy = T.energyMax;
        this.regenDelay = 0;
      } else {
        this.energy -= T.energyDrain * dtReal;
        this.regenDelay = T.energyRegenDelay;
      }
      if (this.energy <= 0) {
        this.energy = 0;
        this.slowActive = false;
        this.slowLock = T.slowExitLock;
      }
    } else {
      this.slowActive = false;
      if (this.regenDelay > 0) this.regenDelay -= dtReal;
      else if (this.energy < T.energyMax) {
        this.energy = Math.min(T.energyMax, this.energy + T.energyRegen * dtReal);
      }
    }
  }

  // ============================================================
  // 每个物理步
  // ============================================================
  /**
   * 只有一个时间单位：**真实秒**。
   *   dt = FIXED_DT × s（s = playerScale / worldScale，正常 1，子弹时间 4）
   * 所有"每真实秒"的速度量（水平速度、重力、跳跃初速）都按真实秒推进；
   * 子弹时间只是把每一步的 dt 变小（世界走得更细），速度按 dt 累积，
   * 因此弹道形状恒定、只是每一帧走得少 → 视觉上整体变慢。
   */
  update(dt, world) {
    this.dt = dt;
    if (!this.alive) {
      this.deathT += dt;
      this.px = this.x;
      this.py = this.y;
      return;
    }
    this.px = this.x;
    this.py = this.y;
    this.animT += dt;
    this.wasGrounded = this.grounded;

    if (this.dashCd > 0) this.dashCd -= dt;
    if (this.invulnT > 0) this.invulnT -= dt;
    if (this.attackBuffer > 0) this.attackBuffer -= dt;
    if (this.wallJumpLock > 0) this.wallJumpLock -= dt;
    if (this.landSquash > 0) this.landSquash = Math.max(0, this.landSquash - dt * 4.5);

    // 鼠标 → 世界坐标（攻击方向要跟着指针）
    const input = world.input;
    const mw = world.camera.screenToWorld(input.pointer.sx, input.pointer.sy);
    this.aimX = mw.x;
    this.aimY = mw.y;
    this.aimAngle = Math.atan2(mw.y - this.centerY, mw.x - this.x);

    this._handleJumpInput(dt, world);
    this._handleDash(dt, world);
    this._handleAttack(dt, world);
    this._physics(dt, world);
    this._checkHazards(world);
    this._checkDoor(world);
    this._updateState(dt, world);
  }

  // ---------------- 跳跃 ----------------
  // 土狼时间 / 剩余跳跃次数由 _physics 末尾按"真实着地状态"维护：
  //   grounded → coyote = T.coyoteTime, jumpsLeft = 1
  //   否则     → coyote 递减
  // 这里只做判定，绝不刷新它们（否则起跳当步会被补回来，出现"一步跳两次"）。
  _handleJumpInput(dt, world) {
    const input = world.input;
    if (input.consume('jump')) this.jumpBuffer = T.jumpBuffer;
    else if (this.jumpBuffer > 0) this.jumpBuffer -= dt;

    const jumpPressed = this.jumpBuffer > 0;
    if (jumpPressed && this.dashT <= 0) {
      // 注意：起跳后的"离地"要等下一个物理步才生效（grounded 在步末尾更新），
      // 所以同一次按键会在本步（以及紧随其后的一两步）里被再次看到。
      // 用 jumpArmed 保证"一次按键只消耗一次跳跃"。
      if (this.jumpArmed === undefined) this.jumpArmed = true;
      if (this.jumpArmed && this.coyote > 0) {
        // 地面上起跳
        this._doJump(world, T.jumpVel, false);
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.jumpsLeft = 0;
        this.jumpArmed = false;
      } else if (this.jumpArmed && this.wallSlide) {
        this._doWallJump(world);
        this.jumpArmed = false;
      } else if (this.jumpArmed && this.jumpsLeft > 0) {
        // 空中二段跳
        this._doJump(world, T.doubleJumpVel, true);
        this.jumpsLeft = 0;
        this.jumpBuffer = 0;
        this.jumpArmed = false;
      }
    }
    // 按键松开后重新武装，等待下一次按下
    if (!input.held.jump && !this.jumpArmed) this.jumpArmed = true;

    // 可变跳跃高度：松手就削掉上升速度
    if (!input.held.jump && this.vy < -80 && !this.jumpCut) {
      this.vy *= T.jumpCutFactor;
      this.jumpCut = true;
    }
  }

  _doJump(world, vel, isDouble) {
    this.jumpCount = (this.jumpCount || 0) + 1;
    if (isDouble) this.doubleJumpCount = (this.doubleJumpCount || 0) + 1;
    this.vy = -vel;
    this.justJumped = true;
    this.grounded = false;
    this.jumpCut = false;
    this.landSquash = 0;
    world.particles.dust(this.x, this.y, isDouble ? 8 : 5);
    if (isDouble) {
      // 二段跳的气浪圈
      world.ring(this.x, this.y - 6, 10, 46, '#8ef2ff', 0.28);
      world.audio.play('doubleJump', { gain: 0.5 });
    } else {
      world.audio.play('jump', { gain: 0.45 });
    }
    world.emitNoise(this.x, this.y, 260, 0.08);
  }

  _doWallJump(world) {
    this.vx = -this.wallDir * T.wallJumpX;
    this.vy = -T.wallJumpY;
    this.wallJumpLock = T.wallJumpLock;
    this.wallSlide = false;
    this.jumpCut = false;
    this.jumpsLeft = 1;
    this.jumpBuffer = 0;
    this.facing = -this.wallDir;
    world.particles.dust(this.x, this.y - this.h * 0.4, 8);
    world.audio.play('jump', { gain: 0.4, pitch: 3 });
    world.emitNoise(this.x, this.y, 260, 0.08);
  }

  // ---------------- 冲刺 ----------------
  _handleDash(dt, world) {
    const input = world.input;
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.dashDir * T.dashSpeed;
      this.vy = 0;
      // 残影
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.018;
        if (this.trail.length < 12) {
          this.trail.push({ x: this.x, y: this.y, facing: this.facing, life: 0.22, max: 0.22 });
        }
      }
      if (this.dashT <= 0) {
        this.vx = this.dashDir * T.dashSpeed * T.dashEndKeep;
      }
      return;
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].life -= dt;
      if (this.trail[i].life <= 0) this.trail.splice(i, 1);
    }

    if (input.consume('dash') && this.dashCd <= 0) {
      // 冲刺方向：有水平输入用输入方向，否则用朝向
      let dir = 0;
      if (input.held.left) dir -= 1;
      if (input.held.right) dir += 1;
      this.dashDir = dir !== 0 ? dir : this.facing;
      this.facing = this.dashDir;
      this.dashT = T.dashTime;
      this.dashCount = (this.dashCount || 0) + 1;
      this.dashCd = T.dashCooldown;
      this.invulnT = T.dashInvuln;
      this.vy = 0;
      this.jumpCut = true;
      world.particles.dust(this.x, this.y, 10, -this.dashDir);
      world.audio.play('dash', { gain: 0.55 });
      world.emitNoise(this.x, this.y, 320, 0.12);
      world.camera.shake(1.4, 9);
    }
  }

  // ---------------- 劈砍 ----------------
  _handleAttack(dt, world) {
    const input = world.input;
    if (input.consume('attack')) {
      this.attackBuffer = T.slashBuffer;
      this.lastAttackSource = input.lastAttackSource;
    } else if (this.attackBuffer > 0) {
      this.attackBuffer -= dt;
    }

    if (this.slashT >= 0) {
      this.slashT += dt;
      // 判定窗口（双采样：本步起点 + 终点）
      if (this.slashT <= T.slashActive && !this.slashDone) {
        this._resolveSlash(world);
      }
      if (this.slashT > T.slashActive + T.slashRecover) {
        this.slashT = -1;
        this.slashDone = true;
      }
    }

    // 启动新的一刀：后摇可被冲刺取消，但判定期间不能再出新刀
    if (this.attackBuffer > 0 && (this.slashT < 0 || this.slashT > T.slashCancelWindow)) {
      if (this.slashT < 0) {
        this._startSlash(world);
        this.attackBuffer = 0;
      }
    }
  }

  _startSlash(world) {
    const input = world.input;
    this.slashCount = (this.slashCount || 0) + 1;
    let angle;
    if (this.lastAttackSource === 'mouse') {
      angle = Math.atan2(this.aimY - this.centerY, this.aimX - this.x);
    } else {
      angle = this.facing > 0 ? 0 : Math.PI;
    }
    this.slashAngle = angle;
    this.slashT = 0;
    this.slashDone = false;
    this.facing = Math.cos(angle) >= 0 ? 1 : -1;
    world.audio.play('slash', { gain: 0.55 });
    world.emitNoise(this.x, this.y, 220, 0.08);
    this.vx += Math.cos(angle) * 26;
    if (Math.abs(Math.sin(angle)) < 0.4) this.vy += Math.sin(angle) * 10;
  }

  _slashSector(angle, x = this.x, y = this.centerY) {
    return makeSector(
      x + Math.cos(angle) * T.slashOffset,
      y + Math.sin(angle) * T.slashOffset,
      T.slashRadius,
      angle,
      T.slashHalfAngle,
    );
  }

  _resolveSlash(world) {
    const angle = this.slashAngle;
    const secNow = this._slashSector(angle);
    const secPrev = this._slashSector(angle, this.px, this.py - this.h * 0.5);
    let hitSomething = false;

    // ---- 敌人 ----
    for (let i = 0; i < world.enemies.length; i++) {
      const e = world.enemies[i];
      if (!e.alive) continue;
      const resNow = e.tryHitSector(secNow, world);
      const resPrev = resNow ? false : e.tryHitSector(secPrev, world);
      const res = resNow || resPrev;
      if (!res) continue;
      if (res === 'blocked') {
        world.onBlocked(e, angle, secNow);
        continue;
      }
      hitSomething = true;
      e.hurt(1, Math.cos(angle) * 620, Math.sin(angle) * 620 - 120, world);
    }

    // ---- 反弹敌方子弹 ----
    const ps = world.projectiles.pool;
    for (let i = 0; i < ps.length; i++) {
      const b = ps[i];
      if (!b.active || b.kind !== PROJECTILE_TYPE.EBULLET || b.deflected) continue;
      if (sectorContainsPoint(secNow, b.x, b.y, 4) || sectorContainsPoint(secPrev, b.x, b.y, 4)) {
        if (world.projectiles.deflect(b, world.enemies)) {
          this.deflectCount = (this.deflectCount || 0) + 1;
          hitSomething = true;
          world.onDeflect(b);
        }
      }
    }
    return hitSomething;
  }

  // ---------------- 拾取 / 投掷：已按需求移除 ----------------
  // 原本这里用右键/K 拾取场上道具再投掷。现在是"只有刀"的版本：
  // 右键改成减缓时间（见 input.js），K 不再绑定任何动作。

  // ---------------- 物理 ----------------
  //   dt  = 动作节奏：一个世界物理步对应的真实秒数（正常 1/120，子弹时间 1/30）
  //   f   = 位置推进时间（真实秒）：位移 = 速度 × f
  // 只有一种时间单位（真实秒）：位移 = 速度 × dt，重力/摩擦/加速度也都按 dt 累积。
  // 子弹时间里 dt 变小 → 每一帧走得少、累积得慢，视觉上整体变慢，而弹道形状完全不变。
  _physics(dt, world) {
    const input = world.input;
    const level = world.level;
    const moveDt = Math.max(dt, 1e-6);

    // ---- 水平 ----
    if (this.dashT > 0) {
      // 冲刺中由 _handleDash 直接设置速度
    } else if (this.wallJumpLock > 0) {
      // 蹬墙后短暂锁方向，避免手感"粘墙"
    } else {
      let dir = 0;
      if (input.held.left) dir -= 1;
      if (input.held.right) dir += 1;
      if (dir !== 0) {
        const accel = this.grounded ? T.groundAccel : T.airAccel;
        const turning = this.vx !== 0 && sign(this.vx) !== dir;
        this.vx = approach(this.vx, dir * T.maxSpeed, accel * (turning ? T.turnBoost : 1) * dt);
        if (this.grounded) this.facing = dir;
      } else {
        const fr = this.grounded ? T.groundFriction : T.airDrag;
        this.vx = approach(this.vx, 0, fr * dt);
      }
    }

    // ---- 重力 ----
    if (this.dashT <= 0) {
      // 起跳当步不再叠加一次重力（否则 720 - 约 14 ≈ 706，肉眼感觉"跳不高"）
      if (!this.justJumped) {
        let g = T.gravity;
        if (this.vy < 0) g = input.held.jump ? T.gravityRiseHeld : T.gravity;
        else g = T.gravityFall;
        this.vy = Math.min(this.vy + g * dt, T.maxFallSpeed);
      }
      this.justJumped = false;
    }

    // ---- 位移 + 碰撞 ----
    // 位移 = 速度 × dt（真实秒）。
    const wasOnGround = this.grounded;
    // 注意：必须在 moveBody 之前取"本步是否在往上飞"，
    // 因为 moveBody 在落地分支里会把 b.vy 清零，之后再判断就永远是"没在飞"。
    const movingUp = this.vy < 0;
    const res = moveBody(this, this.vx * moveDt, this.vy * moveDt, level);
    if (res.hitX) {
      // 贴墙：进入下滑状态
      this.wallDir = sign(this.vx) || this.facing;
      this.vx = 0;
    }

    // 着地判定（三条互斥，顺序很重要）：
    //   1) 本步在往上飞 → 一律离地（绝不能被起跳当步的碰撞结果清掉 vy）
    //   2) 本步往下落且扫掠判为触地 → 落地，vy 归零
    //   3) 本步开始就在地上且没往上飞 → 用 3px 探测复核（走出平台边缘时变 false）
    if (movingUp) {
      this.grounded = false;
    } else if (res.grounded) {
      this.vy = 0;
      this.grounded = true;
    } else if (wasOnGround) {
      this.grounded = probeGround(this, level, 3) && this.vy >= 0;
    } else {
      this.grounded = false;
    }

    // 落地：声音/尘土/挤压
    if (this.grounded && !this.wasGrounded && this.dashT <= 0) {
      const impact = clamp(Math.abs(this.vy) / 900, 0.2, 1);
      this.landSquash = 0.6 + impact * 0.7;
      world.particles.dust(this.x, this.y, 5 + Math.floor(impact * 6));
      world.audio.play('land', { gain: 0.18 + impact * 0.35 });
      world.emitNoise(this.x, this.y, 220, 0.08);
      world.camera.shake(1.2 * impact, 12);
    }
    // ---- 腾空计时 / 土狼时间 / 二段跳（按本步末尾的真实着地状态维护）----
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (this.grounded) {
      this.coyote = T.coyoteTime;
      this.jumpsLeft = 1;
    } else if (this.coyote > 0) {
      this.coyote -= dt;
    }
    // 空中二次跳跃：离地超过一小段时间后允许再跳一次。
    // 不用"落地时置 1"的写法，因为它会被起跳当步残留的 grounded 立刻吃掉。
    if (!this.grounded && this.airTime > T.doubleJumpDelay) this.jumpsLeft = Math.max(this.jumpsLeft, 1);

    // ---- 蹬墙下滑 ----
    const pressing = (input.held.left && this.wallDir < 0) || (input.held.right && this.wallDir > 0);
    const touchingWall = !this.grounded && res.hitX;
    this.wallSlide = false;
    if (!this.grounded && this.vy > 0 && this._isTouchingWall(level) && pressing) {
      this.wallSlide = true;
      if (this.vy > T.wallSlideMax) this.vy = T.wallSlideMax;
      if (Math.random() < 0.28) world.particles.dust(this.x + this.wallDir * 6, this.y - this.h * 0.4, 1);
    }

    // 边界保护：掉出世界下方算死（地刺坑）
    if (this.y > level.height + 80) {
      world.killPlayer('fall', this.x, this.y);
    }
  }

  _isTouchingWall(level) {
    const probe = {
      x: this.x + this.wallDir * 4,
      y: this.y - this.h * 0.5,
      w: 1,
      h: this.h * 0.8,
    };
    for (const s of level.solids) {
      if (
        probe.x < s.x + s.w &&
        probe.x + probe.w > s.x &&
        probe.y < s.y + s.h &&
        probe.y + probe.h > s.y
      )
        return true;
    }
    return false;
  }

  _checkHazards(world) {
    if (!this.alive || this.invulnT > 0) return;
    const hr = this.hurtRect();
    // 略微内缩，避免擦边就死
    const shrunk = { x: hr.x + 3, y: hr.y + 4, w: hr.w - 6, h: hr.h - 6 };
    for (const h of world.level.hazards) {
      if (
        shrunk.x < h.x + h.w &&
        shrunk.x + shrunk.w > h.x &&
        shrunk.y < h.y + h.h &&
        shrunk.y + shrunk.h > h.y
      ) {
        world.killPlayer('spike', this.x, this.y - 10);
        return;
      }
    }
  }

  _checkDoor(world) {
    if (!world.level.doorUsable) return;
    const d = world.level.door;
    const hr = this.hurtRect();
    if (hr.x < d.x + d.w && hr.x + hr.w > d.x && hr.y < d.y + d.h && hr.y + hr.h > d.y) {
      world.onEnterDoor();
    }
  }

  _updateState(dt, world) {
    if (!this.alive) {
      this.state = 'idle';
      return;
    }
    if (this.dashT > 0) this.state = 'dash';
    else if (this.slashT >= 0) this.state = 'slash';
    else if (this.wallSlide) this.state = 'wall';
    else if (!this.grounded) this.state = this.vy < -40 ? 'jump' : 'fall';
    else if (Math.abs(this.vx) > 24) this.state = 'run';
    else this.state = 'idle';
  }

  // ---------------- 绘制 ----------------
  renderPos(alpha) {
    this.ix = lerp(this.px, this.x, alpha);
    this.iy = lerp(this.py, this.y, alpha);
    return { x: this.ix, y: this.iy };
  }

  draw(ctx, alpha, world) {
    const { x, y } = this.renderPos(alpha);
    const slow = world.time.slowBlend;

    // 冲刺残影
    for (const t of this.trail) {
      const a = t.life / t.max;
      drawSamurai(ctx, {
        x: lerp(t.x, this.x, 0.35),
        y: lerp(t.y, this.y, 0.35),
        facing: t.facing,
        state: 'dash',
        animT: this.animT,
        slow: 0,
        alpha: a * 0.3,
        ghost: true,
        h: T.playerH,
        px: world.px,
      });
    }

    if (!this.alive) {
      // 死亡：身体瘫软下沉
      ctx.save();
      ctx.globalAlpha = clamp(1 - this.deathT * 1.2, 0, 1);
      drawSamurai(ctx, {
        x,
        y,
        facing: this.facing,
        state: 'fall',
        animT: 0,
        slow: 0,
        alpha: 1,
        h: T.playerH,
        px: world.px,
      });
      ctx.restore();
      return;
    }

    // 落地挤压（squash & stretch）
    const sq = this.landSquash;
    ctx.save();
    if (sq > 0.01) {
      ctx.translate(x, y);
      ctx.scale(1 + sq * 0.18, 1 - sq * 0.20);
      ctx.translate(-x, -y);
    }
    drawSamurai(ctx, {
      x,
      y,
      facing: this.facing,
      state: this.state === 'slash' ? 'run' : this.state,
      animT: this.animT,
      slash: this.slashT >= 0 ? { angle: this.slashAngle, t01: clamp(this.slashT / (T.slashActive + T.slashRecover), 0, 1) } : null,
      slow,
      alpha: 1,
      h: T.playerH,
      px: world.px,
    });
    ctx.restore();

    // 无敌（冲刺）时的青色轮廓
    if (this.invulnT > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = '#7ee8ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y - this.h * 0.5, 16, 27, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }
}
