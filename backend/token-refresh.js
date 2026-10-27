/**
 * AccessToken 自续期（注册刷新机制）。
 *
 * 逆向依据（2026-10-27，OrcaTerm 1.6.6 前端 bundle `orcaterm_app.zh.*.js`，
 * 模块 24530 与 Rust `[TokenManager]` 日志双向印证）：
 *
 *   OAuthExchangeToken  `{sessionId}`   ← 浏览器 OAuth 回调后的首次换取（桌面端 deep link）
 *   OAuthRefreshToken   `{accessToken}` ← 续期；入参就是**当前** AccessToken
 *   响应 `{Code:0, Message, AccessToken, ExpiresIn:7200}`（有时还带 RefreshToken/User），
 *   并在响应头里同样回一份 `X-OT-Token-Refreshed`。
 *
 * 实测边界（同一天，本机）：
 *   - AccessToken 过期 30 小时后调用 OAuthRefreshToken 仍成功 → 续期不要求 token 未过期；
 *   - 续期出来的 JWT `jti` / `providerCredentialKey` 与原 token 完全一致，只有 iat/exp 变；
 *   - 链式续期（用新 token 再换一次）成立 → 不需要 RefreshToken，也不存在轮换失效；
 *   - 旧 token 在新 token 签发后仍然可用 → 与桌面端并存不会互相踢线；
 *   - 请求头只需常规 CGI 头，Authorization / cookie / uin 查询串都不是必需的（仍照常带）。
 *
 * 因此：只要**曾经登录过一次**（desktop data.bin / .cookies 或 credentialsFile），
 * 插件就能一直自己续下去，不必把 OrcaTerm 客户端开着。
 *
 * 设计取舍：
 *   1. 单飞（in-flight 去重）：并发的好几个回合只发一次续期请求；
 *   2. 失败冷却：认证失败后 30s 内不重复打上游，避免把一次 401 放大成风暴；
 *   3. 只写更晚 exp：多实例（多个端口/多个 DSH）并发续期时不会用旧值覆盖新值；
 *   4. 全程不打印 token 值，/health 只报时间与状态码。
 *
 * @module backend/token-refresh.js
 */

import { cgiCall } from './upstream.js'
import {
  applyAccessToken,
  decodeJwtExp,
  readCachedToken,
  tokenCachePath,
  writeCachedToken,
} from './credentials.js'

/** 续期动作名（与官方前端 `OAuthRefreshToken` 一致）。 */
export const OAUTH_REFRESH_ACTION = 'OAuthRefreshToken'

/** 距过期不足这么久就提前续期（官方是 110 分钟续、5 分钟巡检；这里取 10 分钟）。 */
export const DEFAULT_REFRESH_LEAD_MS = 10 * 60 * 1000

/** 后台巡检间隔（对齐官方 `Periodic check started (every 5 minutes)`）。 */
export const DEFAULT_REFRESH_CHECK_MS = 5 * 60 * 1000

/** 失败后的冷却时间：这段时间内不再向 OAuthRefreshToken 发请求。 */
export const DEFAULT_FAILURE_COOLDOWN_MS = 30 * 1000

/** 单次续期请求上限。续期是控制面小请求，不该拖住聊天。 */
export const DEFAULT_REFRESH_TIMEOUT_MS = 15 * 1000

/** 取凭据的过期时间（毫秒）；0 = 未知（按「需要续期」处理）。 */
export function tokenExpiresAt(credential) {
  const exp = decodeJwtExp(credential?.token || '')
  if (exp > 0) return exp
  const fallback = Number(credential?.expiresAtMs) || 0
  return fallback > 0 ? fallback : 0
}

/** 剩余寿命（毫秒）；-1 表示未知。 */
export function tokenRemainingMs(credential, nowMs = Date.now()) {
  const exp = tokenExpiresAt(credential)
  return exp > 0 ? exp - nowMs : -1
}

/**
 * 建续期器。
 *
 * @param {object} config buildConfig 的产物（会就地替换 `config.credential`）
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用）
 * @param {string}   [options.cachePath] 缓存文件路径
 * @param {number}   [options.leadMs]    提前续期阈值
 * @param {number}   [options.cooldownMs] 失败冷却
 * @param {number}   [options.timeoutMs] 单次请求上限
 * @param {Function} [options.now]       注入时钟（测试用）
 */
