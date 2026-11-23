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
    for (let i = 0; i < 6; i++) {
      await frame();
      const s = window.__GAME__.snapshot();
      out.push({ i, jumpCount: s.player.jumpCount, y: Math.round(s.player.y), vy: Math.round(s.player.vy), state: s.state, grounded: s.player.grounded, loopErr: window.__GAME__.errors().slice(0,2) });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return out;
  })()`);
  console.log(JSON.stringify(r, null, 1));
  const boot = await page.eval('window.__BOOT__.errors');
  console.log('BOOT errors:', JSON.stringify(boot));
} finally { await api.close(); }
