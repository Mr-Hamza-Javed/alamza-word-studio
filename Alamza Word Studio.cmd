@echo off
rem Starts Alamza Word Studio from this folder (works on any PC the folder is copied to).
if not exist "%~dp0runtime\python\pythonw.exe" (
  echo Alamza Word Studio is not set up in this folder yet.
  echo Double-click install.bat first.
  pause
  exit /b 1
)
start "" "%~dp0runtime\python\pythonw.exe" "%~dp0AlamzaWordStudio.pyw" %*
