/**
 * 宿主侧契约回归：真实宿主 LlmRuntime / TokenMeter / BasicCompactionEngine
 * + **插件的真实适配器**，复刻实报的模型切换压缩失败。
 *
 * 实报：
 *   Cannot switch to orcaterm-web-api/hy4-preview: context compaction failed:
 *   this.adapters.get(...)?.adapter.imageRequestPricing is not a function.
 *   code = MODEL_SWITCH_COMPACTION_FAILED
 *
 * 根因：插件的适配器是普通 JS 类（不继承宿主 LlmAdapter 基类），
 * 基类上的 imageRequestPricing / imageRequestTarget 默认实现全部缺失，
 * 而宿主是**直接调用**注册对象上的这两个方法的。
 *
 * 跑法（必须在宿主仓库根目录，因为要 import @deepseek-ai/*）：
 *   cd C:\AITask\deepseek-harness
 *   npx vitest run <拷贝到宿主包 tests 目录后的路径>   # 宿主的 vitest 只 include 特定目录
 *
 * 插件自己的 offline 测试（test/smoke.mjs 第 5b 组）覆盖同样的契约面，
 * 但跑在插件仓库里、不依赖宿主 —— 宿主侧这份是**跨仓库漂移**的哨兵。
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

const MODEL = 'test-model'

/** 上一轮模型（承载历史摘要），与宿主测试同构。 */
class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 一个已积累足够历史、足以触发压缩的会话（事件序列必须合法闭合）。 */
function conversation(turns = 4, text = 'fixture '.repeat(80)): Session {
  const session = Session.create(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
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
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

describe('orcaterm-web-api 适配器契约（宿主侧）', () => {
  function mount() {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter([MODEL], new ContextAdapter(1_000))
    const orca = new OrcaTermWebApiAdapter({ baseUrl: 'http://127.0.0.1:8793' }, null, ctx.logger)
    ctx.llm.registerAdapter([PROVIDER_ID], orca)
    const compact = new BasicCompactionEngine(ctx, {
      headroomTokens: 0, maxTokens: 32, thresholdRatio: 0.5, retainTokens: 100,
    })
    return { ctx, orca, compact }
  }

  it('宿主解析路由图片计价时不再抛 TypeError（实报崩溃点）', () => {
    const { ctx } = mount()
    // 本路由不按视觉 token 收费 → 声明「无计价器」是基类默认语义。
    expect(ctx.llm.imageRequestPricing(PROVIDER_ID, 'hy4-preview')).toBeUndefined()
    // 未注册路由降级为 undefined，不抛错。
    expect(ctx.llm.imageRequestPricing('missing-route', 'hy4-preview')).toBeUndefined()
  })

  it('宿主解析路由图片目标时不再抛 TypeError（同族隐患）', () => {
    const { ctx } = mount()
    const target = ctx.llm.imageRequestTarget(PROVIDER_ID, 'glm-5.3-flash', {
      attachmentId: 'a', mediaType: 'image/png', bytes: 4096, width: 800, height: 600,
    })
    // 本路由不缩放图片 → 保留归一化后的原图。
    expect(target).toEqual({ width: 800, height: 600, maxBytes: 4096 })
  })

  it('模型切换触发的上下文压缩不再报 MODEL_SWITCH_COMPACTION_FAILED', async () => {
    const { ctx } = mount()
    const session = conversation(4)
    const selected = { provider: PROVIDER_ID, model: 'hy4-preview' }
    const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent

    let caught: unknown
    try {
      await agentEvents(ctx, agent).waterfall(
        'agent/request',
        { turn: 5, step: 1, signal: new AbortController().signal },
        () => Promise.resolve(selected),
      )
    } catch (error) {
      caught = error
    }
    const error = caught as { code?: string; message?: string; cause?: { message?: string } } | undefined
    // 失败信息里不得再出现「方法不存在」类缺陷。
    expect(error?.cause?.message ?? '').not.toContain('imageRequestPricing')
    expect(error?.cause?.message ?? '').not.toContain('is not a function')
  })

  it('每个已知模型都能解析精确元信息（压缩阈值依赖上下文窗口）', async () => {
    const { ctx } = mount()
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['deepseek-v4.1-flash', 1048576],
      ['hy4-preview', 1048576],
      ['hy3', 128000],
      ['kimi-k3', 1048576],
      ['glm-5.3-flash', 300000],
    ]
    for (const [model, contextWindow] of cases) {
      const info = await ctx.llm.resolveModelInfo(PROVIDER_ID, model, new AbortController().signal)
      expect(info.context?.contextWindow, `${model} 的上下文窗口`).toBe(contextWindow)
      expect(() => ctx.llm.imageRequestPricing(PROVIDER_ID, model)).not.toThrow()
      expect(() => ctx.llm.imageRequestTarget(PROVIDER_ID, model, {
        attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      })).not.toThrow()
    }
  })

  it('适配器实现宿主会直接调用的全部方法', () => {
    const { orca } = mount()
    for (const method of [
      'providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget',
      'listModels', 'resolveModel', 'prepareCall',
    ]) {
      expect(typeof (orca as unknown as Record<string, unknown>)[method], method).toBe('function')
    }
  })
})
