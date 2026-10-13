#!/usr/bin/env python3
"""Builds the TV movie catalog into docs/movies/data/.

Sources:
  * TMDB (themoviedb.org): catalog rows, details, cast, official YouTube
    trailers and where-to-watch in Nigeria (JustWatch data via TMDB).
    Needs TMDB_TOKEN (v4 "API Read Access Token") or TMDB_API_KEY (v3 key)
    in the environment. Without one, only the public-domain rows are built.
  * Internet Archive: public-domain feature films (explicit public-domain
    licence only), which play in full in the TV's native video player.

Output (small, pre-sized, so the TV does almost no work):
  docs/movies/data/home.json      rows of compact cards
  docs/movies/data/m/<id>.json    one detail file per title, loaded on demand

Run:  TMDB_TOKEN=... python3 movies/build_catalog.py
Standard library only.
"""

import json
import os
import re
import shutil
import ssl
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "movies", "data")
REGION = "NG"

TMDB_API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/"
TOKEN = os.environ.get("TMDB_TOKEN", "").strip()
API_KEY = os.environ.get("TMDB_API_KEY", "").strip()

# (row title, TMDB path, extra query)
TMDB_ROWS = [
    ("Trending this week", "/trending/movie/week", {}),
    ("Popular", "/movie/popular", {"region": REGION}),
    ("In cinemas", "/movie/now_playing", {"region": REGION}),
    ("Top rated", "/movie/top_rated", {}),
    ("Action", "/discover/movie", {"with_genres": "28", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
    ("Comedy", "/discover/movie", {"with_genres": "35", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
    ("Horror", "/discover/movie", {"with_genres": "27", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
    ("Sci-fi", "/discover/movie", {"with_genres": "878", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
    ("Animation", "/discover/movie", {"with_genres": "16", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
    ("Drama", "/discover/movie", {"with_genres": "18", "sort_by": "popularity.desc", "vote_count.gte": "300"}),
]

# (row title, Internet Archive query) — explicit public-domain licence only.
PD_ROWS = [
    ("Free classics · full movies",
     "collection:feature_films AND mediatype:movies AND licenseurl:*publicdomain*"),
    ("Free sci-fi & horror · full movies",
     "collection:SciFi_Horror AND mediatype:movies AND licenseurl:*publicdomain*"),
]
PD_PER_ROW = 24
MIN_FEATURE_SECONDS = 45 * 60

# python.org builds on macOS often ship without CA certs; fall back to the system bundle.
_ssl = ssl.create_default_context()
if not _ssl.get_ca_certs() and os.path.exists("/etc/ssl/cert.pem"):
    _ssl.load_verify_locations("/etc/ssl/cert.pem")


def get_json(url, headers=None, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=dict({"User-Agent": "tv-movies/1.0"}, **(headers or {})))
            with urllib.request.urlopen(req, timeout=30, context=_ssl) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def tmdb(path, **params):
    headers = {}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    else:
        params["api_key"] = API_KEY
    return get_json(TMDB_API + path + "?" + urllib.parse.urlencode(params), headers)


def img(path, size):
    return IMG + size + path if path else ""


def year_of(date):
    return (date or "")[:4]


def short(text, n):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


def norm_title(t):
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


# ---------------------------------------------------------------- TMDB

def tmdb_card(m):
    return {
        "id": "t%d" % m["id"],
        "t": m.get("title") or m.get("name") or "",
        "y": year_of(m.get("release_date")),
        "p": img(m.get("poster_path"), "w185"),
        "b": img(m.get("backdrop_path"), "w780"),
        "r": round(m.get("vote_average") or 0, 1),
        "o": short(m.get("overview"), 240),
    }


def pick_trailer(videos):
    yt = [v for v in (videos or {}).get("results", []) if v.get("site") == "YouTube"]
    def score(v):
        return (v.get("type") == "Trailer", v.get("official", False), v.get("iso_639_1") == "en", v.get("size", 0))
    yt.sort(key=score, reverse=True)
    return yt[0]["key"] if yt else ""


def providers_for(wp):
    region = (wp or {}).get("results", {}).get(REGION) or {}
    def names(kind):
        return [{"n": p["provider_name"], "l": img(p.get("logo_path"), "w92")}
                for p in sorted(region.get(kind, []), key=lambda p: p.get("display_priority", 99))][:6]
    return {"stream": names("flatrate"), "free": names("free") + names("ads"),
            "rent": names("rent"), "buy": names("buy")}


def tmdb_detail(tmdb_id):
    d = tmdb("/movie/%d" % tmdb_id, append_to_response="videos,credits,watch/providers")
    crew = d.get("credits", {}).get("crew", [])
    return {
        "id": "t%d" % d["id"],
        "t": d.get("title", ""),
        "y": year_of(d.get("release_date")),
        "rt": d.get("runtime") or 0,
        "r": round(d.get("vote_average") or 0, 1),
        "g": [g["name"] for g in d.get("genres", [])][:3],
        "o": short(d.get("overview"), 700),
        "tag": d.get("tagline", ""),
        "cast": [c["name"] for c in d.get("credits", {}).get("cast", [])[:6]],
        "dir": [c["name"] for c in crew if c.get("job") == "Director"][:2],
        "p": img(d.get("poster_path"), "w342"),
        "b": img(d.get("backdrop_path"), "w1280"),
        "yt": pick_trailer(d.get("videos")),
        "prov": providers_for(d.get("watch/providers")),
        "info": "https://www.themoviedb.org/movie/%d" % d["id"],
    }


def build_tmdb_rows():
    rows, ids = [], []
    for title, path, params in TMDB_ROWS:
        try:
            res = tmdb(path, **params).get("results", [])
        except Exception as e:
            print("! row %s: %s" % (title, e), file=sys.stderr)
            continue
        cards = [tmdb_card(m) for m in res if m.get("poster_path")][:20]
        rows.append({"title": title, "items": cards})
        ids += [int(c["id"][1:]) for c in cards]
        print("%-28s %d" % (title, len(cards)))
    return rows, sorted(set(ids))


# ---------------------------------------------------------------- Internet Archive

def archive_search(query, rows):
    params = urllib.parse.urlencode([("q", query), ("fl[]", "identifier"), ("fl[]", "title"), ("fl[]", "year"),
                                     ("sort[]", "downloads desc"), ("rows", str(rows)), ("output", "json")])
    return get_json("https://archive.org/advancedsearch.php?" + params)["response"]["docs"]


def archive_id(ident):
    return "a" + re.sub(r"[^A-Za-z0-9_-]", "_", ident)


def archive_film(doc):
    ident = doc["identifier"]
    meta = get_json("https://archive.org/metadata/" + urllib.parse.quote(ident))
    files = meta.get("files", [])
    mp4s = [f for f in files if f["name"].lower().endswith(".mp4")
            and f.get("format", "").lower() in ("h.264", "mpeg4", "512kb mpeg4", "h.264 hd")]
    if not mp4s:
        return None
    best = max(mp4s, key=lambda f: (int(f.get("height") or 0), "512kb" not in f["name"].lower()))
    length = float(best.get("length") or 0)
    if length and length < MIN_FEATURE_SECONDS:
        return None
    m = meta.get("metadata", {})
    title = m.get("title") or doc.get("title") or ident
    if isinstance(title, list):
        title = title[0]
    desc = m.get("description") or ""
    if isinstance(desc, list):
        desc = " ".join(desc)
    desc = re.sub(r"<[^>]+>", " ", desc)
    year = str(m.get("year") or doc.get("year") or m.get("date", ""))[:4]
    thumb = "https://archive.org/services/img/" + urllib.parse.quote(ident)
    return {
        "id": archive_id(ident),
        "t": title, "y": year, "p": thumb, "b": "", "r": 0,
        "o": short(desc, 240),
        "detail": {
            "t": title, "y": year, "rt": int(round(length / 60)) if length else 0, "r": 0,
            "g": [], "o": short(desc, 700), "tag": "Public domain", "cast": [], "dir": [],
            "p": thumb, "b": "", "yt": "",
            "video": "https://archive.org/download/%s/%s" % (urllib.parse.quote(ident), urllib.parse.quote(best["name"])),
            "src": "https://archive.org/details/" + urllib.parse.quote(ident),
            "prov": {"stream": [], "free": [], "rent": [], "buy": []},
        },
    }


def enrich_from_tmdb(film):
    """Give a public-domain film TMDB's poster/backdrop/cast when the match is unambiguous."""
    try:
        res = tmdb("/search/movie", query=film["t"], year=film["y"]).get("results", []) if film["y"] else []
    except Exception:
        return
    match = next((m for m in res if norm_title(m.get("title")) == norm_title(film["t"])
                  and year_of(m.get("release_date")) == film["y"]), None)
    if not match:
        return
    try:
        d = tmdb_detail(match["id"])
    except Exception:
        return
    det = film["detail"]
    film["p"] = img(match.get("poster_path"), "w185") or film["p"]
    film["b"] = img(match.get("backdrop_path"), "w780")
    film["r"] = round(match.get("vote_average") or 0, 1)
    if d["o"]:
        film["o"] = short(d["o"], 240)
        det["o"] = d["o"]
    det.update({k: d[k] for k in ("g", "cast", "dir", "r") if d[k]})
    det["p"] = d["p"] or det["p"]
    det["b"] = d["b"]
    det["yt"] = ""  # the full film plays instead


def build_pd_rows(use_tmdb):
    rows, seen = [], set()
    for title, query in PD_ROWS:
        try:
            docs = [d for d in archive_search(query, PD_PER_ROW * 3) if archive_id(d["identifier"]) not in seen]
        except Exception as e:
            print("! archive %s: %s" % (title, e), file=sys.stderr)
            continue
        with ThreadPoolExecutor(8) as pool:
            films = [f for f in pool.map(lambda d: _safe(archive_film, d), docs) if f]
        films = films[:PD_PER_ROW]
        if use_tmdb:
            with ThreadPoolExecutor(6) as pool:
                list(pool.map(enrich_from_tmdb, films))
        seen.update(f["id"] for f in films)
        rows.append({"title": title, "pd": True, "items": films})
        print("%-28s %d" % (title, len(films)))
    return rows


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception as e:
        print("! %s: %s" % (arg if isinstance(arg, (int, str)) else arg.get("identifier"), e), file=sys.stderr)
        return None


# ---------------------------------------------------------------- main

def main():
    use_tmdb = bool(TOKEN or API_KEY)
    tmp = OUT + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, "m"))

    rows, details = [], {}
    if use_tmdb:
        tmdb_rows, ids = build_tmdb_rows()
        with ThreadPoolExecutor(8) as pool:
            for d in pool.map(lambda i: _safe(tmdb_detail, i), ids):
                if d:
                    details[d["id"]] = d
        print("details: %d" % len(details))
        rows += tmdb_rows
    else:
        print("No TMDB_TOKEN / TMDB_API_KEY set: building public-domain rows only.")

    pd_rows = build_pd_rows(use_tmdb)
    for row in pd_rows:
        for f in row["items"]:
            det = f.pop("detail")
            det["id"] = f["id"]
            details[f["id"]] = det
    # Playable films go second, right under what's trending.
    rows = rows[:1] + pd_rows + rows[1:]

    if not any(r["items"] for r in rows):
        sys.exit("Nothing fetched; keeping the previous catalog.")

    for did, d in details.items():
        with open(os.path.join(tmp, "m", did + ".json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(tmp, "home.json"), "w", encoding="utf-8") as f:
        json.dump({"built": int(time.time()), "tmdb": use_tmdb, "rows": rows}, f,
                  ensure_ascii=False, separators=(",", ":"))

    shutil.rmtree(OUT, ignore_errors=True)
    os.rename(tmp, OUT)
    print("wrote %d rows, %d detail files -> %s" % (len(rows), len(details), os.path.relpath(OUT)))


if __name__ == "__main__":
    main()
