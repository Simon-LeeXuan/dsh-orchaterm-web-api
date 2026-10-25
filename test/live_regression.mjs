#!/usr/bin/env node
/**
 * 活体回归脚本（需要本机反代在跑 + 有效 OrcaTerm 登录态 + 外网）。
 *
 *   node test/live_regression.mjs [baseUrl]      默认 http://127.0.0.1:8793
 *
 * 覆盖 2026-10-24 实测修复的三类缺陷（见 WORK_SUMMARY 第 10 节）：
 *   A. 回放剥离 —— 正文不再重复出现上一轮内容；
 *   B. 工具信封不再被回灌正文带偏 —— 能拿到干净的 tool_calls，且正文零泄漏；
 *   C. 工具结果被上游接受 —— 回传 {TOOL_RESULT} 后推进到 completion，不重发同一工具；
 *   D. provider 契约 —— DSH 原生形态的 `tool-call` 块与 `role:'tool'` 消息必须被翻译并送达
 *      上游（曾因丢弃 `role:'tool'` 导致工具结果根本发不出去，模型反复重发同一个调用）；
 *   E. 上下文对账 —— 追加轮沿用上游上下文不补发历史；重试/压缩则换新会话并补发历史。
 *
 * 它不是 npm test 的一部分：需要真机账号，不适合放进离线单测。
 * 想连「重发历史」那条危险路径一起测，就对 --send-history 起的实例跑（如 8794）。
 */

import { OrcaTermWebApiAdapter } from '../lib/provider.js'

const BASE = (process.argv[2] || process.env.E2E_BASE || 'http://127.0.0.1:8793').replace(/\/+$/, '')

