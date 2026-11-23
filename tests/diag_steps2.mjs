import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(400);
  await page.eval('window.__TEST__.clearEnemies()');
  await page.eval('window.__TEST__.teleport(200,620)');
  await sleep(300);
  const r = await page.eval(`(() => {
    // 用一个循环计数器挂到 player 上，检查 update 是否真的在执行到跳跃分支
    const g = window.__GAME__.snapshot();
    return { hasGame: !!window.__GAME__, playerState: g.player.state, alive: g.player.alive };
  })()`);
  const r2 = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    const samples = [];
    for (let i = 0; i < 3; i++) {
      await frame();
      const s = window.__GAME__.loop();
      samples.push({ steps: s.stepsLastFrame, err: window.__GAME__.errors().slice(-1) });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return samples;
  })()`);
  console.log(JSON.stringify(r), JSON.stringify(r2));
  console.log('last error:', JSON.stringify(await page.eval('window.__GAME__.errors()')));
} finally { await api.close(); }
