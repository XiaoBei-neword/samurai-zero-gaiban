// ============================================================
// camera.js —— 带阻尼的跟随摄像机
// 公开算法：指数阻尼 damp(a,b,λ,dt) = b + (a-b)*exp(-λ*dt)
// 自己实现：速度前瞻、垂直死区、关卡边界钳制、屏震、冲刺微缩放
// ============================================================
import { clamp, damp, rnd } from './math.js';

export class Camera {
  constructor(viewW, viewH, baseZoom = 1) {
    this.viewW = viewW;
    this.viewH = viewH;
    this.baseZoom = baseZoom;
    // 摄像机中心（世界坐标）
    this.x = 0;
    this.y = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.ix = 0; // 插值后的渲染位置
    this.iy = 0;
    this.zoom = baseZoom;
    this.targetZoom = baseZoom;
    // 屏震
    this.shakeAmp = 0;
    this.shakeDecay = 6;
    this.shakeX = 0;
    this.shakeY = 0;
    this._shakeSeed = 0;
    // 跟随参数
    this.lambdaX = 7.5;
    this.lambdaY = 5.2;
    this.bounds = { x: 0, y: 0, w: viewW, h: viewH };
    this.lookahead = 0;
    this.freeze = false;
  }

  setBounds(x, y, w, h) {
    this.bounds = { x, y, w, h };
    this.clampNow();
  }

  /** 直接吸附到目标（切关、重开时用，避免镜头飞过去） */
  snapTo(tx, ty) {
    this.x = tx;
    this.y = ty;
    this.prevX = tx;
    this.prevY = ty;
    this.ix = tx;
    this.iy = ty;
    this.shakeAmp = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.zoom = this.baseZoom;
    this.targetZoom = this.baseZoom;
    this.clampNow();
  }

  shake(amp, decay = 6) {
    if (amp > this.shakeAmp) {
      this.shakeAmp = amp;
      this.shakeDecay = decay;
      this._shakeSeed = rnd(0, 1000);
    }
  }

  /**
   * 每物理步更新一次。
   * @param {number} dt      玩家时间增量（保证减速时镜头手感一致）
   * @param {{x:number,y:number,vx:number,vy:number,grounded:boolean,dashing:boolean}} p
   */
  update(dt, p) {
    this.prevX = this.x;
    this.prevY = this.y;

    // 水平：速度前瞻，冲刺时稍微拉远
    const lead = clamp(p.vx * 0.26, -150, 150);
    this.lookahead = damp(this.lookahead, lead, 3.2, dt);
    const tx = p.x + this.lookahead;

    // 垂直：地面跟得紧，空中只跟一部分（避免每次跳跃镜头上下甩）
    let tyTarget = p.y - 34;
    if (!p.grounded) {
      const airOffset = clamp(p.vy * 0.16, -70, 130);
      tyTarget = p.y - 34 + airOffset * 0.55;
    }
    // 死区：小范围不动
    const dy = tyTarget - this.y;
    if (Math.abs(dy) > 46) tyTarget = this.y + dy - Math.sign(dy) * 46;
    else tyTarget = this.y;

    const lx = p.dashing ? 4.2 : this.lambdaX;
    const ly = p.grounded ? this.lambdaY : this.lambdaY * 0.75;

    if (!this.freeze) {
      this.x = damp(this.x, tx, lx, dt);
      this.y = damp(this.y, tyTarget, ly, dt);
    }

    // 微缩放：冲刺时视野轻微拉开
    this.targetZoom = this.baseZoom * (p.dashing ? 0.965 : 1);
    this.zoom = damp(this.zoom, this.targetZoom, 8, dt);

    this.clampNow();

    // 屏震衰减
    if (this.shakeAmp > 0.01) {
      this.shakeAmp *= Math.exp(-this.shakeDecay * dt);
      const s = this.shakeAmp;
      this._shakeSeed += dt * 60;
      this.shakeX = Math.sin(this._shakeSeed * 2.9) * s + (Math.random() - 0.5) * s * 0.7;
      this.shakeY = Math.cos(this._shakeSeed * 3.7) * s * 0.8 + (Math.random() - 0.5) * s * 0.7;
    } else {
      this.shakeAmp = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  clampNow() {
    const b = this.bounds;
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (b.w <= halfW * 2) this.x = b.x + b.w / 2;
    else this.x = clamp(this.x, b.x + halfW, b.x + b.w - halfW);
    if (b.h <= halfH * 2) this.y = b.y + b.h / 2;
    else this.y = clamp(this.y, b.y + halfH, b.y + b.h - halfH);
  }

  /** 渲染插值（在渲染前调用一次） */
  interpolate(alpha) {
    this.ix = this.prevX + (this.x - this.prevX) * alpha;
    this.iy = this.prevY + (this.y - this.prevY) * alpha;
    // 插值后可能越界，再钳一次
    const b = this.bounds;
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (b.w > halfW * 2) this.ix = clamp(this.ix, b.x + halfW, b.x + b.w - halfW);
    else this.ix = b.x + b.w / 2;
    if (b.h > halfH * 2) this.iy = clamp(this.iy, b.y + halfH, b.y + b.h - halfH);
    else this.iy = b.y + b.h / 2;
  }

  /** 世界绘制前调用。摇晃只影响画面，不影响鼠标→世界的换算 */
  applyTransform(ctx) {
    ctx.translate(this.viewW / 2 + this.shakeX, this.viewH / 2 + this.shakeY);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.ix, -this.iy);
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.ix,
      y: (sy - this.viewH / 2) / this.zoom + this.iy,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.ix) * this.zoom + this.viewW / 2,
      y: (wy - this.iy) * this.zoom + this.viewH / 2,
    };
  }

  /** 当前可视矩形（世界坐标） */
  viewRect() {
    const w = this.viewW / this.zoom;
    const h = this.viewH / this.zoom;
    return { x: this.ix - w / 2, y: this.iy - h / 2, w, h };
  }
}
