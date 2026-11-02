/**
 * 语音服务原型：ASR（SenseVoice）+ TTS（F5-TTS 第 8 轮音色）
 * 先用独立 HTTP 服务验证接口，通了再包成 DSH 插件
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const HOME = os.homedir()
const SHERPA = path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'node_modules', 'sherpa-onnx-node')
const ASR_ROOT = path.join(HOME, '.dsh', 'speech-to-text', 'sensevoice', 'models')
const PY = 'D:\\实用软件\\tts-venv\\Scripts\\python.exe'
const F5_SCRIPT = path.join(__dirname, 'f5_server.py')
const FFMPEG = path.join(HOME, '.dsh', 'bin', 'ffmpeg.exe')
const TMP = path.join(__dirname, 'tmp')

fs.mkdirSync(TMP, { recursive: true })

// ---------- ASR ----------
let recognizer = null
function getRecognizer() {
  if (recognizer) return recognizer
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

function transcribeWav(wavPath) {
  const sherpa = require(SHERPA)
  const rec = getRecognizer()
  const wave = sherpa.readWave(wavPath)
  const stream = rec.createStream()
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
  rec.decode(stream)
  return rec.getResult(stream).text
}

/** 把任意音频转成 16k 单声道 wav */
function toWav16k(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-i', input, '-ar', '16000', '-ac', '1', output])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(err.slice(-300)))))
  })
}

// ---------- TTS（F5 常驻 Python 进程） ----------
const f5Job = { proc: null, ready: false, queue: [], waiting: new Map(), seq: 0 }

function startF5() {
  if (f5Job.proc) return
  const proc = spawn(PY, [F5_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
  f5Job.proc = proc
  let buf = ''
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ready) { f5Job.ready = true; console.log('[f5] ready'); continue }
      const cb = f5Job.waiting.get(msg.id)
      if (cb) { f5Job.waiting.delete(msg.id); cb(msg) }
    }
  })
  proc.stderr.on('data', (d) => process.stderr.write('[f5-err] ' + d.toString().slice(0, 300)))
  proc.on('exit', (code) => { f5Job.proc = null; f5Job.ready = false; console.log('[f5] exit', code) })
}

function synth(text, outPath, speed = 0.9) {
  return new Promise((resolve, reject) => {
    startF5()
    const id = ++f5Job.seq
    const timer = setTimeout(() => { f5Job.waiting.delete(id); reject(new Error('TTS 超时')) }, 60000)
    f5Job.waiting.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.ok) resolve(msg.out)
      else reject(new Error(msg.error || 'TTS 失败'))
    })
    f5Job.proc.stdin.write(JSON.stringify({ id, text, out: outPath }) + '\n')
  })
}

// ---------- HTTP ----------
function logLine(...args) {
  try { fs.appendFileSync(path.join(__dirname, 'svc-access.log'), new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n') } catch {}
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST,GET,OPTIONS',
      'access-control-allow-private-network': 'true',
    })
    return res.end()
  }

  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/health') {
    return send(200, { ok: true, asr: !!recognizer, tts: f5Job.ready })
  }

  // POST /asr  音频二进制（webm/wav 都行）→ { text }
  if (url.pathname === '/asr' && req.method === 'POST') {
    logLine('[asr] 收到请求', req.headers['content-type'], req.headers['content-length'])
    const chunks = []
    for await (const c of req) chunks.push(c)
    const buf = Buffer.concat(chunks)
    logLine('[asr] 读完 body', buf.length)
    if (!buf.length) return send(400, { ok: false, error: '空音频' })
    const stamp = Date.now()
    const rawIn = path.join(TMP, `in-${stamp}.webm`)
    const wavIn = path.join(TMP, `in-${stamp}.wav`)
    fs.writeFileSync(rawIn, buf)
    try {
      logLine('[asr] ffmpeg 转换开始')
      await toWav16k(rawIn, wavIn)
      logLine('[asr] ffmpeg 转换完成')
      const t0 = Date.now()
      logLine('[asr] 开始识别')
      const text = transcribeWav(wavIn)
      logLine('[asr] 识别完成:', text)
      send(200, { ok: true, text, ms: Date.now() - t0 })
    } catch (e) {
      send(500, { ok: false, error: String(e.message || e) })
    } finally {
      fs.rmSync(rawIn, { force: true })
      fs.rmSync(wavIn, { force: true })
    }
    return
  }

  // POST /tts  { text } → wav 二进制
  if (url.pathname === '/tts' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
    const text = (body.text || '').trim()
    if (!text) return send(400, { ok: false, error: '空文本' })
    const out = path.join(TMP, `tts-${Date.now()}.wav`)
    try {
      const t0 = Date.now()
      await synth(text, out, body.speed || 0.9)
      const data = fs.readFileSync(out)
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': data.length,
        'access-control-allow-origin': '*',
        'access-control-allow-private-network': 'true',
        'x-elapsed-ms': String(Date.now() - t0),
      })
      res.end(data)
    } catch (e) {
      send(500, { ok: false, error: String(e.message || e) })
    } finally {
      fs.rmSync(out, { force: true })
    }
    return
  }

  send(404, { ok: false, error: 'not found' })
})

const PORT = 7788
server.listen(PORT, '127.0.0.1', () => {
  console.log(`voice service on http://127.0.0.1:${PORT}`)
  getRecognizer()   // 预热 ASR
  startF5()         // 预热 F5
  console.log('ASR + TTS 预热中…')
})
