/**
 * OrcaTerm Agent 协议适配层：把上游 Agent 的私有对话协议翻成 DSH 能消费的形态。
 *
 * 这里只放**可单测的纯逻辑/有状态流式工具**，不碰网络与文件：
 *   1. 问候语剥离     —— 上游每回合正文前注入的产品欢迎语；
 *   2. 历史回放剥离   —— 上游把调用方传来的 historyMessages 原样回灌成 ai 帧（见下方说明）；
 *   3. 命令目标 shell 判定与改写 —— 上游按 Linux 主机写命令，本机却可能是 Windows；
 *   4. 工具调用解析   —— 上游 `{action,tool:{name,args}}` 信封 → DSH 本机工具契约。
 *
 * ## 历史回放为什么会发生（2026-10-24 实测）
 *
 * `assistantBody` 曾把 DSH 的完整多轮历史放进 `input.historyMessages`。上游 LightAI 网关
 * 会在正式回答**之前**，把这些历史逐条当作自己的消息重新推一遍：
 *
 *     data: {"id":"<uuid>","type":"human","content":"帮我检查工作目录"}
 *     data: {"id":"<uuid>","type":"ai","content":"<我们刚发上去的那段 assistant 正文>"}
 *     data: {"id":"chatcmpl-<uuid>","type":"ai","content":"…正式回答…"}
 *
 * 代理只过滤了 `type:"human"`，于是回放的 `ai` 帧被当成正文吐出来；而下一轮我们又把
 * 「上一轮那段已经混进回放的正文」继续作为历史发上去，重复就逐轮叠加。
 * 结论：**历史不该发**（上游自己按 conversationId 保存上下文）。本模块的重复剥离是
 * 二次保险：即便将来重新打开 historyMessages，同一段正文也不会在下一轮再露一次脸。
 *
 * @module backend/agent-protocol.js
 */

import { existsSync } from 'node:fs'

// ─────────────────────────────────────────────────────────────
// 1. 问候语剥离
// ─────────────────────────────────────────────────────────────

/** 上游欢迎语的固定开头与结尾（两段之间是它随版本改写的自我介绍）。 */
export const GREETING_PREFIX = '你好，我是 OrcaTerm AI'
export const GREETING_END = '需要什么帮助？'

// ─────────────────────────────────────────────────────────────
// 1b. <thinking> 标签改道
// ─────────────────────────────────────────────────────────────

const THINKING_OPEN = '<thinking>'
const THINKING_CLOSE = '</thinking>'

/** buf 结尾是否疑似开标签的未到齐前缀；返回长度（0 = 不是）。 */
function partialOpenSuffixLen(buf) {
  const max = Math.min(buf.length, THINKING_OPEN.length - 1)
  for (let n = max; n > 0; n -= 1) {
    if (THINKING_OPEN.startsWith(buf.slice(-n))) return n
  }
  return 0
}

/**
 * 把正文里的 `<thinking>…</thinking>` 块改道成推理流。
 *
 * 背景（2026-10-25，session-fb62c7fd turn 3 实测）：模型偶尔把思维链**同时**写进
 * 信封的 `thinking` 字段和 `taskCompletion` 正文里的字面 `<thinking>` 标签 ——
 * 后者会原样漏进用户可见正文。这里在输出侧把标签块吃掉、内容转成 reasoning。
 *
 * 与问候语剥离器同型的流式状态机：开标签未到齐时扣住可能的尾部片段；
 * 超过 maxHold 仍等不到闭标签就放弃改道，原文放行（宁可漏改道不能吞正文）。
 *
 * @param {{maxHold?:number, onReasoning?:(text:string)=>void}} [options]
 * @returns {{feed:(delta:string)=>string, flush:()=>string}}
 *   `feed` 返回应作为正文放行的部分；改道出的思维链经 `onReasoning` 回调交出。
 */
export function createThinkingTagRouter(options = {}) {
  const maxHold = Number(options.maxHold) > 0 ? Number(options.maxHold) : 8000
  let buf = ''
  let inside = false
  let settled = false

  function feed(delta) {
    if (settled || !delta) return delta
    buf += delta
    let out = ''
    for (;;) {
      if (!inside) {
        const open = buf.indexOf(THINKING_OPEN)
        if (open === -1) {
          // 没有完整开标签：放行到「可能是开标签未到齐前缀」的尾部为止
          const partial = partialOpenSuffixLen(buf)
          if (partial > 0) {
            out += buf.slice(0, buf.length - partial)
            buf = buf.slice(buf.length - partial)
            return out
          }
          out += buf
          buf = ''
          return out
        }
        out += buf.slice(0, open)
        buf = buf.slice(open + THINKING_OPEN.length)
        inside = true
      } else {
        const close = buf.indexOf(THINKING_CLOSE)
        if (close === -1) {
          if (buf.length > maxHold) {
            // 兜底：等不到闭标签，把已积累的当正文放行，不再改道
            settled = true
            out += THINKING_OPEN + buf
            buf = ''
            return out
          }
          return out // 继续等闭标签
        }
        options.onReasoning?.(buf.slice(0, close))
        buf = buf.slice(close + THINKING_CLOSE.length)
        inside = false
      }
    }
  }

  function flush() {
    if (settled) return ''
    settled = true
    // 流结束时还停在标签内：把开标签补回去按正文放行，不能凭空吞掉
    const out = inside ? THINKING_OPEN + buf : buf
    buf = ''
    return out
  }

  return { feed, flush }
}

