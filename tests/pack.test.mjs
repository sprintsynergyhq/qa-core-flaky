import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const bannedPrefixes = ['docs/', 'tests/', 'fixtures/', 'demo/', 'examples/', 'scripts/', '.github/'];

test('package.json is publishable and the pack includes dist/cli.js', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.notEqual(pkg.private, true);
  assert.equal(Object.hasOwn(pkg, 'private'), false);
  assert.ok(Array.isArray(pkg.files), 'files list is missing');
  assert.ok(pkg.files.includes('dist'), 'files list is missing dist');
  assert.ok(pkg.files.includes('schemas'), 'files list is missing schemas');
  assert.equal(pkg.scripts.prepack, 'npm run build');

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const manifest = JSON.parse(packed.stdout);
  const entry = Array.isArray(manifest) ? manifest[0] : manifest;
  const paths = entry.files.map((file) => file.path);
  assert.ok(paths.includes('dist/cli.js'), 'dist/cli.js is missing from the pack');
  for (const prefix of bannedPrefixes) {
    const hit = paths.find((item) => item === prefix.slice(0, -1) || item.startsWith(prefix));
    assert.equal(hit, undefined, `${prefix} is in the pack`);
  }
});
