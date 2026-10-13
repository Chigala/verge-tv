#!/usr/bin/env python3
"""Builds the TV catalog (latest US movies and series) into docs/data/.

Source: TMDB (themoviedb.org) for rows by category, details, cast, official
YouTube trailers, seasons and episodes, and where to watch in Nigeria
(JustWatch data via TMDB).

Settings, from the environment or a .env file in the repo root:
  TMDB_TOKEN            TMDB "API Read Access Token" (or TMDB_API_KEY, the
                        short v3 key). Required.
  TMDB_SEARCH_KEY       optional v3 key the TV uses to search all of TMDB and
                        load titles that aren't in the catalog. It ends up in
                        the public catalog, so anyone can read it.
Output (small, pre-sized, so the TV does almost no work):
  docs/data/home.json         tabs, rows and one compact card per title
  docs/data/d/<id>.json       one detail file per title, loaded on demand
  docs/data/e/<id>-<n>.json   episodes of season n, for each show's latest seasons

Run:  python3 movies/build_catalog.py
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
ROOT = os.path.normpath(os.path.join(HERE, ".."))
OUT = os.path.join(ROOT, "docs", "data")
REGION = "NG"       # where-to-watch country
ORIGIN = "US"       # the rows only show titles from here; search covers everything


def load_env_file(path):
    """KEY=value lines; anything already in the real environment wins."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip("'\"")
            if key and value and not os.environ.get(key):
                os.environ[key] = value


load_env_file(os.path.join(ROOT, ".env"))

TMDB_API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/"
TOKEN = os.environ.get("TMDB_TOKEN", "").strip()
API_KEY = os.environ.get("TMDB_API_KEY", "").strip()
SEARCH_KEY = os.environ.get("TMDB_SEARCH_KEY", "").strip()
TODAY = time.strftime("%Y-%m-%d")


def days_ago(n):
    return time.strftime("%Y-%m-%d", time.localtime(time.time() - n * 86400))


PER_ROW = 40
HOME_PER_ROW = 20
LATEST_SEASONS = 3      # older seasons load from TMDB on the TV when TMDB_SEARCH_KEY is set
MAX_EPISODES = 60
TV_SKIP = {10767, 10763, 10766}  # talk, news, soap: no trailers and endless episodes

MOVIE_GENRES = [("Action", 28), ("Adventure", 12), ("Comedy", 35), ("Drama", 18), ("Thriller", 53),
                ("Crime", 80), ("Horror", 27), ("Sci-fi", 878), ("Fantasy", 14), ("Romance", 10749),
                ("Animation", 16), ("Family", 10751), ("Mystery", 9648), ("Documentary", 99)]
TV_GENRES = [("Drama", 18), ("Comedy", 35), ("Crime", 80), ("Action & adventure", 10759),
             ("Sci-fi & fantasy", 10765), ("Mystery", 9648), ("Animation", 16), ("Documentary", 99),
             ("Reality", 10764), ("Kids", 10762)]

# "Latest": movies released in the last two years, series with an episode in the last year.
RECENT_MOVIES = {"with_origin_country": ORIGIN, "sort_by": "popularity.desc", "vote_count.gte": 20,
                 "primary_release_date.gte": days_ago(730), "primary_release_date.lte": TODAY}
RECENT_TV = {"with_origin_country": ORIGIN, "sort_by": "popularity.desc", "air_date.gte": days_ago(365),
             "without_genres": "|".join(str(g) for g in sorted(TV_SKIP))}

# key -> (row title, "movie" | "tv", TMDB path, extra query, pages). Order matters:
# titles are listed in this order, which search uses as its popularity order.
# Lists TMDB can't filter by country fetch extra pages; non-US titles are dropped later.
LISTS = {
    "m_latest": ("Latest movies", "movie", "/movie/now_playing", {"region": ORIGIN}, 3),
    "s_new": ("New episodes", "tv", "/discover/tv", dict(RECENT_TV, **{"air_date.gte": days_ago(7), "air_date.lte": TODAY}), 2),
    "m_trend": ("Trending movies", "movie", "/trending/movie/week", {}, 3),
    "s_trend": ("Trending series", "tv", "/trending/tv/week", {}, 3),
    "m_soon": ("Coming soon", "movie", "/movie/upcoming", {"region": ORIGIN}, 3),
    "m_pop": ("Popular movies", "movie", "/discover/movie", RECENT_MOVIES, 2),
    "s_pop": ("Popular series", "tv", "/discover/tv", RECENT_TV, 2),
}
for _name, _gid in MOVIE_GENRES:
    LISTS["mg%d" % _gid] = (_name, "movie", "/discover/movie", dict(RECENT_MOVIES, with_genres=_gid), 2)