/**
 * 造一个流式问候语剥离器。
 *
 * 上游在**每个回合**的正文前都拼这段欢迎语（首轮整条、后续轮作为前缀），且它是随正式内容
 * 一起提交的（不是 `remove-` 草稿），所以只能在输出侧做流式前缀剥离。
 *
 * @param {{prefix?:string, end?:string, maxHold?:number}} [options]
 * @returns {{feed:(delta:string)=>string, flush:()=>string, stripped:()=>string}}
 *   `feed` 返回应放行的正文；`flush` 用于流结束；`stripped` 取被吃掉的问候语原文。
 */
export function createGreetingStripper(options = {}) {
  const prefix = options.prefix ?? GREETING_PREFIX
  const end = options.end ?? GREETING_END
  const maxHold = Number(options.maxHold) > 0 ? Number(options.maxHold) : 300

  let buf = ''
  let settled = false
  let confirmed = false
  let strippedText = ''

  function feed(delta) {
    if (settled || !delta) return delta
    buf += delta
    // 两种命中：buf 是前缀的前缀（分片小于前缀），或 buf 已包含完整前缀（单分片越过前缀）
    const matched = prefix.startsWith(buf) || buf.startsWith(prefix)
    if (!confirmed && !matched) {
      // 与问候语前缀不匹配：不是问候语，原样放行
      settled = true
      const out = buf
      buf = ''
      return out
    }
    if (!confirmed && buf.length >= prefix.length) confirmed = true
    if (confirmed) {
      const idx = buf.indexOf(end)
      if (idx !== -1) {
        settled = true
        strippedText = buf.slice(0, idx + end.length)
        const out = buf.slice(idx + end.length)
        buf = ''
        return out
      }
      // 超长兜底：问候语变体缺失结束标记时放弃剥离，整段放行（不记 stripped，防重复）
      if (buf.length > maxHold) {
        settled = true
        const out = buf
        buf = ''
        return out
      }
      return '' // 仍在问候语内，继续缓冲
    }
    return '' // 仍是问候语开头的前缀片段，继续缓冲
  }

  function flush() {
    if (settled) return ''
    settled = true
    const out = buf
    // 流到结尾仍未定型：整段当正文放行，同时记进 stripped 也不合理 —— 只放行。
    buf = ''
    return out
  }

  return { feed, flush, stripped: () => strippedText, clearStripped: () => { const t = strippedText; strippedText = ''; return t } }
}

// ─────────────────────────────────────────────────────────────
// 2. 历史回放 / 重复正文剥离
// ─────────────────────────────────────────────────────────────

/** 短于这个长度的「历史正文」不值得参与匹配（噪音大、误伤高）。 */
const MIN_PRIOR_CHARS = 8

/**
 * 造一个「重复正文剥离器」：把这一轮输出开头处**已经交付过的正文**整段吃掉。
 *
 * 语义：
 * - `priorTexts` 里放该会话此前已下发给客户端的历史正文（越近的越靠前）；
 * - 本轮输出开头若以某条历史正文原样开头，吃掉它（含其后空行），并**可重复吃多份**；
 * - 若当前缓冲还可能是某条历史正文的**前缀**（分片未到齐），继续缓冲等待判定；
 * - 缓冲超过 `maxHold` 立即放行，避免为了剥离而无限期扣住正文。
 *
 * @param {string[]} priorTexts
 * @param {{maxHold?:number}} [options]
 * @returns {{feed:(delta:string)=>string, flush:()=>string, droppedChars:()=>number}}
 */
export function createRepeatStripper(priorTexts = [], options = {}) {
  const maxHold = Number(options.maxHold) > 0 ? Number(options.maxHold) : 6000
  const priors = (Array.isArray(priorTexts) ? priorTexts : [])
    .map((text) => String(text ?? '').trim())
    .filter((text) => text.length >= MIN_PRIOR_CHARS)
    .sort((a, b) => b.length - a.length)

  let buf = ''
  let open = priors.length === 0
  let dropped = 0

  /** buf 前导空白之后若以某条历史正文开头，返回该吃掉的长度（含其后空行）；否则 -1。 */
  function matchAt(text) {
    const lead = text.length - text.trimStart().length
    const body = text.slice(lead)
    for (const prior of priors) {
      if (body.startsWith(prior)) {
        let end = lead + prior.length
        while (end < text.length && (text[end] === '\n' || text[end] === '\r')) end += 1
        return end
      }
    }
    return -1
  }

  /** 开闸放行：吃过回放的话，连带把回放尾部的空行也去掉（分片恰好断在正文处的场合）。 */
  function openAndTake() {
    open = true
    const out = dropped > 0 ? buf.replace(/^[\s]+/, '') : buf
    buf = ''
    return out
  }

  function feed(delta) {
    if (open || !delta) return delta
    buf += delta
    for (;;) {
      const cut = matchAt(buf)
      if (cut <= 0) break
      dropped += cut
      buf = buf.slice(cut)
    }
    if (buf.trim() === '') return ''
    if (buf.length >= maxHold) return openAndTake()
    // 还可能是某条历史正文的开头 → 再等等，凑齐了才能判定
    const body = buf.trimStart()
    if (priors.some((prior) => prior.startsWith(body))) return ''
    return openAndTake()
  }

  function flush() {
    if (open) return ''
    return openAndTake()
  }

  return { feed, flush, droppedChars: () => dropped }
}

