# dsh-orchaterm-web-api (OrcaTerm / 腾讯或壳终端反代 Provider 插件)

将本机已安装并登录的 OrcaTerm 桌面端（`OrcaTerm.exe`）所承载的云端终端与 AI 模型能力，反向代理为本地 OpenAI 兼容端点，并作为 LLM Provider 接入 DeepSeek Harness (DSH) 客户端模型选择器。

> **架构原则：**
> 1. 本插件**仅注册 Provider（作为模型大语言模型路由）**，不污染全局工具列表。
> 2. 反代服务采用**零依赖 Node.js (>=20)** 原生实现，随插件自带打包（`backend/run.js`），无需外部 Python 虚拟环境或二次编译构建。
> 3. 插件负责全自动的子进程管理（`autoStart` / `killTreeOnDispose` / 管道守护 / `/health` 探活与契约自省）。

---

## 核心设计与逆向分析发现

本插件基于对 OrcaTerm 1.6.6 桌面端（Tauri + WebView2）及线上 Web 版 bundle 的深入逆向分析开发：

1. **凭据来源**：
   - 桌面端数据持久化在 `%APPDATA%\com.orcaterm-desktop.app\data.bin`（明文 JSON，包含 `oauth_access_token` JWT、`userId` 等）和 `%LOCALAPPDATA%\com.orcaterm-desktop.app\.cookies`（Tauri Cookie Jar，包含 `ot_session` 与 `sid`）。
   - 插件后端会自动探测并读取本地登录态，并在日志与接口中执行严格脱敏。
2. **通道分离与上游鉴权**：
   - **CGI 控制台通道**（桌面端口径：`https://api.orcaterm.cloud.tencent.com/cgi/api`）：
     - 认桌面端的 Bearer JWT 和 `ot_session` Cookie。
     - 支持获取用户身份（`GetUserInfo`）、用户 AI 配置（`DescribeUserAiSetting`）、模型列表（`DescribeAIModelList`）、会话管理（`DescribeConversationList`）等，**本机测试全部 100% 连通通过**。
     - ⚠️ **host 分两种口径（v0.3.1 修正）**：桌面端前端 bundle 里硬编码的是
       `api.orcaterm.cloud.tencent.com`；而 `api.orcaterm.com` 是**网页版按
       `location.protocol + "//api." + location.host` 推导出来的**（网页跑在 `orcaterm.com` 上时正好得到它）。
       桌面端产物里 `api.orcaterm.com` 一次都没出现，所以默认值取桌面端那个。
       要换回网页版口径：配置项 `cgiBase` 或环境变量 `ORCA_CGI_BASE`；`/health` 的 `cgiBase` 字段可确认当前用的哪个。
     - 附：桌面端**没有监听任何本地端口**（`OrcaTerm.exe` 零 TCP 端点）；exe 里的 `1420/1430/5180`
       只是 Tauri 开发服务器的 CSP 白名单，不是生产 API。
   - **Assistant AI 对话通道**（`https://lightai.cloud.tencent.com/assistant/chat`）：
     - 基于 SSE 流式传输，上游要求 `Cookie`（含 `uin`、`skey` 等）结合 `authorization: Bearer` 双重鉴权。
     - 凭据现由 `~/.dsh/orca-credentials.json` 与本地桌面端持久化联合管理。插件具备**Token 寿命比对与平滑回退能力**，当手工传入的 Token 过期时，反代会自动从本地桌面端 `.cookies` 中拾取最新的 `ot_session` 实现免维护长效保活。
3. **Agent 协议动态解包与降噪机制**：
   - OrcaTerm 上游服务以运维 Agent 状态机组织输出，包含回答动作（`action: "completion"` / 字段 `taskCompletion`）与反问澄清动作（`action: "ask"` / 字段 `question`）。
   - 反代内核内置字符级流式状态机（`OrcaStreamFilter`），打字机式实时过滤外层 JSON 脚手架与 Markdown 语法围栏，拦截上游的历史反射（`type: "human"`）与草稿撤销帧（`remove-*`），杜绝重复问候语与协议标签泄露。
