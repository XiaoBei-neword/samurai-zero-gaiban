// ============================================================
// tests/check_v2.mjs —— 新需求的快速目视检查（截图为主）
//  1) 第 4 关存在且能进
//  2) 死亡后出现「任务失败」并停留 ~2 秒
//  3) ESC 暂停面板
//  4) 敌人子弹是金色颗粒、无拖尾
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({});
const { page } = api;
const shot = async (name) => {
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(120);
  await api.shot(name);
  await page.eval('window.__TEST__.freeze(false)');
};

try {
  const info = await page.eval('window.__GAME__.levelInfo()');
  console.log('关卡总数:', info.count);

  // 1) 第 4 关
  await page.eval('window.__TEST__.gotoLevel(3)');
  await sleep(600);
  const s4 = await api.snapshot();
  console.log(`第 ${s4.level} 关: ${s4.levelName} 敌人=${s4.enemiesAlive}`);
  await shot('v2_level4');

  // 2) 死亡 → 任务失败 2 秒
  const t0 = Date.now();
  await page.eval('window.__TEST__.killPlayer()');
  await sleep(260);
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(100);
  await api.shot('v2_fail_panel');
  const during = await api.snapshot();
  await page.eval('window.__TEST__.freeze(false)');
  console.log('死亡后 0.36s: state=', during.state, 'alive=', during.player.alive);
  await sleep(2100);
  const after = await api.snapshot();
  console.log(`死亡后 ${((Date.now() - t0) / 1000).toFixed(2)}s: state=`, after.state, 'alive=', after.player.alive);

  // 3) ESC 暂停
  await page.press('Escape');
  await sleep(300);
  const paused = await api.snapshot();
  console.log('ESC 后 paused =', paused.paused, 'state=', paused.state);
  await shot('v2_pause');
  await page.press('Escape');
  await sleep(300);
  console.log('再按 ESC paused =', (await api.snapshot()).paused);

  // 4) 金色子弹
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(500);
  await page.eval('window.__TEST__.freeze(true)');
  for (let i = 0; i < 6; i++) {
    await page.eval(`window.__TEST__.spawnBulletAt(${700 + i * 40}, ${420 + (i % 2) * 30}, ${0.3 + i * 0.2}, 120)`);
  }
  await page.eval('window.__TEST__.teleport(560, 620)');
  await sleep(200);
  await page.eval('window.__TEST__.freeze(false)');
  await sleep(60);
  await shot('v2_golden_bullets');
} finally {
  await api.close();
}
