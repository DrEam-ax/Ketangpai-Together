# Verify the APK launches, using the EXISTING FoodReminder_API33 avd
# (we install our app, check logs/screenshot, then uninstall it again).
# Pure ASCII on purpose: Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
$ErrorActionPreference = 'Continue'
$sdk = 'D:\Android\Sdk'
$apk = 'D:\dsh--vibeCD\app-android\app\build\outputs\apk\debug\app-debug.apk'
$avd = 'FoodReminder_API33'

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_AVD_HOME = 'D:\Android\avd'
$env:JAVA_HOME = 'C:\Users\Lenovo\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot'
$adb = "$sdk\platform-tools\adb.exe"
$emu = "$sdk\emulator\emulator.exe"

Write-Host '=== 1. boot emulator (headless) ==='
& $adb kill-server 2>&1 | Out-Null
$emuProc = Start-Process -FilePath $emu -ArgumentList @(
  '-avd', $avd, '-no-window', '-no-audio', '-no-boot-anim',
  '-gpu', 'swiftshader_indirect', '-no-snapshot'
) -PassThru -WindowStyle Hidden
Write-Host ("emulator pid = {0}" -f $emuProc.Id)

Write-Host ''
Write-Host '=== 2. wait for boot ==='
& $adb start-server 2>&1 | Out-Null
$booted = $false
for ($i = 1; $i -le 50; $i++) {
  Start-Sleep -Seconds 6
  $state = (& $adb shell getprop sys.boot_completed 2>$null) -join ''
  if ($state.Trim() -eq '1') { $booted = $true; Write-Host ("booted after ~{0}s" -f ($i * 6)); break }
  if ($i % 5 -eq 0) { Write-Host ("  waiting {0}s" -f ($i * 6)) }
}

if (-not $booted) {
  Write-Host '[FAIL] emulator did not boot in 300s' -ForegroundColor Red
  Stop-Process -Id $emuProc.Id -Force -ErrorAction SilentlyContinue
  & $adb kill-server 2>&1 | Out-Null
  exit 1
}

Write-Host ''
Write-Host '=== 3. install ==='
& $adb install -r $apk 2>&1 | Select-Object -Last 3

Write-Host ''
Write-Host '=== 4. launch ==='
& $adb logcat -c 2>&1 | Out-Null
& $adb shell am start -n 'com.ktp.scanner/.MainActivity' 2>&1 | Select-Object -First 4

Write-Host ''
Write-Host '=== 5. wait 12s then inspect ==='
Start-Sleep -Seconds 12

$log = & $adb logcat -d 2>&1
$crash = $log | Select-String -Pattern 'FATAL EXCEPTION|E AndroidRuntime|AndroidRuntime.*ktp|Unable to start' | Select-Object -First 20
if ($crash) {
  Write-Host '[EXCEPTION]' -ForegroundColor Red
  $crash | ForEach-Object { Write-Host $_ }
} else {
  Write-Host '[OK] no crash in logcat' -ForegroundColor Green
}

Write-Host ''
Write-Host '--- chromium / webview / ktp lines ---'
$log | Select-String -Pattern 'ktp|chromium|WebView|Capacitor' | Select-Object -First 20 | ForEach-Object { Write-Host $_ }

Write-Host ''
Write-Host '=== 6. resumed activity (should be our app) ==='
& $adb shell dumpsys activity activities 2>&1 | Select-String -Pattern 'mResumedActivity|topResumedActivity|ResumedActivity' | Select-Object -First 4

Write-Host ''
Write-Host '=== 7. screenshot ==='
& $adb shell screencap -p /sdcard/ktp.png 2>&1 | Out-Null
& $adb pull /sdcard/ktp.png 'D:\dsh--vibeCD\app-android\screen1.png' 2>&1 | Select-Object -Last 1

Write-Host ''
Write-Host '=== 8. uninstall (leave the avd clean) ==='
& $adb uninstall com.ktp.scanner 2>&1 | Select-Object -Last 1

Write-Host ''
Write-Host '=== 9. shutdown emulator ==='
& $adb emu kill 2>&1 | Out-Null
Start-Sleep -Seconds 4
Stop-Process -Id $emuProc.Id -Force -ErrorAction SilentlyContinue
& $adb kill-server 2>&1 | Out-Null
Write-Host 'done'
exit 0
