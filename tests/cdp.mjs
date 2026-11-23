/**
 * 零依赖的 Chrome DevTools Protocol (CDP) 客户端。
 *
 * 只用 Node 内置模块与全局 fetch / WebSocket，负责：
 * - 启动 Edge（默认 headless）并通过 /json/version 等待就绪
 * - 创建 page target、连接页面 WebSocket、转发 console / 异常 / 日志 / 对话框
 * - 真实键鼠事件、截图、页面求值、轮询、性能指标
 *
 * 本文件不依赖工作目录：默认浏览器 profile 始终落在 artifacts/tmp/browser-profile 下。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 浏览器临时 profile 放在 artifacts 下，避免污染 tests/ 交付目录。
const PROFILE_ROOT = path.join(ROOT, 'artifacts', 'tmp', 'browser-profile');
// 浏览器路径按顺序探测（可用环境变量 BROWSER_PATH 覆盖），不写死一台机器
const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
].filter(Boolean);
const EDGE_PATH = BROWSER_CANDIDATES.find((p) => fs.existsSync(p)) || BROWSER_CANDIDATES[1];

const MODIFIER_BITS = Object.freeze({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
});

const MOUSE_BUTTON_BITS = Object.freeze({
  left: 1,
  right: 2,
  middle: 4,
});

/** 按键描述表：同时提供 key / code / 虚拟键码 / 可打印字符。 */
const KEYS = Object.create(null);

function defineKey(code, key, virtualKeyCode, extra = {}) {
  KEYS[code] = Object.freeze({
    code,
    key,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...extra,
  });
}

// A-Z（覆盖需求中的 A/D/W/S/J/K/L/R/P/Q/E/F，同时也支持其余字母）
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i);
  defineKey(`Key${letter}`, letter.toLowerCase(), 65 + i, { letter: true });
}
// Digit0-Digit9（覆盖 Digit1-3）
for (let i = 0; i <= 9; i++) {
  defineKey(`Digit${i}`, String(i), 48 + i, { text: String(i) });
}
// Space、修饰键、方向键、导航键、功能键
defineKey('Space', ' ', 32, { text: ' ' });
defineKey('ShiftLeft', 'Shift', 16, { modifier: MODIFIER_BITS.Shift, location: 1, text: undefined });
defineKey('ShiftRight', 'Shift', 16, { modifier: MODIFIER_BITS.Shift, location: 2, text: undefined });
defineKey('ControlLeft', 'Control', 17, { modifier: MODIFIER_BITS.Control, location: 1, text: undefined });
defineKey('ControlRight', 'Control', 17, { modifier: MODIFIER_BITS.Control, location: 2, text: undefined });
defineKey('AltLeft', 'Alt', 18, { modifier: MODIFIER_BITS.Alt, location: 1, text: undefined });
defineKey('AltRight', 'Alt', 18, { modifier: MODIFIER_BITS.Alt, location: 2, text: undefined });
defineKey('MetaLeft', 'Meta', 91, { modifier: MODIFIER_BITS.Meta, location: 1, text: undefined });
defineKey('MetaRight', 'Meta', 92, { modifier: MODIFIER_BITS.Meta, location: 2, text: undefined });
defineKey('ArrowLeft', 'ArrowLeft', 37);
defineKey('ArrowUp', 'ArrowUp', 38);
defineKey('ArrowRight', 'ArrowRight', 39);
defineKey('ArrowDown', 'ArrowDown', 40);
defineKey('Escape', 'Escape', 27);
defineKey('Enter', 'Enter', 13, { text: '\r' });
defineKey('Tab', 'Tab', 9, { text: '\t' });
defineKey('Backspace', 'Backspace', 8);
defineKey('Delete', 'Delete', 46);
defineKey('Insert', 'Insert', 45);
defineKey('Home', 'Home', 36);
defineKey('End', 'End', 35);
defineKey('PageUp', 'PageUp', 33);
defineKey('PageDown', 'PageDown', 34);
for (let i = 1; i <= 12; i++) {
  defineKey(`F${i}`, `F${i}`, 111 + i);
}

/**
 * 给 Promise 加超时，并在成功/失败时清理定时器，避免脚本退不出去。
 * onTimeout 返回 reject 用的错误。
 */
function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.off('exit', finish);
      resolve(child.exitCode !== null || child.signalCode !== null);
    };
    child.once('exit', finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

/** 结束整个浏览器进程树，并等待根进程退出。 */
async function killBrowserTree(child) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    // Windows 下必须用 taskkill /T 才能连渲染进程一起收掉；stdio 必须是 ignore，
    // 避免在受限环境里因创建捕获管道而失败。
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      timeout: 10_000,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // 退化为只杀根进程
  }

  await waitForChildExit(child, 5_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await waitForChildExit(child, 2_000);
  }
}

