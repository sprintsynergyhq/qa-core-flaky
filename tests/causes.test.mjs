import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { classifyCauses, parseJunit, parsePlaywrightJson } from '../dist/index.js';

function readError(name) {
  return fs.readFileSync(`fixtures/errors/${name}`, 'utf8');
}

function failedRecord(errors, overrides = {}) {
  const attempts = overrides.attempts ?? [
    {
      retry: 0,
      status: 'failed',
      durationMs: 10,
      errors,
      attachments: [],
    },
  ];
  return {
    id: 'tests/causes.spec.ts::chromium::sample',
    file: 'tests/causes.spec.ts',
    project: 'chromium',
    titlePath: ['sample'],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts,
    source: { format: 'playwright-json', reportPath: 'fixture.json' },
    ...overrides,
    attempts,
  };
}

function messageRecord(text, extra = {}) {
  return failedRecord([{ message: text }], extra);
}

function causesOf(text, options) {
  return classifyCauses(messageRecord(text), options);
}

function causeNamed(findings, cause) {
  const found = findings.filter((finding) => finding.cause === cause);
  assert.equal(found.length, 1, `expected one ${cause} finding, got ${findings.map((item) => item.cause).join(', ')}`);
  return found[0];
}

function assertEvidence(record, findings) {
  const texts = [];
  for (const attempt of record.attempts) {
    for (const error of attempt.errors ?? []) {
      if (error.message) texts.push(error.message);
      if (error.stack) texts.push(error.stack);
    }
  }
  for (const finding of findings) {
    for (const item of finding.evidence) {
      assert.equal(item.length <= 300, true, item);
      assert.equal(
        texts.some((text) => text.includes(item)),
        true,
        `evidence is not a substring: ${item}`,
      );
    }
  }
}

test('SEL-STRICT matches the captured strict mode error', () => {
  const text = readError('sel-strict.txt');
  const findings = causesOf(text);
  const selectors = causeNamed(findings, 'selectors');
  assert.deepEqual(selectors.ruleIds, ['SEL-STRICT']);
  assert.equal(selectors.confidence, 'medium');
  assert.ok(selectors.evidence.some((item) => item.includes('strict mode violation')));
  assert.equal(findings.some((finding) => finding.cause === 'timing'), false);
});

test('SEL-NOTFOUND and SEL-ZERO match the captured not-found error', () => {
  const findings = causesOf(readError('sel-notfound.txt'));
  const selectors = causeNamed(findings, 'selectors');
  assert.deepEqual(selectors.ruleIds, ['SEL-NOTFOUND', 'SEL-ZERO']);
  assert.equal(selectors.confidence, 'medium');
  assert.ok(selectors.evidence.some((item) => item.includes('element(s) not found')));
});

test('SEL-UNRESOLVED matches a locator that timed out before resolving', () => {
  const findings = causesOf(readError('sel-unresolved.txt'));
  const selectors = causeNamed(findings, 'selectors');
  assert.deepEqual(selectors.ruleIds, ['SEL-UNRESOLVED']);
  assert.equal(selectors.confidence, 'medium');
  assert.ok(selectors.evidence.some((item) => item.includes("waiting for locator('#missing')")));
  assert.equal(findings.some((finding) => finding.cause === 'timing'), false);
});

test('SEL-ZERO matches a count assertion that resolved to zero elements', () => {
  const findings = causesOf(readError('sel-zero.txt'));
  const selectors = causeNamed(findings, 'selectors');
  assert.deepEqual(selectors.ruleIds, ['SEL-UNRESOLVED', 'SEL-ZERO']);
  assert.equal(selectors.confidence, 'medium');
  assert.ok(selectors.evidence.some((item) => item.includes('locator resolved to 0 elements')));
});

test('TIM-EXPECT-TIMEOUT matches a resolved element that stayed hidden', () => {
  const findings = causesOf(readError('tim-expect-timeout.txt'));
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(timing.ruleIds, ['TIM-EXPECT-TIMEOUT']);
  assert.equal(timing.confidence, 'medium');
  assert.ok(timing.evidence.some((item) => item.includes('unexpected value "hidden"')));
  assert.equal(findings.some((finding) => finding.cause === 'selectors'), false);
});

