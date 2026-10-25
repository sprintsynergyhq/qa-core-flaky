import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parsePlaywrightJson } from '../dist/index.js';

const reportPath = 'fixtures/reports/pw-1.60.0-outcomes.json';
const text = fs.readFileSync(reportPath, 'utf8');

function parseFixture() {
  return parsePlaywrightJson(text, reportPath);
}

function byTitle(records, title) {
  const found = records.filter((record) => record.titlePath.at(-1) === title);
  assert.equal(found.length, 1, `expected one record titled ${title}`);
  return found[0];
}

test('parses the fixture without warnings', () => {
  const result = parseFixture();
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.warnings, []);
  // Six top-level cases plus the one test inside the Cart describe.
  assert.equal(result.records.length, 7);
});

test('flaky by retry keeps both attempts', () => {
  const record = byTitle(parseFixture().records, 'flaky by retry');
  assert.equal(record.outcome, 'flaky');
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[0].retry, 0);
  assert.equal(record.attempts[0].status, 'failed');
  assert.ok(record.attempts[0].errors[0]?.message);
  assert.equal(record.attempts[1].retry, 1);
  assert.equal(record.attempts[1].status, 'passed');
});

test('always fails keeps three attempts with the same message', () => {
  const record = byTitle(parseFixture().records, 'always fails');
  assert.equal(record.outcome, 'failed');
  // retries: 2 means the first run plus two retries.
  assert.equal(record.attempts.length, 3);
  const messages = record.attempts.map((attempt) => attempt.errors[0]?.message);
  assert.ok(messages[0]);
  assert.equal(messages[1], messages[0]);
  assert.equal(messages[2], messages[0]);
});

test('times out is a failed test with a timedOut attempt', () => {
  const record = byTitle(parseFixture().records, 'times out');
  assert.equal(record.outcome, 'failed');
  assert.ok(record.attempts.some((attempt) => attempt.status === 'timedOut'));
});

test('skipped test is skipped', () => {
  const record = byTitle(parseFixture().records, 'skipped test');
  assert.equal(record.outcome, 'skipped');
});

test('expected to fail maps to passed with expectedStatus failed', () => {
  const record = byTitle(parseFixture().records, 'expected to fail');
  assert.equal(record.outcome, 'passed');
  assert.equal(record.expectedStatus, 'failed');
});

test('Cart title path keeps the describe title and the spec title', () => {
  const record = byTitle(parseFixture().records, 'shows the heading');
  assert.deepEqual(record.titlePath, ['Cart', 'shows the heading']);
});

test('ids and file paths stay relative', () => {
  const result = parseFixture();
  const cwd = process.cwd();
  assert.equal(JSON.stringify(result).includes(cwd), false);
  for (const record of result.records) {
    assert.equal(record.id, `${record.file}::${record.project}::${record.titlePath.join(' > ')}`);
    assert.equal(record.file.includes('\\'), false);
    assert.equal(record.file.startsWith('/'), false);
    assert.equal(record.project, 'chromium');
  }
});

