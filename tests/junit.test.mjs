import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { detectFormat, parseJunit, parsePlaywrightJson } from '../dist/index.js';

const jsonPath = 'fixtures/reports/pw-1.60.0-outcomes.json';
const junitPath = 'fixtures/reports/pw-1.60.0-outcomes.junit.xml';
const genericPath = 'fixtures/reports/junit-generic.xml';
const NO_ATTEMPT =
  'junit report has no per-attempt data; flaky detection needs the JSON report or reruns';

function byTitle(records, title) {
  const found = records.filter((record) => record.titlePath.at(-1) === title);
  assert.equal(found.length, 1, `expected one record titled ${title}`);
  return found[0];
}

test('Playwright JUnit ids match the JSON fixture', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  assert.deepEqual(
    junit.records.map((record) => record.id),
    json.records.map((record) => record.id),
  );
  assert.deepEqual(junit.warnings, [NO_ATTEMPT]);
});

test('always fails, skipped test, and always passes match the JSON outcomes', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  for (const title of ['always fails', 'skipped test', 'always passes']) {
    assert.equal(byTitle(junit.records, title).outcome, byTitle(json.records, title).outcome, title);
  }
});

test('flaky by retry is one passed attempt when the JUnit file has no per-attempt data', () => {
  const result = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const record = byTitle(result.records, 'flaky by retry');
  assert.equal(record.outcome, 'passed');
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].retry, 0);
  assert.equal(record.attempts[0].status, 'passed');
  assert.equal(record.attempts[0].errors.length, 0);
  assert.equal(record.attempts[0].attachments.length, 1);
  assert.equal(record.attempts[0].attachments[0].name, 'error-context.md');
  assert.match(record.attempts[0].attachments[0].path, /error-context\.md$/);
  assert.ok(result.warnings.includes(NO_ATTEMPT));
});

test('always fails keeps the failure message and the retry text on one attempt', () => {
  const record = byTitle(parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath).records, 'always fails');
  assert.equal(record.outcome, 'failed');
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].status, 'failed');
  assert.equal(record.attempts[0].errors[0].message, 'expect(locator).toHaveText(expected) failed');
  assert.match(record.attempts[0].errors[0].stack, /Retry #1/);
  assert.match(record.attempts[0].errors[0].stack, /Retry #2/);
  assert.equal(record.attempts[0].errors[0].stack.includes('/workspace'), false);
});

test('times out is failed, not timedOut, in the JUnit fixture', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const jsonRecord = byTitle(json.records, 'times out');
  const junitRecord = byTitle(junit.records, 'times out');
  assert.equal(jsonRecord.outcome, 'failed');
  assert.equal(junitRecord.outcome, 'failed');
  assert.ok(jsonRecord.attempts.some((attempt) => attempt.status === 'timedOut'));
  assert.equal(junitRecord.attempts.length, 1);
  assert.equal(junitRecord.attempts[0].status, 'failed');
});

test('expected status is passed because the JUnit file does not carry it', () => {
  const json = parsePlaywrightJson(fs.readFileSync(jsonPath, 'utf8'), jsonPath);
  const junit = parseJunit(fs.readFileSync(junitPath, 'utf8'), junitPath);
  const skipped = byTitle(junit.records, 'skipped test');
  const expected = byTitle(junit.records, 'expected to fail');
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.expectedStatus, 'passed');
  assert.equal(byTitle(json.records, 'skipped test').expectedStatus, 'skipped');
  assert.equal(expected.outcome, 'passed');
  assert.equal(expected.expectedStatus, 'passed');
  assert.equal(byTitle(json.records, 'expected to fail').expectedStatus, 'failed');
});

test('junit-generic.xml has passed, failed, and skipped with project default', () => {
  const result = parseJunit(fs.readFileSync(genericPath, 'utf8'), genericPath);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map((record) => record.outcome),
    ['passed', 'failed', 'skipped'],
  );
  for (const record of result.records) {
    assert.equal(record.project, 'default');
    assert.equal(record.file, 'tests/cart.spec.ts');
    assert.equal(record.source.format, 'junit');
  }
  assert.equal(result.records[1].attempts[0].errors[0].message, 'Expected 1 but saw 2');
  assert.deepEqual(result.warnings, [
    NO_ATTEMPT,
    'JUnit report has no project name; used default',
  ]);
});

