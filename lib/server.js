import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { buildChildEnv, buildSpawnPlan, isAlive, killProcessTree } from './process.js'
import { expandHome, resolveBackendEntry } from './paths.js'
import { checkContract, contractError } from './contract.js'

/**
 * 反代后端进程生命周期管理器。
 *
 * 被托管的是**本插件自带的 Node 服务**（backend/run.js），不是外部仓库，
 * 所以没有「构建产物」这一环，但多了两件事：
 *   · 解释器要能找（宿主 PATH 里的 node，或配置 nodePath）；
 *   · 凭据来自 OrcaTerm 桌面端的明文登录态，后端每次请求现读，这里只负责转达 env。
 *
 * 设计取舍（与 dsh-minimax-web-api/lib/server.js 同构）：
 *   1. 优先复用已有实例（GET /health，结果按 TTL 缓存）；
 *   2. 未运行且 autoStart 时拉起；
 *   3. dispose 按进程树回收（detach: true 则有意留下）；
 *   4. 复用别人起的实例时按 /health 的能力清单判旧构建，不一致就拒用并给命令。
 *
 * @module lib/server.js
 */

const DEFAULT_HEALTH_TTL_MS = 30000
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024

export function baseUrlOf(opts = {}) {
  return String(opts.baseUrl || 'http://127.0.0.1:8793').replace(/\/+$/, '')
}

/** 从 baseUrl 取端口；解析失败回落默认端口。 */
export function portOf(opts = {}) {
  try {
    return Number(new URL(baseUrlOf(opts)).port || 8793)
  } catch {
    return 8793
  }
}

