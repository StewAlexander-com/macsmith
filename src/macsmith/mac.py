"""MAC address normalization, classification, extraction, and formatting.

This is the shared atom every macsmith command sits on. The normalization and
extraction logic is promoted from maclookup.py, which had the only complete
implementation; the formatting half comes from Mac-Converter.py.

Nothing here touches the filesystem or the network, so the same behavior is
reproducible in the browser build. The conformance vectors in
``tests/vectors/mac_vectors.json`` are the authority for both implementations.
"""
from __future__ import annotations

import re
from typing import List, NamedTuple, Optional, Tuple

# --- Classification of a full 12-hex MAC -----------------------------------
# Stable strings so the CLI, the web UI, and tests can all switch on them.
CLASS_BROADCAST = "broadcast"
CLASS_ALL_ZERO = "all-zero"
CLASS_MULTICAST_LAA = "multicast-laa"
CLASS_MULTICAST = "multicast"
CLASS_LAA = "laa"

CLASS_BLURBS = {
    CLASS_BROADCAST: "broadcast (FF:FF:FF:FF:FF:FF)",
    CLASS_ALL_ZERO: "all-zero",
    CLASS_LAA: "locally administered (private/randomized)",
    CLASS_MULTICAST: "multicast/group",
    CLASS_MULTICAST_LAA: "locally administered multicast",
}

_SEPARATORS_RE = re.compile(r"[-:.\s]")
# Separators that may sit *inside* a MAC token. Whitespace is a token boundary
# instead, so two MACs on adjacent lines don't collapse into one long run.
_INNER_SEP_RE = re.compile(r"[-:.]")
_LABEL_RE = re.compile(
    r"(?i)\b(?:mac(?:\s*address)?|hardware\s*address|hwaddr|"
    r"ether(?:net)?(?:\s*address)?|physical\s*address|bia|burned[- ]?in[- ]?address)"
    r"\s*[:=]?\s*"
)
_WRAPPER_CHARS = "()[]<>{}\"'`,;\t\r\n"
_TOKEN_RE = re.compile(r"[0-9A-Fa-fOoIiLl\-:.]+")
_OCR_FIX = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "L": "1"})

# Group sizes real MAC formats use between separators. A separator-bearing
# token with no hex letters (so a phone number could be mistaken for a MAC)
# must use one of these uniform sizes.
_MAC_GROUP_SIZES = {2, 4, 6}


class MacFormatError(ValueError):
    """Raised when a value cannot be rendered in the requested format."""


def normalize_mac(mac_address: str) -> str:
    """Strip separators and uppercase. Accepts colon, hyphen, Cisco dotted,
    bare hex, and space-separated input."""
    return _SEPARATORS_RE.sub("", mac_address or "").upper()


def classify_mac(hex_only: Optional[str]) -> str:
    """Return a stable classification for a 12-hex MAC, or ``""``.

    IEEE first-byte bits: bit 0 (0x01) is I/G, 1 meaning multicast; bit 1
    (0x02) is U/L, 1 meaning locally administered. Tested broadcast >
    all-zero > multicast+LAA > multicast > LAA.
    """
    if not hex_only or len(hex_only) != 12:
        return ""
    upper = hex_only.upper()
    if upper == "FFFFFFFFFFFF":
        return CLASS_BROADCAST
    if upper == "000000000000":
        return CLASS_ALL_ZERO
    try:
        first_byte = int(upper[:2], 16)
    except ValueError:
        return ""
    multicast = bool(first_byte & 0x01)
    laa = bool(first_byte & 0x02)
    if multicast and laa:
        return CLASS_MULTICAST_LAA
    if multicast:
        return CLASS_MULTICAST
    if laa:
        return CLASS_LAA
    return ""


def _all_hex(s: str) -> bool:
    return bool(s) and all(c in "0123456789ABCDEFabcdef" for c in s)


def _has_hex_letter(s: str) -> bool:
    return any(c in "abcdefABCDEF" for c in s)


def _looks_mac_shaped(token: str) -> bool:
    """Gate OCR substitution so vendor words like ``cisco`` aren't corrupted."""
    if not _INNER_SEP_RE.search(token):
        return False
    stripped = _INNER_SEP_RE.sub("", token)
    return 6 <= len(stripped) <= 12


def _has_macish_grouping(token: str) -> bool:
    """Reject pure-digit tokens whose groups aren't sized like a MAC.

    Accepts 2/2/2/2/2/2, 4/4/4, 6/6, and truncated prefix shapes. Rejects
    1-800-555-1234 (1/3/3/4) and +44-20-7946-0958 (mixed sizes).

    Every real MAC notation uses one group width throughout, so uniformity is
    required at any group count. Checking it only from four groups upward let
    the date 2026-08-19 through as 4/2/2, which then merged into a plausible
    eight-character prefix.
    """
    if _has_hex_letter(token):
        return True
    groups = _INNER_SEP_RE.split(token)
    if len(groups) < 2:
        return True
    sizes = [len(g) for g in groups]
    if any(s not in _MAC_GROUP_SIZES for s in sizes):
        return False
    if len(set(sizes)) != 1:
        return False
    return True


