"""Ice Thickness Measurement Tool — local launcher.

Serves the bundled web app on a free localhost port and opens it in the
default browser. Nothing is sent anywhere: the server binds to 127.0.0.1 and
only serves the files inside the app folder.

Usage:
    python launcher.py                 # serve on the first free port and open the browser
    python launcher.py --port 9000     # a specific port
    python launcher.py --no-browser    # do not open a browser

When packaged with PyInstaller (see build_exe.bat) this becomes a single
IceThickness.exe that does the same thing.
"""
import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import webbrowser

APP_TITLE = "Ice Thickness Measurement Tool"
DEFAULT_PORT = 8765


def app_dir():
    """Folder holding index.html: the PyInstaller temp dir when frozen."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    # accept the app either bundled under "webapp/" or at the root
    for candidate in (os.path.join(base, "webapp"), base):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    return base


def free_port(preferred):
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return 0        # let the OS choose


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=app_dir(), **kwargs)

    def log_message(self, *args):
        pass                                    # keep the console quiet

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    folder = app_dir()
    if not os.path.isfile(os.path.join(folder, "index.html")):
        print("ERROR: index.html not found next to the launcher.", file=sys.stderr)
        input("Press Enter to close.")
        return 1

    port = free_port(args.port)
    httpd = Server(("127.0.0.1", port), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{port}/"
    print("=" * 64)
    print(f"  {APP_TITLE}")
    print(f"  Running at {url}")
    print("  Images never leave this computer.")
    print("  Close this window (or press Ctrl+C) to stop the tool.")
    print("=" * 64)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
