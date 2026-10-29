/**
 * Write the example report screenshots.
 * `npm run test:html` does not call this, so an acceptance run leaves git clean.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { renderTriageHtml } from '../dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const report = path.join(root, 'examples/triage.html');
const shots = {
  light: path.join(root, 'examples/triage.png'),
  dark: path.join(root, 'examples/triage-dark.png'),
  mobile: path.join(root, 'examples/triage-mobile.png'),
  print: path.join(root, 'examples/triage-print.png'),
};

const browser = await chromium.launch();
const contrastDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-contrast-'));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const url = pathToFileURL(report).href;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', media: 'screen' });
  await page.goto(url);
  await page.screenshot({ path: shots.light, fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', media: 'screen' });
  await page.screenshot({ path: shots.dark, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', media: 'screen' });
  await page.screenshot({ path: shots.mobile, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.screenshot({ path: shots.print, fullPage: true, animations: 'disabled' });

  const sample = renderTriageHtml(contrastReport(), { version: '0.1.0' });
  const samplePath = path.join(contrastDir, 'badges.html');
  fs.writeFileSync(samplePath, sample);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', media: 'screen' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(pathToFileURL(samplePath).href);
  const light = await badgeContrast(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await badgeContrast(page);
  console.log(JSON.stringify({ light, dark }, null, 2));
} finally {
  await browser.close();
  fs.rmSync(contrastDir, { recursive: true, force: true });
}

function contrastReport() {
  const verdicts = ['likely-real-bug', 'broken-test', 'flaky', 'environment-issue', 'needs-more-runs'];
  return {
    schemaVersion: 1,
    entries: verdicts.map((verdict) => ({
      id: `tests/a.spec.ts::chromium::${verdict}`,
      verdict,
      confidence: 'low',
      ruleId: 'FLAKY',
      signals: [{ kind: 'same-code-flip', detail: 'At least one pass and one fail share the same code.' }],
      causes: [{ cause: 'unknown', confidence: 'low', evidence: ['Timeout'], ruleIds: ['UNK-NONE'] }],
      evidence: ['Timeout'],
      attempts: { total: 2, failed: 1, passed: 1, sameCommit: true },
      history: { runsSeen: 1, firstFailingCommit: null },
      suggestedFix: 'Read the quoted text.',
      healProposal: null,
      nextStep: 'Review the suggested fix.',
      note: null,
      llm: null,
      review: { status: 'Needs Review', reviewer: null, decision: null },
    })),
  };
}

async function badgeContrast(page) {
  return page.evaluate(() => {
    function channel(value) {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }
    function parse(color) {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!match) return null;
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
    }
    function luminance(color) {
      const rgb = parse(color);
      if (!rgb) return 0;
      return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
    }
    function ratio(fg, bg) {
      const left = luminance(fg);
      const right = luminance(bg);
      const lighter = Math.max(left, right);
      const darker = Math.min(left, right);
      return (lighter + 0.05) / (darker + 0.05);
    }
    function paintedBackground(node) {
      let current = node;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        const rgb = parse(color);
        if (rgb && rgb.a > 0.9) return color;
        current = current.parentElement;
      }
      return 'rgb(255, 255, 255)';
    }
    return Array.from(document.querySelectorAll('i[class^="b"]')).map((node) => {
      const fg = getComputedStyle(node).color;
      const bg = paintedBackground(node);
      const border = getComputedStyle(node).borderTopStyle;
      return {
        name: node.textContent,
        color: fg,
        background: bg,
        border,
        contrast: Number(ratio(fg, bg).toFixed(2)),
      };
    });
  });
}
