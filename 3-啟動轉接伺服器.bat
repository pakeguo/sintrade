@echo off
chcp 65001 >nul
title 看盤轉接站（不要關閉）
cd /d "%~dp0"
REM 唯讀轉接站 127.0.0.1:5180：自選同步、三大法人買賣超、手機看盤（需 .env 的 MW_PASSWORD）；下單一律封鎖

echo 關閉已在執行的轉接站（如果有）...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

if not exist "dist\index.html" (
  echo 第一次執行，先打包網頁...
  call npm.cmd run build || (
    echo [失敗] 打包沒有成功，請把畫面截圖給 Claude。
    pause
    exit /b 1
  )
)

echo 啟動轉接站，這個視窗要保持開著；按 Ctrl+C 可結束。
call npm.cmd run phone
echo.
echo 轉接站已停止。
pause
