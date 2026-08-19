#!/usr/bin/env python3
"""Build the browser registry bundle from the packaged IEEE CSVs.

The CSVs are the single source of truth. This generates web/data/registry.json
from them so the browser and the CLI can never disagree about vendor data —
there is only one copy to update.

The bundle keeps organization names and drops postal addresses, which is what
makes it small enough to ship to a browser (about a quarter the size).

    python scripts/build_web_data.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from macsmith.registry import REGISTRY_FILES, REGISTRY_ORDER, Registries  # noqa: E402

OUT_DIR = REPO / "web" / "data"
OUT_FILE = OUT_DIR / "registry.json"


def main() -> int:
    regs = Registries()
    if not regs.available:
        print("No registry CSVs found in src/macsmith/data/.", file=sys.stderr)
        return 1

    bundle = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "prefixLengths": {"MA-S": 9, "MA-M": 7, "MA-L": 6},
        "order": list(REGISTRY_ORDER),
        "registries": {},
    }
    total = 0
    for name in REGISTRY_ORDER:
        table = regs.tables.get(name)
        if not table:
            continue
        bundle["registries"][name] = {k: v.organization for k, v in table.items()}
        total += len(table)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Separators without spaces: this file is machine-read, and the savings are
    # meaningful at 50k+ entries.
    OUT_FILE.write_text(
        json.dumps(bundle, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    size_mb = OUT_FILE.stat().st_size / 1_000_000
    print(f"Wrote {OUT_FILE.relative_to(REPO)} — {total:,} assignments, {size_mb:.1f} MB")
    for name in REGISTRY_ORDER:
        if name in bundle["registries"]:
            print(f"  {name}: {len(bundle['registries'][name]):,} "
                  f"(from {REGISTRY_FILES[name]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
