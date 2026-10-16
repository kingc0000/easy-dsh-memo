// Smoke test: load the plugin with a fake ctx, assert dead code is gone.
// Usage: node smoke.mjs   (uses a temp memo file, never touches production)
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from './lib/index.js';
import { appendEntry, readMemo, summarizeTurn } from './lib/memo-store.js';

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const tmp = mkdtempSync(join(tmpdir(), 'edm-smoke-'));
const memoFile = join(tmp, 'memo.md');

// --- fake ctx -------------------------------------------------------------
const listeners = {};
const tools = [];
const logs = [];
const effects = [];
const ctx = {
  id: 'fake',
  logger: {
    exporter() {},
    info(...a) { logs.push(['info', ...a]); },
    debug(...a) { logs.push(['debug', ...a]); },
    warn(...a) { logs.push(['warn', ...a]); },
  },
  get(name) {
    if (name === 'tools') {
      return {
        register(tool) { tools.push(tool); return () => {}; },
      };
    }
    return undefined;
  },
  on(name, cb) { (listeners[name] ||= []).push(cb); return () => {}; },
  effect(fn) { effects.push(fn); return () => {}; },
};

// --- run plugin -----------------------------------------------------------
apply(ctx, { memoPath: memoFile, logFile: join(tmp, 'logs', 'm.log') });

ok(tools.length === 5, `5 tools registered (got ${tools.length})`);
ok(tools.map((t) => t.name).join(',') === 'memo_save,memo_read,memo_edit,memo_clear,memo_recent',
  'tool names: ' + tools.map((t) => t.name).join(','));

// no auto-inject listener: only auto-save on session/event
const sesListeners = listeners['session/event'] || [];
ok(sesListeners.length === 1, `exactly 1 session/event listener (auto-save only), got ${sesListeners.length}`);

// activated log must not mention autoInject
ok(!logs.some((l) => l.join(' ').includes('autoInject')), 'activated log has no autoInject');

// no injectedSessions / autoInject anywhere in source
const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf-8');
ok(!/autoInject|injectAsSystem|injectedSessions/.test(src), 'source contains no autoInject/injectAsSystem/injectedSessions');

// --- tools actually work --------------------------------------------------
const saveTool = tools.find((t) => t.name === 'memo_save');
await saveTool.execute({ content: '- 用户偏好中文回复', label: 'smoke' });
const saved = readMemo(memoFile);
ok(saved.includes('用户偏好中文回复'), 'memo_save wrote entry');

const readTool = tools.find((t) => t.name === 'memo_read');
const digest = await readTool.execute({});
ok(digest.mode === 'digest' && digest.content.includes('关键约束'), `memo_read digest mode, contains 关键约束`);
const sec = await readTool.execute({ section: '流水' });
ok(sec.mode === 'section', 'memo_read section mode');

const recentTool = tools.find((t) => t.name === 'memo_recent');
const rec = await recentTool.execute({});
ok(rec.total >= 1, `memo_recent total>=1 (got ${rec.total})`);

// --- summarizeTurn / extractKeyPoints -------------------------------------
const longText = '项目配置结论：这是一个没有标题也没有加粗也没有列表的很长的纯文本回复，用来验证兜底分支能正常抽取出第一句完整句子而不会崩溃。';
const st = summarizeTurn('', longText, 'smoke');
ok(st && st.entry, 'summarizeTurn returns entry for plain long text (fallback path)');

const storeSrc = readFileSync(new URL('./lib/memo-store.js', import.meta.url), 'utf-8');
const fallbackBlock = storeSrc.slice(storeSrc.indexOf('Fallback: first meaningful sentence'));
ok(!/assistantText/.test(fallbackBlock), 'extractKeyPoints fallback no longer depends on outer assistantText closure');

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
