#!/usr/bin/env python3
"""Install a web app onto a Hisense VIDAA TV from this computer.

VIDAA only exposes its Hisense_installApp() function to pages loaded from
vidaahub.com. This script makes your TV believe this computer *is*
vidaahub.com, for as long as the TV's DNS points here:

  * DNS server (port 53): answers vidaahub.com with this computer's IP and
    forwards every other lookup to a normal public resolver, so the TV's
    internet keeps working during the install.
  * Web server (ports 80 and 443): serves a remote-friendly install page.

Same approach as github.com/camellan/vidaa-appstore, rewritten here with the
standard library only. Needs admin rights because ports 53/80/443 are
privileged:

  sudo python3 vidaa_installer.py                          (installs Verge Headlines)
  sudo python3 vidaa_installer.py --app-url <url> --name <name>   (any other web app)

Stop it with Ctrl+C once the app is installed, and set the TV's DNS back to
automatic.
"""

import argparse
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, "certs")
BACKUP_DIR = os.path.join(HERE, "backups")
HOSTNAMES = {"vidaahub.com", "www.vidaahub.com"}

DEFAULT_APP_URL = "https://chigala.github.io/verge-tv/"
DEFAULT_ICON = ("https://platform.theverge.com/wp-content/uploads/sites/2/2025/01/"
                "verge-rss-large_80b47e.png?w=300&h=300&crop=1")


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


# ---------------------------------------------------------------- DNS

def _parse_question(data):
    """Returns (name, qtype, end_offset) for the first question in a query."""
    i, labels = 12, []
    while True:
        length = data[i]
        if length == 0:
            i += 1
            break
        if length & 0xC0:  # compression pointers never appear in a query's question
            raise ValueError("unexpected pointer")
        labels.append(data[i + 1:i + 1 + length].decode("ascii", "replace"))
        i += 1 + length
    qtype, _qclass = struct.unpack("!HH", data[i:i + 4])
    return ".".join(labels).lower(), qtype, i + 4


def _local_answer(query, q_end, qtype, ip):
    tid = query[:2]
    question = query[12:q_end]
    if qtype == 1:  # A record
        answer = (b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + socket.inet_aton(ip))
        ancount = 1
    else:           # AAAA etc.: "no such record", so the TV falls back to IPv4
        answer, ancount = b"", 0
    header = tid + struct.pack("!HHHHH", 0x8180, 1, ancount, 0, 0)
    return header + question + answer


def open_dns_socket():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 53))
    return sock


def run_dns(sock, ip, upstream):
    def handle(data, addr):
        try:
            name, qtype, q_end = _parse_question(data)
        except Exception:
            return
        if name in HOSTNAMES:
            log("  DNS  %s asked for %s -> answering with this computer" % (addr[0], name))
            sock.sendto(_local_answer(data, q_end, qtype, ip), addr)
            return
        fwd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        fwd.settimeout(4)
        try:
            fwd.sendto(data, (upstream, 53))
            sock.sendto(fwd.recvfrom(4096)[0], addr)
        except OSError:
            pass  # the TV will retry
        finally:
            fwd.close()

    while True:
        data, addr = sock.recvfrom(4096)
        threading.Thread(target=handle, args=(data, addr), daemon=True).start()


# ---------------------------------------------------------------- web

