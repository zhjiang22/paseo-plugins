# 变更记录

## 0.12.3 · 2026-11-22

适配 Paseo 0.17（0.16 及更早照常可用）：不用改代码。界面懒加载块用 Paseo 0.15 起的编译器重建：以前是 0.14 的编译器生成的，内容等价，只有压缩后的写法不同，块的新鲜度检查因此一直报过期。在隔离的 Paseo 0.17.3 和 0.16.0 daemon 上加载、跑脚本回合并打开网页端（桌面和手机），没有错误。

## 0.12.2 · 2026-11-16

适配 Paseo 0.16 的插件 SDK（0.15 及更早照常可用）：RPC 处理器按 0.16 的 `handle` 类型写，测试按 0.16 的类型补字段；运行时行为不变。在隔离的 Paseo 0.16.0 和 0.15.4 daemon 上加载、跑脚本回合并打开网页端，没有错误。

## 0.12.1 · 2026-10-25

适配 Paseo 0.13（0.12 照常可用）：
- 手机端不再注册 Explorer 位置：0.13 的手机 Explorer 也能放插件标签，但关掉的 Explorer 在原生端仍然挂载，看板会在看不见时继续轮询。网页和桌面不变。
- 共享发送账本（kit）：Paseo 0.13 里请求发出后连接中断，按「结果不明」保留待确认（取消或过期记为「可能已送达」），不再当作发送失败重试；连接断开时的失败照常说「和宿主的连接断了」，不显示宿主的英文原文。
- 动效浮层（kit motion）改为写明的绝对定位：Paseo 0.13 的手机 App 升到 React Native 0.86，删掉了 `StyleSheet.absoluteFillObject`，原来的写法在手机上会让 Ping / Flash 浮层失去定位、把排版顶开。
- 插件市场中文介绍（Paseo 0.13）：公开版清单带 `translations.zh-CN`（中文名称和简介），并附 `OVERVIEW.zh-CN.md` 中文介绍页；旧版 daemon 忽略这个字段，安装和运行不受影响。
- 在隔离的 Paseo 0.13.0 和 0.12.0 daemon 上加载全部插件、跑同一组脚本回合并打开网页端：插件全部运行，网页端没有页面错误和插件报错。

## 0.12.0 · 2026-10-15

- **一键发送**：提示词详情新增「一键发送」开关。打开后这条提示词以短标签胶囊出现在每个 Agent 的输入框上方，排在「提示词」胶囊之后；最多 12 条，超过 3 条时收进一个「一键 N」菜单胶囊，菜单末尾可进入管理。用单独的开关而不复用「置顶」：置顶只决定看板里的排序，一键发送是跨项目、跨设备共用的一份有序列表。
- 点按即发，但不会一点就打断：Agent 空闲、未载入，或正在运行但能插话（按宿主报告的能力判断，自定义 provider 也一样）时直接发出；正在运行又不能插话时，胶囊变成菜单「等这一轮结束再发」/「中断并发送」，有待审批时是「等审批处理完再发」/「仍然发送」。发送交给插件服务端的发送账本：服务端拿到这个 Agent 的发送锁后按当时的状态再判断一次，Agent 刚变忙就不发，提示再点一次选择；同一条提示词同一时间只有一份在路上，与「提示词」胶囊、其他设备共用记录。结果用提示条告知；没收到回复时提示「没有确认发送结果」并请你先核对队列或会话，同一次连接内再点一次沿用原来的消息编号，不会发两份。
- 含 `{{变量}}` 的提示词不能一键发出：点胶囊打开原有的填写表单，填好后照常发送。
- 列表存为宿主设置 `quick-prompts`（`$PASEO_HOME/plugin-settings/project-notes/quick-prompts.json`，0600），每条记手记编号、所属项目、标题副本、是否含变量、是否隐藏和手记版本。任何设备改动后宿主推送设置变更事件，其他设备的胶囊随即更新，不轮询。胶囊逐位更新：位置和编号没变的原地更新，只从第一处变化起重新注册，不闪烁（改编自 kingsleydon/paseo-plugins 的 quick-prompts，MIT，见 NOTICE）。
- 「提示词」页顶部新增一键发送条，显示输入框上方的样子；「管理」里可上移、下移、移除，并标出已删除、在回收站和含变量的条目。手记改了标题、加了变量或移进回收站，打开看板时同步到列表（回收站里的不显示胶囊，恢复后回来）；彻底删除和清空回收站时一并移除。
- **任务卡实时状态**：从任务「开始处理」启动的 Agent，状态显示在卡片上：运行中（蓝，动画）、等你处理（琥珀，审批或提问）、完成未读（绿）、出错（红）、空闲（灰），附子 Agent 数和最近活动时间，点一下打开该 Agent。详情新增「启动记录」，列出这条任务的全部启动及各自状态；已归档或已删除的 Agent 显示「已结束」，不报错。思路参考 fxbing/workboard 与 casonmo/tapd-workbench，未用其代码。
- 状态只来自 Paseo 的 Agent 目录订阅（原本就为输入框胶囊开着，现在胶囊与看板共用一份）和插件自己的启动记录，从不读会话记录，不会唤醒未载入的 Agent；看板只在前台可见时跟随目录变化，有启动未完成时每 4 秒查一次启动记录。启动记录新增 `itemId`、`sourceProjectId`、`createdAt`；0.12.0 之前启动的 Agent 按已有的手记标签照常显示；已归档的旧 Agent 只在详情里列出，没建成 Agent 的旧启动不显示。
- 手机和 1024 px 以下的窗口里，一键提示词一律收进一个「一键 N」菜单胶囊（英文界面只显示数字），不再把各插件胶囊的标签挤成一个字；窗口变宽（旋转、调整大小）时就地展开成单独胶囊，最多 3 个。菜单里含 `{{变量}}` 的提示词改为在提示词库页打开填写表单，以前点了没反应。
  On phones and windows narrower than 1024 px, one-tap prompts always fold into one “One-tap” menu pill (just the count in English), so the other plugins' pills keep their labels; a wider window unfolds them in place, up to three. A prompt with `{{variables}}` in that menu now opens its fill form on the prompts screen instead of doing nothing.
