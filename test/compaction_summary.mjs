// 压缩摘要轮的回归：上游**必须看到待压缩的对话**。
//
// 实报：模型切换触发上下文压缩后失败 ——
//   MODEL_SWITCH_COMPACTION_FAILED
//   cause = "summary is not smaller than the shadowed content (137 >= 134)"
//   或      "summarization produced no text summary content"
//
// 根因（实测对照）：压缩摘要是宿主的**辅助 LLM 调用**（purpose='compaction'），
// 消息体 =「待压缩的那段对话 + 一条压缩指令」。但反代默认**不补发历史**
// （sendHistoryMessages=false），于是上游只收到最后那条压缩指令 ——
// 它根本没见过要压缩的对话，产出的摘要与对话无关：
//   不带 history：191 字元话（"已按您指定的 Markdown 结构完成对话压缩检查点输出"），
//                 零事实 → 不比被压缩内容短 → 压缩被判失败；
//   带 history  ：999 字，逐字复述了对话里的具体事实（SHM 锁 / 8793 端口 / SQLite WAL）。
//
// 手法：假上游把**收到的请求体**记下来，断言压缩轮确实带了 historyMessages，
// 且待压缩的对话内容在里面。假上游不碰真 OrcaTerm，不需要登录态。
//
// 用法：node test/compaction_summary.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startServer } from '../backend/server.js'
import { toAssistantInput } from '../backend/server.js'

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

/** 假上游：记下收到的 assistant 请求体，回一个普通文本答案。 */
function startRecordingUpstream() {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({ type: 'ai', content: '## Primary Request and Intent\n- 摘要占位' })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      received,
    }))
  })
}

/** 压缩摘要轮的消息形态：待压缩的对话 + 宿主追加的压缩指令。 */
const COMPACTION_INSTRUCTION = 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint.'

function compactionMessages() {
  return [
    { role: 'user', content: '帮我查 SQLite 的 WAL 文件为什么一直 SHM 锁住。' },
    { role: 'assistant', content: '我先看进程占用。' },
    { role: 'user', content: '端口 8793 的反代要保持可用，别重启它。' },
    { role: 'assistant', content: '收到，我不会重启 8793 上的反代。' },
    { role: 'user', content: COMPACTION_INSTRUCTION },
  ]
}

console.log('1. 压缩摘要轮：上游必须收到待压缩的对话...')
{
  const fake = await startRecordingUpstream()
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${backend.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: compactionMessages(),
        stream: true,
        user: 'cid-compaction-orcaterm',
        orca_purpose: 'compaction',
        orca_send_history: true,
      }),
    })
    const raw = await res.text()
    assert.equal(res.status, 200, `压缩轮应 200，实际 ${res.status}`)
    assert.match(raw, /Primary Request and Intent/, '上游应回出正文')

    assert.equal(fake.received.length, 1, '上游应恰好收到一次请求')
    const body = fake.received[0]
    const history = body?.input?.historyMessages
    assert.ok(Array.isArray(history) && history.length > 0, '上游请求必须带 historyMessages（否则上游看不到待压缩的对话）')
    const flat = JSON.stringify(history)
    assert.match(flat, /SHM/, 'historyMessages 里应有待压缩对话的具体内容（SHM）')
    assert.match(flat, /8793/, 'historyMessages 里应有待压缩对话的具体内容（8793）')
    // 当前回合 = 压缩指令本身
    assert.match(String(body?.input?.input ?? ''), /compaction engine/, '当前输入应是压缩指令')
    console.log(`   historyMessages 条数=${history.length} 类型=${history.map((h) => h.type).join(',')}`)
    console.log(`   指令在 input.input 里：${String(body?.input?.input).slice(0, 40)}…`)
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('2. 压缩轮不能被误判成「对未决工具调用的反馈」...')
{
  // 区域最后一条 assistant 带 tool_calls（编码会话很常见）。若后端按 feedback
  // 形态发，reviewInput 分支**不带 historyMessages**，历史就丢了。
  const withToolCall = [
    { role: 'user', content: '看下目录' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_t_1', type: 'function', function: { name: 'pwsh', arguments: '{"command":"dir"}' } }] },
    { role: 'user', content: COMPACTION_INSTRUCTION },
  ]
  const fake = await startRecordingUpstream()
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${backend.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: withToolCall,
        stream: true,
        user: 'cid-compaction-toolcall',
        orca_purpose: 'compaction',
        orca_send_history: true,
      }),
    })
    await res.text()
    const body = fake.received[0]
    assert.ok(body, '上游应收到请求')
    assert.equal(body?.input?.reviewAction, undefined, '压缩轮不得走 feedback/review 形态')
    const history = body?.input?.historyMessages
    assert.ok(Array.isArray(history) && history.length > 0, '即使末条 assistant 带 tool_calls，压缩轮也必须带 historyMessages')
    assert.match(JSON.stringify(history), /看下目录/, 'historyMessages 里应有待压缩的对话内容')
    console.log(`   historyMessages 条数=${history.length}`)
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('3. 非压缩轮的行为不变（普通对话仍走 start 形态）...')
{
  const plain = toAssistantInput([
    { role: 'user', content: '你好' },
  ], {})
  assert.equal(plain.type, 'start', '普通轮仍是 start')
  assert.equal(plain.content, '你好')
  // 普通轮不补发历史（默认策略没变）
  const comp = toAssistantInput(compactionMessages(), { purpose: 'compaction' })
  assert.equal(comp.type, 'start', '压缩轮走 start 形态')
  assert.ok(comp.history.length >= 4, `压缩轮应把待压缩的对话放进 history，实际 ${comp.history.length} 条`)
  console.log(`   压缩轮 history 条数=${comp.history.length}`)
}

