// ============================================================
// tests/diag_dash.mjs —— 诊断：冲刺无敌 vs 子弹
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

try {
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(400);
  await page.eval('window.__TEST__.clearEnemies()');
  await page.eval('window.__TEST__.teleport(600, 620)');
  await sleep(300);

  // 在页面里做一次受控实验：起跳 → 冲刺 → 无敌帧中段生成贴脸子弹，逐帧记录
  const r = await page.eval(`(async () => {
    const log = [];
    const T0 = window.__GAME__.snapshot();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    await new Promise((r) => setTimeout(r, 180));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const s1 = window.__GAME__.snapshot();
    window.__TEST__.spawnBulletAt(s1.player.x + 4, s1.player.y - 26, Math.PI, 1600);
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = window.__GAME__.snapshot();
      log.push({
        i,
        state: s.state,
        alive: s.player.alive,
        x: s.player.x,
        y: s.player.y,
        grounded: s.player.grounded,
        dashT: s.player.dashT,
        invuln: s.player.invulnT,
        deaths: s.stats.deaths,
        cause: s.deathCause,
        bullets: s.bullets.total,
      });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    return log;
  })()`);
  for (const row of r) console.log(JSON.stringify(row));
} finally {
  await api.close();
}
