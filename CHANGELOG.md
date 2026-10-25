All notable changes to the `dsh-orchaterm-web-api` plugin will be documented in this file.

## [0.4.0] - 2026-10-25

按用户要求**原样逆向 OrcaTerm 客户端的 API 封装**（REA + 线上明文 bundle），据实测把工具结果
回传切换到**官方协议**。这是行为级变更，版本升 0.4.0。

### 逆向发现（orcaterm_start.js，REA evidence ev_fd6f9d58…，1962 个模块）
1. **官方工具结果协议**（子 Agent 循环，@345023 等 4 处一致）：
   ``{type:'review', reviewAction:'reportToolResult', toolResult, tool}``
   其中 `tool` 是上游信封里的**原样 tool 对象**；用户拒绝时同样走 reportToolResult（文本不同）；
   mcp/system 类工具先发 `{reviewAction:'approve'}` 由后端代执行。官方客户端回传带
   3 次重试 / 15s 超时 / 300→1500ms 退避；子 Agent 循环上限 30 轮。
2. **信封解包双路径**（@73109/@143035）：官方客户端的思维链 = SSE `reasoningContent` **或**
   `aiData.thinking`，二者取并集 —— 印证 v0.3.4/0.3.5 的双路径实现与官方一致；
   另有消息级 `reasoning` 布尔（reasoningActive）。
3. 权限模型：toolSource 枚举 `ui | mcp | system | sub_agent`，effect `allow|ask|deny`，
   lifetime `once|persistent`（客户端本地权限规则，与服务端无关）。

### 决定性对照实验（同任务、同凭据、同会话形状）
- **官方协议**：模型精确答出伪造结果里的「37 个 / 5 个超 300 行」——结果被结构化消费；
- **旧协议（ask + {TOOL_RESULT} 文本）**：模型答「总数 0，未找到任何 .md 文件」——
  **完全无视结果文本**。这正是此前会话「未收到扫描结果」症状的真正根源：
  旧协议把结果当普通用户消息，模型时吃时忽略。

### Changed（行为级）
- **工具结果回传切换到官方协议**：`toAssistantInput` 的工具轮改产
  `{type:'review', reviewAction:'reportToolResult', toolResult, tool}`；
  `tool` 优先取**信封原件**（新增调用级 LRU `ORIG_TOOL_BY_CALL`，512 条，emitToolCall 时按
  callId 记住上游原样 tool 对象），丢档（进程重启）时由 `reconstructOrcaTool` 按映射反推兜底。
  多个工具结果合并为一份 toolResult（官方逐个回传并等待响应；DSH 一次性给全部，只能合并，
  带序号标注）。`assistantBody` 新增 `reviewInput` 直通口；`appendSpillHint` 指引保留。

### Verified
- 协议重放（全链路走反代）：伪造「4711 个文件 / 2300 行 / 23 个超限」，模型精确答出全部三个数
  （4,711/2,300/23），未编造、未重发工具，5/5 PASS；
- `npm test` 全绿（20 组）；活体回归 17/17；`/health` v0.4.0；stderr 空。

### Notes
- `ask + {TOOL_RESULT}` 路径彻底移除（对照实验证明不可靠）；若上游将来变更协议，
  逆向依据与坐标都记录在 WORK_SUMMARY 第 17 节。
- 官方回传有 3 次重试；反代已有等价的传输层重试（serveChat attempt 1..3），未重复实现。
## [0.3.6] - 2026-10-25

用户追问 v0.3.5 没覆盖的「第二次中断」（模型称未收到扫描结果、dsh web 停止继续）。深挖后定位到完整链条，并加了针对性修复。

### 第二次中断的完整链条（实测复现）
1. 会话里三次 tool/result **全部精确 49,932 字符、开头从文件名中间截断** —— DSH 的 pwsh 工具
   在输出超限时**砍头留尾**（~50K 上限），并在结尾留转存文件指针
   `Full formatted result stored at <path>. Use read with offset/limit…`。
2. 直连复现证明**结果确实送达且可读**：无头 25K 结果回传后，模型能正确指出「输出被截断了，
   而且看起来是同一个文件重复输出了很多次」，追问时还能原样引用其中一行 ——
   它不是没收到，而是**正确判断这截无头数据不可用**。
3. 但它随后选择「要用户提供/重新扫描」而不是自救 —— dsh web 因此正常结束回合（模型以问题
   结尾、无工具调用，DSH 等用户输入，不是传输故障）。
4. 顺带测出上游的硬上限：60K 字符的工具结果可正常消化，90K 直接整请求失败（回退成问候语）。

### Fixed —— 转存恢复指引（`appendSpillHint`）
检测到工具结果带 DSH 的转存指针时，在 `{TOOL_RESULT}` 后附一段恢复指引：告知输出被截断、
完整内容在 `<spillPath>`、**不要认为数据缺失或要求用户提供**，应调用 execute_command
分段读取（`-TotalCount` / `-Tail` / `Select-Object -Skip`）或直接在文件上统计。

**验证（同形状重放）**：同样回传无头截断 + 转存指针的结果，修复前模型答复「扫描命令已提交，
尚未收到实际数据…请粘贴执行结果」；修复后它直接发出
`Get-Content -LiteralPath '…dsh-spill\\…-pwsh.txt' -Tail 20` 自救，2/2 PASS。

### Verified
- `npm test` 全绿（20 组不变）；活体回归 17/17；`/health` v0.3.6；stderr 空。

### Notes
- 该修复只对「带 DSH 转存指针的结果」生效（正则匹配 `Full (formatted )?result/output stored at`），
  普通结果不受影响。
- 上游对**整个请求**存在 ~60–90K 字符级的硬上限：即使 DSH 截到 50K，多轮累积后仍可能触顶 ——
  属上游限制，反代侧无法消除，只能靠指令让模型少拉全量输出（指引里已引导它做统计而非全读）。
## [0.3.5] - 2026-10-25

用户报（`session-fb62c7fd`）三个现象，实为**两个根因**，均已修：

### 根因一：标题生成请求污染主对话的上游会话（对应现象 1、3）
DSH 的会话标题请求（`session-title-llm`）带**同一个 sessionId** 和 `purpose: 'session-title'`
（`packages/session/session-title-llm/src/index.ts:263`），此前与主对话共用同一个上游
conversationId —— 「Create a concise title…」指令被插进主对话的工具流程中间，打乱上游
Agent 的待办状态。会话证据：turn=1 step=2 的推理内容是「为会话生成标题」而非处理工具结果；
turn 3 工具结果已送达（tool/result 记录存在、非 error），模型却答复「未收到扫描结果数据」。
（先排除了一个嫌疑：dsh web 进程 20:27 启动，晚于 v0.3.0 的 lib 修复提交，
`role:'tool'` 转换确实已生效 —— 工具结果是送达了的，乱的是上游会话状态。）

