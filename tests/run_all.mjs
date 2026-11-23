// ============================================================
// tests/run_all.mjs —— 一键跑全部自测，最后汇总成一张表
//   node tests/run_all.mjs            # 全部（含 10 分钟长跑）
//   node tests/run_all.mjs --quick    # 跳过长时间运行
//   node tests/run_all.mjs --skip-headed  # 跳过需要真实窗口的部分
// 汇总：artifacts/results/SUMMARY.md 与 summary.json
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'artifacts', 'results');
const LOGS = path.join(ROOT, 'artifacts', 'logs');
const quick = process.argv.includes('--quick');
const skipHeaded = process.argv.includes('--skip-headed');

const SUITE = [
  { name: '基础设施自检（CDP 客户端）', cmd: ['tests/smoke_cdp.mjs'], result: null },
  { name: '基础设施自检（headed）', cmd: ['tests/smoke_cdp.mjs', '--headed'], result: null, headed: true },
  { name: '夹具：音频 / 背景', cmd: ['tests/run_fixtures.mjs'], result: 'fixtures' },
  { name: '关键画面留影 + 冒烟', cmd: ['tests/run_shots.mjs'], result: 'run_shots' },
  { name: '键位 / 边界 / 异常（含子弹时间比值）', cmd: ['tests/run_input.mjs'], result: 'run_input' },
  { name: '子弹时间像素证据（成对截图）', cmd: ['tests/run_bullettime_visual.mjs'], result: 'run_bullettime_visual' },
  { name: '完整流程（两遍）', cmd: ['tests/run_flow.mjs'], result: 'run_flow' },
  { name: '死亡重试 80 次 + 内存（每次 2 秒任务失败）', cmd: ['tests/run_death.mjs'], result: 'run_death' },
  { name: '压测（headless）', cmd: ['tests/run_stress.mjs'], result: 'run_stress' },
  { name: '压测（headed，真实窗口）', cmd: ['tests/run_stress.mjs', '--headed'], result: 'run_stress_headed', headed: true },
  { name: '长时间运行（10 分钟）', cmd: ['tests/run_soak.mjs', '10'], result: 'run_soak', long: true },
];

function run(cmdAll) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, cmdAll, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

await fs.mkdir(RESULTS, { recursive: true });
await fs.mkdir(LOGS, { recursive: true });
// 清掉上次浏览器留下的临时 profile
try {
  await fs.rm(path.join(ROOT, 'artifacts', 'tmp'), { recursive: true, force: true });
} catch {}

const rows = [];
for (const s of SUITE) {
  if (quick && s.long) {
    rows.push({ ...s, skipped: true });
    console.log(`\n⏭  跳过：${s.name}`);
    continue;
  }
  if (skipHeaded && s.headed) {
    rows.push({ ...s, skipped: true });
    console.log(`\n⏭  跳过（headed）：${s.name}`);
    continue;
  }
  console.log(`\n▶▶ ${s.name}  (node ${s.cmd.join(' ')})`);
  const r = await run(s.cmd);
  const logName = path.basename(s.cmd[0], '.mjs') + (s.cmd.includes('--headed') ? '_headed' : '') + '.txt';
  await fs.writeFile(path.join(LOGS, logName), r.out, 'utf8');
  let summary = null;
  if (s.result) {
    try {
      summary = JSON.parse(await fs.readFile(path.join(RESULTS, `${s.result}.json`), 'utf8'));
    } catch {}
  }
  rows.push({ ...s, exit: r.code, ms: r.ms, summary });
  console.log(`   → exit=${r.code}  ${summary ? `${summary.passed}/${summary.total} 通过` : ''}  ${(r.ms / 1000).toFixed(1)}s`);
}

// ---------------- 汇总 ----------------
let md = `# 自测汇总\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n`;
md += `| 测试 | 结果 | 通过/总数 | 耗时 | 失败项 |\n| --- | --- | --- | --- | --- |\n`;
let totalPass = 0;
let totalAll = 0;
let anyFail = false;
for (const r of rows) {
  if (r.skipped) {
    md += `| ${r.name} | 跳过 | - | - | - |\n`;
    continue;
  }
  const s = r.summary;
  const ok = s ? s.ok && r.exit === 0 : r.exit === 0;
  if (!ok) anyFail = true;
  if (s) {
    totalPass += s.passed;
    totalAll += s.total;
  }
  md += `| ${r.name} | ${ok ? '✅ PASS' : '❌ FAIL'} | ${s ? `${s.passed}/${s.total}` : '-'} | ${(r.ms / 1000).toFixed(1)}s | ${
    s && s.failures && s.failures.length ? s.failures.join('<br>') : '-'
  } |\n`;
}
md += `\n**合计：${totalPass}/${totalAll} 项断言通过**\n`;
await fs.writeFile(path.join(RESULTS, 'SUMMARY.md'), md, 'utf8');
await fs.writeFile(
  path.join(RESULTS, 'summary.json'),
  JSON.stringify({ when: new Date().toISOString(), anyFail, totalPass, totalAll, rows: rows.map(({ out, ...r }) => r) }, null, 2),
  'utf8',
);

console.log('\n' + md);
console.log('汇总已写入 artifacts/results/SUMMARY.md');
process.exit(anyFail ? 1 : 0);
