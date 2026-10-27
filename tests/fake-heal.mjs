#!/usr/bin/env node
/**
 * Stand-in for qa-core-heal. Tests point QA_CORE_HEAL_BIN at this file.
 * It records every argument list and returns a recorded dry-run result.
 * It exits 9 if it is ever passed --apply, --yes, or --no-verify.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_HEAL_MODE || 'contract';
const log = process.env.FAKE_HEAL_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);

for (const arg of args) {
  if (arg === '--apply' || arg === '--yes' || arg === '--no-verify' || arg.startsWith('--apply=') || arg.startsWith('--yes=') || arg.startsWith('--no-verify=')) {
    process.stderr.write(`refusing ${arg}\n`);
    process.exit(9);
  }
}

if (args[0] === 'capabilities') {
  if (mode === 'compat') {
    process.stderr.write('unknown command capabilities\n');
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({
      tool: { name: 'qa-core-heal', version: '0.4.0' },
      contracts: { findings: 1, results: 1 },
      playwrightVersion: '1.60.0',
    })}\n`,
  );
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
  const findingsPath = valueAfter('--findings');
  const resultsPath = valueAfter('--results');
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const body = fs.readFileSync(findingsPath);
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
  const spec = args.find((arg) => !arg.startsWith('-')) ?? '';
  const base = spec.split(/[/\\]/).pop();
  let results = [];
  if (base === 'broken.spec.ts') {
    results = [
      {
        file: spec,
        title: 'typo locator never finds the backpack button',
        status: 'proposed',
        strategy: 'locator-heal',
        explanation: 'Compat dry run quoted a locator change.',
        changes: [
          {
            file: 'broken.spec.ts',
            startLine: 4,
            endLine: 4,
            before: "page.locator('#add-to-cart-sauce-labs-bakpack')",
            after: 'page.locator("#add-to-cart-sauce-labs-backpack")',
          },
        ],
      },
    ];
  } else if (base === 'selectors.spec.ts') {
    results = [
      {
        file: spec,
        title: 'unscoped Remove is strict when two items were added',
        status: 'refused',
        message: 'A strict mode locator needs a person to choose the element.',
      },
    ];
  }
  process.stdout.write(`${JSON.stringify({ results })}\n`);
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
