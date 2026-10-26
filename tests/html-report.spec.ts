import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const reportPath = path.resolve('examples/triage.html');
const reportUrl = pathToFileURL(reportPath).href;

function track(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
  });
  return urls;
}

function httpUrls(urls: readonly string[]): string[] {
  return urls.filter((url) => url.startsWith('http://') || url.startsWith('https://'));
}

function pdfToText(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const objects = new Map<number, string>();
  for (const match of source.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2] ?? '');
  }
  const fonts = new Map<string, Map<number, string>>();
  for (const body of objects.values()) {
    const fontDict = body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!fontDict?.[1]) continue;
    for (const ref of fontDict[1].matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
      const fontObj = objects.get(Number(ref[2])) ?? '';
      const unicode = fontObj.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (!unicode?.[1]) continue;
      fonts.set(ref[1] ?? '', parseCMap(streamText(objects.get(Number(unicode[1])) ?? '')));
    }
  }
  let text = '';
  for (const body of objects.values()) {
    const content = streamText(body);
    if (!content.includes('Tj')) continue;
    let font: Map<number, string> | undefined;
    for (const match of content.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj/g)) {
      if (match[1]) {
        font = fonts.get(match[1]);
        continue;
      }
      const hex = match[2];
      if (!font || !hex) continue;
      for (let index = 0; index < hex.length; index += 4) {
        text += font.get(Number.parseInt(hex.slice(index, index + 4), 16)) ?? '';
      }
    }
  }
  return text;
}

function streamText(body: string): string {
  const start = body.indexOf('stream');
  if (start < 0) return '';
  let dataStart = start + 'stream'.length;
  if (body[dataStart] === '\r') dataStart += 1;
  if (body[dataStart] === '\n') dataStart += 1;
  const end = body.indexOf('endstream', dataStart);
  const data = Buffer.from(body.slice(dataStart, end), 'latin1');
  try {
    return inflateSync(data).toString('latin1');
  } catch {
    return '';
  }
}

function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const row of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(row[1] ?? '', 16), utf16Hex(row[2] ?? ''));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = Number.parseInt(row[1] ?? '', 16);
      const to = Number.parseInt(row[2] ?? '', 16);
      let code = Number.parseInt(row[3] ?? '', 16);
      for (let index = from; index <= to; index += 1) {
        map.set(index, String.fromCodePoint(code));
        code += 1;
      }
    }
  }
  return map;
}

