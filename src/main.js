// ============================================================
// main.js —— 启动装配与主循环
// 启动后立即进入第一关：没有主菜单、没有开场动画、没有加载条。
// ============================================================
import { Renderer, VIEW_W, VIEW_H } from './core/render.js';
import { input } from './core/input.js';
import { TimeKeeper, FIXED_DT } from './core/loop.js';
import { Camera } from './core/camera.js';
import { Game } from './game/director.js';
import { Hud } from './game/hud.js';
import { installDebug } from './game/debug.js';
import { T } from './game/const.js';

const errors = [];

// ------------------------------------------------------------
// 音频：即使 audio.js 缺失/出错，也绝不能让游戏挂掉
// ------------------------------------------------------------
const silentAudio = new Proxy(
  {},
  {
    get: (t, k) => {
      if (k === 'ready') return false;
      return () => {};
    },
  },
);
let audio = silentAudio;
try {
  const m = await import('./core/audio.js');
  if (m && m.AudioSys) audio = m.AudioSys;
} catch (e) {
  errors.push('audio.js 加载失败: ' + (e && e.message));
  console.warn('[audio] 加载失败，使用静音兜底', e);
}

// ------------------------------------------------------------
// 背景
// ------------------------------------------------------------
let createBackdrop = null;
try {
  const m = await import('./core/backdrop.js');
  if (m && typeof m.createBackdrop === 'function') createBackdrop = m.createBackdrop;
} catch (e) {
  errors.push('backdrop.js 加载失败: ' + (e && e.message));
  console.warn('[backdrop] 加载失败，使用兜底背景', e);
}

/** 兜底背景：即使 backdrop.js 挂了，画面也不至于全黑 */
class FallbackBackdrop {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cv = document.createElement('canvas');
    this.cv.width = Math.max(64, Math.ceil(w));
    this.cv.height = Math.max(64, Math.ceil(h));
    const c = this.cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#07060f');
    g.addColorStop(0.5, '#120a20');
    g.addColorStop(1, '#1a0e2a');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const bw = 40 + Math.random() * 90;
      const bh = 100 + Math.random() * 320;
      const x = Math.random() * w;
      c.fillStyle = `rgba(18,14,34,${0.5 + Math.random() * 0.4})`;
      c.fillRect(x, h - 120 - bh, bw, bh);
    }
  }
  draw(ctx, cam) {
    const ox = -cam.x * 0.15;
    ctx.drawImage(this.cv, ox, 0);
    ctx.drawImage(this.cv, ox + this.cv.width, 0);
  }
  stats() {
    return { layers: 1, buildMs: 0, drawMsLast: 0, drawMsAvg: 0 };
  }
}

const backdropFactory = createBackdrop
  ? (o) => createBackdrop({ width: o.width, height: o.height, seed: o.seed })
  : (o) => new FallbackBackdrop(o.width, o.height);

// ------------------------------------------------------------
// 装配
// ------------------------------------------------------------
const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const time = new TimeKeeper();
const camera = new Camera(VIEW_W, VIEW_H, T.camBaseZoom);
input.attach(window);
input.setMapper((cx, cy) => renderer.clientToLogical(cx, cy));

const game = new Game({ renderer, input, audio, time, camera, backdropFactory });
const hud = new Hud();
game.hud = hud;
installDebug({ game, time, renderer, audio, input, errors });

// 首次输入时解锁音频（浏览器的自动播放策略要求）
input.onFirstInput = () => {
  try {
    audio.init && audio.init();
    audio.unlock && audio.unlock();
    audio.musicStart && audio.musicStart();
  } catch (e) {
    errors.push('audio 初始化失败: ' + (e && e.message));
  }
};

// ------------------------------------------------------------
// 错误上报（把异常显示出来，绝不静默黑屏）
// ------------------------------------------------------------
const fatalEl = document.getElementById('fatal');
function showFatal(text) {
  if (!fatalEl) return;
  fatalEl.style.display = 'block';
  fatalEl.textContent = text;
}
window.addEventListener('error', (e) => {
  errors.push('window.onerror: ' + (e.message || ''));
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  console.error(e.reason);
});

// ------------------------------------------------------------
// 主循环
// ------------------------------------------------------------
let frameCount = 0;
let lastErrorShown = 0;
let frozen = false; // 测试钩子：冻结画面（截图用）

function frame(now) {
  requestAnimationFrame(frame);
  try {
    if (frozen) {
      // 冻结时只重绘，不推进任何时间（让自动截图拿到确定的一帧）
      game.draw(0);
      return;
    }
    const dtReal = time.begin(now);
    game.beginFrame(dtReal);
    if (game.paused) {
      // 暂停：世界完全冻结（连积分器一起清掉，避免恢复时一次性补一大步）
      game.draw(0);
      time.reset();
      return;
    }
    time.updateScales(dtReal);

    const steps = time.takeSteps();
    // 玩家在每个世界物理步里推进的"真实秒数"：
    //   s = playerScale / worldScale（正常 1，子弹时间 0.6/0.15 = 4）
    // 世界每步是 1/120 世界秒；玩家按 s 倍的真实秒推进，所以相对世界快 s 倍。
    const playerDt = time.playerStepDt;
    for (let i = 0; i < steps; i++) {
      game.step(FIXED_DT, playerDt);
    }

    game.draw(time.alpha);
    frameCount++;
    if (frameCount === 2) {
      window.__READY__ = true;
      performance.mark('game-ready');
    }
  } catch (e) {
    // 一帧出错不至于整局卡死：记录 + 显示一次
    errors.push('frame error: ' + (e && e.stack ? e.stack : e));
    console.error(e);
    if (now - lastErrorShown > 2000) {
      lastErrorShown = now;
      showFatal('运行时错误（游戏仍在尝试继续运行）：\n\n' + (e && e.stack ? e.stack : e));
    }
  }
}

requestAnimationFrame(frame);

// 测试钩子：冻结/解冻画面（自动截图时用，正常游玩不会触发）
if (window.__TEST__) {
  window.__TEST__.freeze = (v) => {
    frozen = !!v;
    return frozen;
  };
}

// 供测试脚本判断"游戏已经跑起来了"
window.__BOOT__ = {
  version: '1.0.0',
  viewW: VIEW_W,
  viewH: VIEW_H,
  hasBackdrop: !!createBackdrop,
  hasAudio: audio !== silentAudio,
  errors,
};