/**
 * 会话级「已交付正文」环形记忆。
 *
 * 只用来喂 `createRepeatStripper`，不承担持久化职责；进程重启即清空，等价于无历史可比。
 */
export function createDeliveredHistory(options = {}) {
  const maxRounds = Number(options.maxRounds) > 0 ? Number(options.maxRounds) : 6
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 20000
  const maxConversations = Number(options.maxConversations) > 0 ? Number(options.maxConversations) : 64
  const store = new Map()

  function textsFor(conversationId) {
    const entry = store.get(String(conversationId || ''))
    return entry ? entry.slice() : []
  }

  function remember(conversationId, text) {
    const key = String(conversationId || '')
    const value = String(text ?? '').trim()
    if (value.length < MIN_PRIOR_CHARS) return
    const list = store.get(key) ? store.get(key).slice() : []
    list.unshift(value)
    let kept = list.slice(0, maxRounds)
    let total = kept.reduce((sum, item) => sum + item.length, 0)
    while (kept.length > 1 && total > maxChars) {
      total -= kept[kept.length - 1].length
      kept = kept.slice(0, -1)
    }
    // 重设键序：Map 保持插入序，命中后重插即 LRU
    store.delete(key)
    store.set(key, kept)
    while (store.size > maxConversations) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
  }

  return { textsFor, remember, size: () => store.size, clear: () => store.clear() }
}

// ─────────────────────────────────────────────────────────────
// 3. 命令目标 shell 判定与改写
// ─────────────────────────────────────────────────────────────

/** 只要出现这些写法，就只能是 cmd.exe 的解释（PowerShell 会把它们当路径/重定向文件名）。 */
const CMD_SIGNALS = [
  /\bdir\s+\/[a-zA-Z]/, // dir /b  /s  /a
  /\d>\s*nul\b/i, // 2>nul（PowerShell 里会真的建一个叫 nul 的文件）
  /%[A-Za-z_][A-Za-z0-9_]*%/, // %USERPROFILE%
  /\b(findstr|attrib|icacls|robocopy|xcopy|diskpart|tasklist|systeminfo|wmic|chkdsk|sfc)\b/i,
  /\b(reg\s+(add|query|delete)|sc\s+(query|start|stop|config))\b/i,
  /\becho\.\s*(?:&&|\|\||$)/i, // echo. 的 cmd 专用写法
]

/** 这些工具在 Windows / PowerShell 里根本不存在，出现即可判定为 POSIX 语义。 */
const POSIX_ONLY_TOOLS = /\b(awk|sed|chmod|chown|chgrp|df|du|xargs|systemctl|journalctl|apt|apt-get|yum|dnf|brew|uname|which|sudo|dpkg|rpm|rsync|sha256sum|md5sum|nohup|crontab|lsof|iptables|watch|ss)\b/;

/**
 * 这些名字在 PowerShell 里是**别名**（ls/grep/echo…），存在但选项完全不同：
 * `ls -la`、`echo -e`、`ps aux` 交到 PowerShell 会以「参数不存在 / 输出走样」失败。
 * 因此必须「工具名 + POSIX 风格短选项」同时出现才算 POSIX。
 */
const POSIX_FLAG_USAGE = /\b(ls|grep|ps|tail|head|wc|sort|uniq|find|rm|cp|mv|mkdir|touch|cat|tar|curl|wget|kill|less|more|diff|patch|tree|stat|file|echo|printf|ln|du|df)\s+-[a-zA-Z]/;

const POSIX_SIGNALS = [
  POSIX_ONLY_TOOLS,
  POSIX_FLAG_USAGE,
  /(^|[\s;&|])\.\/[^\s]/, // 以 ./ 执行当前目录脚本：POSIX 用 ./，PowerShell 用 .\
  /^#!\//, // shebang
]

