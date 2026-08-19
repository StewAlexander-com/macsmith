"""CLI behavior, with the write-path safety rules as first-class tests.

The originals wrote to hardcoded filenames on startup and deleted prior output
without asking. These tests pin the opposite behavior so it cannot regress.
"""
from __future__ import annotations

import pytest

from macsmith import cli, outio

CISCO_ARP = """Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.1.1.1               12   0000.0c07.ac01  ARPA   Vlan1
Internet  10.1.1.2                -   INCOMPLETE      ARPA   Vlan1
Internet  10.1.1.3               44   001a.2b3c.4d5e  ARPA   Vlan1
"""

MAC_TABLE = """Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
   1    0000.0c07.ac01    DYNAMIC     Gi1/0/1
   1    001a.2b3c.4d5e    DYNAMIC     Gi1/0/2
"""


@pytest.fixture()
def arp_file(tmp_path):
    p = tmp_path / "arp.txt"
    p.write_text(CISCO_ARP, encoding="utf-8")
    return p


@pytest.fixture()
def table_file(tmp_path):
    p = tmp_path / "mactable.txt"
    p.write_text(MAC_TABLE, encoding="utf-8")
    return p


# --- exit codes -------------------------------------------------------------

def test_no_command_prints_help(capsys):
    assert cli.main([]) == cli.EXIT_USAGE
    assert "macsmith" in capsys.readouterr().out


def test_no_match_is_distinct_from_error(table_file, capsys):
    """A clean run that found nothing must not look like a failure."""
    code = cli.main(["incomplete", str(table_file), "-f", "csv"])
    assert code == cli.EXIT_NO_MATCH
    assert code != cli.EXIT_ERROR


def test_missing_file_reports_resolved_path(capsys):
    code = cli.main(["incomplete", "definitely-not-here.txt"])
    assert code == cli.EXIT_USAGE
    err = capsys.readouterr().err
    assert "File not found" in err
    assert "definitely-not-here.txt" in err


# --- write safety -----------------------------------------------------------

def test_output_refuses_to_clobber(tmp_path, arp_file, capsys):
    target = tmp_path / "out.csv"
    target.write_text("PRECIOUS DATA", encoding="utf-8")
    code = cli.main(["csv", str(arp_file), "-o", str(target)])
    assert code == cli.EXIT_ERROR
    assert target.read_text(encoding="utf-8") == "PRECIOUS DATA"
    assert "--force" in capsys.readouterr().err


def test_force_replaces_and_says_what_it_replaced(tmp_path, arp_file, capsys):
    target = tmp_path / "out.csv"
    target.write_text("OLD", encoding="utf-8")
    code = cli.main(["csv", str(arp_file), "-o", str(target), "--force"])
    assert code == cli.EXIT_OK
    assert target.read_text(encoding="utf-8") != "OLD"
    assert "replaced 3 bytes" in capsys.readouterr().err


def test_dry_run_writes_nothing(tmp_path, arp_file, capsys):
    target = tmp_path / "out.csv"
    code = cli.main(["csv", str(arp_file), "-o", str(target), "--dry-run"])
    assert code == cli.EXIT_OK
    assert not target.exists(), "dry run must not create the file"
    assert "[dry run]" in capsys.readouterr().err


def test_nothing_is_written_without_an_output_flag(tmp_path, arp_file, monkeypatch):
    """Running a command must never create files in the working directory."""
    monkeypatch.chdir(tmp_path)
    before = set(p.name for p in tmp_path.iterdir())
    cli.main(["incomplete", str(arp_file), "-f", "csv"])
    cli.main(["csv", str(arp_file), "-f", "csv"])
    assert set(p.name for p in tmp_path.iterdir()) == before


# --- commands ---------------------------------------------------------------

