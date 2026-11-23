// ============================================================
// tests/diag_combat.mjs —— 诊断：劈砍到底有没有命中
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({ headed: process.argv.includes('--headed') });
const { page } = api;

const pl = async (tag) => {
  const s = await api.snapshot();
  const p = s.player;
  console.log(
    `[${tag}] p=(${p.x},${p.y}) slashT=${p.slashT} slashAngle=${p.slashAngle} attackBuffer=${p.attackBuffer}` +
      ` aim=${p.aim} aimPoint=${JSON.stringify(p.aimPoint)} pointer=${JSON.stringify(p.pointer)} heldAttack=${p.heldAttack}` +
      ` enemies=${s.enemies.map((e) => `${e.type}@${e.x},${e.y}`).join(' ')} kills=${s.stats.kills} deaths=${s.stats.deaths}`,
  );
};

try {
  await page.eval('window.__TEST__.teleport(1000, 620)');
  await sleep(200);
  await page.mouseMove(1100, 380);
  await sleep(150);
  await pl('aimed right');

  await page.mouseDown('left');
  await sleep(25);
  await pl('t+25ms after mousedown');
  await sleep(60);
  await pl('t+85ms');
  await page.mouseUp('left');
  await sleep(200);
  await pl('released');

  // 放一个敌人到正前方 70px
  console.log('--- spawn ronin at 1075 ---');
  await page.eval('window.__TEST__.spawnEnemy("ronin", 1075, 620)');
  await sleep(120);
  await pl('spawned');
  for (let i = 0; i < 3; i++) {
    await page.mouseMove(1140, 380);
    await page.mouseDown('left');
    await sleep(70);
    await page.mouseUp('left');
    await sleep(180);
    await pl(`after swing ${i + 1}`);
  }

  // 把敌人冻住再砍（排除 AI 干扰）
  console.log('--- 用 freeze 定格，然后连续点砍 ---');
  await page.eval('window.__TEST__.freeze(true)');
  await page.mouseDown('left');
  await sleep(100);
  await page.eval('window.__TEST__.freeze(false)');
  await page.mouseUp('left');
  await sleep(200);
  await pl('after frozen-swing');

  // 直接读一次几何：刀扇形 vs 敌人盒
  const geo = await page.eval(`(() => {
    const g = window.__GAME__;
    const s = window.__GAME__.snapshot();
    return { enemies: s.enemies, player: s.player };
  })()`);
  console.log('geo:', JSON.stringify(geo));
} finally {
  await api.close();
}
