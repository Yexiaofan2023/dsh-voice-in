/**
 * dsh-voice-in 客户端：往输入框左边的插槽里塞一个麦克风按钮。
 * 按住说话 → 录音 → 静音 0.7 秒自动断句 → 发给本地 voice-service → 文字填进输入框。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-in',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const SERVICE = '/dsh-voice-in'   // 同源路由，由 host 转发到本地语音服务（直连 7788 会被 CORS/PNA 拦）
    const SPEAK_SPEED = 0.85     // 播报语速（F5-TTS 的 speed 参数，0.85 = 慢 15%）
    const SILENCE_MS = 1300        // 静音多久算说完
    const SILENCE_RMS = 0.010     // 音量阈值
    const POLL_MS = 80

    /** 把 MediaRecorder 的 blob 解成 16k 单声道 WAV。
     *  MediaRecorder 产出的 webm 常常缺 EBML 头或 Duration，ffmpeg 解析会失败——所以先自己解码。 */
    async function blobToWav16k(blob) {
      const ab = await blob.arrayBuffer()
      const tmpCtx = new AudioContext()
      const decoded = await tmpCtx.decodeAudioData(ab)
      try { await tmpCtx.close() } catch {}

      const targetSr = 16000
      const frames = Math.max(1, Math.ceil(decoded.duration * targetSr))
      const off = new OfflineAudioContext(1, frames, targetSr)
      const src = off.createBufferSource()
      src.buffer = decoded
      src.connect(off.destination)
      src.start()
      const rendered = await off.startRendering()
      const pcm = rendered.getChannelData(0)

      const buf = new ArrayBuffer(44 + pcm.length * 2)
      const view = new DataView(buf)
      const writeStr = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)) }
      writeStr(0, 'RIFF')
      view.setUint32(4, 36 + pcm.length * 2, true)
      writeStr(8, 'WAVE')
      writeStr(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, targetSr, true)
      view.setUint32(28, targetSr * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeStr(36, 'data')
      view.setUint32(40, pcm.length * 2, true)
      let at = 44
      for (let i = 0; i < pcm.length; i++, at += 2) {
        const s = Math.max(-1, Math.min(1, pcm[i]))
        view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      }
      return new Blob([buf], { type: 'audio/wav' })
    }

    /** 把文字塞进 DSH 的输入框（受控组件要用原生 setter 再派发 input） */
    function fillInput(text) {
      const visible = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        if (r.width < 40 || r.height < 8) return false
        const st = window.getComputedStyle(el)
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05
      }
      const editable = (el) =>
        el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)

      // 1) 当前焦点就在可编辑元素上 → 最准
      let el = editable(document.activeElement) && visible(document.activeElement) ? document.activeElement : null
      let how = el ? 'activeElement' : ''

      // 2) 否则找「屏幕上最靠下的那个可见编辑器」——聊天输入框一定在最底下
      if (!el) {
        const pool = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
          .filter((x) => editable(x) && visible(x))
          .map((x) => ({ x, r: x.getBoundingClientRect() }))
          .sort((a, b) => b.r.bottom - a.r.bottom)
        if (pool.length) {
          el = pool[0].x
          how = '最下方可见编辑器'
          console.log('[voice-in] 候选编辑器（按底边从上到下）:', pool.map(({ x, r }) => `${x.tagName}@${Math.round(r.top)}-${Math.round(r.bottom)}${x.placeholder ? ' ph=' + String(x.placeholder).slice(0, 12) : ''}`))
        }
      }

      if (!el) {
        const all = [...document.querySelectorAll('textarea, input, [contenteditable]')]
        console.warn('[voice-in] 没找到可见编辑器。页面候选:', all.map((x) => {
          const r = x.getBoundingClientRect()
          return `${x.tagName}@${Math.round(r.top)}-${Math.round(r.bottom)}`
        }))
        return false
      }
      console.log('[voice-in] 输入框来自:', how, el.tagName, String(el.className || '').slice(0, 40))

      el.focus()

      // 先清空：语音输入是「说一句 = 这句话」，不清会一直往后堆
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        // 受控组件：用原型 setter 直接赋最终值，再派发 InputEvent。
        // 别用 execCommand —— 它会和 React 的受控同步打架，导致同一句被写两遍。
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, text)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        console.log('[voice-in] 填入', el.tagName, '现值:', (el.value || '').slice(-40))
        return true
      }

      // contenteditable：先全选清空
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      if (sel) { sel.removeAllRanges(); sel.addRange(range) }
      try { document.execCommand('delete') } catch {}
      const range2 = document.createRange()
      range2.selectNodeContents(el)
      range2.collapse(false)
      if (sel) { sel.removeAllRanges(); sel.addRange(range2) }

      let ok = false
      try { ok = document.execCommand('insertText', false, text) } catch {}
      // ⚠ execCommand 自己已经派发过 beforeinput/input 了，这里绝不能再 dispatch 一次，
      //   否则编辑器会把同一句插两遍（就是「还是一样的。还是一样的。」那个现象）。
      if (!ok) {
        el.textContent = text
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      }
      // 值要等编辑器渲染完才读得到，延后一拍再量
      setTimeout(() => {
        const now = (el.innerText || el.textContent || '').trim()
        console.log('[voice-in] contenteditable 填入结果，execCommand=', ok, '长度', now.length, '|', now.slice(-30))
      }, 250)
      return true
    }

    function StatusDot({ state }) {
      const color =
        state === 'rec' ? '#ff5f56' : state === 'wait' ? '#ffbd2e' : state === 'ok' ? '#27c93f' : 'rgba(140,170,205,0.5)'
      return h('span', {
        style: { width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' },
      })
    }

    function MicButton() {
      const [state, setState] = React.useState('idle')
      const [hint, setHint] = React.useState('')
      const [link, setLink] = React.useState('checking')   // checking | ok | down
      const ref = React.useRef({ recorder: null, chunks: [], ctx: null, raf: 0, silenceSince: 0 })

      // 挂载时探一次同源路由，之后每 15 秒复查；状态直接显示在按钮上，不用点也知道通不通
      React.useEffect(() => {
        let alive = true
        const ping = async () => {
          try {
            const r = await fetch(SERVICE + '/health', { cache: 'no-store' })
            const j = await r.json()
            if (alive) setLink(j && j.service ? 'ok' : 'down')
            console.log('[voice-in] health', r.status, j)
          } catch (e) {
            if (alive) setLink('down')
            console.warn('[voice-in] health 失败', e && e.message)
          }
        }
        ping()
        const id = setInterval(ping, 15000)
        return () => { alive = false; clearInterval(id) }
      }, [])

      const stop = React.useCallback(async () => {
        const r = ref.current
        console.log('[voice-in] stop() 进入, 有录音器=', !!r.recorder)
        // ⚠ 必须「同步」先把 recorder 摘下来再做异步清理。
        // 之前是先 await r.ctx.close()，挂起期间第二次 stop() 进来会看到 recorder 还在，
        // 于是两条链路各识别一次、各填一次 —— 表现就是同一句话填了两遍。
        const rec = r.recorder
        r.recorder = null
        if (!rec) { console.warn('[voice-in] stop 时没有录音器（重复调用，已忽略）'); return }
        if (r.raf) { cancelAnimationFrame(r.raf); r.raf = 0 }
        if (r.ctx) { try { await r.ctx.close() } catch {} ; r.ctx = null }
        setState('wait'); setHint('识别中…')
        const blob = await new Promise((resolve) => {
          rec.onstop = () => resolve(new Blob(r.chunks, { type: rec.mimeType || 'audio/webm' }))
          try { rec.stop() } catch (e) { console.error('[voice-in] rec.stop 失败', e); resolve(null) }
        })
        r.chunks = []
        console.log('[voice-in] 录音 blob=', blob && blob.size, blob && blob.type)
        if (!blob || !blob.size) { setState('idle'); setHint('没录到声音'); setTimeout(() => { setState('idle'); setHint('') }, 3000); return }
        try {
          // 先转成标准 WAV，避免 MediaRecorder 的 webm 让 ffmpeg 解析失败
          let wav
          try {
            wav = await blobToWav16k(blob)
            console.log('[voice-in] 转 WAV 完成, 大小=', wav.size)
          } catch (e) {
            console.error('[voice-in] 音频解码失败', e, 'blob=', blob.size, blob.type)
            setState('idle'); setHint('解码失败 ' + String(e.message || e).slice(0, 24))
            setTimeout(() => { setState('idle'); setHint('') }, 4000)
            return
          }
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 15000)
          const res = await fetch(SERVICE + '/asr', {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wav,
            signal: ctrl.signal,
          })
          clearTimeout(timer)
          // 500 的时候真实错误在 body 里，控制台只看得到状态码，所以先自己读出来
          if (!res.ok) {
            let detail = ''
            try { detail = (await res.json()).error || '' } catch { detail = await res.text().catch(() => '') }
            console.error('[voice-in] 服务返回', res.status, detail, 'blob=', blob.size, blob.type)
            setState('idle')
            setHint(`${res.status}: ${String(detail).slice(0, 40)}`)
            setTimeout(() => { setState('idle'); setHint('') }, 6000)
            return
          }
          const j = await res.json()
          if (j.ok && j.text) {
            if (fillInput(j.text)) { setState('ok'); setHint(j.text.slice(0, 12)) }
            else { setState('idle'); setHint('没找到输入框') }
          } else {
            setState('idle'); setHint(j.error ? String(j.error).slice(0, 28) : '没听清')
          }
        } catch (e) {
          const msg = String((e && e.message) || e)
          console.error('[voice-in] ASR 失败', e, 'blob=', blob.size)
          setState('idle')
          setHint(msg.includes('abort') ? '超时没响应' : 'ERR ' + msg.slice(0, 26))
        }
        setTimeout(() => { setState('idle'); setHint('') }, 4000)
      }, [])

      const start = React.useCallback(async () => {
        if (ref.current.recorder) return
        console.log('[voice-in] start() 进入',
          'mediaDevices=', !!navigator.mediaDevices,
          'getUserMedia=', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
          'MediaRecorder=', typeof MediaRecorder,
          'secureContext=', window.isSecureContext)
        try {
          setHint('要麦克风…')
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          console.log('[voice-in] getUserMedia OK, tracks=', stream.getAudioTracks().length)
          let rec
          try {
            rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
          } catch (e1) {
            console.warn('[voice-in] webm/opus 不支持，用默认格式', e1.message)
            rec = new MediaRecorder(stream)
          }
          console.log('[voice-in] MediaRecorder mimeType=', rec.mimeType)
          const r = ref.current
          r.recorder = rec
          r.chunks = []
          rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data) }
          rec.start(200)

          // 用 AudioContext 测音量，判断静音断句
          const ctx = new AudioContext()
          const src = ctx.createMediaStreamSource(stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 1024
          src.connect(analyser)
          r.ctx = ctx
          const buf = new Float32Array(analyser.fftSize)
          r.silenceSince = 0
          r.spoke = false        // 必须先检测到说话，才允许「静音断句」
          r.maxRms = 0
          const tick = () => {
            if (!ref.current.recorder) return
            analyser.getFloatTimeDomainData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
            const rms = Math.sqrt(sum / buf.length)
            if (rms > r.maxRms) r.maxRms = rms
            const now = performance.now()
            if (rms >= SILENCE_RMS) {
              r.spoke = true
              r.silenceSince = 0
            } else if (r.spoke) {
              if (!r.silenceSince) r.silenceSince = now
              else if (now - r.silenceSince > SILENCE_MS) {
                console.log('[voice-in] 静音断句触发 rms峰值=', r.maxRms.toFixed(4))
                stop()
                return
              }
            }
            r.raf = requestAnimationFrame(tick)
          }
          tick()
          setState('rec'); setHint('说话…')
          console.log('[voice-in] 开始录音，等待说话')
        } catch (e) {
          console.error('[voice-in] 麦克风失败:', e && e.name, e && e.message)
          setState('idle')
          setHint('麦克风: ' + String((e && (e.name || e.message)) || e).slice(0, 24))
          setTimeout(() => { setState('idle'); setHint('') }, 6000)
        }
      }, [stop])

      React.useEffect(() => () => { if (ref.current.recorder) { try { ref.current.recorder.stop() } catch {} } }, [])

      // ---------- 播报 ----------
      const [speak, setSpeak] = React.useState('idle')  // idle | loading | playing
      const [auto, setAuto] = React.useState(() => { try { return localStorage.getItem('voice-in-auto') === '1' } catch { return false } })
      const audioRef = React.useRef(null)
      const playTokenRef = React.useRef(0)   // 每次播报递增；新回答来了就让它失效，掐断旧的
      const lastSpokenRef = React.useRef('')

      /** 捞页面上最后一条回答：返回 { key, text }。
       *  key 用来判断「是不是同一条」，避免把旧回答当成新的反复念。*/
      const pickLastAnswer = React.useCallback(() => {
        // [data-slot="conversation.chat.node"] 能匹配几百个元素（各种 slot 节点都在里面），
        // 最后一个往往是底部状态栏（「用量 687K tok」这种）。所以要按「像不像回答」来筛。
        const pickers = [
          '[data-slot="conversation.chat.node"]',
          '[data-slot*="chat.node"]',
        ]
        const isStatusBarish = (t) =>
          /用量|tok\b|tokens?\b|^\d+(\.\d+)?%$|设置|复制|编辑|重新生成|展开|收起/.test(t) &&
          t.length < 60
        const looksLikeAnswer = (el, t) => {
          if (t.length < 12 || t.length > 1200) return false
          if (isStatusBarish(t)) return false
          // ⚠ 不能用 getBoundingClientRect 判断尺寸：DSH 的 [data-slot] 元素是 display:contents，
          //   自身没有盒子，宽高全返回 0。只看文本特征。
          return true
        }
        for (const p of pickers) {
          const list = [...document.querySelectorAll(p)]
          if (!list.length) continue
          for (let i = list.length - 1; i >= 0; i--) {
            const el = list[i]
            const t = (el.innerText || el.textContent || '').trim()
            if (!looksLikeAnswer(el, t)) continue
            return { key: `${p}#${i}#${t.length}`, text: t, from: p, index: i, total: list.length }
          }
        }
        const main = document.querySelector('main') || document.body
        const blocks = [...main.querySelectorAll('p, div')].map((x) => (x.innerText || '').trim()).filter((s) => s.length > 20 && s.length < 1200)
        const text = blocks[blocks.length - 1] || ''
        console.log('[voice-in] pick 没命中，走兜底。匹配数:', pickers.map((p) => `${p}=${document.querySelectorAll(p).length}`).join(' '))
        // 一次看清页面到底有哪些 data-slot、每个里面有多少字
        if (!window.__voiceInSlotsDumped) {
          window.__voiceInSlotsDumped = true
          const rows = [...document.querySelectorAll('[data-slot]')].map((el) => {
            const name = el.getAttribute('data-slot')
            const len = (el.innerText || '').trim().length
            return { name, len }
          })
          const merged = new Map()
          for (const r of rows) {
            const prev = merged.get(r.name) || { count: 0, max: 0 }
            merged.set(r.name, { count: prev.count + 1, max: Math.max(prev.max, r.len) })
          }
          const out = [...merged.entries()].map(([k, v]) => `${k} ×${v.count} (最长${v.max}字)`)
          console.log('[voice-in] ★ data-slot 全表（名字 ×数量 最长文本）:\n' + out.join('\n'))
        }
        return { key: 'fallback#' + text.length, text, from: 'fallback', index: -1, total: blocks.length }
      }, [])

      /** 立刻掐断当前播报（新回答来了要抢占） */
      const stopPlayback = React.useCallback(() => {
        playTokenRef.current++            // 令牌一变，正在跑的循环下一次检查就会退出
        try { audioRef.current?.pause() } catch {}
        audioRef.current = null
        setSpeak('idle'); setHint('')
      }, [])

      /** 把一段文本拆句后逐句合成播放；返回是否播完 */
      const speakText = React.useCallback(async (raw) => {
        const myToken = ++playTokenRef.current   // 本次播放的令牌
        const clean = raw.replace(/```[\s\S]*?```/g, '。').replace(/[#*`>|]/g, '').replace(/\s+/g, ' ').trim()
        // 按句切，但把过短的碎片并到前一句，减少「念一句、停一下」的碎裂感
        const parts = clean.split(/(?<=[。！？；\n])/).map((s) => s.trim()).filter(Boolean)
        const sentences = []
        for (const p of parts) {
          if (sentences.length && p.length < 8) sentences[sentences.length - 1] += p
          else sentences.push(p)
        }
        const list = sentences.slice(0, 12)
        if (!list.length) return
        console.log('[voice-in] 播报', list.length, '句')
        setSpeak('loading'); setHint('合成中…')

        /** 合成一句，返回 objectURL */
        const synthOne = async (s) => {
          const r = await fetch(SERVICE + '/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: s, speed: SPEAK_SPEED }),
          })
          if (!r.ok) throw new Error('TTS ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 80))
          return URL.createObjectURL(await r.blob())
        }

        try {
          // 提前合成下一句：播放第 N 句时，第 N+1 句已经在路上，句间空档只剩播放本身
          let nextPromise = synthOne(list[0])
          for (let i = 0; i < list.length; i++) {
            if (playTokenRef.current !== myToken) return   // 被打断了，别再往下播
            const url = await nextPromise
            if (playTokenRef.current !== myToken) { URL.revokeObjectURL(url); return }
            // 现在就去合成下一句
            nextPromise = i + 1 < list.length ? synthOne(list[i + 1]) : null

            // ⚠ 只用一个 Audio 实例：每次 new Audio 的话，pause 只能停住最后一个，
            //   之前那几路还在响 —— 就是「两句语音重叠」的原因。
            if (!audioRef.current) audioRef.current = new Audio()
            const audio = audioRef.current
            audio.src = url
            setSpeak('playing'); setHint('朗读中')
            try { await audio.play() } catch (e) { console.warn('[voice-in] play 被拒', e && e.message) }
            await new Promise((resolve) => {
              let done = false
              const fin = () => { if (done) return; done = true; URL.revokeObjectURL(url); resolve() }
              audio.onended = fin
              audio.onerror = fin
              audio.onpause = () => { if (audio.src === url || audio.src.endsWith(url)) return; fin() }
              // 兜底：被抢占时 onended 不会触发，用令牌轮询解开
              const t = setInterval(() => {
                if (playTokenRef.current !== myToken) { clearInterval(t); fin() }
              }, 200)
              setTimeout(() => clearInterval(t), 120000)
            })
            if (playTokenRef.current !== myToken) return
          }
        } catch (e) {
          console.error('[voice-in] 播报失败', e)
          setHint('播报失败')
        }
        if (playTokenRef.current === myToken) {
          setSpeak('idle'); setHint('')
        }
      }, [])

      /** 手动：点一下读最后一条（正在播就停） */
      const readLastAnswer = React.useCallback(() => {
        if (speak === 'playing' || speak === 'loading') {
          try { audioRef.current?.pause() } catch {}
          audioRef.current = null
          setSpeak('idle'); setHint('')
          return
        }
        const picked = pickLastAnswer()
        if (!picked.text) { setHint('没找到回答'); setTimeout(() => setHint(''), 2500); return }
        lastSpokenRef.current = picked.key
        speakText(picked.text)
      }, [speak, pickLastAnswer, speakText])

      /** 自动：开关打开时轮询最后一条回答，变了就读 */
      // speak 用 ref 存，别塞进 effect 依赖——否则每次状态变化都会重建 interval，
      // 日志里「自动播报已开启」会刷一串，还可能叠出多条轮询同时触发
      const speakStateRef = React.useRef(speak)
      React.useEffect(() => { speakStateRef.current = speak }, [speak])
      // 「这条回答说完了吗」的判定：文本连续 1.2 秒不再变，才认为流式输出结束
      const stableRef = React.useRef({ key: '', at: 0 })

      // 换了会话就把播报状态归零，别把新会话的旧消息当成新回答念一遍。
      // URL 和页面标题一起看——DSH 是单页应用，切会话不一定改 URL，但标题通常跟着变。
      const hrefRef = React.useRef(typeof location !== 'undefined' ? location.href : '')
      const titleRef = React.useRef(typeof document !== 'undefined' ? document.title : '')
      React.useEffect(() => {
        const id = setInterval(() => {
          if (typeof location === 'undefined' || typeof document === 'undefined') return
          const changedHref = location.href !== hrefRef.current
          const changedTitle = document.title !== titleRef.current
          if (!changedHref && !changedTitle) return
          hrefRef.current = location.href
          titleRef.current = document.title
          stopPlayback()
          lastSpokenRef.current = pickLastAnswer().key   // 记下当前这条，但不念
          stableRef.current = { key: '', at: 0 }
          console.log('[voice-in] 检测到会话切换（' + (changedHref ? 'URL' : '标题') + '变了），播报状态已重置 |', document.title)
        }, 800)
        return () => clearInterval(id)
      }, [pickLastAnswer, stopPlayback])

      React.useEffect(() => {
        try { localStorage.setItem('voice-in-auto', auto ? '1' : '0') } catch {}
        if (!auto) return
        console.log('[voice-in] 自动播报已开启')
        const id = setInterval(() => {
          const picked = pickLastAnswer()
          if (!picked.text || picked.text.length < 4) return
          // 同一条就跳过（key 由选择器+序号+长度组成，稳定不变）
          if (picked.key === lastSpokenRef.current) return

          // 新回答出现了，正在播旧的 → 立刻掐断，改念新的（不等旧的那条念完）
          if (speakStateRef.current !== 'idle') {
            console.log('[voice-in] 新回答来了，掐断当前播报')
            stopPlayback()
          }

          // 流式输出还没停：等文本稳定 1.2 秒再念，避免念半句
          const now = Date.now()
          if (stableRef.current.key !== picked.key) {
            stableRef.current = { key: picked.key, at: now }
            return
          }
          if (now - stableRef.current.at < 1200) return
          lastSpokenRef.current = picked.key
          stableRef.current = { key: '', at: 0 }
          console.log('[voice-in] 自动播报触发 from=', picked.from, 'index=', picked.index, '/', picked.total, '长度', picked.text.length, '|', picked.text.slice(0, 30))
          speakText(picked.text)
        }, 800)
        return () => clearInterval(id)
      }, [auto, stopPlayback, speakText])

      const active = state === 'rec'
      return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' } }, [
        h('button', {
          key: 'btn',
          type: 'button',
          'data-voice-in': 'v3',
          title: active ? '点一下结束' : '点一下开始说话（停顿自动断句）',
          onClick: (e) => {
            e.preventDefault()
            e.stopPropagation()
            console.log('[voice-in] 按钮被点击 state=', state)
            if (active) stop()
            else start()
          },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            height: 28, minWidth: 28, padding: '0 6px', borderRadius: 8,
            border: '1px solid rgba(120,160,200,0.35)',
            background: active ? 'rgba(255,95,86,0.22)' : 'rgba(120,160,200,0.08)',
            color: active ? '#ff8a80' : 'rgba(160,190,225,0.9)',
            cursor: 'pointer', fontSize: 12, lineHeight: 1,
          },
        }, [active ? '■' : '🎤', h('span', { key: 't', style: { fontSize: 11 } }, active ? '停' : '说')]),
        h('button', {
          key: 'speak',
          type: 'button',
          'data-voice-in': 'speak',
          title: speak === 'playing' ? '点一下停' : '读最后一条回答',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); readLastAnswer() },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            height: 28, padding: '0 6px', borderRadius: 8,
            border: '1px solid rgba(120,160,200,0.35)',
            background: speak === 'playing' ? 'rgba(39,201,63,0.20)' : 'rgba(120,160,200,0.08)',
            color: speak === 'playing' ? '#7ce38b' : 'rgba(160,190,225,0.9)',
            cursor: 'pointer', fontSize: 12, lineHeight: 1,
          },
        }, [speak === 'playing' ? '⏸' : '🔊', h('span', { key: 't', style: { fontSize: 11 } }, speak === 'loading' ? '…' : speak === 'playing' ? '停' : '读')]),
        h('button', {
          key: 'auto',
          type: 'button',
          'data-voice-in': 'auto',
          title: auto ? '自动播报开着：回答出来就念' : '自动播报关着：点开之后回答出来就念',
          onClick: (e) => {
            e.preventDefault(); e.stopPropagation()
            setAuto((v) => {
              const next = !v
              if (!next) {
                try { audioRef.current?.pause() } catch {}
                audioRef.current = null
                setSpeak('idle'); setHint('')
              } else {
                lastSpokenRef.current = pickLastAnswer().key   // 打开时把当前这条记下，别立刻念旧的
                stableRef.current = { key: '', at: 0 }
                setHint('自动播报已开')
                setTimeout(() => setHint(''), 2000)
              }
              return next
            })
          },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            height: 28, padding: '0 6px', borderRadius: 8,
            border: `1px solid ${auto ? 'rgba(39,201,63,0.5)' : 'rgba(120,160,200,0.35)'}`,
            background: auto ? 'rgba(39,201,63,0.16)' : 'rgba(120,160,200,0.08)',
            color: auto ? '#7ce38b' : 'rgba(160,190,225,0.9)',
            cursor: 'pointer', fontSize: 12, lineHeight: 1,
          },
        }, [auto ? '🔁' : '🔇', h('span', { key: 't', style: { fontSize: 11 } }, auto ? '自动' : '手动')]),
        h('span', {
          key: 'link',
          title: link === 'ok' ? '语音服务就绪' : link === 'down' ? '连不上语音服务' : '检查中',
          style: {
            width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
            background: link === 'ok' ? '#27c93f' : link === 'down' ? '#ff5f56' : '#ffbd2e',
          },
        }),
        hint ? h('span', {
          key: 'hint',
          style: { fontSize: 11, color: 'rgba(150,180,215,0.75)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, hint) : null,
        h(Panel, { key: 'panel', service: SERVICE, speakText, stopPlayback, fillInput }),
      ])
    }

    /** ⚙ 调试面板：状态、缺什么、音色、试听、配置位置 */
    function Panel({ service, speakText, stopPlayback, fillInput }) {
      const [open, setOpen] = React.useState(false)
      const [info, setInfo] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [testText, setTestText] = React.useState('这是测试语音，听听效果怎么样。')

      const load = React.useCallback(async () => {
        setErr('')
        try {
          const r = await fetch(service + '/health', { cache: 'no-store' })
          setInfo(await r.json())
        } catch (e) {
          setErr(String((e && e.message) || e))
          setInfo(null)
        }
      }, [service])

      React.useEffect(() => { if (open) load() }, [open, load])

      const tryTts = async () => {
        setBusy(true)
        try { await speakText(testText) } finally { setBusy(false) }
      }

      const btn = (label, onClick, extra) =>
        h('button', {
          type: 'button',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); onClick() },
          style: {
            padding: '3px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
            border: '1px solid rgba(120,160,200,0.35)', background: 'rgba(120,160,200,0.08)',
            color: 'rgba(160,190,225,0.9)', ...(extra || {}),
          },
        }, label)

      if (!open) {
        return h('button', {
          key: 'gear',
          type: 'button',
          title: '语音插件状态与调试',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, borderRadius: 6, cursor: 'pointer',
            border: '1px solid rgba(120,160,200,0.25)', background: 'transparent',
            color: 'rgba(150,180,215,0.7)', fontSize: 12, padding: 0,
          },
        }, '⚙')
      }

      const row = (k, v) => h('div', { key: k, style: { display: 'flex', gap: 8, lineHeight: 1.7 } }, [
        h('span', { key: 'k', style: { color: 'rgba(150,170,195,0.75)', minWidth: 62 } }, k),
        h('span', { key: 'v', style: { color: 'rgba(210,225,245,0.95)', wordBreak: 'break-all' } }, v),
      ])

      return h('div', {
        key: 'panel',
        style: {
          position: 'absolute', bottom: 34, left: 0, zIndex: 9999,
          width: 340, padding: 12, borderRadius: 10,
          background: 'rgba(24,30,42,0.98)', border: '1px solid rgba(120,160,200,0.28)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.45)', color: 'rgba(210,225,245,0.95)',
          fontSize: 12, lineHeight: 1.6,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } }, [
          h('strong', { key: 't', style: { fontSize: 13 } }, '语音插件'),
          h('span', { key: 'x', onClick: () => { stopPlayback(); setOpen(false) }, style: { cursor: 'pointer', opacity: 0.6 } }, '✕'),
        ]),
        err ? row('错误', err) : null,
        info ? [
          row('服务', info.sherpa && info.tts ? '✓ 就绪' : info.sherpa ? '识别就绪，播报未启动' : '✗ 未就绪'),
          row('音色', info.voice || '（未配置）'),
          row('可用音色', (info.voices || []).join(', ') || '（无）'),
          Array.isArray(info.missing) && info.missing.length
            ? h('div', { key: 'miss', style: { marginTop: 6, padding: 8, borderRadius: 6, background: 'rgba(255,150,80,0.12)', border: '1px solid rgba(255,150,80,0.3)' } }, [
              h('div', { key: 'h', style: { marginBottom: 4, color: '#ffb87a' } }, '⚠ 缺依赖'),
              ...info.missing.map((m, i) => h('div', { key: 'm' + i, style: { fontSize: 11, color: 'rgba(220,205,190,0.9)' } }, `· ${m.what} → ${m.how}`)),
            ])
            : row('依赖', Array.isArray(info.missing) ? '✓ 齐全' : '？（服务未返回状态）'),
        ] : row('服务', '检查中…'),
        h('div', { key: 'ops', style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } }, [
          btn('刷新状态', load),
          btn(busy ? '试听中…' : '试听音色', tryTts),
          btn('重置播报状态', () => { stopPlayback(); load() }),
        ]),
        h('div', { key: 'hintrow', style: { marginTop: 8, fontSize: 11, color: 'rgba(140,160,185,0.7)' } },
          '配置文件：~/.dsh/voice-in-config.json'),
      ])
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: 'voice-in-mic', order: 20 },
          MicButton,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
