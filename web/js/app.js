/**
 * macsmith browser UI.
 *
 * The poka-yoke rules this file implements:
 *  - Results update live, so there is no "run" button to forget to press.
 *  - What was detected is always shown before the result is used, as discrete
 *    values rather than a sentence, so a wrong column is seen rather than read
 *    past. This is the element that stops a bad export, so it gets the largest
 *    type in the working area.
 *  - Nothing is ever downloaded automatically; export is an explicit click.
 *  - The vendor database loads on demand, reports its own age, and asks first
 *    on a metered connection rather than silently spending 1.8MB of someone's
 *    data allowance.
 */
import * as mac from './mac.js';
import * as tbl from './table.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
};

const NARROW_QUERY = '(max-width: 640px)';
const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

// --- vendor database (lazy, and polite about it) ----------------------------

const DB = { data: null, status: 'idle', error: '' };
const PREFIX_LEN = { 'MA-S': 9, 'MA-M': 7, 'MA-L': 6 };
const ORDER = ['MA-S', 'MA-M', 'MA-L'];
const STALE_AFTER_DAYS = 120;
const DB_SIZE_LABEL = '1.8 MB';

/**
 * Whether downloading the database uninvited would be rude.
 *
 * An engineer tethered to a phone in a plant room is exactly the person this
 * tool is for, and 1.8MB spent without asking is a real cost to them.
 */
function connectionIsMetered() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return ['slow-2g', '2g', '3g'].includes(c.effectiveType);
}

let dbDeferred = false;