const TOOLS = [{
  type: 'function',
  function: {
    name: 'pwsh',
    description: 'Run a shell command on the local machine',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
  },
}]

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`)
}

/** 走 OpenAI 面发一轮，收集正文/推理/工具调用/结束原因。 */
async function round(messages, { conversation, label, tools = TOOLS }) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages, tools, user: conversation }),
  })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const out = { content: '', reasoning: '', calls: [], finish: null, error: null }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]' || payload === '') continue
      let obj
      try { obj = JSON.parse(payload) } catch { continue }
      if (obj.error) out.error = obj.error
      const choice = obj.choices?.[0]
      if (!choice) continue
      if (choice.delta?.content) out.content += choice.delta.content
      if (choice.delta?.reasoning_content) out.reasoning += choice.delta.reasoning_content
      if (Array.isArray(choice.delta?.tool_calls)) for (const call of choice.delta.tool_calls) out.calls.push(call.function)
      if (choice.finish_reason) out.finish = choice.finish_reason
    }
  }
  console.log(`\n--- ${label}: finish=${out.finish} 正文=${out.content.length}字 推理=${out.reasoning.length}字 工具=${out.calls.length}${out.error ? ` 错误=${JSON.stringify(out.error)}` : ''}`)
  if (out.content) console.log(`    正文: ${JSON.stringify(out.content.slice(0, 300))}`)
  for (const call of out.calls) console.log(`    工具: ${call.name} ${String(call.arguments).slice(0, 220)}`)
  return out
}

const norm = (text) => String(text).replace(/\s+/g, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log(`活体回归目标：${BASE}\n`)

// ── A/B/C 都要用到的「上一轮有正文」前提 ──────────────────────
const Q1 = '用一段话解释什么是 Git 分支，不要调用任何工具。'
const conv = `cid-livereg-${Date.now()}`

const t1 = await round([{ role: 'user', content: Q1 }], { conversation: conv, label: 'A1 首轮纯文本' })
check('A1 有正文产出', t1.content.trim().length > 20, t1.content.slice(0, 120))
// v0.3.4：上游把思维链放在信封的 "thinking" 字段（不是 SSE reasoningContent 帧），
// 解包只认 taskCompletion 时整段被丢 —— 这里锁住「thinking → reasoning 流」这条链路。
check('A1 有思维链（信封 thinking 字段 → reasoning 流）', t1.reasoning.trim().length > 0, `reasoning=${t1.reasoning.slice(0, 120)}`)
await sleep(1200)

// ── C：本轮要求执行命令 → 应拿到干净 tool_calls，正文零泄漏、零回放 ──
const Q2 = '请列出当前工作目录下的文件，并检查它是不是 git 仓库。'
const t2 = await round([
  { role: 'user', content: Q1 },
  { role: 'assistant', content: t1.content },
  { role: 'user', content: Q2 },
], { conversation: conv, label: 'C1 工具请求轮（重发历史）' })
const head1 = norm(t1.content).slice(0, 20)
check('C1 拿到了工具调用（信封没被回灌正文带偏）', t2.calls.length > 0, `finish=${t2.finish} 正文=${t2.content.slice(0, 200)}`)
check('C1 正文没有夹带原始 JSON 信封', !t2.content.includes('"action"') && !t2.content.includes('taskCompletion'))
check('C1 正文没有回放上一轮（回放剥离生效）', head1.length < 8 || !norm(t2.content).includes(head1), t2.content.slice(0, 200))

// ── C：把工具结果回传给上游 → 应推进到 completion，且不重发同一工具 ──
if (t2.calls.length > 0) {
  const callId = 'call_livereg_1'
  const toolOutput = '=== 目录结构 ===\r\nAITask\r\nwork\r\ndsh-client-config\r\n\r\n=== Git 状态 ===\r\n不是 git 仓库\r\n'
  await sleep(1200)
  const t3 = await round([
    { role: 'user', content: Q1 },
    { role: 'assistant', content: t2.content || '', tool_calls: [{ id: callId, type: 'function', function: { name: t2.calls[0].name, arguments: t2.calls[0].arguments } }] },
    { role: 'tool', tool_call_id: callId, content: toolOutput },
  ], { conversation: conv, label: 'C2 工具结果回传轮' })
  check('C2 上游接受了工具结果（有正文、未重发同一工具）', t3.calls.length === 0 && t3.content.trim().length > 0, `calls=${t3.calls.length} finish=${t3.finish}`)
  check('C2 正文没有回放上一轮', head1.length < 8 || !norm(t3.content).includes(head1), t3.content.slice(0, 200))

  // ── A：纯追问一轮，服务端上下文应仍然有效且不回放 ──
  await sleep(1200)
  const t4 = await round([
    { role: 'user', content: Q1 },
    { role: 'assistant', content: t3.content },
    { role: 'user', content: '把上面两步的结论压成一句话。' },
  ], { conversation: conv, label: 'A2 纯追问（不带工具）' })
  check('A2 有正文产出', t4.content.trim().length > 5)
  check('A2 正文没有回放前面几轮', !norm(t4.content).includes(head1) && !norm(t4.content).includes(norm(t3.content).slice(0, 20)), t4.content.slice(0, 200))
}

// ── 工具映射：命令必须落到本机真实存在的工具上，且能真跑 ──
const cmd = t2.calls[0]
if (cmd) {
  let args = {}
  try { args = JSON.parse(cmd.arguments) } catch { /* 参数不是 JSON 时下面的断言会失败 */ }
  check('工具映射到本机真实工具', /^(pwsh|bash)$/.test(cmd.name), `name=${cmd.name}`)
  check('命令非空且被改写成可执行形态', typeof args.command === 'string' && args.command.trim().length > 0, String(args.command).slice(0, 200))
  console.log('\n本机可直接执行这条命令来验证「真的跑了」：')
  console.log('  ' + String(args.command).replace(/\r?\n/g, ' '))
}

// ── D/E：用真实 provider 适配器，按 DSH 的原生消息形态再走一遍 ──
// 这一段覆盖「上游面向的是 provider 还是反代」的差别：DSH 交给适配器的是
// `{type:'tool-call'}` 内容块与 `role:'tool'` 消息，翻译错了工具结果就永远发不出去。
{
  const logs = []
  const adapter = new OrcaTermWebApiAdapter({ baseUrl: BASE }, null, {
    warn: (m) => logs.push(m), debug: (m) => logs.push(m), info: () => {}, error: (m) => logs.push(m),
  })
  const fakeManager = { ensure: async () => {}, dispose: () => {} }
  const dshTools = [{ name: 'pwsh', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]
  // D1/D2 必须落在同一个会话键上：工具结果轮要复用上游那条「挂着待办工具调用」的会话。
  const dKey = `sess-livereg-${Date.now()}`

  const drive = async (messages) => {
    logs.length = 0
    let text = ''
    const calls = []
    for await (const chunk of adapter.stream('deepseek-v4.1-flash', { messages, tools: dshTools, sessionId: dKey }, undefined, fakeManager)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls.push(chunk.block)
    }
    return { text, calls, logs: logs.slice() }
  }

  const ask = '请列出当前工作目录下的文件。'
  const d1 = await drive([{ role: 'user', content: [{ type: 'text', text: ask }] }])
  check('D1 provider 能产出工具调用', d1.calls.length > 0, `calls=${d1.calls.length}`)
  check('D1 没有「丢弃非文本 block / 忽略未知角色」告警',
    !d1.logs.some((m) => /丢弃非文本 block|忽略未知角色/.test(m)),
    d1.logs.filter((m) => /丢弃|忽略/.test(m)).join(' | '))

  if (d1.calls.length > 0) {
    await sleep(1500)
    const call = d1.calls[0]
    const d2 = await drive([
      { role: 'user', content: [{ type: 'text', text: ask }] },
      { role: 'assistant', source: { kind: 'model', provider: 'orcaterm-web-api', model: 'deepseek-v4.1-flash' }, content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }] },
      { role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, isError: false, content: [{ type: 'text', text: '=== 目录结构 ===\nAITask\nwork\ndsh-client-config' }] },
    ])
    check('D2 工具结果送达上游（有正文、未重发同一工具）', d2.calls.length === 0 && d2.text.trim().length > 0,
      `calls=${d2.calls.length} text=${d2.text.slice(0, 160)}`)
  }

  // E：上下文对账 —— 追加轮沿用上游上下文；原样重发（重试）必须换会话
  const key = `sess-ctx-${Date.now()}`
  const drive2 = async (messages) => {
    logs.length = 0
    for await (const _chunk of adapter.stream('deepseek-v4.1-flash', { messages, tools: dshTools, sessionId: key }, undefined, fakeManager)) { /* 只取判定 */ }
    return logs.join(' | ')
  }
  const U1 = { role: 'user', content: [{ type: 'text', text: '用一句话解释什么是 Git 分支。' }] }
  const A1 = { role: 'assistant', source: { kind: 'model', provider: 'orcaterm-web-api', model: 'deepseek-v4.1-flash' }, content: [{ type: 'text', text: '分支是指向某次提交的可移动指针。' }] }
  const U2 = { role: 'user', content: [{ type: 'text', text: '再补一句它和 tag 的区别。' }] }
  const e1 = await drive2([{ role: 'system', content: 'S' }, U1])
  await sleep(1200)
  const e2 = await drive2([{ role: 'system', content: 'S' }, U1, A1, U2])
  check('E1 首轮判定 fresh', e1.includes('action=fresh'), e1)
  check('E2 追加轮判定 continue 且不补发历史', e2.includes('action=continue') && !e2.includes('换新会话'), e2)
  await sleep(1200)
  const e3 = await drive2([{ role: 'system', content: 'S' }, U1, A1, U2])
  check('E3 原样重发判定 resync 并换会话', e3.includes('action=resync') && e3.includes('换新会话'), e3)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n================ ${results.length - failed.length}/${results.length} 通过 ================`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log('  - ' + item.name)
  process.exit(1)
}