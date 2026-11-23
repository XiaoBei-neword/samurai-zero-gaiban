// ============================================================
// level.js —— 房间：几何、地刺、门、拾取物、静态层预渲染
// 静态层（平台/墙/地刺/装饰）在关卡加载时一次性画进一张世界大小的
// 离屏 canvas，之后每帧只 drawImage 一次 —— 这是保住 60FPS 的关键。
// ============================================================
import { T } from './const.js';
import { Decals } from '../core/particles.js';
import { clamp, makeRng, TAU } from '../core/math.js';

export class Level {
  /**
   * @param {object} def 来自 levels.js 的纯数据
   */
  constructor(def) {
    this.def = def;
    this.name = def.name;
    this.width = def.width;
    this.height = def.height;
    this.theme = def.theme;

    // 运行时几何（深拷贝，避免重开时污染原始数据）
    this.solids = def.solids.map((r) => ({ ...r }));
    this.oneway = def.oneway.map((r) => ({ ...r }));
    this.spikes = def.spikes.map((r) => ({ ...r }));
    this.spawnPoint = { ...def.spawn };
    this.door = { ...def.door, openT: 0, opened: false };
    this.cleared = false;

    this.decals = new Decals(this.width, this.height);
    this.staticLayer = null;
    this.corpses = [];
    this._buildStatic();
    this.reset();
  }

  // ---------------- 静态层预渲染 ----------------
  _buildStatic() {
    const w = Math.ceil(this.width);
    const h = Math.ceil(this.height);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    const rng = makeRng(this.def.seed || 7);
    const acc = this.theme.accent;
    const acc2 = this.theme.accent2;

    // 房间内墙底色（很暗，渐变出深度）
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, 'rgba(16,13,30,0.44)');
    bgGrad.addColorStop(0.55, 'rgba(10,8,20,0.24)');
    bgGrad.addColorStop(1, 'rgba(6,5,14,0.68)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // ---- 远处的墙面板（很淡，只是给远景一点结构，别抢主体）----
    ctx.save();
    ctx.globalAlpha = 0.3;
    for (let x = -60; x < w + 60; x += 140) {
      const bh = 200 + rng.range(0, 160);
      ctx.fillStyle = 'rgba(24,19,42,0.55)';
      ctx.fillRect(x, h - 160 - bh, 108, bh);
      ctx.strokeStyle = 'rgba(70,56,110,0.28)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, h - 160 - bh + 0.5, 107, bh);
      // 窗格
      for (let wy = h - 160 - bh + 18; wy < h - 180; wy += 34) {
        for (let wx = x + 14; wx < x + 94; wx += 26) {
          if (rng.chance(0.28)) {
            ctx.fillStyle = rng.chance(0.5) ? 'rgba(255,180,80,0.16)' : 'rgba(90,200,255,0.13)';
            ctx.fillRect(wx, wy, 14, 16);
          }
        }
      }
    }
    ctx.restore();

    // ---- 天花板 ----
    this._drawCeiling(ctx, rng, acc);

    // ---- 背景墙装饰（霓虹灯管 / 通风格栅 / 电缆槽）----
    this._drawWallDecor(ctx, rng, acc, acc2);

    // ---- 实心平台 / 墙 ----
    for (const s of this.solids) this._drawSlab(ctx, s, acc, acc2, rng, true);

    // ---- 单向平台 ----
    for (const ow of this.oneway) this._drawOneWay(ctx, ow, acc, rng);

    // ---- 地刺 ----
    for (const sp of this.spikes) this._drawSpikes(ctx, sp, acc2, rng);

    // ---- 地板湿反光 ----
    this._drawFloorReflection(ctx, acc, acc2);

    // ---- 门框 ----
    this._drawDoorFrame(ctx, acc);

    // ---- 前景装饰：管道、线缆、垂下的电线 ----
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const x = rng.range(80, w - 80);
      const top = rng.range(0, 80);
      ctx.strokeStyle = 'rgba(40,32,60,0.9)';
      ctx.lineWidth = rng.range(1, 3);
      ctx.beginPath();
      ctx.moveTo(x, top);
      const len = rng.range(60, 200);
      for (let k = 1; k <= 5; k++) {
        ctx.lineTo(x + Math.sin(k * 1.7 + i) * 6, top + (len * k) / 5);
      }
      ctx.stroke();
    }
    // 沿地板的霓虹灯带（断续）
    ctx.globalCompositeOperation = 'lighter';
    for (let x = 40; x < w - 40; x += rng.range(90, 220)) {
      const len = rng.range(30, 90);
      const yy = this.def.floorY - 3;
      const g = ctx.createLinearGradient(x, yy, x + len, yy);
      g.addColorStop(0, 'rgba(255,46,136,0)');
      g.addColorStop(0.5, `${acc}88`);
      g.addColorStop(1, 'rgba(255,46,136,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, yy, len, 2.5);
    }
    ctx.restore();

    this.staticLayer = cv;
  }

