"""Input and output plumbing, including the poka-yoke rules.

The originals all wrote to a hardcoded filename in the current directory the
moment you ran them — mac-list.txt, Found_MAC_Addresses.txt, salt_hw.csv,
search_results.txt, and a date-stamped CSV. Several deleted the previous file
first. Running one in the wrong directory silently clobbered work.

The rules here are the opposite:

* Output goes to stdout unless you name a file. Nothing is ever written by
  surprise, and every command composes with a pipe.
* Naming a file that already exists is refused, not overwritten. ``--force``
  is the explicit override, and it says what it replaced.
* ``--dry-run`` reports the exact destination and row count without writing.
"""
from __future__ import annotations

import csv
import io
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, TextIO

STDIN_SENTINEL = "-"


class InputError(Exception):
    """Raised when input cannot be read. Carries a fix, not just a failure."""


class OutputRefused(Exception):
    """Raised when writing would destroy something the user did not name."""


# --- input ------------------------------------------------------------------

def read_text(source: Optional[str], stdin: TextIO = None) -> str:
    """Read from a path, or from stdin when the path is '-' or omitted.

    A missing file reports the resolved absolute path, because "file not
    found" against a relative path is the least useful error in a toolkit
    people run from whatever directory they happen to be in.
    """
    stdin = stdin if stdin is not None else sys.stdin
    if source in (None, "", STDIN_SENTINEL):
        if stdin.isatty():
            raise InputError(
                "No input. Pass a file path, or pipe text in:\n"
                "  macsmith <command> arp.txt\n"
                "  pbpaste | macsmith <command>\n"
                "  ssh switch 'show ip arp' | macsmith <command>"
            )
        return stdin.read()

    path = Path(source).expanduser()
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    if not resolved.exists():
        raise InputError(f"File not found: {resolved}")
    if resolved.is_dir():
        raise InputError(f"That is a directory, not a file: {resolved}")
    try:
        return resolved.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise InputError(f"Could not read {resolved}: {exc}") from exc


def read_many(sources: Sequence[str], stdin: TextIO = None) -> str:
    """Concatenate several inputs, or read stdin when none are given."""
    if not sources:
        return read_text(None, stdin)
    return "\n".join(read_text(s, stdin) for s in sources)


# --- output -----------------------------------------------------------------

class Destination:
    """Where output is going, and whether that is allowed.

    Resolved up front so a command can refuse *before* doing the work, rather
    than after producing output it then cannot deliver.
    """

    def __init__(self, path: Optional[str], force: bool = False,
                 dry_run: bool = False):
        self.dry_run = dry_run
        self.force = force
        self.path: Optional[Path] = None
        self.replaced_bytes: Optional[int] = None

        if path in (None, "", STDIN_SENTINEL):
            return

        target = Path(path).expanduser()
        try:
            target = target.resolve()
        except OSError:
            pass
        self.path = target

        if target.exists():
            if target.is_dir():
                raise OutputRefused(f"{target} is a directory.")
            if not force:
                raise OutputRefused(
                    f"{target} already exists.\n"
                    f"Refusing to overwrite it. Either choose another name, or "
                    f"pass --force to replace it on purpose."
                )
            self.replaced_bytes = target.stat().st_size

    @property
    def is_stdout(self) -> bool:
        return self.path is None

    def describe(self) -> str:
        if self.is_stdout:
            return "stdout"
        return str(self.path)

    def write(self, text: str, *, rows: Optional[int] = None,
              out: TextIO = None) -> str:
        """Deliver the text. Returns a one-line human summary for stderr."""
        out = out if out is not None else sys.stdout
        count = "" if rows is None else f"{rows} row{'s' if rows != 1 else ''}, "

        if self.dry_run:
            return (f"[dry run] would write {count}{len(text)} bytes to "
                    f"{self.describe()}" +
                    ("" if self.replaced_bytes is None
                     else f" (replacing {self.replaced_bytes} bytes)"))

        if self.is_stdout:
            out.write(text)
            if text and not text.endswith("\n"):
                out.write("\n")
            return ""

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(text, encoding="utf-8")
        note = "" if self.replaced_bytes is None else f" (replaced {self.replaced_bytes} bytes)"
        return f"Wrote {count}{len(text)} bytes to {self.path}{note}"


# --- rendering --------------------------------------------------------------

def to_csv(header: Sequence[str], rows: Iterable[Sequence[str]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    if header:
        writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def to_tsv(header: Sequence[str], rows: Iterable[Sequence[str]]) -> str:
    lines = []
    if header:
        lines.append("\t".join(header))
    lines.extend("\t".join(str(c) for c in row) for row in rows)
    return "\n".join(lines) + ("\n" if lines else "")


def to_aligned(header: Sequence[str], rows: Sequence[Sequence[str]],
               max_rows: Optional[int] = None) -> str:
    """Column-aligned plain text. No dependency, no colour, pipes cleanly."""
    body: List[List[str]] = [[str(c) for c in row] for row in rows]
    shown = body if max_rows is None else body[:max_rows]
    grid = ([list(header)] if header else []) + shown
    if not grid:
        return ""
    width = max(len(r) for r in grid)
    for row in grid:
        row.extend([""] * (width - len(row)))
    widths = [max(len(row[i]) for row in grid) for i in range(width)]

    lines = []
    if header:
        lines.append("  ".join(h.ljust(widths[i]) for i, h in enumerate(grid[0])))
        lines.append("  ".join("-" * widths[i] for i in range(width)))
        shown_grid = grid[1:]
    else:
        shown_grid = grid
    for row in shown_grid:
        lines.append("  ".join(row[i].ljust(widths[i]) for i in range(width)).rstrip())
    if max_rows is not None and len(body) > max_rows:
        lines.append(f"... {len(body) - max_rows} more row(s)")
    return "\n".join(lines) + "\n"


FORMATS = ("csv", "tsv", "table")


def render(fmt: str, header: Sequence[str], rows: Sequence[Sequence[str]],
           max_rows: Optional[int] = None) -> str:
    if fmt == "csv":
        return to_csv(header, rows)
    if fmt == "tsv":
        return to_tsv(header, rows)
    return to_aligned(header, rows, max_rows)


def note(message: str) -> None:
    """Human commentary goes to stderr so stdout stays pipeable."""
    if message:
        print(message, file=sys.stderr)
