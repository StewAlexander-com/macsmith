"""Whitespace-delimited table parsing for switch and router CLI output.

Handles `show mac address-table`, `show ip arp`, and anything else that prints
columns separated by runs of spaces. Two things matter here that the original
scripts got wrong:

1. Columns are *detected*, not typed in. MACTable-Tool.py asked the user which
   column number held the MAC and which held the port, then crashed with an
   IndexError on the first blank or short line. Detection removes the question
   and the crash together.
2. Ragged rows never raise. Real CLI output has banners, separator rules, and
   wrapped lines; a parser that assumes every row has the same width is a
   parser that fails on real input.
"""
from __future__ import annotations

import re
from typing import List, NamedTuple, Optional, Sequence

from .mac import extract_mac_candidate, normalize_mac

# A separator rule: ---- or ==== or a mix, possibly in several columns.
_RULE_RE = re.compile(r"^[\s\-=_+|]*$")
_IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
# Interface names: Gi1/0/1, Fa0/1, Te1/1/1, Eth1/2, Po12, Vlan100, xe-0/0/1,
# ge-0/0/1.0, and the bare CPU / Switch pseudo-ports Cisco prints.
_IFACE_RE = re.compile(
    r"^(?:[A-Za-z]{2,12}[-]?\d+(?:[/:]\d+)*(?:\.\d+)?|CPU|Switch|Router|Drop)$"
)
# Values that mean "this ARP entry never resolved".
INCOMPLETE_MARKERS = {"INCOMPLETE", "incomplete", "Incomplete"}
# Cells that carry no value and so should not vote on a column's type.
_MISSING_VALUE = INCOMPLETE_MARKERS | {"-", "--", "n/a", "N/A", "*"}


class Column(NamedTuple):
    index: int
    kind: str          # "mac" | "ipv4" | "interface" | "other"
    confidence: float  # share of data rows that matched
    sample: str


class Table(NamedTuple):
    rows: List[List[str]]      # data rows only, whitespace-split
    header: Optional[List[str]]
    skipped: int               # banner/rule/blank lines dropped
    columns: List[Column]

    @property
    def width(self) -> int:
        return max((len(r) for r in self.rows), default=0)

    @property
    def modal_width(self) -> int:
        """The row width most rows actually have."""
        if not self.rows:
            return 0
        counts: dict = {}
        for row in self.rows:
            counts[len(row)] = counts.get(len(row), 0) + 1
        return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]

    @property
    def header_aligned(self) -> bool:
        """Whether the header can be trusted to label the data columns.

        Multi-word headings ("Age (min)", "Mac Address") split on whitespace
        into more cells than the data has, which slides every label one or two
        columns to the right. Emitting that is worse than emitting nothing,
        so callers use :meth:`safe_header` instead.
        """
        return bool(self.header) and len(self.header) == self.modal_width

    def safe_header(self) -> Optional[List[str]]:
        return list(self.header) if self.header_aligned else None

    def cell(self, row: Sequence[str], index: Optional[int]) -> str:
        """Bounds-safe cell access. Ragged rows yield '' rather than raising."""
        if index is None or index < 0 or index >= len(row):
            return ""
        return row[index]

    def column_of(self, kind: str) -> Optional[int]:
        for col in self.columns:
            if col.kind == kind:
                return col.index
        return None

    @property
    def mac_column(self) -> Optional[int]:
        return self.column_of("mac")

    @property
    def ip_column(self) -> Optional[int]:
        return self.column_of("ipv4")

    @property
    def port_column(self) -> Optional[int]:
        return self.column_of("interface")


def _is_mac_cell(cell: str) -> bool:
    if cell in INCOMPLETE_MARKERS:
        return False
    hex_only = normalize_mac(cell)
    if len(hex_only) == 12 and extract_mac_candidate(cell):
        return True
    return False


def _is_ipv4_cell(cell: str) -> bool:
    if not _IPV4_RE.match(cell):
        return False
    return all(0 <= int(p) <= 255 for p in cell.split("."))


