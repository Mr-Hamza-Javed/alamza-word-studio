"""Start-with-Windows support (per-user Run registry key) and Start Menu / Desktop shortcuts."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .config import ASSETS_DIR, ROOT_DIR

_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_NAME = "AlamzaWordStudio"
APP_NAME = "Alamza Word Studio"


def pythonw() -> Path:
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    return pyw if pyw.exists() else exe


def launcher() -> Path:
    return ROOT_DIR / "AlamzaWordStudio.pyw"


def command() -> str:
    return f'"{pythonw()}" "{launcher()}" --background'


def supported() -> bool:
    return sys.platform == "win32"


def current_command() -> str | None:
    if not supported():
        return None
    import winreg  # type: ignore

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _KEY) as key:
            return winreg.QueryValueEx(key, _NAME)[0]
    except OSError:
        return None


def is_enabled() -> bool:
    return current_command() is not None


def set_enabled(enabled: bool) -> bool:
    if not supported():
        return False
    import winreg  # type: ignore

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, _NAME, 0, winreg.REG_SZ, command())
        else:
            try:
                winreg.DeleteValue(key, _NAME)
            except OSError:
                pass
    return True


def refresh() -> None:
    """If the folder was moved/copied, point the auto-start entry at this copy."""
    try:
        if supported() and is_enabled() and current_command() != command():
            set_enabled(True)
    except Exception:
        pass


# ---------------------------------------------------------------- shortcuts
def _shortcut_paths() -> list[Path]:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    programs = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    desktop = Path(os.environ.get("USERPROFILE") or Path.home()) / "Desktop"
    try:  # Desktop may be redirected (e.g. OneDrive)
        import ctypes
        from ctypes import wintypes

        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x0000, None, 0, buf) == 0:  # CSIDL_DESKTOP
            desktop = Path(buf.value)
    except Exception:
        pass
    return [programs / f"{APP_NAME}.lnk", desktop / f"{APP_NAME}.lnk"]


def shortcuts_exist() -> bool:
    return supported() and any(p.exists() for p in _shortcut_paths())


def create_shortcuts() -> list[str]:
    if not supported():
        return []
    made = []
    for lnk in _shortcut_paths():
        lnk.parent.mkdir(parents=True, exist_ok=True)
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AWS_LNK);"
            "$s.TargetPath=$env:AWS_TARGET;$s.Arguments=$env:AWS_ARGS;$s.WorkingDirectory=$env:AWS_DIR;"
            "$s.IconLocation=$env:AWS_ICON;$s.Description='Offline word-level transcription';$s.Save()"
        )
        env = dict(os.environ, AWS_LNK=str(lnk), AWS_TARGET=str(pythonw()), AWS_ARGS=f'"{launcher()}"',
                   AWS_DIR=str(ROOT_DIR), AWS_ICON=str(ASSETS_DIR / "icon.ico"))
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], env=env,
                           capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode == 0:
            made.append(str(lnk))
    return made


def remove_shortcuts() -> None:
    for p in _shortcut_paths():
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    # Used by install.ps1:  python -m wordstudio.autostart shortcuts|autostart-on|autostart-off|remove
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "shortcuts":
        for p in create_shortcuts():
            print(f"    Created {p}")
    elif arg == "autostart-on":
        set_enabled(True)
    elif arg == "autostart-off":
        set_enabled(False)
    elif arg == "remove":
        remove_shortcuts()
        set_enabled(False)
