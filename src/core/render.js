// ============================================================
// render.js —— Canvas 2D 底层：画布尺寸、信箱缩放、光晕缓存、文字、全屏闪光
// 关键性能约定：
//   * 内部分辨率固定 1280x720，与窗口大小解耦 → 帧耗时稳定
//   * 光晕一律预渲染成离屏 canvas，用 drawImage + 'lighter' 叠加
//   * 每帧不创建 CanvasGradient / Path2D / shadowBlur
// ============================================================
import { clamp01 } from './math.js';

export const VIEW_W = 1280;
export const VIEW_H = 720;

const FONT_STACK = '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
const MONO_STACK = 'Consolas, "Cascadia Mono", "Courier New", monospace';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: false,
      powerPreference: 'high-performance',
    });
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.textBaseline = 'alphabetic';

    // ---------------- 像素风：世界先画到 1/2 分辨率的离屏画布，再 2x 最近邻放大 ----------------
    // 好处：1) 满屏大颗粒像素，像真的像素游戏；2) 世界部分只画 1/4 的像素数，更快。
    this.pixelScale = 3;
    this.sceneW = VIEW_W / this.pixelScale;
    this.sceneH = VIEW_H / this.pixelScale;
    this.scene = document.createElement('canvas');
    this.scene.width = this.sceneW;
    this.scene.height = this.sceneH;
    this.sctx = this.scene.getContext('2d', { alpha: false });
    this.sctx.imageSmoothingEnabled = false;

    this._glowCache = new Map();
    this._vignette = null;
    this._grain = null;
    this.grainEnabled = true;
    this._flashColor = '#ffffff';
    this._flashAlpha = 0;
    this._cssRect = { left: 0, top: 0, width: VIEW_W, height: VIEW_H };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** 世界绘制入口：返回半分辨率场景的 ctx（已带 0.5 基础缩放，坐标仍是 1280x720 逻辑坐标） */
  beginScene(color = '#050409') {
    const c = this.sctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = color;
    c.fillRect(0, 0, this.sceneW, this.sceneH);
    c.setTransform(1 / this.pixelScale, 0, 0, 1 / this.pixelScale, 0, 0);
    return c;
  }

  /** 场景 → 屏幕：最近邻放大，得到硬边像素 */
  endScene() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.scene, 0, 0, VIEW_W, VIEW_H);
    // HUD 用全分辨率绘制，文字保持清晰
    ctx.imageSmoothingEnabled = true;
    return ctx;
  }

  /** 把 1280x720 逻辑画布按 16:9 信箱式塞进窗口 */
  resize() {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const targetAspect = VIEW_W / VIEW_H;
    let w = vw;
    let h = vw / targetAspect;
    if (h > vh) {
      h = vh;
      w = vh * targetAspect;
    }
    // 略微留边，看起来像一台 CRT/显示器
    const pad = Math.min(28, Math.floor(Math.min(vw, vh) * 0.02));
    w = Math.max(320, w - pad * 2);
    h = Math.max(180, h - pad * 2);
    const c = this.canvas;
    c.style.width = `${Math.round(w)}px`;
    c.style.height = `${Math.round(h)}px`;
    this._updateRect();
    this._buildOverlays();
  }

  _updateRect() {
    const r = this.canvas.getBoundingClientRect();
    this._cssRect = { left: r.left, top: r.top, width: r.width || VIEW_W, height: r.height || VIEW_H };
  }

  /** input 用的坐标映射：client 像素 → 逻辑屏幕坐标 */
  clientToLogical(cx, cy) {
    // 每次都读 rect：窗口移动/缩放下仍然正确（getBoundingClientRect 很便宜）
    const r = this.canvas.getBoundingClientRect();
    this._cssRect = { left: r.left, top: r.top, width: r.width || VIEW_W, height: r.height || VIEW_H };
    return {
      x: ((cx - r.left) / this._cssRect.width) * VIEW_W,
      y: ((cy - r.top) / this._cssRect.height) * VIEW_H,
    };
  }

  _buildOverlays() {
    // 暗角
    const v = document.createElement('canvas');
    v.width = VIEW_W;
    v.height = VIEW_H;
    const vc = v.getContext('2d');
    const g = vc.createRadialGradient(
      VIEW_W / 2,
      VIEW_H / 2,
      VIEW_H * 0.34,
      VIEW_W / 2,
      VIEW_H / 2,
      VIEW_H * 0.92,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(2,1,8,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0.72)');
    vc.fillStyle = g;
    vc.fillRect(0, 0, VIEW_W, VIEW_H);
    this._vignette = v;

    // 胶片颗粒（减缓时间时叠一点，增加"时间被拉长"的质感）
    if (!this._grain) {
      const n = document.createElement('canvas');
      n.width = 256;
      n.height = 256;
      const nc = n.getContext('2d');
      const img = nc.createImageData(256, 256);
      for (let i = 0; i < 256 * 256; i++) {
        const v2 = 120 + Math.random() * 135;
        img.data[i * 4] = v2;
        img.data[i * 4 + 1] = v2;
        img.data[i * 4 + 2] = v2;
        img.data[i * 4 + 3] = Math.random() * 90;
      }
      nc.putImageData(img, 0, 0);
      this._grain = n;
    }
  }

  begin() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return ctx;
  }

  /** 预渲染的径向光晕精灵（缓存，key = 颜色+半径） */
  glowSprite(color, radius) {
    const key = `${color}|${radius}`;
    let c = this._glowCache.get(key);
    if (c) return c;
    const size = Math.max(4, Math.ceil(radius * 2));
    c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    this._glowCache.set(key, c);
    return c;
  }

  /** 在世界里画一团光（调用方已在相机变换内） */
  drawGlow(x, y, radius, color, alpha = 1) {
    const s = this.glowSprite(color, radius);
    const ctx = this.ctx;
    const prevOp = ctx.globalCompositeOperation;
    const prevA = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.drawImage(s, x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevA;
  }

  /** 屏幕空间：全屏闪光（死亡红闪、切关白闪） */
  setFlash(color, alpha) {
    this._flashColor = color;
    this._flashAlpha = clamp01(alpha);
  }

  /** 渲染最后一步：暗角 + 颗粒 + 闪光 */
  finish(slowAmount = 0, grainTime = 0) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this._vignette) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(this._vignette, 0, 0);
    }
    if (this.grainEnabled && slowAmount > 0.01 && this._grain) {
      ctx.globalAlpha = 0.06 + slowAmount * 0.12;
      ctx.globalCompositeOperation = 'overlay';
      const ox = (Math.sin(grainTime * 91.7) * 0.5 + 0.5) * 256;
      const oy = (Math.cos(grainTime * 57.3) * 0.5 + 0.5) * 256;
      for (let y = -256; y < VIEW_H; y += 256) {
        for (let x = -256; x < VIEW_W; x += 256) {
          ctx.drawImage(this._grain, x + ox, y + oy);
        }
      }
    }
    if (this._flashAlpha > 0.002) {
      ctx.globalAlpha = this._flashAlpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = this._flashColor;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------
  // 文字
  // ------------------------------------------------------------
  text(str, x, y, opt = {}) {
    const ctx = this.ctx;
    const size = opt.size || 16;
    const weight = opt.weight || '400';
    const mono = opt.mono || false;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = opt.alpha === undefined ? 1 : opt.alpha;
    ctx.fillStyle = opt.color || '#e8e6f2';
    ctx.font = `${weight} ${size}px ${mono ? MONO_STACK : FONT_STACK}`;
    ctx.textAlign = opt.align || 'left';
    if (opt.glow) {
      ctx.shadowColor = opt.glow;
      ctx.shadowBlur = opt.glowBlur || 16;
    }
    if (opt.spacing) {
      // 手动字距（Canvas 2D 的 letterSpacing 兼容性不稳）
      const chars = Array.from(str);
      let total = 0;
      const widths = chars.map((ch) => {
        const w = ctx.measureText(ch).width;
        total += w;
        return w;
      });
      total += opt.spacing * (chars.length - 1);
      let cx = ctx.textAlign === 'center' ? x - total / 2 : ctx.textAlign === 'right' ? x - total : x;
      const prevAlign = ctx.textAlign;
      ctx.textAlign = 'left';
      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(chars[i], cx, y);
        cx += widths[i] + opt.spacing;
      }
      ctx.textAlign = prevAlign;
    } else {
      ctx.fillText(str, x, y);
    }
    if (opt.glow) {
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
    ctx.globalAlpha = prevA;
  }

  measure(str, size, weight = '400', mono = false) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${mono ? MONO_STACK : FONT_STACK}`;
    return ctx.measureText(str).width;
  }

  /** 一条细线（UI 用） */
  line(x0, y0, x1, y1, color, width = 1, alpha = 1) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** 圆角矩形路径填充（UI 面板用） */
  roundRect(x, y, w, h, r, fill, stroke, lineW = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineW;
      ctx.stroke();
    }
  }
}
