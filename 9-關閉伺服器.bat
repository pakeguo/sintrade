@echo off
chcp 65001 >nul
title 看盤 - 關閉伺服器
cd /d "%~dp0"
REM 關閉 shioaji server（8080）與轉接站（5180）

set "SJ=shioaji"
where shioaji >nul 2>nul || set "SJ=%USERPROFILE%\.local\bin\shioaji.exe"

echo 關閉 shioaji server...
"%SJ%" server stop >nul 2>nul
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

echo 關閉轉接站...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

curl.exe -s -m 2 http://127.0.0.1:8080/api/v1/info >nul 2>nul && (
  echo [注意] shioaji server 好像還在執行，請把畫面截圖給 Claude。
) || (
  echo 已全部關閉。
)
timeout /t 3 >nul
