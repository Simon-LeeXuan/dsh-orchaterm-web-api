/**
 * 插件对反代后端的契约校验。
 *
 * `/health` 现在没有可信的版本号可比（版本号是现读 package.json 的，旧代码也会报新号），
 * 所以判定依据是**能力清单**：本插件依赖的每一项能力都必须由后端自述。
 * 缺项说明 8793 端口上跑的是旧构建（或根本不是本反代），此时拒绝复用并给出下一步命令，
 * 而不是把请求发给一个不认识 `/orca/cgi` 的服务。
 *
 * 凭据不可用（`cgiReady:false`）属于**运行状态**而不是契约失败：后端起来了、只是没登录，
 * 让请求走正常路径拿到明确错误更可诊断。
 *
 * @module lib/contract.js
 */

/** 本插件依赖、缺了会退回不可诊断形态的能力。 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'openai-chat-completions',
  'orca-cgi-passthrough',
  'health-self-description',
])

export function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** a<b 返回 -1，相等 0，大于 1；任一边不合法返回 null（无法比较）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * 校验一次 `/health` 是否像本反代。
 * @param {object|null} health
 * @param {{ requiredCapabilities?: string[], minBackendVersion?: string }} [opts]
 * @returns {{ ok: boolean, problems: string[], unknown: boolean, warnings: string[] }}
 */
export function checkContract(health, opts = {}) {
  if (!health || typeof health !== 'object') {
    return {
      ok: false,
      unknown: true,
      warnings: [],
      problems: ['后端 /health 没有返回 JSON 对象（8793 上跑的多半不是 dsh-orchaterm-web-api 的反代）'],
    }
  }

  const problems = []
  const warnings = []
  if (typeof health.status !== 'string' || health.status === '') {
    problems.push('/health 缺少 status 字段：无法确认这是本反代')
  }

  const required = Array.isArray(opts.requiredCapabilities) && opts.requiredCapabilities.length > 0
    ? opts.requiredCapabilities
    : REQUIRED_CAPABILITIES
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : []
  for (const capability of required) {
    if (!capabilities.includes(capability)) problems.push(`后端缺少能力 ${capability}`)
  }

  if (opts.minBackendVersion) {
    const order = compareVersions(health.version, opts.minBackendVersion)
    if (order === null) problems.push(`后端 version 无法解析: ${JSON.stringify(health.version)}`)
    else if (order < 0) problems.push(`后端版本 ${health.version} 低于本插件要求的 ${opts.minBackendVersion}`)
  }

  // 运行状态只告警：没登录是「现在不能用」，不是「跑错了东西」。
  if (health.credential && health.credential.cgiReady === false) {
    warnings.push('后端读不到 OrcaTerm 登录态（请先启动并登录 OrcaTerm 桌面端）')
  }

  return { ok: problems.length === 0, problems, warnings, unknown: false }
}

/** 拒用不匹配后端时的报错文本：同时说清「发生了什么」和「下一步敲什么」。 */
export function contractError(entryHint, problems) {
  return [
    'dsh-orchaterm-web-api 的后端不满足最小契约，已拒绝复用（避免把别的服务当成 OrcaTerm 反代）。',
    `缺失项：${problems.join('；')}`,
    entryHint ? `后端入口：${entryHint}` : '',
    '处理：重启 DSH 客户端让插件重新拉起后端；或在本插件目录跑 .\\install.ps1 自检；'
      + '若端口 8793 被别的服务占用，改 config.baseUrl 与 --port 到同一空闲端口；'
      + '或把 strictBackend 设为 false 强行复用（不推荐）。',
  ].filter(Boolean).join('\n')
}
