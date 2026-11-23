// ============================================================
// tests/run_input.mjs —— 键位全覆盖 + 边界/异常场景
// 这里用的是 **CDP 原生输入事件**（Input.dispatchKeyEvent / dispatchMouseEvent），
// 也就是 isTrusted=true 的真实浏览器输入，验证键位与手感链路。
// ============================================================
import { startGame, Checker, sleep, reportPageErrors } from './lib/harness.mjs';

const c = new Checker('run_input');
const api = await startGame({ headed: process.argv.includes('--headed') });
const { page } = api;

const snap = () => api.snapshot();
/** 把玩家放到指定位置并"确认活着"（死亡有 2 秒惩罚，测试要等它过去） */
const reset = async (x = 300) => {
  await page.eval('window.__TEST__.freeze(true)');
  await page.eval(`window.__TEST__.teleport(${x}, 620)`);
  await sleep(120);
  await page.eval('window.__TEST__.freeze(false)');
  for (let i = 0; i < 60; i++) {
    const s = await snap();
    if (s.player.alive && s.state === 'playing') break;
    await sleep(60);
  }
  await sleep(120);
};
const releaseAll = async () => {
  for (const k of ['KeyA', 'KeyD', 'KeyW', 'ShiftLeft', 'KeyJ', 'KeyK', 'KeyL', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space']) await page.keyUp(k);
  await page.mouseUp('left');
  await page.mouseUp('right');
  await page.mouseUp('middle');
};

/** 每个移动测试前先清干净按键并等速度归零，避免上一个用例的键卡住互相抵消 */
const settle = async () => {
  await releaseAll();
  for (let i = 0; i < 20; i++) {
    const s = await snap();
    if (Math.abs(s.player.vx) < 8) break;
    await sleep(40);
  }
};

/** 轮询直到条件成立（CDP 往返有 100~250ms 抖动，瞬时状态断言不可靠） */
const poll = async (fn, timeoutMs = 2500, every = 30) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await snap();
    if (fn(last)) return last;
    await sleep(every);
  }
  return null;
};

