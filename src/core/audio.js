/**
 * audio.js — 武士零丐版 · 全程序化音频
 * ------------------------------------------------------------
 * 零素材、零依赖、纯 Web Audio API 实时合成：
 *   · 全部音效 = 振荡器 + 预生成噪声缓冲 + 滤波器 + 包络
 *   · 背景音乐 = 4 小节程序化 loop（三角脉冲 / 方波琶音 / 噪声 hat /
 *     战斗层锯齿贝斯与鼓组），25ms lookahead 调度（A Tale of Two Clocks）
 *
 * 设计底线：
 *   1. 任何 API 都不抛异常（AudioContext 不存在 / 被策略拦截 / 无输出设备）。
 *   2. 一次性音效自动 stop + disconnect；长跑不累积 AudioNode。
 *   3. 噪声缓冲、混响 IR 只在 init() 生成一次，之后复用。
 *
 * 公开 API（游戏只依赖这些）：
 *   init() / unlock() / ready / setMasterVolume(v) / setSlow(amount)
 *   setCombat(on) / musicStart() / musicStop() / play(name, opts)
 *
 * 额外调试接口（夹具用，不影响契约）：
 *   getStats() -> { ctxState, nodeCountEstimate, voiceCount, ... }
 */

// ------------------------------------------------------------
// 常量与工具
// ------------------------------------------------------------

const SFX_NAMES = Object.freeze([
  'slash', 'slashHit', 'kill', 'gunshot', 'enemyShoot',
  'dash', 'jump', 'doubleJump', 'land', 'wallSlide',
  'pickup', 'throw', 'deflect', 'bulletRicochet', 'death',
  'respawn', 'doorOpen', 'levelClear', 'victory', 'shieldBlock',
  'empty', 'spikeDeath', 'slowIn', 'slowOut', 'uiClick',
]);

const MUSIC_BPM = 92;
const MUSIC_STEP = 60 / MUSIC_BPM / 4;       // 十六分音符 0.163s
const MUSIC_STEPS = 64;                      // 4 小节 × 16 步，loop 长度 10.43s
const MUSIC_LEVEL = 0.115;                   // 音乐总线 ≈ -18.8dB
const MUSIC_LOOKAHEAD = 0.12;                // 秒
const MUSIC_TICK_MS = 25;

const SFX_BUS_LEVEL = 0.9;
const MAX_VOICES = 56;                       // 同时存活的合成声部上限
const VOICE_ABSOLUTE_MAX_AGE = 30000;        // 墙钟兜底（ms）
const GC_INTERVAL_MS = 1000;

const DEFAULT_THROTTLE_MS = 45;
const THROTTLES = Object.freeze({
  uiClick: 35,
  empty: 40,
  gunshot: 50,
  enemyShoot: 50,
  deflect: 55,
  slash: 45,
  slashHit: 45,
  kill: 45,
  dash: 50,
  jump: 45,
  doubleJump: 45,
  land: 45,
  wallSlide: 60,
  pickup: 45,
  throw: 45,
  bulletRicochet: 45,
  shieldBlock: 50,
  respawn: 80,
  slowIn: 120,
  slowOut: 120,
  doorOpen: 160,
  death: 250,
  spikeDeath: 200,
  levelClear: 300,
  victory: 1600,
});

// D 小调 / 和声小调：i - VI - iv - V
const CHORDS = Object.freeze([
  { root: 73.42, arp: [293.66, 349.23, 440.00, 587.33] }, // Dm
  { root: 58.27, arp: [233.08, 293.66, 349.23, 466.16] }, // Bb
  { root: 98.00, arp: [392.00, 466.16, 587.33, 783.99] }, // Gm
  { root: 110.00, arp: [440.00, 554.37, 659.25, 880.00] }, // A（含 C#，和声小调 V）
]);

const musicArpSteps = [2, 6, 10, 13];
const musicBassSteps = [0, 2, 3, 6, 8, 10, 11, 14];

// ------------------------------------------------------------
// 内部状态
// ------------------------------------------------------------

let ctx = null;
let master = null;
let slowFilter = null;
let compressor = null;
let sfxBus = null;
let reverbConvolver = null;
let reverbReturn = null;
let noiseBuffer = null;

let initAttempted = false;
let disabled = false;
let initError = '';
let masterVolume = 0.8;
let slowAmount = 0;
let musicDetuneCents = 0;
let combatOn = false;

let liveNodeCount = 0;
let voiceSerial = 0;
let droppedVoices = 0;
let totalPlays = 0;
const voices = new Set();
const lastPlayAt = Object.create(null);

let musicGraph = null;
let musicTimer = null;
let musicStopTimer = null;
let musicPlaying = false;
let musicStep = 0;
let musicNextTime = 0;

let gcTimer = null;

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function num(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function msNow() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/** 半音 -> 频率倍率 */
function semitone(n) {
  return Math.pow(2, n / 12);
}

/** 平滑地逼近日标值（指数趋近，听感自然） */
function smoothParam(param, value, time, timeConstant) {
  if (!param) return;
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(param.value, time);
    }
    param.setTargetAtTime(value, time, Math.max(0.005, timeConstant));
  } catch (_) {
    try { param.value = value; } catch (_e) { /* noop */ }
  }
}

/** 线性渐变到目标值（允许 0） */
function linearParam(param, value, time, duration) {
  if (!param) return;
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(param.value, time);
    }
    param.linearRampToValueAtTime(value, time + Math.max(0.005, duration));
  } catch (_) {
    try { param.value = value; } catch (_e) { /* noop */ }
  }
}

// ------------------------------------------------------------
// 预生成缓冲（只做一次）
// ------------------------------------------------------------

function makeNoiseBuffer(ac, seconds) {
  const length = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    // 轻微一阶低通：更接近"模拟磁带噪声"，也给高频留足能量
    lp = lp * 0.15 + white * 0.85;
    data[i] = lp;
  }
  return buffer;
}

