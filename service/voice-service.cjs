/**
 * dsh-voice-in 本地语音服务：ASR（SenseVoice）+ TTS（F5-TTS）
 *
 * 所有路径都从配置读，优先级：
 *   环境变量 > ~/.dsh/voice-in-config.json > 插件目录下的 config.json > 默认值
 *
 * 配置见 README。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const HOME = os.homedir()
const HOME_DSH = path.join(HOME, '.dsh')
const F5_SCRIPT = path.join(__dirname, 'f5_server.py')
const TMP = path.join(__dirname, 'tmp')
fs.mkdirSync(TMP, { recursive: true })

// ---------- 配置 ----------
function expand(p) {
  if (!p) return p
  return p
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/%([^%]+)%/g, (_, k) => process.env[k] || '')
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, k) => process.env[k] || '')
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

const userCfg = readJsonSafe(path.join(HOME_DSH, 'voice-in-config.json'))
const localCfg = readJsonSafe(path.join(__dirname, '..', 'config.json'))
const cfg = { ...localCfg, ...userCfg }

const env = process.env

/** sherpa-onnx-node 的加载路径：优先配置，其次正常 require */
function resolveSherpa() {
  const configured = expand(env.VOICE_SHERPA_PATH || cfg.sherpaPath)
  if (configured && fs.existsSync(configured)) return configured
  // 正常装法：作为本包的依赖
  try {
    return require.resolve('sherpa-onnx-node')
  } catch {}
  // 兜底：借用其他插件自带的
  const fallback = path.join(HOME_DSH, 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'node_modules', 'sherpa-onnx-node')
  if (fs.existsSync(fallback)) return fallback
  return null
}

const SHERPA = resolveSherpa()
const ASR_ROOT = expand(env.VOICE_ASR_MODELS || cfg.asrModelsRoot) ||
  path.join(HOME_DSH, 'speech-to-text', 'sensevoice', 'models')
const PY = expand(env.VOICE_TTS_PYTHON || cfg.ttsPython) || 'python'
const FFMPEG = expand(env.VOICE_FFMPEG || cfg.ffmpeg) ||
  (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/** TTS 音色配置：可以给多个，客户端用 key 选 */
const TTS_VOICES = (() => {
  const fromCfg = cfg.ttsVoices || cfg['tts_voices']
  if (fromCfg && typeof fromCfg === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(fromCfg)) {
      if (!v || !v.ckpt) continue
      out[k] = {
        ckpt: expand(v.ckpt),
        ref: expand(v.ref),
        refText: v.refText || '',
        speed: v.speed || cfg.ttsSpeed || 0.85,
        label: v.label || k,
      }
    }
    return out
  }
  // 兼容老的单音色配置
  const ckpt = expand(env.VOICE_TTS_CKPT || cfg.ttsCkpt)
  const ref = expand(env.VOICE_TTS_REF || cfg.ttsRef)
  if (ckpt && ref) {
    return { default: { ckpt, ref, refText: cfg.ttsRefText || '', speed: cfg.ttsSpeed || 0.85, label: 'default' } }
  }
  return {}
})()

const DEFAULT_VOICE = cfg.ttsDefaultVoice || Object.keys(TTS_VOICES)[0] || null

/** 自检：缺什么列什么，别到用的时候才炸 */
function selfCheck() {
  const missing = []
  if (!SHERPA) missing.push({ what: 'sherpa-onnx-node', how: '在插件目录跑 pnpm add sherpa-onnx-node' })
  else if (!fs.existsSync(SHERPA)) missing.push({ what: 'sherpa-onnx-node', how: '配置里的 sherpaPath 不存在' })

  const senseModel = path.join(ASR_ROOT, 'sensevoice-onnx', 'model.int8.onnx')
  const tokens = path.join(ASR_ROOT, 'sensevoice-onnx', 'tokens.txt')
  if (!fs.existsSync(senseModel)) missing.push({ what: 'ASR 模型 model.int8.onnx', how: `放到 ${ASR_ROOT}\\sensevoice-onnx\\` })
  if (!fs.existsSync(tokens)) missing.push({ what: 'ASR tokens.txt', how: `放到 ${ASR_ROOT}\\sensevoice-onnx\\` })

  if (!whichFfmpeg()) missing.push({ what: 'ffmpeg', how: '装到 PATH，或在配置里写 ffmpeg 的绝对路径' })
  if (!DEFAULT_VOICE) missing.push({ what: 'TTS 音色', how: '在配置的 ttsVoices 里配一个 ckpt + ref' })
  else {
    const v = TTS_VOICES[DEFAULT_VOICE]
    if (!fs.existsSync(v.ckpt)) missing.push({ what: `音色 ${DEFAULT_VOICE} 的 ckpt`, how: v.ckpt })
    if (v.ref && !fs.existsSync(v.ref)) missing.push({ what: `音色 ${DEFAULT_VOICE} 的参考音频`, how: v.ref })
  }
  return missing
}

