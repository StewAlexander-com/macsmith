"""Table parsing against real switch and router output shapes.

Fixtures are trimmed captures of the formats the original scripts were written
against, including the ragged and banner-laden cases that made them crash.
"""
from __future__ import annotations

import pytest

from macsmith import table

CISCO_MAC_TABLE = """
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
   1    0000.0c07.ac01    DYNAMIC     Gi1/0/1
   1    001a.2b3c.4d5e    DYNAMIC     Gi1/0/2
  10    0242.ac11.0002    DYNAMIC     Gi1/0/3
Total Mac Addresses for this criterion: 4
"""

CISCO_ARP = """
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.1.1.1               12   0000.0c07.ac01  ARPA   Vlan1
Internet  10.1.1.2                -   INCOMPLETE      ARPA   Vlan1
Internet  10.1.1.3               44   001a.2b3c.4d5e  ARPA   Vlan1
Internet  10.1.1.4                -   INCOMPLETE      ARPA   Vlan1
"""

LINUX_ARP = """
Address                  HWtype  HWaddress           Flags Mask            Iface
10.0.0.1                 ether   fe:35:b6:60:0f:ee   C                     eth0
10.0.0.2                 ether   00:1a:2b:3c:4d:5e   C                     eth0
"""

RAGGED = """
1 0000.0c07.ac01 Gi1/0/1
2 001a.2b3c.4d5e
3
   
4 0242.ac11.0002 Gi1/0/4 extra trailing columns here
"""


def test_cisco_mac_table_detects_columns():
    t = table.parse(CISCO_MAC_TABLE)
    assert t.mac_column == 1
    assert t.port_column == 3
    assert len(t.rows) == 4, "banner, rules, and the Total footer are not data"
    assert t.header == ["Vlan", "Mac", "Address", "Type", "Ports"]


def test_cisco_arp_detects_ip_and_mac():
    t = table.parse(CISCO_ARP)
    assert t.ip_column == 1
    assert t.mac_column == 3
    assert len(t.rows) == 4


def test_linux_arp_with_single_nibble_octet():
    t = table.parse(LINUX_ARP)
    assert t.mac_column == 2
    assert t.ip_column == 0


def test_ragged_rows_never_raise():
    t = table.parse(RAGGED)
    # A lone "3" stays a row: dropping data is riskier than keeping a thin row,
    # and every accessor is bounds-safe anyway.
    assert [len(r) for r in t.rows] == [3, 2, 1, 7]
    # Bounds-safe access is the whole point: the original raised IndexError.
    assert t.cell(t.rows[1], 2) == ""
    assert t.cell(t.rows[1], 99) == ""
    assert t.cell(t.rows[0], None) == ""


def test_find_incomplete_scans_every_cell():
    t = table.parse(CISCO_ARP)
    incomplete = table.find_incomplete(t)
    assert len(incomplete) == 2
    assert all("INCOMPLETE" in row for row in incomplete)


def test_incomplete_marker_is_not_a_mac():
    t = table.parse(CISCO_ARP)
    macs = [t.cell(r, t.mac_column) for r in t.rows]
    assert "INCOMPLETE" in macs
    assert sum(1 for m in macs if m == "INCOMPLETE") == 2


def test_empty_and_whitespace_input():
    for text in ("", "   ", "\n\n\n", "-----\n====="):
        t = table.parse(text)
        assert t.rows == []
        assert t.columns == []


@pytest.mark.parametrize("cell,expected", [
    ("0000.0c07.ac01", True),
    ("00:1a:2b:3c:4d:5e", True),
    ("INCOMPLETE", False),
    ("Gi1/0/1", False),
    ("10.1.1.1", False),
    ("DYNAMIC", False),
])
def test_mac_cell_detection(cell, expected):
    assert table._is_mac_cell(cell) is expected


@pytest.mark.parametrize("cell,expected", [
    ("Gi1/0/1", True),
    ("Te1/1/1", True),
    ("Po12", True),
    ("Vlan100", True),
    ("xe-0/0/1", True),
    ("CPU", True),
    ("10.1.1.1", False),
    ("0000.0c07.ac01", False),
])
def test_interface_cell_detection(cell, expected):
    assert table._is_iface_cell(cell) is expected
