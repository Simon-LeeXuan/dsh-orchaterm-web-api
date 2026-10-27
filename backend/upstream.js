/**
 * OrcaTerm 反代内核：把桌面端/网页端的私有 API 复刻成 OpenAI 兼容接口。
 *
 * 上游两条通道（2026-10-24 实测）：
 *   1) CGI  `POST {cgiBase}/cgi/api?action=…&uin=…&ownerUin=…`
 *      头 `X-SeqId` / `X-Referer` / `X-CsrfCode` / `Authorization: Bearer`，体 `{action,data}`。
 *      响应恒为 HTTP 200 + `{data:{Response:{…}}}`，错误也在体内：`Response.Error{Code,Message}`。
 *      认 Bearer JWT（微信 OAuth 号可用）。
 *   2) Assistant `{assistantBase}/chat`（SSE）
 *      体 `{conversationId,user,input,stream:true}`，查询 `name/mode/csrfCode/uin`。
 *      帧 `data:{…}`，终止符 `[DONE]` / `[ERROR]:…` / `[ABORTED]`。
 *      鉴权只认 uin+skey（QQ 系登录态）；缺 skey 时上游回 `NEED_UIN_AND_SKEY`。
 *
 * 本文件不写盘、不打印任何凭据值。
 *
 * @module backend/upstream.js
 */

import { randomUUID } from 'node:crypto'

/** Assistant 路径表（抄自 OrcaTerm 前端模块 82752 的常量）。 */
export const ASSISTANT_PATHS = Object.freeze({
  messages: '/messages',
  singleTurn: '/messages/single-turn',
  addSymbol: '/message/add-symbol',
  chat: '/chat',
  clear: '/clear',
  toolAgent: '/tool-agent',
  remove: '/remove',
  conversation: '/conversation',
  streamStatus: '/stream/status',
  streamResume: '/stream/resume',
  streamAbort: '/stream/abort',
})

/** 上游 CGI 的失败码 → 我们对外说的错误码。 */
const CGI_ERROR_MAP = Object.freeze({
  VERIFY_USER_FAILED: 'AUTH',
  NEED_UIN_AND_SKEY: 'AUTH',
  ACTION_INVALID: 'INVALID_REQUEST',
  'api-action-not-found': 'INVALID_REQUEST',
  'api-params-verify-fail': 'INVALID_REQUEST',
  REQUEST_METHOD_INVALID: 'INVALID_REQUEST',
})

export function newSeqId() {
  return randomUUID()
}

/**
 * 真实客户端身份：桌面端与网页版各一套。
 *
 * 2026-10-25 实测取得（都是桌面端自己的产物，不是推测）：
 * - `origin`/`referer`：WebView2 History 里主页面就是 `http://tauri.localhost/`（访问 35 次），
 *   而 OrcaTerm 的 CGI 请求头写的是 `X-Referer: parent.location.href` —— 桌面端发的就是这个值；
 * - `userAgent`：Rust 日志 `log.rs:34 ... userAgent=` 的原文。WebView2 会随 Edge 升级换版本号，
 *   要重新取值：`Select-String "$env:LOCALAPPDATA\com.orcaterm-desktop.app\logs\orcaterm.log" -Pattern 'userAgent='`。
 *
 * 实测边界（重要，别把这个当成故障修复）：`/cgi/api` 与 `/assistant/chat` **都不校验**
 * Origin / Referer / UA —— 乱填、完全不带都返回 200 且结果一致。所以对齐的价值是
 * 「与真实客户端一致」这个目标本身。反过来说 UA 是唯一有远期风险的字段：服务端将来若加
 * 客户端风控，`dsh-orchaterm-web-api/x.y.z` 这种一眼非浏览器的 UA 最容易被识别，
 * 所以默认值从它换成浏览器口径。
 */
export const DESKTOP_IDENTITY = Object.freeze({
  origin: 'http://tauri.localhost',
  referer: 'http://tauri.localhost/',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
})

/** 网页版口径（v0.3.1 及之前的默认）；`clientIdentity: 'web'` 可切回。 */
export const WEB_IDENTITY = Object.freeze({
  origin: 'https://orcaterm.com',
  referer: 'https://orcaterm.com/terminal',
})

/**
 * 按口径取身份。UA 只在桌面端口口径里给（网页端口口径历史上不发 UA，保持一致以免行为漂移）。
 * @param {'desktop'|'web'} kind
 * @returns {{origin:string, referer:string, userAgent:string}}
 */
export function identityOf(kind) {
  return kind === 'web' ? { ...WEB_IDENTITY } : { origin: DESKTOP_IDENTITY.origin, referer: DESKTOP_IDENTITY.referer }
}

