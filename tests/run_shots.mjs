// ============================================================
// tests/run_shots.mjs —— 关键画面留影 + 冒烟检查
//
// 关键技巧：截图前用 __TEST__.freeze(true) 冻结画面，截完再解冻。
// 这样截图耗时（headless 下几百毫秒到 1 秒）不会让场景跑掉，
// 也避免"按着键截图结果人物跑进怪堆里"这种假故障。
// ============================================================
import { startGame, Checker, sleep, reportPageErrors } from './lib/harness.mjs';

const c = new Checker('run_shots');
const api = await startGame({ headed: process.argv.includes('--headed') });
const { page } = api;

async function shotFrozen(name) {
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(120);
  const r = await api.shot(name);
  await page.eval('window.__TEST__.freeze(false)');
  return r;
}

try {
  // ---------- 0. 启动即进关，没有主菜单 ----------
  const boot = await page.eval(`({
    ready: window.__READY__ === true,
    menuEls: document.querySelectorAll('.menu, #menu, .title-screen').length,
    snap: window.__GAME__.snapshot(),
  })`);
  c.check(boot.ready && boot.snap.level === 1, '启动后直接进入第 1 关（无主菜单）', `level=${boot.snap.level} ${boot.snap.levelName}`);
  c.check(boot.menuEls === 0, '页面里没有任何菜单 DOM');
  await shotFrozen('01_start');

  // ---------- 1. 跑动 ----------
  const x0 = (await api.snapshot()).player.x;
  await page.keyDown('KeyD');
  await sleep(260);
  await page.keyUp('KeyD');
  await sleep(60);
  const moved = await api.snapshot();
  c.check(moved.player.x - x0 > 40, '按住 D 向右移动', `x ${x0} → ${moved.player.x}`);

  // ---------- 2. 浪人发现玩家（视觉 + 听觉）----------
  await page.eval('window.__TEST__.teleport(520, 620)');
  await sleep(650);
  const alerted = await api.snapshot();
  const roninStates = alerted.enemies.filter((e) => e.type === 'ronin').map((e) => e.state);
  c.check(
    roninStates.some((s) => ['alert', 'chase', 'windup', 'attack', 'recover'].includes(s)),
    '浪人发现玩家并进入战斗状态',
    JSON.stringify(alerted.enemies.map((e) => `${e.type}@${e.x}:${e.state}`)),
  );
  await shotFrozen('03_enemy_aggro');

  // ---------- 3. 时间减缓 ----------
  await page.eval('window.__TEST__.teleport(1000, 620)');
  await page.eval('window.__TEST__.setEnergy(100)');
  await page.mouseMove(1120, 380);
  await sleep(150);
  await page.mouseDown('middle');
  await sleep(550); // 缩放是 90ms 时间常数的指数平滑，等它收敛
  const slowState = await page.eval('window.__GAME__.timeScales()');
  c.check(slowState.slowActive === true, '按住鼠标中键进入时间减缓', `world=${slowState.world.toFixed(3)} player=${slowState.player.toFixed(3)}`);
  c.near(slowState.world, 0.15, 0.02, '世界时间缩放 ≈ 0.15');
  c.near(slowState.player, 0.6, 0.02, '玩家时间缩放 ≈ 0.60');
  c.near(slowState.ratio, 4.0, 0.3, '玩家相对时间优势 ≈ 4 倍');

  // ---------- 4. 子弹飞行 + 劈砍反弹 ----------
  await page.eval('window.__TEST__.spawnBulletAt(1090, 592, Math.PI, 200)');
  await sleep(80);
  const before = await api.snapshot();
  c.check(before.bullets.enemyBullets >= 1, '敌方子弹在飞', JSON.stringify(before.bullets));
  await shotFrozen('04_slowmo_bullet');

  // 挥刀 → 立刻冻结 → 在冻结状态里断言并截图（避免子弹在等待截图时飞走/命中玩家）
  await page.mouseDown('left');
  await sleep(70);
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(80);
  const after = await api.snapshot();
  await api.shot('05_deflect');
  await page.eval('window.__TEST__.freeze(false)');
  await page.mouseUp('left');
  await page.mouseUp('middle');
  c.check(
    after.bullets.deflected >= 1,
    '近战把子弹反弹了回去（归属翻转）',
    JSON.stringify(after.bullets),
  );

  // ---------- 5. 击杀（断肢 / 血迹 / 尸体保留）----------
  await page.eval('window.__TEST__.spawnEnemy("ronin", 1068, 620)');
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(80);
  const staged = await api.snapshot();
  await page.eval('window.__TEST__.freeze(false)');
  // 先砍一刀（敌人 68px 内，确保在扇形范围内）
  await page.mouseDown('left');
  await sleep(50);
  await page.mouseUp('left');
  await sleep(220);
  // 立刻冻结再读状态：否则玩家可能在这 200ms 里被别的敌人打死、关卡重置把尸体清掉
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(60);
  const killed = await api.snapshot();
  c.check(killed.stats.kills >= staged.stats.kills, '劈砍命中并击杀敌人', `kills ${staged.stats.kills} → ${killed.stats.kills}`);
  c.check(killed.corpses >= 1, '尸体留在场景里', `corpses=${killed.corpses}`);
  await api.shot('06_kill');
  await page.eval('window.__TEST__.freeze(false)');

  // ---------- 6. 清版开门 ----------
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(650);
  const cleared = await api.snapshot();
  c.check(cleared.cleared === true && cleared.doorUsable === true, '清版后门自动开启', `cleared=${cleared.cleared} open=${cleared.doorOpen}`);
  await page.eval('window.__TEST__.teleport(1640, 620)');
  await sleep(400);
  await shotFrozen('07_door_open');

  // ---------- 7. 结算面板（打通第 4 关后触发）----------
  await page.eval('window.__TEST__.gotoLevel(3)');
  await sleep(300);
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(600);
  const doorInfo = await page.eval('window.__GAME__.levelInfo()');
  await page.eval(`window.__TEST__.teleport(${doorInfo.door.x + doorInfo.door.w / 2}, 620)`);
  await page.waitFor('window.__GAME__.snapshot().state === "victory"', 6000);
  await sleep(900);
  await shotFrozen('08_victory');
  const vic = await api.snapshot();
  c.check(vic.state === 'victory', '第 4 关后进入结算状态', JSON.stringify(vic.stats));

  // ---------- 8. 按 R 从头开始 ----------
  await page.press('KeyR');
  await sleep(400);
  const restarted = await api.snapshot();
  c.check(
    restarted.level === 1 && restarted.state === 'playing' && restarted.stats.kills === 0,
    '结算面板按 R 从头开始（统计清零、回到第 1 关）',
    JSON.stringify({ level: restarted.level, state: restarted.state, stats: restarted.stats }),
  );

  // ---------- 9. 死亡 →「任务失败」面板（停留 2 秒后重置）----------
  await page.eval('window.__TEST__.freeze(true)');
  await page.eval('window.__TEST__.freeze(false)');
  await page.eval('window.__TEST__.killPlayer()');
  await sleep(420);
  const dying = await api.snapshot();
  c.check(dying.state === 'death' && dying.player.alive === false, '死亡后进入「任务失败」状态（不立刻重生）', `state=${dying.state}`);
  await page.eval('window.__TEST__.freeze(true)');
  await sleep(60);
  await api.shot('09_death_fail');
  await page.eval('window.__TEST__.freeze(false)');
  await sleep(2400);
  const revived = await api.snapshot();
  c.check(
    revived.player.alive === true && revived.state === 'playing',
    '「任务失败」约 2 秒后自动重置回可玩状态',
    `state=${revived.state} deaths=${revived.stats.deaths}`,
  );

  // ---------- 9.5 ESC 暂停面板 ----------
  await page.press('Escape');
  await sleep(300);
  const paused = await api.snapshot();
  c.check(paused.paused === true, 'ESC 暂停生效', `paused=${paused.paused}`);
  await api.shot('09b_pause');
  await page.press('Escape');
  await sleep(300);
  c.check((await api.snapshot()).paused === false, '再按 ESC 继续游戏');

  // ---------- 10. 第 2 / 3 / 4 关的画面 ----------
  await page.eval('window.__TEST__.gotoLevel(1)');
  await sleep(500);
  await shotFrozen('10_level2');
  await page.eval('window.__TEST__.gotoLevel(2)');
  await sleep(500);
  await shotFrozen('11_level3');
  await page.eval('window.__TEST__.gotoLevel(3)');
  await sleep(500);
  await shotFrozen('12_level4');

  await reportPageErrors(api, c);
} catch (e) {
  c.check(false, '脚本异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
} finally {
  await api.close();
}

const s = await c.finish();
process.exit(s.ok ? 0 : 1);