test('TIM-EXPECT-TIMEOUT matches Timeout exceeded on a resolved expect', () => {
  const text = [
    'Error: expect(locator).toBeVisible() failed',
    'Timeout 2000ms exceeded.',
    'Call log:',
    "  - waiting for locator('#go')",
    '    - locator resolved to <button id="go">Go</button>',
  ].join('\n');
  const findings = causesOf(text);
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(timing.ruleIds, ['TIM-EXPECT-TIMEOUT']);
  assert.ok(timing.evidence.some((item) => item.includes('Timeout 2000ms exceeded.')));
  assert.equal(findings.some((finding) => finding.cause === 'selectors'), false);
});

test('TIM-TEST-TIMEOUT matches the captured test timeout and the unresolved locator', () => {
  const findings = causesOf(readError('tim-test-timeout.txt'));
  const selectors = causeNamed(findings, 'selectors');
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(selectors.ruleIds, ['SEL-UNRESOLVED']);
  assert.deepEqual(timing.ruleIds, ['TIM-TEST-TIMEOUT']);
  assert.equal(selectors.confidence, 'medium');
  assert.equal(timing.confidence, 'medium');
  assert.ok(timing.evidence.some((item) => item.includes('Test timeout of 800ms exceeded.')));
  assert.deepEqual(
    findings.map((finding) => finding.cause),
    ['selectors', 'timing'],
  );
});

test('TIM-INTERCEPT is timing and not selectors', () => {
  const findings = causesOf(readError('tim-intercept.txt'));
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(timing.ruleIds, ['TIM-INTERCEPT']);
  assert.equal(timing.confidence, 'medium');
  assert.ok(timing.evidence.some((item) => item.includes('intercepts pointer events')));
  assert.equal(findings.some((finding) => finding.cause === 'selectors'), false);
});

test('TIM-NEAR-TIMEOUT is low when it is the only rule', () => {
  const near = classifyCauses(messageRecord('Error: gave up', { attempts: [attempt(900, 'Error: gave up')] }), {
    testTimeoutMs: 1000,
  });
  assert.equal(near.length, 1);
  assert.equal(near[0].cause, 'timing');
  assert.deepEqual(near[0].ruleIds, ['TIM-NEAR-TIMEOUT']);
  assert.equal(near[0].confidence, 'low');
  assert.deepEqual(near[0].evidence, []);

  const below = classifyCauses(messageRecord('Error: gave up', { attempts: [attempt(899, 'Error: gave up')] }), {
    testTimeoutMs: 1000,
  });
  assert.equal(below.length, 1);
  assert.equal(below[0].cause, 'unknown');
});

test('TIM-NEAR-TIMEOUT plus a test timeout stays medium', () => {
  const text = 'Test timeout of 1000ms exceeded.';
  const findings = classifyCauses(messageRecord(text, { attempts: [attempt(950, text)] }), { testTimeoutMs: 1000 });
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(timing.ruleIds, ['TIM-TEST-TIMEOUT', 'TIM-NEAR-TIMEOUT']);
  assert.equal(timing.confidence, 'medium');
});

test('TIM-NEAR-TIMEOUT plus an expect timeout is high', () => {
  const text = [
    'Error: expect(locator).toBeVisible() failed',
    'Timeout 2000ms exceeded.',
    'Call log:',
    "  - waiting for locator('#go')",
    '    - locator resolved to <button id="go">Go</button>',
  ].join('\n');
  const findings = classifyCauses(messageRecord(text, { attempts: [attempt(950, text)] }), { testTimeoutMs: 1000 });
  const timing = causeNamed(findings, 'timing');
  assert.deepEqual(timing.ruleIds, ['TIM-EXPECT-TIMEOUT', 'TIM-NEAR-TIMEOUT']);
  assert.equal(timing.confidence, 'high');
});