export function createTokenRefresher(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const cachePath = options.cachePath || config.tokenCachePath || tokenCachePath()
  const leadMs = Number.isFinite(Number(options.leadMs))
    ? Math.max(0, Number(options.leadMs))
    : DEFAULT_REFRESH_LEAD_MS
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Math.max(0, Number(options.cooldownMs))
    : DEFAULT_FAILURE_COOLDOWN_MS
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : DEFAULT_REFRESH_TIMEOUT_MS
  const now = typeof options.now === 'function' ? options.now : Date.now

  let inFlight = null
  let lastAttemptAt = 0
  let attempts = 0
  let lastRefreshedAt = 0
  let lastAbsorbedAt = 0
  let last = { ok: false, code: 'IDLE', message: '', at: 0, reason: '' }

  /** 只报事实的健康快照（不含任何凭据值）。 */
  function state() {
    const exp = tokenExpiresAt(config.credential)
    const cached = readCachedToken(cachePath)
    const cacheExp = cached ? decodeJwtExp(cached.accessToken) : 0
    return {
      enabled: true,
      expiresAt: exp > 0 ? new Date(exp).toISOString() : '',
      remainingSec: exp > 0 ? Math.round((exp - now()) / 1000) : -1,
      leadSec: Math.round(leadMs / 1000),
      cachePath,
      cacheExpiresAt: cacheExp > 0 ? new Date(cacheExp).toISOString() : '',
      attempts,
      lastRefreshedAt: lastRefreshedAt > 0 ? new Date(lastRefreshedAt).toISOString() : '',
      lastAbsorbedAt: lastAbsorbedAt > 0 ? new Date(lastAbsorbedAt).toISOString() : '',
      last: {
        ok: last.ok,
        code: last.code,
        message: last.message,
        reason: last.reason,
        at: last.at > 0 ? new Date(last.at).toISOString() : '',
      },
    }
  }

  function recordFailure(code, message, reason) {
    last = { ok: false, code, message: String(message || '').slice(0, 200), at: now(), reason: reason || '' }
    return { ok: false, refreshed: false, code, message: last.message, credential: config.credential }
  }

  async function execute(reason) {
    const token = config.credential?.token || config.credential?.assistantBearer || ''
    if (token === '') {
      return recordFailure('NO_TOKEN', '没有可续期的 AccessToken：请先登录一次 OrcaTerm（桌面端或 credentialsFile）', reason)
    }
    // 必须在发请求**之前**取值：cgiCall 会先把响应头 X-OT-Token-Refreshed 吸收进 credential，
    // 之后再读就成了「拿新值和新值比」，必然误判成 NO_PROGRESS（实测踩过）。
    const previousExp = tokenExpiresAt(config.credential)
    lastAttemptAt = now()
    attempts += 1

    let result
    try {
      result = await cgiCall(config, OAUTH_REFRESH_ACTION, { accessToken: token }, {
        fetchImpl,
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
    } catch (error) {
      return recordFailure('TRANSPORT', `续期请求失败: ${error?.message || error}`, reason)
    }

    // 响应头里那枚 token 可能已经被 cgiCall 吸收过（absorb）→ 这就是成功，不必再走 body。
    const advanced = () => tokenExpiresAt(config.credential) > previousExp
    const successByHeader = () => {
      lastRefreshedAt = now()
      last = { ok: true, code: 'OK', message: '', at: lastRefreshedAt, reason: `${reason} (header)` }
      return {
        ok: true,
        refreshed: true,
        persisted: false,
        viaHeader: true,
        expiresAt: tokenExpiresAt(config.credential),
        credential: config.credential,
      }
    }

    if (!result?.ok) {
      if (advanced()) return successByHeader()
      return recordFailure(
        String(result?.upstreamCode || result?.code || 'UPSTREAM'),
        String(result?.message || '续期被上游拒绝').slice(0, 200),
        reason,
      )
    }

    const newToken = typeof result.data?.AccessToken === 'string' ? result.data.AccessToken : ''
    if (newToken === '') {
      if (advanced()) return successByHeader()
      return recordFailure('NO_TOKEN_IN_RESPONSE', '续期响应里没有 AccessToken', reason)
    }

    const newExp = decodeJwtExp(newToken)
    if (newExp > 0 && previousExp > 0 && newExp <= previousExp) {
      if (advanced()) return successByHeader()
      // 服务端回了更短的有效期：不要覆盖，也不要落盘（下次再试）。
      return recordFailure('NO_PROGRESS', '续期返回的 token 没有更晚的过期时间', reason)
    }

    config.credential = applyAccessToken(config.credential, newToken)
    config.credential.sources = Array.from(new Set([...(config.credential.sources || []), 'tokenRefresh']))
    const persisted = writeCachedToken(cachePath, {
      accessToken: newToken,
      expiresAt: newExp,
      refreshedAt: now(),
    })
    lastRefreshedAt = now()
    last = { ok: true, code: 'OK', message: '', at: lastRefreshedAt, reason: reason || '' }
    return {
      ok: true,
      refreshed: true,
      persisted,
      expiresAt: newExp,
      credential: config.credential,
    }
  }

  /**
   * 到期就续（或 force 强制续）。并发调用共享同一个 in-flight Promise。
   * @param {{force?:boolean, reason?:string}} [opts]
   */
  async function ensureFresh(opts = {}) {
    const force = opts.force === true
    const reason = String(opts.reason || (force ? 'force' : 'expiring'))
    const remaining = tokenRemainingMs(config.credential, now())
    if (!force && remaining > leadMs) {
      return { ok: true, refreshed: false, skipped: 'fresh', remainingMs: remaining, credential: config.credential }
    }
    if (inFlight) return inFlight
    // 冷却只挡「自动」路径；显式 force（认证失败重试）必须真的再打一次。
    if (!force && last.ok === false && last.at > 0 && lastAttemptAt > 0 && now() - lastAttemptAt < cooldownMs) {
      return {
        ok: false,
        refreshed: false,
        skipped: 'cooldown',
        code: last.code,
        message: last.message,
        credential: config.credential,
      }
    }

    const pending = execute(reason).finally(() => { inFlight = null })
    inFlight = pending
    return pending
  }

  /**
   * 把上游响应头里的 `X-OT-Token-Refreshed` 吸收进来（服务端滑动续期，桌面端同款行为）。
   * 只接受**更晚**的 exp，防止回退。
   * @param {string} jwt
   * @returns {boolean} 是否更新了凭据
   */
  function absorb(jwt) {
    if (typeof jwt !== 'string' || !jwt.includes('.')) return false
    const exp = decodeJwtExp(jwt)
    if (exp === 0) return false
    const currentExp = tokenExpiresAt(config.credential)
    if (currentExp > 0 && exp <= currentExp) return false
    config.credential = applyAccessToken(config.credential, jwt)
    writeCachedToken(cachePath, { accessToken: jwt, expiresAt: exp })
    lastAbsorbedAt = now()
    return true
  }

  return { cachePath, leadMs, cooldownMs, ensureFresh, absorb, state }
}