**修复**：`conversationKey` 对带 `purpose` 的辅助请求（`'session-title'` | `'compaction'`，
主循环不带此字段）改用独立键 `aux:<purpose>:<sessionId>` —— 标题/压缩请求各自落到独立的上游会话。

**复现验证**（真实 provider 完整重放该场景）：主对话发工具调用 → 同 sessionId 发标题请求 →
主对话回传工具结果。修复后标题请求走独立会话（cid-dsh-40f61d11 ≠ 主对话 cid-dsh-ac37aec7），
工具结果轮正确答出「37 个 .md 文件」（喂的是伪造结果，能答对即证明结果真的被使用），6/6 PASS。

### 根因二：`<thinking>` 字面标签漏进正文（现象 2）
模型偶尔把思维链**同时**写进信封 `thinking` 字段和 `taskCompletion` 正文里的字面
`<thinking>…</thinking>` 标签 —— 后者原样漏进用户可见正文。

**修复**：新增 `createThinkingTagRouter`（与问候语剥离器同型的流式状态机）：把正文里的
`<thinking>` 块吃掉、内容转成 reasoning 流；开标签未到齐时扣住尾部片段；等不到闭标签
（超 maxHold 或流结束）时把开标签补回去按正文放行 —— 宁可漏改道，不能吞正文。

### Verified
- `npm test` 全绿，smoke 扩到 20 组（新增 19：标签改道含逐字符分片/中段标签/无闭标签兜底；
  20：purpose 隔离键）。
- 场景重放 6/6（见上）；活体回归 17/17；`/health` v0.3.5；stderr 空。

### Notes
- `purpose` 隔离对 `compaction`（DSH 上下文压缩请求）同样生效 —— 压缩指令也不该进主上游会话。
- 标签改道只认完整的 `<thinking>`/`</thinking>`；模型若用别的标签名（如 `<think>`）不会误伤。
## [0.3.4] - 2026-10-25

用户报（`session-86560dd5`）：反代会话没有调用工具执行、全程看不到推理思维链。逐项核查：**工具桥没坏**，**推理是真 bug**，已修。

### 先说结论（避免误判故障）
- **该会话的任务是浏览器自动化**（登录 X.com 爬取资源、用 Chrome DevTools MCP）。而上游 OrcaTerm Agent
  只认它自己的终端/文件工具集（`execute_terminal_command` / `remote_read` …），且**忽略调用方声明的
  function schema**（v0.2.0 审计结论）—— DSH 的浏览器工具对它不存在。所以它回复了澄清式提问
  （`action:"ask"`）或纯文本（模型甚至在正文里手写了 `<thinking>` 标签）—— 这是上游行为，不是链路断了。
- **终端任务的工具链路实测正常**：同代理同配置，「列出目录并检查 git 仓库」稳定拿到
  `finish=tool_calls` + pwsh 调用（活体回归 16/16 里的 C1/C2 就是这条链）。

### Fixed —— 思维链被静默丢弃（真 bug）
- **现象**：dsh web 全程看不到推理流；会话里 reasoning 总字符 = 0。
- **根因（直连探针）**：当前 deepseek 槽位把思维链放在**信封 JSON 的 `"thinking"` 字段**里：
  `` `{`"action":"completion","thinking":"思维链…","taskCompletion":"正文…"`}` ``，
  而不是 SSE 帧的 `reasoningContent`。反代的解包状态机只认 `taskCompletion`/`question`，
  thinking 整段被无声丢弃。
- **修复**：`feedUnwrap` 改成多字段循环状态机 —— 依次解出 `thinking`（→ `reasoning_content`
  流式下发，不走正文滤镜）、`taskCompletion`/`question`（→ 正文）。安全性依据：JSON 字符串内的
  引号必为 `\"`，裸 `"key"` 只可能是真键，扫描不会误入字符串内部。`finishUnwrap` 的整包兜底
  同步补了 `obj.thinking`。修后实测：推理题回 102 字思维链、终端任务在发工具调用前回 101 字思维链。
- 顺带修了实现中段的一个自伤 bug：字符串收尾帧的 delta 会因 `currentField` 被提前置空而走错通道，
  现在先取局部快照再清。

### Verified
- 活体回归扩到 **17 项**：新增「A1 有思维链（信封 thinking 字段 → reasoning 流）」锁住这条链路。
- `npm test` 全绿（18 组 smoke 不变）；`/health` v0.3.4；stderr 空。

### Notes
- thinking 字段是在 **deepseek 槽位**上观测到的；glm-4.7-thinking 等其它槽位可能走 SSE
  `reasoningContent`（老路径保留，两种形态都支持）。
- 浏览器类任务走这个 provider 不会产生工具调用（上游没有浏览器工具），需要浏览器自动化时换
  DSH 本地直连的 provider。
# Changelog

## [0.3.3] - 2026-10-25

用户报：OrcaTerm 已启动，但 dsh web 走反代仍报 `Invalid or expired AccessToken`。这是同一根因的**第三次**出现 —— 本轮把它修成「不再需要人工重启反代」。

### 根因（老问题，这次有了完整数据）
- token 寿命 ~2h，桌面端运行中会持续刷新 `%APPDATA%\com.orcaterm-desktop.app\data.bin`；
- 但反代只在**启动时**读一次登录态（`buildConfig` 快照），此后桌面端刷新再多也不感知；
- 本次实测：代理进程里的 token 00:37 就过期了，桌面端 20:37 启动后 store 里已有到 21:28 的新 token，旧代理进程仍揣着旧的。手动重启反代即恢复（`HTTP 200 正文: "正常"`）。
- `resolveCredentials` 本来就会「挑最新」—— 问题从来只在「只跑一次」。

### Fixed
- **凭据临期自动刷新（`ensureFreshCredential`）**：`handleChat` / `handleModels` 在每次上游调用前检查 token 的 `exp`，距过期不足 120s（或解析不出 exp）就重读桌面端登录态（两次文件读）。健康时**零 IO**；桌面端没开时重读到的仍是旧值，行为不变差。
- **认证失败自动重试一次**：assistant 请求若返回认证类错误（`Invalid or expired AccessToken` / `NEED_UIN_AND_SKEY` / `VERIFY_USER_FAILED`），刷新凭据后**重入 `serveChat` 一次**（该分支响应头未写过，重入安全；`authRetried` 防死循环）。
- **流内认证错误也触发刷新**：SSE 中途收到认证类错误时本轮无法重试（头已发出），但立即刷新凭据，让**下一轮**拿到新 token。
- `buildConfig` 的 `cookieFor` 改为读**当时的** `config.credential`（此前捕获启动时的 jar/快照，刷新后不会生效）。