/** 只要出现 PowerShell 的动词-名词 cmdlet 或特有语法，就按 PowerShell 放行。 */
const POWERSHELL_SIGNALS = [
  /\b(Get|Set|New|Remove|Select|Where|ForEach|Write|Read|Test|Start|Stop|Join|Split|Import|Export|ConvertTo|ConvertFrom|Out|Invoke|Add|Clear|Copy|Move|Rename|Resolve|Measure|Compare|Group|Sort|Format|Update|Register|Unregister|Enable|Disable|Restart|Wait|Receive|Send|Enter|Exit|Push|Pop)-[A-Z][a-zA-Z]+/,
  /\$env:/i,
  /\[(System|string|int|math)\./,
  /-[A-Za-z]+\s+\$[A-Za-z_]/,
]

/**
 * 判定一条命令该由哪个 shell 解释。
 *
 * 优先级：PowerShell 特征 > cmd 特征 > POSIX 特征 > 默认 PowerShell。
 *
 * 「默认 PowerShell」是有意的：DSH 在 Windows 上给模型的系统提示词本身就声明了
 * PowerShell，模型绝大多数时候写的是 PowerShell；把没把握的命令交给它，比猜错 shell 更安全
 * （猜错时命令会以「路径不存在」这类形式静默走偏，而不是报语法错，极难排查）。
 *
 * @param {string} command
 * @returns {'powershell'|'cmd'|'posix'}
 */
export function classifyCommandShell(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return 'powershell'
  if (POWERSHELL_SIGNALS.some((re) => re.test(text))) return 'powershell'
  if (CMD_SIGNALS.some((re) => re.test(text))) return 'cmd'
  if (POSIX_SIGNALS.some((re) => re.test(text))) return 'posix'
  return 'powershell'
}

/** 本机 Git Bash / WSL 的兜底路径（用于把上游的 POSIX 命令真正跑起来）。 */
const BASH_CANDIDATES = [
  process.env.DSH_ORCA_BASH || '',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  '/usr/bin/bash',
  '/bin/bash',
  '/usr/local/bin/bash',
]

/** 解析本机可用的 POSIX shell；找不到返回 ''（此时 POSIX 命令只能退回 PowerShell 尽力而为）。 */
export function resolvePosixShell() {
  for (const candidate of BASH_CANDIDATES) {
    if (!candidate) continue
    if (candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else if (existsSync(candidate)) {
      return candidate
    }
  }
  return ''
}

/**
 * 把一条命令改写成「交给 DSH 的 pwsh 工具执行」时该用的命令行。
 *
 * 之所以要改写而不是换工具：Windows 上 DSH 只暴露 `pwsh`，而上游 Agent 按 Linux 主机
 * 写命令（`ls -la`、`git rev-parse`），也偶发 cmd 写法（`dir /b`、`2>nul`）。
 * 三者语法互不兼容，直接把原文丢给 PowerShell 会以「路径不存在」这种误导性形式失败。
 *
 * @param {string} command 上游给出的命令原文
 * @param {'powershell'|'cmd'|'posix'} shell
 * @param {{posixShell?:string, comspec?:string}} [env]
 * @returns {{command:string, shell:string, wrapped:boolean}}
 */
export function wrapCommandForShell(command, shell, env = {}) {
  const raw = String(command ?? '')
  const posixShell = env.posixShell ?? resolvePosixShell()
  const comspec = env.comspec ?? process.env.ComSpec ?? 'cmd.exe'
  if (raw.trim() === '') return { command: raw, shell: 'powershell', wrapped: false }

  if (shell === 'cmd') {
    // 必须整体单引号包住：PowerShell 7 的 && / || 会先被它自己解析掉，语义就变了。
    return {
      command: `& ${psQuote(comspec)} /c ${psQuote(raw)}`,
      shell: 'cmd',
      wrapped: true,
    }
  }
  if (shell === 'posix') {
    if (posixShell === '') return { command: raw, shell: 'powershell', wrapped: false }
    // -lc：以登录 shell 载入 PATH，让 git/node 等都能被找到
    return {
      command: `& ${psQuote(posixShell)} -lc ${psQuote(raw)}`,
      shell: 'posix',
      wrapped: true,
    }
  }
  return { command: raw, shell: 'powershell', wrapped: false }
}

/** PowerShell 单引号字符串：内部单引号写成两个。 */
function psQuote(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`
}

// ─────────────────────────────────────────────────────────────
// 3b. 混合语法命令的逐段路由
// ─────────────────────────────────────────────────────────────

/**
 * 按顶层操作符切分命令链。
 *
 * 只在**引号外**切 `&&` / `||` / `;`；单个 `|`（管道）不切 ——
 * 管道两侧必须在同一个 shell 里才有意义（`ls -la | grep x` 不能拆开跑）。
 *
 * 说明：这是字符串级启发式，不实现完整 shell 文法（例如 bash 的 `case`/`[[ ]]` 内部
 * 仍可能含 `;`）。因此它只用于**决定怎么路由**，改写时每段原文一字不改地保留。
 *
 * @param {string} command
 * @returns {{segments:string[], operators:string[]}} segments.length === operators.length + 1
 */
export function splitCommandChain(command) {
  const text = String(command ?? '')
  const segments = []
  const operators = []
  let buf = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      buf += ch
      if (ch === '\\' && quote === '"') {
        buf += text[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    // 转义：PowerShell 反引号 / POSIX 反斜杠 —— 连着下一个字符一起吞掉
    if (ch === '\\' || ch === '`') {
      buf += ch + (text[i + 1] ?? '')
      i += 1
      continue
    }
    if ((ch === '&' || ch === '|') && text[i + 1] === ch) {
      segments.push(buf)
      operators.push(ch + ch)
      buf = ''
      i += 1
      continue
    }
    if (ch === ';') {
      segments.push(buf)
      operators.push(';')
      buf = ''
      continue
    }
    buf += ch
  }
  segments.push(buf)
  return { segments, operators }
}

/**
 * 认出「整段就是一次 cd」并取出目标。
 *
 * 这类段必须交给 PowerShell 执行（`Set-Location`），因为实测**子 shell 会继承
 * PowerShell 进程的当前目录**：只要 PowerShell 层先切过去，后续的 `cmd /c` 与
 * `bash -lc` 段就都落在同一个目录里了。
 *
 * @param {string} segment
 * @returns {{raw:string}|null} 不是纯 cd 调用时返回 null
 */
export function parseCdSegment(segment) {
  const text = String(segment ?? '').trim()
  if (text === '') return null
  // cd /d X（cmd）、cd X、cd "X"、cd 'X'
  const match = text.match(/^cd(?:\s+\/d)?\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/i)
  if (!match) return null
  const raw = match[1] ?? match[2] ?? match[3] ?? ''
  return raw === '' ? null : { raw }
}

