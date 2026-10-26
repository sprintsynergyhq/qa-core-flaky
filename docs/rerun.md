# Rerun Command

`qa-core-flaky rerun` runs selected failing tests again with Playwright, merges the new attempts into the records for the same commit, and writes a triage report. It does not edit test files, and it does not pass `--update-snapshots`.

## Command

```sh
qa-core-flaky rerun --from <report.json> [--times 5] [--retries <n>] [--modes repeat,isolated] [--config <playwright.config>] [--only <id>] [--max-tests 20] [--commit <sha>] [--root <dir>] [--out-dir <dir>]
```

Defaults are `--times 5`, `--retries 0`, `--modes repeat,isolated`, and `--max-tests 20`. Repeat `--only` to name more than one id.

`--retries` is passed to Playwright. The default is 0, and the range is 0 to 10. A retry inside the rerun lets Playwright hide a first-attempt failure and record a pass, so 0 keeps that first failure visible. Pass the same retry count CI uses when the measurement should include those retries. The stderr cap line includes the retry count. `--retries` is refused on `parse`, `causes`, and `triage`.

`--from` is a Playwright JSON report, a JUnit report, or the JSON from `parse` (a document with `records`). A triage report is not enough, because it does not keep the file and the title.

The cap line and each Playwright command go to stderr. The triage report goes to stdout. `--json` prints JSON on stdout. `--out-dir` writes `triage.json` and `triage.md` with the same pair rule as `triage`. Exit codes match `triage`.

The flags were checked against `npx playwright test --help` for Playwright 1.60.0: `--repeat-each`, `--retries`, `--workers`, `--reporter`, `-g`, `--project`, `--output`, and `--config`. `--project` is passed as one `--project=<name>` argument, including a project named `default`. In 1.60.0 that option takes one or more names, so a following file filter would be read as another project name. The file filter is placed after `--`, so a file name that starts with `-` is not read as an option. A project name that contains `*` or `?` is refused. Playwright treats `*` as a wildcard and compares project names without case, so this tool passes the exact name and then checks the rerun report.

## Modes

| Mode | What one command does |
| --- | --- |
| `repeat` | One command per selected test: `--repeat-each <times> --retries <n> --workers 1`, and either `file:line` or `-g`. `<n>` defaults to 0 |
| `isolated` | `<times>` commands per selected test. Each uses `--retries <n>` and `--workers 1`, and either `file:line` or `-g`. There is no `--repeat-each` |
| `in-order` | One command per file: `--retries <n> --workers 1`, the exact file, and no `-g`. `--workers 1` is set so that file runs in one worker |

Arguments are an array passed to the project's `node_modules/.bin/playwright`. The tool does not call `npx`, so a global Playwright is not used. If that binary is missing, the error names the path and says to install Playwright in this project. The child is not started from a shell string. The printed line quotes each argument for a person to read. That quoting is not how the process is started. Every printed line and every error is redacted. The file filter is printed with the same escapes the process received. Only the home segment is replaced with `<home>`, so a `.` stays `\.` and a character such as `[` stays escaped. Generated output and report paths use the command index (`out-0`, `report-0.json`). They are not built from the test id.

## How One Test Is Selected

Playwright treats each file argument as a regular expression against the absolute file path. `-g` is also a regular expression. A value that is not wrapped in slashes is compiled with the `i` flag (`forceRegExp` in Playwright 1.60.0). A value wrapped in `/.../` keeps only those flags. The grep title joins the project, the file, the describe titles, the test title, and any tags, with spaces.

Repeat and isolated use `file:line` only when that line is unique for the file and project among every test in the report, including a passing test. The file argument is then `/^<absolute path>$/:line`. Playwright's `file:line` selects every test on that line, and every test inside a describe that starts on that line, so a shared line is not one test. A unique line does not use the title, so a trailing tag such as `@smoke`, or a describe tag such as `@grp`, does not drop the test.

When the line is missing or shared, `-g` is `/^...$/` with no `i` flag. Each part of the project, the file, and the title path is escaped, and `(?: @\S+)*` may follow that part so a tag can sit after it. `^` and `$` wrap the whole grep title. This stops `save` from also running `autosave`, and `Login` from also running `login`. A title such as `a.b (c)` is one escaped part inside that anchored pattern. A newline in a title is written as `\n` inside that pattern. Playwright's `.` does not match a newline, and a raw newline would make the value fail the `/pattern/` check.

A title path `Outer` then `child` still has the same grep title as a different test whose title is `Outer child` when neither has a tag, and a tag such as `@smoke` between those parts still matches. A unique `file:line` avoids that collision. When the line is shared, the command uses `-g` and the result is checked afterwards. After every isolated run and every repeat run, the rerun report must contain exactly the requested test id and the expected attempt count (one for isolated, `--times` for repeat). Another id, a missing id, or the wrong count does not abort the rerun. That command is recorded as one `unselectable` attempt on the requested test. The error text starts with `Could not select this test.` and includes the child exit code and the end of stderr. Those Playwright attempts are not merged. The attempt is not a pass and not a failure. Signature, verdict, cause, `DATA-ORDER`, and `no flake observed` skip it, and it is not part of the attempt totals. The Reruns line lists it on its own, for example `isolated not run 3: could not select`. The other commands still run, and the triage report is still written. A child that exits 0 after running nothing is that unselectable attempt, not an unchanged result and not a failure.

