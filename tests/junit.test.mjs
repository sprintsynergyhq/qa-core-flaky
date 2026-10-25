import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  detectFormat,
  homeMarks,
  parseJunit,
  parsePlaywrightJson,
  redactHomeText,
  redactParseResult,
} from '../dist/index.js';

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
    'a=<home>/w&b',
    'cd <home>/w&&npm test',
    'bang <home>/w!',
    'query <home>/w?',
    'hash <home>/w#x',
    'star <home>/w*',
    'pct <home>/w%20',
    'tilde <home>/w~',
    'dollar <home>/w$HOME',
    'file <home>/w/a%20b.ts',
    'ampfile <home>/w/a&b.ts',
    'keep <home>/w-other/file.ts',
    'dot <home>/w.backup/a.ts',
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
  assert.equal(message, input);
  assert.equal(redactHomeText(message), expected);
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
  // No report root. The home directory and username become <home>/, including
  // up to a blocked character. Other known folders are still rewritten.
  const expected = [
    '<home>/file#1.json',
    '<home>/secret.txt',
    '<home>/a.ts',
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
  assert.equal(message.includes('/home/józef/secret.txt'), true);
  assert.equal(message.includes('/Users/李/a.ts'), true);
  assert.equal(message.includes('__w/repo/a.ts'), true);
  assert.equal(message.includes('/__w/repo/a.ts'), false);
  assert.equal(redactHomeText(message), expected);
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

test('a JUnit report with no root rewrites the home directory and username to <home>/', () => {
  const message = [
    "open '/tmp/home/alice/proj/tests/seed-users.json'",
    'also /home/alice/proj/x.json',
    'blocked /home/bob/file#1.json',
    'win C:\\Users\\alice\\proj\\tests\\seed.json',
    'var /var/home/alice/a.json',
    'priv /private/home/alice/a.json',
    'mnt /mnt/data/home/alice/a.json',
    'link file:///home/alice/a.json',
  ].join(' ');
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="reads the seed file" classname="missing.spec.ts" file="/tmp/home/alice/proj/tests/missing.spec.ts">
      <failure message="${message.replaceAll('&', '&amp;')}">${message}</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/home.xml');
  const stored = result.records[0].attempts[0].errors[0].message;
  assert.equal(stored, message);
  assert.equal(stored.includes('/home/alice/'), true);
  const redacted = redactHomeText(stored);
  assert.match(redacted, /open '\/tmp\/<home>\/proj\/tests\/seed-users\.json'/);
  assert.match(redacted, /also <home>\/proj\/x\.json/);
  assert.match(redacted, /blocked <home>\/file#1\.json/);
  assert.match(redacted, /win <home>\/proj\/tests\/seed\.json/);
  assert.match(redacted, /var \/var\/<home>\/a\.json/);
  assert.match(redacted, /priv \/private\/<home>\/a\.json/);
  assert.match(redacted, /mnt \/mnt\/data\/<home>\/a\.json/);
  assert.match(redacted, /link file:\/\/\/<home>\/a\.json/);
  assert.equal(redacted.includes('alice'), false);
  assert.equal(redacted.includes('bob'), false);
  assert.match(result.records[0].file, /^tmp\/<home>\/proj\/tests\/missing\.spec\.ts$/);
  assert.equal(result.records[0].file.includes('alice'), false);
  for (const warning of result.warnings) {
    assert.equal(warning.includes('alice'), false);
    assert.equal(warning.includes('/home/'), false);
  }
});

test('a username with a space is rewritten before the text is split', () => {
  const message = "open 'C:\\Users\\Jöhn Smith\\proj\\seed.json' c:\\users\\alice\\proj\\a.json";
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="seed" classname="a.spec.ts">
      <failure message="${message}">kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/spaced-user.xml');
  const stored = result.records[0].attempts[0].errors[0].message;
  assert.equal(stored, message);
  const redacted = redactHomeText(stored);
  assert.equal(redacted, "open '<home>/proj/seed.json' <home>/proj/a.json");
  assert.equal(redacted.includes('Smith'), false);
  assert.equal(redacted.includes('Jöhn'), false);
  assert.equal(redacted.includes('alice'), false);
  assert.equal(redacted.includes('Users'), false);
  assert.equal(redacted.includes('users'), false);
  const escaped = JSON.parse('"C:\\\\Users\\\\J\\u00f6hn Smith\\\\proj\\\\seed.json"');
  assert.equal(redactHomeText(escaped), '<home>/proj/seed.json');
});

test('url routes that contain home are not rewritten', () => {
  const message = ['/api/home/settings/save', 'GET /home/index/page', '/Users/42/orders'].join(' ');
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="routes" classname="a.spec.ts">
      <failure message="${message}">kept</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/url-home.xml');
  const stored = result.records[0].attempts[0].errors[0].message;
  assert.equal(stored, message);
  assert.equal(redactHomeText(stored), message);
});

test('a home rewrite does not add a path warning', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="home" classname="a.spec.ts" file="/home/alice/proj/a.spec.ts">
      <failure message="open '/home/alice/proj/a.json'">open '/home/alice/proj/a.json'</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/home-warn.xml');
  assert.equal(result.records[0].file, '<home>/proj/a.spec.ts');
  assert.equal(result.records[0].attempts[0].errors[0].message, "open '/home/alice/proj/a.json'");
  assert.equal(redactHomeText(result.records[0].attempts[0].errors[0].message), "open '<home>/proj/a.json'");
  assert.equal(
    result.warnings.some((warning) => warning.includes('rewritten') || warning.includes('alice') || warning.includes('/home/')),
    false,
  );
});

test('a username stops at a newline, whitespace, or a colon', () => {
  assert.equal(
    redactHomeText('Error: missing /home/alice\nError: second line stays'),
    'Error: missing <home>\nError: second line stays',
  );
  assert.equal(redactHomeText('cwd is /home/alice and npm failed'), 'cwd is <home> and npm failed');
  assert.equal(
    redactHomeText('/Users/bob: permission denied (os error 13)'),
    '<home>: permission denied (os error 13)',
  );
});

test('a drive letter is only a drive in a real path position', () => {
  const cases = [
    ['open file:///C:/Users/alice/a.html', 'open file:///<home>/a.html'],
    ['PATH=/usr/bin:/home/alice/bin', 'PATH=/usr/bin:<home>/bin'],
    ['user@host:/home/alice/x', 'user@host:<home>/x'],
    ['HOME:/home/alice/x', 'HOME:<home>/x'],
    ['cwd:/home/ci/w', 'cwd:<home>/w'],
    ['\\\\?\\C:\\Users\\alice\\a.json', '\\\\?\\<home>/a.json'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactHomeText(input), expected, input);
  }
});

test('a bare home in Expected or Received is redacted, and a route parameter stays', () => {
  assert.equal(redactHomeText('Expected: "/users/:id"'), 'Expected: "/users/:id"');
  assert.equal(redactHomeText('Expected: "/Users/:id"'), 'Expected: "/Users/:id"');
  assert.equal(redactHomeText('Expected: "/home/feed"'), 'Expected: "<home>"');
  assert.equal(redactHomeText('Received: "/home/login"'), 'Received: "<home>"');
  assert.equal(redactHomeText('/users/alice/feed'), '<home>/feed');
  assert.equal(
    redactHomeText('Expected: "/home/alice/notes.txt"'),
    'Expected: "<home>/notes.txt"',
  );
  assert.equal(
    redactHomeText('Expected: "/home/alice/proj/a.json"'),
    'Expected: "<home>/proj/a.json"',
  );
  const drift = ['Error: expect(locator).toHaveURL(expected) failed', 'Expected: "/home/feed"', 'Received: "/home/login"'].join(
    '\n',
  );
  assert.equal(redactHomeText(drift), 'Error: expect(locator).toHaveURL(expected) failed\nExpected: "<home>"\nReceived: "<home>"');
  const marks = homeMarks([drift]);
  assert.equal(
    redactHomeText(drift, marks),
    'Error: expect(locator).toHaveURL(expected) failed\nExpected: "<home>"\nReceived: "<home~2>"',
  );
});

test('a run of backslashes is one separator around a Windows home path', () => {
  const file = 'C:\\\\Users\\\\alice\\\\x.json';
  assert.equal(file.includes('\\\\'), true);
  assert.equal(redactHomeText(file), '<home>/x.json');
  assert.equal(redactHomeText('Error at C:\\\\Users\\\\bob\\\\a.ts:12:3'), 'Error at <home>/a.ts:12:3');
  assert.equal(redactHomeText('Error at C:\\Users\\bob\\a.ts:12:3'), 'Error at <home>/a.ts:12:3');
  assert.equal(
    redactHomeText('    at readCsv (C:\\\\Users\\\\alice\\\\x.json:12:3)'),
    '    at readCsv (<home>/x.json:12:3)',
  );
  assert.equal(
    redactHomeText('Expected: "C:\\\\Users\\\\alice\\\\Downloads\\\\report.csv"'),
    'Expected: "<home>/Downloads/report.csv"',
  );
  assert.equal(
    redactHomeText('Received: "C:\\\\Users\\\\alice\\\\Downloads\\\\report.csv"'),
    'Received: "<home>/Downloads/report.csv"',
  );
  assert.equal(redactHomeText('Received: "C:/Users/alice/Desktop"'), 'Received: "<home>/Desktop"');
  assert.equal(redactHomeText('Received: "C:\\\\Users\\\\alice\\\\Desktop"'), 'Received: "<home>/Desktop"');
  assert.equal(
    redactHomeText('Received: "C:\\\\Users\\\\alice\\\\Desktop\\\\Inner\\\\notes.txt"'),
    'Received: "<home>/Desktop/Inner/notes.txt"',
  );
  assert.equal(redactHomeText('Received: "/home/alice/Desktop"'), 'Received: "<home>/Desktop"');
  assert.equal(redactHomeText('Expected: "/home/feed"'), 'Expected: "<home>"');
  assert.equal(redactHomeText('Expected: "/home/alice"'), 'Expected: "<home>"');
  assert.equal(redactHomeText('Received: "/Users/bob/notes"'), 'Received: "<home>/notes"');
});

test('home paths after punctuation, a tilde, a relative prefix, and a UNC share are redacted', () => {
  const cases = [
    [',/home/x', ',<home>'],
    ['>/home/x', '><home>'],
    ['PATH=/home/alice/bin;/home/bob/bin', 'PATH=<home>/bin;<home>/bin'],
    ['</home/alice/proj>', '<<home>/proj>'],
    ['file://localhost/home/alice/a.ts', 'file://localhost/<home>/a.ts'],
    ['/HOME/alice/a.ts', '<home>/a.ts'],
    ['~alice/proj', '<home>/proj'],
    ['~alice', '<home>'],
    ['~/proj', '~/proj'],
    ['../../../home/bob/a.ts', '<home>/a.ts'],
    ['\\\\server\\Users\\bob\\a', '\\\\server<home>/a'],
    ['x\\\\Users\\\\bob\\\\a', 'x<home>/a'],
    ['\\\\home\\\\alice\\\\x', '<home>/x'],
    ['C:\\Users\\Jo Smith failed', '<home> failed'],
    ['route /home/dashboard/widgets', 'route <home>/widgets'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactHomeText(input), expected, input);
  }
  const trailed = 'C:\\Users\\bob\\a;C:\\\\Windows';
  assert.equal(redactHomeText(trailed), '<home>/a;C:\\\\Windows');
  assert.equal(redactHomeText(trailed).includes('C:/Windows'), false);
});

test('two files that differ only by the home username stay distinct ids', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="reads" classname="a.spec.ts" file="/home/alice/proj/a.spec.ts">
      <failure message="Error: element(s) not found">Error: element(s) not found</failure>
    </testcase>
    <testcase name="reads" classname="a.spec.ts" file="/home/bob/proj/a.spec.ts">
      <failure message="Error: element(s) not found">Error: element(s) not found</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/two-homes.xml');
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
  assert.equal(result.records[0].file, '<home>/proj/a.spec.ts');
  assert.equal(result.records[1].file, '<file~2>/proj/a.spec.ts');
  assert.equal(result.records[0].id.includes('alice'), false);
  assert.equal(result.records[1].id.includes('bob'), false);
});