- 新 RPC `project-notes.quick.send`、`project-notes.quick.note`、`project-notes.launches`（按 revision，没变化只回 `unchanged`）。
- 常驻代码只留胶囊注册和读一键列表。一键发送的发送部分、发送账本合约和 `/notes <文字>` 用的看板结构放进新的懒加载分片 `quick`（约 13.5 KB，一次请求），第一次点按胶囊或用 `/notes` 记录时才下载，同一次连接只下载一次；加载期间宿主让胶囊转圈并禁用它和它的菜单，同一条提示词再点只并入这一次，不会发两份；确认菜单本身由宿主即时显示。原先常驻的发送账本合约（约 5 KB）和看板结构（约 5.7 KB）一并移出，常驻代码从 0.11.1 的 48.4 KB 变为 54.3 KB，集合的常驻预算调到 56 KiB。

## 0.11.1 · 2026-10-15

- 连上时不再下载完整语言目录（约 36 KB）：只取几百字节的启动文字（按所选语言），打开手记界面时再下载。网页和桌面端有缓存时照旧立即显示。

## 0.11.0 · 2026-10-15

- Languages：内置英文和简体中文，默认跟随系统；新增 Settings → Plugins → Project Notes → Language，切换后打开的看板、提示词、编辑器和启动界面即时更新。
- 用户翻译位于 `~/.paseo/plugin-data/project-notes/locales/`，从 `templates/en.json` 或 `templates/zh-CN.json` 复制，以语言代码命名，设置 `$meta.name` 并保留占位符；复数必须有 `other`。设置显示覆盖率和问题，缺失或无效条目回退英文。
- 服务端消息与 CLI 使用相同语言；CLI 读取 `i18n-state.json` 中的固定设置或最近设备语言，原有手记和历史正文不翻译。
- 新内置语言可通过 PR 添加 `shared/locales/<code>.json` 并在 `server/locales.ts` 注册。重建延迟界面包，保留首屏常驻体积预算。


## 0.10.4 · 2026-10-14

- 从 Git 安装（市场安装同样如此）时，宿主只装生产依赖，客户端代码里对 `@getpaseo/client` 的类型导入解析不到，0.10.3 安装失败。现在这些类型经插件 SDK 的 `PluginClientContext` 推导（`client/paseo-types.ts`），行为不变；集合脚本新增检查，公开插件的客户端代码只导入生产依赖里的 Paseo 包。