function makeImpulseBuffer(ac, seconds, decay) {
  const length = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buffer = ac.createBuffer(2, length, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // 早期反射 + 指数衰减尾巴；左右声道各自随机，得到自然的宽度
      const early = i < ac.sampleRate * 0.012 ? 0.5 : 1;
      data[i] = (Math.random() * 2 - 1) * early * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}

// ------------------------------------------------------------
// 声部与节点生命周期
// ------------------------------------------------------------

function addNode(v, node) {
  v.nodes.push(node);
  liveNodeCount++;
  return node;
}

function trackSource(v, src, stopAt) {
  v.sources.push(src);
  v.pending++;
  if (stopAt > v.endAt) v.endAt = stopAt;
  try {
    src.onended = () => {
      if (v.dead) return;
      v.pending--;
      if (v.pending <= 0) cleanupVoice(v);
    };
  } catch (_) { /* noop */ }
}

function cleanupVoice(v) {
  if (!v || v.dead) return;
  v.dead = true;
  for (let i = 0; i < v.nodes.length; i++) {
    try { v.nodes[i].disconnect(); } catch (_) { /* noop */ }
  }
  liveNodeCount -= v.nodes.length;
  if (liveNodeCount < 0) liveNodeCount = 0;
  v.nodes.length = 0;
  v.sources.length = 0;
  v.oscs.length = 0;
  voices.delete(v);
}

function killVoice(v) {
  if (!v || v.dead) return;
  for (let i = 0; i < v.sources.length; i++) {
    try {
      v.sources[i].onended = null;
      v.sources[i].stop();
    } catch (_) { /* already stopped */ }
  }
  cleanupVoice(v);
}

function trimOldestVoice() {
  let victim = null;
  for (const v of voices) {
    if (v.isMusic) continue;
    victim = v;
    break;
  }
  if (!victim) {
    for (const v of voices) { victim = v; break; }
  }
  if (!victim) return false;
  killVoice(victim);
  droppedVoices++;
  return true;
}

function createVoice(options) {
  if (!ctx) return null;
  const o = options || {};
  while (voices.size >= MAX_VOICES) {
    if (!trimOldestVoice()) break;
  }
  if (voices.size >= MAX_VOICES) return null;

  const v = {
    nodes: [],
    sources: [],
    oscs: [],
    pending: 0,
    dead: false,
    endAt: 0,
    born: msNow(),
    bornAt: num(ctx.currentTime, 0),
    serial: ++voiceSerial,
    isMusic: !!o.music,
    panNode: null,
    out: null,
  };

  try {
    const out = ctx.createGain();
    out.gain.value = o.level == null ? 1 : Math.max(0, o.level);
    addNode(v, out);
    v.out = out;

    let tail = out;
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(num(o.pan, 0), -1, 1);
      tail.connect(pan);
      addNode(v, pan);
      v.panNode = pan;
      tail = pan;
    }

    const dest = o.dest || sfxBus;
    if (dest) tail.connect(dest);

    if (o.delaySend > 0 && musicGraph) {
      const send = ctx.createGain();
      send.gain.value = clamp(o.delaySend, 0, 2);
      tail.connect(send);
      send.connect(musicGraph.send);
      addNode(v, send);
    }

    if (o.wet > 0 && reverbConvolver) {
      const send = ctx.createGain();
      send.gain.value = clamp(o.wet, 0, 2);
      tail.connect(send);
      send.connect(reverbConvolver);
      addNode(v, send);
    }

    voices.add(v);
    return v;
  } catch (_) {
    // 极端情况下（节点创建失败）也不让部分节点泄漏
    cleanupVoice(v);
    return null;
  }
}

function gcVoices() {
  if (!ctx) return;
  const running = ctx.state === 'running';
  const audioTime = num(ctx.currentTime, 0);
  const wall = msNow();
  const list = Array.from(voices);
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.dead) continue;
    const age = wall - v.born;
    if (running && v.endAt + 1.5 < audioTime) {
      killVoice(v);
      continue;
    }
    if (!running && age > 2500) {
      killVoice(v);
      continue;
    }
    // 墙钟兜底：有些 headless/无输出设备环境 state 仍报 running，但
    // AudioContext.currentTime 不推进，onended 也不会来。此时按预计寿命
    // + 4s 回收，避免节点计数看起来像泄漏。
    const lifeMs = Math.max(0, v.endAt - v.bornAt) * 1000;
    if (age > lifeMs + 4000) {
      killVoice(v);
      continue;
    }
    if (age > VOICE_ABSOLUTE_MAX_AGE) killVoice(v);
  }
}

// ------------------------------------------------------------
// 合成原语
// ------------------------------------------------------------

/**
 * 单振荡器 + 包络（+ 可选滤波）。
 * o: { t0, type, f0, f1, dur, gain, attack, filter, detune }
 */
function tone(v, o) {
  if (!ctx || !v || v.dead) return;
  const t0 = num(o.t0, ctx.currentTime + 0.006);
  const dur = Math.max(0.012, num(o.dur, 0.2));
  const end = t0 + dur;

  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  addNode(v, osc);

  const f0 = Math.max(8, num(o.f0, 440));
  osc.frequency.setValueAtTime(f0, t0);
  const f1 = num(o.f1, 0);
  if (f1 > 0 && Math.abs(f1 - f0) > 0.5) {
    const sweep = clamp(num(o.sweep, 1), 0.05, 1.5);
    const sweepAt = t0 + dur * sweep;
    if (o.linear) osc.frequency.linearRampToValueAtTime(Math.max(8, f1), sweepAt);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(8, f1), sweepAt);
  }

  let detune = num(o.detune, 0);
  if (v.isMusic) {
    detune += musicDetuneCents;
    osc._baseDetune = num(o.detune, 0);
    v.oscs.push(osc);
  }
  if (detune !== 0) osc.detune.value = detune;

  let input = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter.type || 'lowpass';
    const ff0 = Math.max(20, num(o.filter.f0, 1200));
    f.frequency.setValueAtTime(ff0, t0);
    const ff1 = num(o.filter.f1, 0);
    if (ff1 > 0) {
      f.frequency.exponentialRampToValueAtTime(
        Math.max(20, ff1),
        t0 + dur * clamp(num(o.filter.sweep, 1), 0.05, 1.5)
      );
    }
    f.Q.value = clamp(num(o.filter.q, 0.7), 0.0001, 30);
    osc.connect(f);
    addNode(v, f);
    input = f;
  }

  const g = ctx.createGain();
  addNode(v, g);
  const peak = Math.max(0.0004, num(o.gain, 0.2));
  const attack = Math.max(0.001, num(o.attack, 0.004));
  const peakAt = Math.min(t0 + attack, end - 0.003);
  g.gain.setValueAtTime(0.0001, t0);
  if (peakAt > t0) g.gain.exponentialRampToValueAtTime(peak, peakAt);
  else g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  input.connect(g);
  g.connect(v.out);

  osc.start(t0);
  osc.stop(end + 0.03);
  trackSource(v, osc, end + 0.03);
}

