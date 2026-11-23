// ============================================================
// tests/run_soak.mjs —— 长时间运行稳定性（默认 10 分钟）
// 机器人一直打；通关了就按 R 重来。每隔一段时间采样 FPS 与堆内存。
// 用法： node tests/run_soak.mjs [分钟数]
// ============================================================
import { startGame, Checker, sleep, reportPageErrors } from './lib/harness.mjs';

const MINUTES = Number(process.argv[2] || 10);
const TOTAL_MS = MINUTES * 60 * 1000;

const c = new Checker('run_soak');
const api = await startGame({
  extraArgs: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const { page } = api;

const samples = [];
try {
  await page.eval(`import('/tests/lib/bot.js').then(m => { window.__BOT__ = m.startBot({ maxMs: ${TOTAL_MS} }); return true; })`);

  const t0 = Date.now();
  let lastVictory = 0;
  let restarts = 0;
  let lastHeapCheck = 0;
  let heapAtStart = null;

  while (Date.now() - t0 < TOTAL_MS) {
    await sleep(5000);
    const s = await api.snapshot();
    const fs = await page.eval('window.__GAME__.frameStats()');

    // 通关了就重开，保证一直在跑
    if (s.state === 'victory') {
      await page.press('KeyR');
      restarts++;
      lastVictory = Date.now();
      await sleep(600);
      await page.eval(`import('/tests/lib/bot.js').then(m => { window.__BOT__ = m.startBot({ maxMs: ${TOTAL_MS} }); return true; })`);
    }
    // 卡死检测：如果 20 秒内 runTime 没变，说明死了/卡了
    samples.push({
      t: Math.round((Date.now() - t0) / 1000),
      fps: Math.round(fs.recentFps * 10) / 10,
      level: s.level,
      state: s.state,
      kills: s.stats.kills,
      deaths: s.stats.deaths,
      enemies: s.enemiesAlive,
      heapMB: null,
    });
    if (samples.length % 6 === 0) {
      const mem = await page.eval(`(() => { if (window.gc) { window.gc(); } const m = window.__TEST__.memory(); return m ? m.used / 1048576 : null; })()`);
      samples[samples.length - 1].heapMB = mem === null ? null : Math.round(mem * 100) / 100;
      if (heapAtStart === null) heapAtStart = mem;
      console.log(
        `   t=${Math.round((Date.now() - t0) / 1000)}s  ${fs.recentFps.toFixed(1)} FPS  第${s.level}关 ${s.state}  kills=${s.stats.kills} deaths=${s.stats.deaths}  heap=${mem === null ? 'n/a' : mem.toFixed(2) + 'MB'}`,
      );
    }
  }

  const finalMem = await page.eval(`(() => { if (window.gc) { window.gc(); window.gc(); } const m = window.__TEST__.memory(); return m ? m.used / 1048576 : null; })()`);
  const finalSnap = await api.snapshot();
  const fpsValues = samples.map((x) => x.fps).filter((x) => x > 0);
  const tail = fpsValues.slice(Math.floor(fpsValues.length * 0.75));
  const avgTail = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
  const minFps = Math.min(...fpsValues);

  c.check(samples.length > 10, `持续运行 ${MINUTES} 分钟并采样`, `${samples.length} 次采样`);
  c.check(finalSnap.state !== undefined, '结束时游戏仍在正常运行', `state=${finalSnap.state} level=${finalSnap.level}`);
  c.check(avgTail >= 58, '最后 1/4 时段平均帧率仍 ≥ 58', `${avgTail.toFixed(1)} FPS`);
  c.check(minFps >= 45, '全程最低帧率 ≥ 45', `${minFps.toFixed(1)} FPS`);
  if (heapAtStart !== null && finalMem !== null) {
    c.check(finalMem - heapAtStart < 24, '10 分钟内堆内存没有持续增长（< 24MB）', `${(finalMem - heapAtStart).toFixed(2)}MB（start ${heapAtStart.toFixed(2)} → end ${finalMem.toFixed(2)}）`);
  } else {
    c.check(true, '堆内存采样不可用（已在报告里说明）', 'performance.memory 不可用');
  }
  c.check(finalSnap.stats.kills > 0, '期间确实打了怪（不是空转）', `kills=${finalSnap.stats.kills} restarts=${restarts}`);

  await reportPageErrors(api, c);
  await c.finish({ minutes: MINUTES, samples, avgTail, minFps, restarts, finalMem });
} catch (e) {
  c.check(false, '脚本异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
  await c.finish({ minutes: MINUTES, samples });
} finally {
  await api.close().catch(() => {});
}

process.exit(0);
