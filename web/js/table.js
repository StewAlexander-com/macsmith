/**
 * Whitespace-delimited table parsing for the browser.
 * Port of src/macsmith/table.py — see that file for the reasoning.
 */
import { extractMacCandidate, normalizeMac } from './mac.js';

const RULE_RE = /^[\s\-=_+|]*$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IFACE_RE = /^(?:[A-Za-z]{2,12}-?\d+(?:[/:]\d+)*(?:\.\d+)?|CPU|Switch|Router|Drop)$/;
const HEADER_WORD_RE = /^[A-Za-z][A-Za-z()/_.-]*$/;

export const INCOMPLETE_MARKERS = new Set(['INCOMPLETE', 'incomplete', 'Incomplete']);
const MISSING_VALUE = new Set([...INCOMPLETE_MARKERS, '-', '--', 'n/a', 'N/A', '*']);

export function isMacCell(cell) {
  if (INCOMPLETE_MARKERS.has(cell)) return false;
  return normalizeMac(cell).length === 12 && !!extractMacCandidate(cell);
}

export function isIpv4Cell(cell) {
  if (!IPV4_RE.test(cell)) return false;
  return cell.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
}

export function isIfaceCell(cell) {
  if (isIpv4Cell(cell) || isMacCell(cell)) return false;
  return IFACE_RE.test(cell);
}

function looksLikeHeader(cells) {
  if (!cells.length) return false;
  if (cells.some((c) => isMacCell(c) || isIpv4Cell(c))) return false;
  const wordish = cells.filter((c) => HEADER_WORD_RE.test(c)).length;
  return wordish >= Math.max(2, Math.floor(cells.length / 2));
}

export function detectColumns(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const columns = [];
  for (let i = 0; i < width; i += 1) {
    let cells = rows.filter((r) => i < r.length && r[i]).map((r) => r[i]);
    cells = cells.filter((c) => !MISSING_VALUE.has(c));
    if (!cells.length) {
      columns.push({ index: i, kind: 'other', confidence: 0, sample: '' });
      continue;
    }
    const total = cells.length;
    const scores = {
      mac: cells.filter(isMacCell).length / total,
      ipv4: cells.filter(isIpv4Cell).length / total,
      interface: cells.filter(isIfaceCell).length / total,
    };
    const priority = ['mac', 'ipv4', 'interface'];
    let kind = 'mac';
    for (const k of priority) {
      if (scores[k] > scores[kind] ||
          (scores[k] === scores[kind] && priority.indexOf(k) < priority.indexOf(kind))) {
        kind = k;
      }
    }
    let confidence = scores[kind];
    if (confidence <= 0.5) kind = 'other';
    columns.push({ index: i, kind, confidence: Math.round(confidence * 1000) / 1000, sample: cells[0] });
  }

  for (const kind of ['mac', 'ipv4', 'interface']) {
    const matches = columns.filter((c) => c.kind === kind);
    if (matches.length <= 1) continue;
    const winner = matches.reduce((a, b) =>
      b.confidence > a.confidence || (b.confidence === a.confidence && b.index < a.index) ? b : a
    );
    for (const col of matches) if (col !== winner) col.kind = 'other';
  }
  return columns;
}

export function parse(text) {
  let header = null;
  const rows = [];
  let skipped = 0;

  for (const line of (text || '').split('\n')) {
    if (!line.trim()) { skipped += 1; continue; }
    if (RULE_RE.test(line)) { skipped += 1; continue; }
    const cells = line.trim().split(/\s+/);
    if (!rows.length && looksLikeHeader(cells)) {
      if (header !== null) skipped += 1;
      header = cells;
      continue;
    }
    rows.push(cells);
  }

  const filtered = rows.filter((r) => !looksLikeHeader(r));
  skipped += rows.length - filtered.length;

  const counts = new Map();
  for (const r of filtered) counts.set(r.length, (counts.get(r.length) || 0) + 1);
  let modalWidth = 0;
  let bestCount = -1;
  for (const [len, n] of counts) {
    if (n > bestCount || (n === bestCount && len > modalWidth)) { modalWidth = len; bestCount = n; }
  }

  const columns = detectColumns(filtered);
  const headerAligned = !!header && header.length === modalWidth;

  return {
    rows: filtered,
    header,
    headerAligned,
    safeHeader: headerAligned ? header : null,
    skipped,
    columns,
    modalWidth,
    cell(row, index) {
      if (index === null || index === undefined || index < 0 || index >= row.length) return '';
      return row[index];
    },
    columnOf(kind) {
      const found = columns.find((c) => c.kind === kind);
      return found ? found.index : null;
    },
    get macColumn() { return this.columnOf('mac'); },
    get ipColumn() { return this.columnOf('ipv4'); },
    get portColumn() { return this.columnOf('interface'); },
  };
}

export function findIncomplete(table) {
  return table.rows.filter((row) => row.some((cell) => INCOMPLETE_MARKERS.has(cell)));
}
