# Rerun Command

`qa-core-flaky rerun` runs selected failing tests again with Playwright, merges the new attempts into the records for the same commit, and writes a triage report. It does not edit test files, and it does not pass `--update-snapshots`.

## Command

```sh
qa-core-flaky rerun --from <report.json> [--times 5] [--modes repeat,isolated] [--config <playwright.config>] [--only <id>] [--max-tests 20] [--commit <sha>] [--out-dir <dir>]
```

Defaults are `--times 5`, `--modes repeat,isolated`, and `--max-tests 20`. Repeat `--only` to name more than one id.

`--from` is a Playwright JSON report, a JUnit report, or the JSON from `parse` (a document with `records`). A triage report is not enough, because it does not keep the file and the title.

The cap line and each Playwright command go to stderr. The triage report goes to stdout. `--json` prints JSON on stdout. `--out-dir` writes `triage.json` and `triage.md` with the same pair rule as `triage`. Exit codes match `triage`.

The flags were checked against `npx playwright test --help` for Playwright 1.60.0: `--repeat-each`, `--retries`, `--workers`, `--reporter`, `-g`, `--project`, `--output`, and `--config`.

## Modes

| Mode | What one command does |
| --- | --- |
| `repeat` | One command per selected test: `--repeat-each <times> --retries 0 --workers 1` and `-g` |
| `isolated` | `<times>` commands per selected test. Each uses `-g`, `--retries 0`, and `--workers 1`. There is no `--repeat-each` |
| `in-order` | One command per file: `--retries 0 --workers 1`, and no `-g`. `--workers 1` is set so that file runs in one worker |

Arguments are an array passed to `npx playwright test`. The child is not started from a shell string. The printed line quotes each argument for a person to read. That quoting is not how the process is started.

## How `-g` Is Escaped

Playwright treats each test-filter argument as a regular expression against the absolute file path. `-g` is a regular expression. A value that is not wrapped in slashes is compiled with the `i` flag (`forceRegExp` in Playwright 1.60.0). The grep title joins the file suite title, the describe titles, and the test title with spaces.

This tool escapes the title path, joined with spaces, and adds `$` so the pattern matches the end of that grep title. The file filter is escaped the same way. A title such as `a.b (c)` is passed as `a\.b \(c\)$`.

## Selection

Passing tests are skipped. `--only` may name a passing test, and that test is skipped. An id that is not in the report is an error. An id matches the raw id, or the redacted id that triage prints. Redaction does not change which test is rerun. The child process receives the raw file and the raw title. If redaction would change the `-g` title, the printed command omits `-g` and says the title was redacted.

`--max-tests` keeps the first failing tests in the order they appear in the report. The default is 20. The stderr cap line names the max, the times, the modes, how many failing tests were selected, and how many commands will run.

A stored file that is already a `<home>` or `<file~N>` mark cannot be rerun. The original path is gone.

## Merge

New attempts are appended to the record with the same id and the same commit. An empty commit matches an empty commit. Every original attempt is kept. Each new attempt has `rerun.mode` and `rerun.runIndex`. `runIndex` starts at 0 for each command and then counts results inside that command.

The triage entry lists counts per mode. When every rerun attempt passed, the entry says `no flake observed in N runs`. N is the number of rerun attempts. The report does not use another word for that result. If the original attempt failed and a rerun passed on the same commit, the verdict is `flaky`.

## Order

A test that passes `in-order` and fails `isolated`, or the reverse, gets `DATA-ORDER` when each mode is consistent. The failing mode must share one error signature. The evidence line names the modes and the counts. See [causes.md](causes.md).

## Cleanup

Playwright JSON and artifacts go under a temp directory. On success, on failure, and on `SIGINT`, `SIGTERM`, and `SIGHUP`, the tool kills the Playwright process group and then deletes that directory.

## Offline Tests

Unit tests read `fixtures/reports/rerun/`. Those files are small Playwright JSON documents used by the fake runner. They are not a browser log. `QA_CORE_FLAKY_LIVE=1` runs `fixtures/pw-project/tests/order.spec.ts` through the rerun command with `fixtures/pw-project/playwright.rerun.config.ts`. That test is skipped unless the variable is set. It uses `file://` only. It does not call the network.

`fixtures/pw-project/tests/order.spec.ts` is a deterministic pair. The writer creates a marker file. The reader expects that file. In file order the reader passes. Alone, the reader fails. `afterAll` deletes the marker.
