# 零依赖浏览器自动化（Chrome DevTools Protocol）

`tests/cdp.mjs` 是一个只用 Node 内置模块和全局 `fetch` / `WebSocket` 写成的极简 CDP 客户端，用真实的 Microsoft Edge 做端到端测试。不需要 `npm install`，也不依赖 Chrome。

要求：Windows + Node.js 24+（本机实测 Node v24.22.1 / Microsoft Edge 157）。Edge 路径固定为：

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `tests/cdp.mjs` | CDP 客户端：启动 Edge、建页、键鼠、截图、求值、事件 |
| `tests/smoke_cdp.mjs` | 8 项端到端自检 |
| `tests/fixtures/cdp_fixture.html` | 自检夹具：canvas + rAF + 键鼠记录 + FPS |
| `tests/README.md` | 本文档 |
| `artifacts/logs/smoke_cdp.log` / `.json` | 最近一次 headless 自检结果 |
| `artifacts/logs/smoke_cdp_headed.log` / `.json` | 最近一次 headed 自检结果 |
| `artifacts/screenshots/smoke_cdp.png` | headless 自检截图 |
| `artifacts/screenshots/smoke_cdp_headed.png` | headed 自检截图 |

浏览器临时 profile 默认放在 `artifacts/tmp/browser-profile/<pid-random>/`，`session.close()` 时会删除。不要手动删 `artifacts/logs/`，其结果用于回归对比。

## 快速开始

```js
import { launch } from './tests/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const session = await launch({ headed: false, width: 1280, height: 720 });

try {
  session.setGlobalConsoleSink((kind, text) => {
    console.log(`[page:${kind}] ${text}`);
  });

  const page = await session.newPage();
  await page.setViewport(1280, 720);
  await page.goto('http://127.0.0.1:8080/');

  // goto 只保证 load 事件；游戏/画布还需要等自己的 ready 信号
  await page.waitFor('window.__READY__ === true', 8000);

  // 真实键盘输入（DOM 的 e.code）
  await page.keyDown('KeyD');
  await sleep(500);
  await page.keyUp('KeyD');

  // 真实鼠标中键长按（DOM MouseEvent.button === 1）
  await page.mouseMove(640, 360);
  await page.mouseDownHold('middle');
  await sleep(200);
  await page.mouseUpHold('middle');

  console.log('title:', await page.title());
  console.log('url:', await page.url());
  console.log('heap:', (await page.metrics()).JSHeapUsedSize);

  await page.screenshot('artifacts/screenshots/demo.png');
} finally {
  await session.close();
}
```

在项目根目录把上面的代码存成脚本、需要可被 `node` 直接执行时，用 `.mjs`。`page.screenshot()` 的相对路径按**调用进程的 cwd** 解析。

## API

### `launch(opts) -> Promise<Session>`

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `headed` | `false` | `false` 时加 `--headless=new`；`true` 打开真实窗口 |
| `port` | `9333` | CDP 端口；已被占用时直接抛错 |
| `width` / `height` | `1280` / `720` | 窗口尺寸；每个新页面还会用 `Emulation.setDeviceMetricsOverride` 固定为这个 CSS 视口 |
| `userDataDir` | 自动生成 | 自定义 profile 路径；结束时同样会被清理 |
| `args` | `[]` | 追加给 Edge 的参数 |
| `slowMo` | `0` | 每次键鼠动作后的延迟（毫秒），用于肉眼观察 |
| `Edge 路径` | 固定 | 不开放配置，避免误用其他 Chromium |

浏览器就绪通过轮询 `http://127.0.0.1:<port>/json/version` 判断。启动失败、端口被占用、Edge 提前退出都会抛出包含上下文的错误。

### `Session`

```js
const page = await session.newPage('http://127.0.0.1:8080/');
await session.newPage('about:blank');      // 默认
session.setGlobalConsoleSink((kind, text) => {});
await session.close();                     // 幂等
```

