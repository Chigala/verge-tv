#!/usr/bin/env python3
"""Fetches The Verge's public Atom feeds and turns them into small JSON files.

The feeds have no CORS headers, so the TV page can't read them directly.
Instead this script (run by server.py locally, or by the GitHub Action when
hosted) writes docs/feeds/<section>.json, which the page reads.

Run:  python3 feeds.py        writes every section into docs/feeds/
"""

import html
import json
import os
import re
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

FEEDS = {
    "latest": "https://www.theverge.com/rss/index.xml",
    "gadgets": "https://www.theverge.com/rss/gadgets/index.xml",
    "reviews": "https://www.theverge.com/rss/reviews/index.xml",
    "science": "https://www.theverge.com/rss/science/index.xml",
    "entertainment": "https://www.theverge.com/rss/entertainment/index.xml",
    "ai": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    "games": "https://www.theverge.com/rss/games/index.xml",
    "policy": "https://www.theverge.com/rss/policy/index.xml",
}
ATOM = "{http://www.w3.org/2005/Atom}"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "docs", "feeds")

# python.org builds on macOS often ship without CA certs; fall back to the
# system bundle so HTTPS verification still works.
_ssl_ctx = ssl.create_default_context()
if not _ssl_ctx.get_ca_certs() and os.path.exists("/etc/ssl/cert.pem"):
    _ssl_ctx.load_verify_locations("/etc/ssl/cert.pem")


def _text(el):
    return (el.text or "").strip() if el is not None else ""


def _strip_tags(s):
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _first_image(content_html):
    m = re.search(r'<img[^>]+src="([^"]+)"', content_html)
    if not m:
        return ""
    url = html.unescape(m.group(1))
    # Ask the image CDN for a TV-sized copy instead of the full original.
    return url + ("&" if "?" in url else "?") + "w=960"


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = []
    for entry in root.findall(ATOM + "entry"):
        link = ""
        for l in entry.findall(ATOM + "link"):
            if l.get("rel", "alternate") == "alternate":
                link = l.get("href", "")
                break
        content = _text(entry.find(ATOM + "content"))
        summary = _strip_tags(_text(entry.find(ATOM + "summary")))
        body = [
            _strip_tags(p)
            for p in re.findall(r"<p[^>]*>(.*?)</p>", content, re.S)
            if "Read the full story" not in p
        ]
        published = _text(entry.find(ATOM + "published")) or _text(entry.find(ATOM + "updated"))
        try:
            ts = int(datetime.fromisoformat(published).timestamp() * 1000)
        except ValueError:
            ts = 0
        items.append({
            "title": html.unescape(_text(entry.find(ATOM + "title"))),
            "link": link,
            "author": _text(entry.find(ATOM + "author/" + ATOM + "name")),
            "ts": ts,
            "categories": [c.get("term") for c in entry.findall(ATOM + "category")][:3],
            "summary": summary,
            "body": [p for p in body if p],
            "image": _first_image(content),
        })
    return items


def fetch_section(section):
    req = urllib.request.Request(FEEDS[section], headers={"User-Agent": "verge-tv/1.0"})
    with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx) as resp:
        return parse_feed(resp.read())


def to_json(section, items):
    return json.dumps({"section": section, "items": items}, ensure_ascii=False, indent=1)


def build_all():
    os.makedirs(OUT_DIR, exist_ok=True)
    failed = 0
    for section in FEEDS:
        try:
            items = fetch_section(section)
        except Exception as e:  # keep the previous file if one feed hiccups
            print("! %s: %s" % (section, e), file=sys.stderr)
            failed += 1
            continue
        with open(os.path.join(OUT_DIR, section + ".json"), "w", encoding="utf-8") as f:
            f.write(to_json(section, items))
        print("%-14s %d stories" % (section, len(items)))
    return failed


if __name__ == "__main__":
    sys.exit(1 if build_all() == len(FEEDS) else 0)
