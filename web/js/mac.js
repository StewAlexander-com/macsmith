/**
 * MAC address core for the browser.
 *
 * A direct port of src/macsmith/mac.py. Neither implementation is the
 * authority: tests/vectors/mac_vectors.json is, and both must pass it.
 * Run `node web/js/conformance.mjs` after changing anything here.
 */

export const CLASS_BROADCAST = 'broadcast';
export const CLASS_ALL_ZERO = 'all-zero';
export const CLASS_MULTICAST_LAA = 'multicast-laa';
export const CLASS_MULTICAST = 'multicast';
export const CLASS_LAA = 'laa';

export const CLASS_BLURBS = {
  [CLASS_BROADCAST]: 'broadcast (FF:FF:FF:FF:FF:FF)',
  [CLASS_ALL_ZERO]: 'all-zero',
  [CLASS_LAA]: 'locally administered (private/randomized)',
  [CLASS_MULTICAST]: 'multicast/group',
  [CLASS_MULTICAST_LAA]: 'locally administered multicast',
};

const SEPARATORS_RE = /[-:.\s]/g;
const INNER_SEP_RE = /[-:.]/;
const INNER_SEP_SPLIT_RE = /[-:.]/g;
const LABEL_RE =
  /\b(?:mac(?:\s*address)?|hardware\s*address|hwaddr|ether(?:net)?(?:\s*address)?|physical\s*address|bia|burned[- ]?in[- ]?address)\s*[:=]?\s*/gi;
const WRAPPER_CHARS = '()[]<>{}"\'`,;\t\r\n';
const TOKEN_RE = /[0-9A-Fa-fOoIiLl\-:.]+/g;
const MAC_GROUP_SIZES = new Set([2, 4, 6]);

const OCR_FIX = { O: '0', o: '0', I: '1', l: '1', L: '1' };

export class MacFormatError extends Error {}

export function normalizeMac(macAddress) {
  return (macAddress || '').replace(SEPARATORS_RE, '').toUpperCase();
}

export function classifyMac(hexOnly) {
  if (!hexOnly || hexOnly.length !== 12) return '';
  const upper = hexOnly.toUpperCase();
  if (upper === 'FFFFFFFFFFFF') return CLASS_BROADCAST;
  if (upper === '000000000000') return CLASS_ALL_ZERO;
  const firstByte = parseInt(upper.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return '';
  const multicast = (firstByte & 0x01) !== 0;
  const laa = (firstByte & 0x02) !== 0;
  if (multicast && laa) return CLASS_MULTICAST_LAA;
  if (multicast) return CLASS_MULTICAST;
  if (laa) return CLASS_LAA;
  return '';
}

const isAllHex = (s) => !!s && /^[0-9A-Fa-f]+$/.test(s);
const hasHexLetter = (s) => /[a-fA-F]/.test(s);

function looksMacShaped(token) {
  if (!INNER_SEP_RE.test(token)) return false;
  const stripped = token.replace(INNER_SEP_SPLIT_RE, '');
  return stripped.length >= 6 && stripped.length <= 12;
}

function hasMacishGrouping(token) {
  if (hasHexLetter(token)) return true;
  const groups = token.split(INNER_SEP_SPLIT_RE);
  if (groups.length < 2) return true;
  const sizes = groups.map((g) => g.length);
  if (sizes.some((s) => !MAC_GROUP_SIZES.has(s))) return false;
  if (groups.length >= 4 && new Set(sizes).size !== 1) return false;
  return true;
}

function maybePadSingleNibbleOctets(token) {
  let groups;
  if (token.includes(':')) groups = token.split(':');
  else if (token.includes('-')) groups = token.split('-');
  else return null;
  if (groups.length !== 6) return null;
  let hasLetter = false;
  for (const g of groups) {
    if (g.length < 1 || g.length > 2 || !isAllHex(g)) return null;
    if (hasHexLetter(g)) hasLetter = true;
  }
  if (!hasLetter) return null;
  return groups.map((g) => g.padStart(2, '0')).join('').toUpperCase();
}

function normalizedInputIsMacShaped(rawInput) {
  if (!rawInput) return false;
  let text = rawInput.trim();
  if (!text) return false;
  for (const ch of WRAPPER_CHARS + ' ') text = text.split(ch).join('');
  if (!text) return false;
  if (!INNER_SEP_RE.test(text)) return true;
  const groups = text.split(INNER_SEP_SPLIT_RE);
  if (groups.some((g) => g.length === 1) && groups.length >= 2) return false;
  return hasMacishGrouping(text);
}

function candidateFromToken(token) {
  if (!token) return null;
  if (isAllHex(token) && token.length >= 6 && token.length <= 12) {
    return [token.toUpperCase(), false];
  }
  const padded = maybePadSingleNibbleOctets(token);
  if (padded !== null) return [padded, false];
  if (looksMacShaped(token) && hasMacishGrouping(token)) {
    const stripped = token.replace(INNER_SEP_SPLIT_RE, '');
    if (isAllHex(stripped) && stripped.length >= 6 && stripped.length <= 12) {
      return [stripped.toUpperCase(), false];
    }
    const fixed = [...stripped].map((c) => OCR_FIX[c] ?? c).join('');
    if (isAllHex(fixed) && fixed.length >= 6 && fixed.length <= 12 && fixed !== stripped) {
      return [fixed.toUpperCase(), true];
    }
  }
  return null;
}

/**
 * Merge space-separated groups like "00 1A 2B 3C 4D 5E".
 *
 * Groups must be uniformly sized and sized like a real MAC group, otherwise
 * hex fragments of ordinary words glue together across word boundaries and
 * "no address here" becomes ADDEEE. That case is in the vectors.
 */
function combineWhitespaceChunks(tokens) {
  let best = '';
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isAllHex(tokens[i])) continue;
    const width = tokens[i].length;
    if (!MAC_GROUP_SIZES.has(width)) continue;
    let acc = '';
    for (let j = i; j < Math.min(i + 6, tokens.length); j += 1) {
      const t = tokens[j];
      if (!isAllHex(t) || t.length !== width) break;
      acc += t;
      if (acc.length > 12) break;
      if (acc.length >= 6 && acc.length <= 12 && acc.length > best.length) best = acc;
    }
  }
  return best ? [best.toUpperCase(), false] : null;
}