- `newPage(url)`：优先 `PUT /json/new` 创建 page target；若接口不可用则退化为复用已有空白 page。创建后自动启用 `Runtime` / `Page` / `Performance` / `Log` 域并设置视口。`url` 非空白时会等待 load 事件。
- `setGlobalConsoleSink(fn)`：`fn(kind, text)`，对所有已有和后续页面生效。传 `null` 取消。回调抛错不会打断浏览器事件处理。
- `close()`：关闭所有页面、`taskkill /T /F` 结束 Edge 进程树、删除临时 user-data-dir。profile 删除失败只 `console.warn`。

### `Page`

```js
page.send(method, params, timeoutMs = 15000)  // 原始 CDP
page.goto(url)                                // Page.navigate + 等 load 事件
await page.eval('1 + 2')                      // returnByValue + awaitPromise + userGesture
await page.waitFor('window.__READY__ === true', 8000, 100)
await page.screenshot('artifacts/screenshots/x.png')  // 返回 PNG 字节数
await page.setViewport(1280, 720)
```

- `eval(expression)`：只在表达式正常返回时给值；页面抛异常时抛 `PageEvalError`，错误信息包含页面堆栈首段。
- `waitFor(expression, timeoutMs = 8000, pollMs = 100)`：立即轮询，真值即返回该值。也接受函数。求值过程中的临时异常会被忽略，超时错误包含最后一次求值错误。
- `screenshot(filePath)`：截图前最多等两帧 `requestAnimationFrame`；页面隐藏/没有 rAF 时不会卡死，会在 2 秒后直接截图。目录不存在会自动创建。
- `setViewport(w, h)`：固定 CSS 视口、DPR=1。真实窗口模式下不会改变操作系统窗口外框，但页面内容区就是这个尺寸。
- `metrics()`：把 `Performance.getMetrics` 的数组拍平成 `{ JSHeapUsedSize, Nodes, ... }`。

#### 键盘：`code` 用 DOM 的 `e.code`

```js
await page.keyDown('KeyA');
await page.keyDownMany(['KeyD', 'ShiftLeft']);
await page.keyDownMany(['KeyA', 'ShiftLeft']);
await page.keyUpMany(['KeyA', 'ShiftLeft']);
await page.keyUp('KeyA');
await page.press('KeyJ', 60); // 按下 → 等 60ms → 松开
```

支持的 code（**区分大小写**，必须严格匹配）：

- `KeyA` … `KeyZ`
- `Digit0` … `Digit9`
- `Space`、`ShiftLeft`、`ShiftRight`、`ControlLeft/Right`、`AltLeft/Right`、`MetaLeft/Right`
- `ArrowLeft/Right/Up/Down`、`Escape`、`Enter`、`Tab`
- `Backspace`、`Delete`、`Insert`、`Home`、`End`、`PageUp`、`PageDown`
- `F1` … `F12`

每次 `Input.dispatchKeyEvent` 都同时带 `key`、`code`、`windowsVirtualKeyCode`、`nativeVirtualKeyCode`。字符键 keyDown 带 `text`；Shift 按住时字母会变成大写 `key`/`text`。未知 code 直接抛出明确错误。按住多个键时 `modifiers` 位掩码会同步维护。

#### 鼠标：x/y 是相对视口左上角的 CSS 像素

```js
await page.mouseMove(640, 360);
await page.click('left', 40);          // 当前位置按下并松开
await page.mouseDownHold('middle');     // 时间减缓常用
await page.mouseUpHold('middle');
await page.mouseDown('right');
await page.mouseUp('right');
```

只接受 `'left' | 'right' | 'middle'`。CDP 层的 `buttons` 位掩码会自动维护：left=1、right=2、middle=4；`mousePressed` / `mouseReleased` 均带 `clickCount: 1`。DOM 的 `MouseEvent.button` 中中键是 `1`，库内部使用 CDP 字符串 `'middle'`。

右键菜单和鼠标中键自动滚动需要页面自己 `preventDefault`；本项目的自检夹具已经处理。

#### 其它

```js
await page.title();
await page.url();        // Page.getNavigationHistory，不依赖页面 JS
await page.close();      // 关闭标签页并释放 WebSocket
```

`Page.close()` 与 `Session.close()` 都是幂等的。

## 诊断：console、异常、日志、对话框

