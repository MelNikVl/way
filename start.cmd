@echo off
setlocal
cd /d "%~dp0"
set "WAY_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%WAY_NODE%" (
  "%WAY_NODE%" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);require('node:sqlite')" >nul 2>nul
  if not errorlevel 1 goto :run
)
set "WAY_NODE="
for /f "delims=" %%N in ('where node 2^>nul') do (
  if not defined WAY_NODE (
    "%%N" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);require('node:sqlite')" >nul 2>nul
    if not errorlevel 1 set "WAY_NODE=%%N"
  )
)
if defined WAY_NODE goto :run
echo Node.js 24+ with node:sqlite is required. Install it from https://nodejs.org and run this file again.
set "WAY_EXIT=1"
goto :end
:run
"%WAY_NODE%" server.mjs
set "WAY_EXIT=%ERRORLEVEL%"
:end
pause
exit /b %WAY_EXIT%
