@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where.exe node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.16 or newer is required. Please install Node.js and reopen this window.
  pause
  exit /b 1
)
node scripts\start-demo.js
if errorlevel 1 pause
