# Triage Report Schema

`qa-core-flaky triage` writes schema version 1. For this version, the fields below keep their meaning. A later addition may add a field. It does not rename or remove these fields. The version number changes only when a field changes meaning.

The file is `triage.json`. `triage.md` is the same entries in Markdown. Two runs write the same bytes. `--timestamp` adds `generatedAt` and the bytes then change every run. No other field is a clock time.

Passed and skipped tests are omitted. A test that was expected to fail, and did fail, is outcome `passed` and is omitted. One entry is one test id. Records that share an id are merged. Entry order is `likely-real-bug`, `flaky`, `broken-test`, `environment-issue`, `needs-more-runs`, and then the id.

## Report

| Field | Type | Meaning |
| --- | --- | --- |
| schemaVersion | `1` | This document. |
| entries | `TriageEntry[]` | One entry per failed or flaky test. Empty when every test passed or was skipped. |
| generatedAt | `string`, optional | ISO time. Present only with `--timestamp`. |

## Entry

| Field | Type | Meaning |
| --- | --- | --- |
| id | `string` | Test id from the normalized record. |
| verdict | verdict name | `likely-real-bug`, `flaky`, `broken-test`, `environment-issue`, or `needs-more-runs`. `likely-real-bug` means a likely real bug. The report does not say confirmed. |
| confidence | `high`, `medium`, or `low` | See [verdicts.md](verdicts.md). |
| ruleId | `string` | The decision row: `BROKEN-TEST`, `ENVIRONMENT-ISSUE`, `LIKELY-REAL-BUG`, `FLAKY`, `NEEDS-MORE-RUNS`, or `UNEXPECTED-PASS`. |
| signals | `VerdictSignal[]` | The signals that were present, in this order when more than one applies: `consistent-failure`, `same-code-flip`, `insufficient-evidence`, `unexpected-pass`. |
| signals[].kind | signal name | One of those four names. |
| signals[].detail | `string` | One sentence about that signal. |
| causes | cause findings | The cause findings from [causes.md](causes.md). The cause that selected the verdict is first. |
| causes[].cause | cause name | `selectors`, `timing`, `test-data`, `environment`, or `unknown`. |
| causes[].confidence | `high`, `medium`, or `low` | Cause confidence. |
| causes[].evidence | `string[]` | Exact substrings of the error text. Each one is at most 300 characters. |
| causes[].ruleIds | `string[]` | Cause rule ids, in rule-table order. |
| evidence | `string[]` | The cause evidence lines, in cause order, without duplicates. An unexpected pass, or any verdict whose failures have no error text, uses the note as its one evidence line. |
| attempts.total | `number` | Every attempt, including skipped attempts. |
| attempts.failed | `number` | Attempts with status `failed`, `timedOut`, or `interrupted`. |
| attempts.passed | `number` | Attempts with status `passed`. |
| attempts.sameCommit | `boolean` | True when a pass and a fail share the same code. See [verdicts.md](verdicts.md). |
| history.runsSeen | `number` | How many input records had this id. |
| history.firstFailingCommit | `null` | Always null in this version. A later version can name the first failing commit. |
| suggestedFix | `string` | The fix template for the primary cause rule. It does not say to only raise a timeout. |
| healProposal | `null` | Always null in this version. A later version can attach a heal diff. |
| nextStep | `string` | A sentence that contains the exact command `qa-core-flaky rerun <file> -g <title> --times 10`. |
| note | `string` or `null` | Set for an unexpected `test.fail()` pass, or when the failures have no error text. Otherwise null. |
| llm | `null` | Always null in this version. |
| review.status | `Needs Review` | Every entry starts here. The tool does not accept its own finding. |
| review.reviewer | `null` | No reviewer is recorded. |
| review.decision | `null` | No decision is recorded. |

## Markdown

The Markdown file starts with a summary table: test, verdict, cause, confidence. Then one section per test, in the same order. Each section has the causes, the evidence quotes, the attempt counts, the signals, the suggested fix, and the next step. Summary table cells, section headings, evidence quotes, and the next step escape `&`, then `<`, then `>`. A line such as `<div id="cover">`, a title such as `renders <Cart>`, and a home path written as `<home>` stay visible. `<home>` is escaped as `&lt;home&gt;` in those Markdown places. The JSON report keeps the raw `<home>` text. Cause rules read the original error text. Home redaction is applied to the evidence, the id, the title, and the next step when those strings are built. A flaky section also has this sentence: "A flaky test can still point to a real app defect. Check the app behavior too."

When more than one commit is present, the cause list, the evidence, and the suggested fix come from the commit that selected the verdict. The other commit is a separate signal, and each signal names its commit.

The review line is `Review status: Needs Review.`

## Exit Codes

| Code | When |
| --- | --- |
| 0 | The report was written and it has no entries, or `--fail-on never` was set |
| 1 | The tool could not read or write the report. Stderr is one line |
| 2 | The report was written and it has at least one entry. This is the default, `--fail-on findings` |

## Command

```sh
node dist/cli.js triage fixtures/reports/pw-1.60.0-outcomes.json --out-dir /tmp/qa-core-flaky-triage
```

That writes `triage.json` and `triage.md`. `--json` also prints the JSON on stdout. `--fail-on never` exits 0 after the same files are written. `--test-timeout` is forwarded to the near-timeout cause rule. `--commit`, `--branch`, and `--run-id` are stored on every record, the same way `parse` stores them.
