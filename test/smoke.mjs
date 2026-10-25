import assert from 'node:assert/strict'
import { OrcaTermWebApiAdapter, PROVIDER_ID, name, inject, apply } from '../lib/provider.js'
import { classifyDataLine, cgiHeaders, assistantHeaders, identityOf, DESKTOP_IDENTITY } from '../backend/upstream.js'
import { csrfCodeOf } from '../backend/credentials.js'
import { buildConfig, ensureFreshCredential } from '../backend/server.js'
import { createContextTracker, fingerprintMessages } from '../lib/context.js'
import { DEFAULTS, MANAGER_KEYS } from '../lib/config.js'
import { flattenContent, formatOpenAiMessages } from '../lib/openai.js'
import {
  classifyCommandShell,
  createDeliveredHistory,
  createGreetingStripper,
  createRepeatStripper,
  createThinkingTagRouter,
  describeExecutionHost,
  parseToolEnvelope,
  resolveDshToolCall,
  rewriteCommandChain,
  splitCommandChain,
  toWindowsPath,
  wrapCommandForShell,
} from '../backend/agent-protocol.js'

console.log('1. 验证插件基本导出与元数据...')
assert.equal(name, 'dsh-orchaterm-web-api-provider')
assert.deepEqual(inject, ['llm'])
assert.equal(typeof apply, 'function')

console.log('2. 验证 CSRF 算法一致性 (djb2)...')
assert.equal(csrfCodeOf(''), '')
// 测试固定字符串哈希验证算法正常运行
const code = csrfCodeOf('test_skey_12345')
assert.match(code, /^\d+$/)

console.log('3. 验证 SSE 数据行解析分类器 (classifyDataLine)...')
assert.deepEqual(classifyDataLine(''), { kind: 'noop' })
assert.deepEqual(classifyDataLine('data: [DONE]'), { kind: 'done' })
assert.deepEqual(classifyDataLine('data: [ABORTED]'), { kind: 'aborted' })
assert.deepEqual(classifyDataLine('data: [ERROR]: test error'), { kind: 'error', message: 'test error' })
const jsonItem = classifyDataLine('data: {"id":"123","content":"hello"}')
assert.equal(jsonItem.kind, 'data')
assert.equal(jsonItem.item.content, 'hello')

console.log('4. 验证 Provider 适配器生命周期与插件注册...')
let registeredRoute = null
let registeredAdapter = null
let registeredConfigurable = null

const fakeCtx = {
  llm: {
    registerAdapter(routes, adapter) {
      registeredRoute = routes[0]
      registeredAdapter = adapter
      return () => { registeredRoute = null }
    },
    registerConfigurableProviders(list) {
      registeredConfigurable = list
    }
  },
  on(event, handler) {}
}

const adapterInstance = apply(fakeCtx, { baseUrl: 'http://127.0.0.1:8793' })
assert.equal(registeredRoute, PROVIDER_ID)
assert.equal(registeredConfigurable[0].provider, PROVIDER_ID)
assert.ok(adapterInstance instanceof OrcaTermWebApiAdapter)

console.log('5. 验证模型解析 (resolveModel)...')
const resolved = await adapterInstance.resolveModel(PROVIDER_ID, 'deepseek-v4.1-flash')
assert.equal(resolved.id, 'deepseek-v4.1-flash')
assert.equal(resolved.provider, PROVIDER_ID)
assert.ok(resolved.context.contextWindow > 0)
assert.ok(resolved.defaultMaxTokens > 0)

console.log('6. 验证问候语剥离 (createGreetingStripper)...')
{
  // 分片模拟打字机流：问候语被吃掉，正文放行
  {
    const s = createGreetingStripper()
    const pieces = ['你好', '，我是 Orca', 'Term AI，腾讯云 OrcaTerm（遨驰终端）内置的', '云端服务器运维专家。请告诉我你需要什么帮助？', '帮我查 git log']
    const out = pieces.map((p) => s.feed(p)).filter(Boolean).join('')
    assert.equal(out, '帮我查 git log')
  }
  // 整条纯问候语 → 输出为空，但 stripped() 留底供「寒暄回合」归还
  {
    const s = createGreetingStripper()
    assert.equal(s.feed('你好，我是 OrcaTerm AI，腾讯云 OrcaTerm（遨驰终端）内置的云端服务器运维专家。请告诉我你需要什么帮助？'), '')
    assert.equal(s.stripped().startsWith('你好，我是 OrcaTerm AI'), true)
    assert.equal(s.clearStripped().length > 0, true)
    assert.equal(s.clearStripped(), '')
  }
  // 非问候语正文直接放行
  {
    const s = createGreetingStripper()
    assert.equal(s.feed('正常回答内容'), '正常回答内容')
  }
  // 问候语变体缺结束标记时不吞正文（超长兜底放行）
  {
    const s = createGreetingStripper({ maxHold: 40 })
    const out = s.feed('你好，我是 OrcaTerm AI' + '啊'.repeat(60) + '真正的正文')
    assert.ok(out.includes('真正的正文'), '超长兜底必须把内容放出来')
  }
}

