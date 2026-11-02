Agent 观测台是一台主机上所有 Paseo Agent 和子 Agent 的看板。每个会话打开后显示它的结果、时间线、子任务、诊断和执行复盘。它还提供：侧栏上「需要处理」的数量，每个 Agent 附一句原因；就地审批和快捷回复；未读队列；用量统计；来自本机 Claude Code、Codex、Grok CLI、Pi、Kimi Code 和 ZCode 日志的 Token 统计；每一次定时运行；以及可选的智能分析和每轮小结。可选的提醒：提示音、标出需要处理的工作区标签、提示缓存倒计时和定时发送。

它增加了侧栏页面「Agent 观测台」「已归档会话」「定时运行」、工作区面板和 Agent 面板、「命令中心」条目，以及 `/observe`。App 连接时只拿到一小段桩代码；其余部分在第一次打开时才加载。

## 准备工作

需要 Paseo 0.11.1 或更高版本。智能分析和每轮小结需要 Grok CLI（已在 daemon 所在的主机上登录）或一个已启用的 Paseo Provider。

## 语言

内置英文和简体中文。使用设备的语言，除非在「设置 → 插件 → Agent 观测台 → 语言」里选定了一种；缺少的翻译用英文补上。在 `~/.paseo/plugin-data/agent-observatory/locales/` 里放一份翻译好的模板副本，即可增加一种语言。智能分析和每轮小结用所选语言回答。

## 读取的数据

- 从 daemon 读取：Agent 事件、提醒通知、Agent 列表（含已归档的）、你打开的 Agent 待审批的权限请求、Profile 和 Provider、额度窗口（`providers.listUsage()`，只在显示时读取），以及你打开的会话的时间线。在后台只读取已加载的 Agent。
- Token 日志：`$CLAUDE_CONFIG_DIR/projects`（默认 `~/.claude/projects`）、`~/.config/claude/projects`、`$CODEX_HOME/sessions` 和 `archived_sessions`（默认 `~/.codex`）、每个 Grok CLI 会话的 `usage.json`（只读这一个文件），以及 Pi 的会话（默认 `~/.pi/agent/sessions`）；Kimi Code 的 `$KIMI_CODE_HOME/sessions`（默认 `~/.kimi-code/sessions`）及 ZCode 的 `$ZCODE_HOME/cli/db`（默认 `~/.zcode/cli/db`，只读 SQLite 和 WAL）。不跟随符号链接；用 `v2/acp-lazy-sessions.json` 关联 ZCode 的 ACP 会话。只保存计数、模型名、工作目录和会话 ID，从不保存提示词或输出。
- 基于它们的自定义 Provider：Provider 的 `env`、命令行或启动脚本（按文本读取，最多 64 KB，从不执行）里字面写出的 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`、`KIMI_CODE_HOME`、`ZCODE_HOME`、`PI_CODING_AGENT_SESSION_DIR` 或 `PI_CODING_AGENT_DIR`，以及 Pi 的 `sessionDir` 设置。
- 为确认续跑，会在这个 Agent 自己的 Claude Code、Codex 或 Pi 会话日志里查找这次运行的编号（只比对，不保存）。缓存倒计时从基于 Claude 的会话自己的日志里读取最后一次缓存写入和 TTL。
- 定时运行：`$PASEO_HOME/schedules/*.json`、`projects/workspaces.json`，以及 daemon 不再列出的 Agent 的记录。从不写入这些文件。
- daemon 配置里的 Provider 列表，用来判断哪些 Provider 能在一轮进行中接收消息、哪些共用同一份额度。

插件自己不发出任何网络请求。

## 写入的数据

所有内容都写到 `$PASEO_HOME/plugin-data/agent-observatory`（目录 0700；文件 0600，有大小上限，原子替换）：遥测、统计、Token 计数、额度历史、已读回执、偏好设置、分析设置、报告和建议、每轮小结、定时运行账本和续跑账本、设备的时区名、发送账本（在路上的消息，定时发送的连同定时时刻，之后保留一周的简短预览）、它自己的工作区标签和置顶，以及语言状态和翻译模板。

定时运行账本保存运行时间、状态、ID、宿主报错（最多 300 个字符）、去掉凭据的链接、定时任务名称和计划，从不保存回复或提示词。额度历史中的账号名经过哈希处理。遥测记录一轮停下的原因，从不保存回复。报告和小结可能引用会话内容。

## 操作

插件只在你要求时才在 daemon 上执行操作：

- 把结果、提问或错误标为已读；归档 Agent（批量归档要再点一次）；恢复工作区或已归档的会话；
- 用 Provider 自己的选项答复单条权限请求，从不批量或自动答复；
- 向 Agent 发送快捷回复（按钮上的那句话）、AI 建议或智能分析的发现：支持时插进正在运行的这一轮，否则在你确认中断后发出，或者排队等这一轮结束；重试最多送达一次；
- 在你确认的时间安排一次性心跳，在 Agent 的额度重置后让它续跑；无法证明已送达时从不重发，并且只删除插件自己的续跑心跳；
- 把停下的 Agent 交给另一个 Profile，或者按一条建议新建 Agent；
- 在你选定的时间发出定时消息；
- 打开「侧栏标签」时（默认关闭），添加和移除它自己的工作区标签和置顶。

其中一些操作用到插件 API 没有的 daemon 消息，经由插件自己的 daemon 连接发出。插件可以打开 http(s) 链接。

## 智能分析与每轮小结

你发起之前不会分析任何内容；自动分析默认关闭。一次分析会把一段有上限的会话摘录（提示词、回复、工具调用和输出；最多 180 条，约 120,000 个字符）连同项目和 Agent 的元数据发给所选模型。常见格式的凭据会被遮蔽，但遮蔽并不穷尽。「建议」也以同样方式发送最近报告的摘要。

- Grok CLI：`grok` 在一个新建的临时目录里运行，去掉全部内置工具，拒绝工具调用，关闭联网搜索、记忆和会话搜索，也不带其他 Provider 的密钥；摘录经由一个临时文件传给它。结束后删除这个目录、它保存的会话和会话搜索记录。这是插件启动的唯一子进程。
- Paseo 的 Profile 或 Provider：作为被分析 Agent 的临时子 Agent 在它的工作区里运行，使用只读模式或 Claude Code 的 Always Ask，审批请求会被拒绝，但不需要审批的操作（读取文件）仍会执行，且不经遮蔽。结束后它会被归档；它的对话留在宿主和该 Provider 的日志里，并消耗该 Provider 的额度。
- 「自动选择」（默认）在找得到 Grok CLI 时使用它，否则使用一个已启用的 Claude Code 或 Codex Provider。

每轮小结也默认关闭。开启后，顶层 Agent 的一轮结束 10 秒后，执行器（默认是 Grok CLI，low 推理档）拿到这一轮和之前最多 8 轮的消息（不含工具输出，已遮蔽，最多 32 KB），写出一行目标、进展和下一步，还可以附带一条点一下就能发出的建议回复。关闭每轮小结会删除已有的小结。

## 限制

- 导入和扫描都有上限（例如 20,000 个 Token 日志）。

「定时运行」页面仿照 panrafal 的 schedule-runs 插件设计。
