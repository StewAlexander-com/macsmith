#!/usr/bin/env python3
"""Refresh the packaged IEEE registry CSVs from ieee.org.

This is the only part of macsmith that touches the network, and it is a
deliberate, manual step rather than something a lookup does behind your back.

    python scripts/refresh_registries.py            # download and replace
    python scripts/refresh_registries.py --check    # report age, change nothing

A download that returns something implausible is rejected rather than written,
because a truncated or error-page response would otherwise replace a working
database with a broken one and every lookup would quietly start missing.
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA_DIR = REPO / "src" / "macsmith" / "data"

SOURCES = {
    "oui.csv": ("https://standards-oui.ieee.org/oui/oui.csv", "MA-L", 30_000),
    "mam.csv": ("https://standards-oui.ieee.org/oui28/mam.csv", "MA-M", 4_000),
    "oui36.csv": ("https://standards-oui.ieee.org/oui36/oui36.csv", "MA-S", 5_000),
}

TIMEOUT = 90


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "macsmith-refresh"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def validate(raw: bytes, registry: str, minimum_rows: int) -> tuple[bool, str]:
    """Confirm this looks like the registry we asked for before trusting it."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return False, "response was not UTF-8 text"

    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or len(header) < 4:
        return False, f"expected at least 4 columns, got {header}"

    rows = 0
    for row in reader:
        if len(row) >= 4 and row[0] == registry:
            rows += 1
    if rows < minimum_rows:
        return False, (f"only {rows:,} {registry} rows, expected at least "
                       f"{minimum_rows:,} — refusing to replace good data")
    return True, f"{rows:,} {registry} assignments"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="report the age of the local files and exit")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.check:
        sys.path.insert(0, str(REPO / "src"))
        from macsmith.registry import Registries

        regs = Registries()
        if not regs.available:
            print("No registry data present.")
            return 1
        print(f"{regs.summary()}\nage: {regs.age_days()} day(s)"
              + ("  [STALE]" if regs.is_stale() else ""))
        return 0

    failures = 0
    for filename, (url, registry, minimum) in SOURCES.items():
        target = DATA_DIR / filename
        print(f"{filename}: fetching {url}")
        try:
            raw = fetch(url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  FAILED: {exc} — keeping the existing file", file=sys.stderr)
            failures += 1
            continue

        ok, detail = validate(raw, registry, minimum)
        if not ok:
            print(f"  REJECTED: {detail}", file=sys.stderr)
            failures += 1
            continue

        previous = target.stat().st_size if target.exists() else 0
        target.write_bytes(raw)
        delta = target.stat().st_size - previous
        print(f"  OK: {detail} ({len(raw) / 1_000_000:.1f} MB, "
              f"{delta:+,} bytes vs previous)")

    if failures:
        print(f"\n{failures} registry file(s) unchanged.", file=sys.stderr)
        return 1

    print("\nAll registries refreshed. Rebuild the browser bundle with:\n"
          "  python scripts/build_web_data.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
