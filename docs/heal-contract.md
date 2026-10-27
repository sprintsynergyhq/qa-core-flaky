# Heal Findings Contract

`qa-core-flaky triage` can write a findings file for qa-core-heal. The file is version 1. Flaky decides the handoff. Heal is not called. A person still reviews every row. The report does not say the test is stable, and it does not say the test is fixed.

The schema file in this repository is `schemas/heal-findings.v1.schema.json`. Unknown fields are rejected. A review status other than `Needs Review` is rejected. A verdict of `likely-real-bug` or `environment-issue` cannot use a handoff other than `none`.

## Command

```sh
node dist/cli.js triage demo/saucedemo/reports/recorded-seed-443.json --heal-findings heal-findings.json --fail-on never
```

`--heal-findings` is valid for `triage` only. The path is the findings file. It is refused when that path is `triage.json`, `triage.md`, or `triage.html` inside `--out-dir`, including a symlink to one of those files, so the later triage write cannot replace the findings file. `--out-dir` still writes `triage.json` and `triage.md`. Without `--heal`, `healProposal` in that triage report stays null.

The user's `--heal-findings` file is written before `triage.json` and `triage.md`. Heal reads a temporary copy, so the dry run does not open that user file. If a later write fails, the findings file can remain and the command exits 1.

## Heal Runner

`--heal` is valid for `triage` only. It asks qa-core-heal for a dry run and stores one `healProposal` on every triage entry. The command never passes `--apply`, `--yes`, or `--no-verify`. A person can still read `applyCommand` and run that later. This tool does not run it.

The program is `npx --no-install qa-core-heal`. A missing local install is status `unavailable`. The registry copy is not fetched. `QA_CORE_HEAL_BIN` selects another program. A path that ends in `.js` or `.mjs` is run with `node`. The default wait is 60 seconds. `QA_CORE_HEAL_TIMEOUT_MS` can set another wait. A value above 120 seconds is clamped to 120 seconds. The wait kills the heal process group, so a grandchild that still holds a pipe does not keep the run open. Compat mode runs one command per spec file, and each command has its own wait, so several specs can take longer than one wait.

### Contract Mode

`npx --no-install qa-core-heal capabilities --json` selects this mode when the JSON reports findings contract 1 and results contract 1. These shapes count:

| Field | Contract 1 |
| --- | --- |
| `contracts.findings` | `1`, or an array that includes `1` |
| `contracts.results` | `1`, or an array that includes `1`, when `contracts` is present |
| `findingsContract` | `1` |
| `findingsSchemaVersion` | `1` |

Heal 0.4.0 reports `contracts.findings` and `contracts.results` as arrays, for example `[1]`.

The dry run is one command: `npx --no-install qa-core-heal --findings <file> --results <file> --dry-run`. Test titles are not passed on the command line. Heal reads each test from the findings file. A title of `--apply` therefore cannot be read as a flag. Heal writes the results file. Flaky reads it and does not keep it.

The file heal reads is a temporary copy. A spec path that is relative to the Playwright `testDir` is rewritten to a path that exists from the working folder. `config.rootDir` is tried the same way. The user's `--heal-findings` file is left as written. An unnamed Playwright project is stored as `default` in that file. The temporary copy writes an empty project string, so heal is not asked for a project named `default`.

A handoff of `none` stays `skipped-by-gate` even if heal also returns a row. The label is `Proposal from qa-core-heal (dry run, not applied)`.

### Compat Mode

Heal 0.3.x has no `capabilities` command. Flaky then runs `npx --no-install qa-core-heal --version`, and for each spec file `npx --no-install qa-core-heal <spec> --dry-run --json`. The spec path is resolved the same way as in contract mode. Rows are the `verdicts` array. Heal ran that one spec, so the rows join on `testTitle` only. The title may be the full title path or only the last segment. `spec` on a verdict is the file that holds the locator. A page object is a different file from the spec that was run, and that path is the change file, not a join key. Two verdicts in one run with the same title are not guessed: the proposal is `error`. A locator verdict with `after` set and `healApplied` false becomes `proposed`. The line comes from the matching `locators` row (`file` and `old` equal to `before`). The change file is `verdicts[].spec`, or the locator file when spec is empty. A refused locator becomes `refused` with its `reason`. `classification` `non-locator` becomes `not-locator`. `healApplied` true becomes `error`, because this command only asks for a dry run.