async function loadDb({ force = false } = {}) {
  if (DB.status === 'ready' || DB.status === 'loading') return DB;
  if (!force && connectionIsMetered()) {
    dbDeferred = true;
    showAlert({
      strong: 'Vendor names need a ' + DB_SIZE_LABEL + ' download.',
      text: 'You appear to be on a metered or slow connection, so it has not been fetched. Everything else works without it.',
      action: { label: 'Download anyway', onClick: () => { dbDeferred = false; loadDb({ force: true }).then(run); } },
    });
    return DB;
  }

  DB.status = 'loading';
  setDataStatus('Vendor database: loading…');
  try {
    const res = await fetch('data/registry.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DB.data = await res.json();
    if (!DB.data || !DB.data.registries) throw new Error('unexpected file shape');
    DB.status = 'ready';
    const total = ORDER.reduce(
      (n, r) => n + Object.keys(DB.data.registries[r] || {}).length, 0);
    const age = ageDays(DB.data.generated);
    const stale = age !== null && age > STALE_AFTER_DAYS;
    setDataStatus(
      `Vendor database: ${total.toLocaleString()} IEEE assignments, built ${DB.data.generated}` +
      (stale ? ` — ${age} days old, may be missing recent assignments.` : '.')
    );
    if (stale) {
      showAlert({
        strong: `Vendor data is ${age} days old.`,
        text: 'Recent IEEE assignments may be missing, so a "no entry" result is less trustworthy than usual.',
      });
    } else {
      hideAlert();
    }
  } catch (err) {
    DB.status = 'error';
    DB.error = String(err.message || err);
    setDataStatus(
      `Vendor database: could not load (${DB.error}). ` +
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

function showAlert({ strong, text, action }) {
  const box = $('alert');
  box.replaceChildren();
  box.append(el('span', {}, [el('strong', { textContent: strong }), document.createTextNode(' ' + text)]));
  if (action) {
    const btn = el('button', { className: 'btn small', type: 'button', textContent: action.label });
    btn.addEventListener('click', action.onClick);
    box.append(btn);
  }
  box.hidden = false;
}

function hideAlert() {
  $('alert').hidden = true;
}

const CLASS_LABELS = {
  broadcast: ['Broadcast', 'Sent to every device on the LAN. No vendor.'],
  'all-zero': ['All-zero', 'Usually a placeholder or uninitialized address.'],
  laa: ['Private / local', 'Locally administered — randomized privacy address, VM, container, or set by an admin.'],
  'multicast-laa': ['Private multicast', 'Locally administered and multicast. No IEEE assignment.'],
  multicast: ['Multicast', 'A group destination, not a device. No IEEE assignment.'],
};

function lookupVendor(value) {
  const result = { org: '', note: '', cleaned: null, classification: '', registry: '' };
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

// --- detection summary building ---------------------------------------------

const chip = (value, label, tone = '') => ({ value: String(value), label, tone });
const note = (text, kind = 'warn') => ({ text, kind });

/** Chips every table-shaped tool shares, so the summary reads consistently. */
function tableChips(t) {
  const out = [chip(t.rows.length, t.rows.length === 1 ? 'data row' : 'data rows')];
  if (t.skipped) out.push(chip(t.skipped, 'lines skipped'));
  return out;
}

function headerNote(t) {
  if (t.header && !t.headerAligned) {
    return note('The header line does not line up with the data, so it is ignored rather than mislabelling columns.');
  }
  return null;
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
    desc: 'Convert MAC addresses between Cisco dotted, colon, hyphen, and bare formats.',
    inputLabel: 'Paste MAC addresses, or any text containing them',
    sample: SAMPLE_MACS,
    needsDb: false,
    options: [{ type: 'select', id: 'style', label: 'Convert to', value: 'colon',
      choices: [['colon', 'colon  00:1A:2B:3C:4D:5E'], ['hyphen', 'hyphen  00-1A-2B-3C-4D-5E'],
                ['cisco', 'cisco  001a.2b3c.4d5e'], ['bare', 'bare  001A2B3C4D5E']] }],
    run: (text, opts) => {
      const found = mac.extractMacCandidates(text).filter(([h]) => h.length === 12);
      if (!found.length) {
        return { detect: { level: 'warn', chips: [], notes: [note('No complete MAC address found in the input yet.')] },
                 header: [], rows: [] };
      }
      const rows = found.map(([hex]) => {
        const r = mac.convert(hex, opts.style);
        return [
          { v: r.formatted, k: 'mac' },
          { v: r.hexOnly },
          { v: r.classification ? (CLASS_LABELS[r.classification]?.[0] || r.classification) : '', k: 'note' },
        ];
      });
      return {
        detect: { level: 'ok',
          chips: [chip(found.length, found.length === 1 ? 'address found' : 'addresses found', 'good'),
                  chip(opts.style, 'output format', 'key')],
          notes: [] },
        header: ['formatted', 'bare hex', 'note'], rows,
      };
    },
  },

  vendor: {
    desc: 'Identify the IEEE registrant for an address or OUI prefix, offline.',
    inputLabel: 'Paste MAC addresses or OUI prefixes',
    sample: SAMPLE_MACS,
    needsDb: true,
    options: [],
    run: (text) => {
      const found = mac.extractMacCandidates(text);
      if (!found.length) {
        return { detect: { level: 'warn', chips: [],
          notes: [note('No MAC-shaped value found yet. Six hex characters is enough for a vendor lookup.')] },
          header: [], rows: [] };
      }
      const rows = found.map(([hex]) => {
        const r = lookupVendor(hex);
        return [
          { v: hex.length === 12 ? mac.formatMac(hex, 'colon') : hex, k: 'mac' },
          { v: r.registry || '' },
          { v: r.org || '—', k: 'vendor' },
          { v: r.note || '', k: 'note' },
        ];
      });
      const ready = DB.status === 'ready';
      const matched = rows.filter((r) => r[1].v).length;
      return {
        detect: {
          level: ready ? 'ok' : 'warn',
          chips: [chip(found.length, 'looked up'), chip(matched, 'in the registry', matched ? 'good' : '')],
          notes: ready ? [] : [note(
            dbDeferred
              ? 'Vendor database not downloaded, so names are unavailable. Classification still works.'
              : 'Vendor database not loaded — classification still works, names do not.')],
        },
        header: ['address', 'registry', 'organization', 'note'], rows,
      };
    },
  },

  table: {
    desc: 'Turn switch table output into address, port, and vendor columns. Check the detected columns before exporting.',
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
      if (!t.rows.length) {
        return { detect: { level: 'warn', chips: [], notes: [note('No data rows found yet.')] },
                 header: [], rows: [] };
      }
      const macCol = opts.macCol === 'auto' ? t.macColumn : Number(opts.macCol);
      const portCol = opts.portCol === 'auto' ? t.portColumn : Number(opts.portCol);
      if (macCol === null || macCol === undefined) {
        return {
          detect: { level: 'bad', chips: tableChips(t),
            notes: [note('No MAC address column detected. Choose one above.'),
                    note(describeColumns(t), 'info')] },
          header: [], rows: [], table: t,
        };
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
      const chips = tableChips(t);
      chips.push(chip(macCol + 1, 'MAC column', 'key'));
      chips.push(portCol === null || portCol === undefined
        ? chip('none', 'port column')
        : chip(portCol + 1, 'port column', 'key'));
      const notes = [];
      const hn = headerNote(t);
      if (hn) notes.push(hn);
      return { detect: { level: 'ok', chips, notes }, header, rows, table: t };
    },
  },

  incomplete: {
    desc: 'List the ARP entries that never resolved to a hardware address.',
    inputLabel: 'Paste "show ip arp" output',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [],
    run: (text) => {
      const t = tbl.parse(text);
      if (!t.rows.length) {
        return { detect: { level: 'warn', chips: [], notes: [note('No data rows found yet.')] },
                 header: [], rows: [] };
      }
      const hits = tbl.findIncomplete(t);
      if (!hits.length) {
        return {
          detect: { level: 'ok', chips: [chip(0, 'incomplete', 'good'), ...tableChips(t)],
            notes: [note(`No incomplete entries. Scanned ${t.rows.length} rows.`, 'info')] },
          header: [], rows: [],
        };
      }
      return {
        detect: { level: 'warn',
          chips: [chip(hits.length, hits.length === 1 ? 'incomplete entry' : 'incomplete entries'),
                  ...tableChips(t)],
          notes: [] },
        header: t.safeHeader || [],
        rows: hits.map((r) => r.map((c) => ({ v: c, k: c === 'INCOMPLETE' ? 'bad' : '' }))),
      };
    },
  },

  find: {
    desc: 'Find an address in a table whatever format either side uses.',
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
        else {
          return { detect: { level: 'warn', chips: [],
            notes: [note('Enter a complete MAC address to search for.')] }, header: [], rows: [] };
        }
      }
      const t = tbl.parse(text);
      const hits = t.rows.filter((row) => row.some((c) => mac.normalizeMac(c) === needle));
      const colon = mac.formatMac(needle, 'colon');
      const cisco = mac.formatMac(needle, 'cisco');
      if (!hits.length) {
        return {
          detect: { level: 'warn', chips: [chip(0, 'matches'), ...tableChips(t)],
            notes: [note(`${colon} (${cisco}) not found. Searched ${t.rows.length} rows in every format.`)] },
          header: [], rows: [],
        };
      }
      return {
        detect: { level: 'ok',
          chips: [chip(hits.length, hits.length === 1 ? 'match' : 'matches', 'good'), ...tableChips(t)],
          notes: [note(`Matched ${colon} · ${cisco}`, 'info')] },
        header: t.safeHeader || [],
        rows: hits.map((r) => r.map((c) => ({ v: c, k: mac.normalizeMac(c) === needle ? 'mac' : '' }))),
      };
    },
  },

  grep: {
    desc: 'Keep only the lines matching a pattern: a VLAN, a port, part of an address.',
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
      if (!pattern) {
        return { detect: { level: 'warn', chips: [], notes: [note('Enter something to search for.')] },
                 header: [], rows: [] };
      }
      let test;
      if (opts.regex) {
        try {
          const re = new RegExp(pattern, opts.cs ? '' : 'i');
          test = (line) => re.test(line);
        } catch (err) {
          return { detect: { level: 'bad', chips: [],
            notes: [note(`Invalid regular expression: ${err.message}`)] }, header: [], rows: [] };
        }
      } else {
        const needle = opts.cs ? pattern : pattern.toLowerCase();
        test = (line) => (opts.cs ? line : line.toLowerCase()).includes(needle);
      }
      const all = text.split('\n').filter((l) => l.trim());
      const lines = all.filter(test);
      if (!lines.length) {
        return { detect: { level: 'warn', chips: [chip(0, 'matching lines'), chip(all.length, 'lines searched')],
          notes: [note(`No lines matched "${pattern}".`)] }, header: [], rows: [] };
      }
      return {
        detect: { level: 'ok',
          chips: [chip(lines.length, lines.length === 1 ? 'matching line' : 'matching lines', 'good'),
                  chip(all.length, 'lines searched')],
          notes: [] },
        header: [], rows: lines.map((l) => l.trim().split(/\s+/).map((c) => ({ v: c }))),
      };
    },
  },

  csv: {
    desc: 'Turn whitespace-aligned output into CSV for a spreadsheet.',
    inputLabel: 'Paste any columned output',
    sample: SAMPLE_ARP,
    needsDb: false,
    options: [],
    run: (text) => {
      const t = tbl.parse(text);
      if (!t.rows.length) {
        return { detect: { level: 'warn', chips: [], notes: [note('No data rows found yet.')] },
                 header: [], rows: [] };
      }
      const notes = [];
      const hn = headerNote(t);
      if (hn) notes.push(hn);
      return {
        detect: { level: 'ok', chips: tableChips(t), notes },
        header: t.safeHeader || [], rows: t.rows.map((r) => r.map((c) => ({ v: c }))),
      };
    },
  },
};

function describeColumns(t) {
  const parts = t.columns.map((c) =>
    `${c.index + 1}:${c.kind}${c.kind === 'other' ? '' : ` ${Math.round(c.confidence * 100)}%`}`);
  return `Columns detected — ${parts.join(', ') || 'none'}`;
}

// --- state and rendering ----------------------------------------------------

let current = 'fmt';
let lastResult = { header: [], rows: [] };
const optState = {};

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
                                  placeholder: opt.placeholder || '' });
      input.dataset.optId = opt.id;
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