/**
 * POSIX 风格路径 → Windows 路径；无法翻译时返回 null（调用方据此放弃逐段路由）。
 *
 * 只翻译无歧义的 MSYS 盘符写法（`/c/AITask` → `C:\AITask`）；`/tmp`、`/usr/...` 这类
 * Git Bash 虚拟路径的落点依赖安装配置，猜错会造成静默切错目录，所以如实放弃。
 */
export function toWindowsPath(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const drive = text.match(/^\/([a-zA-Z])(\/.*)?$/)
  if (drive) {
    const rest = (drive[2] ?? '').replace(/\//g, '\\')
    return `${drive[1].toUpperCase()}:${rest === '' ? '\\' : rest}`
  }
  if (text.startsWith('/')) return null
  // 已是 Windows 绝对/相对路径
  return text
}

/**
 * 一条命令链 → 交给 DSH `pwsh` 执行的单行命令。
 *
 * 策略：
 * - **单 shell**（全段同一种判定，且没有需要挪目录的 cd）→ 原文整体包装，与旧行为完全一致；
 * - **混合语法** → 逐段包装成 `& cmd /c '…'` / `& bash -lc '…'` / 原生 PowerShell，
 *   用 PowerShell 7 的 `&&` / `||` / `;` 重新串联；cd 段改写成 `Set-Location`，
 *   让后续各段凭「子 shell 继承当前目录」落在同一目录；
 * - **任何一段无法承接**（没有 POSIX shell、或 cd 目标无法翻译）→ 整条链退回单 shell 策略，
 *   并标记 `fallback`，绝不假装成功。
 *
 * @param {string} command
 * @param {{posixShell?:string, comspec?:string}} [env]
 * @returns {{command:string, strategy:'single'|'composed'|'fallback'|'empty', shells:string[], reason?:string}}
 */
export function rewriteCommandChain(command, env = {}) {
  const original = String(command ?? '')
  if (original.trim() === '') return { command: original, strategy: 'empty', shells: [] }

  const posixShell = env.posixShell ?? resolvePosixShell()

  /** 旧行为：整条链判一种 shell。`preferred` 用于让退路至少落在「能解释这条命令」的 shell 上。 */
  const singleShell = (reason, preferred) => {
    const shell = preferred ?? classifyCommandShell(original)
    const wrapped = wrapCommandForShell(original, shell, { ...env, posixShell })
    return { command: wrapped.command, strategy: reason ?? 'single', shells: [wrapped.shell] }
  }

  const { segments, operators } = splitCommandChain(original)
  const shells = segments.map((segment) => classifyCommandShell(segment))
  const cdTargets = segments.map((segment) => parseCdSegment(segment))
  const cdWindowsPaths = cdTargets.map((target) => (target === null ? null : toWindowsPath(target.raw)))

  // cd 段自带判据：能翻译成 Windows 路径的交给 PowerShell（Set-Location）；
  // POSIX 绝对路径（`/tmp`）本身就是「这是 bash 语境」的证据，据实改判 posix。
  for (let i = 0; i < cdTargets.length; i += 1) {
    if (cdTargets[i] === null) continue
    shells[i] = cdWindowsPaths[i] === null ? 'posix' : 'powershell'
  }

  // 单 shell 且没有 cd 需要跨界迁移 → 走旧路径（保证已验证的行为不变）
  if (new Set(shells).size <= 1 && cdTargets.every((target) => target === null)) {
    return singleShell('single')
  }

  const pieces = []
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i].trim()
    const cd = cdTargets[i]
    if (cd) {
      if (cdWindowsPaths[i] === null) {
        // 目标落在 Git Bash 虚拟路径上（/tmp 之类），无法可靠翻译成 Windows 目录。
        // 如实退回单 shell，并优先选 posix —— 至少 cd 本身是对的，后续段落会报出
        // 「command not found」这种可读错误，而不是静默切错目录。
        return singleShell('fallback', posixShell === '' ? 'powershell' : 'posix')
      }
      pieces.push(`Set-Location ${psQuote(cdWindowsPaths[i])}`)
      continue
    }
    if (segment === '') return singleShell('fallback') // 空段（如 "a && && b"）不猜
    if (shells[i] === 'cmd') {
      pieces.push(wrapCommandForShell(segment, 'cmd', { ...env, posixShell, comspec: env.comspec }).command)
      continue
    }
    if (shells[i] === 'posix') {
      const wrapped = wrapCommandForShell(segment, 'posix', { ...env, posixShell })
      if (wrapped.wrapped === false && posixShell === '') return singleShell('fallback')
      pieces.push(wrapped.command)
      continue
    }
    pieces.push(segment)
  }

  let out = ''
  for (let i = 0; i < pieces.length; i += 1) {
    out += pieces[i]
    if (i < operators.length) out += ` ${operators[i]} `
  }
  return { command: out, strategy: 'composed', shells: [...new Set(shells.concat(['powershell']))] }
}

/**
 * 路由结果的简短标记，写进工具 description —— 判错 shell 时能一眼看出走了哪条路。
 */
export function describeShellRouting(plan) {
  if (!plan || plan.strategy === 'empty') return 'shell=empty'
  const shells = Array.isArray(plan.shells) && plan.shells.length > 0 ? plan.shells.join('+') : 'powershell'
  return `shell=${plan.strategy}:${shells}`
}

// ─────────────────────────────────────────────────────────────
// 4. 工具调用解析
// ─────────────────────────────────────────────────────────────