### Verified
- `npm test` 全绿；smoke 扩到 18 组：新增 18a–18e 覆盖「健康零重读 / 临期替换 / exp 解析不出也重读 / 手搓 config 不抛错 / cookieFor 跟随刷新」。
- 真机验证：重启后 `HTTP 200 正文: "正常"`；`/health` → `v=0.3.3`。
- 说明：本轮 token 尚未到期，「临期触发」路径无法在线上复现，由单测 18a–18e 覆盖；线上验证的是「不回归 + 恢复可用」。

### Notes
- 刷新只依赖桌面端**已落盘**的 store/jar；桌面端完全没开且 token 过期时，行为与之前一致（报 AUTH，提示开 OrcaTerm）。

## [0.3.2] - 2026-10-25

对齐客户端身份（origin / referer / UA）。**先记一条更正**：v0.3.1 的「遗留」里我写了
「桌面端 CGI 会带 `&region=`、`&withClientUA=1`、`&withClientIP=1`，插件没带」——
**那句归属错了**，本轮 grep 后撤回。

### 更正：`region` / `withClientUA` / `API_HOST` 不属于 OrcaTerm 的请求路径

v0.3.1 把 `web_sdk.zh.*.js`（腾讯云控制台**通用** CAPI SDK）当成了 OrcaTerm 自己的 CGI 路径。逐串统计：

| | `withClientUA` | `API_HOST` | `i=region/` |
| --- | --- | --- | --- |
| 网页版 `start.js`（**OrcaTerm 本体**） | 0 | 0 | 0 |
| 网页版 `web_sdk.js`（控制台通用 SDK） | 3 | 6 | 1 |
| 桌面端含 `/cgi/api?` 的那份产物 | 0 | 0 | 0 |
| 桌面端 22MB 主产物（内含同一份 web_sdk） | 有 | 有 | 0 |

OrcaTerm 自己的 CGI 构造只有一条：
`y(e) = "".concat(r.Uw ? i.xV : location.protocol+"//api."+location.host, "/cgi/api?").concat(e)`
—— 里面既没有 `region` 也没有 `withClientUA`。`r.Uw` 是平台开关，在**网页版** bundle 里被编译期
折叠成常量 `const r=!1`（`80212(e,t,n){n.d(t,{O1:()=>o,Uw:()=>r});const r=!1}`），所以网页走
`location.host` 推导分支、`i.xV` 不可达；桌面端是另一份构建、`Uw` 为真，走 `i.xV`
= `https://api.orcaterm.cloud.tencent.com`。这正好解释了 v0.3.1 看到的「桌面端产物里该常量只出现一次」。

结论：**这一项不该对齐，也没得对齐**。顺带确认 `start.js` 的 CGI 请求头就是
`{X-SeqId, X-Referer: parent.location.href, X-CsrfCode}` —— 插件此前已全带。

### 实测：两个通道都不校验 Origin / Referer / UA

先自证请求头**确实发出去了**（本地回环服务器收到的头：`origin: "http://tauri.localhost"`、
`user-agent: "DESKTOP-UW-SENTINEL"`），否则「不校验」的结论不成立。

助手通道固定同一内容、同一模型、同一参数，只换 Origin：

| Origin | HTTP | SSE | ai 帧数 | 消息数 | 终止符 |
| --- | --- | --- | --- | --- | --- |
| 不带 | 200 | 是 | **22** | 4 | DONE |
| `http://tauri.localhost`（桌面端） | 200 | 是 | **22** | 4 | DONE |
| `https://orcaterm.com`（网页版） | 200 | 是 | **22** | 4 | DONE |
| `https://evil.example`（乱填） | 200 | 是 | **22** | 4 | DONE |

CGI 通道同样：不带 Origin / 乱填 / 桌面端 / 网页版都是 `HTTP 200 OK keys=5`；
`X-Referer` 乱填甚至完全不带也一样 200。

> 上一轮的「不校验」只测了 CGI、且只跑一次，不够严谨；这轮补了助手通道的重复 A/B 才敢写死。

**所以这一项不是修故障。** 做它的理由只有两条：(1) 用户要求与真实客户端一致；
(2) UA 是唯一有远期风险的字段 —— 服务端将来若加客户端风控，
`dsh-orchaterm-web-api/0.3.1` 这种一眼非浏览器的 UA 最容易被识别，而浏览器 UA 实测可得。

### Added
- **`clientIdentity` 配置项**（默认 `desktop`，可选 `web`；CLI `--client-identity`、
  env `ORCA_CLIENT_IDENTITY`）：统一两个通道发出的 `Origin` / `Referer` / `X-Referer`。
  - `desktop` → `http://tauri.localhost`：桌面端 WebView2 History 里的主页面就是
    `http://tauri.localhost/`（访问 35 次），而 `X-Referer: parent.location.href` 发的正是它；
  - `web` → `https://orcaterm.com` + `https://orcaterm.com/terminal`，即 v0.3.1 及之前的口径。
- **`DESKTOP_IDENTITY.userAgent`**：Rust 日志实测的桌面端 WebView2 UA
  （`… Chrome/152.0.0.0 … Edg/152.0.0.0`），两个通道统一改用它，不再发插件自报名字。
  重新取值：`Select-String "$env:LOCALAPPDATA\com.orcaterm-desktop.app\logs\orcaterm.log" -Pattern 'userAgent='`。
  单项仍可用 `origin` / `referer` / `userAgent`（或 `ORCA_ORIGIN` / `ORCA_REFERER` / `ORCA_USER_AGENT`）覆盖。
- smoke 新增 16/17 组：身份口径与请求头拼装，含「绕过 `buildConfig` 手搓 config 时不得发出
  `undefined`」的回归。

### Fixed
- **`cgiHeaders` 的 cookie 回退分支写死了 `api.orcaterm.com`**：v0.3.1 换默认 host 后，
  当 `credential.cookieHeader` 为空、需要回退到按域取 jar cookie 时，会去取**错域**的 cookie。
  现按实际 `cgiBase` 的 host 取；`assistantHeaders` 同样改用统一的 `hostOf()`，
  不再 `new URL()` 直接抛。这是本轮改动暴露出的既有缺陷，与身份无关。