function renderDetect(detect, hasInput) {
  const box = $('detect');
  if (!hasInput || !detect) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.className = 'detect' + (detect.level === 'warn' ? ' warn' : detect.level === 'bad' ? ' bad' : '');
  box.replaceChildren();

  if (detect.chips?.length) {
    const strip = el('div', { className: 'chips' });
    for (const c of detect.chips) {
      strip.append(el('span', { className: 'chip' + (c.tone ? ` ${c.tone}` : '') }, [
        el('b', { textContent: c.value }),
        document.createTextNode(' ' + c.label),
      ]));
    }
    box.append(strip);
  }
  if (detect.notes?.length) {
    const list = el('div', { className: 'notes' });
    for (const n of detect.notes) {
      list.append(el('div', { className: 'note' + (n.kind === 'info' ? ' info' : ''), textContent: n.text }));
    }
    box.append(list);
  }
}

function renderTable(header, rows) {
  const out = $('out');
  const hint = $('scroll-hint');
  out.replaceChildren();
  hint.hidden = true;
  if (!rows.length) {
    out.append(el('p', { className: 'empty', textContent: 'Nothing to show yet.' }));
    return;
  }

  // Cards need labels. Headerless results stay a scrolling table, because
  // inventing field names would be worse than sideways scrolling.
  const cardable = header.length > 0;
  const table = el('table', { className: cardable ? 'cards' : '' });

  if (cardable) {
    const tr = el('tr');
    for (const h of header) tr.append(el('th', { textContent: h }));
    table.append(el('thead', {}, [tr]));
  }
  const tbody = el('tbody');
  const limit = 500;
  for (const row of rows.slice(0, limit)) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const td = el('td', { textContent: cell.v });
      if (cell.k) td.className = `k-${cell.k}`;
      if (cardable) td.dataset.label = header[i] ?? '';
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  out.append(table);

  if (rows.length > limit) {
    out.append(el('p', { className: 'empty',
      textContent: `Showing the first ${limit} of ${rows.length.toLocaleString()} rows. Export to see them all.` }));
  }
  markScrollable(out, hint);
}

