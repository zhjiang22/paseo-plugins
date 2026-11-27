# Changelog

## Unreleased

- daemon 环境设了 `http_proxy` 且 `no_proxy` 不含 `127.0.0.1` 时（尤其加上 `NODE_USE_ENV_PROXY=1`），启动浏览器报 `connectOverCDP: The property 'Host in options.headers' must match the request authority`：daemon 改为直接用 `DevToolsActivePort` 里的 WebSocket 地址连接 Chromium，不再经代理请求 `/json/version`。
- 地址栏输入不带协议的本地地址（`127.0.0.1:5173`、`localhost:3000`、`*.localhost`、IP 地址）时补 `http://`，不再补 `https://` 导致 `ERR_SSL_PROTOCOL_ERROR`；其他域名仍补 `https://`。
- 地址栏有时停在旧地址：输入框获得焦点或留有未提交的输入时错过一次地址变化，之后就一直不再同步。现在地址栏空闲时总是显示当前页面地址，失焦时也会同步；未提交的输入保留到页面跳转为止。
- 页面跳转、点击、切换标签页后画面不再先变黑：上一幅画面留在原处（不可点击，显示「正在获取画面…」），直到新画面加载完；画面图片关掉 Android 默认的 300 ms 淡入。
- Android 上手动控制页面时，在画面上左右滑不再拉出 Paseo 的侧边抽屉：画面放进原生 ScrollView 抢先接管拖动，画面本身由原生驱动的反向位移固定不动，松手后换算成一次页面滚动。由 `client/swipe-shield.tsx` 实现。

## 0.13.5 - 2026-11-22

- 适配 Paseo 0.17（0.16 及更早照常可用）：不用改代码。界面懒加载块用 Paseo 0.15 起的编译器重建（以前是 0.14 的编译器生成的，内容等价，只有压缩后的写法不同）。在隔离的 Paseo 0.17.3 和 0.16.0 daemon 上加载、跑脚本回合并打开网页端（桌面和手机），没有错误。

## 0.13.4 - 2026-11-16

- 适配 Paseo 0.16 的插件 SDK（0.15 及更早照常可用）：RPC 处理器按 0.16 的 `handle` 类型写，运行时行为不变。在隔离的 Paseo 0.16.0 和 0.15.4 daemon 上加载并打开网页端，没有错误。

## 0.13.3 - 2026-10-29

- 适配 Paseo 0.14：不再注册 `agent.session_open` 钩子。0.14 起，只要带这个钩子的插件启动、停止、重载或崩溃重启，daemon 就把所有打开着的 Agent 会话标成过期；每个 Agent 下一条消息前都会先关掉再重开会话（Claude Code 等进程重启，后台任务和子 Agent 随之结束）。本插件的钩子只用来提前开始恢复浏览器，现在改在 `agent.created` 和 `agent.turn_started` 时开始；Agent 用浏览器工具时恢复已在进行，MCP 桥照旧等待正在恢复的浏览器。
- 在隔离的 Paseo 0.14.0 daemon 上对比：重载旧版本插件后，下一条消息让 Agent 重开了会话（脚本化 ACP 进程重启并重新载入会话）；新版本重载后没有任何 Agent 重开。Paseo 0.13 上行为不变。

## 0.13.2 - 2026-10-25

- 适配 Paseo 0.13：动效浮层（kit motion）改为写明的绝对定位：Paseo 0.13 的手机 App 升到 React Native 0.86，删掉了 `StyleSheet.absoluteFillObject`，原来的写法在手机上会让 Ping / Flash 浮层失去定位、把排版顶开。
- 插件市场中文介绍（Paseo 0.13）：公开版清单带 `translations.zh-CN`（中文名称和简介），并附 `OVERVIEW.zh-CN.md` 中文介绍页；旧版 daemon 忽略这个字段，安装和运行不受影响。
- 在隔离的 Paseo 0.13.0 和 0.12.0 daemon 上加载全部插件、跑同一组脚本回合并打开网页端：插件全部运行，网页端没有页面错误和插件报错。

## 0.13.1 - 2026-10-18

- 修复 Linux ARM64 主机找不到 Chromium（issue #2）：自动查找 Playwright 缓存时写死了 x86-64 的目录名
  `chrome-headless-shell-linux64`，ARM64 上的 `chrome-headless-shell-linux-arm64` 永远找不到，只能靠 `PASEO_SERVER_BROWSER_EXECUTABLE`。
  现在插件和 `scripts/setup-runtime.mjs` 按主机的系统和 CPU 选 Playwright 的目录名（Linux x86-64 / ARM64，另有 macOS、Windows 的名字备用）。
