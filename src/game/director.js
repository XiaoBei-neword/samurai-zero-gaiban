// ============================================================
// director.js —— 游戏流程与世界
//   * 死亡 → 红闪 → 0.1 秒内原地无线重置（无任何"Game Over"界面）
//   * 清版 → 开门 → 走进门 → 无缝切下一关
//   * 第 3 关清版后 → 结算面板（统计 + 按 R 从头开始）
// 同时是各系统互相调用的"世界对象"。
// ============================================================
import { T } from './const.js';
import { clamp, lerp, dist, sign, rnd, TAU } from '../core/math.js';
import { Level } from './level.js';
import { LEVELS } from './levels.js';
import { Player } from './player.js';
import { createEnemy } from './enemies.js';
import { ProjectileSystem } from './projectiles.js';
import { Particles } from '../core/particles.js';
import { bodyAABB } from './physics.js';
import { drawSlashArc } from '../core/sprites.js';
import { VIEW_W, VIEW_H } from '../core/render.js';
import { SLOW_WORLD, SLOW_PLAYER } from '../core/loop.js';

export const STATE = {
  PLAYING: 'playing',
  DEATH: 'death',
  TRANSITION: 'transition',
  VICTORY: 'victory',
};

export class Game {
  /**
   * @param {object} deps {renderer, input, audio, backdropFactory, camera, time}
   */
  constructor(deps) {
    this.renderer = deps.renderer;
    this.input = deps.input;
    this.audio = deps.audio;
    this.time = deps.time;
    this.camera = deps.camera;
    this.backdropFactory = deps.backdropFactory || null;
    this.backdrop = null;

    this.projectiles = new ProjectileSystem();
    this.particles = new Particles();
    this.player = new Player(this);
    this.enemies = [];
    this.corpses = [];
    this.noises = [];
    this.fx = [];
    this.level = null;
    this.levelIndex = 0;
    this.state = STATE.PLAYING;
    this.backdropEnabled = true;
    this.paused = false;
    this.slowForce = false;

    this.stats = { deaths: 0, kills: 0, runTime: 0, levelTime: 0, slowTime: 0 };
    this.deathTimer = 0;
    this.deathCause = '';
    this.transitionT = 0;
    this.transitionTo = -1;
    this.victoryT = 0;
    this.flashColor = '#ffffff';
    this.flashAlpha = 0;
    this.flashDecay = 0;
    this.worldTime = 0;
    this.clearedT = 0;
    this.muzzleCount = 0;
    this.hitMarker = 0;

    this.loadLevel(0, true);
  }

  // ============================================================
  // 关卡装载
  // ============================================================
  loadLevel(index, first = false) {
    this.levelIndex = index;
    const def = LEVELS[index];
    this.level = new Level(def);
    this.projectiles.reset();
    this.particles.reset();
    this.corpses.length = 0;
    this.noises.length = 0;
    this.fx.length = 0;

    // 敌人：按定义逐个创建（每关只有几个，开销可忽略）
    this.enemies = def.enemies.map((d) => createEnemy(this, d));

    // 摄像机
    this.camera.setBounds(0, 0, this.level.width, this.level.height);
    this.camera.snapTo(def.spawn.x + 120, def.spawn.y - 80);

    this.player.reset(def.spawn);
    this.camera.snapTo(this.player.x + 60, this.player.y - 40);

    // 背景
    this.backdrop = this.backdropFactory
      ? this.backdropFactory({
          width: this.level.width,
          height: this.level.height,
          seed: def.seed,
        })
      : null;

    this.state = STATE.PLAYING;
    this.deathTimer = 0;
    this.transitionT = 0;
    this.clearedT = 0;
    this.stats.levelTime = 0;
    if (first) {
      this.stats.runTime = 0;
      this.stats.deaths = 0;
      this.stats.kills = 0;
      this.stats.slowTime = 0;
    }
    this.audio.setCombat(false);
  }

