// ============================================================
// hud.js —— 极简 UI：左上角 FPS + 时间能量槽 + 准星 + 结算面板
// 需求书要求：没有血条、没有分数、没有倒计时、没有小地图。
// ============================================================
import { T } from './const.js';
import { clamp, clamp01, lerp, formatTime, TAU } from '../core/math.js';
import { VIEW_W, VIEW_H } from '../core/render.js';
import { STATE } from './director.js';

export class Hud {
  constructor() {
    this.energyVis = 0;
    this.fpsSmooth = 60;
    this.victoryT = 0;
    this.hintT = 0;
  }

  draw(ctx, game) {
    const time = game.time;
    const p = game.player;

    // ---------------- FPS ----------------
    const fps = Math.round(time.stats.fps);
    ctx.save();
    ctx.globalAlpha = 0.92;
    game.renderer.text(`FPS ${fps}`, 18, 28, {
      size: 13,
      color: fps >= 55 ? '#6fe8c0' : fps >= 40 ? '#ffd166' : '#ff5c7a',
      mono: true,
      weight: '600',
    });
    // 极细的帧时间条，帮助观察抖动（也是实测值，不是装饰）
    const ms = 1000 / Math.max(1, time.stats.fps);
    const barW = 44;
    const load = clamp01(ms / 16.67);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#2a2440';
    ctx.fillRect(18, 34, barW, 2);
    ctx.fillStyle = load > 0.98 ? '#ff5c7a' : '#4fe0b0';
    ctx.fillRect(18, 34, barW * Math.min(1, load), 2);
    ctx.restore();

    // ---------------- 时间能量槽（仅消耗时显示） ----------------
    const draining = p.slowActive;
    const targetVis = draining ? 1 : 0;
    this.energyVis += (targetVis - this.energyVis) * 0.22;
    const ratio = p.energy / T.energyMax;

    if (this.energyVis > 0.02) {
      const x = 18;
      const y = 46;
      const w = 148;
      const h = 7;
      ctx.save();
      ctx.globalAlpha = this.energyVis * 0.95;
      // 底槽
      game.renderer.roundRect(x - 1, y - 1, w + 2, h + 2, 2, 'rgba(10,8,20,0.75)', 'rgba(120,230,255,0.35)', 1);
      // 能量
      const grad = ctx.createLinearGradient(x, y, x + w, y);
      grad.addColorStop(0, '#22e0ff');
      grad.addColorStop(0.7, '#8ef2ff');
      grad.addColorStop(1, '#ffffff');
      ctx.fillStyle = grad;
      const fw = Math.max(0, (w - 2) * clamp01(ratio));
      ctx.fillRect(x + 1, y + 1, fw, h - 2);
      // 高光
      ctx.globalAlpha = this.energyVis * 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + 1, y + 1, fw, 1);
      // 耗尽警示
      if (ratio < 0.22 && draining) {
        ctx.globalAlpha = this.energyVis * (0.4 + 0.4 * Math.sin(time.elapsedReal * 22));
        ctx.fillStyle = '#ff5c7a';
        ctx.fillRect(x + 1, y + 1, fw, h - 2);
      }
      ctx.restore();
    } else if (p.energy < T.energyMax - 0.5) {
      // 回充时的极细刻度（同一个能量槽，只是几乎不显眼）
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#2a2440';
      ctx.fillRect(18, 46, 148, 2);
      ctx.fillStyle = '#22e0ff';
      ctx.fillRect(18, 46, 148 * clamp01(p.energy / T.energyMax), 2);
      ctx.restore();
    }