test('malformed XML throws an error that includes the report path', () => {
  assert.throws(() => parseJunit('<testsuites><testsuite>', 'reports/bad.xml'), /reports\/bad\.xml/);
  assert.throws(() => parseJunit('<root></root>', 'reports/not-junit.xml'), /reports\/not-junit\.xml/);
});

test('XML default entities are decoded and custom entities are not expanded', () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuites [
  <!ENTITY secret "super-secret-value">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<testsuites>
  <testsuite>
    <testcase name="entity" classname="a.spec.ts">
      <failure message="&lt;tag&amp;attr&gt; &secret; &xxe;">&quot;quoted&quot; &nbsp;</failure>
    </testcase>
  </testsuite>
</testsuites>`;
  const result = parseJunit(xml, 'reports/entities.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('super-secret-value'), false);
  assert.equal(blob.includes('root:'), false);
  const error = result.records[0].attempts[0].errors[0];
  assert.match(error.message, /<tag&attr>/);
  assert.match(error.message, /&secret;/);
  assert.match(error.message, /&xxe;/);
  assert.match(error.stack, /"quoted"/);
  assert.match(error.stack, /&nbsp;/);
});

test('a second DOCTYPE does not expand a custom entity', () => {
  const xml = `<!DOCTYPE a []><!DOCTYPE b [<!ENTITY e "SECOND">]>
<testsuites><testsuite hostname="chromium">
  <testcase name="&e;" classname="a.spec.ts">
    <failure message="&lt;kept&gt; &e;">nope</failure>
  </testcase>
</testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/two-doctype.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('SECOND'), false);
  assert.equal(result.records[0].titlePath[0], '&e;');
  const error = result.records[0].attempts[0].errors[0];
  assert.match(error.message, /<kept>/);
  assert.match(error.message, /&e;/);
  assert.equal(error.stack, 'nope');
});

test('a DOCTYPE after a comment or a processing instruction is not expanded', () => {
  const comment = `<!-- <testsuite --><!DOCTYPE a [<!ENTITY e "DECOY">]>
<testsuite hostname="chromium"><testcase name="&e;" classname="a.spec.ts"></testcase></testsuite>`;
  const instruction = `<?x <testsuites?><!DOCTYPE a [<!ENTITY e "DECOY">]>
<testsuite hostname="chromium"><testcase name="&e;" classname="a.spec.ts"></testcase></testsuite>`;
  for (const xml of [comment, instruction]) {
    const result = parseJunit(xml, 'reports/decoy.xml');
    assert.equal(JSON.stringify(result).includes('DECOY'), false);
    assert.equal(result.records[0].titlePath[0], '&e;');
  }
});

test('numeric character references are decoded', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="&#65;&#x42;" classname="a.spec.ts">
      <failure message="&lt;&#65;&gt;">&#x42; &amp; &nbsp;</failure>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/numeric.xml');
  assert.equal(result.records[0].titlePath[0], 'AB');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message, '<A>');
  assert.equal(error.stack, 'B & &nbsp;');
});

test('CDATA stays literal and mixed text is decoded only outside CDATA', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="cdata" classname="a.spec.ts">
      <failure message="msg"><![CDATA[Received: "Tom &amp; Jerry" url?a=1&amp;b=2 &lt;div&gt;]]></failure>
    </testcase>
    <testcase name="mixed" classname="a.spec.ts">
      <failure message="msg">before &amp; <![CDATA[&amp; and &lt;]]> after &lt;</failure>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/cdata.xml');
  const literal = result.records[0].attempts[0].errors[0];
  const mixed = result.records[1].attempts[0].errors[0];
  assert.equal(literal.stack, 'Received: "Tom &amp; Jerry" url?a=1&amp;b=2 &lt;div&gt;');
  assert.equal(mixed.stack, 'before & &amp; and &lt; after <');
});

