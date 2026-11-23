/**
 * cdp.mjs 的端到端自检。
 *
 * 运行：node tests/smoke_cdp.mjs
 * 可从任意工作目录运行；所有项目路径都由 import.meta.url 推导。
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'cdp_fixture.html');
const ARTIFACTS_DIR = path.join(ROOT, 'artifacts');
const LOG_DIR = path.join(ARTIFACTS_DIR, 'logs');
const SCREENSHOT_DIR = path.join(ARTIFACTS_DIR, 'screenshots');
const HEADED = process.argv.includes('--headed');
const MODE = HEADED ? 'headed' : 'headless';
// headless 是正式自检，固定写 smoke_cdp.*；headed 另存一套，避免互相覆盖。
const FILE_STEM = HEADED ? 'smoke_cdp_headed' : 'smoke_cdp';
const SCREENSHOT_PATH = path.join(SCREENSHOT_DIR, `${FILE_STEM}.png`);
const JSON_PATH = path.join(LOG_DIR, `${FILE_STEM}.json`);
const LOG_PATH = path.join(LOG_DIR, `${FILE_STEM}.log`);
const EXPECTED_TESTS = 8;

const startedAt = new Date();
const startedHr = process.hrtime.bigint();
const logLines = [];
const testResults = [];
const sinkEvents = [];

let server = null;
let session = null;
let page = null;
let fixtureUrl = '';
let browserUserAgent = '';
let evalLatency = null;
let screenshotInfo = null;
let metricsSnapshot = null;
let pageStateForReport = null;
let fatalError = null;
let cleanupFailed = false;

function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function waitUntil(predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `${label} 超时（${timeoutMs}ms）${lastError ? `；最后错误：${lastError.message}` : ''}`,
  );
}

async function runTest(name, fn) {
  log('');
  log(`[测试] ${name}`);
  const testStart = process.hrtime.bigint();
  try {
    const detail = await fn();
    const durationMs = Number(process.hrtime.bigint() - testStart) / 1e6;
    const record = {
      name,
      ok: true,
      detail: detail === undefined ? '' : String(detail),
      durationMs: round(durationMs, 1),
    };
    testResults.push(record);
    log(`✅ ${name}${record.detail ? ` — ${record.detail}` : ''}`);
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - testStart) / 1e6;
    const record = {
      name,
      ok: false,
      error: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : '',
      durationMs: round(durationMs, 1),
    };
    testResults.push(record);
    log(`❌ ${name} — ${record.error}`);
    if (record.stack) log(record.stack.split('\n').slice(1, 6).join('\n'));
  }
}

function createFixtureServer(htmlBuffer) {
  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/cdp_fixture.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': htmlBuffer.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Connection: 'close',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(htmlBuffer);
      }
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('not found');
  });
}

async function startFixtureServer() {
  const htmlBuffer = await fsp.readFile(FIXTURE_PATH);
  const fixtureServer = createFixtureServer(htmlBuffer);
  fixtureServer.on('clientError', (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      fixtureServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      fixtureServer.off('error', onError);
      resolve();
    };
    fixtureServer.once('error', onError);
    fixtureServer.once('listening', onListening);
    fixtureServer.listen(0, '127.0.0.1');
  });

  const address = fixtureServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法获取夹具服务器端口');
  }
  server = fixtureServer;
  return `http://127.0.0.1:${address.port}/cdp_fixture.html`;
}

async function closeFixtureServer() {
  if (!server) return;
  const target = server;
  server = null;
  await new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, 2_000);
    try {
      target.close(() => finish());
      // 浏览器先关闭后通常没有连接了；这里兜底处理 keep-alive
      if (typeof target.closeAllConnections === 'function') target.closeAllConnections();
      if (typeof target.closeIdleConnections === 'function') target.closeIdleConnections();
    } catch {
      finish();
    }
  });
}

async function cleanup() {
  log('');
  log('[清理] 关闭页面、浏览器进程、静态服务器并清理临时 profile ...');
  try {
    if (page) {
      await page.close();
      page = null;
    }
  } catch (error) {
    cleanupFailed = true;
    log(`❌ 关闭页面失败：${error.message}`);
  }

  try {
    if (session) {
      await session.close();
      session = null;
    }
  } catch (error) {
    cleanupFailed = true;
    log(`❌ 关闭浏览器失败：${error.message}`);
  }

  try {
    await closeFixtureServer();
  } catch (error) {
    cleanupFailed = true;
    log(`❌ 关闭静态服务器失败：${error.message}`);
  }
  log('[清理] 完成');
}

async function writeReports(ok) {
  const finishedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;
  const passed = testResults.filter((item) => item.ok).length;
  const failed = testResults.length - passed;

  const report = {
    ok,
    mode: MODE,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: round(durationMs, 1),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      projectRoot: ROOT,
    },
    fixtureUrl,
    browser: {
      userAgent: browserUserAgent,
    },
    summary: {
      expectedTests: EXPECTED_TESTS,
      executedTests: testResults.length,
      passed,
      failed,
      cleanupFailed,
      fatal: Boolean(fatalError),
    },
    tests: testResults,
    evalLatency,
    screenshot: screenshotInfo,
    metrics: metricsSnapshot,
    consoleSink: {
      count: sinkEvents.length,
      events: sinkEvents.slice(0, 300),
    },
    pageState: pageStateForReport,
    fatalError: fatalError
      ? {
          message: fatalError.message,
          stack: fatalError.stack,
        }
      : null,
  };

  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.writeFile(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log('');
  log('========================================');
  log(`自检结果：${passed}/${EXPECTED_TESTS} 通过${failed > 0 ? `（${failed} 项失败）` : ''}`);
  if (evalLatency) {
    log(
      `200 次 eval 平均延迟：${evalLatency.avgMs.toFixed(3)} ms` +
        `（P50 ${evalLatency.p50Ms.toFixed(3)} ms / P95 ${evalLatency.p95Ms.toFixed(3)} ms / ` +
        `最大 ${evalLatency.maxMs.toFixed(3)} ms）`,
    );
  }
  if (screenshotInfo) {
    log(
      `截图：${path.relative(ROOT, screenshotInfo.path)}（${screenshotInfo.bytes} bytes，` +
        `${screenshotInfo.width}x${screenshotInfo.height}）`,
    );
  }
  if (fatalError) log(`致命错误：${fatalError.message}`);
  if (cleanupFailed) log('清理阶段有错误，详见上方日志。');
  log(`结果：${ok ? 'PASS' : 'FAIL'}`);
  log(`JSON：${path.relative(ROOT, JSON_PATH)}`);
  log(`日志：${path.relative(ROOT, LOG_PATH)}`);
  log('========================================');

  await fsp.writeFile(LOG_PATH, `${logLines.join('\n')}\n`, 'utf8');
}

async function main() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(SCREENSHOT_DIR, { recursive: true });

  log('========================================');
  log('CDP 端到端自检（零依赖，Microsoft Edge）');
  log(`启动时间：${startedAt.toISOString()}`);
  log(`Node：${process.version}  平台：${process.platform}/${process.arch}`);
  log(`项目根目录：${ROOT}`);
  log(`模式：${MODE}${HEADED ? '（真实窗口）' : '（--headless=new）'}`);
  log('========================================');

  try {
    fixtureUrl = await startFixtureServer();
    log(`夹具服务器：${fixtureUrl}`);

    session = await launch({ headed: HEADED, width: 1280, height: 720, slowMo: 0 });
    session.setGlobalConsoleSink((kind, text) => {
      sinkEvents.push({ kind, text, time: Date.now() });
    });
    page = await session.newPage('about:blank');
    log(`浏览器已就绪：${session._version?.Browser || '未知版本'}`);
  } catch (error) {
    fatalError = error;
    log(`❌ 基础设施初始化失败：${error.message}`);
    if (error.stack) log(error.stack);
  }

  if (!fatalError) {
    await runTest('1. 页面加载、canvas 尺寸与 FPS', async () => {
      await page.setViewport(1280, 720);
      await page.goto(fixtureUrl);
      await page.waitFor(
        'document.readyState === "complete" && window.__READY__ === true',
        5_000,
        50,
      );

      const info = await page.eval(`(() => {
        const canvas = document.getElementById('stage');
        const rect = canvas.getBoundingClientRect();
        return {
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          rectWidth: rect.width,
          rectHeight: rect.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        };
      })()`);

      assertEqual(info.width, 1280, 'canvas.width');
      assertEqual(info.height, 720, 'canvas.height');
      assertEqual(info.clientWidth, 1280, 'canvas.clientWidth');
      assertEqual(info.clientHeight, 720, 'canvas.clientHeight');
      assertEqual(info.innerWidth, 1280, 'window.innerWidth（setViewport）');
      assertEqual(info.innerHeight, 720, 'window.innerHeight（setViewport）');

      browserUserAgent = await page.eval('navigator.userAgent');
      assert(/Edg\//.test(browserUserAgent), 'navigator.userAgent 应包含 Edg/');

      // 明确等 1 秒以上，再检查“最近 1 秒帧数”；headless 下应接近 60
      await sleep(1_100);
      const frameState = await page.eval('({ fps: window.__FPS__, frames: window.__FRAMES__, title: document.title })');
      assert(frameState.fps > 30, `1 秒后 __FPS__ 应 > 30，实际 ${frameState.fps}`);
      assert(
        /^CDP Fixture #\d+$/.test(frameState.title),
        `document.title 应包含帧数，实际 ${JSON.stringify(frameState.title)}`,
      );

      const currentUrl = await page.url();
      assertEqual(currentUrl, fixtureUrl, 'page.url()');
      const title = await page.title();
      assert(/^CDP Fixture #\d+$/.test(title), `page.title() 返回值异常：${title}`);

      return (
        `canvas=${info.width}x${info.height}, DPR=${info.devicePixelRatio}, ` +
        `FPS=${frameState.fps}, frames=${frameState.frames}, title="${title}"`
      );
    });

    await runTest('2. eval 往返、waitFor 正常与超时', async () => {
      const arithmetic = await page.eval('1 + 2 * 3');
      assertEqual(arithmetic, 7, 'eval 算术结果');

      const objectValue = await page.eval('({ text: "往返", list: [1, 2, 3], ok: true })');
      assertEqual(objectValue.text, '往返', 'eval 对象.text');
      assertEqual(JSON.stringify(objectValue.list), '[1,2,3]', 'eval 对象.list');
      assertEqual(objectValue.ok, true, 'eval 对象.ok');

      await page.eval(
        'window.__WAIT_TEST__ = false; setTimeout(() => { window.__WAIT_TEST__ = "ready"; }, 150); true',
      );
      const waited = await page.waitFor(
        'window.__WAIT_TEST__ === "ready" ? "ready" : false',
        2_000,
        30,
      );
      assertEqual(waited, 'ready', 'waitFor 真值');

      const timeoutStart = process.hrtime.bigint();
      let timeoutError = null;
      try {
        await page.waitFor('window.__NEVER_TRUE__ === true', 300, 40);
      } catch (error) {
        timeoutError = error;
      }
      const timeoutElapsedMs = Number(process.hrtime.bigint() - timeoutStart) / 1e6;
      assert(timeoutError instanceof Error, 'waitFor 条件始终为假时应抛错');
      assert(/Page\.waitFor 超时/.test(timeoutError.message), '超时错误信息应包含方法名与“超时”');
      assert(timeoutElapsedMs >= 250, `waitFor 超时触发过早：${timeoutElapsedMs.toFixed(1)}ms`);

      return (
        `eval 往返正常；waitFor 正常；“永不满足”条件在 ` +
        `${timeoutElapsedMs.toFixed(0)}ms 后抛出预期错误`
      );
    });

    await runTest('3. 键盘 press / keyDownMany / keyUpMany', async () => {
      await page.eval('window.__KEYS__.length = 0; window.__KEYUPS__.length = 0; true');

      await page.press('KeyJ');
      const afterPress = await page.eval('[...window.__KEYS__]');
      assert(afterPress.includes('KeyJ'), `press('KeyJ') 后未记录 KeyJ：${afterPress.join(',')}`);

      await page.keyDownMany(['KeyA', 'ShiftLeft']);
      const held = await page.eval('[...window.__KEYS__]');
      assert(held.includes('KeyA'), `keyDownMany 后未记录 KeyA：${held.join(',')}`);
      assert(held.includes('ShiftLeft'), `keyDownMany 后未记录 ShiftLeft：${held.join(',')}`);
      const keyDownCount = held.length;

      await page.keyUpMany(['KeyA', 'ShiftLeft']);
      await sleep(100);
      const afterRelease = await page.eval('({ keys: [...window.__KEYS__], ups: [...window.__KEYUPS__] })');
      assertEqual(
        afterRelease.keys.length,
        keyDownCount,
        '松开后 __KEYS__ 长度不应继续增加（__KEYS__ 只记录 keydown）',
      );
      assert(afterRelease.ups.includes('KeyA'), 'keyup 未记录 KeyA');
      assert(afterRelease.ups.includes('ShiftLeft'), 'keyup 未记录 ShiftLeft');

      return `keydown=${JSON.stringify(afterRelease.keys)}；keyup 均已记录且松开后不再新增`;
    });

    await runTest('4. 鼠标移动与中键按下/松开', async () => {
      await page.eval('window.__MOUSE__.length = 0; true');
      await page.mouseMove(640, 360);
      await page.mouseDown('middle');
      await sleep(20);
      await page.mouseUp('middle');

      const mouseEvents = await page.eval('window.__MOUSE__.map((item) => ({ ...item }))');
      const down = mouseEvents.find((event) => event.type === 'mousedown' && event.button === 1);
      const up = mouseEvents.find((event) => event.type === 'mouseup' && event.button === 1);
      assert(down, `页面未记录到 button===1 的 mousedown：${JSON.stringify(mouseEvents)}`);
      assert(up, `页面未记录到 button===1 的 mouseup：${JSON.stringify(mouseEvents)}`);
      assertEqual(down.clientX, 640, 'mousedown clientX');
      assertEqual(down.clientY, 360, 'mousedown clientY');
      assertEqual(up.clientX, 640, 'mouseup clientX');
      assertEqual(up.clientY, 360, 'mouseup clientY');
      assertEqual(down.buttons, 4, 'mousedown 的 buttons 位掩码（middle=4）');
      assertEqual(up.buttons, 0, 'mouseup 的 buttons 位掩码');

      return `mousedown/mouseup 的 DOM button 均为 1，坐标 (${down.clientX}, ${down.clientY})`;
    });

    await runTest('5. PNG 截图落盘', async () => {
      const bytes = await page.screenshot(SCREENSHOT_PATH);
      assert(bytes > 20_000, `截图应大于 20000 bytes，实际 ${bytes}`);
      const stat = await fsp.stat(SCREENSHOT_PATH);
      assert(stat.isFile(), '截图路径不是普通文件');
      assertEqual(stat.size, bytes, '截图 stat.size 与返回值');
      const header = await fsp.readFile(SCREENSHOT_PATH);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert(header.subarray(0, 8).equals(pngSignature), '截图文件不是有效 PNG 签名');

      screenshotInfo = {
        path: SCREENSHOT_PATH,
        bytes,
        width: 1280,
        height: 720,
      };
      return `${path.relative(ROOT, SCREENSHOT_PATH)}，${bytes} bytes，PNG 签名有效`;
    });

    await runTest('6. Performance metrics 与 JSHeapUsedSize', async () => {
      const metrics = await page.metrics();
      assert(typeof metrics === 'object' && metrics !== null, 'metrics() 应返回对象');
      assert(
        Number.isFinite(metrics.JSHeapUsedSize) && metrics.JSHeapUsedSize > 0,
        `JSHeapUsedSize 应 > 0，实际 ${metrics.JSHeapUsedSize}`,
      );
      metricsSnapshot = {
        JSHeapUsedSize: metrics.JSHeapUsedSize,
        Nodes: metrics.Nodes,
        LayoutCount: metrics.LayoutCount,
        RecalcStyleCount: metrics.RecalcStyleCount,
      };
      return (
        `JSHeapUsedSize=${(metrics.JSHeapUsedSize / 1024 / 1024).toFixed(2)} MiB，` +
        `Nodes=${metrics.Nodes ?? 'n/a'}，LayoutCount=${metrics.LayoutCount ?? 'n/a'}`
      );
    });

    await runTest('7. console.error 与未捕获异常捕获', async () => {
      const consoleBefore = page.consoles.length;
      await page.eval('console.error("SMOKE_CONSOLE_ERROR", { marker: 4242 }); "sent"');
      await waitUntil(
        () =>
          page.consoles
            .slice(consoleBefore)
            .some((entry) => entry.type === 'error' && entry.text.includes('SMOKE_CONSOLE_ERROR')),
        3_000,
        '等待页面 console.error 被 Page.consoles 捕获',
      );
      await waitUntil(
        () =>
          sinkEvents.some(
            (event) => event.kind === 'console' && event.text.includes('SMOKE_CONSOLE_ERROR'),
          ),
        3_000,
        '等待页面 console.error 被全局 sink 捕获',
      );

      const exceptionBefore = page.exceptions.length;
      await page.eval(
        'setTimeout(() => { throw new Error("SMOKE_UNCAUGHT_ERROR"); }, 0); "scheduled"',
      );
      await waitUntil(
        () =>
          page.exceptions
            .slice(exceptionBefore)
            .some((entry) => entry.text.includes('SMOKE_UNCAUGHT_ERROR')),
        3_000,
        '等待未捕获异常进入 Page.exceptions',
      );
      await waitUntil(
        () =>
          sinkEvents.some(
            (event) => event.kind === 'exception' && event.text.includes('SMOKE_UNCAUGHT_ERROR'),
          ),
        3_000,
        '等待未捕获异常被全局 sink 捕获',
      );

      const consoleCount = page.consoles.filter((entry) => entry.text.includes('SMOKE_CONSOLE_ERROR')).length;
      const exceptionCount = page.exceptions.filter((entry) =>
        entry.text.includes('SMOKE_UNCAUGHT_ERROR'),
      ).length;
      assert(consoleCount >= 1, '页面 console.error 未被内部缓存');
      assert(exceptionCount >= 1, '页面未捕获异常未被内部缓存');
      return `console 命中 ${consoleCount} 条，exception 命中 ${exceptionCount} 条；sink 同步收到`;
    });

    await runTest('8. 连续 200 次 eval 延迟', async () => {
      // 预热，不计入统计
      for (let i = 0; i < 10; i++) {
        const value = await page.eval('1 + 1');
        assertEqual(value, 2, '预热 eval 结果');
      }

      const durations = [];
      const batchStart = process.hrtime.bigint();
      for (let i = 0; i < 200; i++) {
        const callStart = process.hrtime.bigint();
        const value = await page.eval('1 + 1');
        const callEnd = process.hrtime.bigint();
        assertEqual(value, 2, 'eval 结果');
        durations.push(Number(callEnd - callStart) / 1e6);
      }
      const totalMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
      const sorted = [...durations].sort((a, b) => a - b);
      const avgMs = totalMs / durations.length;

      evalLatency = {
        count: durations.length,
        totalMs: round(totalMs, 3),
        avgMs: round(avgMs, 3),
        minMs: round(sorted[0], 3),
        maxMs: round(sorted[sorted.length - 1], 3),
        p50Ms: round(sorted[Math.floor(sorted.length * 0.5)], 3),
        p95Ms: round(sorted[Math.floor(sorted.length * 0.95)], 3),
        durationsMs: durations.map((value) => round(value, 3)),
      };
      return (
        `平均 ${avgMs.toFixed(3)} ms/次，P50 ${evalLatency.p50Ms.toFixed(3)} ms，` +
        `P95 ${evalLatency.p95Ms.toFixed(3)} ms，总耗时 ${totalMs.toFixed(1)} ms`
      );
    });
  }

  const passedBeforeCleanup = testResults.filter((item) => item.ok).length;
  if (session && page) {
    log('');
    log(`[页面状态] console=${page.consoles.length}，exception=${page.exceptions.length}，` +
      `log=${page.logs.length}，dialog=${page.dialogs.length}`);
    for (const entry of page.consoles.filter((item) => item.type === 'error').slice(0, 3)) {
      log(`  console.error: ${entry.text.slice(0, 300)}`);
    }
    for (const entry of page.exceptions.slice(0, 3)) {
      log(`  exception: ${entry.text.split('\n')[0].slice(0, 300)}`);
    }
    // cleanup() 会关闭页面并把 page 置空，报告需要提前留快照
    pageStateForReport = {
      consoles: page.consoles,
      exceptions: page.exceptions,
      logs: page.logs,
      dialogs: page.dialogs,
    };
  }

  await cleanup();

  const allPassed =
    !fatalError &&
    !cleanupFailed &&
    testResults.length === EXPECTED_TESTS &&
    passedBeforeCleanup === EXPECTED_TESTS;

  await writeReports(allPassed);

  if (!allPassed) {
    process.exitCode = 1;
  }
}

await main();