The label is `Heal 0.3.x dry run, not re-run verified`. A handoff of `none` uses that same label. `verification.performed` is false. That proposal is not a re-run result. The results schema's re-run rule is not applied to this older output. The proposal schema still accepts it.

### Missing Heal

When the program cannot be started, every entry gets status `unavailable` and this one line is printed:

`qa-core-heal is not installed. No proposal was made.`

The verdicts are unchanged. The command still exits the way triage exits without heal. A timeout or a heal error is status `error` on the rows heal was asked to handle, with one line on stderr. A handoff of `none` stays `skipped-by-gate`.

## Proposal Fields

`healProposal` is null when `--heal` was not used. Otherwise it matches `schemas/heal-proposal.v1.schema.json`. `schemas/heal-results.v1.schema.json` is the results file heal writes. Both are vendored here. `schemaVersion` of the triage report stays 1.

| Field | Meaning |
| --- | --- |
| contractVersion | Always `1`. |
| tool | Always `qa-core-heal`. |
| toolVersion | The version heal reported. Empty when heal is missing. |
| mode | Always `dry-run` from this command. |
| status | `proposed`, `refused`, `not-locator`, `nothing-to-heal`, `error`, `unavailable`, or `skipped-by-gate`. An `applied` result from a dry run is stored as `error`. |
| strategy | `locator-heal`, `rule-suggestion`, `ai-suggestion`, or `none`. |
| label | The heading in Markdown and HTML. |
| changes | Before and after text. Empty when nothing is proposed. |
| refusal | Code and message, or null. |
| verification | What heal re-ran, or a not-run value. |
| applyCommand | A locator proposal's hand command, or null. It contains `--apply`. This tool does not run it. |

Markdown shows the label `Proposal from qa-core-heal (dry run, not applied)` for a contract run. A diff inside a Markdown fence is not escaped as prose, so the text is the diff heal returned. A fence is long enough that backticks in the diff stay inside it. A diff longer than 12 lines, or larger than 4000 bytes, is the path `h/<id>.diff` instead of the diff text.

HTML paints the status word from the stylesheet, and the status class links to `h/<id>.diff` when that file holds the label, the explanation, and the diff. The refusal code is in the patch file and in `triage.json`. It is not an attribute on the page. The directory name is one letter so a page of 200 proposals, for every status and every refusal code, stays at least 5 KB under 307,200 bytes. Diff text is not placed in the HTML, so a `<script>` in a change cannot run. A skipped or unavailable row is the status word only. `--heal` with `--out-dir` writes the patch files. It does not create or clean `h/` when `--heal` was not used. It deletes only diff files named in `h/.qa-core-flaky`, which are the files this tool wrote on an earlier `--heal` run. A user file in that folder is left in place, and the folder itself is not removed. The id in the file name is a hash of the triage entry id. A patch file is the diff text for a person to read. It is not applied.

Cause bars use a width class in the stylesheet, such as `w67`. A style attribute is not used. The page policy allows only the hashed stylesheet, so an inline width would be ignored and every bar would fill its track.

A needs-more-runs verdict can still be a locator handoff. The gates force `none` only for `likely-real-bug` and `environment-issue`. Heal still has to verify a change before it proposes one. One observed attempt is offered when the other gates pass.

Two runs of the same reports write the same bytes. `--timestamp` adds `generatedAt`, and the bytes then change every run. The same flag adds `generatedAt` to the triage report.

## Top Level Fields

