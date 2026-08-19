/**
 * Layout, typography, and reach.
 *
 * These run at every viewport in the config, so the narrow layout cannot rot
 * while someone develops against a desktop window. The numbers are the ones
 * measured on the original page: 615px of preamble before the input on an
 * 844px phone, 14 tap targets between 30 and 37px, a 13.6px textarea that
 * made iOS zoom on focus, and 12 distinct font sizes with nine of them
 * crowded between 11.2 and 14.4px.
 */
import { expect, test } from '@playwright/test';

import { Macsmith } from './helpers.js';
import { CISCO_ARP, CISCO_MAC_TABLE, LONG_VENDOR_MAC } from './fixtures.js';

const NARROW = 640;

test.describe('reach and fit', () => {
  test('the page never scrolls sideways', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    await app.waitForDb();

    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(overflow, 'horizontal page scroll is always a layout bug').toBeLessThanOrEqual(0);
  });

  test('the input is reachable without a long scroll', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    const { top, viewportHeight } = await page.evaluate(() => ({
      top: document.getElementById('input').getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    }));

    // The original put the input 615px down an 844px screen: 73% preamble.
    expect(top / viewportHeight,
      'most of the first screen should be the tool, not the preamble')
      .toBeLessThan(0.55);
  });

  test('the tool tabs occupy one scrollable row, not several', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    const { height, rowHeight } = await page.evaluate(() => {
      const nav = document.querySelector('nav.tools');
      const btn = nav.querySelector('.tool-btn');
      return {
        height: nav.getBoundingClientRect().height,
        rowHeight: btn.getBoundingClientRect().height,
      };
    });
    expect(height, 'wrapped tab rows ate 121px above the fold')
      .toBeLessThan(rowHeight * 1.6);
  });

  test('every interactive control meets the 44px touch target minimum', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();

    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, select, input[type=text], summary')]
        .filter((elm) => elm.offsetParent !== null)
        .map((elm) => ({
          what: (elm.textContent || elm.id || elm.tagName).trim().slice(0, 30),
          height: Math.round(elm.getBoundingClientRect().height),
        }))
        .filter((x) => x.height < 44)
    );
    expect(small, 'WCAG 2.5.5 and Apple HIG both want 44px').toEqual([]);
  });
});

test.describe('typography', () => {
  test('the type scale has few enough steps to create hierarchy', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();

    const sizes = await page.evaluate(() => {
      const seen = new Set();
      for (const elm of document.querySelectorAll('*')) {
        if (elm.offsetParent === null && elm.tagName !== 'BODY') continue;
        if (!elm.textContent.trim()) continue;
        seen.add(parseFloat(getComputedStyle(elm).fontSize));
      }
      return [...seen].sort((a, b) => a - b);
    });

    expect(sizes.length,
      `twelve near-identical sizes is not a hierarchy: ${sizes.join(', ')}`)
      .toBeLessThanOrEqual(6);
  });

  test('anything typeable is at least 16px so iOS does not zoom', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('find');

    const tooSmall = await page.evaluate(() =>
      [...document.querySelectorAll('textarea, input[type=text], select')]
        .filter((elm) => elm.offsetParent !== null)
        .map((elm) => ({ what: elm.id || elm.tagName, px: parseFloat(getComputedStyle(elm).fontSize) }))
        .filter((x) => x.px < 16)
    );
    expect(tooSmall, 'below 16px, focusing a field zooms the whole page on iOS')
      .toEqual([]);
  });

  test('pasted aligned columns do not soft-wrap in the input', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.setInput(CISCO_MAC_TABLE);

    const wrap = await page.evaluate(() => {
      const ta = document.getElementById('input');
      return { white: getComputedStyle(ta).whiteSpace, attr: ta.getAttribute('wrap') };
    });
    expect(wrap.attr, 'wrapping destroys the column alignment being read').toBe('off');
    expect(wrap.white).toBe('pre');
  });

  test('the detection summary outweighs the result text', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();

    const { chipValue, cell } = await page.evaluate(() => ({
      chipValue: parseFloat(getComputedStyle(document.querySelector('#detect .chip b')).fontSize),
      cell: parseFloat(getComputedStyle(document.querySelector('#out td')).fontSize),
    }));
    expect(chipValue,
      'this is the element that prevents a wrong-column export, so it must lead')
      .toBeGreaterThan(cell);
  });
});