function utf16Hex(hex: string): string {
  let out = '';
  for (let index = 0; index < hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

test('the report works offline in a browser', async ({ page, browserName }) => {
  const urls = track(page);
  await page.goto(reportUrl);
  await expect(page.getByRole('heading', { name: 'Triage Report', level: 1 })).toBeVisible();
  await expect(page.locator('[data-summary="tests"]')).toHaveText('6');
  await expect(page.locator('[data-summary="flaky"]')).toHaveText('6');
  await expect(page.locator('[data-summary="likely-real-bug"]')).toHaveText('0');
  await expect(page.locator('dt', { hasText: 'Commit' })).toHaveCount(0);
  await expect(page.getByText('Tests Flagged')).toBeVisible();
  await expect(page.getByText('Built by SprintSynergy.')).toBeVisible();

  const light = await page.evaluate(() => {
    return getComputedStyle(document.body).backgroundColor;
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
  await page.emulateMedia({ colorScheme: 'light' });

  const before = await page.locator('tbody th[scope="row"]').allTextContents();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.locator('th[data-sort-key="test"]')).toHaveAttribute('aria-sort', 'descending');
  const after = await page.locator('tbody th[scope="row"]').allTextContents();
  expect(after[0]).not.toBe(before[0]);
  expect(after[0]).toContain('product image');

  await page.getByLabel('Cause', { exact: true }).selectOption('timing');
  await expect(page.locator('tbody:not([hidden])')).toHaveCount(2);
  await page.getByLabel('Cause', { exact: true }).selectOption('');
  await page.getByLabel('Search', { exact: true }).fill('bike light');
  await expect(page.locator('tbody:not([hidden])')).toHaveCount(1);
  await expect(page.locator('tbody:not([hidden]) th')).toContainText('bike light');
  await page.getByLabel('Search', { exact: true }).fill('');
  await expect(page.locator('tbody:not([hidden])')).toHaveCount(6);

  const row = page.locator('tbody', { hasText: 'network drop' });
  await row.locator('summary').click();
  await expect(row.getByText('net::ERR_INTERNET_DISCONNECTED')).toBeVisible();
  await expect(row.getByText('Needs Review')).toBeVisible();
  const command = await row.locator('code').innerText();
  expect(command).toContain('qa-core-flaky rerun ');
  await page.evaluate(() => {
    document.addEventListener('copy', (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const write = data.setData.bind(data);
      data.setData = (type: string, value: string) => {
        if (type === 'text/plain') document.documentElement.setAttribute('data-copied', value);
        write(type, value);
      };
    });
  });
  await row.getByRole('button', { name: 'Copy Command' }).click();
  await expect(row.getByRole('button', { name: 'Copied' })).toBeVisible();
  let copied = await page.evaluate(() => document.documentElement.getAttribute('data-copied') ?? '');
  if (!copied) {
    copied = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    });
  }
  expect(copied).toBe(command);

  const injected = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.appendChild(script);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(injected).toBe(false);
  expect(httpUrls(urls)).toEqual([]);
});

test('the table is readable without script', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const urls = track(page);
  await page.goto(reportUrl);
  await expect(page.getByRole('heading', { name: 'Triage Report', level: 1 })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('tbody')).toHaveCount(6);
  await page.locator('summary').first().click();
  await expect(page.getByText('Needs Review').first()).toBeVisible();
  expect(httpUrls(urls)).toEqual([]);
  await context.close();
});

test('the page fits a phone width', async ({ page }) => {
  const urls = track(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(reportUrl);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator('td[data-label="Verdict"]').first()).toBeVisible();
  await expect(page.locator('td[data-label="Cause"]').first()).toBeVisible();
  await expect(page.locator('td[data-label="Confidence"]').first()).toBeVisible();
  await expect(page.locator('td[data-label="Attempts"]').first()).toBeVisible();
  await expect(page.getByLabel('Sort By')).toBeVisible();
  const cause = page.locator('td[data-label="Cause"]').first();
  const box = await cause.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(376);
  expect(httpUrls(urls)).toEqual([]);
});

test('print lists every evidence heading', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'PDF printing is provided by Chromium');
  const urls = track(page);
  await page.goto(reportUrl);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ printBackground: true });
  const text = pdfToText(Buffer.from(pdf));
  expect(text.split('Evidence').length - 1).toBe(6);
  expect(text.split('Next Step').length - 1).toBe(6);
  expect(httpUrls(urls)).toEqual([]);
});