/**
 * Flag the results box when it actually scrolls sideways.
 *
 * Two things follow from overflow: a sighted user needs to be told a column
 * is off-screen, and a keyboard user needs to be able to reach the scroll at
 * all, which requires the container to be focusable. Both are driven by the
 * measured overflow rather than a guess from the viewport width, so a wide
 * table on a tablet is handled the same as a narrow one on a phone.
 */
function markScrollable(out, hint) {
  const overflows = out.scrollWidth > out.clientWidth + 1;
  hint.hidden = !overflows;
  if (overflows) {
    out.tabIndex = 0;
    out.setAttribute('role', 'region');
    out.setAttribute('aria-label', 'Results, scrolls sideways');
  } else {
    out.removeAttribute('tabindex');
    out.removeAttribute('role');
    out.removeAttribute('aria-label');
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
    result = { detect: { level: 'bad', chips: [], notes: [note(`Something went wrong: ${err.message}`)] },
               header: [], rows: [] };
  }

  renderDetect(result.detect, !!text.trim());
  if (result.table) syncColumnChoices(result.table);

  lastResult = { header: result.header || [], rows: result.rows || [] };
  renderTable(lastResult.header, lastResult.rows);

  const has = lastResult.rows.length > 0;
  for (const id of ['btn-copy', 'btn-copy-tsv', 'btn-download']) $(id).disabled = !has;
  $('count').textContent = has
    ? `${lastResult.rows.length.toLocaleString()} row${lastResult.rows.length === 1 ? '' : 's'}`
    : '';

  if (tool.needsDb && DB.status === 'idle' && !dbDeferred && text.trim()) {
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
  if (tool.needsDb && DB.status === 'idle' && !dbDeferred) loadDb().then(run);
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

// Re-render on rotation or resize so the card/table decision stays correct.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderTable(lastResult.header, lastResult.rows), 150);
});

async function copy(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1400);
  } catch {
    btn.textContent = 'Copy blocked — select the table instead';
    setTimeout(() => { btn.textContent = label; }, 2600);
  }
}

$('btn-copy').addEventListener('click', (e) =>
  copy(toDelimited(lastResult.header, lastResult.rows, ','), e.currentTarget, 'Copy CSV'));
$('btn-copy-tsv').addEventListener('click', (e) =>
  copy(toDelimited(lastResult.header, lastResult.rows, '\t'), e.currentTarget, 'Copy TSV'));
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

// A viewport this narrow cannot show a MAC address and a port side by side.
if (window.innerWidth < 320) {
  showAlert({
    strong: 'This screen is very narrow.',
    text: 'Results are stacked one field per line. Rotating to landscape, or using a wider window, will be easier to read.',
  });
}

selectTool('fmt');
