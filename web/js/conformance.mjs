/**
 * Run the shared conformance vectors against the browser MAC core.
 *
 * The Python side runs the same file via tests/test_mac_vectors.py. If the two
 * implementations drift, one of them fails here.
 *
 *   node web/js/conformance.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mac from './mac.js';
import * as tbl from './table.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectorDir = join(here, '..', '..', 'tests', 'vectors');
const vectors = JSON.parse(readFileSync(join(vectorDir, 'mac_vectors.json'), 'utf8'));
const tableVectors = JSON.parse(readFileSync(join(vectorDir, 'table_vectors.json'), 'utf8'));

let passed = 0;
const failures = [];

function check(group, label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failures.push(`${group}: ${label}\n    expected ${e}\n    actual   ${a}`);
  }
}

for (const c of vectors.normalize) {
  check('normalize', c.in, mac.normalizeMac(c.in), c.out);
}

for (const c of vectors.classify) {
  check('classify', c.in, mac.classifyMac(c.in), c.out);
}

for (const c of vectors.extract) {
  check('extract', c.in, mac.extractMacCandidate(c.in), c.first);
}

for (const c of vectors.format) {
  check('format', `${c.hex} -> ${c.style}`, mac.formatMac(c.hex, c.style), c.out);
}

for (const c of vectors.format_aliases) {
  check('format_aliases', c.alias, mac.resolveStyle(c.alias), c.resolves_to);
}

for (const c of vectors.format_errors) {
  let threw = false;
  try {
    mac.formatMac(c.hex, c.style);
  } catch (err) {
    threw = err instanceof mac.MacFormatError;
  }
  check('format_errors', c.why, threw, true);
}

for (const c of vectors.convert) {
  const result = mac.convert(c.in, c.style);
  check('convert.ok', c.in, result.ok, c.ok);
  if (c.ok) {
    check('convert.formatted', c.in, result.formatted, c.formatted);
    check('convert.detected', c.in, result.detected, c.detected);
    check('convert.classification', c.in, result.classification, c.classification);
  } else {
    check('convert.error', c.in, result.error.length > 0, true);
  }
}

// Stub registry shared with the Python runner: does hex begin with an
// assigned prefix? Both sides must filter against identical data.
const REGISTERED = vectors.reportable_registered_prefixes || [];
const resolves = (hexOnly) => REGISTERED.some((prefix) => hexOnly.startsWith(prefix));

for (const c of vectors.reportable || []) {
  const found = mac.reportableCandidates(c.in, resolves).map(([h]) => h);
  check('reportable', JSON.stringify(c.in), found, c.out);
}

for (const c of tableVectors.cases) {
  const t = tbl.parse(c.text);
  check('table.rows', c.name, t.rows.length, c.rows);
  check('table.macColumn', c.name, t.macColumn, c.macColumn);
  check('table.ipColumn', c.name, t.ipColumn, c.ipColumn);
  check('table.portColumn', c.name, t.portColumn, c.portColumn);
  check('table.headerAligned', c.name, t.headerAligned, c.headerAligned);
  check('table.incomplete', c.name, tbl.findIncomplete(t).length, c.incomplete);
  // Bounds-safe access, matching the Python side's guarantee.
  let raised = false;
  try {
    for (const row of t.rows) {
      for (const i of [-1, 0, 3, 99, null, undefined]) t.cell(row, i);
    }
  } catch {
    raised = true;
  }
  check('table.cellNeverRaises', c.name, raised, false);
}

if (failures.length) {
  console.error(`\n${failures.length} conformance failure(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`${passed} conformance checks passed (browser core matches the vectors)`);