async function removeProfileDir(dir) {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  } catch (error) {
    // profile 删除失败只警告，不能让测试脚本报错退出
    console.warn(`[cdp] 警告：清理 user-data-dir 失败：${dir}（${error.message}）`);
  }
}

async function fetchJson(url, { method = 'GET', timeoutMs = 3_000 } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { response, status: response.status, ok: response.ok, text, data };
}

/** 等 `/json/version` 可用；返回版本信息，失败返回 null。 */
async function probeVersion(port, timeoutMs) {
  try {
    const result = await fetchJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs });
    if (result.ok && result.data && result.data.webSocketDebuggerUrl) {
      return result.data;
    }
  } catch {
    // 浏览器还没起好，端口拒绝连接是正常情况
  }
  return null;
}

/**
 * CDP WebSocket 连接：请求/响应配对、事件分发、关闭时拒绝全部悬挂 Promise。
 */
class CDPConnection {
  constructor(wsUrl, label) {
    this.url = wsUrl;
    this.label = label;
    this._nextId = 1;
    this._pending = new Map();
    this._opened = false;
    this._closed = false;
    this._eventHandler = () => {};
    this._closeHandler = () => {};
    this._messageQueue = Promise.resolve();

    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    this._ws = new WebSocket(wsUrl);
    this._bindSocket();
  }

  _bindSocket() {
    this._ws.addEventListener('open', () => {
      if (this._closed) return;
      this._opened = true;
      this._resolveReady();
    });

    this._ws.addEventListener('message', (event) => {
      if (this._closed) return;
      // 串行处理消息，避免异步 Blob 解码造成事件乱序
      this._messageQueue = this._messageQueue
        .then(() => this._handleRawMessage(event.data))
        .catch((error) => {
          console.warn(`[cdp] 解析 CDP 消息失败：${error.message}`);
        });
    });

    this._ws.addEventListener('error', () => {
      if (!this._opened) {
        this._rejectReady(
          new Error(
            `无法连接 CDP WebSocket（${this.label}）：${this.url}。` +
              '可能是页面已关闭，或 --remote-allow-origins 未生效。',
          ),
        );
      }
      this._finalizeClose('WebSocket 发生错误');
    });

    this._ws.addEventListener('close', (event) => {
      const reason = `code=${event.code}${event.reason ? `，${event.reason}` : ''}`;
      if (!this._opened) {
        this._rejectReady(
          new Error(`CDP WebSocket 在建立连接前关闭（${this.label}，${reason}）：${this.url}`),
        );
      }
      this._finalizeClose(`连接关闭（${reason}）`);
    });
  }

  setEventHandler(fn) {
    this._eventHandler = typeof fn === 'function' ? fn : () => {};
  }

  setCloseHandler(fn) {
    this._closeHandler = typeof fn === 'function' ? fn : () => {};
  }

  async open(timeoutMs = 10_000) {
    const waitPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this._ws.close();
        } catch {
          // ignore
        }
        this._finalizeClose('WebSocket 连接超时');
        reject(new Error(`CDP WebSocket 连接超时（${timeoutMs}ms）：${this.url}`));
      }, timeoutMs);

      this._readyPromise.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });

    await waitPromise;
  }

  async _handleRawMessage(data) {
    if (this._closed) return;
    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8');
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    } else if (data && typeof data.text === 'function') {
      text = await data.text();
    } else {
      text = String(data);
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new Error(`收到非 JSON 的 CDP 消息：${text.slice(0, 200)}`);
    }

    if (typeof message.id === 'number') {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        const error = new Error(
          `CDP ${pending.method} 失败：${message.error.message || '未知协议错误'}` +
            `（code ${message.error.code}）`,
        );
        error.method = pending.method;
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
        return;
      }
      pending.resolve(message.result || {});
      return;
    }

    if (typeof message.method === 'string') {
      try {
        this._eventHandler(message);
      } catch (error) {
        console.warn(`[cdp] 处理事件 ${message.method} 失败：${error.message}`);
      }
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new Error('CDPConnection.send：method 必须是非空字符串'));
    }
    if (this._closed || !this._opened) {
      return Promise.reject(new Error(`CDP ${method} 不可用：连接尚未建立或已关闭`));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error(`CDP ${method} 的 timeoutMs 必须是正数`));
    }

    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(id);
        if (!pending) return;
        this._pending.delete(id);
        const error = new Error(`CDP ${method} 超时（${timeoutMs}ms）`);
        error.method = method;
        error.code = 'CDP_TIMEOUT';
        reject(error);
      }, timeoutMs);

      this._pending.set(id, { method, resolve, reject, timer });

      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`CDP ${method} 发送失败：${error.message}`));
      }
    });
  }

  _rejectPending(reason) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      this._pending.delete(id);
      pending.reject(new Error(`CDP ${pending.method} 未完成：${reason}`));
    }
  }

  _finalizeClose(reason) {
    if (this._closed) return;
    this._closed = true;
    this._rejectPending(reason);
    if (!this._opened) {
      this._rejectReady(new Error(`CDP WebSocket 未能建立连接（${this.label}）：${reason}`));
    }
    try {
      this._closeHandler(reason);
    } catch (error) {
      console.warn(`[cdp] 连接关闭回调失败：${error.message}`);
    }
  }

  async close(reason = '客户端主动关闭') {
    if (this._closed) return;
    try {
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, 'client close');
      }
    } catch {
      // ignore
    }
    this._finalizeClose(reason);
  }
}

