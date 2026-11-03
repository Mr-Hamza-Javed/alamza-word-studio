#Requires -Version 5.1
# Removes shortcuts, the start-with-Windows entry and (optionally) your data.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$AppName = "Alamza Word Studio"

try { Invoke-WebRequest -UseBasicParsing -Method Post "http://127.0.0.1:7865/api/quit" -TimeoutSec 3 | Out-Null } catch { }

foreach ($p in @(
  (Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "$AppName.lnk")
)) { if (Test-Path $p) { Remove-Item $p -Force } }
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "AlamzaWordStudio" -ErrorAction SilentlyContinue
Write-Host "Shortcuts and auto-start removed." -ForegroundColor Green

$answer = Read-Host "Also delete the app environment (.venv, ~2 GB)? (y/N)"
if ($answer -match '^[yY]') { Remove-Item (Join-Path $Root ".venv") -Recurse -Force -ErrorAction SilentlyContinue }

$data = Join-Path $env:LOCALAPPDATA "AlamzaWordStudio"
$answer = Read-Host "Also delete your transcripts and settings in $data ? (y/N)"
if ($answer -match '^[yY]') { Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "Downloaded models stay in your Hugging Face cache (%USERPROFILE%\.cache\huggingface). Delete it to free that space." -ForegroundColor Gray
Write-Host "Done." -ForegroundColor Green
