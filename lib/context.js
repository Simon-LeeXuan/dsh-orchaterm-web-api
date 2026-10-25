/**
 * 上游会话上下文 与 DSH 消息历史 的对账。
 *
 * ## 为什么需要这一步
 *
 * 反代默认**不把 DSH 的多轮历史发给上游**（上游会把它逐条回灌成 `type:"ai"` 帧污染正文，
 * 详见 backend/upstream.js），上下文改由上游按 `conversationId` 自己维护。
 * 代价是 DSH 侧的压缩、改写、编辑不会自动同步到上游，上游会话一旦丢失也无法自愈。
 *
 * 这里用「消息指纹前缀比对」把两边对上账：
 *
 * | 情形 | 判据 | 处理 |
 * | --- | --- | --- |
 * | 首次对话 | 无上次记录 | `fresh`：新会话，无历史可发 |
 * | 正常追加 | 上次列表是本次列表的前缀，且更长 | `continue`：沿用上游上下文 |
 * | 压缩 / 改写 / 编辑 | 前缀对不上，或列表变短 | `resync`：换新会话 + 一次性补发历史 |
 * | 重试同一条 | 列表长度与内容与上次完全相同 | `resync`：否则上游会看到重复的一轮 |
 * | 轮数超上限 | `rounds >= maxRounds` | `resync`：借 DSH 压缩过的历史给上游瘦身 |
 * | 工具结果轮 | 末条消息是 `tool` | `continue`：上游还挂着待办的工具调用，**必须**留在同一会话 |
 *
 * 「换新会话 + 补发历史」把 DSH 的（可能已压缩的）历史一次性交给上游，同时让上游上下文
 * 归零重算，因此压缩同步与上下文膨胀两个问题一起解决。补发的那一轮，输出侧的历史回放剥离
 * 会自动生效（见 backend/agent-protocol.js 的重复剥离器）。
 *
 * 只比对**非 system** 消息：DSH 的系统提示词每轮可能带动态内容（时间、目录等），
 * 把它算进来会让每一轮都判定为「改写」而反复补发历史。
 *
 * @module lib/context.js
 */

/** 稳定短哈希（FNV-1a）；只做指纹，不承担安全职责。 */
function hashOf(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 取消息列表的指纹（逐条 `role|hash`）。忽略 system/developer —— 理由见模块说明。
 *
 * @param {Array} messages OpenAI 形态的消息（`formatOpenAiMessages` 的输出）
 * @returns {string[]}
 */
export function fingerprintMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  const out = []
  for (const message of list) {
    const role = message?.role
    if (role === 'system' || role === 'developer') continue
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
        .map((call) => `${call?.id ?? ''}:${call?.function?.name ?? ''}:${call?.function?.arguments ?? ''}`)
        .join(',')
      : ''
    out.push(`${role}|${hashOf(`${message?.content ?? ''}#${calls}#${message?.tool_call_id ?? ''}`)}`)
  }
  return out
}

/** 逐位比对前缀。 */
function isPrefix(previous, current) {
  if (previous.length > current.length) return false
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i] !== current[i]) return false
  }
  return true
}

/**
 * 造一个对账器。状态按会话键保存（会话键由 provider 决定：DSH sessionId 或首条用户消息指纹）。
 *
 * @param {{maxConversations?:number}} [options]
 * @returns {{
 *   decide:(key:string, messages:Array, options?:{maxRounds?:number}) => {action:'fresh'|'continue'|'resync', reason:string, rounds:number},
 *   reset:(key:string) => void,
 *   size:() => number,
 * }}
 */
export function createContextTracker(options = {}) {
  const maxConversations = Number(options.maxConversations) > 0 ? Number(options.maxConversations) : 64
  const store = new Map()

  function remember(key, list, rounds) {
    // 重插以维持 LRU 顺序
    store.delete(key)
    store.set(key, { list, rounds })
    while (store.size > maxConversations) store.delete(store.keys().next().value)
  }

  function decide(key, messages, decideOptions = {}) {
    const current = fingerprintMessages(messages)
    const entry = store.get(key)
    const previous = entry?.list ?? null
    const lastRole = lastNonSystemRole(messages)

    // 工具结果轮：上游还挂着待办的工具调用，换会话会让它变成孤儿，必须留在原地。
    if (lastRole === 'tool') {
      remember(key, current, entry?.rounds ?? 0)
      return { action: 'continue', reason: 'tool-round', rounds: entry?.rounds ?? 0 }
    }

    if (!previous) {
      remember(key, current, 0)
      return { action: 'fresh', reason: 'new-conversation', rounds: 0 }
    }

    if (current.length < previous.length) {
      remember(key, current, 0)
      return { action: 'resync', reason: 'history-shrank', rounds: 0 }
    }
    if (!isPrefix(previous, current)) {
      remember(key, current, 0)
      return { action: 'resync', reason: 'history-rewritten', rounds: 0 }
    }
    if (current.length === previous.length) {
      remember(key, current, 0)
      return { action: 'resync', reason: 'retry-same-history', rounds: 0 }
    }

    const rounds = (entry?.rounds ?? 0) + 1
    const maxRounds = Number(decideOptions.maxRounds) > 0 ? Number(decideOptions.maxRounds) : 0
    if (maxRounds > 0 && rounds >= maxRounds) {
      remember(key, current, 0)
      return { action: 'resync', reason: 'round-cap', rounds: 0 }
    }

    remember(key, current, rounds)
    return { action: 'continue', reason: 'append-only', rounds }
  }

  return {
    decide,
    reset: (key) => { store.delete(key) },
    size: () => store.size,
  }
}

/** 末条非 system 消息的角色。 */
function lastNonSystemRole(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const role = list[i]?.role
    if (role !== 'system' && role !== 'developer') return role
  }
  return ''
}