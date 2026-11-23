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
    for (let i = 0; i < 4; i++) {
      await frame();
      const g = window.__GAME__;
      out.push({ i, steps: g.loop(), u: window.__GAME__.snapshot().player });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return out;
  })()`);
  for (const o of r) console.log(o.i, 'steps=', o.steps && o.steps.stepsLastFrame, 'dtReal=', o.steps && o.steps.dtReal, 'vy=', o.u.vy, 'y=', o.u.y, 'grounded=', o.u.grounded);
} finally { await api.close(); }
