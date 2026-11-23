// ============================================================
// backdrop.js —— 纯程序化视差霓虹夜城（赛博朋克 / 武士零风）
// ------------------------------------------------------------
// 设计约定：
//   * 零依赖、零素材：全部几何 / 渐变 / 噪点都由 Canvas 2D 现画。
//   * 创建时把静态层全部预渲染进离屏 canvas；每帧只做
//     drawImage 平移拼接 + 雨丝 / 霓虹招牌 / 飞车等少量动画元素。
//   * 6 个预渲染层：天幕 → 远塔 → 中楼 → 近楼 → 线缆 → 地面雾，
//     视差系数 0.08 / 0.17 / 0.33 / 0.55 / 0.85 / 0.72。
//   * 横向取模无限拼接（层宽 = 世界宽 + 一屏余量），纵向留余量。
//   * 同 seed 完全确定（自写 mulberry32），全文件不使用 Math.random。
//   * draw() 自己 save/restore + setTransform，不依赖也不污染调用方状态。
//
// 公开 API：
//   createBackdrop({ width, height, seed = 1, palette = null }) -> Backdrop
//   backdrop.draw(ctx, cam, time, opts)   cam = {x, y, w, h}（世界坐标可视矩形）
//   backdrop.stats() -> { layers, buildMs, drawMsLast, drawMsAvg }
// ============================================================

const DESIGN_W = 1280;
const DESIGN_H = 720;

const SKY_TOP = -80; // 天幕层在设计坐标中的顶端（屏幕外余量）
const SKY_H = 880;

const MIN_LAYER_W = DESIGN_W;
const MAX_LAYER_W = 4608; // 超宽关卡到这里为止，再靠取模拼接（楼体跨接缝时会重复绘制）

const SIGN_P = 0.85; // 霓虹招牌与最前层同视差
const SIGN_PV = 0.4;
const FLYER_P = 0.14;
const FOG_W = 2560;
const FOG_H = 360;
const FOG_TOP = 420;

const RAIN_FAR_N = 200;
const RAIN_NEAR_N = 150;
const RAIN_AREA_W = 1400;
const RAIN_AREA_H = 800;

const TAU = Math.PI * 2;

// ============================================================
// 0. 小工具（纯函数）
// ============================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 正模（相机坐标可能为负） */
function mod(n, m) {
  const r = n % m;
  return r < 0 ? r + m : r;
}

/** mulberry32：32 位状态的小型 PRNG，同 seed 结果完全一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数哈希 → [0,1)，用于招牌闪烁（确定性、无状态） */
function hash01(n) {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

const now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

// ============================================================
// 1. 颜色工具（调色板覆盖时用来派生明暗 / 透明度）
// ============================================================

const COLOR_CACHE = new Map();

/** 支持 #rgb / #rrggbb / rgb() / rgba()，解析失败回退到深紫黑 */
function parseColor(css) {
  if (typeof css !== 'string') return [8, 6, 18];
  const key = css.trim().toLowerCase();
  const hit = COLOR_CACHE.get(key);
  if (hit) return hit;
  let rgb = null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(key);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map((ch) => ch + ch).join('');
    }
    if (h.length >= 6) {
      rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
  } else {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(key);
    if (m) rgb = [+m[1], +m[2], +m[3]];
  }
  if (!rgb || !isFinite(rgb[0]) || !isFinite(rgb[1]) || !isFinite(rgb[2])) rgb = [8, 6, 18];
  rgb = [clamp(Math.round(rgb[0]), 0, 255), clamp(Math.round(rgb[1]), 0, 255), clamp(Math.round(rgb[2]), 0, 255)];
  COLOR_CACHE.set(key, rgb);
  return rgb;
}