/**
 * 从一段文本里认出 OrcaTerm Agent 的工具信封。
 *
 * 上游把工具调用**当正文写**出来（还常裹在 ```json 围栏里），所以要在输出侧拦截：
 * `{"action":"review","tool":{"type":"mcp","mcpServer":"mcp-server-orcaterm-oauth","name":"execute_command","args":{…}}}`
 *
 * @param {string} raw
 * @returns {object|null} 信封对象；不是工具信封时返回 null
 */
export function parseToolEnvelope(raw) {
  const clean = String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  if (clean === '') return null
  try {
    const obj = JSON.parse(clean)
    if (obj && typeof obj.action === 'string' && obj.tool && typeof obj.tool === 'object') return obj
  } catch { /* 非 JSON 或非工具信封 */ }
  return null
}

/**
 * 上游 Agent 的 `{action,tool:{…}}` 信封 → DSH 本机工具契约。
 *
 * 上游不会用调用方声明的 function schema，它认自己的客户端工具集（`uiServers:['orcaterm']`
 * 激活），下发 `tool:{type:'mcp',mcpServer:'mcp-server-orcaterm-oauth',name,args}`。
 * 这里把它的工具名映射到本机 DSH 真实存在的工具上。
 *
 * @param {{name?:string, args?:object, description?:string}} tool 上游 tool 对象
 * @param {Array} declaredTools 本轮请求里 DSH 声明的工具（OpenAI function 形态）
 * @param {{posixShell?:string, comspec?:string, platform?:string}} [env]
 * @returns {{name:string, arguments:object, mappedFrom:string, shell?:string}}
 */
export function resolveDshToolCall(tool, declaredTools = [], env = {}) {
  const origName = String(tool?.name || '')
  const args = tool?.args ?? tool?.input ?? {}
  const toolNames = new Set(
    (Array.isArray(declaredTools) ? declaredTools : [])
      .map((item) => item?.function?.name || item?.name)
      .filter(Boolean),
  )
  const has = (toolName) => toolNames.has(toolName)

  // 1) 命令执行：上游 Linux 语义 → 本机执行器
  if (origName === 'execute_command' || origName === 'execute_terminal_command' || origName === 'run_commands') {
    const command = args.command || args.cmd || ''
    if (has('bash')) {
      // Linux/macOS 的 DSH 直接就有 bash，不需要绕 PowerShell
      return { name: 'bash', arguments: { command }, mappedFrom: origName, shell: 'posix', strategy: 'single' }
    }
    if (has('pwsh')) {
      const plan = rewriteCommandChain(command, env)
      const baseDescription = tool?.description || 'OrcaTerm 命令执行'
      return {
        name: 'pwsh',
        arguments: {
          command: plan.command,
          // 把路由结果写进 description：判错 shell 时能一眼看出走了哪条路，不必再猜
          description: `${baseDescription} [${describeShellRouting(plan)}]`,
        },
        mappedFrom: origName,
        shell: plan.strategy === 'composed' ? 'mixed' : (plan.shells[0] ?? 'powershell'),
        strategy: plan.strategy,
      }
    }
  }

  // 2) 文件读取
  if (origName === 'remote_read' || origName === 'read_file') {
    const filePath = args.path || args.file_path || args.filePath || ''
    if (has('read')) return { name: 'read', arguments: { file_path: filePath }, mappedFrom: origName }
  }

  // 3) 文件写入
  if (origName === 'remote_write' || origName === 'write_file') {
    const filePath = args.path || args.file_path || args.filePath || ''
    if (has('write')) {
      return { name: 'write', arguments: { file_path: filePath, content: args.content || '' }, mappedFrom: origName }
    }
  }

  // 4) 目录查找 / 5) 内容搜索
  if ((origName === 'remote_glob' || origName === 'glob_file') && has('glob')) {
    return { name: 'glob', arguments: { pattern: args.pattern || '*' }, mappedFrom: origName }
  }
  if ((origName === 'remote_grep' || origName === 'search_content') && has('grep')) {
    return { name: 'grep', arguments: { pattern: args.pattern || args.query || '' }, mappedFrom: origName }
  }

  // 6) DSH 恰好声明了同名工具 → 原样放行
  if (has(origName)) return { name: origName, arguments: args, mappedFrom: origName }

  // 7) 兜底：带 command 且本机有 pwsh → 当命令跑
  if (args.command && has('pwsh')) {
    const plan = rewriteCommandChain(args.command, env)
    return {
      name: 'pwsh',
      arguments: {
        command: plan.command,
        description: `${tool?.description || origName} [${describeShellRouting(plan)}]`,
      },
      mappedFrom: origName,
      shell: plan.strategy === 'composed' ? 'mixed' : (plan.shells[0] ?? 'powershell'),
      strategy: plan.strategy,
    }
  }

  return { name: origName || 'unknown', arguments: args, mappedFrom: origName }
}

// ─────────────────────────────────────────────────────────────
// 5. 运行环境自述（写进上游提示词，减少 shell 猜错）
// ─────────────────────────────────────────────────────────────

/**
 * 用本进程所在机器的真实情况描述执行环境。
 *
 * 后端与 DSH 的本机工具在同一台机器上，所以这里的 platform 就是命令真正被解释的地方。
 *
 * @param {{platform?:string, cwd?:string, posixShell?:string}} [env]
 */
