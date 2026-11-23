// ============================================================
// tests/diag_gravity.mjs —— 诊断：子弹时间对"玩家下落"的影响
//   比较正常 / 子弹时间两种状态下，玩家自由落体时每帧的 y 位移与 vy 增长
// ============================================================
import { startGame } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

try {
  const r = await page.eval(
    `(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      async function drop(force) {
        window.__TEST__.holdSlowForce(false);
        window.__TEST__.gotoLevel(0);
        for (let i = 0; i < 8; i++) await frame();
        window.__TEST__.clearEnemies();
        if (force) { window.__TEST__.holdSlowForce(true); for (let i = 0; i < 16; i++) await frame(); }
        // 抬到高处（平台 B 上方），然后自由落体
        window.__TEST__.teleport(700, 200);
        for (let i = 0; i < 3; i++) await frame();
        const dy = [], dvy = [];
        let prev = window.__GAME__.snapshot().player;
        for (let f = 0; f < 20; f++) {
          await frame();
          const p = window.__GAME__.snapshot().player;
          dy.push(p.y - prev.y);
          dvy.push(p.vy - prev.vy);
          prev = p;
        }
        window.__TEST__.holdSlowForce(false);
        const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        return { scales: window.__GAME__.timeScales(), dy: avg(dy), dvy: avg(dvy) };
      }
      return { normal: await drop(false), slow: await drop(true) };
    })()`,
    60000,
  );
  const n = r.normal;
  const s = r.slow;
  console.log(
    JSON.stringify(
      {
        normal: n,
        slow: s,
        ratio: { dy: s.dy / n.dy, dvy: s.dvy / n.dvy, playerScale: s.scales.player },
      },
      null,
      2,
    ),
  );
} finally {
  await api.close();
}