/**
 * 噪声爆发（循环复用同一 AudioBuffer）。
 * o: { t0, dur, gain, attack, rate, hp, lp, bp:{f0,f1,q} }
 */
function noise(v, o) {
  if (!ctx || !v || v.dead || !noiseBuffer) return;
  const t0 = num(o.t0, ctx.currentTime + 0.006);
  const dur = Math.max(0.014, num(o.dur, 0.1));
  const end = t0 + dur;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  src.playbackRate.value = clamp(num(o.rate, 1), 0.25, 4);
  addNode(v, src);

  let input = src;

  if (o.bp) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    const ff0 = Math.max(20, num(o.bp.f0, 1500));
    f.frequency.setValueAtTime(ff0, t0);
    const ff1 = num(o.bp.f1, 0);
    if (ff1 > 0) {
      f.frequency.exponentialRampToValueAtTime(
        Math.max(20, ff1),
        t0 + dur * clamp(num(o.bp.sweep, 1), 0.05, 1.5)
      );
    }
    f.Q.value = clamp(num(o.bp.q, 1), 0.0001, 30);
    input.connect(f);
    addNode(v, f);
    input = f;
  }

  if (o.hp != null) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = Math.max(20, num(o.hp, 4000));
    f.Q.value = 0.7;
    input.connect(f);
    addNode(v, f);
    input = f;
  }

  if (o.lp != null) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.max(20, num(o.lp, 5000));
    f.Q.value = 0.7;
    input.connect(f);
    addNode(v, f);
    input = f;
  }

  const g = ctx.createGain();
  addNode(v, g);
  const peak = Math.max(0.0004, num(o.gain, 0.2));
  const attack = Math.max(0.001, num(o.attack, 0.003));
  const peakAt = Math.min(t0 + attack, end - 0.002);
  g.gain.setValueAtTime(0.0001, t0);
  if (peakAt > t0) g.gain.exponentialRampToValueAtTime(peak, peakAt);
  else g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  input.connect(g);
  g.connect(v.out);

  // 循环源随机取一个相位，避免每发噪声完全一样
  const maxOffset = Math.max(0, noiseBuffer.duration - 0.25);
  try { src.start(t0, Math.random() * maxOffset); } catch (_) { src.start(t0); }
  src.stop(end + 0.03);
  trackSource(v, src, end + 0.03);
}

/** 一组非谐波正弦分量（金属 / 撞击用） */
function metal(v, o) {
  if (!ctx || !v) return;
  const t0 = num(o.t0, ctx.currentTime + 0.006);
  const list = o.partials || [
    { r: 1, g: 0.15, d: 0.4 },
    { r: 2.76, g: 0.08, d: 0.3 },
    { r: 4.07, g: 0.045, d: 0.22 },
  ];
  const base = Math.max(20, num(o.base, 1200));
  const ratio = num(o.ratio, 1);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    tone(v, {
      type: 'sine',
      t0: t0 + num(p.delay, 0),
      f0: base * p.r * ratio,
      f1: base * p.r * ratio * 0.985,
      dur: num(o.dur, 0.45) * num(p.d, 1),
      gain: num(o.gain, 0.2) * num(p.g, 1),
      attack: num(o.attack, 0.001),
      detune: num(p.detune, 0),
      filter: o.filter,
    });
  }
}

/** 声像扫频（dash 用） */
function panSweep(v, t0, dur, from, to) {
  if (!v || !v.panNode) return;
  try {
    const p = v.panNode.pan;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(clamp(from, -1, 1), t0);
    p.linearRampToValueAtTime(clamp(to, -1, 1), t0 + Math.max(0.02, dur));
  } catch (_) { /* noop */ }
}

// ------------------------------------------------------------
// 音效配方（25 个）
// 每个函数签名 (t0, r, g, pan)：r = 半音倍率，g = 外部增益，pan = 声像
// ------------------------------------------------------------