  /** 重开当前关（死亡触发 或 玩家按 R） */
  resetLevel(byDeath) {
    const def = LEVELS[this.levelIndex];
    this.level.reset();
    this.projectiles.reset();
    this.particles.reset();
    this.corpses.length = 0;
    this.noises.length = 0;
    this.fx.length = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i].reset(def.enemies[i], this);
    }
    this.player.reset(this.level.spawnPoint);
    this.camera.snapTo(this.player.x + 50, this.player.y - 40);
    this.time.reset();
    this.state = STATE.PLAYING;
    this.deathTimer = 0;
    this.clearedT = 0;
    this.stats.levelTime = 0;
    this.audio.setCombat(false);
    if (byDeath) {
      this.audio.play('respawn', { gain: 0.3 });
    }
  }

  // ============================================================
  // 每帧（真实时间）：输入以外的 UI / 计时 / 状态迁移
  // ============================================================
  beginFrame(dtReal) {
    const input = this.input;

    // ESC：暂停 / 继续（暂停期间显示操作说明，世界完全冻结）
    if (input.consume('pause')) {
      this.paused = !this.paused;
      this.audio.play('uiClick', { gain: 0.4 });
      if (this.paused) this.audio.setSlow(0);
    }
    if (this.paused) {
      this.decayFlash(dtReal);
      return;
    }

    // R：重开当前关（结算面板里则是从头开始）
    if (input.consume('restart')) {
      if (this.state === STATE.VICTORY) {
        this.stats.runTime = 0;
        this.stats.deaths = 0;
        this.stats.kills = 0;
        this.stats.slowTime = 0;
        this.victoryT = 0;
        this.loadLevel(0, true);
        this.flash('#ffffff', 0.4, 3);
        this.audio.play('uiClick', { gain: 0.4 });
        return;
      }
      if (this.state === STATE.PLAYING || this.state === STATE.TRANSITION) {
        this.resetLevel(false);
        this.flash('#66e0ff', 0.22, 6);
        this.audio.play('uiClick', { gain: 0.4 });
        return;
      }
    }

    if (this.state === STATE.VICTORY) {
      this.victoryT = Math.min(1, this.victoryT + dtReal * 2.2);
      this.player.updateEnergy(dtReal, false);
      this.time.setSlow(false);
      this.particles.update(dtReal, this.level.solids, this.level.decals);
      this.stepFx(dtReal);
      this.decayFlash(dtReal);
      return;
    }

    // 子弹时间（按真实时间推进的能量槽，与时间缩放无关）
    // 测试钩子 holdSlowForce 会强制按住并有无限能量，用于逐帧量化采样。
    const wantSlow = (this.input.held.slow || this.slowForce) && this.state === STATE.PLAYING;
    const wasSlow = this.player.slowActive;
    this.player.updateEnergy(dtReal, wantSlow, !!this.slowForce);
    if (this.player.slowActive && !wasSlow) this.audio.play('slowIn', { gain: 0.35 });
    if (!this.player.slowActive && wasSlow) this.audio.play('slowOut', { gain: 0.25 });
    if (this.player.slowActive) this.stats.slowTime += dtReal;
    this.time.setSlow(this.player.slowActive);
    // 测试钩子：setSlowSlider(x) 让"动作节奏"变成 x 倍（玩家位置/速度恒不变，只改节奏）
    if (this.slowSlider > 0) {
      this.time.setSlow(true);
      this.time.worldScaleOverride = SLOW_WORLD * this.slowSlider;
      this.time.playerScaleOverride = SLOW_PLAYER * this.slowSlider;
    } else {
      this.time.worldScaleOverride = null;
      this.time.playerScaleOverride = null;
    }
    // 音频的减缓扫频只在明显变化时更新（每帧调用 60 次没必要）
    if (Math.abs(this.time.slowBlend - (this._lastSlowBlend || 0)) > 0.02 || (this.time.slowBlend === 0 && this._lastSlowBlend !== 0)) {
      this._lastSlowBlend = this.time.slowBlend;
      this.audio.setSlow(this.time.slowBlend);
    }

    if (this.state === STATE.PLAYING) this.stats.runTime += dtReal;

    // 死亡 → 红闪 → 瞬时重置
    if (this.state === STATE.DEATH) {
      this.deathTimer -= dtReal;
      this.particles.update(dtReal, this.level.solids, this.level.decals);
      this.stepFx(dtReal);
      this.camera.update(dtReal, this.player);
      if (this.deathTimer <= 0) {
        this.resetLevel(true);
        this.flash('#ff1030', 0.55, 6);
      }
    }

    // 切关
    if (this.state === STATE.TRANSITION) {
      this.transitionT += dtReal;
      if (this.transitionT >= T.transitionTime * 0.5 && this.transitionTo >= 0) {
        const next = this.transitionTo;
        this.transitionTo = -1;
        if (next >= LEVELS.length) {
          this.state = STATE.VICTORY;
          this.victoryT = 0;
          this.player.alive = true;
          this.audio.play('victory', { gain: 0.85 });
          this.audio.setCombat(false);
        } else {
          this.loadLevel(next);
          this.flash('#bff6ff', 0.5, 4);
          this.state = STATE.PLAYING;
        }
      }
    }

    this.decayFlash(dtReal);
    if (this.hitMarker > 0) this.hitMarker -= dtReal * 4;
  }

  decayFlash(dtReal) {
    if (this.flashAlpha > 0) {
      this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * dtReal);
    }
  }

  // ============================================================
  // 每个物理步（世界时间）
  // ============================================================
  step(dtWorld, dtPlayer) {
    this.worldTime += dtWorld;
    const lvl = this.level;

    if (this.state === STATE.VICTORY) {
      this.player.update(dtPlayer, this); // 只为了动画
      return;
    }

    if (this.state === STATE.PLAYING || this.state === STATE.TRANSITION) {
      this.stats.levelTime += dtPlayer;
      this.level.update(dtWorld);
      this.player.update(dtPlayer, this);

      // 敌人在世界时间下推进
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.alive) e.update(dtWorld, this);
      }
      this.separateBodies();

      this.projectiles.update(dtWorld, this);
      this.updateNoises(dtWorld);

      // 清版 → 开门
      if (!lvl.cleared && this.aliveEnemyCount() === 0 && this.state === STATE.PLAYING) {
        lvl.clear();
        this.clearedT = 0.001;
        this.audio.play('doorOpen', { gain: 0.6 });
        this.audio.play('levelClear', { gain: 0.55 });
        this.camera.shake(3, 4);
      }
      if (this.clearedT > 0) this.clearedT += dtWorld;

      // 战斗音乐强度（只在状态变化时通知音频，避免每步都改增益）
      const combatNow = this.aliveEnemyCount() > 0;
      if (combatNow !== this._lastCombat) {
        this._lastCombat = combatNow;
        this.audio.setCombat(combatNow);
      }
    }

    this.particles.update(dtWorld, lvl.solids, lvl.decals);
    this.stepFx(dtWorld);

    // 摄像机用玩家时间（减速时镜头不会"抢跑"）
    this.camera.update(dtPlayer, this.player);
  }

  stepFx(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      if (f.life <= 0) this.fx.splice(i, 1);
    }
  }

  separateBodies() {
    const p = this.player;
    if (!p.alive) return;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive) continue;
      const a = p.hurtRect();
      const b = bodyAABB(e);
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        // 只做水平轻推，不致死
        const dir = sign(p.x - e.x) || 1;
        const overlap = Math.min(
          a.x + a.w - b.x,
          b.x + b.w - a.x,
        );
        p.x += dir * Math.min(overlap, 6);
        p.vx += dir * 40;
        e.vx -= dir * 20;
      }
    }
  }

  /** 一个"世界像素"有多大：场景画布是 1/pixelScale 分辨率，再乘相机 zoom */
  get px() {
    return this.renderer.pixelScale / this.camera.zoom;
  }

  aliveEnemyCount() {
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i].alive) n++;
    return n;
  }

  // ============================================================
  // 事件接口（供各系统调用）
  // ============================================================
  emitNoise(x, y, radius, life = 0.1) {
    this.noises.push({ x, y, radius, life });
    if (this.noises.length > 32) this.noises.shift();
  }

  updateNoises(dt) {
    for (let i = this.noises.length - 1; i >= 0; i--) {
      const n = this.noises[i];
      n.life -= dt;
      if (n.life <= 0) {
        this.noises.splice(i, 1);
        continue;
      }
      // 只有新噪声才会叫醒敌人（避免每帧重复触发）
      if (n._handled) continue;
      n._handled = true;
      for (let k = 0; k < this.enemies.length; k++) {
        const e = this.enemies[k];
        if (e.alive) e.onHear(n, this);
      }
    }
  }

  killPlayer(cause, x, y) {
    if (this.noDeath) {
      // 仅自动化测试用的钩子：不掉血条也不会死。
      // 但"掉出世界"必须处理，否则会无限下落卡死。
      if (cause === 'fall') {
        const sp = this.level.spawnPoint;
        const p = this.player;
        p.x = sp.x;
        p.y = sp.y;
        p.px = sp.x;
        p.py = sp.y;
        p.vx = 0;
        p.vy = 0;
        this.camera.snapTo(sp.x, sp.y - 40);
      }
      return;
    }
    // 冲刺无敌：冲刺期间（以及结束后的几帧收尾）对一切伤害免疫 ——
    // 包括子弹、敌人的刀、盾撞、地刺、甚至自己的手雷。
    if (this.player.invulnT > 0) return;
    if (!this.player.alive || this.state !== STATE.PLAYING) return;
    const p = this.player;
    p.alive = false;
    p.deathT = 0;
    this.deathCause = cause;
    this.stats.deaths++;
    if (!this.deathLog) this.deathLog = [];
    this.deathLog.push({
      cause,
      x: Math.round(p.x),
      y: Math.round(p.y),
      at: Math.round(this.stats.runTime * 100) / 100,
    });
    if (this.deathLog.length > 10) this.deathLog.shift();
    this.state = STATE.DEATH;
    this.deathTimer = T.deathHoldTime;
    this.deathTotal = T.deathHoldTime;

    const cx = x === undefined ? p.x : x;
    const cy = y === undefined ? p.centerY : y;
    this.particles.bloodBurst(cx, cy, 0, 0, 34, 420);
    this.particles.sparks(cx, cy, 12, 2, 380);
    this.particles.limb(cx, cy, rnd(-1, 1), -1, 8, 1);
    this.audio.play(cause === 'spike' ? 'spikeDeath' : 'death', { gain: 0.85 });
    this.camera.shake(11, 7);
    this.time.hitstop(0.055);
    this.flash('#ff0a2a', 0.9, 9);
    this.level.decals.splat(cx, p.y + 2, 26, 1);
  }

  onEnemyKilled(enemy, vx, vy, src) {
    enemy.alive = false;
    this.stats.kills++;
    const dirX = Math.abs(vx) > 1 ? sign(vx) : enemy.facing;
    const dirY = Math.abs(vy) > 1 ? vy : -200;

    // 击飞：断肢 + 大量血
    const cx = enemy.x;
    const cy = enemy.centerY;
    this.enemies = this.enemies.filter((e) => e !== enemy);
    this.corpses.push({
      type: enemy.type,
      x: cx + dirX * 26,
      y: enemy.y,
      facing: -dirX,
      rot: dirX * 0.35,
      w: enemy.w,
      h: enemy.h,
      t: 0,
    });
    if (this.corpses.length > T.corpseLimit) this.corpses.shift();

    this.particles.bloodBurst(cx, cy, dirX, dirY * 0.004, 30, 460);
    this.particles.sparks(cx, cy, 8, 2, 340, dirX, -1);
    for (let i = 0; i < T.bodySplitPieces + 1; i++) {
      this.particles.limb(cx + rnd(-6, 6), cy + rnd(-8, 8), dirX * rnd(0.6, 1.4), -1, rnd(6, 12), 0);
    }
    this.level.decals.splat(cx + dirX * 12, enemy.y + 2, 22, 1);
    this.audio.play('kill', { gain: 0.9, pitch: rnd(-1, 1) });
    this.audio.play('slashHit', { gain: 0.55, pitch: rnd(-2, 2) });
    this.camera.shake(T.shakeKill, 8);
    this.time.hitstop(T.hitstopKill);
    this.flash('#ffffff', 0.16, 12);
    this.hitMarker = 1;
    this.fx.push({ type: 'killflash', x: cx, y: cy, life: 0.12, max: 0.12 });

    // 枪手不再掉落手枪（拾取/投掷系统已移除）
    // 附近敌人听到惨叫
    this.emitNoise(cx, cy, 420, 0.12);
  }

  /** 近战被盾牌挡下 */
  onBlocked(enemy, angle, sector) {
    const cx = enemy.x + Math.cos(angle) * 22;
    const cy = enemy.centerY;
    this.particles.sparks(cx, cy, 16, 5, 420, Math.cos(angle + Math.PI), Math.sin(angle + Math.PI));
    enemy.blockFlash = 1;
    this.audio.play('shieldBlock', { gain: 0.7 });
    this.camera.shake(T.shakeBlock, 9);
    this.time.hitstop(T.hitstopHit);
    // 玩家被弹开
    const p = this.player;
    p.vx = -Math.cos(angle) * 260;
    p.vy = -120;
    p.invulnT = Math.max(p.invulnT, 0.05);
    this.flash('#ffb347', 0.12, 12);
    this.fx.push({ type: 'ring', x: cx, y: cy, r0: 8, r1: 34, color: '#ffd9a0', life: 0.18, max: 0.18 });
  }

  /** 子弹被反弹 */
  onDeflect(bullet) {
    this.audio.play('deflect', { gain: 0.7, pitch: rnd(-1, 1) });
    this.particles.sparks(bullet.x, bullet.y, 12, 3, 320);
    this.camera.shake(2.2, 10);
    this.time.hitstop(0.022);
    this.fx.push({ type: 'ring', x: bullet.x, y: bullet.y, r0: 4, r1: 26, color: '#bff6ff', life: 0.16, max: 0.16 });
    this.flash('#8ef2ff', 0.1, 14);
  }

  onEnterDoor() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.TRANSITION;
    this.transitionT = 0;
    this.transitionTo = this.levelIndex + 1;
    this.audio.play('uiClick', { gain: 0.45, pitch: 5 });
    this.flash('#ffffff', 0.5, 3);
  }

  /** 计时：谁在同侧追击我（用于包抄判定） */
  countEngagers(exclude) {
    let n = 0;
    const px = this.player.x;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive || e === exclude) continue;
      if (e.state === 'chase' && Math.abs(e.x - px) < 460) n++;
    }
    return n;
  }

  flash(color, alpha, decay = 8) {
    if (alpha >= this.flashAlpha) {
      this.flashColor = color;
      this.flashAlpha = alpha;
      this.flashDecay = decay;
    }
  }

  ring(x, y, r0, r1, color, life) {
    this.fx.push({ type: 'ring', x, y, r0, r1, color, life, max: life });
  }

  shockwave(x, y, r) {
    this.fx.push({ type: 'ring', x, y, r0: 6, r1: r, color: '#ffd9a0', life: 0.3, max: 0.3 });
    this.fx.push({ type: 'ring', x, y, r0: 2, r1: r * 1.5, color: '#ff7a3c', life: 0.45, max: 0.45 });
  }

  // ============================================================
  // 绘制
  // ============================================================
  draw(alpha) {
    const r = this.renderer;
    const cam = this.camera;
    cam.interpolate(alpha);
    const view = cam.viewRect();
    const slow = this.time.slowBlend;

    // 世界部分画在 1/2 分辨率的场景画布上（像素风 + 更快）
    const ctx = r.beginScene('#050409');

    // 背景（压暗一档，让角色和刀光成为画面里最亮的东西）
    if (this.backdrop && this.backdropEnabled !== false) {
      ctx.save();
      ctx.globalAlpha = 0.72;
      this.backdrop.draw(ctx, view, this.worldTime + this.time.elapsedReal * 0, { slow, flash: 0 });
      ctx.restore();
      ctx.fillStyle = 'rgba(5,4,12,0.34)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    ctx.save();
    cam.applyTransform(ctx);

    // 房间静态层 + 血迹
    this.level.drawStatic(ctx, view);

    // 视口裁剪：屏幕外的东西不画（同屏敌人多的时候这项最省）
    const vx0 = view.x - 80;
    const vx1 = view.x + view.w + 80;
    const vy0 = view.y - 80;
    const vy1 = view.y + view.h + 80;
    const onScreen = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

    // 尸体
    this.drawCorpses(ctx, onScreen);

    // 门 / 拾取物
    this.level.drawDynamic(ctx, this.worldTime, this.px);

    // 敌人（先画激光，再画身体）
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.alive && onScreen(e.x, e.y - e.h * 0.5)) e.drawLaser(ctx, this);
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.alive && onScreen(e.x, e.y - e.h * 0.5)) e.draw(ctx, this);
    }

    // 投掷物 / 子弹
    this.projectiles.draw(ctx, slow, onScreen);

    // 玩家
    this.player.draw(ctx, alpha, this);

    // 粒子
    this.particles.draw(ctx, onScreen);

    // 特效层
    this.drawFx(ctx);

    ctx.restore();

    // 场景 → 屏幕（2x 最近邻放大），HUD 画在全分辨率上
    const dctx = r.endScene();
    this.drawHud(dctx);
    r.setFlash(this.flashColor, this.flashAlpha);
    r.finish(slow, this.time.elapsedReal);
  }

  drawCorpses(ctx, onScreen) {
    for (let i = 0; i < this.corpses.length; i++) {
      const c = this.corpses[i];
      if (onScreen && !onScreen(c.x, c.y - 10)) continue;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.globalAlpha = 0.92;
      // 躺在地上的身体：一段深色躯干 + 头
      ctx.fillStyle = '#0b0812';
      ctx.beginPath();
      ctx.ellipse(0, -7, c.h * 0.4, 7, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#141020';
      ctx.beginPath();
      ctx.arc(-c.facing * c.h * 0.34, -9, 6, 0, TAU);
      ctx.fill();
      // 霓虹轮廓残光
      ctx.strokeStyle = c.type === 'gunner' ? '#1c6b84' : c.type === 'shield' ? '#8a5f22' : '#7a1638';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(0, -7, c.h * 0.4, 7, 0, Math.PI * 0.05, Math.PI * 0.95);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawFx(ctx) {
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i];
      const t = 1 - f.life / f.max;
      if (f.type === 'ring') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 3 * (1 - t) + 0.6;
        ctx.beginPath();
        ctx.arc(f.x, f.y, lerp(f.r0, f.r1, t), 0, TAU);
        ctx.stroke();
        ctx.restore();
      } else if (f.type === 'killflash') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (1 - t) * 0.8;
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 46);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(1, 'rgba(255,90,140,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 46, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    // 玩家的刀光
    const p = this.player;
    if (p.alive && p.slashT >= 0) {
      const prog = clamp(p.slashT / T.slashActive, 0, 1);
      drawSlashArc(
        ctx,
        p.ix + Math.cos(p.slashAngle) * T.slashOffset,
        p.iy - p.h * 0.5 + Math.sin(p.slashAngle) * T.slashOffset,
        T.slashRadius,
        p.slashAngle,
        T.slashHalfAngle,
        prog,
        'rgba(255,255,255,0.95)',
        'rgba(150,240,255,0.7)',
        this.px,
      );
    }
  }

  /** HUD 由 hud.js 负责，这里转发 */
  drawHud(ctx) {
    if (this.hud) this.hud.draw(ctx, this);
  }

  // ============================================================
  // 调试 / 测试用
  // ============================================================
  snapshot() {
    const p = this.player;
    return {
      state: this.state,
      paused: !!this.paused,
      level: this.levelIndex + 1,
      levelName: this.level.name,
      player: {
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        vx: Math.round(p.vx * 10) / 10,
        vy: Math.round(p.vy * 10) / 10,
        alive: p.alive,
        grounded: p.grounded,
        state: p.state,
        energy: Math.round(p.energy * 10) / 10,
        slow: p.slowActive,
        jumpsLeft: p.jumpsLeft,
        invuln: p.invulnT > 0,
        invulnT: Math.round(p.invulnT * 1000) / 1000,
        dashCd: Math.round(p.dashCd * 1000) / 1000,
        dashT: Math.round(p.dashT * 1000) / 1000,
        slashT: Math.round(p.slashT * 1000) / 1000,
        slashCount: p.slashCount || 0,
        dashCount: p.dashCount || 0,
        jumpCount: p.jumpCount || 0,
        doubleJumpCount: p.doubleJumpCount || 0,
        deflectCount: p.deflectCount || 0,
        slashAngle: Math.round(p.slashAngle * 100) / 100,
        attackBuffer: Math.round(p.attackBuffer * 1000) / 1000,
        aim: Math.round(p.aimAngle * 100) / 100,
        aimPoint: [Math.round(p.aimX), Math.round(p.aimY)],
        pointer: [
          Math.round(this.input.pointer.sx),
          Math.round(this.input.pointer.sy),
        ],
        heldAttack: this.input.held.attack,
      },
      enemies: this.enemies.map((e) => ({
        type: e.type,
        x: Math.round(e.x),
        y: Math.round(e.y),
        state: e.state,
        facing: e.facing,
        heard: Math.round((e.heard || 0) * 100) / 100,
        alive: e.alive,
      })),
      deathCause: this.deathCause,
      deathLog: this.deathLog || [],
      enemiesAlive: this.aliveEnemyCount(),
      bullets: this.projectiles.stats(),
      particles: this.particles.stats(),
      cleared: this.level.cleared,
      doorOpen: Math.round(this.level.door.openT * 100) / 100,
      doorUsable: this.level.doorUsable,
      stats: {
        deaths: this.stats.deaths,
        kills: this.stats.kills,
        runTime: Math.round(this.stats.runTime * 100) / 100,
      },
      victory: this.state === STATE.VICTORY,
      corpses: this.corpses.length,
    };
  }
}