console.log('7. 验证重复正文剥离 (createRepeatStripper)...')
{
  const prior = '我将帮您完成以下操作：\n\n1. 检查当前状态\n2. 清理临时文件\n\n请问是否按这个思路开始执行？'
  // 7a. 上一轮正文被原样重放 → 吃掉，只留新内容
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed(`${prior}\n\n好的，开始执行。`), '好的，开始执行。')
    assert.ok(s.droppedChars() > 0)
  }
  // 7b. 同一段被重放两次 → 两份都吃掉
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed(`${prior}${prior}\n\n新内容`), '新内容')
  }
  // 7c. 完全无关的新正文 → 立刻放行，不受剥离器影响
  {
    const s = createRepeatStripper([prior])
    assert.equal(s.feed('这是一段全新的回答'), '这是一段全新的回答')
  }
  // 7d. 无历史可比 → 直通
  {
    const s = createRepeatStripper([])
    assert.equal(s.feed('任意内容'), '任意内容')
  }
  // 7e. 逐字符分片到达也要能剥离（打字机流）
  {
    const s = createRepeatStripper([prior])
    const stream = `${prior}\n\n结论如下`
    let out = ''
    for (const ch of stream) out += s.feed(ch)
    assert.equal(out, '结论如下')
  }
  // 7f. 只是与历史正文「开头相似」但并非重放 → 最终必须放行，不能被吞掉
  {
    const s = createRepeatStripper([prior])
    const fresh = '我将帮您完成以下操作，但这次是另一件事'
    let out = ''
    for (const ch of fresh) out += s.feed(ch)
    out += s.flush()
    assert.equal(out, fresh)
  }
}

console.log('8. 验证会话级已交付正文记忆 (createDeliveredHistory)...')
{
  const store = createDeliveredHistory({ maxRounds: 2, maxChars: 5000 })
  store.remember('cid-x', '第一轮的正文内容（足够长以通过最短长度门槛）')
  store.remember('cid-x', '第二轮的正文内容（足够长以通过最短长度门槛）')
  store.remember('cid-y', '另一个会话的正文内容（互不串台）')
  assert.deepEqual(store.textsFor('cid-x'), [
    '第二轮的正文内容（足够长以通过最短长度门槛）',
    '第一轮的正文内容（足够长以通过最短长度门槛）',
  ])
  assert.deepEqual(store.textsFor('cid-y'), ['另一个会话的正文内容（互不串台）'])
  // 太短的不记（噪音大、误伤高）
  store.remember('cid-z', '短')
  assert.deepEqual(store.textsFor('cid-z'), [])
}

console.log('9. 验证命令目标 shell 判定 (classifyCommandShell)...')
{
  // 真实会话里出现过、且被 PowerShell 曲解的那条
  assert.equal(classifyCommandShell('cd C:\\AITask && echo === 目录结构 === && dir /b && echo. && echo === Git 状态 === && git status --short 2>nul'), 'cmd')
  assert.equal(classifyCommandShell('git status --short 2>nul'), 'cmd')
  assert.equal(classifyCommandShell('findstr /i error log.txt'), 'cmd')
  assert.equal(classifyCommandShell('echo %USERPROFILE%'), 'cmd')
  // 上游按 Linux 主机写出来的
  assert.equal(classifyCommandShell("ls -la && echo '---' && git rev-parse --is-inside-work-tree 2>&1"), 'posix')
  assert.equal(classifyCommandShell('sudo systemctl restart nginx'), 'posix')
  assert.equal(classifyCommandShell('awk -F, \'{print $1}\' data.csv'), 'posix')
  assert.equal(classifyCommandShell('echo -e "a\\nb"'), 'posix')
  // PowerShell 自身
  assert.equal(classifyCommandShell('Get-ChildItem -Recurse -Filter *.js'), 'powershell')
  assert.equal(classifyCommandShell('$env:PATH -split ";"'), 'powershell')
  assert.equal(classifyCommandShell('Remove-Item -Force build'), 'powershell')
  // 无把握的一律交给 PowerShell（与 DSH 系统提示词一致）
  assert.equal(classifyCommandShell('git log --oneline -5'), 'powershell')
  assert.equal(classifyCommandShell(''), 'powershell')
}

