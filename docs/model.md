# Normalized Model

Parsers emit this model. The Playwright JSON parser and the JUnit parser both fill it.

## Parse Result

`ParseResult` is the value printed by `qa-core-flaky parse`.

| Field | Type | Meaning |
| --- | --- | --- |
| schemaVersion | `1` | Schema version of the parse result. This parser always writes `1`. |
| records | `TestRecord[]` | One record per test in the report. |
| warnings | `string[]` | Problems that did not stop the parse. A test with zero results adds a warning. A file path outside the report root adds a warning. |

## Test Record

| Field | Type | Meaning |
| --- | --- | --- |
| id | `string` | Stable id from `makeTestId`: file, project, and title path, joined as `file::project::title path`. The title path uses ` > ` between titles. |
| file | `string` | Spec file, relative to the report `config.rootDir` when that field is present and the file sits inside it. Forward slashes. Never an absolute machine path. A path outside that root is rewritten to a relative path, and the parse adds a warning that quotes the relative path only. In Playwright 1.60.0, `config.rootDir` is the resolved `testDir` when the config sets `testDir`, and the config directory otherwise. |
| line | `number`, optional | Line of the test in `file`, when the report has one. |
| project | `string` | Playwright project name. `default` when the report has no project name. |
| titlePath | `string[]` | Describe titles, then the spec title. The file-level suite title is left out. In Playwright 1.60.0 that suite has line 0 and its title is the spec path. A describe has a source line, and its title is kept even when the title equals the spec file name. |
| expectedStatus | `passed`, `failed`, `skipped`, `timedOut`, or `interrupted` | The status the test was expected to finish with. |
| outcome | `Outcome` | Normalized result for the whole test, after retries. |
| attempts | `Attempt[]` | Every retry attempt, sorted by `retry`. |
| source | `SourceInfo` | Which report the record came from. |

## Outcome

`passed`, `flaky`, `failed`, or `skipped`.

Playwright's test `status` maps as follows.

| Playwright status | Outcome |
| --- | --- |
| `expected` | `passed`, or `skipped` when every result was skipped |
| `unexpected` | `failed` |
| `flaky` | `flaky` |
| `skipped` | `skipped` |

An unknown Playwright status becomes `failed` and adds a warning. An unknown `expectedStatus` becomes `passed` and adds a warning. An unknown attempt status becomes `failed`.

## Attempt

| Field | Type | Meaning |
| --- | --- | --- |
| retry | `number` | Retry index from the report. The first run is `0`. |
| status | `AttemptStatus` | `passed`, `failed`, `timedOut`, `skipped`, or `interrupted`. |
| durationMs | `number` | Attempt duration in milliseconds, from the report `duration` field. |
| errors | `AttemptError[]` | Errors for this attempt. ANSI escape codes are removed. |
| attachments | `Attachment[]` | Attachments for this attempt. |
| workerIndex | `number`, optional | Worker that ran the attempt, when the report has one. |
| startTime | `string`, optional | Start time from the report, when present. |

## Attempt Error

| Field | Type | Meaning |
| --- | --- | --- |
| message | `string` | Error text with ANSI escape codes removed. |
| stack | `string`, optional | Stack trace with ANSI escape codes removed, when the report has one. |
| location | object, optional | Source location, when the report has `file`, `line`, and `column`. |
| location.file | `string` | File path, made relative to `config.rootDir` when it sits inside that directory. A path outside that root is rewritten to a relative path. Never an absolute machine path. |
| location.line | `number` | Line number. |
| location.column | `number` | Column number. |

## Attachment

| Field | Type | Meaning |
| --- | --- | --- |
| name | `string` | Attachment name. |
| path | `string`, optional | Path on disk, when the report has one. Made relative to `config.rootDir` when the file sits inside that directory. A path outside that root is rewritten to a relative path. Never an absolute machine path. |
| contentType | `string` | Media type from the report. An empty string is used when the report omits it. |

## Source Info

| Field | Type | Meaning |
| --- | --- | --- |
| format | `playwright-json` or `junit` | Report format. The JSON parser writes `playwright-json`. The JUnit parser writes `junit`. |
| reportPath | `string` | Path of the report that was parsed, as passed to the parser. |
| runId | `string`, optional | Run id, when the caller passes one. |
| commitSha | `string`, optional | Commit SHA, when the caller passes one. |
| branch | `string`, optional | Branch name, when the caller passes one. |
| createdAt | `string`, optional | Creation time, when the caller passes one. The parser does not invent this from the report. |

## Test Id

`makeTestId(file, project, titlePath)` returns `file::project::` plus the title path joined by ` > `. The project segment is `default` when the project name is empty. The caller passes a file path that is already relative and uses forward slashes.

