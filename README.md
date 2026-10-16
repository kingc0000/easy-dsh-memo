# easy-dsh-memo 🧠

**Global conversation memory for DeepSeek Harness (DSH)**

每轮对话自动提取重要信息，保存到 `$DSH_HOME/memo.md`（默认 `~/.dsh/memo.md`）作为全局记忆，供 Agent 用 `memo_read` 按需读取历史上下文——通过精简摘要机制，避免把无关历史全量带入 LLM 上下文。

## 功能特性

| 特性 | 说明 |
|---|---|
| 🔄 **自动保存** | 每轮对话结束后自动提取关键信息追加到 memo.md（最新在前，按 `###` 流水条目） |
| 🛠 **5 个记忆工具** | `memo_save` / `memo_read` / `memo_edit` / `memo_clear` / `memo_recent` |
| 📖 **memo_read 精简模式** | 默认只返回关键约束 + 用户偏好 + 最近 5 条流水（约 3KB），可按 `section=` / `query=` 定向读取，`full=true` 才取全文 |
| 💾 **零额外 token 开销** | 提取基于规则（标题/加粗/列表），不调用 LLM API |
| 🔒 **原子写入** | 追加使用临时文件 + rename，防止写坏 |
| 🚫 **不自动注入** | 无注入逻辑（原"首轮自动注入"占位实现已作为死代码移除），记忆到达模型走 `memo_read` |
| 🧩 **可与静态分类共存** | 自动保存的流水插在 `# 🧠 Global Memory` 头部之下，文件尾部的静态章节（约束/Facts/Projects/Lessons/Preferences 等）不受影响 |
| ⚙️ **日志落盘** | 插件日志写入 `$DSH_HOME/logs/easy-dsh-memo.log`，便于排查 |
| 🧪 **可隔离测试** | 通过 `MEMO_FILE` 环境变量或 `memoPath` 配置指向临时文件，不影响真实记忆 |

## 安装

```bash
# 方式 1: 从本地目录安装
dsh plugin add /path/to/easy-dsh-memo

# 方式 2: 从源码目录安装（推荐, 文件链接实时同步修改）
cd ~/.dsh/profiles/<profile>
dsh plugin add /path/to/easy-dsh-memo
```

> DSH 的 `plugin add` 使用 pnpm file-link：源码目录与 profile 中安装的副本共享同一 inode，改源码即时生效，无需重装。

## 配置

在 `cordis.patch.yml` 中配置：

```yaml
- id: easy-dsh-memo
  config:
    memoPath: ~/.dsh/memo.md     # 自定义记忆文件路径（默认 $DSH_HOME/memo.md）
    autoSave: true               # 每轮对话自动保存摘要（默认 true）
    logFile: ~/.dsh/logs/easy-dsh-memo.log   # 日志文件路径（默认 memo 同目录 logs/）
```

## 可用工具

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `memo_save` | 保存重要信息到全局记忆 | `content`(必填), `label`(可选会话标签) |
| `memo_read` | 读取记忆（默认精简摘要） | `query`(关键词召回), `section`(单个分类), `full`(完整文件) |
| `memo_edit` | 编辑记忆的某个章节 | `heading`(章节标题), `content`(新内容) |
| `memo_clear` | 清除所有记忆（需二次确认） | `confirm: "clear"` |
| `memo_recent` | 查看最近自动保存的条目 | `count`(默认 5, 最大 20) |

### `memo_save`

```json
{
  "content": "- 用户偏好使用中文回复\n- 项目部署在阿里云 ECS",
  "label": "用户偏好"
}
```

### `memo_read`（精简摘要优先）

默认返回 digest（关键约束 + 用户偏好 + 最近 5 条流水），**约 3KB 而非全文 20KB**，降低无关上下文占用：

```json
{}                                // 精简摘要(默认)
{ "section": "lessons" }          // 只读 Lessons 分类
{ "query": "usageLimit" }         // 只返回含该关键词的条目
{ "full": true }                  // 完整文件(仅在确实需要时用)
```

`section` 可选值：`约束` / `facts` / `projects` / `lessons` / `preferences` / `历史` / `流水`。

### `memo_edit`

```json
{
  "heading": "2026-10-15",
  "content": "- 更新了用户偏好\n- 新增项目配置"
}
```

### `memo_clear`

```json
{ "confirm": "clear" }
```

### `memo_recent`

```json
{ "count": 8 }
```

## 记忆文件格式

`memo.md` 由两部分组成：

1. **自动保存的对话流水**（插件管理，插在 `# 🧠 Global Memory` 头部之下，新条目在上）
2. **静态分类章节**（手工维护或由外部 `memo` 命令管理，位于文件尾部，流水追加不触碰）

```markdown
# 🧠 Global Memory

> Auto-managed by easy-dsh-memo. Last updated: 2026-10-16T02:00:00.000Z

## 2026-10-16
### 02:33 - Session feishu-xxx
- **User asked**: 如何配置多 key 轮询代理
- 使用 round-robin 策略轮询多个 API key, 429 自动切换重试
...
<!-- 以下为 easy-dsh-memo 自动保存的对话流水(新条目在上) -->

# 📌 关键约束（机器必读）
- ...
```

## 工作原理

```
用户消息 → Agent 回复 → [auto-save] 提取关键信息 → 追加到 memo.md(流水区头部)
                               ↑
Agent 主动调用 memo_read(精简) → 只带必要上下文 → 按需扩展 section/query/full
```

上下文策略：**默认不向 LLM 注入全量记忆**。Agent 通过 `memo_read` 按需读取（先拿精简摘要，再按 section/query 定向扩展），避免"一股脑把无关信息传给 LLM"。

## 与 dsh 配合使用

在 profile（如 feishu）中，插件会自动：

1. 每轮对话结束后保存摘要到 memo.md（最新在前）
2. Agent 可通过 memo 工具主动读取/写入/管理记忆

```bash
# 添加到 feishu profile
cd ~/.dsh/profiles/feishu
dsh plugin add /path/to/easy-dsh-memo

# 重启 dsh 服务生效
systemctl restart dsh-feishu
```

## 注意事项

- **自动保存是启发式的**：提取基于规则（Markdown 标题、加粗文本、列表项），不依赖 LLM，零额外 token 开销；对不包含可提取内容的消息会跳过或给出兜底摘要
- **日志**：默认写入 memo 同目录 `logs/easy-dsh-memo.log`，可用 `logFile` 覆盖
- **不自动注入**：插件不含注入逻辑。此前有一个"新会话首轮注入"占位实现（只打日志、从未真正改写消息），已于 2026-10-16 作为死代码整体移除（`autoInject` / `injectAsSystem` 配置项一并删除）；记忆到达模型的正路是 `memo_read` 工具
- **需要首轮自动注入怎么办**：走 dsh 原生机制 `dsh-agent-instructions`（dsh-base 默认启用），它会在新会话首轮加载 `$DSH_HOME/AGENTS.md`（默认预算 65KB）；把要常驻的内容写进该文件即可，本插件不会写它
- **记忆文件手动可编辑**：memo.md 是普通 Markdown；自动保存只动流水区，静态章节不会被覆盖
- **测试隔离**：设置 `MEMO_FILE=/tmp/test-memo.md` 或 `memoPath` 指向临时文件后可安全实验

## 许可证

MIT