console.log('10. 验证命令改写 (wrapCommandForShell)...')
{
  const cmdWrapped = wrapCommandForShell("dir /b && echo 'ok'", 'cmd', { comspec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(cmdWrapped.wrapped, true)
  assert.equal(cmdWrapped.shell, 'cmd')
  assert.equal(cmdWrapped.command, "& 'C:\\Windows\\system32\\cmd.exe' /c 'dir /b && echo ''ok'''")

  const posixWrapped = wrapCommandForShell('ls -la', 'posix', { posixShell: 'C:\\Program Files\\Git\\bin\\bash.exe' })
  assert.equal(posixWrapped.wrapped, true)
  assert.equal(posixWrapped.command, "& 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'ls -la'")

  // 本机没有 POSIX shell 时，只能退回 PowerShell 尽力而为（不谎报成功）
  const posixUnavailable = wrapCommandForShell('ls -la', 'posix', { posixShell: '' })
  assert.equal(posixUnavailable.wrapped, false)
  assert.equal(posixUnavailable.command, 'ls -la')

  // PowerShell 命令原样放行
  const ps = wrapCommandForShell('Get-Date', 'powershell', {})
  assert.equal(ps.wrapped, false)
  assert.equal(ps.command, 'Get-Date')
}

console.log('11. 验证工具调用解析 (resolveDshToolCall / parseToolEnvelope)...')
{
  // 上游真实下发过的信封（实测样本，含 ph_1 这类网关附加字段）
  const envelope = parseToolEnvelope('```json\n' + JSON.stringify({
    action: 'review',
    ph_1: '--',
    tool: { type: 'mcp', mcpServer: 'mcp-server-orcaterm-oauth', name: 'execute_command', args: { command: 'ls -la' } },
  }) + '\n```')
  assert.ok(envelope, '工具信封应被识别')
  assert.equal(envelope.tool.name, 'execute_command')
  // 普通 fenced JSON 不是工具信封
  assert.equal(parseToolEnvelope('```json\n{"action":"completion","taskCompletion":"hi"}\n```'), null)
  assert.equal(parseToolEnvelope('普通文本'), null)

  const pwshTools = [{ type: 'function', function: { name: 'pwsh' } }, { type: 'function', function: { name: 'read' } }]
  const cmdCall = resolveDshToolCall({ name: 'execute_command', args: { command: 'dir /b' } }, pwshTools, { posixShell: '', comspec: 'cmd.exe' })
  assert.equal(cmdCall.name, 'pwsh')
  assert.equal(cmdCall.shell, 'cmd')
  assert.equal(cmdCall.arguments.command, "& 'cmd.exe' /c 'dir /b'")
  assert.equal(cmdCall.mappedFrom, 'execute_command')

  const readCall = resolveDshToolCall({ name: 'remote_read', args: { path: 'a.txt' } }, pwshTools)
  assert.equal(readCall.name, 'read')
  assert.equal(readCall.arguments.file_path, 'a.txt')

  // Linux 上的 DSH 有 bash：命令不再绕 PowerShell
  const bashCall = resolveDshToolCall({ name: 'execute_command', args: { command: 'ls -la' } }, [{ type: 'function', function: { name: 'bash' } }])
  assert.equal(bashCall.name, 'bash')
  assert.equal(bashCall.arguments.command, 'ls -la')
}

console.log('12. 验证执行环境自述 (describeExecutionHost)...')
{
  const win = describeExecutionHost({ platform: 'win32', cwd: 'C:\\AITask', posixShell: 'bash.exe' })
  assert.ok(/Windows/.test(win))
  assert.ok(/PowerShell/.test(win))
  assert.ok(/Git Bash/.test(win))
  assert.ok(/C:\\AITask/.test(win))
  const linux = describeExecutionHost({ platform: 'linux', cwd: '/srv/app', posixShell: '' })
  assert.ok(/linux/.test(linux))
  assert.ok(/POSIX/.test(linux))
}

console.log('13. 验证 DSH 消息 → OpenAI 消息（工具结果必须活下来）...')
{
  // 13a. assistant 的 tool-call 块 → OpenAI tool_calls；reasoning 块静默丢弃
  const flat = flattenContent([
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '好的' },
    { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"dir /b"}' },
  ])
  assert.equal(flat.text, '好的')
  assert.deepEqual(flat.dropped, [])
  assert.deepEqual(flat.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'pwsh', arguments: '{"command":"dir /b"}' },
  }])
  // 缺 id/name 的 tool-call 块算丢弃，不静默造一个假调用
  assert.deepEqual(flattenContent([{ type: 'tool-call', name: 'x' }]).dropped, ['tool-call'])
  assert.deepEqual(flattenContent([{ type: 'image', attachment: {} }]).dropped, ['image'])

  const warn = []
  const wire = formatOpenAiMessages({
    system: 'SYS',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '列出文件' }] },
      // 纯工具调用的 assistant 消息没有文本，绝不能因此被整条丢掉
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"dir /b"}' }] },
      { role: 'tool', toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' }, isError: false, content: [{ type: 'text', text: '目录清单' }] },
    ],
  }, (m) => warn.push(m))

  assert.deepEqual(wire.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(wire[0], { role: 'system', content: 'SYS' })
  assert.equal(wire[2].tool_calls[0].id, 'call_1')
  assert.equal(wire[3].tool_call_id, 'call_1')
  assert.equal(wire[3].content, '目录清单')
  assert.deepEqual(warn, [], '工具调用/工具结果都不该产生丢弃告警')
}