test('DATA-VALUE-DRIFT quotes both received lines', () => {
  const first = readError('data-value-1.txt');
  const second = readError('data-value-2.txt');
  const record = failedRecord([], {
    attempts: [attempt(10, first, 0), attempt(10, second, 1)],
  });
  const findings = classifyCauses(record);
  const data = causeNamed(findings, 'test-data');
  assert.deepEqual(data.ruleIds, ['DATA-VALUE-DRIFT']);
  assert.equal(data.confidence, 'high');
  assert.ok(data.evidence.includes('Received: "1"'));
  assert.ok(data.evidence.includes('Received: "2"'));
  assert.equal(findings.some((finding) => finding.cause === 'selectors'), false);
  assert.equal(findings.some((finding) => finding.cause === 'unknown'), false);
});

test('DATA-ALREADY-EXISTS matches duplicate, unique constraint, and already exists', () => {
  const captured = causesOf(readError('data-already-exists.txt'));
  const data = causeNamed(captured, 'test-data');
  assert.deepEqual(data.ruleIds, ['DATA-ALREADY-EXISTS']);
  assert.equal(data.confidence, 'medium');
  for (const phrase of ['duplicate key', 'Already Exists', 'UNIQUE CONSTRAINT failed']) {
    const findings = causesOf(`Error: ${phrase}`);
    assert.deepEqual(causeNamed(findings, 'test-data').ruleIds, ['DATA-ALREADY-EXISTS']);
  }
});

test('titles, source frames, headers, and assertion lines do not choose a cause', () => {
  const benign = 'Error: the cart total was not a number';
  const header = `  [chromium] \u203A tests/a.spec.ts:21:1 \u203A rejects duplicate emails ${'\u2500'.repeat(8)}`;
  const httpHeader = `  [chromium] \u203A tests/a.spec.ts:21:1 \u203A loads the 503 Service Unavailable page ${'\u2500'.repeat(8)}`;
  const inputs = [
    `${benign}\n  21 | test('rejects duplicate emails', async ({ page }) => {`,
    `${benign}\n> 21 | test('rejects duplicate emails', async ({ page }) => {`,
    `${benign}\n     |                                                               ^`,
    `${benign}\n    at rejects duplicate emails (tests/a.spec.ts:21:1)`,
    `${benign}\n${header}`,
    `${benign}\n  21 | test('loads the 503 Service Unavailable page', async ({ page }) => {`,
    `${benign}\n${httpHeader}`,
    `${benign}\nLocator: getByRole('button', { name: 'Email already exists' })`,
    `${benign}\n  - waiting for getByRole('button', { name: 'Email already exists' })`,
    `${benign}\n    - locator resolved to <button>Email already exists</button>`,
    `${benign}\nExpected: "already exists"`,
    `${benign}\nExpected: "503 Service Unavailable"`,
    `${benign}\nLocator: getByRole('button', { name: '503 Service Unavailable' })`,
    `${benign}\n  - waiting for getByRole('button', { name: '503 Service Unavailable' })`,
    `${benign}\n    - locator resolved to <div>503 Service Unavailable</div>`,
    `${benign}\nExpected: "ECONNREFUSED"`,
    `${benign}\nLocator: getByRole('button', { name: 'ECONNREFUSED' })`,
    `${benign}\n  - waiting for getByRole('button', { name: 'socket hang up' })`,
    `${benign}\n    - locator resolved to <div>net::ERR_CONNECTION_REFUSED</div>`,
    "  21 | test('rejects duplicate emails', async ({ page }) => {",
  ];
  for (const text of inputs) {
    const findings = causesOf(text);
    assert.equal(findings.length, 1, text);
    assert.equal(findings[0].cause, 'unknown', text);
    assert.deepEqual(findings[0].ruleIds, ['UNK-NONE'], text);
  }

  const stillData = causesOf(
    "Locator: getByRole('button', { name: 'Email already exists' })\nError: duplicate key value violates unique constraint",
  );
  const data = causeNamed(stillData, 'test-data');
  assert.deepEqual(data.ruleIds, ['DATA-ALREADY-EXISTS']);
  assert.equal(data.evidence.some((item) => item.includes('Locator:')), false);

  const stillHttp = causesOf('Expected: "503 Service Unavailable"\nError: apiRequestContext.get: 503 Service Unavailable');
  const http = causeNamed(stillHttp, 'environment');
  assert.deepEqual(http.ruleIds, ['ENV-HTTP5XX']);
  assert.equal(http.evidence.some((item) => item.startsWith('Expected:')), false);
});

