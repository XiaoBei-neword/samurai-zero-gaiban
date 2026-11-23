// ============================================================
// tests/diag_jump.mjs —— 数值诊断：子弹时间下的跳跃高度 / 上升时长 / 下落速度
//   同时输出"时间放慢系数 s = playerScale / worldScale"，用来判断
//   "_ts 错误系数" 是否还在（s=1 才是自洽的）
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

const run = async (label, slider) => {
  const r = await page.eval(
    `(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const key = (code, down) =>
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: 'x', bubbles: true }));
      const SLIDER = ${slider};
      // 用测试钩子按滑块值锁住缩放（模拟玩家按住减速）
      window.__TEST__.holdSlowForce(false);
      window.__TEST__.gotoLevel(0);
      for (let i = 0; i < 8; i++) await frame();
      window.__TEST__.clearEnemies();
      window.__TEST__.teleport(200, 620);   // 平地，头顶无平台
      for (let i = 0; i < 10; i++) await frame();
      if (SLIDER > 0) {
        window.__TEST__.setSlowSlider(SLIDER);
        window.__TEST__.holdSlowForce(true);
        for (let i = 0; i < 20; i++) await frame();
      }
      const sc = window.__GAME__.timeScales();
      const y0 = window.__GAME__.snapshot().player.y;
      // 起跳并一直按住，记录最高点与上升耗时
      key('KeyW', true);
      let minY = y0;
      let upT = 0;
      let apexFrames = -1;
      for (let f = 0; f < 400; f++) {
        await frame();
        const p = window.__GAME__.snapshot().player;
        if (p.y < minY) minY = p.y;
        if (apexFrames < 0 && f > 2 && p.vy > -1 && p.vy < 30) apexFrames = f;
        if (f > 4 && p.grounded) break;
      }
      key('KeyW', false);
      // 再测一次下落速度：从高处自由落体
      window.__TEST__.teleport(200, 250);
      for (let i = 0; i < 6; i++) await frame();
      const yA = window.__GAME__.snapshot().player.y;
      const vA = window.__GAME__.snapshot().player.vy;
      for (let i = 0; i < 20; i++) await frame();
      const yB = window.__GAME__.snapshot().player.y;
      const vB = window.__GAME__.snapshot().player.vy;
      window.__TEST__.holdSlowForce(false);
      window.__TEST__.setSlowSlider(0);
      return {
        scales: sc,
        sRatio: sc.playerScale / Math.max(sc.worldScale, 1e-4),
        jumpHeight: Math.round((y0 - minY) * 10) / 10,
        apexFrames,
        fallPer20f: Math.round((yB - yA) * 10) / 10,
        fallV0: Math.round(vA),
        fallV1: Math.round(vB),
      };
    })()`,
    60000,
  );
  console.log(`[${label}] ` + JSON.stringify(r));
  return r;
};

try {
  const normal = await run('正常', 0);
  const slow = await run('减速0.6', 1);
  console.log(
    JSON.stringify(
      {
        jumpRatio: (slow.jumpHeight / normal.jumpHeight).toFixed(3),
        apexFramesRatio: (slow.apexFrames / normal.apexFrames).toFixed(3),
        fallRatio: (slow.fallPer20f / normal.fallPer20f).toFixed(3),
        slider: slow.scales,
      },
      null,
      2,
    ),
  );
} finally {
  await api.close();
}
