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
    .replaceAll('"', '&quot;');
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
  assert.match(stamped, /<dt>Generated<\/dt><dd>26 Oct 2026, 18:07 UTC<\/dd>/);
  assert.equal(stamped.includes('<dt>Branch</dt>'), false);
  assert.equal(stamped.includes('<dt>Run Id</dt>'), false);
  assert.equal(stamped.includes('kit-1'), false);
  const poisoned = renderTriageHtml(report([], { generatedAt: '3"><meta http-equiv="refresh" content="0;url=https://evil.example/">' }), {
    version: '0.0.1',
  });
  assert.equal(poisoned.includes('http-equiv="refresh"'), false);
  assert.equal(poisoned.includes('<dt>Generated</dt>'), false);

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
  assert.equal(rerun.includes('<dt>Commit</dt>'), false);
  assert.match(rerun, /data-rerun="isolated"/);
  assert.match(rerun, /In Order: total 1, failed 1, passed 0/);
  assert.match(rerun, /In Order not run 2: could not select/);
  assert.match(rerun, /no flake observed in 3 runs/);
  assert.match(rerun, /Seen In 3 Runs/);
  assert.equal(rerun.includes('class="strip"'), false);
  assert.match(rerun, /Tests Flagged/);
  assert.equal(rerun.includes('Tests Seen'), false);
  assert.match(rerun, /Triage Tests/);
  assert.match(rerun, /<p class="note">/);
});

test('a commit is shown only when it is 7 to 40 hex characters', () => {
  const page = (detail) =>
    renderTriageHtml(
      report([
        entry({
          signals: [{ kind: 'same-code-flip', detail }],
        }),
      ]),
      { version: '0.0.1' },
    );
  const short = page('At least one pass and one fail share commit abcdef1.');
  assert.match(short, /<dt>Commit<\/dt><dd class="sha">abcdef1<\/dd>/);
  const longSha = 'ab'.repeat(20);
  const long = page(`At least one pass and one fail share commit ${longSha}.`);
  assert.match(long, /<dt>Commit<\/dt><dd class="sha">abababa<\/dd>/);
  assert.equal(long.includes(`<dd class="sha">${longSha}</dd>`), false);
  for (const detail of [
    'At least one pass and one fail share commit tonight.',
    'At least one pass and one fail share commit abc123.',
    'At least one pass and one fail share commit abc123g.',
    `At least one pass and one fail share commit ${'a'.repeat(41)}.`,
  ]) {
    assert.equal(page(detail).includes('<dt>Commit</dt>'), false, detail);
  }
});

