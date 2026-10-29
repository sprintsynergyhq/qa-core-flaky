# qa-core-flaky

qa-core-flaky triages flaky Playwright tests. It separates a likely real bug from an unstable test, names the likely cause, and suggests a fix for an engineer to review. It reads a Playwright JSON report or a JUnit XML report and prints one normalized record per test. It also names a likely cause for each failed or flaky test, with the evidence quoted from the error text. The JSON parser keeps every retry attempt. The JUnit parser keeps one attempt per test, because Playwright's default JUnit report does not list retries separately.

## Status

Version 0.1.0. The commands are `parse`, `causes`, `triage`, and `rerun`.

## Install

Node.js 22.6 or later is required.

```sh
npm i -D qa-core-flaky
npx qa-core-flaky --help
npx qa-core-flaky triage <report> --out-dir out --html
```

`rerun` needs `@playwright/test` 1.60.0 or later installed in the project that contains the tests. It is an optional peer dependency of this package.

The heal handoff needs `qa-core-heal` 0.4.0 or later for a re-run-verified fix. `qa-core-heal` 0.3.x gives only the older dry-run mode, which is not re-run verified. Install it in the same project when you use `--heal`.

## Quick Start

```sh
npx qa-core-flaky parse <report.json>
npx qa-core-flaky parse <report.junit.xml>
npx qa-core-flaky causes <report.json>
npx qa-core-flaky triage <report.json> --out-dir out --html
```

`rerun` needs a Playwright browser in the project under test. This example keeps one failing test and runs it once in each default mode:

```sh
npx qa-core-flaky rerun --from <report.json> --config playwright.config.ts --max-tests 1 --times 1
```

The format is detected from the file contents. The root element must be `testsuites` or `testsuite` for JUnit. A later mention of `<testsuite` is not enough. `--format json` or `--format junit` overrides that detection. Optional flags `--commit`, `--branch`, and `--run-id` are copied onto each record by `parse`. `--commit` applies to every report in that command. When it is omitted, a Playwright JSON report uses `config.metadata.gitCommit` when that field is a non-empty string. `--redact` hides home usernames in `parse` output. Without it, `parse` returns the original error text. `--out` writes the output to a file instead of stdout.

`causes` prints one block per failed or flaky test. `--json` prints a JSON array of `{ id, findings }`. `--test-timeout` supplies the timeout used by the near-timeout rule. The rule list is in [docs/causes.md](docs/causes.md).

`triage` writes `triage.json` and `triage.md` for each failed or flaky test. The JSON schema is [docs/report-schema.md](docs/report-schema.md). The verdict rows are [docs/verdicts.md](docs/verdicts.md). The default exit code is 2 when the report has at least one entry, and 0 when it has none. `--fail-on never` exits 0 after the files are written. A tool error exits 1. Do not point `--out-dir` at a directory under `/proc`. Creating a directory there can hang, which is a Node bug, and the command does not probe `/proc`.

`--heal-findings <file>` writes a findings file for qa-core-heal. `--heal` asks qa-core-heal for a dry run and stores the result on `healProposal`. The program is `npx --no-install qa-core-heal`, so a missing local install is not downloaded from the registry. A copy already in the npx cache can still run, so install qa-core-heal as a dev dependency for predictable results. Without `--heal`, that field stays null. The command never passes `--apply`, `--yes`, or `--no-verify`. The fields, the five handoff gates, and the redaction rules are in [docs/heal-contract.md](docs/heal-contract.md).

## HTML Report

`--html` writes `triage.html` in `--out-dir`, beside `triage.json` and `triage.md`. `rerun` accepts the same flag when it writes a triage report.

```sh
npx qa-core-flaky triage <report.json> --out-dir out --html --fail-on never
```

The page is one file. CSS and script are inline. It does not call the network, load a font, or load an image. Open it from disk, or attach the file to a message. The table is still readable when script is off. Filters, sorting, and the copy button need script.