- 测试：目录名对照表、脚本里的副本与插件一致；模拟 ARM64 主机时只放 x86-64 的缓存不会被误用，放了 ARM64 的缓存就能找到。

## 0.13.0 - 2026-10-15

- 新增「Agent 开的端口」：**⋯ → 服务与端口**（原「本工作区服务」）和标签页面板里，本工作区服务下面多了一组 Agent 开的端口。
  - Agent 用 Bash 随手起、没写进 `paseo.json` 的开发服务也能列出来，点一下在共享浏览器的新标签页打开 `http://127.0.0.1:<端口>/`，不用再问 Agent 端口号。
  - 每行一个彩色端口胶囊，写明是哪个 Agent 开的（Agent 标题）、程序名（只取第一个词，不含命令行参数）和监听地址（仅本机 / 所有地址 / 仅某个地址）。
  - Agent 运行中为蓝色，空闲为绿色；Agent 已停止、已归档或出错而它起的进程还占着端口时为琥珀色。面板开着时新出现的端口闪一下并标「新」。
  - 其他工作区的 Agent 开的端口收在「其他工作区」里，展开后显示所属项目和工作区，也能在当前浏览器里打开。
  - 只能打开列表里的端口：面板只把端口号交给服务器，地址由服务器按扫描结果拼出，仍按现有导航规则检查；和本工作区服务一样只在手动模式下可用。
- 端口怎么找：daemon 在本机读 `/proc/net/tcp`、`/proc/net/tcp6` 里正在监听的 TCP 套接字，经 `/proc/<pid>/fd` 的 socket inode 找到进程，再从进程环境里只取 `PASEO_AGENT_ID` 和 `PASEO_AGENT_CWD`，归到 Agent 和工作区。
  - 只看与 daemon 同一用户的进程；本插件自己的进程（Chromium 调试端口和控制接口）和其他 Paseo daemon 的进程树一律跳过。
  - 离开 daemon 进程树的进程（`nohup`、`setsid`、父进程已退出）也算：Agent 用 `nohup … &` 起的服务会马上被系统收养，只看进程树会漏掉它们。这些进程靠继承的 `PASEO_AGENT_ID` 归属，而且这个 Agent 必须是本 daemon 的（已归档的也算）；其他 daemon 的 Agent、已删除的 Agent 和你自己在终端里起的服务都不列。
  - 环境只在进程占着监听端口时才读，最多 128 KB，读完清零，只留这两个变量；不读命令行；文件用 O_NOFOLLOW 打开且必须是普通文件，链接只读不跟随；每次扫描最多 2 秒，进程数、描述符数和文件大小都有上限，碰到上限时注明「只列出了一部分」。
  - 只在「服务与端口」或标签页面板打开、App 在前台时每 4 秒问一次；服务器把扫描结果共享 2.5 秒，没变化时只回一个版本号。已知端口每次只用三次小读取确认，出现新的监听端口时才遍历进程（约 200 个进程、4000 个描述符的主机上一次约 50 毫秒）。
  - 非 Linux 的 daemon 主机上这一组安静隐藏；扫描出错只在这一组里提示，不影响浏览器其他功能。
- 端口发现的做法改编自 alessandrocornacchia/paseo-port-forward 的 `server/scan.ts`（MIT），许可证全文见 NOTICE。
- 测试：
  - `/proc/net/tcp(6)` 解析（IPv4、IPv6、IPv4 映射地址、大小端、只收 LISTEN 和本用户、被截断的行）、`stat` 与程序名、环境只取两个变量及各项上限、inode 到进程、最近的 daemon 与进程树、已知端口的确认与 PID 复用、上限与时限；在本机真实 `/proc` 上起带 Agent 环境的 HTTP 服务（含父进程已退出的）验证能找到，且不带出其他环境变量。
  - 归属 Agent 与工作区（ID 精确匹配、目录精确匹配、其他 daemon 的 Agent 不列）、监听地址与打开地址、扫描与 Agent 记录的缓存、版本号、行数上限、只能打开列表里的端口；插件入口把 `openPort` 换成服务器自己拼出的地址。
  - 界面：分组与颜色、无障碍标签、展开其他工作区、只发端口号、只在面板打开时轮询且带版本号、新端口出现、Agent 模式不能打开、不支持的主机隐藏这一组。

## 0.12.1 - 2026-10-15

- 连上时不再下载完整语言目录（约 51 KB）：只取几百字节的启动文字（按所选语言），打开浏览器界面时再下载。网页和桌面端有缓存时照旧立即显示。

## 0.12.0 - 2026-10-15