  _drawCeiling(ctx, rng, acc) {
    const w = this.width;
    // 顶部结构梁
    ctx.fillStyle = '#0a0814';
    ctx.fillRect(0, -40, w, 76);
    ctx.strokeStyle = 'rgba(70,56,110,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 36);
    ctx.lineTo(w, 36);
    ctx.stroke();
    // 顶部管线
    for (let i = 0; i < 3; i++) {
      const y = 8 + i * 9;
      ctx.strokeStyle = i === 1 ? 'rgba(80,64,120,0.55)' : 'rgba(50,42,78,0.6)';
      ctx.lineWidth = i === 1 ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // 吊灯
    for (let x = 160; x < w; x += 420) {
      ctx.fillStyle = 'rgba(30,24,45,0.9)';
      ctx.fillRect(x - 3, 36, 6, 22);
      ctx.beginPath();
      ctx.moveTo(x - 16, 74);
      ctx.lineTo(x + 16, 74);
      ctx.lineTo(x + 9, 58);
      ctx.lineTo(x - 9, 58);
      ctx.closePath();
      ctx.fillStyle = 'rgba(36,28,54,0.95)';
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, 76, 0, x, 76, 70);
      g.addColorStop(0, `${acc}30`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, 76, 70, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** 背景墙上的装饰：让空荡荡的远景有东西可看，同时不干扰判定 */
  _drawWallDecor(ctx, rng, acc, acc2) {
    const w = this.width;
    const floorY = this.def.floorY;

    // 竖向霓虹灯管（贴在墙上，隔一段一根）
    for (let x = 120; x < w - 80; x += rng.range(180, 320)) {
      const hgt = rng.range(120, 300);
      const top = rng.range(60, floorY - hgt - 60);
      const col = rng.chance(0.5) ? acc : acc2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // 灯管本体
      const g = ctx.createLinearGradient(x, top, x, top + hgt);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.15, `${col}cc`);
      g.addColorStop(0.85, `${col}cc`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, top, 2.5, hgt);
      // 光晕
      const hg = ctx.createLinearGradient(x - 26, 0, x + 26, 0);
      hg.addColorStop(0, 'rgba(0,0,0,0)');
      hg.addColorStop(0.5, `${col}22`);
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(x - 26, top, 52, hgt);
      ctx.restore();
      // 上下固定卡扣
      ctx.fillStyle = 'rgba(70,60,100,0.8)';
      ctx.fillRect(x - 4, top - 3, 10, 4);
      ctx.fillRect(x - 4, top + hgt - 1, 10, 4);
    }

    // 通风格栅
    for (let i = 0; i < Math.floor(w / 420); i++) {
      const x = rng.range(160, w - 240);
      const y = rng.range(120, floorY - 220);
      const gw = rng.range(70, 130);
      const gh = rng.range(40, 70);
      ctx.save();
      ctx.fillStyle = 'rgba(26,22,44,0.85)';
      ctx.fillRect(x, y, gw, gh);
      ctx.strokeStyle = 'rgba(90,78,140,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, gw - 1, gh - 1);
      ctx.strokeStyle = 'rgba(50,42,80,0.8)';
      for (let ly = y + 6; ly < y + gh - 4; ly += 5) {
        ctx.beginPath();
        ctx.moveTo(x + 4, ly);
        ctx.lineTo(x + gw - 4, ly);
        ctx.stroke();
      }
      // 一点点漏光
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = acc;
      ctx.fillRect(x + gw * 0.35, y + gh - 3, gw * 0.3, 1.5);
      ctx.restore();
    }

    // 横向电缆槽
    for (let y = 120; y < floorY - 120; y += rng.range(160, 260)) {
      ctx.strokeStyle = 'rgba(52,44,82,0.7)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(22,18,38,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y - 1.6);
      ctx.lineTo(w, y - 1.6);
      ctx.stroke();
    }
  }

  /** 地板边缘的湿润反光（赛博朋克的老套路，但确实有用） */
  _drawFloorReflection(ctx, acc, acc2) {
    const floorY = this.def.floorY;
    const w = this.width;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, floorY, 0, floorY + 46);
    g.addColorStop(0, `${acc}30`);
    g.addColorStop(0.35, `${acc}12`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, floorY + 2, w, 46);
    // 几道竖向的彩色反射条
    for (let x = 60; x < w; x += 260) {
      const rg = ctx.createLinearGradient(0, floorY, 0, floorY + 60);
      rg.addColorStop(0, `${acc2}22`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(x, floorY + 2, 26, 60);
    }
    ctx.restore();
  }

  /** 一块实心地台/墙体 */
  _drawSlab(ctx, s, acc, acc2, rng, isGround) {
    const g = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
    g.addColorStop(0, '#1a1426');
    g.addColorStop(0.18, '#120e1c');
    g.addColorStop(1, '#07050d');
    ctx.fillStyle = g;
    ctx.fillRect(s.x, s.y, s.w, s.h);

    // 顶面高光条
    ctx.fillStyle = 'rgba(150,140,200,0.32)';
    ctx.fillRect(s.x, s.y, s.w, 2);
    // 顶面下方的金属带（让"地面"有厚度，不是一块黑）
    const band = ctx.createLinearGradient(0, s.y, 0, s.y + 18);
    band.addColorStop(0, 'rgba(120,110,175,0.22)');
    band.addColorStop(1, 'rgba(60,54,95,0)');
    ctx.fillStyle = band;
    ctx.fillRect(s.x, s.y + 2, s.w, 18);
    // 顶面霓虹边
    ctx.globalCompositeOperation = 'lighter';
    const ng = ctx.createLinearGradient(s.x, 0, s.x + s.w, 0);
    ng.addColorStop(0, 'rgba(0,0,0,0)');
    ng.addColorStop(0.15, acc);
    ng.addColorStop(0.85, acc);
    ng.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = ng;
    ctx.fillRect(s.x, s.y - 1, s.w, 2);
    ctx.globalAlpha = 0.26;
    ctx.fillRect(s.x, s.y - 6, s.w, 11);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 底板接缝 + 侧面暗边
    ctx.strokeStyle = 'rgba(72,58,110,0.5)';
    ctx.lineWidth = 1;
    const step = 64;
    for (let x = s.x + step; x < s.x + s.w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, s.y + 4);
      ctx.lineTo(x + 0.5, s.y + s.h);
      ctx.stroke();
    }
    // 地板嵌入式指示灯（每隔一段一颗，给地面"实感"）
    ctx.globalCompositeOperation = 'lighter';
    for (let x = s.x + 26; x < s.x + s.w - 20; x += 96) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = acc;
      ctx.fillRect(x, s.y + 6, 10, 1.6);
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x - 4, s.y + 4, 18, 6);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // 底部渗出的暗影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(s.x, s.y + s.h - 3, s.w, 3);

    // 随机螺栓 / 指示灯
    if (s.w > 60) {
      const n = Math.floor(s.w / 90);
      for (let i = 0; i < n; i++) {
        const x = s.x + 20 + rng.range(0, s.w - 40);
        ctx.fillStyle = 'rgba(120,110,160,0.22)';
        ctx.fillRect(x, s.y + 7, 3, 3);
        if (rng.chance(0.35)) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = rng.chance(0.5) ? `${acc2}aa` : `${acc}aa`;
          ctx.fillRect(x + 12, s.y + 7, 5, 2);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    }
  }

  _drawOneWay(ctx, ow, acc, rng) {
    ctx.fillStyle = '#141020';
    ctx.fillRect(ow.x, ow.y, ow.w, ow.h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = acc;
    ctx.fillRect(ow.x, ow.y, ow.w, 1.6);
    ctx.globalAlpha = 0.14;
    ctx.fillRect(ow.x, ow.y - 4, ow.w, 8);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // 底部支撑
    ctx.strokeStyle = 'rgba(60,50,92,0.6)';
    ctx.lineWidth = 2;
    for (let x = ow.x + 10; x < ow.x + ow.w - 6; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, ow.y + ow.h);
      ctx.lineTo(x, ow.y + ow.h + 5);
      ctx.stroke();
    }
  }

  _drawSpikes(ctx, sp, acc2, rng) {
    // 底座
    ctx.fillStyle = '#0c0810';
    ctx.fillRect(sp.x, sp.y + sp.h - 6, sp.w, 6);
    const count = Math.max(2, Math.floor(sp.w / 14));
    const wPer = sp.w / count;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x0 = sp.x + i * wPer;
      ctx.moveTo(x0, sp.y + sp.h);
      ctx.lineTo(x0 + wPer * 0.5, sp.y - 6);
      ctx.lineTo(x0 + wPer, sp.y + sp.h);
    }
    const g = ctx.createLinearGradient(0, sp.y - 6, 0, sp.y + sp.h);
    g.addColorStop(0, '#ffe3ec');
    g.addColorStop(0.35, '#ff5d7f');
    g.addColorStop(1, '#3a0a18');
    ctx.fillStyle = g;
    ctx.fill();
    // 尖端发光
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const x0 = sp.x + i * wPer;
      const cx = x0 + wPer * 0.5;
      const gg = ctx.createRadialGradient(cx, sp.y - 4, 0, cx, sp.y - 4, 10);
      gg.addColorStop(0, 'rgba(255,90,130,0.5)');
      gg.addColorStop(1, 'rgba(255,90,130,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(cx, sp.y - 4, 10, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawDoorFrame(ctx, acc) {
    const d = this.def.door;
    ctx.save();
    // 门洞（很暗，里面渐黑）
    const g = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y + d.h);
    g.addColorStop(0, '#05030a');
    g.addColorStop(1, '#0b0714');
    ctx.fillStyle = g;
    ctx.fillRect(d.x, d.y, d.w, d.h);
    // 门框
    ctx.strokeStyle = `${acc}cc`;
    ctx.lineWidth = 3;
    ctx.strokeRect(d.x + 1.5, d.y + 1.5, d.w - 3, d.h - 3);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = acc;
    ctx.lineWidth = 9;
    ctx.strokeRect(d.x + 1.5, d.y + 1.5, d.w - 3, d.h - 3);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // 门框上的警示条纹
    ctx.fillStyle = 'rgba(255,179,71,0.55)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(d.x - 4, d.y + 10 + i * 20, 3, 10);
    }
    ctx.restore();
  }

  // ---------------- 运行时 ----------------

  reset() {
    this.cleared = false;
    this.door.openT = 0;
    this.door.opened = false;
    this.decals.clear();
    this.corpses.length = 0;
  }

  clear() {
    this.cleared = true;
    this.door.opened = true;
  }

  update(dt) {
    if (this.door.opened && this.door.openT < 1) {
      this.door.openT = clamp(this.door.openT + dt / T.doorOpenTime, 0, 1);
    }
    if (!this.door.opened && this.door.openT > 0) {
      this.door.openT = clamp(this.door.openT - dt / T.doorOpenTime, 0, 1);
    }
  }

  /** 门是否真的能进（开启动画过半） */
  get doorUsable() {
    return this.cleared && this.door.openT > 0.55;
  }

  /** 地刺的实际致命范围（比视觉略微内缩，避免"擦边秒死"的憋屈感） */
  get hazards() {
    if (!this._hazards) {
      this._hazards = this.spikes.map((sp) => ({
        x: sp.x + 3,
        y: sp.y - 2,
        w: sp.w - 6,
        h: sp.h + 4,
      }));
    }
    return this._hazards;
  }

  /** 把血迹画进贴花层 */
  splat(x, y, size, group) {
    this.decals.splat(x, y, size, group);
  }

  // ---------------- 绘制 ----------------
  /**
   * 只把"相机看得见的那一块"静态层 blit 上来。
   * 全图 1920x720 每次都缩放贴一遍在软件光栅下很贵，裁到可见区域能省一半以上。
   */
  drawStatic(ctx, view) {
    const lw = this.staticLayer.width;
    const lh = this.staticLayer.height;
    if (!view) {
      ctx.drawImage(this.staticLayer, 0, 0);
      return;
    }
    let sx = Math.max(0, Math.floor(view.x) - 2);
    let sy = Math.max(0, Math.floor(view.y) - 2);
    let sw = Math.min(lw - sx, Math.ceil(view.w) + 4);
    let sh = Math.min(lh - sy, Math.ceil(view.h) + 4);
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(this.staticLayer, sx, sy, sw, sh, sx, sy, sw, sh);
    this.decals.draw(ctx);
  }

  drawDynamic(ctx, time, px = 2.46) {
    // ---- 门 ----
    const d = this.door;
    const open = d.openT;
    // 门扇：关闭时是一整块金属板，开启时向上收起
    const slabH = d.h * (1 - open);
    if (slabH > 0.5) {
      const g = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y);
      g.addColorStop(0, '#141019');
      g.addColorStop(0.5, '#221a2e');
      g.addColorStop(1, '#100c16');
      ctx.fillStyle = g;
      ctx.fillRect(d.x, d.y + d.h - slabH, d.w, slabH);
      ctx.strokeStyle = 'rgba(120,100,170,0.35)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(d.x + (d.w * i) / 4, d.y + d.h - slabH);
        ctx.lineTo(d.x + (d.w * i) / 4, d.y + d.h);
        ctx.stroke();
      }
    }
    if (open > 0.02) {
      // 开启后的内部光
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(
        d.x + d.w / 2,
        d.y + d.h / 2,
        0,
        d.x + d.w / 2,
        d.y + d.h / 2,
        d.w * 1.6,
      );
      g.addColorStop(0, `rgba(120,255,235,${0.42 * open})`);
      g.addColorStop(0.5, `rgba(40,200,255,${0.16 * open})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(d.x - d.w, d.y - d.h, d.w * 3, d.h * 3);
      // 竖直光柱
      ctx.globalAlpha = 0.5 * open;
      ctx.fillStyle = 'rgba(140,255,240,0.5)';
      ctx.fillRect(d.x + 4, d.y + 2, d.w - 8, d.h - 4);
      ctx.restore();
      // 门里的星点
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const t = (time * 0.7 + i * 0.37) % 1;
        const px = d.x + d.w * 0.5 + Math.sin(i * 2.1 + time) * d.w * 0.3;
        const py = d.y + d.h - t * d.h;
        ctx.globalAlpha = (1 - t) * open * 0.9;
        ctx.fillStyle = '#b8fff4';
        ctx.fillRect(px, py, 2, 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

  }
}
