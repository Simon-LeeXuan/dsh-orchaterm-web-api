import { spawnSync } from 'node:child_process'

/**
 * 进程树回收与子进程环境白名单。
 *
 * 拉起的是**本插件自带的 Node 反代**（backend/run.js）。它只该看到 OS 必需变量、
 * 出网代理变量，以及自己的 `ORCA_` / `DSH_ORCATTERM2API_` 命名空间；宿主里的
 * `DEEPSEEK_API_KEY`、别的插件的 `CAMOUFOX_PORT`、`PYTHONPATH` 一律不进。
 *
 * @module lib/process.js
 */

/** 探测某个 PID 是否还活着（不发信号）。 */
export function isAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 连带子进程一起结束。
 * @param {number} pid 目标进程
 * @param {{ force?: boolean, platform?: NodeJS.Platform }} [options]
 * @returns {{ ok: boolean, method: string, detail: string }}
 */
export function killProcessTree(pid, options = {}) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { ok: false, method: 'none', detail: `无效 PID: ${pid}` }
  }
  const platform = options.platform || process.platform
  const force = options.force !== false

  if (platform === 'win32') {
    const args = ['/PID', String(numeric), '/T']
    if (force) args.push('/F')
    const result = spawnSync('taskkill', args, { windowsHide: true, encoding: 'utf8' })
    const detail = String(result.stderr || result.stdout || '').trim()
    if (result.status === 0) return { ok: true, method: 'taskkill', detail }
    const alreadyGone = /没有这样的进程|not found|No such/i.test(detail)
    return { ok: alreadyGone, method: 'taskkill', detail: detail || `exit=${result.status}` }
  }

  // POSIX：负号打整个进程组（要求 spawn 时 detached，见 buildSpawnPlan）。
  try {
    process.kill(-numeric, force ? 'SIGKILL' : 'SIGTERM')
    return { ok: true, method: 'process-group', detail: `pgid=${numeric}` }
  } catch (error) {
    const code = error?.code
    if (code === 'ESRCH') return { ok: true, method: 'process-group', detail: '进程组已退出' }
    try {
      process.kill(numeric, force ? 'SIGKILL' : 'SIGTERM')
      return { ok: true, method: 'single', detail: `进程组信号失败(${code})，退化为单进程` }
    } catch (inner) {
      return { ok: false, method: 'single', detail: String(inner?.code || inner) }
    }
  }
}

/**
 * 决定怎么拉起后端。
 * - 托管（默认）：stdio 走管道，插件能 tail 日志、能在 dispose 时按进程树回收；
 *   代价是父进程被强杀时子进程写 stdout 会 EPIPE 而退出（对「宿主退出=服务停」是正确语义）。
 * - detach：独立进程组 + stdio 落 logFile 或忽略，插件退出不再牵连后端。
 *
 * @param {{ detach?: boolean, logFile?: string, cwd?: string, entryDir?: string }} opts
 * @param {{ stdout?: number, stderr?: number }} [fds]
 */
export function buildSpawnPlan(opts = {}, fds = {}) {
  const detached = opts.detach === true
  const useFiles = detached && Boolean(opts.logFile) && Boolean(fds.stdout) && Boolean(fds.stderr)
  return {
    detached,
    windowsHide: true,
    cwd: opts.cwd || opts.entryDir,
    stdio: detached
      ? useFiles ? ['ignore', fds.stdout, fds.stderr] : ['ignore', 'ignore', 'ignore']
      : ['ignore', 'pipe', 'pipe'],
  }
}

/** 跑起 Node 与网络栈必需的 OS 变量。 */
export const ENV_BASE_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'TEMP', 'TMP', 'HOME',
  'TZ', 'LANG', 'LC_ALL',
  // 出网：公司网/代理环境下反代要能连到 api.orcaterm.com
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS',
])

/** 后端认识的命名空间；其余环境变量一律不进子进程。 */
export const ENV_PASSTHROUGH_PREFIXES = Object.freeze(['ORCA_', 'DSH_ORCATTERM2API_'])

/**
 * 组子进程环境。
 * @param {Record<string, string | undefined>} source 通常传 process.env
 * @param {{ inject?: Record<string, string | number>, extraKeys?: string[] }} [options]
 * @returns {{ env: Record<string, string>, keys: string[] }}
 */
export function buildChildEnv(source = {}, options = {}) {
  const env = {}
  for (const key of ENV_BASE_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (!ENV_PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    if (typeof value !== 'string' || value === '') continue
    env[key] = value
  }
  for (const key of Array.isArray(options.extraKeys) ? options.extraKeys : []) {
    const value = source[key]
    if (typeof key === 'string' && typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(options.inject || {})) {
    if (value === undefined || value === null || value === '') continue
    env[key] = String(value)
  }
  return { env, keys: Object.keys(env).sort() }
}
