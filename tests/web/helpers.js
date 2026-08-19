/**
 * Shared harness for the browser tests.
 *
 * These tests are written adversarially. A feature test asks "does the button
 * work"; a poka-yoke test asks "can I make this tool do the wrong thing, and
 * if I can't, is the reason visible?" Most specs here are an attempted
 * mistake plus an assertion that it was prevented or surfaced.
 */
import { expect } from '@playwright/test';

export const TOOLS = ['fmt', 'vendor', 'table', 'incomplete', 'find', 'grep', 'csv'];

/** Tools that need the vendor database, and so trigger the one allowed fetch. */
export const DB_TOOLS = ['vendor', 'table'];

export class Macsmith {
  constructor(page) {
    this.page = page;
    this.input = page.locator('#input');
    this.detect = page.locator('#detect');
    this.out = page.locator('#out');
    this.count = page.locator('#count');
    this.copyCsv = page.locator('#btn-copy');
    this.copyTsv = page.locator('#btn-copy-tsv');
    this.download = page.locator('#btn-download');
    this.sample = page.locator('#btn-sample');
    this.clear = page.locator('#btn-clear');
    this.dataStatus = page.locator('#data-status');
  }

  async goto() {
    await this.page.goto('/index.html');
    await expect(this.input).toBeVisible();
  }

  async selectTool(name) {
    await this.page.locator(`.tool-btn[data-tool="${name}"]`).click();
    await expect(this.page.locator(`.tool-btn[data-tool="${name}"]`))
      .toHaveAttribute('aria-selected', 'true');
  }

  async loadSample() {
    await this.sample.click();
    await expect(this.input).not.toHaveValue('');
  }

  /**
   * Put text in the input the way a paste does.
   *
   * `fill()` is fine for small values but drives the text through Playwright's
   * input pipeline, which costs ~29 seconds for a 234KB table — an artefact of
   * the harness, not the page, which handles the same paste in ~44ms. Above a
   * threshold we set the value and dispatch a single input event, which is
   * exactly what a real paste produces.
   */
  async setInput(text) {
    if (text.length < 20_000) {
      await this.input.fill(text);
      await this.page.waitForTimeout(60);
      return;
    }
    await this.page.evaluate((value) => {
      const el = document.getElementById('input');
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    // Large inputs are debounced by 120ms before recomputing.
    await this.page.waitForTimeout(400);
  }

  async waitForDb() {
    await expect(this.dataStatus).toContainText(/IEEE assignments|could not load/, {
      timeout: 20_000,
    });
  }

  /** Result rows as arrays of cell text. */
  async rows() {
    return this.page.locator('#out table tbody tr').evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    );
  }

  async headers() {
    return this.page.locator('#out table thead th').allTextContents();
  }

  async rowCount() {
    return this.page.locator('#out table tbody tr').count();
  }

  async detectMessage() {
    if (!(await this.detect.isVisible())) return '';
    return (await this.detect.textContent()).trim();
  }

  async exportEnabled() {
    return {
      csv: !(await this.copyCsv.isDisabled()),
      tsv: !(await this.copyTsv.isDisabled()),
      download: !(await this.download.isDisabled()),
    };
  }

  async setOption(id, value) {
    const select = this.page.locator(`#opts select[data-opt-id="${id}"]`);
    if (await select.count()) {
      await select.selectOption(String(value));
      return;
    }
    const text = this.page.locator('#opts input[type="text"]').first();
    await text.fill(String(value));
    await this.page.waitForTimeout(60);
  }
}

/**
 * Record every network request the page makes.
 *
 * Install before navigation. The returned object accumulates requests so a
 * test can assert on the complete set rather than sampling.
 */
export function recordRequests(page) {
  const record = { all: [], nonGet: [], crossOrigin: [], bodies: [] };
  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();
    record.all.push({ url, method, type: request.resourceType() });
    if (method !== 'GET') record.nonGet.push({ url, method });
    if (!url.startsWith('http://127.0.0.1:8791') && !url.startsWith('data:')) {
      record.crossOrigin.push({ url, method });
    }
    const body = request.postData();
    if (body) record.bodies.push({ url, body });
  });
  return record;
}

/** A recognisable string, so we can prove it never left the page. */
export const CANARY = 'CANARY-a1b2c3-DO-NOT-EXFILTRATE';
