"""Talk to a Hisense VIDAA TV's local MQTT broker (port 36669, mutual TLS).

Standard library only. No paho, no cloud, no internet.

The TV enforces mutual TLS, so a client certificate is required. It also derives
its MQTT credentials from the TV's own clock, so we read the TV's HTTP Date
header rather than trusting the host clock.

Verified against: 50A5HX (VIDAA 9, MT9602, V0000.09.09Q.P1015)
"""

from __future__ import annotations

import email.utils
import hashlib
import json
import queue
import socket
import ssl
import struct
import threading
import time
import urllib.request

PATTERN = "38D65DC30F45109A369A86FCE866A85B"
XOR_TIMESTAMP_MASK = 6239759785777146216
MODERN_SALT = "h!i@s#$v%i^d&a*a"
PLAIN_SALT = "h*i&s%e!r^v0i1c9"

MQTT_PORT = 36669
UPNP_PORTS = (38400, 18400)


# --- MQTT wire format ------------------------------------------------------

def _varint(n: int) -> bytes:
    out = b""
    while True:
        byte = n % 128
        n //= 128
        if n:
            byte |= 0x80
        out += bytes([byte])
        if not n:
            return out


def _str(value) -> bytes:
    if isinstance(value, str):
        value = value.encode()
    return struct.pack("!H", len(value)) + value


def _packet(ptype: int, flags: int, body: bytes) -> bytes:
    return bytes([(ptype << 4) | flags]) + _varint(len(body)) + body


class TVError(Exception):
    """Any failure talking to the TV."""


