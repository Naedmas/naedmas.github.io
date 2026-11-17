#!/usr/bin/env python3
"""Sync the public Apothecarion catalogue from a local Notion export.

Source of truth is the personal-hobby Notion database "Bits"
(under Warhammer 40,000). This script never talks to Notion itself
and must never write to Notion. Re-run after refreshing the raw export:

    python3 scripts/sync_bits.py

Raw data (kept outside the public repo by default):

    $NOTION_BITS_RAW  or  /workspace/notion-bits-raw/

        bits.json            Rows dump of the Bits database
        kit_catalog.json     Kits catalog (kit name only)
        model_catalog.json   Model catalog (unit name + faction)
        image_refs.json      Optional notion-file-block references
        orig/                Already-downloaded originals:
                             <slug>__<full32hex-blockid>__orig.<ext>
        pages/*.json         Optional per-page or paged dumps
                             (include_file_urls). Signed URLs expire
                             in minutes; used only if orig/ is missing
                             a file, then the download is cached in orig/.

Writes into the site repo (this script's parent / ..):

    apothecarion/bits.json
    apothecarion/img/<slug>.webp          and .jpg fallback
    apothecarion/img/<slug>-thumb.webp    and .jpg fallback

Pillow resizes the long edge to 1000px (full) and 400px (thumb),
preserving aspect ratio. Titles with no Image, or whose download
fails, use the original themed placeholder on the page (no image
fields are written).

Property policy
---------------
Bits (source database):
  Name (title)              INCLUDE  as name / id (HTML stripped)
  Image (files)             INCLUDE  downloaded into apothecarion/img
                                     (any host); placeholder if missing
                                     or download fails
  Armour Type (select)      INCLUDE  as armourType
  Kits (relation)           INCLUDE  resolved kit name(s) only
  Model (relation)          INCLUDE  resolved model name(s) only;
                                     Faction from the model catalog
  Euro (number)             EXCLUDE  (price)
  Qty (number)              INCLUDE  as qty (integer); omitted if blank
  Bitz Box Code (text)      EXCLUDE  (private storage location)
  url (system)              EXCLUDE  (private Notion page links)
  createdTime (system)      EXCLUDE

Kit catalog (resolved):
  Name                      INCLUDE
  other properties          EXCLUDE

Model catalog (resolved):
  Name                      INCLUDE  as models[]
  Faction (select)          INCLUDE  as faction (first non-empty)
  other properties          EXCLUDE

Weekly refresh (same time as the Armoury / Librarium sync):
  1. Use only the personal Notion connector (user-Notion--personal),
     read-only. Never the Vemag Notion, and never write to Notion.
  2. Fetch the Bits database (id 3ee2db47-2d73-8028-a9fd-f1ed0879e636,
     data source collection://3ee2db47-2d73-8011-9a38-000bd87f21bf)
     if the schema may have changed.
  3. Export every Bits row into /workspace/notion-bits-raw/bits.json.
     Prefer view-mode pagination on
     view://3ee2db47-2d73-8052-b959-000ce5981487 (page_size 50, follow
     next_cursor until has_more is false). SQL/rows queries also work
     when the workspace Query Data Source allowance remains.
  4. Export the Kits catalog
     (collection://3e72db47-2d73-8000-a2ad-000bb308fd4b) as
     kit_catalog.json (url, Name) and the Model catalog
     (collection://3ed2db47-2d73-807d-84b7-000b4036e072) as
     model_catalog.json (url, Name, Faction).
  5. For each bit with an Image (or a page cover if Image is empty),
     resolve a signed download URL (get_file_download_urls with
     notion-file-block:// references, up to 25 at a time, or fetch
     the page with include_file_urls) and download any missing
     originals into /workspace/notion-bits-raw/orig/ before the
     signed URLs expire.
  6. Run: python3 scripts/sync_bits.py
  7. If apothecarion/bits.json or apothecarion/img/ changed, commit
     and push to main, then confirm the GitHub Pages build.
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
FULL_EDGE = 1000
THUMB_EDGE = 400
JPEG_QUALITY = 78
WEBP_QUALITY = 72
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = Path("/workspace/notion-bits-raw")
OUT_DIR = REPO_ROOT / "apothecarion"
IMG_DIR = OUT_DIR / "img"

SOURCE_NAME = "Bits"
SOURCE_ID = "3ee2db47-2d73-8028-a9fd-f1ed0879e636"
DATA_SOURCE_ID = "3ee2db47-2d73-8011-9a38-000bd87f21bf"


def load_results(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    return data.get("results") or data.get("rows") or data.get("bits") or []


def parse_jsonish(value: Any) -> Any:
    if value is None or value == "":
        return None
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text[0] in "[{":
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return value


def as_list(value: Any) -> list[Any]:
    value = parse_jsonish(value)
    if value is None or value == "" or value == "[]":
        return []
    if isinstance(value, list):
        return value
    return [value]


def strip_html(value: str | None) -> str:
    text = re.sub(r"<br\s*/?>", " ", value or "", flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def html_unescape(value: str) -> str:
    return (
        value.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )


def page_key(url: str | None) -> str | None:
    if not url:
        return None
    slug = str(url).rstrip("/").split("/")[-1].split("?")[0]
    hexid = re.sub(r"[^0-9a-fA-F]", "", slug)
    if len(hexid) == 32:
        return f"{hexid[0:8]}-{hexid[8:12]}-{hexid[12:16]}-{hexid[16:20]}-{hexid[20:32]}"
    return slug or None


def short_id(url: str | None) -> str:
    key = page_key(url) or ""
    return key.replace("-", "") or "bit"


def index_by_url(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = page_key(row.get("url"))
        if key:
            out[key] = row
        # also index un-dashed /p/ forms
        raw = str(row.get("url") or "").rstrip("/").split("/")[-1].split("?")[0]
        if raw:
            out[raw] = row
    return out


def slugify(name: str) -> str:
    slug = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug or "bit"


def unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def host_of(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def filename_from_url(url: str, fallback: str) -> str:
    name = unquote(urlparse(url.split("?")[0]).path.split("/")[-1])
    if not name or "." not in name:
        name = fallback + ".bin"
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def find_originals(raw_dir: Path, name: str, url: str | None) -> list[Path]:
    orig_dir = raw_dir / "orig"
    if not orig_dir.is_dir():
        return []
    sid = short_id(url)
    slug = slugify(name)
    matches = sorted(orig_dir.glob(f"*__{sid}__*")) or sorted(orig_dir.glob(f"{slug}__*"))
    return [p for p in matches if p.is_file() and p.stat().st_size > 32]


def extract_image_urls(raw_dir: Path, row: dict[str, Any], name: str) -> list[str]:
    # Optional images.json: page url or name -> url or list of urls
    images_path = raw_dir / "images.json"
    url = row.get("url")
    if images_path.is_file():
        data = json.loads(images_path.read_text())
        if isinstance(data, dict):
            for key in (url, page_key(url), name):
                if key and key in data:
                    return [u for u in as_list(data[key]) if isinstance(u, str) and u.startswith("http")]
    # pages dumps or paged exports may include signed Image URLs
    for candidate in (
        raw_dir / "pages" / f"{slugify(name)}.json",
        raw_dir / "pages" / f"{page_key(url) or 'none'}.json",
    ):
        if not candidate.is_file():
            continue
        text = candidate.read_text()
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = {}
        props = obj.get("properties") or {}
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except json.JSONDecodeError:
                props = {}
        urls = [u for u in as_list(props.get("Image") or props.get("cover")) if isinstance(u, str) and u.startswith("http")]
        if not urls:
            cover = obj.get("cover") or {}
            file = cover.get("file") if isinstance(cover, dict) else None
            if isinstance(file, dict) and isinstance(file.get("url"), str):
                urls = [file["url"]]
        if urls:
            return urls
    return []


def download_missing(raw_dir: Path, name: str, url: str | None, row: dict[str, Any]) -> list[Path]:
    existing = find_originals(raw_dir, name, url)
    if existing:
        return existing
    urls = extract_image_urls(raw_dir, row, name)
    if not urls:
        return []
    orig_dir = raw_dir / "orig"
    orig_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    sid = short_id(url)
    slug = slugify(name)
    for index, image_url in enumerate(urls):
        dest = orig_dir / f"{slug}__{sid}__{index}__{filename_from_url(image_url, slug)}"
        headers = {
            "User-Agent": BROWSER_UA,
            "Accept": "image/jpeg,image/png,image/webp,image/*,*/*;q=0.8",
        }
        host = host_of(image_url)
        if host:
            scheme = "https" if image_url.startswith("https") else "http"
            headers["Referer"] = f"{scheme}://{host}/"
        request = urllib.request.Request(image_url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as resp:
                data = resp.read()
            if len(data) < 32:
                raise ValueError(f"suspiciously small response ({len(data)} bytes)")
            dest.write_bytes(data)
            saved.append(dest)
            print(f"  downloaded {dest.name} ({dest.stat().st_size} bytes)")
        except Exception as exc:
            print(f"  FAIL download for {name}: {exc}", file=sys.stderr)
    return saved


def prepared_image(src: Path, max_edge: int) -> Image.Image:
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        background = Image.new("RGB", im.size, (8, 12, 9))
        rgba = im.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        im = background
    elif im.mode != "RGB":
        im = im.convert("RGB")
    w, h = im.size
    long_edge = max(w, h)
    if long_edge > max_edge:
        scale = max_edge / long_edge
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    return im


def resize_image(src: Path, dest_jpg: Path, dest_webp: Path, max_edge: int) -> None:
    dest_jpg.parent.mkdir(parents=True, exist_ok=True)
    with prepared_image(src, max_edge) as im:
        im.save(dest_jpg, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        im.save(dest_webp, "WEBP", quality=WEBP_QUALITY, method=6)


def resolve_names(row: dict[str, Any], field: str, lookup: dict[str, dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for item in as_list(row.get(field)):
        url = item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else None)
        rec = None
        key = page_key(url)
        if key:
            rec = lookup.get(key)
        if rec is None and url:
            raw = str(url).rstrip("/").split("/")[-1].split("?")[0]
            rec = lookup.get(raw)
        name = strip_html((rec.get("Name") if rec else None) or "")
        if name:
            names.append(name)
    return unique(names)


def resolve_faction(row: dict[str, Any], lookup: dict[str, dict[str, Any]]) -> str | None:
    for item in as_list(row.get("Model")):
        url = item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else None)
        rec = None
        key = page_key(url)
        if key:
            rec = lookup.get(key)
        if rec is None and url:
            rec = lookup.get(str(url).rstrip("/").split("/")[-1].split("?")[0])
        if not rec:
            continue
        faction = strip_html(str(rec.get("Faction") or ""))
        if faction:
            return faction
    return None


def parse_qty(value: Any) -> int | None:
    """Return Qty as an int, or None when the field is blank or invalid."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return int(value) if value == int(value) else int(round(value))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        if number != number or number in (float("inf"), float("-inf")):
            return None
        return int(number) if number == int(number) else int(round(number))
    return None