def test_fmt_converts_and_reports_detection(capsys):
    assert cli.main(["fmt", "00:1A:2B:3C:4D:5E", "--to", "cisco", "-f", "csv"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "001a.2b3c.4d5e" in out
    assert "colon" in out


def test_fmt_quiet_emits_only_addresses(capsys):
    cli.main(["fmt", "0000.0c07.ac01", "--to", "colon", "-q", "-f", "csv"])
    assert capsys.readouterr().out.strip() == "00:00:0C:07:AC:01"


def test_fmt_refuses_incomplete_address(capsys):
    code = cli.main(["fmt", "001A2B", "--to", "colon", "-f", "csv"])
    assert code == cli.EXIT_ERROR
    assert "could not be converted" in capsys.readouterr().err


def test_find_matches_across_formats(arp_file, capsys):
    """A colon-format needle must find a Cisco-format haystack entry."""
    code = cli.main(["find", str(arp_file), "--mac", "00:1a:2b:3c:4d:5e", "-f", "csv"])
    assert code == cli.EXIT_OK
    assert "10.1.1.3" in capsys.readouterr().out


def test_find_reports_both_formats_when_missing(arp_file, capsys):
    code = cli.main(["find", str(arp_file), "--mac", "aa:bb:cc:dd:ee:ff"])
    assert code == cli.EXIT_NO_MATCH
    assert "was not found" in capsys.readouterr().err


def test_incomplete_finds_unresolved_entries(arp_file, capsys):
    assert cli.main(["incomplete", str(arp_file), "-f", "csv"]) == cli.EXIT_OK
    assert "10.1.1.2" in capsys.readouterr().out


def test_table_detects_columns_without_being_told(table_file, capsys):
    assert cli.main(["table", str(table_file), "-f", "csv"]) == cli.EXIT_OK
    captured = capsys.readouterr()
    assert "0000.0c07.ac01,Gi1/0/1" in captured.out
    assert "using column 2 for MAC" in captured.err


def test_table_vendor_lookup_is_offline(table_file, capsys):
    assert cli.main(["table", str(table_file), "--vendors", "-q", "-f", "csv"]) == cli.EXIT_OK
    assert "Cisco" in capsys.readouterr().out


def test_table_column_override(table_file, capsys):
    cli.main(["table", str(table_file), "--mac-column", "2", "--port-column", "4",
              "-q", "-f", "csv"])
    assert "0000.0c07.ac01,Gi1/0/1" in capsys.readouterr().out


def test_grep_plain_and_regex(arp_file, capsys):
    assert cli.main(["grep", "INCOMPLETE", str(arp_file), "-f", "csv"]) == cli.EXIT_OK
    assert "10.1.1.2" in capsys.readouterr().out
    assert cli.main(["grep", r"10\.1\.1\.[13]", str(arp_file), "-e", "-f", "csv"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "10.1.1.1" in out and "10.1.1.3" in out


def test_grep_invalid_regex_is_usage_not_crash(arp_file, capsys):
    assert cli.main(["grep", "[unclosed", str(arp_file), "-e"]) == cli.EXIT_USAGE
    assert "Invalid regular expression" in capsys.readouterr().err


def test_vendor_explains_a_miss(capsys):
    code = cli.main(["vendor", "02:42:ac:11:00:02", "--explain", "-f", "csv"])
    assert code == cli.EXIT_OK
    assert "Locally administered" in capsys.readouterr().out


def test_salt_pairs_minion_to_hwaddr(tmp_path, capsys):
    yaml_text = """web-01:
  eth0:
    hwaddr: 00:1a:2b:3c:4d:5e
  lo:
    hwaddr: 00:00:00:00:00:00
db-01:
  eth0:
    hwaddr: 3c:22:fb:1a:9f:01
"""
    p = tmp_path / "salt.yaml"
    p.write_text(yaml_text, encoding="utf-8")
    assert cli.main(["salt", str(p), "-f", "csv"]) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "web-01,00:1a:2b:3c:4d:5e" in out
    assert "db-01,3c:22:fb:1a:9f:01" in out
    assert "00:00:00:00:00:00" not in out, "loopback placeholder is not a real address"


# --- destination unit tests -------------------------------------------------

def test_destination_stdout_is_default():
    dest = outio.Destination(None)
    assert dest.is_stdout
    assert dest.describe() == "stdout"


def test_destination_refuses_directory(tmp_path):
    with pytest.raises(outio.OutputRefused):
        outio.Destination(str(tmp_path))