test('kit sized reports stay under 300 KB at 200 entries and use a strict policy', () => {
  const kit = JSON.parse(fs.readFileSync(kitJson, 'utf8'));
  const copies = (count) =>
    Array.from({ length: count }, (_, index) => {
      const source = structuredClone(kit.entries[index % kit.entries.length]);
      source.id = `${source.id} #${index}`;
      return source;
    });
  const html = renderTriageHtml(report(copies(200)), { version: '0.0.1' });
  const bytes = Buffer.byteLength(html);
  const thousand = Buffer.byteLength(renderTriageHtml(report(copies(1000)), { version: '0.0.1' }));
  console.log(`html bytes 200 ${bytes}`);
  console.log(`html bytes 1000 ${thousand}`);
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

test('200 entries of every heal status stay under 300 KB', () => {
  const kit = JSON.parse(fs.readFileSync(kitJson, 'utf8'));
  const long = Array.from({ length: 40 }, (_, index) => `patched line ${index}`).join('\n');
  const statuses = [
    'proposed',
    'applied',
    'refused',
    'not-locator',
    'nothing-to-heal',
    'error',
    'unavailable',
    'skipped-by-gate',
  ];
  const codes = [
    'ambiguous-match',
    'element-changed',
    'strict-needs-human',
    'possible-real-bug',
    'weakens-test',
    'verification-failed',
    'baseline-not-reproduced',
    'no-safe-pattern',
    'ai-disabled',
    'ai-invalid-output',
    'ineligible-handoff',
    'navigation-or-network',
    'spec-not-found',
    'timeout',
  ];
  const margin = 5 * 1024;
  for (const status of statuses) {
    for (const code of codes) {
      const copies = Array.from({ length: 200 }, (_, index) => {
        const source = structuredClone(kit.entries[index % kit.entries.length]);
        source.id = `${source.id} #${index}`;
        source.healProposal = {
          contractVersion: 1,
          tool: 'qa-core-heal',
          toolVersion: '0.4.0',
          mode: 'dry-run',
          status,
          strategy: status === 'proposed' ? 'locator-heal' : 'none',
          fixRuleId: null,
          reviewLevel: 'standard',
          label: 'Proposal from qa-core-heal (dry run, not applied)',
          changes:
            status === 'proposed' || status === 'applied'
              ? [{ file: 'tests/broken.spec.ts', startLine: 4, endLine: 4, before: long, after: 'page.locator("#ok")' }]
              : [],
          explanation: 'One confident candidate.',
          refusal: { code, message: 'A person has to choose.' },
          verification: null,
          ai: { used: false, label: null, promptSha256: null },
          applyCommand: null,
        };
        return source;
      });
      const html = renderTriageHtml(report(copies), { version: '0.0.1' });
      const bytes = Buffer.byteLength(html);
      assert.equal(bytes < 307_200, true, `${status} ${code} is ${bytes} bytes`);
      assert.equal(307_200 - bytes >= margin, true, `${status} ${code} has ${307_200 - bytes} bytes of room`);
      assert.equal(html.includes('data-heal-refusal'), false, status);
      assert.equal(html.includes('baseline-not-reproduced'), false, status);
      assert.equal(html.includes('patched line 39'), false, status);
      assert.equal(html.includes('style="width:'), false, status);
    }
  }
});

test('the committed example has no machine paths or PR numbers', () => {
  const html = fs.readFileSync(kitHtml, 'utf8');
  for (const needle of ['/workspace', '/tmp/', '/home/', '/Users/', 'C:\\Users']) {
    assert.equal(html.includes(needle), false, needle);
  }
  assert.equal(/PR \d/.test(html), false);
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
  assert.match(html, /data-cause-count="timing">3</);
  assert.match(html, /data-cause-count="unknown">2</);
  assert.match(html, /data-cause-count="selectors">0</);
  assert.match(html, /data-cause-count="environment">1</);
  assert.match(html, /data-cause-count="test-data">0</);
  assert.match(html, /<dt>Commit<\/dt><dd class="sha">679e0bb<\/dd>/);
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  assert.match(html, new RegExp(`Generated by qa-core-flaky ${version}\\. Built by SprintSynergy\\.`));
  assert.match(html, /Tests Flagged/);
  assert.match(html, /Seen In 3 Runs/);
  assert.match(html, /Total 6, failed 3, passed 3\. Same code for a pass and a fail: yes\./);
  assert.match(html, /<button class="copy">Copy Command<\/button>/);
  assert.match(html, /Triage Tests/);
  for (const item of source.entries) {
    assert.equal(html.includes(`data-test="${escapeHtml(item.id)}"`), true, item.id);
    assert.equal(html.includes(`data-v="${item.verdict}"`), true, item.id);
    assert.equal(html.includes(`data-c="${item.causes[0].cause}"`), true, item.id);
    assert.equal(html.includes(`data-k="${item.confidence}"`), true, item.id);
    assert.equal(html.includes(`data-f="${item.attempts.failed}"`), true, item.id);
    assert.equal(html.includes(`data-n="${item.attempts.total}"`), true, item.id);
    assert.equal(html.includes(`data-r="${item.history.runsSeen}"`), true, item.id);
    for (const line of item.evidence) assert.equal(html.includes(escapeHtml(line)), true, line);
    for (const signal of item.signals) {
      assert.equal(html.includes(`data-signal="${signal.kind}"`), true, signal.kind);
      assert.equal(html.includes(escapeHtml(signal.detail)), true, signal.detail);
    }
    for (const finding of item.causes) {
      assert.equal(html.includes(escapeHtml(finding.ruleIds.join(', '))), true, finding.ruleIds.join(','));
    }
    assert.equal(html.includes(escapeHtml(item.suggestedFix)), true, item.id);
    const sameCode = item.attempts.sameCommit ? 'yes' : 'no';
    assert.equal(
      html.includes(
        `Total ${item.attempts.total}, failed ${item.attempts.failed}, passed ${item.attempts.passed}. Same code for a pass and a fail: ${sameCode}.`,
      ),
      true,
      item.id,
    );
    assert.equal(html.includes('<b>Attempts</b>'), true, item.id);
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

test('a count that is not a finite number throws and is not written', () => {
  const attack = '3"><meta http-equiv="refresh" content="0;url=https://evil.example/">';
  const fields = [
    ['attempts.total', (row) => { row.attempts.total = attack; }],
    ['attempts.failed', (row) => { row.attempts.failed = attack; }],
    ['attempts.passed', (row) => { row.attempts.passed = attack; }],
    ['history.runsSeen', (row) => { row.history.runsSeen = attack; }],
    ['attempts.reruns.repeat.total', (row) => { row.attempts.reruns = { repeat: { total: attack, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.repeat.failed', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: attack, passed: 0 } }; }],
    ['attempts.reruns.repeat.passed', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: 0, passed: attack } }; }],
    ['attempts.reruns.repeat.notRun', (row) => { row.attempts.reruns = { repeat: { total: 1, failed: 0, passed: 0, notRun: attack } }; }],
    ['attempts.reruns.isolated.total', (row) => { row.attempts.reruns = { isolated: { total: attack, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.isolated.failed', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: attack, passed: 0 } }; }],
    ['attempts.reruns.isolated.passed', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: 0, passed: attack } }; }],
    ['attempts.reruns.isolated.notRun', (row) => { row.attempts.reruns = { isolated: { total: 1, failed: 0, passed: 0, notRun: attack } }; }],
    ['attempts.reruns.in-order.total', (row) => { row.attempts.reruns = { 'in-order': { total: attack, failed: 0, passed: 0 } }; }],
    ['attempts.reruns.in-order.failed', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: attack, passed: 0 } }; }],
    ['attempts.reruns.in-order.passed', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: 0, passed: attack } }; }],
    ['attempts.reruns.in-order.notRun', (row) => { row.attempts.reruns = { 'in-order': { total: 1, failed: 0, passed: 0, notRun: attack } }; }],
  ];
  for (const [name, mutate] of fields) {
    const row = entry();
    mutate(row);
    assert.throws(() => renderTriageHtml(report([row]), { version: '0.0.1' }), new RegExp(`${name.replaceAll('.', '\\.')} must be a finite number`));
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const row = entry();
    row.attempts.total = value;
    assert.throws(() => renderTriageHtml(report([row]), { version: '0.0.1' }), /attempts\.total must be a finite number/);
  }
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
