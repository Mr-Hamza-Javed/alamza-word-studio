"""Runtime helpers: bundled ffmpeg, system info, safe stdio for pythonw."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path

from .config import BIN_DIR, LOG_DIR


def ensure_stdio(log_name: str = "wordstudio.log") -> None:
    """pythonw.exe has no console, so sys.stdout/stderr are None. Point them at a log file."""
    if sys.stdout is None or sys.stderr is None:
        log = open(LOG_DIR / log_name, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log


def ensure_ffmpeg() -> str | None:
    """Make an `ffmpeg` executable available on PATH. WhisperX shells out to it."""
    exe_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    local = BIN_DIR / exe_name
    if str(BIN_DIR) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = str(BIN_DIR) + os.pathsep + os.environ.get("PATH", "")
    if local.exists():
        return str(local)
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore

        src = Path(imageio_ffmpeg.get_ffmpeg_exe())
        shutil.copy2(src, local)
        if sys.platform != "win32":
            local.chmod(0o755)
        return str(local)
    except Exception:
        return None


def _cpu_name() -> str:
    try:
        if sys.platform == "win32":
            import winreg  # type: ignore

            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
        if sys.platform == "darwin":
            return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        with open("/proc/cpuinfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or "Unknown CPU"


_STATIC: dict | None = None


def system_info() -> dict:
    global _STATIC
    import psutil  # type: ignore

    if _STATIC is None:
        _STATIC = {
            "cpu": _cpu_name(),
            "cores": psutil.cpu_count(logical=False) or os.cpu_count() or 1,
            "threads": psutil.cpu_count(logical=True) or os.cpu_count() or 1,
            "ram_total": psutil.virtual_memory().total,
            "os": f"{platform.system()} {platform.release()}",
            "python": platform.python_version(),
            "ffmpeg": bool(ensure_ffmpeg()),
        }
    vm = psutil.virtual_memory()
    return {
        **_STATIC,
        "cpu_percent": psutil.cpu_percent(interval=None),
        "ram_used": vm.total - vm.available,
        "ram_percent": vm.percent,
    }


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def open_path(path: Path) -> None:
    path = Path(path)
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def reveal_file(path: Path) -> None:
    path = Path(path)
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(path)])
    else:
        open_path(path.parent)
