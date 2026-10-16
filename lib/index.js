/**
 * @module easy-dsh-memo
 *
 * Global conversation memory for DeepSeek Harness (DSH).
 *
 * What it does:
 * 1. **Auto-save** — after each assistant turn, extracts important info and
 *    appends a summary to ~/.dsh/memo.md (newest first).
 * 2. **Tools** — the agent can explicitly save, read, edit, or clear global memory:
 *    - `memo_save(content)`   — save a specific note
 *    - `memo_read()`          — read global memory, 默认精简摘要(约束+偏好+最近流水)
 *                              — 按需: section=<分类> / query=<关键词> / full=true
 *    - `memo_edit(heading, content)` — edit a section
 *    - `memo_clear()`         — reset memory
 *    - `memo_recent(count)`   — show recently saved entries
 * 3. **No injection** — memory reaches the model through the `memo_read` tool.
 *    (A first-turn auto-inject placeholder existed before but never injected
 *    anything and was removed as dead code. If first-turn injection is ever
 *    wanted, use dsh's native mechanism: `$DSH_HOME/AGENTS.md`, loaded by
 *    `dsh-agent-instructions` on a new session's first request.)
 *
 * Install:  dsh plugin add ./easy-dsh-memo
 * Or from local path:  dsh plugin add /path/to/easy-dsh-memo
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  resolveMemoPath,
  readMemo,
  appendEntry,
  editSection,
  clearMemo,
  summarizeTurn,
} from './memo-store.js';

/** Stable cordis plugin name. */
export const name = 'easy-dsh-memo';

/** Validated plugin configuration. */
export const Config = z.object({
  /**
   * Custom path for memo.md. Defaults to `$DSH_HOME/memo.md` (typically
   * ~/.dsh/memo.md).
   */
  memoPath: z.string().required(false),

  /**
   * When true (default), auto-save a turn summary to memo.md after each
   * assistant response. Set false to disable auto-save (tools still work).
   */
  autoSave: z.boolean().required(false),

  /**
   * Optional log file path for plugin logs. Defaults to
   * `$DSH_HOME/logs/easy-dsh-memo.log`.
   */
  logFile: z.string().required(false),
});

/**
 * Create a console logger exporter that writes to stdout/stderr and optionally
 * to a log file. DSH surfaces do not mount a console exporter by default, so
 * `ctx.logger.*` records land in the in-memory buffer and are never printed.
 *
 * @param logFile - optional absolute path to append logs to.
 * @returns a cordis logger exporter.
 */