/** 将 console 参数粗略转成可读文本；不追求 devtools 的完整格式化。 */
function remoteObjectToText(arg) {
  if (!arg || typeof arg !== 'object') return String(arg ?? '');
  if (arg.type === 'string') return arg.value ?? '';
  if (arg.type === 'undefined') return 'undefined';
  if (arg.subtype === 'null') return 'null';
  if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'bigint') {
    if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
    return String(arg.value);
  }
  if (arg.value !== undefined) {
    if (typeof arg.value === 'object') {
      try {
        return JSON.stringify(arg.value);
      } catch {
        return String(arg.value);
      }
    }
    return String(arg.value);
  }
  return arg.description || arg.className || arg.type || '未知值';
}

function formatExceptionText(details) {
  if (!details) return '未知页面异常';
  const exception = details.exception || {};
  if (exception.description) return exception.description;
  if (exception.value !== undefined) return String(exception.value);
  if (details.text) return details.text;
  return '未知页面异常';
}

class Page {
  constructor(session, connection, target) {
    this._session = session;
    this._conn = connection;
    this.targetId = target.id;
    this.consoles = [];
    this.exceptions = [];
    this.logs = [];
    this.dialogs = [];
    this.closed = false;
    this.viewport = { width: session._width, height: session._height };

    this._loadWaiters = new Set();
    this._keysDown = new Set();
    this._mouse = {
      x: 0,
      y: 0,
      buttons: new Set(),
    };
    this._closePromise = null;

    this._conn.setEventHandler((event) => this._handleEvent(event));
    this._conn.setCloseHandler((reason) => this._handleDisconnect(reason));
  }

