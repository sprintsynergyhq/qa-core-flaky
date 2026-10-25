# Deterministic Cause Rules

`classifyCauses` reads one `TestRecord` and returns the likely causes. There is no model call. Each finding quotes evidence copied from the error text, or it says Unknown.

The cause list follows the categories in the project plan: selectors, timing, test data, environment, and unknown. Selector evidence follows the same boundary as qa-core-heal: a failure is a locator problem only when the error shows that the locator did not resolve to the expected elements. A locator that resolved to real elements but had the wrong value is not a locator problem. A click blocked because another element `intercepts pointer events` is a timing signal.

## What A Finding Contains

| Field | Meaning |
| --- | --- |
| cause | `selectors`, `timing`, `test-data`, `environment`, or `unknown` |
| confidence | `high`, `medium`, or `low` |
| evidence | Exact substrings of `message` or `stack`. Each one is at most 300 characters. Nothing is paraphrased. |
| ruleIds | The rule ids that matched, in the order listed on this page |

Message and stack are both read. ANSI escape codes are removed first, including when the record still has them. Line endings are normalized before the rules run: `\r\n`, a lone `\r`, and `\r\r\n` become `\n`. Quoted evidence does not contain `\r`. A JUnit `message` attribute is often only the first line. The detailed text is the element body, stored on `stack`. A rule that matches only the stack still matches.

A failed, timed out, or interrupted attempt with no error text does not throw. It is Unknown, rule `UNK-EMPTY`, with an empty evidence list.

Passed and skipped attempts are not read. A passed or skipped record returns no findings. A failed or flaky record with no failed attempt returns `UNK-EMPTY`.

## Lines That Are Not Evidence

Before any rule runs, these lines are removed:

| Line | Example |
| --- | --- |
| Playwright source frame | A line number, then a pipe, then source. A leading `>` is the same kind of line |
| Caret line under a source frame | a line of spaces, a pipe, spaces, and `^` |
| Stack frame | `at` followed by a space or a tab, then a frame that ends in `:line:col` or in parentheses that hold a location. Nested parentheses count, as in `at seedDuplicate (eval at x (/w/a.ts:1:2), <anonymous>:1:1)`. Prose that only starts with `at`, such as `at least one row is a duplicate (see log)`, stays |
| JUnit header | `[chromium] › tests/a.spec.ts:21:1 › title` followed by a box-drawing rule |

`DATA-ALREADY-EXISTS`, `ENV-NET`, and `ENV-HTTP5XX` also skip `Locator:` lines, `Expected:` lines, `waiting for ...` lines, and `locator resolved to ...` lines. A button named `Email already exists`, or `Expected: "503 Service Unavailable"`, is Unknown.

## How Confidence Is Chosen

| Confidence | When |
| --- | --- |
| high | Two or more independent rules of the same cause matched, or one strong rule matched on every failed attempt and there are at least two failed attempts |
| medium | One strong rule matched on one attempt. Rules that quote the same line, or that sit in one dependent group, count as that one rule |
| low | The only match is `TIM-NEAR-TIMEOUT` |

Two rules are independent when their evidence lines differ and they are not in the same group. `SEL-NOTFOUND`, `SEL-ZERO`, and `SEL-UNRESOLVED` are one group, so a single `toBeVisible` miss or a single `toHaveCount` of zero stays medium. `TIM-TEST-TIMEOUT` and `TIM-NEAR-TIMEOUT` are one group, because a test timeout is already past the near-timeout line. `TIM-NEAR-TIMEOUT` by itself stays low even when it matches every failed attempt. `TIM-NEAR-TIMEOUT` with an independent timing rule, such as `TIM-EXPECT-TIMEOUT` or `TIM-INTERCEPT`, is high.

Findings are sorted by confidence (`high`, then `medium`, then `low`). The same confidence is sorted by cause: selectors, environment, timing, test-data. Unknown is returned only when no other rule matched, so it is alone.

## How To Run

```sh
node dist/cli.js causes fixtures/reports/pw-1.60.0-outcomes.json
node dist/cli.js causes fixtures/reports/pw-1.60.0-outcomes.json --json
node dist/cli.js causes fixtures/reports/pw-1.60.0-outcomes.json --test-timeout 30000
```

