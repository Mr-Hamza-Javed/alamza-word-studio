"""Start-with-Windows support (per-user Run registry key)."""

from __future__ import annotations

import sys
from pathlib import Path

from .config import ROOT_DIR

_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_NAME = "AlamzaWordStudio"


def _command() -> str:
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    if pyw.exists():
        exe = pyw
    return f'"{exe}" "{ROOT_DIR / "AlamzaWordStudio.pyw"}" --background'


def supported() -> bool:
    return sys.platform == "win32"


def is_enabled() -> bool:
    if not supported():
        return False
    import winreg  # type: ignore

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _KEY) as key:
            winreg.QueryValueEx(key, _NAME)
            return True
    except OSError:
        return False


def set_enabled(enabled: bool) -> bool:
    if not supported():
        return False
    import winreg  # type: ignore

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, _NAME, 0, winreg.REG_SZ, _command())
        else:
            try:
                winreg.DeleteValue(key, _NAME)
            except OSError:
                pass
    return True
