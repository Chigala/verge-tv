#!/usr/bin/env python3
"""Runs the Verge TV headlines page from this computer.

Serves docs/index.html and builds docs/feeds/<section>.json on request
(cached for 10 minutes), so the page works exactly as it does when hosted.
Standard library only.

Run:  python3 server.py            (listens on port 8787)
      python3 server.py 9000       (custom port)
"""

import os
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import feeds

CACHE_SECONDS = 600
DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")

_cache = {}  # section -> (fetched_at, json_bytes)


def get_section_json(section):
    now = time.time()
    cached = _cache.get(section)
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1]
    try:
        body = feeds.to_json(section, feeds.fetch_section(section)).encode()
    except Exception:
        if cached:  # serve stale headlines rather than an error
            return cached[1]
        raise
    _cache[section] = (now, body)
    return body


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(DOCS, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path.startswith("/feeds/") and path.endswith(".json"):
            section = path[len("/feeds/"):-len(".json")]
            if section not in feeds.FEEDS:
                self._send(404, b'{"error":"unknown section"}', "application/json")
                return
            try:
                self._send(200, get_section_json(section), "application/json; charset=utf-8")
            except Exception as e:
                self._send(502, ('{"error":"%s"}' % str(e).replace('"', "'")).encode(), "application/json")
        else:
            self._send(404, b"Not found", "text/plain")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Verge TV running. On your TV, open:  http://%s:%d" % (local_ip(), port))
    server.serve_forever()
