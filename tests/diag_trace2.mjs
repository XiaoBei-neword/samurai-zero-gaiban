import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(400);
  await page.eval('window.__TEST__.clearEnemies()');
  await page.eval('window.__TEST__.teleport(200,620)');
  await sleep(300);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    await frame();
    const p = window.__GAME__.snapshot().player;
    return { dbg: window.__GAME__.dbg ? window.__GAME__.dbg() : null, vy: p.vy, y: p.y, jc: p.jumpCount, trace: window.__GAME__.playerTrace() };
  })()`);
  console.log(JSON.stringify(r));
} finally { await api.close(); }
