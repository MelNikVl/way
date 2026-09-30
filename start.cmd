@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node server.mjs
  goto :end
)
set "WAY_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%WAY_NODE%" (
  "%WAY_NODE%" server.mjs
) else (
  echo Node.js 20+ is required. Install Node.js from https://nodejs.org then run this file again.
)
:end
pause
