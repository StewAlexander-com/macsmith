/**
 * Poka-yoke specs.
 *
 * Each test attempts a mistake and asserts it was either prevented or made
 * visible. The interesting failures are the quiet ones: an export that does
 * not match what was on screen, a stale result left over from the last tool,
 * a truncated table that silently exports truncated data.
 */
import { expect, test } from '@playwright/test';

import { Macsmith } from './helpers.js';
import {
  ALL_INCOMPLETE,
  CISCO_ARP,
  CISCO_MAC_TABLE,
  NOT_MACS,
  PROSE,
  TWO_MAC_COLUMNS,
  bigTable,
} from './fixtures.js';

test.describe('nothing happens without asking', () => {
  test('no file downloads unless the download button is clicked', async ({ page }) => {
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    await app.setInput(CISCO_MAC_TABLE);
    await app.selectTool('csv');
    await page.waitForTimeout(400);

    expect(downloads, 'loading, typing, and switching tools must write nothing').toEqual([]);
  });

  test('clicking download produces exactly one file, named for the tool', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('incomplete');
    await app.loadSample();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      app.download.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^macsmith-incomplete-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('export controls stay disabled while there is nothing to export', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    expect(await app.exportEnabled()).toEqual({ csv: false, tsv: false, download: false });

    await app.setInput(PROSE);
    expect(await app.exportEnabled(),
      'prose yields no rows, so there is nothing to copy').toEqual(
      { csv: false, tsv: false, download: false });
  });

  test('clearing the input clears the results rather than leaving them stale', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    expect(await app.rowCount()).toBeGreaterThan(0);

    await app.clear.click();
    expect(await app.rowCount()).toBe(0);
    expect(await app.exportEnabled()).toEqual({ csv: false, tsv: false, download: false });
    expect(await app.detectMessage()).toBe('');
  });
});

test.describe('what you export is what you saw', () => {
  test('the copied CSV matches the rendered table exactly', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    await app.waitForDb();

    const rendered = await app.rows();
    await app.copyCsv.click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());

    const lines = clipboard.trim().split('\n');
    // First line is the header; the rest must equal the rendered rows in order.
    expect(lines.length - 1).toBe(rendered.length);
    for (const [i, row] of rendered.entries()) {
      for (const cell of row) {
        expect(lines[i + 1], `row ${i} must contain ${cell}`).toContain(cell);
      }
    }
  });

  test('a truncated display still exports every row, and says so', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('csv');
    await app.setInput(bigTable(1200));
    await page.waitForTimeout(600);

    const shown = await app.rowCount();
    expect(shown, 'the table caps rendering to stay responsive').toBe(500);
    await expect(app.out).toContainText(/Showing the first 500 of 1,?200 rows/);

    await app.copyCsv.click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Whether a header line is present depends on whether it aligned to the
    // data, so count from what was actually emitted rather than assuming one.
    const headerLines = (await app.headers()).length ? 1 : 0;
    const dataLines = clipboard.trim().split('\n').length - headerLines;
    expect(dataLines,
      'the export must contain all 1200 rows, not the 500 displayed').toBe(1200);
  });

  test('a blocked clipboard says so instead of failing silently', async ({ page, context }) => {
    await context.clearPermissions();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
    });

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('incomplete');
    await app.loadSample();
    await app.copyCsv.click();

    await expect(app.copyCsv, 'a silent no-op would be the worst outcome')
      .toContainText(/Copy blocked/);
  });
});

test.describe('the detection is shown before it is acted on', () => {
  test('the summary names the columns actually used', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();

    expect(await app.chipValue('MAC column'),
      'the summary must name the column it actually used').toBe('2');
    expect(await app.chipValue('port column')).toBe('4');
    expect(await app.chipValue('data rows')).toBe('5');
  });

  test('overriding the column changes both the summary and the output', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    const before = (await app.rows())[0][0];

    await app.setOption('macCol', '2');
    const after = (await app.rows())[0][0];

    expect(after, 'a different column must produce different output').not.toBe(before);
    expect(await app.chipValue('MAC column'),
      'the summary must follow the override, not the detection').toBe('3');
  });

  test('an ambiguous table still commits to one column and says which', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.setInput(TWO_MAC_COLUMNS);
    await page.waitForTimeout(200);

    expect(await app.chipValue('MAC column'),
      'silence about an ambiguous choice is the failure mode').toMatch(/^\d+$/);
    expect(await app.rowCount()).toBe(2);
  });

  test('a header that does not line up is dropped and the reason given', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('csv');
    await app.setInput(CISCO_ARP);
    await page.waitForTimeout(200);

    // "Age (min)" splits into two cells, so the header is wider than the data.
    expect(await app.detectMessage()).toMatch(/does not line up/i);
    const headers = await app.headers();
    expect(headers, 'a shifted header mislabels columns, so emit none').toEqual([]);
  });
});

test.describe('honest about finding nothing', () => {
  test('no matches is reported as a result, not an error', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('incomplete');
    await app.setInput(CISCO_MAC_TABLE);
    await page.waitForTimeout(200);

    const message = await app.detectMessage();
    expect(message).toMatch(/no incomplete entries/i);
    expect(message).toMatch(/scanned/i);
    expect(await app.exportEnabled()).toEqual({ csv: false, tsv: false, download: false });
  });

  test('a failed search says how much was searched', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('find');
    await app.setInput(CISCO_ARP);
    await app.setOption('needle', 'aa:bb:cc:dd:ee:ff');
    await page.waitForTimeout(200);

    const message = await app.detectMessage();
    expect(message).toMatch(/not found/i);
    expect(message, 'the user needs to know the search was real').toMatch(/4 row/);
  });

  test('phone numbers and prose never produce a confident vendor', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(NOT_MACS);
    await app.waitForDb();
    await page.waitForTimeout(300);

    const rows = await app.rows();
    const organizations = rows.map((r) => r[2] || '');
    for (const org of organizations) {
      expect(org, `"${org}" was invented from input containing no MAC address`)
        .toMatch(/^(—|Private \/ local|Multicast|Broadcast|All-zero|Private multicast|no registry entry)?$/);
    }
  });

  test('an invalid regular expression is reported, not swallowed', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('grep');
    await app.setInput(CISCO_ARP);
    await page.locator('#opts input[type="checkbox"]').first().check();
    await app.setOption('pattern', '[unclosed');
    await page.waitForTimeout(200);

    expect(await app.detectMessage()).toMatch(/invalid regular expression/i);
    expect(await app.rowCount(), 'a broken pattern must not return everything').toBe(0);
  });

  test('every ARP entry unresolved is still a real answer', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('incomplete');
    await app.setInput(ALL_INCOMPLETE);
    await page.waitForTimeout(200);

    expect(await app.rowCount()).toBe(2);
    expect(await app.detectMessage()).toMatch(/2 incomplete/i);
  });
});