console.log('4. provider 侧：压缩轮必须「每次新会话 + 补发历史」...')
{
  const { OrcaTermWebApiAdapter, PROVIDER_ID } = await import('../lib/provider.js')
  const adapter = new OrcaTermWebApiAdapter({ baseUrl: 'http://127.0.0.1:1' })
  const options = { purpose: 'compaction', sessionId: 'session-x', messages: compactionMessages() }
  const first = adapter.resolveConversation(adapter.current(), options, compactionMessages())
  const second = adapter.resolveConversation(adapter.current(), options, compactionMessages())
  assert.equal(first.sendHistory, true, '压缩轮必须补发历史（否则上游看不到待压缩的对话）')
  assert.notEqual(first.conversationId, second.conversationId, '每次压缩都要新会话（否则上游上下文会叠加旧摘要）')
  assert.match(first.conversationId, /^cid-[0-9a-f]{12}-orcaterm$/, `会话 id 应是官方形态 cid-{uuid}-orcaterm，实际 ${first.conversationId}`)
  console.log(`   第一次=${first.conversationId} 第二次=${second.conversationId} sendHistory=${first.sendHistory}`)

  // 普通轮不受影响：仍按对账结果决定，且默认不补发历史。
  const plainOptions = { sessionId: 'session-y', messages: [{ role: 'user', content: '你好' }] }
  const plain = adapter.resolveConversation(adapter.current(), plainOptions, plainOptions.messages)
  assert.equal(plain.action, 'fresh')
  assert.equal(plain.sendHistory, false, '普通首轮不补发历史（策略未变）')
}

console.log('5. provider 发出的请求体必须带 orca_send_history 与 orca_purpose...')
{
  const { OrcaTermWebApiAdapter } = await import('../lib/provider.js')
  const seen = []
  const recorder = createServer((req, res) => {
    // 适配器会先探活 /health 再发聊天请求。能力清单要齐，否则契约校验会拒用这个后端。
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        version: '0.0.0-test',
        capabilities: ['openai-chat-completions', 'orca-cgi-passthrough', 'health-self-description'],
        credential: { cgiReady: true, assistantReady: true },
      }))
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({ type: 'ai', content: '## Primary Request and Intent\n- 摘要占位' })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const recorderPort = await new Promise((resolve) => {
    recorder.listen(0, '127.0.0.1', () => resolve(recorder.address().port))
  })
  const adapter = new OrcaTermWebApiAdapter({ baseUrl: `http://127.0.0.1:${recorderPort}` })
  try {
    // 压缩轮
    for await (const _chunk of adapter.stream('deepseek-v4.1-flash', {
      purpose: 'compaction',
      sessionId: 'session-z',
      messages: compactionMessages(),
    }, adapter.current(), null)) { /* drain */ }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].orca_purpose, 'compaction', '请求体必须带 orca_purpose=compaction')
    assert.equal(seen[0].orca_send_history, true, '请求体必须带 orca_send_history=true')
    console.log(`   orca_purpose=${seen[0].orca_purpose} orca_send_history=${seen[0].orca_send_history}`)

    // 普通轮：不得带这两个标记（否则上游每轮都被灌历史）
    for await (const _chunk of adapter.stream('deepseek-v4.1-flash', {
      sessionId: 'session-w',
      messages: [{ role: 'user', content: '你好' }],
    }, adapter.current(), null)) { /* drain */ }
    assert.equal(seen.length, 2)
    assert.equal(seen[1].orca_purpose, undefined, '普通轮不得带 orca_purpose')
    assert.equal(seen[1].orca_send_history, undefined, '普通轮不得带 orca_send_history')
  } finally {
    await new Promise((resolve) => recorder.close(resolve))
  }
}

console.log('\ncompaction_summary 全部通过！')
