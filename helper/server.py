#!/usr/bin/env python3
"""Verge helper: serves the launcher on your LAN and launches TV apps.

The TV only accepts launch commands on its local MQTT bus (mutual TLS, port
36669). A web page cannot speak that, so this process does it for the page.
Nothing leaves your network.

    python3 helper/server.py

Then open http://<this-machine>:8777/ on the TV.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vidaa_tv as vt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOCS = os.path.join(ROOT, "docs")
CONFIG = os.path.join(HERE, "config.json")
APPS = os.path.join(HERE, "apps.json")
CERT = os.path.join(HERE, "certs", "vidaa_client.pem")
KEY = os.path.join(HERE, "certs", "vidaa_client.key")
PORT = int(os.environ.get("VERGE_PORT", "8777"))


def read_json(path, fallback):
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:
        return fallback


class Controller:
    """Holds the TV connection and turns requests into commands."""

    def __init__(self):
        self.lock = threading.Lock()
        self.tv = None
        self.config = read_json(CONFIG, None)
        self.apps = read_json(APPS, [])
        self.last_error = None
        self.paired = bool(self.config and self.config.get("mac"))

    def _connect(self):
        if self.tv is not None:
            return self.tv
        if not self.paired:
            raise vt.TVError("not paired yet — run: python3 helper/pair.py")
        tv = vt.TV(
            self.config["host"],
            self.config["mac"],
            CERT,
            KEY,
            plain_auth=bool(self.config.get("plain_auth")),
        )
        tv.connect()
        self.tv = tv
        return tv

    def _drop(self):
        if self.tv is not None:
            try:
                self.tv.close()
            except Exception:
                pass
            self.tv = None

    def _reachable(self):
        try:
            with socket.create_connection((self.config["host"], vt.MQTT_PORT), timeout=1.5):
                return True
        except Exception:
            return False

    def status(self):
        with self.lock:
            reachable = self.paired and self._reachable()
            return {
                "paired": self.paired,
                "host": (self.config or {}).get("host"),
                "reachable": reachable,
                "error": self.last_error,
                "apps": self.apps,
            }

    def launch(self, app_id):
        app = None
        for candidate in self.apps:
            if str(candidate.get("appId")) == str(app_id):
                app = candidate
                break
        if app is None:
            raise vt.TVError(f"unknown app id {app_id}")

        with self.lock:
            for attempt in (1, 2):
                try:
                    tv = self._connect()
                    tv.launch(app["appId"], app["name"], app.get("url", ""))
                    self.last_error = None
                    return {"ok": True, "appId": app["appId"], "name": app["name"]}
                except Exception as error:
                    self.last_error = str(error)
                    self._drop()
                    if attempt == 2:
                        raise vt.TVError(str(error))
                    time.sleep(0.4)

    def key(self, key_name):
        with self.lock:
            tv = self._connect()
            tv.send_key(key_name)
            return {"ok": True, "key": key_name}

    def toast(self, message):
        with self.lock:
            tv = self._connect()
            tv.show_message(message)
            return {"ok": True}


CONTROLLER = Controller()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOCS, **kwargs)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            sys.stderr.write(f"[helper] {args[0]}\n")

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/"):
            try:
                if self.path.startswith("/api/status") or self.path.startswith("/api/apps"):
                    return self._json(CONTROLLER.status())
                return self._json({"error": "unknown endpoint"}, 404)
            except Exception as error:
                return self._json({"ok": False, "error": str(error)}, 500)
        if self.path in ("/", "/index.html"):
            self.path = "/launcher.html"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        try:
            if self.path == "/api/launch":
                return self._json(CONTROLLER.launch(body.get("appId")))
            if self.path == "/api/key":
                return self._json(CONTROLLER.key(body.get("key", "KEY_HOME")))
            if self.path == "/api/toast":
                return self._json(CONTROLLER.toast(body.get("message", "Verge")))
            return self._json({"error": "unknown endpoint"}, 404)
        except vt.TVError as error:
            return self._json({"ok": False, "error": str(error)}, 503)
        except Exception as error:
            return self._json({"ok": False, "error": f"{type(error).__name__}: {error}"}, 500)


def main():
    if not os.path.exists(DOCS):
        print(f"missing {DOCS}")
        return 1
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[helper] launcher on http://<this-machine>:{PORT}/")
    if CONTROLLER.paired:
        print(f"[helper] TV {CONTROLLER.config['host']} · {len(CONTROLLER.apps)} apps")
    else:
        print("[helper] NOT PAIRED — run: python3 helper/pair.py")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[helper] stopped")
        CONTROLLER._drop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
