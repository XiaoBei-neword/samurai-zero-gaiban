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
    const out = [];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    for (let i = 0; i < 5; i++) {
      await frame();
      out.push({ i, err: window.__GAME__.errors().slice(-1)[0] || '' });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return out;
  })()`);
  console.log(JSON.stringify(r, null, 1).slice(0, 2000));
} finally { await api.close(); }