### Notes / 未做
- `clientIdentity` 已进 `MANAGER_KEYS`：它影响后端进程发出的头，改动需重启后端。
- UA 里的 Chrome/Edge 版本随 WebView2 升级而变，是**本机当前值**，不是恒定常量。
- 本轮活体回归中途出现过 `fetch failed` / `terminated`：先用独立计数排除嫌疑 ——
  CGI 通道旧/新 UA 各 10 次全成功，助手通道旧/新身份各 4 次全成功，与本次改动无关，
  是上游/网络的瞬时抖动；重跑后 `desktop` 与 `web` 两种口径均 16/16。

## [0.3.1] - 2026-10-24

用户指出：反代的**后端访问端点不对 —— 用的是网页版推导出来的那个，不是 OrcaTerm 这个封装好的软件实际访问的那个**。查证后确认属实，并修正默认值。

### 结论：不是「端口」问题，是 **host** 问题

先把容易走偏的三点排掉（都有实测证据）：

1. **桌面端没有监听任何本地端口。** `OrcaTerm.exe`（PID 16296）当时**零个 TCP/UDP 端点**；
   全机 LISTEN 列表里也没有 1420 / 1430 / 5180。
2. **1420 / 1430 / 5180 是 Tauri 开发服务器来源，不是生产 API。** 它们只出现在 exe 内嵌的
   **CSP** 里（`script-src` / `worker-src` / `child-src` 白名单，形如 `http://127.0.0.1:1430/**`）
   和图标路径 `http://127.0.0.1:5180/icons/128x128.png`；生产环境 webview 的 origin 是
   `http://tauri.localhost`（Rust 日志实测）。
3. **缓存里出现的 `127.0.0.1:10808` 是本机 v2rayN 代理**，出现在腾讯边缘节点回包的响应头里，
   与 OrcaTerm 无关。

真正的差异是**控制面 host**：

| | CGI 控制面 host | 依据 |
| --- | --- | --- |
| **网页版** | `https://api.orcaterm.com` | 网页端 bundle `orcaterm_start.zh.*.js` 里是**推导式**：<br>`"".concat(location.protocol, "//api.").concat(location.host)` + `/cgi/api?`<br>—— 网页跑在 `orcaterm.com` 上时，正好推出 `api.orcaterm.com` |
| **桌面端** | `https://api.orcaterm.cloud.tencent.com` | 桌面端前端 bundle 里**硬编码**的唯一 API 常量 |
| 助手通道 | `https://lightai.cloud.tencent.com` + `/assistant` | 桌面端常量与 Tauri cookie jar（`lightai.cloud.tencent.com`）一致 —— **这一条插件本来就是对的** |

证据链（桌面端产物，全部只读）：

- `OrcaTerm.exe`（43.3 MB）里 `api.orcaterm.com` 出现 **0 次**，`api.orcaterm.cloud.tencent.com` **1 次**；
- WebView2 缓存 JS（`Code Cache/js/3907231ce2eaa8e3_0`）中该常量唯一出现，邻近字符串为 `//api` 与 `/cgi/api?`；
- WebView2 的 HTTP 服务器属性表（= 桌面端 webview 真连过的 host）里有 `orcaterm.com`、`lightai.cloud.tencent.com`、`cdn.orcaterm.tencent-cloud.com`、`cloudcache.tencent-cloud.com`，**没有 `api.orcaterm.com`**；
- 桌面端区域/host 表另含 `orcaterm.cloud.tencent.com` / `.cn` / `.com.cn`、`orcaterm.intl.cloud.tencent.com`、`orcaterm.com`、`127.0.0.1`；
- exe 内嵌更新清单走 `https://orcaterm.com/cgi/api?action=CheckDesktopUpdateManifest…`。

### Changed
- **`cgiBase` 默认值改为桌面端的 `https://api.orcaterm.cloud.tencent.com`**（原 `https://api.orcaterm.com`）。
  - 仍可用配置项 `cgiBase` 或环境变量 `ORCA_CGI_BASE` 换回网页版口径，注释里写明了两种口径的来源。
  - `/health` 的 `cgiBase` 字段可直接确认当前用的是哪一个。
- 版本号 `0.3.0` → `0.3.1`（`package.json` 与 `backend/server.js` 的 `VERSION` 同步）。

### Verified
- 五个候选 host 用真实凭据逐个实测：`api.orcaterm.com`、`api.orcaterm.cloud.tencent.com`、
  `orcaterm.cloud.tencent.com`、`orcaterm.cloud.tencent.cn`、`orcaterm.com` **全部 200 且无上游 Error**；
  其中两个 `api.*` host 返回相同的用户 AI 设置，三个非 `api` host 返回另一套默认模型
  （`hunyuan_appcreate_agent`），说明 `api.` 前缀确实是另一个 API 面。
- 逐 action 对比两个 `api.*` host：桌面端 host 全部成功（139–7417ms）；网页版推导式 host
  在本轮出现 2 次 `fetch failed`（此前同 action 曾 2673ms 成功），稳定性不如桌面端 host。
- 切换后 `npm test` 全绿；`/health` → `cgiBase=https://api.orcaterm.cloud.tencent.com`；
  `/v1/models` 仍恰好 5 项；活体回归 **16/16 通过**。

### Notes / 未做
> ⚠️ 本节两条已在 [0.3.2] 更正，保留原文以便追溯：第 1 条已于 v0.3.2 实现（`clientIdentity`），
> 且实测两个通道都不校验这些头；第 2 条**归属错误**——`region`/`withClientUA`/`API_HOST`
> 只存在于腾讯云控制台通用 `web_sdk`，不在 OrcaTerm 自己的 CGI 路径上。

- 桌面端的 `Origin`/`Referer` 是 `http://tauri.localhost`，插件仍沿用 `https://orcaterm.com/terminal`。
  实测调用不受影响，故本轮**未改**；若将来出现签名/风控类拒绝，这里是第一个该试的开关。
- ~~桌面端 CGI 请求会带 `&region=`、`&withClientUA=1`、`&withClientIP=1`，网页端另有
  `?i=region/<Action>` 形态。插件目前只带 `action`/`uin`/`ownerUin`，实测够用；
  未验证这些参数是否影响限流或路由精度。~~ —— 见上方更正。

## [0.3.0] - 2026-10-24

本轮来自 `session-fc7c2c2f-6d9e-48d1-8c25-6ec3b06c7b1c` 的实测复盘：正文反复出现前几轮对话、同一个工具调用被重复下发 4 次。根因全部在真机复现并修掉，且都有回归测试。

