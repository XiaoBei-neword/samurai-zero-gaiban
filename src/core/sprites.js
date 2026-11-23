// ============================================================
// sprites.js —— 像素风角色/道具绘制（全部程序化，没有任何外部素材）
//
// 关键：整个世界渲染在 1/3 分辨率的场景画布上（render.js 的 pixelScale=3），
// 所以这里的"1 像素"≈ 世界坐标里 px = (pixelScale / 相机 zoom) ≈ 2 世界单位。
// 所有形状先按 px 对齐（snap），再用矩形拼出来 —— 放大 3 倍之后每个方块都是
// 硬边像素，而不是"矢量图形缩小再放大"的糊边。
//
// 角色高度约 20~24 像素，这是像素动作游戏里常见的比例。
// ============================================================
import { clamp, TAU } from './math.js';

/** 一个世界像素有多大（调用方会传真实值；缺省按 pixelScale=3 / zoom=1.5 估算） */
export const DEFAULT_PX = 2;

export const BODY_H = { player: 52, ronin: 56, gunner: 54, shield: 62 };

const snap = (v, px) => Math.round(v / px) * px;

/** 以像素为单位画矩形；w/h 至少 1 像素 */
function pr(ctx, px, x, y, w, h, color) {
  const W = Math.max(1, Math.round(w)) * px;
  const H = Math.max(1, Math.round(h)) * px;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), W, H);
}

/** 地面接触阴影（几块像素，不用椭圆） */
export function drawGroundShadow(ctx, x, y, w, alpha = 0.45, px = DEFAULT_PX) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  const W = Math.max(2, Math.round((w * 2) / px)) * px;
  ctx.fillRect(snap(x - W / 2, px), snap(y + px, px), W, px);
  ctx.restore();
}

/** 小亮点（块状，不用径向渐变） */
function pixelGlow(ctx, px, x, y, r, color, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const R = Math.max(1, Math.round(r)) * px;
  ctx.fillRect(snap(x - R, px), snap(y - R, px), R * 2, R * 2);
  ctx.restore();
}

/**
 * 通用像素人形（头 + 躯干 + 两腿 + 两手），全部用对齐到像素格的矩形拼成。
 * pose: { legA, legB, armA, armB, bob, crouch, headTilt }
 * spec: { body, bodyLit, armFront, armBack, legFront, legBack, boot, belt, accent, visor, hood, helmet, bulk }
 */
function humanoid(ctx, px, x, y, facing, pose, spec) {
  const S = (n) => snap(n * px, px);
  const F = facing >= 0 ? 1 : -1;
  const bulk = spec.bulk || 0; // 0 玩家 / 1 浪人·枪手 / 2 铁卫

  const ox = snap(x, px);
  const oy = snap(y, px);
  const bob = Math.round(pose.bob || 0) * px;
  const crouch = Math.round(pose.crouch || 0) * px;

  const legH = 7 + bulk;
  const hipY = oy - S(legH) + bob + crouch;
  const shoulderY = oy - S(14 + bulk * 2) + bob + crouch;
  const headY = oy - S(19 + bulk * 2) + bob + crouch;
  const headW = 5 + Math.floor(bulk / 2);
  const headH = 5;
  const bodyW = 6 + bulk;
  const bodyH = 7 + bulk;
  const hipW = 4 + bulk;

  // ---- 腿 ----
  const swing = Math.round((pose.legA || 0) * 2) * px;
  const lift = Math.round((pose.legB || 0) * 1.5) * px;
  pr(ctx, px, ox - S(2) + swing, hipY, 2, legH, spec.legBack);
  pr(ctx, px, ox - lift, hipY, 2, legH, spec.legFront);
  pr(ctx, px, ox - lift + F * px, oy - px, 3, 1, spec.boot);

  // ---- 后手 ----
  const armSwing = Math.round((pose.armB || 0) * 1.5) * px;
  pr(ctx, px, ox - F * S(1), shoulderY + S(1) + armSwing, 2, 5, spec.armBack);

  // ---- 躯干 ----
  pr(ctx, px, ox - S(bodyW / 2), shoulderY, bodyW, bodyH, spec.body);
  pr(ctx, px, ox + F * S(bodyW / 2 - 1), shoulderY, 1, bodyH, spec.bodyLit);
  pr(ctx, px, ox - S(hipW / 2), hipY - S(1), hipW, 1, spec.belt);

  // ---- 头 ----
  pr(ctx, px, ox - S(headW / 2), headY, headW, headH, spec.body);
  pr(ctx, px, ox - S(headW / 2), headY, headW, 1, spec.bodyLit);
  pr(ctx, px, ox + (F > 0 ? -S(1) : -S(2)), headY + S(2), 3, 1, spec.visor || spec.accent);

  // ---- 兜帽 / 头盔 ----
  if (spec.hood) {
    pr(ctx, px, ox - S(headW / 2) - px, headY - px, headW + 2, 2, spec.hood);
    pr(ctx, px, ox - F * S(3), headY, 1, 3, spec.hood);
  }
  if (spec.helmet) {
    pr(ctx, px, ox - S(headW / 2), headY - px, headW, 1, spec.helmet);
    pr(ctx, px, ox - S(headW / 2) - px, headY + S(2), headW + 2, 1, spec.helmet);
  }

  // ---- 前手 ----
  const armPose = Math.round((pose.armA || 0) * 2) * px;
  const handX = ox + F * S(3);
  const handY = shoulderY + S(2) - armPose;
  pr(ctx, px, handX - F * S(1), handY, 2, 5, spec.armFront);
  return { handX, handY, S, F, ox, oy };
}

