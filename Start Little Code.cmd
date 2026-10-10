@echo off
setlocal
cd /d "%~dp0"
node scripts\start-desktop.mjs %*
if errorlevel 1 (
  echo.
  echo Little Code needs its desktop build. Run npm run desktop:build in this folder.
  pause
)
endlocal
