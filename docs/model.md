# Normalized Model

Parsers emit this model. The Playwright JSON parser fills it from a JSON report. The `junit` format value is reserved for a later parser.

## Parse Result

`ParseResult` is the value printed by `qa-core-flaky parse`.

| Field | Type | Meaning |
| --- | --- | --- |
| schemaVersion | `1` | Schema version of the parse result. This parser always writes `1`. |
| records | `TestRecord[]` | One record per test in the report. |
| warnings | `string[]` | Problems that did not stop the parse. A test with zero results adds a warning. |

## Test Record

| Field | Type | Meaning |
| --- | --- | --- |
| id | `string` | Stable id from `makeTestId`: file, project, and title path, joined as `file::project::title path`. The title path uses ` > ` between titles. |
| file | `string` | Spec file, relative to the report `config.rootDir` when that field is present. Forward slashes. Never an absolute machine path. In Playwright 1.60.0, `config.rootDir` is the resolved `testDir` when the config sets `testDir`, and the config directory otherwise. |
| line | `number`, optional | Line of the test in `file`, when the report has one. |
| project | `string` | Playwright project name. `default` when the report has no project name. |
| titlePath | `string[]` | Describe titles, then the spec title. The file-level suite title is left out, because it is the file name. |
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
| location.file | `string` | File path, made relative to `config.rootDir` when it sits inside that directory. |
| location.line | `number` | Line number. |
| location.column | `number` | Column number. |

## Attachment

| Field | Type | Meaning |
| --- | --- | --- |
| name | `string` | Attachment name. |
| path | `string`, optional | Path on disk, when the report has one. Made relative to `config.rootDir` when the file sits inside that directory. |
| contentType | `string` | Media type from the report. An empty string is used when the report omits it. |

## Source Info

| Field | Type | Meaning |
| --- | --- | --- |
| format | `playwright-json` or `junit` | Report format. This parser always writes `playwright-json`. |
| reportPath | `string` | Path of the report that was parsed, as passed to the parser. |
| runId | `string`, optional | Run id, when the caller passes one. |
| commitSha | `string`, optional | Commit SHA, when the caller passes one. |
| branch | `string`, optional | Branch name, when the caller passes one. |
| createdAt | `string`, optional | Creation time, when the caller passes one. The parser does not invent this from the report. |

## Test Id

`makeTestId(file, project, titlePath)` returns `file::project::` plus the title path joined by ` > `. The project segment is `default` when the project name is empty. The caller passes a file path that is already relative and uses forward slashes.