test('two selector rules on different lines are high', () => {
  const text = [
    "Error: strict mode violation: getByRole('button') resolved to 2 elements",
    'Error: element(s) not found',
  ].join('\n');
  const findings = causesOf(text);
  const selectors = causeNamed(findings, 'selectors');
  assert.deepEqual(selectors.ruleIds, ['SEL-STRICT', 'SEL-NOTFOUND']);
  assert.equal(selectors.confidence, 'high');
});

test('a long line does not stall intercept detection', () => {
  const text = `${'a'.repeat(80000)}\nError: gave up`;
  const started = Date.now();
  const findings = causesOf(text);
  assert.equal(Date.now() - started < 1000, true);
  assert.equal(findings[0].cause, 'unknown');
});

test('UNK-NONE evidence is clipped to 300 characters', () => {
  const line = 'E'.repeat(1020);
  const findings = causesOf(line);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].ruleIds, ['UNK-NONE']);
  assert.equal(findings[0].evidence.length, 1);
  assert.equal(findings[0].evidence[0].length, 300);
  assert.equal(line.startsWith(findings[0].evidence[0]), true);
});

test('indented Expected and Received lines still count as value drift', () => {
  const first = [
    'expect(locator).toHaveText(expected) failed',
    "    Locator: locator('#n')",
    '    Expected: "9"',
    '    Received: "1"',
  ].join('\n');
  const second = [
    'expect(locator).toHaveText(expected) failed',
    "    Locator: locator('#n')",
    '    Expected: "9"',
    '    Received: "2"',
  ].join('\n');
  const findings = classifyCauses(
    failedRecord([], { attempts: [attempt(10, first, 0), attempt(10, second, 1)] }),
  );
  const data = causeNamed(findings, 'test-data');
  assert.deepEqual(data.ruleIds, ['DATA-VALUE-DRIFT']);
  assert.equal(data.confidence, 'high');
  assert.ok(data.evidence.some((item) => item.includes('Received: "1"')));
  assert.ok(data.evidence.some((item) => item.includes('Received: "2"')));
});

test('the order dependency hook adds DATA-ORDER and ignores text that is not evidence', () => {
  const record = messageRecord('Error: order changed the cart badge');
  const kept = classifyCauses(record, {
    orderDependency: () => ['order changed', 'not in the error'],
  });
  const data = causeNamed(kept, 'test-data');
  assert.deepEqual(data.ruleIds, ['DATA-ORDER']);
  assert.deepEqual(data.evidence, ['order changed']);

  const dropped = classifyCauses(record, { orderDependency: () => ['not in the error'] });
  assert.equal(dropped[0].cause, 'unknown');
});

test('ENV-NET matches the captured closed-port error and the other net phrases', () => {
  const findings = causesOf(readError('env-net.txt'));
  const environment = causeNamed(findings, 'environment');
  assert.deepEqual(environment.ruleIds, ['ENV-NET']);
  assert.equal(environment.confidence, 'medium');
  assert.ok(environment.evidence.some((item) => item.includes('net::ERR_CONNECTION_REFUSED')));
  for (const phrase of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'socket hang up']) {
    const match = causesOf(`Error: connect ${phrase}`);
    assert.deepEqual(causeNamed(match, 'environment').ruleIds, ['ENV-NET']);
  }
});

