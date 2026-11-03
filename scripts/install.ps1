#Requires -Version 5.1
<#
  Alamza Word Studio - portable setup for Windows.

  Everything goes inside this folder (runtime\, models\, data\, exports\), so the whole
  folder can be copied to another PC and run there without installing anything.

  - Fresh setup: downloads a private Python (~10 MB) and the packages into runtime\
  - Upgrading from the old (non-portable) version: re-uses the packages, models and
    transcripts already on this PC by MOVING them into the folder. Nothing is downloaded
    again and no space is wasted on duplicates.
#>
param(
  [switch]$Update,          # just make sure packages are installed/up to date
  [switch]$NoModel,         # skip pre-downloading the recommended model (fresh setup)
  [switch]$NoLaunch         # don't start the app at the end
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$AppName = "Alamza Word Studio"
$PyDir = Join-Path $Root "runtime\python"
$Py = Join-Path $PyDir "python.exe"
$PyW = Join-Path $PyDir "pythonw.exe"
$DefaultPython = "3.12.10"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Size($path) {
  if (-not (Test-Path $path)) { return 0 }
  $s = (Get-ChildItem $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($s) { return [int64]$s } else { return 0 }
}
function Gb($bytes) { "{0:N2} GB" -f ($bytes / 1GB) }

Write-Host ""
Write-Host "  $AppName setup (portable)" -ForegroundColor Magenta
Write-Host "  Folder: $Root" -ForegroundColor DarkGray

if ($Root -like "$env:ProgramFiles*" -or $Root -like "${env:ProgramFiles(x86)}*") {
  throw "Please move this folder out of 'Program Files' (for example to C:\Apps). Windows doesn't let apps save files there."
}

# ---------------------------------------------------------------- stop a running copy
Step "Closing $AppName if it is running"
try { Invoke-WebRequest -UseBasicParsing -Method Post "http://127.0.0.1:7865/api/quit" -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch { }
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$main = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -like "*AlamzaWordStudio.pyw*" })
$ids = @($main | ForEach-Object { $_.ProcessId })
$kids = @($procs | Where-Object { $ids -contains $_.ParentProcessId })
foreach ($p in ($kids + $main)) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
Ok "Ready"

# ---------------------------------------------------------------- helpers
function Get-EmbedZip([string]$version) {
  $tmp = Join-Path $env:TEMP "python-$version-embed-amd64.zip"
  $url = "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip"
  try {
    Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp
    return $tmp
  } catch {
    # That exact patch has no Windows build: use the newest one of the same 3.x line.
    $mm = ($version -split '\.')[0..1] -join '.'
    $listing = (Invoke-WebRequest -UseBasicParsing "https://www.python.org/ftp/python/").Content
    $patches = [regex]::Matches($listing, "href=`"($([regex]::Escape($mm))\.(\d+))/`"") |
      ForEach-Object { [pscustomobject]@{ V = $_.Groups[1].Value; P = [int]$_.Groups[2].Value } } |
      Sort-Object P -Descending
    foreach ($p in $patches) {
      $url = "https://www.python.org/ftp/python/$($p.V)/python-$($p.V)-embed-amd64.zip"
      try { Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp; Info "Using Python $($p.V)"; return $tmp } catch { }
    }
    throw "Couldn't download Python $mm. Check your internet connection."
  }
}

function Install-EmbeddedPython([string]$version) {
  $zip = Get-EmbedZip $version
  if (Test-Path $PyDir) { Remove-Item $PyDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $PyDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $PyDir -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  # Enable site-packages and let Python find the app's own code (two folders up).
  $pth = Get-ChildItem $PyDir -Filter "python*._pth" | Select-Object -First 1
  $zipName = (Get-ChildItem $PyDir -Filter "python*.zip" | Select-Object -First 1).Name
  Set-Content -Path $pth.FullName -Encoding ASCII -Value @($zipName, ".", "Lib\site-packages", "..\..", "import site")
  New-Item -ItemType Directory -Force -Path (Join-Path $PyDir "Lib\site-packages") | Out-Null
}

function Find-OldVenv {
  $local = Join-Path $Root ".venv"
  if (Test-Path (Join-Path $local "pyvenv.cfg")) { return $local }
  # An older copy installed somewhere else: follow its Start Menu shortcut.
  $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk"
  if (Test-Path $lnk) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath
    if ($target -match '^(.*\\\.venv)\\Scripts\\pythonw?\.exe$' -and (Test-Path (Join-Path $Matches[1] "pyvenv.cfg"))) {
      return $Matches[1]
    }
  }
  return $null
}

# ---------------------------------------------------------------- Python runtime
$freshInstall = $false
$hadShortcuts = Test-Path (Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk")

if (Test-Path $Py) {
  Step "Portable Python found in runtime\python"
} else {
  $oldVenv = Find-OldVenv
  if ($oldVenv) {
    Step "Converting your existing installation to portable (no packages will be downloaded again)"
    $cfg = Get-Content (Join-Path $oldVenv "pyvenv.cfg") -Raw
    if ($cfg -match '(?m)^\s*version(?:_info)?\s*=\s*(\d+\.\d+\.\d+)') { $ver = $Matches[1] } else { $ver = $DefaultPython }
    Info "Your packages were built for Python $ver. Getting the matching portable Python (~10 MB)..."
    Install-EmbeddedPython $ver
  } else {
    Step "Downloading a private Python $DefaultPython (~10 MB)"
    Install-EmbeddedPython $DefaultPython
    $getPip = Join-Path $env:TEMP "get-pip.py"
    Invoke-WebRequest -UseBasicParsing "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    & $Py $getPip --no-warn-script-location --no-cache-dir | Out-Null
    Remove-Item $getPip -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw "Couldn't set up pip." }
    $freshInstall = $true
  }
}
Ok ("Python " + (& $Py -c "import sys; print(sys.version.split()[0])"))

# Move packages out of the old .venv (also finishes a move that was interrupted earlier).
$oldVenv = Find-OldVenv
if ($oldVenv) {
  $oldSite = Join-Path $oldVenv "Lib\site-packages"
  $newSite = Join-Path $PyDir "Lib\site-packages"
  if (Test-Path $oldSite) {
    Info ("Moving installed packages ({0}) from {1}..." -f (Gb (Size $oldSite)), $oldVenv)
    Get-ChildItem $oldSite -Force | ForEach-Object {
      $dest = Join-Path $newSite $_.Name
      if (Test-Path $dest) { Remove-Item $_.FullName -Recurse -Force } else { Move-Item $_.FullName $newSite -Force }
    }
  }
  Remove-Item $oldVenv -Recurse -Force
  Ok "Packages moved into runtime\python and the old .venv was removed"
  $oldRoot = Split-Path -Parent $oldVenv
  if ($oldRoot -ne $Root) { $script:OldAppFolder = $oldRoot }
}

# ---------------------------------------------------------------- packages
if ($freshInstall) {
  Step "Installing WhisperX and app components (5-10 minutes, ~2 GB)"
} else {
  Step "Checking app components (downloads only what's missing)"
}
& $Py -m pip install -r (Join-Path $Root "requirements.txt") --extra-index-url https://download.pytorch.org/whl/cpu `
  --no-cache-dir --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw "Package installation failed. Check your internet connection and run install.bat again." }
Ok "Components ready"

# ---------------------------------------------------------------- move old data & models into the folder
Step "Moving your transcripts and downloaded models into the app folder"
& $Py -m wordstudio.migrate
if ($LASTEXITCODE -ne 0) { Warn "Some items couldn't be moved. The app will try again when it starts." }

Step "Preparing FFmpeg and word-alignment data"
& $Py -c "from wordstudio.runtime import ensure_ffmpeg; print('    FFmpeg:', 'ready' if ensure_ffmpeg() else 'MISSING')"
& $Py -c "import wordstudio, nltk; from wordstudio.config import NLTK_DIR; nltk.download('punkt_tab', download_dir=str(NLTK_DIR), quiet=True); print('    Sentence data ready')"

if ($freshInstall -and -not $NoModel) {
  Step "Downloading the recommended model (Distil Large v3, ~1.5 GB) and the word aligner"
  Info "Models also download automatically on first use, so this step is optional."
  & $Py -c "import wordstudio; from faster_whisper import download_model; download_model('distil-large-v3'); print('    Model ready')"
  & $Py -c "import wordstudio, torchaudio; torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_model(); print('    Aligner ready')"
}

# ---------------------------------------------------------------- clean up pip's download cache
$pipCache = Join-Path $env:LOCALAPPDATA "pip\cache"
$cacheSize = Size $pipCache
if ($cacheSize -gt 50MB) {
  Step ("Removing pip's download cache ({0})" -f (Gb $cacheSize))
  Info "These are only copies of already-installed downloads; nothing stops working."
  try { & $Py -m pip cache purge *> $null } catch { }
  Ok "Freed space"
}

# ---------------------------------------------------------------- shortcuts / autostart
if ($hadShortcuts) {
  # Re-create them so they point at the portable Python (old ones pointed at .venv).
  Step "Updating Start Menu and Desktop shortcuts"
  & $Py -m wordstudio.autostart shortcuts
} elseif (-not $Update) {
  $answer = Read-Host "    Add $AppName to the Start Menu and Desktop on this PC? (Y/n)"
  if ($answer -notmatch '^[nN]') {
    Step "Creating Start Menu and Desktop shortcuts"
    & $Py -m wordstudio.autostart shortcuts
  }
}
if ($freshInstall -and -not $Update) {
  $answer = Read-Host "    Start $AppName automatically when Windows starts? (Y/n)"
  if ($answer -notmatch '^[nN]') {
    & $Py -m wordstudio.autostart autostart-on
    & $Py -c "from wordstudio.config import save_settings; save_settings({'start_with_windows': True})"
    Ok "Will start with Windows (in the tray, near the clock)"
  }
}

if ($script:OldAppFolder -and (Test-Path $script:OldAppFolder)) {
  Write-Host ""
  Warn "The old app folder is no longer needed: $($script:OldAppFolder)"
  $answer = Read-Host "    Delete it? (y/N)"
  if ($answer -match '^[yY]') { Remove-Item $script:OldAppFolder -Recurse -Force -ErrorAction SilentlyContinue; Ok "Deleted" }
}

$total = (Size (Join-Path $Root "runtime")) + (Size (Join-Path $Root "models")) + (Size (Join-Path $Root "data"))
Write-Host ""
Write-Host "  All set! Everything is inside this folder ($(Gb $total))." -ForegroundColor Green
Write-Host "  To use it on another PC, copy the whole folder and double-click 'Alamza Word Studio.cmd'." -ForegroundColor Gray
Write-Host "  The app runs in the system tray (bottom-right, near the clock). Link: http://127.0.0.1:7865/" -ForegroundColor Gray

if (-not $NoLaunch) {
  Start-Process -FilePath $PyW -ArgumentList "`"$(Join-Path $Root 'AlamzaWordStudio.pyw')`"" -WorkingDirectory $Root
}