export function describeExecutionHost(env = {}) {
  const platform = env.platform ?? process.platform
  const cwd = env.cwd || ''
  const where = cwd ? `，当前工作目录 ${cwd}` : ''
  if (platform === 'win32') {
    const shell = env.posixShell ?? resolvePosixShell()
    return `执行环境：Windows${where}（命令在调用方主机的当前会话目录执行，不是云端沙箱），命令由 PowerShell 7 执行。`
      + '请只用 PowerShell 语法（不要写 dir /b、ls -la、2>nul 这类 cmd/bash 写法）；'
      + (shell ? 'POSIX 风格的命令会被自动转交给本机 Git Bash 执行。' : '本机没有 POSIX shell，请务必使用 PowerShell。')
  }
  return `执行环境：${platform}${where}（命令在调用方主机的当前会话目录执行，不是云端沙箱），命令由 bash 执行，请使用 POSIX shell 语法。`
}

// ─────────────────────────────────────────────────────────────
// 6. 工具结果回传前的敏感信息脱敏（官方 Sn.fp 的逐条移植）
// ─────────────────────────────────────────────────────────────

/**
 * 官方客户端在 `reportToolResult` 回传前，先用 `Sn.fp`（线上 bundle 模块 35482，
 * `orcaterm_start.zh.decf2b6a285396d427d2.js` @15689）把工具输出里的凭据脱敏成
 * `[已隐藏…]` 占位符，再交给上游。这是**行为级等价**的一部分：上游看到的工具结果
 * 应该与官方客户端发出的形态一致。以下 14 条规则按官方源码逐条移植，顺序即官方顺序。
 */

const REDACT_LABEL = (label) => `[已隐藏${label}]`
const REDACT_KEY_BLOCK = REDACT_LABEL('的私钥证书')
const REDACT_API_KEY = REDACT_LABEL('的 API 密钥')
const REDACT_AWS_KEY = REDACT_LABEL('的 AWS 密钥')
const REDACT_GITHUB_TOKEN = REDACT_LABEL('的 GitHub 令牌')
const REDACT_GOOGLE_KEY = REDACT_LABEL('的 Google API 密钥')
const REDACT_SLACK_TOKEN = REDACT_LABEL('的 Slack 令牌')
const REDACT_STRIPE_KEY = REDACT_LABEL('的 Stripe 密钥')
const REDACT_JWT = REDACT_LABEL('的 JWT 令牌')

/** 官方规则 11 用的「敏感键名」判定（password/passwd/secret/token/apikey/… 结尾即视为敏感）。 */
function isSensitiveAssignKey(rawKey) {
  const normalized = String(rawKey || '').toLowerCase().replace(/[-_]/g, '')
  if (/pwd$/.test(normalized)) return /[-_]pwd$/i.test(rawKey)
  return /(?:password|passwd|secretkey|secret|token|apikey|accesskey|accesstoken|refreshtoken|authtoken|clientsecret|privatekey|credentials?|auth)$/.test(normalized)
}

/** 拆出赋值右值两侧的引号（官方 c 函数）。 */
function splitQuotedValue(value) {
  const first = value[0]
  const last = value[value.length - 1]
  const quote = value.length >= 2 && (first === "'" || first === '"') && first === last ? first : ''
  return { quote, value: quote ? value.slice(1, -1) : value }
}

/** 官方规则 11/12 共用的「右值替换为 ***，保留原引号」处理（官方 a 函数）。 */
function redactAssignValue(_match, prefix, sep, rawValue) {
  const { quote } = splitQuotedValue(rawValue)
  return `${prefix}${sep}${quote}***${quote}`
}