for _name, _gid in TV_GENRES:
    LISTS["sg%d" % _gid] = (_name, "tv", "/discover/tv", dict(RECENT_TV, with_genres=_gid), 2)

# (tab id, tab title, [(list key, wide cards?)])
TABS = [
    ("home", "Home", [("m_latest", True), ("s_new", True), ("m_trend", False), ("s_trend", False),
                      ("m_soon", False), ("s_pop", False)]),
    ("movies", "Movies", [("m_latest", False), ("m_soon", False), ("m_trend", False), ("m_pop", False)]
     + [("mg%d" % g, False) for _, g in MOVIE_GENRES]),
    ("series", "Series", [("s_new", False), ("s_trend", False), ("s_pop", False)]
     + [("sg%d" % g, False) for _, g in TV_GENRES]),
]

VIDEO_ORDER = {"Trailer": 0, "Teaser": 1, "Clip": 2, "Featurette": 3, "Behind the Scenes": 4}

# python.org builds on macOS often ship without CA certs; fall back to the system bundle.
_ssl = ssl.create_default_context()
if not _ssl.get_ca_certs() and os.path.exists("/etc/ssl/cert.pem"):
    _ssl.load_verify_locations("/etc/ssl/cert.pem")


def get_json(url, headers=None, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=dict({"User-Agent": "tv-movies/2.0"}, **(headers or {})))
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


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception as e:
        print("! %s: %s" % (arg, e), file=sys.stderr)
        return None


# ---------------------------------------------------------------- TMDB lists

def card(m, kind):
    date = m.get("release_date") or m.get("first_air_date") or ""
    c = {
        "k": "m" if kind == "movie" else "s",
        "t": m.get("title") or m.get("name") or "",
        "y": year_of(date),
        "p": img(m.get("poster_path"), "w185"),
        "b": img(m.get("backdrop_path"), "w780"),
        "r": round(m.get("vote_average") or 0, 1),
        "o": short(m.get("overview"), 200),
        "g": (m.get("genre_ids") or [])[:3],
    }
    if kind == "movie" and date > TODAY:
        c["soon"] = date
    return c


def fetch_list(path, params, pages):
    out = []
    for page in range(1, pages + 1):
        res = tmdb(path, page=page, **params)
        out += res.get("results", [])
        if page >= res.get("total_pages", 1):
            break
    return out


def build_lists():
    lists, items = {}, {}
    for key, (title, kind, path, params, pages) in LISTS.items():
        try:
            res = fetch_list(path, params, pages)
        except Exception as e:
            print("! list %s: %s" % (title, e), file=sys.stderr)
            continue
        if key == "m_soon":  # upcoming also lists films already out; keep the future ones when there are enough
            future = [m for m in res if (m.get("release_date") or "") > TODAY]
            res = future if len(future) >= 8 else res
        ids = []
        for m in res:
            if not m.get("poster_path") or m.get("adult"):
                continue
            iid = ("m" if kind == "movie" else "s") + str(m["id"])
            if iid not in ids:
                items.setdefault(iid, card(m, kind))
                ids.append(iid)
        lists[key] = ids
    return lists, items


# ---------------------------------------------------------------- TMDB details

def videos_of(v):
    vs = [x for x in (v or {}).get("results", []) if x.get("site") == "YouTube" and x.get("key")]
    vs.sort(key=lambda x: (VIDEO_ORDER.get(x.get("type"), 9), not x.get("official"),
                           x.get("iso_639_1") not in ("en", None), -(x.get("size") or 0)))
    return [{"k": x["key"], "n": short(x.get("name") or x.get("type") or "Video", 60)} for x in vs][:8]


def cast_of(credits):
    return [{"n": c["name"], "c": short(c.get("character") or "", 40), "p": img(c.get("profile_path"), "w185")}
            for c in (credits or {}).get("cast", [])[:12]]


