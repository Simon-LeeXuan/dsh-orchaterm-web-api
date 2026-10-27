/**
 * AccessToken 自续期（OAuthRefreshToken）单元测试。
 *
 * 覆盖点（对应 backend/token-refresh.js 的设计约束）：
 *   1. 健康 token 不打扰上游（零请求）；
 *   2. 临期/过期 → 用**当前** token 调 OAuthRefreshToken，换新后凭据与缓存同步；
 *   3. force（认证失败重试）绕过阈值；
 *   4. 失败不污染现有凭据、不写缓存，并记录可诊断的 code；
 *   5. X-OT-Token-Refreshed 响应头只在「更晚」时吸收；
 *   6. 并发单飞：多个回合只发一次续期请求；
 *   7. 缓存与桌面端登录态合并时的优先级（更晚的 exp 胜出 + jar ot_session 同步）。
 *
 * 全测试离线：fetch 是注入的假实现，不碰任何真实账号。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OAUTH_REFRESH_ACTION,
  createTokenRefresher,
  tokenRemainingMs,
} from '../backend/token-refresh.js'
import {
  applyAccessToken,
  decodeJwtExp,
  readCachedToken,
  resolveCredentials,
  writeCachedToken,
} from '../backend/credentials.js'
import { buildConfig } from '../backend/server.js'
import { cgiCall } from '../backend/upstream.js'

const workDir = mkdtempSync(join(tmpdir(), 'orca-token-refresh-'))

/** 造一枚可解码的假 JWT（只需要 payload.exp）。 */
function jwt(payload = {}) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64')
  return `header.${body}.sig`
}
function expiringJwt(secondsFromNow) {
  return jwt({ exp: Math.floor((Date.now() + secondsFromNow * 1000) / 1000), jti: 'test' })
}

/** 假上游：记录请求，按脚本回包。 */
function fakeUpstream(script) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const call = {
      action: parsed.searchParams.get('action'),
      uin: parsed.searchParams.get('uin'),
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers || {},
    }
    calls.push(call)
    const next = typeof script === 'function' ? script(call, calls.length) : script
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers || {}) },
    })
  }
  return { fetchImpl, calls }
}

function okResponse(newToken, extra = {}) {
  return {
    status: 200,
    body: { data: { Response: { Code: 0, Message: 'Success', AccessToken: newToken, ExpiresIn: 7200, ...extra } } },
    headers: { 'x-ot-token-refreshed': newToken },
  }
}

function baseCredential(token, overrides = {}) {
  return {
    token,
    assistantBearer: token,
    cookieHeader: '',
    jar: [{ name: 'ot_session', value: token, domain: '.orcaterm.com', path: '/' }],
    uin: '864829721248',
    ownerUin: '864829721248',
    skey: '',
    csrfCode: '',
    sources: ['desktop-store'],
    expiresAtMs: decodeJwtExp(token),
    cgiReady: true,
    assistantReady: true,
    ...overrides,
  }
}

function candidateConfig(token, overrides = {}) {
  return {
    cgiBase: 'https://api.example.test',
    credential: baseCredential(token),
    origin: 'http://tauri.localhost',
    referer: 'http://tauri.localhost/',
    userAgent: 'test-agent',
    ...overrides,
  }
}

console.log('1. 健康 token：不打扰上游（零请求、零落盘）')
{
  const token = expiringJwt(3600)
  const cachePath = join(workDir, 't1.json')
  const { fetchImpl, calls } = fakeUpstream(okResponse(expiringJwt(7200)))
  const config = candidateConfig(token)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath, leadMs: 10 * 60 * 1000 })

  const outcome = await refresher.ensureFresh({})
  assert.equal(outcome.refreshed, false)
  assert.equal(outcome.skipped, 'fresh')
  assert.equal(calls.length, 0)
  assert.equal(existsSync(cachePath), false)
  assert.equal(config.credential.token, token)
  assert.equal(refresher.state().remainingSec > 3000, true)
}