- 内置英文和简体中文，默认跟随系统语言；新增「语言」设置，切换后已打开的界面即时更新，重新连接后保留选择。
- 侧栏、工作区面板、Command Center、斜杠命令、浏览器界面与显示给用户的服务器错误使用共享翻译目录，中文原有措辞保持不变。
- 支持用户把 `ko.json` 等翻译放在 `~/.paseo/plugin-data/server-browser/locales/`（或 `$PASEO_HOME/plugin-data/server-browser/locales/`）。语言设置显示覆盖率和格式问题，未翻译或无效条目回退英文。
- 目录中的 `templates/en.json` 和 `templates/zh-CN.json` 提供完整模板。翻译时设置 `$meta.name`，保留消息键和 `{placeholder}`；CLDR 复数形式必须有 `other`。同名文件可覆盖部分内置语言，更新只重写模板。
- README 与插件介绍补充语言设置和贡献方式：PR 新增 `shared/locales/<code>.json`，并在 `server/locales.ts` 注册一行内置目录。

## 0.11.2 — 2026-10-14

- 手动接管期间，Agent 读不到页面结构、网络请求和控制台记录，只能用截图看页面：`browser_snapshot`、`browser_find`、`browser_wait_for`、`browser_network_requests`、`browser_network_request`、`browser_console_messages` 和写操作一样被拒绝，拒绝信息提示改用 `browser_take_screenshot`。
  - 原因：Playwright MCP 的页面快照会带上表单框里已经填写的内容，密码框也是明文；以前你手动登录时，Agent 读取的快照会把你输入的密码带进它的模型会话。网络和控制台记录里也有你接管期间提交的表单和令牌。
  - 申请操作时和调用 Playwright MCP 前各检查一次；按工具名判断，插件更新前已经启动的 Agent 会话同样受限。
  - 截图、阅读页面（不含表单内容）和页面诊断仍然可用；新建浏览器 Agent 时的说明也改成了这样。
  - 交还 Agent 之后页面结构又能读到，表单里没提交的内容会出现在快照里，Agent 的操作也会把整页快照存进 `artifacts/page-*.yml`；文档提醒提交登录表单后再交还。
- `browser_network_request` 不再提供请求头和请求正文，只能读 `part` 为 `response-headers` 或 `response-body` 的响应。
  - 不带 `part` 的完整详情包含请求头，也一并拒绝。
  - 原因：Playwright MCP 会保留标签页的全部请求记录，直到 Agent 自己在这个标签页导航；以前交还后 Agent 仍能读出你接管期间提交的表单正文，包括密码。
- 调试地址改由环境变量交给 Playwright MCP，不再出现在它的命令行里（本机其他账号能读到进程命令行）。调试端口本身仍然没有认证，见下面的文档说明。
- 标签页地址：面板、Agent 的标签页列表和阅读页面返回的地址都去掉账号密码（`user:password@`），查询参数和 `#` 片段保留。Playwright MCP 自己的回复本来就列着所有标签页的完整地址，文档里写明了这一点。
- 错误信息不再带网页地址。Playwright 的导航错误会写出完整地址（查询参数、`#` 片段和跳转目标），而插件 RPC 的错误会显示在客户端并写进 daemon 日志；现在每个 RPC 错误里的任何 `协议://` 地址都换成「[网页地址]」，保存的失败原因也一样。
- `artifacts/` 的自动清理覆盖其中所有普通文件，包括 Playwright MCP 用网站给的文件名保存的下载，以及 `request-*`、`response-*` 等文件。以前只清理固定格式命名的截图、快照和日志，其他文件会一直留着。仍然保留最新的一份和 5 分钟内的文件，不进子目录，不跟随符号链接。
- 崩溃、强制结束或重启后留下的 `session.json` 不再被信任：
  - bridge 只在其中记录的 Chromium 仍以当前用户、这个工作区的 Profile 运行时才使用它（和插件认领孤儿进程的检查相同），否则按「尚未启动」处理，不启动 Playwright MCP；浏览器正在恢复时等待新文件。
  - 插件启动恢复时删除浏览器已不在运行的旧文件；记录的 Chromium 仍在运行时保留，供归档和孤儿清理停止它。
