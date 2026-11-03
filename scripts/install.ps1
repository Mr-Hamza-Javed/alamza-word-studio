#Requires -Version 5.1
<#
  Alamza Word Studio - one-click setup for Windows.
  - Finds (or installs) Python 3.10-3.13
  - Creates a private virtual environment in .venv
  - Installs WhisperX (CPU) and the app's dependencies
  - Prepares FFmpeg and word-alignment data
  - Creates Start Menu + Desktop shortcuts that launch the app in the system tray
#>
param(
  [switch]$Update,          # re-run dependency install only, keep shortcuts/settings
  [switch]$NoModel,         # skip pre-downloading the recommended model
  [switch]$NoLaunch         # don't start the app at the end
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$AppName = "Alamza Word Studio"
$Venv = Join-Path $Root ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"
$PyW = Join-Path $Venv "Scripts\pythonw.exe"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  $AppName setup" -ForegroundColor Magenta
Write-Host "  Private, offline, word-level transcription" -ForegroundColor DarkGray

# ---------------------------------------------------------------- Python
function Find-Python {
  $candidates = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($v in "3.12", "3.11", "3.13", "3.10") { $candidates += ,@("py", "-$v") }
  }
  foreach ($exe in "python", "python3") {
    if (Get-Command $exe -ErrorAction SilentlyContinue) { $candidates += ,@($exe) }
  }
  foreach ($c in $candidates) {
    try {
      $pa = @()
      if ($c.Count -gt 1) { $pa = $c[1..($c.Count - 1)] }
      $ver = & $c[0] @pa -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0 -and $ver -match '^3\.(1[0-3])$') { return ,$c }
    } catch { }
  }
  return $null
}

if (-not (Test-Path $Py)) {
  Step "Looking for Python 3.10 - 3.13"
  $python = Find-Python
  if (-not $python) {
    Warn "Python not found. Installing Python 3.12 with winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw "winget is not available. Install Python 3.12 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run install.bat again."
    }
    winget install --id Python.Python.3.12 -e --scope user --accept-package-agreements --accept-source-agreements | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
    $python = Find-Python
    if (-not $python) { throw "Python was installed but isn't on PATH yet. Close this window and run install.bat again." }
  }
  $pyArgs = @()
  if ($python.Count -gt 1) { $pyArgs = $python[1..($python.Count - 1)] }
  Ok ("Using " + (& $python[0] @pyArgs --version))

  Step "Creating private Python environment (.venv)"
  & $python[0] @pyArgs -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw "Could not create the virtual environment." }
}

# ---------------------------------------------------------------- Packages
Step "Installing WhisperX and app components (first time: 5-10 minutes, ~2 GB)"
& $Py -m pip install --upgrade pip --quiet --disable-pip-version-check
& $Py -m pip install -r (Join-Path $Root "requirements.txt") --extra-index-url https://download.pytorch.org/whl/cpu --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "Package installation failed. Check your internet connection and run install.bat again." }
Ok "Packages installed"

Step "Preparing FFmpeg and word-alignment data"
& $Py -c "import sys; sys.path.insert(0, r'$Root'); from wordstudio.runtime import ensure_ffmpeg; p = ensure_ffmpeg(); print('    FFmpeg:', p or 'MISSING')"
& $Py -c "import nltk; [nltk.download(r, quiet=True) for r in ('punkt_tab', 'punkt')]; print('    NLTK data ready')"

if (-not $NoModel -and -not $Update) {
  Step "Downloading the recommended model (Distil Large v3, ~1.5 GB) and the word aligner"
  Write-Host "    You can skip this with Ctrl+C; models also download on first use." -ForegroundColor DarkGray
  try {
    & $Py -c "from faster_whisper import download_model; download_model('distil-large-v3'); print('    Model ready')"
    & $Py -c "import torchaudio; torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_model(); print('    Aligner ready')"
  } catch { Warn "Model download skipped: $_" }
}

# ---------------------------------------------------------------- Shortcuts
if (-not $Update) {
  Step "Creating Start Menu and Desktop shortcuts"
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "$AppName.lnk")
  )
  foreach ($lnkPath in $targets) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $PyW
    $lnk.Arguments = "`"$(Join-Path $Root 'AlamzaWordStudio.pyw')`""
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = (Join-Path $Root "assets\icon.ico")
    $lnk.Description = "Offline word-level transcription"
    $lnk.Save()
  }
  Ok "Shortcuts created"

  $answer = Read-Host "    Start $AppName automatically when Windows starts? (Y/n)"
  if ($answer -notmatch '^[nN]') {
    & $Py -c "import sys; sys.path.insert(0, r'$Root'); from wordstudio import autostart; from wordstudio.config import save_settings; autostart.set_enabled(True); save_settings({'start_with_windows': True})"
    Ok "Will start with Windows (in the tray, near the clock)"
  }
}

Write-Host ""
Write-Host "  All set!" -ForegroundColor Green
Write-Host "  $AppName runs in the system tray (bottom-right, near the clock)." -ForegroundColor Gray
Write-Host "  Click its icon to open the app; right-click for more options." -ForegroundColor Gray
Write-Host "  Link: http://127.0.0.1:7865/" -ForegroundColor Gray

if (-not $NoLaunch) {
  Start-Process -FilePath $PyW -ArgumentList "`"$(Join-Path $Root 'AlamzaWordStudio.pyw')`"" -WorkingDirectory $Root
}
