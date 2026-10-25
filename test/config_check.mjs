import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, MANAGER_KEYS, KNOWN_MODELS, PROVIDER_ID, PROVIDER_LABEL } from '../lib/config.js'
import { REQUIRED_CAPABILITIES } from '../lib/contract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const patchPath = join(__dirname, '..', 'cordis.patch.yml')
const patchContent = readFileSync(patchPath, 'utf8')

console.log('1. 验证基础常量定义...')
assert.equal(PROVIDER_ID, 'orcaterm-web-api')
assert.equal(PROVIDER_LABEL, 'OrcaTerm（反代）')
assert.ok(KNOWN_MODELS.length > 0)

console.log('2. 验证 cordis.patch.yml 中的配置项是否与 DEFAULTS 对齐...')
const lines = patchContent.split('\n')
const configLines = lines.filter(l => /^\s{8}[a-zA-Z0-9]+:/.test(l))
const patchKeys = configLines.map(l => l.trim().split(':')[0])

for (const key of Object.keys(DEFAULTS)) {
  assert.ok(patchKeys.includes(key), `cordis.patch.yml 缺少 DEFAULTS 键: ${key}`)
}

console.log('3. 验证 MANAGER_KEYS 包含关键受控字段...')
for (const key of ['baseUrl', 'autoStart', 'strictBackend', 'logFile']) {
  assert.ok(MANAGER_KEYS.includes(key), `MANAGER_KEYS 必须包含 ${key}`)
}

console.log('4. 验证契约必需能力声明...')
assert.ok(REQUIRED_CAPABILITIES.includes('openai-chat-completions'))
assert.ok(REQUIRED_CAPABILITIES.includes('health-self-description'))

console.log('config_check 全部通过！')