test.describe('narrow presentation', () => {
  test('labelled results become cards, headerless ones stay scrollable', async ({ page }) => {
    const width = page.viewportSize().width;
    const app = new Macsmith(page);
    await app.goto();

    // Labelled: the MAC table has a real header.
    await app.selectTool('table');
    await app.loadSample();
    await app.waitForDb();
    const labelled = await page.locator('#out table').getAttribute('class');
    expect(labelled).toContain('cards');

    const firstCell = page.locator('#out td').first();
    if (width <= NARROW) {
      await expect(firstCell).toHaveAttribute('data-label', 'mac');
      const display = await firstCell.evaluate((n) => getComputedStyle(n).display);
      expect(display, 'cards stack fields with their labels').toBe('flex');
    }

    // Headerless: search results have no field names to card up.
    await app.selectTool('grep');
    await app.loadSample();
    const headerless = await page.locator('#out table').getAttribute('class');
    expect(headerless, 'inventing labels would be worse than scrolling')
      .not.toContain('cards');
  });

  test('a sideways-scrolling result says so on a narrow screen', async ({ page }) => {
    const width = page.viewportSize().width;
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('grep');
    await app.loadSample();

    const hint = page.locator('#scroll-hint');
    if (width <= NARROW) {
      await expect(hint, 'a hidden column with no hint is a hidden column')
        .toBeVisible();
    } else {
      await expect(hint).toBeHidden();
    }
  });

  test('a long vendor name wraps rather than widening the page', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.setInput(LONG_VENDOR_MAC);
    await app.waitForDb();

    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the detection summary stays visible above the results', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('csv');
    await app.setInput(CISCO_ARP);

    const order = await page.evaluate(() => {
      const detect = document.getElementById('detect').getBoundingClientRect();
      const out = document.getElementById('out').getBoundingClientRect();
      return { detectTop: detect.top, outTop: out.top };
    });
    expect(order.detectTop,
      'the check must come before the thing being checked').toBeLessThan(order.outTop);
  });
});

test.describe('edge-scenario warnings', () => {
  test('a metered connection defers the 1.8MB download and offers a choice', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true, effectiveType: '3g' },
        configurable: true,
      });
    });

    let dbRequested = false;
    await page.route('**/data/registry.json', (route) => {
      dbRequested = true;
      route.continue();
    });

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.loadSample();
    await page.waitForTimeout(600);

    expect(dbRequested, 'spending someone\'s data allowance uninvited is the error')
      .toBe(false);
    const alert = page.locator('#alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/1\.8 MB/);

    // And the choice must actually work.
    await alert.locator('button').click();
    await app.waitForDb();
    expect(dbRequested).toBe(true);
    const rows = await app.rows();
    expect(rows.some((r) => r.join(' ').includes('Cisco'))).toBe(true);
  });

  test('stale vendor data warns rather than answering confidently', async ({ page }) => {
    await page.route('**/data/registry.json', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.generated = '2020-01-01';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('vendor');
    await app.loadSample();
    await app.waitForDb();

    await expect(page.locator('#alert')).toContainText(/days old/i);
    await expect(app.dataStatus).toContainText(/may be missing recent assignments/i);
  });
});

test.describe('hidden means hidden', () => {
  /**
   * An explicit `display` value in CSS beats the `hidden` attribute, so an
   * element toggled with `.hidden = true` can stay on screen as an empty box.
   * That shipped: the warning bar rendered as a bare amber outline, and the
   * sideways-scroll hint appeared under results that were not scrollable.
   */
  test('elements toggled off are actually off screen', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();

    await expect(page.locator('#alert'), 'no warning applies on first load')
      .toBeHidden();
    await expect(page.locator('#detect'), 'nothing has been detected yet')
      .toBeHidden();
    await expect(page.locator('#scroll-hint'), 'there is no result to scroll')
      .toBeHidden();

    // A carded result is not sideways-scrollable, so the hint stays off.
    await app.selectTool('table');
    await app.loadSample();
    await expect(page.locator('#scroll-hint')).toBeHidden();
  });

  test('no element renders as an empty visible box', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    const empties = await page.evaluate(() =>
      [...document.querySelectorAll('#alert, #detect, #scroll-hint, .chips, .notes')]
        .filter((n) => n.offsetParent !== null && !n.textContent.trim())
        .map((n) => n.id || n.className)
    );
    expect(empties, 'a visible empty box is a toggling bug').toEqual([]);
  });
});
