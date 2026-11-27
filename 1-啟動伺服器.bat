@echo off
chcp 65001 >nul
title 看盤 - 啟動 shioaji server
cd /d "%~dp0"
REM 啟動永豐 shioaji server（讀取本資料夾的 .env 登入），就緒後自動開啟看盤網頁

set "SJ=shioaji"
where shioaji >nul 2>nul || set "SJ=%USERPROFILE%\.local\bin\shioaji.exe"

curl.exe -s -m 3 http://127.0.0.1:8080/api/v1/info >nul 2>nul && (
  echo shioaji server 已經在執行中。
  goto open
)

echo 清除殘留的舊 server（避免 os error 10048）...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

echo 啟動 shioaji server（另開視窗，請不要關掉那個視窗）...
start "shioaji server（不要關閉）" /d "%~dp0" cmd /k ""%SJ%" server start"

echo 等待 server 就緒（最多 90 秒）...
for /l %%i in (1,1,45) do (
  curl.exe -s -m 2 http://127.0.0.1:8080/api/v1/info >nul 2>nul && goto ready
  timeout /t 2 /nobreak >nul
)
echo.
echo [失敗] 90 秒內 server 沒有回應。請看「shioaji server」視窗的訊息，或把畫面截圖給 Claude。
pause
exit /b 1

:ready
echo server 已就緒。

:open
echo 開啟看盤網頁...
start "" "http://127.0.0.1:8080/apps/mywatch/"
timeout /t 3 >nul