```js
session.setGlobalConsoleSink((kind, text) => {
  // kind: 'console' | 'exception' | 'log' | 'dialog'
  console.log(`[${kind}] ${text}`);
});

const page = await session.newPage('http://127.0.0.1:8080/');
// ...
console.log(page.consoles);   // [{ kind:'console', type:'error', text, time, args }]
console.log(page.exceptions); // [{ kind:'exception', text, url, lineNumber, ... }]
console.log(page.logs);       // Log.entryAdded
console.log(page.dialogs);    // Page.javascriptDialogOpening
```

- `console` 的 `text` 形如 `[error] xxx`，`kind` 统一为 `'console'`；console 类型见数组元素的 `type`。
- 未捕获异常 `/exception` 同时写入 `page.exceptions` 和 sink。
- `page.logs` 是浏览器网络/渲染日志，404 favicon 等也会进来；不要把它当异常。自检夹具为 favicon 返回 204。
- `Page.javascriptDialogOpening` 只上报、**不自动关闭**。需要脚本自己处理，例如：

```js
await page.send('Page.handleJavaScriptDialog', { accept: true });
```

## 自检

headless（正式结果）：

```bash
node tests/smoke_cdp.mjs
```

真实窗口（额外一套产物，不覆盖 headless）：

```bash
node tests/smoke_cdp.mjs --headed
```

脚本用 `import.meta.url` 定位项目，可从任意工作目录运行。会起一个随机端口的临时静态服务器（只服务 `tests/fixtures/cdp_fixture.html`），结束后关闭。

8 项断言：

1. 页面加载、canvas 1280×720、视口、标题帧数、1 秒后 FPS > 30
2. eval 往返、waitFor 成功、waitFor 超时抛错
3. `press`、`keyDownMany`、`keyUpMany` 和松开后不再新增 keydown
4. 鼠标中键：DOM `button === 1`、坐标 `(640, 360)`、buttons 位掩码
5. PNG 截图字节数 > 20000 且文件真实存在、签名有效
6. `metrics().JSHeapUsedSize > 0`
7. `console.error` 被 sink 捕获；未捕获 `throw` 被 `page.exceptions` 捕获
8. 连续 200 次 `eval` 的往返延迟

### 运行、构建与清理

- 没有构建步骤，也没有 `package.json` 依赖：直接 `node tests/smoke_cdp.mjs`。
- 浏览器临时 profile 在 `artifacts/tmp/browser-profile/<pid-random>/`。正常退出由 `session.close()` 删除；空父目录 `browser-profile/` 可以保留，也可以手动清掉。
- profile 删除失败只会 `console.warn`，不会让测试进程崩溃退出。若上次异常断电/强杀留下残留，先确认没有 Edge 测试进程，再执行：

```powershell
# 仅清理本测试的临时 profile，不会动 artifacts/logs 与 screenshots
Remove-Item -Recurse -Force artifacts\tmp\browser-profile -ErrorAction SilentlyContinue
```

- 端口：CDP 默认 `9333`（被占用会报错，不会误连旧实例）；静态夹具服务器使用系统分配的随机端口。本次会话不常驻、不占端口。

## 实测数据（Microsoft Edge 157，Node v24.22.1，Windows）

headless 模式（`node tests/smoke_cdp.mjs`）：

- 8/8 通过（耗时约 10.2s）。
- 夹具 canvas 为 1280×720、DPR=1；rAF **61 FPS**（等待 1.1s 时的最近 1 秒帧数；换测量点 frames=98）。没有出现 headless 下 rAF 被虚拟成异常快/慢的问题，基本就是显示器 60Hz 的节拍。
- 截图 `artifacts/screenshots/smoke_cdp.png`：**598,286 bytes**。
- `JSHeapUsedSize`：约 1.43 MiB。
- 连续 200 次 `eval('1 + 1')`：
  - 平均 **2.992 ms**
  - P50 **0.811 ms**
  - P95 **12.583 ms**
  - 最大 **77.594 ms**
  - 总耗时 598.4 ms
- 延迟分布是双峰的：多数调用 < 1ms，少数会撞上浏览器主线程/合成帧，出现 ~8ms 或更大的尖峰。因此做实时控制时优先在单个 `eval` 里批量读取/写入状态，不要对时间敏感逻辑依赖每次 3ms 的均值。