test('ENV-HTTP5XX matches a 503 and ignores durations and expected values', () => {
  const findings = causesOf(readError('env-http.txt'));
  const environment = causeNamed(findings, 'environment');
  assert.deepEqual(environment.ruleIds, ['ENV-HTTP5XX']);
  assert.ok(environment.evidence.some((item) => item.includes('503 Service Unavailable')));
  assert.equal(causesOf('Timeout: 5000ms exceeded while waiting')[0].cause, 'unknown');
  assert.equal(causesOf('Expected: 512\nReceived: 1')[0].cause, 'unknown');
  const status = causesOf('Error: status 500 Internal Server Error');
  assert.deepEqual(causeNamed(status, 'environment').ruleIds, ['ENV-HTTP5XX']);
});

test('ENV-BROWSER matches launch and a closed browser with no locator evidence', () => {
  const launch = causesOf(readError('env-browser-launch.txt'));
  assert.deepEqual(causeNamed(launch, 'environment').ruleIds, ['ENV-BROWSER']);
  const closed = causesOf(readError('env-browser-closed.txt'));
  assert.deepEqual(causeNamed(closed, 'environment').ruleIds, ['ENV-BROWSER']);
  assert.equal(closed.some((finding) => finding.cause === 'selectors'), false);
});

test('a closed browser with locator evidence is selectors and not environment', () => {
  const text = [
    'Error: locator.click: Target page, context or browser has been closed',
    'Call log:',
    "  - waiting for locator('#go')",
    'Timeout 1000ms exceeded.',
  ].join('\n');
  const findings = causesOf(text);
  assert.deepEqual(causeNamed(findings, 'selectors').ruleIds, ['SEL-UNRESOLVED']);
  assert.equal(findings.some((finding) => finding.cause === 'environment'), false);
});

test('a resolved locator value mismatch is unknown, not selectors', () => {
  const text = readError('data-value-1.txt');
  const record = messageRecord(text);
  const findings = classifyCauses(record);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].cause, 'unknown');
  assert.deepEqual(findings[0].ruleIds, ['UNK-NONE']);
  assert.equal(findings[0].confidence, 'low');
  assert.ok(findings[0].evidence.includes('Expected: "9"'));
  assert.ok(findings[0].evidence.includes('Received: "1"'));
  assertEvidence(record, findings);
});

test('a message matching no rule gives exactly one unknown finding', () => {
  const record = messageRecord('Error: the cart total was not a number');
  const findings = classifyCauses(record);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].cause, 'unknown');
  assert.deepEqual(findings[0].ruleIds, ['UNK-NONE']);
  assert.ok(findings[0].evidence.some((item) => item.includes('the cart total was not a number')));
  assertEvidence(record, findings);
});

test('an empty failure does not throw and is an explicit unknown', () => {
  const record = failedRecord([]);
  const findings = classifyCauses(record);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    cause: 'unknown',
    confidence: 'low',
    evidence: [],
    ruleIds: ['UNK-EMPTY'],
  });
  const blank = failedRecord([{ message: '   ', stack: '' }]);
  assert.deepEqual(classifyCauses(blank)[0].ruleIds, ['UNK-EMPTY']);
  assert.doesNotThrow(() => classifyCauses(failedRecord([{ message: undefined, stack: undefined }])));
});

test('JUnit stack is read when the message attribute is only a summary', () => {
  const stack = readError('sel-strict.txt');
  const record = failedRecord([
    { message: 'expect(locator).toHaveText(expected) failed', stack },
  ]);
  const findings = classifyCauses(record);
  const selectors = causeNamed(findings, 'selectors');
  assert.ok(selectors.evidence.some((item) => item.includes('strict mode violation')));
  assert.equal(record.attempts[0].errors[0].message.includes('strict mode violation'), false);
  assertEvidence(record, findings);
});

test('a parsed empty JUnit failure classifies as unknown', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="empty" classname="a.spec.ts"><failure/></testcase>
    <testcase name="blank" classname="a.spec.ts"><failure><![CDATA[]]></failure></testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/empty-failure.xml');
  for (const record of result.records) {
    const findings = classifyCauses(record);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].ruleIds, ['UNK-EMPTY']);
  }
});

