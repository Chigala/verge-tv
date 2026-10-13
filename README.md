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
movies/build_runtime_config.py  writes the ignored/deployment-only Worker endpoint
worker/                    private trailer resolver and HLS proxy for Cloudflare Workers
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
| `TRAILER_API_URL` | GitHub Actions secret | Public Cloudflare Worker URL including the private `ACCESS_PATH`. **Play** uses its fast `/embed` redirect; there is no YouTube fallback. |
| `TRAILER_URL_TEMPLATE` | Cloudflare Worker secret only | Sensitive upstream page template. Never put it in GitHub, Pages runtime data, `.env`, commands, logs or support messages. Supported placeholders: `{tmdb}` `{imdb}` `{type}` `{title}` `{year}`; with none, the TMDB number is added to the end. |

```bash
gh secret set TMDB_TOKEN --repo Chigala/verge-tv
gh variable set TMDB_SEARCH_KEY --repo Chigala/verge-tv
gh secret set TRAILER_API_URL --repo Chigala/verge-tv
gh workflow run deploy-pages.yml --repo Chigala/verge-tv
```

## Build and preview on this computer

```bash
python3 movies/build_catalog.py
python3 -m http.server 8000 --directory docs
```

Then open http://localhost:8000 and use the arrow keys, Enter and Escape.
`docs/data/runtime.json` is ignored by Git. Without a local runtime file, the
catalog works but the **Play** button is hidden. For GitHub Pages, set
**Settings → Pages → Build and deployment → Source** to **GitHub Actions** once;
the deployment workflow writes only the Worker endpoint into the artifact. It
never receives the sensitive upstream template.

## Private trailer gateway

The active TV path is intentionally small: `/embed` validates the title fields,
fills the private `TRAILER_URL_TEMPLATE`, and immediately redirects the iframe
to the player page. The player handles playback while the TV app sends remote
commands through its documented `postMessage` API. The template stays out of
Git and the public Pages artifact, while the old 60-second resolution wait is
removed.

The Worker also retains the older `/resolve` and `/media` implementation for
diagnostics, but the Pages app no longer calls it. That legacy path can inspect
plain HLS/MP4 sources and deliberately does not bypass CAPTCHA, login or DRM.

The legacy resolver accepts a movie/TV identifier, fetches the configured source page,
finds a plain HLS/MP4 media URL, encrypts it into a short-lived opaque token,
and proxies the manifest and media back to the TV. It rewrites variant streams,
segments, audio, subtitles, initialization files and key URIs. It deliberately
does not bypass CAPTCHA, login or DRM challenges. If the initial HTML contains
no media URL, a Cloudflare Browser Run fallback executes the page and observes
only media requests. It never takes screenshots or returns page content.
Before using a browser, a bounded multi-hop resolver can follow server hashes,
intermediary pages and redirects while preserving cookies and referrers. It can
decode common Base64, hex/XOR and Hunter-packed player configuration without
executing arbitrary page JavaScript.

The real source is not required for development or automated testing. All
repository tests use invented `.invalid` domains. Only the owner should enter
the real value, using Cloudflare's hidden interactive secret prompt:

```bash
cd worker
npm install
npx wrangler login
npm test
npm run deploy
npx wrangler secret put TRAILER_URL_TEMPLATE
npx wrangler secret put ACCESS_PATH
npx wrangler secret put PLAYBACK_TOKEN_SECRET
npm run deploy
```

The first deployment creates the Worker without a usable route. Each interactive
`secret put` creates and deploys a new Worker version, and the final deployment
confirms that the checked-in code and non-secret configuration are current.

Requirements for the two generated values:

- `ACCESS_PATH`: 16–128 random letters, numbers, `_` or `-`.
- `PLAYBACK_TOKEN_SECRET`: at least 32 random characters.

After deployment, privately construct the endpoint as
`https://<worker-host>/<ACCESS_PATH>`. Enter it interactively as the GitHub
secret `TRAILER_API_URL`, rerun the Pages workflow, and then remove the former
GitHub copy of the source template:

```bash
gh secret set TRAILER_API_URL --repo Chigala/verge-tv
gh workflow run deploy-pages.yml --repo Chigala/verge-tv
gh secret delete TRAILER_URL_TEMPLATE --repo Chigala/verge-tv
```

Do not paste either URL into an issue, commit, command argument or support chat.
The endpoint path is intentionally obscure, but obscurity is not authentication;
the Worker also validates identifiers, blocks private upstream hosts, issues
expiring encrypted media tokens, restricts browser origins and emits only
sanitized error codes. Cloudflare observability is disabled in `wrangler.jsonc`.

Browser Run is used only after static discovery fails. Cloudflare currently
includes 10 browser minutes per day on the Workers Free plan; when that allowance
is exhausted the TV receives the sanitized `BROWSER_RUN_LIMIT_REACHED` error.
After pulling a Worker code update, existing secrets are retained and only these
commands are needed:

```bash
cd worker
npm install
npm test
npm run deploy
```

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