/** 探活并取回 /health 自述；不在线或形状不对返回 null。 */
export async function probe(opts = {}, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${baseUrlOf(opts)}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(Number(opts.probeTimeoutMs || 3000)),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** 兼容只关心在不在跑的调用点。 */
export async function ping(opts = {}, fetchImpl = globalThis.fetch) {
  return (await probe(opts, fetchImpl)) !== null
}

/**
 * 复用实例的**运行状态**告警（契约失败由 contract.js 负责，不重复报）。
 * 凭据没读到是「现在不能用」而不是「跑错了东西」，只告警一次。
 */
export function diffHealth(health) {
  const warnings = []
  if (!health || typeof health !== 'object') return { warnings: ['/health 没有返回 JSON'] }
  const credential = health.credential
  if (credential && credential.cgiReady === false) {
    warnings.push('后端读不到 OrcaTerm 登录态：请先启动并登录 OrcaTerm 桌面端（E:\\Desktop\\OrcaTerm.lnk）')
  }
  if (credential && credential.assistantReady === false) {
    warnings.push('对话链路需要 uin+skey（QQ 系登录态）：当前账号没有该凭据，/v1/chat/completions 会回 401')
  }
  return { warnings }
}

function resolveNodePath(opts, entryDir) {
  const candidates = []
  const explicit = expandHome(opts.nodePath || '')
  if (explicit !== '') candidates.push([explicit, 'config.nodePath'])
  if (process.env.DSH_ORCA_NODE) candidates.push([expandHome(process.env.DSH_ORCA_NODE), 'env DSH_ORCA_NODE'])
  // 拉起本插件的运行时自己就是 node：process.execPath 是最可靠的答案。
  candidates.push([process.execPath, 'process.execPath'])
  candidates.push(['node', 'PATH'])
  if (entryDir) candidates.push([join(dirname(entryDir), 'node.exe'), 'entry-adjacent'])
  const found = candidates.find(([file]) => file === 'node' || existsSync(file))
  return { path: found ? found[0] : 'node', source: found ? found[1] : 'fallback PATH' }
}

/**
 * 建后端管理器。
 * @param {object} opts 插件配置（每代请求由 adapter 传当代快照）
 * @param {object|null} [logger]
 */
export function createBackendManager(opts = {}, logger) {
  let child = null
  let starting = null
  let cachedHealth = null
  let healthyUntil = 0
  let lastPid = 0
  let warnedCredential = false
  const recentLogs = []

  const note = (level, message) => {
    const text = `orchaterm-web-api: ${message}`
    if (typeof logger?.[level] === 'function') logger[level](text)
  }

  const logFile = expandHome(opts.logFile || '')

  function writeLogFile(line) {
    if (!logFile) return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
      if (statSync(logFile).size > LOG_FILE_MAX_BYTES) {
        const rotated = `${logFile}.1`
        if (existsSync(rotated)) unlinkSync(rotated)
        appendFileSync(rotated, readFileSync(logFile), 'utf8')
      }
    } catch {
      // 日志落盘失败不该挡住推理链路
    }
  }

  function remember(line) {
    if (!line) return
    for (const row of String(line).split('\n')) {
      if (!row) continue
      recentLogs.push(row)
      if (recentLogs.length > 200) recentLogs.shift()
      writeLogFile(row)
    }
  }

  function spawnServer() {
    const resolved = resolveBackendEntry(opts)
    if (!resolved.entry) {
      throw new Error(
        `找不到反代入口 backend/run.js。\n尝试过：${resolved.tried.join(' | ')}\n`
        + '请在配置里写 backendDir，或设置环境变量 DSH_ORCATTERM2API_DIR。',
      )
    }
    const entryDir = dirname(resolved.entry)
    note('debug', `后端入口 = ${resolved.entry}（来源 ${resolved.source}）`)

    const node = resolveNodePath(opts, resolved.entry)
    note('debug', `Node = ${node.path}（来源 ${node.source}）`)

    const { env, keys } = buildChildEnv(process.env, {
      extraKeys: Array.isArray(opts.passEnvKeys) ? opts.passEnvKeys : [],
      inject: {
        ORCA_CGI_BASE: opts.cgiBase || '',
        ORCA_ASSISTANT_BASE: opts.assistantBase || '',
        ORCA_ACCESS_TOKEN: '',
        ORCA_UIN: opts.uin || '',
        ORCA_SKEY: opts.skey || '',
        ORCA_COOKIES: opts.cookies || '',
        ORCA_ASSISTANT_COOKIES: opts.assistantCookies || '',
        ORCA_SEND_HISTORY: opts.sendHistoryMessages === true ? '1' : '',
        // 工具结果回传信封形态（'review' 默认 | 'ask'）：两种都是官方形态，见 README。
        ORCA_RESULT_ENVELOPE: opts.resultEnvelope || '',
        DSH_ORCA_CREDENTIALS: expandHome(opts.credentialsFile || ''),
        ...(opts.env || {}),
      },
    })
    // ORCA_ACCESS_TOKEN 显式置空会被 buildChildEnv 跳过；这里记录放行名单即可。
    note('debug', `子进程环境变量（只记名不记值）: ${keys.join(', ')}`)

    const port = portOf(opts)
    const args = [resolved.entry, '--port', String(port), '--host', '127.0.0.1']
    if (opts.cgiBase) args.push('--cgi-base', String(opts.cgiBase))
    if (opts.assistantBase) args.push('--assistant-base', String(opts.assistantBase))
    if (opts.assistant) args.push('--assistant', String(opts.assistant))
    if (opts.mode !== undefined && opts.mode !== null && opts.mode !== '') args.push('--mode', String(opts.mode))
    if (opts.model) args.push('--model', String(opts.model))
    const credFile = expandHome(opts.credentialsFile || '')
    if (credFile) args.push('--credentials', credFile)
    if (opts.assistantCookies) args.push('--assistant-cookies', String(opts.assistantCookies))
    if (opts.clientIdentity) args.push('--client-identity', String(opts.clientIdentity))
    const fds = opts.detach === true && logFile ? openLogFileStreams(logFile) : {}
    const plan = buildSpawnPlan({ ...opts, cwd: entryDir }, fds)
    const proc = spawn(node.path, args, { ...plan, env })
    lastPid = proc.pid
    note('info', `已拉起反代 PID=${proc.pid} 模式=${opts.detach === true ? 'detach' : '托管'} port=${port}`)

    if (proc.stdout) proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    if (proc.stderr) proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[反代退出] code=${code}`)
      if (child === proc) child = null
      cachedHealth = null
      healthyUntil = 0
    })
    proc.on('error', (error) => remember(`[反代进程错误] ${error?.message || error}`))

    if (opts.detach === true) {
      child = null
      proc.unref?.()
    } else {
      child = proc
    }
    return proc
  }

  /** 探活 + 契约校验；凭据缺失只告警一次。 */
  async function freshHealth() {
    const health = await probe(opts, opts.fetchImpl)
    if (!health) {
      cachedHealth = null
      healthyUntil = 0
      return null
    }
    cachedHealth = health
    healthyUntil = Date.now() + Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)

    const contract = checkContract(health, opts)
    if (!contract.ok) {
      if (opts.strictBackend === false) {
        for (const item of contract.problems) note('warn', `后端不满足契约（strictBackend=false，仍复用）：${item}`)
      } else {
        note('warn', `拒绝复用后端：${contract.problems.join('；')}`)
        throw Object.assign(
          new Error(contractError(resolveBackendEntry(opts).entry, contract.problems)),
          { failureCode: 'BACKEND_STALE' },
        )
      }
    }

    const { warnings } = diffHealth(health)
    for (const item of warnings) {
      if (/登录态/.test(item)) {
        if (warnedCredential) continue
        warnedCredential = true
      }
      note('warn', item)
    }
    note('debug', `后端自述 status=${health.status} version=${health.version} cgi=${health.credential?.cgiReady} assistant=${health.credential?.assistantReady}`)
    return health
  }

  async function ensure() {
    const ttl = Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)
    if (ttl > 0 && cachedHealth && Date.now() < healthyUntil) return cachedHealth
    const alive = await freshHealth()
    if (alive) return alive
    if (opts.autoStart === false) {
      throw new Error(
        `OrcaTerm 反代未在 ${baseUrlOf(opts)} 运行，且 autoStart=false。\n`
        + `请手动启动：node backend/run.js --port ${portOf(opts)}，或把 autoStart 设为 true。`,
      )
    }
    if (starting) return starting

    starting = (async () => {
      note('info', `正在启动 OrcaTerm 反代 (${baseUrlOf(opts)})`)
      spawnServer()

      const timeoutMs = Number(opts.startTimeoutMs || 30000)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (lastPid !== 0 && !isAlive(lastPid)) {
          const where = logFile ? `详见日志文件 ${logFile}` : '(无最近日志)'
          throw new Error(
            `OrcaTerm 反代启动失败（PID=${lastPid} 已退出）。${where}\n最近日志:\n${recentLogs.slice(-30).join('\n')}`,
          )
        }
        const ready = await freshHealth().catch((error) => {
          // 契约失败是终局，不该等到超时；其它情况（还没起来）继续轮询。
          if (error?.failureCode === 'BACKEND_STALE') throw error
          return null
        })
        if (ready) {
          note('info', `反代已就绪 (${baseUrlOf(opts)})`)
          return ready
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`OrcaTerm 反代在 ${timeoutMs}ms 内未就绪。最近日志:\n${recentLogs.slice(-30).join('\n')}`)
    })().finally(() => {
      starting = null
    })

    return starting
  }

  function dispose() {
    if (opts.detach === true) {
      note('info', `detach 模式：保留反代 PID=${lastPid}，不由插件回收`)
      cachedHealth = null
      healthyUntil = 0
      return
    }
    const target = child?.pid || (isAlive(lastPid) ? lastPid : 0)
    if (target) {
      if (opts.killTreeOnDispose !== false) {
        const result = killProcessTree(target, { force: true })
        note('info', `回收反代进程树 PID=${target} method=${result.method} ok=${result.ok}${result.detail ? ` (${result.detail})` : ''}`)
        if (!result.ok) note('warn', `进程树回收未确认：${result.detail}`)
      } else {
        try {
          child?.kill()
          note('info', `仅回收直接子进程 PID=${target}（killTreeOnDispose=false）`)
        } catch {
          // 目标可能已自行退出
        }
      }
    }
    child = null
    cachedHealth = null
    healthyUntil = 0
  }

  return {
    ensure,
    dispose,
    health: () => cachedHealth,
    entry: () => resolveBackendEntry(opts).entry,
    port: () => portOf(opts),
    pid: () => child?.pid || lastPid || 0,
    tail: () => recentLogs.slice(-20).join('\n'),
    get isRunning() {
      return child !== null || isAlive(lastPid)
    },
  }
}

/** detach + logFile 组合下把反代 stdio 直接接到日志文件。 */
function openLogFileStreams(logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    return { stdout: openSync(logFile, 'a'), stderr: openSync(logFile, 'a') }
  } catch {
    return {}
  }
}
