# Normalized Model

Parsers emit this model. The Playwright JSON parser and the JUnit parser both fill it.

## Parse Result

`ParseResult` is the value printed by `qa-core-flaky parse`.

| Field | Type | Meaning |
| --- | --- | --- |
| schemaVersion | `1` | Schema version of the parse result. This parser always writes `1`. |
| records | `TestRecord[]` | One record per test in the report. |
| warnings | `string[]` | Problems that did not stop the parse. A test with zero results adds a warning. A file path outside the report root adds a warning. A home directory in a structured file path, rewritten to `<home>`, does not add a warning. Home redaction of error text happens later, when triage output is built, and does not add a warning either. |

## Test Record

| Field | Type | Meaning |
| --- | --- | --- |
| id | `string` | Stable id from `makeTestId`: file, project, and title path, joined as `file::project::title path`. The title path uses ` > ` between titles. |
| file | `string` | Spec file, relative to the report `config.rootDir` when that field is present and the file sits inside it. Forward slashes. Never an absolute machine path. A path outside that root is rewritten to a relative path, and the parse adds a warning that quotes the relative path only. A home directory in this field, with no report root, is rewritten to `<home>` and does not add that warning. Error text is not redacted here. In Playwright 1.60.0, `config.rootDir` is the resolved `testDir` when the config sets `testDir`, and the config directory otherwise. |
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

The XML parser does not expand entities. After parsing, attribute values and ordinary element text decode the five predefined XML entities (`lt`, `gt`, `amp`, `apos`, `quot`) and numeric character references whose code point is a legal XML 1.0 character (`&#65;` and `&#x42;`). The policy for a bad reference is to parse the report and leave the reference literal. A reference the grammar rejects, including a hex reference with an uppercase `X` (`&#X41;`), does not fail the report. A reference to a character XML forbids, such as `&#0;`, is also kept as the original reference text. `CDATA` stays literal, including entity text inside it, and is not rewritten before parsing. HTML entities stay literal. Entities declared in a `DOCTYPE` stay literal. Only a `DOCTYPE` in the prolog is removed, so an external entity identifier there is not read or fetched. A `DOCTYPE` after the root element, including one inside `CDATA`, is left in place.

## Error Text Paths

Paths inside error text are rewritten only when the token looks like a real filesystem path.

| Token | What Happens |
| --- | --- |
| Report root, or a path inside it | The root prefix is removed. No warning. |
| Absolute path outside the root that starts with `/home/`, `/Users/`, `/tmp/`, `/var/`, `/runner/`, `/srv/`, `/opt/`, `/etc/`, `/usr/`, `/root/`, `/mnt/`, `/private/`, `/workspace/`, `/builds/`, `/__w/`, `/github/workspace/`, `/Volumes/`, or `/agent/_work/`, or that ends in a source location such as `file.ts:12` | Rewritten to a relative path. One warning. `/srv/ci/out.json` and `/opt/app/data.json` are examples. `/app/` and `/data/` are not in this list. A username may contain Unicode letters, so `/home/józef/...` and `/Users/李/...` are paths. With no report root, a home directory in error text is left as written. Cause rules and signatures read that original text. The username is hidden later, when triage output is built. |
| Windows path | Backslash runs become one forward slash, and the drive letter stays (`C:/Users/bob/a.ts`). Relative only when the root uses that drive. Otherwise the normalized form is kept and one warning quotes it. With no report root, `C:/Users/<user>/`, `C:\Users\<user>\`, and the doubled form `C:\\Users\\<user>\\` stay in the stored message. Output redaction turns each of them into `<home>/`. |
| `http://` or `https://` URL | Left as written, including `?x=/home/a` and a root prefix inside the URL. No warning. |
| One segment, a regex, a quoted URL path, a glob, or prose | Left as written. `/var/`, `/Ready/`, `/\d+/`, `"/inventory.html"`, `"/cart/checkout.html"`, `/api/search?q=1`, `/src/**/*.ts`, `/and/or`, and `/month/user` are examples. No warning. |