- 恢复标签页时去掉更多一次性参数：`verification_code`、`sms_code`、`mfa_code`、`invite_code` 这类 `*_code` 和 `code_*`（`country_code`、`zip_code` 等表示地区、语言、币种的除外），`totp`、`passcode`、`pin`、`pass`、`hash`、`hmac`、`assertion`、`PHPSESSID`、`ott`；驼峰写法（如 `oobCode`）按下划线处理；路径参数 `;jsessionid=…` 也去掉。规则按参数名判断，是启发式的。
- Playwright MCP 保存的文件（截图、网络和控制台记录、下载）只有 daemon 用户可读写：bridge 启动时把 umask 设为 077，不再沿用 Agent 的设置。
- 文档：
  - 写清调试端口没有认证的后果：本机任何账号或进程连上它，就能拿到这个工作区 Profile 的全部 Cookie 和登录状态、读取页面、在已登录的网站执行脚本并绕过手动接管；端口可以从 `/proc/net/tcp` 找到，`hidepid` 也挡不住。根本的修法是调试管道加需要令牌的本机代理，要改写浏览器的启动和连接方式，本版没有做。
  - 写明 Agent 会话连接期间 Playwright MCP 会把每个标签页的控制台输出持续写进 `artifacts/console-*.log`，网页下载也可能另存到 `artifacts/`。
  - 写明手动接管期间 Agent 只能用截图和页面正文看页面，你输入的密码不会进入它的模型会话；交还之后，表单里没提交的内容会出现在页面快照里。
- 测试：
  - 真实服务器和 Chromium 加替身 Playwright MCP：手动接管时页面结构、网络和控制台读取被拒绝，且不会转给 MCP，截图照常转发。
  - 真实 Playwright MCP：手动接管时在密码框里输入的内容，不会出现在 Agent 收到的任何回复里（快照、查找、等待被拒绝；截图、阅读页面、诊断和标签页列表照常）；交还后，快照确实列出了密码框里输入的值。
  - bridge 与替身 Playwright MCP：请求头、请求正文和完整详情被拒绝，响应部分照常转发；MCP 保存的文件为 0600；调试地址只在环境变量里，并用运行时里真实的 Playwright MCP 确认它读取这个变量；记录的 Chromium 已退出或不是这个工作区的时，按未启动处理且不启动 MCP。
  - 真实 Chromium：手动模式下服务器拒绝页面结构、网络和控制台读取，包括接管前刚拿到的租约；导航到 `http://127.0.0.1:9/x?token=…#…` 失败时，RPC 错误里没有查询参数和片段；标签页地址去掉账号密码，保留查询参数和片段。
  - 单元：插件恢复时删除崩溃留下的 `session.json`，保留浏览器仍在运行的；`artifacts/` 里网站命名的旧下载被清理，新文件保留；恢复地址的一次性参数对照表；任意协议地址的错误文本替换。

## 0.11.1 — 2026-10-14

- 浏览器总览与工作区面板改为首次打开时加载，共用按内容哈希缓存的界面分片，减少手机连接时常驻客户端下载量。
- 侧栏、命令和 `/server-browser` 入口保持即时可用；插件卸载时清理界面分片自己的画面缓存和定时器。

## 0.11.0 — 2026-10-12

- 修复直接在画面上打字时丢字：连续打字再按回车，现在每个字和回车都会送到网页。
  - 键盘、文字和滚轮改走每台设备自己的有序输入流。
  - 只要标签页、文档、画面尺寸和控制方都没变，画面刷新就不会再作废已经打出的字。
  - 点击仍然只对当时显示的那一帧有效。
  - 遇到以下情况，旧页面上还没送出的输入会被丢弃，并提示有几个字没发出，不会补发到新页面：其他设备开始输入、Agent 执行一步、网页弹出对话框、切换标签页、网页跳到新文档。
- 回车提交表单、网页跳到新文档后，画面会立刻跟上。
  - 原因：截图进行到一半时网页换了文档，Chromium 不会回应那次截图。
  - 以前插件要等满 10 秒超时，期间一直显示「正在获取画面…」，最后报错；现在会立刻用新会话重新截图。
  - 截图会话在网页切换文档时被拒绝的，也会马上重试。
- 电脑上可以直接在画面上用输入法打中文。
  - 组合期间画面右上角显示「输入法组合中」和正在组合的拼音，选好的词一次送出。
  - ⌘/Ctrl+V 按纯文本粘贴；表情面板和听写输入的文字也能送达。
  - 手机点画面不弹出系统键盘，仍用底部输入栏。
- Agent 模式下也能直接点后退、前进、刷新，或在地址栏打开网址。
  - 先弹出「切到手动并后退？」之类的确认。
  - 确认后切到手动，等 Agent 做完当前这一步（最多 10 秒），页面没有变化才执行。
- 新增「本工作区服务」，在 ⋯ 菜单和标签页面板里都能打开。
  - 列出本工作区的服务脚本，以及它们的运行和健康状态。
  - 一键在新标签页打开 `http://127.0.0.1:<端口>/`。
- 设备仿真的 User-Agent 跟随真实的 Chromium 版本，不再写死 Chrome/130。
  - 同时发送对应的 Client Hints：品牌、平台、是否移动设备。
  - Safari 预设不发送 Client Hints。
  - 改回自定义尺寸时，恢复 Chromium 自己的 UA。