/** 拼 CGI URL：action 同时进查询串与请求体（上游两处都读）。 */
export function cgiUrl(config, action) {
  const u = new URL(`${config.cgiBase.replace(/\/+$/, '')}/cgi/api`)
  u.searchParams.set('action', action)
  u.searchParams.set('uin', config.credential.uin || '')
  u.searchParams.set('ownerUin', config.credential.ownerUin || config.credential.uin || '')
  return u.toString()
}

export function cgiHeaders(config) {
  const headers = {
    'content-type': 'application/json',
    'X-SeqId': newSeqId(),
    'X-Referer': config.referer || DESKTOP_IDENTITY.referer,
    'X-CsrfCode': config.credential.csrfCode || '0',
  }
  // 浏览器发跨源 XHR 时一定会带 Origin，所以这里也补上。
  // 三个字段都留了兜底：绕过 buildConfig 手搓 config 时也不会发出 undefined。
  headers.Origin = config.origin || DESKTOP_IDENTITY.origin
  headers['user-agent'] = config.userAgent || DESKTOP_IDENTITY.userAgent
  if (config.credential.token) headers.Authorization = `Bearer ${config.credential.token}`
  // cookie 按**实际 cgiBase 的 host** 取，别再写死 api.orcaterm.com：
  // 默认值换成桌面端口径 host 之后，写死会让 jar 回退分支拿错域的 cookie。
  const cookieHost = hostOf(config.cgiBase)
  const cookie = config.credential.cookieHeader
    || (config.cookieFor ? config.cookieFor(cookieHost) : '')
  if (cookie) headers.Cookie = cookie
  return headers
}

/** 取 URL 的 hostname；拿不到就回空（调用方会再走凭据里的 cookieHeader）。 */
function hostOf(url) {
  try { return new URL(String(url).replace(/\/+$/, '') + '/').hostname } catch { return '' }
}

/**
 * 调一次 CGI，把 `{data:{Response}}` 拆成值或错误。
 *
 * 响应头 `X-OT-Token-Refreshed` 是服务端的滑动续期（桌面端同款行为）：
 * 一旦出现就交给 `config.absorbServerToken`，不需要额外请求。
 *
 * @param {object} config
 * @param {string} action
 * @param {object} [data]
 * @param {{signal?:AbortSignal, fetchImpl?:Function}} [options]
 * @returns {Promise<{ok:boolean, data?:unknown, code?:string, message?:string, upstreamCode?:string, newToken?:string}>}
 */
export async function cgiCall(config, action, data = {}, options = {}) {
  const doFetch = options.fetchImpl || globalThis.fetch
  let response
  try {
    response = await doFetch(cgiUrl(config, action), {
      method: 'POST',
      headers: cgiHeaders(config),
      body: JSON.stringify({ action, data }),
      signal: options.signal,
    })
  } catch (error) {
    return { ok: false, code: 'TRANSPORT', message: `CGI ${action} 请求失败: ${error?.message || error}` }
  }
  // 服务端可能在**任何**已认证响应上回一枚新 token；先收，再判 body。
  const newToken = response.headers?.get?.('x-ot-token-refreshed') || ''
  if (newToken !== '' && typeof config.absorbServerToken === 'function') {
    try {
      config.absorbServerToken(newToken)
    } catch {
      // 吸收失败不该影响这次调用
    }
  }
  if (!response.ok) {
    return { ok: false, code: 'SERVER', message: `CGI ${action} HTTP ${response.status}`, newToken }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, code: 'SERVER', message: `CGI ${action} 响应不是 JSON`, newToken }
  }
  const body = payload?.data?.Response
  if (body && typeof body === 'object' && body.Error) {
    const upstreamCode = String(body.Error.Code || '')
    const message = String(body.Error.Message || upstreamCode || '上游错误')
    return {
      ok: false,
      code: CGI_ERROR_MAP[upstreamCode] || (upstreamCode ? 'SERVER' : 'TRANSPORT'),
      message: `${action}: ${message}`,
      upstreamCode,
      newToken,
    }
  }
  return { ok: true, data: body, newToken }
}