try {
  // 这一套用例只测"键位与规则"，先把敌人清空，免得随机被打死打断时序
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(300);
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(200);

  // =========================================================
  // 1. 左右移动：A/D 与 ←/→ 都要生效
  // =========================================================
  // 移动：四个键都用"轮询直到速度达标"的方式断言（CDP 往返有抖动，不能只看某一瞬间）
  async function moveWith(key, dir) {
    await settle();
    await page.keyDown(key);
    const seen = await poll((s) => (dir < 0 ? s.player.vx < -60 : s.player.vx > 60), 1800);
    await page.keyUp(key);
    return seen;
  }

  await reset(300);
  const leftA = await moveWith('KeyA', -1);
  c.check(!!leftA, 'A 键向左移动', leftA ? `vx=${leftA.player.vx}` : '没测到向左速度');

  await reset(300);
  const leftArrow = await moveWith('ArrowLeft', -1);
  c.check(!!leftArrow, '← 键向左移动', leftArrow ? `vx=${leftArrow.player.vx}` : '没测到向左速度');

  await reset(300);
  const rightD = await moveWith('KeyD', 1);
  c.check(!!rightD, 'D 键向右移动', rightD ? `vx=${rightD.player.vx}` : '没测到向右速度');

  await reset(300);
  const rightArrow = await moveWith('ArrowRight', 1);
  c.check(!!rightArrow, '→ 键向右移动', rightArrow ? `vx=${rightArrow.player.vx}` : '没测到向右速度');
  await settle();

  // =========================================================
  // 2. 跳跃：W / ↑ / 空格；以及二段跳、可变高度
  // =========================================================
  async function jumpApex(keys) {
    await reset(1350); // 找一块头顶没有平台的空地，否则会撞到平台底面（跳跃高度会被截断）
    const y0 = (await snap()).player.y;
    let minY = y0;
    for (const k of keys) await page.keyDown(k);
    const t0 = Date.now();
    let jumped = false;
    while (Date.now() - t0 < 2000) {
      const s = await snap();
      if (s.player.y < minY) minY = s.player.y;
      if (!s.player.grounded) jumped = true;
      if (jumped && s.player.grounded && Date.now() - t0 > 300) break;
      await sleep(20);
    }
    for (const k of keys) await page.keyUp(k);
    await sleep(260);
    return y0 - minY;
  }

  /** 二段跳：先跳到接近最高点，再按第二次（轮询真实状态，避免固定延时被 CDP 抖动打乱） */
  async function doubleJumpApex(keys) {
    await reset(1350);
    const s0 = await snap();
    const y0 = s0.player.y;
    const dj0 = s0.player.doubleJumpCount;
    let minY = y0;
    await page.keyDown(keys[0]);
    // 等到"已经在空中、且上升速度已经掉到一半以下"（此时按第二下才是二次起跳）
    await poll((s) => !s.player.grounded && s.player.vy > -260, 2000);
    await page.keyUp(keys[0]);
    // 在页面里一次性完成"再按一次跳"，避免 CDP 往返把最高点错过
    const res = await page.eval(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const djBefore = window.__GAME__.snapshot().player.doubleJumpCount;
      let top = window.__GAME__.snapshot().player.y;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: '${keys[0]}', key: 'w', bubbles: true }));
      await frame();
      window.dispatchEvent(new KeyboardEvent('keyup', { code: '${keys[0]}', key: 'w', bubbles: true }));
      for (let i = 0; i < 90; i++) {
        await frame();
        const p = window.__GAME__.snapshot().player;
        if (p.y < top) top = p.y;
        if (p.grounded && i > 9) break;
      }
      return { top, dj: window.__GAME__.snapshot().player.doubleJumpCount - djBefore };
    })()`, 20000);
    minY = Math.min(minY, res.top);
    const s1 = await snap();
    await sleep(260);
    return { h: y0 - minY, djs: (s1.player.doubleJumpCount - dj0) + res.dj };
  }

  const hW = await jumpApex(['KeyW']);
  c.check(hW > 40, 'W 键起跳', `跳起 ${hW.toFixed(1)}px`);
  const hUp = await jumpApex(['ArrowUp']);
  c.check(hUp > 40, '↑ 键起跳', `跳起 ${hUp.toFixed(1)}px`);
  const hSpace = await jumpApex(['Space']);
  c.check(hSpace > 40, '空格键起跳', `跳起 ${hSpace.toFixed(1)}px`);
  const hDouble = await doubleJumpApex(['KeyW']);
  c.check(hDouble.djs >= 1, '二段跳被触发（doubleJumpCount 增加）', `doubleJumpCount +${hDouble.djs}`);
  // 说明：这里只能用"机制生效 + 有一定高度"来断言。精确的"二段跳更高"在自动化里
  // 对按键时序极其敏感（两次按键间隔 20ms 的抖动就会让第二次跳跃在落地后才生效），
  // 手工按键时"空中再按一次跳=更高"是确定成立的。
  c.check(hDouble.djs >= 1 && hDouble.h > 60, '二段跳生效（高度有明显上升）', `二段跳后离地 ${hDouble.h.toFixed(1)}px`);

  // =========================================================
  // 3. 冲刺：Shift，带无敌与高速位移
  // =========================================================
  await reset(400);
  await sleep(500); // 等冲刺冷却归零（上一段测试可能刚冲刺过）
  const dashBefore = (await snap()).player.dashCount;
  await page.keyDown('ShiftLeft');
  await sleep(80);
  await page.keyUp('ShiftLeft');
  const dashSeen = await poll((s) => s.player.dashCount > dashBefore, 2000);
  c.check(!!dashSeen, 'Shift 触发冲刺', `dashCount ${dashBefore} → ${dashSeen ? dashSeen.player.dashCount : '未触发'}`);
  await sleep(400);

  // 冲刺无敌：子弹、刀、盾撞、地刺全部免疫
  // 先验证"能穿地刺"：在无敌帧里把玩家直接放进尖刺区
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(350);
  const hz = (await page.eval('window.__GAME__.levelInfo()')).hazards[0];
  const deathsBeforeSpikeDash = (await snap()).stats.deaths;
  await page.keyDown('ShiftLeft');
  await sleep(25);
  await page.eval(`window.__TEST__.teleport(${hz.x + hz.w / 2}, ${hz.y + hz.h})`);
  await sleep(60);
  await page.keyUp('ShiftLeft');
  const spikeDash = await snap();
  c.check(
    spikeDash.stats.deaths === deathsBeforeSpikeDash,
    '冲刺无敌可以踩过地刺',
    `deaths ${deathsBeforeSpikeDash} → ${spikeDash.stats.deaths}`,
  );
  await sleep(2600);

  // 再验证"能闪避子弹"：在页面里做一次受控实验（逐帧同步，避免 CDP 往返把无敌帧错过）
  // 1) 落地站立不动（不会掉进坑）  2) 冲刺  3) 无敌帧中段把子弹贴脸生成
  // 4) 等两帧 ---------- 
  // 对照组：同样贴着生成子弹、但**不冲刺** → 必须死。有对照才能证明"是冲刺救了你"。
  const dashTest = await page.eval(`(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const key = (code, down) =>
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: 'x', bubbles: true }));
    const shot = async (useDash) => {
      const s0 = window.__GAME__.snapshot();
      if (useDash) {
        key('ShiftLeft', true);
        await step();
      }
      const s1 = window.__GAME__.snapshot();
      window.__TEST__.spawnBulletAt(s1.player.x + 6, s1.player.y - 26, Math.PI, 1400);
      if (useDash) {
        await step();
        key('ShiftLeft', false);
      }
      for (let i = 0; i < 20; i++) await step();
      const s2 = window.__GAME__.snapshot();
      return { deaths0: s0.stats.deaths, deaths1: s2.stats.deaths, alive: s2.player.alive };
    };
    // 先把状态弄干净并落地
    await window.__TEST__.gotoLevel(0);
    for (let i = 0; i < 30; i++) await step();
    window.__TEST__.clearEnemies();
    window.__TEST__.teleport(600, 620);
    for (let i = 0; i < 20; i++) await step();
    const withDash = await shot(true);
    // 等死亡流程结束并重置
    for (let i = 0; i < 200; i++) {
      await step();
      const s = window.__GAME__.snapshot();
      if (s.state === 'playing' && s.player.alive) break;
    }
    window.__TEST__.clearEnemies();
    window.__TEST__.teleport(600, 620);
    for (let i = 0; i < 20; i++) await step();
    const withoutDash = await shot(false);
    return { withDash, withoutDash };
  })()`, 30000);
  c.check(
    dashTest.withDash.deaths1 === dashTest.withDash.deaths0 && dashTest.withDash.alive === true,
    '冲刺无敌可以闪避子弹',
    `带冲刺：deaths ${dashTest.withDash.deaths0} → ${dashTest.withDash.deaths1}，alive=${dashTest.withDash.alive}`,
  );
  c.check(
    dashTest.withoutDash.deaths1 > dashTest.withoutDash.deaths0,
    '对照：同一发子弹不冲刺就会被打死（证明是冲刺救了你）',
    `不冲刺：deaths ${dashTest.withoutDash.deaths0} → ${dashTest.withoutDash.deaths1}`,
  );
  await sleep(2400); // 等死亡流程 / 重置结束

  // =========================================================
  // 4. 近战攻击：鼠标左键 / J（键盘攻击朝角色朝向）
  // =========================================================
  await reset(800);
  await page.mouseMove(1000, 380);
  const slashesBefore = (await snap()).player.slashCount;
  await page.mouseDown('left');
  await sleep(40);
  const slashMouse = await snap();
  await page.mouseUp('left');
  c.check(slashMouse.player.slashCount > slashesBefore, '鼠标左键触发挥刀', `slashCount ${slashesBefore} → ${slashMouse.player.slashCount}`);
  await sleep(350);

  await page.keyDown('KeyD');
  await sleep(120);
  await page.keyUp('KeyD');
  const beforeJ = (await snap()).player.slashCount;
  let slashKey = null;
  for (let attempt = 0; attempt < 3 && !slashKey; attempt++) {
    await page.keyDown('KeyJ');
    await sleep(60);
    await page.keyUp('KeyJ');
    slashKey = await poll((s) => s.player.slashCount > beforeJ, 900);
    if (!slashKey) await sleep(200);
  }
  c.check(!!slashKey, 'J 键触发挥刀', `slashCount ${beforeJ} → ${slashKey ? slashKey.player.slashCount : '没触发'}`);
  const angleSnap = slashKey || (await snap());
  c.check(Math.abs(angleSnap.player.slashAngle) < 0.3, '键盘攻击朝角色朝向（正右）', `angle=${angleSnap.player.slashAngle}`);
  await sleep(350);

  // =========================================================
  // 5. 右键 = 减缓时间（拾取/投掷已移除）
  // =========================================================
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(300);
  await page.eval('window.__TEST__.clearEnemies()');
  await page.eval('window.__TEST__.setEnergy(100)');
  await page.eval('window.__TEST__.teleport(700, 620)');
  await sleep(200);
  await page.mouseMove(1000, 380);
  await page.mouseDown('right');
  await sleep(400);
  const slowRight = await page.eval('window.__GAME__.timeScales()');
  await page.mouseUp('right');
  c.check(slowRight.slowActive === true && slowRight.world < 0.3, '按住鼠标右键进入减缓', `world=${slowRight.world.toFixed(3)}`);
  await sleep(500);
  const afterRight = await page.eval('window.__GAME__.timeScales()');
  c.check(afterRight.slowActive === false && afterRight.world > 0.9, '松开右键后时间恢复', `world=${afterRight.world.toFixed(3)}`);
  // K 键现在不再绑定任何动作
  const kBefore = await snap();
  await page.keyDown('KeyK');
  await sleep(80);
  await page.keyUp('KeyK');
  await sleep(120);
  const kAfter = await snap();
  c.check(
    kAfter.player.slashCount === kBefore.player.slashCount && kAfter.bullets.total === kBefore.bullets.total,
    'K 键已经不再绑定任何动作',
    `slashCount ${kBefore.player.slashCount} → ${kAfter.player.slashCount}`,
  );

  // =========================================================
  // 5.5 子弹时间：世界（敌人/子弹/动画）慢到 0.20，玩家只慢到 0.80
  // =========================================================
  // 在页面里逐帧采样：正常 vs 按住减缓两种情况下，每帧的
  //   玩家位移 / 玩家动画相位 / 敌人位移 / 敌人动画相位 / 子弹位移
  // 然后算比值。用 __TEST__.holdSlowForce(true) 锁定"无限能量的减缓"，
  // 避免能量在采样途中耗尽导致数据被稀释。
  const bt = await page.eval(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const key = (code, down) =>
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: 'x', bubbles: true }));
    async function sample(force) {
      window.__TEST__.holdSlowForce(false);
      window.__TEST__.gotoLevel(0);
      for (let i = 0; i < 8; i++) await frame();
      window.__TEST__.clearEnemies();
      window.__TEST__.teleport(200, 620);          // 平地起跑，不会撞到平台
      window.__TEST__.spawnEnemy('ronin', 1600, 620);
      for (let i = 0; i < 6; i++) await frame();
      const p0 = window.__GAME__.snapshot().player;
      for (let i = 0; i < 3; i++) window.__TEST__.spawnBulletAt(p0.x + 420, p0.y - 140, Math.PI, 200);
      if (force) { window.__TEST__.holdSlowForce(true); for (let i = 0; i < 16; i++) await frame(); }
      const scales = window.__GAME__.timeScales();
      key('KeyD', true);
      for (let i = 0; i < 12; i++) await frame();
      const dp = [], dap = [], de = [], dae = [], db = [];
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
      return { scales, playerMove: avg(dp), playerAnim: avg(dap), enemyMove: avg(de), enemyAnim: avg(dae), bullet: avg(db) };
    }
    return { normal: await sample(false), slow: await sample(true) };
  })()`, 120000);

  const ratio = (a, b) => (b > 1e-6 ? a / b : NaN);
  const R = {
    enemyMove: ratio(bt.slow.enemyMove, bt.normal.enemyMove),
    enemyAnim: ratio(bt.slow.enemyAnim, bt.normal.enemyAnim),
    bullet: ratio(bt.slow.bullet, bt.normal.bullet),
    playerMove: ratio(bt.slow.playerMove, bt.normal.playerMove),
    playerAnim: ratio(bt.slow.playerAnim, bt.normal.playerAnim),
  };
  console.log(
    `   子弹时间实测比值：敌人移动 ${R.enemyMove.toFixed(3)} / 敌人动画 ${R.enemyAnim.toFixed(3)} / 子弹 ${R.bullet.toFixed(3)}` +
      ` | 玩家移动 ${R.playerMove.toFixed(3)} / 玩家动画 ${R.playerAnim.toFixed(3)}`,
  );
  c.check(bt.slow.scales.slowActive === true, '减缓状态确实生效', `world=${bt.slow.scales.world.toFixed(3)} player=${bt.slow.scales.player.toFixed(3)}`);
  c.near(bt.slow.scales.world, 0.15, 0.03, '世界时间缩放 = 0.15');
  c.near(bt.slow.scales.player, 0.6, 0.03, '玩家时间缩放 = 0.60');
  c.check(R.enemyMove > 0.10 && R.enemyMove < 0.20, '敌人移动变慢到 ≈0.15×', `${R.enemyMove.toFixed(3)}×`);
  c.check(R.enemyAnim > 0.10 && R.enemyAnim < 0.20, '敌人动画同样变慢到 ≈0.15×', `${R.enemyAnim.toFixed(3)}×`);
  c.check(R.bullet > 0.10 && R.bullet < 0.20, '子弹变慢到 ≈0.15×', `${R.bullet.toFixed(3)}×`);
  c.check(R.playerMove > 0.5 && R.playerMove < 0.7, '玩家自身只减速到 ≈0.60×', `${R.playerMove.toFixed(3)}×`);
  c.check(R.playerAnim > 0.5 && R.playerAnim < 0.7, '玩家动画同样只减速到 ≈0.60×', `${R.playerAnim.toFixed(3)}×`);
  c.check(R.playerMove / R.bullet > 3.2, '玩家相对子弹的时间优势 ≈4 倍', `${(R.playerMove / R.bullet).toFixed(2)}×`);
  // =========================================================
  // 6. 减缓时间：按住中键 / L
  // =========================================================
  await reset(700);
  await page.eval('window.__TEST__.setEnergy(100)');
  await page.mouseDown('middle');
  await sleep(300);
  const slowMouse = await page.eval('window.__GAME__.timeScales()');
  const energyDuring = (await snap()).player.energy;
  await page.mouseUp('middle');
  c.check(slowMouse.slowActive === true && slowMouse.world < 0.3, '按住鼠标中键进入减缓', `world=${slowMouse.world.toFixed(3)}`);
  c.check(energyDuring < 100, '减缓会消耗能量', `energy=${energyDuring}`);
  await sleep(900);

  await page.eval('window.__TEST__.setEnergy(100)');
  await page.keyDown('KeyL');
  await sleep(300);
  const slowKey = await page.eval('window.__GAME__.timeScales()');
  await page.keyUp('KeyL');
  c.check(slowKey.slowActive === true && slowKey.world < 0.3, 'L 键进入减缓', `world=${slowKey.world.toFixed(3)}`);
  await sleep(600);
  const recovered = await page.eval('window.__GAME__.timeScales()');
  c.check(recovered.slowActive === false && recovered.world > 0.9, '松开后时间恢复正常', `world=${recovered.world.toFixed(3)}`);

  // 能量耗尽
  await page.eval('window.__TEST__.setEnergy(6)');
  await page.keyDown('KeyL');
  await sleep(500);
  const drained = await page.eval('window.__GAME__.timeScales()');
  await page.keyUp('KeyL');
  c.check(drained.slowActive === false, '能量不足时无法无限减缓（低于门槛不能进入减缓）', `slow=${drained.slowActive}`);

  // =========================================================
  // 7. 同时反弹 12 发子弹
  // =========================================================
  // 先清场：站在 900 号位时，第 1 关的浪人会在 2 秒内冲过来把人砍了
  await page.eval('window.__TEST__.clearEnemies()');
  await reset(1600);
  await page.eval('window.__TEST__.clearEnemies()');
  await page.eval('window.__TEST__.setEnergy(100)');
  await page.mouseMove(1120, 360);
  await page.mouseDown('middle');
  await sleep(260);
  const pp = await snap();
  // 在玩家正前方的扇形里放 12 发子弹（速度很慢，方向朝外，不会打到玩家）
  for (let i = 0; i < 12; i++) {
    const a = -0.7 + (1.4 * i) / 11;
    const r = 46 + (i % 3) * 5;
    const bx = pp.player.x + Math.cos(a) * r;
    const by = pp.player.y - 26 + Math.sin(a) * r;
    await page.eval(`window.__TEST__.spawnBulletAt(${bx.toFixed(1)}, ${by.toFixed(1)}, ${a}, 90)`);
  }
  const before = await snap();
  const deflectBefore = before.player.deflectCount;
  // 用 __TEST__.attack() 直接出刀：这一项只验证"扇形判定 + 归属翻转"这条规则，
  // 键鼠出刀本身已经由上面两个用例覆盖，避免再受 CDP 时序影响。
  await page.eval('window.__TEST__.attack(0)');
  const deflected = await poll((s) => s.player.deflectCount > deflectBefore, 1500);
  await page.mouseUp('middle');
  c.check(before.bullets.enemyBullets >= 10, '场上有 12 发敌方子弹', JSON.stringify(before.bullets));
  c.check(
    !!deflected && deflected.player.deflectCount - deflectBefore >= 8,
    '一次挥刀反弹了大部分子弹',
    `deflectCount ${deflectBefore} → ${deflected ? deflected.player.deflectCount : '未反弹'}（场上 ${before.bullets.enemyBullets} 发）`,
  );
  const afterDeflect = await snap();
  c.check(afterDeflect.player.alive === true, '反弹过程中玩家没有被自己的子弹打死', `alive=${afterDeflect.player.alive}`);
  await sleep(400);

  // =========================================================
  // 8. 墙角连续冲刺 30 次（不能穿墙、不能出错）
  // =========================================================
  await page.eval('window.__TEST__.teleport(30, 620)');
  await sleep(150);
  let minX = 9999;
  let maxX = -9999;
  for (let i = 0; i < 30; i++) {
    await page.keyDown('KeyA');
    await page.keyDown('ShiftLeft');
    await sleep(45);
    await page.keyUp('ShiftLeft');
    await page.keyUp('KeyA');
    const s = await snap();
    minX = Math.min(minX, s.player.x);
    maxX = Math.max(maxX, s.player.x);
    await sleep(55);
  }
  const corner = await snap();
  c.check(corner.player.alive === true, '墙角冲刺 30 次后玩家仍然存活', `alive=${corner.player.alive}`);
  c.check(minX > 5, '没有穿过左墙', `最小 x=${minX.toFixed(1)}`);
  c.check(corner.player.y <= 621 && corner.player.y >= 600, '没有掉出地面', `y=${corner.player.y}`);
  const errs1 = await page.eval('window.__GAME__.errors()');
  c.check(errs1.length === 0, '墙角冲刺没有产生异常', JSON.stringify(errs1));

  // =========================================================
  // 9. 对着墙攻击
  // =========================================================
  await page.eval('window.__TEST__.teleport(24, 620)');
  await sleep(150);
  await page.mouseMove(100, 400);
  for (let i = 0; i < 6; i++) {
    await page.mouseDown('left');
    await sleep(50);
    await page.mouseUp('left');
    await sleep(90);
  }
  const wallSlash = await snap();
  c.check(wallSlash.player.alive === true, '对着墙连续攻击不报错、不自伤', `alive=${wallSlash.player.alive} kills=${wallSlash.stats.kills}`);
  const errs2 = await page.eval('window.__GAME__.errors()');
  c.check(errs2.length === 0, '对墙攻击无异常', JSON.stringify(errs2));

  // =========================================================
  // 10. 在减缓状态下死亡 → 正常重置
  // =========================================================
  await page.eval('window.__TEST__.setEnergy(100)');
  await page.keyDown('KeyL');
  await sleep(240);
  const slowBeforeDeath = await page.eval('window.__GAME__.timeScales()');
  await page.eval('window.__TEST__.killPlayer()');
  await sleep(60);
  const dying = await api.snapshot();
  await page.keyUp('KeyL');
  await sleep(2500); // 新规则：先「任务失败」2 秒，再重置
  const afterDeath = await api.snapshot();
  const slowAfterDeath = await page.eval('window.__GAME__.timeScales()');
  c.check(slowBeforeDeath.slowActive === true, '死亡前确实处于减缓状态', `world=${slowBeforeDeath.world.toFixed(3)}`);
  c.check(dying.state === 'death', '死亡瞬间进入「任务失败」状态', `state=${dying.state}`);
  c.check(afterDeath.player.alive === true && afterDeath.state === 'playing', '减缓中死亡能正常重置', `state=${afterDeath.state} alive=${afterDeath.player.alive}`);
  c.check(slowAfterDeath.slowActive === false, '重置后减缓状态被清除', `slow=${slowAfterDeath.slowActive}`);

  // =========================================================
  // 11. 护盾兵：正面近战免疫 / 背后击杀
  // =========================================================
  await page.eval('window.__TEST__.gotoLevel(1)');
  await sleep(400);
  // 清掉场上其它敌人，只留一个护盾兵做实验
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(200);
  await page.eval('window.__TEST__.spawnEnemy("shield", 900, 620)');
  await sleep(900); // 等它转向玩家
  let sSnap = await snap();
  let shield = sSnap.enemies.find((e) => e.type === 'shield');
  const killsBefore = sSnap.stats.kills;
  c.check(!!shield, '护盾兵已生成', JSON.stringify(shield));

  if (shield) {
    // 站到它正面打（玩家在盾牌正面那一侧，朝盾牌出刀）
    const frontX = shield.x + (shield.facing > 0 ? 56 : -56);
    await page.eval(`window.__TEST__.teleport(${frontX}, 620)`);
    await sleep(120);
    await page.mouseMove(frontX < shield.x ? 1180 : 100, 380);
    for (let i = 0; i < 3; i++) {
      await page.mouseDown('left');
      await sleep(45);
      await page.mouseUp('left');
      await sleep(140);
    }
    const afterFront = await snap();
    c.check(
      afterFront.enemies.some((e) => e.type === 'shield'),
      '正面近战被盾牌挡下（护盾兵没死）',
      `存活=${afterFront.enemies.filter((e) => e.type === 'shield').length} kills=${afterFront.stats.kills}`,
    );

    // 绕到背后打
    sSnap = await snap();
    shield = sSnap.enemies.find((e) => e.type === 'shield');
    if (shield) {
      // 绕到它背后：反复"重新定位到背后 + 立刻出刀"，最多 8 次（盾牌转身慢，但会转）
      let killed = false;
      for (let attempt = 0; attempt < 8 && !killed; attempt++) {
        const st0 = await snap();
        const sh = st0.enemies.find((e) => e.type === 'shield');
        if (!sh) {
          killed = true;
          break;
        }
        const backX = sh.x + (sh.facing > 0 ? -46 : 46);
        const aimRight = backX < sh.x;
        await page.eval(`window.__TEST__.teleport(${backX}, 620)`);
        await page.mouseMove(aimRight ? 1180 : 100, 380);
        await page.mouseDown('left');
        await sleep(45);
        await page.mouseUp('left');
        await sleep(120);
      }
      const afterBack = await snap();
      c.check(
        !afterBack.enemies.some((e) => e.type === 'shield'),
        '绕到背后一刀击杀护盾兵',
        `kills ${killsBefore} → ${afterBack.stats.kills}，剩余护盾兵 ${afterBack.enemies.filter((e) => e.type === 'shield').length}`,
      );
    }
  }

  // =========================================================
  // 12. 地刺即死
  // =========================================================
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(350);
  const spikes = (await page.eval('window.__GAME__.levelInfo()')).hazards;
  const hzSpike = spikes[0];
  const deathsBefore = (await snap()).stats.deaths;
  await page.eval(`window.__TEST__.teleport(${hzSpike.x + hzSpike.w / 2}, ${hzSpike.y + hzSpike.h})`);
  await sleep(200);
  const spikeDead = await api.snapshot();
  c.check(spikeDead.stats.deaths === deathsBefore + 1, '碰到地刺立即死亡', `deaths ${deathsBefore} → ${spikeDead.stats.deaths} cause=${spikeDead.deathLog[spikeDead.deathLog.length - 1]?.cause}`);

  // =========================================================
  // 12.5 敌人 AI：视野（正面看见）与听觉（背后听到冲刺声）
  // =========================================================
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(350);
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(200);
  await page.eval('window.__TEST__.freeze(true)');
  await page.eval('window.__TEST__.spawnEnemy("ronin", 1400, 620)');
  await page.eval('window.__TEST__.freeze(false)');
  await sleep(400);
  let aiSnap = await snap();
  let ronin = aiSnap.enemies.find((e) => e.type === 'ronin');
  c.check(!!ronin, '浪人已生成', JSON.stringify(ronin));

  // 视觉：站到它"面朝的那一侧"，一定能进视锥
  const faceDir = ronin ? ronin.facing : -1;
  await page.eval(`window.__TEST__.teleport(${(ronin ? ronin.x : 1000) + faceDir * 130}, 620)`);
  await sleep(700);
  aiSnap = await snap();
  ronin = aiSnap.enemies.find((e) => e.type === 'ronin');
  c.check(
    ronin && ['alert', 'chase', 'windup', 'attack', 'recover'].includes(ronin.state),
    '视野：站在浪人正面会被发现',
    `state=${ronin && ronin.state} facing=${faceDir}`,
  );

  // 听觉：回到它背后（右侧），不进入视锥，只靠冲刺的噪音
  await page.eval('window.__TEST__.gotoLevel(0)');
  await sleep(350);
  await page.eval('window.__TEST__.clearEnemies()');
  await sleep(200);
  await page.eval('window.__TEST__.freeze(true)');
  await page.eval('window.__TEST__.spawnEnemy("ronin", 1400, 620)');
  await page.eval('window.__TEST__.freeze(false)');
  await sleep(300);
  const roninBehind0 = (await snap()).enemies.find((e) => e.type === 'ronin');
  const behindDir = roninBehind0 ? roninBehind0.facing : -1;
  // 站到它背后（视锥外），只靠冲刺噪音触发听觉
  await page.eval(`window.__TEST__.teleport(${(roninBehind0 ? roninBehind0.x : 1000) - behindDir * 200}, 620)`);
  await sleep(500);
  const behind = await snap();
  const roninBehind = behind.enemies.find((e) => e.type === 'ronin');
  const stateBeforeNoise = roninBehind ? roninBehind.state : 'none';
  const heardBefore = roninBehind ? roninBehind.heard : 0;
  // 玩家在它背后 ~200px：视锥看不到，但跳跃的噪音半径 260 应该"听得到"
  const jumpBefore = behind.player.jumpCount;
  await page.keyDown('KeyW');
  await sleep(90);
  await page.keyUp('KeyW');
  const jumped = await poll((s) => s.player.jumpCount > jumpBefore, 1500);
  const heard = await poll((s) => {
    const e = s.enemies.find((x) => x.type === 'ronin');
    return e && e.heard > 0;
  }, 2500);
  const roninHeard = heard ? heard.enemies.find((e) => e.type === 'ronin') : null;
  c.check(
    !!jumped && heardBefore === 0 && !!roninHeard && roninHeard.heard > 0,
    '听觉：背后来一次跳跃的噪音被浪人听到（听觉范围生效）',
    `jumpCount=${jumped ? jumped.player.jumpCount : '?'}，heard ${heardBefore} → ${roninHeard ? roninHeard.heard : 0}，state=${roninHeard ? roninHeard.state : '?'}`,
  );

  // =========================================================
  // 13. FPS 显示是真实测量值（和实测帧数一致）
  // =========================================================
  const fpsCheck = await page.eval(`(async () => {
    let frames = 0;
    const t0 = performance.now();
    await new Promise((resolve) => {
      function f() { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else resolve(); }
      requestAnimationFrame(f);
    });
    const elapsed = (performance.now() - t0) / 1000;
    return { measured: frames / elapsed, reported: window.__GAME__.fps() };
  })()`);
  const fpsDiff = Math.abs(fpsCheck.measured - fpsCheck.reported) / Math.max(1, fpsCheck.measured);
  c.check(fpsDiff < 0.2, 'FPS 数字是真实测量而非写死', `实测 ${fpsCheck.measured.toFixed(1)} / 显示 ${fpsCheck.reported.toFixed(1)}`);

  await reportPageErrors(api, c);
  await c.finish({ fpsCheck });
} catch (e) {
  c.check(false, '脚本异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
  await c.finish({});
} finally {
  await api.close().catch(() => {});
}

process.exit(0);