| Field | Meaning |
| --- | --- |
| schema | Always `qa-core.heal-findings`. |
| schemaVersion | Always `1`. |
| tool.name | Always `qa-core-flaky`. |
| tool.version | The version in `package.json`. |
| generatedAt | ISO time. Present only with `--timestamp`. |
| project.configPath | Playwright config path from the report, relative, with forward slashes. Null when the report has none. |
| project.baseUrl | Origin only, when the report stores `baseURL`. The path, query, user, and password are dropped. Null when the report does not store one. |
| project.testIdAttribute | The test id attribute, when the report stores one. Null otherwise. |
| project.playwrightVersion | `config.version` from a Playwright JSON report. Null for a JUnit report. |
| source.triageSchemaVersion | Always `1`. |
| source.reports | The report paths that were read, in command order, relative when they sit inside the working directory. |
| source.commit | The commit SHA when every record in the command has the same one. Otherwise null. |
| source.runId | The run id when every record has the same one. The field is omitted when it is null. |
| redaction.applied | Always true. |
| redaction.rules | The redaction rules that run on every file. See Redaction below. |
| findings | One row per failed or flaky test. Passed and skipped tests are omitted. Empty when every test passed or was skipped. |

The recorded SauceDemo JSON report from Playwright 1.60.0 stores `config.version` and `config.configFile`. It does not store `baseURL` or `testIdAttribute`, so those two fields are null for that file. A later report that does store them is copied through.

When more than one report is passed, the first report that has a project fact fills it. A later report fills a fact that is still null. It does not replace a fact that was already set.

## Finding Fields

| Field | Meaning |
| --- | --- |
| findingId | 12 hex characters. See Finding Id below. |
| testId | Flaky's test id, `file::project::title path`, after redaction. |
| file | Spec path. Relative, forward slashes. |
| line | Spec line from the report, or null when the report has no spec line. |
| project | Playwright project name. `default` when the report has none. |
| titlePath | Describe titles, then the spec title. |
| verdict | `likely-real-bug`, `flaky`, `broken-test`, `environment-issue`, or `needs-more-runs`. |
| verdictConfidence | `high`, `medium`, or `low`. Same value as the triage entry. |
| primaryRuleId | The first rule id of the primary cause, in the order in [causes.md](causes.md). This is not the verdict row id. |
| causes | Cause findings. Evidence lines are at most 300 characters and are already redacted. |
| attempts.total | Attempts that ran, including skipped attempts. An unselectable rerun command is not included. |
| attempts.failed | Attempts with status `failed`, `timedOut`, or `interrupted`. |
| attempts.passed | Attempts with status `passed`. |
| attempts.sameCommit | True when a pass and a fail share the same code. |
| errorSignature | `sha256:` and 64 hex characters. See Error Signature below. |
| failingSelector | The selector quoted from the error, or null. At most 300 characters. |
| errorLocation | File, line, and column where the failure was thrown, or null. |
| handoff | `mode`, `reason`, and `gates`. |
| review.status | Always `Needs Review`. |

Rows are ordered like the triage report: verdict order, then test id. The verdict order is `likely-real-bug`, `flaky`, `broken-test`, `environment-issue`, `needs-more-runs`.

The recorded SauceDemo JSON report includes a spec line, so `line` is that line. `errorLocation` is the failure location from the error, and it can be a different line. The recorded JUnit report does not include a spec line or an error location, so both fields are null.

## Handoff Gates

Every row records the same five gates, in this order.

| Gate | Passed when |
| --- | --- |
| verdict-not-likely-real-bug | The verdict is not `likely-real-bug`. |
| verdict-not-environment-issue | The verdict is not `environment-issue`. |
| no-slow-load-signal | No cause on that test includes `TIM-SLOW-LOAD`. |
| rule-has-fix-strategy | The primary rule is a locator rule or a suggestion rule in the table below. |
| evidence-present | At least one cause evidence line is non-empty after redaction. |

The note "The report has no error text for these attempts." is not quoted evidence. A `DATA-ORDER` line produced by the order check does count, because it is stored on the cause.

## Handoff Mode

`mode` is `locator`, `suggest`, or `none`.

A verdict of `likely-real-bug` or `environment-issue` is always `none`, even when the primary rule would otherwise be a locator rule or a suggestion rule.

