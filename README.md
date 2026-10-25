# qa-core-flaky

qa-core-flaky will triage flaky Playwright tests. It separates a likely real bug from an unstable test, names the likely cause, and suggests a fix for an engineer to review. This repository reads a Playwright JSON report or a JUnit XML report and prints one normalized record per test. It also names a likely cause for each failed or flaky test, with the evidence quoted from the error text. The JSON parser keeps every retry attempt. The JUnit parser keeps one attempt per test, because Playwright's default JUnit report does not list retries separately.

## Status

Early development. This repository is private until v0.1 review. The commands are `parse` and `causes`.

## Quick Start

From a local clone, build the project and parse a report:

```sh
npm ci
npm run build
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.json
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.junit.xml
node dist/cli.js causes fixtures/reports/pw-1.60.0-outcomes.json
```

The package is not published. Use the commands above from a local clone. `node dist/cli.js --help` lists the commands.

The format is detected from the file contents. The root element must be `testsuites` or `testsuite` for JUnit. A later mention of `<testsuite` is not enough. `--format json` or `--format junit` overrides that detection. Optional flags `--commit`, `--branch`, and `--run-id` are copied onto each record by `parse`. `--out` writes the output to a file instead of stdout.

`causes` prints one block per failed or flaky test. `--json` prints a JSON array of `{ id, findings }`. `--test-timeout` supplies the timeout used by the near-timeout rule. The rule list is in [docs/causes.md](docs/causes.md).

## Model

Each test becomes a record with a stable id, a file path, a project name, a title path, an expected status, an outcome, and every attempt. The outcome is passed, flaky, failed, or skipped. The full field list is in [docs/model.md](docs/model.md).

## Regenerating Fixtures

`npm run fixtures` runs the local Playwright project in `fixtures/pw-project` and rewrites `fixtures/reports/pw-1.60.0-outcomes.json` and `fixtures/reports/pw-1.60.0-outcomes.junit.xml` from that same run. Run it from the repository root. The script ignores the test process exit code, because some fixture tests are meant to fail. It then replaces volatile values with fixed placeholders: start times, durations, worker indexes, absolute paths, and a machine hostname when one is present. Playwright writes the project name in the JUnit `hostname` attribute, and that project name is left as-is. ANSI escape codes are removed. Repeated locator lines in error text are rewritten to a fixed count, because that count changes between runs.

Tests and CI use the committed report. They do not install browsers and they do not call the network. Regenerating the fixture needs the Playwright browser installed on the machine that runs the script.

## License

MIT. See [LICENSE](LICENSE). This repository is private until v0.1 review.
