// 工具结果轮的「受理超时」回归：15s 只该约束「上游是否受理这次回传」（拿到响应头），
// **不能**给随后的流式答案加硬墙。
//
// 实报（session-21bd31eb / session-8b10359d）：工具结果轮里模型 reasoning 正在流，
// 第 15 秒连接被掐断 → DSH 报
//   「本轮运行失败 orchaterm-web-api 错误: The operation was aborted due to timeout」
// 内核再重试 2 次，每次都同样失败，整轮报废。
//
// 官方语义（模块 32804 `SE` = withTimeout(promise)）：超时只是「停止等待」并重试，
// 实现里只有 setTimeout + reject，没有任何 AbortSignal。所以照搬到 fetch 上本身就是误移植。
//
// 手法：假上游先立刻回响应头，然后**故意慢慢**吐正文（远超受理超时），最后 [DONE]。
// 断言客户端拿到完整正文。用短超时（800ms）驱动同一段代码路径，测试几秒内跑完。
//
// 用法：node test/report_timeout.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startServer } from '../backend/server.js'

const ACCEPT_TIMEOUT_MS = 800   // 受理阶段上限（替代线上的 15000，让测试快）
const BODY_SPREAD_MS = 2600     // 正文吐得比受理上限久得多 —— 修复前必然被掐断

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'Run a PowerShell command on the local Windows machine.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
]

const FAKE_CREDENTIAL = {
  token: 'fake.token.value',
  assistantBearer: 'fake.token.value',
  cookieHeader: 'uin=fake; skey=fake',
  jar: [],
  uin: 'fake',
  ownerUin: 'fake',
  skey: 'skeyfake',
  csrfCode: '1',
  sources: ['test'],
  expiresAtMs: Date.now() + 3600_000,
  cgiReady: true,
  assistantReady: true,
  detail: {},
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 假上游：立刻回头，正文分片慢吐，最后 [DONE]。可指定每片后等多久。 */
function startSlowUpstream({ pieces, gapMs, sawAbort }) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      // 第一片里放一个完整的信封：正文部分（taskCompletion），随后慢慢吐更多。
      const frames = pieces.map((p) => ({ type: 'ai', content: p }))
      for (let i = 0; i < frames.length; i += 1) {
        if (res.writableEnded || res.destroyed) return
        if (i > 0) await new Promise((r) => setTimeout(r, gapMs))
        res.write(`data: ${JSON.stringify(frames[i])}\n\n`)
      }
      if (res.writableEnded || res.destroyed) return
      res.write('data: [DONE]\n\n')
      res.end()
    })
    res.on('close', () => { if (!res.writableEnded) sawAbort() })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function callProxy(port, messages) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages, stream: true, tools: TOOLS, user: 'cid-report-timeout-orcaterm' }),
  })
  const raw = await res.text()
  const chunks = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const p = t.slice(5).trim()
    if (p === '[DONE]') continue
    try { chunks.push(JSON.parse(p)) } catch { /* ignore */ }
  }
  const deltaOf = (k) => chunks.map((c) => c.choices?.[0]?.delta?.[k] ?? '').join('')
  return {
    content: deltaOf('content'),
    reasoning: deltaOf('reasoning_content'),
    finish: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop() ?? null,
    errors: chunks.map((c) => c.error?.message).filter(Boolean),
  }
}

/** 工具结果轮的消息形态：assistant 发了 tool_calls，随后一条 tool 结果（触发 isToolReport）。 */
function toolReportMessages() {
  return [
    { role: 'user', content: '看下目录' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_t_1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"dir"}' } }] },
    { role: 'tool', tool_call_id: 'call_t_1', content: 'a.txt\nb.txt' },
  ]
}

console.log('1. 工具结果轮：正文比受理超时慢得多时，仍必须完整送达...')
{
  const TAIL = '这是慢慢吐出来的结论正文。'
  // 第一个信封只给 thinking（不产生正文），之后用 taskCompletion 吐正文，分 5 片跨 ~2.6s
  const pieces = [
    '{"thinking":"先看工具结果。"',
    ',"taskCompletion":"',
    TAIL.slice(0, 4),
    TAIL.slice(4, 8),
    TAIL.slice(8, 12),
    `${TAIL.slice(12)}"}`,
  ]
  let abortedByFake = false
  const fake = await startSlowUpstream({ pieces, gapMs: Math.round(BODY_SPREAD_MS / pieces.length), sawAbort: () => { abortedByFake = true } })
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
    reportRetryTimeoutMs: ACCEPT_TIMEOUT_MS,
  })
  try {
    const out = await callProxy(backend.port, toolReportMessages())
    console.log(`   正文=${JSON.stringify(out.content)} finish=${out.finish} errors=${JSON.stringify(out.errors)}`)
    // 1a. 正文必须完整（修复前会在受理超时处被掐断，正文残缺 + 出现 abort 错误帧）
    assert.equal(out.content, TAIL, `正文应完整送达，实际=${JSON.stringify(out.content)}`)
    // 1b. 不能出现「被超时掐断」的错误帧
    assert.equal(out.errors.length, 0, `不应有错误帧：${JSON.stringify(out.errors)}`)
    assert.equal(out.finish, 'stop')
    // 1c. 假上游不该看到客户端提前断开
    assert.equal(abortedByFake, false, '连接不应在正文吐完前被掐断')
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('2. 受理阶段确实卡住时，仍要按官方语义超时并重试 3 次...')
{
  // 假上游：**不回头**（一直挂着），用于验证受理超时仍然生效（这次是它的正当用途）
  let attempts = 0
  const hang = createServer((req) => { attempts += 1 /* 只收不答 */ })
  const hangPort = await new Promise((resolve) => hang.listen(0, '127.0.0.1', () => resolve(hang.address().port)))
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${hangPort}`,
    credential: FAKE_CREDENTIAL,
    reportRetryTimeoutMs: 300,
  })
  try {
    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${backend.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: toolReportMessages(), stream: true, tools: TOOLS, user: 'cid-hang' }),
    })
    const payload = await res.json().catch(() => null)
    const elapsed = Date.now() - started
    console.log(`   HTTP ${res.status} ${JSON.stringify(payload?.error?.message || payload)} 用时 ${elapsed}ms，上游收到 ${attempts} 次`)
    assert.equal(res.status, 502, '受理一直超时应收 502')
    assert.match(String(payload?.error?.message || ''), /没有返回/, '错误应说明是受理超时')
    assert.equal(attempts, 3, `应重试 3 次，实际 ${attempts}`)
    // 300ms × 3 次 + 退避(300+600) ≈ 1.8s；给足余量
    assert.ok(elapsed < 6000, `总耗时应在数秒内，实际 ${elapsed}ms`)
  } finally {
    await backend.close()
    await new Promise((resolve) => hang.close(resolve))
  }
}

console.log('\nreport_timeout 全部通过！')
