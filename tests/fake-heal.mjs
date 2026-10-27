#!/usr/bin/env node
/**
 * Stand-in for qa-core-heal. Tests point QA_CORE_HEAL_BIN at this file.
 * Capabilities JSON is fixtures/heal/heal-0.4.0-capabilities.json.
 * That is the 0.4.0 shape from the PR 10 review: contracts.findings and
 * contracts.results are arrays of version numbers. 0.4.0 was not released,
 * so this is not a registry tarball.
 * Compat JSON follows fixtures/heal/real-heal-0.3.4-dry-run.json, recorded
 * from qa-core-heal 0.3.4: verdicts[] and locators[].
 * It records every argument list. It exits 9 if passed --apply, --yes, or --no-verify.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = process.env.FAKE_HEAL_MODE || 'contract';
const log = process.env.FAKE_HEAL_LOG;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);

for (const arg of args) {
  if (arg === '--apply' || arg === '--yes' || arg === '--no-verify' || arg.startsWith('--apply=') || arg.startsWith('--yes=') || arg.startsWith('--no-verify=')) {
    process.stderr.write(`refusing ${arg}\n`);
    process.exit(9);
  }
}

if (mode === 'grandchild') {
  spawn('sleep', ['25'], { stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else if (args[0] === 'capabilities') {
  if (mode === 'compat') {
    process.stderr.write('unknown command capabilities\n');
    process.exit(1);
  }
  const caps = fs.readFileSync(path.join(root, 'fixtures/heal/heal-0.4.0-capabilities.json'));
  process.stdout.write(caps);
  if (!caps.toString('utf8').endsWith('\n')) process.stdout.write('\n');
  process.exit(0);
}

if (args.includes('--version')) {
  process.stdout.write(mode === 'compat' ? '0.3.4\n' : '0.4.0\n');
  process.exit(0);
}

if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  process.stderr.write('heal failed\n');
  process.exit(1);
} else if (args.includes('--findings')) {
  writeContractResults();
} else {
  writeCompatResults();
}

function writeContractResults() {
  if (args.includes('--test')) {
    process.stderr.write('--findings cannot be combined with --test. Each finding names its own test.\n');
    process.exit(1);
  }
  if (!args.includes('--dry-run')) {
    process.stderr.write('missing --dry-run\n');
    process.exit(1);
  }
  const findingsPath = valueAfter('--findings');
  const resultsPath = valueAfter('--results');
  const body = fs.readFileSync(findingsPath);
  if (process.env.FAKE_HEAL_FINDINGS_OUT) fs.writeFileSync(process.env.FAKE_HEAL_FINDINGS_OUT, body);
  const findings = JSON.parse(body.toString('utf8'));
  const document = {
    schema: 'qa-core.heal-results',
    schemaVersion: 1,
    tool: { name: 'qa-core-heal', version: '0.4.0', playwrightVersion: '1.60.0' },
    mode: 'dry-run',
    input: {
      findingsSchemaVersion: 1,
      findingsSha256: createHash('sha256').update(body).digest('hex'),
      findingCount: findings.findings.length,
    },
    ai: { enabled: false, provider: null, model: null },
    results: findings.findings.map(toResult),
  };
  fs.writeFileSync(resultsPath, `${JSON.stringify(document, null, 2)}\n`);
  process.exit(0);
}

function toResult(finding) {
  if (finding.handoff.mode === 'none') {
    return row(finding, 'refused', 'none', null, [], {
      code: 'ineligible-handoff',
      message: 'The handoff was none.',
    });
  }
  if (mode === 'refused' || finding.primaryRuleId === 'SEL-STRICT') {
    return row(finding, 'refused', 'none', null, [], {
      code: 'strict-needs-human',
      message: 'A strict mode locator needs a person to choose the element.',
    });
  }
  if (finding.handoff.mode === 'locator') {
    const after =
      process.env.FAKE_HEAL_XSS === '1'
        ? '<script>alert(1)</script>'
        : process.env.FAKE_HEAL_LONG === '1'
          ? Array.from({ length: 20 }, (_, index) => `patched line ${index}`).join('\n')
          : 'page.locator("#add-to-cart-sauce-labs-backpack")';
    return row(
      finding,
      'proposed',
      'locator-heal',
      'HEAL-SEL-LOCATOR',
      [
        {
          file: finding.file,
          startLine: finding.line || 1,
          endLine: finding.line || 1,
          before: "page.locator('#add-to-cart-sauce-labs-bakpack')",
          after,
        },
      ],
      null,
    );
  }
  return row(finding, 'refused', 'none', null, [], {
    code: 'no-safe-pattern',
    message: 'No safe pattern matched this failure.',
  });
}

function row(finding, status, strategy, fixRuleId, changes, refusal) {
  const proposed = status === 'proposed';
  return {
    findingId: finding.findingId,
    testId: finding.testId,
    status,
    strategy,
    fixRuleId,
    reviewLevel: proposed ? 'review-carefully' : 'standard',
    changes,
    patchFile: null,
    explanation: proposed
      ? 'One confident candidate on the live page, same element kind.'
      : refusal.message,
    refusal,
    verification: proposed
      ? {
          performed: true,
          method: 'shadow-rerun',
          runs: 1,
          passed: 1,
          failed: 0,
          baselineReproduced: true,
          outcome: 'passed',
        }
      : {
          performed: false,
          method: 'none',
          runs: 0,
          passed: 0,
          failed: 0,
          baselineReproduced: null,
          outcome: 'not-run',
        },
    ai: { used: false, label: null, promptSha256: null },
  };
}

function writeCompatResults() {
  const recorded = process.env.FAKE_HEAL_STDOUT;
  if (recorded) {
    const body = fs.readFileSync(recorded);
    process.stdout.write(body);
    if (!body.toString('utf8').endsWith('\n')) process.stdout.write('\n');
    process.exit(0);
  }
  const spec = args.find((arg) => arg !== '--' && !arg.startsWith('-')) ?? '';
  const base = spec.split(/[/\\]/).pop();
  const locators = [];
  const verdicts = [];
  if (base === 'broken.spec.ts') {
    const after =
      process.env.FAKE_HEAL_XSS === '1'
        ? '<script>alert(1)</script>'
        : 'page.locator("#add-to-cart-sauce-labs-backpack")';
    const before = "page.locator('#add-to-cart-sauce-labs-bakpack')";
    locators.push({
      file: spec,
      line: 4,
      old: before,
      new: after,
      level: 'css',
      ambiguous: false,
      status: 'proposed',
      reason: null,
    });
    verdicts.push({
      spec,
      testTitle: 'typo locator never finds the backpack button',
      classification: 'locator',
      message: 'Compat dry run quoted a locator change.',
      healApplied: false,
      before,
      after,
      verified: null,
      reverted: false,
      revertReason: null,
      occurrences: null,
    });
  } else if (base === 'selectors.spec.ts') {
    const before = "page.getByRole('button', { name: 'Remove' })";
    const reason = 'A strict mode locator needs a person to choose the element.';
    locators.push({
      file: spec,
      line: 8,
      old: before,
      new: null,
      level: 'role',
      ambiguous: false,
      status: 'refused',
      reason,
    });
    verdicts.push({
      spec,
      testTitle: 'unscoped Remove is strict when two items were added',
      classification: 'locator',
      message: reason,
      healApplied: false,
      before,
      after: null,
      verified: null,
      reverted: false,
      revertReason: null,
      occurrences: null,
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      dryRun: true,
      locators,
      verdicts,
      summary: { heals: 0, refusals: verdicts.length, nonLocator: 0, errors: 0 },
      fileErrors: [],
    })}\n`,
  );
  process.exit(0);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    process.stderr.write(`missing ${flag}\n`);
    process.exit(1);
  }
  return value;
}
