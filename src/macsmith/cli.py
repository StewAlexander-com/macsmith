"""macsmith command line.

One entry point over the eight scripts this replaces. Every subcommand reads a
file or stdin and writes stdout, so they compose:

    ssh switch 'show mac address-table' | macsmith table --vendors
    pbpaste | macsmith incomplete
    macsmith find arp.txt --mac 001a.2b3c.4d5e

Mapping back to the originals, for anyone migrating:

    Mac-Converter.py            -> macsmith fmt
    maclookup.py                -> macsmith vendor
    MACTable-Tool.py            -> macsmith table
    Find-Incomplete-MAC...py    -> macsmith incomplete
    IP-ARP-MAC-Lookup.py        -> macsmith find
    Color-NetSearch.py          -> macsmith grep
    MAC2CSV.py                  -> macsmith csv
    saltstack-mac2csv.py        -> macsmith salt
"""
from __future__ import annotations

import argparse
import re
import sys
from typing import List, Optional, Sequence

from . import __version__, mac, outio, registry, table as table_mod

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
# A search that ran correctly but matched nothing. Distinct from an error so
# scripts can tell "no incomplete entries" from "the file was unreadable".
EXIT_NO_MATCH = 3


# --- shared argument groups -------------------------------------------------

def _add_output_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("output")
    g.add_argument("-o", "--output", metavar="FILE",
                   help="write to FILE instead of stdout (refuses to overwrite)")
    g.add_argument("--force", action="store_true",
                   help="allow -o to replace an existing file")
    g.add_argument("--dry-run", action="store_true",
                   help="report what would be written without writing it")
    g.add_argument("-f", "--format", dest="fmt", choices=outio.FORMATS,
                   default=None, help="output format (default: table to a "
                                      "terminal, csv when piped or written)")


def _resolve_format(args) -> str:
    if args.fmt:
        return args.fmt
    # A human at a terminal wants columns; a pipe or a file wants CSV.
    if args.output:
        return "csv"
    return "table" if sys.stdout.isatty() else "csv"


def _deliver(args, header, rows) -> int:
    fmt = _resolve_format(args)
    dest = outio.Destination(args.output, force=args.force, dry_run=args.dry_run)
    text = outio.render(fmt, header, rows)
    outio.note(dest.write(text, rows=len(rows)))
    return EXIT_OK if rows else EXIT_NO_MATCH


# --- fmt --------------------------------------------------------------------

def cmd_fmt(args) -> int:
    """Convert MAC addresses between formats."""
    values: List[str] = list(args.macs)
    if not values:
        text = outio.read_many([args.file] if args.file else [])
        values = [hexes for hexes, _ocr in mac.extract_mac_candidates(text)]
        values = [v for v in values if len(v) == 12]
        if not values:
            outio.note("No complete MAC addresses found in the input.")
            return EXIT_NO_MATCH

    header = ["input", "formatted", "detected", "class"]
    rows, failures = [], 0
    for value in values:
        result = mac.convert(value, args.to)
        if result.ok:
            rows.append([result.original, result.formatted,
                         result.detected or "?", result.classification or ""])
        else:
            failures += 1
            rows.append([result.original, f"! {result.error}", "", ""])

    if args.quiet:
        header = []
        rows = [[r[1]] for r in rows if not r[1].startswith("! ")]

    code = _deliver(args, header, rows)
    if failures:
        outio.note(f"{failures} value(s) could not be converted.")
        return EXIT_ERROR
    return code


# --- vendor -----------------------------------------------------------------

def cmd_vendor(args) -> int:
    """Look up the IEEE registrant for MAC addresses or OUI prefixes."""
    regs = registry.default()
    if not regs.available:
        outio.note(
            "No IEEE registry data found next to the package.\n"
            "Expected oui.csv, mam.csv, or oui36.csv in macsmith/data/."
        )
        return EXIT_ERROR
    if regs.is_stale():
        outio.note(f"Registry data is {regs.age_days()} days old. "
                   f"Refresh with: python scripts/refresh_registries.py")

    values: List[str] = list(args.macs)
    if not values:
        text = outio.read_many([args.file] if args.file else [])
        values = [h for h, _ in mac.extract_mac_candidates(text)]
        if not values:
            outio.note("No MAC-shaped values found in the input.")
            return EXIT_NO_MATCH

    header = ["input", "matched", "registry", "organization", "note"]
    rows = []
    for value in values:
        result = regs.lookup(value)
        if result.record is not None:
            rows.append([value, result.record.assignment, result.record.registry,
                         result.record.organization,
                         "typo corrected" if result.note == "ocr" else ""])
        else:
            label = registry.EXPLANATIONS.get(result.classification, ("", ""))[0]
            rows.append([value, result.cleaned or "", "",
                         label or "no registry entry",
                         registry.explain(result) if args.explain else ""])
    return _deliver(args, header, rows)