def providers_for(wp):
    region = (wp or {}).get("results", {}).get(REGION) or {}

    def names(kind):
        return [{"n": p["provider_name"], "l": img(p.get("logo_path"), "w92")}
                for p in sorted(region.get(kind, []), key=lambda p: p.get("display_priority", 99))][:6]
    return {"stream": names("flatrate"), "free": names("free") + names("ads"),
            "rent": names("rent"), "buy": names("buy")}


def movie_cert(rd):
    by = {r.get("iso_3166_1"): r.get("release_dates", []) for r in (rd or {}).get("results", [])}
    for country in ("US", "GB"):
        for x in by.get(country, []):
            if x.get("certification"):
                return x["certification"]
    return ""


def tv_cert(cr):
    by = {r.get("iso_3166_1"): r.get("rating") for r in (cr or {}).get("results", [])}
    return by.get("US") or by.get("GB") or ""


def recs_of(r, prefix):
    return [prefix + str(x["id"]) for x in (r or {}).get("results", [])][:30]


def seasons_of(d):
    return [{"n": s["season_number"], "nm": s.get("name") or "Season %d" % s["season_number"],
             "ep": s.get("episode_count") or 0, "y": year_of(s.get("air_date"))}
            for s in d.get("seasons", []) if s.get("season_number") and s.get("episode_count")]


def movie_detail(mid):
    d = tmdb("/movie/%d" % mid, include_video_language="en,null",
             append_to_response="videos,credits,watch/providers,release_dates,recommendations")
    crew = d.get("credits", {}).get("crew", [])
    directors = [c["name"] for c in crew if c.get("job") == "Director"][:2]
    countries = d.get("origin_country") or [c["iso_3166_1"] for c in d.get("production_countries", [])]
    return {
        "id": "m%d" % d["id"], "k": "m", "tm": d["id"], "imdb": d.get("imdb_id") or "",
        "t": d.get("title", ""), "y": year_of(d.get("release_date")),
        "date": d.get("release_date") or "",
        "rt": d.get("runtime") or 0,
        "r": round(d.get("vote_average") or 0, 1),
        "cert": movie_cert(d.get("release_dates")),
        "g": [g["name"] for g in d.get("genres", [])][:3],
        "o": short(d.get("overview"), 700),
        "tag": d.get("tagline", ""),
        "crew": [["Director", directors]] if directors else [],
        "cast": cast_of(d.get("credits")),
        "p": img(d.get("poster_path"), "w342"),
        "b": img(d.get("backdrop_path"), "w1280"),
        "v": videos_of(d.get("videos")),
        "prov": providers_for(d.get("watch/providers")),
        "info": "https://www.themoviedb.org/movie/%d" % d["id"],
        "rec": recs_of(d.get("recommendations"), "m"),
        "_us": ORIGIN in countries,
    }


def tv_detail(sid):
    d = tmdb("/tv/%d" % sid, include_video_language="en,null",
             append_to_response="videos,credits,watch/providers,content_ratings,recommendations,external_ids")
    creators = [c["name"] for c in d.get("created_by", [])][:2]
    networks = [n["name"] for n in d.get("networks", [])][:2]
    ended = d.get("status") in ("Ended", "Canceled")
    return {
        "id": "s%d" % d["id"], "k": "s", "tm": d["id"],
        "imdb": (d.get("external_ids") or {}).get("imdb_id") or "",
        "t": d.get("name", ""), "y": year_of(d.get("first_air_date")),
        "y2": year_of(d.get("last_air_date")) if ended else "",
        "sn": d.get("number_of_seasons") or 0, "ep": d.get("number_of_episodes") or 0,
        "r": round(d.get("vote_average") or 0, 1),
        "cert": tv_cert(d.get("content_ratings")),
        "g": [g["name"] for g in d.get("genres", [])][:3],
        "o": short(d.get("overview"), 700),
        "tag": d.get("tagline", ""),
        "crew": [x for x in (["Created by", creators], ["Network", networks]) if x[1]],
        "cast": cast_of(d.get("credits")),
        "p": img(d.get("poster_path"), "w342"),
        "b": img(d.get("backdrop_path"), "w1280"),
        "v": videos_of(d.get("videos")),
        "prov": providers_for(d.get("watch/providers")),
        "info": "https://www.themoviedb.org/tv/%d" % d["id"],
        "rec": recs_of(d.get("recommendations"), "s"),
        "ss": seasons_of(d),
        "_us": ORIGIN in (d.get("origin_country") or []) and not TV_SKIP & {g["id"] for g in d.get("genres", [])},
    }