def _maybe_pad_single_nibble_octets(token: str) -> Optional[str]:
    """Pad the ``fe:35:b6:60:f:ee`` shape where a leading zero was dropped.

    Full-MAC shape only (exactly 6 groups), and at least one group must carry
    a hex letter so ``1:2:3:4:5:6`` counters stay out of the MAC path.
    """
    if ":" in token:
        groups = token.split(":")
    elif "-" in token:
        groups = token.split("-")
    else:
        return None
    if len(groups) != 6:
        return None
    has_letter = False
    for g in groups:
        if not (1 <= len(g) <= 2) or not _all_hex(g):
            return None
        if _has_hex_letter(g):
            has_letter = True
    if not has_letter:
        return None
    return "".join(g.zfill(2) for g in groups).upper()


def _normalized_input_is_mac_shaped(raw_input: str) -> bool:
    """Whether raw input is safe to treat as bare hex once separators go.

    Without this, ``1-800-555-1234`` normalizes to a plausible-looking hex run
    and gets reported as a partial match.
    """
    if not raw_input:
        return False
    text = raw_input.strip()
    if not text:
        return False
    for ch in _WRAPPER_CHARS + " ":
        text = text.replace(ch, "")
    if not text:
        return False
    if not _INNER_SEP_RE.search(text):
        return True
    groups = _INNER_SEP_RE.split(text)
    # Single-nibble octets must go through the candidate extractor, which pads
    # them; merging here would shift the prefix.
    if any(len(g) == 1 for g in groups) and len(groups) >= 2:
        return False
    return _has_macish_grouping(text)


def _candidate_from_token(token: str) -> Optional[Tuple[str, bool]]:
    """Score one token. Returns ``(hex_only, used_ocr)`` or None."""
    if not token:
        return None
    if _all_hex(token) and 6 <= len(token) <= 12:
        return token.upper(), False
    padded = _maybe_pad_single_nibble_octets(token)
    if padded is not None:
        return padded, False
    if _looks_mac_shaped(token) and _has_macish_grouping(token):
        stripped = _INNER_SEP_RE.sub("", token)
        if _all_hex(stripped) and 6 <= len(stripped) <= 12:
            return stripped.upper(), False
        fixed = stripped.translate(_OCR_FIX)
        if _all_hex(fixed) and 6 <= len(fixed) <= 12 and fixed != stripped:
            return fixed.upper(), True
    return None


def _combine_whitespace_chunks(tokens: List[str]) -> Optional[Tuple[str, bool]]:
    """Merge ``00 1A 2B 3C 4D 5E`` where each chunk is below the 6-char floor.

    Chunks must be uniformly sized and sized like a real MAC group. Without
    that, hex-ish fragments of ordinary words get glued across word
    boundaries: "no address here" tokenizes to add/e/e/e and merges into
    ADDEEE, which then reports as a partial OUI prefix.
    """
    best = ""
    n = len(tokens)
    for i in range(n):
        if not _all_hex(tokens[i]):
            continue
        width = len(tokens[i])
        if width not in _MAC_GROUP_SIZES:
            continue
        acc = ""
        for j in range(i, min(i + 6, n)):
            t = tokens[j]
            if not _all_hex(t) or len(t) != width:
                break
            acc += t
            if len(acc) > 12:
                break
            if 6 <= len(acc) <= 12 and len(acc) > len(best):
                best = acc
    return (best.upper(), False) if best else None


def extract_mac_candidates(text: str) -> List[Tuple[str, bool]]:
    """Pull every plausible MAC out of free-form text.

    Returns ``(hex_only_uppercase, used_ocr)`` ordered by preference: longest
    first, and a clean match always ahead of an OCR-corrected one.
    """
    if not text:
        return []
    stripped = _LABEL_RE.sub(" ", text)
    stripped = stripped.translate({ord(c): " " for c in _WRAPPER_CHARS})

    cleaned = []
    for tok in _TOKEN_RE.findall(stripped):
        tok = tok.strip(".-:")
        if tok:
            cleaned.append(tok)

    candidates: List[Tuple[str, bool]] = []
    seen = set()

    def _add(item):
        if item is None:
            return
        hex_only, used_ocr = item
        if hex_only in seen:
            return
        seen.add(hex_only)
        candidates.append(item)

    for tok in cleaned:
        _add(_candidate_from_token(tok))
    _add(_combine_whitespace_chunks(cleaned))

    candidates.sort(key=lambda c: (-len(c[0]), c[1]))
    return candidates


def extract_mac_candidate(text: str) -> Optional[str]:
    """Best single MAC-shaped run in ``text``, or None."""
    candidates = extract_mac_candidates(text)
    return candidates[0][0] if candidates else None


COMPLETE_LEN = 12


def _is_single_value_line(line: str) -> bool:
    """Whether a line holds one deliberately-typed value and nothing else.

    ``ABCDEF`` on its own is someone asking about a prefix and deserves an
    answer, even a negative one. The same six characters inside "invoice
    ABCDEF settled" are a word that happens to be valid hex.
    """
    text = _LABEL_RE.sub(" ", line)
    text = text.translate({ord(c): " " for c in _WRAPPER_CHARS})
    return len(text.split()) == 1


