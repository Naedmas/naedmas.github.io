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
    armoury/img/<slug>.webp          and .jpg fallback
    armoury/img/<slug>-thumb.webp    and .jpg fallback
    armoury/img/<slug>-2.webp/.jpg   and -2-thumb.* for later frames

Pillow resizes the long edge to 1200px (full) and 500px (thumb),
preserving aspect ratio, and writes webp + JPEG for every frame.
Every file in the Notion Image property is downloaded and published,
in Notion order. The first frame is also copied to the legacy
image / thumb / imageWebp / thumbWebp fields for compatibility.
Models with no Image, or whose download/resize fails, omit image
fields so the page can show the themed placeholder.

models.json is rebuilt from the current Notion export only, so a
model that has left the database is dropped. After writing
derivatives, the script deletes any armoury/img/*.jpg or *.webp
that no current model references (placeholder.svg is kept) and
any orig/ file that does not belong to a current model's Image
property in Notion order.

Property policy
---------------
My Individual Models (source database):
  Name (title)              INCLUDE  as name / id
  Image (files)             INCLUDE  every file, in Notion order,
                                     downloaded into armoury/img as
                                     images[] / thumbs[] plus webp
                                     counterparts; first frame also
                                     in image / thumb / imageWebp /
                                     thumbWebp
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

Weekly refresh (same time as the Librarium / Apothecarion sync):
  1. Use only the personal Notion connector (user-Notion--personal),
     read-only. Never the Vemag Notion, and never write to Notion.
     Do not sign up for or upgrade a Notion plan.
  2. Fetch the "My Individual Models" database
     (id 3fb2db47-2d73-800c-b259-e7c220db5d97,
     data source collection://3fb2db47-2d73-8003-b7d2-000b46673ebf)
     if the schema may have changed.
  3. Export every row into /workspace/notion-models-raw/individual_models.json.
     Prefer view-mode pagination on
     view://3fb2db47-2d73-80ec-ab05-000cd49d86ce (page_size 50, follow
     next_cursor until has_more is false). Prefer file:// Image tokens
     from view-mode rows over bare SQL UUIDs. Keep every file in the
     Image property, in Notion order — not only the first. Rows mode
     also works; avoid SQL if the Query Data Source allowance is low.
  4. Export the Kit catalog
     (collection://3e72db47-2d73-8000-a2ad-000bb308fd4b) as
     kit_catalog.json (url, Name), the Model catalog
     (collection://3ed2db47-2d73-807d-84b7-000b4036e072) as
     model_catalog.json (url, Name, Faction), and Models Owned
     (collection://3e72db47-2d73-800f-831f-000b402abdd8) as
     models_owned.json with only the public fields (url, Name,
     Faction, Type, Base size, Keywords). Never export Purchase
     History, Qty, Assigned, army lists, or HQ relations.
  5. For each Image file (all of them, in order), resolve a signed
     download URL (get_file_download_urls with notion-file-block://
     references built from file:// attachment tokens, up to 25 at a
     time) and cache missing originals in
     /workspace/notion-models-raw/orig/ as
     <Name>__<index>__<original-filename> before the signed URLs
     expire. Skip originals that are already on disk. Use the large
     sibling asset files from write_to_file, not the truncated ~6.3KB
     previews.
  6. Run: python3 scripts/sync_models.py
     The script rebuilds armoury/models.json from the current export
     only (models no longer in Notion are removed). It publishes
     every remaining Image file as webp+jpeg, then prunes any
     armoury/img derivative that no current model references and
     any orig/ file that no longer matches a current Image
     property. Stage those deletions (git add -u armoury/img) with
     the rest of the Armoury changes.
  7. If armoury/models.json or armoury/img/ changed, commit and push
     to main, then confirm the GitHub Pages build.

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
WEBP_QUALITY = 80
BG_COLOR = (8, 12, 9)

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


def filename_from_token(token: Any, fallback: str) -> str:
    if not isinstance(token, str):
        return fallback + ".bin"
    if token.startswith("file://"):
        from urllib.parse import unquote as _unquote
        inner = _unquote(token[7:])
        try:
            data = json.loads(inner)
        except json.JSONDecodeError:
            data = {}
        source = str(data.get("source") or "")
        if source.startswith("attachment:"):
            parts = source.split(":", 2)
            if len(parts) >= 3 and parts[2]:
                return re.sub(r"[^A-Za-z0-9._-]", "_", parts[2])
        return fallback + ".bin"
    if token.startswith("http"):
        return filename_from_url(token, fallback)
    return fallback + ".bin"


def find_originals(raw_dir: Path, name: str) -> list[Path]:
    orig_dir = raw_dir / "orig"
    if not orig_dir.is_dir():
        return []
    matches = sorted(orig_dir.glob(f"{name}__*"))
    return [p for p in matches if p.is_file()]


def originals_for_row(raw_dir: Path, row: dict[str, Any]) -> list[Path]:
    """Return orig files for this row's Image property, in Notion order."""
    name = (row.get("Name") or "").strip()
    tokens = as_list(row.get("Image") or row.get("i"))
    orig_dir = raw_dir / "orig"
    ordered: list[Path] = []
    if tokens and orig_dir.is_dir():
        for index, token in enumerate(tokens):
            filename = filename_from_token(token, name or "image")
            dest = orig_dir / f"{name}__{index}__{filename}"
            if dest.is_file() and dest.stat().st_size > 0:
                ordered.append(dest)
                continue
            fallback = sorted(orig_dir.glob(f"{name}__{index}__*"))
            fallback = [p for p in fallback if p.is_file() and p.stat().st_size > 0]
            if fallback:
                ordered.append(fallback[0])
        if ordered:
            return ordered
    return find_originals(raw_dir, name)


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


def prepared_image(src: Path, max_edge: int) -> Image.Image:
    im = ImageOps.exif_transpose(Image.open(src))
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        background = Image.new("RGB", rgba.size, BG_COLOR)
        background.paste(rgba, mask=rgba.split()[-1])
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
    im = prepared_image(src, max_edge)
    dest_jpg.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest_jpg, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    im.save(dest_webp, "WEBP", quality=WEBP_QUALITY, method=6)


def build_record(
    row: dict[str, Any],
    models: dict[str, dict[str, Any]],
    kits: dict[str, dict[str, Any]],
    owned: dict[str, dict[str, Any]],
    image_files: list[str],
    thumb_files: list[str],
    image_webp: list[str],
    thumb_webp: list[str],
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
        "imagesWebp": image_webp,
        "thumbsWebp": thumb_webp,
        "image": image_files[0] if image_files else None,
        "thumb": thumb_files[0] if thumb_files else None,
        "imageWebp": image_webp[0] if image_webp else None,
        "thumbWebp": thumb_webp[0] if thumb_webp else None,
    }
    return record



def expected_orig_paths(raw_dir: Path, rows: list[dict[str, Any]]) -> set[Path]:
    """Orig files that still belong to a current model's Image property."""
    orig_dir = raw_dir / "orig"
    keep: set[Path] = set()
    if not orig_dir.is_dir():
        return keep
    for row in rows:
        name = (row.get("Name") or "").strip()
        tokens = as_list(row.get("Image") or row.get("i"))
        for index, token in enumerate(tokens):
            filename = filename_from_token(token, name or "image")
            dest = orig_dir / f"{name}__{index}__{filename}"
            if dest.is_file() and dest.stat().st_size > 0:
                keep.add(dest.resolve())
                continue
            fallback = sorted(orig_dir.glob(f"{name}__{index}__*"))
            fallback = [p for p in fallback if p.is_file() and p.stat().st_size > 0]
            if fallback:
                keep.add(fallback[0].resolve())
    return keep


def prune_originals(raw_dir: Path, rows: list[dict[str, Any]]) -> list[str]:
    orig_dir = raw_dir / "orig"
    if not orig_dir.is_dir():
        return []
    keep = expected_orig_paths(raw_dir, rows)
    removed: list[str] = []
    for path in sorted(orig_dir.iterdir()):
        if not path.is_file():
            continue
        if path.resolve() in keep:
            continue
        print(f"  prune orig {path.name}")
        path.unlink()
        removed.append(path.name)
    return removed


def referenced_img_names(records: list[dict[str, Any]]) -> set[str]:
    keys = (
        "images", "thumbs", "imagesWebp", "thumbsWebp",
        "image", "thumb", "imageWebp", "thumbWebp",
    )
    names: set[str] = set()
    for rec in records:
        for key in keys:
            val = rec.get(key)
            if isinstance(val, list):
                for item in val:
                    if item:
                        names.add(Path(item).name)
            elif val:
                names.add(Path(val).name)
    return names


def prune_public_images(records: list[dict[str, Any]]) -> list[str]:
    keep = referenced_img_names(records) | {"placeholder.svg"}
    removed: list[str] = []
    if not IMG_DIR.is_dir():
        return removed
    for path in sorted(IMG_DIR.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".jpg", ".jpeg", ".webp", ".png"}:
            continue
        if path.name in keep:
            continue
        print(f"  prune img {path.name}")
        path.unlink()
        removed.append(path.name)
    return removed


def previous_model_names(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return set()
    return {
        m.get("name") for m in (payload.get("models") or [])
        if isinstance(m, dict) and m.get("name")
    }


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
    out_json = OUT_DIR / "models.json"
    dropped_models = previous_model_names(out_json)

    records: list[dict[str, Any]] = []
    with_images = 0
    failed = 0
    multi = 0
    max_frames = 0
    for row in individuals:
        name = (row.get("Name") or "").strip()
        if not name:
            continue
        slug = slugify(name)
        originals = originals_for_row(raw_dir, row) or download_missing(raw_dir, name)
        image_files: list[str] = []
        thumb_files: list[str] = []
        image_webp: list[str] = []
        thumb_webp: list[str] = []
        try:
            for index, src in enumerate(originals):
                suffix = "" if index == 0 else f"-{index + 1}"
                full_jpg = IMG_DIR / f"{slug}{suffix}.jpg"
                full_webp_path = IMG_DIR / f"{slug}{suffix}.webp"
                thumb_jpg = IMG_DIR / f"{slug}{suffix}-thumb.jpg"
                thumb_webp_path = IMG_DIR / f"{slug}{suffix}-thumb.webp"
                print(f"  resize {name} [{index}] {src.name} -> img/{full_jpg.name}")
                resize_image(src, full_jpg, full_webp_path, FULL_EDGE)
                resize_image(src, thumb_jpg, thumb_webp_path, THUMB_EDGE)
                image_files.append(f"img/{full_jpg.name}")
                image_webp.append(f"img/{full_webp_path.name}")
                thumb_files.append(f"img/{thumb_jpg.name}")
                thumb_webp.append(f"img/{thumb_webp_path.name}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL resize for {name}: {exc}", file=sys.stderr)
            image_files, thumb_files, image_webp, thumb_webp = [], [], [], []
        if image_files:
            with_images += 1
            max_frames = max(max_frames, len(image_files))
            if len(image_files) > 1:
                multi += 1
        records.append(build_record(
            row, models, kits, owned,
            image_files, thumb_files, image_webp, thumb_webp,
        ))

    records.sort(key=lambda r: ((r.get("unit") or "zzz").lower(), r.get("name") or ""))
    payload = {
        "updatedAt": datetime.now(BRISBANE).isoformat(timespec="seconds"),
        "source": "My Individual Models",
        "count": len(records),
        "models": records,
    }
    current_names = {r.get("name") for r in records if r.get("name")}
    dropped_models = sorted(dropped_models - current_names)
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    pruned_img = prune_public_images(records)
    pruned_orig = prune_originals(raw_dir, individuals)
    print(
        f"Wrote {out_json} ({len(records)} models, {with_images} with images, "
        f"{multi} with multiple, max {max_frames} frames, {failed} failed)"
    )
    print(
        f"Pruned {len(dropped_models)} models from models.json, "
        f"{len(pruned_img)} armoury/img files, {len(pruned_orig)} orig files"
    )
    for name in dropped_models:
        print(f"  dropped model {name}")
    return 0 if records else 1


if __name__ == "__main__":
    raise SystemExit(main())