const SOUNDS = {
  // 挥刀：高频噪声嘶声 + 空气爆裂，刀锋金属泛音
  slash(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.035 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.24, gain: 0.46, attack: 0.012,
      bp: { f0: 3000 * r, f1: 620 * r, q: 1.2, sweep: 0.85 },
      hp: 420,
    });
    noise(v, {
      t0: t0 + 0.012, dur: 0.14, gain: 0.17, attack: 0.006,
      bp: { f0: 5200 * r, f1: 2400 * r, q: 2.2 },
      hp: 1500,
    });
    tone(v, { type: 'sine', t0, f0: 3600 * r, f1: 2100 * r, dur: 0.13, gain: 0.07, attack: 0.002 });
    tone(v, { type: 'triangle', t0, f0: 760 * r, f1: 320 * r, dur: 0.16, gain: 0.08, attack: 0.004 });
  },

  // 刀刃入肉：低频冲击 + 闷响 + 短噪声
  slashHit(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.05 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 165 * r, f1: 46 * r, dur: 0.17, gain: 0.55, attack: 0.002 });
    tone(v, { type: 'triangle', t0, f0: 92 * r, f1: 38 * r, dur: 0.2, gain: 0.2, attack: 0.003 });
    noise(v, {
      t0, dur: 0.13, gain: 0.34, attack: 0.002,
      bp: { f0: 900 * r, f1: 280 * r, q: 0.8 },
      lp: 2600,
    });
    noise(v, { t0, dur: 0.075, gain: 0.18, attack: 0.001, bp: { f0: 380 * r, q: 1.1 }, lp: 1800 });
  },

  // 击杀：更重的下坠 + 碎裂噪声颗粒
  kill(t0, r, g, pan) {
    const v = createVoice({ level: 1.05 * g, pan, wet: 0.06 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 132 * r, f1: 34 * r, dur: 0.33, gain: 0.58, attack: 0.002 });
    tone(v, { type: 'square', t0, f0: 65 * r, f1: 28 * r, dur: 0.3, gain: 0.12, attack: 0.003, filter: { type: 'lowpass', f0: 320, q: 1 } });
    noise(v, {
      t0, dur: 0.3, gain: 0.44, attack: 0.002,
      bp: { f0: 800 * r, f1: 170 * r, q: 0.7, sweep: 0.9 },
      lp: 3200,
    });
    noise(v, { t0: t0 + 0.01, dur: 0.18, gain: 0.18, attack: 0.004, bp: { f0: 2800 * r, f1: 500 * r, q: 1.4 } });
    for (let i = 0; i < 3; i++) {
      noise(v, {
        t0: t0 + 0.035 + i * 0.055 + Math.random() * 0.025,
        dur: 0.045,
        gain: 0.09,
        attack: 0.001,
        hp: 3600 + Math.random() * 2600,
      });
    }
  },

  // 手枪：爆裂 + 低频膛压 + 短尾音
  gunshot(t0, r, g, pan) {
    const v = createVoice({ level: 1.1 * g, pan, wet: 0.04 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.1, gain: 0.62, attack: 0.001,
      bp: { f0: 5000 * r, f1: 500 * r, q: 0.9, sweep: 0.8 },
      hp: 180,
    });
    tone(v, { type: 'sine', t0, f0: 185 * r, f1: 48 * r, dur: 0.16, gain: 0.48, attack: 0.001 });
    tone(v, { type: 'square', t0, f0: 88 * r, f1: 35 * r, dur: 0.1, gain: 0.11, filter: { type: 'lowpass', f0: 700, q: 1 } });
    noise(v, { t0: t0 + 0.085, dur: 0.22, gain: 0.09, attack: 0.012, lp: 1300 });
  },

  // 敌人开枪：更闷、更钝，尾巴更长
  enemyShoot(t0, r, g, pan) {
    const v = createVoice({ level: 0.95 * g, pan, wet: 0.03 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.11, gain: 0.5, attack: 0.001,
      bp: { f0: 2200 * r, f1: 320 * r, q: 0.8, sweep: 0.8 },
      lp: 2600,
    });
    tone(v, { type: 'sine', t0, f0: 150 * r, f1: 52 * r, dur: 0.17, gain: 0.38, attack: 0.002 });
    tone(v, { type: 'triangle', t0, f0: 72 * r, f1: 32 * r, dur: 0.16, gain: 0.14, filter: { type: 'lowpass', f0: 500, q: 1 } });
    noise(v, { t0: t0 + 0.07, dur: 0.25, gain: 0.08, attack: 0.02, lp: 900 });
  },

  // 冲刺：低频呼啸 + 左右反相扫频
  dash(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.03 });
    if (!v) return;
    panSweep(v, t0, 0.3, -0.7, 0.7);
    noise(v, {
      t0, dur: 0.32, gain: 0.48, attack: 0.02,
      bp: { f0: 150 * r, f1: 1200 * r, q: 0.8, sweep: 0.75 },
    });
    noise(v, {
      t0: t0 + 0.01, dur: 0.3, gain: 0.18, attack: 0.006,
      bp: { f0: 1800 * r, f1: 260 * r, q: 0.7, sweep: 0.9 },
    });
    tone(v, { type: 'sine', t0, f0: 85 * r, f1: 40 * r, dur: 0.28, gain: 0.3, attack: 0.008 });
    tone(v, { type: 'triangle', t0, f0: 180 * r, f1: 70 * r, dur: 0.2, gain: 0.07, attack: 0.01 });
  },

  // 起跳
  jump(t0, r, g, pan) {
    const v = createVoice({ level: 0.9 * g, pan, wet: 0.02 });
    if (!v) return;
    tone(v, { type: 'triangle', t0, f0: 330 * r, f1: 560 * r, dur: 0.11, gain: 0.2, attack: 0.003 });
    tone(v, { type: 'sine', t0, f0: 660 * r, f1: 760 * r, dur: 0.08, gain: 0.06, attack: 0.002 });
    noise(v, { t0, dur: 0.04, gain: 0.045, attack: 0.001, hp: 2800 });
  },

  // 二段跳：更高、带五度和声
  doubleJump(t0, r, g, pan) {
    const v = createVoice({ level: 0.92 * g, pan, wet: 0.03 });
    if (!v) return;
    tone(v, { type: 'triangle', t0, f0: 520 * r, f1: 820 * r, dur: 0.15, gain: 0.16, attack: 0.003 });
    tone(v, { type: 'sine', t0, f0: 780 * r, f1: 1230 * r, dur: 0.15, gain: 0.1, attack: 0.003 });
    tone(v, { type: 'sine', t0, f0: 1560 * r, f1: 1640 * r, dur: 0.1, gain: 0.035, attack: 0.002 });
    noise(v, { t0, dur: 0.06, gain: 0.05, attack: 0.002, hp: 3200 });
  },

  // 落地
  land(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.02 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 105 * r, f1: 40 * r, dur: 0.15, gain: 0.32, attack: 0.002 });
    tone(v, { type: 'triangle', t0, f0: 70 * r, f1: 35 * r, dur: 0.13, gain: 0.12, attack: 0.003 });
    noise(v, { t0, dur: 0.11, gain: 0.18, attack: 0.001, lp: 900, bp: { f0: 500 * r, f1: 180 * r, q: 0.8 } });
  },

  // 贴墙滑：短促的沙沙摩擦
  wallSlide(t0, r, g, pan) {
    const v = createVoice({ level: 0.8 * g, pan, wet: 0.02 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.14, gain: 0.16, attack: 0.012,
      bp: { f0: 2800 * r, f1: 1500 * r, q: 1.4 },
      hp: 900,
    });
    noise(v, { t0: t0 + 0.01, dur: 0.1, gain: 0.055, attack: 0.01, hp: 5200 });
  },

  // 拾取：两音上行 blip
  pickup(t0, r, g, pan) {
    const v = createVoice({ level: 0.9 * g, pan, wet: 0.04 });
    if (!v) return;
    tone(v, { type: 'triangle', t0, f0: 880 * r, dur: 0.1, gain: 0.15, attack: 0.002 });
    tone(v, { type: 'triangle', t0: t0 + 0.08, f0: 1320 * r, dur: 0.14, gain: 0.13, attack: 0.002 });
    tone(v, { type: 'sine', t0: t0 + 0.08, f0: 1760 * r, dur: 0.08, gain: 0.03, attack: 0.002 });
  },

  // 投掷：比 slash 更低更钝的呼啸
  throw(t0, r, g, pan) {
    const v = createVoice({ level: 0.95 * g, pan, wet: 0.03 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.2, gain: 0.32, attack: 0.012,
      bp: { f0: 600 * r, f1: 2000 * r, q: 0.9 },
      hp: 250,
    });
    tone(v, { type: 'sine', t0, f0: 240 * r, f1: 110 * r, dur: 0.18, gain: 0.14, attack: 0.004 });
    tone(v, { type: 'triangle', t0, f0: 480 * r, f1: 240 * r, dur: 0.14, gain: 0.05, attack: 0.004 });
  },

  // 弹反：金属"叮"，非谐波分量 + 短混响
  deflect(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.45 });
    if (!v) return;
    metal(v, {
      t0, base: 2200 * r, dur: 0.55, gain: 0.2,
      partials: [
        { r: 1, g: 0.16, d: 0.55 },
        { r: 2.76, g: 0.09, d: 0.4 },
        { r: 4.07, g: 0.05, d: 0.28 },
        { r: 5.43, g: 0.03, d: 0.2 },
      ],
    });
    noise(v, { t0, dur: 0.05, gain: 0.12, attack: 0.001, hp: 4500 });
    tone(v, { type: 'sine', t0, f0: 4800 * r, f1: 4500 * r, dur: 0.25, gain: 0.022, attack: 0.001 });
  },

  // 流弹弹地
  bulletRicochet(t0, r, g, pan) {
    const v = createVoice({ level: 0.9 * g, pan, wet: 0.22 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 3200 * r, f1: 1100 * r, dur: 0.14, gain: 0.13, attack: 0.001 });
    tone(v, { type: 'triangle', t0, f0: 1800 * r, f1: 700 * r, dur: 0.09, gain: 0.05, attack: 0.001 });
    noise(v, { t0, dur: 0.04, gain: 0.09, attack: 0.001, hp: 4000 });
    tone(v, { type: 'sine', t0: t0 + 0.065, f0: 2100 * r, f1: 1500 * r, dur: 0.08, gain: 0.045, attack: 0.001 });
  },

  // 玩家死亡：0.35s 内完成的下坠 + 刺耳噪声
  death(t0, r, g, pan) {
    const v = createVoice({ level: 1.1 * g, pan, wet: 0.1 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 150 * r, f1: 26 * r, dur: 0.3, gain: 0.5, attack: 0.002 });
    tone(v, { type: 'sawtooth', t0, f0: 75 * r, f1: 18 * r, dur: 0.28, gain: 0.1, filter: { type: 'lowpass', f0: 500, q: 1.2 } });
    noise(v, {
      t0, dur: 0.3, gain: 0.28, attack: 0.002,
      bp: { f0: 2400 * r, f1: 160 * r, q: 0.6 },
    });
    noise(v, { t0, dur: 0.24, gain: 0.18, attack: 0.001, lp: 350 });
    tone(v, { type: 'square', t0, f0: 55 * r, f1: 20 * r, dur: 0.26, gain: 0.05, filter: { type: 'lowpass', f0: 300, q: 1 } });
  },

  // 重开：极短上扬
  respawn(t0, r, g, pan) {
    const v = createVoice({ level: 0.85 * g, pan, wet: 0.05 });
    if (!v) return;
    tone(v, { type: 'triangle', t0, f0: 220 * r, f1: 900 * r, dur: 0.14, gain: 0.18, attack: 0.002 });
    tone(v, { type: 'sine', t0, f0: 440 * r, f1: 1400 * r, dur: 0.1, gain: 0.055, attack: 0.002 });
    noise(v, { t0, dur: 0.06, gain: 0.04, attack: 0.001, hp: 2600 });
  },

  // 门开：电子鸣响 + 低频机械
  doorOpen(t0, r, g, pan) {
    const v = createVoice({ level: 0.9 * g, pan, wet: 0.12 });
    if (!v) return;
    tone(v, { type: 'square', t0, f0: 523.25 * r, dur: 0.1, gain: 0.045, attack: 0.003, filter: { type: 'lowpass', f0: 1800, q: 1 } });
    tone(v, { type: 'square', t0: t0 + 0.1, f0: 784 * r, dur: 0.18, gain: 0.045, attack: 0.003, filter: { type: 'lowpass', f0: 2400, q: 1 } });
    tone(v, { type: 'sine', t0, f0: 82 * r, f1: 50 * r, dur: 0.5, gain: 0.26, attack: 0.01 });
    noise(v, { t0, dur: 0.35, gain: 0.09, attack: 0.02, lp: 600 });
  },

  // 清版：短促和弦上行
  levelClear(t0, r, g, pan) {
    const v = createVoice({ level: 0.8 * g, pan, wet: 0.24 });
    if (!v) return;
    const notes = [293.66, 349.23, 440.0, 587.33];
    for (let i = 0; i < notes.length; i++) {
      const at = t0 + i * 0.09;
      tone(v, { type: 'triangle', t0: at, f0: notes[i] * r, dur: 0.55, gain: 0.09, attack: 0.004 });
      tone(v, { type: 'sine', t0: at, f0: notes[i] * 2 * r, dur: 0.28, gain: 0.025, attack: 0.003 });
    }
    tone(v, { type: 'sine', t0, f0: 146.83 * r, dur: 0.8, gain: 0.055, attack: 0.01 });
  },

  // 通关：3.5s 小调琶音 + 长和弦（Dm add9），克制收束
  victory(t0, r, g, pan) {
    const v = createVoice({ level: 0.8 * g, pan, wet: 0.38 });
    if (!v) return;
    const arp = [146.83, 174.61, 220.0, 261.63, 329.63, 392.0, 440.0, 523.25];
    for (let i = 0; i < arp.length; i++) {
      const at = t0 + i * 0.155;
      tone(v, { type: 'triangle', t0: at, f0: arp[i] * r, dur: 0.9, gain: 0.07, attack: 0.008 });
      if (i % 2 === 0) {
        tone(v, { type: 'sine', t0: at, f0: arp[i] * 2 * r, dur: 0.55, gain: 0.022, attack: 0.01 });
      }
    }
    const pad = [146.83, 174.61, 220.0, 293.66, 329.63];
    const chordAt = t0 + 1.0;
    for (let i = 0; i < pad.length; i++) {
      tone(v, { type: 'sine', t0: chordAt, f0: pad[i] * r, dur: 2.35, gain: 0.042, attack: 0.55 });
    }
    tone(v, { type: 'sine', t0: chordAt, f0: 73.42 * r, dur: 2.45, gain: 0.1, attack: 0.3 });
  },

  // 护盾格挡：金属钝响
  shieldBlock(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.16 });
    if (!v) return;
    tone(v, { type: 'sine', t0, f0: 180 * r, f1: 62 * r, dur: 0.2, gain: 0.38, attack: 0.002 });
    noise(v, { t0, dur: 0.09, gain: 0.24, attack: 0.001, bp: { f0: 700 * r, q: 1.8 }, lp: 2200 });
    metal(v, {
      t0, base: 720 * r, dur: 0.24, gain: 0.22,
      partials: [
        { r: 1, g: 0.08, d: 0.24 },
        { r: 1.74, g: 0.05, d: 0.18 },
        { r: 2.91, g: 0.03, d: 0.12 },
      ],
    });
  },

  // 空仓：机械咔哒
  empty(t0, r, g, pan) {
    const v = createVoice({ level: 0.9 * g, pan, wet: 0.02 });
    if (!v) return;
    noise(v, { t0, dur: 0.04, gain: 0.24, attack: 0.001, hp: 2600 });
    tone(v, { type: 'square', t0, f0: 1900 * r, f1: 1500 * r, dur: 0.03, gain: 0.04, attack: 0.001 });
    noise(v, { t0: t0 + 0.055, dur: 0.03, gain: 0.12, attack: 0.001, hp: 3200 });
  },

  // 触刺：尖锐噪声 + 闷响
  spikeDeath(t0, r, g, pan) {
    const v = createVoice({ level: 1.1 * g, pan, wet: 0.08 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.14, gain: 0.4, attack: 0.001,
      hp: 4500,
      bp: { f0: 7000 * r, f1: 2000 * r, q: 1 },
    });
    tone(v, { type: 'sine', t0, f0: 1800 * r, f1: 900 * r, dur: 0.07, gain: 0.11, attack: 0.001 });
    tone(v, { type: 'sine', t0, f0: 100 * r, f1: 30 * r, dur: 0.3, gain: 0.48, attack: 0.002 });
    noise(v, { t0, dur: 0.24, gain: 0.22, attack: 0.002, lp: 400 });
  },

  // 进入减缓：反向吸气（上升噪声 + 上升低频）
  slowIn(t0, r, g, pan) {
    const v = createVoice({ level: 1.0 * g, pan, wet: 0.15 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.55, gain: 0.3, attack: 0.42,
      bp: { f0: 180 * r, f1: 3200 * r, q: 1 },
      hp: 100,
    });
    tone(v, { type: 'sine', t0, f0: 55 * r, f1: 190 * r, dur: 0.55, gain: 0.13, attack: 0.4 });
    tone(v, { type: 'triangle', t0, f0: 260 * r, f1: 780 * r, dur: 0.5, gain: 0.035, attack: 0.35 });
  },

  // 退出减缓：下行呼气
  slowOut(t0, r, g, pan) {
    const v = createVoice({ level: 0.95 * g, pan, wet: 0.1 });
    if (!v) return;
    noise(v, {
      t0, dur: 0.42, gain: 0.28, attack: 0.005,
      bp: { f0: 3200 * r, f1: 180 * r, q: 0.9 },
    });
    tone(v, { type: 'sine', t0, f0: 190 * r, f1: 58 * r, dur: 0.4, gain: 0.11, attack: 0.004 });
    tone(v, { type: 'triangle', t0, f0: 780 * r, f1: 260 * r, dur: 0.35, gain: 0.03, attack: 0.004 });
  },

  // UI 点击 / 重启确认
  uiClick(t0, r, g, pan) {
    const v = createVoice({ level: 0.8 * g, pan, wet: 0.02 });
    if (!v) return;
    noise(v, { t0, dur: 0.022, gain: 0.12, attack: 0.001, hp: 3500 });
    tone(v, { type: 'square', t0, f0: 1400 * r, f1: 1100 * r, dur: 0.035, gain: 0.055, attack: 0.001, filter: { type: 'lowpass', f0: 2800, q: 1 } });
  },
};