4. **上游历史回放的处理原则（v0.3.0）**：
   - 上游 LightAI 网关会把调用方发来的 `input.historyMessages` **逐条原样回灌**成 `type:"ai"` 帧（位置在正式回答之前），而它本身已凭 `conversationId` 保存上下文。
   - 所以反代**默认不发历史**（`sendHistoryMessages: false`），并额外用会话级「已交付正文」记忆做二次剥离（`createRepeatStripper`），确保同一段正文不会在下一轮再露一次脸。
5. **上下文对账：DSH 侧的压缩/改写如何同步到上游（v0.3.0）**：
   - 默认不发历史后，DSH 的压缩、编辑不会自动上去，上游会话丢失也无法自愈。`lib/context.js` 按消息指纹前缀比对，逐轮判定：
     追加 → `continue`（沿用上游上下文）；列表变短 / 前缀对不上 / 原样重发（重试）/ 轮数超 `conversationMaxRounds` → `resync`（换新会话 + 一次性补发 DSH 的历史）。
   - **工具结果轮永远 `continue`**：上游还挂着待办的工具调用，换会话会让它变成孤儿。
   - 只比对非 system 消息 —— DSH 的系统提示词每轮可能带动态内容（时间、目录等），算进来会让每轮都被判成「改写」而反复补发历史。

---

## 安装与接入 dsh web

### 1. 执行安装自检脚本
在插件目录下执行：
```powershell
cd C:\AITask\dsh-client-config\plugins\dsh-orchaterm-web-api
.\install.ps1
```
脚本会自动检查 Node.js 运行环境、探测 OrcaTerm 桌面端凭据有效性、启动本地反代验证 `/health` 与 `/v1/models`、并在 `~/.dsh/profiles/web/node_modules/` 建立软链接 (Junction)。

### 2. 启用插件并重启客户端
确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中包含 `dsh-orchaterm-web-api`。
退出并重新启动 DeepSeek Harness 客户端即可在模型选择器中看到 **OrcaTerm（反代）** 分组。

---

## 协议与工具系统适配 (v0.2.0 / v0.3.0)

1. **双向全双工工具调用系统**：
   - 逆向并打通了 OrcaTerm 的客户端 UI 工具系统（`uiServers: ['orcaterm']`）。当模型需要执行运维任务、命令或文件检索时，反代自动拦截上游 Agent 的 `action: "review"` 工具动作，智能映射为 DSH 本机工具（如 `execute_command` -> `pwsh` / `bash`，`remote_read` -> `read`，`remote_write` -> `write` 等），下发给 DSH 执行。
   - DSH 本机执行工具后，反代自动将工具输出重构为 `{TOOL_RESULT}(execute_command): <output>` 标签回传给上游，模型顺利读取真实机器数据并推进下一阶段。
   - **回传链的完整闭环（v0.3.0 关键修复）**：DSH 交给适配器的是 `role:'tool'` 消息（带 `toolCallId`）与 assistant 的 `{type:'tool-call'}` 内容块。此前 `lib/openai.js` 把它们分别当成「未知角色」和「非文本 block」丢掉，导致工具结果**根本发不到上游**，上游只能反复重发同一个工具调用。现在 `flattenContent()` 会翻成 OpenAI 的 `tool_calls` / `{role:'tool', tool_call_id, content}`。
   - **命令目标 shell 自适应（v0.3.0）**：上游按 Linux 主机写命令（`ls -la`），真实会话里模型偶尔写成 cmd 写法（`dir /b`、`2>nul`），而 Windows 上 DSH 只暴露 `pwsh`。反代按「PowerShell 特征 > cmd 特征 > POSIX 特征 > 默认 PowerShell」判定后改写：cmd → `cmd /c`、POSIX → 本机 Git Bash（`-lc`）、PowerShell → 原样。同时把本机真实环境写进提示词，让模型直接写对语法。判错 shell 时命令会以「路径不存在」这类形式静默走偏，所以**默认交给 PowerShell**是刻意的保守选择。
   - **混合语法逐段路由（v0.3.0）**：`cd x && dir /b && ls -la` 这种一条链里混了三种语法的命令，按顶层 `&&`/`||`/`;` 切段后**逐段**交给对应 shell，再用 PowerShell 7 的操作符串联。`cd` 段改写成 `Set-Location`（实测子 shell 会继承 PowerShell 的当前目录，后续各段自动落在同一目录）。路由结果写进工具 description，如 `[shell=composed:powershell+cmd+posix]`。