## 0.10.3 · 2026-10-14

- 发送账本（各插件共用）：读不了的账本另存的备份最多留 3 份、一周，写到一半中断留下的临时文件在下次启动时删除；日志只写错误类型，不再引用账本内容（JSON 解析错误会带出出错位置附近的文字，可能是提示词）。发送锁目录收紧为 0700，锁文件先建成 0600 再交给 SQLite。
- 文档写明：「发送给当前 Agent」也会先把提示词全文写进发送账本，发完留 160 字预览一周；启动记录保存的字段（含启动参数的哈希和 500 字以内的错误）；命令行参数对这台主机上的其他账号可见，正文请用 `--body-file -`。

## 0.10.2 · 2026-10-14

- 项目看板、提示词库和提示词弹层改为首次打开时按需下载；侧栏、面板、斜杠命令、附件来源与提示词按钮继续直接注册。关闭后重开复用已加载界面，减少手机连接时的常驻下载量。

## 0.10.1 · 2026-10-12

- 手机端：共用发送账本文件里顶层的 `key` 改名为 `sendKey`。原名会让 esbuild 改掉 Paseo Hermes 兼容补丁要匹配的变量名，补丁失效后手机 App 上的具名导入会串值；全插件 Hermes 守卫现在会拦下这种情况。
- 手机端：清空回收站时逐个项目更新确认框，改为把项目编号当参数传给状态更新（Hermes 没有块级作用域，循环里排队的更新以前可能读到下一个项目）。
- 新增「等这一轮结束再发」：发送提示词会打断不支持插话的回合、或会取消待审批时，确认条有三个选择：「中断并发送」（有审批时是「仍然发送」）、「等这一轮结束再发」（有审批时是「等审批处理完再发」）、「取消发送」。选等待后，提示词存进插件服务端的队列，Agent 这一轮结束、没有待审批时自动发出，App 关着也照发。以前只能打断，或者自己记着回头再发。
- 排队用新的消息 ID，不复用直接发送的 ID；已经直接发过一次的提示词不再提供排队，避免同一条发两次。排好后操作区的按钮变成「已排队」，不能再直接发送。
- 选择器里列出这个 Agent 排队的提示词，按提示词标题命名：排队中（琥珀色）可「取消排队」；排队后会话里出现了别人的消息就停下，标「待确认」（橙色），可「仍然发送」或「取消排队」；已送达（绿色）、可能已送达、未发送、已过期显示一阵后消失。只有还有提示词在等、App 在前台时每 5 秒刷新一次。
- 新 RPC `project-notes.deferred.enqueue / list / cancel / resume`，队列文件在 `$PASEO_HOME/plugin-data/project-notes/deferred-send.json`。插件的每个 RPC 都会把 daemon API 交给队列，重载后第一次调用就恢复投递。发送能力查询多返回 `bases`，自定义 Provider id 的斜杠提示词按内置基类判断会不会打断。
- 队列和每个 Agent 一把的发送锁来自各插件共用的 kit，两个插件不会抢同一个空闲时机。
- 复查修复：同一条提示词同一时间只有一个投递，选择器按服务端记录锁住「发送给当前 Agent」和再次排队，重新选择、重开选择器后照样认得。排队行加上呼吸和送达闪动。去掉「另一插件先投递会让这里待确认」的过时说明（kit 已在锁文件里共享各插件发出的消息 ID）。
- 「发送给当前 Agent」也交给插件服务端（新 RPC `project-notes.deferred.send`）。服务端拿到这个 Agent 的发送锁后按当时的状态再判断一次：要打断回合或取消审批，而你同意的不是这些（比如确认之后又有了新审批），就不发送，选择器重新给出三个选择；同意后用同一个消息 ID 再发。以前客户端自己发，确认时看到的状态可能已经过时。
  - 同一个 Agent 的同一条提示词同一时间只有一条在路上（排队中、发送中、待确认），由服务端按提示词的键判断：两台设备同时发送只发出一次，另一台显示这一条。键和以前排队 ID 里的键相同，升级前排着的提示词照样认得。
  - 新状态「发送中」：20 秒内没等到 Agent 开始这一轮，先显示「发送中」，结果出来后变成「已送达」或「待确认」。
  - 没收到发送结果时（插件重载、进程退出），这条停在「待确认」。服务端每分钟去会话记录里找一次，找到了就标「已送达（在会话记录里找到了这条消息）」；「仍然发送」也先查会话记录，没有、且上次发送已过两分钟才重发。
  - 选择器不再自己判断能不能重发、能不能排队，都以服务端记录为准；只记着没收到回复的那次用的消息 ID（见下一条）。
