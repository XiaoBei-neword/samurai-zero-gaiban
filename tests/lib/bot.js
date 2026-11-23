// ============================================================
// tests/lib/bot.js —— 浏览器里跑的"自动驾驶机器人"
//
// 它通过 window.__GAME__ 读游戏状态，然后向 window 派发**真实的 DOM
// 键盘/鼠标事件**（和玩家按键走同一条代码路径：Input 事件监听 →
// 动作锁存 → 玩家状态机）。
//
// 注意（如实说明）：这是合成事件（isTrusted=false），验证的是
// "输入处理链路 + 游戏规则 + 关卡可通关性"，不是浏览器原生输入管线；
// 原生管线由 run_input.mjs 用 CDP 的 Input.dispatch* 覆盖。
//
// 行为策略：
//   1. 找最近敌人 → 冲刺（无敌帧）拉近 → 进入范围就劈砍
//   2. 有子弹靠近 → 按住 L 减缓时间 → 朝子弹挥刀反弹
//   3. 前方没地面 / 有地刺 → 跳；跳不过去再用空中冲刺
//   4. 护盾兵正面朝向自己 → 跳起来从上方劈
//   5. 清版后 → 走向门
// ============================================================

export function startBot(opts = {}) {
  const cfg = {
    tickMs: 40,
    attackRangeX: 86,
    attackRangeY: 56,
    dashRangeX: 240,
    maxMs: opts.maxMs || 240000,
  };

  const keyState = new Set();
  let lastClient = { x: 640, y: 360 };
  const mouseDownState = { left: false, middle: false };
  const log = [];

  function emitKey(code, down) {
    window.dispatchEvent(
      new KeyboardEvent(down ? 'keydown' : 'keyup', {
        code,
        key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function setKey(code, down) {
    down = !!down;
    if (down === keyState.has(code)) return;
    if (down) keyState.add(code);
    else keyState.delete(code);
    emitKey(code, down);
  }

  function emitMouse(button, down) {
    if (down === mouseDownState[button]) return;
    mouseDownState[button] = down;
    const btn = button === 'left' ? 0 : 1;
    window.dispatchEvent(
      new MouseEvent(down ? 'mousedown' : 'mouseup', {
        button: btn,
        buttons: down ? (button === 'left' ? 1 : 4) : 0,
        clientX: lastClient.x,
        clientY: lastClient.y,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function releaseAll() {
    for (const c of Array.from(keyState)) setKey(c, false);
    emitMouse('left', false);
    emitMouse('middle', false);
  }

  function aimWorld(wx, wy) {
    const cam = window.__GAME__.cam();
    const sx = (wx - cam.x) * cam.zoom + 640;
    const sy = (wy - cam.y) * cam.zoom + 360;
    const cv = document.getElementById('game');
    const r = cv.getBoundingClientRect();
    const clientX = r.left + (sx / 1280) * r.width;
    const clientY = r.top + (sy / 720) * r.height;
    lastClient = { x: clientX, y: clientY };
    window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true, cancelable: true }));
  }

  /** 某列是否有可站立的地面（脚底 y 附近） */
  function groundAt(x, feetY, info) {
    for (const s of info.solids) {
      if (x > s.x - 2 && x < s.x + s.w + 2 && feetY >= s.y - 10 && feetY <= s.y + 70) return s.y;
    }
    for (const o of info.oneway) {
      if (x > o.x - 2 && x < o.x + o.w + 2 && feetY >= o.y - 10 && feetY <= o.y + 26) return o.y;
    }
    return null;
  }

  /** 从 (x,y) 往下找地面，返回距离 */
  function groundBelow(x, feetY, info) {
    let best = Infinity;
    for (const s of info.solids) {
      if (x > s.x && x < s.x + s.w && s.y >= feetY - 4 && s.y - feetY < best) best = s.y - feetY;
    }
    for (const o of info.oneway) {
      if (x > o.x && x < o.x + o.w && o.y >= feetY - 4 && o.y - feetY < best) best = o.y - feetY;
    }
    return best;
  }

  function nearestEnemy(g) {
    let best = null;
    let bestScore = Infinity;
    for (const e of g.enemies) {
      if (!e.alive) continue;
      const score = Math.abs(e.x - g.player.x) + Math.abs(e.y - g.player.y) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  function nearestBullet(px, py) {
    let best = null;
    let bd = Infinity;
    for (const b of window.__TEST__.bullets()) {
      if (b.deflected || b.owner !== 'enemy') continue;
      const d = Math.hypot(b.x - px, b.y - (py - 26));
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best ? { b: best, d: bd } : null;
  }

  let startedAt = performance.now();
  let timer = null;
  let lastDeaths = -1;
  let lastX = 0;
  let stuckMs = 0;
  let jumpHoldUntil = 0;
  let dashUntil = 0;
  let attackUntil = 0;
  let lastTick = performance.now();

  function tick() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (now - startedAt > cfg.maxMs) {
      stop();
      return;
    }
    let g;
    try {
      g = window.__GAME__.snapshot();
    } catch {
      return;
    }

    if (g.state === 'victory') {
      releaseAll();
      log.push({ t: Math.round(now - startedAt), ev: 'victory', stats: g.stats });
      stop();
      return;
    }
    if (!g.player.alive) {
      releaseAll();
      return;
    }
    if (g.stats.deaths !== lastDeaths) {
      if (lastDeaths >= 0) log.push({ t: Math.round(now - startedAt), ev: 'died', deaths: g.stats.deaths, cause: g.deathCause });
      lastDeaths = g.stats.deaths;
      releaseAll();
    }

    const p = g.player;
    const info = window.__GAME__.levelInfo();

    // 卡住检测
    if (Math.abs(p.x - lastX) < 6) stuckMs += dt;
    else stuckMs = 0;
    lastX = p.x;

    // ---- 0. 计时器驱动的按键释放 ----
    if (jumpHoldUntil && now > jumpHoldUntil) {
      setKey('KeyW', false);
      jumpHoldUntil = 0;
    }
    if (dashUntil && now > dashUntil) {
      setKey('ShiftLeft', false);
      dashUntil = 0;
    }
    if (attackUntil && now > attackUntil) {
      emitMouse('left', false);
      attackUntil = 0;
    }

    // ---- 1. 子弹威胁 → 减缓（右键=减缓）----
    // 冲刺已经能躲子弹，所以这里只在能量够的时候减速以便看清 / 反打。
    const threat = nearestBullet(p.x, p.y);
    const bulletNear = threat && threat.d < 260;
    setKey('KeyL', !!bulletNear && p.energy > 12);
    if (threat && threat.d < 120 && p.energy > 12) {
      // 代价：放宽出手距离即可，具体判定交给扇形
      aimWorld(threat.b.x, threat.b.y);
      if (!attackUntil) {
        emitMouse('left', true);
        attackUntil = now + 45;
      }
      return;
    }

    // ---- 2. 清版 → 走向门 ----
    if (g.enemiesAlive === 0) {
      const doorCx = info.door.x + info.door.w / 2;
      setKey('KeyA', p.x > doorCx + 16);
      setKey('KeyD', p.x < doorCx - 16);
      if (p.y > info.door.y + info.door.h - 40) {
        setKey('KeyW', true);
        jumpHoldUntil = now + 180;
      }
      return;
    }

    const tgt = nearestEnemy(g);
    if (!tgt) return;
    const dx = tgt.x - p.x;
    const dy = tgt.y - p.y;
    const adx = Math.abs(dx);
    const dirX = dx >= 0 ? 1 : -1;

    // ---- 3. 落脚点判断（防掉坑 / 防掉崖）----
    const feetY = p.y;
    const aheadX = p.x + dirX * 46;
    const aheadGround = groundAt(aheadX, feetY, info);
    const wideGap = groundAt(p.x + dirX * 110, feetY, info) === null;
    const gapAhead = p.grounded && aheadGround === null;

    // 前方地刺
    let hazardAhead = false;
    for (const hz of info.hazards) {
      const near = hz.x < p.x + dirX * 80 && hz.x + hz.w > p.x + dirX * 20;
      if (near && Math.abs(hz.y - p.y) < 60) hazardAhead = true;
    }
    // 正下方是否有地刺（正在坠落）
    let hazardBelow = false;
    if (!p.grounded && p.vy > 80) {
      for (const hz of info.hazards) {
        if (p.x > hz.x - 10 && p.x < hz.x + hz.w + 10 && hz.y > p.y && hz.y - p.y < 160) hazardBelow = true;
      }
    }

    // ---- 4. 护盾兵：正面免疫近战 → 贴近后等冲刺冷却好，一次穿到背后 ----
    if (tgt.type === 'shield') {
      // 玩家在盾牌的哪一侧：和盾牌朝向同号就是"正面"
      const front = Math.sign(p.x - tgt.x) === (tgt.facing || 1) || Math.abs(tgt.x - p.x) < 8;
      if (front && adx < 200) {
        if (adx < 105 && p.dashCd <= 0 && p.grounded) {
          // 冲刺 990*0.14 ≈ 139px，从 105px 内出发才穿得过去
          setKey('ShiftLeft', true);
          dashUntil = now + 70;
          setKey('KeyD', dx > 0);
          setKey('KeyA', dx < 0);
          return;
        }
        if (adx < 105) {
          // 冲刺还没好：先退开，别贴着脸挨盾撞
          setKey('KeyA', dx > 0);
          setKey('KeyD', dx < 0);
          setKey('ShiftLeft', false);
          return;
        }
        // 还远：正常走过去
        setKey('KeyD', dx > 0);
        setKey('KeyA', dx < 0);
        setKey('ShiftLeft', false);
        return;
      }
    }

    // ---- 5. 攻击优先：够得着就先出刀（比对方的蓄力快，稳赢）----
    const inRange = adx <= cfg.attackRangeX && Math.abs(dy) <= cfg.attackRangeY;
    if (inRange) {
      setKey('KeyA', false);
      setKey('KeyD', false);
      setKey('ShiftLeft', false);
      aimWorld(tgt.x, tgt.y - 28);
      if (!attackUntil) {
        emitMouse('left', true);
        attackUntil = now + 45;
      }
      return;
    }

    // ---- 6. 对方在蓄力/盾冲准备 → 用冲刺的无敌帧后撤 ----
    const dangerous =
      tgt.state === 'windup' || tgt.state === 'attack' || tgt.state === 'bash' || tgt.state === 'bashWindup';
    if (dangerous && adx < 120 && dy > -80) {
      setKey('ShiftLeft', true);
      dashUntil = now + 60;
      setKey('KeyA', dx > 0);
      setKey('KeyD', dx < 0);
      return;
    }

    // ---- 6. 移动 / 跳跃 / 冲刺 ----
    // 紧急：脚下/身前马上就是尖刺 → 立刻跳
    if (p.grounded) {
      for (const hz of info.hazards) {
        const overlapX = hz.x < p.x + 34 && hz.x + hz.w > p.x - 34;
        if (overlapX && Math.abs(p.y - hz.y) < 40 && p.y > hz.y - 30) {
          setKey('KeyW', true);
          jumpHoldUntil = now + 220;
          setKey('KeyD', dx > 0);
          setKey('KeyA', dx < 0);
          return;
        }
      }
    }
    // 目标在上方、而我正站在"托着它的那块平台"正下方 → 先横着走到平台边缘外面再跳
    if (dy < -60) {
      for (const s of info.solids) {
        const supports = tgt.x >= s.x - 6 && tgt.x <= s.x + s.w + 6 && Math.abs(s.y - tgt.y) < 10;
        if (!supports) continue;
        if (p.x > s.x + 8 && p.x < s.x + s.w - 8) {
          const goRight = s.x + s.w - p.x < p.x - s.x;
          setKey('KeyD', goRight);
          setKey('KeyA', !goRight);
          setKey('ShiftLeft', false);
          if (p.grounded) {
            setKey('KeyW', true);
            jumpHoldUntil = now + 240;
          }
          return;
        }
      }
    }

    // 站在台上、敌人在下面：朝最近的平台边缘走过去掉下去（这游戏没有"下"键）
    if (dy > 60 && Math.abs(dx) < 60 && p.grounded) {
      let plat = null;
      for (const s of info.solids) {
        if (p.x >= s.x - 2 && p.x <= s.x + s.w + 2 && Math.abs(s.y - p.y) < 8) plat = s;
      }
      for (const o of info.oneway) {
        if (p.x >= o.x - 2 && p.x <= o.x + o.w + 2 && Math.abs(o.y - p.y) < 8) plat = o;
      }
      if (plat) {
        const goRight = plat.x + plat.w - p.x < p.x - plat.x;
        setKey('KeyD', goRight);
        setKey('KeyA', !goRight);
        setKey('KeyW', false);
        setKey('ShiftLeft', false);
        return;
      }
    }

    // 目标在明显下方时，必须走到台子边缘掉下去（这游戏没有"下"键）
    const horizThresh = Math.abs(dy) > 60 ? 4 : 10;
    setKey('KeyD', dx > horizThresh);
    setKey('KeyA', dx < -horizThresh);
    if (stuckMs > 1200) {
      // 卡住了就来回横move 一下找路
      const d = Math.floor(now / 800) % 2 === 0 ? 1 : -1;
      setKey('KeyD', d > 0);
      setKey('KeyA', d < 0);
    }

    // 需要往上（敌人在高处）
    const needRise = dy < -60 && adx < 190;
    // 空中：如果下落且下方没有地面或下方是刺 → 空中冲刺找活路
    if (!p.grounded && p.vy > 60) {
      const below = groundBelow(p.x + dirX * 60, p.y, info);
      if ((below === Infinity || hazardBelow) && p.y > 300) {
        setKey('ShiftLeft', true);
        dashUntil = now + 80;
      }
    }
    // 起跳条件：窄坑 / 地刺 / 需要上去 / 卡住
    if ((gapAhead || hazardAhead || needRise || stuckMs > 900) && p.grounded) {
      setKey('KeyW', true);
      jumpHoldUntil = now + (wideGap ? 260 : 170);
      if ((wideGap || stuckMs > 1200) && adx > 60) {
        setKey('ShiftLeft', true);
        dashUntil = now + 70;
      }
      stuckMs = 0;
      return;
    }
    // 空中补一次二段跳：敌人明显在上方、自己正在减速上升时
    if (!p.grounded && p.jumpsLeft > 0 && p.vy > -140 && (dy < -70 || (gapAhead && p.vy > -30))) {
      setKey('KeyW', false);
      setTimeout(() => {
        setKey('KeyW', true);
        jumpHoldUntil = performance.now() + 200;
      }, 16);
    }
    // 远距离冲刺拉近（无敌帧，顺便躲子弹）
    if (adx > 160 && adx < cfg.dashRangeX && p.grounded && !dashUntil) {
      setKey('ShiftLeft', true);
      dashUntil = now + 60;
    }
    // 贴脸随时补刀
    if (adx < cfg.attackRangeX + 34 && Math.abs(dy) < 60) {
      aimWorld(tgt.x, tgt.y - 26);
      if (!attackUntil) {
        emitMouse('left', true);
        attackUntil = now + 45;
      }
    }
  }

  function start() {
    startedAt = performance.now();
    lastTick = startedAt;
    timer = setInterval(tick, cfg.tickMs);
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    releaseAll();
  }

  const api = {
    start,
    stop,
    cfg,
    log,
    get running() {
      return !!timer;
    },
    report: () => ({
      elapsedMs: Math.round(performance.now() - startedAt),
      log,
      snapshot: window.__GAME__.snapshot(),
    }),
  };
  start();
  return api;
}
