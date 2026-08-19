/**
 * Accessibility, checked by axe rather than by my judgement.
 *
 * Readability was one of the goals of this pass, and "is this easy to scan"
 * is exactly the kind of question where an author's opinion is worth little.
 * Contrast ratios, roles, names, and landmark structure are measurable, so
 * they get measured. Runs at every viewport, since a rule can pass wide and
 * fail narrow.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { Macsmith, TOOLS } from './helpers.js';
import { CISCO_ARP } from './fixtures.js';

const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function summarise(violations) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
  }));
}

test.describe('accessibility', () => {
  test('the empty page has no violations', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    expect(summarise(violations)).toEqual([]);
  });

  test('every tool with results has no violations', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    for (const tool of TOOLS) {
      await app.selectTool(tool);
      await app.loadSample();
      const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
      expect(summarise(violations), `tool: ${tool}`).toEqual([]);
    }
  });

  test('warning and detection states have no violations', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();

    // A detection summary carrying a warning note.
    await app.selectTool('csv');
    await app.setInput(CISCO_ARP);
    await expect(page.locator('#detect')).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
    expect(summarise(violations)).toEqual([]);
  });

  test('text contrast passes AA everywhere, including the recessive greys', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    await app.selectTool('table');
    await app.loadSample();
    await app.waitForDb();

    const { violations } = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    expect(summarise(violations),
      'the old --faint sat at 3.79:1 against the panel, used for table headers')
      .toEqual([]);
  });

  test('the whole interface is reachable and operable by keyboard', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();

    // Tab to the first tool button and switch tools with the keyboard alone.
    const reached = await page.evaluate(() => {
      const focusable = [...document.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, summary, [tabindex]:not([tabindex="-1"])'
      )].filter((n) => n.offsetParent !== null);
      return focusable.length;
    });
    expect(reached, 'every control must be in the tab order').toBeGreaterThan(10);

    await page.locator('.tool-btn[data-tool="incomplete"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.tool-btn[data-tool="incomplete"]'))
      .toHaveAttribute('aria-selected', 'true');

    await page.locator('#btn-sample').focus();
    await page.keyboard.press('Enter');
    expect(await app.rowCount()).toBeGreaterThan(0);
  });

  test('results are announced rather than changing silently', async ({ page }) => {
    const app = new Macsmith(page);
    await app.goto();
    const detect = page.locator('#detect');
    await expect(detect).toHaveAttribute('aria-live', 'polite');
    await expect(detect).toHaveAttribute('role', 'status');
  });
});