# --- table ------------------------------------------------------------------

def cmd_table(args) -> int:
    """Turn a MAC address table into MAC / port / vendor columns."""
    text = outio.read_many([args.file] if args.file else [])
    parsed = table_mod.parse(text)
    if not parsed.rows:
        outio.note("No data rows found. Is this switch table output?")
        return EXIT_NO_MATCH

    mac_col = args.mac_column - 1 if args.mac_column else parsed.mac_column
    port_col = args.port_column - 1 if args.port_column else parsed.port_column

    if mac_col is None:
        outio.note(
            "Could not find a MAC address column.\n"
            "Detected columns: " + _describe_columns(parsed) + "\n"
            "Name one explicitly with --mac-column N (1-based)."
        )
        return EXIT_ERROR

    if not args.quiet:
        outio.note(_preview(parsed, mac_col, port_col))

    regs = registry.default() if args.vendors else None
    header = ["mac", "port", "vendor"] if args.vendors else ["mac", "port"]
    rows = []
    for row in parsed.rows:
        mac_cell = parsed.cell(row, mac_col)
        if not mac_cell:
            continue
        port_cell = parsed.cell(row, port_col)
        if args.vendors:
            rows.append([mac_cell, port_cell, regs.vendor_name(mac_cell, unknown="—")])
        else:
            rows.append([mac_cell, port_cell])
    return _deliver(args, header, rows)


def _describe_columns(parsed) -> str:
    return ", ".join(
        f"{c.index + 1}:{c.kind}{'' if c.kind == 'other' else f'({c.confidence:.0%})'}"
        for c in parsed.columns
    ) or "none"


def _preview(parsed, mac_col: Optional[int], port_col: Optional[int]) -> str:
    """Show what was detected before acting on it.

    This is the poka-yoke that replaces "which column number is the MAC?".
    You see the answer instead of supplying it, and you see it before any
    output is produced.
    """
    bits = [f"{len(parsed.rows)} data row(s), {parsed.skipped} header/rule line(s) skipped"]
    if parsed.header:
        label = "header" if parsed.header_aligned else "header (does not align to data, ignored)"
        bits.append(f"{label}: " + " | ".join(parsed.header))
    bits.append(f"columns: {_describe_columns(parsed)}")
    chosen = f"using column {mac_col + 1} for MAC"
    if port_col is not None:
        chosen += f", column {port_col + 1} for port"
    else:
        chosen += ", no port column detected"
    bits.append(chosen)
    sample = parsed.rows[0] if parsed.rows else []
    if sample:
        bits.append(f"first row -> mac={parsed.cell(sample, mac_col)!r} "
                    f"port={parsed.cell(sample, port_col)!r}")
    return "\n".join("  " + b for b in bits)


# --- incomplete -------------------------------------------------------------

def cmd_incomplete(args) -> int:
    """List ARP entries that never resolved to a hardware address."""
    text = outio.read_many([args.file] if args.file else [])
    parsed = table_mod.parse(text)
    hits = table_mod.find_incomplete(parsed)
    if not hits:
        outio.note("No incomplete entries found.")
        return EXIT_NO_MATCH
    outio.note(f"  {len(hits)} incomplete entr{'y' if len(hits) == 1 else 'ies'} "
               f"of {len(parsed.rows)} row(s).")
    return _deliver(args, parsed.safe_header() or [], hits)


# --- find -------------------------------------------------------------------

def cmd_find(args) -> int:
    """Find a MAC address in a table regardless of the format either side uses."""
    text = outio.read_many([args.file] if args.file else [])
    needle = mac.normalize_mac(args.mac)
    if len(needle) != 12:
        extracted = mac.extract_mac_candidate(args.mac)
        if not extracted or len(extracted) != 12:
            outio.note(f"{args.mac!r} is not a complete MAC address.")
            return EXIT_USAGE
        needle = extracted

    parsed = table_mod.parse(text)
    hits = []
    for row in parsed.rows:
        for cell in row:
            if mac.normalize_mac(cell) == needle:
                hits.append(row)
                break

    if not hits:
        outio.note(f"{mac.format_mac(needle, 'colon')} was not found. "
                   f"Searched {len(parsed.rows)} row(s) in every format.")
        return EXIT_NO_MATCH
    outio.note(f"  {len(hits)} match(es) for {mac.format_mac(needle, 'colon')} "
               f"({mac.format_mac(needle, 'cisco')})")
    return _deliver(args, parsed.safe_header() or [], hits)


