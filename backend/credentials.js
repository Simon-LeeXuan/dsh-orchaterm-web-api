import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

/** csrfCode = djb2(skey) & 0x7fffffff（与 OrcaTerm 前端 getACSRFToken 同一算法）。 */
export function csrfCodeOf(skey) {
  if (typeof skey !== 'string' || skey === '') return ''
  let hash = 5381
  for (let i = 0; i < skey.length; i += 1) hash += (hash << 5) + skey.charCodeAt(i)
  return String(hash & 0x7fffffff)
}

function appdata() {
  return process.env.APPDATA || `${process.env.USERPROFILE || homedir()}\\AppData\\Roaming`
}
function localappdata() {
  return process.env.LOCALAPPDATA || `${process.env.USERPROFILE || homedir()}\\AppData\\Local`
}

/** 桌面端安装/登录目录是否在本机存在（用于健康页提示）。 */
export function desktopPaths(overrides = {}) {
  return {
    store: overrides.storePath || `${appdata()}\\com.orcaterm-desktop.app\\data.bin`,
    cookies: overrides.cookiesPath || `${localappdata()}\\com.orcaterm-desktop.app\\.cookies`,
  }
}

/** 插件自己的续期结果缓存：`~/.dsh/orca-token-cache.json`（可用 DSH_ORCA_TOKEN_CACHE 覆盖）。 */
export function tokenCachePath(explicit = '') {
  const chosen = String(explicit || process.env.DSH_ORCA_TOKEN_CACHE || '').trim()
  if (chosen !== '') return chosen
  return `${homedir()}\\.dsh\\orca-token-cache.json`
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 解析 Tauri cookie jar（`[{"raw_cookie":"k=v; Path=/; Domain=…"}]`）。
 */
export function parseCookieJar(text) {
  if (!text) return []
  let list
  try {
    list = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    const raw = typeof entry?.raw_cookie === 'string' ? entry.raw_cookie : ''
    const [pair, ...attrs] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const domain = entry?.domain?.HostOnly || entry?.domain?.Suffix || ''
    out.push({
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain,
      path: (attrs.find((a) => /^\s*Path=/.test(a)) || '').split('=')[1]?.trim() || '/',
    })
  }
  return out
}

/**
 * 组 Cookie 头：按域筛选。
 */
export function cookieHeaderFor(cookies, host) {
  const pairs = []
  for (const c of cookies) {
    if (!c.domain) continue
    const ok = c.domain.startsWith('.')
      ? host === c.domain.slice(1) || host.endsWith(c.domain)
      : host === c.domain || host.endsWith(`.${c.domain}`)
    if (ok) pairs.push(`${c.name}=${c.value}`)
  }
  return pairs.join('; ')
}

function pick(cookies, name, hostPattern) {
  for (const c of cookies) {
    if (c.name !== name) continue
    if (!hostPattern || hostPattern.test(c.domain)) return c.value
  }
  return ''
}

/** 解析 JWT payload 中的 exp（毫秒级时间戳）。 */
export function decodeJwtExp(jwt) {
  if (typeof jwt !== 'string' || !jwt.includes('.')) return 0
  try {
    const raw = Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')
    const payload = JSON.parse(raw)
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ *
 * 续期结果缓存
 *
 * 背景：AccessToken 是 2 小时有效期的 JWT，桌面端在跑时由它的 TokenManager
 * 到点续期并写回 `data.bin` / `.cookies`。插件自己续期（见 token-refresh.js）
 * 后必须把结果落盘 —— 否则反代进程一重启，就得靠桌面端留下的一次性登录态，
 * 而那个值可能早已过期。
 *
 * 文件里只有 `{accessToken, expiresAt, refreshedAt}`；写入用临时文件 + rename，
 * POSIX 下 mode 0600。**只取更晚 exp 的那一个**：多实例并发续期时不会互相踩旧值。
 * ------------------------------------------------------------------ */

/**
 * 读插件自己的续期缓存。
 * @param {string} [path]
 * @returns {{accessToken:string, expiresAt:number, refreshedAt:number, path:string}|null}
 */
export function readCachedToken(path = tokenCachePath()) {
  if (!path || !existsSync(path)) return null
  try {
    const raw = JSON.parse(readText(path))
    const accessToken = typeof raw?.accessToken === 'string' ? raw.accessToken : ''
    if (accessToken === '') return null
    return {
      accessToken,
      expiresAt: Number(raw?.expiresAt) || decodeJwtExp(accessToken),
      refreshedAt: Number(raw?.refreshedAt) || 0,
      path,
    }
  } catch {
    return null
  }
}

/**
 * 写续期缓存（更晚的 exp 才覆盖；原子写）。
 * @returns {boolean} 是否真的写了盘
 */
export function writeCachedToken(path, { accessToken, expiresAt = 0, refreshedAt = Date.now() } = {}) {
  if (!path || typeof accessToken !== 'string' || accessToken === '') return false
  try {
    const previous = readCachedToken(path)
    const nextExp = Number(expiresAt) || decodeJwtExp(accessToken)
    if (previous && decodeJwtExp(previous.accessToken) > nextExp) return false
    mkdirSync(dirname(path), { recursive: true })
    const body = JSON.stringify({
      version: 1,
      accessToken,
      expiresAt: nextExp,
      refreshedAt: Number(refreshedAt) || Date.now(),
    }, null, 2)
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* 临时文件可能没建出来 */ }
      throw error
    }
    return true
  } catch {
    return false
  }
}

/**
 * 把一枚新 AccessToken 应用到当前凭据上（就地返回新对象，不改入参）。
 *
 * 除了 `token` / `assistantBearer` / `expiresAtMs`，**必须同步 jar 里的 `ot_session`**：
 * CGI 通道在桌面端口径下就是靠这个 cookie 鉴权的，只换 Bearer 不换 cookie，
 * 等于把旧 token 又发了一遍（`cookieFor` 优先读 jar）。
 *
 * @param {object} credential resolveCredentials 的产物
 * @param {string} accessToken 新 JWT
 * @param {{keepAssistantBearer?:boolean}} [options]
 *   `keepAssistantBearer`：保留调用方显式给的有效 `assistantBearer`
 *   （解析路径用；**续期路径不要用** —— 续期出来的 token 就是该用的 bearer）。
 * @returns {object} 新凭据对象
 */
export function applyAccessToken(credential, accessToken, options = {}) {
  if (!credential || typeof accessToken !== 'string' || accessToken === '') return credential
  const exp = decodeJwtExp(accessToken)
  const next = {
    ...credential,
    token: accessToken,
    assistantBearer: options.keepAssistantBearer === true && credential.assistantBearer
      ? credential.assistantBearer
      : accessToken,
    expiresAtMs: exp > 0 ? exp : Number(credential.expiresAtMs) || 0,
  }
  if (Array.isArray(next.jar)) {
    next.jar = next.jar.map((entry) => (
      entry?.name === 'ot_session' ? { ...entry, value: accessToken } : entry
    ))
  }
  if (typeof next.cookieHeader === 'string' && /(^|;\s*)ot_session=/.test(next.cookieHeader)) {
    next.cookieHeader = next.cookieHeader.replace(
      /(^|;\s*)ot_session=[^;]*/,
      (_, lead) => `${lead}ot_session=${accessToken}`,
    )
  }
  return next
}

/** 候选 token 里挑最鲜活的：优先「未过期」的，其次按 exp 排序（过期值仍要留给续期用）。 */
function freshestToken(candidates) {
  const list = candidates.filter((item) => item && typeof item.token === 'string' && item.token !== '')
  if (list.length === 0) return null
  const now = Date.now()
  const valid = list.filter((item) => item.exp > now)
  const pool = valid.length > 0 ? valid : list
  return pool.reduce((best, item) => (item.exp > best.exp ? item : best), pool[0])
}

/**
 * 解析当前可用凭据。
 *
 * 优先级与续期策略（v0.6.0 起）：
 *   1. 显式 credentialsFile / 参数 / 环境变量里的 token：能解析出 exp 且未过期就照旧用；
 *   2. 否则在「插件续期缓存 / 桌面端 data.bin / 桌面端 .cookies」之间取 exp 最晚的一个
 *      （未过期的优先，都过期时仍取最晚的那个 —— 它是续期的输入，见 token-refresh.js）；
 *   3. uin 与 skey 结合 cookieHeader，提供完整的 LightAI 助手鉴权体系。
 *
 * 这里只做**本地**判断；真正向服务端换新 token 的是 token-refresh.js。
 */
export function resolveCredentials(opts = {}) {
  const paths = desktopPaths(opts)
  const sources = []

  // 1) 手工凭据文件：~/.dsh/orca-credentials.json
  const defaultPointer = `${homedir()}\\.dsh\\orca-credentials.json`
  const pointer = opts.credentialsFile || process.env.DSH_ORCA_CREDENTIALS || (existsSync(defaultPointer) ? defaultPointer : '')
  let file = null
  if (pointer && existsSync(pointer)) {
    try {
      file = JSON.parse(readText(pointer))
      sources.push('credentialsFile')
    } catch {
      file = null
    }
  }

  // 2) 桌面端登录态 + 插件自己的续期缓存
  const storeText = readText(paths.store)
  const jarText = readText(paths.cookies)
  const jar = parseCookieJar(jarText)
  const cachePath = tokenCachePath(opts.tokenCache)
  const cached = readCachedToken(cachePath)

  const tokenFromStoreMatch = /"oauth_access_token"\s*:\s*"([^"]+)"/.exec(storeText)
  const tokenFromStore = tokenFromStoreMatch?.[1] || ''
  const tokenFromJar = pick(jar, 'ot_session', /orcaterm/) || ''

  const explicitToken = file?.token || opts.token || process.env.ORCA_ACCESS_TOKEN || ''
  const explicitExp = decodeJwtExp(explicitToken)

  const chosen = (explicitToken !== '' && (explicitExp === 0 || explicitExp > Date.now()))
    ? { token: explicitToken, exp: explicitExp, source: 'credentialsFile' }
    : (freshestToken([
      { token: cached?.accessToken || '', exp: decodeJwtExp(cached?.accessToken || ''), source: 'tokenCache' },
      { token: tokenFromStore, exp: decodeJwtExp(tokenFromStore), source: 'desktop-store' },
      { token: tokenFromJar, exp: decodeJwtExp(tokenFromJar), source: 'desktop-cookies' },
      ...(explicitToken !== '' ? [{ token: explicitToken, exp: explicitExp, source: 'credentialsFile' }] : []),
    ]) || { token: '', exp: 0, source: '' })

  // 桌面端在后台续期时会先写进 .cookies；缓存则是插件续期的产物。
  // 选中的值比 jar 里的新时，把 jar 的 ot_session 也换掉（CGI 的 cookie 鉴权读它）。
  const jarExp = decodeJwtExp(tokenFromJar)

  // assistant 专用的 Bearer Token：若手工填的已过期，自动回退到当前最鲜活的 token
  const rawFileBearer = file?.assistantBearer || opts.assistantBearer || process.env.ORCA_ASSISTANT_BEARER || ''
  const isFileBearerValid = rawFileBearer !== '' && decodeJwtExp(rawFileBearer) > Date.now()
  const assistantBearer = isFileBearerValid
    ? rawFileBearer
    : (chosen.token || rawFileBearer || '')

  const uin = String(
    file?.uin || opts.uin || process.env.ORCA_UIN
    || /"userId"\s*:\s*"(\d+)"/.exec(storeText)?.[1]
    || pick(jar, 'uin', /tencent/) || '',
  ).replace(/^o0+/, '')
  const skey = String(file?.skey || opts.skey || process.env.ORCA_SKEY || pick(jar, 'skey', /tencent/) || '')
  const pSkey = String(file?.pskey || process.env.ORCA_PSKEY || pick(jar, 'p_skey', /tencent/) || '')

  // 完整的 Cookie 头，优先用 credentialsFile / 配置中传入的
  const cookieHeader = String(
    file?.cookieHeader || file?.cookies || opts.assistantCookies || opts.cookies || process.env.ORCA_ASSISTANT_COOKIES || process.env.ORCA_COOKIES || '',
  )

  const expiresMatch = /"oauth_expires_at"\s*:\s*(\d+)/.exec(storeText)
  const expiresAtMs = Math.max(
    Number(expiresMatch?.[1] || 0),
    chosen.exp,
    decodeJwtExp(tokenFromStore),
    jarExp,
    cached ? decodeJwtExp(cached.accessToken) : 0,
  )

  const hasSkey = (skey || pSkey || /skey=/i.test(cookieHeader)) !== ''
  const hasUin = (uin || /uin=/i.test(cookieHeader)) !== ''

  if (chosen.source && chosen.source !== 'credentialsFile') {
    sources.push(chosen.source === 'desktop-cookies' ? 'desktop-store' : chosen.source)
  }

  const credential = {
    token: chosen.token,
    assistantBearer,
    cookieHeader,
    jar,
    uin,
    ownerUin: String(file?.ownerUin || uin),
    skey: skey || pSkey,
    csrfCode: csrfCodeOf(skey || pSkey),
    sources: Array.from(new Set(sources)),
    expiresAtMs,
    tokenCachePath: cachePath,
    cgiReady: chosen.token !== '' || uin !== '',
    assistantReady: hasUin && hasSkey,
    detail: {
      store: {
        path: paths.store,
        exists: storeText !== '',
        hasToken: Boolean(tokenFromStore),
        hasUserId: Boolean(/"userId"\s*:\s*"\d+"/.test(storeText)),
      },
      cookies: {
        path: paths.cookies,
        exists: jarText !== '',
        entries: jar.length,
        domains: Array.from(new Set(jar.map((c) => c.domain))).sort(),
      },
      tokenCache: {
        path: cachePath,
        exists: cached !== null,
        hasToken: Boolean(cached?.accessToken),
        expiresAt: cached ? new Date(decodeJwtExp(cached.accessToken) || cached.expiresAt).toISOString() : '',
      },
    },
  }

  // 缓存里的 token 比桌面端 jar 新时，把 jar 的 ot_session 同步过去。
  // 手工给的有效 assistantBearer 不能被顺手覆盖（它可能是另一套鉴权串）。
  if (chosen.source !== 'desktop-store' && chosen.source !== 'desktop-cookies' && jarExp < chosen.exp) {
    return applyAccessToken(credential, chosen.token, { keepAssistantBearer: isFileBearerValid })
  }
  return credential
}

/** 供健康页/日志使用：只报事实，不回报任何值。 */
export function redact(cred) {
  return {
    tokenChars: cred.token.length,
    assistantBearerChars: cred.assistantBearer.length,
    uinPresent: cred.uin !== '',
    skeyPresent: cred.skey !== '' || /skey=/i.test(cred.cookieHeader),
    csrfCodePresent: cred.csrfCode !== '',
    cookieHeaderLength: cred.cookieHeader.length,
    cookieEntries: cred.jar?.length ?? 0,
    cookieDomains: cred.detail?.cookies?.domains ?? [],
    sources: cred.sources,
    expiresAt: cred.expiresAtMs > 0 ? new Date(cred.expiresAtMs).toISOString() : '',
    cgiReady: cred.cgiReady,
    assistantReady: cred.assistantReady,
    tokenCache: {
      path: cred.detail?.tokenCache?.path ?? '',
      exists: cred.detail?.tokenCache?.exists ?? false,
      expiresAt: cred.detail?.tokenCache?.expiresAt ?? '',
    },
  }
}