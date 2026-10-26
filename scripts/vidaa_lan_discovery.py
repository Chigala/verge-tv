#!/usr/bin/env python3
"""Read-only DIAL and CDP discovery for a VIDAA TV on the local network.

Sends SSDP M-SEARCH requests and HTTP GET metadata requests only. It never
launches an app, sends a DIAL POST, opens a CDP WebSocket, or emits identifiers.
"""

import argparse
import ipaddress
import json
import re
import socket
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

SSDP_MULTICAST = ("239.255.255.250", 1900)
MAX_METADATA_BYTES = 1024 * 1024


def clean(value, limit=160):
    text = str(value)
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[redacted-ip]", text)
    text = re.sub(r"\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b", "[redacted-mac]", text, flags=re.I)
    text = re.sub(r"\b(?:[0-9a-f]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})\b", "[redacted-token]", text)
    return text[:limit]


def local_http_url(value):
    try:
        from urllib.parse import urlparse
        parsed = urlparse(value)
        address = ipaddress.ip_address(parsed.hostname or "")
        if parsed.scheme != "http" or not (address.is_private or address.is_loopback or address.is_link_local):
            return None
        return value
    except (ValueError, TypeError):
        return None


def http_get(url, timeout):
    safe_url = local_http_url(url)
    if not safe_url:
        return {"ok": False, "error": "Skipped non-local or non-HTTP metadata URL"}

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    request = urllib.request.Request(safe_url, headers={"User-Agent": "Verge-ReadOnly-Diagnostic/1.0"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_METADATA_BYTES + 1)
            return {"ok": 200 <= response.status < 300, "status": response.status, "body": body[:MAX_METADATA_BYTES]}
    except urllib.error.HTTPError as error:
        return {"ok": False, "status": error.code, "error": "HTTP metadata request rejected"}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        return {"ok": False, "error": clean(reason, 100)}


def parse_headers(payload):
    headers = {}
    try:
        lines = payload.decode("utf-8", errors="replace").split("\r\n")
    except AttributeError:
        return headers
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return headers


def ssdp_discover(tv_ip, timeout, wait):
    endpoints = [SSDP_MULTICAST]
    if tv_ip:
        endpoints.insert(0, (tv_ip, 1900))
    request = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1900\r\n"
        "MAN: \"ssdp:discover\"\r\n"
        "MX: 2\r\n"
        "ST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n"
    ).encode("ascii")
    found = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.4)
    try:
        for endpoint in endpoints:
            try:
                sock.sendto(request, endpoint)
            except OSError as error:
                print("SSDP send skipped: " + clean(error, 100))
        import time
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            try:
                payload, _ = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            headers = parse_headers(payload)
            location = local_http_url(headers.get("location", ""))
            if location:
                found[location] = headers
    finally:
        sock.close()
    return found


def inspect_dial(found, timeout):
    if not found:
        print("DIAL: no SSDP response with readable local metadata")
        return
    print("DIAL devices discovered: " + str(len(found)))
    for index, headers in enumerate(found.values(), 1):
        location = headers.get("location")
        app_url = local_http_url(headers.get("application-url", ""))
        print("Device " + str(index) + ":")
        print("  DIAL application endpoint advertised: " + ("yes" if app_url else "no"))
        metadata = http_get(location, timeout)
        print("  Device metadata GET: " + (str(metadata.get("status")) if metadata.get("ok") else "unavailable"))
        if metadata.get("ok"):
            try:
                root = ET.fromstring(metadata["body"])
                print("  Metadata XML readable: yes (" + clean(root.tag.split("}")[-1], 50) + ")")
            except (ET.ParseError, KeyError):
                print("  Metadata XML readable: no")
        if app_url:
            dial = http_get(app_url, timeout)
            print("  DIAL metadata GET: " + (str(dial.get("status")) if dial.get("ok") else "unavailable"))
        print("  Launch command sent: no")


def inspect_cdp(tv_ip, timeout):
    if not tv_ip:
        print("CDP LAN: skipped (supply --tv-ip)")
        return
    base = "http://" + tv_ip + ":9223"
    version = http_get(base + "/json/version", timeout)
    targets = http_get(base + "/json", timeout)
    if not version.get("ok") and not targets.get("ok"):
        print("CDP LAN: unavailable, blocked, or not listening on port 9223")
        return
    print("CDP LAN: metadata reachable")
    if version.get("ok"):
        try:
            info = json.loads(version["body"].decode("utf-8", errors="replace"))
            print("  Browser: " + clean(info.get("Browser", "unknown"), 80))
            print("  Protocol: " + clean(info.get("Protocol-Version", "unknown"), 30))
        except (ValueError, AttributeError):
            print("  Version metadata: unreadable JSON")
    if targets.get("ok"):
        try:
            items = json.loads(targets["body"].decode("utf-8", errors="replace"))
            pages = [item for item in items if isinstance(item, dict) and item.get("type") == "page"]
            launcher = any(re.search(r"hisenseUI|index\.html", str(item.get("url", "")), re.I) for item in pages)
            print("  Debug targets: " + str(len(items)))
            print("  Launcher-like target: " + ("yes" if launcher else "no"))
            print("  CDP commands sent: no")
        except (ValueError, TypeError):
            print("  Target metadata: unreadable JSON")


def main():
    parser = argparse.ArgumentParser(description="Read-only VIDAA DIAL/CDP discovery; never launches apps")
    parser.add_argument("--tv-ip", help="TV IPv4/IPv6 address for unicast SSDP and CDP GET checks")
    parser.add_argument("--timeout", type=float, default=3.0, help="HTTP timeout in seconds (default: 3)")
    parser.add_argument("--wait", type=float, default=4.0, help="SSDP listen time in seconds (default: 4)")
    parser.add_argument("--skip-ssdp", action="store_true", help="Only run direct CDP GET checks")
    args = parser.parse_args()
    if args.timeout <= 0 or args.wait <= 0:
        parser.error("--timeout and --wait must be positive")
    if args.tv_ip:
        try:
            address = ipaddress.ip_address(args.tv_ip)
            if not (address.is_private or address.is_loopback or address.is_link_local):
                parser.error("--tv-ip must be a local/private address")
        except ValueError:
            parser.error("--tv-ip must be a valid IP address")
    if not args.skip_ssdp:
        found = ssdp_discover(args.tv_ip, args.timeout, args.wait)
        inspect_dial(found, args.timeout)
    inspect_cdp(args.tv_ip, args.timeout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
