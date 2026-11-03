@echo off
title Alamza Word Studio - Update
cd /d "%~dp0"
where git >nul 2>nul && git pull
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Update
pause