/** 像素刀：一条 1px 粗的斜线，由一格格方块拼出来 */
function pixelBlade(ctx, px, x, y, angle, lenPx, color, glow) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let i = 0; i < lenPx; i++) {
    const bx = x + ca * i * px;
    const by = y + sa * i * px;
    pr(ctx, px, bx, by, 1, 1, i / lenPx > 0.86 ? glow : color);
  }
}

// ------------------------------------------------------------
// 玩家：武士
// ------------------------------------------------------------
export function drawSamurai(ctx, o) {
  const {
    x, y, facing = 1, state = 'idle', animT = 0, slash = null, slow = 0, alpha = 1, ghost = false,
    px = DEFAULT_PX,
  } = o;
  const S = (n) => snap(n * px, px);

  ctx.save();
  ctx.globalAlpha = alpha;
  if (!ghost) drawGroundShadow(ctx, x, y, 8, 0.4, px);

  let bob = 0;
  let legA = 0;
  let legB = 0;
  let armA = 1;
  let armB = 0;
  let crouch = 0;
  if (state === 'run') {
    const ph = animT * 15;
    legA = Math.sin(ph) * 1.2;
    legB = -legA;
    bob = -Math.abs(Math.cos(ph)) * 1.2;
    armA = 0.4 + Math.sin(ph) * 0.5;
  } else if (state === 'jump') {
    legA = 1.4;
    legB = -0.8;
    armA = 1.8;
  } else if (state === 'fall') {
    legA = -0.6;
    legB = 0.8;
    armA = 0.8;
  } else if (state === 'dash') {
    legA = 2.2;
    legB = 1.2;
    bob = 1;
    armA = 2.4;
  } else if (state === 'wall') {
    legA = 0.4;
    legB = -0.6;
  } else if (state === 'slash') {
    crouch = 1;
  } else {
    bob = Math.sin(animT * 2.6) * 0.6;
  }

  // 围巾：一格格像素朝身后拖（玩家最好认的识别物）
  const scarfCol = slow > 0.35 ? '#2ec8e0' : '#e01b45';
  const scarfCol2 = slow > 0.35 ? '#7ff0ff' : '#ff5470';
  const back = -Math.round(facing);
  const flap = Math.round(Math.sin(animT * 10) * 0.6);
  for (let i = 0; i < 5; i++) {
    pr(
      ctx,
      px,
      x + back * S(2 + i),
      y - S(15 - i * 0.4) + (i >= 4 ? flap * px : 0),
      1,
      1,
      i < 3 ? scarfCol : scarfCol2,
    );
  }

  const spec = {
    body: ghost ? '#123a49' : '#5b5099',
    bodyLit: ghost ? '#1d5568' : '#7b6fc0',
    armFront: ghost ? '#1d5568' : '#6f63ad',
    armBack: ghost ? '#123a49' : '#3a3260',
    legFront: ghost ? '#16414f' : '#4a4178',
    legBack: ghost ? '#0e2c38' : '#332c56',
    boot: ghost ? '#0b2230' : '#1a1530',
    belt: ghost ? '#0e2c38' : '#2a2246',
    accent: slow > 0.35 ? '#5fe6ff' : '#22e0ff',
    visor: slow > 0.35 ? '#bffbff' : '#8ff6ff',
    bulk: 0,
  };

  const res = humanoid(ctx, px, x, y, facing, { legA, legB, armA, armB, bob, crouch }, spec);

  // 刀
  let bladeAngle;
  if (slash) bladeAngle = slash.angle;
  else bladeAngle = facing > 0 ? 0.45 : Math.PI - 0.45;
  if (state === 'dash') bladeAngle = facing > 0 ? 0 : Math.PI;
  pr(ctx, px, res.handX, res.handY, 1, 1, '#2f2540');
  pixelBlade(ctx, px, res.handX, res.handY, bladeAngle, 10, '#eaffff', '#9fd8ff');

  if (!ghost) {
    pixelGlow(ctx, px, x + facing * 2, y - S(9), 1, 'rgba(90,220,255,0.8)', 0.22 + 0.1 * Math.sin(animT * 3));
  }
  ctx.restore();
}

