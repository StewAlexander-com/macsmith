/**
 * Input corpus for the browser tests.
 *
 * Real captures where possible, plus the malformed shapes that broke the
 * original scripts. Anything with a comment explaining "the original did X"
 * is a regression guard, not a hypothetical.
 */

export const CISCO_MAC_TABLE = `          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
   1    0000.0c07.ac01    DYNAMIC     Gi1/0/1
   1    001a.2b3c.4d5e    DYNAMIC     Gi1/0/2
  10    0242.ac11.0002    DYNAMIC     Gi1/0/3
  10    3c22.fb1a.9f01    DYNAMIC     Gi1/0/4
Total Mac Addresses for this criterion: 5`;

export const CISCO_ARP = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.1.1.1               12   0000.0c07.ac01  ARPA   Vlan1
Internet  10.1.1.2                -   INCOMPLETE      ARPA   Vlan1
Internet  10.1.1.3               44   001a.2b3c.4d5e  ARPA   Vlan1
Internet  10.1.1.4                -   INCOMPLETE      ARPA   Vlan1`;

export const LINUX_ARP = `Address                  HWtype  HWaddress           Flags Mask            Iface
10.0.0.1                 ether   fe:35:b6:60:0f:ee   C                     eth0
10.0.0.2                 ether   00:1a:2b:3c:4d:5e   C                     eth0`;

/**
 * Windows line endings. Anyone pasting out of PuTTY, SecureCRT, or Notepad
 * brings CRLF with them, and a parser that leaves a stray \r on the last cell
 * of every row corrupts the final column silently.
 */
export const CRLF_ARP = CISCO_ARP.replace(/\n/g, '\r\n');

/** Tab-separated, as pasted out of a spreadsheet. */
export const TSV_TABLE = `Vlan\tMac Address\tType\tPorts
1\t0000.0c07.ac01\tDYNAMIC\tGi1/0/1
1\t001a.2b3c.4d5e\tDYNAMIC\tGi1/0/2`;

/** Banners, blank lines, a lone token, and a too-wide row in one file. */
export const RAGGED = `1 0000.0c07.ac01 Gi1/0/1
2 001a.2b3c.4d5e
3
   
4 0242.ac11.0002 Gi1/0/4 extra trailing columns here`;

/** Every ARP entry unresolved — the "nothing to show but not an error" case. */
export const ALL_INCOMPLETE = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.1.1.2                -   INCOMPLETE      ARPA   Vlan1
Internet  10.1.1.4                -   INCOMPLETE      ARPA   Vlan1`;

/** Two MAC-shaped columns: column choice is genuinely ambiguous. */
export const TWO_MAC_COLUMNS = `Port      Learned           Configured        State
Gi1/0/1   0000.0c07.ac01    001a.2b3c.4d5e    up
Gi1/0/2   3c22.fb1a.9f01    0242.ac11.0002    up`;

/**
 * Values that must never be read as MAC addresses. A tool that reports a
 * confident vendor for a phone number has taught the user to distrust it.
 */
export const NOT_MACS = `1-800-555-1234
+44-20-7946-0958
(415) 555-1212
no address here
the bad cafe added a fee
192.168.1.1
2026-08-19
$1,234.56`;

/** Mixed formats in one paste, which is what a real ticket looks like. */
export const MIXED_FORMATS = `00:1A:2B:3C:4D:5E
0000.0c07.ac01
3C-22-FB-1A-9F-01
Physical Address. . . : 02-42-AC-11-00-02
fe:35:b6:60:f:ee`;

/** Non-ASCII around real data — comments, names, and emoji from tickets. */
export const UNICODE_NOISE = `# Núcleo — planta baja ✅
Vlan    Mac Address       Type        Ports
   1    0000.0c07.ac01    DYNAMIC     Gi1/0/1
   2    001a.2b3c.4d5e    DYNAMIC     Gi1/0/2  ← 交换机`;

/** A vendor name long enough to test wrapping rather than truncation. */
export const LONG_VENDOR_MAC = '00:00:0c:07:ac:01';

/** Build a large table to exercise rendering limits and responsiveness. */
export function bigTable(rows = 5000) {
  const lines = ['Vlan    Mac Address       Type        Ports'];
  for (let i = 0; i < rows; i += 1) {
    const hex = (i + 0x100000).toString(16).padStart(6, '0');
    lines.push(`   1    0000.${hex.slice(0, 4)}.${hex.slice(4)}${'0'.repeat(2)}    DYNAMIC     Gi1/0/${(i % 48) + 1}`);
  }
  return lines.join('\n');
}

/** Text with no MAC-shaped content at all. */
export const PROSE = `The switch in closet 3 was replaced on Tuesday.
Nothing else of note. Ticket closed.`;