test('a DOCTYPE inside CDATA stays in the failure text', () => {
  const kept = `<testsuite hostname="chromium">
    <testcase name="kept" classname="a.spec.ts">
      <failure message="msg"><![CDATA[Received: <!DOCTYPE html><html>]]></failure>
    </testcase>
  </testsuite>`;
  const broken = `<testsuite hostname="chromium">
    <testcase name="broken" classname="a.spec.ts">
      <failure message="msg"><![CDATA[got <!DOCTYPE html [ broken]]></failure>
    </testcase>
  </testsuite>`;
  const keptResult = parseJunit(kept, 'reports/cdata-doctype.xml');
  const brokenResult = parseJunit(broken, 'reports/cdata-doctype-broken.xml');
  assert.equal(keptResult.records[0].attempts[0].errors[0].stack, 'Received: <!DOCTYPE html><html>');
  assert.equal(brokenResult.records[0].attempts[0].errors[0].stack, 'got <!DOCTYPE html [ broken');
});

test('a prolog DOCTYPE is removed and a bad DOCTYPE is rejected', () => {
  const bom = '\uFEFF<!DOCTYPE a [<!ENTITY e "BOM">]><testsuite hostname="chromium"><testcase name="&e;" classname="a.spec.ts"></testcase></testsuite>';
  const bombs = `<!DOCTYPE lol [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<testsuite hostname="chromium"><testcase name="&lol2;" classname="a.spec.ts"></testcase></testsuite>`;
  const bomResult = parseJunit(bom, 'reports/bom-doctype.xml');
  const bombResult = parseJunit(bombs, 'reports/bombs.xml');
  assert.equal(JSON.stringify(bomResult).includes('BOM'), false);
  assert.equal(bomResult.records[0].titlePath[0], '&e;');
  assert.equal(JSON.stringify(bombResult).includes('lollol'), false);
  assert.equal(bombResult.records[0].titlePath[0], '&lol2;');
  assert.throws(
    () => parseJunit('<!doctype html><testsuite hostname="chromium"><testcase name="n" classname="a.spec.ts"></testcase></testsuite>', 'reports/lower.xml'),
    /Invalid XML in report reports\/lower\.xml/,
  );
  assert.throws(
    () => parseJunit('<!DOCTYPE foo <testsuite hostname="chromium"><testcase name="n" classname="a.spec.ts"></testcase></testsuite>', 'reports/open.xml'),
    /Invalid XML in report reports\/open\.xml/,
  );
});

test('error text that is not a filesystem path stays unchanged', () => {
  const text =
    'Expected pattern: /Ready/ "/inventory.html" https://www.saucedemo.com/inventory.html regex /\\d+/ "a\\\\b"';
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="patterns" classname="a.spec.ts">
      <failure message='${text}'>kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/patterns.xml');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message, text);
  assert.equal(error.stack, 'kept');
  assert.deepEqual(result.warnings, [NO_ATTEMPT]);
});

test('a root-shaped absolute path is rewritten when the next character is not a name', () => {
  const input = [
    'a=/home/ci/w&b',
    'cd /home/ci/w&&npm test',
    'bang /home/ci/w!',
    'query /home/ci/w?',
    'hash /home/ci/w#x',
    'star /home/ci/w*',
    'pct /home/ci/w%20',
    'tilde /home/ci/w~',
    'dollar /home/ci/w$HOME',
    'file /home/ci/w/a%20b.ts',
    'ampfile /home/ci/w/a&b.ts',
    'keep /home/ci/w-other/file.ts',
    'dot /home/ci/w.backup/a.ts',
    'prose /var/',
    'url https://x.test/home/ci/w/a?x=/home/ci/w',
  ].join(' ');
  const expected = [
    'a=home/ci/w&b',
    'cd home/ci/w&&npm test',
    'bang home/ci/w!',
    'query /home/ci/w?',
    'hash /home/ci/w#x',
    'star /home/ci/w*',
    'pct home/ci/w%20',
    'tilde home/ci/w~',
    'dollar home/ci/w$HOME',
    'file home/ci/w/a%20b.ts',
    'ampfile home/ci/w/a&b.ts',
    'keep home/ci/w-other/file.ts',
    'dot home/ci/w.backup/a.ts',
    'prose /var/',
    'url https://x.test/home/ci/w/a?x=/home/ci/w',
  ].join(' ');
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="paths" classname="a.spec.ts">
      <failure message="${input.replaceAll('&', '&amp;')}">kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/root-boundary.xml');
  const message = result.records[0].attempts[0].errors[0].message;
  assert.equal(message, expected);
  for (const warning of result.warnings) {
    assert.equal(warning.includes('/home/ci/w'), false);
  }
});