console.log('2. 临期 token：调 OAuthRefreshToken，换新并落盘')
{
  const oldToken = expiringJwt(60)
  const newToken = expiringJwt(7200)
  const cachePath = join(workDir, 't2.json')
  const { fetchImpl, calls } = fakeUpstream(okResponse(newToken))
  const config = candidateConfig(oldToken)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath, leadMs: 10 * 60 * 1000 })

  const outcome = await refresher.ensureFresh({})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.refreshed, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, OAUTH_REFRESH_ACTION)
  assert.equal(calls[0].uin, '864829721248')
  assert.deepEqual(calls[0].body, { action: OAUTH_REFRESH_ACTION, data: { accessToken: oldToken } })

  // 凭据：token / assistantBearer / jar 里的 ot_session 全部换新
  assert.equal(config.credential.token, newToken)
  assert.equal(config.credential.assistantBearer, newToken)
  assert.equal(config.credential.jar[0].value, newToken)
  assert.ok(config.credential.sources.includes('tokenRefresh'))

  // 缓存：可被重新读回，且 exp 正确
  const cached = readCachedToken(cachePath)
  assert.equal(cached.accessToken, newToken)
  assert.equal(cached.expiresAt, decodeJwtExp(newToken))
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).version, 1)

  const state = refresher.state()
  assert.equal(state.last.ok, true)
  assert.equal(state.attempts, 1)
  assert.notEqual(state.lastRefreshedAt, '')
}

console.log('3. force：健康 token 也强制续期（认证失败重试路径）')
{
  const oldToken = expiringJwt(3600)
  const newToken = expiringJwt(7200)
  const { fetchImpl, calls } = fakeUpstream(okResponse(newToken))
  const config = candidateConfig(oldToken)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath: join(workDir, 't3.json') })

  await refresher.ensureFresh({ force: true, reason: 'auth-error' })
  assert.equal(calls.length, 1)
  assert.equal(config.credential.token, newToken)
  assert.equal(refresher.state().last.reason, 'auth-error')
}

console.log('4. 上游拒绝：保持旧凭据、不写缓存、给出可诊断 code')
{
  const oldToken = expiringJwt(30)
  const cachePath = join(workDir, 't4.json')
  const { fetchImpl, calls } = fakeUpstream({
    status: 200,
    body: { data: { Response: { Error: { Code: 'INVALID_ACCESS_TOKEN', Message: 'Invalid or expired AccessToken' } } } },
  })
  const config = candidateConfig(oldToken)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath, cooldownMs: 0 })

  const outcome = await refresher.ensureFresh({ force: true })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'INVALID_ACCESS_TOKEN')
  assert.match(outcome.message, /Invalid or expired AccessToken/)
  assert.equal(calls.length, 1)
  assert.equal(config.credential.token, oldToken)
  assert.equal(existsSync(cachePath), false)
  assert.equal(refresher.state().last.ok, false)

  // 冷却期内自动路径不再打上游；force 仍然会打
  const cooling = createTokenRefresher(config, {
    fetchImpl,
    cachePath,
    cooldownMs: 60_000,
    leadMs: 10 * 60 * 1000,
  })
  await cooling.ensureFresh({ force: true })
  const before = calls.length
  const cooled = await cooling.ensureFresh({})
  assert.equal(cooled.skipped, 'cooldown')
  assert.equal(calls.length, before)
  await cooling.ensureFresh({ force: true })
  assert.equal(calls.length, before + 1)
}

console.log('5. 传输失败：不抛异常，返回 TRANSPORT')
{
  const { fetchImpl } = fakeUpstream(() => new Error('ECONNRESET'))
  const config = candidateConfig(expiringJwt(30))
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath: join(workDir, 't5.json') })
  const outcome = await refresher.ensureFresh({ force: true })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'TRANSPORT')
  assert.match(outcome.message, /ECONNRESET/)
}

console.log('6. 单飞：并发回合只发一次续期请求')
{
  const newToken = expiringJwt(7200)
  let resolveFetch
  const gate = new Promise((resolve) => { resolveFetch = resolve })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(init)
    await gate
    return new Response(JSON.stringify(okResponse(newToken).body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ot-token-refreshed': newToken },
    })
  }
  const config = candidateConfig(expiringJwt(30))
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath: join(workDir, 't6.json') })

  const all = Promise.all([refresher.ensureFresh({}), refresher.ensureFresh({}), refresher.ensureFresh({})])
  resolveFetch()
  const outcomes = await all
  assert.equal(calls.length, 1, '三个并发调用只允许一次网络请求')
  assert.equal(outcomes.every((o) => o.refreshed === true), true)
  assert.equal(config.credential.token, newToken)
}