# --- grep -------------------------------------------------------------------

def cmd_grep(args) -> int:
    """Search table text for a pattern, keeping whole rows."""
    text = outio.read_many([args.file] if args.file else [])
    if args.regex:
        try:
            pattern = re.compile(args.pattern, 0 if args.case_sensitive else re.IGNORECASE)
        except re.error as exc:
            outio.note(f"Invalid regular expression: {exc}")
            return EXIT_USAGE
        matches = pattern.search
    else:
        needle = args.pattern if args.case_sensitive else args.pattern.lower()

        def matches(line: str) -> bool:  # type: ignore[misc]
            return needle in (line if args.case_sensitive else line.lower())

    hits = [line for line in text.splitlines() if line.strip() and matches(line)]
    if not hits:
        outio.note(f"No lines matched {args.pattern!r}.")
        return EXIT_NO_MATCH
    outio.note(f"  {len(hits)} matching line(s).")
    rows = [[line] for line in hits] if _resolve_format(args) != "table" else [line.split() for line in hits]
    return _deliver(args, [], rows)


# --- csv --------------------------------------------------------------------

def cmd_csv(args) -> int:
    """Convert whitespace-columned output to CSV without losing ragged rows."""
    text = outio.read_many([args.file] if args.file else [])
    parsed = table_mod.parse(text)
    if not parsed.rows:
        outio.note("No data rows found.")
        return EXIT_NO_MATCH
    header = parsed.safe_header() or []
    if args.no_header:
        header = []
    args.fmt = args.fmt or "csv"
    return _deliver(args, header, parsed.rows)


# --- salt -------------------------------------------------------------------

def cmd_salt(args) -> int:
    """Extract minion name and hardware address from salt network.interfaces."""
    text = outio.read_many([args.file] if args.file else [])
    try:
        import yaml  # noqa: F401
    except ImportError:
        rows = _salt_parse_lines(text)
        outio.note("  PyYAML not installed — used line parsing. "
                   "For nested output install it: pip install 'macsmith[salt]'")
    else:
        rows = _salt_parse_yaml(text)

    if not rows:
        outio.note("No minion/hwaddr pairs found.")
        return EXIT_NO_MATCH
    return _deliver(args, ["minion", "hwaddr"], rows)


def _salt_parse_yaml(text: str) -> List[List[str]]:
    """Walk the parsed YAML so a minion with several interfaces keeps them all.

    The original zipped two independently-built lists, which silently misaligned
    names and addresses whenever a minion had more than one interface.
    """
    import yaml

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return _salt_parse_lines(text)
    if not isinstance(data, dict):
        return _salt_parse_lines(text)

    rows: List[List[str]] = []
    for minion, interfaces in data.items():
        if not isinstance(interfaces, dict):
            continue
        for iface, detail in interfaces.items():
            if not isinstance(detail, dict):
                continue
            hwaddr = detail.get("hwaddr")
            if not hwaddr or hwaddr == "00:00:00:00:00:00":
                continue
            rows.append([str(minion), str(hwaddr), str(iface)])
    if rows and all(len(r) == 3 for r in rows):
        return [[m, h] for m, h, _ in rows] if _single_iface(rows) else \
               [[f"{m} ({i})", h] for m, h, i in rows]
    return rows


def _single_iface(rows: List[List[str]]) -> bool:
    seen = {}
    for minion, _hw, _iface in rows:
        seen[minion] = seen.get(minion, 0) + 1
    return all(v == 1 for v in seen.values())


def _salt_parse_lines(text: str) -> List[List[str]]:
    """Fallback that walks indentation, pairing each hwaddr with its minion."""
    rows: List[List[str]] = []
    current: Optional[str] = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if indent == 0 and line.endswith(":"):
            current = line[:-1].strip()
            continue
        if line.startswith("hwaddr:") and current:
            hwaddr = line.split(":", 1)[1].strip()
            if hwaddr and hwaddr != "00:00:00:00:00:00":
                rows.append([current, hwaddr])
    return rows


# --- info -------------------------------------------------------------------

