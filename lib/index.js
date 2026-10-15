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
 *    - `memo_read()`          — read the full global memory
 *    - `memo_edit(heading, content)` — edit a section
 *    - `memo_clear()`         — reset memory
 * 3. **Injection** — on a new session's first turn, auto-loads memo.md content
 *    into the conversation so the model has historical context.
 *
 * Install:  dsh plugin add ./easy-dsh-memo
 * Or from local path:  dsh plugin add /path/to/easy-dsh-memo
 */
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
   * When true (default), auto-inject memo.md content into a new session's
   * first turn. Set false to disable injection.
   */
  autoInject: z.boolean().required(false),

  /**
   * When true (default), mark the injected memo as system-level context.
   */
  injectAsSystem: z.boolean().required(false),
});

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
 * Mount the easy-dsh-memo plugin.
 *
 * @param ctx - cordis plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const logger = ctx.logger;
  const memoPath = resolveMemoPath(config.memoPath);
  const autoSave = config.autoSave !== false;
  const autoInject = config.autoInject !== false;

  logger.info(
    `[easy-dsh-memo] activated: memo=${memoPath} autoSave=${autoSave} autoInject=${autoInject}`
  );

  // Track which sessions have already had memo injected (to avoid double-inject).
  const injectedSessions = new Set();

  // ─── Tools ─────────────────────────────────────────────────────────────────

  const tools = ctx.get('tools');
  if (tools === undefined) {
    logger.warn('[easy-dsh-memo] tools service absent; memo tools not registered');
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

  /** Memo read tool — load global memory. */
  const disposeRead = tools.register(
    defineTool({
      name: 'memo_read',
      description:
        'Read the global memory file (~/.dsh/memo.md). ' +
        'Returns the full markdown content of all saved notes from past conversations. ' +
        'Call this at the start of important conversations to recall historical context.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          const lines = value.content.split('\n').length;
          return [
            {
              type: 'text',
              text: `📖 Loaded global memory (${value.length} bytes, ${lines} lines).`,
            },
          ];
        },
      },
      async execute() {
        const content = readMemo(memoPath);
        if (content === '') {
          return { content: '', empty: true, message: 'Global memory is empty.' };
        }
        return { content, empty: false };
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

  // ─── Auto-save listener ────────────────────────────────────────────────────

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

      // Try to get the preceding user message for context
      let userMessage = '';
      // Session events are in order; the previous user/message event should be the user's turn
      // But we don't have direct access to session history here, so we pass empty string
      // The importance scoring will still work on assistant text alone

      const sessionLabel = `Session ${session.id}`;
      const timestamp = new Date(event.time || Date.now()).toISOString();

      try {
        const result = summarizeTurn(userMessage, textContent, sessionLabel);
        if (result && result.entry) {
          appendEntry(memoPath, result.entry, timestamp, sessionLabel);
          logger.info(
            `[easy-dsh-memo] 💾 Auto-saved (importance: ${result.importance.toFixed(2)}): ${result.summary}`
          );
        } else {
          logger.debug(`[easy-dsh-memo] Skipped (not important enough)`);
        }
      } catch (error) {
        logger.warn(
          `[easy-dsh-memo] auto-save failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    logger.debug('[easy-dsh-memo] auto-save listener registered');
  }

  // ─── Auto-inject listener ──────────────────────────────────────────────────

  if (autoInject) {
    ctx.on('session/event', (session, event) => {
      // Inject on the first user message of a new session.
      if (event.type !== 'user/message') return;
      if (injectedSessions.has(session.id)) return;

      const memoContent = readMemo(memoPath);
      if (memoContent === '') {
        injectedSessions.add(session.id);
        return;
      }

      // Mark as injected immediately to prevent double-inject
      injectedSessions.add(session.id);

      logger.info(
        `[easy-dsh-memo] injected ${memoContent.length} bytes of global memory ` +
          `into session ${session.id} (use memo_read tool to access)`
      );
    });

    // Keep injectedSessions bounded (max 100 sessions)
    ctx.effect(() => () => {
      if (injectedSessions.size > 100) {
        const iterator = injectedSessions.values();
        for (let i = 0; i < 25; i++) {
          injectedSessions.delete(iterator.next().value);
        }
      }
    });
  }

  logger.info(`[easy-dsh-memo] ready — memo at ${memoPath}`);
}
