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
| attempts.total | `number` | Every attempt that ran, including skipped attempts. An unselectable rerun command is not included. |
| attempts.failed | `number` | Attempts with status `failed`, `timedOut`, or `interrupted`. |
| attempts.passed | `number` | Attempts with status `passed`. |
| attempts.sameCommit | `boolean` | True when a pass and a fail share the same code. See [verdicts.md](verdicts.md). |
| attempts.reruns | object, optional | Present when rerun attempts were merged. Keys are `repeat`, `isolated`, and `in-order`. A mode is present when it ran or when a command could not select the test. Each value has `total`, `failed`, and `passed`. `total` counts attempts that ran. `notRun`, when present, is the number of unselectable commands and is not part of `total`. |
| observation | `string`, optional | `no flake observed in N runs` when every rerun attempt that ran passed. N is that number. An unselectable command is not included and does not block the sentence. Absent when no rerun ran, or a ran rerun did not pass. |
| history.runsSeen | `number` | How many input records had this id. |
| history.firstFailingCommit | `null` | Always null in this version. A later version can name the first failing commit. |
| suggestedFix | `string` | The fix template for the primary cause rule. It does not say to only raise a timeout. |
| healProposal | object or `null` | Null when triage is run without `--heal`. With `--heal`, a dry-run proposal from qa-core-heal. See [heal-contract.md](heal-contract.md). |
| nextStep | `string` | A sentence that contains `qa-core-flaky rerun --from <report> --only <id>`. The id is the redacted id. The report path is redacted. When the report recorded a Playwright config, the sentence also contains `--config`. Paste the command from the folder where triage ran. That path is relative to that folder when the config file is inside it and the relative path has no username. It is the file name when the relative path would climb with `..` or contain a username. It is never `<home>`. The rerun looks up Playwright from the config file's folder and each parent folder, so a kit that holds `node_modules` can be triaged from its parent. When one run failed on every attempt and no rerun was merged, the sentence also says to triage several runs with the same `--commit` before relying on the verdict. That hint does not change the verdict. |
| note | `string` or `null` | Set for an unexpected `test.fail()` pass, or when the failures have no error text. Otherwise null. |
| llm | `null` | Always null in this version. |
| review.status | `Needs Review` | Every entry starts here. The tool does not accept its own finding. |
| review.reviewer | `null` | No reviewer is recorded. |
| review.decision | `null` | No decision is recorded. |

## Markdown

The Markdown file starts with a summary table: test, verdict, cause, confidence. Then one section per test, in the same order. Each section has the causes, the evidence quotes, the attempt counts, the signals, the suggested fix, and the next step. Summary table cells and section headings escape `\`, `*`, `_`, and backticks, then `&`, then `<`, then `>`. A `|` in a cell becomes `\|`. A newline in a cell or a heading becomes the two characters `\` and `n`, so the row stays one line. Evidence quotes escape `\`, `*`, `_`, and backticks, then `&`, then `<`, then `>`. The next step escapes the sentence the same way, and puts the command in a code span. When the command contains a newline, that newline is written as the two characters `\` and `n`, so the span stays one line. `--only` treats that pair as a newline, so the copied command still selects the test. When the command has no newline, the span adds no backslashes. A title that contains a star, an underscore, or a backtick keeps those characters visible. A line such as `<div id="cover">`, a title such as `renders <Cart>`, and a home path written as `<home>` stay visible. `<home>` is escaped as `&lt;home&gt;` in those Markdown places. The JSON report keeps the raw `<home>` text. Cause rules read the original error text. Home redaction is applied to the evidence, the id, the title, and the next step when those strings are built. Evidence lines are deduped before that redaction. Within one entry, usernames are numbered from the id, then the title, then the file, then the evidence. The first is `<home>` and later different usernames are `<home~2>`, `<home~3>`. The same username keeps one mark. `C:\Users\alice` and `/home/Alice` are different marks, because the username match keeps its case. An app route such as `/home/feed` shows as `<home>`. Ids that redact to the same string stay separate entries. The first id is unchanged and the next ones gain ` (2)`, ` (3)`. A flaky section also has this sentence: "A flaky test can still point to a real app defect. Check the app behavior too." When rerun attempts are present, the attempts section lists counts per mode. A mode that ran uses `mode total N, failed F, passed P`. Unselectable commands are a separate clause, `mode not run N: could not select`. When every rerun attempt that ran passed, it also includes `no flake observed in N runs`. N does not include the unselectable commands.

`--out-dir` writes `triage.md` and `triage.json` together. Both are written to temp names, then renamed. If either write fails, the previous pair stays and no unpaired file is left behind. When the directory was empty and the second rename fails, the new file is removed too. A destination that is not a file, such as a directory named `triage.json`, is left as it is. Do not point `--out-dir` at a directory under `/proc`. Creating a directory there can hang. That is a Node bug. This command does not probe `/proc`.

`--commit` sets one SHA on every report in that command, and it overrides `config.metadata.gitCommit`. When `--commit` is omitted, a Playwright JSON report uses `config.metadata.gitCommit` or a top-level `metadata.gitCommit` when that value is a non-empty string. A signal names a commit only when a SHA is present. A blank `--commit` does not erase a SHA that the report already has.

When more than one commit is present, the cause list, the evidence, and the suggested fix come from the commit that selected the verdict. The other commit is a separate signal, and each signal names its commit.

The review line is `Review status: Needs Review.`

When `healProposal` is set, Markdown has the proposal label, the status, a refusal when heal returned one, and the diff. A diff in a fence is the diff text, not prose-escaped. A diff longer than 12 lines, or larger than 4000 bytes, is the relative path `h/<id>.diff`. The JSON report keeps the changes. The HTML page paints the status word from the stylesheet and links `h/<id>.diff` for the label, the explanation, and the diff. A skipped or unavailable row is the status word only. The detail headings in the HTML page are bold labels. Cause bars use width classes in that same stylesheet. A style attribute is not used, because the page policy would block it.

## HTML

`--html` writes `triage.html` in `--out-dir`, next to `triage.json` and `triage.md`. `rerun` accepts the same flag. The page is built from this schema. It does not add a verdict, a cause, or a count. `attempts.total`, `attempts.failed`, `attempts.passed`, `history.runsSeen`, and each rerun `total`, `failed`, `passed`, and `notRun` must be finite numbers. Any other value throws before the page is written. Home usernames are hidden again with the same rules as `parse --redact`, unless `--html-no-redact` is set. The file inlines its CSS and its script. It does not load a network resource. A Content-Security-Policy meta tag allows those inline blocks by hash and blocks every other source. `--html` needs `--out-dir`. Without script, the table is still readable and the filters stay hidden. A commit is shown only when a signal names 7 to 40 hex characters, and then only the first 7. `generatedAt`, when it is a UTC timestamp, is shown as a calendar time. The footer names the tool version.

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
