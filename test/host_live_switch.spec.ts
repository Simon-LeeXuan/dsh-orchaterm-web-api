/**
 * 决定性验证：模型切换 → 上下文压缩 → **摘要调用走真实 OrcaTerm 上游**。
 *
 * 宿主的摘要是用「上一个模型」做的（compaction-basic/src/summarizer.ts:127
 * `latest = agent.session.requestHeader()?.config`）。所以当上个模型是 orcaterm 路由时，
 * 摘要请求会**原样经过插件的真实适配器**打到真实上游 —— 契约缺陷若还在，
 * 这一步就会以 TypeError 崩掉。
 *
 * 这比「只断言方法存在」强得多：它走的是真实链路（宿主 LlmRuntime → 插件适配器 →
 * 反代 → OrcaTerm 助手网关 → 摘要文本回来）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'

// 这份 spec 要**拷进宿主仓库**才能跑（要 import @deepseek-ai/*），
// 所以插件自身的路径用环境变量给出，默认指向本机开发位置。
const PLUGIN_ROOT = process.env.ORCATERM_PLUGIN_ROOT
  ?? 'C:/AITask/dsh-client-config/plugins/dsh-orchaterm-web-api'
const { OrcaTermWebApiAdapter, PROVIDER_ID } = await import(`file:///${PLUGIN_ROOT}/lib/provider.js`)
const { installDirectFetch } = await import(`file:///${PLUGIN_ROOT}/test/direct-fetch.mjs`)

// 宿主 vitest 的 setup 删掉了 NO_PROXY，而 Node 的 fetch 在启动时已绑死代理 ——
// 本地 127.0.0.1:8793 的请求会被送进代理。改成直连（后端自己的上游调用不受影响）。
installDirectFetch()

const SMALL = 'small'

/** 目标路由：小上下文窗口，用来触发压缩。 */
class SmallContextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, context: { contextWindow: 20_000 },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 上个模型是 orcaterm 路由的历史会话。 */
function conversation(provider: string, model: string, text: string, runId = 'r1'): Session {
  const session = Session.create(SessionId(`orca-switch-${runId}`))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider, model } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider, model },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // 再补一个「只有用户消息」的半轮。
  //
  // 这一步是**忠实性关键**：后端按「最后一条 assistant 之后的消息」切分当前回合，
  // 其余作为 history（要显式补发才到上游）。所以：
  //   · 区域末尾是 user  → 那条 user 落在当前回合里，整段对话被当正文发上去，
  //                        上游「碰巧」看到了对话 → 掩盖了「历史没补发」这个缺陷；
  //   · 区域末尾是 assistant → 当前回合只剩压缩指令，历史不补发就等于上游什么都没看到，
  //                        这才是真实会话的形态（被压缩的是已完成的轮次）。
  // 7 个表面节点 = 3 个完整轮次(6) + 1 条用户消息 → 保留尾巴是最后那条 user，
  // 压缩区域 = u1,a1,u2,a2,u3,a3 → 末尾落在 assistant 上。
  session.append('turn/start', { turn: 4 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${text} user tail` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

describe('orcaterm-web-api：真实上游的模型切换压缩', () => {
  it('切换模型触发压缩时，摘要请求真实经过插件适配器，且不出现契约类缺陷', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter([SMALL], new SmallContextAdapter())
    const orca = new OrcaTermWebApiAdapter({ baseUrl: 'http://127.0.0.1:8793' }, null, ctx.logger)
    ctx.llm.registerAdapter([PROVIDER_ID], orca)

    // 数一数摘要请求打上去了几次。
    // 修复前：第一次压缩轮判 `fresh` → **不补发历史** → 上游只看到压缩指令 →
    //         摘要与对话无关 → 压缩被判失败 → 宿主重试 → 第二次判 `resync`
    //         才补发历史、才成功。所以修复前是 **2 次**上游调用。
    // 修复后：压缩轮直接「新会话 + 补发历史」→ **1 次**就成功。
    let upstreamCalls = 0
    const originalStream = orca.stream.bind(orca)
    ;(orca as unknown as { stream: (...args: unknown[]) => unknown }).stream = (...args: unknown[]) => {
      upstreamCalls += 1
      return originalStream(...(args as Parameters<typeof originalStream>))
    }
    void new BasicCompactionEngine(ctx, {
      headroomTokens: 0, maxTokens: 32, thresholdRatio: 0.5, retainTokens: 100,
    })

    // 上个模型 = orcaterm 路由 → 摘要会用它 → 真实上游。
    // 历史要足够长，摘要才可能比被压缩的内容更短（否则压缩会因「没省下东西」而拒绝，
    // 那是内容问题，不是契约问题）。
    // 会话 id 每次运行都要不同：OrcaTerm 服务端会留着同 id 的旧会话，id 复用会让
    // 上游看到上一轮的对话，摘要内容被污染、断言失去意义。
    const runId = Date.now().toString(36)
    const session = conversation(PROVIDER_ID, 'hy4-preview', '上下文压力测试。'.repeat(4000), runId)
    console.log('  [诊断] surface 节点数 =', session.surface.nodes.length)
    const measured = ctx.tokenMeter.measure(session)
    console.log('  [诊断] totalTokens =', measured.totalTokens)
    console.log('  [诊断] 每节点 tokens =', JSON.stringify(measured.nodes.map((n: { tokens: number }) => n.tokens)))
    const agent = { session, options: { provider: PROVIDER_ID, model: 'hy4-preview' } } as Agent

    let caught: unknown
    let result: unknown
    try {
      result = await agentEvents(ctx, agent).waterfall(
        'agent/request',
        { turn: 4, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ provider: SMALL, model: SMALL }),
      )
    } catch (error) {
      caught = error
    }

    const error = caught as { code?: string; message?: string; cause?: { message?: string } } | undefined
    const cause = error?.cause?.message ?? error?.message ?? ''
    console.log('  [诊断] code =', error?.code)
    console.log('  [诊断] cause =', cause.slice(0, 200))
    console.log('  [诊断] result =', JSON.stringify(result))

    // ① 契约类缺陷绝不允许出现（这正是实报的 TypeError）。
    expect(cause).not.toContain('imageRequestPricing')
    expect(cause).not.toContain('imageRequestTarget')
    expect(cause).not.toContain('is not a function')

    // ② 压缩必须**真正成功**：模型切换被放行，摘要检查点落到会话里。
    //    这是修复前失败的那一步（MODEL_SWITCH_COMPACTION_FAILED）。
    expect(
      error,
      `模型切换的压缩仍然失败：${cause.slice(0, 200)}`,
    ).toBeUndefined()
    expect(result, '模型切换应被放行').toEqual({ provider: SMALL, model: SMALL })
    const checkpoints = session.snapshotEvents()
      .filter((event: { type: string }) => event.type === 'compaction/summary')
    expect(checkpoints.length, '应写下一个压缩检查点').toBeGreaterThan(0)
    console.log(`  [诊断] 压缩检查点数 = ${checkpoints.length}`)

    // ③ 摘要正文必须**含待压缩对话的内容**，不能是「已完成压缩检查点输出」这类
    //    与对话无关的元话。修复前上游只收到压缩指令（历史没补发），摘要与对话无关。
    const summaryBlocks = (checkpoints[0] as { data?: { summary?: Array<{ text?: string }> } })
      .data?.summary ?? []
    const summaryText = summaryBlocks.map((block) => block.text ?? '').join('\n')
    console.log('  [诊断] 摘要正文 =', summaryText.slice(0, 300))
    expect(summaryText.length, '摘要正文不应为空').toBeGreaterThan(0)
    expect(
      summaryText,
      '摘要里找不到待压缩对话的内容（上游没看到历史？）',
    ).toContain('上下文压力测试')

    // ④ 压缩必须**一次就成功**：修复前要靠「失败→重试」才补上历史（两次上游调用）。
    console.log(`  [诊断] 上游调用次数 = ${upstreamCalls}`)
    expect(upstreamCalls, '压缩应一次成功，不该靠重试补历史').toBe(1)
  }, 600_000)
})
