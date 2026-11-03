#Requires -Version 5.1
# Removes this PC's shortcuts and auto-start entry. Everything else lives inside the app folder.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$AppName = "Alamza Word Studio"

try { Invoke-WebRequest -UseBasicParsing -Method Post "http://127.0.0.1:7865/api/quit" -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch { }

foreach ($p in @(
  (Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "$AppName.lnk")
)) { if (Test-Path $p) { Remove-Item $p -Force } }
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "AlamzaWordStudio" -ErrorAction SilentlyContinue
Write-Host "Shortcuts and start-with-Windows removed from this PC." -ForegroundColor Green
Write-Host ""
Write-Host "Everything else (app, models, transcripts) is inside:" -ForegroundColor Gray
Write-Host "  $Root" -ForegroundColor Gray
Write-Host "Delete that folder to remove the app completely." -ForegroundColor Gray
