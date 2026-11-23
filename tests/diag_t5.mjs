import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    for (let i = 0; i < 3; i++) await frame();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return [window.__GAME__.lastTrace(), window.__GAME__.lastTrace2()];
  })()`);
  console.log('T1:', r[0].slice(-500));
  console.log('T2:', r[1].slice(-300));
} finally { await api.close(); }