def cmd_info(args) -> int:
    """Report what data is loaded and how old it is."""
    regs = registry.default()
    lines = [f"macsmith {__version__}", f"registry data: {regs.data_dir}"]
    if regs.available:
        lines.append(f"loaded: {regs.summary()}")
        age = regs.age_days()
        lines.append(f"age: {age} day(s)" + ("  [STALE]" if regs.is_stale() else ""))
    else:
        lines.append("loaded: none — vendor lookup unavailable")
    print("\n".join(lines))
    return EXIT_OK if regs.available else EXIT_ERROR


# --- parser -----------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="macsmith",
        description="Offline MAC address and ARP/MAC-table toolkit.",
        epilog="Every command reads a file or stdin and writes stdout, so they "
               "pipe. Browser version: https://stewalexander-com.github.io/macsmith/",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--version", action="version", version=f"macsmith {__version__}")
    sub = p.add_subparsers(dest="command", metavar="<command>")

    # fmt
    s = sub.add_parser("fmt", help="convert MAC addresses between formats")
    s.add_argument("macs", nargs="*", help="addresses to convert (default: read input)")
    s.add_argument("--file", metavar="FILE", help="read addresses from FILE or '-'")
    s.add_argument("--to", default="colon",
                   help="target format: colon, hyphen, cisco, bare "
                        "(aliases: pc, windows, dotted, unix)")
    s.add_argument("-q", "--quiet", action="store_true",
                   help="print only the converted addresses")
    _add_output_args(s)
    s.set_defaults(func=cmd_fmt)

    # vendor
    s = sub.add_parser("vendor", help="look up the IEEE registrant offline")
    s.add_argument("macs", nargs="*", help="addresses or OUI prefixes")
    s.add_argument("--file", metavar="FILE", help="read addresses from FILE or '-'")
    s.add_argument("--explain", action="store_true",
                   help="say why a lookup missed")
    _add_output_args(s)
    s.set_defaults(func=cmd_vendor)

    # table
    s = sub.add_parser("table", help="MAC table to mac/port/vendor columns")
    s.add_argument("file", nargs="?", help="table file, or '-' for stdin")
    s.add_argument("--vendors", action="store_true", help="add an offline vendor column")
    s.add_argument("--mac-column", type=int, metavar="N",
                   help="override MAC column (1-based)")
    s.add_argument("--port-column", type=int, metavar="N",
                   help="override port column (1-based)")
    s.add_argument("-q", "--quiet", action="store_true", help="skip the detection preview")
    _add_output_args(s)
    s.set_defaults(func=cmd_table)

    # incomplete
    s = sub.add_parser("incomplete", help="list unresolved ARP entries")
    s.add_argument("file", nargs="?", help="ARP file, or '-' for stdin")
    _add_output_args(s)
    s.set_defaults(func=cmd_incomplete)

    # find
    s = sub.add_parser("find", help="find a MAC in a table, any format either side")
    s.add_argument("file", nargs="?", help="table file, or '-' for stdin")
    s.add_argument("--mac", required=True, help="address to look for")
    _add_output_args(s)
    s.set_defaults(func=cmd_find)

    # grep
    s = sub.add_parser("grep", help="search table text, keeping whole rows")
    s.add_argument("pattern", help="text to look for")
    s.add_argument("file", nargs="?", help="file to search, or '-' for stdin")
    s.add_argument("-e", "--regex", action="store_true", help="treat pattern as a regex")
    s.add_argument("-s", "--case-sensitive", action="store_true")
    _add_output_args(s)
    s.set_defaults(func=cmd_grep)

    # csv
    s = sub.add_parser("csv", help="whitespace columns to CSV")
    s.add_argument("file", nargs="?", help="file to convert, or '-' for stdin")
    s.add_argument("--no-header", action="store_true", help="do not emit a header row")
    _add_output_args(s)
    s.set_defaults(func=cmd_csv)

    # salt
    s = sub.add_parser("salt", help="salt network.interfaces YAML to minion/hwaddr")
    s.add_argument("file", nargs="?", help="YAML file, or '-' for stdin")
    _add_output_args(s)
    s.set_defaults(func=cmd_salt)

    # info
    s = sub.add_parser("info", help="show loaded registry data and its age")
    s.set_defaults(func=cmd_info)

    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_USAGE
    try:
        return args.func(args)
    except outio.InputError as exc:
        outio.note(str(exc))
        return EXIT_USAGE
    except outio.OutputRefused as exc:
        outio.note(str(exc))
        return EXIT_ERROR
    except mac.MacFormatError as exc:
        outio.note(str(exc))
        return EXIT_USAGE
    except BrokenPipeError:
        # `macsmith ... | head` is normal usage, not a failure.
        return EXIT_OK
    except KeyboardInterrupt:
        outio.note("Interrupted.")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