- 第三轮复查修复：
  - 同意只对当时那一轮有效：确认「中断并发送」时把 Agent 正在跑的这一轮（轮次 ID 和开始时间）一起交给服务端；那一轮结束、又开始新的一轮后，旧的同意不能打断新的一轮，服务端重新问。Agent 没换轮次时只确认一次。
  - 没收到回复时按原 ID 再试：发送或排队的回复丢了、列表也读不到时，再点一次（发送或等待都一样，重新打开选择器也一样）沿用那次的消息 ID，服务端答复那条消息的结果，不会再发一份；收到答复或列表里出现这条之后，下次才用新 ID。
- 第四轮复查修复：
  - 「等这一轮结束再发」的回复丢了之后，选择器上还留着的「中断并发送」确认改按那次排队的消息 ID 去问服务端，不再用确认框自己的编号另发一份。
  - 发送的回复丢了、随后列表读到这条已送达：当前预览直接标为「提示词已发送」，清掉「没有收到发送结果」的提示，之后不会再用新编号重发。这条还在路上时，选择器照旧锁住，每次再试仍按原编号去问。
- 复核修复：排队后又改了变量，旧消息送达时不再把当前预览标成「已发送」。送达只结算它当时带的那份正文，结果只显示在队列行里。

## 0.10.0 · 2026-10-12

- 修改历史独立保存，旧看板自动无损迁移；总览、增量和命令行默认只带当前内容，历史按需读取。只改状态、重点或置顶不再占用历史版本。看板读取兼容版本 1、2，迁移和后续写入一律写版本 2；已提交的版本键同时保存在旁路，主文件缺键不再导致历史消失或被淘汰。
- **升级后不能直接回滚到 0.9.0**：旧版会拒绝读写版本 2，防止悄悄剥除历史引用。目录安装升级后须重新构建 CLI；`list`、`show` 等读取也可能触发迁移写入。
- 回收站增加彻底删除和清空，接近体积上限时仍可清理；恢复和不增大文件的更新不再被预留空间阻挡，清空确认明确包含搜索未显示的条目。本地写入后继续增量同步，避免反复下载全部看板。
- 只恢复主看板而缺少快照时，详情显示缺失情况，可显式确认「放弃缺失的快照并继续」；保留正文和现存快照，解除正文编辑阻塞。备份仍需包含 `boards/history/`。目录同步兼容 Windows 上不支持目录 fsync 的权限错误。
- 提示词支持发送到未载入会话，网络重试复用原消息标识与发送方式，待审批确认绑定具体请求；卸载时释放全部界面注册。
- 网页和 Mac 桌面胶囊可填入输入框、追加或替换并撤销；提示词编辑器可根据项目语言和已有测试命令生成目标、范围、约束、验收四段模板。
- 启动找回按目标项目分页列出工作区并核对 worktree 标识，覆盖准备中、创建中和无标识的不确定状态；找到工作区后禁用修改选项重试，只有明确创建前拒绝时可另开一次。停机等待在途阶段保存。
- 创建工作区不传 `firstAgentContext`，保留用户标题及 `notes/<id>` 分支，避免额外自动命名调用。发送正文以用户编辑后的「初始任务」为准；来源附件仅含项目、状态、重点、手记编号和标题，不再携带原正文。

## 0.9.0 — 2026-10-12

