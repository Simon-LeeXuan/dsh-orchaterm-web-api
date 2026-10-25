import { readFileSync, existsSync } from 'node:fs'
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
export function desktopPaths() {
  return {
    store: `${appdata()}\\com.orcaterm-desktop.app\\data.bin`,
    cookies: `${localappdata()}\\com.orcaterm-desktop.app\\.cookies`,
  }
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

/**
 * 解析当前可用凭据。
 *
 * 优先级与保活策略：
 *   1. 显式 credentialsFile (JSON) 或环境变量中的 token/bearer；若已过期，自动回退到本地鲜活 token；
 *   2. OrcaTerm 桌面端：对比 data.bin 与 .cookies 中的 ot_session，自动选取未过期且最鲜活的一个；
 *   3. uin 与 skey 结合 cookieHeader，提供完整的 LightAI 助手鉴权体系。
 */
export function resolveCredentials(opts = {}) {
  const paths = desktopPaths()
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

  const storeText = readText(paths.store)
  const jarText = readText(paths.cookies)
  const jar = parseCookieJar(jarText)

  // 桌面端双源提取：data.bin 里的 oauth_access_token vs .cookies 里的 ot_session
  const tokenFromStoreMatch = /"oauth_access_token"\s*:\s*"([^"]+)"/.exec(storeText)
  const tokenFromStore = tokenFromStoreMatch?.[1] || ''
  const tokenFromJar = pick(jar, 'ot_session', /orcaterm/) || ''

  // 比较有效期，选最鲜活的本地 token（OrcaTerm 在后台刷新 token 时会先写进 .cookies）
  const storeExp = decodeJwtExp(tokenFromStore)
  const jarExp = decodeJwtExp(tokenFromJar)
  const freshestLocalToken = jarExp >= storeExp && tokenFromJar ? tokenFromJar : (tokenFromStore || tokenFromJar)

  const rawFileToken = file?.token || opts.token || process.env.ORCA_ACCESS_TOKEN || ''
  const token = (rawFileToken && decodeJwtExp(rawFileToken) > Date.now()) ? rawFileToken : (freshestLocalToken || rawFileToken)
  if (token === freshestLocalToken && freshestLocalToken) sources.push('desktop-store')

  // assistant 专用的 Bearer Token：若手工填的已过期，自动回退到桌面端实时保活的 ot_session
  const rawFileBearer = file?.assistantBearer || opts.assistantBearer || process.env.ORCA_ASSISTANT_BEARER || ''
  const isFileBearerValid = rawFileBearer && decodeJwtExp(rawFileBearer) > Date.now()
  const assistantBearer = isFileBearerValid ? rawFileBearer : (freshestLocalToken || rawFileBearer || token)

  const uin = String(
    file?.uin || opts.uin || process.env.ORCA_UIN
    || /"userId"\s*:\s*"(\d+)"/.exec(storeText)?.[1]
    || pick(jar, 'uin', /tencent/) || '',
  ).replace(/^o0+/, '')
  const skey = String(file?.skey || opts.skey || process.env.ORCA_SKEY || pick(jar, 'skey', /tencent/) || '')
  const pSkey = String(file?.pskey || process.env.ORCA_PSKY || pick(jar, 'p_skey', /tencent/) || '')

  // 完整的 Cookie 头，优先用 credentialsFile / 配置中传入的
  const cookieHeader = String(
    file?.cookieHeader || file?.cookies || opts.assistantCookies || opts.cookies || process.env.ORCA_ASSISTANT_COOKIES || process.env.ORCA_COOKIES || '',
  )

  const expiresMatch = /"oauth_expires_at"\s*:\s*(\d+)/.exec(storeText)
  const expiresAtMs = Math.max(Number(expiresMatch?.[1] || 0), storeExp, jarExp)

  const hasSkey = (skey || pSkey || /skey=/i.test(cookieHeader)) !== ''
  const hasUin = (uin || /uin=/i.test(cookieHeader)) !== ''

  return {
    token,
    assistantBearer,
    cookieHeader,
    jar,
    uin,
    ownerUin: String(file?.ownerUin || uin),
    skey: skey || pSkey,
    csrfCode: csrfCodeOf(skey || pSkey),
    sources: Array.from(new Set(sources)),
    expiresAtMs,
    cgiReady: token !== '' || uin !== '',
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
    },
  }
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
  }
}