def reportable_candidates(text, resolves=None):
    """Candidates worth putting in front of a user.

    Six or more hex characters is a low bar that ordinary text clears by
    accident: ``FACADE`` and ``DEADBEEF`` are words, and a date or phone
    number glues into ``20260819`` and ``79460958`` once separators go. Every
    one of those was being reported as an unregistered prefix, so real hits
    arrived mixed with noise the reader had to filter by eye.

    A complete twelve-digit address is kept regardless, because it can be
    classified even with no registry at hand. A shorter run is only kept when
    it resolves to a real assignment, or when the line holds nothing else and
    so was clearly typed on purpose.

    ``resolves`` is a predicate taking hex and returning whether it is a
    registered prefix. Pass None when no registry is loaded: filtering would
    then be guesswork, so nothing is dropped.
    """
    lines = text.splitlines() or [text]
    out: List[Tuple[str, bool]] = []
    seen = set()
    for line in lines:
        explicit = _is_single_value_line(line)
        for hex_only, used_ocr in extract_mac_candidates(line):
            if hex_only in seen:
                continue
            if (len(hex_only) < COMPLETE_LEN
                    and not explicit
                    and resolves is not None
                    and not resolves(hex_only)):
                continue
            seen.add(hex_only)
            out.append((hex_only, used_ocr))
    out.sort(key=lambda c: (-len(c[0]), c[1]))
    return out


# --- Formatting -------------------------------------------------------------
# Style names are the CLI's ``--to`` values and the web UI's dropdown values.
STYLE_CISCO = "cisco"        # 001a.2b3c.4d5e
STYLE_COLON = "colon"        # 00:1A:2B:3C:4D:5E
STYLE_HYPHEN = "hyphen"      # 00-1A-2B-3C-4D-5E
STYLE_BARE = "bare"          # 001A2B3C4D5E
STYLES = (STYLE_CISCO, STYLE_COLON, STYLE_HYPHEN, STYLE_BARE)

# What the original Mac-Converter called "PC format" is colon-separated upper.
STYLE_ALIASES = {"pc": STYLE_COLON, "windows": STYLE_HYPHEN, "dot": STYLE_CISCO,
                 "dotted": STYLE_CISCO, "ieee": STYLE_HYPHEN, "unix": STYLE_COLON}


def resolve_style(style: str) -> str:
    s = (style or "").strip().lower()
    s = STYLE_ALIASES.get(s, s)
    if s not in STYLES:
        raise MacFormatError(
            f"unknown format {style!r}; expected one of {', '.join(STYLES)}"
        )
    return s


def format_mac(hex_only: str, style: str = STYLE_COLON) -> str:
    """Render 12 hex characters in the requested style.

    Cisco style is lowercase because that is how IOS prints it; the rest are
    uppercase, matching the original converter's output.
    """
    style = resolve_style(style)
    h = normalize_mac(hex_only)
    if len(h) != 12 or not _all_hex(h):
        raise MacFormatError(
            f"need 12 hex characters to format, got {len(h)} from {hex_only!r}"
        )
    if style == STYLE_CISCO:
        low = h.lower()
        return f"{low[0:4]}.{low[4:8]}.{low[8:12]}"
    if style == STYLE_BARE:
        return h
    sep = ":" if style == STYLE_COLON else "-"
    return sep.join(h[i:i + 2] for i in range(0, 12, 2))


def detect_style(mac_address: str) -> Optional[str]:
    """Best guess at the style of an input string, or None if unrecognizable."""
    t = (mac_address or "").strip()
    if not t:
        return None
    if "." in t:
        return STYLE_CISCO
    if ":" in t:
        return STYLE_COLON
    if "-" in t:
        return STYLE_HYPHEN
    if _all_hex(t) and len(t) == 12:
        return STYLE_BARE
    return None


class ConvertResult(NamedTuple):
    ok: bool
    original: str
    hex_only: Optional[str]
    formatted: Optional[str]
    detected: Optional[str]
    classification: str
    error: str = ""


def convert(mac_address: str, style: str = STYLE_COLON) -> ConvertResult:
    """Convert one address, reporting what was detected rather than guessing
    silently. Used by both the CLI and the web UI so the two agree."""
    original = mac_address or ""
    detected = detect_style(original)
    hex_only = normalize_mac(original)
    if len(hex_only) != 12 or not _all_hex(hex_only):
        extracted = extract_mac_candidate(original)
        if extracted and len(extracted) == 12:
            hex_only = extracted
        else:
            return ConvertResult(
                ok=False, original=original, hex_only=None, formatted=None,
                detected=detected, classification="",
                error="not a complete MAC address (need 12 hex characters)",
            )
    return ConvertResult(
        ok=True, original=original, hex_only=hex_only,
        formatted=format_mac(hex_only, style), detected=detected,
        classification=classify_mac(hex_only),
    )
