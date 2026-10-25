/**
 * 路径解析：反代入口是本插件自带的 `backend/run.js`，不是外部仓库，
 * 所以这里只解决两件事——`~` 展开，以及「换机器/改布局时后端入口在哪」。
 *
 * 解析顺序：配置 backendDir → 环境变量 DSH_ORCATTERM2API_DIR → 插件同级 backend/。
 *
 * @module lib/paths.js
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（本文件在 lib/ 下）。 */
export function pluginDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 展开开头的 `~`（Windows 下也认 %USERPROFILE%）。 */
export function expandHome(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(1).replace(/^[\\/]/, ''))
  }
  return value
}

/**
 * 找后端入口文件（backend/run.js）。
 * @param {{backendDir?: string}} [opts]
 * @returns {{entry:string, source:string, tried:string[]}}
 */
export function resolveBackendEntry(opts = {}) {
  const tried = []
  const candidates = []
  const explicit = expandHome(opts.backendDir || '')
  if (explicit !== '') candidates.push([join(explicit, 'run.js'), 'config.backendDir'])
  const fromEnv = expandHome(process.env.DSH_ORCATTERM2API_DIR || '')
  if (fromEnv !== '') candidates.push([join(fromEnv, 'run.js'), 'env DSH_ORCATTERM2API_DIR'])
  const local = join(pluginDir(), 'backend', 'run.js')
  candidates.push([local, 'plugin backend/'])

  for (const [file, source] of candidates) {
    tried.push(file)
    if (existsSync(file)) return { entry: file, source, tried }
  }
  return { entry: '', source: 'not-found', tried }
}
