// ============================================================
// server.mjs —— 零依赖静态文件服务器
// 只用 node:http / node:fs，不安装任何依赖。
// 只监听 127.0.0.1，只服务项目目录内的文件（防目录穿越）。
// 浏览器不允许用 file:// 加载 ES Module，所以需要这个服务器。
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function safeResolve(urlPath) {
  // 去掉 query / hash，解码，拼到 ROOT 下并确认没有跑出目录
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.resolve(ROOT, '.' + path.posix.normalize(p));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function createHandler() {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      const abs = safeResolve(req.url || '/');
      if (!abs) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + req.url);
        return;
      }
      let file = abs;
      if (stat.isDirectory()) {
        file = path.join(abs, 'index.html');
        try {
          stat = await fsp.stat(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404');
          return;
        }
      }
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ETag: etag,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 ' + (err && err.message));
    }
  };
}

function tryOpenBrowser(url) {
  try {
    // 用 cmd /c start 打开默认浏览器；失败也不影响服务器
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动服务器。测试脚本也复用它（传入 open:false）。
 * @param {{port?:number, open?:boolean, quiet?:boolean, maxPortTries?:number}} opts
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export function startServer(opts = {}) {
  const { port = Number(process.env.PORT) || 8123, open = false, quiet = false, maxPortTries = 30 } = opts;
  const log = quiet ? () => {} : (...a) => console.log(...a);

  return new Promise((resolve, reject) => {
    const server = http.createServer(createHandler());
    let attempt = 0;

    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE' && attempt < maxPortTries) {
        attempt++;
        server.listen(port + attempt, HOST);
        return;
      }
      reject(err);
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      const actualPort = server.address().port;
      const url = `http://${HOST}:${actualPort}/index.html`;
      log('');
      log('  ┌──────────────────────────────────────────────┐');
      log('  │        武士零 · 丐版   —— 本地服务已启动      │');
      log('  └──────────────────────────────────────────────┘');
      log(`   地址： ${url}`);
      log('   关闭本窗口即结束游戏服务。');
      log('');
      if (open) {
        const ok = tryOpenBrowser(url);
        log(ok ? '   已尝试用默认浏览器打开。' : `   自动打开失败，请手动在浏览器里访问 ${url}`);
      }
      resolve({
        port: actualPort,
        url,
        close: () =>
          new Promise((res2) => {
            server.close(() => res2());
            // 保险：强制断开 keep-alive 连接
            setTimeout(res2, 500);
          }),
      });
    });

    server.listen(port, HOST);
  });
}

// 直接运行：启动并打开浏览器
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const noOpen = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';
  const s = await startServer({ open: !noOpen });
  const shutdown = () => {
    console.log('\n  正在关闭服务…');
    s.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
