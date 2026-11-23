// ============================================================
// tests/diag_fall.mjs —— 数值诊断：子弹时间下玩家的"下落速度"
//   在固定地图坐标的空域里自由落体，量**相同真实时间窗口内下落的像素数**，
//   同时记录起跳最高点与下落轨迹，验证"轨迹形状不变、只是变慢"。
// ============================================================
import { startGame } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

const run = async (label, on) => {
  const r = await page.eval(
    `(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const ON = ${on};
      window.__TEST__.setSlowSlider(0);
      window.__TEST__.holdSlowForce(false);
      window.__TEST__.gotoLevel(0);
      for (let i = 0; i < 10; i++) await frame();
      window.__TEST__.clearEnemies();
      window.__TEST__.teleport(200, 620);          // 平地起跳，头顶无平台
      for (let i = 0; i < 6; i++) await frame();
      if (ON) {
        window.__TEST__.holdSlowForce(true);
        for (let i = 0; i < 20; i++) await frame();
      }
      // ---- 1. 起跳，记录最高点 / 上升耗时 / 峰值上升速度 ----
      const p0 = window.__GAME__.snapshot().player;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
      let minY = p0.y, v0 = 0;
      const tJump = performance.now();
      for (let i = 0; i < 400; i++) {
        await frame();
        const p = window.__GAME__.snapshot().player;
        if (p.y < minY) minY = p.y;
        if (-p.vy > v0) v0 = -p.vy;
        if (i > 2 && p.vy > -60) break; // 快到最高点
      }
      const riseMs = Math.round(performance.now() - tJump);
      const apexY = window.__GAME__.snapshot().player.y;
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));

      // ---- 2. 从最高点开始，量 300ms 真实时间下落了多少像素 ----
      const yA = window.__GAME__.snapshot().player.y;
      const tA = performance.now();
      while (performance.now() - tA < 300) await frame();
      const yB = window.__GAME__.snapshot().player.y;
      const fall300 = Math.round(yB - yA);
      for (let i = 0; i < 400; i++) {
        const p = window.__GAME__.snapshot().player;
        if (p.grounded) break;
        await frame();
      }
      const sc = window.__GAME__.timeScales();
      window.__TEST__.holdSlowForce(false);
      return {
        jumpHeight: Math.round(p0.y - minY),
        riseMs,
        vJump: Math.round(v0),
        apexY: Math.round(apexY),
        fall300,
        world: +sc.world.toFixed(3),
        player: +sc.player.toFixed(3),
      };
    })()`,
    60000,
  );
  console.log(`[${label}] ` + JSON.stringify(r));
  return r;
};

try {
  const a = await run('正常   ', false);
  const b = await run('子弹时间', true);
  console.log('');
  console.log(`跳跃高度：正常 ${a.jumpHeight}px vs 子弹时间 ${b.jumpHeight}px  → 比值 ${(b.jumpHeight / a.jumpHeight).toFixed(3)}（应≈1.00）`);
  console.log(`上升耗时：正常 ${a.riseMs}ms vs 子弹时间 ${b.riseMs}ms  → 比值 ${(b.riseMs / a.riseMs).toFixed(2)}（应≈1.67）`);
  console.log(`起跳初速：正常 ${a.vJump} vs 子弹时间 ${b.vJump}（应相同）`);
  console.log(`300ms 内下落：正常 ${a.fall300}px vs 子弹时间 ${b.fall300}px  → 比值 ${(b.fall300 / Math.max(a.fall300, 1)).toFixed(2)}（应明显 < 1，即下落变慢）`);
} finally {
  await api.close();
}