The text form is one block per failed or flaky test. Passed and skipped tests are omitted. `--json` prints an array of `{ id, findings }`. `--test-timeout` is the timeout in milliseconds for `TIM-NEAR-TIMEOUT`. The normalized model does not store the Playwright timeout, so the command does not infer one.

## Selectors

A selector rule does not match a resolved locator whose value or count is merely wrong.

### SEL-STRICT

| | |
| --- | --- |
| Check | The text contains `strict mode violation` |
| Example | `Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Remove' }) resolved to 2 elements:` |
| Confidence | Medium on one failed attempt. High when it matches every failed attempt and there are two or more, or when an independent selector rule matches on a different line |

The example is the message from `fixtures/pw-project/tests/causes.spec.ts` under Playwright 1.60.0. The file is `fixtures/errors/sel-strict.txt`.

### SEL-NOTFOUND

| | |
| --- | --- |
| Check | The text contains `element(s) not found` |
| Example | `Error: element(s) not found` |
| Confidence | Medium on one attempt, including when `SEL-ZERO` quotes the same `element(s) not found` line. High when this rule matches every failed attempt and there are two or more |

Captured in `fixtures/errors/sel-notfound.txt`.

### SEL-UNRESOLVED

| | |
| --- | --- |
| Check | `locator resolved to 0 elements`, or a call-log wait (`waiting for locator(` or `waiting for getBy...(`) with `Timeout <digits>ms exceeded` or `Test timeout of <digits>ms exceeded` and no `locator resolved to <` line. A strict mode error is not unresolved |
| Example | `TimeoutError: locator.click: Timeout 400ms exceeded.` with `waiting for locator('#missing')` |
| Confidence | Medium on one attempt, including together with `SEL-ZERO` on the same line. High when this rule matches every failed attempt and there are two or more |

`waiting for getByRole(...)` is included because Playwright 1.60.0 logs `getBy` calls that way, not only `locator(`. Captured in `fixtures/errors/sel-unresolved.txt` and, for the zero-element line, `fixtures/errors/sel-zero.txt`.

### SEL-ZERO

| | |
| --- | --- |
| Check | `toHaveCount`, `toBeVisible`, or `toBeAttached` (the `expect(locator)` form or `Expect "..."`) and the text reports zero elements: `element(s) not found`, `locator resolved to 0 elements`, or `toHaveCount` with `Received: 0` |
| Example | `8 × locator resolved to 0 elements` on `expect(locator).toHaveCount(expected) failed` with `Received: 0` |
| Confidence | Medium on the captured count failure. `SEL-UNRESOLVED` quotes the same `locator resolved to 0 elements` line, and the two rules are one group. High when this rule matches every failed attempt and there are two or more |

The `8 ×` count is the count from one local run of the fixture. It is not a benchmark. Captured in `fixtures/errors/sel-zero.txt`.

## Timing

### TIM-EXPECT-TIMEOUT

| | |
| --- | --- |
| Check | The locator resolved to a real element (`locator resolved to <...>`) and the failure is an expect timeout, and it is not `element(s) not found`, not `resolved to 0 elements`, and not a strict mode violation. Either `Timeout <digits>ms exceeded` appears on an expect, or the matcher is `toBeVisible`, `toBeHidden`, `toBeEnabled`, or `toBeDisabled` and the text has `Timeout: <digits>ms` or `with timeout <digits>ms` |
| Example | `unexpected value "hidden"` from `expect(locator).toBeVisible() failed`, with `locator resolved to <span hidden="" id="hidden">Hidden</span>` |
| Confidence | Medium on one attempt |

Playwright 1.60.0 does not print `Timeout 400ms exceeded` for this expect. It prints `Timeout:  400ms` and the resolved element. `toHaveText` uses that same `Timeout:` field for a wrong value, and it is not this rule. Captured in `fixtures/errors/tim-expect-timeout.txt`.

### TIM-TEST-TIMEOUT

| | |
| --- | --- |
| Check | The text contains `Test timeout of <digits>ms exceeded` |
| Example | `Test timeout of 800ms exceeded.` |
| Confidence | Medium on one attempt. High when it matches every failed attempt and there are two or more |