headed 模式（`node tests/smoke_cdp.mjs --headed`，真实窗口）：

- **8/8 全部通过**；截图 `artifacts/screenshots/smoke_cdp_headed.png`：**598,932 bytes**，尺寸 1280×720。
- fixture FPS=**60**，frames=179；真实窗口下 rAF 同样稳定在 60Hz（本机没有 120Hz 刷新，rAF 不按 unthrottled 跑）。
- `JSHeapUsedSize`：约 1.11 MiB。
- 连续 200 次 `eval('1 + 1')`：
  - 平均 **13.166 ms**
  - P50 **13.203 ms**
  - P95 **33.676 ms**
  - 最大 **66.714 ms**
  - 总耗时 2,633.3 ms
- 同一次 headed 运行里还观测到几次约 4–5s 的 CDP 命令停顿（例如一次 `waitFor` 的 300ms 超时实际到 4,982ms 才抛出）。这些是浏览器/系统调度侧的长尾，不是 Node 侧事件循环挂死；错误最终仍按预期抛出。
- **结论：自动化测试优先 headless。** headed 适合人工确认真实窗口画面和 FPS。需要实时决策（例如自动驾驶机器人）时，把决策循环放进页面内（项目里是 `tests/lib/bot.js`），CDP 只做低频的状态读取、截图和人工干预。
- headed 与 headless 的 launch 参数只差一个 `--headless=new`（以及 UA），但 headed 要经过真实窗口合成/前台调度，CDP 往返和长尾明显更差；不要用 headed 的均值来给实时逻辑定时。

> 以上数字来自 2026-11-21 的本机实测，日志和截图都在 `artifacts/`。重新跑会覆盖同名日志；headed 使用独立的 `*_headed.*` 文件名，不会覆盖 headless 结果。

## 已知坑

1. **先等页面 ready，再驱动。** `goto()` 只等 load；canvas 应用通常在 `requestAnimationFrame` 里初始化，建议先 `waitFor('window.__READY__ === true')` 再截图/按键。
2. **截图前等一帧。** `screenshot()` 已自动等两帧，但首帧画布内容仍可能是空的；业务有 ready 信号时先等 ready，必要时再自己等 1–2 帧。
3. **中键不是 DOM button 4。** CDP 用 `'middle'`，DOM 事件里 `button === 1`；这只是映射关系，不要自己传数字。
4. **右键上下文菜单**不会由库自动屏蔽；页面要监听 `contextmenu` 并 `preventDefault`，否则真实窗口模式可能弹菜单。
5. **console sink 是事件驱动**，不是 `eval` 返回值；收到 console.error 后建议用轮询/短 sleep 等它到达，不要假设它和下一条 CDP 响应严格同序。
6. **弹窗不会自动关闭**。alert/confirm 会挂住页面 JS，必须调用 `Page.handleJavaScriptDialog`。
7. **每次 `session.newPage()` 都是新标签页**，同一 session 内共享浏览器进程和临时 profile；页面间不会自动隔离端口。
8. **端口冲突会主动报错**，不会悄悄连到上一次残留的 Edge。换 `opts.port` 即可。
9. **沙箱限制**：Chromium 需要创建 Windows 命名管道；如果进程环境禁止创建命名管道（例如受限的 DSH workspace-write 沙箱），Edge 会只活 0.1s 就退出并报 `FATAL:mojo\public\cpp\platform\platform_channel.cc ... 拒绝访问 (0x5)`。在正常/danger-full-access 环境不会出现。
10. **headed 的 CDP 延迟不适合毫秒级控制。** 本次实测均值 13.2ms，而且会偶发 4–5s 的单次命令停顿；`waitFor` 的 `timeoutMs` 只能保证最终抛错，单次 `eval` 卡住时抛错时间会被动延长（实测 300ms 超时在 headed 下约 4,982ms 才返回）。实时决策请放进页面内。
11. 仅支持 `code` 表中列出的按键；特殊输入（输入法、组合键输入文本）请用 `eval` 设置对应 DOM 状态或自行扩展 `KEYS` 表。