2. **多动作支持与问候语过滤**：
   - 完整支持上游的回答模式（`completion`）与提问反问模式（`ask`），反问选项自动格式化为 Markdown 列表。
   - 内置流式前缀剥离器，彻底消除上游无意义的初始问候语，纯寒暄轮次智能原样吐回。
   - 会话级重复正文剥离（v0.3.0）：同一段正文不会在下一轮再显示一次。
3. **思维链（Thinking）流式支持**：
   - 默认开启 `enableThinking`，使用 `Hy4-preview`、`DeepSeek-V4.1-Flash`、`Kimi-K3` 等支持思考模式的模型时，深度思考过程以 `reasoning-delta` 实时流式呈现在 DSH 思考气泡中。
4. **精选 5 大核心模型**：
   - `DeepSeek-V4.1-Flash`（默认，1M 上下文，支持图片）、`Hy4-preview`（1M 上下文）、`Hy3`（128K）、`Kimi-K3`（1M 上下文，支持图片）、`GLM-5.3-Flash`（申报 300K，支持图片）。
5. **模型 ID 兼容路由（证据边界）**：
   - 展示名直接发给 LightAI 会被拒（`LLM(...) is not loaded`），反代用 `backend/upstream.js` 的 `UPSTREAM_MODEL_MAP` 转到可加载的槽位。
   - 这些槽位与展示名的模型版本、能力是否严格等价，LightAI 未提供公开元数据，本插件也未做等价性验证；因此是**兼容路由**，输出质量可能与展示名有偏差。
   - `GLM-5.3-Flash` 的 300K 是按你提供值申报给 DSH 的 `contextWindow`，不是实测上限；实测中该路由能接受真实会话规模的负载，但 LightAI 不返回其精确 token 数或硬上限。
6. **客户端身份口径（v0.3.2）**：
   - `clientIdentity: 'desktop'`（默认）→ `Origin`/`Referer`/`X-Referer` = `http://tauri.localhost`，
     UA = 桌面端 WebView2 实测 UA（从 `%LOCALAPPDATA%\com.orcaterm-desktop.app\logs\orcaterm.log` 的 `userAgent=` 取）。
     依据：WebView2 History 里桌面端主页面就是 `http://tauri.localhost/`，而 OrcaTerm 代码写的是 `X-Referer: parent.location.href`。
   - `clientIdentity: 'web'` → `https://orcaterm.com` + `https://orcaterm.com/terminal`，即 v0.3.1 及之前的口径。
   - ⚠️ **实测：`/cgi/api` 与 `/assistant/chat` 都不校验这些头** —— 不带、乱填都返回 200 且 ai 帧数一致。
     所以这一项是「与真实客户端一致」，**不修任何故障**；改它的唯一实际意义是 UA ——
     上游将来若加客户端风控，`dsh-orchaterm-web-api/x.y.z` 这种一眼非浏览器的 UA 最容易被识别。
   - UA 里的 Chrome/Edge 版本随 WebView2 升级而变，是**本机当前值**，不是恒定常量。

---

## 官方语义移植（v0.4.0 / v0.5.0）

1. **工具结果官方协议（v0.4.0）**：DSH 执行完工具，反代按官方子 Agent 循环的信封回传
   `{type:'review', reviewAction:'reportToolResult', toolResult, tool}`（`tool` 为上游信封原件），
   对照实验证明模型精确消费结果（旧的 `{TOOL_RESULT}` 文本协议时吃时忽略）。
2. **流控制通道（v0.5.0）**：逆向 `orcaterm_start_core` 模块 2481 后移植 —— 会话 ID 放在路径段：
   `GET /stream/status/{cid}`、`GET /stream/resume/{cid}?offset=N`、`POST /stream/abort/{cid}`（空体）。
   **DSH 用户点停止时，反代在感知到客户端掐断且上游流未走完的情况下，自动补发
   `POST /stream/abort/{cid}`**（官方 stop = 本地断流 + 通知服务端，双动作）。管理端点：
   `POST /orca/stream-abort`、`GET /orca/stream-status?conversationId=`。
3. **回传重试官方参数（v0.5.0）**：工具结果轮 `attempts=3`、单次 15s 超时、退避 300→600→1200ms
   （`min(base·2ⁿ, max)`，模块 32804 公式 + @78376 实参）。