def ensure_cert():
    key = os.path.join(CERT_DIR, "vidaahub.com.key")
    crt = os.path.join(CERT_DIR, "vidaahub.com.crt")
    if not (os.path.exists(key) and os.path.exists(crt)):
        os.makedirs(CERT_DIR, exist_ok=True)
        subprocess.check_call([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-days", "3650", "-keyout", key, "-out", crt,
            "-subj", "/CN=vidaahub.com",
            "-addext", "subjectAltName=DNS:vidaahub.com,DNS:www.vidaahub.com",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return crt, key


def make_handler(page_bytes):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/log":  # the install page reports results here
                msg = parse_qs(url.query).get("m", [""])[0]
                log("  TV   " + msg[:500])
                self._send(204, b"", "text/plain")
            elif url.path == "/original-appinfo":
                # The OLDEST app-list backup, i.e. the TV's list before we changed anything.
                backups = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("appinfo-backup-")) \
                    if os.path.isdir(BACKUP_DIR) else []
                if not backups:
                    self._send(404, b"No backup yet", "text/plain")
                    return
                with open(os.path.join(BACKUP_DIR, backups[0]), "rb") as f:
                    log("  WEB  TV fetched original backup %s" % backups[0])
                    self._send(200, f.read(), "text/plain; charset=utf-8")
            elif url.path in ("/", "/index.html"):
                log("  WEB  %s opened the install page" % self.client_address[0])
                self._send(200, page_bytes, "text/html; charset=utf-8")
            else:
                self._send(404, b"Not found", "text/plain")

        def do_POST(self):
            # The install page saves TV data here (e.g. a backup of the app list).
            url = urlparse(self.path)
            if url.path != "/save":
                self._send(404, b"Not found", "text/plain")
                return
            name = parse_qs(url.query).get("name", ["data"])[0]
            name = "".join(ch for ch in name if ch.isalnum() or ch in "-_") or "data"
            length = min(int(self.headers.get("Content-Length", 0)), 5 * 1024 * 1024)
            body = self.rfile.read(length)
            os.makedirs(BACKUP_DIR, exist_ok=True)
            path = os.path.join(BACKUP_DIR, "%s-%s.txt" % (name, time.strftime("%Y%m%d-%H%M%S")))
            with open(path, "wb") as f:
                f.write(body)
            log("  SAVE %d bytes from the TV -> %s" % (len(body), os.path.relpath(path, HERE)))
            self._send(204, b"", "text/plain")

        def log_message(self, *args):
            pass

    return Handler


def make_web_server(handler, port, cert=None):
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    if cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*cert)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    return server


def build_page(app):
    with open(os.path.join(HERE, "install.html"), encoding="utf-8") as f:
        page = f.read()
    return page.replace("__APP_JSON__", json.dumps(app)).encode("utf-8")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app-url", default=DEFAULT_APP_URL, help="web address of the app to install")
    ap.add_argument("--name", default="Verge Headlines", help="name shown in the TV's Apps list")
    ap.add_argument("--icon", default=DEFAULT_ICON, help="PNG icon URL, 220-400px square")
    ap.add_argument("--ip", default=None, help="this computer's LAN IP (auto-detected)")
    ap.add_argument("--upstream", default="1.1.1.1", help="resolver for every other lookup")
    args = ap.parse_args()

    if hasattr(os, "geteuid") and os.geteuid() != 0:
        sys.exit("Please run with sudo (ports 53, 80 and 443 need admin rights):\n"
                 "  sudo python3 %s" % sys.argv[0])

    ip = args.ip or local_ip()
    app = {
        "id": "".join(ch for ch in args.name if ch.isalnum()) + "debug",
        "name": args.name,
        "url": args.app_url,
        "icon": args.icon,
    }
    handler = make_handler(build_page(app))
    cert = ensure_cert()

    # Bind everything up front so a busy port fails loudly here.
    try:
        http_server = make_web_server(handler, 80)
        https_server = make_web_server(handler, 443, cert)
        dns_sock = open_dns_socket()
    except OSError as e:
        sys.exit("Couldn't start (%s). Is another DNS or web server already running on this computer?" % e)
    for target, a in ((http_server.serve_forever, ()), (https_server.serve_forever, ()),
                      (run_dns, (dns_sock, ip, args.upstream))):
        threading.Thread(target=target, args=a, daemon=True).start()

    log("")
    log("VIDAA installer running")
    log("  App:  %s  ->  %s" % (app["name"], app["url"]))
    log("")
    log("On the TV:")
    log("  1. Set DNS Server 1 to   %s" % ip)
    log("  2. In the TV Browser open   https://vidaahub.com   (accept the certificate warning)")
    log("  3. Press Install")
    log("  4. Set the TV's DNS back to automatic, then restart the TV")
    log("")
    log("Activity from the TV appears below. Press Ctrl+C here when you're done.")
    log("")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        log("\nStopped. Remember to set the TV's DNS back to automatic.")


if __name__ == "__main__":
    main()
