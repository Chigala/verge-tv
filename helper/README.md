# Verge helper

Launches real TV apps on a Hisense VIDAA set from a page you control.

## Why this exists

The TV only starts native apps when the command arrives on its own MQTT bus
(`36669`, mutual TLS). A web page cannot speak that: browsers can't present a
client certificate, and DIAL refuses anything carrying an `Origin` header.
So a small process on your LAN holds the connection instead.

```
TV browser  ──HTTP──▶  helper :8777  ──MQTT/mTLS──▶  TV :36669
```

Nothing leaves your network.

## Setup

```sh
sh helper/setup_certs.sh           # client certificate the TV demands
python3 helper/pair.py --host <tv-ip>
python3 helper/server.py
```

`pair.py` puts a 4-digit PIN on the TV. Feed it back and this machine is
authorised to send commands. **The authorisation is bound to the TV MAC, so it
survives reboots and never expires** — there is no token to renew.

Then open `http://<this-machine>:8777/` on the TV.

## How the protocol actually behaves

Recorded from a `50A5HX` (VIDAA 9, MT9602, `V0000.09.09Q.P1015`):

| Behaviour | Detail |
| --- | --- |
| Transport | MQTT 3.1.1 over TLS 1.3, port `36669` |
| TLS | **Mutual.** Without a client cert the handshake aborts with `certificate required` |
| Client cert | `CN=VidaaAppAndroidV01`, issued by `RemoteCA`, valid to 2034 |
| Credentials | Derived from the TV MAC **and the TV's own clock** — read its HTTP `Date` header, not your system time |
| MAC case | Case-sensitive. `C0:E5:…` works; `c0:e5:…` connects but every command is silently dropped |
| Subscriptions | Refused (`SUBACK 0x80`) for every topic, even after pairing. The bus is **write-only** |
| Launch | Publish to `/remoteapp/tv/ui_service/<client>/actions/launchapp` with `{"appId": "1", "name": "Netflix", "url": "netflix", "urlType": 37}` |
| Pairing | `actions/vidaa_app_connect` pops the PIN; `actions/authenticationcode {"authNum": <int>}` authorises the client id |

Because subscriptions never work, there is no acknowledgement to read. A toast
or a launch is the only proof, which is why `pair.py` ends by showing one.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | paired?, reachable?, and the app list |
| `POST /api/launch` | `{"appId": "1"}` |
| `POST /api/key` | `{"key": "KEY_HOME"}` |
| `POST /api/toast` | `{"message": "hi"}` — useful as a liveness check |

The page is served from `docs/` on the same origin as the API, which avoids
CORS and mixed-content blocking entirely.

## Files

| File | Role |
| --- | --- |
| `vidaa_tv.py` | MQTT framing, TLS, credentials, pairing, launch. Standard library only. |
| `pair.py` | One-time PIN pairing, writes `config.json`. |
| `server.py` | Static launcher + launch API. |
| `apps.json` | App ids and launch keys read from the TV. |
| `certs/` | Client certificate. Gitignored. |
| `config.json` | TV host and MAC. Gitignored. |

## Running it forever

Any always-on box on the LAN will do — a Raspberry Pi, a NAS, an old phone.
It is one Python file serving HTTP and opening one TLS socket, so the
requirements are close to nothing. Point `config.json` at the TV and start
`server.py` at boot.