  async _initialize() {
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Page.enable'),
      this.send('Performance.enable'),
      this.send('Log.enable'),
    ]);
    await this.setViewport(this._session._width, this._session._height);
  }

  async send(method, params = {}, timeoutMs = 15_000) {
    if (this.closed) {
      throw new Error(`Page.send(${method}) 失败：页面已关闭`);
    }
    return this._conn.send(method, params, timeoutMs);
  }

  _emitSink(kind, text) {
    const sink = this._session._sink;
    if (typeof sink !== 'function') return;
    try {
      sink(kind, text);
    } catch (error) {
      console.warn(`[cdp] 全局 console sink 抛错：${error.message}`);
    }
  }

  _handleEvent(event) {
    const { method, params = {} } = event;
    try {
      if (method === 'Page.loadEventFired') {
        this._resolveLoadWaiters();
        return;
      }

      if (method === 'Runtime.consoleAPICalled') {
        const type = params.type || 'log';
        const args = Array.isArray(params.args) ? params.args : [];
        const text = args.map(remoteObjectToText).join(' ');
        this.consoles.push({ kind: 'console', type, text, time: Date.now(), args });
        this._emitSink('console', `[${type}] ${text}`);
        return;
      }

      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails || {};
        const text = formatExceptionText(details);
        this.exceptions.push({
          kind: 'exception',
          text,
          url: details.url || '',
          lineNumber: details.lineNumber,
          columnNumber: details.columnNumber,
          time: Date.now(),
          details,
        });
        this._emitSink('exception', text);
        return;
      }

      if (method === 'Log.entryAdded') {
        const entry = params.entry || {};
        const text =
          `[${entry.level || 'info'}] ${entry.source || 'log'}: ${entry.text || ''}` +
          (entry.url ? `（${entry.url}）` : '');
        this.logs.push({ kind: 'log', ...entry, text, time: Date.now() });
        this._emitSink('log', text);
        return;
      }

      if (method === 'Page.javascriptDialogOpening') {
        const type = params.type || 'alert';
        const message = params.message || '';
        this.dialogs.push({
          kind: 'dialog',
          type,
          message,
          url: params.url || '',
          time: Date.now(),
        });
        this._emitSink('dialog', `[${type}] ${message}`);
      }
    } catch (error) {
      console.warn(`[cdp] 处理页面事件 ${method} 失败：${error.message}`);
    }
  }

  _handleDisconnect(reason) {
    if (this.closed) {
      this._session.pages.delete(this);
      return;
    }
    this.closed = true;
    this._session.pages.delete(this);
    this._rejectLoadWaiters(new Error(`页面连接断开：${reason}`));
  }

  _resolveLoadWaiters() {
    for (const waiter of [...this._loadWaiters]) {
      if (!this._loadWaiters.delete(waiter)) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  _rejectLoadWaiters(error) {
    for (const waiter of [...this._loadWaiters]) {
      if (!this._loadWaiters.delete(waiter)) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  _armLoadWaiter(timeoutMs) {
    let waiter = null;
    const promise = new Promise((resolve, reject) => {
      waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!this._loadWaiters.delete(waiter)) return;
          reject(new Error(`Page.goto 等待 load 事件超时（${timeoutMs}ms）`));
        }, timeoutMs),
      };
      this._loadWaiters.add(waiter);
    });

    return {
      promise,
      // 取消时 resolve(false)，避免产生无人处理的 rejection
      cancel: () => {
        if (!waiter) return false;
        if (!this._loadWaiters.delete(waiter)) return false;
        clearTimeout(waiter.timer);
        waiter.resolve(false);
        return true;
      },
    };
  }

  async goto(url) {
    if (typeof url !== 'string' || !url) {
      throw new Error('Page.goto：url 必须是非空字符串');
    }
    if (this.closed) {
      throw new Error(`Page.goto(${url}) 失败：页面已关闭`);
    }

    const waiter = this._armLoadWaiter(20_000);
    try {
      let result;
      try {
        result = await this.send('Page.navigate', { url }, 15_000);
      } catch (error) {
        throw new Error(`Page.goto(${url}) 失败：Page.navigate 调用出错：${error.message}`);
      }
      if (result.errorText) {
        throw new Error(`Page.goto(${url}) 失败：浏览器拒绝导航：${result.errorText}`);
      }
      const loaded = await waiter.promise;
      if (!loaded) {
        throw new Error(`Page.goto(${url}) 失败：导航被取消`);
      }
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    await this._slow();
  }

  async eval(expression, timeoutMs = 15_000) {
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('Page.eval：expression 必须是非空字符串');
    }
    if (this.closed) {
      throw new Error('Page.eval 失败：页面已关闭');
    }

    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      timeoutMs,
    );

    if (result.exceptionDetails) {
      const text = formatExceptionText(result.exceptionDetails);
      const error = new Error(`页面求值异常：${text}`);
      error.name = 'PageEvalError';
      error.exceptionDetails = result.exceptionDetails;
      throw error;
    }

    const remote = result.result || {};
    if (remote.type === 'undefined') return undefined;
    if (remote.subtype === 'null') return null;
    if (remote.unserializableValue !== undefined) {
      const raw = String(remote.unserializableValue);
      if (raw === 'NaN') return Number.NaN;
      if (raw === 'Infinity') return Number.POSITIVE_INFINITY;
      if (raw === '-Infinity') return Number.NEGATIVE_INFINITY;
      if (raw === '-0') return -0;
      return raw;
    }
    if (Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
    return remote.description;
  }

  async waitFor(expression, timeoutMs = 8_000, pollMs = 100) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Page.waitFor：timeoutMs 必须是正数');
    }
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new Error('Page.waitFor：pollMs 必须是正数');
    }
    if (typeof expression !== 'string' && typeof expression !== 'function') {
      throw new Error('Page.waitFor：expression 必须是字符串或函数');
    }

    const expressionText =
      typeof expression === 'function' ? `(${expression.toString()})()` : expression;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (true) {
      if (this.closed) {
        throw new Error(`Page.waitFor 失败：页面已关闭（表达式：${expressionText}）`);
      }
      try {
        const value = await this.eval(expressionText);
        if (value) return value;
      } catch (error) {
        lastError = error;
        if (this.closed) throw error;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const detail = lastError ? `；最后一次求值错误：${lastError.message}` : '';
        throw new Error(
          `Page.waitFor 超时（${timeoutMs}ms）：${expressionText.slice(0, 200)}${detail}`,
        );
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  async screenshot(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Page.screenshot：filePath 必须是非空字符串');
    }
    const absolutePath = path.resolve(filePath);

    // 截图前尽量等两帧，避免 canvas 首帧尚未绘出时拿到空白图。
    // 页面不可见/没有 rAF 时不能卡死，这里最多等 2 秒后照常截图。
    try {
      await this.send(
        'Runtime.evaluate',
        {
          expression:
            'typeof requestAnimationFrame === "function" ? ' +
            'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))) ' +
            ': true',
          returnByValue: true,
          awaitPromise: true,
        },
        2_000,
      );
    } catch {
      // 忽略；真正截图失败会在下面的 captureScreenshot 给出明确错误
    }

    const result = await this.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false },
      20_000,
    );
    if (!result.data) {
      throw new Error('Page.screenshot：Page.captureScreenshot 未返回图片数据');
    }

    const buffer = Buffer.from(result.data, 'base64');
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, buffer);
    return buffer.length;
  }

  async setViewport(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Page.setViewport：width/height 必须是正数');
    }
    const w = Math.round(width);
    const h = Math.round(height);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: w,
      screenHeight: h,
    });
    this.viewport = { width: w, height: h };
  }

  async title() {
    return this.eval('document.title');
  }

  async url() {
    const history = await this.send('Page.getNavigationHistory');
    const entries = Array.isArray(history.entries) ? history.entries : [];
    return entries[history.currentIndex]?.url || 'about:blank';
  }

  async metrics() {
    const result = await this.send('Performance.getMetrics');
    const metrics = {};
    for (const item of result.metrics || []) {
      metrics[item.name] = item.value;
    }
    return metrics;
  }

  _modifierMask() {
    let mask = 0;
    for (const code of this._keysDown) {
      const modifier = KEYS[code]?.modifier;
      if (modifier) mask |= modifier;
    }
    return mask;
  }

  async _slow() {
    const delay = this._session._slowMo;
    if (delay > 0) await sleep(delay);
  }

  async keyDown(code) {
    if (this.closed) throw new Error(`Page.keyDown(${code}) 失败：页面已关闭`);
    const spec = KEYS[code];
    if (!spec) {
      throw new Error(`Page.keyDown：不支持的按键 code=${code}（请使用 DOM 的 e.code，如 KeyD）`);
    }

    const modifiers = this._modifierMask() | (spec.modifier || 0);
    const shiftActive = (modifiers & MODIFIER_BITS.Shift) !== 0;
    let key = spec.key;
    let text = spec.text;
    if (spec.letter) {
      key = shiftActive ? spec.key.toUpperCase() : spec.key.toLowerCase();
      text = key;
    }

    const params = {
      type: 'keyDown',
      key,
      code: spec.code,
      modifiers,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    };
    if (spec.location !== undefined) params.location = spec.location;
    if (text !== undefined && text !== null) {
      params.text = text;
      params.unmodifiedText = text;
    }

    await this.send('Input.dispatchKeyEvent', params);
    this._keysDown.add(code);
    await this._slow();
  }

  async keyUp(code) {
    if (this.closed) throw new Error(`Page.keyUp(${code}) 失败：页面已关闭`);
    const spec = KEYS[code];
    if (!spec) {
      throw new Error(`Page.keyUp：不支持的按键 code=${code}（请使用 DOM 的 e.code，如 KeyD）`);
    }

    const modifiers = this._modifierMask() & ~(spec.modifier || 0);
    const shiftActive = (modifiers & MODIFIER_BITS.Shift) !== 0;
    const key = spec.letter ? (shiftActive ? spec.key.toUpperCase() : spec.key.toLowerCase()) : spec.key;

    const params = {
      type: 'keyUp',
      key,
      code: spec.code,
      modifiers,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    };
    if (spec.location !== undefined) params.location = spec.location;

    await this.send('Input.dispatchKeyEvent', params);
    this._keysDown.delete(code);
    await this._slow();
  }

  async press(code, holdMs = 60) {
    if (typeof code !== 'string' || !code) {
      throw new Error('Page.press：code 必须是非空字符串');
    }
    if (!Number.isFinite(holdMs) || holdMs < 0) {
      throw new Error('Page.press：holdMs 必须是非负数');
    }
    await this.keyDown(code);
    try {
      if (holdMs > 0) await sleep(holdMs);
    } finally {
      await this.keyUp(code);
    }
  }

  async keyDownMany(codes) {
    if (!Array.isArray(codes)) throw new Error('Page.keyDownMany：codes 必须是数组');
    for (const code of codes) {
      await this.keyDown(code);
    }
  }

  async keyUpMany(codes) {
    if (!Array.isArray(codes)) throw new Error('Page.keyUpMany：codes 必须是数组');
    for (const code of codes) {
      await this.keyUp(code);
    }
  }

  _checkMouseButton(button, method) {
    if (!Object.prototype.hasOwnProperty.call(MOUSE_BUTTON_BITS, button)) {
      throw new Error(`${method}：button 只能是 'left' | 'right' | 'middle'，收到 ${button}`);
    }
  }

  _mouseButtonsMask() {
    let mask = 0;
    for (const button of this._mouse.buttons) {
      mask |= MOUSE_BUTTON_BITS[button];
    }
    return mask;
  }

  async mouseMove(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Page.mouseMove：x/y 必须是数字');
    }
    this._mouse.x = x;
    this._mouse.y = y;
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: this._mouseButtonsMask(),
      modifiers: this._modifierMask(),
      pointerType: 'mouse',
    });
    await this._slow();
  }

  async mouseDown(button = 'left') {
    this._checkMouseButton(button, 'Page.mouseDown');
    if (this.closed) throw new Error(`Page.mouseDown(${button}) 失败：页面已关闭`);
    this._mouse.buttons.add(button);
    try {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: this._mouse.x,
        y: this._mouse.y,
        button,
        buttons: this._mouseButtonsMask(),
        modifiers: this._modifierMask(),
        clickCount: 1,
        pointerType: 'mouse',
      });
    } catch (error) {
      this._mouse.buttons.delete(button);
      throw error;
    }
    await this._slow();
  }

  async mouseUp(button = 'left') {
    this._checkMouseButton(button, 'Page.mouseUp');
    if (this.closed) throw new Error(`Page.mouseUp(${button}) 失败：页面已关闭`);
    this._mouse.buttons.delete(button);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: this._mouse.x,
      y: this._mouse.y,
      button,
      buttons: this._mouseButtonsMask(),
      modifiers: this._modifierMask(),
      clickCount: 1,
      pointerType: 'mouse',
    });
    await this._slow();
  }

  async click(button = 'left', holdMs = 40) {
    this._checkMouseButton(button, 'Page.click');
    if (!Number.isFinite(holdMs) || holdMs < 0) {
      throw new Error('Page.click：holdMs 必须是非负数');
    }
    await this.mouseDown(button);
    try {
      if (holdMs > 0) await sleep(holdMs);
    } finally {
      await this.mouseUp(button);
    }
  }

  async mouseDownHold(button = 'left') {
    return this.mouseDown(button);
  }

  async mouseUpHold(button = 'left') {
    return this.mouseUp(button);
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = (async () => {
      if (this.closed) {
        this._session.pages.delete(this);
        return;
      }
      this.closed = true;
      this._session.pages.delete(this);
      this._rejectLoadWaiters(new Error('页面已关闭'));
      await this._conn.close('页面关闭');
      await this._session._closeTargetById(this.targetId);
      this._session._claimedTargets.delete(this.targetId);
    })();
    return this._closePromise;
  }
}

