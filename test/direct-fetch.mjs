/**
 * 直连 fetch：绕开本机的 NODE_USE_ENV_PROXY（v2rayN 的 http_proxy）。
 *
 * 宿主的 vitest setup 会删掉 NO_PROXY 等代理变量，而 Node 的内置 fetch 在进程启动时
 * 就已把代理配置绑死 —— 于是**对 127.0.0.1 的本地请求也被送进代理**，表现为
 * `TypeError: fetch failed`。这跟被测代码无关，是测试环境问题。
 *
 * 后端进程自己的上游调用（→ OrcaTerm 助手网关）不在本进程内，不受影响。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

/**
 * 一个不经过代理的 fetch 实现，形状与全局 fetch 兼容（只用到本测试需要的部分）。
 * @param {string} input 请求 URL
 * @param {object} [init] 请求选项
 * @returns {Promise<Response>}
 */
export function directFetch(input, init = {}) {
  const url = new URL(String(input))
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method || 'GET',
        headers: init.headers || {},
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve(new Response(body, {
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: res.headers,
          }))
        })
      },
    )
    req.on('error', reject)
    if (init.signal) {
      init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** 把全局 fetch 换成直连实现（返回还原函数）。 */
export function installDirectFetch() {
  const original = globalThis.fetch
  globalThis.fetch = directFetch
  return () => {
    globalThis.fetch = original
  }
}