console.log('7. X-OT-Token-Refreshed：只吸收更晚的 token')
{
  const current = expiringJwt(3600)
  const newer = expiringJwt(7200)
  const older = expiringJwt(60)
  const cachePath = join(workDir, 't7.json')
  const { fetchImpl } = fakeUpstream({ status: 200, body: {} })
  const config = candidateConfig(current)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath })

  assert.equal(refresher.absorb('not-a-jwt'), false)
  assert.equal(refresher.absorb(older), false, '更早的 exp 不能覆盖')
  assert.equal(config.credential.token, current)

  assert.equal(refresher.absorb(newer), true)
  assert.equal(config.credential.token, newer)
  assert.equal(readCachedToken(cachePath).accessToken, newer)
  assert.notEqual(refresher.state().lastAbsorbedAt, '')

  // cgiCall 也要顺手吸收
  const { fetchImpl: f2 } = fakeUpstream({
    status: 200,
    body: { data: { Response: { Code: 0 } } },
    headers: { 'x-ot-token-refreshed': newer },
  })
  const cfg2 = candidateConfig(older)
  const refresher2 = createTokenRefresher(cfg2, { fetchImpl: f2, cachePath })
  cfg2.absorbServerToken = (jwt) => refresher2.absorb(jwt)
  const result = await cgiCall(cfg2, 'DescribeUserAiSetting', {}, { fetchImpl: f2 })
  assert.equal(result.ok, true)
  assert.equal(result.newToken, newer)
  assert.equal(cfg2.credential.token, newer)
  assert.equal(refresher2.state().lastAbsorbedAt !== '', true)
}

console.log('8. applyAccessToken：同步 jar 与 cookieHeader 里的 ot_session')
{
  const token = expiringJwt(7200)
  const cred = applyAccessToken({
    token: 'old',
    assistantBearer: 'old',
    cookieHeader: 'sid=x; ot_session=old; uin=o1',
    jar: [{ name: 'ot_session', value: 'old', domain: '.orcaterm.com' }, { name: 'sid', value: 'x', domain: '.lightai.cloud.tencent.com' }],
    expiresAtMs: 0,
    sources: ['desktop-store'],
  }, token)
  assert.equal(cred.token, token)
  assert.equal(cred.assistantBearer, token)
  assert.equal(cred.jar[0].value, token)
  assert.equal(cred.jar[1].value, 'x', '别的 cookie 不能被顺手改掉')
  assert.equal(cred.cookieHeader, `sid=x; ot_session=${token}; uin=o1`)
  assert.equal(cred.expiresAtMs, decodeJwtExp(token))
}

console.log('9. 缓存合并：续期缓存比桌面端新时优先，并同步 ot_session')
{
  const dir = mkdtempSync(join(workDir, 'merge-'))
  const storePath = join(dir, 'data.bin')
  const cookiesPath = join(dir, '.cookies')
  const cachePath = join(dir, 'cache.json')

  const oldToken = expiringJwt(-3600)
  const newToken = expiringJwt(7200)
  writeFileSync(storePath, JSON.stringify({ oauth_access_token: oldToken, userId: '864829721248', oauth_expires_at: Date.now() }))
  writeFileSync(cookiesPath, JSON.stringify([{
    raw_cookie: `ot_session=${oldToken}; Path=/; Domain=.orcaterm.com`,
    domain: { Suffix: '.orcaterm.com' },
  }]))
  writeCachedToken(cachePath, { accessToken: newToken, expiresAt: decodeJwtExp(newToken) })

  const cred = resolveCredentials({
    storePath,
    cookiesPath,
    tokenCache: cachePath,
    credentialsFile: join(dir, 'absent.json'),
  })
  assert.equal(cred.token, newToken)
  assert.ok(cred.sources.includes('tokenCache'))
  assert.equal(cred.jar.find((c) => c.name === 'ot_session').value, newToken)

  // 反向：桌面端 token 更新时不能被缓存里的旧值压住
  const cachePath2 = join(dir, 'cache2.json')
  writeFileSync(storePath, JSON.stringify({ oauth_access_token: newToken, userId: '864829721248' }))
  writeCachedToken(cachePath2, { accessToken: oldToken, expiresAt: decodeJwtExp(oldToken) })
  const cred2 = resolveCredentials({
    storePath,
    cookiesPath,
    tokenCache: cachePath2,
    credentialsFile: join(dir, 'absent.json'),
  })
  assert.equal(cred2.token, newToken)
  assert.ok(cred2.sources.includes('desktop-store'))

  // writeCachedToken：更早的 exp 不覆盖（此时缓存里是 newToken）
  assert.equal(writeCachedToken(cachePath, { accessToken: oldToken }), false)
  assert.equal(readCachedToken(cachePath).accessToken, newToken, '缓存里原有的新值保持不变')
}

