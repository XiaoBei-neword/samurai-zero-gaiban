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
      out.push({ i, jc: s.player.jumpCount, y: +s.player.y.toFixed(1), vy: s.player.vy, g: s.player.grounded, st: s.player.state, lc: s.player.doubleJumpCount });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return out;
  })()`);
  console.log(JSON.stringify(r));
} finally { await api.close(); }