test('a parsed JUnit summary plus stack still sees the stack', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="strict" classname="a.spec.ts">
      <failure message="expect(locator).toHaveText(expected) failed"><![CDATA[Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Remove' }) resolved to 2 elements:]]></failure>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/stack-evidence.xml');
  const record = result.records[0];
  assert.equal(record.attempts[0].errors[0].message.includes('strict mode violation'), false);
  const findings = classifyCauses(record);
  assert.ok(causeNamed(findings, 'selectors').evidence.some((item) => item.includes('strict mode violation')));
});

test('the same rule on every failed attempt is high, and one attempt is medium', () => {
  const text = readError('sel-strict.txt');
  const once = causesOf(text);
  assert.equal(causeNamed(once, 'selectors').confidence, 'medium');
  const twice = classifyCauses(
    failedRecord([], { attempts: [attempt(10, text, 0), attempt(10, text, 1)] }),
  );
  assert.equal(causeNamed(twice, 'selectors').confidence, 'high');
});

test('findings sort by confidence and then by cause', () => {
  const strict = readError('sel-strict.txt');
  const net = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:54321/';
  const findings = classifyCauses(
    failedRecord([], {
      attempts: [attempt(10, strict, 0), attempt(10, `${strict}\n${net}`, 1)],
    }),
  );
  assert.equal(findings[0].cause, 'selectors');
  assert.equal(findings[0].confidence, 'high');
  assert.equal(findings[1].cause, 'environment');
  assert.equal(findings[1].confidence, 'medium');
});

test('passed attempts are ignored', () => {
  const record = failedRecord([], {
    attempts: [
      attempt(10, readError('sel-strict.txt'), 0, 'passed'),
      attempt(10, 'Error: page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:9/', 1, 'failed'),
    ],
  });
  const findings = classifyCauses(record);
  assert.deepEqual(findings.map((finding) => finding.cause), ['environment']);
});

test('evidence strings are substrings and the result is stable', () => {
  const names = [
    'sel-strict.txt',
    'sel-notfound.txt',
    'sel-unresolved.txt',
    'sel-zero.txt',
    'tim-expect-timeout.txt',
    'tim-test-timeout.txt',
    'tim-intercept.txt',
    'data-value-1.txt',
    'data-already-exists.txt',
    'env-net.txt',
    'env-http.txt',
    'env-browser-launch.txt',
    'env-browser-closed.txt',
  ];
  for (const name of names) {
    const record = messageRecord(readError(name));
    const first = classifyCauses(record);
    const second = classifyCauses(record);
    assert.deepEqual(first, second, name);
    assertEvidence(record, first);
  }
});

test('the outcomes fixture classifies value mismatch as unknown and the timeout as timing', () => {
  const parsed = parsePlaywrightJson(
    fs.readFileSync('fixtures/reports/pw-1.60.0-outcomes.json', 'utf8'),
    'fixtures/reports/pw-1.60.0-outcomes.json',
  );
  const alwaysFails = parsed.records.find((record) => record.titlePath.at(-1) === 'always fails');
  const timedOut = parsed.records.find((record) => record.titlePath.at(-1) === 'times out');
  const failedFindings = classifyCauses(alwaysFails);
  assert.equal(failedFindings.length, 1);
  assert.equal(failedFindings[0].cause, 'unknown');
  assert.ok(failedFindings[0].evidence.some((item) => item.includes('Received: "Ready"')));
  const timeoutFindings = classifyCauses(timedOut);
  assert.ok(timeoutFindings.some((finding) => finding.ruleIds.includes('TIM-TEST-TIMEOUT')));
  assert.equal(JSON.stringify(timeoutFindings), JSON.stringify(classifyCauses(timedOut)));
});

function attempt(durationMs, message, retry = 0, status = 'failed') {
  return {
    retry,
    status,
    durationMs,
    errors: [{ message }],
    attachments: [],
  };
}