### Added
- **`backend/agent-protocol.js`（新模块）**：把可单测的协议逻辑从 `server.js` 里拆出来，测试不再复制实现。
  - `createGreetingStripper()` —— 问候语流式前缀剥离（原内联逻辑，行为不变）；
  - `createRepeatStripper()` —— **历史回放剥离器**；
  - `createDeliveredHistory()` —— 会话级「已交付正文」环形记忆（LRU，默认留最近 6 轮 / 20K 字符 / 64 会话）；
  - `classifyCommandShell()` / `wrapCommandForShell()` / `resolvePosixShell()` —— 单 shell 判定与改写；
  - `splitCommandChain()` / `parseCdSegment()` / `toWindowsPath()` / `rewriteCommandChain()` / `describeShellRouting()` —— **混合语法命令的逐段路由**；
  - `resolveDshToolCall()` / `parseToolEnvelope()` —— 工具信封解析与 DSH 契约映射（从 `server.js` 迁入）；
  - `describeExecutionHost()` —— 生成写进上游提示词的执行环境自述。
- **`lib/context.js`（新模块）**：**上游会话上下文与 DSH 消息历史的对账**。
  - `fingerprintMessages()` —— 非 system 消息的逐条指纹（忽略 system，因为 DSH 系统提示词每轮可能带动态内容）；
  - `createContextTracker()` —— 判定 `fresh` / `continue` / `resync`。
- **`conversationMaxRounds` 配置项**（默认 `40`）：上游同一会话最多连续多少轮，超过就换新会话并补发历史（`0` = 不限制）。
- **`sendHistoryMessages` 配置项**（默认 `false`）：是否把 DSH 多轮历史发进 `input.historyMessages`。同步更新 `cordis.patch.yml`、`MANAGER_KEYS`（改它要重启后端）与 `--send-history` / `ORCA_SEND_HISTORY=1` 命令行开关；**仅用于对比排障**。provider 的上下文对账在判定需要换会话时会逐轮覆盖它（请求体 `orca_send_history`）。
- **执行环境自述注入**：`assistantBody` 的 `emphasisPrompt` 现在会带上本机真实环境（Windows → 「命令由 PowerShell 7 执行，请只用 PowerShell 语法；POSIX 风格的命令会被自动转交给本机 Git Bash」），从源头减少模型把命令写成另一个 shell 的语法。

### Fixed
- **工具结果根本没送到上游（这是「工具没有真正跑起来」的主因）**：`lib/openai.js` 的 `formatOpenAiMessages()` 把 `role:'tool'` 当成「未知角色」丢掉，同时把 assistant 消息里的 `{type:'tool-call'}` 内容块当「非文本 block」丢掉。结果是 DSH 明明执行完了工具，送到上游的请求里**既没有那次工具调用、也没有它的结果** —— 上游只能按同样的参数再发一次工具调用，于是死循环。
  - 复现（`provider-probe.mjs`，用 DSH 原生消息形态驱动真实适配器）：
    ```
    [warn] 丢弃非文本 block（type=tool-call）
    [warn] 忽略未知角色 "tool"
    第二轮有没有重复调用同一工具? 有（= 结果没被上游接受）
    ```
  - 修复：`flattenContent()` 把 `tool-call` 块翻成 OpenAI `tool_calls`，`role:'tool'` 翻成 `{role:'tool', tool_call_id, content}`（`reasoning` 块仍有意不回灌）。修复后同一探针：
    ```
    第二轮有没有重复调用同一工具? 没有  正文: "当前工作目录下共有 3 个项目：- AITask - work - dsh-client-config …"
    ```
  - 这一条独立于 shell 问题：**修好它之后，工具轮才第一次真正闭环**。
- **正文反复出现以前的对话内容（根因）**：`input.historyMessages` 会被上游 LightAI 网关**逐条原样回灌**成 `type:"ai"` 帧，位置在正式回答之前：
  ```
  data: {"id":"<uuid>","type":"human","content":"<上一轮用户话>"}
  data: {"id":"<uuid>","type":"ai","content":"<我们发上去的那段 assistant 正文>"}   ← 回灌
  data: {"id":"chatcmpl-<uuid>","type":"ai","content":"…正式回答…"}
  ```
  代理只过滤 `type:"human"`，回灌的 `ai` 帧会被当成正文；而下一轮的历史又包含「上一轮已被污染的正文」，重复逐轮叠加。
  - 决定性证据（`dupe.mjs` 探针，同一 conversationId 且已有服务端上下文时重发历史）：上游共回 3 组消息，其中 `ai` 组 182 字符与上一轮正文逐字相同；反证探针 `replay-probe.mjs` 确认该行为至今仍在，故干净正文确实是代理剥离的结果；
  - **修复**：默认不再发历史。上游凭 `conversationId` 自己保上下文——实测第二轮 `{TOOL_RESULT}` 被正常接受并转入 `action:"completion"`，第三轮（不带任何历史）仍能正确引用前两轮结论，故历史既多余又有害；
  - **二次保险**：`createRepeatStripper` 按会话记住已交付正文，在新一轮输出开头整段吃掉重复内容。即使把 `sendHistoryMessages` 打开，正文也不再回放。
- **工具信封被回灌正文带偏、甚至丢掉**：当上游在信封前先回灌历史时，`finishUnwrap` 的兜底分支会把「回灌正文 + 工具信封 JSON」整段当正文吐出去，`tryToolEnvelope` 因前缀不是 JSON 而失败——**既重复正文又丢掉工具调用**。由上一条的修复 + 剥离器解决（`toolreplay.mjs` 验证：`finish=tool_calls`、1 个干净工具调用、正文 0 字）。
- **命令被交给了错的 shell 解释**：上游按 Linux 主机写命令（`ls -la && git rev-parse …`），实测会话里模型则写了 cmd 写法（`dir /b`、`2>nul`），而两者都被送进 DSH 的 `pwsh`：
  - `dir /b` 在 PowerShell 里被解析成路径 `C:\b` → `Get-ChildItem: 找不到路径"C:\b"`；
  - `2>nul` 在 PowerShell 里会真的建一个叫 `nul` 的文件；
  - 输出不可用 → 模型拿不到有效结果 → 用完全相同的参数重发同一个工具调用。
  - 修复（单 shell）：`classifyCommandShell()` 按「PowerShell 特征 > cmd 特征 > POSIX 特征 > 默认 PowerShell」判定，`wrapCommandForShell()` 做等价改写：
    - cmd → `& 'C:\Windows\system32\cmd.exe' /c '<原文>'`（整体单引号包住，否则 PowerShell 7 会先把自己的 `&&`/`||` 解析掉）；
    - POSIX → `& 'C:\Program Files\Git\bin\bash.exe' -lc '<原文>'`（本机没有 POSIX shell 时如实退回不包装，不谎报成功）；
    - PowerShell → 原样放行。
  - 真机验证：`& '…cmd.exe' /c 'cd C:\AITask && dir /b /ad && echo ''---done---'' && git status --short 2>nul || echo not-a-git-repo'` 在 PowerShell 7 下正确输出目录清单与 git 判定；`& '…bash.exe' -lc "ls -la | head -5 && git rev-parse --is-inside-work-tree 2>&1"` 同样正常。
  - `execute_command` 在原生有 `bash` 的 DSH（Linux/macOS）上直接映射 `bash`，不再绕 PowerShell。
