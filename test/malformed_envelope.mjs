// 畸形信封回归：模型把工具信封写成**非法 JSON**（实测：thinking 字符串里带未转义的 "），
// 且整包以正文形式落到客户端。期望行为：仍然恢复出工具调用（而不是把原始 JSON 当正文吐给用户）。
//
// 手法：起一个假上游（说 OrcaTerm 的 SSE 方言），把反代 --assistant-base 指向它，
// 于是"上游产出畸形信封"这件事被完全确定化，不再依赖线上模型的心情。
//
// 用法：node test/malformed_envelope.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startServer } from '../backend/server.js'
import { recoverToolEnvelope, createEnvelopeFenceGuard } from '../backend/agent-protocol.js'

// ── 线上真实样本（session-dba58595 turn 8，逐字符照抄）──────────────────
// 注意 "thinking" 的值里有未转义的引号：`…但用户已经明确说"帮我关机，关闭电脑"，…`
// 这一段让整包 JSON.parse 失败 —— 就是它把信封逼成了正文。
const MALFORMED_THINKING_ENVELOPE = [
  '{',
  '  "action": "review",',
  '  "thinking": "用户要求关机。这是 Windows 环境，需要使用 PowerShell 的关机命令。关机是不可逆操作，需要先确认。但用户已经明确说"帮我关机，关闭电脑"，意图清晰。使用 shutdown /s /t 0 命令立即关机。",',
  '  "tool": {',
  '    "type": "mcp",',
  '    "mcpServer": "mcp-server-orcaterm-oauth",',
  '    "name": "execute_command",',
  '    "description": "立即关闭计算机",',
  '    "args": {',
  '      "command": "shutdown /s /t 0"',
  '    }',
  '  }',
  '}',
].join('\n')

const FENCED = `\`\`\`json\n${MALFORMED_THINKING_ENVELOPE}\n\`\`\``

// 先离线确认这份样本确实是"非法 JSON"（否则这个测试就测不到东西了）
assert.throws(() => JSON.parse(MALFORMED_THINKING_ENVELOPE), '样本必须是非法的 JSON，否则测不到兜底路径')

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'Run a PowerShell command on the local Windows machine.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    },
  },
]

