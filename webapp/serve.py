#!/usr/bin/env python3
"""Serve the Ice Thickness web tool on your local network.

Usage:
    python serve.py [port]

Default port is 8000. Press Ctrl+C to stop.
"""
import functools
import http.server
import os
import socket
import socketserver
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def log_message(self, fmt, *args):  # keep the console tidy
        pass


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def main():
    try:
        with ThreadingServer(("", PORT), QuietHandler) as httpd:
            host = socket.gethostname()
            print("Ice Thickness Measurement Tool")
            print(f"  Local:   http://localhost:{PORT}")
            print(f"  Network: http://{host}:{PORT}")
            print("Press Ctrl+C to stop.")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
