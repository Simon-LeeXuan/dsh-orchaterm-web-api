// 「映射会话被上游卡死 → 零输出」的救援回归。
//
// 实报：session-628db98d（2026-10-27，Godot 任务会话）——
//   15:04 起上游对同一 conversationId 连续 200 + 零输出（provider 侧
//   inputTokens≈32500 计入、outputTokens 恒 0），此后该 cid 的每一轮、
//   换模型（glm-5.3-flash → hy3）都零输出；DSH 侧 EMPTY_RESPONSE 重试
//   2 次后整轮失败（turn/end code=EMPTY_RESPONSE ×3）。
// 同时间窗实测对照：最小请求、新会话 + 127KB 大输入都完全正常 ——
// 卡死的是上游按 conversationId 保存的会话状态，不是账号、不是模型。
//
// 根因：宿主每轮都带同一个 cid（provider 的会话映射 payload.user），反代按 cid
// 去重只发增量（DELIVERED.textsFor）；旧 cid 一旦被上游卡死就永远救不回来 ——
// 桌面端那个会话没有任何自愈路径。
//
// 修复（与压缩摘要轮同款模式）：流结束零正文/零工具调用时，abort 掉旧 cid 的
// 僵尸流，换全新会话 + 补发全量历史（含系统要求）重入一次；工具结果信封
// （review/ask/feedback）引用旧会话的调用 id，新会话认不得，降级为普通 start。
// 救援后记住 cid 映射：下一轮直接用救援会话，不再撞一次注定零输出的旧 cid。
//
// 手法：假上游对「卡死 cid」回 200 + 事件流但零内容（两种终止形态各测一次：
// 带 [DONE] 与不带 [DONE]——后者会先走断流续传检查），对其它 cid 正常回
// completion 信封。假上游不碰真 OrcaTerm，不需要登录态。
// 每组用独立的卡死 cid：RESCUED_CID 与 DELIVERED 是模块级记忆，跨组串味。
//
// 用法：node test/empty_response_rescue.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startServer } from '../backend/server.js'

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
// 真 JWT 形状 + 未来 exp：让 ensureFreshCredential 不触发 refreshCredential（不打真桌面端 store）。
const FAKE_JWT = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`
const FAKE_CREDENTIAL = {
  token: FAKE_JWT,
  assistantBearer: FAKE_JWT,
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

/**
 * 假上游：卡死 cid 回「受理但零输出」（可选带不带 [DONE]），其它 cid 正常回 completion 信封。
 * 记下收到的 assistant 请求体（received）与 /stream/abort 次数（state.aborts）。
 */
function startRecordingUpstream({ stuckCid, sendDoneForStuck }) {
  const received = []
  const state = { aborts: 0, completions: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      if (raw.trim()) {
        try { body = JSON.parse(raw) } catch { /* 流控制等请求体不是 JSON */ }
      }
      if (req.url.includes('/stream/abort/')) state.aborts += 1
      if (req.method === 'POST' && body.conversationId) received.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (body.conversationId === stuckCid) {
        // 卡死会话：受理但一个字不吐（session-628db98d 实测形态）
        res.write(`data: ${JSON.stringify({ type: 'ai', content: '' })}\n\n`)
        if (sendDoneForStuck) res.write('data: [DONE]\n\n')
      } else {
        state.completions += 1
        res.write(`data: ${JSON.stringify({ type: 'ai', content: JSON.stringify({ action: 'completion', thinking: '', taskCompletion: `正常-${state.completions}` }) })}\n\n`)
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received, state }))
  })
}

function chatMessages() {
  return [
    { role: 'system', content: '你是 DSH 编码代理，必须用工具真实执行。' },
    { role: 'user', content: '扫描当前目录' },
    { role: 'assistant', content: '已扫描，共 12 个文件。' },
    { role: 'user', content: '继续' },
  ]
}

async function chat(port, cid) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orca-conversation-id': cid },
    body: JSON.stringify({ model: 'glm-5.3-flash', stream: false, messages: chatMessages() }),
  })
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  return res.json()
}

console.log('1. 带 [DONE] 的零输出：自动换新会话 + 补发历史救援...')
{
  const stuckCid = 'cid-stuckgroup1-orcaterm'
  const fake = await startRecordingUpstream({ stuckCid, sendDoneForStuck: true })
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const data = await chat(backend.port, stuckCid)
    assert.match(data.choices?.[0]?.message?.content ?? '', /^正常-\d+$/,
      `救援后应有正文，实际 ${JSON.stringify(data.choices?.[0]?.message?.content)}`)
    assert.equal(fake.received.length, 2, `应恰好两次上游请求（卡死轮 + 救援轮），实际 ${fake.received.length}`)
    const rescue = fake.received[1]
    assert.notEqual(rescue.conversationId, stuckCid, '救援轮必须换新会话')
    const history = rescue.input?.historyMessages
    assert.ok(Array.isArray(history) && history.length >= 2, '救援轮必须补发全量历史')
    assert.match(JSON.stringify(history), /扫描当前目录/, '历史里应有此前的对话')
    assert.match(String(rescue.input?.input ?? ''), /系统要求/, '救援轮必须保留系统要求（新会话没有上游按 cid 保留的上下文）')
    assert.equal(rescue.input?.type, 'start', '救援轮降级为普通 start（review 信封引用旧会话的调用 id，新会话认不得）')
    assert.ok(fake.state.aborts >= 1, '救援前应 abort 掉卡死会话的僵尸流')
    console.log(`   救援会话=${rescue.conversationId} 历史条数=${history.length} abort=${fake.state.aborts}`)
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('2. 不带 [DONE] 的零输出（断流续传也救不回）：同样救援...')
{
  const stuckCid = 'cid-stuckgroup2-orcaterm'
  const fake = await startRecordingUpstream({ stuckCid, sendDoneForStuck: false })
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const data = await chat(backend.port, stuckCid)
    assert.match(data.choices?.[0]?.message?.content ?? '', /^正常-\d+$/,
      `救援后应有正文，实际 ${JSON.stringify(data.choices?.[0]?.message?.content)}`)
    assert.equal(fake.received.length, 2, `应恰好两次上游请求（卡死轮 + 救援轮），实际 ${fake.received.length}`)
    assert.notEqual(fake.received[1].conversationId, stuckCid)
    console.log('   救援会话=' + fake.received[1].conversationId)
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('3. 救援成功后记住映射：下一轮直接用救援会话...')
{
  const stuckCid = 'cid-stuckgroup3-orcaterm'
  const fake = await startRecordingUpstream({ stuckCid, sendDoneForStuck: true })
  const backend = await startServer({
    port: await freePort(),
    assistantBase: `http://127.0.0.1:${fake.port}`,
    credential: FAKE_CREDENTIAL,
  })
  try {
    const data = await chat(backend.port, stuckCid)
    assert.match(data.choices?.[0]?.message?.content ?? '', /^正常-\d+$/)
    const rescuedCid = fake.received[1].conversationId
    assert.ok(rescuedCid && rescuedCid !== stuckCid)
    const data2 = await chat(backend.port, stuckCid)
    assert.match(data2.choices?.[0]?.message?.content ?? '', /^正常-\d+$/)
    const next = fake.received[fake.received.length - 1]
    assert.equal(next.conversationId, rescuedCid, '下一轮应直接用救援会话（不再撞卡死 cid）')
    assert.equal(next.input?.historyMessages, undefined, '救援会话后续轮不补发历史（上游按 cid 自己保上下文）')
    assert.equal(fake.received.length, 3, '下一轮不应再产生一次救援')
  } finally {
    await backend.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

console.log('\n全部通过：零输出救援（新会话 + 补发历史 + cid remap）工作正常')