- **混合语法命令只能整体交给一种 shell（`cd x && dir /b && ls -la` 必有两段走偏）**：`rewriteCommandChain()` 现在按顶层操作符切段、逐段路由，再用 PowerShell 7 的 `&&` / `||` / `;` 重新串联：
  - 引号内的操作符不切；单个 `|` 不切（管道两侧必须在同一 shell 里才有意义）；
  - `cd` 段改写成 `Set-Location`：实测**子 shell 会继承 PowerShell 进程的当前目录**，因此后续 `cmd /c` 与 `bash -lc` 段自动落在同一目录（`cd C:\AITask && dir /b /ad && ls -la` 实测两段输出都在 `C:\AITask`）；
  - MSYS 盘符路径可翻译（`/c/AITask` → `C:\AITask`）；`/tmp` 这类 Git Bash 虚拟路径落点依赖安装配置，**不猜** —— 整条链退回单 shell，并优先退到 posix，让 `cd` 至少是对的、后续段报出可读的 `command not found`，而不是静默切错目录；
  - 路由结果写进工具 description（如 `[shell=composed:powershell+cmd+posix]`），判错时一眼能看出走了哪条路。
- **上游上下文与 DSH 侧的压缩/改写脱钩**：默认不发历史后，上下文由上游按 `conversationId` 维护，DSH 的压缩/编辑不会同步上去，上游会话丢失也无法自愈。新加 `lib/context.js` 按消息指纹前缀对账：
  - 追加轮 → `continue`（沿用上游上下文，不补发历史）；
  - 列表变短 / 前缀对不上 / **原样重发（重试）** / 轮数超上限 → `resync`：换一个新会话并一次性补发 DSH 的历史，把压缩结果同步上去并给上游上下文瘦身；
  - **工具结果轮永远 `continue`**：上游还挂着待办的工具调用，换会话会让它变成孤儿；
  - 实测：压缩后（列表只剩一条摘要）`resync` 到 `cid-dsh-…-r2`，模型仍能回答出摘要里的内容，证明改写后的历史确实送达了新会话。

### Verified
- `npm test`：`config_check` + `smoke` 全绿；smoke 扩到 **15 组**，新增：DSH→OpenAI 消息转换（工具结果必须活下来）、混合语法命令链切分与逐段路由、上下文对账判定；另有重复剥离（含逐字符分片、只相似非重放、空历史直通）、已交付正文记忆、shell 判定、命令改写、工具映射、环境自述。
- **可重跑的活体回归 `test/live_regression.mjs`**（`npm run test:live:regression [baseUrl]`，需要反代在跑 + 有效登录态），共 **16 项断言**：
  - A 回放剥离、B 工具信封、C 工具结果被接受、D **provider 契约（DSH 原生 tool-call/tool 消息）**、E **上下文对账（fresh/continue/resync）**；
  - 对 `http://127.0.0.1:8793` 跑通 **16/16**；
  - 脚本最后会打印本轮下发的真实命令，便于在本机直接执行验证「确实跑了」。
- 缺陷复现/修复对照（都是先复现再修）：
  - `provider-probe.mjs`（DSH 原生消息形态驱动真实适配器）：修复前第二轮**重发同一工具调用、零正文**；修复后**有正文、不重发**；
  - `ctx-probe.mjs`：首轮 `fresh` → 追加 `continue`（不补发历史）→ 原样重发 `resync`（换到 `-r1`）→ 压缩后 `resync`（换到 `-r2`，仍能答出摘要内容），9/9 通过；
  - `check.mjs`：混合语法 `cd C:\AITask && dir /b /ad && ls -la | head -4` 真机执行，cmd 与 bash 两段输出都落在 `C:\AITask`。
- 反证探针：确认上游**至今仍会回灌**历史（6 组消息、含 98 字符的上一轮正文原文），故干净正文确实是代理剥离的结果，而不是上游改了行为。

### Notes / 未做
- **不需要本地 SSH 服务**（本轮评估结论）：OrcaTerm 的原生设计是「桌面端连主机、云端下命令、客户端执行」。但本插件走的是 DSH 本机工具执行，命令**本来就在本机真实执行**；fc7c 会话里 8 次 `tool/call` 对应 8 次 `job/registered` + 8 次 `job/settled`，执行链是通的。真正卡住的先是「工具结果根本没发出去」（上文的 `role:'tool'` 丢弃），再是「命令写给了错的 shell」。走 DSH 工具还意味着**仍受 DSH 自己的审批与沙箱策略约束**，而自建 SSH + 桌面端执行会绕开这层约束。
- 上游上下文仍以服务端 `conversationId` 为主（省掉逐轮重发历史），DSH 的压缩/改写通过 `resync` 换会话 + 补发历史来同步；上游自身是否另外做摘要仍未验证。
- 逐段路由是字符串级启发式，不实现完整 shell 文法（例如 bash 的 `case`/`[[ ]]` 内部含 `;` 仍可能误切）；`/tmp` 这类 Git Bash 虚拟路径的 `cd` 不做翻译。两者都会退回单 shell 并在 description 里标 `fallback`，不假装成功。

## [0.2.0] - 2026-10-24