/** 把一段文本切成 n 片（模拟 SSE 分片：跨帧是本类 bug 的必要条件之一）。 */
function sliceInto(text, n) {
  const size = Math.ceil(text.length / n)
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** 假上游：按 OrcaTerm SSE 方言回一段 AI content，然后 [DONE]。 */
function startFakeUpstream(frames) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      for (const item of frames) res.write(`data: ${JSON.stringify(item)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

/** 收 SSE 的 tool_calls / content / reasoning，并给出 finish_reason。 */
async function callProxy(port, content) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content }],
      stream: true,
      tools: TOOLS,
      user: 'cid-malformed-test-orcaterm',
    }),
  })
  assert.equal(res.status, 200, '反代应回 200')
  const raw = await res.text()
  const chunks = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const p = t.slice(5).trim()
    if (p === '[DONE]') continue
    try { chunks.push(JSON.parse(p)) } catch { /* 非 JSON 帧忽略 */ }
  }
  const deltaOf = (k) => chunks.map((c) => c.choices?.[0]?.delta?.[k] ?? '').join('')
  return {
    chunks,
    content: deltaOf('content'),
    reasoning: deltaOf('reasoning_content'),
    toolCalls: chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []),
    finish: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop() ?? null,
    raw,
  }
}

// 假上游不需要真凭据，但反代的前置检查要求 assistantReady（uin+skey 齐）。
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

console.log('1. recoverToolEnvelope 能从不合法 JSON 里恢复工具信封...')
{
  // 1a. 严格 JSON 走原路
  const ok = recoverToolEnvelope(JSON.stringify({ action: 'review', tool: { name: 'execute_command', args: { command: 'x' } } }))
  assert.equal(ok.envelope.tool.name, 'execute_command')
  assert.equal(ok.recovered, false, '合法 JSON 不应标成 recovered')

  // 1b. 线上那份畸形样本：恢复出 name / args / action，且 thinking 取到完整值
  const rec = recoverToolEnvelope(FENCED)
  assert.ok(rec, '畸形信封必须能恢复')
  assert.equal(rec.recovered, true)
  assert.equal(rec.envelope.action, 'review')
  assert.equal(rec.envelope.tool.name, 'execute_command')
  assert.equal(rec.envelope.tool.mcpServer, 'mcp-server-orcaterm-oauth')
  assert.equal(rec.envelope.tool.type, 'mcp')
  assert.equal(rec.envelope.tool.description, '立即关闭计算机')
  assert.deepEqual(rec.envelope.tool.args, { command: 'shutdown /s /t 0' })
  // thinking 的容错取值：容忍值里那个未转义的引号，一直取到真正的收尾引号
  assert.ok(rec.thinking.includes('帮我关机，关闭电脑'), `thinking 应含被未转义引号截断的后半段，实际=${rec.thinking}`)
  assert.ok(rec.thinking.endsWith('命令立即关机。'), `thinking 应取到真正收尾，实际=${rec.thinking.slice(-30)}`)

  // 1c. 没有 tool 对象的普通正文 → null（不能把散文误判成信封）
  assert.equal(recoverToolEnvelope('```json\n{"action":"completion","taskCompletion":"你好"}\n```'), null)
  assert.equal(recoverToolEnvelope('就是一段普通文字，里面提到了 "action" 和 "tool" 两个词'), null)
  assert.equal(recoverToolEnvelope(''), null)
  assert.equal(recoverToolEnvelope(null), null)

  // 1d. 严格路径保持既有语义：只要有 action + tool 对象就放行（缺 name 由 resolveDshToolCall 兜成 unknown）
  const namelessStrict = recoverToolEnvelope('{"action":"review","tool":{"type":"mcp"}}')
  assert.equal(namelessStrict.recovered, false)
  assert.equal(namelessStrict.envelope.tool.name, undefined)

  // 1e. 宽松路径则**必须**拿到 name 才认 —— 非法 JSON 里的「tool 对象」可能只是散文里的只言片语
  assert.equal(recoverToolEnvelope('{"action":"review","thinking":"x","tool":{"type":"mcp",}}'), null)
  assert.equal(recoverToolEnvelope('他说 "tool": { 然后就没有了'), null)

  // 1f. 还要有「信封证据」（显式 action 或 args）——否则散文里提一句 "tool": {"name": …} 就被误吞
  assert.equal(recoverToolEnvelope('文档里写 "tool": {"name": "execute_command"} 这样的字段'), null)
  // 有 args、没 action（模型省字段）→ 仍认，action 兜成 review
  const noAction = recoverToolEnvelope('{"thinking":"x","tool":{"name":"remote_read","args":{"path":"a.txt"}}} extra')
  assert.equal(noAction.recovered, true)
  assert.equal(noAction.envelope.action, 'review')
  assert.deepEqual(noAction.envelope.tool.args, { path: 'a.txt' })

  // 1g. args 本身也坏掉 → 仍恢复工具名，args 退化成空对象（可见但不静默）
  const badArgs = recoverToolEnvelope('{"action":"review","thinking":"x","tool":{"name":"execute_command","args":{bad json}}}')
  assert.ok(badArgs)
  assert.equal(badArgs.envelope.tool.name, 'execute_command')
  assert.equal(badArgs.argsRecovered, false)
  assert.equal(badArgs.recovered, true)
}

console.log('2. createEnvelopeFenceGuard 处理跨帧围栏...')
{
  // 2a. 整块一次到 → 挂起后立刻闭环
  const g1 = createEnvelopeFenceGuard()
  const r1 = g1.feed('前置说明\n```json\n{"action":"review"}\n```')
  assert.equal(r1.emit, '前置说明\n', '围栏前的正文先放行')
  assert.ok(r1.candidate && r1.candidate.includes('"action"'), '闭环后给出候选块')
  assert.equal(g1.holding(), false)

  // 2b. 跨帧切片 → 中段不出字，闭环后才给候选（这正是逐帧匹配漏掉的场景）
  const g2 = createEnvelopeFenceGuard()
  const pieces = sliceInto(FENCED, 7)
  const emitted = []
  let candidate = null
  for (const p of pieces) {
    const step = g2.feed(p)
    if (step.emit) emitted.push(step.emit)
    if (step.candidate) candidate = step.candidate
  }
  assert.equal(emitted.join(''), '', '挂起期间不应把信封碎片当正文吐出')
  assert.ok(g2.holding() === false)
  assert.ok(candidate, '跨帧也必须闭环并给出候选')
  assert.ok(recoverToolEnvelope(candidate), '候选块应能被恢复')

  // 2c. 围栏一直不闭环 → flush 必须把挂起内容交还调用方（宁可漏拦截，不能吞正文）
  const g3 = createEnvelopeFenceGuard()
  const r3 = g3.feed('```json\n{"action":"review"')
  assert.equal(r3.emit, '')
  assert.equal(g3.holding(), true)
  const f3 = g3.flush()
  assert.equal(f3.emit, '', 'flush 不再自己出正文')
  assert.equal(f3.candidate, '```json\n{"action":"review"', 'flush 把挂起块交还调用方')
  // 交还的块恢复不出信封 → 调用方会原样下发，所以文本不会丢
  assert.equal(recoverToolEnvelope(f3.candidate), null)
  assert.equal(g3.holding(), false, 'flush 之后不再挂起')

  // 2d. 挂起超上限 → 自动放行，不无限占内存
  const g4 = createEnvelopeFenceGuard({ maxHold: 40 })
  const r4 = g4.feed(`\`\`\`json\n{"action":"review","padding":"${'x'.repeat(200)}"`)
  assert.ok(r4.emit.length > 0, '超过 maxHold 应放行')
  assert.equal(g4.holding(), false)
}

/** 找一个空闲端口（startServer 的 port 用 `options.port || 8793`，传 0 拿不到临时端口）。 */
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

console.log('3. 端到端：假上游吐畸形信封，反代必须产出工具调用而不是正文...')
{
  // 分 6 片投递，同时覆盖"跨帧"与"非法 JSON"两个维度
  const frames = sliceInto(MALFORMED_THINKING_ENVELOPE, 6).map((content) => ({ type: 'ai', content }))
  const fake = await startFakeUpstream(frames)
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const out = await callProxy(backend.port, '帮我关机，关闭电脑')

    // 3a. 必须拿到工具调用，且映射成 DSH 的 pwsh
    assert.equal(out.toolCalls.length, 1, `应恰好 1 个工具调用，实际 ${out.toolCalls.length}；正文=${out.content.slice(0, 200)}`)
    assert.equal(out.toolCalls[0].function.name, 'pwsh')
    const args = JSON.parse(out.toolCalls[0].function.arguments)
    assert.equal(args.command, 'shutdown /s /t 0')
    assert.equal(out.finish, 'tool_calls')

    // 3b. 原始信封绝不能再出现在正文里（这就是用户报的症状）
    assert.equal(/"action"\s*:/.test(out.content), false, `正文不应夹带 action 字段：${out.content.slice(0, 300)}`)
    assert.equal(/"mcpServer"/.test(out.content), false)
    assert.equal(out.content.includes('shutdown /s /t 0'), false, '正文不应回显命令')
    assert.equal(out.content.includes('```'), false, '正文不应残留围栏')

    // 3c. 被打断的思考链尾段应改道进 reasoning，而不是丢进正文
    assert.ok(out.reasoning.includes('用户要求关机'), 'reasoning 应含思考前缀')
    assert.ok(out.reasoning.includes('帮我关机，关闭电脑'), `思考尾段应改道 reasoning，实际=${out.reasoning.slice(-80)}`)

    console.log(`   ✓ 工具调用=${out.toolCalls[0].function.name}(${args.command})，正文长度=${out.content.length}，reasoning 长度=${out.reasoning.length}`)
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('\nmalformed_envelope 全部通过！')