// ------------------------------------------------------------
// 音乐：4 小节程序化 loop + lookahead 调度
// ------------------------------------------------------------

function ensureMusicGraph() {
  if (!ctx || disabled) return null;
  if (musicGraph) return musicGraph;

  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(master);

  const ambient = ctx.createGain();
  ambient.gain.value = 1;
  ambient.connect(out);

  const combat = ctx.createGain();
  combat.gain.value = combatOn ? 1 : 0.0001;
  combat.connect(out);

  // 附点八分延迟（≈0.489s），给琶音一点空间
  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = MUSIC_STEP * 3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.3;
  const send = ctx.createGain();
  send.gain.value = 0.5;
  send.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(out);

  musicGraph = { out, ambient, combat, delay, feedback, send };
  return musicGraph;
}

function disconnectMusicGraph(g) {
  if (!g) return;
  const nodes = [g.out, g.ambient, g.combat, g.delay, g.feedback, g.send];
  for (let i = 0; i < nodes.length; i++) {
    try { nodes[i].disconnect(); } catch (_) { /* noop */ }
  }
}

function killMusicVoices() {
  const list = Array.from(voices);
  for (let i = 0; i < list.length; i++) {
    if (list[i].isMusic) killVoice(list[i]);
  }
}

function musicTone(dest, o) {
  const v = createVoice({
    level: 1,
    dest,
    music: true,
    delaySend: o.delaySend || 0,
    pan: o.pan || 0,
  });
  if (!v) return;
  tone(v, o);
}