test('tampered counts do not navigate', async ({ page }) => {
  const urls = track(page);
  const { renderTriageHtml } = (await import('../dist/report/html.js')) as {
    renderTriageHtml: (report: unknown, options?: { version?: string }) => string;
  };
  const attack = '3"><meta http-equiv="refresh" content="0;url=https://evil.example/">';
  const base = () => ({
    id: 'tests/a.spec.ts::chromium::title',
    verdict: 'flaky',
    confidence: 'low',
    ruleId: 'FLAKY',
    signals: [{ kind: 'same-code-flip', detail: 'At least one pass and one fail share the same code.' }],
    causes: [{ cause: 'timing', confidence: 'low', evidence: ['Timeout'], ruleIds: ['TIM-EXPECT-TIMEOUT'] }],
    evidence: ['Timeout'],
    attempts: {
      total: 2,
      failed: 1,
      passed: 1,
      sameCommit: true,
      reruns: undefined as
        | undefined
        | Record<string, { total: number; failed: number; passed: number; notRun?: number }>,
    },
    history: { runsSeen: 1, firstFailingCommit: null },
    suggestedFix: 'Wait.',
    healProposal: null,
    nextStep: 'Review the suggested fix.',
    note: null,
    llm: null,
    review: { status: 'Needs Review', reviewer: null, decision: null },
  });
  const fields: Array<[string, (row: ReturnType<typeof base>) => void]> = [
    ['attempts.total', (row) => { row.attempts.total = attack as unknown as number; }],
    ['attempts.failed', (row) => { row.attempts.failed = attack as unknown as number; }],
    ['attempts.passed', (row) => { row.attempts.passed = attack as unknown as number; }],
    ['history.runsSeen', (row) => { row.history.runsSeen = attack as unknown as number; }],
    ['attempts.reruns.repeat.total', (row) => { row.attempts.reruns = { repeat: { total: attack as unknown as number, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.repeat.failed', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: attack as unknown as number, passed: 0 } }; }],
    ['attempts.reruns.repeat.passed', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: 0, passed: attack as unknown as number } }; }],
    ['attempts.reruns.repeat.notRun', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: 0, passed: 0, notRun: attack as unknown as number } }; }],
    ['attempts.reruns.isolated.total', (row) => { row.attempts.reruns = { isolated: { total: attack as unknown as number, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.isolated.failed', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: attack as unknown as number, passed: 0 } }; }],
    ['attempts.reruns.isolated.passed', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: 0, passed: attack as unknown as number } }; }],
    ['attempts.reruns.isolated.notRun', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: 0, passed: 0, notRun: attack as unknown as number } }; }],
    ['attempts.reruns.in-order.total', (row) => { row.attempts.reruns = { 'in-order': { total: attack as unknown as number, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.in-order.failed', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: attack as unknown as number, passed: 0 } }; }],
    ['attempts.reruns.in-order.passed', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: 0, passed: attack as unknown as number } }; }],
    ['attempts.reruns.in-order.notRun', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: 0, passed: 0, notRun: attack as unknown as number } }; }],
  ];
  for (const [name, mutate] of fields) {
    const row = base();
    mutate(row);
    let message = '';
    try {
      renderTriageHtml({ schemaVersion: 1, entries: [row] }, { version: '0.0.1' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain(`${name} must be a finite number`);
  }
  expect(page.url()).toBe('about:blank');
  expect(httpUrls(urls)).toEqual([]);
});

test('escaped titles do not run', async ({ page }, testInfo) => {
  const { renderTriageHtml } = (await import('../dist/report/html.js')) as {
    renderTriageHtml: (report: unknown, options?: { version?: string }) => string;
  };
  const html = renderTriageHtml(
    {
      schemaVersion: 1,
      entries: [
        {
          id: '<script>alert(1)</script>',
          verdict: 'flaky',
          confidence: 'low',
          ruleId: 'FLAKY',
          signals: [{ kind: 'same-code-flip', detail: '"><img src=x onerror=alert(1)>' }],
          causes: [{ cause: 'unknown', confidence: 'low', evidence: ['back`tick'], ruleIds: ['UNK-NONE'] }],
          evidence: ['"><img src=x onerror=alert(1)>', 'back`tick', '</script><script>alert(2)</script>'],
          attempts: { total: 1, failed: 1, passed: 0, sameCommit: false },
          history: { runsSeen: 1, firstFailingCommit: null },
          suggestedFix: 'Read the quoted text.',
          healProposal: null,
          nextStep: 'Review the suggested fix. To see the test again, run: qa-core-flaky rerun --from report.json --only id',
          note: null,
          llm: null,
          review: { status: 'Needs Review', reviewer: null, decision: null },
        },
      ],
    },
    { version: '0.0.1' },
  );
  const file = testInfo.outputPath('xss.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  const urls = track(page);
  let dialog = false;
  page.on('dialog', () => {
    dialog = true;
  });
  await page.goto(pathToFileURL(file).href);
  await page.locator('summary').click();
  await expect(page.locator('pre')).toContainText('back`tick');
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('script').count()).toBe(1);
  expect(dialog).toBe(false);
  expect(httpUrls(urls)).toEqual([]);
});
