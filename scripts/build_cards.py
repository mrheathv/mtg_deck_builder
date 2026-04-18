"""
Build the MTG card database and export per-format JSON files.

Usage:
    python scripts/build_cards.py

Outputs (in ./data/):
    cards-standard.json
    cards-historic.json
    cards-explorer.json
    cards-pioneer.json

The SQLite database (mtg_cards.sqlite3) is built as an intermediate artifact
and can be kept or discarded after the JSON files are exported.
"""

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import requests
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "mtg_cards.sqlite3"
BULK_TYPE = "default_cards"
BULK_ENDPOINT = "https://api.scryfall.com/bulk-data"

FORMATS = {
    "standard": ("standard", "AND p2.games LIKE '%arena%'"),
    "historic":  ("historic",  "AND p2.games LIKE '%arena%'"),
    "explorer":  ("explorer",  "AND p2.games LIKE '%arena%'"),
    "pioneer":   ("pioneer",   ""),
}

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS oracle_cards (
  oracle_id TEXT PRIMARY KEY,
  name TEXT,
  mana_cost TEXT,
  cmc REAL,
  type_line TEXT,
  oracle_text TEXT,
  power TEXT,
  toughness TEXT,
  loyalty TEXT,
  colors TEXT,
  color_identity TEXT,
  color_indicator TEXT,
  keywords TEXT,
  produced_mana TEXT,
  reserved INTEGER,
  edhrec_rank INTEGER,
  layout TEXT
);

CREATE TABLE IF NOT EXISTS printings (
  id TEXT PRIMARY KEY,
  oracle_id TEXT,
  name TEXT,
  set_code TEXT,
  set_name TEXT,
  collector_number TEXT,
  rarity TEXT,
  released_at TEXT,
  lang TEXT,
  games TEXT,
  digital INTEGER,
  booster INTEGER,
  legalities TEXT,
  image_uris TEXT,
  scryfall_uri TEXT,
  FOREIGN KEY (oracle_id) REFERENCES oracle_cards(oracle_id)
);

CREATE TABLE IF NOT EXISTS card_faces (
  printing_id TEXT,
  face_index INTEGER,
  name TEXT,
  mana_cost TEXT,
  type_line TEXT,
  oracle_text TEXT,
  power TEXT,
  toughness TEXT,
  loyalty TEXT,
  colors TEXT,
  color_indicator TEXT,
  image_uris TEXT,
  PRIMARY KEY (printing_id, face_index),
  FOREIGN KEY (printing_id) REFERENCES printings(id)
);

