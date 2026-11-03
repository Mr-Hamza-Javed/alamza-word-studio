"""Desktop entry point: runs the local server and a system-tray icon (no taskbar window)."""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

from . import APP_NAME, autostart
from .config import ASSETS_DIR, load_settings, output_dir
from .runtime import ensure_ffmpeg, ensure_stdio, lan_ip, open_path


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _running_instance(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return json.loads(r.read()).get("app") == APP_NAME
    except Exception:
        return False


def _copy(text: str) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run("clip", input=text.encode("utf-16le"), check=False,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif sys.platform == "darwin":
            subprocess.run("pbcopy", input=text.encode(), check=False)
        else:
            subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode(), check=False)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> None:
    ensure_stdio()
    parser = argparse.ArgumentParser(prog="alamza-word-studio")
    parser.add_argument("--background", action="store_true", help="don't open the browser on start")
    parser.add_argument("--no-tray", action="store_true", help="run without a tray icon (server only)")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args(argv)

    settings = load_settings()
    port = args.port or int(settings.get("port") or 7865)
    host = "0.0.0.0" if settings.get("lan_access") else "127.0.0.1"
    open_browser = settings.get("open_browser_on_start", True) and not args.background

    # Already running? Just open the UI and leave.
    if _running_instance(port):
        webbrowser.open(f"http://127.0.0.1:{port}/")
        return
    while not _port_free(host, port) and port < 65000:
        port += 1

    local_url = f"http://127.0.0.1:{port}/"
    lan = lan_ip() if host == "0.0.0.0" else None
    lan_url = f"http://{lan}:{port}/" if lan else None
    ensure_ffmpeg()

    import uvicorn

    from .server import create_app

    icon_holder: dict = {}

    def notify(title: str, msg: str):
        icon = icon_holder.get("icon")
        if icon is not None and settings.get("notify_on_finish", True):
            try:
                icon.notify(msg, title)
            except Exception:
                pass

    def on_event(evt: dict):
        if evt.get("type") == "finished":
            ok = evt.get("status") == "done"
            notify(APP_NAME, f"{'Finished' if ok else 'Failed'}: {evt.get('name', '')}")

    server_holder: dict = {}

    def quit_all():
        srv = server_holder.get("server")
        if srv:
            srv.should_exit = True
        icon = icon_holder.get("icon")
        if icon is not None:
            try:
                icon.stop()
            except Exception:
                pass

    app = create_app(urls=lambda: {"local": local_url, "lan": lan_url}, on_quit=quit_all, on_event=on_event)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False, log_config=None)
    server = uvicorn.Server(config)
    server_holder["server"] = server

    if args.no_tray:
        if open_browser:
            threading.Timer(1.2, lambda: webbrowser.open(local_url)).start()
        print(f"{APP_NAME} running at {local_url}" + (f"  (LAN: {lan_url})" if lan_url else ""), flush=True)
        try:
            server.run()
        finally:
            app.state.jobs.shutdown()
        return

    server_thread = threading.Thread(target=server.run, name="ws-server", daemon=True)
    server_thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)

    try:
        import pystray
        from PIL import Image
    except Exception:
        # No tray support available: keep serving in the foreground.
        if open_browser:
            webbrowser.open(local_url)
        server_thread.join()
        return

    image = Image.open(ASSETS_DIR / "icon.png")

    def on_open(icon=None, item=None):
        webbrowser.open(local_url)

    def on_copy(icon=None, item=None):
        _copy(local_url)
        notify(APP_NAME, f"Link copied: {local_url}")

    def on_copy_lan(icon=None, item=None):
        if lan_url:
            _copy(lan_url)
            notify(APP_NAME, f"LAN link copied: {lan_url}")

    def on_output(icon=None, item=None):
        folder = output_dir()
        folder.mkdir(parents=True, exist_ok=True)
        open_path(folder)

    def on_autostart(icon, item):
        autostart.set_enabled(not autostart.is_enabled())

    def on_quit(icon, item):
        quit_all()

    items = [
        pystray.MenuItem(f"Open {APP_NAME}", on_open, default=True),
        pystray.MenuItem(f"Copy link  ({local_url.rstrip('/')})", on_copy),
    ]
    if lan_url:
        items.append(pystray.MenuItem(f"Copy LAN link  ({lan_url.rstrip('/')})", on_copy_lan))
    items += [
        pystray.MenuItem("Open output folder", on_output),
        pystray.Menu.SEPARATOR,
    ]
    if autostart.supported():
        items.append(pystray.MenuItem("Start with Windows", on_autostart, checked=lambda item: autostart.is_enabled()))
    items.append(pystray.MenuItem("Quit", on_quit))

    icon = pystray.Icon("AlamzaWordStudio", image, f"{APP_NAME}\n{local_url}", menu=pystray.Menu(*items))
    icon_holder["icon"] = icon

    def setup(icon):
        icon.visible = True
        notify(APP_NAME, f"Running at {local_url}  (click the tray icon to open)")
        if open_browser:
            webbrowser.open(local_url)

    try:
        icon.run(setup=setup)
    finally:
        server.should_exit = True
        app.state.jobs.shutdown()
        server_thread.join(timeout=5)


if __name__ == "__main__":
    main()
