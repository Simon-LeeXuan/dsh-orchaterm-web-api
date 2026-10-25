#!/usr/bin/env node
/**
 * 反代进程入口。由插件的 lib/server.js 自动拉起，也可以手动跑：
 *
 *   node backend/run.js --port 8791
 *
 * 环境变量：ORCA_CGI_BASE / ORCA_ASSISTANT_BASE / ORCA_ACCESS_TOKEN / ORCA_UIN / ORCA_SKEY
 *           ORCA_COOKIES / ORCA_ASSISTANT_COOKIES / DSH_ORCA_CREDENTIALS
 *           ORCA_SEND_HISTORY=1（把 DSH 多轮历史发给上游；默认不发，见 --send-history）
 */

import { startServer } from './server.js'

function argv(flags) {
  const out = {}
  const list = process.argv.slice(2)
  for (let i = 0; i < list.length; i += 1) {
    const key = list[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    if (flags.includes(name)) {
      out[name] = list[i + 1]
      i += 1
    } else {
      out[name] = true
    }
  }
  return out
}

const options = argv(['port', 'host', 'cgi-base', 'assistant-base', 'assistant', 'mode', 'model', 'credentials', 'token', 'uin', 'skey', 'assistant-cookies', 'client-identity'])

const config = {
  port: options.port ? Number(options.port) : undefined,
  host: options.host,
  cgiBase: options['cgi-base'],
  assistantBase: options['assistant-base'],
  assistant: options.assistant,
  mode: options.mode ? Number(options.mode) : undefined,
  model: options.model,
  credentialsFile: options.credentials,
  token: options.token,
  uin: options.uin,
  skey: options.skey,
  assistantCookies: options['assistant-cookies'],
  sendHistoryMessages: options['send-history'] === true,
  // 'desktop'（默认）或 'web'：以哪个客户端的身份访问上游。
  clientIdentity: options['client-identity'],
}

const handle = await startServer(config)
process.stdout.write(`orchaterm2api listening on http://${config.host || '127.0.0.1'}:${handle.port}\n`)

let closing = false
const shutdown = async (signal) => {
  if (closing) return
  closing = true
  process.stdout.write(`orchaterm2api 收到 ${signal}，关闭中\n`)
  try {
    await handle.close()
  } catch {
    // close 自身失败也要退出，否则父进程等不到 stdio 关闭
  }
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
// Windows：父进程被强杀时管道断裂，这里让 EPIPE 变成体面退出而不是崩溃码。
process.stdout.on('error', () => process.exit(0))