- 提示词库接入输入框胶囊、`/prompt`、附件源和 `{{变量}}` 填参预览；选择条目不发送，显式发送使用共用发送计划与中断确认。`/notes <文字>` 可快速存为随手记。
- 每条手记保留最近 10 版修改快照，可预览并恢复为新版本；旧数据继续兼容。
- CLI 根据 Paseo workspace 的项目记录识别外置 worktree、子目录和符号链接；修改、完成、删除和恢复支持相同请求 ID 重放。
- 启动连接失败后可重试同一请求，避免锁死；其他设备更新手记时保护本地启动草稿，由用户决定载入。未确定结果可按标签找回 Agent，初始任务携带来源手记 ID。
- 同步区分完整快照和增量，正确处理磁盘备份恢复和看板移除，并保护本地写入免受在途旧响应覆盖。
- 大看板使用虚拟列表、正文索引缓存、短防抖与有界摘要，降低手机输入和滚动负担。
- 迁移至 `addScreen`，保留旧宿主运行时回退；使用中文标题、可访问状态及按需查询。版本升至 0.9.0，增加启动恢复、多设备、CLI、快照、同步和提示词交互回归测试。

## 0.8.1 — 2026-10-10

Security hardening after two external reviews of the published 0.8.0. Notes, the board file format and the interface stay the same, and lock files written by 0.8.0 are still understood.

- Board lock: a waiting writer now takes over a lock only when the process holding it has exited (on Linux a reused pid counts as exited, by the process start time), or after a minute when the holder cannot be checked from here (unreadable lock, another host or PID namespace). 0.8.0 removed any lock older than 30 seconds, even a live holder's. Each lock carries a random token: a writer removes only its own lock and checks it still holds the lock right before committing, and a `.reclaim` guard file lets only one of several waiters take over a stale lock. Before, two writers could hold a board at once and the later write silently replaced the earlier one.
- Overview size limits: a board file over 32 MiB, or the boards that would push one overview reply past 32 MiB in total (filled smallest first), are left out and named. The app shows a notice, marks those projects 不可用 in the project list and explains instead of showing an empty project; every other project loads as usual. Before, one oversized board, or two large boards together, made the whole overview fail. The total stays at 32 MiB because the reply is one WebSocket message: over the relay it grows by a third, and the host drops an app whose outbound queue would pass 64 MiB. In the CLI, `list` without `--project` does the same and reports what it skipped (`unavailable` in `--json`); a board left out only for the total still reads with `--project`.
- CLI input limits: `--body-file` reads only regular files and refuses, from `stat` and before reading, files over 96,000 bytes, the most a 32,000-character body can take in UTF-8. Directories, FIFOs and devices such as `/dev/zero` are refused without being opened. Standard input (`-`, and now `/dev/stdin`) stops at the same limit, and the `projects.json` fallback at 8 MiB, the limit already applied to `paseo project ls`. There is still no path allow-list: the CLI runs in the agent's own shell, which can read those files anyway.
- CLI output: human-readable output shows control characters from notes, project names and paths (ESC sequences such as OSC 52, CR, backspace, C1 controls) escaped as `\xNN`, keeping newlines and tabs; error messages too. `--json` output is unchanged. Times print in UTC and say so.
- Start dialog: provider errors and launch failures sent to the app are cut to 500 characters, including those in journals written before.
- The inbox has one description, 暂不归入项目的想法, in the projects RPC, the overview and the CLI, which used three wordings.
- Development: the fixture preview server answers a malformed request such as `GET //` with 400 and a missing build with 500 instead of exiting, and `PROJECT_NOTES_PREVIEW_PORT` sets its port (default 4693) for both the server and the Playwright config.
- Tests: lock liveness, pid reuse, unknown holders, a deterministic two-writer interleaving that lost an update on 0.8.0, a refused commit after the lock was taken over, CLI processes recovering a crashed writer's lock, overview degradation in the store, dashboard, client merge and UI, CLI input limits, escaping, UTC times and capped errors. A cache test that assumed ctime changes within one kernel clock tick now waits for the tick (it failed about 1 run in 7 before).

## 0.8.0 — 2026-10-09

开源整理：可以单独公开，并提交到 Paseo 插件市场。界面、功能和数据格式不变，已有手记照常读取。