## JUnit XML

The JUnit parser reads `testsuites`, then `testsuite`, then `testcase`. One testcase becomes one record with one attempt. This table is the mapping used for the Playwright 1.60.0 fixture `fixtures/reports/pw-1.60.0-outcomes.junit.xml` and for the hand-written file `fixtures/reports/junit-generic.xml`.

| JUnit | Record field |
| --- | --- |
| `testcase` `file` attribute when it is non-empty, otherwise `classname` | `file` |
| `testcase` `name` | `titlePath` |
| `testsuite` `hostname` | `project` |
| `failure` or `error` | outcome `failed`, attempt status `failed` |
| `skipped` | outcome `skipped`, attempt status `skipped` |
| neither `failure`, `error`, nor `skipped` | outcome `passed`, attempt status `passed` |
| `time` attribute, seconds | `durationMs`, milliseconds, rounded |
| `system-out` or `system-err` attachment marker | `attachments` |
| `failure` or `error` `message` attribute | `errors[0].message` |
| `failure` or `error` text, when it differs from the message | `errors[0].stack` |

Playwright 1.60.0 writes the project name in the `testsuite` `hostname` attribute. In this fixture that value is `chromium`. It writes the spec path in `classname` (`tests/outcomes.spec.ts`). It does not set a `file` attribute. It joins describe titles and the test title in `name` with a space, the character U+203A, and a space. For the Cart test that name is `Cart › shows the heading`, and the title path is `Cart`, then `shows the heading`. The id uses ` > ` between those titles, the same as the JSON parser.

A missing or blank `hostname` becomes project `default`. The parser adds one warning for the report, not one warning per test: `JUnit report has no project name; used default`.

`expectedStatus` is not in JUnit. The parser sets it to `passed`.

Attachment lines do not include a name or a media type. The parser uses the file name as the attachment name and an empty content type. ANSI escape codes are removed from the failure message and text.

The XML parser does not expand entities. After parsing, attribute values and ordinary element text decode the five predefined XML entities (`lt`, `gt`, `amp`, `apos`, `quot`) and numeric character references (`&#65;` and `&#x42;`). `CDATA` stays literal, including entity text inside it. HTML entities stay literal. Entities declared in a `DOCTYPE` stay literal. Only a `DOCTYPE` in the prolog is removed, so an external entity identifier there is not read or fetched. A `DOCTYPE` after the root element, including one inside `CDATA`, is left in place.

## Known Gaps

These gaps were checked against the Playwright 1.60.0 JUnit fixture produced with the reporter's default options. `includeRetries` was left unset. The file has one `testcase` per test. It has no `flakyFailure`, `flakyError`, `rerunFailure`, or `rerunError` elements.

| Test | JSON outcome | JUnit outcome | What the JUnit file contains |
| --- | --- | --- | --- |
| always passes | `passed` | `passed` | One testcase, no failure |
| flaky by retry | `flaky` | `passed` | One testcase, no failure element. The failed attempt is not a separate result. |
| always fails | `failed` | `failed` | One `failure`. The retry text is inside that one body. |
| times out | `failed` | `failed` | One `error`. The attempt status is `failed`, not `timedOut`. |
| skipped test | `skipped` | `skipped` | One `skipped` element. JSON `expectedStatus` is `skipped`. JUnit `expectedStatus` is `passed`. |
| expected to fail | `passed` | `passed` | No `failure` element. JSON `expectedStatus` is `failed`. JUnit `expectedStatus` is `passed`. |
| Cart > shows the heading | `passed` | `passed` | One passing testcase. The describe title is in `name`. |

The seven test ids match across the two fixtures. The outcome differs for `flaky by retry` only.

Every JUnit parse adds this warning, because this parser stores one attempt and does not split retries:

`junit report has no per-attempt data; flaky detection needs the JSON report or reruns`

Other differences from the JSON records for the same run:

- `always fails` and `times out` keep every retry's text in the single attempt's error. They are not separate attempts. The JSON records have one attempt per retry.
- The `time` attribute on a Playwright testcase is the sum of the attempt durations, in seconds. It is stored on the single attempt as `durationMs`. The fixture script replaces those attributes with `0` before the file is committed.
- JUnit has no line number and no worker index. Those fields are omitted.
- Attachment paths in this fixture are relative to the report file's directory (`../pw-project/test-results/...`). The JSON report's attachment paths are relative to `config.rootDir` (`test-results/...`). The paths differ.
- The reporter can emit per-retry elements when `includeRetries` is enabled. This parser does not read those elements. The fixture was generated without that option, and the elements are not in the file.