Captured in `fixtures/errors/tim-test-timeout.txt`. The same text also matches `SEL-UNRESOLVED` when the call log is still waiting on a locator that never resolved. Both causes are returned.

### TIM-INTERCEPT

| | |
| --- | --- |
| Check | A line contains `intercepts pointer events` and that line is not a Playwright source frame (a line number, then a pipe, then source) |
| Example | `<div id="cover"></div> intercepts pointer events` |
| Confidence | Medium on one attempt |

This is not a selector rule. The locator in the captured run resolved to the button. Captured in `fixtures/errors/tim-intercept.txt`.

### TIM-NEAR-TIMEOUT

| | |
| --- | --- |
| Check | The attempt status is failed, timed out, or interrupted, and `durationMs * 10 >= testTimeoutMs * 9`. The timeout is known only when the caller passes `testTimeoutMs` |
| Example | No line of its own. When this is the only finding, the Unknown evidence lines are included so that text is not hidden. When another rule also matches, those Unknown lines are not added |
| Confidence | Low when it is the only timing rule. Medium together with `TIM-TEST-TIMEOUT`, because that pair is one group. High when an independent timing rule also matches |

Duration is a field on the attempt. It is not copied into evidence, because the evidence list is only exact error text.

## Test Data

### DATA-VALUE-DRIFT

| | |
| --- | --- |
| Check | Two or more failed attempts fail the same assertion with different `Received:` lines. The assertion key is the matcher (`toHaveText` and the rest), the `Locator:` line, and the `Expected:` line. Those three lines may be indented |
| Example | `Received: "1"` on one attempt and `Received: "2"` on the next, both with `Expected: "9"` and `locator('#n')` |
| Confidence | High when every failed attempt is part of that drift. Medium when some failed attempt is not |

Both lines are evidence. Captured in `fixtures/errors/data-value-1.txt` and `fixtures/errors/data-value-2.txt`.

### DATA-ALREADY-EXISTS

| | |
| --- | --- |
| Check | A line matches `already exists`, `duplicate`, or `unique constraint`, case insensitive. `Locator:`, `Expected:`, `waiting for`, and `locator resolved to` lines are skipped |
| Example | `Error: insert failed: duplicate key value violates unique constraint "users_email_key"` |
| Confidence | Medium on one attempt. High when it matches every failed attempt and there are two or more |

`fixtures/errors/data-already-exists.txt` is a realistic application error. It was not produced by the local Playwright run.

### DATA-ORDER

Order dependency is not detected in this version. `classifyCauses` calls `options.orderDependency` when the caller passes one. The hook returns evidence substrings. Strings that are not substrings of `message` or `stack`, and strings that are empty, are dropped. A kept line longer than 300 characters is clipped to 300. The rule id is `DATA-ORDER`.

The default is no hook, which returns nothing. PR 6 is the version that fills the hook in. Passing a hook from outside is supported so that version can attach order evidence without changing the other rules. If the hook throws, classification continues. The error is one debug note, `debug: order dependency hook failed: ...`, appended to `options.debugNotes` when that array is present.

## Environment

### ENV-NET

| | |
| --- | --- |
| Check | A line contains `net::ERR_` followed by the error name, or `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, or `socket hang up`. `Locator:`, `Expected:`, `waiting for`, and `locator resolved to` lines are skipped |
| Example | `Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:54321/` |
| Confidence | Medium on one attempt. High when another environment rule also matches, or when this rule matches every failed attempt and there are two or more |

Captured in `fixtures/errors/env-net.txt` from `page.goto` to `http://127.0.0.1:54321/`, a closed local port. The test does not use a public host.

### ENV-HTTP5XX

| | |
| --- | --- |
| Check | A line has a status from 500 to 599 with a status word, an HTTP reason phrase, or an `apiRequestContext` error, or a `Received:` line whose value is that status (`Received: 503` or `Received: "503"`). The pattern is `status` or `HTTP/1.x` followed by the code, or the code followed by `Internal Server Error`, `Not Implemented`, `Bad Gateway`, `Service Unavailable`, `Gateway Timeout`, or `HTTP Version Not Supported`, or `apiRequestContext.<method>: <code>`, or `Received:` and the code. `Locator:`, `Expected:`, `waiting for`, and `locator resolved to` lines are skipped. `Expected: 503` does not match |
| Example | `Error: apiRequestContext.get: 503 Service Unavailable` |
| Confidence | Medium on one attempt |

