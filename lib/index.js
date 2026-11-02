/**
 * dsh-voice-in host 入口。
 *
 * 两件事：
 * 1. 用**独立 node.exe** 起本地语音服务（ASR + TTS）——不能用 process.execPath，
 *    那是 Electron，跑原生 addon 会报 `External buffers are not allowed`。
 * 2. 在 DSH 自己的 webServer 上注册**同源路由** `/dsh-voice-in/asr` 和 `/tts` 做转发。
 *    浏览器从 `dsh-app://app` 直连 `127.0.0.1:7788` 会被 CORS / Private Network Access 拦掉
 *    （请求能到、响应被丢，报 net::ERR_FAILED），走同源就没这问题。
 */
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/** 宿主必须提供 webServer，否则 ctx.webServer 是 undefined，路由注册会静默失败 */
export const inject = ['webServer']
export const name = 'voice-in'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const servicePath = path.join(__dirname, '..', 'service', 'voice-service.cjs')

/** 找一个「真正的 node.exe」，不是 Electron 套壳的那个 */
function findStandaloneNode() {
  if (process.env.DSH_VOICE_NODE && fs.existsSync(process.env.DSH_VOICE_NODE)) {
    return process.env.DSH_VOICE_NODE
  }
  const candidates = []
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (fs.existsSync(p)) candidates.push(p)
  }
  const runtimeNode = path.join(
    os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  if (fs.existsSync(runtimeNode)) candidates.push(runtimeNode)
  return candidates.find((p) => !/DeepSeek Harness\.exe$/i.test(p)) || null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** @param ctx cordis 上下文 */
export function apply(ctx, config = {}) {
  let child = null
  const port = config.port ?? 7788
  const base = `http://127.0.0.1:${port}`

  const startService = () => {
    if (child) return
    const nodeBin = findStandaloneNode()
    if (!nodeBin) {
      ctx.logger?.error?.('[voice-in] 找不到独立的 node.exe，语音服务没起来（可设 DSH_VOICE_NODE）')
      return
    }
    ctx.logger?.info?.(`[voice-in] 用 ${nodeBin} 启动语音服务`)
    child = spawn(nodeBin, [servicePath], {
      env: { ...process.env, VOICE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d) => ctx.logger?.info?.(`[voice-in] ${d.toString().trim()}`))
    child.stderr?.on('data', (d) => ctx.logger?.warn?.(`[voice-in] ${d.toString().trim().slice(0, 200)}`))
    child.on('exit', (code) => {
      ctx.logger?.warn?.(`[voice-in] 语音服务退出 code=${code}`)
      child = null
    })
  }

  startService()

  /** 注册一条同源路由 */
  const route = (p, fn) =>
    ctx.effect?.(() =>
      ctx.webServer?.register({
        kind: 'exact',
        path: p,
        handler: async (req, res) => {
          try {
            await fn(req, res)
          } catch (e) {
            try {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
            } catch {}
          }
        },
      }),
    )

  route('/dsh-voice-in/health', async (req, res) => {
    let up = false
    try {
      const r = await fetch(`${base}/health`)
      up = r.ok
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, service: up }))
  })

  route('/dsh-voice-in/asr', async (req, res) => {
    const body = await readBody(req)
    if (!body.length) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, error: '空音频' }))
    }
    const r = await fetch(`${base}/asr`, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || 'audio/wav' },
      body,
    })
    const text = await r.text()
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  })

  route('/dsh-voice-in/tts', async (req, res) => {
    const body = await readBody(req)
    const r = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const ab = Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') || 'audio/wav',
      'content-length': ab.length,
    })
    res.end(ab)
  })

  ctx.on?.('dispose', () => {
    if (child) {
      try {
        child.kill()
      } catch {}
      child = null
    }
  })
}
