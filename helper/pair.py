#!/usr/bin/env python3
"""One-time pairing with a Hisense VIDAA TV.

The TV pops a 4-digit PIN; feed it back and this machine is authorised to
launch apps. The authorisation is bound to the TV MAC, so it survives reboots
and needs no token. Run this again only if you change machine identity.

    python3 helper/pair.py --host <tv-ip>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vidaa_tv as vt

HERE = os.path.dirname(os.path.abspath(__file__))
PIN_FILE = os.path.join(HERE, ".pin")
CONFIG = os.path.join(HERE, "config.json")


def log(message):
    print(f"[pair] {message}", flush=True)


def read_pin():
    """Wait for a PIN from helper/.pin, then from stdin as a fallback."""
    log("PIN_REQUESTED — type the 4 digits from the TV into helper/.pin")
    deadline = time.time() + 120
    while time.time() < deadline:
        if os.path.exists(PIN_FILE):
            with open(PIN_FILE) as handle:
                pin = handle.read().strip()
            try:
                os.unlink(PIN_FILE)
            except OSError:
                pass
            if pin:
                log(f"PIN_SUBMITTED {pin}")
                return pin
        if sys.stdin and sys.stdin.isatty():
            try:
                return input("PIN: ").strip()
            except EOFError:
                return ""
        time.sleep(0.2)
    raise vt.TVError("no PIN arrived within 120 seconds")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="192.168.1.58")
    parser.add_argument("--mac", default=None)
    parser.add_argument("--plain", action="store_true", help="older plain credential scheme")
    args = parser.parse_args()

    cert = os.path.join(HERE, "certs", "vidaa_client.pem")
    key = os.path.join(HERE, "certs", "vidaa_client.key")
    for path in (cert, key):
        if not os.path.exists(path):
            log(f"missing {path} — run helper/setup_certs.sh first")
            return 2

    mac = args.mac or vt.local_mac(args.host)
    if not mac:
        log("could not read the TV's MAC address; pass --mac")
        return 2
    log(f"TV {args.host} · mac {mac}")

    tv = vt.TV(args.host, mac, cert, key, plain_auth=args.plain)
    try:
        tv.connect()
    except vt.TVError as error:
        log(f"connect failed: {error}")
        return 1
    log("connected to the TV broker")

    try:
        tv.pair(read_pin)
    except vt.TVError as error:
        log(f"pairing failed: {error}")
        tv.close()
        return 1

    # A toast is the only acknowledgement this firmware gives us.
    tv.show_message("Verge connected. Launcher ready.", "Verge", 8)
    time.sleep(0.5)
    tv.close()

    config = {
        "host": args.host,
        "mac": mac,
        "client_id": tv.client_id,
        "plain_auth": args.plain,
        "paired_at": int(time.time()),
    }
    with open(CONFIG, "w") as handle:
        json.dump(config, handle, indent=2)

    log("PAIRED")
    log("you should have seen a 'Verge connected' toast on the TV")
    log(f"saved {CONFIG}")
    log("next: python3 helper/server.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