// ------------------------------------------------------------
// 敌人 1：浪人（近战，刀比玩家短）
// ------------------------------------------------------------
export function drawRonin(ctx, o) {
  const { x, y, facing = 1, state = 'idle', animT = 0, windup = 0, alpha = 1, px = DEFAULT_PX } = o;
  const S = (n) => snap(n * px, px);
  ctx.save();
  ctx.globalAlpha = alpha;
  drawGroundShadow(ctx, x, y, 9, 0.45, px);

  let bob = Math.sin(animT * 2) * 0.6;
  let legA = 0;
  let legB = 0;
  let armA = 0.8;
  let armB = 0;
  if (state === 'chase') {
    const ph = animT * 13;
    legA = Math.sin(ph) * 1.3;
    legB = -legA;
    bob = -Math.abs(Math.cos(ph)) * 1.2;
    armA = 1.2;
  } else if (state === 'windup') {
    legA = 0.8;
    legB = -0.5;
    armA = -1.2;
  } else if (state === 'attack') {
    legA = 1.2;
    armA = 2.2;
  }

  const spec = {
    body: '#63394b',
    bodyLit: '#8a5266',
    armFront: '#7a465c',
    armBack: '#46283a',
    legFront: '#55303f',
    legBack: '#3a2130',
    boot: '#231420',
    belt: '#2a1a26',
    accent: windup > 0 ? '#ff9db0' : '#ff3d8f',
    hood: '#7a465c',
    bulk: 1,
  };
  const res = humanoid(ctx, px, x, y, facing, { legA, legB, armA, armB, bob, crouch: 0 }, spec);

  const bladeAngle =
    state === 'windup' ? facing * -2.4 : state === 'attack' ? facing * 0.12 : facing > 0 ? 0.5 : Math.PI - 0.5;
  pixelBlade(ctx, px, res.handX, res.handY, bladeAngle, state === 'attack' ? 11 : 9, '#ffd6e0', '#ff2e88');
  pixelGlow(ctx, px, x + facing * 2, y - S(10), 2, 'rgba(255,60,120,0.8)', 0.35);

  // 蓄力警示：头顶一颗闪的方块
  if (windup > 0) {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(animT * 30);
    pr(ctx, px, x - px, y - S(24), 3, 3, '#ff3355');
    ctx.restore();
  }
  ctx.restore();
}

// ------------------------------------------------------------
// 敌人 2：枪手（远程）
// ------------------------------------------------------------
export function drawGunner(ctx, o) {
  const {
    x, y, facing = 1, state = 'idle', animT = 0, aimAngle = 0, alpha = 1, alert = 0, px = DEFAULT_PX,
  } = o;
  const S = (n) => snap(n * px, px);
  ctx.save();
  ctx.globalAlpha = alpha;
  drawGroundShadow(ctx, x, y, 8, 0.45, px);

  let bob = Math.sin(animT * 2.2) * 0.5;
  let legA = 0;
  if (state === 'chase') {
    const ph = animT * 12;
    legA = Math.sin(ph) * 1.2;
    bob = -Math.abs(Math.cos(ph)) * 1;
  }

  const spec = {
    body: '#2f6383',
    bodyLit: '#4a8cae',
    armFront: '#44809f',
    armBack: '#1f4459',
    legFront: '#2a5670',
    legBack: '#1b3a4c',
    boot: '#122a38',
    belt: '#173444',
    accent: '#7ff0ff',
    helmet: '#1f4459',
    visor: '#c9fbff',
    bulk: 1,
  };
  const res = humanoid(ctx, px, x, y, facing, { legA, legB: -legA, armA: 1, armB: 0, bob, crouch: 0 }, spec);

  // 枪（一条几像素的枪管 + 枪口火光）
  const gunAngle = state === 'aim' || state === 'fire' ? aimAngle : facing > 0 ? 0.05 : Math.PI - 0.05;
  const gx = res.handX;
  const gy = res.handY + S(1);
  const ca = Math.cos(gunAngle);
  const sa = Math.sin(gunAngle);
  for (let i = 0; i < 4; i++) {
    pr(ctx, px, gx + ca * i * px, gy + sa * i * px, 1, 1, i === 3 ? '#9df0ff' : '#3c5570');
  }
  if (state === 'fire') pixelGlow(ctx, px, gx + ca * px * 5, gy + sa * px * 5, 2, 'rgba(255,240,190,0.95)', 0.95);
  pixelGlow(ctx, px, x + facing * 2, y - S(9), 2, 'rgba(40,210,255,0.8)', 0.3);

  if (alert > 0) {
    ctx.save();
    ctx.globalAlpha = alert;
    pr(ctx, px, x - px, y - S(25), 2, 4, '#ff3c5a');
    pr(ctx, px, x - px, y - S(20), 2, 1, '#ff3c5a');
    ctx.restore();
  }
  ctx.restore();
}

