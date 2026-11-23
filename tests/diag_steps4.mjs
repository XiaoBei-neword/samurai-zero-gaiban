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
    // 在页面里包一层 moveBody 观察：用事件先禁用键盘，仅记录 y/vy 每个 requestAnimationFrame
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    const rows = [];
    for (let f = 0; f < 3; f++) {
      await frame();
      const p = window.__GAME__.snapshot().player;
      rows.push({ f, y: +p.y.toFixed(1), vy: p.vy, g: p.grounded, st: p.state, jc: p.jumpCount });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return rows;
  })()`);
  console.log(JSON.stringify(r));
} finally { await api.close(); }
