@echo off
chcp 65001 >nul
REM 更新看盤程式：git pull → 安裝套件 → 打包並上傳到 shioaji server；轉接站在執行中就自動重啟
REM git pull 可能改到這個 bat 本身，執行中的 bat 被改寫會出錯 → 先複製到暫存資料夾再執行
if not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\mywatch-update.bat" >nul
  call "%TEMP%\mywatch-update.bat" --run "%~dp0"
  exit /b
)
title 看盤 - 更新伺服器
cd /d "%~2"

curl.exe -s -m 3 http://127.0.0.1:8080/api/v1/info >nul 2>nul || (
  echo [注意] shioaji server 沒有在執行，請先執行「1-啟動伺服器.bat」再更新。
  pause
  exit /b 1
)

echo [1/3] 下載最新程式（git pull）...
git pull || (
  echo [失敗] git pull 沒有成功，請把畫面截圖給 Claude。
  pause
  exit /b 1
)

echo [2/3] 安裝／更新套件（npm install）...
call npm.cmd install --no-audit --no-fund || (
  echo [失敗] npm install 沒有成功，請把畫面截圖給 Claude。
  pause
  exit /b 1
)

echo [3/3] 打包並上傳到 shioaji server（npm run deploy）...
call npm.cmd run deploy || (
  echo [失敗] 部署沒有成功，請把畫面截圖給 Claude。
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" && (
  echo 轉接站正在執行，重新啟動以套用更新...
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
  start "看盤轉接站（不要關閉）" /d "%~2" cmd /k npm.cmd run phone
)

echo.
echo 更新完成！請到看盤網頁按 Ctrl+F5 重新整理。
pause
