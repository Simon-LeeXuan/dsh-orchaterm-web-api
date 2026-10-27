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
      provider, id: model, name: model, context: { contextWindow: 1_000 },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 上个模型是 orcaterm 路由的历史会话。 */
function conversation(provider: string, model: string, text: string): Session {
  const session = Session.create(SessionId('orca-switch'))
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
  session.append('turn/start', { turn: 4 })
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
    void new BasicCompactionEngine(ctx, {
      headroomTokens: 0, maxTokens: 32, thresholdRatio: 0.5, retainTokens: 100,
    })

    // 上个模型 = orcaterm 路由 → 摘要会用它 → 真实上游。
    // 历史要足够长，摘要才可能比被压缩的内容更短（否则压缩会因「没省下东西」而拒绝，
    // 那是内容问题，不是契约问题）。
    const session = conversation(PROVIDER_ID, 'hy4-preview', '上下文压力测试。'.repeat(4000))
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

    // ② 摘要请求必须**真实到达上游**。判据是「走到了宿主处理摘要内容的那一步」：
    //    - 摘要太啰嗦 → "summary is not smaller than the shadowed content"
    //    - 摘要是空的   → "summarization produced no text summary content"
    //    两者都只可能发生在上游**已经回了摘要**之后；
    //    传输/鉴权失败会是完全不同的文案（fetch failed / AccessToken / HTTP 5xx）。
    const reachedUpstream = cause.includes('summary is not smaller')
      || cause.includes('summarization produced no text summary content')
      || result !== undefined
    expect(
      reachedUpstream,
      `摘要请求没有到达上游（cause=${cause.slice(0, 160)}）`,
    ).toBe(true)
  }, 600_000)
})
