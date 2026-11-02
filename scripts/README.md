# 干净环境测试脚本

模拟一个「什么插件都没装、什么模型都没下」的新用户，从零把插件跑起来。

用途：改完代码后自己验一遍，确认别人照着 README 做真的能用。

## 跑法

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File .\scripts\test-clean-install.ps1
```

⚠ **脚本必须存成 UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按 GBK 解释，中文全乱码、直接语法错误。

## 它做什么

1. 清空 `%TEMP%\voice-in-clean-test`，建一个隔离目录
2. 从 GitHub clone 仓库（不碰任何现有文件）
3. 从 Releases 下载模型和音色（约 1.4 GB）
4. 把配置写到隔离目录，**不借用本机已有的任何路径**
5. 语法检查
6. 在 7799 端口起服务（避开常用的 7788）
7. 验证 `/health` → ASR → TTS

## 会用到本机的东西

只有两样，脚本顶部可以改：

| 参数 | 默认 | 用途 |
|---|---|---|
| `$Ffmpeg` | 自动找 PATH 里的 ffmpeg | 音频格式转换 |
| `$TtsPython` | `python` | 跑 F5-TTS 的解释器 |

如果本机没装 F5-TTS，脚本会在 TTS 那一步失败——那是**预期**的，说明播报依赖没满足。ASR 应该照常通过。

## 输出什么样

```
=== 1. 从 GitHub clone ===      ✓ 9 个文件
=== 2. 从 Releases 下载模型 ===  ✓ 1.4 GB
=== 3. 写隔离配置 ===           ✓
=== 4. 语法检查 ===             ✓
=== 5. 起服务 ===
=== 6. 验证 ===                 ok=True sherpa=True tts=True
                               ★ 依赖齐全
=== 7. 端到端 ===
  ASR: {"ok":true,"text":"...","ms":256}
  TTS: 返回 124460 字节
```

## 清理

测试目录在 `%TEMP%\voice-in-clean-test`，跑完手动删就行。模型占 1.4 GB，别一直留着。
