// ============================================================
// tests/shot_page.mjs —— 通用：打开任意页面/夹具，等就绪后截图
// 用法： node tests/shot_page.mjs <path?query> <输出名> [--wait=表达式] [--size=1280x720]
// 例：   node tests/shot_page.mjs "tests/fixtures/chars_check.html" chars
// ============================================================
import path from 'node:path';
import { launch } from './cdp.mjs';
import { startServer } from '../server.mjs';
import { ARTIFACTS, SHOTS, ensureDirs, sleep } from './lib/harness.mjs';

const args = process.argv.slice(2);
const pagePath = args[0] || 'index.html';
const name = args[1] || 'shot';
const waitArg = args.find((a) => a.startsWith('--wait='));
const waitExpr = waitArg ? waitArg.slice(7) : 'window.__READY__ === true || window.__CHARS_READY__ === true || window.__BACKDROP_CHECK_DONE__ === true || window.__AUDIO_CHECK_DONE__ === true';
const sizeArg = args.find((a) => a.startsWith('--size='));
const [w, h] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [1280, 720];
const freezeGame = args.includes('--freeze');

await ensureDirs();
const server = await startServer({ port: 9931, open: false, quiet: true });
const session = await launch({
  port: 9932,
  width: w,
  height: h,
  userDataDir: path.join(ARTIFACTS, 'tmp', `shot-${Date.now()}`),
});
const errs = [];
session.setGlobalConsoleSink((kind, text) => {
  if (kind === 'error' || kind === 'exception') errs.push(`${kind}: ${text}`);
});
try {
  const url = server.url.replace('index.html', pagePath);
  const page = await session.newPage(url);
  await page.waitFor(waitExpr, 20000);
  await sleep(300);
  if (freezeGame) {
    try {
      await page.eval('window.__TEST__.freeze(true)');
    } catch {}
  }
  const f = path.join(SHOTS, `${name}.png`);
  const bytes = await page.screenshot(f);
  console.log(`📷 artifacts/screenshots/${name}.png  ${(bytes / 1024).toFixed(0)} KB  ${w}x${h}`);
  if (errs.length) console.log('⚠️ 页面报错：\n' + errs.slice(0, 6).join('\n'));
} finally {
  try {
    await session.close();
  } catch {}
  await server.close();
}