`Timeout: 5000ms` and `Expected: 512` do not match. `fixtures/errors/env-http.txt` is realistic and was not produced by the local run.

### ENV-BROWSER

| | |
| --- | --- |
| Check | The text contains `browserType.launch`, or it contains `Target page, context or browser has been closed` and the same error has no selector evidence in `message` or `stack` |
| Example | `Error: browserType.launch: Failed to launch the browser.` and `Error: page.goto: Target page, context or browser has been closed` |
| Confidence | Medium on one attempt |

A closed target that still has selector evidence stays a selector finding and is not also `ENV-BROWSER`. `fixtures/errors/env-browser-launch.txt` and `fixtures/errors/env-browser-closed.txt` are realistic and were not produced by the local run.

## Unknown

| Rule | When | Evidence | Confidence |
| --- | --- | --- | --- |
| UNK-NONE | Some failed attempt has error text, and no rule matched | The `Expected:` and `Received:` lines when those exist, otherwise the first non-empty line that is still evidence. If every line was removed as a stack frame, the first original line is quoted. Each line is clipped to 300 characters. Leading whitespace is allowed | low |
| UNK-EMPTY | Every failed attempt has no error text, or the record is failed or flaky and has no failed attempt | Empty | low |

A value mismatch on a resolved locator, such as `toHaveText` with `Received: "1"`, is `UNK-NONE` when the received value does not change across attempts. It is not selectors and it is not timing. The captured example is `fixtures/errors/data-value-1.txt`.

## Error Signature

`normalizeErrorSignature` compares errors across attempts and runs. The steps run in this order:

1. ANSI escape codes are removed.
2. A trailing `:line:column` on a file token becomes `:L:C`. The match starts where the previous character is not part of a file token.
3. A duration such as `5000ms` or `1.5ms` becomes `Nms`.
4. A port on `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, or an `http(s)` URL becomes `:PORT`.
5. Digits inside a `/tmp/`, `/private/tmp/`, or `/var/folders/` path become `N`.
6. A UUID becomes `ID`. Digits after `id=` or `id:` become `N`.
7. A count is rewritten only when it starts a call-log line. Optional spaces come first, then an optional `-` and the spaces after it, then the count, then `×` or `x`, then `locator`. That count becomes `N ×`. `9 × locator` and `9 x locator` become `N × locator`. A count on an Expected or Received line stays. A quoted value which runs onto a line starting with a count followed by `locator` can still be rewritten.
8. Runs of spaces or tabs become one space, then the ends are trimmed.

Numbers in assertion values are kept, including `Expected: "1 × 4"`, `Received: "2×"`, and `Received: "2 × Backpack"`. `Received: "1"` and `Received: "9 x"` stay as written. Two errors that differ only by a call-log repeat count share a signature.

## Local Fixture

`fixtures/pw-project/tests/causes.spec.ts` produces the captured messages on `file://` pages, plus one navigation to a closed localhost port. `fixtures/pw-project/playwright.config.ts` ignores that spec so `npm run fixtures` still regenerates the seven-test outcomes report. Run the cause spec with `fixtures/pw-project/playwright.causes.config.ts` when the messages need to be captured again. Unit tests read the committed text files and do not launch a browser.

## Known Limits

- `TIM-NEAR-TIMEOUT` runs only when the caller passes the test timeout. The normalized record does not store Playwright's per-test timeout, and `causes` does not read it out of the raw report.
- JUnit attachment paths stay relative to the report file. JSON attachment paths stay relative to `config.rootDir`. The two bases are documented in [model.md](model.md). Cause rules do not quote attachment paths.
- A Windows path that does not share a drive with the report root is stored as `C:/...` with the drive kept and the separators collapsed. It is not rewritten to a POSIX relative path.
- Order dependency is the `orderDependency` hook only. Nothing in this version decides that a test failed because of order.
- A stack-frame-only error, such as `at /home/alice:12:3`, is Unknown and quotes that first frame. The frame is not a cause by itself.