4. **工具结果脱敏（v0.5.0）**：官方客户端回传前必过 `Sn.fp` —— 14 条正则把 PEM 私钥、
   sk-/AKIA/ghp_/AIza/xox、JWT、URL 内嵌凭据、Bearer、敏感赋值、CLI 密码参数替换为
   `[已隐藏…]`/`***`（模块 35482 逐条移植为 `redactSecrets`）。上游看到的工具结果形态与官方一致。
5. **请求形态对齐（v0.5.0）**：`input.id` 与 `x-seqid` 同值；会话 ID 采用官方生成式
   `cid-<id>-orcaterm`（模块 72535：`cid-{id}-{assistant}`，mode 0=RE_ACT 不加后缀）；
   后端代执行结果帧（id 形如 `run-*-tool-*`）以带类别与脱敏摘要的可读行透出。
6. **UI 工具官方全集（证据）**：headless 15 项（官方免确认）+ foreground 8 项（需确认），
   见 `agent-protocol.js` 的 `UI_TOOL_HEADLESS`/`UI_TOOL_FOREGROUND` 与分类器
   `classifyUiToolCategory`；`selectedUITools` 仍只声明可映射到 DSH 工具的 7 项。

---

## 验证

```powershell
npm test                       # 离线：cordis/DEFAULTS 静态校验 + 24 组 smoke（消息转换、剥离、判定、路由、映射、身份、脱敏、流控制）
npm run test:live:regression   # 活体：需反代在跑 + 有效登录态，17 项断言，会让模型真发工具调用
# 凭据说明（v0.3.3）：token 临期/过期时反代自动重读 OrcaTerm 桌面端登录态，并在认证失败时自动重试一次；
# 只要桌面端开着就不用再手动重启反代。桌面端没开且 token 过期时报 AUTH 属预期。
```

`live_regression.mjs` 覆盖五段：回放剥离 → 工具信封 → 工具结果被接受 → **provider 契约（DSH 原生 `tool-call`/`tool` 消息）** → **上下文对账（fresh/continue/resync）**；
结束时会把本轮下发的真实命令打印出来，便于在本机直接执行确认「确实跑了」。
想连「重发历史」这条危险路径一起测，就对 `--send-history` 起的实例跑（例如 8794 端口）。

---

## 为什么不需要再拉一个本地 SSH 服务（v0.3.0 评估结论）

OrcaTerm 的原生设计确实是「桌面端连接主机 → 云端 Agent 下发命令 → 客户端在主机上执行」。但那套机制要解决的问题，本插件用另一条路已经解决了：

1. **命令本来就在本机真实执行**。`session-fc7c2c2f` 里有 8 次 `tool/call`，对应 8 次 `job/registered` + 8 次 `job/settled` —— 执行链是通的。
2. **当时真正卡住的是两件事，都不是执行通道**：① **工具结果根本没送回上游** —— DSH 的 `role:'tool'` 消息在 `lib/openai.js` 里被判成「未知角色」丢弃，上游收不到结果，只能按同样参数反复重发同一个工具调用；② **命令写给了错的 shell** —— `dir /b` 被 PowerShell 解析成路径 `C:\b`，输出全是错误信息。v0.3.0 的「回传链闭环 + 环境自述 + shell 自适应/逐段路由」解决的正是这两层。
3. **走 DSH 工具比自建 SSH 更安全**：命令是通过 DSH 自己的 `pwsh` 工具执行的，因此**仍然受 DSH 的审批与沙箱策略约束**；而「本地 SSH 服务 + 桌面端执行」会让命令绕开 DSH 这层管控，直接以登录用户权限运行。
4. 若将来确实需要真正的 POSIX 环境（例如上游坚持 Linux 语义而本机 Git Bash 不够用），更小的改动是让 DSH 暴露 `bash` 工具——`resolveDshToolCall` 已经优先走 `bash`，不需要引入 SSH。

> 本机已具备的条件（实测）：`C:\Program Files\Git\bin\bash.exe` 与 `wsl.exe` 均可用，故 POSIX 命令能跑；系统未安装 OpenSSH Server（`sshd` 服务不存在），自建 SSH 还需要额外开启系统可选功能。