In-order passes the absolute file after `--`, with no `-g` and no line. The pattern is anchored at both ends, so `tests/login.spec.ts` does not also run `old/tests/login.spec.ts`. Records from another file or another project, or a report with no tests, are recorded the same way: one `unselectable` attempt on each selected test in that file and project, and the rerun continues. Only a matching file and project are merged.

## Selection

Passing tests are skipped. `--only` may name a passing test, and that test is skipped. An id that is not in the report is an error. An id matches the raw id, or the redacted id that triage prints. A newline in the id may be written as the two characters `\` and `n`, which is what the Markdown next step does, and that form matches the test. A real newline matches too. Redaction does not change which test is rerun. A relative test path is not a home directory. `users/list.spec.ts`, `users/admin/edit.spec.ts`, `home/page.spec.ts`, and `Users/Shared/x` stay in the id, the file, the title, the evidence, and the `--only` value, so the printed command still names that one test. The child process receives the raw file and the raw title. If redaction would change the `-g` title, the printed command omits `-g` and says the title was redacted.

`--times` must be from 1 to 20. `--max-tests` must be from 1 to 50. `--retries` must be from 0 to 10. The plan refuses more than 400 commands. A mode cannot be listed twice. `--max-tests` keeps the first failing tests in the order they appear in the report. The default is 20 tests, 5 times, and 0 retries. The stderr cap line names the max, the times, the retries, the modes, how many failing tests were selected, and how many commands will run.

A stored file that is already a `<home>` or `<file~N>` mark cannot be rerun. The original path is gone.

The next step in the triage report includes `--config` when the source report recorded a Playwright config. That argument is a path relative to the report root, or the file name when a relative path would contain a username. It is never `<home>`. The report path in `--from` is still redacted.

## Merge

New attempts are appended to the record with the same id and the same commit. An empty commit matches an empty commit. Every original attempt is kept. Each new attempt has `rerun.mode` and `rerun.runIndex`. `runIndex` starts at 0 for each command and then counts results inside that command.

The triage entry lists counts per mode. An `unselectable` command is listed as `not run` and is not part of `total`, `failed`, or `passed`. When every rerun attempt that ran passed, the entry says `no flake observed in N runs`. N is the number of rerun attempts that ran. An `unselectable` command is not included and does not block that sentence. The report does not use another word for that result. If the original attempt failed and a rerun that ran passed on the same commit, the verdict is `flaky`. An `unselectable` command does not change the verdict or the cause.

## Order

A test that passes `in-order` and fails `isolated`, or the reverse, gets `DATA-ORDER` when each mode is consistent. The failing mode must share one error signature. The evidence line names the modes and the counts. See [causes.md](causes.md).

## Cleanup

Playwright JSON and artifacts go under a temp directory. Traces, screenshots, and the other files Playwright writes for the rerun are in that directory, and they are deleted with it when the run ends. That includes a successful run, a failed run, and a stop signal. The tool does not keep them. The test child is started with `TMPDIR`, `TMP`, and `TEMP` set to a `tmp` directory inside that rerun directory, so a Playwright profile folder is created there. The project root is read by a child process, not by importing Playwright in this process. That child gets `PWTEST_CACHE_DIR`, `TMPDIR`, `TMP`, and `TEMP` pointed at the same `tmp` directory, so the transform cache is removed with the rerun directory. The parent does not import Playwright, so it does not keep a cache directory of its own. The config path is passed in `QA_CORE_FLAKY_CONFIG`. The child is killed if it has not finished after 20 seconds.

On success, on failure, and on `SIGINT`, `SIGTERM`, and `SIGHUP`, cleanup has one owner. A second call waits for that same cleanup. The tool sends `SIGTERM` to the child's process group and to descendants of the spawned child. It polls every 20ms for up to 300ms until `kill(-pid, 0)` returns `ESRCH` (or `EPERM`), those descendants are gone, and the child `close` event has fired. If any of them is still alive, it sends `SIGKILL` to the same processes and polls for another 300ms. It then deletes the rerun directory. `fs.rm` uses `maxRetries: 5` and `retryDelay: 40`, and the tool tries that delete up to 3 times. `ENOENT` and `ENOTEMPTY` are not thrown. `EBUSY` and `EPERM` are retried and then ignored. That delete removes the profile folder. A signal sets a stopping flag before this cleanup starts. The plan starts no further command and prints no further failure, including `Playwright wrote no JSON report`. An error raised after that flag is set does not replace the signal. The process then exits 130 for `SIGINT`, 143 for `SIGTERM`, or 129 for `SIGHUP`, with no stack trace, and it does not write the triage report. A broken pipe, including stderr piped to `head`, does not skip this cleanup.

## Offline Tests

Unit tests read `fixtures/reports/rerun/`. Those files are small Playwright JSON documents used by the fake runner. They are not a browser log. `QA_CORE_FLAKY_LIVE=1` runs `fixtures/pw-project/tests/order.spec.ts` through the rerun command with `fixtures/pw-project/playwright.rerun.config.ts`. That test is skipped unless the variable is set. It uses `file://` only. It does not call the network. `QA_CORE_FLAKY_SIGNALS=1` runs a slow browser test five times for each of `SIGINT`, `SIGTERM`, and `SIGHUP`. That test is skipped unless the variable is set and the platform is Linux. It checks that the private temp directory is empty, that no process from the run remains, and that the exit code is 130, 143, or 129.

`fixtures/pw-project/tests/order.spec.ts` is a deterministic pair. The writer creates a marker file. The reader expects that file. In file order the reader passes. Alone, the reader fails. `afterAll` deletes the marker.