- 已关闭（未载入）的浏览器 Agent 现在算作可用，不再因此重复创建 Agent。
  - 重新连接时优先复用已保存的那个，打开时由 Paseo 自动载入。
  - 只有已归档或已不存在的 Agent 才会被替换。
- 工作区从归档恢复后，浏览器可以重新启动：工作区列表里再次出现这个工作区时，插件解除它的停用标记。
- 孤儿浏览器列表增加已归档或已删除的工作区留下的浏览器资料。
  - 显示工作区名称、占用空间和最后使用时间。
  - 确认后可以删除，删除会清掉其中的登录状态、Cookie、历史、缓存和 Agent 截图。
  - 浏览器仍在运行的，要先停止才能删除资料。
- 操作记录把 10 秒内同一标签页上连续的同类输入合并成一条，打字不再挤掉其他记录。
- 交叉复查后的修复：
  - 输入法组合绑定开始组合时的标签页和文档。组合期间页面或控制方变了（换文档、切标签页、其他设备开始输入、Agent 执行一步、弹出对话框），没确认的文字直接丢弃并提示，不会改发到新页面；输入槽同时释放，点一下画面或按 Tab 才重新接收键盘。
  - 网页里的 iframe 跳到新文档也算换页面：之前打出、还没送达的输入作废并提示，不会进入新来源的文档。
  - 「切到手动并后退？」等确认绑定打开确认时看到的页面。之后网页换了页面，确认框变红并禁用确认；服务器同样拒绝，不切到手动，也不执行。Agent 在同一页面上执行的步骤不会让确认失效。
  - 切换标签页（包括切走再切回）、改画面尺寸、换设备预设和「完整宽度」都会作废旧输入。
  - 网页已经弹出对话框时，没发出的文字不算送达：输入栏保留草稿，提示有几个字没发出，并提供「查看对话框」。
  - 长文本按整个字符分段发送，表情等由两个编码单元组成的字符不会被切开；输入栏分段发送中途失败时，只保留还没发出的部分。
  - 每台设备单独记录已处理的最高输入序号，其他设备插入输入后，旧序号的输入也会被拒绝。
  - 从孤儿浏览器停止或删除后，插件同步记下工作区已归档；工作区恢复后（包括插件冷启动后才归档的情况）浏览器可以重新启动。
- 复核后的修复：
  - 网页原地改写文档也算换了文档，包括 `document.open()`、页面加载完后的 `document.write`，以及返回 HTML 的 `javascript:` 地址。之前打出、还没送达的输入作废并提示，接管确认也随之失效。
    - 判断只看调试协议的 `Page.documentOpened` 事件和当前文档上的生命周期 `init` 事件，不往网页注入脚本。
    - 网页加载过程中的 `document.write` 和 Playwright 自己读取网页，都不会打断打字。
  - 换成会做站点隔离的完整 Chromium 时，跑在独立进程里的 iframe 由插件单独接一个调试会话盯着。
    - 以下情况都会结束输入：iframe 用同一地址刷新、iframe 自己 `document.open()`、iframe 里面再加载框架。
    - 默认的 headless shell 不会把 iframe 放进独立进程，也就不会多开会话。
  - iframe 里用 History API 改地址不再打断打字。以前按地址判断，地址一变就结束输入；现在只看文档是否换了。
  - 每台设备输入序号的记录表满 64 台后，被挤出的设备再用旧序号发送会被拒绝。
    - 服务器把被挤出设备的最高序号记为下限，没有记录的设备必须高于这个下限。
    - 界面发送时自动从下限之上编号，正常打字不受影响。
- 测试：
  - 新增在真实 Chromium 上连续打字的回归测试和输入队列的单元测试。
  - 新增回车跳到新文档时持续取画面的回归测试，以及截图中途换文档时立即重来的单元测试。
  - 新增界面测试，覆盖打字、输入法、粘贴、多设备输入、本工作区服务和删除浏览器资料。
  - 新增连接真实 daemon 和网页端的 `tests/live-typing-check.mjs`（`npm run test:typing`）。
  - 弹出窗口对话框的测试改为等待新页面事件，不再偶发失败。
  - 新增复查回归测试（真实 Chromium 与界面）：输入法组合中途换文档或标签页、iframe 跳到新来源、过期的接管确认、来回切换标签页和改尺寸、已有对话框时的打字、表情跨分段边界的长粘贴，以及孤儿清理后恢复工作区；`npm run test:typing` 也覆盖组合中途换文档和换标签页。
  - 新增复核回归测试：
    - 原地改写文档：`document.open()`、`javascript:` 地址、父页面改写 iframe；
    - 加载中写入和 Playwright 读取不打断打字；
    - 完整 Chromium 站点隔离下 iframe 自刷新、自改写和内层框架；
    - 序号下限，服务端和界面各一条。

