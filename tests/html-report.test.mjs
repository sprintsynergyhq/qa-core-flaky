import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderTriageHtml, writeTriageHtml } from '../dist/index.js';

const cli = 'dist/cli.js';
const fixture = 'fixtures/reports/pw-1.60.0-outcomes.json';
const kitJson = 'fixtures/reports/saucedemo-kit-triage.json';
const kitHtml = 'examples/triage.html';

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function oneLine(text) {
  const trimmed = text.replace(/\n$/, '');
  return !trimmed.includes('\n');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function entry(overrides = {}) {
  return {
    id: 'tests/a.spec.ts::chromium::title',
    verdict: 'flaky',
    confidence: 'low',
    ruleId: 'FLAKY',
    signals: [{ kind: 'same-code-flip', detail: 'At least one pass and one fail share the same code.' }],
    causes: [
      {
        cause: 'timing',
        confidence: 'low',
        evidence: ['Timeout 1000ms exceeded'],
        ruleIds: ['TIM-EXPECT-TIMEOUT'],
      },
    ],
    evidence: ['Timeout 1000ms exceeded'],
    attempts: { total: 2, failed: 1, passed: 1, sameCommit: true },
    history: { runsSeen: 1, firstFailingCommit: null },
    suggestedFix: 'Wait for what the user sees.',
    healProposal: null,
    nextStep:
      "Review the suggested fix. To see the test again, run: qa-core-flaky rerun --from 'report.json' --only 'tests/a.spec.ts::chromium::title'",
    note: null,
    llm: null,
    review: { status: 'Needs Review', reviewer: null, decision: null },
    ...overrides,
  };
}

function report(entries, extra = {}) {
  return { schemaVersion: 1, entries, ...extra };
}

test('html is byte stable and escapes untrusted text', () => {
  const source = report([
    entry({
      id: '<script>alert(1)</script>',
      evidence: ['"><img src=x onerror=alert(1)>', 'back`tick', '</script><script>alert(2)</script>'],
      suggestedFix: 'Do not run `rm -rf`.',
      signals: [{ kind: 'same-code-flip', detail: 'title <script> and `tick`' }],
    }),
  ]);
  const first = renderTriageHtml(source, { version: '0.0.1' });
  const second = renderTriageHtml(source, { version: '0.0.1' });
  assert.equal(first, second);
  assert.equal(first.includes('<script>alert'), false);
  assert.equal(first.includes('<img'), false);
  assert.equal(first.includes('onerror='), true);
  assert.match(first, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(first, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(first, /back`tick/);
  assert.equal(first.match(/<script/g)?.length, 1);
  assert.equal(source.entries[0].id, '<script>alert(1)</script>');
});

test('html redaction hides home usernames unless opted out', () => {
  const source = report([
    entry({
      id: 'tests/a.spec.ts::chromium::/home/alice/proj',
      evidence: ['open /home/alice/proj/a.spec.ts and /Users/bob/x'],
      nextStep:
        "Review the suggested fix. To see the test again, run: qa-core-flaky rerun --from '/home/alice/report.json' --only 'id'",
    }),
  ]);
  const hidden = renderTriageHtml(source, { version: '0.0.1' });
  const shown = renderTriageHtml(source, { version: '0.0.1', redact: false });
  assert.equal(hidden.includes('alice'), false);
  assert.equal(hidden.includes('bob'), false);
  assert.match(hidden, /&lt;home&gt;/);
  assert.match(shown, /\/home\/alice\/proj/);
  assert.match(shown, /\/Users\/bob\/x/);
  assert.equal(source.entries[0].evidence[0].includes('alice'), true);
});

test('html shows only counts from the report, including an empty report', () => {
  const empty = renderTriageHtml(report([]), { version: '0.0.1' });
  assert.match(empty, /No Entries/);
  assert.match(empty, /No Causes/);
  assert.match(empty, /data-summary="tests">0</);
  assert.match(empty, /data-summary="flaky">0</);
  assert.equal(empty.includes('<table'), false);

  const stamped = renderTriageHtml(report([], { generatedAt: '2026-10-26T18:07:00.000Z', branch: 'main', runId: 'kit-1' }), {
    version: '0.0.1',
  });
  assert.match(stamped, /<dt>Generated<\/dt><dd>2026-10-26T18:07:00.000Z<\/dd>/);
  assert.match(stamped, /<dt>Branch<\/dt><dd>main<\/dd>/);
  assert.match(stamped, /<dt>Run Id<\/dt><dd>kit-1<\/dd>/);

  const rerun = renderTriageHtml(
    report([
      entry({
        history: { runsSeen: 3, firstFailingCommit: null },
        attempts: {
          total: 4,
          failed: 1,
          passed: 3,
          sameCommit: true,
          reruns: {
            isolated: { total: 3, failed: 0, passed: 3 },
            'in-order': { total: 1, failed: 1, passed: 0, notRun: 2 },
          },
        },
        observation: 'no flake observed in 3 runs',
        signals: [{ kind: 'same-code-flip', detail: 'At least one pass and one fail share commit tonight.' }],
      }),
    ]),
    { version: '0.0.1' },
  );
  assert.match(rerun, /data-summary="tests">1</);
  assert.match(rerun, /data-summary="flaky">1</);
  assert.match(rerun, /data-summary="likely-real-bug">0</);
  assert.match(rerun, /data-cause-count="timing">1</);
  assert.match(rerun, /data-cause-count="selectors">0</);
  assert.match(rerun, /<dt>Commit<\/dt><dd>tonight<\/dd>/);
  assert.match(rerun, /data-rerun="isolated"/);
  assert.match(rerun, /In Order: total 1, failed 1, passed 0/);
  assert.match(rerun, /In Order not run 2: could not select/);
  assert.match(rerun, /no flake observed in 3 runs/);
  assert.match(rerun, /Runs Seen: 3/);
  assert.equal(rerun.match(/<ol class="strip"[^>]*>((?:<li><\/li>)*)<\/ol>/)?.[1].match(/<li>/g)?.length, 3);
});

test('two hundred entries stay under 300 KB and use a strict policy', () => {
  const entries = Array.from({ length: 200 }, (_, index) =>
    entry({
      id: `tests/file.spec.ts::chromium::case ${index}`,
      verdict: index % 5 === 0 ? 'likely-real-bug' : 'flaky',
      evidence: [`Expected: "${index}"`, 'Received: "no"'],
      history: { runsSeen: 1, firstFailingCommit: null },
    }),
  );
  const html = renderTriageHtml(report(entries), { version: '0.0.1' });
  const bytes = Buffer.byteLength(html);
  assert.equal(bytes < 300 * 1024, true, `html is ${bytes} bytes`);
  assert.match(html, /data-summary="tests">200</);
  const style = html.match(/<style>([\s\S]*)<\/style>/);
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  const policy = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(style?.[1]);
  assert.ok(script?.[1]);
  assert.ok(policy?.[1]);
  const styleHash = createHash('sha256').update(style[1], 'utf8').digest('base64');
  const scriptHash = createHash('sha256').update(script[1], 'utf8').digest('base64');
  assert.equal(policy[1].includes(`style-src 'sha256-${styleHash}'`), true);
  assert.equal(policy[1].includes(`script-src 'sha256-${scriptHash}'`), true);
  assert.match(policy[1], /default-src 'none'/);
  assert.match(policy[1], /connect-src 'none'/);
  assert.equal(policy[1].includes('unsafe-inline'), false);
  assert.equal(/<(?:script|link|img)[^>]+(?:src|href)\s*=\s*["']https?:/i.test(html), false);
  assert.equal(html.includes('\u2014') || html.includes('\u2013'), false);
});

test('the SauceDemo example is the rendered kit triage', () => {
  const source = JSON.parse(fs.readFileSync(kitJson, 'utf8'));
  const html = renderTriageHtml(source);
  const plain = renderTriageHtml(source, { redact: false });
  assert.equal(html, fs.readFileSync(kitHtml, 'utf8'));
  assert.equal(html, plain);
  assert.equal(html.includes('/home/'), false);
  assert.equal(html.includes('/Users/'), false);
  assert.equal(html.includes('\u2014') || html.includes('\u2013'), false);
  assert.match(html, /data-summary="tests">6</);
  assert.match(html, /data-summary="flaky">6</);
  assert.match(html, /data-summary="likely-real-bug">0</);
  assert.match(html, /data-summary="needs-more-runs">0</);
  assert.match(html, /data-cause-count="timing">2</);
  assert.match(html, /data-cause-count="unknown">2</);
  assert.match(html, /data-cause-count="selectors">1</);
  assert.match(html, /data-cause-count="environment">1</);
  assert.match(html, /data-cause-count="test-data">0</);
  assert.match(html, /<dt>Commit<\/dt><dd>tonight<\/dd>/);
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  assert.match(html, new RegExp(`Generated by qa-core-flaky ${version}`));
  for (const item of source.entries) {
    assert.equal(html.includes(escapeHtml(item.id)), true, item.id);
    assert.equal(html.includes(`data-verdict="${item.verdict}"`), true, item.id);
    assert.equal(html.includes(`data-cause="${item.causes[0].cause}"`), true, item.id);
    assert.equal(html.includes(`data-confidence="${item.confidence}"`), true, item.id);
    assert.equal(html.includes(`data-failed="${item.attempts.failed}"`), true, item.id);
    assert.equal(html.includes(`data-total="${item.attempts.total}"`), true, item.id);
    assert.equal(html.includes(`data-runs="${item.history.runsSeen}"`), true, item.id);
    assert.equal(html.includes(`data-rule="${item.ruleId}"`), true, item.id);
    for (const line of item.evidence) assert.equal(html.includes(escapeHtml(line)), true, line);
    for (const signal of item.signals) {
      assert.equal(html.includes(`data-signal="${signal.kind}"`), true, signal.kind);
      assert.equal(html.includes(escapeHtml(signal.detail)), true, signal.detail);
    }
    for (const finding of item.causes) {
      assert.equal(html.includes(escapeHtml(finding.ruleIds.join(', '))), true, finding.ruleIds.join(','));
    }
    assert.equal(html.includes(escapeHtml(item.suggestedFix)), true, item.id);
    assert.equal(html.includes(`passed ${item.attempts.passed}`), true, item.id);
    assert.match(html, new RegExp(`Review Status: ${item.review.status}\\.`));
    const command = item.nextStep.slice(item.nextStep.indexOf('qa-core-flaky rerun '));
    assert.equal(html.includes(escapeHtml(command)), true, command);
  }
});

test('triage --html writes triage.html and leaves json and markdown unchanged', (t) => {
  const dir = keepTemp(t, 'triage-html-');
  const result = run(['triage', fixture, '--out-dir', dir, '--html', '--fail-on', 'never']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'), fs.readFileSync('fixtures/reports/golden/triage.json', 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'triage.md'), 'utf8'), fs.readFileSync('fixtures/reports/golden/triage.md', 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'triage.html'), 'utf8');
  assert.match(html, /always fails/);
  assert.match(html, /Content-Security-Policy/);
  assert.equal(html.includes('/home/'), false);
  const again = keepTemp(t, 'triage-html-plain-');
  const plain = run(['triage', fixture, '--out-dir', again, '--html', '--html-no-redact', '--fail-on', 'never']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(fs.readFileSync(path.join(again, 'triage.html'), 'utf8'), html);
});

test('html flags are rejected when they cannot be applied', () => {
  const missingDir = run(['triage', fixture, '--html', '--fail-on', 'never']);
  assert.equal(missingDir.status, 1);
  assert.match(missingDir.stderr, /--html needs --out-dir/);
  assert.equal(oneLine(missingDir.stderr), true);
  const bare = run(['triage', fixture, '--html-no-redact', '--fail-on', 'never']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--html-no-redact requires --html/);
  const parse = run(['parse', fixture, '--html']);
  assert.equal(parse.status, 1);
  assert.match(parse.stderr, /--html is only valid for triage and rerun/);
  const causes = run(['causes', fixture, '--html-no-redact']);
  assert.equal(causes.status, 1);
  assert.match(causes.stderr, /--html is only valid for triage and rerun/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--html/);
  assert.match(help.stdout, /--html-no-redact/);
});

test('a directory named triage.html does not remove the json pair', (t) => {
  const dir = keepTemp(t, 'triage-html-dir-');
  fs.mkdirSync(path.join(dir, 'triage.html'));
  const result = run(['triage', fixture, '--out-dir', dir, '--html', '--fail-on', 'never']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(oneLine(result.stderr), true);
  assert.equal(fs.statSync(path.join(dir, 'triage.html')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'), fs.readFileSync('fixtures/reports/golden/triage.json', 'utf8'));
  assert.equal(fs.existsSync(path.join(dir, 'triage.md')), true);
});

test('rerun --html writes a page when no command runs', (t) => {
  const dir = keepTemp(t, 'rerun-html-src-');
  const out = keepTemp(t, 'rerun-html-out-');
  const reportPath = path.join(dir, 'pass.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'ok',
              file: 'a.spec.ts',
              tests: [
                {
                  projectName: 'chromium',
                  expectedStatus: 'passed',
                  status: 'expected',
                  results: [{ retry: 0, status: 'passed', duration: 1, errors: [] }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const result = run(['rerun', '--from', reportPath, '--out-dir', out, '--html', '--fail-on', 'never']);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(out, 'triage.html'), 'utf8');
  assert.match(html, /No Entries/);
  assert.equal(fs.existsSync(path.join(out, 'triage.json')), true);
});

test('writeTriageHtml replaces a file and refuses a directory', (t) => {
  const dir = keepTemp(t, 'write-html-');
  writeTriageHtml(dir, '<p>one</p>\n');
  assert.equal(fs.readFileSync(path.join(dir, 'triage.html'), 'utf8'), '<p>one</p>\n');
  writeTriageHtml(dir, '<p>two</p>\n');
  assert.equal(fs.readFileSync(path.join(dir, 'triage.html'), 'utf8'), '<p>two</p>\n');
  fs.rmSync(path.join(dir, 'triage.html'));
  fs.mkdirSync(path.join(dir, 'triage.html'));
  assert.throws(() => writeTriageHtml(dir, '<p>no</p>\n'), /triage\.html must be a file/);
  assert.equal(fs.statSync(path.join(dir, 'triage.html')).isDirectory(), true);
});