def build_record(
    name: str,
    bit_id: str,
    armour: str | None,
    kits: list[str],
    models: list[str],
    faction: str | None,
    qty: int | None,
    image_files: list[str],
    thumb_files: list[str],
    image_webp: list[str],
    thumb_webp: list[str],
) -> dict[str, Any]:
    record = {
        "id": bit_id,
        "name": name,
        "armourType": armour,
        "kits": kits,
        "models": models,
        "faction": faction,
        "images": image_files,
        "thumbs": thumb_files,
        "imagesWebp": image_webp,
        "thumbsWebp": thumb_webp,
        "image": image_files[0] if image_files else None,
        "thumb": thumb_files[0] if thumb_files else None,
        "imageWebp": image_webp[0] if image_webp else None,
        "thumbWebp": thumb_webp[0] if thumb_webp else None,
    }
    if qty is not None:
        record["qty"] = qty
    return record


def main() -> int:
    raw_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        os.environ.get("NOTION_BITS_RAW", str(DEFAULT_RAW))
    )
    bits_path = raw_dir / "bits.json"
    if not bits_path.is_file():
        print(f"Missing {bits_path}", file=sys.stderr)
        return 1

    bits_rows = load_results(bits_path)
    kits = index_by_url(load_results(raw_dir / "kit_catalog.json") if (raw_dir / "kit_catalog.json").is_file() else [])
    models = index_by_url(load_results(raw_dir / "model_catalog.json") if (raw_dir / "model_catalog.json").is_file() else [])

    IMG_DIR.mkdir(parents=True, exist_ok=True)

    used_ids: set[str] = set()
    records: list[dict[str, Any]] = []
    with_images = 0
    failed = 0
    failed_names: list[str] = []

    def make_id(name: str, url: str | None) -> str:
        base = slugify(name)
        candidate = base
        if candidate in used_ids:
            candidate = f"{base}-{short_id(url)}"
        suffix = 2
        while candidate in used_ids:
            candidate = f"{base}-{short_id(url)}-{suffix}"
            suffix += 1
        used_ids.add(candidate)
        return candidate

    rows_sorted = sorted(bits_rows, key=lambda r: (strip_html(r.get("Name") or "").lower(), r.get("url") or ""))
    for row in rows_sorted:
        name = strip_html(row.get("Name") or row.get("n") or "")
        if not name:
            continue
        url = row.get("url")
        bit_id = make_id(name, url)
        armour = strip_html(row.get("Armour Type") or row.get("a") or "") or None
        kit_names = resolve_names(row, "Kits", kits) or resolve_names(row, "k", kits)
        model_names = resolve_names(row, "Model", models) or resolve_names(row, "m", models)
        faction = resolve_faction(row, models)

        originals = download_missing(raw_dir, name, url, row) or find_originals(raw_dir, name, url)
        image_files: list[str] = []
        thumb_files: list[str] = []
        image_webp: list[str] = []
        thumb_webp: list[str] = []
        if originals:
            try:
                for index, src in enumerate(originals[:1]):
                    suffix = "" if index == 0 else f"-{index + 1}"
                    full_jpg = IMG_DIR / f"{bit_id}{suffix}.jpg"
                    full_webp = IMG_DIR / f"{bit_id}{suffix}.webp"
                    thumb_jpg = IMG_DIR / f"{bit_id}{suffix}-thumb.jpg"
                    thumb_webp_path = IMG_DIR / f"{bit_id}{suffix}-thumb.webp"
                    resize_image(src, full_jpg, full_webp, FULL_EDGE)
                    resize_image(src, thumb_jpg, thumb_webp_path, THUMB_EDGE)
                    image_files.append(f"img/{full_jpg.name}")
                    image_webp.append(f"img/{full_webp.name}")
                    thumb_files.append(f"img/{thumb_jpg.name}")
                    thumb_webp.append(f"img/{thumb_webp_path.name}")
                with_images += 1
            except Exception as exc:
                failed += 1
                failed_names.append(name)
                print(f"  FAIL resize for {name}: {exc}", file=sys.stderr)
                image_files, thumb_files, image_webp, thumb_webp = [], [], [], []
        elif as_list(row.get("Image") or row.get("i")):
            failed += 1
            failed_names.append(name)
            print(f"  FAIL missing original for {name}", file=sys.stderr)

        records.append(build_record(
            name, bit_id, armour, kit_names, model_names, faction,
            parse_qty(row.get("Qty") if "Qty" in row else row.get("q")),
            image_files, thumb_files, image_webp, thumb_webp,
        ))

    payload = {
        "updatedAt": datetime.now(BRISBANE).isoformat(timespec="seconds"),
        "source": SOURCE_NAME,
        "sourceId": SOURCE_ID,
        "dataSourceId": DATA_SOURCE_ID,
        "count": len(records),
        "bits": records,
    }
    out_path = OUT_DIR / "bits.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Wrote {out_path.relative_to(REPO_ROOT)} "
        f"({len(records)} bits, {with_images} with images, {failed} failed)."
    )
    if failed_names:
        print("Failed:", "; ".join(failed_names[:30]) + ("…" if len(failed_names) > 30 else ""))
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
