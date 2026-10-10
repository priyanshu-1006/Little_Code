@echo off
setlocal
cd /d "%~dp0"
npm.cmd run desktop:build
pause
endlocal