class TV:
    def __init__(self, host, mac, certfile, keyfile, plain_auth=False):
        self.host = host
        self.mac = mac
        self.certfile = certfile
        self.keyfile = keyfile
        self.plain_auth = plain_auth

        self.sock = None
        self.client_id = None
        self.username = None
        self.token = None
        self.topics = {}
        self.applist = []
        self.state = {}
        self.volume = None

        self._inbox = queue.Queue()
        self._stop = threading.Event()
        self._reader = None
        self._pinger = None
        self._pid = 0

    # --- credentials -------------------------------------------------------

    def derive(self, timestamp):
        digest = hashlib.md5(f"{PATTERN}${self.mac}".encode()).hexdigest().upper()
        client_id = f"{self.mac}$his${digest[:6]}_vidaacommon_001"

        salt = PLAIN_SALT if self.plain_auth else MODERN_SALT
        digit = sum(int(c) for c in str(timestamp)) % 10
        inner = hashlib.md5(f"his{digit}{salt}".encode()).hexdigest().upper()[:6]
        password = hashlib.md5(f"{timestamp}${inner}".encode()).hexdigest().upper()
        username = f"his${timestamp}" if self.plain_auth else f"his${timestamp ^ XOR_TIMESTAMP_MASK}"
        return client_id, username, password

    def set_topics(self):
        cid = self.client_id
        self.topics = {
            "ui": f"/remoteapp/tv/ui_service/{cid}/",
            "platform": f"/remoteapp/tv/platform_service/{cid}/",
            "remote": f"/remoteapp/tv/remote_service/{cid}/",
            "mobile": f"/remoteapp/mobile/{cid}/",
            "broadcast": "/remoteapp/mobile/broadcast/",
        }

    # --- transport ---------------------------------------------------------

    def _tls(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(self.certfile, self.keyfile)
        raw = socket.create_connection((self.host, MQTT_PORT), timeout=10)
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        sock = ctx.wrap_socket(raw)
        sock.settimeout(None)
        return sock

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise TVError("TV closed the connection")
            buf += chunk
        return buf

    def _read_packet(self):
        first = self._read_exact(1)[0]
        mult, length = 1, 0
        for _ in range(4):
            byte = self._read_exact(1)[0]
            length += (byte & 0x7F) * mult
            mult *= 128
            if not byte & 0x80:
                break
        body = self._read_exact(length) if length else b""
        return first >> 4, first & 0x0F, body

    def publish(self, topic, payload=""):
        if not isinstance(payload, str):
            payload = json.dumps(payload)
        body = _str(topic) + payload.encode()
        self.sock.sendall(_packet(3, 0, body))

    def subscribe(self, topics):
        self._pid += 1
        body = struct.pack("!H", self._pid)
        for topic in topics:
            body += _str(topic) + bytes([0])
        self.sock.sendall(_packet(8, 2, body))

    # --- connection --------------------------------------------------------

    def connect(self, password=None, username=None, timestamp=None):
        if password is None:
            stamp = timestamp or tv_timestamp(self.host)
            self.client_id, self.username, password = self.derive(stamp)
        else:
            self.client_id, self.username = self.client_id, username
        self.set_topics()

        self.sock = self._tls()
        flags = 0x02 | 0x80 | 0x40
        body = _str("MQTT") + bytes([4]) + bytes([flags]) + struct.pack("!H", 60)
        body += _str(self.client_id) + _str(self.username) + _str(password)
        self.sock.sendall(_packet(1, 0, body))

        ptype, _, data = self._read_packet()
        if ptype != 2 or len(data) < 2:
            raise TVError(f"unexpected reply 0x{ptype:02x}")
        if data[1] != 0:
            raise TVError(f"broker refused the connection (rc={data[1]})")

        self._stop.clear()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._pinger = threading.Thread(target=self._ping_loop, daemon=True)
        self._pinger.start()
        return True

    def _read_loop(self):
        while not self._stop.is_set():
            try:
                ptype, _, body = self._read_packet()
            except Exception:
                break
            if ptype == 9:
                self.subacks.append(body.hex())
                continue
            if ptype == 11:
                continue
            if ptype == 3 and len(body) >= 2:
                tlen = struct.unpack("!H", body[:2])[0]
                topic = body[2:2 + tlen].decode(errors="replace")
                payload = body[2 + tlen:].decode(errors="replace")
                self._handle(topic, payload)
                self._inbox.put((topic, payload))

    def _ping_loop(self):
        while not self._stop.is_set():
            time.sleep(25)
            if self._stop.is_set():
                return
            try:
                self.sock.sendall(_packet(12, 0, b""))
            except Exception:
                return

    def _handle(self, topic, payload):
        if topic.endswith("ui_service/data/applist"):
            try:
                data = json.loads(payload)
                entries = data.get("applist") if isinstance(data, dict) else data
                if isinstance(entries, list):
                    self.applist = entries
            except Exception:
                pass
        elif topic.endswith("ui_service/data/gettvstate") or topic.endswith("broadcast/ui_service/state"):
            try:
                self.state = json.loads(payload)
            except Exception:
                pass
        elif topic.endswith("data/getvolume"):
            try:
                self.volume = json.loads(payload)
            except Exception:
                pass

    def wait_for(self, topic_suffix, timeout=10.0):
        return self.wait_any([topic_suffix], timeout)

    def wait_any(self, topic_suffixes, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                topic, payload = self._inbox.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                return None
            if any(topic.endswith(suffix) for suffix in topic_suffixes):
                return topic, payload
        return None

    def drain(self, seconds=0.6):
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                self._inbox.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                return

    def close(self):
        self._stop.set()
        try:
            if self.sock:
                self.sock.sendall(_packet(14, 0, b""))
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass

    # --- high level --------------------------------------------------------

    def start_session(self):
        self.subscribe([f"{self.topics['mobile']}#", f"{self.topics['broadcast']}#"])

    def request_applist(self, timeout=8.0):
        self.publish(f"{self.topics['ui']}actions/applist")
        if self.wait_for("ui_service/data/applist", timeout):
            return self.applist
        self.drain(0.3)
        return self.applist

    def launch(self, app_id, name, url="", url_type=37):
        payload = {
            "appId": str(app_id),
            "name": name,
            "url": url,
            "urlType": url_type,
            "appName": name,
            "appUrl": url,
        }
        self.publish(f"{self.topics['ui']}actions/launchapp", payload)

    def send_key(self, key):
        self.publish(f"{self.topics['remote']}actions/sendkey", key)

    def pair(self, pin_provider):
        """Authorise this MAC identity with the PIN the TV puts on screen.

        The broker never answers on a topic we can read (this firmware refuses
        every SUBSCRIBE), so the only proof is what happens on the TV. The
        authorisation is bound to the client id, which is derived from the MAC,
        so it survives reboots and needs no token.
        """
        self.publish(
            f"{self.topics['ui']}actions/vidaa_app_connect",
            {"app_version": 2, "connect_result": 0, "device_type": "Mobile App"},
        )
        pin = str(pin_provider()).strip()
        if not pin.isdigit():
            raise TVError(f"PIN must be digits, got {pin!r}")
        self.publish(f"{self.topics['ui']}actions/authenticationcode", {"authNum": int(pin)})
        time.sleep(1.5)
        return True

    def show_message(self, message, title="Verge", duration=6):
        self.publish(
            f"{self.topics['ui']}actions/showmessage",
            {"message": message, "title": title, "duration": duration, "type": "notify"},
        )


def tv_timestamp(host, timeout=3.0):
    """Read the TV's own clock from its UPnP HTTP Date header."""
    for port in UPNP_PORTS:
        url = f"http://{host}:{port}/MediaServer/rendererdevicedesc.xml"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "VergeHelper"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                header = response.headers.get("Date")
                if header:
                    return int(email.utils.parsedate_to_datetime(header).timestamp())
        except Exception:
            continue
    return int(time.time())


def local_mac(host):
    """Look the TV's MAC up in the local ARP table."""
    import re
    import subprocess

    try:
        out = subprocess.run(["arp", "-n", host], capture_output=True, text=True, timeout=5).stdout
        match = re.search(r"([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})", out, re.I)
        if match:
            parts = [p.zfill(2) for p in match.group(1).split(":")]
            return ":".join(parts).lower()
    except Exception:
        pass
    try:
        out = subprocess.run(["ip", "neigh", "show", host], capture_output=True, text=True, timeout=5).stdout
        match = re.search(r"lladdr ([0-9a-f:]{17})", out)
        if match:
            return match.group(1).lower()
    except Exception:
        pass
    return None