## 0.10.1 — 2026-10-12

- 修复 Android App 的 Hermes 默认求值器无法加载最近画面缓存：改用闭包，保留逐主机隔离、访问顺序淘汰、字节预算、过期和卸载清理。
- 全仓库客户端兼容性守卫校验默认 Hermes 编译、入口导出及 interop 补丁，避免客户端加载失败回退。

## 0.10.0 — 2026-10-12

- 人工操作绑定用户所见的标签页和画面版本；其他设备或 Agent 改变页面后，拒绝陈旧操作并刷新画面，避免错页输入。
- 工作区归档时停止 Chromium、取消恢复并回收会话资源，保留登录 Profile；提供孤儿浏览器列表与停止入口。
- 已归档或关闭的浏览器 Agent 可重新连接；查询失败时保留关联并提示重试，避免重复创建。其他设备启动浏览器后，已打开的空闲或启动中面板会自动同步。
- 网页 confirm、prompt 等对话框显示待处理状态，用户可在面板应答，Agent 可通过 browser_handle_dialog 应答，不再自动关闭。
- 最近画面改为有条数、字节和存活时间上限的缓存，并随工作区移除和插件卸载清理。
- 网页标签选择、固定和关闭使用独立按钮，避免网页端嵌套按钮和误切换；入口迁移到 Paseo 0.11 的 screen 与 sidebar header API，保留旧宿主运行时检测。
- 增加桌面、手机和平板设备仿真预设，联动视口、像素比、触摸、移动模式与 UA；显示同时观看的客户端数量。

## 0.9.2 — 2026-10-10 (security hardening)

- The browser Agent's bridge offers a fixed list of Playwright MCP 0.0.82 tools and refuses every other tool, including ones a later MCP version adds; `tools/list` shows only the allowed ones. `browser_file_upload` and `browser_drop` accept only regular files whose real path is inside the workspace directory (no symbolic links) and pass the checked real paths on.
- Playwright MCP runs in the workspace directory and no longer receives the client's roots, so files that tools save by name stay in the workspace or the browser's `artifacts/`. The bridge starts it only from the runtime directory's `node_modules/@playwright/mcp/cli.js` and with basic environment variables only (no secrets, `NODE_OPTIONS`, proxy or `PLAYWRIGHT_MCP_*` settings).
- Agent navigation (`browser_navigate` and new tabs) goes through the panel's address rules on the server, and Playwright MCP gets the normalized address. Addresses with credentials and link-local or cloud metadata addresses (169.254.0.0/16, fe80::/10, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`) are refused. Chromium also gets host-resolver rules for them, so page scripts, redirects, frames and forms cannot reach them; host names that only resolve to them through DNS are not caught.
- Each workspace browser has its own control token, renewed at every start. A token works only for its own workspace, page reading and diagnostics included.
- Saved tab addresses lose their fragment and query parameters that look like one-time credentials (OAuth `code` and `state`, tokens, signatures, tickets, session ids, one-time passwords, magic links) before they are written to `state.json` and reopened. Other query parameters stay.
- Leases: a lease the bridge stopped waiting for is never handed out, a lease that is not renewed within 2 minutes expires, and an Agent's new tab keeps its lease until the page has loaded or timed out. The bridge and the control endpoint share one set of time limits (`server/budgets.ts`); the bridge always waits longer than the server works on a request.
- Page titles, the viewport probe, fit width, page reading and the login check in diagnostics have their own time limits, so a page stuck in a script no longer stalls polling. Stopping or restarting the browser no longer waits behind a stuck action.
- The data, workspace, profile, artifacts and runtime directories must be real directories owned by the daemon user and are set to 0700; otherwise the browser does not start and says why. `setup-runtime.mjs` checks the runtime directory the same way.
- Chromium's sandbox is on by default. When Chromium cannot start with it, the browser starts once more with `--no-sandbox`, remembers that for the plugin process and warns in page diagnostics. `PASEO_SERVER_BROWSER_SANDBOX=1` requires the sandbox and `0` turns it off.
- Chromium inherits an allowlisted environment (paths, locale, time zone, temporary and XDG folders, proxy and font settings, the setuid sandbox path), and the runtime's `lib/` joins `LD_LIBRARY_PATH` only when it exists. A `PASEO_SERVER_BROWSER_PROXY` with credentials is refused, because Chromium's command line is visible to other local users.
- Smaller fixes: releasing a lease switches the active tab only for a write lease in Agent mode; `agent.json`, `state.json` and `session.json` are read only as small regular files, never through a symbolic link, and the Agent id must be well formed; the overview and `browser.options` no longer send workspace directories to clients; the preview server answers a malformed request instead of crashing; the README and overview describe where downloads go and the remaining limits (unauthenticated debugging port, x86-64 headless shell lookup).

