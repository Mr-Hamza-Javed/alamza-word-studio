@echo off
title Alamza Word Studio - Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup did not finish. Scroll up to see what went wrong.
)
pause
