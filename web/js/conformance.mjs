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

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(here, '..', '..', 'tests', 'vectors', 'mac_vectors.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

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

if (failures.length) {
  console.error(`\n${failures.length} conformance failure(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`${passed} conformance checks passed (browser core matches the vectors)`);