### Added
- **精简并精准核实 OrcaTerm 核心 5 模型矩阵（去除旧版冗余与别名）**：
  - 将模型目录彻底精简为用户选定的 5 个核心模型，完全对齐真实规格：
    1. `DeepSeek-V4.1-Flash` (`deepseek-v4.1-flash`)：思考模式 Max/High/Low，**图片识别（多模态）**，**1M 超长上下文**，客户端默认首选；
    2. `Hy4-preview` (`hy4-preview`)：思考模式 High，**1M 超长上下文**；
    3. `Hy3` (`hy3`)：思考模式 High/Low，128K 上下文；
    4. `Kimi-K3` (`kimi-k3`)：思考模式 Max/High/Low，**图片识别（多模态）**，**1M 超长上下文**；
    5. `GLM-5.3-Flash` (`glm-5.3-flash`)：思考模式 Max/High/Low，**图片识别（多模态）**，当前按用户提供值申报 300K（并非已测得的上限）；
  - 真实 session 负载回放：`session-2987fd6a-64f6-4267-8313-cf6f81fcef43` 原 provider 记录峰值 453,653 输入 tokens 和 325 个工具定义；重建 307 条消息与相同工具定义，经 GLM-5.3-Flash 路由成功完成，无 context-length 错误。
  - 原 session 的 token 计数来自另一个 provider；LightAI 没有返回 GLM 精确 usage 或硬上限，因此此次测试说明该真实请求负载可接受，但不能确定 GLM 的准确最大上下文，也不能把 300K 当作上限。
  - 旧桌面端设置中的 `deepseek-v3::deepseek-v4.1-flash` 只映射为五项中的 DeepSeek-V4.1-Flash 默认项，`/v1/models` 不再额外返回第六个 legacy ID。
  - GLM 实测：用 `session-2987fd6a-64f6-4267-8313-cf6f81fcef43` 重建的真实消息与 325 个工具 schema，经 GLM-5.3-Flash 路由成功完成；原 provider 记录 453,653 input tokens，但 LightAI 不提供 GLM token usage，故 300K 仅为申报值，最大上下文未知。
- **突破 OrcaTerm 封闭生态，实现与 DSH 工具系统的全双工双向桥接（Major Architectural Breakthrough）**：
  - **根因深度审计与推翻**：深入逆向 OrcaTerm Web 前端 bundle（`orcaterm_start_core` 与 `orcaterm_app`）的内部模块 2481 与 72535，彻底弄清了 OrcaTerm Agent 的真实工具调用协议。此前上游之所以「不响应 tools / 报 undefined / 陷入问候循环」，不是网关不可逾越的边界，而是因为：
    1. 前端协议从不传 OpenAI 的 `tools` 字段，而是依赖 `user.setting.uiServers`（客户端执行的 UI 工具）与 `selectedUITools`。此前插件把这些全部传了空数组/空对象，导致模型被剥夺了调用工具的能力。
    2. 上游 `mcpServers` 是云端自主沙箱，因没有远程主机连接而直接返回 undefined 并在首轮自行下发 `completion`；而 `uiServers` 则明确通知云端由**客户端本地执行**，云端下发 `review` 动作后会立即挂起流并等待客户端回报。
    3. 工具结果返回时，上游要求使用 `{TOOL_RESULT}(toolName): output` 标签语法且请求类型为 `type: "ask"`，此前直接作为普通对话历史发送，导致模型无法识别工具返回值。
  - **客户端 UI 工具集激活**：
    - `backend/upstream.js` 在 `user.setting` 中正式注入 `uiServers: ['orcaterm']`、`selectedUITools` 与 `approvedTools`（`execute_terminal_command`, `remote_read`, `remote_write`, `remote_edit`, `remote_glob`, `remote_grep`, `list_terminals`），且保持 `mcpServers: []`，确保工具调用权完整交还给 DSH 客户端，绝不触发云端未绑主机的自动执行。
    - 注入 `emphasisPrompt` 强指令，指导模型在面临运维任务时必须调用工具执行，彻底消除模型在多轮对话中「假装审核完成」的幻觉。
  - **智能工具语义映射器 (`resolveDshToolCall`)**：
    - 在 `backend/server.js` 中构建双向映射：
      - `execute_command` / `execute_terminal_command` / `run_commands` 自动映射为 DSH 本机的 `pwsh`（Windows 环境）或 `bash`（Linux/macOS 环境），并将命令与描述参数自动组装；
      - `remote_read` 映射为 DSH `read` (`file_path`)；
      - `remote_write` 映射为 DSH `write` (`file_path`, `content`)；
      - `remote_glob` 映射为 DSH `glob` (`pattern`)；
      - `remote_grep` 映射为 DSH `grep` (`pattern`)；
      - 若 DSH 声明了同名工具则原样透传。
    - 伴随工具调用下发标准 OpenAI `tool_calls` delta 及 `finish_reason: "tool_calls"`，精准触发 DSH Agent 循环的本地工具执行阶段。
  - **工具返回结果逆向装配 (`toAssistantInput`)**：
    - 当 DSH 本地执行完毕返回 `role: 'tool'` 消息时，`toAssistantInput` 自动捕获前序 `tool_call_id`，将结果重构为 OrcaTerm Agent 协议标准的 `{TOOL_RESULT}(execute_command): <output>`，并将请求 `type` 动态置为 `ask`。
    - 模型接收到真实的本机执行结果后，顺利推进至下一阶段生成最终报告，`finish_reason` 输出 `stop`。

### Verified
- 实测端到端验证：
  - Turn 1：提问查看目录 -> 模型触发 `execute_command` -> 映射并下发 DSH `pwsh` tool_calls -> finish_reason 为 `tool_calls`。
  - Turn 2：DSH 本机执行 `pwsh` 并回传目录输出 -> 逆向装配为 `{TOOL_RESULT}` -> 模型成功解析真实文件列表并输出格式化表格，finish_reason 为 `stop`。
- 完整闭环，真实可用！

## [0.1.4] - 2026-10-24

### Fixed
- **思维链（reasoning）透传打通**：
  - 根因一：`assistantBody` 把 `enableThinking` 硬编码为 `false`（`config.enableThinking === true`，配置从未暴露）。改为缺省 `true`，并跟随 OpenAI 请求的 `reasoning_effort`/`reasoning` 字段动态开关。
  - 实测：`deepseek-reasoner` 回传 883 字符 `reasoning_content`，provider 层已有 reasoning-delta → DSH 思考气泡渲染。注：`deepseek-chat-latest` 等非推理模型本身无思维链，属模型能力而非插件缺陷。
- **工具声明透传链路修复**：
  - provider 层此前把 DSH 工具 schema 完全丢弃（只打警告、`x-orca-tools: ignore`）。现改为 `formatOpenAiTools` 结果放进请求体 `tools` 字段，反代 `toUpstreamTools` 过滤转换后透传给上游 Agent 网关的 `user.setting.tools`。
  - 上游自身执行的工具帧（`item.tool`）从静默计数改为可见正文行（`> ⚙️ [上游工具] …`），让「上游在干什么」对用户可观测。
  - **上游能力边界（实测结论）**：OrcaTerm Agent 网关忽略外部 function schema（tools 字段已确认送达但模型不响应），其命令执行绑定自家 MCP 生态且需会话内已连接服务器；DSH 场景下工具调用仍不可用，纯问候/寒暄轮次上游还会回问候语信封。