console.log('14. 验证混合语法命令链的切分与逐段路由...')
{
  // 14a. 引号内的操作符不切；管道不切
  const s1 = splitCommandChain('echo "a && b" && dir /b | findstr x')
  assert.deepEqual(s1.segments, ['echo "a && b" ', ' dir /b | findstr x'])
  assert.deepEqual(s1.operators, ['&&'])
  const s2 = splitCommandChain('a; b || c')
  assert.deepEqual(s2.operators, [';', '||'])
  assert.deepEqual(s2.segments, ['a', ' b ', ' c'])

  // 14b. MSYS 盘符路径可翻译；Git Bash 虚拟路径不猜
  assert.equal(toWindowsPath('/c/AITask'), 'C:\\AITask')
  assert.equal(toWindowsPath('/d'), 'D:\\')
  assert.equal(toWindowsPath('C:\\AITask'), 'C:\\AITask')
  assert.equal(toWindowsPath('..\\x'), '..\\x')
  assert.equal(toWindowsPath('/tmp'), null)

  const env = { posixShell: 'C:\\Program Files\\Git\\bin\\bash.exe', comspec: 'C:\\Windows\\system32\\cmd.exe' }

  // 14c. 单一 shell 走旧路径（行为不变）
  assert.equal(rewriteCommandChain('dir /b', env).strategy, 'single')
  assert.equal(rewriteCommandChain('Get-ChildItem', env).strategy, 'single')
  assert.equal(rewriteCommandChain('ls -la', env).strategy, 'single')

  // 14d. 混合语法逐段路由，cd 交给 PowerShell 让子 shell 继承目录
  const mixed = rewriteCommandChain('cd C:\\AITask && dir /b && ls -la', env)
  assert.equal(mixed.strategy, 'composed')
  assert.equal(
    mixed.command,
    "Set-Location 'C:\\AITask' && & 'C:\\Windows\\system32\\cmd.exe' /c 'dir /b' && & 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'ls -la'",
  )
  // POSIX 盘符路径同样能翻译
  assert.equal(rewriteCommandChain('cd /c/AITask && dir /b && ls -la', env).strategy, 'composed')

  // 14e. cd 目标无法翻译 → 退回单 shell，且优先退到能解释这条命令的 posix
  const fallback = rewriteCommandChain('cd /tmp && dir /b', env)
  assert.equal(fallback.strategy, 'fallback')
  assert.ok(fallback.command.includes('bash.exe'), '退路应落在 bash，至少让 cd 是对的')
  // 本机没有 POSIX shell 时不能假装成功
  const noPosix = rewriteCommandChain('cd /tmp && dir /b', { posixShell: '', comspec: 'cmd.exe' })
  assert.equal(noPosix.strategy, 'fallback')

  // 14f. 混合链里的空段不猜；单一 shell 的畸形命令原样透出，让 shell 自己报语法错
  assert.equal(rewriteCommandChain('dir /b && && ls -la', env).strategy, 'fallback')
  assert.equal(rewriteCommandChain('a && && b', env).command, 'a && && b')
  assert.equal(rewriteCommandChain('', env).strategy, 'empty')

  // 14g. resolveDshToolCall 把路由结果写进 description，便于排查
  const call = resolveDshToolCall(
    { name: 'execute_command', args: { command: 'cd C:\\AITask && dir /b && ls -la' }, description: '看看目录' },
    [{ type: 'function', function: { name: 'pwsh' } }],
    env,
  )
  assert.equal(call.name, 'pwsh')
  assert.equal(call.strategy, 'composed')
  assert.ok(call.arguments.description.startsWith('看看目录'), call.arguments.description)
  assert.ok(call.arguments.description.includes('shell=composed:'), call.arguments.description)
}