test('redactParseResult hides a made-up home in source.reportPath', () => {
  const paths = ['/home/alice/r.xml', 'C:\\Users\\alice\\r.xml'];
  for (const reportPath of paths) {
    const result = {
      schemaVersion: 1,
      records: [
        {
          id: 'a.spec.ts::default::t',
          file: 'a.spec.ts',
          project: 'default',
          titlePath: ['t'],
          expectedStatus: 'passed',
          outcome: 'failed',
          attempts: [
            {
              retry: 0,
              status: 'failed',
              durationMs: 1,
              errors: [{ message: 'Error: gave up' }],
              attachments: [],
            },
          ],
          source: { format: 'junit', reportPath },
        },
      ],
      warnings: [],
    };
    const hidden = redactParseResult(result);
    assert.equal(hidden.records[0].source.reportPath, '<home>/r.xml');
    assert.equal(hidden.records[0].source.reportPath, redactHomeText(reportPath));
    assert.equal(result.records[0].source.reportPath, reportPath);
    assert.equal(hidden.records[0].attempts[0].errors[0].message, 'Error: gave up');
  }
});

test('home folders match in any case, and UNC and SMB keep the server', () => {
  assert.equal(redactHomeText('/USERS/alice/x'), '<home>/x');
  assert.equal(redactHomeText('/users/alice/x'), '<home>/x');
  assert.equal(redactHomeText('/HOME/alice/x'), '<home>/x');
  assert.equal(redactHomeText('\\\\?\\UNC\\server\\Users\\bob\\a'), '\\\\?\\UNC\\server<home>/a');
  assert.equal(redactHomeText('smb://server/Users/bob/a'), 'smb://server<home>/a');
  assert.equal(redactHomeText("locator('h1 ~p')"), "locator('h1 ~p')");
  assert.equal(redactHomeText("locator('.a ~.b')"), "locator('.a ~.b')");
  assert.equal(redactHomeText("locator('li ~li >> nth=1')"), "locator('li ~li >> nth=1')");
  assert.equal(redactHomeText('C:\\Users\\Jo Smith Failed Again'), '<home> Failed Again');
  assert.equal(redactHomeText('C:\\Users\\jo smith failed'), '<home> failed');
});