- 需要 Paseo 0.11.1 或更新版本（原为 0.9.0）：manifest 新增英文显示名 `Project Notes`、描述、图标和截图，这些字段要求 0.11 及以上；开发依赖 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 固定为 0.11.1。
- Git 安装更轻：准备步骤改为 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，只按锁文件安装生成命令行工具所需的 esbuild 和 zod（约 20 MB，原来要装全部约 270 个开发依赖、约 350 MB），再由 `npm run build` 生成 `bin/notes.mjs`。为此看板数据结构从 `shared/board.ts` 拆到 `shared/schema.ts`，命令行工具不再引用 Paseo SDK；`shared/board.ts` 只定义 RPC 并转出这些结构，插件内的引用不变。
- 命令行读取 `projects.json` 的回退路径与插件数据目录用同一套 `PASEO_HOME` 解析，`PASEO_HOME=~` 时也能找到。
- 新增插件市场说明页 OVERVIEW.md、图标与截图（来自隔离测试 daemon 的真实界面，示例数据均为虚构）；README 改为通用安装方式，许可证署名改为「Project Notes contributors」。
- 预览数据、截图脚本和测试改用虚构的示例项目与通用 profile 名；Playwright 和单元测试固定使用 UTC 时区。
- 测试新增打包约定（Git 安装只装生产依赖、CLI 打包只含 zod 与本地源码、SDK 版本与 manifest 下限一致、图标与截图存在且不超过 400 KB）和 `PASEO_HOME` 解析。

## 0.7.2 — 2026-09-23

- 修复：手机、折叠屏等原生 App 上，项目列表和启动选项里的搜索框不再与下方内容重叠（共享 kit 的搜索框在纵向布局里会把所在行压成 0 高度，网页端不受影响）。

## 0.7.1 — 2026-09-23

- 共享 kit v3 调色板：深色主题下颜色更亮（霓虹感），新增天蓝、青柠、洋红色相与渐变、光晕工具；文字颜色对比度仍 ≥ 4.5:1。功能与布局不变。

## 0.7.0 — 2026-09-23

加颜色：状态和类别一眼可辨，布局、数据与操作不变。

- 类型固定配色：任务蓝（方框勾）、提示词紫（对话框图标，替换原来的终端图标）、想法琥珀（灯泡）。类型切换（条数着色，手机宽度够时也显示图标）、编辑器、列表行首、空状态都用同一颜色；宽屏列表的选中行用该类型的浅色底。
- 任务状态用形状和颜色同时区分：待办灰色空心圈、进行中蓝色半圈、已完成绿色实心对勾。卡片、看板列头（图标、名称、条数，下方一条同色细线）、手机分组标题、详情和编辑器的状态切换全部一致；状态切换里当前状态用同色浅底和边框（文字保持正文色，保证对比度）。
- 重点改为红旗、置顶为琥珀图钉，卡片与列表的信息行、详情和编辑器里的开关一致（打开时着色，关闭时灰色）。详情里的「删除」改为红色垃圾桶图标，仍然只是移到回收站。
- 项目用首字母色块，颜色按项目名计算，与其他插件里同一项目一致；随手记是固定的青色收件箱，已移除的项目为灰色。用在项目筛选按钮、选择项目列表、全部项目视图的卡片和列表、按项目分组的标题、编辑器的「保存到」和「开始处理」的目标项目。
- 回收站：标题和菜单入口带红色垃圾桶，每行的「恢复」是绿色按钮，行首显示类型颜色。
- 「开始处理」：工作区方式带彩色图标（独立 Worktree 青绿、项目目录靛蓝）；启动进度区按阶段着色并带进度条——进行中蓝、已开始绿、需要核对琥珀、被拒绝红；服务器给出的原因直接显示在进度区里，不再另起一条红色提示。提示词详情里的「开始处理」是蓝色按钮。
- 空状态按类型着色，读取失败为红色，同步中断为琥珀色提示条。
- 类型切换的图标按实际宽度显示：手机约 370 px 起、桌面约 790 px 起（条数位数多时相应放宽），更窄时只保留名称和彩色条数，「全部项目」和右侧按钮不会被挤压。桌面搜索框基准宽度从 240 px 调为 200 px（仍可缩到 140 px），让侧栏展开时约 800 px 宽的界面也能显示图标。
- 预览新增 `?nav=0`（不能跳转的客户端）和「启动被拒绝」「启动完成」两个截图视图；组件测试新增 2 项颜色语义检查（共 63 项），界面测试不变（桌面与手机各 10 项）。

## 0.6.0 — 2026-09-23

界面重做，数据、RPC 与同步方式不变。