The report root matches when the next character does not continue the path name. Letters, digits, `_`, and `-` continue the name. A `.` continues the name only when a name character follows it, so `project-other` and `project.txt` stay whole. `root&b`, `root&&npm`, `root!`, `root?`, `root#x`, `root*`, `root%20`, `root~`, and `root$HOME` are still the root. Outside the root, a token may contain `%`, `~`, `$`, `&`, `!`, `@`, `+`, and Unicode letters, which is why `/home/ci/w/a%20b.ts` and `/home/ci/w/a&b.ts` are paths. A token that contains `?`, `*`, `#`, `=`, or `,` and does not start with a known folder stays as written. When a report root is known, a token outside that root that starts with a known folder is rewritten up to the first of those characters, and the rest is kept, so `/home/bob/file#1.json` does not leave the absolute `/home/bob` path in the text. A regex literal such as `/pattern/` is still left as written. `/app/` and `/data/` stay as written when they are not under another known folder.

Cause rules and error signatures read the original error text. The parser does not redact a home directory inside that text. Redaction runs when the triage report builds evidence, ids, titles, and the next step, for both JSON and Markdown. The verdict is the same with or without that redaction. A structured file path is the exception: with no report root, `toPortablePath` still rewrites the home directory so the stored `file` field is not an absolute machine path, and that rewrite does not add a warning.

The username stops at a newline, a carriage return, whitespace, `:`, `;`, `,`, a quote, `)`, `]`, or `>`. A space is included only when a path separator follows on the same line before one of those stops, so `Jöhn Smith` is one username and `cwd is /home/alice and npm failed` keeps the words after the name. With no separator after the name, `/home/alice` becomes `<home>` and the following text stays. `/Users/bob: permission denied (os error 13)` becomes `<home>: permission denied (os error 13)`. A separator is one forward slash or a run of one or more backslashes. That run is one separator around the drive letter, `Users` or `home`, and the username, so `C:\Users\alice\x.json` and `C:\\Users\\alice\\x.json` both become `<home>/x.json`. With a separator, the result is `<home>/` plus the rest of the path, and a run of backslashes in that tail becomes one forward slash. The tail stops at whitespace, a quote, `)`, `]`, `>`, `?`, `*`, `#`, `=`, or `,`, and it does not stop at `:`. `Error at C:\\Users\\bob\\a.ts:12:3` becomes `Error at <home>/a.ts:12:3`. A stack frame such as `at readCsv (C:\\Users\\alice\\x.json:12:3)` becomes `at readCsv (<home>/x.json:12:3)`.

A letter before `:` is a drive letter only at the start of the text or after a character that is not a letter or digit. That includes `file:///` and `\\?\`. These are redacted: `open file:///C:/Users/alice/a.html`, `PATH=/usr/bin:/home/alice/bin`, `user@host:/home/alice/x`, `HOME:/home/alice/x`, `cwd:/home/ci/w`, and `\\?\C:\Users\alice\a.json`. `cwd:/home/ci/w` is a POSIX path. The `d` in `cwd:` is preceded by a letter, so it is not a drive.

POSIX paths match `home` and `users` in any case, so `/HOME/alice/x`, `/USERS/alice/x`, and `/Users/BOB/x` are redacted. `/users/:id` stays as written, because a segment that starts with `:` is not a username. `c:\users\alice` is redacted too. The home folder must start a path, or follow `/tmp/`, `/var/`, `/private/`, `/mnt/<one segment>/`, `file://`, or a drive letter. `/api/home/settings/save`, `GET /home/index/page`, and `/Users/42/orders` stay as written. `http://` and `https://` URLs stay as written, including a home path inside the URL.

