// ============================================================
// debug.js —— 只读状态快照 + 测试钩子
// 正常游玩时这两个对象不会被用到；自测脚本通过 CDP 调用它们。
// 明确区分：
//   window.__GAME__  —— 只读，给测试断言用（关卡、玩家、敌人、FPS、统计）
//   window.__TEST__  —— 会产生副作用（传送、加压、造死亡），只给自动化测试用
// ============================================================
import { createEnemy } from './enemies.js';
import { T } from './const.js';
import { LEVELS } from './levels.js';

export function installDebug(deps) {
  const { game, time, renderer, audio, input } = deps;
  let stress = null;

  // ---------- 只读 ----------
  const gameApi = {
    version: '1.0.0',
    snapshot: () => game.snapshot(),
    fps: () => time.stats.fps,
    frameStats: () => {
      const p = time.stats.percentiles();
      return {
        fps: time.stats.fps,
        recentFps: time.stats.recentFps(180),
        minFps: time.stats.minFps,
        maxFrameMs: time.stats.maxFrameMs,
        p50ms: p.p50,
        p95ms: p.p95,
        maxMs: p.max,
        frames: time.stats.frames,
      };
    },
    timeScales: () => ({
      world: time.worldScale,
      player: time.playerScale,
      ratio: time.playerScale / Math.max(time.worldScale, 1e-4),
      slowBlend: time.slowBlend,
      slowActive: player().slowActive,
    }),
    poolStats: () => ({
      particles: game.particles.stats(),
      projectiles: game.projectiles.stats(),
      enemies: game.enemies.length,
      corpses: game.corpses.length,
      decals: game.level.decals.splats,
      fx: game.fx.length,
    }),
    levelInfo: () => ({
      index: game.levelIndex,
      count: LEVELS.length,
      name: game.level.name,
      width: game.level.width,
      spawn: game.level.spawnPoint,
      door: { x: game.level.door.x, y: game.level.door.y, w: game.level.door.w, h: game.level.door.h },
      enemyTypes: LEVELS[game.levelIndex].enemies.map((e) => e.type),
      hazards: game.level.hazards.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h })),
      solids: game.level.solids.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
      oneway: game.level.oneway.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
    }),
    lastError: () => deps.errors && deps.errors.length ? deps.errors[deps.errors.length - 1] : null,
    errors: () => (deps.errors || []).slice(0, 20),
    /** 只读：玩家内部状态（排查跳跃） */
    pstate: () => {
      const p = game.player;
      return { vy: Math.round(p.vy), y: Math.round(p.y * 10) / 10, grounded: p.grounded, coyote: Math.round(p.coyote * 1000) / 1000, jumpsLeft: p.jumpsLeft, jumpBuffer: Math.round(p.jumpBuffer * 1000) / 1000, dt: p.dt };
    },
    /** 只读：最近一次物理步里玩家各阶段的 vy / grounded（排查跳跃被吞） */
    playerTrace: () => JSON.parse(JSON.stringify(game.player.trace || [])),
    /** 只读：最近一次 moveBody 的内部数据（排查碰撞把向上移动吃掉） */
    moveDebug: () => JSON.parse(JSON.stringify(game.player._dbg || {})),
    /** 只读：玩家与最近敌人的动画相位（用于量化"动画是否也变慢"） */
    animPhases: () => {
      const e = game.enemies.find((x) => x.alive);
      return {
        player: Math.round((game.player.animT || 0) * 1000) / 1000,
        enemy: e ? Math.round((e.animT || 0) * 1000) / 1000 : null,
      };
    },
    cam: () => ({
      x: Math.round(game.camera.ix * 10) / 10,
      y: Math.round(game.camera.iy * 10) / 10,
      zoom: Math.round(game.camera.zoom * 1000) / 1000,
      view: game.camera.viewRect(),
      playerScreen: game.camera.worldToScreen(game.player.ix, game.player.iy),
    }),
    loop: () => ({
      stepsLastFrame: time.stepsLastFrame,
      dtReal: Math.round(time.dtReal * 10000) / 10000,
      acc: Math.round(time.acc * 10000) / 10000,
      alpha: Math.round(time.alpha * 1000) / 1000,
      worldScale: Math.round(time.worldScale * 1000) / 1000,
      playerScale: Math.round(time.playerScale * 1000) / 1000,
      hitstop: Math.round(time.hitstopLeft * 1000) / 1000,
      elapsedReal: Math.round(time.elapsedReal * 100) / 100,
    }),
  };

  function player() {
    return game.player;
  }

  // ---------- 有副作用 ----------
  const testApi = {
    /** 测试钩子：让 killPlayer 静默返回，用于"跑完整流程"的自动化验证 */
    noDeath: false,

    snapshot: () => game.snapshot(),
    levelInfo: () => gameApi.levelInfo(),

    teleport(x, y) {
      const p = player();
      p.x = x;
      p.y = y;
      p.vx = 0;
      p.vy = 0;
      p.px = x;
      p.py = y;
      // 传送是测试专用：镜头直接跟过去，否则鼠标瞄准会指向错误的世界坐标
      game.camera.snapTo(x, y - 40);
      return true;
    },

    setEnergy(v) {
      player().energy = Math.max(0, Math.min(T.energyMax, v));
      return player().energy;
    },

    /** 测试专用：把减缓状态锁定/N 秒满能量，保证采样期间缩放不会掉下来 */
    holdSlowForce(on) {
      game.slowForce = !!on;
      if (on) player().energy = T.energyMax;
      return game.slowForce;
    },

    /** 测试专用：直接用 g 指定世界缩放（x 为玩家/hitstop 用的"时间放慢系数"，1 表示与正常等长） */
    setSlowSlider(x) {
      game.slowSlider = Number(x) || 0;
      return game.slowSlider;
    },

    setNoDeath(on) {
      this.noDeath = on;
      game.noDeath = !!on;
      return game.noDeath;
    },

    /** 直接安排一次死亡（走完整死亡→重置流程） */
    killPlayer() {
      game.noDeath = false;
      game.killPlayer('test');
      return game.stats.deaths;
    },

    /** 用真实死亡路径清空全部敌人（验证开门/切关） */
    clearEnemies() {
      const before = game.enemies.length;
      while (game.enemies.length > 0) {
        const e = game.enemies[0];
        e.hurt(1, 600, -200, game);
      }
      return { before, after: game.enemies.length };
    },

    gotoLevel(i) {
      if (i < 0 || i >= LEVELS.length) return false;
      game.loadLevel(i);
      return true;
    },

    /** 压测：持续维持指定数量的敌人 / 子弹 / 粒子 */
    startStress(opts = {}) {
      this.stopStress();
      const cfg = {
        enemies: opts.enemies || 8,
        bullets: Math.min(opts.bullets || 48, T.maxBullets),
        particles: opts.particles || 600,
      };
      this.setNoDeath(true);
      const spawnExtra = () => {
        const idx = game.enemies.length;
        const lvl = game.level;
        const types = ['ronin', 'gunner', 'shield'];
        const type = types[idx % 3];
        const x = 240 + ((idx * 173) % Math.max(200, lvl.width - 400));
        const def = { type, x, y: lvl.def.floorY, patrol: [x - 40, x + 40] };
        game.enemies.push(createEnemy(game, def));
      };
      const tick = () => {
        if (!game.level) return;
        // 补子弹
        for (let i = 0; i < 24 && game.projectiles.count < cfg.bullets; i++) {
          const x = game.player.x + (Math.random() - 0.5) * 900;
          const y = game.player.y - 40 - Math.random() * 260;
          game.projectiles.spawnEnemyBullet(x, y, Math.random() * Math.PI * 2, 420);
        }
        // 补敌人
        for (let i = 0; i < 2 && game.enemies.length < cfg.enemies; i++) spawnExtra();
        // 补粒子
        if (game.particles.count < cfg.particles) {
          game.particles.bloodBurst(
            game.player.x + (Math.random() - 0.5) * 800,
            game.player.y - 80 - Math.random() * 200,
            0,
            0,
            18,
            300,
          );
        }
      };
      const timer = setInterval(tick, 16);
      tick();
      stress = { cfg, timer, startedAt: performance.now() };
      time.stats.reset();
      return cfg;
    },

    stopStress() {
      if (stress) {
        clearInterval(stress.timer);
        stress = null;
      }
      this.setNoDeath(false);
      // 清掉加压产生的子弹与敌人
      game.projectiles.reset();
      return true;
    },

    stressActive: () => !!stress,

    /** 把相机强行移动（截图用） */
    setCamera(x, y) {
      game.camera.snapTo(x, y);
      return true;
    },

    /** 让玩家原地不动（截图/测量性能时用） */
    freezePlayer(on) {
      game.player.frozen = !!on;
      return true;
    },

    memory() {
      const m = performance.memory;
      return m
        ? {
            used: m.usedJSHeapSize,
            total: m.totalJSHeapSize,
            limit: m.jsHeapSizeLimit,
          }
        : null;
    },

    framePercentiles: () => time.stats.percentiles(),
    recentFps: (n) => time.stats.recentFps(n || 120),

    /** 让一帧时间变得很长，验证 FPS 显示是真实值而不是写死的 */
    resetFrameStats() {
      time.stats.reset();
      return true;
    },

    setBackdropEnabled(on) {
      game.backdropEnabled = !!on;
      return true;
    },

    /** 直接推进能量（测试"能量耗尽后锁定"） */
    drainEnergy() {
      player().energy = 0;
      return true;
    },

    /** 在指定位置放一个可拾取道具（拾取系统已移除，保留为空实现） */
    spawnPickup(type, x, y) {
      return null;
    },

    /** 把所有可拾取道具清掉（旧接口保留为空实现，拾取系统已移除） */
    clearPickups() {
      return true;
    },

    /** 直接发起一次挥刀（用来单独验证"反弹"这类规则，绕开键鼠时序） */
    attack(angleRad) {
      const p = game.player;
      if (typeof angleRad === 'number') p.lastAttackSource = 'key';
      p._startSlash(game);
      if (typeof angleRad === 'number') p.slashAngle = angleRad;
      return true;
    },

    /** 伤害/击杀统计快照 */
    /** 分段测绘制耗时（毫秒/次），用来定位瓶颈 */
    profileDraw(n = 20) {
      const ctx = game.renderer.begin();
      const view = game.camera.viewRect();
      const t = (fn) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        return Math.round(((performance.now() - t0) / n) * 1000) / 1000;
      };
      const out = {};
      out.backdrop = t(() => {
        ctx.save();
        ctx.globalAlpha = 0.72;
        game.backdrop.draw(ctx, view, 0, { slow: 0, flash: 0 });
        ctx.restore();
      });
      ctx.save();
      game.camera.applyTransform(ctx);
      out.staticLayer = t(() => game.level.drawStatic(ctx, view));
      out.enemies = t(() => {
        for (const e of game.enemies) if (e.alive) e.draw(ctx, game);
      });
      out.projectiles = t(() => game.projectiles.draw(ctx, 0, () => true));
      out.particles = t(() => game.particles.draw(ctx, () => true));
      out.player = t(() => game.player.draw(ctx, 1, game));
      ctx.restore();
      out.hud = t(() => game.drawHud(ctx));
      out.vignette = t(() => game.renderer.finish(0, 0));
      out.enemyCount = game.enemies.length;
      out.bulletCount = game.projectiles.count;
      out.particleCount = game.particles.count;
      return out;
    },

    stats: () => ({ ...game.stats }),

    /** 所有在飞子弹（用于"反弹"断言） */
    bullets: () => game.projectiles.list(),

    /** 造一颗朝指定方向飞的敌人子弹（验证反弹/图形时用） */
    spawnBulletAt(x, y, angle, speed = 300) {
      const b = game.projectiles.spawnEnemyBullet(x, y, angle, speed);
      return !!b;
    },

    /** 造一个指定类型的敌人（验证护盾/枪手行为时用） */
    spawnEnemy(type, x, y) {
      const def = { type, x, y, patrol: [x - 30, x + 30] };
      const e = createEnemy(game, def);
      game.enemies.push(e);
      return { type: e.type, x: e.x, y: e.y };
    },

    /** 触发一次爆炸（验证手雷范围击杀） */
    explode(x, y) {
      game.shockwave(x, y, T.grenadeRadius);
      for (const e of game.enemies.slice()) {
        const cy = e.y - e.h * 0.5;
        if (Math.hypot(e.x - x, cy - y) < T.grenadeRadius) e.hurt(3, 400, -200, game);
      }
      return true;
    },
  };

  game.noDeath = false;
  window.__GAME__ = gameApi;
  window.__TEST__ = testApi;
  return { gameApi, testApi };
}
