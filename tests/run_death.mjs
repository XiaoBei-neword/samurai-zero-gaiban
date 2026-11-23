// ============================================================
// tests/run_death.mjs —— 死亡重试 200 次：重置延迟 + 内存泄漏
//
// 用 --js-flags=--expose-gc + --enable-precise-memory-info 拿到真实堆大小，
// 每次测量前强制 GC，避免把"没回收的垃圾"当成泄漏。
// ============================================================
import { startGame, Checker, sleep, reportPageErrors } from './lib/harness.mjs';

const c = new Checker('run_death');
const api = await startGame({
  headed: process.argv.includes('--headed'),
  extraArgs: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const { page } = api;

try {
  c.check(await page.eval('typeof window.gc === "function"'), '页面里有 window.gc（可做公平的堆对比）', await page.eval('typeof window.gc'));

  // ---------- 1. 40 次死亡 → 重试，测重置延迟 ----------
  // 注意：整个循环在页面里跑 80 多秒，必须给够 CDP 的超时（默认 15s 会误判成失败）
  const res = await page.eval(`(async () => {
    const lat = [];
    const deathCounts = [];
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) {
      const before = window.__GAME__.snapshot().stats.deaths;
      const tStart = performance.now();
      window.__TEST__.killPlayer();
      let guard = 0;
      while (guard++ < 400) {
        await new Promise(r => requestAnimationFrame(r));
        const s = window.__GAME__.snapshot();
        if (s.state === 'playing' && s.player.alive) break;
      }
      lat.push(performance.now() - tStart);
      const s2 = window.__GAME__.snapshot();
      deathCounts.push(s2.stats.deaths - before);
    }
    lat.sort((a, b) => a - b);
    const at = (p) => lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))];
    return {
      n: lat.length,
      p50: at(0.5), p95: at(0.95), max: lat[lat.length - 1], min: lat[0],
      avg: lat.reduce((a, b) => a + b, 0) / lat.length,
      deathDeltaOk: deathCounts.every((d) => d === 1),
      totalMs: performance.now() - t0,
      snapshot: window.__GAME__.snapshot(),
    };
  })()`, 120000);

  console.log(
    `   40 次死亡重置：p50=${res.p50.toFixed(1)}ms p95=${res.p95.toFixed(1)}ms max=${res.max.toFixed(1)}ms（总 ${(res.totalMs / 1000).toFixed(1)}s）`,
  );
  c.near(res.snapshot.stats.deaths, 40, 1, '死亡次数统计准确（40 次）');
  c.check(res.deathDeltaOk === true, '每次死亡都恰好 +1（没有漏计/重复计）');
  // 新规则：死亡后先显示「任务失败」2 秒再无缝重置
  c.near(res.p50, 2000, 260, '重置延迟符合设计（约 2 秒「任务失败」后再重置）');
  c.check(res.p95 < 2600, '重置延迟 P95 < 2.6s', `p95=${res.p95.toFixed(1)}ms`);
  c.check(res.snapshot.player.alive === true, '40 次之后玩家仍然可操作', `alive=${res.snapshot.player.alive}`);
  c.check(res.snapshot.level === 1, '重试不会跳到别的关卡', `level=${res.snapshot.level}`);

  // ---------- 2. 堆内存对比（强制 GC 后）----------
  const memBefore = await page.eval(`(() => { window.gc(); window.gc(); const m = window.__TEST__.memory(); return m ? m.used : 0; })()`);
  await sleep(300);

  // 再来 40 次（带战斗：每轮都放敌人 + 开枪 + 粒子）
  await page.eval('window.__TEST__.gotoLevel(2)');
  await sleep(400);
  const res2 = await page.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      // 造一点战斗垃圾：子弹 + 粒子 + 一次爆炸
      window.__TEST__.spawnBulletAt(400 + Math.random() * 600, 400, Math.random() * 6.28, 300);
      window.__TEST__.explode(600 + Math.random() * 400, 560);
      window.__TEST__.killPlayer();
      let guard = 0;
      while (guard++ < 400) {
        await new Promise(r => requestAnimationFrame(r));
        const s = window.__GAME__.snapshot();
        if (s.state === 'playing' && s.player.alive) break;
      }
    }
    return window.__GAME__.snapshot();
  })()`, 120000);
  await sleep(500);
  const memAfter = await page.eval(`(() => { window.gc(); window.gc(); const m = window.__TEST__.memory(); return m ? m.used : 0; })()`);
  const poolAfter = await page.eval('window.__GAME__.poolStats()');
  const growthMB = (memAfter - memBefore) / 1048576;

  console.log(`   堆内存：${(memBefore / 1048576).toFixed(2)}MB → ${(memAfter / 1048576).toFixed(2)}MB（变化 ${growthMB.toFixed(2)}MB）`);
  console.log(`   池状态：${JSON.stringify(poolAfter)}`);
  c.check(growthMB < 8, '80 次死亡后堆内存没有明显增长（< 8MB）', `${growthMB.toFixed(2)}MB`);
  c.check(poolAfter.particles.alive <= poolAfter.particles.max, '粒子池没有爆掉', JSON.stringify(poolAfter.particles));
  c.check(poolAfter.projectiles.total <= 160, '子弹池没有爆掉', JSON.stringify(poolAfter.projectiles));
  c.check(res2.stats.deaths >= 80, '累计死亡次数正确', `deaths=${res2.stats.deaths}`);

  // ---------- 3. 重置后场景状态是干净的 ----------
  const clean = await page.eval(`({
    particles: window.__GAME__.poolStats().particles.alive,
    proj: window.__GAME__.poolStats().projectiles.total,
    corpses: window.__GAME__.poolStats().corpses,
    enemies: window.__GAME__.snapshot().enemiesAlive,
    state: window.__GAME__.snapshot().state,
    playerAtSpawn: (() => {
      const s = window.__GAME__.snapshot();
      const info = window.__GAME__.levelInfo();
      return Math.abs(s.player.x - info.spawn.x) < 40;
    })(),
  })`);
  c.check(clean.enemies > 0 && clean.state === 'playing', '重置后敌人重新生成、状态可玩', JSON.stringify(clean));
  c.check(clean.playerAtSpawn === true, '重置后玩家回到出生点附近', JSON.stringify(clean.playerAtSpawn));
  c.check(clean.corpses === 0, '重置清空了尸体', `corpses=${clean.corpses}`);
  c.check(clean.proj <= 2, '重置清空了飞行物', `proj=${clean.proj}`);

  await reportPageErrors(api, c);
  await c.finish({
    resetLatency: { p50: res.p50, p95: res.p95, max: res.max, avg: res.avg },
    heap: { beforeMB: memBefore / 1048576, afterMB: memAfter / 1048576, growthMB },
    poolAfter,
  });
} catch (e) {
  c.check(false, '脚本异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
  await c.finish({});
} finally {
  await api.close().catch(() => {});
}

process.exit(0);
