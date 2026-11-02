# dsh-voice-in

在 DeepSeek Harness 的输入框左边加三个控件：**说一句变文字**、**点一下读回答**、**自动播报开关**。

配合 F5-TTS，可以让 DSH 真的「开口说话」。

> **已验证**：2026-11-02 在隔离环境里从零跑过一遍——`git clone` → 从 Releases 下载 1.4 GB 模型 → 写配置 → 起服务 → ASR 和 TTS 都通。没有借用任何本机已有的东西。

---

## 能干什么

- **🎤 说** —— 点一下开始录，说完停顿 1.3 秒自动断句，识别出来的文字**替换**输入框内容（不是追加）
- **🔊 读** —— 读最后一条回答，按句合成、逐句播放，边播边合成下一句
- **🔇 手动 / 🔁 自动** —— 自动播报开关（存在 localStorage，刷新记得住）。开着时新回答会自动念，**新内容来了会掐断旧的**
- **状态小圆点** —— 绿＝语音服务就绪，红＝连不上，黄＝检查中

**全程本地**，不走任何 API，不消耗 token。识别是 SenseVoice（约 54 毫秒），合成是 F5-TTS（约 1.3 秒/句）。

---

## 快速开始

### 1. 装插件

```powershell
Copy-Item . $env:USERPROFILE\.dsh\plugins\dsh-voice-in -Recurse
cd $env:USERPROFILE\.dsh\plugins\dsh-voice-in
pnpm install            # 会装 sherpa-onnx-node（含对应平台的二进制）

# 链接进 profile
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$prof\package.json" "$prof\..\profile-backup-voice" -Force
cd $prof
pnpm add "link:$env:USERPROFILE\.dsh\plugins\dsh-voice-in"
# 然后手写 package.json 的 dsh.profile.bundles，加一项 dsh-voice-in
```

### 2. 拿模型和音色

去 [Releases](https://github.com/Yexiaofan2023/dsh-voice-in/releases) 下载：

| 文件 | 放哪儿 |
|---|---|
| `sensevoice-models.zip`（154 MB） | 解压到 `~/.dsh/speech-to-text/sensevoice/models/` |
| `model_384_infer.pt`（1.26 GB） | `~/.dsh/voice-in/models/` |
| `ref-clean.wav`（441 KB） | 同上 |

### 3. 装 F5-TTS

见 [F5-TTS 官方文档](https://github.com/SWivid/F5-TTS)。一句话：

```bash
git clone https://github.com/SWivid/F5-TTS.git
cd F5-TTS && pip install -e .
```

记下那个 Python 解释器的路径。

### 4. 写配置

复制 `config.example.json` 到 `~/.dsh/voice-in-config.json`，改这几项：

```json
{
  "asrModelsRoot": "~/.dsh/speech-to-text/sensevoice/models",
  "ffmpeg": "",
  "ttsPython": "python",
  "ttsDefaultVoice": "whale",
  "ttsVoices": {
    "whale": {
      "label": "大肥鱼（第 8 轮）",
      "ckpt": "~/.dsh/voice-in/models/model_384_infer.pt",
      "ref": "~/.dsh/voice-in/models/ref-clean.wav",
      "refText": "我是来自深海的鲸鱼娘deep seek，就在刚刚，人类把这一整个B站账号交给了我",
      "speed": 0.85
    }
  }
}
```

路径支持 `~` 和 `%环境变量%`。`ffmpeg` 留空就用 PATH 里的。

### 5. 重启 DSH，查自检

```
GET /dsh-voice-in/health
```

返回里 `missing` 数组会告诉你还缺什么、该放哪儿。空数组就说明齐了。

---

## 依赖

| 东西 | 必需 | 说明 |
|---|---|---|
| sherpa-onnx-node | 是 | `pnpm install` 自动装。找不到会提示 |
| ASR 模型 | 是 | Releases 里的 zip，约 230 MB |
| ffmpeg | 是 | 装到 PATH 或配置绝对路径 |
| F5-TTS | 播报才需要 | 没有的话「🎤 说」照常能用 |
| 音色 ckpt + 参考音 | 播报才需要 | Releases 里那份，或自己训练的 |

**播报是可选的**。只想要语音输入的话，装到第 2 步就够，`ttsVoices` 留空。

---

## 用别的音色

`ttsVoices` 是个字典，想加几个加几个，`ttsDefaultVoice` 决定用哪个：

```json
"ttsVoices": {
  "whale":   { "label": "大肥鱼", ... },
  "myvoice": { "label": "我自己的", "ckpt": "...", "ref": "...", "refText": "..." }
}
```

训练方法看 [F5-TTS 的 finetune 文档](https://github.com/SWivid/F5-TTS)。参考音频要 10 秒左右、干净、无背景音，`refText` 必须和音频内容一字不差。

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
        ├─ sherpa-onnx SenseVoice 识别
        └─ spawn Python 跑 service/f5_server.py（常驻进程）
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
10. **Windows 下 Python 读写 stdin/stdout 默认 GBK** —— 传中文会崩，要 `reconfigure(encoding='utf-8')`。

---

## 自定义

`client.js` 顶部：

```js
const SPEAK_SPEED = 0.85   // 默认语速（也可以按音色在配置里单独设）
const SILENCE_MS = 1300    // 静音多久算说完
const SILENCE_RMS = 0.010  // 音量阈值
```

---

## 关于音色

仓库 Releases 里那份 `model_384_infer.pt` 是大肥鱼的声音，训练素材来自互联网上的公开内容。放着就是给大家用的。

**不想用可以完全不用**——`ttsVoices` 里换成自己的模型就行，插件不绑定任何特定音色。

---

## 已知问题

**自动播报抓正文的位置还没定准。** `[data-slot="conversation.chat.node"]` 能匹配几百个节点，最后一个常是底部状态栏，正文在哪个 slot 还没完全定位。现在按长度和关键词过滤凑合，偶尔会念错。

欢迎提 PR 改进。

---

## License

MIT