def _is_iface_cell(cell: str) -> bool:
    if _is_ipv4_cell(cell) or _is_mac_cell(cell):
        return False
    return bool(_IFACE_RE.match(cell))


def _looks_like_header(cells: Sequence[str]) -> bool:
    """A header row has no MAC and no IP, and reads like words."""
    if not cells:
        return False
    if any(_is_mac_cell(c) or _is_ipv4_cell(c) for c in cells):
        return False
    wordish = sum(1 for c in cells if re.match(r"^[A-Za-z][A-Za-z()/_.-]*$", c))
    return wordish >= max(2, len(cells) // 2)


def detect_columns(rows: Sequence[Sequence[str]]) -> List[Column]:
    """Classify each column by what most of its cells look like.

    Returns one Column per index, sorted by index. A column is typed when more
    than half its non-empty cells agree; ties resolve toward the more specific
    kind (mac > ipv4 > interface).
    """
    width = max((len(r) for r in rows), default=0)
    columns: List[Column] = []
    for i in range(width):
        cells = [r[i] for r in rows if i < len(r) and r[i]]
        # Markers that mean "no value in this cell" must not count against the
        # column's type. An ARP table that is half INCOMPLETE is still an ARP
        # table, and scoring them as non-MACs pinned confidence at exactly 0.5.
        cells = [c for c in cells if c not in _MISSING_VALUE]
        if not cells:
            columns.append(Column(i, "other", 0.0, ""))
            continue
        total = len(cells)
        scores = {
            "mac": sum(1 for c in cells if _is_mac_cell(c)) / total,
            "ipv4": sum(1 for c in cells if _is_ipv4_cell(c)) / total,
            "interface": sum(1 for c in cells if _is_iface_cell(c)) / total,
        }
        kind, confidence = max(scores.items(), key=lambda kv: (kv[1], -"mac ipv4 interface".index(kv[0])))
        if confidence <= 0.5:
            kind, confidence = "other", confidence
        columns.append(Column(i, kind, round(confidence, 3), cells[0]))

    # Only one column of each specific kind: keep the most confident, demote
    # the rest. Two "mac" columns would make downstream selection ambiguous.
    for kind in ("mac", "ipv4", "interface"):
        matches = [c for c in columns if c.kind == kind]
        if len(matches) <= 1:
            continue
        winner = max(matches, key=lambda c: (c.confidence, -c.index))
        for col in matches:
            if col is not winner:
                columns[col.index] = col._replace(kind="other")
    return columns


def parse(text: str) -> Table:
    """Parse CLI table text. Never raises on malformed input."""
    header: Optional[List[str]] = None
    rows: List[List[str]] = []
    skipped = 0

    for line in (text or "").splitlines():
        if not line.strip():
            skipped += 1
            continue
        if _RULE_RE.match(line):
            skipped += 1
            continue
        cells = line.split()
        if not rows and _looks_like_header(cells):
            # Keep the *last* header-like line before the data starts. Cisco
            # prints a centered banner ("Mac Address Table") above the real
            # column header, and the banner would otherwise win.
            if header is not None:
                skipped += 1
            header = cells
            continue
        rows.append(cells)

    # A header-looking line among the data (repeated headers from paged output)
    # is dropped rather than treated as a row.
    if rows:
        filtered = [r for r in rows if not _looks_like_header(r)]
        skipped += len(rows) - len(filtered)
        rows = filtered

    return Table(rows=rows, header=header, skipped=skipped, columns=detect_columns(rows))


def find_incomplete(table: Table) -> List[List[str]]:
    """Rows whose MAC/hardware-address cell is the INCOMPLETE marker.

    The original script hardcoded ``words[2] == "INCOMPLETE"``, which is right
    only for one Cisco format and raises IndexError on short lines. This scans
    every cell instead.
    """
    out = []
    for row in table.rows:
        if any(cell in INCOMPLETE_MARKERS for cell in row):
            out.append(row)
    return out