A bare POSIX `/home/<name>` or `/Users/<name>` is redacted inside an Expected or Received value too. An app route such as `/home/feed` has that same shape, so it shows as `<home>`. `/home/login` shows as `<home>` when it is the only username in that string. Within one triage entry, the first username is `<home>` and later different usernames are `<home~2>`, `<home~3>`. The order is the id, then the title, then the file, then the evidence. The same username keeps one mark, so `/home/alice` and `/home/alice/` become `<home>` and `<home>/`. Case-different spellings are different marks, so `C:\Users\alice` and `/home/Alice` do not share a mark. Any path after the username is rewritten, including one segment and no file extension. `Received: "/Users/bob/notes"` becomes `Received: "<home>/notes"`. `Received: "/home/alice/Desktop"` becomes `Received: "<home>/Desktop"`. `Expected: "/users/:id"` stays as written. A drive-letter path is never an app route, so `X:\Users\<name>` and `X:/Users/<name>` are rewritten at any depth, with one backslash or a run of them. `Received: "C:/Users/alice/Desktop"` becomes `Received: "<home>/Desktop"`. `Expected: "C:\\Users\\alice\\Downloads\\report.csv"` becomes `Expected: "<home>/Downloads/report.csv"`. This output rewrite does not add a warning. Cause rules still read the original text, so the verdict does not change.

A path tail stops at `;`. `C:\Users\bob\a;C:\\Windows` becomes `<home>/a;C:\\Windows`. The trailing Windows path keeps its backslashes. Rewriting that tail to forward slashes was only cosmetic, and it no longer happens.

These forms are also homes: `,/home/x`, `>/home/x`, `;/home/bob` after another home, `</home/alice/...>`, `file://localhost/home/...`, `/HOME/...`, `~alice/`, `../../../home/bob/...`, `\\server\Users\bob\a`, `\\?\UNC\server\Users\bob\a`, `//server/Users/bob/x`, `smb://server/Users/bob/a`, `SMB://server/users/bob/a`, `x\\Users\\bob\\a`, and `\\home\\alice\\x`. The server name in a UNC or SMB path stays, and the username is replaced. `smb` matches in any case. `~/proj` stays, because it names no username. A `~` inside `locator('...')` or `locator("...")` stays, so `locator('h1 ~p')`, `locator('.a ~.b')`, and `locator('li ~li >> nth=1')` are not homes. The name after `~` must start with a letter, a digit, or `_`.

With no separator after the username, every following token that starts with a letter is part of the name until a short prose word (`failed`, `again`, `the`, and the other words in the list in `src/report-path.ts`). This hides extra words on purpose so no part of a display name leaks. `C:\Users\Jo Smith Failed Again` becomes `<home> Failed Again`. `C:\Users\jo smith failed` becomes `<home> failed`. `C:\Users\Mary Ann Lee failed` becomes `<home> failed`. `C:\Users\Jo De La Cruz failed` becomes `<home> failed`. A prose word stops the name, so `Failed Again` stays. Prose such as `route /home/dashboard/widgets` becomes `route <home>/widgets`. The tool cannot tell that route from a home directory, so the username-shaped segment is hidden and the rest of the path stays.

A quoted mark that the text already contains, such as `Expected: "<home~2>"`, is tagged `<text:home~2>` before numbering. That tag and a generated `<home~2>` are not the same text.

`parse` and the library return the original error text, including usernames. That is the text cause rules read. `parse --redact`, and `redactParseResult`, hide the username in the printed records. The default is still the raw text.

A structured file path with no report root is still stored as `<home>/...`. When one report has two files that redact to the same `<home>` path, the first id stays `<home>` and the later ones become `<file~2>`, `<file~3>`, in the order the parser saw them. `<home~2>` is only the second username inside one triage entry. The mark is not the username. Triage also keeps entries whose ids differed only by a username: the first redacted id is unchanged, and the next ones gain ` (2)`, ` (3)`.

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
- Attachment paths are not on the same base, and that difference is kept on purpose. A JUnit file has no `config.rootDir`. Playwright writes each `[[ATTACHMENT|...]]` path relative to the report file, and this parser stores that path as written when it is already relative (`../pw-project/test-results/...` for this fixture). A JSON attachment path is relative to `config.rootDir` (`test-results/...`). Cause rules do not read attachment paths. Inventing a project root for JUnit would change paths the file does not name.
- The reporter can emit per-retry elements when `includeRetries` is enabled. This parser does not read those elements. The fixture was generated without that option, and the elements are not in the file.