function createLoggerExporter(logFile) {
  const debugEnabled = process.env.MEMO_DEBUG === '1';
  return {
    levels: { default: 3 }, // 3 = debug
    export(message) {
      if (message.type === 'debug' && !debugEnabled) return;
      const time = new Date(message.ts).toISOString();
      const prefix = `[${time}] easy-dsh-memo [${message.type}]`;
      const args = message.args.map((arg) => {
        if (arg instanceof Error) return arg.stack ?? arg.message;
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ');
      const line = `${prefix} ${args}`;

      // Write to log file
      if (logFile !== undefined) {
        try {
          mkdirSync(dirname(logFile), { recursive: true });
          appendFileSync(logFile, line + '\n');
        } catch {
          // swallow
        }
      }

      // Write to console
      const write = message.type === 'error' || message.type === 'warn' ? console.error : console.log;
      write(line);
    },
  };
}

/**
 * Minimal defineTool implementation — creates a tool object in the format
 * expected by `tools.register()`. This avoids importing @deepseek-ai/dsh-tools
 * which has a heavy transitive dependency chain.
 *
 * @param options - tool definition
 * @returns registry-ready tool definition
 */
function defineTool(options) {
  const { name, description, parameters, output, execute, isConcurrencySafe } = options;

  // Convert parameter schema specs to JSON Schema format
  const parameterSchemas = {};
  if (parameters) {
    for (const [key, spec] of Object.entries(parameters)) {
      parameterSchemas[key] = {
        type: spec.type,
        description: spec.description,
        required: spec.required !== false,
        ...(spec.items ? { items: spec.items } : {}),
      };
    }
  }

  const tool = {
    name,
    description,
    parameters: parameterSchemas,
    output: {
      schema: { type: 'json' },
      render(args, value) {
        if (output && typeof output.render === 'function') {
          return output.render(args, value);
        }
        return [{ type: 'text', text: String(value) }];
      },
    },
    async execute(args, exec) {
      return execute(args, exec);
    },
  };

  if (typeof isConcurrencySafe === 'function') {
    tool.isConcurrencySafe = isConcurrencySafe;
  }

  return tool;
}

/**
 * Build a compact memory digest — 只含关键约束 + 用户偏好 + 最近 N 条流水。
 * 目的是避免把无关历史全量传给 LLM; 完整内容按需用 section/query/full 查。
 */
function buildDigest(memoContent, recentCount = 5) {
  const section = (start, endRe) => {
    const i = memoContent.indexOf(start);
    if (i < 0) return '';
    const rest = memoContent.slice(i + start.length);
    const m = endRe.exec(rest);
    return m ? rest.slice(0, m.index).trim() : rest.trim();
  };

  const constraints = section('# 📌 关键约束', /^# 🗂️/m);
  const prefs = section('# 🎯 Preferences', /^# 📜/m);

  // 最近 N 条流水: 头部区(# 🧠 之后到 # 📌 之前的 ### 条目, 新条目在上)
  const streamEnd = memoContent.indexOf('# 📌 关键约束');
  const stream = (streamEnd >= 0 ? memoContent.slice(0, streamEnd) : memoContent).trim();
  const recent = [];
  for (const block of stream.split('\n### ')) {
    if (recent.length >= recentCount) break;
    const entry = block.trim();
    if (entry && !entry.startsWith('# 🧠') && !entry.startsWith('> Auto-managed')) {
      recent.push(entry.startsWith('### ') ? entry : '### ' + entry);
    }
  }

  return [
    '# 📌 关键约束',
    constraints || '(空)',
    '',
    '# 🎯 Preferences',
    prefs || '(空)',
    '',
    `# 🕘 最近 ${recentCount} 条对话流水`,
    ...(recent.length ? recent : ['(无)']),
    '',
    '# 📚 完整记忆按需查询',
    'memo_read({ section: "facts|projects|lessons|历史|流水" }) 读单个分类;',
    'memo_read({ query: "关键词" }) 精准召回; memo_read({ full: true }) 全量。',
  ].join('\n');
}

/**
 * Mount the easy-dsh-memo plugin.
 *
 * @param ctx - cordis plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const memoPath = resolveMemoPath(config.memoPath);
  const autoSave = config.autoSave !== false;

  // Configure logger exporter (DSH surfaces don't mount one by default)
  const logFile = config.logFile ?? join(dirname(memoPath), 'logs', 'easy-dsh-memo.log');
  ctx.logger.exporter(createLoggerExporter(logFile));
  const logger = ctx.logger;

  logger.info(
    `activated: memo=${memoPath} autoSave=${autoSave} log=${logFile}`
  );

  // ─── Auto-save listener (registered BEFORE tools check) ────────────────────

  if (autoSave) {
    ctx.on('session/event', (session, event) => {
      // Only auto-save on assistant messages (end of a response).
      if (event.type !== 'assistant/message') return;
      if (!event.data || !event.data.message) return;

      const message = event.data.message;
      if (!message.content || !Array.isArray(message.content)) return;

      // Extract text content from the message
      const textContent = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ');

      if (!textContent || textContent.trim() === '') return;

      const sessionLabel = `Session ${session.id}`;
      const timestamp = new Date(event.time || Date.now()).toISOString();

      try {
        const result = summarizeTurn('', textContent, sessionLabel);
        if (result && result.entry) {
          appendEntry(memoPath, result.entry, timestamp, sessionLabel);
          logger.info(
            `💾 Auto-saved (importance: ${result.importance.toFixed(2)}): ${result.summary}`
          );
        } else {
          logger.debug('Skipped (not important enough)');
        }
      } catch (error) {
        logger.warn(
          `auto-save failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    logger.debug('auto-save listener registered');
  }

  // ─── Tools (optional - doesn't block auto-save) ───────────────────────────

  const tools = ctx.get('tools');
  if (tools === undefined) {
    logger.warn('tools service absent; memo tools not registered (auto-save still works)');
    return;
  }

  /** Memo save tool — append a note to global memory. */
  const disposeSave = tools.register(
    defineTool({
      name: 'memo_save',
      description:
        'Save important information to the global memory file (~/.dsh/memo.md). ' +
        'Use this when the user shares key preferences, decisions, project context, ' +
        'or any information worth remembering across conversations. ' +
        'The content is saved in markdown format and will be available in future sessions.',
      parameters: {
        content: {
          type: 'string',
          required: true,
          description:
            'The information to save. Use markdown formatting (bullets, headings, etc.). ' +
            'Be concise — only save what is genuinely important to remember.',
        },
        label: {
          type: 'string',
          required: false,
          description:
            'Optional short label for this note (e.g. "User preference", "Project context").',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [
            { type: 'text', text: `📝 Saved to global memory (${value.length} bytes).` },
          ];
        },
      },
      async execute(args) {
        const { content, label } = args;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new Error('memo_save: `content` is required');
        }
        const sessionLabel = label ?? 'Manual note';
        const timestamp = new Date().toISOString();
        appendEntry(memoPath, content.trim(), timestamp, sessionLabel);
        logger.debug(
          `[easy-dsh-memo] saved "${sessionLabel}" (${content.length} chars)`
        );
        return { saved: true, bytes: content.length, label: sessionLabel };
      },
    })
  );

  /** Memo read tool — load global memory (compact by default). */
  const disposeRead = tools.register(
    defineTool({
      name: 'memo_read',
      description:
        'Read the global memory (~/.dsh/memo.md). 默认返回精简摘要: 只含关键约束、' +
        '用户偏好与最近 5 条流水, 避免把无关历史全量带入上下文。' +
        '按需扩展: section=<约束|facts|projects|lessons|preferences|历史|流水> 读单个分类; ' +
        'query=<关键词> 精准召回相关条目; full=true 才返回完整文件(仅在确实需要时用)。',
      parameters: {
        query: { type: 'string', required: false, description: '关键词, 只返回匹配的记忆条目' },
        section: { type: 'string', required: false, description: '分类名, 只返回该分类' },
        full: { type: 'boolean', required: false, description: 'true=返回完整文件(默认 false)' },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          const lines = value.content.split('\n').length;
          return [
            {
              type: 'text',
              text: `📖 Loaded global memory (${value.length} bytes, ${lines} lines, mode=${value.mode || 'digest'}).`,
            },
          ];
        },
      },
      async execute(args) {
        const content = readMemo(memoPath);
        if (content === '') {
          return { content: '', empty: true, message: 'Global memory is empty.' };
        }
        const { query, section, full } = args || {};

        if (full) return { content, empty: false, mode: 'full' };

        if (section) {
          const map = {
            '约束': ['# 📌 关键约束', '# 🗂️'],
            facts: ['# 🗂️ Facts', '# 🗂️ Projects'],
            projects: ['# 🗂️ Projects', '# 💡'],
            lessons: ['# 💡 Lessons', '# 🎯'],
            preferences: ['# 🎯 Preferences', '# 📜'],
            '历史': ['# 📜 早期会话流水', '---'],
            流水: ['# 🧠 Global Memory', '# 📌 关键约束'],
          };
          const [s, e] = map[section] || [];
          if (s) {
            const si = content.indexOf(s);
            if (si >= 0) {
              const ei = content.indexOf(e, si + s.length);
              const sec = ei >= 0 ? content.slice(si, ei) : content.slice(si);
              return { content: sec.trim(), empty: false, mode: 'section', section };
            }
          }
          return { content: '', empty: true, message: `未知分类: ${section}` };
        }

        if (query) {
          const hits = [];
          const lines = content.split('\n');
          let cur = null;
          const q = query.toLowerCase();
          for (const line of lines) {
            if (/^#{2,3} /.test(line)) cur = line;
            if (line.toLowerCase().includes(q)) {
              hits.push((cur ? cur + '\n' : '') + line);
              cur = null;
            }
          }
          if (!hits.length) {
            return { content: '', empty: true, message: `未找到包含 "${query}" 的记忆` };
          }
          return { content: hits.slice(0, 20).join('\n---\n'), empty: false, mode: 'query', query };
        }

        // 默认: 精简摘要(约束 + 偏好 + 最近流水 + 索引), 不把全量历史带给 LLM
        const digest = buildDigest(content);
        return { content: digest, empty: false, mode: 'digest' };
      },
    })
  );

  /** Memo edit tool — replace a specific section. */
  const disposeEdit = tools.register(
    defineTool({
      name: 'memo_edit',
      description:
        'Edit a specific section of the global memory file. ' +
        'Provide the section heading (e.g. "2026-10-15" or a specific entry label) ' +
        'and the replacement markdown content.',
      parameters: {
        heading: {
          type: 'string',
          required: true,
          description:
            'The section heading to find (e.g. "2026-10-15", "My project notes").',
        },
        content: {
          type: 'string',
          required: true,
          description: 'Replacement markdown content for this section.',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [
            {
              type: 'text',
              text: value.success ? '✏️ Memory section updated.' : '⚠️ Section not found.',
            },
          ];
        },
      },
      async execute(args) {
        const { heading, content } = args;
        if (typeof heading !== 'string' || heading.trim() === '') {
          throw new Error('memo_edit: `heading` is required');
        }
        const success = editSection(memoPath, heading.trim(), content.trim());
        return { success };
      },
    })
  );

  /** Memo clear tool — reset all memory. */
  const disposeClear = tools.register(
    defineTool({
      name: 'memo_clear',
      description:
        'Clear all global memory. This is destructive — the entire memo.md will be reset. ' +
        'Use only when the user explicitly asks to reset memory.',
      parameters: {
        confirm: {
          type: 'string',
          required: true,
          description: 'Type "clear" to confirm. This cannot be undone.',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [
            {
              type: 'text',
              text: value.cleared ? '🗑️ Global memory cleared.' : '⚠️ Confirmation failed.',
            },
          ];
        },
      },
      async execute(args) {
        const { confirm } = args;
        if (confirm !== 'clear') {
          return {
            cleared: false,
            message: 'Confirmation failed: type "clear" to confirm.',
          };
        }
        clearMemo(memoPath);
        logger.info('[easy-dsh-memo] memory cleared');
        return { cleared: true };
      },
    })
  );

  /** Memo recent tool — show recently saved entries. */
  const disposeRecent = tools.register(
    defineTool({
      name: 'memo_recent',
      description:
        'Show the most recently saved memory entries (last 5). ' +
        'Use this to quickly review what was auto-saved from recent conversations.',
      parameters: {
        count: {
          type: 'number',
          required: false,
          description: 'Number of recent entries to show (default 5, max 20).',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [
            {
              type: 'text',
              text: `📋 Showing ${value.shown} of ${value.total} recent entries.`,
            },
          ];
        },
      },
      async execute(args) {
        const count = Math.min(args.count || 5, 20);
        const content = readMemo(memoPath);
        if (content === '') {
          return { entries: [], shown: 0, total: 0, message: 'No memories saved yet.' };
        }

        // Split into entries by "###" headings
        const entries = content.split(/\n### /).filter((e) => e.trim());
        const recent = entries.slice(0, count).map((e) => '### ' + e.trim());

        return {
          entries: recent,
          shown: recent.length,
          total: entries.length,
        };
      },
    })
  );

  // Register cleanup effects
  ctx.effect(() => () => {
    if (disposeSave) disposeSave();
    if (disposeRead) disposeRead();
    if (disposeEdit) disposeEdit();
    if (disposeClear) disposeClear();
    if (disposeRecent) disposeRecent();
  });

  logger.info(`ready — memo at ${memoPath}`);
}
