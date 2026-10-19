@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Lighting Lab needs Node.js 22 or newer. Install it, then run this file again.
  pause
  exit /b 1
)
echo Starting Lighting Lab. Keep this window open while you use the editor.
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4318'"
node server.cjs
set "exit_code=%ERRORLEVEL%"
echo Lighting Lab stopped with exit code %exit_code%.
pause
exit /b %exit_code%