Otherwise:

| Mode | When |
| --- | --- |
| locator | The primary rule is `SEL-NOTFOUND`, `SEL-UNRESOLVED`, or `SEL-ZERO`, the slow load gate passed, and there is quoted evidence. |
| suggest | The primary rule is a suggestion rule in the table below, and there is quoted evidence. The slow load gate does not block this mode. |
| none | The primary rule is a refuse rule, a locator rule was blocked by a slow load signal, or there is no quoted evidence. |

`TIM-SLOW-LOAD` is a suggestion rule. The slow load gate records a failure when that rule matched, and it stops a locator handoff. It does not turn the `TIM-SLOW-LOAD` suggestion off. A selector miss that also has `TIM-SLOW-LOAD` is not a locator handoff.

The reason is one short sentence, at most 300 characters. It names the verdict or the rule that decided the mode.

## Rule Strategies

These are the 17 cause rules. The strategy is the handoff this file offers. Heal still has to accept or refuse the row. This file does not apply a change.

| Rule | Strategy |
| --- | --- |
| SEL-NOTFOUND | locator |
| SEL-UNRESOLVED | locator |
| SEL-ZERO | locator |
| SEL-STRICT | suggest |
| TIM-EXPECT-TIMEOUT | suggest |
| TIM-SLOW-LOAD | suggest |
| TIM-TEST-TIMEOUT | suggest |
| TIM-INTERCEPT | suggest |
| TIM-NEAR-TIMEOUT | none |
| DATA-VALUE-DRIFT | suggest |
| DATA-ALREADY-EXISTS | suggest |
| DATA-ORDER | suggest |
| ENV-NET | none |
| ENV-HTTP5XX | none |
| ENV-BROWSER | none |
| UNK-NONE | none |
| UNK-EMPTY | none |

An unknown rule id is treated as none.

The SauceDemo environment demo passes on a later retry, so its verdict is `flaky`, not `environment-issue`. The primary rule is `ENV-NET`, which is none. A failure that is `environment-issue` is also none, because of the verdict gate.

## Finding Id

`findingId` is the first 12 hex characters of a SHA-256. The hashed bytes are the UTF-8 text of `JSON.stringify([file, project, titlePath])`, using the redacted values that are written in the row. The same file, project, and title path always produce the same id. The id does not include the attempt counts or the error text.

Two tests can redact to the same file, project, and title path when the only difference was an email or another hidden part. Those rows would share an id, and heal joins on `findingId`. When that happens, the hash gains a fourth JSON value: the SHA-256 of the unredacted file, project, and title path. The raw title is not written. The hash is not a secret: someone who can guess the title can check it. The id also changes when a colliding row appears or disappears in a later run, so it is stable for the same set of reports. A row that does not collide keeps the three-value id, so one test alone stays on that id. The same reports still write the same ids.

## Error Signature

`errorSignature` is `sha256:` plus the SHA-256 of the failed attempts' error text, after two steps:

1. `normalizeErrorSignature` rewrites durations, line and column numbers, ports, and call log repeat counts. The steps are in [causes.md](causes.md).
2. The redaction rules below run on that text.

Each distinct failed attempt contributes one block. The blocks stay in retry order and are joined with a newline. The same failure hashes to the same signature. A query string or an email that was removed does not remain in the hashed text.

## Failing Selector

The selector is quoted from the error text. Source frames are skipped.

| Error text | Stored value |
| --- | --- |
| `Locator: locator('#add-to-cart-sauce-labs-bakpack')` | `#add-to-cart-sauce-labs-bakpack` |
| `Locator: locator('[data-test="inventory-item"] img').first()` | `locator('[data-test="inventory-item"] img').first()` |
| `strict mode violation: getByRole('button', { name: 'Remove' })` | `getByRole('button', { name: 'Remove' })` |

A simple `locator('...')` or `locator("...")` with no chain keeps the inner selector. A chain or a `getBy` call keeps the call as printed. When the error has no selector, the field is null.

## Redaction