test('a quoted home mark does not collide with a generated mark', () => {
  const text = 'Expected: "<home~2>"\nReceived: "/home/bob/a"';
  const marks = homeMarks(['/home/alice/a', text]);
  const out = redactHomeText(text, marks);
  assert.equal(out.includes('<text:home~2>'), true);
  assert.equal(out.includes('bob'), false);
  assert.match(out, /<home~2>\/a/);
});

test('homeMarks stays linear for many usernames', () => {
  const lines = Array.from({ length: 20000 }, (_item, index) => `/home/user${index}/a`);
  const started = Date.now();
  const marks = homeMarks(lines);
  assert.equal(Date.now() - started < 2000, true);
  assert.equal(marks.size, 20000);
});

test('the second home file uses a file mark, not a home mark', () => {
  const xml = `<testsuites><testsuite hostname="chromium">
    <testcase name="reads" classname="a.spec.ts" file="/home/alice/proj/a.spec.ts">
      <failure message="Error: element(s) not found">Error: element(s) not found</failure>
    </testcase>
    <testcase name="reads" classname="a.spec.ts" file="/home/bob/proj/a.spec.ts">
      <failure message="Error: element(s) not found">Error: element(s) not found</failure>
    </testcase>
  </testsuite></testsuites>`;
  const result = parseJunit(xml, 'reports/two-homes.xml');
  assert.equal(result.records[1].id.startsWith('<file~2>/'), true);
  assert.equal(result.records[1].id.includes('<home~2>'), false);
});