// ------------------------------------------------------------
// 敌人 3：铁卫（护盾，正面免疫近战）
// ------------------------------------------------------------
export function drawShield(ctx, o) {
  const {
    x, y, facing = 1, state = 'idle', animT = 0, shieldUp = 1, alpha = 1, blockFlash = 0,
    px = DEFAULT_PX,
  } = o;
  const S = (n) => snap(n * px, px);
  ctx.save();
  ctx.globalAlpha = alpha;
  drawGroundShadow(ctx, x, y, 11, 0.5, px);

  let bob = Math.sin(animT * 1.7) * 0.5;
  let legA = 0;
  if (state === 'chase') {
    const ph = animT * 8.5;
    legA = Math.sin(ph) * 0.7;
    bob = -Math.abs(Math.cos(ph)) * 0.8;
  } else if (state === 'bash') {
    legA = 1.4;
  }

  const spec = {
    body: '#5e4a35',
    bodyLit: '#8a6b48',
    armFront: '#7d5f3e',
    armBack: '#43331f',
    legFront: '#51402c',
    legBack: '#33261a',
    boot: '#1f1810',
    belt: '#2a2015',
    accent: '#ffb347',
    helmet: '#43331f',
    visor: '#ff8a2a',
    bulk: 2,
  };
  humanoid(ctx, px, x, y, facing, { legA, legB: -legA, armA: 0.6, armB: 0, bob, crouch: 0 }, spec);

  // 盾：一整块像素板（上沿亮、下沿厚、中间一颗盾脐）
  if (shieldUp > 0.01) {
    ctx.save();
    ctx.globalAlpha = alpha * shieldUp;
    const sw = 5;
    const sh = 12;
    const bx = x + facing * S(4);
    const by = y - S(13);
    pr(ctx, px, bx - S(sw / 2), by, sw, sh, '#7a5c30');
    pr(ctx, px, bx - S(sw / 2), by, 1, sh, '#a8813f');
    pr(ctx, px, bx - S(sw / 2), by + S(1), sw, 1, '#c99a4e');
    pr(ctx, px, bx - S(sw / 2), by + S(sh - 2), sw, 2, '#4a3722');
    pr(ctx, px, bx - S(1), by + S(5), 2, 2, '#ffd08a');
    if (blockFlash > 0) {
      ctx.globalAlpha = alpha * blockFlash * 0.85;
      pr(ctx, px, bx - S(4), by - S(1), 8, sh + 2, '#ffe6b0');
    }
    ctx.restore();
  }
  pixelGlow(ctx, px, x - facing * 2, y - S(9), 2, 'rgba(255,150,50,0.8)', 0.3);
  ctx.restore();
}

// ------------------------------------------------------------
// 刀光：沿弧线排一串像素方块（像素化的弧光）
// ------------------------------------------------------------
export function drawSlashArc(ctx, cx, cy, radius, angle, halfAngle, progress, colorA, colorB, px = DEFAULT_PX) {
  const sweep = halfAngle * 2;
  const head = angle - halfAngle + sweep * (0.12 + progress * 0.92);
  const tail = angle - halfAngle + sweep * Math.max(0, progress * 0.9 - 0.32);
  const steps = Math.max(8, Math.round(((head - tail) * radius) / px));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let layer = 0; layer < 2; layer++) {
    const rr = radius * (layer === 0 ? 1 : 0.82);
    ctx.fillStyle = layer === 0 ? colorA : colorB;
    ctx.globalAlpha = (1 - progress) * (layer === 0 ? 0.95 : 0.4);
    const size = px * (layer === 0 ? 1 : 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = tail + (head - tail) * t;
      const w = rr + Math.sin(t * Math.PI) * (layer === 0 ? 5 : 9);
      ctx.fillRect(snap(cx + Math.cos(a) * w, px), snap(cy + Math.sin(a) * w, px), size, size);
    }
  }
  ctx.restore();
}