/** rgb 数组 → 'rgb()' / 'rgba()' */
function rgbCss(rgb, a) {
  if (a === undefined || a >= 1) return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a < 0 ? 0 : a})`;
}

/** 接受颜色字符串或 rgb 数组 */
function rgbaOf(c, a) {
  return rgbCss(Array.isArray(c) ? c : parseColor(c), a);
}

function mixRgb(a, b, t) {
  const k = clamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

// ============================================================
// 2. Canvas / 路径小工具
// ============================================================

function createCanvas(w, h, opts) {
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('backdrop.js: 需要浏览器 Canvas 2D 环境（document.createElement）');
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  if (opts && opts.alpha === false) c.getContext('2d', { alpha: false });
  return c;
}

function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

function fillRoundRect(g, x, y, w, h, r) {
  roundRectPath(g, x, y, w, h, r);
  g.fill();
}

function strokeRoundRect(g, x, y, w, h, r) {
  roundRectPath(g, x, y, w, h, r);
  g.stroke();
}

/** 一根下垂的电缆（二次贝塞尔，视觉下垂量 = sag） */
function cablePath(g, x0, y0, x1, y1, sag) {
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5 + sag * 2;
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(mx, my, x1, y1);
}

/** 在一个字块里生成几笔抽象"汉字"，输出 [x0,y0,x1,y1] 数组 */
function glyphStrokes(out, x, y, w, h, rng) {
  const n = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.52) {
      const yy = y + h * (0.16 + rng() * 0.68);
      const inset = w * (0.12 + rng() * 0.14);
      out.push([x + inset, yy, x + w - inset, yy]);
    } else {
      const xx = x + w * (0.18 + rng() * 0.64);
      const inset = h * (0.1 + rng() * 0.16);
      out.push([xx, y + inset, xx, y + h - inset]);
    }
  }
  if (rng() < 0.36) {
    const yy = y + h * (0.32 + rng() * 0.44);
    out.push([x + w * 0.34, yy, x + w * 0.66, yy]);
  }
}

// ============================================================
// 3. 默认调色板
// ============================================================

const DEFAULT_PALETTE = Object.freeze({
  // 从天顶到地平线再到地面：深蓝黑 → 紫 → 地平线品红辉光 → 收暗
  sky: ['#07060f', '#0c0a1a', '#150f28', '#211338', '#321a48', '#1a1028', '#090611'],
  far: '#171130',
  mid: '#0f0a1e',
  near: '#07050e',
  neon: ['#ff2e88', '#22e0ff', '#7b3cff', '#ffb347'],
  rain: 'rgba(184, 236, 255, 0.16)',
  fog: 'rgba(88, 150, 190, 0.12)',
});

const isColorString = (v) => typeof v === 'string' && v.trim().length > 0;

function normalizePalette(user) {
  if (!user || typeof user !== 'object') return DEFAULT_PALETTE;
  const sky = Array.isArray(user.sky) ? user.sky.filter(isColorString) : [];
  const neon = Array.isArray(user.neon) ? user.neon.filter(isColorString) : [];
  return {
    sky: sky.length ? sky : DEFAULT_PALETTE.sky,
    far: isColorString(user.far) ? user.far : DEFAULT_PALETTE.far,
    mid: isColorString(user.mid) ? user.mid : DEFAULT_PALETTE.mid,
    near: isColorString(user.near) ? user.near : DEFAULT_PALETTE.near,
    neon: neon.length ? neon : DEFAULT_PALETTE.neon,
    rain: isColorString(user.rain) ? user.rain : DEFAULT_PALETTE.rain,
    fog: isColorString(user.fog) ? user.fog : DEFAULT_PALETTE.fog,
  };
}

// ============================================================
// 4. 对外工厂
// ============================================================

/**
 * 每个关卡创建一个背景。
 * @param {{width:number, height:number, seed?:number, palette?:object}} options
 * @returns {Backdrop}
 */
export function createBackdrop(options) {
  return new Backdrop(options);
}

// ============================================================
// 5. Backdrop
// ============================================================

export class Backdrop {
  constructor(options) {
    const o = options || {};
    const w = Number(o.width);
    const h = Number(o.height);
    this.width = isFinite(w) && w > 0 ? Math.round(w) : 1920;
    this.height = isFinite(h) && h > 0 ? Math.round(h) : DESIGN_H;
    this.seed = isFinite(o.seed) ? (o.seed | 0) : 1;
    this.palette = normalizePalette(o.palette);

    // 层宽 = 世界宽 + 一屏余量：相机走遍全关时最前层也不会露出接缝
    this.layerW = clamp(Math.ceil(this.width) + DESIGN_W, MIN_LAYER_W, MAX_LAYER_W);

    this.layers = [];
    this.signs = [];
    this.flyers = [];
    this._visibleSigns = [];

    this._baseColor = rgbCss(mixRgb(parseColor(this.palette.sky[0]), [0, 0, 0], 0.4));
    this._slowDark = '#07222e';

    // 绘制耗时统计（环形缓冲 60 帧）
    this._msRing = new Float64Array(60);
    this._msIdx = 0;
    this._msFill = 0;
    this._sumMs = 0;
    this._lastMs = 0;
    this._frames = 0;

    const t0 = now();
    this._buildSky();
    this._buildFar();
    this._buildMid();
    this._buildNear();
    this._buildSigns(); // 先建招牌，最前层要给它们画吊线
    this._buildFront();
    this._buildFog();
    this._buildFlyers();
    this._buildRain();
    this._buildMs = now() - t0;
  }

  // ----------------------------------------------------------
  // 内部：每层独立 PRNG（改了别的层不会影响这一层）
  // ----------------------------------------------------------
  _rng(salt) {
    const s = (Math.imul(this.seed | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
    return mulberry32(s);
  }

  _layer(name, canvas, topY, p, pv, alpha, afterSigns) {
    const L = {
      name,
      canvas,
      topY,
      p,
      pv,
      alpha: alpha === undefined ? 1 : alpha,
      afterSigns: !!afterSigns,
    };
    this.layers.push(L);
    return L;
  }

  // ============================================================
  // 5.1 天幕：渐变夜空 + 星 + 月 + 云带 + 地平线光污染
  // ============================================================
  _buildSky() {
    const W = this.layerW;
    const H = SKY_H;
    const top = SKY_TOP;
    const cv = createCanvas(W, H, { alpha: false });
    const g = cv.getContext('2d');
    const sky = this.palette.sky;
    const pick = (i) => sky[Math.min(i, sky.length - 1)];
    const rng = this._rng(0x5b1);

    // --- 底色渐变（设计坐标 -80 → 800 映射到画布 0 → 880）
    const grad = g.createLinearGradient(0, 0, 0, H);
    const stops = [
      [top, pick(0)],
      [140, pick(1)],
      [360, pick(2)],
      [500, pick(3)],
      [585, pick(4)],
      [645, pick(5)],
      [760, pick(6)],
      [800, '#04030a'],
    ];
    for (let i = 0; i < stops.length; i++) {
      grad.addColorStop(clamp((stops[i][0] - top) / H, 0, 1), stops[i][1]);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    // --- 星点（上 3/4 天空）
    for (let i = 0; i < 300; i++) {
      const x = rng() * W;
      const y = 40 + rng() * 500;
      const s = rng() < 0.86 ? 1 : 2;
      const a = 0.07 + rng() * 0.28;
      g.fillStyle = rng() < 0.22
        ? `rgba(255,214,180,${a.toFixed(3)})`
        : `rgba(196,224,255,${a.toFixed(3)})`;
      g.fillRect(Math.round(x), Math.round(y), s, s);
    }
    // 少量亮星 + 十字光
    for (let i = 0; i < 7; i++) {
      const x = Math.round(rng() * W);
      const y = Math.round(60 + rng() * 380);
      const a = 0.28 + rng() * 0.25;
      g.fillStyle = `rgba(220,236,255,${a.toFixed(3)})`;
      g.fillRect(x, y, 2, 2);
      g.fillStyle = `rgba(200,226,255,${(a * 0.4).toFixed(3)})`;
      g.fillRect(x - 3, y + 0.5, 8, 1);
      g.fillRect(x + 0.5, y - 3, 1, 8);
    }

    // --- 星云（极低透明度，提一点紫/青的空气感）
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x = rng() * W;
      const y = 80 + rng() * 380;
      const r = 240 + rng() * 460;
      const col = parseColor(i % 2 ? this.palette.neon[2] : this.palette.neon[1]);
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgbCss(col, 0.05));
      rg.addColorStop(0.55, rgbCss(col, 0.018));
      rg.addColorStop(1, rgbCss(col, 0));
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // --- 地平线城市光污染（压扁的径向光）
    const glowCols = [this.palette.neon[0], this.palette.neon[1]];
    for (let i = 0; i < 2; i++) {
      const x = W * (i === 0 ? 0.34 : 0.72) + rng() * W * 0.16;
      const cy = 600 - top;
      const r = 620;
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, rgbaOf(glowCols[i], 0.1));
      rg.addColorStop(0.4, rgbaOf(glowCols[i], 0.038));
      rg.addColorStop(1, rgbaOf(glowCols[i], 0));
      g.save();
      g.translate(x, cy + 40);
      g.scale(1, 0.4);
      g.fillStyle = rg;
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fill();
      g.restore();
    }

    // --- 高空云带
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 9; i++) {
      const cx = rng() * W;
      const cy = 100 + rng() * 430;
      const rx = 240 + rng() * 700;
      const ry = 20 + rng() * 58;
      const col = parseColor(i % 3 === 0 ? this.palette.neon[0] : i % 3 === 1 ? this.palette.neon[2] : this.palette.neon[1]);
      const a = 0.03 + rng() * 0.03;
      g.save();
      g.translate(cx, cy);
      g.scale(1, ry / rx);
      const cg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      cg.addColorStop(0, rgbCss(col, a));
      cg.addColorStop(0.62, rgbCss(col, a * 0.34));
      cg.addColorStop(1, rgbCss(col, 0));
      g.fillStyle = cg;
      g.beginPath();
      g.arc(0, 0, rx, 0, TAU);
      g.fill();
      g.restore();
    }

    // --- 月亮：放两个（间距 > 一屏，任何时刻最多看到一个）
    for (let mi = 0; mi < 2; mi++) {
      const mx = W * (0.26 + mi * 0.54 + rng() * 0.04);
      const my = 148 + rng() * 60 - top;
      const mr = 54 + rng() * 18;

      g.globalCompositeOperation = 'lighter';
      const halo = g.createRadialGradient(mx, my, mr * 0.7, mx, my, mr * 4.6);
      halo.addColorStop(0, 'rgba(190,205,255,0.12)');
      halo.addColorStop(0.35, 'rgba(150,170,255,0.04)');
      halo.addColorStop(1, 'rgba(120,140,255,0)');
      g.fillStyle = halo;
      g.fillRect(mx - mr * 4.6, my - mr * 4.6, mr * 9.2, mr * 9.2);

      g.globalCompositeOperation = 'source-over';
      const dg = g.createLinearGradient(mx - mr, my - mr, mx + mr, my + mr);
      dg.addColorStop(0, 'rgba(226,232,255,0.24)');
      dg.addColorStop(0.6, 'rgba(180,192,235,0.14)');
      dg.addColorStop(1, 'rgba(130,145,200,0.08)');
      g.fillStyle = dg;
      g.beginPath();
      g.arc(mx, my, mr, 0, TAU);
      g.fill();

      // 月面斑驳
      g.save();
      g.beginPath();
      g.arc(mx, my, mr, 0, TAU);
      g.clip();
      for (let i = 0; i < 6; i++) {
        const a = rng() * TAU;
        const rr = rng() * mr * 0.7;
        const cr = mr * (0.08 + rng() * 0.16);
        g.fillStyle = `rgba(40,42,80,${(0.05 + rng() * 0.06).toFixed(3)})`;
        g.beginPath();
        g.arc(mx + Math.cos(a) * rr, my + Math.sin(a) * rr, cr, 0, TAU);
        g.fill();
      }
      g.restore();
      g.strokeStyle = 'rgba(214,226,255,0.16)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(mx, my, mr, 0, TAU);
      g.stroke();

      // 一条薄云横过月亮
      g.save();
      g.translate(mx + mr * 0.18, my + mr * 0.34);
      g.scale(1, 0.26);
      const cg2 = g.createRadialGradient(0, 0, 0, 0, 0, mr * 2.1);
      cg2.addColorStop(0, 'rgba(9,7,18,0.6)');
      cg2.addColorStop(0.55, 'rgba(9,7,18,0.3)');
      cg2.addColorStop(1, 'rgba(9,7,18,0)');
      g.fillStyle = cg2;
      g.beginPath();
      g.arc(0, 0, mr * 2.1, 0, TAU);
      g.fill();
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';

    // 天际线附近压一层很淡的暗紫，让远处楼群边界更柔和
    const base = g.createLinearGradient(0, 520 - top, 0, 800 - top);
    base.addColorStop(0, 'rgba(8,6,18,0)');
    base.addColorStop(0.6, 'rgba(10,7,20,0.08)');
    base.addColorStop(1, 'rgba(8,6,16,0.2)');
    g.fillStyle = base;
    g.fillRect(0, 520 - top, W, 800 - top);

    return this._layer('sky', cv, SKY_TOP, 0.08, 0.05);
  }

  // ============================================================
  // 5.2 远层塔群：细长剪影 + 稀疏冷窗 + 航空警示灯
  // ============================================================
  _buildFar() {
    const W = this.layerW;
    const H = 560;
    const cv = createCanvas(W, H);
    const g = cv.getContext('2d');
    const rng = this._rng(0x1f3a);
    const pal = this.palette;
    const base = parseColor(pal.far);
    const warm = parseColor(pal.neon[3] || '#ffb347');
    const cyan = [120, 205, 240];
    const violet = parseColor(pal.neon[2] || '#7b3cff');

    // 远景整体更亮、更淡：空气透视把轮廓"推"到后面
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgbCss(mixRgb(base, parseColor('#4a3160'), 0.44)));
    grad.addColorStop(0.45, rgbCss(mixRgb(base, parseColor('#2a1d42'), 0.28)));
    grad.addColorStop(1, rgbCss(mixRgb(base, parseColor('#1a1330'), 0.12)));

    let x = -30;
    while (x < W + 26) {
      const tall = rng() < 0.19;
      const bw = tall ? 11 + rng() * 12 : 14 + rng() * 36;
      const bh = tall ? 320 + rng() * 180 : 120 + rng() * 150;
      const by = H - bh;

      const step = rng() < 0.48
        ? { dx: bw * (0.12 + rng() * 0.3), w: bw * (0.3 + rng() * 0.4), h: 8 + rng() * 46 }
        : null;
      const tank = rng() < 0.22
        ? { dx: bw * (0.12 + rng() * 0.55), w: 7 + rng() * 10, h: 7 + rng() * 11 }
        : null;
      const antTop = by - (step ? step.h : 0);
      const ant = rng() < 0.5
        ? { dx: bw * (0.3 + rng() * 0.4), h: Math.min(12 + rng() * 66, Math.max(4, antTop - 4)) }
        : null;
      const beacon = rng() < 0.2;

      const wins = [];
      const n = (tall ? 7 : 3) + ((rng() * (tall ? 10 : 8)) | 0);
      for (let i = 0; i < n; i++) {
        const bright = rng() < 0.12;
        const rgb = bright ? warm : rng() < 0.78 ? cyan : violet;
        wins.push({
          x: 2 + rng() * Math.max(1, bw - 6),
          y: by + 7 + rng() * Math.max(1, bh - 16),
          w: bright ? 3 : rng() < 0.4 ? 2 : 1,
          h: bright ? 3 : 2 + ((rng() * 2) | 0),
          css: rgbCss(rgb, bright ? 0.28 + rng() * 0.16 : 0.08 + rng() * 0.16),
        });
      }

      const paint = (px) => {
        g.fillStyle = grad;
        g.fillRect(px, by, bw, H - by + 2);
        if (step) {
          g.fillStyle = grad;
          g.fillRect(px + step.dx, by - step.h, step.w, step.h + 1);
        }
        const topY = by - (step ? step.h : 0);
        if (tank) {
          g.fillStyle = rgbCss(mixRgb(base, parseColor('#0d0a1a'), 0.3), 0.92);
          g.fillRect(px + tank.dx, topY - tank.h, tank.w, tank.h);
          g.fillStyle = 'rgba(120,140,190,0.10)';
          g.fillRect(px + tank.dx, topY - tank.h, tank.w, 1);
        }
        if (ant) {
          g.fillStyle = rgbCss(mixRgb(base, parseColor('#584070'), 0.55));
          const ax = Math.round(px + ant.dx);
          g.fillRect(ax, topY - ant.h, 1, ant.h);
          g.fillRect(ax - 2, topY - ant.h, 5, 1);
        }
        if (beacon) {
          const bxx = px + (ant ? ant.dx : bw * 0.5);
          const byy = topY - (ant ? ant.h : 0) - 2;
          const bg = g.createRadialGradient(bxx, byy, 0, bxx, byy, 9);
          bg.addColorStop(0, 'rgba(255,80,100,0.26)');
          bg.addColorStop(1, 'rgba(255,80,100,0)');
          g.fillStyle = bg;
          g.fillRect(bxx - 9, byy - 9, 18, 18);
          g.fillStyle = 'rgba(255,96,112,0.65)';
          g.fillRect(bxx - 1, byy - 1, 2, 2);
        }
        for (let i = 0; i < wins.length; i++) {
          const win = wins[i];
          g.fillStyle = win.css;
          g.fillRect(px + win.x, win.y, win.w, win.h);
        }
      };

      paint(x);
      if (x < 0) paint(x + W);
      if (x + bw > W) paint(x - W);
      x += bw + 1 + rng() * 15;
    }

    // 远景全息广告牌：把"像楼"的细节和高光点睛留在远层
    for (let i = 0; i < 4; i++) {
      const bw2 = 64 + rng() * 70;
      const bh2 = 26 + rng() * 24;
      const bx = 30 + rng() * Math.max(10, W - bw2 - 60);
      const by = 60 + rng() * 140; // 设计 y 300~440
      const col = parseColor(i === 1 ? pal.neon[0] : i === 2 ? pal.neon[2] : i === 3 ? pal.neon[3] : pal.neon[1]);
      const hot = mixRgb(col, [255, 255, 255], 0.5);
      g.globalCompositeOperation = 'lighter';
      const rg = g.createRadialGradient(bx + bw2 * 0.5, by + bh2 * 0.5, 0, bx + bw2 * 0.5, by + bh2 * 0.5, bw2 * 0.85);
      rg.addColorStop(0, rgbaOf(col, 0.12));
      rg.addColorStop(1, rgbaOf(col, 0));
      g.fillStyle = rg;
      g.fillRect(bx - bw2 * 0.4, by - bh2, bw2 * 1.8, bh2 * 3);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = 'rgba(5,4,11,0.55)';
      g.fillRect(bx, by, bw2, bh2);
      g.strokeStyle = rgbaOf(col, 0.4);
      g.lineWidth = 1;
      g.strokeRect(bx + 0.5, by + 0.5, bw2 - 1, bh2 - 1);
      g.fillStyle = rgbaOf(hot, 0.45);
      const bars = 3 + ((rng() * 4) | 0);
      for (let j = 0; j < bars; j++) {
        g.fillRect(bx + 7 + rng() * (bw2 - 24), by + 6 + rng() * (bh2 - 12), 6 + rng() * 12, 1.5);
      }
      g.fillStyle = 'rgba(6,5,12,0.5)';
      g.fillRect(bx + bw2 * 0.5, by + bh2, 1, 28);
    }

    // 楼脚雾：压低对比、抬一点黑位
    const haze = g.createLinearGradient(0, 240, 0, H);
    haze.addColorStop(0, 'rgba(84,58,120,0)');
    haze.addColorStop(0.6, 'rgba(96,62,130,0.055)');
    haze.addColorStop(1, 'rgba(130,80,150,0.10)');
    g.fillStyle = haze;
    g.fillRect(0, 240, W, H - 240);

    // 远处几条极淡的车流光带
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const y = 330 + rng() * 90;
      const cx = rng() * W;
      const len = 120 + rng() * 260;
      const col = parseColor(i === 1 ? pal.neon[1] : pal.neon[0]);
      const lg = g.createLinearGradient(cx, 0, cx + len, 0);
      lg.addColorStop(0, rgbCss(col, 0));
      lg.addColorStop(0.5, rgbCss(col, 0.09));
      lg.addColorStop(1, rgbCss(col, 0));
      g.fillStyle = lg;
      g.fillRect(cx, y, len, 1.5);
    }
    g.globalCompositeOperation = 'source-over';

    return this._layer('far', cv, 240, 0.17, 0.1);
  }

  // ============================================================
  // 5.3 中层楼群：更密、更多亮窗、屋顶设备与霓虹边条
  // ============================================================
  _buildMid() {
    const W = this.layerW;
    const H = 460;
    const cv = createCanvas(W, H);
    const g = cv.getContext('2d');
    const rng = this._rng(0x2b71);
    const pal = this.palette;
    const neon = pal.neon;
    const base = parseColor(pal.mid);
    const warm = parseColor(neon[3] || '#ffb347');
    const cyan = [120, 205, 240];
    const violet = parseColor(neon[2] || '#7b3cff');

    // 地平线辉光：盖在远层楼脚上
    g.globalCompositeOperation = 'lighter';
    const haze = g.createLinearGradient(0, 0, 0, 300);
    haze.addColorStop(0, rgbaOf(violet, 0));
    haze.addColorStop(0.55, rgbaOf(violet, 0.045));
    haze.addColorStop(0.85, rgbaOf(neon[0], 0.04));
    haze.addColorStop(1, rgbaOf(neon[0], 0));
    g.fillStyle = haze;
    g.fillRect(0, 0, W, 300);
    g.globalCompositeOperation = 'source-over';

    // 中景压暗、降对比：只留剪影轮廓，细节交给远景
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgbCss(mixRgb(base, parseColor('#241a3c'), 0.2)));
    grad.addColorStop(0.5, rgbCss(mixRgb(base, parseColor('#0c0918'), 0.08)));
    grad.addColorStop(1, rgbCss(mixRgb(base, parseColor('#080611'), 0.3)));

    let x = -40;
    while (x < W + 40) {
      const short = rng() < 0.3;
      const bw = 30 + rng() * 82;
      const bh = short ? 120 + rng() * 70 : 180 + rng() * 150;
      const by = H - bh;

      const step = rng() < 0.3
        ? { dx: bw * (0.1 + rng() * 0.3), w: bw * (0.35 + rng() * 0.4), h: 8 + rng() * 34 }
        : null;
      const tank = rng() < 0.24
        ? { dx: bw * (0.1 + rng() * 0.55), w: 14 + rng() * 12, h: 12 + rng() * 14 }
        : null;
      const ac = rng() < 0.36
        ? { dx: bw * (0.08 + rng() * 0.6), w: 10 + rng() * 16, h: 5 + rng() * 8 }
        : null;
      const antTop = by - (step ? step.h : 0);
      const ant = rng() < 0.4
        ? { dx: bw * (0.2 + rng() * 0.6), h: Math.min(14 + rng() * 52, Math.max(4, antTop - 4)) }
        : null;
      const roofSign = rng() < 0.12
        ? { dx: bw * (0.2 + rng() * 0.4), w: 24 + rng() * 30, h: 5 + rng() * 7, col: neon[(rng() * neon.length) | 0] }
        : null;
      const strip = rng() < 0.32
        ? { side: rng() < 0.5, col: neon[(rng() * neon.length) | 0] }
        : null;

      // 窗：不再铺满网格，改成暗楼层 + 零散亮窗，避免"砖墙"感
      const cols = Math.max(1, Math.min(7, Math.floor((bw - 12) / 15)));
      const rows = Math.max(2, Math.min(11, Math.floor((bh - 26) / 19)));
      const ox = 6 + (bw - cols * 15) * 0.5;
      const wins = [];
      for (let r = 0; r < rows; r++) {
        if (rng() < 0.34) continue;
        if (rng() < 0.2) {
          wins.push({
            x: ox, y: by + 9 + r * 19,
            w: Math.max(6, bw - ox * 2), h: 2,
            css: rgbCss(warm, 0.03 + rng() * 0.035),
          });
          continue;
        }
        for (let c = 0; c < cols; c++) {
          if (rng() > 0.3) continue;
          const rgb = rng() < 0.62 ? warm : rng() < 0.78 ? cyan : violet;
          wins.push({
            x: ox + c * 15,
            y: by + 9 + r * 19,
            w: rng() < 0.12 ? 8 : 4,
            h: 4,
            css: rgbCss(rgb, 0.08 + rng() * 0.2),
          });
        }
      }

      const paint = (px) => {
        g.fillStyle = grad;
        g.fillRect(px, by, bw, H - by + 2);
        if (step) {
          g.fillStyle = grad;
          g.fillRect(px + step.dx, by - step.h, step.w, step.h + 1);
        }
        const topY = by - (step ? step.h : 0);

        // 屋顶边缘一点冷光
        g.fillStyle = 'rgba(126,196,240,0.05)';
        g.fillRect(px, topY, step ? bw * 0.9 : bw, 1);

        for (let i = 0; i < wins.length; i++) {
          g.fillStyle = wins[i].css;
          g.fillRect(px + wins[i].x, wins[i].y, wins[i].w, wins[i].h);
        }

        if (tank) {
          const tx = px + tank.dx;
          g.fillStyle = 'rgba(7,6,13,0.9)';
          g.fillRect(tx, by - tank.h - 2, tank.w, tank.h);
          g.fillRect(tx + 2, by - 2, 2, 4);
          g.fillRect(tx + tank.w - 4, by - 2, 2, 4);
          g.fillStyle = 'rgba(40,50,75,0.35)';
          g.fillRect(tx, by - tank.h - 2, tank.w, 1);
        }
        if (ac) {
          g.fillStyle = 'rgba(8,6,14,0.9)';
          g.fillRect(px + ac.dx, by - ac.h - 1, ac.w, ac.h);
          g.fillStyle = 'rgba(90,110,150,0.1)';
          g.fillRect(px + ac.dx + 1, by - ac.h, ac.w - 2, 1);
        }
        if (ant) {
          g.fillStyle = 'rgba(12,9,20,0.9)';
          g.fillRect(px + ant.dx, topY - ant.h, 1, ant.h);
          g.fillRect(px + ant.dx - 3, topY - ant.h, 7, 1);
        }

        if (roofSign) {
          const rx = px + roofSign.dx;
          const ry = topY - roofSign.h - 4;
          g.globalCompositeOperation = 'lighter';
          const rg = g.createRadialGradient(
            rx + roofSign.w * 0.5, ry + roofSign.h * 0.5, 0,
            rx + roofSign.w * 0.5, ry + roofSign.h * 0.5, roofSign.w,
          );
          rg.addColorStop(0, rgbaOf(roofSign.col, 0.12));
          rg.addColorStop(1, rgbaOf(roofSign.col, 0));
          g.fillStyle = rg;
          g.fillRect(rx - roofSign.w * 0.5, ry - roofSign.h, roofSign.w * 2, roofSign.h * 3);
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = 'rgba(4,3,9,0.85)';
          g.fillRect(rx, ry, roofSign.w, roofSign.h);
          g.fillStyle = rgbaOf(roofSign.col, 0.4);
          g.fillRect(rx, ry, roofSign.w, 1);
          g.fillRect(rx, ry + roofSign.h - 1, roofSign.w, 1);
        }

        if (strip) {
          const sx = px + (strip.side ? bw - 2 : 1);
          g.globalCompositeOperation = 'lighter';
          g.strokeStyle = rgbaOf(strip.col, 0.04);
          g.lineWidth = 7;
          g.beginPath();
          g.moveTo(sx, topY + 8);
          g.lineTo(sx, H);
          g.stroke();
          g.globalCompositeOperation = 'source-over';
          g.strokeStyle = rgbaOf(strip.col, 0.28);
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(sx, topY + 8);
          g.lineTo(sx, H);
          g.stroke();
        }
      };

      paint(x);
      if (x < 0) paint(x + W);
      if (x + bw > W) paint(x - W);
      x += bw + 20 + rng() * 60;
    }

    // 一层极淡的空气雾盖在中景上：降对比、抬黑位，别让大块深色压住角色
    g.globalCompositeOperation = 'lighter';
    const veil = g.createLinearGradient(0, 0, 0, H);
    veil.addColorStop(0, 'rgba(64,84,152,0)');
    veil.addColorStop(0.32, 'rgba(64,84,152,0.025)');
    veil.addColorStop(0.55, 'rgba(92,68,144,0.04)');
    veil.addColorStop(0.82, 'rgba(92,68,144,0.022)');
    veil.addColorStop(1, 'rgba(92,68,144,0)');
    g.fillStyle = veil;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    return this._layer('mid', cv, 340, 0.33, 0.18);
  }

  // ============================================================
  // 5.4 近层楼体：大块暗剪影 + 少量暖亮窗 + 管道 / 水箱 / 护栏
  // ============================================================
  _buildNear() {
    const W = this.layerW;
    const H = 360;
    const cv = createCanvas(W, H);
    const g = cv.getContext('2d');
    const rng = this._rng(0x3d15);
    const pal = this.palette;
    const neon = pal.neon;
    const base = parseColor(pal.near);
    const warm = parseColor(neon[3] || '#ffb347');
    const cyan = [120, 205, 240];

    // 近景不再纯黑：深蓝紫底 + 空气雾，避免"大块死黑"压住角色
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgbCss(mixRgb(base, parseColor('#2a2044'), 0.34)));
    grad.addColorStop(0.5, rgbCss(mixRgb(base, parseColor('#0d0a19'), 0.22)));
    grad.addColorStop(1, rgbCss(mixRgb(base, parseColor('#080610'), 0.5)));

    // 街谷底
    g.fillStyle = rgbCss(mixRgb(base, parseColor('#05040b'), 0.45));
    g.fillRect(0, H - 40, W, 40);

    let x = -50;
    while (x < W + 50) {
      const tall = rng() < 0.18;
      const bw = 60 + rng() * 110;
      const bh = tall ? 270 + rng() * 50 : 130 + rng() * 110;
      const by = H - bh;

      const stepH = 8 + rng() * 22;
      const step = rng() < 0.32 && by - stepH > 6
        ? { dx: bw * (0.06 + rng() * 0.25), w: bw * (0.4 + rng() * 0.4), h: stepH }
        : null;
      const tank = rng() < 0.22
        ? { dx: bw * (0.08 + rng() * 0.6), w: 18 + rng() * 16, h: 14 + rng() * 16 }
        : null;
      const pipe = rng() < 0.35
        ? { dx: bw * (0.05 + rng() * 0.7), w: 18 + rng() * 42, h: 7 + rng() * 10 }
        : null;
      const antTop = by - (step ? step.h : 0);
      const ant = rng() < 0.45
        ? { dx: bw * (0.15 + rng() * 0.7), h: Math.min(18 + rng() * 60, Math.max(4, antTop - 4)) }
        : null;
      const rail = rng() < 0.35;
      const wallSign = rng() < 0.2
        ? {
            x: 10 + rng() * Math.max(4, bw - 46),
            y: by + 28 + rng() * Math.max(4, bh - 86),
            w: 18 + rng() * 20,
            h: 9 + rng() * 10,
            col: neon[(rng() * neon.length) | 0],
          }
        : null;

      const wins = [];
      const n = 1 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const big = rng() < 0.3;
        wins.push({
          x: 8 + rng() * Math.max(4, bw - 26),
          y: by + 20 + rng() * Math.max(4, bh - 46),
          w: big ? 11 : 5,
          h: big ? 8 : 7,
          css: rgbCss(rng() < 0.74 ? warm : cyan, 0.18 + rng() * 0.32),
        });
      }
      let brightWin = null;
      if (rng() < 0.42) {
        brightWin = {
          x: 8 + rng() * Math.max(4, bw - 30),
          y: by + 22 + rng() * Math.max(4, bh - 52),
          w: 9,
          h: 11,
          css: rgbCss(warm, 0.6),
        };
      }

      const paint = (px) => {
        g.fillStyle = grad;
        g.fillRect(px, by, bw, H - by + 2);
        if (step) {
          g.fillStyle = grad;
          g.fillRect(px + step.dx, by - step.h, step.w, step.h + 1);
        }
        const topY = by - (step ? step.h : 0);

        // 屋顶冷色细边 + 一层 2px 的柔和反光
        g.fillStyle = 'rgba(122,196,240,0.1)';
        g.fillRect(px, topY, bw, 1);
        g.fillStyle = 'rgba(100,160,220,0.03)';
        g.fillRect(px, topY + 1, bw, 2);

        for (let i = 0; i < wins.length; i++) {
          const w = wins[i];
          g.fillStyle = w.css;
          g.fillRect(px + w.x, w.y, w.w, w.h);
        }
        if (brightWin) {
          g.globalCompositeOperation = 'lighter';
          const bx = px + brightWin.x + 4;
          const bY = brightWin.y + 5;
          const rg = g.createRadialGradient(bx, bY, 0, bx, bY, 22);
          rg.addColorStop(0, 'rgba(255,179,71,0.14)');
          rg.addColorStop(1, 'rgba(255,179,71,0)');
          g.fillStyle = rg;
          g.fillRect(bx - 22, bY - 22, 44, 44);
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = brightWin.css;
          g.fillRect(px + brightWin.x, brightWin.y, brightWin.w, brightWin.h);
        }

        if (tank) {
          const tx = px + tank.dx;
          g.fillStyle = 'rgba(6,5,11,0.94)';
          g.fillRect(tx, by - tank.h - 3, tank.w, tank.h);
          g.fillRect(tx + 2, by - 3, 2, 5);
          g.fillRect(tx + tank.w - 4, by - 3, 2, 5);
          g.fillStyle = 'rgba(70,86,120,0.18)';
          g.fillRect(tx, by - tank.h - 3, tank.w, 1);
        }
        if (pipe) {
          const px2 = px + pipe.dx;
          g.fillStyle = 'rgba(7,6,13,0.94)';
          g.fillRect(px2, by - pipe.h - 1, pipe.w, pipe.h);
          g.fillStyle = 'rgba(80,120,160,0.09)';
          g.fillRect(px2, by - pipe.h - 1, pipe.w, 1);
          g.fillStyle = 'rgba(12,10,20,0.9)';
          g.fillRect(px2 + 3, by - pipe.h - 1, 2, pipe.h + 6);
          g.fillRect(px2 + pipe.w - 6, by - pipe.h - 1, 2, pipe.h + 6);
        }
        if (ant) {
          g.fillStyle = 'rgba(9,7,15,0.94)';
          g.fillRect(px + ant.dx, topY - ant.h, 1, ant.h);
          g.fillRect(px + ant.dx - 4, topY - ant.h, 9, 1);
        }
        if (rail) {
          g.fillStyle = 'rgba(10,8,18,0.9)';
          g.fillRect(px, topY - 5, bw, 1);
          for (let rx = px + 4; rx < px + bw - 2; rx += 7) {
            g.fillRect(rx, topY - 4, 1, 4);
          }
        }

        if (wallSign) {
          const sx = px + wallSign.x;
          const sy = wallSign.y;
          const cxm = sx + wallSign.w * 0.5;
          const cym = sy + wallSign.h * 0.5;
          g.globalCompositeOperation = 'lighter';
          const rg = g.createRadialGradient(cxm, cym, 0, cxm, cym, wallSign.w);
          rg.addColorStop(0, rgbaOf(wallSign.col, 0.2));
          rg.addColorStop(1, rgbaOf(wallSign.col, 0));
          g.fillStyle = rg;
          g.fillRect(cxm - wallSign.w, cym - wallSign.h, wallSign.w * 2, wallSign.h * 2);
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = 'rgba(5,4,10,0.9)';
          g.fillRect(sx, sy, wallSign.w, wallSign.h);
          g.strokeStyle = rgbaOf(wallSign.col, 0.5);
          g.lineWidth = 1;
          g.strokeRect(sx + 0.5, sy + 0.5, wallSign.w - 1, wallSign.h - 1);
          g.fillStyle = rgbaOf(mixRgb(parseColor(wallSign.col), [255, 255, 255], 0.5), 0.5);
          g.fillRect(sx + 4, sy + 4, wallSign.w - 8, 1.5);
          g.fillRect(sx + 4, sy + 7, (wallSign.w - 8) * 0.6, 1.5);
        }
      };

      paint(x);
      if (x < 0) paint(x + W);
      if (x + bw > W) paint(x - W);
      x += bw + 40 + rng() * 150;
    }

    // 横贯全宽的管道（近景机械感）
    for (let i = 0; i < 2; i++) {
      const y = H - 62 + i * 22 + rng() * 6;
      const th = 5 + rng() * 6;
      g.fillStyle = 'rgba(6,5,11,0.94)';
      g.fillRect(0, y, W, th);
      g.fillStyle = 'rgba(100,150,200,0.055)';
      g.fillRect(0, y, W, 1);
      for (let bx = rng() * 80; bx < W; bx += 150 + rng() * 140) {
        g.fillStyle = 'rgba(9,7,15,0.92)';
        g.fillRect(bx, y - 4, 4, th + 8);
      }
    }

    // 空气雾：抬黑位、降对比，别让近景变成纯黑大块
    g.globalCompositeOperation = 'lighter';
    const veil = g.createLinearGradient(0, 0, 0, H);
    veil.addColorStop(0, 'rgba(72,92,150,0.032)');
    veil.addColorStop(0.4, 'rgba(60,80,140,0.02)');
    veil.addColorStop(1, 'rgba(40,60,110,0)');
    g.fillStyle = veil;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    const dark = g.createLinearGradient(0, H - 60, 0, H);
    dark.addColorStop(0, 'rgba(7,6,14,0)');
    dark.addColorStop(1, 'rgba(7,6,14,0.5)');
    g.fillStyle = dark;
    g.fillRect(0, H - 60, W, 60);

    return this._layer('near', cv, 440, 0.55, 0.28);
  }

  // ============================================================
  // 5.5 最前层：电缆 / 吊灯（视差 0.85）
  // ============================================================
  _buildFront() {
    const W = this.layerW;
    const H = 380;
    const TOP = -80;
    const cv = createCanvas(W, H);
    const g = cv.getContext('2d');
    const rng = this._rng(0x6c2f);
    const yOf = (dy) => dy - TOP;

    let x = -180;
    while (x < W + 220) {
      const len = 360 + rng() * 680;
      const y0 = 46 + rng() * 190;
      const y1 = y0 + (rng() - 0.5) * 26;
      const sag = 10 + rng() * 42;
      const thick = rng() < 0.25 ? 2.2 : 1.2;
      const lamp = rng() < 0.5 ? { h: 6, r: 14 + rng() * 8 } : null;

      const paint = (ox) => {
        const ax = ox + x;
        const bx = ax + len;
        // 线缆主体（近黑剪影）
        g.strokeStyle = 'rgba(2,2,6,0.92)';
        g.lineWidth = thick;
        cablePath(g, ax, yOf(y0), bx, yOf(y1), sag);
        g.stroke();
        // 顶部一丝冷光，避免在暗天上完全看不见
        g.strokeStyle = 'rgba(120,150,200,0.08)';
        g.lineWidth = 0.8;
        cablePath(g, ax, yOf(y0) - 1, bx, yOf(y1) - 1, sag);
        g.stroke();

        if (lamp) {
          const lx = ax + len * 0.5;
          const ly = yOf(y0 + (y1 - y0) * 0.5) + sag * 0.5;
          g.strokeStyle = 'rgba(3,3,8,0.92)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(lx, ly);
          g.lineTo(lx, ly + lamp.h);
          g.stroke();
          const lr = lamp.r;
          g.globalCompositeOperation = 'lighter';
          const lg = g.createRadialGradient(lx, ly + lamp.h, 0, lx, ly + lamp.h, lr);
          lg.addColorStop(0, 'rgba(255,196,120,0.26)');
          lg.addColorStop(1, 'rgba(255,196,120,0)');
          g.fillStyle = lg;
          g.fillRect(lx - lr, ly + lamp.h - lr, lr * 2, lr * 2);
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = 'rgba(255,222,175,0.55)';
          g.fillRect(lx - 1, ly + lamp.h - 1, 2, 2);
        }
      };

      paint(0);
      if (x < 0) paint(W);
      if (x + len > W) paint(-W);
      x += len * (0.7 + rng() * 0.35);
    }

    // 给上半屏的招牌画吊线/挂钩：招牌在 0.85 层，吊线同层对齐
    const hang = (s, ox) => {
      const cx = ox + s.x + s.w * 0.5;
      g.strokeStyle = 'rgba(3,3,8,0.82)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(cx, yOf(s.y) - 1);
      g.lineTo(cx, yOf(-60));
      g.stroke();
      g.fillStyle = 'rgba(3,3,8,0.85)';
      g.fillRect(cx - 3, yOf(s.y) - 2, 6, 2);
    };
    for (let i = 0; i < this.signs.length; i++) {
      const s = this.signs[i];
      if (s.y > 296 || s.id % 3 === 0) continue;
      hang(s, 0);
      if (s.x < 40) hang(s, W);
      if (s.x + s.w > W - 40) hang(s, -W);
    }

    return this._layer('front', cv, TOP, 0.85, SIGN_PV);
  }

  // ============================================================
  // 5.6 地面雾：低频团雾 + 底部压暗，横向无缝平铺
  // ============================================================
  _buildFog() {
    const W = FOG_W;
    const H = FOG_H;
    const cv = createCanvas(W, H);
    const g = cv.getContext('2d');
    const rng = this._rng(0x4e8a);
    const col = parseColor(this.palette.fog);

    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgbaOf(col, 0));
    grad.addColorStop(0.5, rgbaOf(col, 0.05));
    grad.addColorStop(0.85, rgbaOf(col, 0.13));
    grad.addColorStop(1, rgbaOf(col, 0.18));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    for (let i = 0; i < 8; i++) {
      const cx = rng() * W;
      const cy = 60 + rng() * (H - 110);
      const rx = 260 + rng() * 520;
      const ry = 30 + rng() * 80;
      const a = 0.05 + rng() * 0.05;
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, rgbaOf(col, a));
      rg.addColorStop(0.6, rgbaOf(col, a * 0.45));
      rg.addColorStop(1, rgbaOf(col, 0));
      const paint = (ox) => {
        g.save();
        g.translate(cx + ox, cy);
        g.scale(1, ry / rx);
        g.fillStyle = rg;
        g.beginPath();
        g.arc(0, 0, rx, 0, TAU);
        g.fill();
        g.restore();
      };
      paint(0);
      if (cx - rx < 0) paint(W);
      if (cx + rx > W) paint(-W);
    }

    // 地平线附近的城市光污染：在雾里加两三团极淡的粉/青，给角色背后留一点分离
    g.globalCompositeOperation = 'lighter';
    const glowCols = [this.palette.neon[0], this.palette.neon[1], this.palette.neon[2]];
    for (let i = 0; i < 3; i++) {
      const cx = rng() * W;
      const cy = 120 + rng() * 110;
      const rx = 300 + rng() * 280;
      const ry = 55 + rng() * 45;
      const col = parseColor(glowCols[i % glowCols.length]);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, rgbaOf(col, 0.055));
      rg.addColorStop(0.55, rgbaOf(col, 0.022));
      rg.addColorStop(1, rgbaOf(col, 0));
      const paint = (ox) => {
        g.save();
        g.translate(cx + ox, cy);
        g.scale(1, ry / rx);
        g.fillStyle = rg;
        g.beginPath();
        g.arc(0, 0, rx, 0, TAU);
        g.fill();
        g.restore();
      };
      paint(0);
      if (cx - rx < 0) paint(W);
      if (cx + rx > W) paint(-W);
    }
    g.globalCompositeOperation = 'source-over';

    const dark = g.createLinearGradient(0, H * 0.55, 0, H);
    dark.addColorStop(0, 'rgba(6,5,12,0)');
    dark.addColorStop(1, 'rgba(6,5,12,0.2)');
    g.fillStyle = dark;
    g.fillRect(0, H * 0.55, W, H * 0.45);

    return this._layer('fog', cv, FOG_TOP, 0.72, 0.15, 0.94, true);
  }

  // ============================================================
  // 5.7 霓虹招牌：核心 + 光晕两张预渲染小图（光晕用 lighter 烘焙）
  // ============================================================
  _buildSigns() {
    const W = this.layerW;
    const rng = this._rng(0x51c7);
    const neon = this.palette.neon;
    const count = Math.max(10, Math.round(W / 215));
    const slot = W / count;

    for (let i = 0; i < count; i++) {
      const kind = i % 3;
      const hero = i % 6 === 0;
      let w;
      let h;
      if (kind === 0) {
        w = (24 + rng() * 14) * (hero ? 1.25 : 1);
        h = (96 + rng() * 80) * (hero ? 1.2 : 1);
      } else if (kind === 1) {
        w = (96 + rng() * 86) * (hero ? 1.2 : 1);
        h = (30 + rng() * 20) * (hero ? 1.15 : 1);
      } else {
        w = (40 + rng() * 18) * (hero ? 1.2 : 1);
        h = (40 + rng() * 24) * (hero ? 1.2 : 1);
      }
      const color = neon[(i + (i >> 2)) % neon.length];
      const x = clamp(i * slot + 20 + rng() * Math.max(4, slot * 0.45), 8, W - w - 8);
      const y = 70 + (i % 4) * 100 + rng() * 76;
      const sprite = this._makeSignSprite(kind, w, h, color, rng);
      const mode = i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0;
      this.signs.push({
        id: i,
        x,
        y,
        w,
        h,
        kind,
        hero,
        core: sprite.core,
        glow: sprite.glow,
        pad: sprite.pad,
        coreW: sprite.core.width,
        coreH: sprite.core.height,
        glowOff: sprite.pad + sprite.gp,
        mode,
        rate: 0.55 + rng() * 1.5,
        phase: rng() * 11,
        _a: 1,
      });
    }
  }

  _makeSignSprite(kind, w, h, colorCss, rng) {
    const pad = 3;
    const gp = 30;
    const col = parseColor(colorCss);
    const hot = mixRgb(col, [255, 255, 255], 0.55);
    const cw = Math.ceil(w + pad * 2);
    const ch = Math.ceil(h + pad * 2);

    const core = createCanvas(cw, ch);
    const cg = core.getContext('2d');
    const glow = createCanvas(cw + gp * 2, ch + gp * 2);
    const gg = glow.getContext('2d');

    // --- 字块布局（局部坐标，相对 core 画布）
    const cells = [];
    if (kind === 0) {
      const n = Math.max(2, Math.floor((h - 12) / 22));
      const cellH = (h - 12) / n;
      for (let i = 0; i < n; i++) cells.push([5, 6 + i * cellH, w - 10, cellH - 4]);
    } else if (kind === 1) {
      const n = Math.max(3, Math.floor(w / 26));
      const cellW = (w - 12) / n;
      for (let i = 0; i < n; i++) cells.push([6 + i * cellW, 8, cellW - 4, h - 16]);
    } else {
      cells.push([7, 7, w - 14, h - 14]);
    }
    const strokes = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      glyphStrokes(strokes, c[0], c[1], Math.max(4, c[2]), Math.max(4, c[3]), rng);
    }

    // --- 核心层：暗底 + 霓虹边框 + 亮字
    cg.fillStyle = 'rgba(4,3,9,0.92)';
    fillRoundRect(cg, pad, pad, w, h, 3);
    cg.lineWidth = 1.5;
    cg.strokeStyle = rgbaOf(col, 0.75);
    strokeRoundRect(cg, pad + 0.5, pad + 0.5, w - 1, h - 1, 3);
    cg.lineWidth = 1;
    cg.strokeStyle = rgbaOf(hot, 0.2);
    strokeRoundRect(cg, pad + 3.5, pad + 3.5, w - 7, h - 7, 2);

    cg.lineCap = 'round';
    cg.lineWidth = 1.6;
    cg.strokeStyle = rgbaOf(hot, 0.85);
    cg.beginPath();
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      cg.moveTo(s[0], s[1]);
      cg.lineTo(s[2], s[3]);
    }
    cg.stroke();

    // 底部一条细灯条
    cg.fillStyle = rgbaOf(col, 0.6);
    cg.fillRect(pad + 4, pad + h - 4, w - 8, 1);

    // --- 光晕层：全程 lighter 叠加，运行时只需 drawImage
    gg.globalCompositeOperation = 'lighter';
    const gx = gp + pad + w * 0.5;
    const gy = gp + pad + h * 0.5;
    const rr = Math.max(w, h) * 0.6 + gp * 0.9;
    const rg = gg.createRadialGradient(gx, gy, 0, gx, gy, rr);
    rg.addColorStop(0, rgbaOf(col, 0.26));
    rg.addColorStop(0.45, rgbaOf(col, 0.11));
    rg.addColorStop(1, rgbaOf(col, 0));
    gg.fillStyle = rg;
    gg.fillRect(gx - rr, gy - rr, rr * 2, rr * 2);

    const borderPasses = [
      [16, 0.04],
      [9, 0.07],
      [4, 0.13],
    ];
    for (let i = 0; i < borderPasses.length; i++) {
      gg.lineWidth = borderPasses[i][0];
      gg.strokeStyle = rgbaOf(col, borderPasses[i][1]);
      strokeRoundRect(gg, gp + pad, gp + pad, w, h, 3);
    }

    gg.lineCap = 'round';
    const glyphPasses = [
      [5, 0.09],
      [2.2, 0.14],
    ];
    for (let i = 0; i < glyphPasses.length; i++) {
      gg.lineWidth = glyphPasses[i][0];
      gg.strokeStyle = rgbaOf(hot, glyphPasses[i][1]);
      gg.beginPath();
      for (let j = 0; j < strokes.length; j++) {
        const s = strokes[j];
        gg.moveTo(gp + s[0], gp + s[1]);
        gg.lineTo(gp + s[2], gp + s[3]);
      }
      gg.stroke();
    }

    return { core, glow, pad, gp };
  }

  // ============================================================
  // 5.8 远处飞车：预渲染拖尾光斑（低频掠过）
  // ============================================================
  _buildFlyers() {
    const rng = this._rng(0x2c4d);
    const makeSprite = (color) => {
      const c = createCanvas(140, 30);
      const g = c.getContext('2d');
      const col = parseColor(color);
      g.globalCompositeOperation = 'lighter';
      const lg = g.createLinearGradient(0, 0, 140, 0);
      lg.addColorStop(0, rgbCss(col, 0));
      lg.addColorStop(0.55, rgbCss(col, 0.2));
      lg.addColorStop(0.9, rgbCss(col, 0.62));
      lg.addColorStop(1, rgbCss(col, 0.35));
      g.fillStyle = lg;
      g.save();
      g.translate(0, 15);
      g.scale(1, 0.16);
      g.beginPath();
      g.arc(70, 0, 70, 0, TAU);
      g.fill();
      g.restore();
      const core = g.createRadialGradient(118, 15, 0, 118, 15, 15);
      core.addColorStop(0, 'rgba(255,255,255,0.8)');
      core.addColorStop(0.2, rgbCss(col, 0.8));
      core.addColorStop(1, rgbCss(col, 0));
      g.fillStyle = core;
      g.fillRect(103, 0, 37, 30);
      return c;
    };
    const cols = [this.palette.neon[1], this.palette.neon[3]];
    for (let i = 0; i < 2; i++) {
      this.flyers.push({
        sprite: makeSprite(cols[i % cols.length]),
        y: 170 + rng() * 130,
        speed: 40 + rng() * 70,
        phase: rng() * 2600,
        span: 2600,
        alpha: 0.55 + rng() * 0.25,
        blink: 1.6 + rng() * 3.2,
      });
    }
  }

  // ============================================================
  // 5.9 雨：两档预生成雨丝（相机快速移动时也不会出现空洞）
  // ============================================================
  _buildRain() {
    const rng = this._rng(0x77a1);
    const make = (n, lenMin, lenMax, spdMin, spdMax) => {
      const d = {
        n,
        x: new Float32Array(n),
        y: new Float32Array(n),
        len: new Float32Array(n),
        spd: new Float32Array(n),
      };
      for (let i = 0; i < n; i++) {
        d.x[i] = rng() * RAIN_AREA_W;
        d.y[i] = rng() * RAIN_AREA_H;
        d.len[i] = lenMin + rng() * (lenMax - lenMin);
        d.spd[i] = spdMin + rng() * (spdMax - spdMin);
      }
      return d;
    };
    this._rainFar = make(RAIN_FAR_N, 7, 13, 560, 860);
    this._rainNear = make(RAIN_NEAR_N, 14, 26, 900, 1350);

    // 预生成 8 档颜色（slow 时偏青），每帧只取一个字符串
    const base = parseColor(this.palette.rain);
    const cyan = [34, 224, 255];
    this._rainStylesFar = [];
    this._rainStylesNear = [];
    for (let i = 0; i < 8; i++) {
      const k = i / 7;
      const rgb = mixRgb(base, cyan, k * 0.62);
      this._rainStylesFar.push(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.075 + k * 0.035).toFixed(3)})`);
      this._rainStylesNear.push(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.14 + k * 0.05).toFixed(3)})`);
    }
  }

  // ============================================================
  // 6. 每帧绘制
  // ============================================================

  /**
   * 画背景。纯绘制，不改调用方 ctx 状态。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,w:number,h:number}} cam 世界坐标可视矩形
   * @param {number} time 游戏内真实时间（秒）
   * @param {{slow?:number, flash?:number, flashColor?:string}} [opts]
   */
  draw(ctx, cam, time, opts = {}) {
    if (!ctx) return;
    const t0 = now();
    const o = opts || {};
    const vw = cam && cam.w > 0 ? cam.w : DESIGN_W;
    const vh = cam && cam.h > 0 ? cam.h : DESIGN_H;
    const camX = cam && isFinite(cam.x) ? cam.x : 0;
    const camY = cam && isFinite(cam.y) ? cam.y : 0;
    const t = isFinite(time) ? time : 0;
    const slow = clamp(isFinite(o.slow) ? o.slow : 0, 0, 1);
    const flash = clamp(isFinite(o.flash) ? o.flash : 0, 0, 1);
    const flashColor = typeof o.flashColor === 'string' && o.flashColor ? o.flashColor : '#ffffff';

    // 覆盖式缩放：1280x720 设计分辨率按比例铺满视口（正常情况 scale = 1）
    const scale = Math.max(0.5, vw / DESIGN_W, vh / DESIGN_H);

    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = this._baseColor;
      ctx.fillRect(0, 0, vw, vh);

      if (scale !== 1) {
        ctx.setTransform(
          scale, 0, 0, scale,
          (vw - DESIGN_W * scale) * 0.5,
          (vh - DESIGN_H * scale) * 0.5,
        );
      }
      ctx.imageSmoothingEnabled = scale > 1.001;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';

      // 相机中心相对世界中心的竖直偏移 → 各层垂直视差（0.05~0.4）
      const vy = clamp(camY + vh * 0.5 - this.height * 0.5, -220, 220);

      this._drawLayer(ctx, this.layers[0], camX, vy, 1); // 天幕
      this._drawLayer(ctx, this.layers[1], camX, vy, 1); // 远塔
      this._drawFlyers(ctx, camX, t, slow);
      this._drawLayer(ctx, this.layers[2], camX, vy, 1); // 中楼
      this._drawLayer(ctx, this.layers[3], camX, vy, 1); // 近楼
      this._drawLayer(ctx, this.layers[4], camX, vy, 1); // 线缆
      this._drawSigns(ctx, camX, vy, t, slow);
      this._drawLayer(ctx, this.layers[5], camX, vy, 0.85 + slow * 0.1); // 地面雾
      this._drawRain(ctx, camX, t, slow);
      this._drawGrading(ctx, slow, flash, flashColor);
    } finally {
      ctx.restore();
    }

    // --- 统计（真实 performance.now，环形平均）
    const ms = now() - t0;
    this._lastMs = ms;
    this._frames++;
    const idx = this._msIdx;
    this._sumMs += ms - this._msRing[idx];
    this._msRing[idx] = ms;
    this._msIdx = (idx + 1) % this._msRing.length;
    if (this._msFill < this._msRing.length) this._msFill++;
  }

  /** 单层横向取模拼接 */
  _drawLayer(ctx, layer, camX, vy, alphaMul) {
    const cv = layer.canvas;
    const w = cv.width;
    if (!w) return;
    const off = Math.round(mod(camX * layer.p, w));
    const y = Math.round(layer.topY + clamp(-vy * layer.pv, -56, 56));
    const a = layer.alpha * (alphaMul === undefined ? 1 : alphaMul);
    if (a !== 1) ctx.globalAlpha = a;
    let x = -off;
    let guard = 0;
    while (x < DESIGN_W && guard < 12) {
      ctx.drawImage(cv, x, y);
      x += w;
      guard++;
    }
    if (a !== 1) ctx.globalAlpha = 1;
  }

  _drawFlyers(ctx, camX, t, slow) {
    if (!this.flyers.length) return;
    const ft = t * (1 - slow * 0.6);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.flyers.length; i++) {
      const f = this.flyers[i];
      const x = mod(ft * f.speed + f.phase - camX * FLYER_P, f.span) - 500;
      if (x < -180 || x > DESIGN_W + 160) continue;
      const y = f.y + Math.sin(ft * 0.7 + f.phase) * 6;
      const blink = 0.35 + 0.65 * Math.max(0, Math.sin(ft * f.blink + f.phase));
      ctx.globalAlpha = blink * f.alpha;
      ctx.drawImage(f.sprite, Math.round(x), Math.round(y));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawSigns(ctx, camX, vy, t, slow) {
    const vis = this._visibleSigns;
    vis.length = 0;
    const backT = t * (1 - slow * 0.55);
    const off = Math.round(mod(camX * SIGN_P, this.layerW));
    const yOff = Math.round(clamp(-vy * SIGN_PV, -56, 56));
    const layerW = this.layerW;

    for (let i = 0; i < this.signs.length; i++) {
      const s = this.signs[i];
      const margin = s.coreW + s.glowOff;
      let sx = s.x - off;
      if (sx < -margin) sx += layerW;
      if (sx > DESIGN_W + margin) sx -= layerW;
      if (sx <= -margin || sx >= DESIGN_W + margin) continue;

      const ph = backT * s.rate + s.phase;
      let a = 0.7 + 0.24 * Math.sin(ph * 1.6) + 0.06 * Math.sin(ph * 5.1 + 1.3);
      if (s.mode === 1) {
        const h = hash01(s.id * 977 + Math.floor(backT * 10) * 131);
        if (h < 0.1) a *= 0.22;
        else if (h < 0.16) a *= 0.6;
      } else if (s.mode === 2) {
        const h = hash01(s.id * 613 + Math.floor(backT * 22) * 37);
        a *= h < 0.13 ? 0.35 : 1;
      }
      s._a = clamp(a * (s.hero ? 1.12 : 1), 0.06, 1);
      vis.push(s, Math.round(sx), Math.round(s.y + yOff));
    }
    if (vis.length === 0) return;

    // 先把所有光晕用 lighter 叠掉，再统一画核心，减少状态切换
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < vis.length; i += 3) {
      const s = vis[i];
      ctx.globalAlpha = s._a * 0.9;
      ctx.drawImage(s.glow, vis[i + 1] - s.glowOff, vis[i + 2] - s.glowOff);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < vis.length; i += 3) {
      const s = vis[i];
      ctx.globalAlpha = s._a;
      ctx.drawImage(s.core, vis[i + 1] - s.pad, vis[i + 2] - s.pad);
    }
    ctx.globalAlpha = 1;
  }

  _drawRain(ctx, camX, t, slow) {
    const idx = Math.round(slow * 7);
    const ft = t * (1 - slow * 0.85);
    const wind = 44 + Math.sin(ft * 0.45) * 22;
    const slant = 1 + wind * 0.012;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';

    const far = this._rainFar;
    ctx.strokeStyle = this._rainStylesFar[idx];
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < far.n; i++) {
      const x = mod(far.x[i] + ft * wind * 0.45 - camX * 0.45, RAIN_AREA_W) - 60;
      const y = mod(far.y[i] + ft * far.spd[i], RAIN_AREA_H) - 40;
      ctx.moveTo(x, y);
      ctx.lineTo(x + slant * 0.7, y + far.len[i]);
    }
    ctx.stroke();

    const near = this._rainNear;
    ctx.strokeStyle = this._rainStylesNear[idx];
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    for (let i = 0; i < near.n; i++) {
      const x = mod(near.x[i] + ft * wind - camX * 0.9, RAIN_AREA_W) - 60;
      const y = mod(near.y[i] + ft * near.spd[i], RAIN_AREA_H) - 40;
      ctx.moveTo(x, y);
      ctx.lineTo(x + slant, y + near.len[i]);
    }
    ctx.stroke();
  }

  _drawGrading(ctx, slow, flash, flashColor) {
    if (slow > 0.002) {
      // 一次 source-over 就把"压暗 + 偏青"做完，省掉一次全屏 lighter
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = slow * 0.34;
      ctx.fillStyle = this._slowDark;
      ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    }
    if (flash > 0.002) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = flash * 0.7;
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ============================================================
  // 7. 统计 / 清理
  // ============================================================

  stats() {
    return {
      layers: this.layers.length,
      buildMs: this._buildMs,
      drawMsLast: this._lastMs,
      drawMsAvg: this._msFill ? this._sumMs / this._msFill : 0,
    };
  }

  /** 切关时释放离屏画布（可选调用） */
  destroy() {
    for (let i = 0; i < this.layers.length; i++) {
      const cv = this.layers[i].canvas;
      cv.width = 0;
      cv.height = 0;
    }
    this.layers.length = 0;
    this.signs.length = 0;
    this.flyers.length = 0;
    this._visibleSigns.length = 0;
  }
}