- 去掉大标题、英文眉题、说明文字和底部说明，改为一行工具栏：项目范围、任务 / 提示词 / 想法（带条数）、搜索、新建（手机上是「+」）和「···」（回收站、按项目分组、刷新）。第一条手记的标题距界面顶部：桌面从约 476 px 到 104 px，手机从约 604 px 到 135 px。
- 任务卡片只保留标题、一两行摘要和一行「重点 · 项目 · 时间」；状态圈是唯一的快捷操作，点一下前进一步。其余操作（开始处理、编辑、复制、状态、置顶、重点、删除）集中到点开后的详情里。全部项目视图才显示项目名。
- 手机上任务改为可折叠分组（进行中、待办、已完成，已完成默认收起），不再横向切换状态；宽屏的提示词、想法、按项目分组和回收站改为左列表右详情，列表每行都能直接复制。
- 编辑与新建合为同一弹层：保存固定可见（手机顶部、桌面底部），标题回车即保存，标题为空时保存不可用；在别处被修改时停用保存，可「载入最新」。删除改为直接移到回收站并提示，不再二次确认；「置顶」「重点」可在详情里直接切换。
- 「开始处理」弹层：说明缩成一行，Agent 设置折叠为一行摘要（需要处理时自动展开），两列排布；确认后表单收起，只显示进度与结果。复制结果改用轻提示。
- 同步状态平时不显示，只在手动刷新或同步失败时出现；读取失败给出「重试」。首次加载显示骨架行。
- 统一使用共享 UI 套件（`client/kit.tsx`），颜色全部来自主题，图标与宿主一致。修复网页端卡片内按钮嵌套导致的点击穿透问题。
- 新增模拟数据预览（`npm run preview:build`）、截图脚本（`npm run preview:shots`）和 Playwright 界面测试（`npm run test:ui`，桌面与手机各 10 项）；组件测试新增 5 项（共 61 项）。

## 0.5.0 — 2026-09-22

- 适配 Paseo 0.9.0：manifest 改为 `"paseo": ">=0.9.0"`，开发依赖固定 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 0.9.0。0.8 的 daemon / App 不再加载本插件。
- 看板同步改为按内容版本号：`project-notes.dashboard` 接受上次的 `revision`，没有变化只回 `{ unchanged: true, revision }`（约 60 字节），有变化只回变化的看板，项目列表变化时才带项目列表。版本号由看板文件内容和项目列表计算，插件、CLI、其他进程或手工修改都会生效；插件重启后相同内容得到相同版本号。旧客户端不带版本号时仍拿到完整数据。
- 界面只在前台可见时轮询：App 进入后台或 iOS inactive、面板所在标签被隐藏（布局尺寸为 0）时暂停，回到前台立即检查一次。约每 5 秒一次，一分钟无变化后放宽到每 15 秒；自己的修改直接用写入结果更新并回到 5 秒。后台轮询不再触发重新渲染，派生列表与卡片做了缓存。
- 服务端按文件 inode / 大小 / mtime / ctime 缓存已解析的看板，轮询时只 `stat`，只重读变化的文件；读取并行且有上限。Paseo 项目列表在各 RPC 间共享：`project.update` 事件立即失效，另有 30 秒兜底过期；8 秒超时，失败时沿用上次列表。
- 启动任务：创建工作区和 Agent 时带 0.9 幂等键（`project-notes:<launchId>:workspace|agent`），重复点击、重试或新旧插件进程重叠都不会多建；被插件重载打断的启动按 Agent 标签查询已创建的会话（只查询、不补建）。读取代理选项的各调用加超时，总计控制在 24 秒内。启动记录改用唯一临时文件写入。
- 打开结果时显式传 `serverId`（0.9 导航参数），始终打开发起启动的主机上的会话。启动状态查询同样只在前台轮询。
- 删除未被引用的 `client/web.ts`（用 `window.open` / `Linking.openURL` 的旧外链工具）。插件界面没有打开外部链接的入口，因此没有改接 `openExternalUrl`。
- 测试从 13 项扩充到 56 项：存储缓存、锁、真实 CLI 进程并发、看板版本号与增量、全部 RPC、启动幂等与中断、界面轮询（react-test-renderer）。

## 0.4.0

- 新增命令行 `bin/notes.mjs`，Agent 和脚本可直接读写手记；插件与 CLI 通过 `<board>.json.lock` 跨进程串行化写入。

## 0.3.0

- 从作者自用的本地插件整理为独立插件。
