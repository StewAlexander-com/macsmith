/**
 * macsmith browser UI.
 *
 * The poka-yoke rules this file implements:
 *  - Results update live, so there is no "run" button to forget to press.
 *  - What was detected is always shown before the result is used, so a wrong
 *    column is visible rather than silently baked into an export.
 *  - Nothing is ever downloaded automatically; export is an explicit click.
 *  - The vendor database loads on demand and reports its own age, so a stale
 *    "no entry" answer announces itself instead of looking authoritative.
 */
import * as mac from './mac.js';
import * as tbl from './table.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
};

// --- vendor database (lazy) -------------------------------------------------

const DB = { data: null, status: 'idle', error: '' };
const PREFIX_LEN = { 'MA-S': 9, 'MA-M': 7, 'MA-L': 6 };
const ORDER = ['MA-S', 'MA-M', 'MA-L'];
const STALE_AFTER_DAYS = 120;

async function loadDb() {
  if (DB.status === 'ready' || DB.status === 'loading') return DB;
  DB.status = 'loading';
  setDataStatus('Vendor database: loading…');
  try {
    const res = await fetch('data/registry.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DB.data = await res.json();
    DB.status = 'ready';
    const total = ORDER.reduce(
      (n, r) => n + Object.keys(DB.data.registries[r] || {}).length, 0);
    const age = ageDays(DB.data.generated);
    const stale = age !== null && age > STALE_AFTER_DAYS;
    setDataStatus(
      `Vendor database: ${total.toLocaleString()} IEEE assignments, built ${DB.data.generated}` +
      (stale ? ` — ${age} days old, may be missing recent assignments.` : '.')
    );
  } catch (err) {
    DB.status = 'error';
    DB.error = String(err.message || err);
    setDataStatus(
      'Vendor database: could not load (' + DB.error + '). ' +
      'Run `python scripts/build_web_data.py` to generate web/data/registry.json.'
    );
  }
  return DB;
}

function ageDays(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

function setDataStatus(text) {
  const node = $('data-status');
  if (node) node.textContent = text;
}

const CLASS_LABELS = {
  broadcast: ['Broadcast', 'Sent to every device on the LAN. No vendor.'],
  'all-zero': ['All-zero', 'Usually a placeholder or uninitialized address.'],
  laa: ['Private / local', 'Locally administered — randomized privacy address, VM, container, or set by an admin.'],
  'multicast-laa': ['Private multicast', 'Locally administered and multicast. No IEEE assignment.'],
  multicast: ['Multicast', 'A group destination, not a device. No IEEE assignment.'],
};

function lookupVendor(value) {
  const result = { org: '', note: '', cleaned: null, classification: '' };
  const candidates = mac.extractMacCandidates(value);
  const bare = mac.normalizeMac(value);
  const tryList = [];
  if (/^[0-9A-F]{6,12}$/.test(bare)) tryList.push([bare, false]);
  tryList.push(...candidates);

  for (const [hex, usedOcr] of tryList) {
    if (result.cleaned === null) {
      result.cleaned = hex;
      result.classification = mac.classifyMac(hex);
    }
    if (DB.status !== 'ready') continue;
    for (const reg of ORDER) {
      const table = DB.data.registries[reg];
      const len = PREFIX_LEN[reg];
      if (!table || hex.length < len) continue;
      const org = table[hex.slice(0, len)];
      if (org) {
        return {
          org, registry: reg, cleaned: hex,
          classification: mac.classifyMac(hex),
          note: usedOcr ? 'typo corrected' : '',
        };
      }
    }
  }
  if (result.classification && CLASS_LABELS[result.classification]) {
    result.org = CLASS_LABELS[result.classification][0];
    result.note = CLASS_LABELS[result.classification][1];
  } else if (result.cleaned) {
    result.note = DB.status === 'ready'
      ? 'No registry entry — prefix may be unassigned.'
      : 'Vendor database unavailable.';
  }
  return result;
}

// --- tools ------------------------------------------------------------------

const SAMPLE_TABLE = `          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
   1    0000.0c07.ac01    DYNAMIC     Gi1/0/1
   1    001a.2b3c.4d5e    DYNAMIC     Gi1/0/2
  10    0242.ac11.0002    DYNAMIC     Gi1/0/3
  10    3c22.fb1a.9f01    DYNAMIC     Gi1/0/4`;

const SAMPLE_ARP = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.1.1.1               12   0000.0c07.ac01  ARPA   Vlan1
Internet  10.1.1.2                -   INCOMPLETE      ARPA   Vlan1
Internet  10.1.1.3               44   001a.2b3c.4d5e  ARPA   Vlan1
Internet  10.1.1.4                -   INCOMPLETE      ARPA   Vlan1`;

const SAMPLE_MACS = `00:1A:2B:3C:4D:5E
0000.0c07.ac01
3C-22-FB-1A-9F-01
Physical Address. . . : 02-42-AC-11-00-02`;

const TOOLS = {
  fmt: {
    label: 'Format',
    desc: 'Convert MAC addresses between Cisco dotted, colon, hyphen, and bare formats. Paste one per line, or paste any text and every address in it is found.',
    inputLabel: 'Paste MAC addresses, or any text containing them',
    sample: SAMPLE_MACS,
    needsDb: false,
    options: [{ type: 'select', id: 'style', label: 'Convert to', value: 'colon',
      choices: [['colon', 'colon  00:1A:2B:3C:4D:5E'], ['hyphen', 'hyphen  00-1A-2B-3C-4D-5E'],
                ['cisco', 'cisco  001a.2b3c.4d5e'], ['bare', 'bare  001A2B3C4D5E']] }],
    run: (text, opts) => {
      const found = mac.extractMacCandidates(text).filter(([h]) => h.length === 12);
      if (!found.length) return { detect: { level: 'warn', text: 'No complete MAC address found in the input yet.' }, header: [], rows: [] };
      const rows = found.map(([hex]) => {
        const r = mac.convert(hex, opts.style);
        return [
          { v: r.formatted, k: 'mac' },
          { v: r.hexOnly },
          { v: r.classification ? (CLASS_LABELS[r.classification]?.[0] || r.classification) : '', k: 'note' },
        ];
      });
      return {
        detect: { level: 'ok', text: `Found <b>${found.length}</b> address(es). Converting to <b>${opts.style}</b>.` },
        header: ['formatted', 'bare hex', 'note'], rows,
      };
    },
  },

  vendor: {
    label: 'Vendor lookup',
    desc: 'Identify the IEEE registrant for an address or OUI prefix. Searches MA-L, MA-M, and MA-S, longest prefix first.',
    inputLabel: 'Paste MAC addresses or OUI prefixes',
    sample: SAMPLE_MACS,
    needsDb: true,
    options: [],
    run: (text) => {
      const found = mac.extractMacCandidates(text);
      if (!found.length) return { detect: { level: 'warn', text: 'No MAC-shaped value found yet. Six hex characters is enough for a vendor lookup.' }, header: [], rows: [] };
      const rows = found.map(([hex]) => {
        const r = lookupVendor(hex);
        return [
          { v: hex.length === 12 ? mac.formatMac(hex, 'colon') : hex, k: 'mac' },
          { v: r.registry || '' },
          { v: r.org || '—', k: 'vendor' },
          { v: r.note || '', k: 'note' },
        ];
      });
      return {
        detect: { level: DB.status === 'ready' ? 'ok' : 'warn',
          text: DB.status === 'ready'
            ? `Looked up <b>${found.length}</b> value(s) against the local IEEE registries.`
            : 'Vendor database not loaded — classification still works, names do not.' },
        header: ['address', 'registry', 'organization', 'note'], rows,
      };
    },
  },

  table: {
    label: 'MAC table',
    desc: 'Turn switch MAC address-table output into address / port / vendor columns. The MAC and port columns are detected for you — check the summary before exporting.',
    inputLabel: 'Paste "show mac address-table" output',
    sample: SAMPLE_TABLE,
    needsDb: true,
    options: [
      { type: 'check', id: 'vendors', label: 'Add vendor column', value: true },
      { type: 'select', id: 'macCol', label: 'MAC column', value: 'auto', choices: [['auto', 'auto-detect']] },
      { type: 'select', id: 'portCol', label: 'Port column', value: 'auto', choices: [['auto', 'auto-detect']] },
    ],
    run: (text, opts) => {
      const t = tbl.parse(text);
      if (!t.rows.length) return { detect: { level: 'warn', text: 'No data rows found yet.' }, header: [], rows: [] };
      const macCol = opts.macCol === 'auto' ? t.macColumn : Number(opts.macCol);
      const portCol = opts.portCol === 'auto' ? t.portColumn : Number(opts.portCol);
      if (macCol === null || macCol === undefined) {
        return { detect: { level: 'bad', text: `No MAC column detected. ${describeColumns(t)} Choose one above.` },
                 header: [], rows: [], table: t };
      }
      const header = opts.vendors ? ['mac', 'port', 'vendor'] : ['mac', 'port'];
      const rows = [];
      for (const row of t.rows) {
        const m = t.cell(row, macCol);
        if (!m) continue;
        const cells = [{ v: m, k: 'mac' }, { v: t.cell(row, portCol) }];
        if (opts.vendors) {
          const r = lookupVendor(m);
          cells.push({ v: r.org || '—', k: 'vendor' });
        }
        rows.push(cells);
      }
      return { detect: { level: 'ok', text: detectSummary(t, macCol, portCol) }, header, rows, table: t };
    },
  },

  incomplete: {
    label: 'Incomplete ARP',
    desc: 'List ARP entries that never resolved to a hardware address — the ones showing INCOMPLETE.',
    inputLabel: 'Paste "show ip arp" output',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [],
    run: (text) => {
      const t = tbl.parse(text);
      if (!t.rows.length) return { detect: { level: 'warn', text: 'No data rows found yet.' }, header: [], rows: [] };
      const hits = tbl.findIncomplete(t);
      if (!hits.length) {
        return { detect: { level: 'ok', text: `Scanned <b>${t.rows.length}</b> row(s). <b>No incomplete entries.</b>` }, header: [], rows: [] };
      }
      return {
        detect: { level: 'warn', text: `<b>${hits.length}</b> incomplete entr${hits.length === 1 ? 'y' : 'ies'} out of <b>${t.rows.length}</b> row(s).` },
        header: t.safeHeader || [], rows: hits.map((r) => r.map((c) => ({ v: c, k: c === 'INCOMPLETE' ? 'bad' : '' }))),
      };
    },
  },

  find: {
    label: 'Find a MAC',
    desc: 'Find an address in a table no matter which format each side uses — paste colon format, match Cisco dotted, or the other way round.',
    inputLabel: 'Paste the table to search',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [{ type: 'text', id: 'needle', label: 'Address to find', value: '00:1a:2b:3c:4d:5e',
                placeholder: 'any format' }],
    run: (text, opts) => {
      let needle = mac.normalizeMac(opts.needle || '');
      if (needle.length !== 12) {
        const ex = mac.extractMacCandidate(opts.needle || '');
        if (ex && ex.length === 12) needle = ex;
        else return { detect: { level: 'warn', text: 'Enter a complete MAC address to search for.' }, header: [], rows: [] };
      }
      const t = tbl.parse(text);
      const hits = t.rows.filter((row) => row.some((c) => mac.normalizeMac(c) === needle));
      const shown = `${mac.formatMac(needle, 'colon')} · ${mac.formatMac(needle, 'cisco')}`;
      if (!hits.length) {
        return { detect: { level: 'warn', text: `<b>${shown}</b> not found in ${t.rows.length} row(s). Every format was checked.` }, header: [], rows: [] };
      }
      return {
        detect: { level: 'ok', text: `<b>${hits.length}</b> match(es) for <b>${shown}</b>.` },
        header: t.safeHeader || [],
        rows: hits.map((r) => r.map((c) => ({ v: c, k: mac.normalizeMac(c) === needle ? 'mac' : '' }))),
      };
    },
  },

  grep: {
    label: 'Search',
    desc: 'Keep only the lines that match a pattern — a VLAN, a port, a partial address, anything.',
    inputLabel: 'Paste the text to search',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [
      { type: 'text', id: 'pattern', label: 'Contains', value: 'INCOMPLETE', placeholder: 'text or regex' },
      { type: 'check', id: 'regex', label: 'Regular expression', value: false },
      { type: 'check', id: 'cs', label: 'Case sensitive', value: false },
    ],
    run: (text, opts) => {
      const pattern = opts.pattern || '';
      if (!pattern) return { detect: { level: 'warn', text: 'Enter something to search for.' }, header: [], rows: [] };
      let test;
      if (opts.regex) {
        try {
          const re = new RegExp(pattern, opts.cs ? '' : 'i');
          test = (line) => re.test(line);
        } catch (err) {
          return { detect: { level: 'bad', text: `Invalid regular expression: ${err.message}` }, header: [], rows: [] };
        }
      } else {
        const needle = opts.cs ? pattern : pattern.toLowerCase();
        test = (line) => (opts.cs ? line : line.toLowerCase()).includes(needle);
      }
      const lines = text.split('\n').filter((l) => l.trim() && test(l));
      if (!lines.length) return { detect: { level: 'warn', text: `No lines matched <b>${escapeHtml(pattern)}</b>.` }, header: [], rows: [] };
      return {
        detect: { level: 'ok', text: `<b>${lines.length}</b> matching line(s).` },
        header: [], rows: lines.map((l) => l.trim().split(/\s+/).map((c) => ({ v: c }))),
      };
    },
  },

  csv: {
    label: 'To CSV',
    desc: 'Turn whitespace-aligned output into CSV for a spreadsheet. Ragged rows are kept rather than dropped.',
    inputLabel: 'Paste any columned output',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [],
    run: (text) => {
      const t = tbl.parse(text);
      if (!t.rows.length) return { detect: { level: 'warn', text: 'No data rows found yet.' }, header: [], rows: [] };
      const note = t.header && !t.headerAligned
        ? ' The header line does not line up with the data, so it is left out rather than mislabelling columns.'
        : '';
      return {
        detect: { level: 'ok', text: `<b>${t.rows.length}</b> row(s), ${t.skipped} header/rule line(s) skipped.${note}` },
        header: t.safeHeader || [], rows: t.rows.map((r) => r.map((c) => ({ v: c }))),
      };
    },
  },
};

function describeColumns(t) {
  const parts = t.columns.map((c) =>
    `${c.index + 1}:${c.kind}${c.kind === 'other' ? '' : ` ${Math.round(c.confidence * 100)}%`}`);
  return `Columns detected: ${parts.join(', ') || 'none'}.`;
}

function detectSummary(t, macCol, portCol) {
  const bits = [`<b>${t.rows.length}</b> data row(s), ${t.skipped} header/rule line(s) skipped.`];
  bits.push(describeColumns(t));
  bits.push(`Using column <b>${macCol + 1}</b> for the MAC` +
    (portCol === null || portCol === undefined ? ', no port column found' : `, column <b>${portCol + 1}</b> for the port`) + '.');
  if (t.header && !t.headerAligned) {
    bits.push('The header line does not line up with the data, so it is ignored.');
  }
  return bits.join(' ');
}

// --- state and rendering ----------------------------------------------------

let current = 'fmt';
let lastResult = { header: [], rows: [] };
const optState = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildOptions(tool) {
  const host = $('opts');
  host.replaceChildren();
  optState[current] = optState[current] || {};
  for (const opt of tool.options) {
    if (!(opt.id in optState[current])) optState[current][opt.id] = opt.value;
    const wrap = el('label', { className: 'opt' });
    if (opt.type === 'check') {
      const box = el('input', { type: 'checkbox', checked: !!optState[current][opt.id] });
      box.addEventListener('change', () => { optState[current][opt.id] = box.checked; run(); });
      wrap.append(box, document.createTextNode(opt.label));
    } else if (opt.type === 'select') {
      wrap.append(document.createTextNode(opt.label));
      const sel = el('select');
      sel.dataset.optId = opt.id;
      for (const [v, text] of opt.choices) sel.append(el('option', { value: v, textContent: text }));
      sel.value = String(optState[current][opt.id]);
      sel.addEventListener('change', () => { optState[current][opt.id] = sel.value; run(); });
      wrap.append(sel);
    } else {
      wrap.append(document.createTextNode(opt.label));
      const input = el('input', { type: 'text', value: optState[current][opt.id] ?? '',
                                  placeholder: opt.placeholder || '', size: 20 });
      input.addEventListener('input', () => { optState[current][opt.id] = input.value; run(); });
      wrap.append(input);
    }
    host.append(wrap);
  }
}

/** Refill the column dropdowns from what was actually detected. */
function syncColumnChoices(t) {
  for (const id of ['macCol', 'portCol']) {
    const sel = $('opts').querySelector(`select[data-opt-id="${id}"]`);
    if (!sel || !t) continue;
    const keep = sel.value;
    sel.replaceChildren(el('option', { value: 'auto', textContent: 'auto-detect' }));
    for (const c of t.columns) {
      const sample = c.sample ? ` — ${c.sample.slice(0, 18)}` : '';
      sel.append(el('option', { value: String(c.index),
        textContent: `column ${c.index + 1}${sample}` }));
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'auto';
  }
}

function renderTable(header, rows) {
  const out = $('out');
  out.replaceChildren();
  if (!rows.length) {
    out.append(el('p', { className: 'empty', textContent: 'Nothing to show yet.' }));
    return;
  }
  const table = el('table');
  if (header.length) {
    const tr = el('tr');
    for (const h of header) tr.append(el('th', { textContent: h }));
    table.append(el('thead', {}, [tr]));
  }
  const tbody = el('tbody');
  const limit = 500;
  for (const row of rows.slice(0, limit)) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td', { textContent: cell.v });
      if (cell.k) td.className = `k-${cell.k}`;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  out.append(table);
  if (rows.length > limit) {
    out.append(el('p', { className: 'empty',
      textContent: `Showing the first ${limit} of ${rows.length} rows. Export to see them all.` }));
  }
}

function toDelimited(header, rows, sep) {
  const esc = (v) => {
    const s = String(v ?? '');
    return sep === ',' && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  if (header.length) lines.push(header.map(esc).join(sep));
  for (const row of rows) lines.push(row.map((c) => esc(c.v)).join(sep));
  return lines.join('\n') + '\n';
}

function run() {
  const tool = TOOLS[current];
  const text = $('input').value;
  const opts = optState[current] || {};
  let result;
  try {
    result = tool.run(text, opts);
  } catch (err) {
    result = { detect: { level: 'bad', text: `Something went wrong: ${escapeHtml(err.message)}` }, header: [], rows: [] };
  }

  const detect = $('detect');
  if (!text.trim()) {
    detect.hidden = true;
  } else if (result.detect) {
    detect.hidden = false;
    detect.className = 'detect' + (result.detect.level === 'warn' ? ' warn'
      : result.detect.level === 'bad' ? ' bad' : '');
    detect.innerHTML = result.detect.text;
  }

  if (result.table) syncColumnChoices(result.table);

  lastResult = { header: result.header || [], rows: result.rows || [] };
  renderTable(lastResult.header, lastResult.rows);

  const has = lastResult.rows.length > 0;
  for (const id of ['btn-copy', 'btn-copy-tsv', 'btn-download']) $(id).disabled = !has;
  $('count').textContent = has
    ? `${lastResult.rows.length} row${lastResult.rows.length === 1 ? '' : 's'}`
    : '';

  if (tool.needsDb && DB.status === 'idle' && text.trim()) {
    loadDb().then(run);
  }
}

function selectTool(name) {
  current = name;
  const tool = TOOLS[name];
  for (const btn of document.querySelectorAll('.tool-btn')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tool === name));
  }
  $('tool-desc').textContent = tool.desc;
  $('input-label').textContent = tool.inputLabel;
  buildOptions(tool);
  if (tool.needsDb && DB.status === 'idle') loadDb().then(run);
  run();
}

// --- wiring -----------------------------------------------------------------

for (const btn of document.querySelectorAll('.tool-btn')) {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
}
/**
 * Recompute on every keystroke while that is cheap, and coalesce once it is
 * not. A large paste costs real work, and running it per keystroke is what
 * makes a tab feel broken; a small input recomputing instantly is what makes
 * the live preview worth having.
 */
const DEBOUNCE_ABOVE_BYTES = 50_000;
let debounceTimer = null;
$('input').addEventListener('input', () => {
  clearTimeout(debounceTimer);
  if ($('input').value.length < DEBOUNCE_ABOVE_BYTES) {
    run();
    return;
  }
  debounceTimer = setTimeout(run, 120);
});
$('btn-sample').addEventListener('click', () => {
  $('input').value = TOOLS[current].sample;
  run();
});
$('btn-clear').addEventListener('click', () => {
  $('input').value = '';
  run();
  $('input').focus();
});

async function copy(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1400);
  } catch {
    btn.textContent = 'Copy blocked — select the table instead';
    setTimeout(() => { btn.textContent = label; }, 2600);
  }
}

$('btn-copy').addEventListener('click', (e) =>
  copy(toDelimited(lastResult.header, lastResult.rows, ','), e.target, 'Copy CSV'));
$('btn-copy-tsv').addEventListener('click', (e) =>
  copy(toDelimited(lastResult.header, lastResult.rows, '\t'), e.target, 'Copy TSV (for Excel)'));
$('btn-download').addEventListener('click', () => {
  const blob = new Blob([toDelimited(lastResult.header, lastResult.rows, ',')],
    { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `macsmith-${current}-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

selectTool('fmt');