test('Unicode home paths and CI work folders are rewritten when JUnit has no root', () => {
  const input = [
    '/home/bob/file#1.json',
    '/home/józef/secret.txt',
    '/Users/李/a.ts',
    '/__w/repo/a.ts',
    '/github/workspace/repo/a.ts',
    '/Volumes/CI/a.ts',
    '/agent/_work/1/a.ts',
    '/app/foo/bar.json',
    '/data/foo/bar.json',
  ].join(' ');
  // No report root, so a blocked token such as file#1.json stays absolute.
  // A path with no blocked character is still rewritten, including Unicode names.
  const expected = [
    '/home/bob/file#1.json',
    'home/józef/secret.txt',
    'Users/李/a.ts',
    '__w/repo/a.ts',
    'github/workspace/repo/a.ts',
    'Volumes/CI/a.ts',
    'agent/_work/1/a.ts',
    '/app/foo/bar.json',
    '/data/foo/bar.json',
  ].join(' ');
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="paths" classname="a.spec.ts">
      <failure message="${input}">kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/blocked.xml');
  const message = result.records[0].attempts[0].errors[0].message;
  assert.equal(message, expected);
});

test('queries, globs, url paths, and prose stay as written', () => {
  const input = [
    'Received string: "/api/search?q=1&x=2"',
    "page.route('/api/users/*', h)",
    'glob /src/**/*.ts',
    'list /a/b,/c/d',
    'Expected: "/cart/checkout.html"',
    'text /and/or more',
    'price /month/user',
    'wrote /srv/ci/out.json and /opt/app/data.json',
  ].join(' ');
  const expected = [
    'Received string: "/api/search?q=1&x=2"',
    "page.route('/api/users/*', h)",
    'glob /src/**/*.ts',
    'list /a/b,/c/d',
    'Expected: "/cart/checkout.html"',
    'text /and/or more',
    'price /month/user',
    'wrote srv/ci/out.json and opt/app/data.json',
  ].join(' ');
  const escaped = input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="paths" classname="a.spec.ts">
      <failure message="${escaped}">kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/not-a-path.xml');
  assert.equal(result.records[0].attempts[0].errors[0].message, expected);
});

test('an absolute JUnit path is rewritten and does not stay absolute', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="runs elsewhere" file="/var/data/a.spec.ts">
      <failure message="boom at /var/data/a.spec.ts">boom</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/absolute.xml');
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('/var/data/a.spec.ts'), false);
  assert.equal(result.records[0].file, 'var/data/a.spec.ts');
  assert.equal(result.records[0].file.startsWith('/'), false);
  assert.match(result.records[0].attempts[0].errors[0].message, /var\/data\/a\.spec\.ts/);
  assert.ok(
    result.warnings.some((warning) =>
      warning.startsWith('File path was absolute and was rewritten to a relative path:'),
    ),
  );
  for (const warning of result.warnings) {
    assert.equal(warning.includes('/var/data/a.spec.ts'), false);
  }
});

test('time in seconds becomes durationMs', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="timed" classname="a.spec.ts" time="1.5"></testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/time.xml');
  assert.equal(result.records[0].attempts[0].durationMs, 1500);
});