CREATE INDEX IF NOT EXISTS idx_printings_oracle_id ON printings(oracle_id);
CREATE INDEX IF NOT EXISTS idx_oracle_name ON oracle_cards(name);
CREATE INDEX IF NOT EXISTS idx_printings_set ON printings(set_code);
CREATE INDEX IF NOT EXISTS idx_printings_lang ON printings(lang);
"""

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
                raise ValueError("Downloaded file doesn't look like JSON (not a Scryfall card array)")

        tmp.rename(dest)
        print(f"Download complete: {dest} ({size / 1e6:.1f} MB)")
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def jdump(x):
    return None if x is None else json.dumps(x, ensure_ascii=False)


def upsert_oracle(cur, c):
    cur.execute("""
        INSERT INTO oracle_cards (
          oracle_id, name, mana_cost, cmc, type_line, oracle_text,
          power, toughness, loyalty,
          colors, color_identity, color_indicator,
          keywords, produced_mana, reserved, edhrec_rank, layout
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(oracle_id) DO UPDATE SET
          name=COALESCE(excluded.name, oracle_cards.name),
          mana_cost=COALESCE(excluded.mana_cost, oracle_cards.mana_cost),
          cmc=COALESCE(excluded.cmc, oracle_cards.cmc),
          type_line=COALESCE(excluded.type_line, oracle_cards.type_line),
          oracle_text=COALESCE(excluded.oracle_text, oracle_cards.oracle_text),
          power=COALESCE(excluded.power, oracle_cards.power),
          toughness=COALESCE(excluded.toughness, oracle_cards.toughness),
          loyalty=COALESCE(excluded.loyalty, oracle_cards.loyalty),
          colors=COALESCE(excluded.colors, oracle_cards.colors),
          color_identity=COALESCE(excluded.color_identity, oracle_cards.color_identity),
          color_indicator=COALESCE(excluded.color_indicator, oracle_cards.color_indicator),
          keywords=COALESCE(excluded.keywords, oracle_cards.keywords),
          produced_mana=COALESCE(excluded.produced_mana, oracle_cards.produced_mana),
          reserved=COALESCE(excluded.reserved, oracle_cards.reserved),
          edhrec_rank=COALESCE(excluded.edhrec_rank, oracle_cards.edhrec_rank),
          layout=COALESCE(excluded.layout, oracle_cards.layout)
    """, (
        c.get("oracle_id"), c.get("name"), c.get("mana_cost"), c.get("cmc"),
        c.get("type_line"), c.get("oracle_text"), c.get("power"), c.get("toughness"),
        c.get("loyalty"), jdump(c.get("colors")), jdump(c.get("color_identity")),
        jdump(c.get("color_indicator")), jdump(c.get("keywords")),
        jdump(c.get("produced_mana")),
        1 if c.get("reserved") else 0 if c.get("reserved") is not None else None,
        c.get("edhrec_rank"), c.get("layout"),
    ))


def upsert_printing(cur, c):
    cur.execute("""
        INSERT INTO printings (
          id, oracle_id, name,
          set_code, set_name, collector_number, rarity,
          released_at, lang,
          games, digital, booster,
          legalities, image_uris, scryfall_uri
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          oracle_id=excluded.oracle_id, name=excluded.name,
          set_code=excluded.set_code, set_name=excluded.set_name,
          collector_number=excluded.collector_number, rarity=excluded.rarity,
          released_at=excluded.released_at, lang=excluded.lang,
          games=excluded.games, digital=excluded.digital, booster=excluded.booster,
          legalities=excluded.legalities, image_uris=excluded.image_uris,
          scryfall_uri=excluded.scryfall_uri
    """, (
        c.get("id"), c.get("oracle_id"), c.get("name"),
        c.get("set"), c.get("set_name"), c.get("collector_number"), c.get("rarity"),
        c.get("released_at"), c.get("lang"), jdump(c.get("games")),
        1 if c.get("digital") else 0 if c.get("digital") is not None else None,
        1 if c.get("booster") else 0 if c.get("booster") is not None else None,
        jdump(c.get("legalities")), jdump(c.get("image_uris")), c.get("scryfall_uri"),
    ))


def upsert_faces(cur, c):
    faces = c.get("card_faces")
    if not faces:
        return
    for i, f in enumerate(faces):
        cur.execute("""
            INSERT INTO card_faces (
              printing_id, face_index,
              name, mana_cost, type_line, oracle_text,
              power, toughness, loyalty,
              colors, color_indicator, image_uris
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(printing_id, face_index) DO UPDATE SET
              name=excluded.name, mana_cost=excluded.mana_cost,
              type_line=excluded.type_line, oracle_text=excluded.oracle_text,
              power=excluded.power, toughness=excluded.toughness,
              loyalty=excluded.loyalty, colors=excluded.colors,
              color_indicator=excluded.color_indicator, image_uris=excluded.image_uris
        """, (
            c.get("id"), i, f.get("name"), f.get("mana_cost"), f.get("type_line"),
            f.get("oracle_text"), f.get("power"), f.get("toughness"), f.get("loyalty"),
            jdump(f.get("colors")), jdump(f.get("color_indicator")), jdump(f.get("image_uris")),
        ))

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_db(bulk_path: Path):
    print(f"\nLoading bulk JSON into memory...")
    with open(bulk_path, encoding="utf-8") as f:
        cards = json.load(f)
    print(f"  {len(cards):,} total cards in bulk file")

    if DB_PATH.exists():
        DB_PATH.unlink()
        print(f"  Removed existing DB: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_SQL)
    conn.commit()

    cur = conn.cursor()
    t0 = time.time()
    inserted = skipped = 0

    for c in tqdm(cards, desc="Building DB"):
        if not c.get("oracle_id") or not c.get("id"):
            skipped += 1
            continue
        if c.get("lang") != "en":
            skipped += 1
            continue
        legalities = c.get("legalities", {})
        if not any(legalities.get(fmt) == "legal"
                   for fmt in ("standard", "historic", "explorer", "pioneer")):
            skipped += 1
            continue

        upsert_oracle(cur, c)
        upsert_printing(cur, c)
        upsert_faces(cur, c)
        inserted += 1

        if inserted % 5000 == 0:
            conn.commit()

    conn.commit()
    elapsed = round(time.time() - t0, 1)
    print(f"  Done in {elapsed}s — inserted {inserted:,}, skipped {skipped:,}")
    return conn


def export_json(conn):
    print("\nExporting per-format JSON files...")
    for fmt_name, (legality_field, arena_clause) in FORMATS.items():
        rows = conn.execute(f"""
            SELECT oc.name, oc.color_identity, oc.type_line, oc.mana_cost, oc.cmc,
                   p.rarity, oc.oracle_text, oc.keywords, p.set_name
            FROM oracle_cards oc
            JOIN printings p ON p.id = (
                SELECT p2.id FROM printings p2
                WHERE p2.oracle_id = oc.oracle_id
                  AND p2.lang = 'en'
                  AND json_extract(p2.legalities, '$.{legality_field}') = 'legal'
                  {arena_clause}
                ORDER BY p2.released_at DESC
                LIMIT 1
            )
            ORDER BY oc.name
        """).fetchall()

        cards_out = [
            {
                "name": r[0],
                "color_identity": json.loads(r[1]) if r[1] else [],
                "type_line": r[2] or "",
                "mana_cost": r[3] or "",
                "cmc": r[4] or 0,
                "rarity": r[5] or "",
                "oracle_text": r[6] or "",
                "keywords": json.loads(r[7]) if r[7] else [],
                "set_name": r[8] or "",
            }
            for r in rows
        ]

        out = DATA_DIR / f"cards-{fmt_name}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(cards_out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  {fmt_name}: {len(cards_out):,} cards → {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    bulk_path = DATA_DIR / f"{BULK_TYPE}.json"

    # Step 1: Download bulk data
    if bulk_path.exists() and bulk_path.stat().st_size == 0:
        bulk_path.unlink()
    if not bulk_path.exists():
        url = get_bulk_download_url()
        download_bulk(url, bulk_path)
    else:
        print(f"Using cached bulk file: {bulk_path} ({bulk_path.stat().st_size / 1e6:.0f} MB)")

    # Step 2: Build SQLite DB
    conn = build_db(bulk_path)

    # Step 3: Export JSON files
    export_json(conn)
    conn.close()

    # Step 4: Remove the large bulk JSON to free disk space
    bulk_path.unlink()
    print(f"\nRemoved bulk file ({bulk_path}) to free disk space")
    print("\nDone. Upload data/cards-*.json to R2.")