def detail_for(iid):
    return movie_detail(int(iid[1:])) if iid[0] == "m" else tv_detail(int(iid[1:]))


def season_detail(job):
    sid, n = job
    e = tmdb("/tv/%d/season/%d" % (sid, n), include_video_language="en,null", append_to_response="videos")
    eps = [{"n": ep.get("episode_number"), "t": ep.get("name") or "", "d": ep.get("air_date") or "",
            "rt": ep.get("runtime") or 0, "r": round(ep.get("vote_average") or 0, 1),
            "o": short(ep.get("overview"), 400), "s": img(ep.get("still_path"), "w300")}
           for ep in e.get("episodes", [])]
    return {"n": n, "nm": e.get("name") or "Season %d" % n, "o": short(e.get("overview"), 400),
            "v": videos_of(e.get("videos")), "eps": eps[-MAX_EPISODES:]}


# ---------------------------------------------------------------- main

def more_like_this(details, items):
    """TMDB recommendations that are in the catalog, topped up with same-genre titles."""
    by_genre = {}
    for iid, c in items.items():
        for g in c.get("g", [])[:1]:
            by_genre.setdefault((c["k"], g), []).append(iid)
    for iid, d in details.items():
        more = [r for r in d.pop("rec", []) if r in details and r != iid]
        c = items[iid]
        for g in c.get("g", [])[:1]:
            for other in by_genre.get((c["k"], g), []):
                if len(more) >= 16:
                    break
                if other != iid and other not in more:
                    more.append(other)
        d["more"] = more[:16]


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def main():
    if not (TOKEN or API_KEY):
        sys.exit("Set TMDB_TOKEN (or TMDB_API_KEY) in .env or the environment.")
    tmp = OUT + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, "d"))
    os.makedirs(os.path.join(tmp, "e"))

    lists, items = build_lists()
    details = {}
    with ThreadPoolExecutor(8) as pool:
        for iid, d in zip(list(items), pool.map(lambda i: _safe(detail_for, i), list(items))):
            if d and d.pop("_us"):
                details[iid] = d
    print("details: %d %s titles of %d fetched" % (len(details), ORIGIN, len(items)))
    # Titles that failed or aren't from ORIGIN can't be opened, so drop them everywhere.
    items = {iid: c for iid, c in items.items() if iid in details}
    more_like_this(details, items)

    jobs = [(d["tm"], s["n"]) for d in details.values() if d["k"] == "s" for s in d["ss"][-LATEST_SEASONS:]]
    seasons = 0
    with ThreadPoolExecutor(8) as pool:
        for job, season in zip(jobs, pool.map(lambda j: _safe(season_detail, j), jobs)):
            if season:
                write_json(os.path.join(tmp, "e", "s%d-%d.json" % job), season)
                seasons += 1
    print("seasons: %d of %d" % (seasons, len(jobs)))

    genres = {}
    for kind in ("movie", "tv"):
        try:
            for g in tmdb("/genre/%s/list" % kind).get("genres", []):
                genres.setdefault(str(g["id"]), g["name"])
        except Exception as e:
            print("! genres %s: %s" % (kind, e), file=sys.stderr)

    tabs = []
    for tab_id, tab_title, specs in TABS:
        rows = []
        for key, wide in specs:
            ids = [i for i in lists.get(key, []) if i in items][:HOME_PER_ROW if tab_id == "home" else PER_ROW]
            if ids:
                row = {"title": LISTS[key][0], "items": ids}
                if wide:
                    row["wide"] = 1
                rows.append(row)
                if tab_id != "home":
                    print("%-22s %d" % (row["title"], len(ids)))
        if rows:
            tabs.append({"id": tab_id, "title": tab_title, "rows": rows})

    if not items:
        sys.exit("Nothing fetched; keeping the previous catalog.")

    for iid, d in details.items():
        write_json(os.path.join(tmp, "d", iid + ".json"), d)
    write_json(os.path.join(tmp, "home.json"),
               {"built": int(time.time()), "key": SEARCH_KEY,
                "genres": genres, "tabs": tabs, "items": items})

    shutil.rmtree(OUT, ignore_errors=True)
    os.rename(tmp, OUT)
    print("wrote %d tabs, %d titles, %d seasons -> %s" % (len(tabs), len(items), seasons, os.path.relpath(OUT)))


if __name__ == "__main__":
    main()