const REDACTION_RULES = [
  // 1) PEM 私钥/证书块
  { pattern: /-----BEGIN[^-]*?(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END[^-]*?(?:PRIVATE KEY|CERTIFICATE)-----/gi, replacement: REDACT_KEY_BLOCK },
  // 2) Anthropic / OpenAI 风格 API key
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, replacement: REDACT_API_KEY },
  // 3) AWS AccessKey
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACT_AWS_KEY },
  // 4) GitHub token
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: REDACT_GITHUB_TOKEN },
  // 5) Google API key
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: REDACT_GOOGLE_KEY },
  // 6) Slack token
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACT_SLACK_TOKEN },
  // 7) Stripe key
  { pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replacement: REDACT_STRIPE_KEY },
  // 8) JWT（三段式）
  { pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACT_JWT },
  // 9) URL 内嵌用户名:密码（保留协议与用户名）
  { pattern: /((?:https?|ftp|smtp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:)[^/\s:@]+@/gi, replacement: '$1***@' },
  // 10) Bearer 令牌
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, replacement: '$1***' },
  // 11) KEY=VALUE / KEY: VALUE 赋值（键名敏感才替换；嵌套含 = 的值递归处理）
  {
    pattern: /\b([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"';|&]+)/g,
    replacement: (match, key, sep, rawValue) => {
      if (!isSensitiveAssignKey(key)) {
        const { quote, value } = splitQuotedValue(rawValue)
        if (value.includes('=')) {
          const inner = redactSecrets(value)
          if (inner !== value) return `${key}${sep}${quote}${inner}${quote}`
        }
        return match
      }
      return redactAssignValue(match, key, sep, rawValue)
    },
  },
  // 12) CLI 长参数 --password/--token/--secret/…
  { pattern: /(--(?:password|token|secret|api-?key|access-?key|auth-?token))(\s+|=)("[^"]*"|'[^']*'|[^\s"';|&]+)/gi, replacement: redactAssignValue },
  // 13) 常见数据库/云 CLI 的环境变量赋值
  { pattern: /\b(MYSQL_PWD|PGPASSWORD|REDISCLI_AUTH|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN)(["']?\s*=\s*["']?)([^\s"';|&]+)/gi, replacement: '$1$2***' },
  // 14a) sshpass -p
  { pattern: /(\bsshpass\s+-p\s*["']?)(?!--)[^\s"';|&)]+/gi, replacement: '$1***' },
  // 14b) mysql 系列的 -p 密码
  { pattern: /(\b(?:mysql|mysqladmin|mysqldump|mysqlimport|mysqlshow|mariadb(?:-(?:admin|dump|import|show))?)\b[^\r\n;|&]*?\s-p)(["']?)([^\s"';|&)]+)\2/gi, replacement: '$1$2***$2' },
  // 14c) redis-cli -a / --pass
  { pattern: /(\bredis-cli\b[^\r\n;|&]*?\s(?:-a(?:\s+)?|--pass(?:=|\s+)))(["']?)(?!--)([^\s"';|&)]+)\2/gi, replacement: '$1$2***$2' },
  // 14d) curl -u / --user（user:password 保留用户名）
  {
    pattern: /(\bcurl\b[^\r\n;|&]*?\s(?:-u(?:\s+)?|--(?:user|proxy-user)(?:=|\s+)))(["']?)(?!--)([^\s"';|&)]+)\2/gi,
    replacement: (_match, prefix, quote, value) => {
      const colon = value.indexOf(':')
      const masked = colon < 0 ? '***' : `${value.slice(0, colon)}:***`
      return `${prefix}${quote}${masked}${quote}`
    },
  },
]

/**
 * 对工具输出做官方同款脱敏。非字符串入参原样返回空串（官方 s 函数语义）。
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return ''
  let out = text
  for (const rule of REDACTION_RULES) out = out.replace(rule.pattern, rule.replacement)
  return out
}

// ─────────────────────────────────────────────────────────────
// 7. UI 工具注册表与执行类别（官方 An 分类器的移植）
// ─────────────────────────────────────────────────────────────

/**
 * 官方客户端的 orcaterm UI 工具全集（`orcaterm_start.zh…js` @76135 附近，En/Tn 两个 Set）：
 * - headless（En）：官方客户端**无需用户确认**自动执行的只读/查询类工具；
 * - foreground（Tn）：需要前台确认的写操作/危险操作。
 * 我们声明 uiServers 时仍只挑能真正映射到 DSH 工具的子集（见 upstream.assistantBody），
 * 这里保留官方全集作为证据与未来扩展的依据。
 */
export const UI_TOOL_HEADLESS = Object.freeze([
  'execute_terminal_command',
  'get_orcaterm_settings',
  'get_terminal_detail',
  'get_terminal_output',
  'list_terminals',
  'login_by_connect_id',
  'query_agent_tasks_status',
  'query_commands_status',
  'read_cloud_space_file',
  'read_cloud_space_file_list',
  'remote_glob',
  'remote_grep',
  'remote_read',
  'remote_write',
  'send_terminal_signal',
])

export const UI_TOOL_FOREGROUND = Object.freeze([
  'create_cloud_space_file',
  'edit_cloud_space_file',
  'remote_edit',
  'remote_multi_edit',
  'run_commands',
  'select_connect_config',
  'submit_agent_tasks',
  'update_orcaterm_settings',
])

/**
 * 官方 An({name,type,mcpServer}) 分类器：决定一个工具信封由谁执行、要不要先 approve。
 * - system 类型 → 服务端系统工具（等用户前台确认）；
 * - 带 mcpServer 或 type=mcp → 服务端 MCP（先发 approve，由上游代执行）；
 * - 其余按名字落 headless/foreground 两类。
 * @param {{name?:string, type?:string, mcpServer?:string, toolType?:string}} tool
 * @returns {'server_system'|'server_mcp'|'headless_ui'|'foreground_required'}
 */
export function classifyUiToolCategory(tool = {}) {
  const type = String(tool.type || tool.toolType || '').trim()
  if (type === 'system') return 'server_system'
  if (tool.mcpServer || type === 'mcp') return 'server_mcp'
  const name = String(tool.name || '').trim()
  if (UI_TOOL_FOREGROUND.includes(name)) return 'foreground_required'
  if (UI_TOOL_HEADLESS.includes(name)) return 'headless_ui'
  return 'foreground_required'
}

// ─────────────────────────────────────────────────────────────
// 8. 回传重试退避（官方 xn.SE 的公式移植）
// ─────────────────────────────────────────────────────────────

/**
 * 官方回传工具结果的退避序列（模块 32804：delay = min(base * 2^n, max)）。
 * 实测参数（@78376）：attempts=3, timeoutMs=15000, baseDelayMs=300, maxDelayMs=1500
 * → 重试前的等待是 300ms、600ms（第三次直接发，不再等待）。
 * @param {number} attempt 第几次失败后的等待（0 起）
 * @param {{baseDelayMs?:number, maxDelayMs?:number}} [options]
 */
export function reportRetryBackoffMs(attempt, options = {}) {
  const base = Math.max(0, options.baseDelayMs ?? 300)
  const max = Math.max(base, options.maxDelayMs ?? 1500)
  return Math.min(base * 2 ** attempt, max)
}

/** 官方回传超时：单次尝试 15s（`回传工具结果` 操作的 timeoutMs）。 */
export const REPORT_RETRY_TIMEOUT_MS = 15000