console.log('15. 验证上下文对账 (createContextTracker)...')
{
  const tracker = createContextTracker()
  const msg = (role, text, extra = {}) => ({ role, content: text, ...extra })
  const U1 = msg('user', '第一问')
  const A1 = msg('assistant', '第一答')
  const U2 = msg('user', '第二问')
  const A2 = msg('assistant', '第二答')

  // 15a. 首轮
  let d = tracker.decide('k', [{ role: 'system', content: 's' }, U1])
  assert.equal(d.action, 'fresh')
  // 15b. 追加 → 沿用上游上下文
  d = tracker.decide('k', [{ role: 'system', content: 's' }, U1, A1, U2])
  assert.equal(d.action, 'continue')
  assert.equal(d.reason, 'append-only')
  // 15c. system 变了但非 system 消息是追加 → 仍然 continue（DSH 系统提示词每轮可能带动态内容）
  d = tracker.decide('k', [{ role: 'system', content: 's2' }, U1, A1, U2, A2])
  assert.equal(d.action, 'continue')
  // 15d. 重试同一条（列表一模一样）→ 必须换会话，否则上游会看到重复的一轮
  d = tracker.decide('k', [{ role: 'system', content: 's2' }, U1, A1, U2, A2])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'retry-same-history')
  // 15e. 压缩：列表变短 → 换会话 + 补发历史
  d = tracker.decide('k', [{ role: 'system', content: 's' }, U1])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'history-shrank')
  // 15f. 改写：把已有消息换了个说法 → 换会话
  d = tracker.decide('k', [{ role: 'system', content: 's' }, { role: 'user', content: '被改写过的第一问' }])
  assert.equal(d.action, 'resync')
  assert.equal(d.reason, 'history-rewritten')
  // 15g. 工具结果轮永远留在原会话（上游还挂着待办的工具调用）
  const withTool = [
    { role: 'system', content: 's' }, U1,
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '输出' },
  ]
  for (let i = 0; i < 3; i += 1) {
    d = tracker.decide('k2', withTool)
    if (i > 0) assert.equal(d.action, 'continue', '工具结果轮不该触发换会话')
  }
  assert.equal(d.reason, 'tool-round')
  // 15h. 轮数上限：连续追加到上限后必须换一次会话，且理由正确
  const capped = createContextTracker()
  capped.decide('c', [U1])
  const actions = []
  for (let i = 1; i <= 5; i += 1) {
    const seen = capped.decide('c', [U1, ...Array.from({ length: i }, (_, j) => msg('user', `第${j}轮`))], { maxRounds: 3 })
    actions.push(seen)
  }
  assert.ok(actions.some((a) => a.action === 'resync' && a.reason === 'round-cap'), JSON.stringify(actions))
  assert.ok(actions.every((a) => a.action === 'resync' || a.action === 'continue'))
  // 上限 0 = 不限制
  const unlimited = createContextTracker()
  unlimited.decide('u', [U1])
  const seenU = unlimited.decide('u', [U1, msg('user', '再问')], { maxRounds: 0 })
  assert.equal(seenU.action, 'continue')
  // 15i. 指纹忽略 system/developer
  assert.deepEqual(fingerprintMessages([{ role: 'system', content: 'a' }, { role: 'developer', content: 'b' }]), [])
}

