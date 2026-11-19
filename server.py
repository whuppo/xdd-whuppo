#!/usr/bin/env python3
"""Local dev server for xdd.whuppo.

Serves static/ at / and the generated price data at /data/, refreshing the data every
30 minutes with update_data.py, the same script the GitHub Action runs. So the site
behaves the same locally as it does on GitHub Pages.

Run:  python3 server.py  (then open http://localhost:8000)
No third-party dependencies.
"""

import os
import threading
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import update_data

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DATA_DIR = os.path.join(ROOT, "data")
REFRESH_INTERVAL = 30 * 60  # poe.ninja itself caches for 30 minutes


def refresh():
    try:
        update_data.update_all(DATA_DIR, log=lambda msg: print(f"[data] {msg}"))
    except Exception as exc:
        print(f"[data] refresh failed: {exc}")


def refresher():
    while True:
        time.sleep(REFRESH_INTERVAL)
        refresh()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def translate_path(self, path):
        # /data/... comes from the generated data directory; everything else from static/.
        p = urllib.parse.urlparse(path).path
        if p == "/data" or p.startswith("/data/"):
            saved, self.directory = self.directory, DATA_DIR
            try:
                return super().translate_path(p[len("/data"):] or "/")
            finally:
                self.directory = saved
        return super().translate_path(path)

    def end_headers(self):
        # Make browsers revalidate so code and data changes show up without a hard refresh.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet; data refreshes are logged above


def main():
    port = int(os.environ.get("PORT", "8000"))
    print("Fetching prices…")
    refresh()
    threading.Thread(target=refresher, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"xdd.whuppo running at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
