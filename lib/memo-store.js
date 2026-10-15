/**
 * @module easy-dsh-memo/memo-store
 *
 * File-based global memory store backed by a single markdown file at
 * ~/.dsh/memo.md. Thread-safe via atomic-write (write-to-temp + rename).
 *
 * Format:
 *   # 🧠 Global Memory
 *
 *   > Auto-managed by easy-dsh-memo. Do not edit manually.
 *
 *   ## 2026-10-15
 *   ### 19:30 - Session: feishu-xxx
 *   - key point 1
 *   - key point 2
 *
 *   ## 2026-10-14
 *   ...
 *
 * New entries prepend to the top (under the header), newest first.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the memo.md path: config override → $DSH_HOME/memo.md → ~/.dsh/memo.md.
 */
export function resolveMemoPath(customPath) {
  if (customPath) return customPath;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'memo.md');
}

/**
 * Create the directory for memo.md if it does not exist.
 */
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the full memo content. Returns '' when the file does not exist or is empty.
 */
export function readMemo(filePath) {
  try {
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Append a new entry to the memo file (newest first).
 * The entry is grouped under today's date heading.
 *
 * @param filePath - absolute path to memo.md
 * @param entry - markdown content (without date heading)
 * @param timestamp - ISO 8601 timestamp string (for grouping)
 * @param sessionLabel - short label for the session/turn
 */
/**
 * Stable marker used to detect our managed memo file.
 * Uses a regex that matches the header regardless of timestamp.
 */
const HEADER_RE = /^# 🧠 Global Memory\n\n> Auto-managed by easy-dsh-memo\. Last updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

export function appendEntry(filePath, entry, timestamp, sessionLabel) {
  if (!entry || entry.trim() === '') return;

  ensureDir(filePath);

  const now = new Date(timestamp);
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeKey = now.toISOString().slice(11, 16); // HH:MM

  const dateHeading = `## ${dateKey}`;
  const entryBlock = `\n### ${timeKey} - ${sessionLabel}\n${entry}\n`;
  const newTimestamp = now.toISOString();

  let current = readMemo(filePath);

  if (current === '') {
    // New file
    const header = `# 🧠 Global Memory\n\n> Auto-managed by easy-dsh-memo. Last updated: ${newTimestamp}\n`;
    writeFileSync(filePath, header + dateHeading + entryBlock + '\n', 'utf-8');
    return;
  }

  // Check if file starts with our header (using regex to match any timestamp)
  const headerMatch = HEADER_RE.exec(current);
  if (!headerMatch) {
    // File exists without our header — prepend header + entry
    const header = `# 🧠 Global Memory\n\n> Auto-managed by easy-dsh-memo. Last updated: ${newTimestamp}\n`;
    const newContent = header + dateHeading + entryBlock + '\n' + current;
    atomicWrite(filePath, newContent);
    return;
  }

  // File has our header. Update the timestamp and insert entry.
  const headerEndIdx = headerMatch.index + headerMatch[0].length;
  const rest = current.slice(headerEndIdx).trimStart();
  const updatedHeader = `# 🧠 Global Memory\n\n> Auto-managed by easy-dsh-memo. Last updated: ${newTimestamp}\n`;

  // Check if today's date heading already exists
  if (rest.startsWith(dateHeading)) {
    // Insert new entry right after the existing date heading
    const afterDateHeading = rest.slice(dateHeading.length);
    const newContent = updatedHeader + dateHeading + entryBlock + afterDateHeading;
    atomicWrite(filePath, newContent);
  } else {
    // Insert a new date heading with the entry, before existing content
    const newContent = updatedHeader + dateHeading + entryBlock + '\n' + rest;
    atomicWrite(filePath, newContent);
  }
}

/**
 * Save/replace a specific section of the memo.
 * Searches for a heading match and replaces the content under it.
 *
 * @param filePath - absolute path to memo.md
 * @param heading - heading to find (e.g. "2026-10-15" or "2026-10-15\n### 19:30")
 * @param replacement - replacement markdown content
 */
export function editSection(filePath, heading, replacement) {
  const content = readMemo(filePath);
  if (content === '') return false;

  const headingLine = `## ${heading}`;
  const idx = content.indexOf(headingLine);
  if (idx === -1) return false;

  // Find the next heading of same or higher level
  const nextHeadingIdx = content.indexOf('\n## ', idx + headingLine.length);
  const endIdx = nextHeadingIdx === -1 ? content.length : nextHeadingIdx;

  const before = content.slice(0, idx);
  const after = content.slice(endIdx);
  const newContent = before + `## ${heading}\n${replacement}\n` + after;
  atomicWrite(filePath, newContent);
  return true;
}

/**
 * Clear the memo file (keep the header only).
 */
export function clearMemo(filePath) {
  ensureDir(filePath);
  writeFileSync(filePath, `# 🧠 Global Memory\n\n> Auto-managed by easy-dsh-memo.\n\n_(cleared)_\n`, 'utf-8');
}

/**
 * Atomically write content to a file (write to .tmp then rename).
 */
function atomicWrite(filePath, content) {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
  renameSync(tmpPath, filePath);
}

/**
 * Summarize a conversation turn into a compact memo entry.
 * Uses heuristics to identify genuinely important information worth saving.
 *
 * Criteria for saving:
 * - User preferences/settings/decisions
 * - Project context, configurations, credentials locations
 * - Important conclusions, action items, architecture decisions
 * - Information explicitly requested to be remembered
 *
 * Criteria for skipping:
 * - Casual greetings, chit-chat
 * - Simple Q&A with no lasting value
 * - Information already obvious from context
 * - Repetitive content
 *
 * @param userMessage - the user's message text
 * @param assistantMessage - the assistant's response text
 * @param sessionLabel - short session identifier
 * @returns {{entry: string, summary: string, importance: number}} or null if nothing worth saving
 */
export function summarizeTurn(userMessage, assistantMessage, sessionLabel) {
  const userText = (userMessage || '').trim();
  const assistantText = (assistantMessage || '').trim();

  if (!userText && !assistantText) return null;

  // Score the importance of this turn
  const importance = scoreImportance(userText, assistantText);

  // Only save if importance is above threshold
  if (importance < 0.3) return null;

  const parts = [];

  // User's question/ask (truncated)
  if (userText) {
    const userShort = userText.slice(0, 200);
    parts.push(`- **User asked**: ${escapeMarkdown(userShort)}`);
  }

  // Extract key points from assistant response
  if (assistantText) {
    const keyPoints = extractKeyPoints(assistantText);
    for (const point of keyPoints.slice(0, 5)) {
      parts.push(`- ${escapeMarkdown(point)}`);
    }
  }

  if (parts.length === 0) return null;

  const entry = parts.join('\n');
  const summary = generateSummary(userText, assistantText);

  return { entry, summary, importance };
}

/**
 * Score the importance of a conversation turn (0-1 scale).
 * Higher score = more worth saving.
 */
function scoreImportance(userText, assistantText) {
  let score = 0;

  // Keywords that indicate important content
  const importantPatterns = [
    // Preferences/settings
    { pattern: /偏好|设置|配置|preference|setting|config/i, weight: 0.4 },
    // Decisions
    { pattern: /决定|决策|选择|decision|choose|select/i, weight: 0.4 },
    // Project context
    { pattern: /项目|架构|部署|project|architecture|deploy/i, weight: 0.3 },
    // Credentials/secrets
    { pattern: /密钥|密码|token|key|secret|credential|auth/i, weight: 0.5 },
    // Action items
    { pattern: /待办|任务|action|todo|task/i, weight: 0.3 },
    // Conclusions
    { pattern: /总结|结论|important|conclusion|summary/i, weight: 0.3 },
    // Remember/save instructions
    { pattern: /记住|保存|remember|save|note this|记住/i, weight: 0.6 },
    // User preferences explicitly stated
    { pattern: /我喜欢|我希望|prefer|want|need/i, weight: 0.3 },
  ];

  for (const { pattern, weight } of importantPatterns) {
    if (pattern.test(userText) || pattern.test(assistantText)) {
      score += weight;
    }
  }

  // Penalize short/casual conversations
  if (userText.length < 10 && assistantText.length < 50) {
    score -= 0.5;
  }

  // Penalize obvious greetings
  const greetingPattern = /^(你好|hello|hi|hey|嗨|早上好|下午好|晚上好|谢谢|thank|好的|ok)[\s!！.。]*$/i;
  if (greetingPattern.test(userText) || greetingPattern.test(assistantText)) {
    score -= 0.5;
  }

  // Penalize very short responses
  if (assistantText.length < 20) {
    score -= 0.2;
  }

  // Cap at 1.0
  return Math.max(0, Math.min(1, score));
}

/**
 * Generate a short summary of what was saved (for user notification).
 */
function generateSummary(userText, assistantText) {
  const summaryParts = [];

  // Extract the core topic from user message
  if (userText) {
    const userShort = userText.slice(0, 60);
    if (userText.length > 60) userShort += '…';
    summaryParts.push(userShort);
  }

  // Add key insight from assistant response
  if (assistantText) {
    const keyPoints = extractKeyPoints(assistantText);
    if (keyPoints.length > 0) {
      summaryParts.push(keyPoints.slice(0, 2).join('; '));
    }
  }

  if (summaryParts.length === 0) return '';
  return summaryParts.join(' | ');
}

/**
 * Extract important bullet points from assistant text.
 * Heuristics: look for headings, bullet points, bold text, code blocks.
 */
function extractKeyPoints(text) {
  const points = [];

  // Look for explicit bullet points / numbered lists
  const bulletMatch = text.match(/[-*]\s+(.{10,200})/g);
  if (bulletMatch) {
    for (const m of bulletMatch.slice(0, 5)) {
      const cleaned = m.replace(/^[-*]\s+/, '').trim();
      if (cleaned.length > 10) points.push(cleaned);
    }
  }

  // Look for markdown headings (##, ###)
  if (points.length < 3) {
    const headingMatch = text.match(/^#+\s+(.{5,100})$/gm);
    if (headingMatch) {
      for (const h of headingMatch.slice(0, 3)) {
        const cleaned = h.replace(/^#+\s+/, '').trim();
        points.push(`**${cleaned}**`);
      }
    }
  }

  // Look for bold text (**...** or __...)
  if (points.length < 3) {
    const boldMatch = text.match(/\*\*(.{5,100})\*\*/g);
    if (boldMatch) {
      for (const b of boldMatch.slice(0, 3)) {
        const cleaned = b.replace(/^\*\*|\*\*$/g, '').trim();
        if (cleaned.length > 5) points.push(cleaned);
      }
    }
  }

  // Fallback: first meaningful sentence
  if (points.length === 0 && assistantText.length > 20) {
    const sentences = assistantText.split(/[.!?。！？]/);
    for (const s of sentences) {
      const cleaned = s.trim();
      if (cleaned.length > 20) {
        points.push(cleaned.slice(0, 150) + (cleaned.length > 150 ? '…' : ''));
        break;
      }
    }
  }

  return points;
}

/**
 * Escape characters that could break markdown formatting.
 */
function escapeMarkdown(text) {
  return text.replace(/\n/g, ' ').replace(/\|/g, '\\|');
}