console.log('16. 验证客户端身份口径 (identityOf / 请求头拼装)...')
{
  const desktop = identityOf('desktop')
  assert.equal(desktop.origin, 'http://tauri.localhost')
  assert.equal(desktop.referer, 'http://tauri.localhost/')
  const web = identityOf('web')
  assert.equal(web.origin, 'https://orcaterm.com')
  assert.equal(web.referer, 'https://orcaterm.com/terminal')
  // 未知口径回落桌面端（默认口径），不抛错
  assert.deepEqual(identityOf('nonsense'), desktop)
  // 桌面端 UA 是实测来的浏览器 UA，不是插件自报名字
  assert.match(DESKTOP_IDENTITY.userAgent, /^Mozilla\/5\.0/)
  assert.doesNotMatch(DESKTOP_IDENTITY.userAgent, /dsh-orchaterm/)

  const asked = []
  const cfg = {
    cgiBase: 'https://api.orcaterm.cloud.tencent.com',
    origin: desktop.origin,
    referer: desktop.referer,
    userAgent: DESKTOP_IDENTITY.userAgent,
    credential: { token: 't', cookieHeader: '', csrfCode: '7', uin: 'u1', ownerUin: 'o1' },
    cookieFor: (host) => { asked.push(host); return `Cookie-for-${host}` },
  }
  const cgi = cgiHeaders(cfg)
  assert.equal(cgi.Origin, 'http://tauri.localhost')
  assert.equal(cgi['X-Referer'], 'http://tauri.localhost/')
  assert.equal(cgi['user-agent'], DESKTOP_IDENTITY.userAgent)
  // cookie 按**实际 cgiBase 的 host** 取，不再写死 api.orcaterm.com
  assert.deepEqual(asked, ['api.orcaterm.cloud.tencent.com'])
  assert.equal(cgi.Cookie, 'Cookie-for-api.orcaterm.cloud.tencent.com')

  const asst = assistantHeaders({ ...cfg, assistantBase: 'https://lightai.cloud.tencent.com/assistant' }, 'seq-1')
  assert.equal(asst.origin, 'http://tauri.localhost')
  assert.equal(asst.referer, 'http://tauri.localhost/')
  assert.equal(asst['X-Referer'], 'http://tauri.localhost/')
  assert.equal(asst['x-seqid'], 'seq-1')
  assert.equal(asst.Accept, 'text/event-stream')

  // 绕过 buildConfig 手搓 config 时也不能发出 undefined
  const bare = cgiHeaders({ cgiBase: 'https://x.test', credential: { csrfCode: '', uin: '', token: '' } })
  assert.equal(bare.Origin, 'http://tauri.localhost')
  assert.equal(bare['X-Referer'], 'http://tauri.localhost/')
  assert.match(bare['user-agent'], /^Mozilla\/5\.0/)
  const bareAsst = assistantHeaders({ assistantBase: 'https://y.test/assistant', credential: { csrfCode: '' } })
  assert.equal(bareAsst.origin, 'http://tauri.localhost')
  assert.doesNotMatch(JSON.stringify(bareAsst), /undefined/)
}

console.log('17. 验证新增配置键与重启判定...')
{
  assert.equal(DEFAULTS.clientIdentity, 'desktop')
  assert.ok(MANAGER_KEYS.includes('clientIdentity'), '改身份口径要重启后端')
}

