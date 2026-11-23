import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const out = [];
    out.push(['before', window.__GAME__.pstate()]);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    for (let i = 0; i < 3; i++) { await frame(); out.push(['f' + i, window.__GAME__.pstate()]); }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return out;
  })()`);
  for (const [k, v] of r) console.log(k, JSON.stringify(v));
} finally { await api.close(); }
