// ============================================================
// tests/run_fixtures.mjs —— 跑音频 / 背景两个夹具页（子代理写好了但起不了浏览器）
// 产出 artifacts/results/fixtures.json 与截图
// ============================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';
import { startServer } from '../server.mjs';
import { ARTIFACTS, SHOTS, RESULTS, ensureDirs, Checker, sleep } from './lib/harness.mjs';

const SOUNDS = [
  'slash', 'slashHit', 'kill', 'gunshot', 'enemyShoot', 'dash', 'jump', 'doubleJump', 'land',
  'wallSlide', 'pickup', 'throw', 'deflect', 'bulletRicochet', 'death', 'respawn', 'doorOpen',
  'levelClear', 'victory', 'shieldBlock', 'empty', 'spikeDeath', 'slowIn', 'slowOut', 'uiClick',
];

const c = new Checker('fixtures');
await ensureDirs();
const server = await startServer({ port: 9911, open: false, quiet: true });
const session = await launch({
  port: 9912,
  width: 1280,
  height: 720,
  userDataDir: path.join(ARTIFACTS, 'tmp', `fixtures-${Date.now()}`),
});
const consoleLog = [];
session.setGlobalConsoleSink((kind, text) => consoleLog.push({ kind, text }));

const extra = {};
try {
  // ---------------- 音频夹具 ----------------
  const p1 = await session.newPage(server.url.replace('index.html', 'tests/fixtures/audio_check.html') + '?auto=1');
  await p1.waitFor('window.__AUDIO_CHECK_DONE__ === true', 40000);
  const audioCheck = await p1.eval('window.__AUDIO_CHECK__');
  const stats1 = await p1.eval('typeof window.__AUDIO_STATS__ === "function" ? window.__AUDIO_STATS__() : null');
  c.check(audioCheck && audioCheck.ok === true, '音频夹具：全部音效无异常', JSON.stringify({ ok: audioCheck.ok, errors: (audioCheck.errors || []).slice(0, 3) }).slice(0, 300));
  c.check(!!stats1, '音频夹具：暴露了节点统计', JSON.stringify(stats1));

  // 多轮压：连续触发 200 次音效，看活跃节点数是否持续增长
  const leak = await p1.eval(`(async () => {
    const sys = window.__AUDIO_SYS__;
    const names = ${JSON.stringify(SOUNDS)};
    const before = window.__AUDIO_STATS__();
    for (let round = 0; round < 8; round++) {
      for (const n of names) sys.play(n, { gain: 0.2 });
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 3800)); // 等 victory(3.5s) 这种长音效播完
    const after = window.__AUDIO_STATS__();
    return { before, after, calls: names.length * 8 };
  })()`);
  c.check(
    leak.after.nodeCountEstimate <= leak.before.nodeCountEstimate + 4,
    '音频夹具：200 次连发后没有 AudioNode 泄漏',
    `before=${JSON.stringify(leak.before)} after=${JSON.stringify(leak.after)}`,
  );
  await p1.screenshot(path.join(SHOTS, 'fixture_audio.png'));

  // ---------------- 背景夹具 ----------------
  const p2 = await session.newPage(server.url.replace('index.html', 'tests/fixtures/backdrop_check.html') + '?auto=1&seed=1&cam=800');
  await p2.waitFor('window.__BACKDROP_CHECK_DONE__ === true', 30000);
  const bd = await p2.eval('window.__BACKDROP_CHECK__');
  c.check(bd && bd.ok === true, '背景夹具：绘制无异常', JSON.stringify(bd).slice(0, 400));
  c.check(bd.drawMsAvg > 0 && bd.drawMsAvg < 4, '背景夹具：单帧 draw 耗时 < 4ms', `${bd.drawMsAvg} ms`);
  await p2.screenshot(path.join(SHOTS, 'fixture_backdrop.png'));

  // 三个关卡 seed 的截图
  for (const [seed, camx, name] of [[1337, 600, 'level1'], [2049, 1400, 'level2'], [4242, 1200, 'level3']]) {
    const p = await session.newPage(server.url.replace('index.html', 'tests/fixtures/backdrop_check.html') + `?auto=1&seed=${seed}&cam=${camx}`);
    await p.waitFor('window.__BACKDROP_CHECK_DONE__ === true', 30000);
    const d = await p.eval('window.__BACKDROP_CHECK__');
    extra[`backdrop_${name}`] = d;
    await p.screenshot(path.join(SHOTS, `fixture_backdrop_${name}.png`));
    await p.close();
    console.log(`   📷 fixture_backdrop_${name}.png  draw=${d && d.drawMsAvg}ms`);
  }

  extra.audioCheck = audioCheck;
  extra.audioLeak = leak;
  extra.audioStats = stats1;
  extra.backdrop = bd;
  extra.consoleErrors = consoleLog.filter((l) => l.kind === 'error' || l.kind === 'exception').slice(0, 10);
  c.check(extra.consoleErrors.length === 0, '两个夹具页均无 console 错误/异常', JSON.stringify(extra.consoleErrors).slice(0, 300));
} catch (e) {
  c.check(false, '夹具脚本异常', e && e.message ? e.message : String(e));
  console.error(e);
} finally {
  try {
    await session.close();
  } catch {}
  await server.close();
}

const s = await c.finish(extra);
await fs.writeFile(path.join(ARTIFACTS, 'logs', 'fixtures_detail.json'), JSON.stringify(extra, null, 2), 'utf8');
process.exit(s.ok ? 0 : 1);