/** Assistant 的查询串：name/mode/csrfCode/uin（前端同款参数集）。 */
export function assistantQuery(config, path = '/chat', extra = {}) {
  const base = config.assistantBase.replace(/\/+$/, '')
  const u = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`)
  const params = {
    name: config.assistant,
    mode: String(config.mode),
    csrfCode: config.credential.csrfCode || '',
    sseresume: 'true',
    ...extra,
  }
  // 如果凭据里没有明确要求带 uin 查询参数，保留空或按配置传
  if (config.credential.uin && extra.includeUinQuery) params.uin = config.credential.uin
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    u.searchParams.set(key, String(value))
  }
  return u.toString()
}

export function assistantHeaders(config, seqId) {
  const headers = {
    'content-type': 'application/json',
    Accept: 'text/event-stream',
    'x-seqid': seqId || newSeqId(),
    'x-product': 'orcaterm',
    // origin/referer 与 CGI 通道共用同一份身份口径，不再各处写死；
    // referer 与 X-Referer 在浏览器里本来就是同一个值（当前页面 URL），所以两个头都给同一个。
    origin: config.origin || DESKTOP_IDENTITY.origin,
    referer: config.referer || DESKTOP_IDENTITY.referer,
    'X-Referer': config.referer || DESKTOP_IDENTITY.referer,
    'user-agent': config.userAgent || DESKTOP_IDENTITY.userAgent,
  }
  const cookie = config.credential.cookieHeader
    || (config.cookieFor ? config.cookieFor(hostOf(config.assistantBase)) : '')
  if (cookie) headers.Cookie = cookie
  const authBearer = config.credential.assistantBearer || config.credential.token
  if (authBearer) {
    headers.Authorization = authBearer.startsWith('Bearer ') ? authBearer : `Bearer ${authBearer}`
  }
  return headers
}

/**
 * OrcaTerm 客户端展示的 5 大模型名称 → LightAI 网关可加载的 model ID。
 *
 * 证据边界（实测，2026-10-24）：
 * - 直接把展示名（`glm-5.3-flash`、`kimi-k3`、`deepseek-v4.1-flash` 等）发给 LightAI 会返回
 *   `[LLM_ERROR]: LLM(<name>) is not loaded.`，即这些字符串不是当前网关注册的模型槽；
 * - 表中右侧的 ID 是实测可加载并能正常返回 SSE 的槽位。
 *
 * 未验证项：这些槽位与展示名的模型版本、能力、质量是否严格等价，LightAI 未提供公开元数据，
 * 本插件也未做等价性验证。因此本表是「兼容路由」，不是模型身份声明；输出质量可能与展示名有偏差。
 */
export const UPSTREAM_MODEL_MAP = Object.freeze({
  'deepseek-v4.1-flash': 'deepseek-chat-latest',
  'deepseek-v3::deepseek-v4.1-flash': 'deepseek-chat-latest',
  'hy4-preview': 'Hunyuan3/hy4-preview',
  'hy3': 'Hunyuan3/hy3',
  'kimi-k3': 'kimi-latest',
  'glm-5.3-flash': 'glm-4.7-thinking',
})

/**
 * 流控制通道（逆向 orcaterm_start_core 模块 2481/82752，2026-10-25）：
 *
 * 官方客户端的「停止」= 本地 AbortController.abort() + `Lt()`：
 *   POST {assistantBase}/stream/abort/{conversationId}?name=&mode=&csrfCode=&sseresume=true
 *   体为空对象 `{}`，响应 `{data}`。
 * 「断线重连」用 `/stream/resume/{cid}?...&offset=<已收 chunk 数>`（GET，SSE 续流），
 * 前置探测用 `/stream/status/{cid}`（GET → `{status:'running'|...}`）。
 * 会话 ID 放在**路径段**里，查询串只带 name/mode/csrfCode/sseresume。
 */

/** 拼 `/{path}/{conversationId}` 形态的流控制 URL（官方 getRequestUrl 的段拼接语义）。 */
export function streamControlUrl(config, path, conversationId, extra = {}) {
  return assistantQuery(config, `${path}/${encodeURIComponent(String(conversationId || ''))}`, extra)
}

/** 官方 stop() 的服务端半边：通知上游中止该会话的运行中流。fire-and-forget 场景不抛错。 */
export async function assistantAbort(config, conversationId) {
  try {
    await fetch(streamControlUrl(config, ASSISTANT_PATHS.streamAbort, conversationId), {
      method: 'POST',
      headers: { ...assistantHeaders(config), Accept: 'application/json' },
      body: '{}',
    })
    return true
  } catch {
    return false
  }
}

/** 查询会话流状态（官方 It()）：返回 `{status:...}` 或 null。 */
export async function assistantStreamStatus(config, conversationId) {
  try {
    const res = await fetch(streamControlUrl(config, ASSISTANT_PATHS.streamStatus, conversationId), {
      method: 'GET',
      headers: assistantHeaders(config),
    })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    return payload?.data || null
  } catch {
    return null
  }
}

/**
 * 组一次 assistant 请求体（对齐前端 `assistant_request.body`）。
 * @param {object} config
 * @param {{conversationId:string, content:string, model:string, history?:Array,
 *          enableThinking?:boolean, tools?:Array, type?:string, toolResultText?:string,
 *          sendHistoryMessages?:boolean, envPrompt?:string, inputId?:string}} input
 *   `tools` 为 OpenAI function 形态数组，原样透传给上游 Agent 网关；
 *   `enableThinking` 缺省视为 true（推理模型才有思维链，非推理模型由网关自行忽略）。
 *   `uiServers` 与 `selectedUITools` 激活 OrcaTerm 客户端自主工具（命令执行/文件读写等），
 *   使模型在遇到运维任务时主动通过 action: "review" 下发工具调用，而不是拒绝或幻觉。
 *   `envPrompt` 是执行环境自述（见 agent-protocol.js），拼在 emphasisPrompt 里。
 *   `inputId`：官方 Fe 把 input 的消息 id 与 `x-seqid` 设成**同一个值**（模块 2481：
 *   `const {id: x = Ub()} = e` → headers `x-seqid: x`、`input.id = x`），这里对齐。
 *
 * ## 关于 historyMessages（2026-10-24 实测，默认不发）
 *
 * 上游会在正式回答前把 historyMessages 逐条**回灌**成 `type:"ai"` 帧，代理只能靠正文比对
 * 二次剥离；而下一轮的历史又包含上一轮已被污染的正文，重复逐轮叠加。
 * 同时实测：不发历史时上游凭 conversationId 自己保上下文（第二轮工具结果被正常接受、
 * 第三轮能正确引用前两轮结论），因此历史既多余又有害。只有显式要求时才发。
 */
export function assistantBody(config, input) {
  const uiToolList = [
    'execute_terminal_command',
    'remote_read',
    'remote_write',
    'remote_edit',
    'remote_glob',
    'remote_grep',
    'list_terminals',
  ]
  const payloadContent = input.toolResultText || input.content || ''
  const payloadType = input.type || (input.toolResultText ? 'ask' : 'start')
  const requestedModel = input.model || config.model || 'deepseek-v4.1-flash'
  const targetModel = UPSTREAM_MODEL_MAP[requestedModel] || requestedModel
  const baseEmphasis = input.toolResultText
    ? ''
    : '当用户需要执行命令、读写文件或检查状态时，必须调用工具真实执行，不要编造输出。'
  const emphasisPrompt = [baseEmphasis, input.envPrompt || ''].filter(Boolean).join('')
  return {
    conversationId: input.conversationId,
    user: {
      id: config.credential.uin || '',
      setting: {
        model: targetModel,
        enableThinking: input.enableThinking !== false,
        thinkingLevel: input.thinkingLevel || 'high',
        language: config.language || 'zh',
        tools: Array.isArray(input.tools) ? input.tools : [],
        mcpServers: [],
        uiServers: ['orcaterm'],
        approvedTools: uiToolList,
        approvedMCPTools: [],
        selectedMCPTools: {},
        selectedUITools: {
          orcaterm: uiToolList,
        },
        hideToolMessage: true,
        env: [],
        a2a: {},
      },
    },
    input: input.reviewInput
      // 官方工具结果协议（逆向 orcaterm_start.js 子 Agent 循环，2026-10-25）：
      //   {type:'review', reviewAction:'reportToolResult', toolResult, tool}
      // 实测对照：该协议下模型精确消费结果内容；而旧的 type:'ask' + {TOOL_RESULT} 文本
      // 会被模型当作普通用户消息时吃时忽略（"总数 0 / 未收到数据"症状的根源）。
      // 官方 Fe 对**所有** input 类型都补 {id, emphasisPrompt, files}（模块 2481）。
      ? {
        ...input.reviewInput,
        ...(input.inputId ? { id: input.inputId } : {}),
        // 官方 Fe 对所有 input 类型统一补 {id, emphasisPrompt, files}（模块 2481）。
        emphasisPrompt: input.reviewEmphasis || '',
        files: [],
      }
      : {
        type: payloadType,
        ...(input.inputId ? { id: input.inputId } : {}),
        input: payloadContent,
        content: payloadContent,
        emphasisPrompt,
        files: [],
        ...(input.sendHistoryMessages === true && Array.isArray(input.history) && input.history.length > 0
          ? { historyMessages: input.history }
          : {}),
      },
    stream: true,
  }
}

/** 解 one SSE frame 的 data 行（OrcaTerm 语义：`[DONE]`/`[ERROR]:`/`[ABORTED]` 三种控制帧）。 */
export function classifyDataLine(raw) {
  const text = String(raw || '').replace(/^\s*data:\s*/, '').trim()
  if (text === '' ) return { kind: 'noop' }
  if (text === '[DONE]') return { kind: 'done' }
  if (/^\[ERROR]:/.test(text)) return { kind: 'error', message: text.replace(/^\[ERROR]:[\s\n]*/, '') }
  if (/^\[ABORTED]/.test(text)) return { kind: 'aborted' }
  try {
    return { kind: 'data', item: JSON.parse(text) }
  } catch {
    return { kind: 'data', item: { content: text } }
  }
}
