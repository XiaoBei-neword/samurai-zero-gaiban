import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    await frame();
    return { dbg: window.__GAME__.snapshot().player.dbg || null, p: window.__GAME__.snapshot().player };
  })()`);
  // 直接读内部：通过 debug 钩子暴露
  const r2 = await page.eval(`(() => {
    const g = window.__GAME__;
    return { has: true };
  })()`);
  console.log(JSON.stringify(r.p));
} finally { await api.close(); }
