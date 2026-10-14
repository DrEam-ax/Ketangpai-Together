# End-to-end check of the native HTTP bridge:
# boot -> install -> launch -> fill the add-account form via TAB navigation -> tap submit -> screenshot.
# Pure ASCII on purpose.
$ErrorActionPreference = 'Continue'
$sdk = 'D:\Android\Sdk'
$apk = 'D:\dsh--vibeCD\app-android\app\build\outputs\apk\debug\app-debug.apk'
$avd = 'FoodReminder_API33'
$out = 'D:\dsh--vibeCD\app-android'

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_AVD_HOME = 'D:\Android\avd'
$env:JAVA_HOME = 'C:\Users\Lenovo\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot'
$adb = "$sdk\platform-tools\adb.exe"
$emu = "$sdk\emulator\emulator.exe"

# 测试账号从环境变量读，脚本里不写任何真实凭据（避免误提交密码）。
# 用法:
#   $env:KTP_TEST_PHONE='<手机号>'; $env:KTP_TEST_PASSWORD='<密码>'; .\test-add-account.ps1
$testKey = if ($env:KTP_TEST_KEY) { $env:KTP_TEST_KEY } else { 't1' }
$testPhone = $env:KTP_TEST_PHONE
$testPassword = $env:KTP_TEST_PASSWORD
if (-not $testPhone -or -not $testPassword) {
  Write-Host '[SKIP] KTP_TEST_PHONE / KTP_TEST_PASSWORD not set - will only verify launch, not login.' -ForegroundColor Yellow
}

function Shot($name) {
  & $adb shell screencap -p /sdcard/s.png 2>&1 | Out-Null
  & $adb pull /sdcard/s.png "$out\$name.png" 2>&1 | Out-Null
  Write-Host ("  shot -> {0}.png" -f $name)
}

Write-Host '=== boot ==='
& $adb kill-server 2>&1 | Out-Null
$emuProc = Start-Process -FilePath $emu -ArgumentList @(
  '-avd', $avd, '-no-window', '-no-audio', '-no-boot-anim',
  '-gpu', 'swiftshader_indirect', '-no-snapshot'
) -PassThru -WindowStyle Hidden

& $adb start-server 2>&1 | Out-Null
$booted = $false
for ($i = 1; $i -le 50; $i++) {
  Start-Sleep -Seconds 6
  $state = (& $adb shell getprop sys.boot_completed 2>$null) -join ''
  if ($state.Trim() -eq '1') { $booted = $true; Write-Host ("booted ~{0}s" -f ($i * 6)); break }
}
if (-not $booted) { Stop-Process -Id $emuProc.Id -Force -EA SilentlyContinue; exit 1 }

Write-Host '=== install + launch ==='
& $adb install -r $apk 2>&1 | Select-Object -Last 1
& $adb logcat -c 2>&1 | Out-Null
& $adb shell am start -n 'com.ktp.scanner/.MainActivity' 2>&1 | Select-Object -First 2
Start-Sleep -Seconds 7

# Make sure the display is on and unlocked
& $adb shell input keyevent KEYCODE_WAKEUP 2>&1 | Out-Null
& $adb shell wm dismiss-keyguard 2>&1 | Out-Null
Start-Sleep -Seconds 2
Shot 'step0_launch'

if (-not $testPhone -or -not $testPassword) {
  Write-Host '=== no credentials supplied - launch verified, skipping login test ==='
  & $adb uninstall com.ktp.scanner 2>&1 | Out-Null
  & $adb emu kill 2>&1 | Out-Null
  Start-Sleep -Seconds 4
  Stop-Process -Id $emuProc.Id -Force -EA SilentlyContinue
  & $adb kill-server 2>&1 | Out-Null
  Write-Host 'done (launch-only)'
  exit 0
}

Write-Host '=== tap key field (approx 541,1066) ==='
& $adb shell input tap 541 1066 2>&1 | Out-Null
Start-Sleep -Seconds 2
& $adb shell input text $testKey 2>&1 | Out-Null
Start-Sleep -Seconds 1

Write-Host '=== TAB -> phone ==='
& $adb shell input keyevent 61 2>&1 | Out-Null
Start-Sleep -Seconds 1
& $adb shell input text $testPhone 2>&1 | Out-Null
Start-Sleep -Seconds 1

Write-Host '=== TAB -> password ==='
& $adb shell input keyevent 61 2>&1 | Out-Null
Start-Sleep -Seconds 1
& $adb shell input text $testPassword 2>&1 | Out-Null
Start-Sleep -Seconds 1

Write-Host '=== dismiss IME ==='
& $adb shell input keyevent 4 2>&1 | Out-Null
Start-Sleep -Seconds 2
Shot 'step1_filled'

Write-Host '=== tap 添加并验证登录 (approx 541,1493) ==='
& $adb shell input tap 541 1493 2>&1 | Out-Null
Start-Sleep -Seconds 8
Shot 'step2_after_add'

Write-Host ''
Write-Host '=== logcat (ours) ==='
$log = & $adb logcat -d 2>&1
$log | Select-String -Pattern 'ktp|FATAL|AndroidRuntime' | Select-Object -First 20 | ForEach-Object { Write-Host $_ }

Write-Host ''
Write-Host '=== cleanup ==='
& $adb shell run-as com.ktp.scanner cat /data/data/com.ktp.scanner/shared_prefs/ktp.xml 2>&1 | Select-String -Pattern 'ktp|accounts' | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
& $adb emu kill 2>&1 | Out-Null
Start-Sleep -Seconds 4
Stop-Process -Id $emuProc.Id -Force -EA SilentlyContinue
& $adb kill-server 2>&1 | Out-Null
Write-Host 'done'
exit 0