function musicNoise(dest, o) {
  const v = createVoice({ level: 1, dest, music: true, pan: o.pan || 0 });
  if (!v) return;
  noise(v, o);
}

/** 排一个十六分步（step 0..63），t 为绝对 AudioContext 时间 */
function scheduleMusicStep(step, t) {
  if (!ctx || !musicGraph) return;
  const bar = Math.floor(step / 16) % 4;
  const s16 = step % 16;
  const chord = CHORDS[bar];
  const g = musicGraph;

  // —— 环境层 ——
  // 八分音符三角脉冲（重拍更重）
  if ((step & 1) === 0) {
    const accent = s16 % 8 === 0;
    musicTone(g.ambient, {
      type: 'triangle',
      t0: t,
      f0: chord.root,
      dur: 0.26,
      gain: accent ? 0.42 : 0.24,
      attack: 0.005,
      filter: { type: 'lowpass', f0: 620, q: 1.1 },
    });
    musicTone(g.ambient, {
      type: 'sine',
      t0: t,
      f0: chord.root * 2,
      dur: 0.2,
      gain: accent ? 0.075 : 0.045,
      attack: 0.004,
    });
  }

  // 稀疏方波琶音 + 延迟
  const arpIndex = musicArpSteps.indexOf(s16);
  if (arpIndex >= 0) {
    const note = chord.arp[(arpIndex + bar) % chord.arp.length];
    musicTone(g.ambient, {
      type: 'square',
      t0: t,
      f0: note,
      dur: 0.38,
      gain: 0.075,
      attack: 0.004,
      delaySend: 0.55,
      filter: { type: 'lowpass', f0: 2300, q: 2.2 },
    });
  }

  // 轻 hat：八分反拍
  if (s16 % 4 === 2) {
    musicNoise(g.ambient, {
      t0: t,
      dur: 0.05,
      gain: 0.075,
      attack: 0.001,
      hp: 7200,
    });
  }

  // —— 战斗层（增益交叉淡化，未开启时几乎静音）——
  // 底鼓
  if (s16 === 0 || s16 === 8) {
    musicTone(g.combat, {
      type: 'sine',
      t0: t,
      f0: 132,
      f1: 42,
      dur: 0.22,
      gain: 0.42,
      attack: 0.002,
    });
    musicNoise(g.combat, {
      t0: t,
      dur: 0.012,
      gain: 0.04,
      attack: 0.001,
      hp: 2200,
    });
  }

  // 军鼓 / 边击
  if (s16 === 4 || s16 === 12) {
    musicNoise(g.combat, {
      t0: t,
      dur: 0.12,
      gain: 0.11,
      attack: 0.001,
      bp: { f0: 1850, q: 0.9 },
      hp: 500,
    });
    musicTone(g.combat, {
      type: 'triangle',
      t0: t,
      f0: 186,
      f1: 150,
      dur: 0.06,
      gain: 0.045,
      attack: 0.001,
    });
  }

  // 锯齿贝斯（八分/切分）
  if (musicBassSteps.indexOf(s16) >= 0) {
    const octave = (s16 === 6 || s16 === 14) ? 2 : 1;
    musicTone(g.combat, {
      type: 'sawtooth',
      t0: t,
      f0: chord.root * octave,
      dur: s16 === 0 ? 0.3 : 0.16,
      gain: 0.26,
      attack: 0.004,
      filter: { type: 'lowpass', f0: 620, f1: 150, q: 4.5, sweep: 0.9 },
    });
  }

  // 更密的 hat（十六分）
  musicNoise(g.combat, {
    t0: t,
    dur: s16 % 4 === 0 ? 0.04 : 0.028,
    gain: s16 % 4 === 0 ? 0.038 : 0.016,
    attack: 0.001,
    hp: 8600,
  });
}

