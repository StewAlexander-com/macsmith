"""Run the shared table vectors against the Python parser.

web/js/conformance.mjs runs the same file against the browser parser, so the
two cannot drift apart the way they could before these vectors existed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from macsmith import table

CASES = json.loads(
    (Path(__file__).parent / "vectors" / "table_vectors.json").read_text(encoding="utf-8")
)["cases"]

IDS = [c["name"] for c in CASES]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_row_count(case):
    assert len(table.parse(case["text"]).rows) == case["rows"]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_detected_columns(case):
    parsed = table.parse(case["text"])
    assert parsed.mac_column == case["macColumn"], "MAC column"
    assert parsed.ip_column == case["ipColumn"], "IPv4 column"
    assert parsed.port_column == case["portColumn"], "interface column"


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_header_alignment(case):
    parsed = table.parse(case["text"])
    assert parsed.header_aligned is case["headerAligned"]
    if not case["headerAligned"]:
        assert parsed.safe_header() is None, "a misaligned header must not be offered"


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_incomplete_count(case):
    parsed = table.parse(case["text"])
    assert len(table.find_incomplete(parsed)) == case["incomplete"]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_cell_access_never_raises(case):
    """Bounds-safe access across every row and a range of bad indices."""
    parsed = table.parse(case["text"])
    for row in parsed.rows:
        for index in (-1, 0, 3, 99, None):
            assert isinstance(parsed.cell(row, index), str)
