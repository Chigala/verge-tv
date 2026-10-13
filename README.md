# Movie Catalog for VIDAA TV

A remote-friendly catalog of movies and series for Hisense VIDAA TVs. The rows
show the latest US movies and series by category; search finds any movie or
series from anywhere. Each title has a details page with trailers, cast, "more
like this" and where to watch in Nigeria, and series have seasons and episodes.
A small installer puts it in the TV's Apps list.

```
docs/index.html            the TV app (arrow keys, OK, Back, number keys in search)
docs/data/                 the catalog, rebuilt daily by movies/build_catalog.py (about 3 minutes)
docs/movies/index.html     redirect for TVs that installed the old /movies/ address
movies/build_catalog.py    builds docs/data/ from TMDB
movies/build_runtime_config.py  writes the ignored/deployment-only trailer config
installer/                 DNS + web server that lets the TV install the app
.github/workflows/         rebuilds the catalog and deploys Pages from an artifact
.env                       local settings (gitignored), read by build_catalog.py
```

Live at https://chigala.github.io/verge-tv/

## Settings

| Setting | Where | What |
|---|---|---|
| `TMDB_TOKEN` | GitHub secret and/or `.env` | TMDB "API Read Access Token" (or `TMDB_API_KEY` for the short v3 key). Required. |
| `TMDB_SEARCH_KEY` | GitHub variable and/or `.env` | Optional short v3 key the TV uses to search all of TMDB and load any title, season or episode. Public: it ends up in the catalog. Without it, search covers only the catalog and series show only their latest 3 seasons. |
| `TRAILER_URL_TEMPLATE` | GitHub Actions secret and/or `.env` | Trailer webpage or direct video template per title. It is generated only in the Pages deployment artifact and is never written to committed catalog data. This is the only source used by **Play**; there is no YouTube fallback. Placeholders: `{tmdb}` `{imdb}` `{type}` `{title}` `{year}`; with none, the TMDB number is added to the end. |

```bash
gh secret set TMDB_TOKEN --repo Chigala/verge-tv
gh variable set TMDB_SEARCH_KEY --repo Chigala/verge-tv
gh secret set TRAILER_URL_TEMPLATE --repo Chigala/verge-tv --body 'https://example.com/{type}/{tmdb}'
gh workflow run deploy-pages.yml --repo Chigala/verge-tv
```

## Build and preview on this computer

```bash
python3 movies/build_catalog.py
python3 movies/build_runtime_config.py docs/data/runtime.json
python3 -m http.server 8000 --directory docs
```

Then open http://localhost:8000 and use the arrow keys, Enter and Escape.
`docs/data/runtime.json` is ignored by Git. For GitHub Pages, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions** once; the deployment workflow injects the secret into the artifact.

## Install it into the TV's Apps list

You need: the TV and computer on the same network, and a TV that lets you set DNS manually.

1. On the computer, from the `installer` folder:
   ```bash
   sudo python3 vidaa_installer.py
   ```
   It prints this computer's IP address. Leave it running.
2. On the TV: Settings → Network → Network Configuration → your connection →
   IP/DNS settings → Manual. Set **DNS 1** to the IP it printed. Save.
3. Open the TV's **Browser** and go to `https://vidaahub.com`. Accept the certificate warning.
4. Press **Install (new)** (VIDAA 9 and newer) or **Install (old)** (older TVs). Wait for "installed".
   **Check apps** shows whether the TV really lists it; **Restore** puts back the TV's original custom app list (backed up in `installer/backups/`).
5. Set the TV's DNS back to **automatic**, then restart the TV.
6. Press Ctrl+C in the installer window.

The installer uses https://chigala.github.io/verge-tv/ by default; pass `--app-url` and `--name` to install a different web app.
To remove it later, repeat the steps and press **Uninstall**.

The installed app keeps using that hosted URL, so normal app updates do not require reinstalling it. After publishing an update, fully close and reopen the TV app so its WebView fetches the new page.

If the page says the install function is not found, your TV's firmware blocks
custom installs; use a Browser bookmark instead.

Installer approach from [camellan/vidaa-appstore](https://github.com/camellan/vidaa-appstore).

Catalog data from [TMDB](https://www.themoviedb.org/) (this product uses the TMDB API but is not endorsed or certified by TMDB) and JustWatch.