class Session {
  constructor(options) {
    this._port = options.port;
    this._child = options.child;
    this._profileDir = options.profileDir;
    this._width = options.width;
    this._height = options.height;
    this._slowMo = options.slowMo;
    this._headed = options.headed;
    this._version = options.version;
    this.pages = new Set();
    this._sink = null;
    this._closed = false;
    this._closePromise = null;
    this._claimedTargets = new Set();
  }

  setGlobalConsoleSink(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') {
      throw new TypeError('Session.setGlobalConsoleSink：fn 必须是函数或 null');
    }
    this._sink = typeof fn === 'function' ? fn : null;
  }

  async _httpJson(pathname, { method = 'GET', timeoutMs = 4_000 } = {}) {
    const result = await fetchJson(`http://127.0.0.1:${this._port}${pathname}`, {
      method,
      timeoutMs,
    });
    if (!result.ok) {
      const detail = result.text ? `：${result.text.slice(0, 200)}` : '';
      throw new Error(`CDP HTTP ${method} ${pathname} 返回 ${result.status}${detail}`);
    }
    if (!result.data) {
      throw new Error(`CDP HTTP ${method} ${pathname} 返回的不是 JSON`);
    }
    return result.data;
  }

  _claimTarget(target) {
    if (!target || typeof target.id !== 'string' || !target.id) {
      throw new Error('Session.newPage：浏览器没有返回有效的 target id');
    }
    if (this._claimedTargets.has(target.id)) {
      throw new Error(`Session.newPage：target ${target.id} 已被本会话占用`);
    }
    this._claimedTargets.add(target.id);
    return target;
  }

  async _pickExistingTarget() {
    const targets = await this._httpJson('/json/list');
    if (!Array.isArray(targets)) {
      throw new Error('Session.newPage：/json/list 返回值不是数组');
    }
    const candidates = targets.filter(
      (target) =>
        target &&
        target.type === 'page' &&
        typeof target.id === 'string' &&
        typeof target.webSocketDebuggerUrl === 'string' &&
        !this._claimedTargets.has(target.id) &&
        !String(target.url || '').startsWith('devtools://'),
    );
    if (candidates.length === 0) return null;
    // 优先复用空白页，避免把用户页面直接导航掉
    candidates.sort((a, b) => {
      const aBlank = a.url === 'about:blank' ? 0 : 1;
      const bBlank = b.url === 'about:blank' ? 0 : 1;
      return aBlank - bBlank;
    });
    return this._claimTarget(candidates[0]);
  }

  async _createPageTarget() {
    let putError = null;
    try {
      const result = await fetchJson(
        `http://127.0.0.1:${this._port}/json/new?${encodeURIComponent('about:blank')}`,
        { method: 'PUT', timeoutMs: 4_000 },
      );
      if (result.ok && result.data) {
        return this._claimTarget(result.data);
      }
      putError = new Error(
        `PUT /json/new 返回 HTTP ${result.status}${result.text ? `：${result.text.slice(0, 120)}` : ''}`,
      );
    } catch (error) {
      putError = error;
    }

    // Edge/Chromium 若不允许创建新 target（例如 405），退化为复用已有空白 page。
    const existing = await this._pickExistingTarget();
    if (existing) {
      console.warn('[cdp] /json/new 不可用，已退化为复用已有 page target');
      return existing;
    }
    throw new Error(
      `Session.newPage 创建 target 失败：${putError ? putError.message : '未知原因'}` +
        '；且没有可复用的 page target',
    );
  }

  async _findTargetWebSocket(target) {
    if (typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl) {
      return target.webSocketDebuggerUrl;
    }
    const targets = await this._httpJson('/json/list');
    const found = Array.isArray(targets) ? targets.find((item) => item.id === target.id) : null;
    if (found && typeof found.webSocketDebuggerUrl === 'string') {
      return found.webSocketDebuggerUrl;
    }
    throw new Error(`target ${target.id} 没有 webSocketDebuggerUrl`);
  }

  async _connectPageSocket(wsUrl) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let conn = null;
      try {
        conn = new CDPConnection(wsUrl, 'page');
        await conn.open(8_000);
        return conn;
      } catch (error) {
        lastError = error;
        if (conn) await conn.close('连接页面失败');
        if (attempt < 3) await sleep(150 * attempt);
      }
    }
    throw new Error(
      `连接页面 WebSocket 失败（重试 3 次）：${lastError ? lastError.message : '未知错误'}`,
    );
  }

  async newPage(url = 'about:blank') {
    if (this._closed) {
      throw new Error('Session.newPage 失败：浏览器会话已关闭');
    }
    if (typeof url !== 'string' || !url) {
      throw new Error('Session.newPage：url 必须是非空字符串');
    }

    const target = await this._createPageTarget();
    let conn = null;
    let page = null;
    try {
      const wsUrl = await this._findTargetWebSocket(target);
      conn = await this._connectPageSocket(wsUrl);
      page = new Page(this, conn, target);
      try {
        await page._initialize();
        // 某些 headless 版本不支持 bringToFront；失败不影响主流程
        try {
          await page.send('Page.bringToFront', {}, 3_000);
        } catch {
          // ignore
        }

        if (url !== 'about:blank') {
          await page.goto(url);
        } else {
          const currentUrl = await page.url().catch(() => 'about:blank');
          if (currentUrl !== 'about:blank') await page.goto('about:blank');
        }
      } catch (error) {
        await page.close();
        throw error;
      }
      this.pages.add(page);
      return page;
    } catch (error) {
      if (page) {
        await page.close().catch(() => {});
      } else if (conn) {
        await conn.close('创建页面失败').catch(() => {});
        await this._closeTargetById(target.id);
      }
      this._claimedTargets.delete(target.id);
      throw new Error(`Session.newPage(${url}) 失败：${error.message}`, { cause: error });
    }
  }

  async _closeTargetById(targetId) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this._port}/json/close/${encodeURIComponent(targetId)}`,
        { signal: AbortSignal.timeout(1_500) },
      );
      await response.text().catch(() => '');
    } catch {
      // target 已经不存在 / 浏览器已退出，属于正常情况
    }
  }

  close() {
    if (!this._closePromise) this._closePromise = this._doClose();
    return this._closePromise;
  }

  async _doClose() {
    if (this._closed) return;
    this._closed = true;
    this._sink = null;

    const pages = [...this.pages];
    await Promise.all(
      pages.map((page) =>
        page.close().catch((error) => {
          console.warn(`[cdp] 警告：关闭页面失败：${error.message}`);
        }),
      ),
    );

    try {
      await killBrowserTree(this._child);
    } catch (error) {
      console.warn(`[cdp] 警告：关闭浏览器进程失败：${error.message}`);
    }

    await removeProfileDir(this._profileDir);
  }
}

function validateLaunchOptions(opts) {
  const headed = Boolean(opts.headed);
  const port = opts.port === undefined ? 9333 : Number(opts.port);
  const width = opts.width === undefined ? 1280 : Math.round(Number(opts.width));
  const height = opts.height === undefined ? 720 : Math.round(Number(opts.height));
  const slowMo = opts.slowMo === undefined ? 0 : Number(opts.slowMo);
  const args = opts.args === undefined ? [] : opts.args;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('launch：port 必须是 1-65535 的整数');
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('launch：width 必须是正数');
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('launch：height 必须是正数');
  }
  if (!Number.isFinite(slowMo) || slowMo < 0) {
    throw new Error('launch：slowMo 必须是非负数');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('launch：args 必须是字符串数组');
  }
  return { headed, port, width, height, slowMo, args };
}

function buildBrowserArgs({ headed, port, width, height, profileDir, extraArgs, url }) {
  const args = [
    ...(headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height}`,
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--enable-precise-memory-info',
    '--use-angle=d3d11',
    '--mute-audio',
    '--disable-session-crashed-bubble',
    '--hide-scrollbars',
    ...extraArgs,
    url,
  ];
  return args;
}

