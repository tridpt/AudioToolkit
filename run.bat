@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\express (
  call npm install
  if errorlevel 1 exit /b 1
)
if not exist .venv\Scripts\python.exe (
  call npm run setup:ai
  if errorlevel 1 exit /b 1
)
echo Open http://127.0.0.1:4188 in your browser.
call npm start
