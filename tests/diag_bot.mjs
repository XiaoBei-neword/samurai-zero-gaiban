// ============================================================
// tests/diag_bot.mjs —— 看机器人到底卡在哪
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

const line = async (tag) => {
  const s = await api.snapshot();
  const keyState = await page.eval('window.__BOT__ ? Array.from(window.__BOT_KEYS__ || []) : []');
  console.log(
    `[${tag}] lvl=${s.level} p=(${s.player.x.toFixed(0)},${s.player.y.toFixed(0)}) vx=${s.player.vx.toFixed(0)} vy=${s.player.vy.toFixed(0)}` +
      ` grounded=${s.player.grounded} state=${s.player.state} kills=${s.stats.kills} deaths=${s.stats.deaths}` +
      `\n        enemies=[${s.enemies.map((e) => `${e.type}@${e.x},${e.y}:${e.state}`).join(' ')}] bullets=${s.bullets.total}`,
  );
};

try {
  await page.eval(`import('/tests/lib/bot.js').then(m => { window.__BOT__ = m.startBot({ maxMs: 60000 }); return true; })`);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    await line(`t+${i + 1}s`);
    const s = await api.snapshot();
    if (s.state === 'victory' || s.level > 1) break;
  }
  const rep = await page.eval('window.__BOT__.report()');
  console.log('events:', JSON.stringify(rep.log));
} finally {
  await api.close();
}