export function extractMacCandidates(text) {
  if (!text) return [];
  let stripped = text.replace(LABEL_RE, ' ');
  for (const ch of WRAPPER_CHARS) stripped = stripped.split(ch).join(' ');

  const cleaned = [];
  for (const tok of stripped.match(TOKEN_RE) || []) {
    const trimmed = tok.replace(/^[.\-:]+/, '').replace(/[.\-:]+$/, '');
    if (trimmed) cleaned.push(trimmed);
  }

  const candidates = [];
  const seen = new Set();
  const add = (item) => {
    if (!item) return;
    const [hexOnly] = item;
    if (seen.has(hexOnly)) return;
    seen.add(hexOnly);
    candidates.push(item);
  };

  for (const tok of cleaned) add(candidateFromToken(tok));
  add(combineWhitespaceChunks(cleaned));

  candidates.sort((a, b) => b[0].length - a[0].length || Number(a[1]) - Number(b[1]));
  return candidates;
}

export function extractMacCandidate(text) {
  const candidates = extractMacCandidates(text);
  return candidates.length ? candidates[0][0] : null;
}

// --- formatting -------------------------------------------------------------

export const STYLE_CISCO = 'cisco';
export const STYLE_COLON = 'colon';
export const STYLE_HYPHEN = 'hyphen';
export const STYLE_BARE = 'bare';
export const STYLES = [STYLE_CISCO, STYLE_COLON, STYLE_HYPHEN, STYLE_BARE];

const STYLE_ALIASES = {
  pc: STYLE_COLON,
  windows: STYLE_HYPHEN,
  dot: STYLE_CISCO,
  dotted: STYLE_CISCO,
  ieee: STYLE_HYPHEN,
  unix: STYLE_COLON,
};

export function resolveStyle(style) {
  let s = (style || '').trim().toLowerCase();
  s = STYLE_ALIASES[s] ?? s;
  if (!STYLES.includes(s)) {
    throw new MacFormatError(`unknown format '${style}'; expected one of ${STYLES.join(', ')}`);
  }
  return s;
}

export function formatMac(hexOnly, style = STYLE_COLON) {
  const resolved = resolveStyle(style);
  const h = normalizeMac(hexOnly);
  if (h.length !== 12 || !isAllHex(h)) {
    throw new MacFormatError(
      `need 12 hex characters to format, got ${h.length} from '${hexOnly}'`
    );
  }
  if (resolved === STYLE_CISCO) {
    const low = h.toLowerCase();
    return `${low.slice(0, 4)}.${low.slice(4, 8)}.${low.slice(8, 12)}`;
  }
  if (resolved === STYLE_BARE) return h;
  const sep = resolved === STYLE_COLON ? ':' : '-';
  return (h.match(/.{2}/g) || []).join(sep);
}

export function detectStyle(macAddress) {
  const t = (macAddress || '').trim();
  if (!t) return null;
  if (t.includes('.')) return STYLE_CISCO;
  if (t.includes(':')) return STYLE_COLON;
  if (t.includes('-')) return STYLE_HYPHEN;
  if (isAllHex(t) && t.length === 12) return STYLE_BARE;
  return null;
}

export function convert(macAddress, style = STYLE_COLON) {
  const original = macAddress || '';
  const detected = detectStyle(original);
  let hexOnly = normalizeMac(original);
  if (hexOnly.length !== 12 || !isAllHex(hexOnly)) {
    const extracted = extractMacCandidate(original);
    if (extracted && extracted.length === 12) {
      hexOnly = extracted;
    } else {
      return {
        ok: false,
        original,
        hexOnly: null,
        formatted: null,
        detected,
        classification: '',
        error: 'not a complete MAC address (need 12 hex characters)',
      };
    }
  }
  return {
    ok: true,
    original,
    hexOnly,
    formatted: formatMac(hexOnly, style),
    detected,
    classification: classifyMac(hexOnly),
    error: '',
  };
}
