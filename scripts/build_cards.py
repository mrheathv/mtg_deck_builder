"""
Build per-format MTG card JSON files directly from the Scryfall bulk data.

Skips SQLite entirely — processes the bulk JSON in a single pass and writes:
    data/cards-standard.json
    data/cards-historic.json
    data/cards-explorer.json
    data/cards-pioneer.json

Usage:
    python scripts/build_cards.py
"""

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)

BULK_TYPE = "default_cards"
BULK_ENDPOINT = "https://api.scryfall.com/bulk-data"

# (legality_field, arena_only)
FORMATS = {
    "standard": ("standard", True),
    "historic":  ("historic",  True),
    "explorer":  ("explorer",  True),
    "pioneer":   ("pioneer",   False),
}

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def get_bulk_download_url():
    print("Fetching Scryfall bulk-data index...")
    resp = requests.get(BULK_ENDPOINT, timeout=30)
    resp.raise_for_status()
    entries = resp.json()["data"]
    target = next(e for e in entries if e["type"] == BULK_TYPE)
    url = target["download_uri"]
    size_mb = target.get("size", 0) / 1e6
    updated = target.get("updated_at", "unknown")
    print(f"  URL: {url}")
    print(f"  Updated: {updated}  Size: {size_mb:.0f} MB")
    return url


def download_bulk(url: str, dest: Path, chunk_size: int = 1 << 20):
    tmp = dest.with_suffix(".tmp")
    try:
        r = requests.get(url, stream=True, timeout=(10, 300))
        r.raise_for_status()
        total = int(r.headers.get("Content-Length", 0))
        with open(tmp, "wb") as f, tqdm(total=total, unit="B", unit_scale=True,
                                         desc=f"Downloading {dest.name}") as pbar:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
                    pbar.update(len(chunk))

        size = tmp.stat().st_size
        if size == 0:
            raise ValueError("Downloaded file is empty")
        with open(tmp, "rb") as f:
            if f.read(1) != b"[":
                raise ValueError("Downloaded file doesn't look like a Scryfall card array")

        tmp.rename(dest)
        print(f"Download complete: {dest} ({size / 1e6:.1f} MB)")
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise

# ---------------------------------------------------------------------------
# Process
# ---------------------------------------------------------------------------

def process(bulk_path: Path):
    """
    Single-pass through the bulk JSON.
    For each oracle_id + format, track the most recent English legal printing.
    Only store the fields the app actually needs — no image URLs.
    """
    print("\nLoading bulk JSON into memory...")
    t0 = time.time()
    with open(bulk_path, encoding="utf-8") as f:
        cards = json.load(f)
    print(f"  Loaded {len(cards):,} entries in {round(time.time()-t0, 1)}s")

    # best[oracle_id][format_name] = { released_at, ...card fields... }
    best = defaultdict(dict)

    print("Processing cards...")
    for c in tqdm(cards, desc="Processing"):
        if c.get("lang") != "en":
            continue
        oracle_id = c.get("oracle_id")
        if not oracle_id:
            continue

        legalities = c.get("legalities", {})
        on_arena = "arena" in c.get("games", [])
        released_at = c.get("released_at", "")

        for fmt_name, (legality_field, arena_only) in FORMATS.items():
            if legalities.get(legality_field) != "legal":
                continue
            if arena_only and not on_arena:
                continue

            current = best[oracle_id].get(fmt_name)
            if current is None or released_at > current["_released_at"]:
                best[oracle_id][fmt_name] = {
                    "_released_at": released_at,
                    "name":           c.get("name") or "",
                    "color_identity": c.get("color_identity") or [],
                    "type_line":      c.get("type_line") or "",
                    "mana_cost":      c.get("mana_cost") or "",
                    "cmc":            c.get("cmc") or 0,
                    "rarity":         c.get("rarity") or "",
                    "oracle_text":    c.get("oracle_text") or "",
                    "keywords":       c.get("keywords") or [],
                    "set_name":       c.get("set_name") or "",
                }

    print("\nExporting per-format JSON files...")
    for fmt_name in FORMATS:
        cards_out = sorted(
            (
                {k: v for k, v in data.items() if k != "_released_at"}
                for oracle_data in best.values()
                if fmt_name in oracle_data
                for data in [oracle_data[fmt_name]]
            ),
            key=lambda c: c["name"],
        )

        out = DATA_DIR / f"cards-{fmt_name}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(cards_out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  {fmt_name}: {len(cards_out):,} cards → {out} ({out.stat().st_size / 1e6:.1f} MB)")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    bulk_path = DATA_DIR / f"{BULK_TYPE}.json"

    # Download if needed
    if bulk_path.exists() and bulk_path.stat().st_size == 0:
        bulk_path.unlink()
    if not bulk_path.exists():
        url = get_bulk_download_url()
        download_bulk(url, bulk_path)
    else:
        print(f"Using cached bulk file: {bulk_path} ({bulk_path.stat().st_size / 1e6:.0f} MB)")

    # Process directly to JSON (no SQLite)
    process(bulk_path)

    # Remove the large bulk file to free disk space
    bulk_path.unlink()
    print(f"\nRemoved bulk file to free disk space")
    print("Done. Upload data/cards-*.json to R2.")
