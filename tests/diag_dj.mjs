import { startGame, sleep } from './lib/harness.mjs';
const api = await startGame({});
const { page } = api;
try {
  await sleep(1500);
  const r = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const k = (d) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    const log = [];
    const st = () => { const p = window.__GAME__.snapshot().player; return { y: Math.round(p.y), vy: Math.round(p.vy), g: p.grounded, jl: p.jumpsLeft, jc: p.jumpCount, djc: p.doubleJumpCount }; };
    k(true);
    for (let i = 0; i < 20; i++) { await frame(); if (i % 4 === 0) log.push(['up', st()]); }
    k(false);
    for (let i = 0; i < 5; i++) await frame();
    log.push(['released', st()]);
    k(true);
    for (let i = 0; i < 10; i++) { await frame(); if (i % 3 === 0) log.push(['2nd', st()]); }
    k(false);
    return log;
  })()`);
  for (const [tag, s] of r) console.log(tag, JSON.stringify(s));
} finally { await api.close(); }
