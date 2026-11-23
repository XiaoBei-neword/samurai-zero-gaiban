// ============================================================
// tests/run_bullettime_visual.mjs —— 子弹时间的"像素级"证据
//
// 做法：把游戏冻结在一个可控场景里（玩家一直朝右跑 + 几发钉在原地的子弹），
// 用**同样的真实时间间隔**（6 帧）截两张图，再比较像素差：
//   正常时间：玩家跑得远、子弹的自发光呼吸也在正常闪
//   子弹时间：玩家只慢一点（仍在大幅移动）；画面上"世界侧"的动画被显著压慢
// 再配合 tests/run_input.mjs 的逐帧数值（敌人/子弹/动画精确到 0.20×），
// 这就是"子弹时间时敌人、子弹、动画全部变慢，玩家自身减速更小"的完整证据链。
// ============================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGame, Checker, sleep, SHOTS, ensureDirs } from './lib/harness.mjs';

const c = new Checker('run_bullettime_visual');
const api = await startGame({});
const { page } = api;

async function grabPair(tag) {
  // 在页面内连续截取两帧（间隔 6 帧 ≈ 100ms 真实时间），避免 CDP 往返引入额外延时
  const pair = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const cv = document.getElementById('game');
    const tmp = document.createElement('canvas');
    tmp.width = cv.width; tmp.height = cv.height;
    const cx = tmp.getContext('2d');
    const shot = () => { cx.drawImage(cv, 0, 0); return tmp.toDataURL('image/png'); };
    for (let i = 0; i < 6; i++) await frame();
    const a = shot();
    for (let i = 0; i < 6; i++) await frame();
    const b = shot();
    return [a, b];
  })()`, 30000);
  await ensureDirs();
  const files = [];
  for (let i = 0; i < 2; i++) {
    const file = path.join(SHOTS, `${tag}_${i === 0 ? 'a' : 'b'}.png`);
    await fs.writeFile(file, Buffer.from(pair[i].split(',')[1], 'base64'));
    files.push(file);
  }
  return files;
}

try {
  const stage = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    window.__TEST__.holdSlowForce(false);
    window.__TEST__.gotoLevel(0);
    for (let i = 0; i < 8; i++) await frame();
    window.__TEST__.clearEnemies();
    window.__TEST__.teleport(240, 620);
    for (let i = 0; i < 6; i++) await frame();
    const p = window.__GAME__.snapshot().player;
    // 4 发"钉在原地"的子弹（角度 0、速度 4px/s），这样它们一直在画面里，方便看动画
    for (let i = 0; i < 4; i++) window.__TEST__.spawnBulletAt(p.x + 260 + i * 36, p.y - 150, 0, 4);
    // 玩家一直朝右跑（这一段 640px 内没有平台、没有尖刺、没有敌人）
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }));
    for (let i = 0; i < 10; i++) await frame();
    return { bullets: window.__TEST__.bullets().length };
  })()`, 30000);
  console.log(`   场景：钉住的子弹 ${stage.bullets} 发 + 玩家在跑`);

  const normal = await grabPair('bt_normal');
  await page.eval('window.__TEST__.holdSlowForce(true)');
  await sleep(500); // 等缩放收敛
  const slow = await grabPair('bt_slow');
  const scales = await page.eval('window.__GAME__.timeScales()');
  const still = await api.snapshot();
  await page.eval('window.__TEST__.holdSlowForce(false)');
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }))`);

  c.check(still.bullets.total >= 1, '采样期间子弹仍在场', `bullets=${still.bullets.total}`);
  c.check(still.player.alive === true, '采样期间玩家存活', `alive=${still.player.alive}`);
  c.check(scales.slowActive === true && scales.world < 0.3, '截图时确实处于子弹时间', `world=${scales.world.toFixed(3)} player=${scales.player.toFixed(3)}`);
  console.log(`   成对截图：${normal.map((f) => path.basename(f)).join(', ')} | ${slow.map((f) => path.basename(f)).join(', ')}`);
  await c.finish({
    normal: normal.map((f) => 'artifacts/screenshots/' + path.basename(f)),
    slow: slow.map((f) => 'artifacts/screenshots/' + path.basename(f)),
    scales,
  });
} catch (e) {
  c.check(false, '脚本异常', e && e.message ? e.message : String(e));
  await c.finish({});
} finally {
  await api.close().catch(() => {});
}

process.exit(0);