console.log('18. 验证凭据临期自动刷新 (ensureFreshCredential / refreshCredential)...')
{
  const future = () => JSON.stringify({ exp: Math.floor((Date.now() + 3600_000) / 1000) })
  const expiring = () => JSON.stringify({ exp: Math.floor((Date.now() + 30_000) / 1000) })
  const jwtOf = (payload) => `header.${Buffer.from(payload()).toString('base64')}.sig`
  const ready = { token: 't', cookieHeader: '', jar: [], csrfCode: '1', uin: 'u', skey: 's' }

  // 18a. 健康凭据（距过期 > 120s）：不刷新、零重读
  {
    let reads = 0
    const cfg = { credential: { ...ready, token: jwtOf(future) }, refreshCredential: () => { reads += 1; return { ...ready, token: jwtOf(future) } } }
    ensureFreshCredential(cfg)
    assert.equal(reads, 0)
  }
  // 18b. 临期（< 120s）：重读并替换
  {
    const cfg = { credential: { ...ready, token: jwtOf(expiring) }, refreshCredential: () => { cfg.credential = { ...ready, token: jwtOf(future) }; return cfg.credential } }
    const got = ensureFreshCredential(cfg)
    assert.equal(got.token, cfg.credential.token)
    assert.notEqual(got.token, '')
  }
  // 18c. exp 解析不出（=0）：与「过期」同等对待，也重读
  {
    let reads = 0
    const cfg = { credential: { ...ready, token: 'not-a-jwt' }, refreshCredential: () => { reads += 1; return { ...ready, token: jwtOf(future) } } }
    ensureFreshCredential(cfg)
    assert.equal(reads, 1)
  }
  // 18d. 没有 refreshCredential 的 config（手搓的）：原样返回不抛错
  {
    const cfg = { credential: { ...ready } }
    assert.equal(ensureFreshCredential(cfg), cfg.credential)
  }
  // 18e. buildConfig 产物自带 refreshCredential，且 cookieFor 读的是**当时的** credential
  {
    const cfg = buildConfig({ credential: { ...ready, cookieHeader: 'a=1', jar: [{ name: 'a', value: '1', domain: 'x.test', path: '/' }] } })
    assert.equal(typeof cfg.refreshCredential, 'function')
    cfg.credential = { ...cfg.credential, cookieHeader: '', jar: [{ name: 'b', value: '2', domain: 'y.test', path: '/' }] }
    assert.equal(cfg.cookieFor('y.test'), 'b=2')
  }
}

console.log('19. 验证 <thinking> 标签改道 (createThinkingTagRouter)...')
{
  const routed = []
  // 19a. 开头的完整标签块 → 内容进推理，正文只剩后半
  {
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const out = r.feed('\n\n<thinking>\n先扫描再分类。\n</thinking>\n\n好的，开始执行。')
    assert.equal(out.trim(), '好的，开始执行。')
    assert.equal(routed.join('').includes('先扫描再分类。'), true)
  }
  // 19b. 逐字符分片也要正确
  {
    routed.length = 0
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const stream = 'A<thinking>推理内容</thinking>B'
    let out = ''
    for (const ch of stream) out += r.feed(ch)
    out += r.flush()
    assert.equal(out, 'AB')
    assert.equal(routed.includes('推理内容'), true)
  }
  // 19c. 没有标签 → 原样放行
  {
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    assert.equal(r.feed('普通正文 <t 但不是标签'), '普通正文 <t 但不是标签')
    assert.equal(r.flush(), '')
  }
  // 19d. 只有开标签没有闭标签 → 流结束兜底按正文放行（含开标签），不能吞内容
  {
    const r = createThinkingTagRouter({ maxHold: 40, onReasoning: (t) => routed.push(t) })
    const held = r.feed('<thinking>一直没结束的内容')
    const out = held + r.flush()
    assert.ok(out.includes('<thinking>'), '兜底必须把开标签吐回正文')
    assert.ok(out.includes('一直没结束'), out)
  }
  // 19e. 中段出现标签块 → 前后正文都保留
  {
    routed.length = 0
    const r = createThinkingTagRouter({ onReasoning: (t) => routed.push(t) })
    const out = r.feed('前文<thinking>中间思考</thinking>后文')
    assert.equal(out, '前文后文')
    assert.equal(routed.includes('中间思考'), true)
  }
}

console.log('20. 验证辅助请求（purpose）不共用主会话键...')
{
  const adapter = new OrcaTermWebApiAdapter({}, null, null)
  const main = { sessionId: 'sess-1', messages: [{ role: 'user', content: 'hi' }] }
  const title = { sessionId: 'sess-1', purpose: 'session-title', messages: [{ role: 'user', content: 'hi' }] }
  const compact = { sessionId: 'sess-1', purpose: 'compaction', messages: [{ role: 'user', content: 'hi' }] }
  const kMain = adapter.conversationKey(main)
  const kTitle = adapter.conversationKey(title)
  const kCompact = adapter.conversationKey(compact)
  assert.equal(kMain, 's:sess-1')
  assert.ok(kTitle.startsWith('aux:session-title:'), kTitle)
  assert.ok(kCompact.startsWith('aux:compaction:'), kCompact)
  assert.notEqual(kTitle, kMain)
  assert.notEqual(kTitle, kCompact)
  // 无 sessionId 的辅助请求也要有自己的键
  const t2 = adapter.conversationKey({ purpose: 'session-title', messages: [{ role: 'user', content: 'hi' }] })
  assert.ok(t2.startsWith('aux:session-title:'), t2)
}

console.log('smoke 测试全部通过！')
