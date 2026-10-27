# ============================================================================
# dsh-orchaterm-web-api 安装与环境就绪自检脚本
# ============================================================================
param (
  [string]$Profile = "web"
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " [OrcaTerm 反代插件] 开始安装自检与环境校验" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

$pluginDir = $PSScriptRoot

# 1. 检查 Node.js
Write-Host "`n[1/5] 检查 Node.js 运行环境..." -ForegroundColor Yellow
try {
  $nodeVer = (node -v).Trim()
  Write-Host "  -> Node.js 已安装: $nodeVer" -ForegroundColor Green
} catch {
  Write-Error "未找到 Node.js，请确保已安装 Node.js >= 20 并在 PATH 中。"
}

# 2. 运行配置自检与单测
Write-Host "`n[2/5] 运行插件单元测试 (config_check & smoke & token_refresh)..." -ForegroundColor Yellow
$testResult = & node "$pluginDir\test\config_check.mjs"
if ($LASTEXITCODE -ne 0) {
  Write-Error "config_check 失败！"
}
$smokeResult = & node "$pluginDir\test\smoke.mjs"
if ($LASTEXITCODE -ne 0) {
  Write-Error "smoke 测试失败！"
}
$refreshResult = & node "$pluginDir\test\token_refresh.mjs"
if ($LASTEXITCODE -ne 0) {
  Write-Error "token_refresh 测试失败！"
}
Write-Host "  -> 单元测试与配置校验全部通过！" -ForegroundColor Green

# 3. 检查本机 OrcaTerm 登录态 + 自续期缓存
Write-Host "`n[3/5] 检查 OrcaTerm 桌面端安装与登录态..." -ForegroundColor Yellow
$storePath = "$env:APPDATA\com.orcaterm-desktop.app\data.bin"
$cookiePath = "$env:LOCALAPPDATA\com.orcaterm-desktop.app\.cookies"
$cachePath = "$env:USERPROFILE\.dsh\orca-token-cache.json"

function Get-TokenExpiry([string]$jwt) {
  if (-not $jwt -or $jwt -notmatch '\.') { return $null }
  try {
    $seg = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
    while ($seg.Length % 4) { $seg += '=' }
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($seg)) | ConvertFrom-Json
    if ($null -ne $json.exp) { return [DateTimeOffset]::FromUnixTimeSeconds([int64]$json.exp).ToLocalTime() }
  } catch {}
  return $null
}

$tokenExpiry = $null
if (Test-Path $storePath) {
  $storeTxt = [System.IO.File]::ReadAllText($storePath)
  $m = [regex]::Match($storeTxt, '"oauth_access_token"\s*:\s*"([^"]+)"')
  if ($m.Success) {
    $tokenExpiry = Get-TokenExpiry $m.Groups[1].Value
    if ($tokenExpiry) {
      Write-Host "  -> 成功检测到 OrcaTerm 桌面端登录态 (token 到期: $($tokenExpiry.ToString('yyyy-MM-dd HH:mm')))" -ForegroundColor Green
    } else {
      Write-Host "  -> 成功检测到 OrcaTerm 桌面端登录态 (Bearer Token 就绪)" -ForegroundColor Green
    }
  } else {
    Write-Host "  -> 检测到 OrcaTerm store 文件，但未提取到 token，请启动桌面端并登录。" -ForegroundColor Yellow
  }
} else {
  Write-Host "  -> 未发现桌面端 store 文件 ($storePath)，若首次使用请先安装并启动 OrcaTerm。" -ForegroundColor Yellow
}

# 续期缓存：v0.6.0 起插件自己用 OAuthRefreshToken 续期，结果落在这里，重启也不丢。
if (Test-Path $cachePath) {
  try {
    $cache = Get-Content $cachePath -Raw | ConvertFrom-Json
    $cacheExpiry = Get-TokenExpiry $cache.accessToken
    if ($cacheExpiry) {
      $status = if ($cacheExpiry -gt (Get-Date)) { '有效' } else { '已过期（下次请求会自动续期）' }
      Write-Host "  -> 自续期缓存已就绪 ($cachePath, 到期: $($cacheExpiry.ToString('yyyy-MM-dd HH:mm'))，$status)" -ForegroundColor Green
    }
  } catch {
    Write-Host "  -> 自续期缓存存在但无法解析（可忽略，后端会自动重建）" -ForegroundColor Yellow
  }
} else {
  Write-Host "  -> 尚无自续期缓存：首次调用时后端会用 OAuthRefreshToken 自动生成（$cachePath）" -ForegroundColor Cyan
}

# 4. 检查/建立 profile junction
Write-Host "`n[4/5] 检查与建立 DSH profile 插件软链接 (Junction)..." -ForegroundColor Yellow
$profileModules = "$env:USERPROFILE\.dsh\profiles\$Profile\node_modules"
if (-not (Test-Path $profileModules)) {
  New-Item -ItemType Directory -Force -Path $profileModules | Out-Null
}

$junctionTarget = Join-Path $profileModules "dsh-orchaterm-web-api"
if (Test-Path $junctionTarget) {
  $isJunction = ((Get-Item $junctionTarget).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  if ($isJunction) {
    Write-Host "  -> Junction 已经存在: $junctionTarget" -ForegroundColor Green
  } else {
    Write-Host "  -> 目标路径不是 Junction，正在替换..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $junctionTarget
    New-Item -ItemType Junction -Path $junctionTarget -Target $pluginDir | Out-Null
    Write-Host "  -> Junction 创建成功: $junctionTarget -> $pluginDir" -ForegroundColor Green
  }
} else {
  New-Item -ItemType Junction -Path $junctionTarget -Target $pluginDir | Out-Null
  Write-Host "  -> Junction 创建成功: $junctionTarget -> $pluginDir" -ForegroundColor Green
}

# 5. 探活或自启动本地反代验证
Write-Host "`n[5/5] 验证反代服务通信 (/health)..." -ForegroundColor Yellow
$healthUrl = "http://127.0.0.1:8793/health"
$healthOk = $false
try {
  $res = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3 -ErrorAction SilentlyContinue
  if ($res.status -eq "ok") {
    $healthOk = $true
    Write-Host "  -> 本地反代服务运行正常 (PID/Version: $($res.version))" -ForegroundColor Green
    if ($res.tokenRefresh -and $res.tokenRefresh.enabled -ne $false) {
      $remainMin = [math]::Round($res.tokenRefresh.remainingSec / 60)
      $checkMin = [math]::Round($res.tokenRefresh.checkSec / 60)
      $lastCode = $res.tokenRefresh.last.code
      Write-Host "  -> AccessToken 自续期已启用 (剩余约 $remainMin 分钟；每 $checkMin 分钟巡检；最近一次: $lastCode)" -ForegroundColor Green
    }
  }
} catch {}

if (-not $healthOk) {
  Write-Host "  -> 本地反代当前未常驻，DSH 启动时将由 autoStart 机制按需托管拉起 (127.0.0.1:8793)。" -ForegroundColor Cyan
}

Write-Host "`n=========================================================" -ForegroundColor Cyan
Write-Host " [OrcaTerm 反代插件] 安装检查完成！" -ForegroundColor Cyan
Write-Host " 请确认 ~/.dsh/profiles/$Profile/package.json 中 bundles 已添加 dsh-orchaterm-web-api" -ForegroundColor Cyan
Write-Host " 重启 DeepSeek Harness 客户端即可加载模型路由。" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
