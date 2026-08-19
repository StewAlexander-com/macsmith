"""Offline IEEE registry lookup across MA-L, MA-M, and MA-S.

Longest prefix wins: MA-S (36-bit, 9 hex chars) beats MA-M (28-bit, 7) beats
MA-L (24-bit, 6). Data ships with the package, so lookups never touch the
network — the original MAC-Table-Tool called macvendors.co per address, which
made a 500-line MAC table both slow and useless offline.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional

from .mac import (
    CLASS_ALL_ZERO,
    CLASS_BROADCAST,
    CLASS_LAA,
    CLASS_MULTICAST,
    CLASS_MULTICAST_LAA,
    classify_mac,
    extract_mac_candidates,
    normalize_mac,
)

DATA_DIR = Path(__file__).resolve().parent / "data"

REGISTRY_FILES = {"MA-L": "oui.csv", "MA-M": "mam.csv", "MA-S": "oui36.csv"}
REGISTRY_PREFIX_LEN = {"MA-S": 9, "MA-M": 7, "MA-L": 6}
# Longest first, so longest-prefix-match falls out of iteration order.
REGISTRY_ORDER = ("MA-S", "MA-M", "MA-L")

# IEEE publishes updates continuously. Past this age the data is stale enough
# that a confident "no entry" could be wrong, so the CLI warns.
STALE_AFTER_DAYS = 120


class VendorRecord(NamedTuple):
    registry: str
    assignment: str
    organization: str
    address: str


class LookupResult(NamedTuple):
    """A lookup plus how it was reached, so the UI never has to guess.

    ``cleaned`` is the hex actually used as the key. ``note`` is ``""``,
    ``"ocr"`` (a letter-O/zero style typo was corrected) or ``"partial"``
    (something MAC-shaped was found but no registry contains it).
    """
    record: Optional[VendorRecord]
    cleaned: Optional[str]
    note: str = ""
    classification: str = ""

    @property
    def found(self) -> bool:
        return self.record is not None


class Registries:
    """Lazily-loaded registry tables.

    Loading all three CSVs costs about 5MB and a moment of parsing, so it is
    deferred until the first lookup. Commands that never look up a vendor pay
    nothing.
    """

    def __init__(self, data_dir: Path = DATA_DIR):
        self.data_dir = Path(data_dir)
        self._tables: Optional[Dict[str, Dict[str, VendorRecord]]] = None

    # -- loading ------------------------------------------------------------
    @staticmethod
    def _iter_csv(path: Path) -> Iterable[List[str]]:
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # header
            for row in reader:
                if row:
                    yield row

    @classmethod
    def _load_one(cls, path: Path) -> Dict[str, VendorRecord]:
        out: Dict[str, VendorRecord] = {}
        for row in cls._iter_csv(path):
            if len(row) < 4:
                continue
            out[row[1].upper()] = VendorRecord(row[0], row[1].upper(), row[2], row[3])
        return out

    @property
    def tables(self) -> Dict[str, Dict[str, VendorRecord]]:
        if self._tables is None:
            tables: Dict[str, Dict[str, VendorRecord]] = {}
            for registry, filename in REGISTRY_FILES.items():
                path = self.data_dir / filename
                if path.exists():
                    tables[registry] = self._load_one(path)
            self._tables = tables
        return self._tables

    @property
    def available(self) -> bool:
        return bool(self.tables)

    def summary(self) -> str:
        return ", ".join(
            f"{r}({len(self.tables[r]):,})" for r in REGISTRY_ORDER if r in self.tables
        )

    def age_days(self) -> Optional[int]:
        """Age of the newest registry file, or None if no data is present."""
        stamps = [
            (self.data_dir / f).stat().st_mtime
            for f in REGISTRY_FILES.values()
            if (self.data_dir / f).exists()
        ]
        if not stamps:
            return None
        newest = datetime.fromtimestamp(max(stamps), tz=timezone.utc)
        return (datetime.now(timezone.utc) - newest).days

    def is_stale(self) -> bool:
        age = self.age_days()
        return age is not None and age > STALE_AFTER_DAYS

    # -- lookup -------------------------------------------------------------
    def _match_prefix(self, hex_only: str) -> Optional[VendorRecord]:
        for registry in REGISTRY_ORDER:
            table = self.tables.get(registry)
            if not table:
                continue
            plen = REGISTRY_PREFIX_LEN[registry]
            if len(hex_only) < plen:
                continue
            record = table.get(hex_only[:plen])
            if record is not None:
                return record
        return None

    def lookup(self, mac_address: str) -> LookupResult:
        """Look up one address or prefix, reporting how the match was reached."""
        raw = mac_address or ""
        normalized = normalize_mac(raw)
        cleaned: Optional[str] = None
        note = ""

        from .mac import _all_hex, _normalized_input_is_mac_shaped  # local: private helpers

        if (_all_hex(normalized) and 6 <= len(normalized) <= 12
                and _normalized_input_is_mac_shaped(raw)):
            cleaned = normalized
            record = self._match_prefix(normalized)
            if record is not None:
                return LookupResult(record, cleaned, "", classify_mac(cleaned))
            note = "partial"

        for hex_only, used_ocr in extract_mac_candidates(raw):
            record = self._match_prefix(hex_only)
            if record is not None:
                return LookupResult(
                    record, hex_only, "ocr" if used_ocr else "", classify_mac(hex_only)
                )
            if cleaned is None:
                cleaned = hex_only
                note = "partial"

        return LookupResult(
            None, cleaned, note if cleaned else "",
            classify_mac(cleaned) if cleaned else "",
        )

    def vendor_name(self, mac_address: str, unknown: str = "") -> str:
        """Just the organization name — the common case for table annotation."""
        result = self.lookup(mac_address)
        if result.record is not None:
            return result.record.organization
        if result.classification:
            return EXPLANATIONS.get(result.classification, ("", ""))[0] or unknown
        return unknown


# Short label and longer explanation per classification, shared by CLI and web.
EXPLANATIONS = {
    CLASS_BROADCAST: (
        "Broadcast",
        "FF:FF:FF:FF:FF:FF — sent to every device on the LAN. No vendor.",
    ),
    CLASS_ALL_ZERO: (
        "All-zero",
        "Often a placeholder or an uninitialized address. No vendor.",
    ),
    CLASS_LAA: (
        "Private / local",
        "Locally administered (U/L bit set) — not assigned by IEEE. Likely a "
        "randomized privacy address, a VM, a container, or set by an admin.",
    ),
    CLASS_MULTICAST_LAA: (
        "Private multicast",
        "Locally administered and multicast (both low bits set). No IEEE "
        "assignment exists for this address.",
    ),
    CLASS_MULTICAST: (
        "Multicast",
        "Group address (I/G bit set) — a destination, not a device. No IEEE "
        "vendor assignment.",
    ),
}


def explain(result: LookupResult) -> str:
    """A plain-language reason for a miss, so 'not found' is never a dead end."""
    if result.record is not None:
        return ""
    if result.classification in EXPLANATIONS:
        return EXPLANATIONS[result.classification][1]
    if result.cleaned is None:
        return "No MAC-shaped value found. Need at least 6 hex characters."
    if result.note == "partial":
        return (
            f"No registry entry for {result.cleaned[:9]}. The prefix may be "
            "unassigned, or the local registry data may predate the assignment."
        )
    return "No registry entry."


_DEFAULT: Optional[Registries] = None


def default() -> Registries:
    """Process-wide registries, loaded once on first use."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = Registries()
    return _DEFAULT
