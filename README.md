# dsh-voice-in

在 DeepSeek Harness 的输入框左边加三个控件：**说一句变文字**、**点一下读回答**、**自动播报开关**。

配合你自己训练的 TTS 音色，可以让 DSH 真的「开口说话」。

---

## 能干什么

- **🎤 说** —— 点一下开始录，说完停顿 1.3 秒自动断句，识别出来的文字**替换**输入框内容（不是追加）
- **🔊 读** —— 读最后一条回答，按句合成、逐句播放，边播边合成下一句
- **🔇 手动 / 🔁 自动** —— 自动播报开关（存在 localStorage，刷新记得住）。开着时新回答会自动念，**新内容来了会掐断旧的**
- **状态小圆点** —— 绿＝语音服务就绪，红＝连不上，黄＝检查中

---

## 依赖

需要自备这几样（都不随包提供）：

| 东西 | 说明 |
|---|---|
| **ASR 模型** | SenseVoice（sherpa-onnx 格式），放到 `~/.dsh/speech-to-text/sensevoice/models/` |
| **TTS 引擎** | [F5-TTS](https://github.com/SWivid/F5-TTS)，装在任意 Python 环境里，需要有自己训练的 ckpt + 参考音频 |
| **sherpa-onnx-node** | `npm i sherpa-onnx-node`，或借用其他插件自带的 |
| **ffmpeg** | 任意版本，支持 opus/webm 解码即可 |
| **独立 node.exe** | ⚠ 不能用 Electron 自带的（见「已知的坑」第 1 条） |

### ASR 模型放哪儿

```
~/.dsh/speech-to-text/sensevoice/models/
├── sensevoice-onnx/
│   ├── model.int8.onnx
│   └── tokens.txt
└── silero/
    └── silero_vad.onnx
```

三个文件可从 [csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) 和 [csukuangfj/vad](https://huggingface.co/csukuangfj/vad) 下载。

> 国内建议走 `hf-mirror.com`，路径里把 `resolve/main/` 带上。

### TTS 配置

`service/f5_server.py` 顶部有三个常量要按自己的环境改：

```python
CKPT = r"...\ckpts\your-model.pt"     # 你训练的权重
REF  = r"...\ref-clean.wav"           # 参考音频（10 秒左右干净人声）
REF_TEXT = "这段参考音频对应的文字"      # 必须和音频内容一字不差
```

---

## 装法

```powershell
# 1. 拷到插件目录
Copy-Item . $env:USERPROFILE\.dsh\plugins\dsh-voice-in -Recurse

# 2. 备份 profile 包清单
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$prof\package.json" "$env:USERPROFILE\.dsh\profiles\profile-backup-voice" -Force

# 3. 链接进 profile
Set-Location $prof
pnpm add "link:$env:USERPROFILE\.dsh\plugins\dsh-voice-in"

# 4. 手写 bundles —— pnpm 只写 dependencies，还要在 package.json 的
#    dsh.profile.bundles 数组里加一项 "dsh-voice-in"

# 5. 重启 DSH
```

---

## 架构

```
浏览器 (client.js)
  ├─ ctx.slots 注入 conversation.input.left → 三个按钮
  ├─ MediaRecorder 录音 → RMS 静音检测断句（先判断「说过话」才允许断）
  ├─ 浏览器内解码成 16k 单声道 WAV（webm 直接喂 ffmpeg 会失败）
  └─ fetch /dsh-voice-in/asr
        ↓ 同源，不跨源
DSH host (lib/index.js)
  ├─ ctx.webServer.register 开路由：/dsh-voice-in/{asr,tts,health}
  ├─ 转发到本地 7788
  └─ 用独立 node.exe 拉起 service/voice-service.cjs
        ├─ sherpa-onnx SenseVoice 识别（约 54ms）
        └─ spawn Python 跑 service/f5_server.py（常驻进程，约 1.3s/句）
```

**关键**：host 必须 `export const inject = ['webServer']`，否则 `ctx.webServer` 是 undefined，路由注册会**静默失败**（浏览器侧表现为 405）。

---

## 已知的坑

这些都是实际踩过的，写下来省得重复：

1. **Electron 的 Node 跑不了 sherpa** —— `process.execPath` 指向宿主 exe，原生模块会报 `External buffers are not allowed`。必须找独立的 node.exe。
2. **MediaRecorder 的 webm 喂不进 ffmpeg** —— 缺 EBML 头或时长信息。先在浏览器里 `decodeAudioData` + `OfflineAudioContext` 转到 16k，再上传。
3. **静音检测要先判断「说过话」** —— 否则一开录音就被环境静音掐断。
4. **直连 127.0.0.1 会被浏览器拦** —— 页面在自定义协议下时，跨源访问本地地址会报 `net::ERR_FAILED`，但**服务端其实已经处理完了**。加 `Access-Control-Allow-Private-Network` 也救不了，必须走同源路由。
5. **漏写 `inject` 导致路由静默不注册** —— 表现为 405，很难查。
6. **`stop()` 里先 `await` 再清标志位 → 并发重入** —— 两次调用都能通过「有 recorder 吗」的检查，同一句识别两遍。要同步先摘 recorder。
7. **`execCommand('insertText')` 自己会派发 `input`** —— 再手动 dispatch 一次，编辑器会插两遍。
8. **`[data-slot]` 是 `display: contents`** —— 元素自身没有盒子，`getBoundingClientRect()` 全返回 0，不能用宽高筛元素。
9. **多个 `new Audio()` 会叠音** —— 必须复用同一个播放器，否则 `pause()` 只停最后一个，之前那些还在响。

---

## 自定义

`client.js` 顶部几个常量：

```js
const SPEAK_SPEED = 0.85   // 播报语速（F5 的 speed 参数，不改变音调）
const SILENCE_MS = 1300    // 静音多久算说完
const SILENCE_RMS = 0.010  // 音量阈值
```

---

## 已知问题

**自动播报抓正文的位置还没定准。** `[data-slot="conversation.chat.node"]` 能匹配几百个节点，最后一个常是底部状态栏（「用量 xxx tok」），正文在哪个 slot 还没完全定位。现在的做法是按长度和关键词过滤凑合，偶尔会念错。

欢迎提 PR 改进。

---

## License

MIT
