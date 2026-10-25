# qa-core-flaky

qa-core-flaky will triage flaky Playwright tests. It separates a likely real bug from an unstable test, names the likely cause, and suggests a fix for an engineer to review. This repository currently reads a Playwright JSON report or a JUnit XML report and prints one normalized record per test. The JSON parser keeps every retry attempt. The JUnit parser keeps one attempt per test, because Playwright's default JUnit report does not list retries separately.

## Status

Early development. This repository is private until v0.1 review. Only the parse command exists.

## Quick Start

From a local clone, build the project and parse a report:

```sh
npm ci
npm run build
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.json
node dist/cli.js parse fixtures/reports/pw-1.60.0-outcomes.junit.xml
```

The package is not published. Use the commands above from a local clone. `node dist/cli.js --help` lists the parse command.

The format is detected from the file contents. `--format json` or `--format junit` overrides that detection. Optional flags `--commit`, `--branch`, and `--run-id` are copied onto each record. `--out` writes the JSON to a file instead of stdout.

## Model

Each test becomes a record with a stable id, a file path, a project name, a title path, an expected status, an outcome, and every attempt. The outcome is passed, flaky, failed, or skipped. The full field list is in [docs/model.md](docs/model.md).

## Regenerating Fixtures

`npm run fixtures` runs the local Playwright project in `fixtures/pw-project` and rewrites `fixtures/reports/pw-1.60.0-outcomes.json` and `fixtures/reports/pw-1.60.0-outcomes.junit.xml` from that same run. Run it from the repository root. The script ignores the test process exit code, because some fixture tests are meant to fail. It then replaces volatile values with fixed placeholders: start times, durations, worker indexes, absolute paths, and a machine hostname when one is present. Playwright writes the project name in the JUnit `hostname` attribute, and that project name is left as-is. ANSI escape codes are removed. Repeated locator lines in error text are rewritten to a fixed count, because that count changes between runs.

Tests and CI use the committed report. They do not install browsers and they do not call the network. Regenerating the fixture needs the Playwright browser installed on the machine that runs the script.

## License

MIT. See [LICENSE](LICENSE). This repository is private until v0.1 review.
