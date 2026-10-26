# Verdicts

`decideVerdict` reads every record for one test id and returns one verdict. There is no model call. The rows below are applied in order. The first row that matches wins.

A pass and a fail are on the same code when they share a commit SHA. A missing SHA counts as the same code only inside one report. Attempts with status `failed`, `timedOut`, or `interrupted` are failures. `passed` attempts are passes. Skipped attempts are neither. An `unselectable` rerun attempt is neither, and it does not change the verdict, the cause, or `no flake observed`.

When a later run fails on every attempt with one error signature, that consistent failure is checked before a same-code flip. A broken test, an environment issue, or a likely real bug outranks flaky. The report lists both signals.

A later code group that only passes removes the earlier consistent verdict. A broken test on commit `aaa`, then a pass on commit `bbb`, is `needs-more-runs`. The pass and the fail are not the same code, so the verdict is not flaky. A pass and a fail on one SHA are still flaky.

Without a commit SHA, a run id is the code key. With neither, the report path with `.json`, `.xml`, or `.junit.xml` removed is the key, so one run's JSON and JUnit files are one group. `collapseRunRecords` resolves `.` and `..` first, so `./report.json` and an absolute spelling of that file are one path. `triage` uses `realpath` only to drop a repeated path before parsing. The error names the path that was typed. A second file with the same normalized contents is dropped before parsing too, so a copy is not a second run. Normalization turns CRLF into LF, drops trailing newlines, and parses JSON before hashing, so a pretty copy and a compact copy of one JSON report are one run. A real second run whose normalized contents are identical is also treated as a copy.

A JSON report and a JUnit report with different stems (`results.json` and `junit.xml`) and no SHA or run id stay two code groups unless their test id sets match and their timestamps match. The timestamp is `createdAt` when every record in the file has the same value, otherwise the sorted `startTime` values. Without a shared timestamp they stay two groups. When they pair, both files share a run id, the JSON record is kept, and the JUnit record is not counted again.

"Later" is `createdAt` when every code group has one. Otherwise it is the earliest `startTime` when every code group has one. Mixed clocks, or a group with neither, stay in command-line order. Ties keep command-line order.

Rerun attempts are attempts. They use the commit stored on the record. Five failing reruns of one signature, added to one earlier failure of that signature, are enough for `likely-real-bug` when the cause is unknown. A passing rerun on that same commit makes the verdict `flaky`. When every rerun attempt passed, the entry also says `no flake observed in N runs`. N is the number of rerun attempts. The report does not call the test anything else for that result.

## Confidence

| Confidence | When |
| --- | --- |
| low | The test has fewer than 3 pass or fail attempts |
| high | There are at least 3 such attempts, the decision row is high, and the primary cause is high |
| medium | Anything else |

The high rows are broken test, environment issue, likely real bug, and flaky. Needs more runs is a low row. Cause confidence is the value from [causes.md](causes.md).

## Decision Table

| Order | Row id | When | Verdict |
| --- | --- | --- | --- |
| 1 | `BROKEN-TEST` | One code group failed on every attempt with one error signature, and the primary cause is selectors with `SEL-NOTFOUND` | `broken-test` |
| 2 | `ENVIRONMENT-ISSUE` | One code group failed on every attempt with one error signature, and the primary cause is environment | `environment-issue` |
| 3 | `LIKELY-REAL-BUG` | One code group failed on every attempt with one error signature, that group has at least 2 failures, and the primary cause is unknown. A resolved locator whose received value does not change is this unknown cause (`UNK-NONE`). Attempts with no error text are not this row | `likely-real-bug` |
| 4 | `FLAKY` | At least one pass and one fail on the same code, and no earlier row matched | `flaky` |
| 5 | `NEEDS-MORE-RUNS` | Only one failed attempt in total, or the failures do not share one error signature and there is no pass | `needs-more-runs` |
| 6 | `UNEXPECTED-PASS` | `expectedStatus` is `failed`, an attempt passed, and no attempt failed. This is a `test.fail()` test that passed. The verdict has a note | `needs-more-runs` |
| 7 | `NEEDS-MORE-RUNS` | No earlier row matched. A repeated timeout whose primary cause is not one of the rows above lands here | `needs-more-runs` |

The verdict value `likely-real-bug` is a likely real bug. The report does not say confirmed.

## Examples

### Broken Test

Three attempts, each `Error: element(s) not found`. One signature. Primary cause selectors, rule `SEL-NOTFOUND`, confidence high. Three attempts, so the entry confidence is high.

One attempt with the same error is still a broken test. Fewer than 3 attempts, so the entry confidence is low.

### Environment Issue

Three attempts, each `net::ERR_CONNECTION_REFUSED` or `ECONNREFUSED`. Primary cause environment. Entry confidence high when the cause is high and there are at least 3 attempts.

### Likely Real Bug

Three attempts, each failing `toHaveText` with the same `Received:` line. The cause rules call that unknown, not selectors and not timing. Two or more failures and one signature select `likely-real-bug`. The unknown cause is low, so the entry confidence is medium once there are 3 attempts. Two attempts are still this verdict, with low confidence because there are fewer than 3.

`Received: "1"` on one attempt and `Received: "2"` on the next do not share a signature. That case is not this row.

### Flaky

One failure and one pass in the same report, with no commit SHA. The missing SHA matches inside that report, so the verdict is flaky. Two attempts, so the confidence is low.

The same pass and fail on one commit SHA across two reports is also flaky. A pass in one report and a fail in another report, both without a SHA, are not the same code.

A flaky entry includes this sentence: "A flaky test can still point to a real app defect. Check the app behavior too."

A flaky entry whose failed attempts have no error text still has evidence. The note, and the evidence line, are: "The report has no error text for these attempts." The same line is used for any other verdict whose failures have no error text.

### Needs More Runs

One attempt and an error that matches no stronger row, such as `Error: gave up`. Verdict `needs-more-runs`, confidence low.

Three attempts that fail with three different messages, and no pass. Verdict `needs-more-runs`, confidence medium.

Three failed attempts and no error text on any of them. The cause is unknown (`UNK-EMPTY`), and there is nothing to quote, so this is not a likely real bug. Verdict `needs-more-runs`. The note, and the evidence line, are: "The report has no error text for these attempts."

### Unexpected Pass

`expectedStatus` is `failed` and the only attempt passed. Playwright records that as an unexpected pass of `test.fail()`. Verdict `needs-more-runs`. The note is: "This test uses test.fail() and it passed. The expected failure did not happen."

A `test.fail()` test that does fail is outcome `passed` in the normalized model. Triage does not list it.

### Times Out In The Fixture

`times out` in `fixtures/reports/pw-1.60.0-outcomes.json` has three `timedOut` attempts and one signature. The causes are selectors (`SEL-UNRESOLVED`) and timing (`TIM-TEST-TIMEOUT`). The primary cause is selectors, and the rule is not `SEL-NOTFOUND`, so row 1 does not match. It is not environment and it is not unknown, so rows 2 and 3 do not match. There is no pass, so it is not flaky. There is more than one failure and only one signature, so row 5 does not match. The verdict is `needs-more-runs`.

### Both Signals

One report on SHA `aaa` has a pass and a fail. A later report on SHA `bbb` fails twice with the same unknown value mismatch. Row 3 matches the later run, so the verdict is `likely-real-bug`. The signals are `consistent-failure` and `same-code-flip`. The cause, the evidence, and the suggested fix come from commit `bbb`. The flip on commit `aaa` is the other signal. Each signal names its commit.

An environment failure that is consistent on a new SHA outranks an earlier flip the same way. The verdict is `environment-issue`, and both signals are listed.
