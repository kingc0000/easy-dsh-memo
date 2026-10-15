# easy-dsh-memo 🧠

**Global conversation memory for DeepSeek Harness (DSH)**

每轮对话自动提取重要信息，保存到 `~/.dsh/memo.md` 作为全局记忆，让每个新对话都能继承历史上下文。

## 功能特性

| 特性 | 说明 |
|---|---|
| 🔄 **自动保存** | 每轮对话结束后，自动提取关键信息追加到 memo.md（最新在前） |
| 🛠 **工具调用** | Agent 可主动调用 `memo_save`/`memo_read`/`memo_edit`/`memo_clear` |
| 💉 **自动注入** | 新会话首轮自动加载 memo.md 内容作为历史记忆 |
| 💾 **零额外开销** | 纯文件系统操作，不调用 LLM API，不增加 token 消耗 |
| 🔒 **原子写入** | 写入 memo.md 使用临时文件 + rename，防止写坏 |

## 安装

```bash
# 方式 1: 从本地目录安装
dsh plugin add /path/to/easy-dsh-memo

# 方式 2: 从源码目录安装（当前工作区）
cd ~/.dsh/profiles/feishu
dsh plugin add /root/dsh/easy-dsh-memo
```

## 配置

在 `cordis.patch.yml` 中配置：

```yaml
- id: easy-dsh-memo
  config:
    memoPath: ~/.dsh/memo.md      # 自定义记忆文件路径（默认 ~/.dsh/memo.md）
    autoSave: true                 # 每轮对话自动保存摘要
    autoInject: true               # 新会话首轮自动注入记忆
    injectAsSystem: true           # 注入方式（预留）
```

## 可用工具

### `memo_save`
保存重要信息到全局记忆。

```json
{
  "content": "- 用户偏好使用中文回复\n- 项目部署在阿里云 ECS",
  "label": "用户偏好"
}
```

### `memo_read`
读取全局记忆全文。适合在新对话开始时调用。

### `memo_edit`
编辑记忆的某个章节。

```json
{
  "heading": "2026-10-15",
  "content": "- 更新了用户偏好\n- 新增项目配置"
}
```

### `memo_clear`
清除所有记忆（需二次确认）。

```json
{
  "confirm": "clear"
}
```

## 记忆文件格式

`~/.dsh/memo.md` 采用结构化 Markdown 格式：

```markdown
# 🧠 Global Memory

> Auto-managed by easy-dsh-memo. Last updated: 2026-10-15T19:30:00.000Z

## 2026-10-15
### 19:30 - Session feishu-xxx
- **User asked**: 如何配置多 key 轮询代理
- 配置位于 /etc/sensenova-proxy/config.json
- 使用 round-robin 策略轮询多个 API key
- 429 错误自动切换下一个 key 重试

## 2026-10-14
### 22:15 - Session web-xxx
- **User asked**: 如何优化 token 成本
- 使用极简模式降低 token 消耗
...
```

## 工作原理

```
用户消息 → Agent 回复 → [auto-save] 提取关键信息 → 追加到 memo.md
                              ↑
新会话启动 → [auto-inject] 加载 memo.md → 注入到对话上下文
                              ↑
Agent 主动调用 memo_read → 返回完整记忆内容
```

## 与 dsh-feishu 配合使用

在 feishu profile 中，插件会自动：
1. 每轮飞书对话结束后，保存摘要到 memo.md
2. 新飞书会话开始时，注入历史记忆
3. Agent 可以主动调用 memo 工具管理记忆

```bash
# 添加到 feishu profile
cd ~/.dsh/profiles/feishu
dsh plugin add /root/dsh/easy-dsh-memo

# 重启 dsh 服务生效
systemctl restart dsh-feishu
```

## 注意事项

- **自动保存是启发式的**：提取逻辑基于规则（Markdown 标题、加粗文本、列表项），不依赖 LLM，零额外 token 开销
- **记忆文件手动可编辑**：memo.md 是普通 Markdown 文件，可以直接编辑，但自动保存的格式可能会覆盖手动修改
- **会话追踪内存**：自动注入使用了内存 Set 追踪已注入会话，dsh 重启后清空

## 许可证

MIT
