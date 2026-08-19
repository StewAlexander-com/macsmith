/**
 * Edge cases: the inputs and conditions that arrive from the real world rather
 * than from a fixture someone wrote to make a test pass.
 */
import { expect, test } from '@playwright/test';

import { Macsmith } from './helpers.js';
import {
  CRLF_ARP,
  LINUX_ARP,
  LONG_VENDOR_MAC,
  MIXED_FORMATS,
  PROSE,
  TSV_TABLE,
  UNICODE_NOISE,
  bigTable,
} from './fixtures.js';

test.describe('real-world paste shapes', () => {
  test('Windows line endings do not corrupt the last column', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('csv');
    await app.setInput(CRLF_ARP);

    const rows = await app.rows();
    expect(rows.length).toBe(4);
    for (const row of rows) {
      for (const cell of row) {
        expect(cell, 'a stray carriage return would ride along invisibly')
          .not.toMatch(/[\r\n]/);
      }
      expect(row[row.length - 1]).toBe('Vlan1');
    }
  });

  test('tab-separated input parses like whitespace-aligned input', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(TSV_TABLE);

    const rows = await app.rows();
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe('0000.0c07.ac01');
    expect(rows[0][1]).toBe('Gi1/0/1');
  });

  test('comments and non-ASCII around the data are skipped, not counted', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(UNICODE_NOISE);

    expect(await app.rowCount()).toBe(2);
    expect(await app.detectMessage()).toMatch(/2 data row/);
  });

  test('mixed address formats in one paste are all found', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('fmt');
    await app.setInput(MIXED_FORMATS);

    const rows = await app.rows();
    const formatted = rows.map((r) => r[0]);
    expect(formatted).toContain('00:1A:2B:3C:4D:5E');
    expect(formatted).toContain('00:00:0C:07:AC:01');
    expect(formatted).toContain('3C:22:FB:1A:9F:01');
    expect(formatted).toContain('02:42:AC:11:00:02');
    // fe:35:b6:60:f:ee has a single-nibble octet that must be padded.
    expect(formatted).toContain('FE:35:B6:60:0F:EE');
  });

  test('a linux arp table detects a different column layout', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(LINUX_ARP);

    expect(await app.detectMessage()).toMatch(/using column 3 for the MAC/i);
    expect(await app.rowCount()).toBe(2);
  });

  test('prose produces no rows and says so without alarm', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(PROSE);

    expect(await app.rowCount()).toBe(0);
    expect(await app.detectMessage()).toMatch(/no data rows/i);
  });
});

test.describe('scale', () => {
  test('a 5000-row table stays responsive', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('csv');

    const text = bigTable(5000);
    await app.setInput(text);
    await expect(app.count).toContainText('5000 rows', { timeout: 10_000 });

    // Time the page's own work rather than the harness's input pipeline.
    const elapsed = await page.evaluate((value) => {
      const el = document.getElementById('input');
      const started = performance.now();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - started;
    }, text);

    expect(elapsed, 'parsing and rendering a 5000-row paste must not lock the tab')
      .toBeLessThan(2000);
    expect(await app.rowCount(), 'rendering is capped, not unbounded').toBe(500);
  });

  test('a long vendor name wraps instead of stretching the table', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(LONG_VENDOR_MAC);
    await app.waitForDb();

    const pageOverflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(pageOverflow, 'a long vendor name must not push the page sideways')
      .toBeLessThanOrEqual(0);
  });
});

test.describe('degrading honestly', () => {
  test('a missing vendor database is reported, and the rest still works', async ({ page }) => {
    await page.route('**/data/registry.json', (route) => route.fulfill({ status: 404 }));

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(MIXED_FORMATS);
    await expect(app.dataStatus).toContainText(/could not load/i, { timeout: 15_000 });

    // Classification is pure logic, so it must survive the data being gone.
    const rows = await app.rows();
    expect(rows.length).toBeGreaterThan(0);
    const laa = rows.find((r) => r[0] === '02:42:AC:11:00:02');
    expect(laa[2], 'the U/L bit is knowable without any database')
      .toBe('Private / local');
  });

  test('a corrupt vendor database does not take the page down', async ({ page }) => {
    await page.route('**/data/registry.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'not json{{' })
    );
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(MIXED_FORMATS);
    await expect(app.dataStatus).toContainText(/could not load/i, { timeout: 15_000 });

    expect(errors, 'a bad payload must be handled, not thrown').toEqual([]);
    expect(await app.rowCount()).toBeGreaterThan(0);
  });

  test('a slow database does not block the tools that do not need it', async ({ page }) => {
    await page.route('**/data/registry.json', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      route.continue();
    });

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('incomplete');
    await app.loadSample();

    // No waiting on the database: this tool never needed it.
    expect(await app.rowCount()).toBe(2);
  });
});

test.describe('no unhandled errors anywhere', () => {
  test('every tool survives every fixture without throwing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    const app = new Macsmith(page);
    await app.goto();
    const inputs = [PROSE, CRLF_ARP, TSV_TABLE, UNICODE_NOISE, MIXED_FORMATS, '', '   ', '\u0000\uFFFD'];
    for (const tool of ['fmt', 'vendor', 'table', 'incomplete', 'find', 'grep', 'csv']) {
      await app.selectTool(tool);
      for (const value of inputs) {
        await app.setInput(value);
      }
    }
    expect(errors).toEqual([]);
  });
});
