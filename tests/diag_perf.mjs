// ============================================================
// tests/diag_perf.mjs —— 诊断：浏览器里的真实帧率 / 每帧步数 / 输入延迟
// 用于搞清楚 headless 模式下 rAF 到底跑多快。
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const extra = process.argv.slice(2);

const api = await startGame({ headed: extra.includes('--headed'), extraArgs: extra.filter((a) => a.startsWith('--')) });
const { page } = api;

try {
  const env = await page.eval(`({
    dpr: window.devicePixelRatio,
    innerW: window.innerWidth, innerH: window.innerHeight,
    canvasCss: (() => { const r = document.getElementById('game').getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top)}; })(),
    visibility: document.visibilityState,
  })`);
  console.log('环境:', JSON.stringify(env));

  await sleep(2500);
  console.log('静态 2.5s 后:', JSON.stringify(await page.eval('window.__GAME__.frameStats()')));

  // 测量按住 D 键 1 秒的实际位移
  const x0 = (await api.snapshot()).player.x;
  await page.keyDown('KeyD');
  const t0 = Date.now();
  await sleep(1000);
  const s1 = await api.snapshot();
  await page.keyUp('KeyD');
  console.log(
    `按住 D ${Date.now() - t0}ms：x ${x0} → ${s1.player.x}（位移 ${(s1.player.x - x0).toFixed(1)}px），vx=${s1.player.vx}`,
  );
  console.log('帧统计:', JSON.stringify(await page.eval('window.__GAME__.frameStats()')));

  // 每帧固定步数（正常应该是 2 左右：120Hz 物理 / 60fps 画面）
  const steps = await page.eval(`(() => {
     const t = window.__DIAG_TIME__;
     return null;
  })()`);

  // 输入延迟：按下后多久 vx 开始变化
  await sleep(300);
  const lat = [];
  for (let i = 0; i < 5; i++) {
    await page.keyDown('KeyD');
    const t1 = Date.now();
    for (let k = 0; k < 40; k++) {
      const s = await api.snapshot();
      if (s.player.vx > 20) break;
      await sleep(5);
    }
    lat.push(Date.now() - t1);
    await page.keyUp('KeyD');
    await sleep(400);
  }
  console.log('输入→速度变化的观测延迟(ms):', JSON.stringify(lat));

  // 计时器精度：100ms 内实际推进了多少游戏时间
  const before = (await api.snapshot()).stats.runTime;
  await sleep(1000);
  const after = (await api.snapshot()).stats.runTime;
  console.log(`1s 真实时间推进的游戏时间: ${(after - before).toFixed(3)}s`);
} finally {
  await api.close();
}
