# Rerun Command

`qa-core-flaky rerun` runs selected failing tests again with Playwright, merges the new attempts into the records for the same commit, and writes a triage report. It does not edit test files, and it does not pass `--update-snapshots`.

## Command

```sh
qa-core-flaky rerun --from <report.json> [--times 5] [--modes repeat,isolated] [--config <playwright.config>] [--only <id>] [--max-tests 20] [--commit <sha>] [--out-dir <dir>]
```

Defaults are `--times 5`, `--modes repeat,isolated`, and `--max-tests 20`. Repeat `--only` to name more than one id.

`--from` is a Playwright JSON report, a JUnit report, or the JSON from `parse` (a document with `records`). A triage report is not enough, because it does not keep the file and the title.

The cap line and each Playwright command go to stderr. The triage report goes to stdout. `--json` prints JSON on stdout. `--out-dir` writes `triage.json` and `triage.md` with the same pair rule as `triage`. Exit codes match `triage`.

The flags were checked against `npx playwright test --help` for Playwright 1.60.0: `--repeat-each`, `--retries`, `--workers`, `--reporter`, `-g`, `--project`, `--output`, and `--config`. `--project` is passed as one `--project=<name>` argument, including a project named `default`. In 1.60.0 that option takes one or more names, so a following file filter would be read as another project name. The file filter is placed after `--`, so a file name that starts with `-` is not read as an option. A project name that contains `*` or `?` is refused. Playwright treats `*` as a wildcard and compares project names without case, so this tool passes the exact name and then checks the rerun report.

## Modes

| Mode | What one command does |
| --- | --- |
| `repeat` | One command per selected test: `--repeat-each <times> --retries 0 --workers 1`, and either `file:line` or `-g` |
| `isolated` | `<times>` commands per selected test. Each uses `--retries 0` and `--workers 1`, and either `file:line` or `-g`. There is no `--repeat-each` |
| `in-order` | One command per file: `--retries 0 --workers 1`, the exact file, and no `-g`. `--workers 1` is set so that file runs in one worker |

Arguments are an array passed to the project's `node_modules/.bin/playwright`. The tool does not call `npx`, so a global Playwright is not used. If that binary is missing, the error names the path and says to install Playwright in this project. The child is not started from a shell string. The printed line quotes each argument for a person to read. That quoting is not how the process is started. Every printed line and every error is redacted. Generated output and report paths use the command index (`out-0`, `report-0.json`). They are not built from the test id.

## How One Test Is Selected

Playwright treats each file argument as a regular expression against the absolute file path. `-g` is also a regular expression. A value that is not wrapped in slashes is compiled with the `i` flag (`forceRegExp` in Playwright 1.60.0). A value wrapped in `/.../` keeps only those flags. The grep title joins the project, the file, the describe titles, the test title, and any tags, with spaces.

Repeat and isolated prefer `file:line` when the report stored a line. The file argument is `/^<absolute path>$/:line`. That selects one location. It does not use the title, so a trailing tag such as `@smoke`, or a describe tag such as `@grp`, does not drop the test.

When the report has no line, `-g` is `/^...$/` with no `i` flag. Each part of the project, the file, and the title path is escaped, and `(?: @\S+)*` may follow that part so a tag can sit after it. `^` and `$` wrap the whole grep title. This stops `save` from also running `autosave`, and `Login` from also running `login`. A title such as `a.b (c)` is one escaped part inside that anchored pattern.

A title path `Outer` then `child` still has the same grep title as a different test whose title is `Outer child` when neither has a tag. `file:line` avoids that. After every isolated run and every repeat run, the rerun report must contain exactly the requested test id and the expected attempt count (one for isolated, `--times` for repeat). Another id, a missing id, or the wrong count fails that mode. Those attempts are not merged. A child that exits 0 after running nothing is that error, not an unchanged result. The error includes the child exit code and the end of stderr.

In-order passes the absolute file after `--`, with no `-g` and no line. The pattern is anchored at both ends, so `tests/login.spec.ts` does not also run `old/tests/login.spec.ts`. Records from another file or another project are an error. A report with no tests is an error. Only the requested file and project are merged.

## Selection

Passing tests are skipped. `--only` may name a passing test, and that test is skipped. An id that is not in the report is an error. An id matches the raw id, or the redacted id that triage prints. Redaction does not change which test is rerun. The child process receives the raw file and the raw title. If redaction would change the `-g` title, the printed command omits `-g` and says the title was redacted.

`--times` must be from 1 to 20. `--max-tests` must be from 1 to 50. The plan refuses more than 400 commands. A mode cannot be listed twice. `--max-tests` keeps the first failing tests in the order they appear in the report. The default is 20 tests and 5 times. The stderr cap line names the max, the times, the modes, how many failing tests were selected, and how many commands will run.

A stored file that is already a `<home>` or `<file~N>` mark cannot be rerun. The original path is gone.

The next step in the triage report includes `--config` when the source report recorded a Playwright config. That path is redacted with the rest of the entry.

## Merge

New attempts are appended to the record with the same id and the same commit. An empty commit matches an empty commit. Every original attempt is kept. Each new attempt has `rerun.mode` and `rerun.runIndex`. `runIndex` starts at 0 for each command and then counts results inside that command.

The triage entry lists counts per mode. When every rerun attempt passed, the entry says `no flake observed in N runs`. N is the number of rerun attempts. The report does not use another word for that result. If the original attempt failed and a rerun passed on the same commit, the verdict is `flaky`.

## Order

A test that passes `in-order` and fails `isolated`, or the reverse, gets `DATA-ORDER` when each mode is consistent. The failing mode must share one error signature. The evidence line names the modes and the counts. See [causes.md](causes.md).

## Cleanup

Playwright JSON and artifacts go under a temp directory. The child is started with `TMPDIR`, `TMP`, and `TEMP` set to a `tmp` directory inside that rerun directory, so a Playwright profile folder is created there. On success, on failure, and on `SIGINT`, `SIGTERM`, and `SIGHUP`, the tool sends `SIGTERM` to the process group, waits, then sends `SIGKILL`, and then deletes the rerun directory. That delete removes the profile folder. A broken pipe, including stderr piped to `head`, does not skip this cleanup.

## Offline Tests

Unit tests read `fixtures/reports/rerun/`. Those files are small Playwright JSON documents used by the fake runner. They are not a browser log. `QA_CORE_FLAKY_LIVE=1` runs `fixtures/pw-project/tests/order.spec.ts` through the rerun command with `fixtures/pw-project/playwright.rerun.config.ts`. That test is skipped unless the variable is set. It uses `file://` only. It does not call the network.

`fixtures/pw-project/tests/order.spec.ts` is a deterministic pair. The writer creates a marker file. The reader expects that file. In file order the reader passes. Alone, the reader fails. `afterAll` deletes the marker.
