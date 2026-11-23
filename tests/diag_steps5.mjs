import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);   // 让游戏稳定
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const s0 = window.__GAME__.snapshot();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    for (let i = 0; i < 10; i++) await frame();
    const s1 = window.__GAME__.snapshot();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return { level: s0.level, state0: s0.state, spawn: [s0.player.x, s0.player.y], state1: s1.state, y: s1.player.y, vy: s1.player.vy, jc: s1.player.jumpCount };
  })()`);
  console.log(JSON.stringify(r));
} finally { await api.close(); }
