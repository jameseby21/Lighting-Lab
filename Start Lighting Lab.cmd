@echo off
rem ===================================================================================================
rem  Start Lighting Lab.cmd - the double-click launcher.
rem
rem  1. Moves into this folder (so it works from Explorer, a shortcut, or the Start menu).
rem  2. Checks that Node.js 22+ is installed, and says exactly how to get it if not.
rem  3. Starts the local server with --open: the browser opens only AFTER the server is listening.
rem     If Lighting Lab is already running, the server notices and just opens the existing page.
rem  4. Keeps this window open so any startup error stays readable. Close it (or Ctrl+C) to stop.
rem
rem  Phone/tablet on the same Wi-Fi?  Run:  node server.cjs --open --lan
rem  This file must keep Windows (CRLF) line endings - see .gitattributes.
rem ===================================================================================================
setlocal
cd /d "%~dp0"
title Lighting Lab

where node >nul 2>nul
if errorlevel 1 goto :need_node

rem Exit code 0 means "Node major version is 22 or newer".
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto :old_node

echo Starting Lighting Lab. Your browser will open in a moment.
echo Keep this window open while you use Lighting Lab. Close it to stop.
echo.
node server.cjs --open
set "exit_code=%ERRORLEVEL%"
echo.
echo Lighting Lab stopped with exit code %exit_code%.
pause
exit /b %exit_code%

:need_node
echo Lighting Lab needs Node.js 22 or newer, and Node.js was not found.
echo.
echo   Easiest:  open PowerShell and run   winget install OpenJS.NodeJS.LTS
echo   Or:       download the LTS installer from https://nodejs.org
echo.
echo Then close this window and double-click "Start Lighting Lab.cmd" again.
pause
exit /b 1

:old_node
for /f "delims=" %%v in ('node --version') do set "node_version=%%v"
echo Lighting Lab needs Node.js 22 or newer. This PC has Node.js %node_version%.
echo.
echo   Update with:  winget upgrade OpenJS.NodeJS.LTS   (or install the LTS from https://nodejs.org)
echo.
pause
exit /b 1