test('error messages contain no ANSI escape codes', () => {
  const ansi = /\u001B\[[0-9;]*m/;
  for (const record of parseFixture().records) {
    for (const attempt of record.attempts) {
      for (const error of attempt.errors) {
        assert.equal(ansi.test(error.message), false);
        if (error.stack !== undefined) assert.equal(ansi.test(error.stack), false);
      }
    }
  }
});

test('invalid JSON and a report without suites throw the report path', () => {
  assert.throws(() => parsePlaywrightJson('{', 'reports/bad.json'), /reports\/bad\.json/);
  assert.throws(
    () => parsePlaywrightJson('{"ok":true}', 'reports/no-suites.json'),
    /reports\/no-suites\.json/,
  );
});

test('an unknown extra field does not stop the parse', () => {
  const raw = JSON.stringify({
    extraTop: true,
    config: { rootDir: '/tmp/project' },
    suites: [
      {
        title: 'sample.spec.ts',
        file: '/tmp/project/sample.spec.ts',
        mystery: 1,
        specs: [
          {
            title: 'works',
            file: '/tmp/project/sample.spec.ts',
            line: 4,
            extraSpec: 'ok',
            tests: [
              {
                projectName: '',
                expectedStatus: 'passed',
                status: 'expected',
                extraTest: { nested: true },
                results: [
                  {
                    retry: 1,
                    status: 'passed',
                    duration: 5,
                    bonus: 'field',
                    errors: [
                      {
                        message: 'Error: \u001b[31mnope\u001b[0m at /tmp/project/sample.spec.ts',
                        stack: 'at fn (/tmp/project/sample.spec.ts:4:1)',
                        location: { file: '/tmp/project/sample.spec.ts', line: 4, column: 1 },
                      },
                    ],
                    attachments: [
                      {
                        name: 'shot',
                        contentType: 'image/png',
                        path: '/tmp/project/test-results/shot.png',
                      },
                    ],
                  },
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [],
                    attachments: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = parsePlaywrightJson(raw, 'synthetic.json');
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.outcome, 'passed');
  assert.equal(record.project, 'default');
  assert.equal(record.file, 'sample.spec.ts');
  assert.deepEqual(record.titlePath, ['works']);
  assert.equal(record.attempts[0].retry, 0);
  assert.equal(record.attempts[1].retry, 1);
  assert.equal(record.attempts[1].errors[0].message.includes('\u001b'), false);
  assert.equal(record.attempts[1].errors[0].message.includes('/tmp/project'), false);
  assert.equal(record.attempts[1].errors[0].location.file, 'sample.spec.ts');
  assert.equal(record.attempts[1].attachments[0].path, 'test-results/shot.png');
});

function leaksAbsolute(text, absolutePath) {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(absolutePath, from);
    if (at === -1) return false;
    const prev = at === 0 ? '' : text[at - 1];
    if (prev !== '.') return true;
    from = at + absolutePath.length;
  }
  return false;
}

test('a file path outside rootDir stays relative and warns', () => {
  const raw = JSON.stringify({
    config: { rootDir: '/tmp/project' },
    suites: [
      {
        title: 'outside.spec.ts',
        file: '/tmp/project-other/outside.spec.ts',
        line: 0,
        column: 0,
        specs: [
          {
            title: 'runs elsewhere',
            file: '/tmp/project-other/outside.spec.ts',
            line: 3,
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [
                      {
                        message: 'Error: boom at /tmp/project-other/outside.spec.ts',
                        stack: 'at fn (/var/data/outside.spec.ts:3:1)',
                        location: {
                          file: '/tmp/project-other/outside.spec.ts',
                          line: 3,
                          column: 1,
                        },
                      },
                    ],
                    attachments: [
                      {
                        name: 'shot',
                        contentType: 'image/png',
                        path: '/var/data/shot.png',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = parsePlaywrightJson(raw, 'outside.json');
  const record = result.records[0];
  const blob = JSON.stringify(result);
  assert.equal(leaksAbsolute(blob, '/tmp/project-other/outside.spec.ts'), false);
  assert.equal(leaksAbsolute(blob, '/tmp/project'), false);
  assert.equal(leaksAbsolute(blob, '/var/data/shot.png'), false);
  assert.equal(leaksAbsolute(blob, '/var/data/outside.spec.ts'), false);
  assert.equal(record.file, '../project-other/outside.spec.ts');
  assert.equal(record.file.startsWith('/'), false);
  assert.deepEqual(record.titlePath, ['runs elsewhere']);
  assert.equal(record.attempts[0].errors[0].location.file, '../project-other/outside.spec.ts');
  assert.equal(record.attempts[0].errors[0].message, 'Error: boom at ../project-other/outside.spec.ts');
  assert.equal(record.attempts[0].errors[0].stack, 'at fn (../../var/data/outside.spec.ts:3:1)');
  assert.equal(record.attempts[0].attachments[0].path, '../../var/data/shot.png');
  const outside = result.warnings.filter((warning) =>
    warning.startsWith('File path is outside the report root'),
  );
  assert.equal(outside.length, 3);
  for (const warning of outside) {
    assert.equal(leaksAbsolute(warning, '/tmp/project'), false);
    assert.equal(leaksAbsolute(warning, '/var/data'), false);
  }
});

test('a describe titled with the spec file name stays in the title path', () => {
  const raw = JSON.stringify({
    config: { rootDir: '/tmp/project' },
    suites: [
      {
        title: 'tests/outcomes.spec.ts',
        file: '/tmp/project/tests/outcomes.spec.ts',
        line: 0,
        column: 0,
        suites: [
          {
            title: 'outcomes.spec.ts',
            file: '/tmp/project/tests/outcomes.spec.ts',
            line: 10,
            column: 6,
            specs: [
              {
                title: 'keeps the describe',
                file: '/tmp/project/tests/outcomes.spec.ts',
                line: 11,
                tests: [
                  {
                    projectName: 'chromium',
                    expectedStatus: 'passed',
                    status: 'expected',
                    results: [{ retry: 0, status: 'passed', duration: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = parsePlaywrightJson(raw, 'describe-name.json');
  assert.equal(result.records.length, 1);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.records[0].file, 'tests/outcomes.spec.ts');
  assert.deepEqual(result.records[0].titlePath, ['outcomes.spec.ts', 'keeps the describe']);
});

test('error text that is not a filesystem path stays unchanged', () => {
  const text = 'Expected pattern: /Ready/ "/inventory.html" https://www.saucedemo.com/inventory.html regex /\\d+/ "a\\\\b"';
  const raw = JSON.stringify({
    config: { rootDir: '/tmp/project' },
    suites: [
      {
        title: 'sample.spec.ts',
        file: 'sample.spec.ts',
        specs: [
          {
            title: 'keeps the message',
            file: 'sample.spec.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [{ message: text, stack: text }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = parsePlaywrightJson(raw, 'patterns.json');
  assert.equal(result.warnings.length, 0);
  assert.equal(result.records[0].attempts[0].errors[0].message, text);
  assert.equal(result.records[0].attempts[0].errors[0].stack, text);
});

test('a root path in error text stays hidden after file, colon, backtick, and brackets', () => {
  const text = [
    'at file:///tmp/project/tests/a.spec.ts:3:1',
    'cwd:/tmp/project/x',
    'see `/tmp/project/src/a.ts`',
    '[/tmp/project/a.png]',
    '{/tmp/project/lib/a.ts}',
  ].join(' ');
  const expected = [
    'at file://tests/a.spec.ts:3:1',
    'cwd:x',
    'see `src/a.ts`',
    '[a.png]',
    '{lib/a.ts}',
  ].join(' ');
  const result = parsePlaywrightJson(errorReport(text), 'root-text.json');
  assert.equal(result.warnings.length, 0);
  assert.equal(result.records[0].attempts[0].errors[0].message, expected);
  assert.equal(result.records[0].attempts[0].errors[0].stack, expected);
  assert.equal(JSON.stringify(result).includes('/tmp/project'), false);
});

test('a filesystem path after file, colon, backtick, and brackets is rewritten', () => {
  const text = [
    'file:///var/data/a.spec.ts:3:1',
    'cwd:/home/user/a.ts:2',
    'see `/tmp/other/a.ts:4`',
    '[/var/data/a.png]',
    '{/runner/work/a.ts:1}',
    'at /var/data/a.ts:1).',
    'note /home/me/a.ts:2,',
    'pic /var/data/a.png.',
    'end /tmp/project/a.ts:3;',
  ].join(' ');
  const expected = [
    'file://../../var/data/a.spec.ts:3:1',
    'cwd:../../home/user/a.ts:2',
    'see `../other/a.ts:4`',
    '[../../var/data/a.png]',
    '{../../runner/work/a.ts:1}',
    'at ../../var/data/a.ts:1).',
    'note ../../home/me/a.ts:2,',
    'pic ../../var/data/a.png.',
    'end a.ts:3;',
  ].join(' ');
  const result = parsePlaywrightJson(errorReport(text), 'prefix-text.json');
  assert.equal(result.records[0].attempts[0].errors[0].message, expected);
  assert.equal(result.records[0].attempts[0].errors[0].stack, expected);
  const blob = JSON.stringify(result);
  assert.equal(leaksAbsolute(blob, '/tmp/project'), false);
  assert.equal(leaksAbsolute(blob, '/var/data/a.spec.ts'), false);
  assert.equal(leaksAbsolute(blob, '/home/user/a.ts'), false);
  assert.equal(leaksAbsolute(blob, '/tmp/other/a.ts'), false);
  assert.equal(leaksAbsolute(blob, '/runner/work/a.ts'), false);
  const outside = result.warnings.filter((warning) =>
    warning.startsWith('File path is outside the report root'),
  );
  assert.equal(outside.length, 7);
});

function rootReport(text, rootDir) {
  return JSON.stringify({
    config: { rootDir },
    suites: [
      {
        title: 'sample.spec.ts',
        file: 'sample.spec.ts',
        specs: [
          {
            title: 'keeps the surrounding text',
            file: 'sample.spec.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [{ message: text, stack: text }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

function errorReport(text) {
  return rootReport(text, '/tmp/project');
}

test('an http URL is not rewritten, including a query path and the report root', () => {
  const text = 'see https://example.com/page?x=/home/a and https://x.test/tmp/project/a end';
  const result = parsePlaywrightJson(errorReport(text), 'urls.json');
  assert.equal(result.records[0].attempts[0].errors[0].message, text);
  assert.equal(result.records[0].attempts[0].errors[0].stack, text);
  assert.equal(result.warnings.length, 0);
});

test('a real path beside a URL is rewritten and the URL is not', () => {
  const text = 'boom /opt/app/data.json see https://example.com/opt/app/data.json';
  const result = parsePlaywrightJson(errorReport(text), 'url-and-path.json');
  const message = result.records[0].attempts[0].errors[0].message;
  assert.equal(message.includes('https://example.com/opt/app/data.json'), true);
  assert.equal(message.includes('boom /opt/app/data.json'), false);
  assert.match(message, /boom \.\.\/\.\.\/opt\/app\/data\.json/);
  assert.equal(
    result.warnings.some((warning) => warning.includes('https://example.com')),
    false,
  );
});

test('a known prefix in prose is not rewritten', () => {
  const text = 'The prefixes /var/ /home/ /tmp/ /Users/ /runner/ appear in prose.';
  const result = parsePlaywrightJson(errorReport(text), 'prose.json');
  assert.equal(result.records[0].attempts[0].errors[0].message, text);
  assert.equal(result.warnings.length, 0);
});

test('an absolute path outside the old prefix list is rewritten', () => {
  const text = 'wrote /srv/ci/out.json and /opt/app/data.json';
  const result = parsePlaywrightJson(errorReport(text), 'wide.json');
  const message = result.records[0].attempts[0].errors[0].message;
  assert.equal(message, 'wrote ../../srv/ci/out.json and ../../opt/app/data.json');
  assert.equal(/(?:^|\s)\/srv\/ci\/out\.json/.test(message), false);
  assert.equal(/(?:^|\s)\/opt\/app\/data\.json/.test(message), false);
});

test('a report root followed by a non-name character is rewritten', () => {
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
    'a=../w&b',
    'cd ../w&&npm test',
    'bang ../w!',
    'query ../w?',
    'hash ../w#x',
    'star ../w*',
    'pct ../w%20',
    'tilde ../w~',
    'dollar ../w$HOME',
    'file a%20b.ts',
    'ampfile a&b.ts',
    'keep ../w-other/file.ts',
    'dot ../w.backup/a.ts',
    'prose /var/',
    'url https://x.test/home/ci/w/a?x=/home/ci/w',
  ].join(' ');
  const result = parsePlaywrightJson(rootReport(input, '/home/ci/w'), 'root-boundary.json');
  const message = result.records[0].attempts[0].errors[0].message;
  assert.equal(message, expected);
  for (const warning of result.warnings) {
    assert.equal(warning.includes('/home/ci/w'), false);
  }
});

test('escaped Windows backslashes keep the drive and use single separators', () => {
  const message = 'Error at C:\\\\Users\\\\bob\\\\a.ts:12:3';
  const result = parsePlaywrightJson(errorReport(message), 'windows.json');
  const stored = result.records[0].attempts[0].errors[0].message;
  assert.equal(stored, 'Error at C:/Users/bob/a.ts:12:3');
  assert.equal(stored.includes('Users//bob'), false);
  assert.equal(stored.includes('\\'), false);
  assert.ok(result.warnings.some((warning) => warning.includes('C:/Users/bob/a.ts:12:3')));
});

test('a Windows path on the report drive becomes relative', () => {
  const raw = JSON.stringify({
    config: { rootDir: 'C:/work/repo' },
    suites: [
      {
        title: 'a.ts',
        file: 'C:/work/repo/src/a.ts',
        specs: [
          {
            title: 'runs',
            file: 'C:/work/repo/src/a.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'unexpected',
                results: [
                  {
                    retry: 0,
                    status: 'failed',
                    duration: 1,
                    errors: [{ message: 'at C:\\\\work\\\\repo\\\\src\\\\a.ts:2:1' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = parsePlaywrightJson(raw, 'windows-root.json');
  assert.equal(result.records[0].file, 'src/a.ts');
  assert.equal(result.records[0].attempts[0].errors[0].message, 'at src/a.ts:2:1');
  assert.equal(
    result.warnings.some((warning) => warning.startsWith('File path is a Windows path')),
    false,
  );
});

test('a test with zero results warns and still returns a record', () => {
  const raw = JSON.stringify({
    suites: [
      {
        title: 'empty.spec.ts',
        file: 'empty.spec.ts',
        specs: [
          {
            title: 'has no results',
            file: 'empty.spec.ts',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'skipped',
                results: [],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = parsePlaywrightJson(raw, 'empty.json');
  assert.equal(result.records.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /empty\.spec\.ts::chromium::has no results/);
});
