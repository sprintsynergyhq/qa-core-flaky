import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = 'dist/cli.js';
const fixture = 'fixtures/reports/pw-1.60.0-outcomes.json';

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
}

function oneLine(text) {
  const trimmed = text.replace(/\n$/, '');
  return !trimmed.includes('\n');
}

test('parse exits 0 and prints schemaVersion 1', () => {
  const result = run(['parse', fixture]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.ok(Array.isArray(json.records));
});

test('commit and branch are copied onto every record', () => {
  const result = run(['parse', fixture, '--commit', 'abc123', '--branch', 'main']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.ok(json.records.length > 0);
  for (const record of json.records) {
    assert.equal(record.source.commitSha, 'abc123');
    assert.equal(record.source.branch, 'main');
    assert.equal(record.source.format, 'playwright-json');
    assert.equal(record.source.reportPath, fixture);
  }
});

test('a missing file exits 1 with a one-line stderr message', () => {
  const result = run(['parse', 'does-not-exist.json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /does-not-exist\.json/);
});

test('help exits 0 and lists parse', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /parse/);
});

test('version exits 0 and prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.0.1\n');
});

test('parsing the fixture twice is byte identical', () => {
  const first = run(['parse', fixture]);
  const second = run(['parse', fixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});

const junitFixture = 'fixtures/reports/pw-1.60.0-outcomes.junit.xml';

test('parse auto-detects a JUnit report', () => {
  const result = run(['parse', junitFixture, '--commit', 'abc123', '--branch', 'main']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.records.length > 0);
  for (const record of json.records) {
    assert.equal(record.source.format, 'junit');
    assert.equal(record.source.reportPath, junitFixture);
    assert.equal(record.source.commitSha, 'abc123');
    assert.equal(record.source.branch, 'main');
  }
});

test('--format json on a JUnit file exits 1', () => {
  const result = run(['parse', junitFixture, '--format', 'json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(oneLine(result.stderr), true);
  assert.match(result.stderr, /Invalid JSON/);
  assert.match(result.stderr, /pw-1\.60\.0-outcomes\.junit\.xml/);
});

test('parsing the JUnit fixture twice is byte identical', () => {
  const first = run(['parse', junitFixture]);
  const second = run(['parse', junitFixture]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.endsWith('\n'));
});
