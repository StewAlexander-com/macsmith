/**
 * The page tells people "Nothing you paste is uploaded, stored, or logged."
 *
 * That sentence is why a network engineer would risk pasting an internal ARP
 * table into a browser tab. If it is ever false, nothing else in this project
 * matters. These tests are the proof, and they are deliberately paranoid:
 * they assert an allowlist of exactly one fetched file, and they hunt for the
 * pasted text in every outbound request.
 */
import { expect, test } from '@playwright/test';

import { CANARY, DB_TOOLS, Macsmith, TOOLS, recordRequests } from './helpers.js';
import { CISCO_ARP, CISCO_MAC_TABLE, MIXED_FORMATS } from './fixtures.js';

/** The only file the page is allowed to fetch beyond its own static assets. */
const ALLOWED_PATHS = [
  '/index.html',
  '/js/app.js',
  '/js/mac.js',
  '/js/table.js',
  '/data/registry.json',
  '/favicon.ico',
];

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

test.describe('privacy claim', () => {
  test('the page makes no cross-origin requests at all', async ({ page }) => {
    const record = recordRequests(page);
    const app = new Macsmith(page);
    await app.goto();

    // Exercise every tool, including the two that load the vendor database.
    for (const tool of TOOLS) {
      await app.selectTool(tool);
      await app.loadSample();
    }
    await app.waitForDb();
    await page.waitForTimeout(500);

    expect(record.crossOrigin, 'no request may leave this origin').toEqual([]);
  });

  test('every request is a GET from the allowlist', async ({ page }) => {
    const record = recordRequests(page);
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    await app.waitForDb();

    expect(record.nonGet, 'nothing may be POSTed, PUT, or PATCHed').toEqual([]);

    const paths = [...new Set(record.all.map((r) => pathOf(r.url)))];
    for (const p of paths) {
      expect(ALLOWED_PATHS, `unexpected request to ${p}`).toContain(p);
    }
  });

  test('pasted text never appears in any request', async ({ page }) => {
    const record = recordRequests(page);
    const app = new Macsmith(page);
    await app.goto();

    // A canary the tools will happily parse around, so it stays in the DOM.
    const payload = `${CANARY}\n${CISCO_ARP}`;
    for (const tool of TOOLS) {
      await app.selectTool(tool);
      await app.setInput(payload);
    }
    await app.waitForDb();
    await page.waitForTimeout(500);

    // No request body at all is the strongest form of this assertion.
    expect(record.bodies, 'no request may carry a body').toEqual([]);

    const encoded = encodeURIComponent(CANARY);
    for (const request of record.all) {
      expect(request.url, 'the canary must not appear in a URL')
        .not.toContain(CANARY);
      expect(request.url, 'the canary must not appear percent-encoded')
        .not.toContain(encoded);
    }
  });

  test('no beacon, websocket, or service worker is opened', async ({ page }) => {
    const sockets = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));

    const record = recordRequests(page);
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(MIXED_FORMATS);
    await app.waitForDb();

    expect(sockets, 'no websocket may be opened').toEqual([]);
    const kinds = record.all.map((r) => r.type);
    for (const forbidden of ['websocket', 'eventsource', 'ping', 'beacon']) {
      expect(kinds, `no ${forbidden} request`).not.toContain(forbidden);
    }
    const workers = await page.evaluate(async () =>
      navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0
    );
    expect(workers, 'no service worker may be registered').toBe(0);
  });

  test('nothing is written to local or session storage or cookies', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(`${CANARY}\n${CISCO_MAC_TABLE}`);
    await app.waitForDb();

    const stored = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
    }));

    expect(stored.local, 'localStorage must stay empty').toEqual({});
    expect(stored.session, 'sessionStorage must stay empty').toEqual({});
    expect(stored.cookie, 'no cookies may be set').toBe('');
  });

  test('the tools still work with the network cut after first load', async ({ page, context }) => {
    const app = new Macsmith(page);
    await app.goto();
    // Load the database, then go offline. This is the claim in the banner:
    // "load the page once and turn off your Wi-Fi".
    await app.selectTool('vendor');
    await app.loadSample();
    await app.waitForDb();

    await context.setOffline(true);

    await app.selectTool('table');
    await app.loadSample();
    expect(await app.rowCount()).toBeGreaterThan(0);
    const rows = await app.rows();
    expect(rows.some((r) => r.join(' ').includes('Cisco'))).toBe(true);

    await context.setOffline(false);
  });

  test.describe('database is fetched only when a tool needs it', () => {
    for (const tool of TOOLS.filter((t) => !DB_TOOLS.includes(t))) {
      test(`${tool} does not download the vendor database`, async ({ page }) => {
        const record = recordRequests(page);
        const app = new Macsmith(page);
        await app.goto();
        await app.selectTool(tool);
        await app.loadSample();
        await page.waitForTimeout(700);

        const fetchedDb = record.all.some((r) => pathOf(r.url) === '/data/registry.json');
        expect(fetchedDb, `${tool} needs no vendor data, so must not spend 1.8MB`).toBe(false);
      });
    }
  });
});
