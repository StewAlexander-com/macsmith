# macsmith

Offline MAC address and ARP/MAC-table tools for network engineers, in a browser
tab or a terminal.

**[Open the web version →](https://stewalexander-com.github.io/macsmith/)** —
no install, nothing uploaded.

Paste `show mac address-table` or `show ip arp` output and get back clean
columns, vendor names, and CSV. Convert between Cisco dotted, colon, and hyphen
formats. Find an address regardless of which format either side happens to use.

---

## Why a browser version

Every one of these operations is a pure function from pasted text to text.
Nothing needs the network, a login, or a server. That makes a static page the
better default for most people:

- **No install.** Plenty of corporate laptops won't run `pip install`. They all
  run a browser.
- **Nothing is uploaded.** There is no backend to send your ARP table to. The
  only file the page fetches is its own vendor database, which you can confirm
  in DevTools → Network, or by loading the page once and going offline.
- **Mistakes are visible.** You see the parsed columns before you export them,
  and nothing is written to disk until you click.

The command line is there for the cases the browser can't serve: pipelines,
jump boxes with no GUI, and scripting.

## Install the CLI

```bash
pip install git+https://github.com/StewAlexander-com/macsmith.git
```

The core has no third-party dependencies, and CI proves it on every push. PyYAML
is optional and only affects nested `salt` input.

## Use it

Every command reads a file or stdin and writes stdout, so they compose.

```bash
# What is this address, and who made it?
macsmith vendor 3c:22:fb:1a:9f:01
macsmith fmt 00:1A:2B:3C:4D:5E --to cisco     # 001a.2b3c.4d5e

# Turn a switch table into annotated CSV
ssh switch 'show mac address-table' | macsmith table --vendors -o inventory.csv

# Which ARP entries never resolved?
macsmith incomplete arp.txt

# Find an address whatever format it is stored in
macsmith find arp.txt --mac 001a.2b3c.4d5e

# Keep only the lines you care about
macsmith grep Gi1/0/24 mactable.txt

# What data am I actually running against?
macsmith info
```

`macsmith --help` lists everything; `macsmith <command> --help` explains one.

### Output rules

Output goes to **stdout** unless you name a file with `-o`. Nothing is written
by surprise, and everything pipes.

Naming a file that already exists is **refused**, not overwritten:

```
$ macsmith csv arp.txt -o report.csv
/home/you/report.csv already exists.
Refusing to overwrite it. Either choose another name, or pass --force to
replace it on purpose.
```

`--dry-run` reports the destination and size without writing anything.

Exit codes distinguish outcomes so scripts can tell them apart: `0` success,
`1` error, `2` bad usage, and `3` for a clean run that matched nothing.

## Where the vendor data comes from

The IEEE MA-L, MA-M, and MA-S registries ship with the package — about 53,000
assignments. Lookups never touch the network, and longest prefix wins, so an
MA-S 36-bit assignment beats the MA-L block it sits inside.

A miss is explained rather than left as a dead end:

```
$ macsmith vendor 02:42:ac:11:00:02 --explain
Locally administered (U/L bit set) — not assigned by IEEE. Likely a
randomized privacy address, a VM, a container, or set by an admin.
```

`macsmith info` reports the data's age, and anything older than 120 days warns
on use. A weekly workflow opens a pull request with fresh registries; you can
also run `python scripts/refresh_registries.py` yourself. That script is the
only code here that makes a network request, and it validates the download
before replacing anything.

## Two implementations, one source of truth

The browser and the CLI are separate implementations, which is exactly the kind
of arrangement that drifts apart quietly. So neither one is the authority:
[`tests/vectors/mac_vectors.json`](tests/vectors/mac_vectors.json) is.

```bash
pytest -q                      # Python core against the vectors
node web/js/conformance.mjs    # browser core against the same vectors
```

Both run in CI, and the site is only published when both pass. A bug fix starts
by adding a case to the vectors.

That file has already earned its place — it caught a false positive where hex
fragments of ordinary words glued together across word boundaries, so the prose
"no address here" parsed as the OUI prefix `ADDEEE`.

## Development

```bash
git clone https://github.com/StewAlexander-com/macsmith.git
cd macsmith
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

pytest -q
node web/js/conformance.mjs

python scripts/build_web_data.py     # generate web/data/registry.json
cd web && python -m http.server 8000  # preview the site
```

`web/data/registry.json` is generated from the packaged CSVs and is not
committed, so the vendor data has exactly one source of truth.

## Replaces

These eight scripts, each of which did one thing and could not be piped into
anything else:

| Original | Now |
|---|---|
| `Mac-Converter.py` | `macsmith fmt` |
| `maclookup.py` | `macsmith vendor` |
| `MACTable-Tool.py` | `macsmith table --vendors` |
| `Find-Incomplete-MAC-Addresses.py` | `macsmith incomplete` |
| `IP-ARP-MAC-Lookup.py` | `macsmith find` |
| `Color-NetSearch.py` | `macsmith grep` |
| `MAC2CSV.py` | `macsmith csv` |
| `saltstack-mac2csv.py` | `macsmith salt` |

Behavior differences worth knowing if you are migrating:

- Vendor lookups are offline. `MACTable-Tool.py` called `macvendors.co` once per
  address, which made a large table slow and made the tool useless without
  internet.
- Nothing is written unless you ask. The originals wrote hardcoded filenames
  into the working directory, and several deleted the previous output first.
- Columns are detected instead of typed in, which removed both the prompt and
  the `IndexError` that came with it on short or blank lines.
- A header whose width doesn't match the data is dropped, because a shifted
  header mislabels columns rather than just looking untidy.

## License

MIT.