## 0.9.1 — 2026-10-10

- The host runtime is a locked dependency tree. `runtime-deps/package.json` and `runtime-deps/package-lock.json` ship with the plugin; `scripts/setup-runtime.mjs` copies them into the runtime directory and runs `npm ci --ignore-scripts --no-audit --no-fund`, so every host installs the same transitive dependencies. Before, only the four direct versions were pinned and `npm install` resolved the rest afresh. Setup stays manual and install scripts stay disabled; the runtime directory's `package.json` is replaced by the shipped one.

## 0.9.0 — 2026-10-10 (ready to publish)

- Require Paseo 0.11.1 and pin the 0.11.1 plugin, client and protocol SDKs. The manifest gains an English display name, a description, an icon and four screenshots for the plugin registry, and an `OVERVIEW.md` describes setup, data, network access and limits.
- No build command: the server code takes its workspace type from the host SDK instead of importing `@getpaseo/client`, so Paseo compiles a Git or registry install without installing development dependencies.
- The browser Agent's bridge no longer offers Playwright MCP's `browser_run_code_unsafe`, which runs arbitrary Node.js code in the MCP process, and refuses calls to it. Page JavaScript (`browser_evaluate`) and the other browsing tools are unchanged.
- A host without the prepared runtime or Chromium now gets setup guidance (`scripts/setup-runtime.mjs`, `PASEO_SERVER_BROWSER_RUNTIME`, `PASEO_SERVER_BROWSER_EXECUTABLE`) instead of a module or file error. `setup-runtime.mjs` also reports which Chromium the plugin will use and the optional `lib/` and `fonts.conf`.
- Page diagnostics describe the host truthfully: Chromium follows the daemon's `HTTP(S)_PROXY` / `ALL_PROXY`; host libraries and fonts no longer count as a warning; a new check reports whether Playwright MCP is installed; the CDP check shows whether Chromium's sandbox is on.
- New opt-in environment variables: `PASEO_SERVER_BROWSER_PROXY` sets a proxy for the shared Chromium only, and `PASEO_SERVER_BROWSER_SANDBOX=1` turns on Chromium's sandbox. Both are off by default, so existing browsers behave as before.
- Without a selected profile, a new browser Agent uses the first usable agent profile, as the panel already does, instead of looking for particular profile names.
- Tests and the live acceptance scripts follow `PASEO_SERVER_BROWSER_RUNTIME` and `PASEO_SERVER_BROWSER_DATA`.
- The preview fixture and its frames use fictional projects and pages. The README covers runtime setup, stored data and how to delete it, network access and security notes; internal design and verification notes stay out of the published package. The MIT notice names the plugin's contributors.

## 0.8.2 — 2026-09-23

- Fix: in the phone / foldable app the project and workspace search no longer overlaps the list below it. The shared kit's search field collapsed its row on native layout; web was unaffected.

## 0.8.1 — 2026-09-23

- Shared kit v3 palette: brighter, neon-like shades on dark themes, new sky / lime / fuchsia hues and gradient / glow helpers; text colours keep ≥ 4.5:1. No functional or layout changes.

## 0.8.0 — 2026-09-23 (colour)

- Colours carry the same meaning as in the other Paseo plugins: who is in control is violet (Agent) or amber (手动) on the switch, as a thin edge around the page and in the activity list; Agent work spins blue, approvals pulse amber, login walls are orange, errors red and stopped browsers gray.
- A project's colour comes from its name, as in every other plugin, replacing the theme-rotated project palette; the phone header, overview cards and rows and the workspace picker show the coloured project mark.
- Browser tabs show a live state mark (Agent at work, waiting for approval, needs login, error, taken over by you).
- Overview filters get moving marks and coloured counts, thumbnails a state pill, cards that need you a tinted border, phone sections a coloured project header; each card's accessible name includes its state.
- Menu and sheet icons are coloured by kind (view cyan, page size teal, reading indigo, diagnostics green, activity pink, Agent violet, open elsewhere blue) and 关闭浏览器 is red; diagnostics, activity, resources and page tabs use coloured result icons; stage and empty states sit on tinted tiles, and banners over the page get an opaque ground.
- Spinners and pulses reuse the observatory's motion helpers (paused in the background, off with reduced motion). Frame pacing, revision polling and visibility gating are unchanged.

## 0.7.0 — 2026-09-23 (UI redesign)

