// 手工跑一遍适配器 → 反代 → OrcaTerm 的链路（不外发凭据，只报状态）。
import { OrcaTermWebApiAdapter, PROVIDER_ID } from '../lib/provider.js'

const logs = []
const logger = {
  warn: (m) => { logs.push(`WARN ${m}`) },
  debug: (m) => { logs.push(`DEBUG ${m}`) },
  info: (m) => { logs.push(`INFO ${m}`) },
}

const adapter = new OrcaTermWebApiAdapter({ baseUrl: 'http://127.0.0.1:8793' }, null, logger)

console.log('--- providerInfo ---')
console.log(JSON.stringify(adapter.providerInfo(PROVIDER_ID)))

console.log('\n--- listModels ---')
const models = await adapter.listModels(PROVIDER_ID)
console.log(`count=${models.length}`)
for (const m of models.slice(0, 6)) console.log(`  ${m.id}  ${m.name}`)

console.log('\n--- resolveModel ---')
console.log(JSON.stringify(await adapter.resolveModel(PROVIDER_ID, models[0]?.id ?? 'deepseek-v4.1-flash')))

console.log('\n--- stream (real call) ---')
const controller = new AbortController()
const prepared = await adapter.prepareCall(PROVIDER_ID, models[0]?.id ?? 'deepseek-v4.1-flash', controller.signal)
let text = ''
let reasoning = ''
let finish = null
let usage = null
for await (const chunk of prepared.stream({
  provider: PROVIDER_ID,
  model: prepared.model.id,
  messages: [{ role: 'user', content: '只回复四个字：链路已通' }],
  sessionId: 'manual-live-test',
  signal: controller.signal,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  if (chunk.type === 'usage') usage = chunk.usage
  if (chunk.type === 'finish') finish = chunk.reason
}
console.log(`text=${JSON.stringify(text.slice(0, 200))}`)
console.log(`reasoningChars=${reasoning.length}`)
console.log(`usage=${JSON.stringify(usage)}`)
console.log(`finish=${JSON.stringify(finish)}`)
console.log('\n--- adapter logs ---')
for (const line of logs) console.log(line)