The header is the report title. It shows the generated time when the JSON has a UTC `generatedAt`, for example 26 Oct 2026, 18:07 UTC. It shows a commit when a signal names 7 to 40 hex characters, and then only the first 7, in monospace. Summary cards count flagged tests and each verdict. A zero card is muted. A bar list counts the primary cause. The table lists the test, verdict, cause, confidence, failed attempts out of the total, and runs seen. The test title is shown with the file and project under it. Open a row for the evidence, the signals, the suggested fix, the next step, the attempts, rerun counts when the JSON has them, and the review status. The next step command is a block, with Copy Command under it. Attempts read as the total, the failed count, the passed count, and whether a pass and a fail used the same code. When a test was seen in more than one run, the row says so in words. On a narrow screen each test is a stacked card, and a Sort By control replaces the column buttons. Above that width the column buttons stay and Sort By is hidden. Printing opens every row and keeps the column headings. The footer is `Generated by qa-core-flaky` plus the version, then `Built by SprintSynergy.`

Home usernames are hidden, with the same rules as `parse --redact`. That is the file to share. `--html-no-redact` leaves those names visible. Token-like strings stay hidden. The JSON and Markdown reports still hide home names. Do not share a file made with that flag.

The screenshots are a SauceDemo run stored in `fixtures/reports/saucedemo-kit-triage.json`. The report lists 6 flaky tests. Tests that passed are not listed.

![Triage report, light](https://raw.githubusercontent.com/sprintsynergyhq/qa-core-flaky/main/examples/triage.png)

![Triage report, dark](https://raw.githubusercontent.com/sprintsynergyhq/qa-core-flaky/main/examples/triage-dark.png)

![Triage report, mobile](https://raw.githubusercontent.com/sprintsynergyhq/qa-core-flaky/main/examples/triage-mobile.png)

![Triage report, print](https://raw.githubusercontent.com/sprintsynergyhq/qa-core-flaky/main/examples/triage-print.png)

`rerun` runs the failing tests again with Playwright and merges the new attempts. `--retries` defaults to 0 so a retry cannot hide the first failure. `--root` is the JUnit project root. The modes and the safety rules are in [docs/rerun.md](docs/rerun.md). Unit tests do not launch a browser.

## Demo

`demo/saucedemo` is a Playwright suite for the public SauceDemo practice app. Some tests fail on purpose from a seed. `npm test` does not run it and does not call that site. The recorded reports and the run notes are in [demo/saucedemo/README.md](demo/saucedemo/README.md).

## Model

Each test becomes a record with a stable id, a file path, a project name, a title path, an expected status, an outcome, and every attempt. The outcome is passed, flaky, failed, or skipped. The full field list is in [docs/model.md](docs/model.md).

## Contributors

From a local clone, install dependencies, build, and run the commands against the committed fixtures:

```sh
git clone https://github.com/sprintsynergyhq/qa-core-flaky.git
cd qa-core-flaky
npm ci
npm run build
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.json
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.junit.xml
node dist/cli.js causes fixtures/reports/pw-1.60.0-outcomes.json
node dist/cli.js triage fixtures/reports/pw-1.60.0-outcomes.json --out-dir /tmp/qa-core-flaky-triage
```

`node dist/cli.js --help` lists the commands. See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and [SECURITY.md](SECURITY.md).

## Regenerating Fixtures

`npm run fixtures` runs the local Playwright project in `fixtures/pw-project` and rewrites `fixtures/reports/pw-1.60.0-outcomes.json` and `fixtures/reports/pw-1.60.0-outcomes.junit.xml` from that same run. Run it from the repository root. The script ignores the test process exit code, because some fixture tests are meant to fail. It then replaces volatile values with fixed placeholders: start times, durations, worker indexes, absolute paths, and a machine hostname when one is present. Playwright writes the project name in the JUnit `hostname` attribute, and that project name is left as-is. ANSI escape codes are removed. Repeated locator lines in error text are rewritten to a fixed count, because that count changes between runs.

Tests and CI use the committed report. They do not install browsers and they do not call the network. Regenerating the fixture needs the Playwright browser installed on the machine that runs the script.

## License

MIT. See [LICENSE](LICENSE).