console.log('10. buildConfig：接线完成（refresher / absorb / force / 阈值）')
{
  const cfg = buildConfig({
    credential: baseCredential(expiringJwt(30)),
    tokenCache: join(workDir, 't10.json'),
    tokenRefresh: 'auto',
    tokenRefreshLeadMs: 123456,
    storePath: join(workDir, 'absent-store.bin'),
    cookiesPath: join(workDir, 'absent-cookies'),
  })
  assert.equal(cfg.tokenRefreshEnabled, true)
  assert.equal(cfg.tokenRefreshLeadMs, 123456)
  assert.equal(typeof cfg.tokenRefresher.ensureFresh, 'function')
  assert.equal(typeof cfg.forceRefreshCredential, 'function')
  assert.equal(cfg.absorbServerToken('garbage'), false)
  assert.equal(tokenRemainingMs(cfg.credential) > 0, true)

  const off = buildConfig({ credential: baseCredential(expiringJwt(30)), tokenRefresh: 'off' })
  assert.equal(off.tokenRefreshEnabled, false)
  assert.equal(off.tokenRefresher, null)
  assert.equal(off.absorbServerToken('garbage'), false)
}

console.log('11. 响应头先被吸收也不能误判 NO_PROGRESS（buildConfig 的真实接线）')
{
  const oldToken = expiringJwt(30)
  const newToken = expiringJwt(7200)
  const cachePath = join(workDir, 't11.json')
  const { fetchImpl, calls } = fakeUpstream(okResponse(newToken))
  const config = candidateConfig(oldToken)
  const refresher = createTokenRefresher(config, { fetchImpl, cachePath })
  // 与 buildConfig 完全一致：cgiCall 会先 absorb 响应头，再回到 execute 比对 exp。
  config.absorbServerToken = (jwt) => refresher.absorb(jwt)

  const outcome = await refresher.ensureFresh({ force: true, reason: 'auth-error' })
  assert.equal(calls.length, 1)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.refreshed, true)
  assert.equal(config.credential.token, newToken)
  assert.equal(readCachedToken(cachePath).accessToken, newToken)
  assert.equal(refresher.state().last.ok, true)
}

console.log('12. 本地重读不得把刚续好的 token 换回更旧的')
{
  const dir = mkdtempSync(join(workDir, 'downgrade-'))
  const storePath = join(dir, 'data.bin')
  const cookiesPath = join(dir, '.cookies')
  const older = expiringJwt(-60)
  const newer = expiringJwt(7200)
  writeFileSync(storePath, JSON.stringify({ oauth_access_token: older, userId: '864829721248' }))
  writeFileSync(cookiesPath, JSON.stringify([{
    raw_cookie: `ot_session=${older}; Path=/; Domain=.orcaterm.com`,
    domain: { Suffix: '.orcaterm.com' },
  }]))

  const cfg = buildConfig({
    credential: baseCredential(newer),
    storePath,
    cookiesPath,
    tokenCache: join(dir, 'cache.json'),
    tokenRefresh: 'off',
  })
  cfg.refreshCredential()
  assert.equal(cfg.credential.token, newer, '桌面端旧值不能覆盖手里更鲜活的 token')
  assert.equal(cfg.credential.jar.find((c) => c.name === 'ot_session').value, newer)
  assert.equal(cfg.credential.uin, '864829721248', '其它字段仍按最新读取更新')

  // 反向：桌面端确实更新了 → 必须切过去
  const newer2 = expiringJwt(9000)
  writeFileSync(storePath, JSON.stringify({ oauth_access_token: newer2, userId: '864829721248' }))
  cfg.credential = baseCredential(expiringJwt(-120))
  cfg.refreshCredential()
  assert.equal(cfg.credential.token, newer2)
}

rmSync(workDir, { recursive: true, force: true })
console.log('\n✅ token_refresh: 全部通过（12 组）')