- Rebuild the viewer on the shared Paseo UI kit: two chrome rows on desktop (browser tabs, then navigation) and one row on phones instead of two tab strips, an address row and a status footer.
- Browser tabs become calm tabs with a project-colored dot; a new-workspace picker opens browsers for workspaces that have none yet.
- An explicit Agent / 手动 switch shows who is in control; re-selecting the current mode sends nothing, and a takeover that waits for the Agent's current step says so.
- Phones get a thumb-reach bottom bar (back, reload, address, page tabs, keyboard) only while in manual control; the typing tray docks under the page with Enter, Tab, Backspace, Select all, Esc and scroll keys.
- Page tabs move into a sheet behind a tab-count button; zoom and viewport readouts move into the ··· menu.
- Secondary tools (view and quality, reading, diagnostics, activity, resources, agent connection, stop) become host sheets reached from ···; stopping the browser asks for confirmation, confirmations become toasts.
- The all-browsers overview is a thumbnail grid on desktop (one small frame per page, never polled) and a grouped list on phones, with filters, search and state badges.
- Switching back to a browser shows its last frame dimmed until the live frame arrives; decision states (approval, login) appear as dismissible one-line banners.
- Add a synthetic preview (`npm run preview:build`) and Playwright UI tests (`npm run test:ui`); remove the obsolete 0.2/0.3 live UI scripts.

## 0.6.0 — 2026-09-22

- Require Paseo 0.9.0; pin the 0.9.0 plugin, client and protocol SDKs.
- Never block or fail an Agent session open: lifecycle hooks start browser restoration in the background, and the MCP bridge waits (bounded) for a browser that is still being restored.
- Size frames to the viewer: phones receive the visible viewport downscaled to their screen (device pixel ratio capped at 2), retried after scroll animations instead of falling back to full size.
- Pace frames by the link: one request in flight, never faster than twice the round trip, and lower JPEG quality automatically while changed frames arrive slowly.
- Omit unchanged data: frame polls carry a session revision and overview polls a content revision, so idle polls cost tens of bytes; overview summaries drop tab lists, settings, runtime and finished history.
- Poll only while visible (background, iOS inactive and hidden host tabs pause), relax overview polling to 5 s and remove the per-second re-render timer.
- Cache the workspace listing for 30 s with workspace lifecycle invalidation instead of listing every workspace on each frame and input.
- Open the current page on the viewer's device (system browser everywhere, Paseo's local browser on desktop) and pass `serverId` when opening the linked Agent.

## 0.5.0 — 2026-09-20

- Group the upper browser-session tabs by project, with stable shared colors and explicit Agent labels.
- Keep webpage tabs on the lower row, following the selected Agent's workspace browser.
- Preserve each workspace's existing webpage selection when switching viewer sessions.
- Represent sessions without a linked Agent as manual browsing; no synthetic Agent identities.

## 0.4.1 — 2026-09-20

- Check the website's own horizontal overflow after matching the viewer window.
- Include wide nested application panes and tables when computing the required viewport width.
- Add an explicit full-width action and use a 1440 × 900 desktop preset.
- Keep the result as a live viewport with unchanged page navigation and vertical scrolling.

## 0.4.0 — 2026-09-19

- Rework the interface around a bounded browser viewport instead of stacked dashboard cards.
- Move workspace browsing and secondary tools into drawers, retaining compact workspace and Agent context.
- Fit the full remote frame without cropping or enlarging pixels; make viewport matching an explicit action.
- Support desktop viewports up to 2560 × 1600 and preserve the chosen size across restarts.
- Improve keyboard access and keep remote resolution unchanged when another viewer connects.

## 0.3.0 — 2026-09-19

- Add a project/workspace browser overview with the explicitly associated Agent, current page and actual browser activity.
- Separate Agent lifecycle status from browser tool activity; add filters and search.
- Keep page ownership visible while scrolling and link directly to the associated Agent.
- Track the last 12 operations in memory, preserving their target identity without storing input content or URL credentials/query parameters.
- Inspecting or switching overview cards does not navigate pages or create new workspaces.

## 0.2.0 — 2026-09-19

- Add bounded crash recovery, background workspace restoration and persistent session settings.
- Use native Chromium TargetIDs; reject stale targets and protect pinned tabs and tab limits.
- Add read-only page/login/network diagnostics and clean article/visible-text reading via UI and MCP.
- Add adaptive frame quality, measured timing, touch scrolling and mouse wheel input.
- Add scoped artifact retention and runtime resource statistics.
- Preserve human takeover rules and separate browser tool namespaces.
- Validate with 8 integration tests, 19 real Paseo UI checks and actual Agent tool calls.

## 0.1.0 — 2026-09-19

- Initial Linux browser runtime with workspace profiles, Paseo image/input panel and shared MCP Agent.