- **SSE 中途崩溃导致进程退出**：
  - `session-62714398` 期间 reasoner 测试触发 `ERR_HTTP_HEADERS_SENT` 崩溃（异常处理路径对已 writeHead 的流式响应再次写 JSON 状态行）。`json()` 与顶层 catch 现在检查 `res.headersSent`，SSE 中途出错直接终结连接。

### Verified
- `deepseek-reasoner` 思维链流式透传（883 字符 reasoning）。
- tools 字段确认送达上游（抓包 body 验证），上游忽略为能力边界非插件丢失。
- `npm test` 全绿；进程崩溃路径修复。

## [0.1.3] - 2026-10-24

### Fixed
- **解决 `session-2827878b` 首轮问候语泄漏（第三种问候形态）**：
  - 上游会把问候语作为**正文前缀**拼在回复最前面（含新变体：「…腾讯云云端服务器运维专家」「…遨驰终端内置的…」等，结尾统一为「需要什么帮助？」），且会嵌在 `taskCompletion` 值内部或 fenced 信封正文的开头。
  - 新增 `stripGreeting` 流式前缀剥离器（`backend/server.js`）：分片边界安全（前缀/结尾标记均可跨分片命中），300 字符超长兜底防止吞正文；剥离的问候语记录在 `greetingStripped`。
  - 纯问候语回合（剥离后零正文、零工具调用、未向客户端写过任何字节）：把剥离的问候语原样吐回——寒暄应答寒暄，避免 DSH 侧 EMPTY_RESPONSE 误报。已验证上游对寒暄类首轮**无条件**回问候语，提示词压制与伪造历史均无效，吐回是唯一正确策略。
- **解决 `action: "review"` 等 MCP 工具调用信封泄漏**：
  - 上游第三种动作信封 `{"action":"review","tool":{"type":"mcp","name":"execute_command","args":{...}}}` 原样透传成 ```json 代码块。
  - 新增 `tryToolEnvelope` / `emitToolCall`：拦截 `action + tool` 结构信封，转成 OpenAI `tool_calls` 流式 delta；fenced 匹配改为贪婪模式修复嵌套 `args:{...}}` 截断。
- **`lib/provider.js` 工具调用渲染**：
  - 丢弃 tool_calls 的旧逻辑替换为 DSH `tool-call` 内容块转换（`block-end` + `{type:'tool-call', id, name, arguments}`），DSH Web 端可渲染工具调用卡片。
  - 有工具调用时 finish reason 输出 `tool-calls`（对齐 `@deepseek-ai/dsh-llm` `FinishReason` 契约）；纯工具轮不再误判 EMPTY_RESPONSE。
- **正文统计口径修正**：
  - 新增 `emittedText` 作为「真正下发给客户端的正文」的权威计数（问候语剥离前 `full` 口径错误导致空回合判断永不成立）；非流式响应 `content` 改用 `emittedText`。
  - 流式响应头改为惰性初始化（`beginStream`），空轮判定与吐回兜底可在首字节前完成。

### Verified
- 真实上游端到端回归：fenced completion 信封 + 问候语前缀 + 嵌套 args 的混合流 → 无问候语、无代码块泄漏、正文完整保留（3 项 PASS）。
- 寒暄首轮 → 问候语剥离后吐回，非空。
- 离线 `npm test` 全绿（新增第 6 节：剥离器分片边界 / 变体结尾 / 非问候放行 / 工具信封识别 / 非信封不误伤回归）。

## [0.1.2] - 2026-10-24

### Fixed
- **解决提问工具 (`action: "ask"`) 原始 JSON 泄漏问题**：
  - OrcaTerm Agent 的响应除了正常回答 (`action: "completion"`, 字段 `taskCompletion`)，还包含向用户反问澄清的提问工具 (`action: "ask"`, 字段 `question` 与 `options`)。
  - 重构了 `backend/server.js` 中的流式状态机，同时监听并精确提取 `taskCompletion` 与 `question` 字段内部的正文，剥除外层 JSON 包装及 Markdown 代码块语法。
  - 若 `ask` 工具附带 `options` 选项数组，自动排版为清晰的 Markdown 列表追加至正文末尾。
- **解决正文反复出现重复问候语的问题**：
  - 拦截 OrcaTerm Agent 发送的草稿撤销帧（`id: "remove-*"`），在撤销事件到达且尚未正式输出有效字段时重置缓冲区，彻底避免上游将未提交的初始问候语混入最终正文。
  - 修复 `toAssistantInput` 的消息切分逻辑：准确定位最后一个 `assistant` 消息，其后的多条消息（包括系统提示、用户提问、上下文快照）均合并为当前轮次输入，历史轮次仅包含完成交互的交替消息，消除上游回显多段历史导致的级联重复。
- **Token 自动保活与平滑回退**：
  - 新增 `decodeJwtExp` 函数，比对 JWT 的真实有效截止期。
  - 当手工配置的 `assistantBearer` 过期后，系统自动回退到 OrcaTerm 桌面端实时刷新的 `.cookies` 文件中的 `ot_session`，无需人工频繁换取 Token。
  - 给 LightAI 网关连接增加了自动网络重试（3次），化解偶发的 TLS 握手 reset (`ECONNRESET`)。

## [0.1.1] - 2026-10-24

### Added
- **LightAI 助手双重鉴权支持**：
  - 适配了网关同时校验 `Cookie`（含 `skey`、`uin`、`saas_synced_session`）与 `Authorization: Bearer <assistantBearer>` 的复杂鉴权模型。
  - 增加了 `~/.dsh/orca-credentials.json` 自动解析机制。
- **Agent 协议初版流式状态机**：
  - 初步实现了从 OrcaTerm Agent 的 SSE 流中实时提取 `taskCompletion`，过滤非 AI 历史回显。

## [0.1.0] - 2026-10-24

### Added
- **首次发布**：
  - 实现基于 Node.js 原生的本地反代服务（`backend/`），端口 `8793`。
  - 逆向并打通 OrcaTerm 桌面端凭据解析（`data.bin` 与 `.cookies`）。
  - 实现 CGI 控制台通道与模型列表查询（`DescribeUserAiSetting` / `DescribeAIModelList`）。
  - 实现原生 `LlmAdapter`，成功作为 `orcaterm-web-api` 路由接入 DSH Web 模型选择器。
  - 交付 `install.ps1`、`test/config_check.mjs` 与 `test/smoke.mjs`。
