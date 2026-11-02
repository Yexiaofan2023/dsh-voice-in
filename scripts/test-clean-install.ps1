# 模拟"全新用户"：从 GitHub 拿代码和模型，在隔离目录里跑一遍
# 用法：powershell -File test-clean-install.ps1
$ErrorActionPreference = 'Continue'   # native 命令往 stderr 写进度是正常的，不能用 Stop

$Repo = 'https://github.com/Yexiaofan2023/dsh-voice-in.git'
$Base = Join-Path $env:TEMP 'voice-in-clean-test'
$FakeHome = Join-Path $Base 'fake-home'
$RepoDir = Join-Path $Base 'repo'
$Models = Join-Path $Base 'models'

Write-Host "=== 0. 清理旧测试目录 ===" -ForegroundColor Cyan
if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
New-Item -ItemType Directory -Path $FakeHome, $Models -Force | Out-Null
Write-Host "  测试根目录: $Base"

Write-Host "=== 1. 从 GitHub clone（模拟新用户）===" -ForegroundColor Cyan
git clone --depth 1 $Repo $RepoDir 2>$null
if ($LASTEXITCODE -ne 0) { throw 'git clone 失败' }
if (-not (Test-Path "$RepoDir\client.js")) { throw 'clone 失败' }
Write-Host "  ✓ 代码拿到，文件数: $((Get-ChildItem $RepoDir -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' }).Count)"

Write-Host "=== 2. 从 Releases 下载模型（模拟新用户）===" -ForegroundColor Cyan
$tag = 'v0.1.0'
$assets = (Invoke-RestMethod "https://api.github.com/repos/Yexiaofan2023/dsh-voice-in/releases/tags/$tag" -Headers @{ 'User-Agent'='dsh' }).assets
foreach ($a in $assets) {
  if ($a.state -ne 'uploaded') { Write-Host "  ⚠ $($a.name) 还没上传完，跳过"; continue }
  $dest = Join-Path $Models $a.name
  Write-Host "  下载 $($a.name) ($([math]::Round($a.size/1MB,1)) MB)…"
  Invoke-WebRequest -Uri $a.browser_download_url -OutFile $dest -UseBasicParsing -TimeoutSec 3600
  Write-Host "    ✓ $([math]::Round((Get-Item $dest).Length/1MB,1)) MB"
}
if (Test-Path "$Models\sensevoice-models.zip") {
  Expand-Archive "$Models\sensevoice-models.zip" -DestinationPath $Models -Force
  Write-Host "  ✓ ASR 模型已解压"
}

Write-Host "=== 3. 写配置（指向隔离目录）===" -ForegroundColor Cyan
$cfg = @{
  asrModelsRoot = "$Models"
  ffmpeg = ''
  ttsPython = 'python'
  ttsDefaultVoice = 'whale'
  ttsVoices = @{
    whale = @{
      label = '大肥鱼（第 8 轮）'
      ckpt = "$Models\model_384_infer.pt"
      ref = "$Models\ref-clean.wav"
      refText = '我是来自深海的鲸鱼娘deep seek，就在刚刚，人类把这一整个B站账号交给了我'
      speed = 0.85
    }
  }
}
$cfgPath = Join-Path $RepoDir 'config.json'
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
Write-Host "  ✓ 配置写到 $cfgPath"

Write-Host "=== 4. 语法检查 ===" -ForegroundColor Cyan
node --check "$RepoDir\service\voice-service.cjs"
if ($LASTEXITCODE -ne 0) { throw 'voice-service.cjs 语法错' }
node --check "$RepoDir\client.js"
if ($LASTEXITCODE -ne 0) { throw 'client.js 语法错' }
Write-Host "  ✓ 语法都过了"

Write-Host "=== 5. 起服务（用隔离配置）===" -ForegroundColor Cyan
$env:VOICE_PORT = '7799'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $node = $node.Source } else { throw '找不到 node.exe，请先装 Node.js' }
Write-Host "  用 node: $node"
$logOut = Join-Path $Base 'svc.log'
$logErr = Join-Path $Base 'svc.err'
Start-Process -FilePath $node -ArgumentList "$RepoDir\service\voice-service.cjs" -WorkingDirectory $RepoDir -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr
Start-Sleep -Seconds 30

Write-Host "=== 6. 验证 ===" -ForegroundColor Cyan
try {
  $j = (Invoke-WebRequest 'http://127.0.0.1:7799/health' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
  Write-Host "  ok=$($j.ok)  sherpa=$($j.sherpa)  tts=$($j.tts)  voice=$($j.voice)"
  if ($j.missing.Count -gt 0) {
    Write-Host "  ⚠ 缺:" -ForegroundColor Yellow
    $j.missing | ForEach-Object { Write-Host "    - $($_.what) → $($_.how)" }
  } else {
    Write-Host "  ★ 依赖齐全" -ForegroundColor Green
  }
  # ASR + TTS 各打一次
  Write-Host "=== 7. 端到端 ===" -ForegroundColor Cyan
  $wav = Join-Path $Models 'ref-clean.wav'
  $asr = Invoke-WebRequest 'http://127.0.0.1:7799/asr' -Method POST -InFile $wav -ContentType 'audio/wav' -UseBasicParsing -TimeoutSec 60
  Write-Host "  ASR: $($asr.Content)"
  $body = [Text.Encoding]::UTF8.GetBytes('{"text":"干净环境测试通过。","speed":0.85}')
  $tts = Invoke-WebRequest 'http://127.0.0.1:7799/tts' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
  Write-Host "  TTS: 返回 $($tts.RawContentLength) 字节"
} catch {
  Write-Host "  ✗ 失败: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "--- 服务日志 ---"
  Get-Content $logOut -ErrorAction SilentlyContinue | Select-Object -First 20
  Get-Content $logErr -ErrorAction SilentlyContinue | Select-Object -First 20
}
Write-Host "`n测试目录保留在: $Base（确认没问题可删）"