These rules run on the file, the title, the evidence, the selector, the error location, the report paths, and the error signature text:

| Rule | What it hides |
| --- | --- |
| home-user | A home directory username, using the same `<home>` marks as triage. |
| absolute-path | A machine path under a known folder such as `/opt/`, `/root/`, `/workspace/`, `/private/`, `/tmp/`, or `/var/`, a Windows drive path, or a UNC path. The stored form is `<path>/` plus the last segment. |
| url-query | The query string and the fragment on an `http`, `https`, `ws`, `wss`, or `ftp` URL. A user and password in the URL are removed too. A query on a masked machine path is removed. A query on a home mark such as `<home>/x?token=1` is removed. A query on a relative path such as `/cart?session=abc` is removed before emails are masked. |
| token-like | A `Bearer` token, a JWT-shaped string, a value assigned to `token`, `password`, `api_key`, `access_token`, `refresh_token`, or `secret_key`, a `sk_live_` or `sk_test_` value, a GitHub token prefix, an AWS access key id, or an `Authorization: Basic` value. The stored form is `<token>`. |
| email | An email address. The stored form is `<email>`. |

An app route such as `/assets/` is not a machine path and is left as written. Machine folders also include `/app/`, `/data/`, `/code/`, `/src/`, `/project/`, `/Library/`, `/proc/`, `/run/`, `/dev/`, and `/nix/`. A `file://` URL becomes `file:///<path>/` plus the last segment. A trailing `:line:column` is dropped before that segment is chosen, so the file name stays. A `/mnt/<drive>/Users` path is masked as one path, so the home mark is not left in the middle.

Token-like text covers `Bearer`, a JWT, `Authorization: Basic`, `sk_live_` and `sk_test_`, GitHub token prefixes, AWS access key ids, and assigned names such as `token=`. Cookie values, Slack `xoxb-` tokens, `npm_` tokens, Google `AIza` keys, a user and password in a `postgres://` URL, and `~/` paths are not masked.

A URL-encoded home or machine path, such as `%2Fhome%2F` or `%2Fopt%2F`, is replaced with `<path>`. A query on that encoded path is removed too.

`redaction.rules` lists these five names on every file, in the order above. The list does not shrink when a rule did not match.

Triage JSON still uses the home-user rule only. The extra rules apply to the findings file.

## Recorded SauceDemo Demo

`demo/saucedemo/reports/recorded-seed-443.json` is the JSON report used by the tests. Triage with `--heal-findings` writes one row per failed or flaky test:

| Test | Verdict | Primary rule | Handoff |
| --- | --- | --- | --- |
| problem user image src differs from the standard catalog | likely-real-bug | UNK-NONE | none |
| aborted document fails page.goto | flaky | ENV-NET | none |
| unscoped Remove is strict when two items were added | flaky | SEL-STRICT | suggest |
| B expects the badge A added | flaky | DATA-VALUE-DRIFT | suggest |
| image delay fails the short visibility check | flaky | TIM-EXPECT-TIMEOUT | suggest |
| waitForTimeout before add to cart | flaky | TIM-TEST-TIMEOUT | suggest |
| typo locator never finds the backpack button | broken-test | SEL-NOTFOUND | locator |

The typo row also matches `SEL-ZERO`. The primary rule is `SEL-NOTFOUND`, because that rule comes first in the cause table. The handoff is locator.

The environment row is `flaky` because a later retry passed. The handoff is none because `ENV-NET` has no fix strategy.

The recorded JUnit file keeps one attempt per test. A test that passed on retry is not listed. The typo test is still a broken test, and its handoff is locator. The image test is `needs-more-runs` with rule `UNK-NONE`, so its handoff is none. That file has no spec line and no error location.

## What This Version Does Not Do

`--heal` does not pass `--apply`, `--yes`, or `--no-verify`. It does not pass `--test` together with `--findings`. It does not write the project source. It does not say the test is stable, and it does not say the test is fixed. `review.status` stays `Needs Review`. A patch file under `h/` is the diff text for a person to read. It is not applied.