    // ---------------- 准星 ----------------
    if (p.alive && game.state === STATE.PLAYING) {
      const mx = game.input.pointer.sx;
      const my = game.input.pointer.sy;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#a8f4ff';
      ctx.lineWidth = 1.2;
      const g = 5;
      const l = 5;
      ctx.beginPath();
      ctx.moveTo(mx - g - l, my);
      ctx.lineTo(mx - g, my);
      ctx.moveTo(mx + g, my);
      ctx.lineTo(mx + g + l, my);
      ctx.moveTo(mx, my - g - l);
      ctx.lineTo(mx, my - g);
      ctx.moveTo(mx, my + g);
      ctx.lineTo(mx, my + g + l);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx - 0.7, my - 0.7, 1.4, 1.4);
      ctx.restore();
    }

    // ---------------- 死亡：任务失败（停留 2 秒后无缝重置） ----------------
    if (game.state === STATE.DEATH) {
      const total = game.deathTotal || 2;
      const left = Math.max(0, game.deathTimer || 0);
      const t = clamp01(1 - left / total); // 0 → 1
      const fadeIn = clamp01(t * 6);
      const cx = VIEW_W / 2;
      const cy = VIEW_H * 0.46;
      ctx.save();
      // 暗红压边
      ctx.globalAlpha = 0.42 * fadeIn;
      const g = ctx.createRadialGradient(cx, cy, VIEW_H * 0.12, cx, cy, VIEW_H * 0.85);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(40,0,10,0.55)');
      g.addColorStop(1, 'rgba(10,0,4,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();

      const scale = 1 + (1 - fadeIn) * 0.12;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.globalAlpha = fadeIn;
      ctx.save();
      ctx.shadowColor = 'rgba(255,40,80,0.8)';
      ctx.shadowBlur = 16;
      game.renderer.text('任 务 失 败', 0, 0, {
        size: 58,
        weight: '700',
        color: '#ff5470',
        align: 'center',
        alpha: fadeIn,
      });
      ctx.restore();
      game.renderer.text('MISSION  FAILED', 0, -54, {
        size: 12,
        color: '#ff9db0',
        align: 'center',
        mono: true,
        spacing: 4,
        alpha: fadeIn * 0.75,
      });
      game.renderer.text('正在重置本关…', 0, 44, {
        size: 14,
        color: 'rgba(255,190,205,0.75)',
        align: 'center',
        alpha: fadeIn * (0.5 + 0.3 * Math.sin(time.elapsedReal * 6)),
      });
      ctx.restore();

      // 底部进度细线：让玩家知道还有多久重开
      ctx.save();
      ctx.globalAlpha = fadeIn * 0.7;
      ctx.fillStyle = 'rgba(255,90,120,0.25)';
      ctx.fillRect(cx - 90, cy + 70, 180, 2);
      ctx.fillStyle = '#ff5470';
      ctx.fillRect(cx - 90, cy + 70, 180 * (left / total), 2);
      ctx.restore();
    }

    // ---------------- 暂停：操作说明 ----------------
    if (game.paused) {
      this.drawPause(ctx, game);
    }

    // ---------------- 结算面板 ----------------
    if (game.state === STATE.VICTORY) {
      this.drawVictory(ctx, game);
    }
  }

  /** 暂停面板：只看操作，不打断 */
  drawPause(ctx, game) {
    const cx = VIEW_W / 2;
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = '#04030a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 0.5;
    const g = ctx.createRadialGradient(cx, VIEW_H * 0.4, 40, cx, VIEW_H * 0.5, VIEW_W * 0.7);
    g.addColorStop(0, 'rgba(34,224,255,0.14)');
    g.addColorStop(0.6, 'rgba(255,46,136,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;

    const top = 96;
    game.renderer.text('已 暂 停', cx, top, {
      size: 44,
      weight: '700',
      color: '#eafaff',
      align: 'center',
      spacing: 6,
    });
    game.renderer.text('PAUSED', cx, top - 44, {
      size: 12,
      color: '#7ef0ff',
      align: 'center',
      mono: true,
      spacing: 5,
      alpha: 0.8,
    });

    const rows = [
      ['左右移动', 'A  D　或　←  →'],
      ['跳跃（二段跳 / 蹬墙跳）', 'W　↑　空格'],
      ['冲刺（短暂无敌，可躲子弹 / 刀 / 地刺）', 'Shift'],
      ['近战攻击 / 反弹子弹', '鼠标左键　或　J'],
      ['减缓时间（按住）', '鼠标右键　或　中键　或　L'],
      ['重新开始本关', 'R'],
      ['暂停 / 继续', 'Esc'],
    ];
    const x0 = cx - 300;
    const y0 = top + 66;
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = '#3a4a66';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 24);
    ctx.lineTo(cx + 300, y0 - 24);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (let i = 0; i < rows.length; i++) {
      const y = y0 + i * 40;
      game.renderer.text(rows[i][0], x0, y, { size: 15, color: '#9fb2cf' });
      game.renderer.text(rows[i][1], cx + 300, y, { size: 15, color: '#e8f6ff', align: 'right' });
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#3a4a66';
      ctx.beginPath();
      ctx.moveTo(x0, y + 12);
      ctx.lineTo(cx + 300, y + 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const pulse = 0.55 + 0.45 * Math.sin(game.time.elapsedReal * 3);
    game.renderer.text('按 Esc 继续', cx, VIEW_H - 60, {
      size: 17,
      color: `rgba(200,240,255,${0.5 + 0.4 * pulse})`,
      align: 'center',
      spacing: 2,
    });
    ctx.restore();
  }

  drawVictory(ctx, game) {
    const t = clamp01(game.victoryT);
    const ease = t * t * (3 - 2 * t);
    ctx.save();
    // 遮罩（半透明，还能看见背后的战场）
    ctx.globalAlpha = 0.62 * ease;
    ctx.fillStyle = '#04030a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 遮罩上的一层冷色渐变
    ctx.globalAlpha = 0.5 * ease;
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H * 0.42, 40, VIEW_W / 2, VIEW_H * 0.5, VIEW_W * 0.7);
    g.addColorStop(0, 'rgba(34,224,255,0.16)');
    g.addColorStop(0.5, 'rgba(255,46,136,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    const cx = VIEW_W / 2;
    const baseY = VIEW_H * 0.34 + (1 - ease) * 14;

    // 装饰横线
    ctx.globalAlpha = ease * 0.55;
    ctx.strokeStyle = '#7ef0ff';
    ctx.lineWidth = 1;
    const lineW = 320 * ease;
    ctx.beginPath();
    ctx.moveTo(cx - lineW, baseY - 52);
    ctx.lineTo(cx + lineW, baseY - 52);
    ctx.stroke();

    ctx.globalAlpha = ease;
    game.renderer.text('MISSION  COMPLETE', cx, baseY - 68, {
      size: 12,
      color: '#7ef0ff',
      align: 'center',
      mono: true,
      spacing: 4,
      alpha: ease * 0.8,
    });

    // 大字
    ctx.save();
    ctx.shadowColor = 'rgba(120,240,255,0.55)';
    ctx.shadowBlur = 26;
    game.renderer.text('任 务 完 成', cx, baseY, {
      size: 62,
      weight: '700',
      color: '#f2fbff',
      align: 'center',
      alpha: ease,
    });
    ctx.restore();

    // 统计
    const sy = baseY + 74;
    const rows = [
      ['总死亡次数', `${game.stats.deaths}`],
      ['总击杀数', `${game.stats.kills}`],
      ['通关总用时', formatTime(game.stats.runTime)],
    ];
    for (let i = 0; i < rows.length; i++) {
      const y = sy + i * 34;
      const rowAlpha = clamp01((t - 0.25 - i * 0.08) * 4);
      ctx.globalAlpha = rowAlpha;
      // 分隔线的点
      ctx.fillStyle = 'rgba(120,240,255,0.5)';
      ctx.fillRect(cx - 150, y - 5, 2, 2);
      game.renderer.text(rows[i][0], cx - 128, y, {
        size: 15,
        color: '#9aa8c4',
        align: 'left',
        alpha: rowAlpha,
      });
      game.renderer.text(rows[i][1], cx + 150, y, {
        size: 17,
        color: '#e8f6ff',
        align: 'right',
        mono: true,
        alpha: rowAlpha,
      });
      ctx.globalAlpha = rowAlpha * 0.25;
      ctx.strokeStyle = '#3a4a66';
      ctx.beginPath();
      ctx.moveTo(cx - 128, y + 9);
      ctx.lineTo(cx + 150, y + 9);
      ctx.stroke();
    }

    // 底部提示
    const hintAlpha = clamp01((t - 0.55) * 3);
    const pulse = 0.6 + 0.4 * Math.sin(game.time.elapsedReal * 3.2);
    ctx.globalAlpha = hintAlpha;
    game.renderer.text('按 R 键从头开始', cx, VIEW_H * 0.86, {
      size: 18,
      color: `rgba(200,240,255,${0.55 + 0.35 * pulse})`,
      align: 'center',
      spacing: 2,
      alpha: hintAlpha,
    });
    ctx.restore();
  }
}
