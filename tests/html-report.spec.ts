import fs from 'node:fs';
import path from 'node:path';
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

test('the report works offline in a browser', async ({ page, browserName }) => {
  const urls = track(page);
  await page.goto(reportUrl);
  await expect(page.getByRole('heading', { name: 'Triage Report', level: 1 })).toBeVisible();
  await expect(page.locator('[data-summary="tests"]')).toHaveText('6');
  await expect(page.locator('[data-summary="flaky"]')).toHaveText('6');
  await expect(page.locator('[data-summary="likely-real-bug"]')).toHaveText('0');
  await expect(page.locator('dt', { hasText: 'Commit' }).locator('xpath=following-sibling::dd[1]')).toHaveText('tonight');

  if (browserName === 'chromium') {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.screenshot({
      path: path.resolve('examples/triage.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({
      path: path.resolve('examples/triage-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  }

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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(reportUrl);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('table')).toBeVisible();
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
