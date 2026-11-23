// ============================================================
// tests/diag_flow.mjs —— 诊断：复现 run_shots 里那些"没动"的现象
// ============================================================
import { startGame, sleep } from './lib/harness.mjs';

const api = await startGame({ headed: process.argv.includes('--headed') });
const { page } = api;

const dump = async (tag) => {
  const s = await api.snapshot();
  const cam = await page.eval('window.__GAME__.cam()');
  const loop = await page.eval('window.__GAME__.loop()');
  console.log(
    `[${tag}] state=${s.state} lvl=${s.level} p=(${s.player.x},${s.player.y}) vx=${s.player.vx} grounded=${s.player.grounded}` +
      ` cam=(${cam.x},${cam.y}) zoom=${cam.zoom} pScreen=(${cam.playerScreen.x.toFixed(0)},${cam.playerScreen.y.toFixed(0)})` +
      ` steps=${loop.stepsLastFrame} dt=${loop.dtReal} elapsed=${loop.elapsedReal}` +
      ` enemies=[${s.enemies.map((e) => `${e.type}@${e.x},${e.y}:${e.state}f${e.facing}`).join(' ')}]` +
      ` deaths=${s.stats.deaths} lastDeath=${JSON.stringify(s.deathLog[s.deathLog.length - 1] || null)}`,
  );
};

try {
  await dump('boot');
  await sleep(600);
  await dump('after 600ms');

  console.log('--- 截图（看它是否打断模拟）---');
  await api.shot('diag_before');
  await dump('right after shot');
  await sleep(600);
  await dump('600ms after shot');

  console.log('--- 按住 D 300ms ---');
  await page.keyDown('KeyD');
  await sleep(300);
  await dump('holding D 300ms');
  await sleep(300);
  await dump('holding D 600ms');
  await page.keyUp('KeyD');
  await sleep(200);
  await dump('released');

  console.log('--- 传送并等待 ---');
  await page.eval('window.__TEST__.teleport(560, 620)');
  await dump('just after teleport');
  await sleep(200);
  await dump('200ms after teleport');
  await sleep(600);
  await dump('800ms after teleport');

  console.log('--- 跳跃 ---');
  await page.press('KeyW', 80);
  await sleep(150);
  await dump('after jump');

  console.log('--- 缓慢推进 2s ---');
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    await dump(`t+${(i + 1) * 500}ms`);
  }
} finally {
  await api.close();
}
