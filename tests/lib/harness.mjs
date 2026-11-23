// ============================================================
// tests/lib/harness.mjs —— 测试公共设施
//   * 起游戏静态服务器（复用 server.mjs）
//   * 启动 Edge（headless 或 headed）+ 打开游戏 + 等 __READY__
//   * 截图 / 断言 / 日志落盘
// 所有产物都写到 artifacts/ 下，源码目录保持干净。
// ============================================================
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch } from '../cdp.mjs';
import { startServer } from '../../server.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ARTIFACTS = path.join(ROOT, 'artifacts');
export const SHOTS = path.join(ARTIFACTS, 'screenshots');
export const LOGS = path.join(ARTIFACTS, 'logs');
export const RESULTS = path.join(ARTIFACTS, 'results');

let portSeq = 9700;

export async function ensureDirs() {
  for (const d of [ARTIFACTS, SHOTS, LOGS, RESULTS, path.join(ARTIFACTS, 'tmp')]) {
    await fs.mkdir(d, { recursive: true });
  }
}

/** 断言与结果收集 */
export class Checker {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.t0 = Date.now();
  }
  record(ok, label, detail) {
    this.rows.push({ ok: !!ok, label, detail });
    const mark = ok ? '✅' : '❌';
    console.log(`${mark} ${label}${detail === undefined ? '' : '  —— ' + detail}`);
    return ok;
  }
  check(ok, label, detail) {
    return this.record(ok, label, detail);
  }
  eq(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.record(ok, label, ok ? `${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  near(actual, expected, tol, label) {
    const ok = Math.abs(actual - expected) <= tol;
    return this.record(ok, label, `${actual}（期望 ${expected} ±${tol}）`);
  }
  get passed() {
    return this.rows.filter((r) => r.ok).length;
  }
  get failed() {
    return this.rows.filter((r) => !r.ok);
  }
  get total() {
    return this.rows.length;
  }
  summary() {
    const ms = Date.now() - this.t0;
    return {
      name: this.name,
      passed: this.passed,
      failed: this.failed.length,
      total: this.total,
      ok: this.failed.length === 0,
      durationMs: ms,
      failures: this.failed.map((f) => `${f.label} —— ${f.detail}`),
      rows: this.rows,
    };
  }
  async finish(extra = {}) {
    const s = { ...this.summary(), ...extra };
    await ensureDirs();
    const file = path.join(RESULTS, `${this.name}.json`);
    await fs.writeFile(file, JSON.stringify(s, null, 2), 'utf8');
    console.log('');
    console.log(`—— ${this.name}：${s.passed}/${s.total} 通过，耗时 ${(s.durationMs / 1000).toFixed(1)}s`);
    if (s.failed) console.log(`   失败项：\n   - ${s.failures.join('\n   - ')}`);
    console.log(`   结果文件：artifacts/results/${this.name}.json`);
    return s;
  }
}

/** 启动游戏服务 + 浏览器 + 打开游戏页面 */
export async function startGame(opts = {}) {
  await ensureDirs();
  const {
    headed = false,
    width = 1280,
    height = 720,
    openLevel = null,
    extraArgs = [],
  } = opts;

  const server = await startServer({ port: portSeq++, open: false, quiet: true });
  const session = await launch({
    headed,
    port: portSeq++,
    width,
    height,
    args: extraArgs,
    userDataDir: path.join(ARTIFACTS, 'tmp', `profile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
  });

  const logs = [];
  const exceptions = [];
  session.setGlobalConsoleSink((kind, text) => {
    logs.push({ kind, text });
    if (kind === 'exception' || kind === 'error') exceptions.push({ kind, text });
  });

  const page = await session.newPage(server.url);
  // 等游戏跑起来（第一帧之后 __READY__ 才是 true）
  await page.waitFor('window.__READY__ === true', 15000);
  await page.waitFor('!!(window.__GAME__ && window.__GAME__.snapshot)', 5000);

  if (openLevel !== null) {
    await page.eval(`window.__TEST__.gotoLevel(${openLevel})`);
    await page.waitFor('window.__READY__ === true', 5000);
  }

  const api = {
    session,
    page,
    server,
    logs,
    exceptions,
    url: server.url,
    async eval(expr) {
      return page.eval(expr);
    },
    async snapshot() {
      return page.eval('window.__GAME__.snapshot()');
    },
    async shot(name) {
      await ensureDirs();
      const f = path.join(SHOTS, `${name}.png`);
      const bytes = await page.screenshot(f);
      console.log(`   📷 artifacts/screenshots/${name}.png (${(bytes / 1024).toFixed(0)} KB)`);
      return { file: f, bytes };
    },
    async hold(keys, ms) {
      for (const k of keys) await page.keyDown(k);
      await sleep(ms);
      for (const k of keys) await page.keyUp(k);
    },
    async tap(key, holdMs = 60) {
      await page.press(key, holdMs);
    },
    async wait(expr, timeout = 8000) {
      return page.waitFor(expr, timeout);
    },
    async close() {
      try {
        await session.close();
      } catch {}
      try {
        await server.close();
      } catch {}
    },
  };
  return api;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把页面里的异常与 console 错误打印出来（用于报告"没有报错"） */
export async function reportPageErrors(api, checker) {
  const boot = await api.eval('window.__BOOT__ ? {hasBackdrop: window.__BOOT__.hasBackdrop, hasAudio: window.__BOOT__.hasAudio, errs: window.__BOOT__.errors} : null');
  checker.check(!!boot, '页面已启动 __BOOT__', boot && `backdrop=${boot.hasBackdrop} audio=${boot.hasAudio}`);
  const frameErrs = await api.eval('window.__GAME__.errors()');
  const fatal = await api.eval('(document.getElementById("fatal")||{}).style ? document.getElementById("fatal").style.display : "none"');
  checker.check(fatal !== 'block', '没有触发致命错误遮罩', `fatal.style.display=${fatal}`);
  checker.check(frameErrs.length === 0, '游戏循环内无异常', frameErrs.length ? frameErrs.join(' | ') : '0 条');
  const pageExceptions = api.exceptions.filter((e) => e.kind === 'exception');
  checker.check(pageExceptions.length === 0, '页面无未捕获异常', pageExceptions.length ? pageExceptions.slice(0, 3).map((e) => e.text).join(' | ') : '0 条');
  return boot;
}

/** 往页面里注入一个"自动驾驶机器人"：读状态 → 用真实键鼠事件操作 */
export const BOT_SOURCE = `
(() => {
  const g = () => window.__GAME__.snapshot();
  const input = (window.__BOT_STATE__ = window.__BOT_STATE__ || { keys: new Set(), mouse: { x: 640, y: 360 }, plans: [] });
  return true;
})()
`;
