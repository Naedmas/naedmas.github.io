#!/usr/bin/env python3
"""Sync the public Librarium booklist from a local Notion export.

Source of truth is the personal-hobby Notion database "Novels"
(under Warhammer 40,000 / Lore).

    Database ID:     4b946981-c4b0-4470-b957-75ddf336ff23
    Data source ID:  a84528f4-1192-4f59-aef1-e4524e679e8e
    collection://a84528f4-1192-4f59-aef1-e4524e679e8e

Character names are resolved from the related "Characters" data source
(collection://338d1568-be75-411f-94a2-2bfab5254ef4) — names only.

This script never talks to Notion itself and must never write to Notion.
Re-run after refreshing the raw export:

    python3 scripts/sync_books.py

Raw data (kept outside the public repo by default):

    $NOTION_BOOKS_RAW  or  /workspace/notion-books-raw/

        novels.json              SQL/rows dump of Novels
        characters.json          SQL dump of Characters (url + Name at least)
        covers.json              Optional title -> list of cover URLs
                                 (from page fetches with include_file_urls)
        pages/*.json             Optional notion-fetch dumps of each row
        orig/                    Already-downloaded originals that are
                                 allowed (never official / wiki cover art):
                                 <Title>__<index>__<original-filename>.<ext>

Writes into the site repo (this script's parent / ..):

    blog/books.json
    blog/img/<slug>.jpg
    blog/img/<slug>-thumb.jpg

Cover policy
------------
Notion file URLs expire, so any allowed cover is downloaded and committed.
Official Black Library / Games Workshop / Lexicanum / wiki cover art is
NOT downloaded or published (standing site rule: no official artwork).
Those titles use the original placeholder SVG at blog/img/placeholder.svg.
If a later export has a user-uploaded file (e.g. a Notion-hosted image
or another allowed host), it is resized with Pillow and committed.

Property policy — Novels
------------------------
  Title (title)             INCLUDE  as title / id
  Author (text)             INCLUDE
  Series (text)             INCLUDE
  Type (select)             INCLUDE
  Focus (multi_select)      INCLUDE  (Dark Angels, Unforgiven, Fallen, …)
  Read Status (status)      INCLUDE  as status
  Edition focus (select)    INCLUDE  as edition
  Summary (text)            INCLUDE  (public lore blurbs)
  Official link (url)       INCLUDE  when it is a public lore/wiki link,
                                     not a shop / purchase location
  Cover (files)             INCLUDE  only if the URL is allowed; else placeholder
  Characters (relation)     INCLUDE  resolved character names only
  url (system)              EXCLUDE  (private Notion page links)
  createdTime (system)      EXCLUDE  (when the row was added, not a pub date)

There is no rating, price, or purchase-location field in this database.

Property policy — Characters (resolved)
---------------------------------------
  Name                      INCLUDE  as characters[]
  url, Official link, Summary, Status, Role, Faction, Wing,
  Edition focus, Other sources, Tabletop model,
  Models owned, Appears in  EXCLUDE

Weekly refresh (same cadence as the Armoury, personal Notion only, read-only):
  1. Query Novels (collection://a84528f4-1192-4f59-aef1-e4524e679e8e)
     and write novels.json under /workspace/notion-books-raw/.
  2. Query Characters for url + Name
     (collection://338d1568-be75-411f-94a2-2bfab5254ef4)
     and write characters.json.
  3. Optionally fetch each book page with file URLs and store Cover
     lists in covers.json or pages/<Title>.json.
  4. From the site repo: python3 scripts/sync_books.py
  5. If blog/books.json or allowed images changed, commit, push main,
     and confirm the GitHub Pages build.
  6. Never modify Notion. Never use the Vemag Australia workspace.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo

from PIL import Image, ImageOps

BRISBANE = ZoneInfo("Australia/Brisbane")
FULL_EDGE = 1200
THUMB_EDGE = 500
JPEG_QUALITY = 85

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = Path("/workspace/notion-books-raw")
OUT_DIR = REPO_ROOT / "blog"
IMG_DIR = OUT_DIR / "img"

SOURCE_NAME = "Novels"
SOURCE_DB_ID = "4b946981-c4b0-4470-b957-75ddf336ff23"
SOURCE_DS_ID = "a84528f4-1192-4f59-aef1-e4524e679e8e"

# Official / wiki cover art must not be downloaded or committed.
BLOCKED_COVER_HOSTS = (
    "lexicanum.com",
    "games-workshop.com",
    "warhammer.com",
    "warhammer40000.com",
    "blacklibrary.com",
    "forgeworld.com",
    "gw-media.com",
    "gamesworkshop.com",
)

# Official-link hosts that look like shops rather than public lore pages.
BLOCKED_LINK_HOSTS = (
    "games-workshop.com",
    "gamesworkshop.com",
    "warhammer.com",
    "blacklibrary.com",
    "amazon.",
    "ebay.",
    "etsy.com",
    "bookdepository.",
    "mightyape.",
)


def load_results(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    return data.get("results") or data.get("rows") or []


def parse_jsonish(value: Any) -> Any:
    if value is None or value == "":
        return None
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text in ("null", "None", "{}"):
            return None
        if text == "[]":
            return []
        if text.startswith("[") or text.startswith("{"):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return value


def as_list(value: Any) -> list[Any]:
    value = parse_jsonish(value)
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [v for v in value if v not in (None, "")]
    return [value]


def page_key(url: str | None) -> str | None:
    if not url:
        return None
    slug = str(url).rstrip("/").split("/")[-1].split("?")[0]
    if slug.startswith("p/") or "/p/" in str(url):
        slug = str(url).rstrip("/").split("/")[-1].split("?")[0]
    return slug or None


def index_by_url(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = page_key(row.get("url"))
        if key:
            out[key] = row
    return out


def slugify(name: str) -> str:
    slug = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug or "book"


def unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def is_blocked_host(url: str, blocked: tuple[str, ...]) -> bool:
    host = host_of(url)
    if not host:
        return False
    return any(host == b or host.endswith("." + b.lstrip(".")) or b in host for b in blocked if not b.endswith(".")) or any(
        b.rstrip(".") in host for b in blocked if b.endswith(".")
    )


def cover_allowed(url: str) -> bool:
    if not url or not url.startswith("http"):
        return False
    return not is_blocked_host(url, BLOCKED_COVER_HOSTS)


def official_link_allowed(url: str) -> str | None:
    text = (url or "").strip()
    if not text:
        return None
    if "notion.so" in text or "notion.com" in text:
        return None
    if is_blocked_host(text, BLOCKED_LINK_HOSTS):
        return None
    return text


def filename_from_url(url: str, fallback: str) -> str:
    name = unquote(urlparse(url).path.split("/")[-1])
    if not name or "." not in name:
        name = fallback + ".bin"
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def find_originals(raw_dir: Path, title: str) -> list[Path]:
    orig_dir = raw_dir / "orig"
    if not orig_dir.is_dir():
        return []
    matches = sorted(orig_dir.glob(f"{title}__*"))
    return [p for p in matches if p.is_file()]


def extract_cover_urls(raw_dir: Path, title: str) -> list[str]:
    covers_path = raw_dir / "covers.json"
    if covers_path.is_file():
        data = json.loads(covers_path.read_text())
        urls = data.get(title) if isinstance(data, dict) else None
        if urls:
            return [u for u in as_list(urls) if isinstance(u, str) and u.startswith("http")]
    page_path = raw_dir / "pages" / f"{title}.json"
    if not page_path.is_file():
        # also try slug filename
        alt = raw_dir / "pages" / f"{slugify(title)}.json"
        page_path = alt if alt.is_file() else page_path
    if not page_path.is_file():
        return []
    text = page_path.read_text()
    try:
        obj = json.loads(text)
        props = obj.get("properties") or {}
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except json.JSONDecodeError:
                props = {}
        urls = [u for u in as_list(props.get("Cover")) if isinstance(u, str) and u.startswith("http")]
        if urls:
            return urls
        text = obj.get("text") or text
    except json.JSONDecodeError:
        pass
    match = re.search(r"<properties>\s*(\{.*?\})\s*</properties>", text, re.S)
    if not match:
        return []
    try:
        props = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    return [u for u in as_list(props.get("Cover")) if isinstance(u, str) and u.startswith("http")]


def download_missing(raw_dir: Path, title: str) -> list[Path]:
    existing = find_originals(raw_dir, title)
    if existing:
        return existing
    urls = [u for u in extract_cover_urls(raw_dir, title) if cover_allowed(u)]
    if not urls:
        skipped = extract_cover_urls(raw_dir, title)
        if skipped:
            print(f"  skip official/blocked cover for {title}")
        return []
    orig_dir = raw_dir / "orig"
    orig_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for index, url in enumerate(urls):
        dest = orig_dir / f"{title}__{index}__{filename_from_url(url, slugify(title))}"
        request = urllib.request.Request(url, headers={"User-Agent": "naedmas-books-sync/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=60) as resp:
                dest.write_bytes(resp.read())
            saved.append(dest)
            print(f"  downloaded {dest.name} ({dest.stat().st_size} bytes)")
        except Exception as exc:
            print(f"  FAIL download for {title}: {exc}", file=sys.stderr)
    return saved


def resize_to_jpeg(src: Path, dest: Path, max_edge: int) -> None:
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        elif im.mode == "L":
            im = im.convert("RGB")
        w, h = im.size
        long_edge = max(w, h)
        if long_edge > max_edge:
            scale = max_edge / long_edge
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        im.save(dest, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)


def resolve_characters(row: dict[str, Any], lookup: dict[str, dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for item in as_list(row.get("Characters")):
        url = item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else None)
        key = page_key(url)
        rec = lookup.get(key) if key else None
        name = (rec.get("Name") if rec else None) or ""
        name = name.strip()
        if name:
            names.append(name)
    return unique(names)


def build_record(
    row: dict[str, Any],
    characters: list[str],
    image_files: list[str],
    thumb_files: list[str],
) -> dict[str, Any]:
    title = (row.get("Title") or "").strip()
    return {
        "id": slugify(title),
        "title": title,
        "author": (row.get("Author") or "").strip() or None,
        "series": (row.get("Series") or "").strip() or None,
        "type": (row.get("Type") or "").strip() or None,
        "focus": unique(str(v) for v in as_list(row.get("Focus"))),
        "status": (row.get("Read Status") or "").strip() or None,
        "edition": (row.get("Edition focus") or "").strip() or None,
        "summary": (row.get("Summary") or "").strip() or None,
        "officialLink": official_link_allowed(row.get("Official link") or ""),
        "characters": characters,
        "images": image_files,
        "thumbs": thumb_files,
        "image": image_files[0] if image_files else None,
        "thumb": thumb_files[0] if thumb_files else None,
    }


def main() -> int:
    raw_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        os.environ.get("NOTION_BOOKS_RAW", str(DEFAULT_RAW))
    )
    novels_path = raw_dir / "novels.json"
    characters_path = raw_dir / "characters.json"
    missing = [p.name for p in (novels_path, characters_path) if not p.is_file()]
    if missing:
        print(f"Missing raw files in {raw_dir}: {', '.join(missing)}", file=sys.stderr)
        print("Export the personal Notion dumps first, then re-run.", file=sys.stderr)
        return 1

    novels = load_results(novels_path)
    characters = index_by_url(load_results(characters_path))

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    for stale in IMG_DIR.glob("*.jpg"):
        stale.unlink()

    records: list[dict[str, Any]] = []
    used_ids: dict[str, int] = {}
    with_images = 0
    skipped_covers = 0
    for row in novels:
        title = (row.get("Title") or "").strip()
        if not title:
            continue
        originals = download_missing(raw_dir, title) or find_originals(raw_dir, title)
        if not originals and extract_cover_urls(raw_dir, title):
            skipped_covers += 1
        image_files: list[str] = []
        thumb_files: list[str] = []
        base = slugify(title)
        used_ids[base] = used_ids.get(base, 0) + 1
        slug = base if used_ids[base] == 1 else f"{base}-{used_ids[base]}"
        for index, src in enumerate(originals):
            suffix = "" if index == 0 else f"-{index + 1}"
            full_rel = f"img/{slug}{suffix}.jpg"
            thumb_rel = f"img/{slug}{suffix}-thumb.jpg"
            print(f"  resize {title} {src.name} -> {full_rel}")
            resize_to_jpeg(src, IMG_DIR / f"{slug}{suffix}.jpg", FULL_EDGE)
            resize_to_jpeg(src, IMG_DIR / f"{slug}{suffix}-thumb.jpg", THUMB_EDGE)
            image_files.append(full_rel)
            thumb_files.append(thumb_rel)
        if image_files:
            with_images += 1
        rec = build_record(row, resolve_characters(row, characters), image_files, thumb_files)
        rec["id"] = slug
        records.append(rec)

    records.sort(key=lambda r: ((r.get("series") or "zzz").lower(), (r.get("title") or "").lower()))
    payload = {
        "updatedAt": datetime.now(BRISBANE).isoformat(timespec="seconds"),
        "source": SOURCE_NAME,
        "sourceId": SOURCE_DB_ID,
        "dataSourceId": SOURCE_DS_ID,
        "count": len(records),
        "books": records,
    }
    out_json = OUT_DIR / "books.json"
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Wrote {out_json} ({len(records)} books, {with_images} with images, "
        f"{skipped_covers} official covers skipped)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