/**
 * 启动 Edge 并返回 Session。
 * @param {{headed?: boolean, port?: number, width?: number, height?: number,
 *          userDataDir?: string, args?: string[], slowMo?: number}} opts
 */
export async function launch(opts = {}) {
  const options = validateLaunchOptions(opts || {});

  if (!fs.existsSync(EDGE_PATH)) {
    throw new Error(`launch：找不到 Microsoft Edge：${EDGE_PATH}`);
  }

  // 避免误连到已经占用端口的旧浏览器实例
  const occupied = await probeVersion(options.port, 600);
  if (occupied) {
    throw new Error(
      `launch：端口 ${options.port} 已被占用（可能是上一次残留的浏览器）。` +
        '请等它退出，或通过 opts.port 换一个端口。',
    );
  }

  let profileDir;
  if (opts.userDataDir) {
    profileDir = path.resolve(String(opts.userDataDir));
    fs.mkdirSync(profileDir, { recursive: true });
  } else {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, `${process.pid}-`));
  }

  const args = buildBrowserArgs({
    headed: options.headed,
    port: options.port,
    width: options.width,
    height: options.height,
    profileDir,
    extraArgs: options.args,
    url: 'about:blank',
  });

  let child = null;
  let spawnError = null;
  try {
    child = spawn(EDGE_PATH, args, {
      // 受限环境下不能用 pipe 捕获子进程输出，ignore 最稳。
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', (error) => {
      spawnError = error;
    });
  } catch (error) {
    await removeProfileDir(profileDir);
    throw new Error(`launch：无法启动 Edge 进程：${error.message}`);
  }

  if (!child || !child.pid) {
    await removeProfileDir(profileDir);
    throw new Error('launch：Edge 进程没有有效的 PID');
  }

  const startedAt = Date.now();
  const timeoutMs = 30_000;
  let version = null;
  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (spawnError) {
        throw new Error(`launch：Edge 进程启动失败：${spawnError.message}`);
      }
      if (child.exitCode !== null) {
        throw new Error(
          `launch：Edge 在就绪前退出（exitCode=${child.exitCode}，signal=${child.signalCode || '无'}）`,
        );
      }
      version = await probeVersion(options.port, 800);
      if (version) break;
      await sleep(100);
    }
    if (!version) {
      throw new Error(
        `launch：等待 Edge CDP 就绪超时（${timeoutMs}ms，端口 ${options.port}）。` +
          '请检查端口占用，或改用 headed 模式观察启动日志。',
      );
    }
  } catch (error) {
    await killBrowserTree(child);
    await removeProfileDir(profileDir);
    throw error;
  }

  return new Session({
    port: options.port,
    child,
    profileDir,
    width: options.width,
    height: options.height,
    slowMo: options.slowMo,
    headed: options.headed,
    version,
  });
}
