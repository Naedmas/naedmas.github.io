#!/usr/bin/env python3
"""Sync the public Armoury gallery from a local Notion export.

Source of truth is the personal-hobby Notion database "My Individual Models".
This script never talks to Notion itself (and must never write to Notion).
Re-run after refreshing the raw export:

    python3 scripts/sync_models.py

Raw data (kept outside the public repo by default):

    $NOTION_MODELS_RAW  or  /workspace/notion-models-raw/

        individual_models.json   SQL/rows dump of My Individual Models
        model_catalog.json       Model catalog (unit name + faction)
        kit_catalog.json         Kit catalog (kit name only)
        models_owned.json        Models Owned (squad name + public fields)
        orig/                    Already-downloaded originals:
                                 <Name>__<index>__<original-filename>.<ext>
        pages/*.json             Optional notion-fetch dumps of each row
                                 (include_file_urls). Signed URLs expire
                                 in minutes; used only if orig/ is missing
                                 a file, then the download is cached in orig/.

Writes into the site repo (this script's parent / ..):

    armoury/models.json
    armoury/img/<slug>.jpg
    armoury/img/<slug>-thumb.jpg

Pillow resizes the long edge to 1200px (full) and 500px (thumb).

Property policy
---------------
My Individual Models (source database):
  Name (title)              INCLUDE  as name / id
  Image (files)             INCLUDE  downloaded into armoury/img
  Kit (relation)            INCLUDE  resolved kit name only
  Model (relation)          INCLUDE  resolved unit name; Faction from catalog
  Squads (relation)         INCLUDE  resolved Models Owned name + public fields
  Status (status)           INCLUDE
  Wargear (multi_select)    INCLUDE
  url (system)              EXCLUDE  (private Notion page links)
  createdTime (system)      INCLUDE  as created (Australia/Brisbane date)

Kit catalog (resolved):
  Name                      INCLUDE
  Assembly Guide (files)    EXCLUDE
  other relations           EXCLUDE

Model catalog (resolved):
  Name                      INCLUDE  as unit
  Faction (select)          INCLUDE  as faction (primary)
  other relations           EXCLUDE

Models Owned (resolved via Squads; inventory/purchase data is never pulled):
  Name                      INCLUDE  as squad
  Faction (multi_select)    INCLUDE  as faction fallback only
  Type (multi_select)       INCLUDE
  Base size (select)        INCLUDE
  Keywords (multi_select)   INCLUDE  (public game keywords, used in search)
  Purchase History          EXCLUDE
  Qty                       EXCLUDE
  Assigned (formula)        EXCLUDE
  Status, Image             EXCLUDE  (individual model's own fields are used)
  Kits, Model, Squads       EXCLUDE  (relations / back-links)
  All Army List / HQ *      EXCLUDE
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
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
DEFAULT_RAW = Path("/workspace/notion-models-raw")
OUT_DIR = REPO_ROOT / "armoury"
IMG_DIR = OUT_DIR / "img"

# Fields we may copy from a Models Owned row. Never include purchase, qty,
# army lists, or other inventory/private properties.
OWNED_PUBLIC_FIELDS = ("Name", "Faction", "Type", "Base size", "Keywords")


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
        if text in ("null", "None", "[]", "{}"):
            if text in ("[]",):
                return []
            return None
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
    slug = slug.removeprefix("p/") if False else slug
    # URLs may be https://app.notion.com/p/<id>
    if "notion.com" in str(url):
        parts = str(url).split("/")
        slug = parts[-1].split("?")[0]
        if slug == "" and len(parts) > 1:
            slug = parts[-2]
    return slug or None


def index_by_url(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = page_key(row.get("url"))
        if key:
            out[key] = row
    return out


def first_related(row: dict[str, Any], field: str, lookup: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for item in as_list(row.get(field)):
        key = page_key(item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else None))
        if key and key in lookup:
            return lookup[key]
    return None


def slugify(name: str) -> str:
    slug = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug or "model"


def brisbane_date(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return value[:10] if len(value) >= 10 else value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(BRISBANE).date().isoformat()


def unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def find_originals(raw_dir: Path, name: str) -> list[Path]:
    orig_dir = raw_dir / "orig"
    if not orig_dir.is_dir():
        return []
    matches = sorted(orig_dir.glob(f"{name}__*"))
    return [p for p in matches if p.is_file()]


def filename_from_url(url: str, fallback: str) -> str:
    name = unquote(urlparse(url).path.split("/")[-1])
    if not name or "." not in name:
        name = fallback + ".bin"
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def extract_image_urls_from_page(path: Path) -> list[str]:
    text = path.read_text()
    try:
        obj = json.loads(text)
        props = obj.get("properties") or {}
        images = as_list(props.get("Image"))
        urls = [u for u in images if isinstance(u, str) and u.startswith("http")]
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
    return [u for u in as_list(props.get("Image")) if isinstance(u, str) and u.startswith("http")]


def download_missing(raw_dir: Path, name: str) -> list[Path]:
    existing = find_originals(raw_dir, name)
    if existing:
        return existing
    pages_dir = raw_dir / "pages"
    page_path = pages_dir / f"{name}.json"
    if not page_path.is_file():
        return []
    urls = extract_image_urls_from_page(page_path)
    if not urls:
        return []
    orig_dir = raw_dir / "orig"
    orig_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for index, url in enumerate(urls):
        dest = orig_dir / f"{name}__{index}__{filename_from_url(url, name)}"
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "naedmas-models-sync/1.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as resp:
                dest.write_bytes(resp.read())
            saved.append(dest)
            print(f"  downloaded {dest.name} ({dest.stat().st_size} bytes)")
        except Exception as exc:
            print(f"  FAIL download for {name}: {exc}", file=sys.stderr)
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


def build_record(
    row: dict[str, Any],
    models: dict[str, dict[str, Any]],
    kits: dict[str, dict[str, Any]],
    owned: dict[str, dict[str, Any]],
    image_files: list[str],
    thumb_files: list[str],
) -> dict[str, Any]:
    name = (row.get("Name") or "").strip()
    model = first_related(row, "Model", models) or {}
    kit = first_related(row, "Kit", kits) or {}
    squad = first_related(row, "Squads", owned) or {}

    unit = (model.get("Name") or "").strip() or None
    faction = (model.get("Faction") or "").strip() or None
    if not faction:
        owned_factions = [str(v) for v in as_list(squad.get("Faction"))]
        faction = owned_factions[0] if owned_factions else None

    types = unique(str(v) for v in as_list(squad.get("Type")))
    keywords = unique(str(v) for v in as_list(squad.get("Keywords")))
    wargear = unique(str(v) for v in as_list(row.get("Wargear")))
    base_size = (squad.get("Base size") or "").strip() or None
    kit_name = (kit.get("Name") or "").strip() or None
    squad_name = (squad.get("Name") or "").strip() or None
    status = (row.get("Status") or "").strip() or None

    record: dict[str, Any] = {
        "id": slugify(name),
        "name": name,
        "unit": unit,
        "faction": faction,
        "status": status,
        "kit": kit_name,
        "squad": squad_name,
        "wargear": wargear,
        "type": types[0] if types else None,
        "baseSize": base_size,
        "keywords": keywords,
        "created": brisbane_date(row.get("createdTime")),
        "images": image_files,
        "thumbs": thumb_files,
        "image": image_files[0] if image_files else None,
        "thumb": thumb_files[0] if thumb_files else None,
    }
    return record


def main() -> int:
    import os
    raw_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        os.environ.get("NOTION_MODELS_RAW", str(DEFAULT_RAW))
    )
    required = {
        "individual_models.json": raw_dir / "individual_models.json",
        "model_catalog.json": raw_dir / "model_catalog.json",
        "kit_catalog.json": raw_dir / "kit_catalog.json",
        "models_owned.json": raw_dir / "models_owned.json",
    }
    missing = [name for name, path in required.items() if not path.is_file()]
    if missing:
        print(f"Missing raw files in {raw_dir}: {', '.join(missing)}", file=sys.stderr)
        print("Export the personal Notion dumps first, then re-run.", file=sys.stderr)
        return 1

    individuals = load_results(required["individual_models.json"])
    models = index_by_url(load_results(required["model_catalog.json"]))
    kits = index_by_url(load_results(required["kit_catalog.json"]))
    owned = index_by_url(load_results(required["models_owned.json"]))

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    # Remove previously generated jpgs so renamed/deleted models don't linger.
    for stale in IMG_DIR.glob("*.jpg"):
        stale.unlink()

    records: list[dict[str, Any]] = []
    with_images = 0
    for row in individuals:
        name = (row.get("Name") or "").strip()
        if not name:
            continue
        slug = slugify(name)
        originals = download_missing(raw_dir, name) or find_originals(raw_dir, name)
        image_files: list[str] = []
        thumb_files: list[str] = []
        for index, src in enumerate(originals):
            suffix = "" if index == 0 else f"-{index+1}"
            full_rel = f"img/{slug}{suffix}.jpg"
            thumb_rel = f"img/{slug}{suffix}-thumb.jpg"
            print(f"  resize {name} {src.name} -> {full_rel}")
            resize_to_jpeg(src, IMG_DIR / f"{slug}{suffix}.jpg", FULL_EDGE)
            resize_to_jpeg(src, IMG_DIR / f"{slug}{suffix}-thumb.jpg", THUMB_EDGE)
            image_files.append(full_rel)
            thumb_files.append(thumb_rel)
        if image_files:
            with_images += 1
        records.append(build_record(row, models, kits, owned, image_files, thumb_files))

    records.sort(key=lambda r: ((r.get("unit") or "zzz").lower(), r.get("name") or ""))
    payload = {
        "updatedAt": datetime.now(BRISBANE).isoformat(timespec="seconds"),
        "source": "My Individual Models",
        "count": len(records),
        "models": records,
    }
    out_json = OUT_DIR / "models.json"
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {out_json} ({len(records)} models, {with_images} with images)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
