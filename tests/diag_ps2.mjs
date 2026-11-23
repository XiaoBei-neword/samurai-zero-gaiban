import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const a = window.__GAME__.pstate();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    const rows = [];
    for (let i = 0; i < 12; i++) { await frame(); rows.push(window.__GAME__.pstate()); }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    return { a, rows };
  })()`);
  console.log('before', JSON.stringify(r.a));
  for (const row of r.rows) console.log(JSON.stringify(row));
} finally { await api.close(); }
