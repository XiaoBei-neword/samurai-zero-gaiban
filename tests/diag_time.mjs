// ============================================================
// tests/diag_time.mjs —— 诊断/量化：子弹时间里各实体的真实速率
//   对比"正常"与"子弹时间"两种情况下，每帧的：
//     玩家位移、玩家动画相位、敌人位移、敌人动画相位、子弹位移
// ============================================================
import { startGame } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;

try {
  const r = await page.eval(
    `(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const key = (code, down) =>
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: 'x', bubbles: true }));

      async function sample(force) {
        window.__TEST__.holdSlowForce(false);
        window.__TEST__.gotoLevel(0);
        for (let i = 0; i < 8; i++) await frame();
        window.__TEST__.clearEnemies();
        // 站在 200 号位（平地，不会撞到任何平台），然后一直朝右跑
        window.__TEST__.teleport(200, 620);
        window.__TEST__.spawnEnemy('ronin', 1600, 620);
        for (let i = 0; i < 6; i++) await frame();
        const p0 = window.__GAME__.snapshot().player;
        for (let i = 0; i < 3; i++) window.__TEST__.spawnBulletAt(p0.x + 420, p0.y - 140, Math.PI, 200);
        if (force) {
          window.__TEST__.holdSlowForce(true);
          for (let i = 0; i < 16; i++) await frame();
        }
        const scales = window.__GAME__.timeScales();
        key('KeyD', true);
        for (let i = 0; i < 12; i++) await frame(); // 加速到最大速度
        const dp = [], db = [], de = [], dap = [], dae = [];
        let prev = null;
        for (let f = 0; f < 24; f++) {
          await frame();
          const g = window.__GAME__.snapshot();
          const bs = window.__TEST__.bullets().map((b) => b.x);
          const ph = window.__GAME__.animPhases();
          const cur = { px: g.player.x, bx: bs, ex: g.enemies[0] ? g.enemies[0].x : null, ph };
          if (prev) {
            dp.push(Math.abs(cur.px - prev.px));
            dap.push(Math.abs(cur.ph.player - prev.ph.player));
            const dd = [];
            for (let i = 0; i < Math.min(cur.bx.length, prev.bx.length); i++) dd.push(Math.abs(cur.bx[i] - prev.bx[i]));
            if (dd.length) db.push(dd.reduce((a, b) => a + b, 0) / dd.length);
            if (cur.ex !== null && prev.ex !== null) de.push(Math.abs(cur.ex - prev.ex));
            if (cur.ph.enemy !== null && prev.ph.enemy !== null) dae.push(Math.abs(cur.ph.enemy - prev.ph.enemy));
          }
          prev = cur;
        }
        key('KeyD', false);
        window.__TEST__.holdSlowForce(false);
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
        return {
          scales,
          playerMove: avg(dp),
          playerAnim: avg(dap),
          enemyMove: avg(de),
          enemyAnim: avg(dae),
          bullet: avg(db),
        };
      }

      const normal = await sample(false);
      const slow = await sample(true);
      return { normal, slow };
    })()`,
    120000,
  );

  const n = r.normal;
  const s = r.slow;
  const ratio = (a, b) => (b > 1e-6 ? a / b : NaN);
  const fmt = (v) => (Number.isNaN(v) ? 'n/a' : v.toFixed(3));
  console.log(
    JSON.stringify(
      {
        normal: n,
        slow: s,
        ratios: {
          worldScale: s.scales.world,
          playerScale: s.scales.player,
          enemyMove: ratio(s.enemyMove, n.enemyMove),
          enemyAnim: ratio(s.enemyAnim, n.enemyAnim),
          bullet: ratio(s.bullet, n.bullet),
          playerMove: ratio(s.playerMove, n.playerMove),
          playerAnim: ratio(s.playerAnim, n.playerAnim),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await api.close();
}
