import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await page.eval("window.__TEST__.gotoLevel(0)");
  await sleep(300);
  await page.eval("window.__TEST__.startStress({enemies:16, bullets:160, particles:1500})");
  await sleep(2500);
  const p = await page.eval("window.__TEST__.profileDraw(20)");
  console.log("16 敌人分段耗时(ms):", JSON.stringify(p, null, 0));
  const s = await page.eval("window.__GAME__.frameStats()");
  console.log("fps:", s.recentFps.toFixed(1), "p50:", s.p50ms, "p95:", s.p95ms);
  await page.eval("window.__TEST__.startStress({enemies:3, bullets:0, particles:300})");
  await sleep(2000);
  console.log("3 敌人分段耗时(ms):", JSON.stringify(await page.eval("window.__TEST__.profileDraw(20)")));
} finally { await api.close(); }