test('ANSI codes are removed from a JUnit failure', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="colored" classname="a.spec.ts">
      <failure message="Error: \u001b[31mnope\u001b[0m">still \u001b[31mred\u001b[0m</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/ansi.xml');
  const error = result.records[0].attempts[0].errors[0];
  assert.equal(error.message.includes('\u001b'), false);
  assert.equal(error.stack.includes('\u001b'), false);
  assert.match(error.message, /nope/);
  assert.match(error.stack, /red/);
});

test('a leading UTF-8 BOM is ignored for detection and JSON parsing', () => {
  const raw = '\uFEFF{"suites":[]}';
  assert.equal(detectFormat(raw, 'reports/bom.json'), 'json');
  const result = parsePlaywrightJson(raw, 'reports/bom.json');
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(detectFormat('\uFEFF<testsuite name="only"></testsuite>', 'reports/bom.xml'), 'junit');
});

test('format detection uses contents, not the file name', () => {
  assert.equal(detectFormat('  \n{"suites":[]}', 'reports/note.txt'), 'json');
  assert.equal(detectFormat('<?xml version="1.0"?><testsuites></testsuites>', 'reports/out.json'), 'junit');
  assert.equal(detectFormat('<testsuite name="only"></testsuite>', 'reports/out.json'), 'junit');
  assert.throws(() => detectFormat('not a report', 'reports/notes.txt'), /unknown report format: reports\/notes\.txt/);
});

test('an invalid character reference is kept literal and a valid one is decoded', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="refs" classname="a.spec.ts">
      <failure message="&#x41;&#0;">&#X41; &#0; &#x42;</failure>
    </testcase>
    <testcase name="cdata" classname="a.spec.ts">
      <failure message="kept"><![CDATA[&#X41; &#0;]]></failure>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/charref.xml');
  const decoded = result.records[0].attempts[0].errors[0];
  const literal = result.records[1].attempts[0].errors[0];
  assert.equal(decoded.message, 'A&#0;');
  assert.equal(decoded.stack, '&#X41; &#0; B');
  assert.equal(literal.stack, '&#X41; &#0;');
  assert.equal(literal.stack.includes('&amp;'), false);
});

test('an empty failure is a failed attempt with no error entry', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="empty" classname="a.spec.ts"><failure/></testcase>
    <testcase name="blank" classname="a.spec.ts"><failure><![CDATA[]]></failure></testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'reports/empty-failure.xml');
  assert.equal(result.records.length, 2);
  for (const record of result.records) {
    assert.equal(record.outcome, 'failed');
    assert.equal(record.attempts[0].status, 'failed');
    assert.deepEqual(record.attempts[0].errors, []);
  }
});

test('a JUnit attachment path stays relative to the report file', () => {
  const xml = `<testsuite hostname="chromium">
    <testcase name="shot" classname="a.spec.ts">
      <system-out><![CDATA[
[[ATTACHMENT|../pw-project/test-results/shot.png]]
]]></system-out>
    </testcase>
  </testsuite>`;
  const result = parseJunit(xml, 'fixtures/reports/sample.junit.xml');
  assert.equal(result.records[0].attempts[0].attachments[0].path, '../pw-project/test-results/shot.png');
});

test('format detection uses the root element', () => {
  assert.equal(detectFormat('{"message":"<testsuite name=\\"x\\">"}', 'reports/note.json'), 'json');
  assert.equal(
    detectFormat('<?xml version="1.0"?><!-- <testsuite> --><testsuite name="only"></testsuite>', 'reports/comment.xml'),
    'junit',
  );
  assert.throws(() => detectFormat('hello <testsuite name="x"></testsuite>', 'reports/prose.txt'), /unknown report format/);
  assert.throws(
    () => detectFormat('<html><body><testsuite></testsuite></body></html>', 'reports/page.html'),
    /unknown report format/,
  );
  assert.throws(
    () => detectFormat('<!-- <testsuite> --><notes></notes>', 'reports/notes.xml'),
    /unknown report format/,
  );
});

test('parsing the JUnit fixture twice is byte identical', () => {
  const text = fs.readFileSync(junitPath, 'utf8');
  const first = JSON.stringify(parseJunit(text, junitPath));
  const second = JSON.stringify(parseJunit(text, junitPath));
  assert.equal(first, second);
});