function whichFfmpeg() {
  if (path.isAbsolute(FFMPEG)) return fs.existsSync(FFMPEG) ? FFMPEG : null
  const dirs = (process.env.PATH || '').split(path.delimiter)
  const names = process.platform === 'win32' ? [FFMPEG, 'ffmpeg.exe'] : [FFMPEG]
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// ---------- ASR ----------
let recognizer = null
function getRecognizer() {
  if (recognizer) return recognizer
  if (!SHERPA) throw new Error('找不到 sherpa-onnx-node。在插件目录运行：pnpm add sherpa-onnx-node')
  const sherpa = require(SHERPA)
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(ASR_ROOT, 'sensevoice-onnx', 'model.int8.onnx'),
        language: 'zh',
        useInverseTextNormalization: 1,
      },
      tokens: path.join(ASR_ROOT, 'sensevoice-onnx', 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  })
  return recognizer
}

// ---------- ffmpeg 转 16k 单声道 ----------
function toWav16k(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const exe = whichFfmpeg() || FFMPEG
    const p = spawn(exe, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath])
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) => reject(new Error(`调不起 ffmpeg（${exe}）：${e.message}`)))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 失败: ' + err.slice(-300)))))
  })
}

function transcribeWav(wavPath) {
  const sherpa = require(SHERPA)
  const rec = getRecognizer()
  const wave = sherpa.readWave(wavPath)
  const stream = rec.createStream()
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
  rec.decode(stream)
  return rec.getResult(stream).text || ''
}

// ---------- TTS ----------
const f5 = { proc: null, ready: false, seq: 0, pending: new Map() }

function startF5() {
  if (f5.proc || !DEFAULT_VOICE) return
  const v = TTS_VOICES[DEFAULT_VOICE]
  if (!v) return
  if (!fs.existsSync(v.ckpt)) {
    console.error(`[f5] 音色 ckpt 不存在：${v.ckpt}`)
    return
  }
  const proc = spawn(PY, [F5_SCRIPT], {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      VOICE_TTS_CKPT: v.ckpt,
      VOICE_TTS_REF: v.ref || '',
      VOICE_TTS_REF_TEXT: v.refText || '',
      VOICE_TTS_SPEED: String(v.speed || 0.85),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  f5.proc = proc
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.ready) {
        f5.ready = true
        console.log('[f5] ready')
        continue
      }
      const job = f5.pending.get(msg.id)
      if (job) {
        f5.pending.delete(msg.id)
        msg.ok ? job.resolve(msg.out) : job.reject(new Error(msg.error || 'TTS 失败'))
      }
    }
  })
  proc.stderr.on('data', (d) => console.error('[f5-err]', d.toString().slice(0, 300)))
  proc.on('exit', (code) => {
    console.warn('[f5] 退出 code=', code)
    f5.proc = null
    f5.ready = false
  })
}

function synth(text, outPath, speed) {
  return new Promise((resolve, reject) => {
    if (!f5.proc) startF5()
    if (!f5.proc) return reject(new Error('TTS 没启动（缺音色配置）'))
    const id = ++f5.seq
    f5.pending.set(id, { resolve, reject })
    f5.proc.stdin.write(JSON.stringify({ id, text, out: outPath, speed: speed || 0.85 }) + '\n')
  })
}

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      sherpa: !!SHERPA,
      tts: f5.ready,
      voice: DEFAULT_VOICE,
      voices: Object.keys(TTS_VOICES),
      missing: selfCheck(),
    })
  }

  if (url.pathname === '/asr' && req.method === 'POST') {
    const buf = await readBody(req)
    if (!buf.length) return send(res, 400, { ok: false, error: '空音频' })
    const stamp = Date.now()
    const rawIn = path.join(TMP, `in-${stamp}.bin`)
    const wavIn = path.join(TMP, `in-${stamp}.wav`)
    fs.writeFileSync(rawIn, buf)
    try {
      const t0 = Date.now()
      await toWav16k(rawIn, wavIn)
      const text = transcribeWav(wavIn)
      send(res, 200, { ok: true, text, ms: Date.now() - t0 })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e.message || e) })
    } finally {
      try {
        fs.unlinkSync(rawIn)
      } catch {}
      try {
        fs.unlinkSync(wavIn)
      } catch {}
    }
    return
  }

  if (url.pathname === '/tts' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const text = String(body.text || '').trim()
      if (!text) return send(res, 400, { ok: false, error: 'text 为空' })
      const out = path.join(TMP, `out-${Date.now()}.wav`)
      await synth(text, out, body.speed)
      const buf = fs.readFileSync(out)
      try {
        fs.unlinkSync(out)
      } catch {}
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'access-control-allow-origin': '*' })
      res.end(buf)
    } catch (e) {
      send(res, 500, { ok: false, error: String(e.message || e) })
    }
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
})

const PORT = Number(process.env.VOICE_PORT || cfg.port) || 7788
server.listen(PORT, '127.0.0.1', () => {
  console.log(`voice service on http://127.0.0.1:${PORT}`)
  const miss = selfCheck()
  if (miss.length) {
    console.log('⚠ 缺依赖：')
    for (const m of miss) console.log(`  - ${m.what} → ${m.how}`)
  } else {
    console.log('依赖齐全，预热 ASR + TTS…')
    try {
      getRecognizer()
      console.log('ASR ready')
    } catch (e) {
      console.error('ASR 预热失败:', e.message)
    }
    startF5()
  }
})
