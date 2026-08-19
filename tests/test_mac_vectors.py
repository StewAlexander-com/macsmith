"""Run the shared conformance vectors against the Python MAC core.

The same file is run against the browser build by web/js/conformance.mjs, so a
behavior change that only lands on one side fails here or there.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from macsmith import mac

VECTORS = json.loads(
    (Path(__file__).parent / "vectors" / "mac_vectors.json").read_text(encoding="utf-8")
)


def _ids(cases, key):
    return [str(c.get(key, "")) for c in cases]


@pytest.mark.parametrize("case", VECTORS["normalize"], ids=_ids(VECTORS["normalize"], "in"))
def test_normalize(case):
    assert mac.normalize_mac(case["in"]) == case["out"]


@pytest.mark.parametrize("case", VECTORS["classify"], ids=_ids(VECTORS["classify"], "in"))
def test_classify(case):
    assert mac.classify_mac(case["in"]) == case["out"]


@pytest.mark.parametrize("case", VECTORS["extract"], ids=_ids(VECTORS["extract"], "in"))
def test_extract(case):
    assert mac.extract_mac_candidate(case["in"]) == case["first"]


@pytest.mark.parametrize("case", VECTORS["format"], ids=_ids(VECTORS["format"], "out"))
def test_format(case):
    assert mac.format_mac(case["hex"], case["style"]) == case["out"]


@pytest.mark.parametrize("case", VECTORS["format_aliases"], ids=_ids(VECTORS["format_aliases"], "alias"))
def test_format_aliases(case):
    assert mac.resolve_style(case["alias"]) == case["resolves_to"]


@pytest.mark.parametrize("case", VECTORS["format_errors"], ids=_ids(VECTORS["format_errors"], "why"))
def test_format_errors(case):
    with pytest.raises(mac.MacFormatError):
        mac.format_mac(case["hex"], case["style"])


@pytest.mark.parametrize("case", VECTORS["convert"], ids=_ids(VECTORS["convert"], "in"))
def test_convert(case):
    result = mac.convert(case["in"], case["style"])
    assert result.ok is case["ok"]
    if not case["ok"]:
        assert result.error, "a failed conversion must explain itself"
        return
    assert result.formatted == case["formatted"]
    assert result.detected == case["detected"]
    assert result.classification == case["classification"]
