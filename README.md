# Verge Headlines for VIDAA TV

A remote-friendly headlines reader for The Verge, plus a small installer that
puts it (or any web app) in a Hisense VIDAA TV's Apps list.

```
docs/index.html        the TV app (arrow keys, OK, Back, number keys 1-8, RED = refresh)
docs/feeds/*.json      headlines, rebuilt by feeds.py
feeds.py               fetches The Verge's public feeds into docs/feeds/
server.py              runs the app from this computer (http://<your-ip>:8787)
installer/             DNS + web server that lets the TV install the app
.github/workflows/     refreshes the headlines every 30 min when hosted on GitHub Pages
```

## Run the app from this computer

```bash
python3 server.py
```

Open the address it prints in the TV's Browser. The computer must stay on.

## Install it into the TV's Apps list

You need: the TV and computer on the same network, and a TV that lets you set DNS manually.

1. On the computer, from the `installer` folder:
   ```bash
   sudo python3 vidaa_installer.py --app-url <APP URL>
   ```
   It prints this computer's IP address. Leave it running.
2. On the TV: Settings → Network → Network Configuration → your connection →
   IP/DNS settings → Manual. Set **DNS 1** to the IP it printed. Save.
3. Open the TV's **Browser** and go to `https://vidaahub.com`. Accept the certificate warning.
4. Press **Install**. Wait for "installed".
5. Set the TV's DNS back to **automatic**, then restart the TV.
6. Press Ctrl+C in the installer window.

To remove the app later, repeat with the same `--app-url` and press **Uninstall**.

If the page says the install function is not found, your TV's firmware blocks
custom installs; use a Browser bookmark instead.

Installer approach from [camellan/vidaa-appstore](https://github.com/camellan/vidaa-appstore).
