# 课堂派签到 App —— 一键打包
# 产物：app\build\outputs\apk\debug\app-debug.apk
# 复用本机已有的 Android SDK 与 Gradle 缓存，不额外下载 SDK。

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = 'D:\Android\Sdk'
$env:JAVA_HOME = 'C:\Users\Lenovo\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot'
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

Write-Host ''
Write-Host '=================================================='
Write-Host '  课堂派签到 App 打包'
Write-Host ("  ANDROID_HOME = {0}" -f $env:ANDROID_HOME)
Write-Host ("  JAVA_HOME    = {0}" -f $env:JAVA_HOME)
Write-Host '=================================================='
Write-Host ''

if (-not (Test-Path "$env:JAVA_HOME\bin\java.exe")) {
  Write-Host '[失败] 找不到 JDK17' -ForegroundColor Red
  exit 3
}
if (-not (Test-Path "$env:ANDROID_HOME\platforms")) {
  Write-Host '[失败] 找不到 Android SDK' -ForegroundColor Red
  exit 2
}

$apk = Join-Path $root 'app\build\outputs\apk\debug\app-debug.apk'

# 关键：先删掉上次的产物。
# 否则构建失败时旧 apk 还在，脚本会把它当成本次成功产物报出来 —— 真的踩过，
# 结果把一个其实是上一版的包当新版发出去过。
if (Test-Path $apk) { Remove-Item $apk -Force }

Push-Location $root
& "$root\gradlew.bat" assembleDebug --console=plain
$code = $LASTEXITCODE
Pop-Location

Write-Host ''
if ($code -eq 0 -and (Test-Path $apk)) {
  $f = Get-Item $apk
  Write-Host ('[成功] {0}' -f $f.FullName) -ForegroundColor Green
  Write-Host ('       大小 {0:N1} MB   时间 {1}' -f ($f.Length / 1MB), $f.LastWriteTime)
  exit 0
}
Write-Host ("[失败] gradle 退出码 {0}，未产出 apk（不会误用旧包）" -f $code) -ForegroundColor Red
exit 7