function musicTick() {
  if (!musicPlaying || !ctx || !musicGraph) return;
  if (ctx.state !== 'running') return; // 切标签页/未解锁时不空转排程
  try {
    const audioNow = ctx.currentTime;
    const horizon = audioNow + MUSIC_LOOKAHEAD;
    if (musicNextTime < audioNow - 0.3) musicNextTime = audioNow + 0.05;
    let guard = 0;
    while (musicNextTime < horizon && guard < 40) {
      scheduleMusicStep(musicStep, musicNextTime);
      musicNextTime += MUSIC_STEP;
      musicStep = (musicStep + 1) % MUSIC_STEPS;
      guard++;
    }
  } catch (_) {
    // 单步失败不能打断调度器
  }
}

// ------------------------------------------------------------
// AudioContext 初始化 / 解锁
// ------------------------------------------------------------

function initAudio() {
  if (initAttempted) return;
  initAttempted = true;

  try {
    if (typeof window === 'undefined') {
      disabled = true;
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      disabled = true;
      return;
    }

    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (_) {
      ctx = new Ctor();
    }
    if (!ctx) {
      disabled = true;
      return;
    }

    noiseBuffer = makeNoiseBuffer(ctx, 2.0);

    master = ctx.createGain();
    master.gain.value = masterVolume;

    // 总线：sources(sfx / music) → master → slowFilter → compressor → destination
    slowFilter = ctx.createBiquadFilter();
    slowFilter.type = 'lowpass';
    slowFilter.frequency.value = 20000 * Math.pow(0.045, slowAmount);
    slowFilter.Q.value = 0.6;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 14;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.22;

    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_BUS_LEVEL;

    master.connect(slowFilter);
    slowFilter.connect(compressor);
    compressor.connect(ctx.destination);
    sfxBus.connect(master);

    // 程序化混响（IR 也只生成一次）
    try {
      reverbConvolver = ctx.createConvolver();
      reverbConvolver.buffer = makeImpulseBuffer(ctx, 0.85, 2.6);
      reverbReturn = ctx.createGain();
      reverbReturn.gain.value = 0.5;
      reverbConvolver.connect(reverbReturn);
      reverbReturn.connect(master);
    } catch (_) {
      reverbConvolver = null;
      reverbReturn = null;
    }

    gcTimer = setInterval(gcVoices, GC_INTERVAL_MS);

    // 初始化时如果 AudioContext 被策略挂起，不主动 resume，等 unlock()
  } catch (err) {
    disabled = true;
    initError = String(err && err.message ? err.message : err);
    try {
      if (ctx && typeof ctx.close === 'function') ctx.close();
    } catch (_) { /* noop */ }
    ctx = null;
    master = null;
    slowFilter = null;
    compressor = null;
    sfxBus = null;
    reverbConvolver = null;
    reverbReturn = null;
    noiseBuffer = null;
  }
}

function requestResume() {
  if (!ctx || typeof ctx.resume !== 'function') return;
  try {
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* noop */ }
}

function unlockAudio() {
  try {
    if (!initAttempted) initAudio();
    if (!ctx || disabled) return;
    if (ctx.state !== 'running') requestResume();
  } catch (_) { /* noop */ }
}

// ------------------------------------------------------------
// 公开 API 实现
// ------------------------------------------------------------

function setMasterVolume(v) {
  masterVolume = clamp(num(v, masterVolume), 0, 1);
  if (ctx && master) {
    linearParam(master.gain, masterVolume, ctx.currentTime, 0.05);
  }
}

function setSlow(amount) {
  slowAmount = clamp(num(amount, 0), 0, 1);
  musicDetuneCents = -slowAmount * 42; // 轻微降调，听感"沉下去"，不是变速播放

  if (ctx && slowFilter) {
    const target = 20000 * Math.pow(0.045, slowAmount); // 全速 20kHz → 减缓 900Hz
    smoothParam(slowFilter.frequency, target, ctx.currentTime, 0.09);
  }

  if (ctx) {
    // 已经在响的音乐音符也一起轻轻降调
    for (const v of voices) {
      if (!v.isMusic) continue;
      for (let i = 0; i < v.oscs.length; i++) {
        try {
          const osc = v.oscs[i];
          osc.detune.setTargetAtTime(
            num(osc._baseDetune, 0) + musicDetuneCents,
            ctx.currentTime,
            0.12
          );
        } catch (_) { /* noop */ }
      }
    }
  }
}

function setCombat(on) {
  combatOn = !!on;
  if (!ctx || !musicGraph) return;
  const target = combatOn ? 1 : 0.0001;
  smoothParam(musicGraph.combat.gain, target, ctx.currentTime, 0.16);
}

function musicStart() {
  try {
    if (!initAttempted) initAudio();
    if (!ctx || disabled) return;
    if (musicPlaying) return;

    if (musicStopTimer) {
      clearTimeout(musicStopTimer);
      musicStopTimer = null;
    }
    if (musicGraph) {
      killMusicVoices();
      disconnectMusicGraph(musicGraph);
      musicGraph = null;
    }

    if (ctx.state === 'suspended') requestResume();
    const g = ensureMusicGraph();
    if (!g) return;

    musicPlaying = true;
    const t = ctx.currentTime;
    try {
      g.out.gain.cancelScheduledValues(t);
      g.out.gain.setValueAtTime(0.0001, t);
      g.out.gain.exponentialRampToValueAtTime(MUSIC_LEVEL, t + 0.4);
    } catch (_) {
      try { g.out.gain.value = MUSIC_LEVEL; } catch (_e) { /* noop */ }
    }

    musicStep = 0;
    musicNextTime = t + 0.08;
    if (musicTimer) clearInterval(musicTimer);
    musicTimer = setInterval(musicTick, MUSIC_TICK_MS);
    musicTick();
  } catch (_) {
    musicPlaying = false;
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }
}

function musicStop() {
  try {
    musicPlaying = false;
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (!ctx || !musicGraph) return;

    const g = musicGraph;
    const t = ctx.currentTime;
    try {
      g.out.gain.cancelScheduledValues(t);
      g.out.gain.setValueAtTime(Math.max(0.0001, g.out.gain.value), t);
      g.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); // 0.1s 淡出
    } catch (_) {
      try { g.out.gain.value = 0.0001; } catch (_e) { /* noop */ }
    }

    if (musicStopTimer) clearTimeout(musicStopTimer);
    // 0.17s < 0.2s：淡出结束后彻底断开，保证"完全静音"且节点回家
    musicStopTimer = setTimeout(() => {
      musicStopTimer = null;
      if (musicGraph === g) {
        killMusicVoices();
        disconnectMusicGraph(g);
        musicGraph = null;
      }
    }, 170);
  } catch (_) {
    musicPlaying = false;
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }
}

function playSound(name, opts) {
  try {
    if (!ctx || disabled) return false;
    if (ctx.state === 'closed') return false;

    const fn = SOUNDS[name];
    if (typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(SOUNDS, name)) return false;

    const now = msNow();
    const throttle = Object.prototype.hasOwnProperty.call(THROTTLES, name)
      ? THROTTLES[name]
      : DEFAULT_THROTTLE_MS;
    const last = lastPlayAt[name];
    if (last != null && now - last < throttle) return false;
    lastPlayAt[name] = now;

    // 自动播放策略：尽量顺手 resume；即使仍 suspended 也先排进去，
    // 用户第一次按键时 unlock() 成功后立即出声（声部上限兜底）。
    if (ctx.state !== 'running') requestResume();

    const o = (opts && typeof opts === 'object') ? opts : {};
    const pitch = clamp(num(o.pitch, 0), -48, 48);
    const gain = clamp(num(o.gain, 1), 0, 2);
    const pan = clamp(num(o.pan, 0), -1, 1);
    if (gain <= 0.0005) return true;

    const t0 = ctx.currentTime + 0.006;
    totalPlays++;
    fn(t0, semitone(pitch), gain, pan);
    return true;
  } catch (_) {
    return false;
  }
}

function getStats() {
  let ctxState = 'none';
  try { ctxState = ctx ? ctx.state : 'none'; } catch (_) { ctxState = 'unknown'; }
  let musicVoiceCount = 0;
  for (const v of voices) if (v.isMusic) musicVoiceCount++;
  return {
    ctxState,
    nodeCountEstimate: liveNodeCount,
    voiceCount: voices.size,
    musicVoiceCount,
    musicPlaying,
    musicStep,
    droppedVoices,
    totalPlays,
    slowAmount,
    combatOn,
    masterVolume,
    sampleRate: ctx ? ctx.sampleRate : 0,
    disabled,
    initError,
    sfxNames: SFX_NAMES.length,
  };
}

// ------------------------------------------------------------
// 导出（唯一公开入口）
// ------------------------------------------------------------

export const AudioSys = {
  init: initAudio,
  unlock: unlockAudio,

  get ready() {
    return !!ctx && !disabled && ctx.state !== 'closed';
  },

  setMasterVolume,
  setSlow,
  setCombat,
  musicStart,
  musicStop,
  play: playSound,

  // 调试/夹具用，不属于游戏调用契约
  getStats,
  get soundNames() {
    return SFX_NAMES.slice();
  },
};
