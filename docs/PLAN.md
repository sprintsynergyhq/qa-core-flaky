# P3 Flaky Test Triage Agent: Project Plan

Owner: Muhammad Usman (CEO, SprintSynergy). Builder: Chotu, using Cursor cloud agents, one PR per milestone. Reviewer: Chotu, two-pass review on every PR. Merge: Muhammad only.
Status: Draft v2, Oct 23, 2026 (PKT, UTC+5). Nothing is built yet. v2 records Muhammad's repo decision.
Name: qa-core-flaky. Repo: `github.com/sprintsynergyhq/qa-core-flaky` (decided by Muhammad, Oct 23, 2026). The repo stays PRIVATE until v0.1 passes review, and it includes an MIT LICENSE file. Muhammad creates the empty repo himself; it did not exist yet when checked on Oct 23, 2026. README and docs say "private until v0.1 review", never public, open source or published.

## 1. Problem

A red Playwright test does not always mean a bug. Some tests pass and fail on the same code (flaky), and teams learn to ignore red builds. Detection tools already exist (Playwright retries, Trunk, BuildPulse, Datadog, Currents, CircleCI; see RESEARCH.md). What teams still do by hand is the next step: for each red test, is it a real bug or an unstable test, what is the likely cause, and what should change?

P3 answers those three questions per test, with the evidence quoted, and hands the answer to an engineer for review. It fits the master plan angle: "Not every red test is a bug. Know which ones are, fast."

## 2. Scope

### In Scope (v1)
- Inputs: Playwright JSON reports, Playwright JUnit XML reports, retry attempts inside a report, extra reruns that the tool runs itself, a local folder of past reports, and GitHub Actions run history (artifacts) for a repo the user names.
- Per-test verdict: Likely Real Bug, Flaky, Broken Test, Environment Issue, or Needs More Runs.
- Per-test likely cause: Timing, Selectors, Test Data (including order dependency and shared state), Environment, or Unknown.
- Per-test suggested fix written for an engineer to review, plus a proposed locator diff from qa-core-heal when the cause is Selectors.
- Triage report in JSON (stable schema) and Markdown.
- A SauceDemo demo suite with deliberately flaky tests of each cause type and one real app defect.
- Optional LLM explanation (PR 10, Blocked until Muhammad decides), off by default, never changes the deterministic verdict.

### Non-Goals (v1)
- No auto-fix, no commits, no PRs opened by the tool. Applying a change is always a human decision (same rule as qa-core-heal).
- No quarantine or skip management; Trunk, BuildPulse and Datadog already do this.
- No hosted dashboard, database or SaaS.
- No Cypress, Selenium or other runners in v1.
- No client code, client repos or client CI data in demos, fixtures or evals.
- No claim that a test is "stable". Reruns can only show that no flake was observed in N runs.
- No numbers in the README or marketing that the repo's own eval harness does not produce.
- No public release, visibility change or npm publish in v1. The repo is private until v0.1 passes review; going public after that is Muhammad's call.
- The MVP (PRs 1 to 6) is fully rule-based. No LLM in the MVP.

## 3. Inputs

| Input | How We Read It | Notes |
| --- | --- | --- |
| Playwright JSON report | `suites > specs > tests > results[]` with `retry`, `status`, `duration`, `errors`, `attachments`; test `status` and `expectedStatus`; `projectName` | Primary format. Holds every retry attempt. |
| Playwright JUnit XML | `testsuite > testcase` with `failure`, `skipped`, `system-out` | How retries appear in Playwright's JUnit output is an assumption to verify in PR 2. |
| Traces and attachments | Paths from `attachments` (trace.zip, screenshots) | Linked in the report, opened only for page URL in later PRs. |
| Reruns | `qa-core-flaky rerun` runs `npx playwright test` with `--repeat-each`, `--retries=0`, `--workers=1`, file vs single-test isolation | Owned by the tool, written to `.qa-core/flaky/runs/`. |
| Local history | A folder of past JSON or JUnit reports, each with optional metadata (commit SHA, branch, run id, created at) | Enables same-commit flip detection. |
| GitHub Actions history | Read-only REST: list workflow runs, list artifacts, download ZIP | The repo is private, so a token is required: a read-only fine-grained token with `actions:read` and `contents:read`, passed by env var (`GITHUB_TOKEN` or `--token-env`), never logged or committed. Never writes to GitHub. Tests use recorded fixtures only. |

## 4. Classification Approach

Deterministic signals first, LLM reasoning second, human review always.

### 4.1 Normalized Model (All Parsers Emit This)
- `TestRecord`: `id` (stable: `file::project::titlePath joined by " > "`), `file`, `line`, `project`, `titlePath`, `expectedStatus`, `outcome` (`passed`, `flaky`, `failed`, `skipped`), `attempts[]`, `source` (`format`, `reportPath`, `runId`, `commitSha`, `branch`, `createdAt`).
- `Attempt`: `retry`, `status` (`passed`, `failed`, `timedOut`, `skipped`, `interrupted`), `durationMs`, `errors[]` (`message`, `stack`, `location`), `attachments[]` (`name`, `path`, `contentType`), `workerIndex`.

### 4.2 Verdict Signals (Deterministic)
1. Same-code flip: at least one pass and one fail for the same test on the same commit (retries in one run, reruns, or history). Verdict Flaky. This is the shared industry definition (Google, BuildPulse, CircleCI, Playwright).
2. Consistent failure: every attempt and every rerun failed with the same normalized error signature. Verdict depends on cause: app assertion mismatch gives Likely Real Bug; locator not found gives Broken Test; network or browser errors give Environment Issue.
3. Regression point: with history, the first commit where a consistently failing test started failing is named ("fails on every run since abc1234").
4. Order dependency: fails in the full file but passes alone (or the reverse) during reruns. Verdict Flaky, cause Test Data (order dependency), following iDFlakies.
5. Not enough evidence: one failed attempt, no retries, no history. Verdict Needs More Runs, with the exact rerun command.
6. Priority: Broken and Likely Real Bug outrank Flaky when signals conflict (Trunk's rule), and the report shows both signals.

### 4.3 Cause Rules (Deterministic, Evidence Quoted)
| Cause | Signals | Example Evidence |
| --- | --- | --- |
| Selectors | `strict mode violation`, `element(s) not found`, `waiting for locator(` with nothing resolved, count or visibility assertion with zero elements (same evidence rules as qa-core-heal) | `locator.click: Error: strict mode violation: getByRole('button', { name: 'Remove' }) resolved to 2 elements` |
| Timing | `Timeout NNNNms exceeded`, `Test timeout of`, a web-first assertion that resolved the element but timed out on state, failure duration near the configured timeout, `waitForTimeout` in the test source, `intercepts pointer events` | `expect(locator).toBeVisible() failed ... Timeout 2000ms exceeded` |
| Test Data | Assertion value differs between attempts, passes alone and fails in suite (or the reverse), shared storage or serial-mode dependencies, "already exists" style messages | `Expected: "1" Received: "2"` on attempt 1, `Expected: "1" Received: "3"` on attempt 2 |
| Environment | `net::ERR_`, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, HTTP 5xx in the message, browser launch or crash errors, fails only on one project or only on CI | `page.goto: net::ERR_CONNECTION_RESET at https://www.saucedemo.com/` |
| Unknown | No rule matched | The tool says so instead of guessing. |

Each cause gets a confidence: High (two or more independent signals agree), Medium (one strong signal), Low (one weak signal). More than one cause can be listed; the first is primary.

### 4.4 LLM Reasoning (Optional, PR 10)
- Off by default. Enabled with `--explain` and a provider key in an environment variable.
- Sends only redacted error text, the test title and a short source snippet. Never secrets, cookies, storage state or full traces.
- Output is labeled "LLM suggestion, unverified". It can add an explanation and a fix idea for Unknown causes. It never changes the verdict or cause chosen by the rules.

### 4.5 Human Review
- Every finding in the report starts with `review.status: "Needs Review"`. The tool never marks its own finding as accepted.
- Fix suggestions follow antipatterns from Trunk's published autofix prompt: never just raise a timeout, never loosen an assertion, never wait on internal API calls in end-to-end tests.

## 5. Output: Triage Report Per Test

JSON (`schemaVersion: 1`, stable within the major version, like qa-core-heal) and Markdown. One entry per non-passing test:

```json
{
  "id": "tests/cart.spec.ts::chromium::Cart > remove button",
  "verdict": "flaky",
  "confidence": "high",
  "causes": [
    { "cause": "selectors", "confidence": "high", "evidence": ["strict mode violation: getByRole('button', { name: 'Remove' }) resolved to 2 elements"] }
  ],
  "attempts": { "total": 3, "failed": 1, "passed": 2, "sameCommit": true },
  "history": { "runsSeen": 0, "firstFailingCommit": null },
  "suggestedFix": "Scope the locator to the item row, for example inventoryItem.getByRole('button', { name: 'Remove' }).",
  "healProposal": null,
  "nextStep": "Review the fix. If accepted, rerun with: npx qa-core-flaky rerun tests/cart.spec.ts -g \"remove button\" --times 10",
  "llm": null,
  "review": { "status": "Needs Review", "reviewer": null, "decision": null }
}
```

Exit codes (mirroring qa-core-heal): 0 report written and nothing needs attention, 1 tool error, 2 report written with at least one finding that needs review.

## 6. Architecture

```
inputs (JSON, JUnit, rerun output, history folder, GitHub artifacts)
   -> parsers (src/parsers/*)          -> normalized TestRecord[]
   -> history store (.qa-core/flaky/)   -> merged records per test id
   -> signals (src/signals/*)          -> flips, consistency, order, regression point
   -> cause rules (src/causes/*)       -> causes with quoted evidence
   -> verdict engine (src/verdict.ts)  -> verdict + confidence
   -> fix suggester (src/fixes/*)      -> templates per cause, optional qa-core-heal dry-run diff
   -> optional LLM explainer           -> labeled suggestion only
   -> reporters (src/report/*)         -> triage.json (schemaVersion 1) + triage.md
CLI: qa-core-flaky parse | triage | rerun | history fetch
```

Tech stack, matching qa-core-heal: TypeScript, ESM, Node 22.6 or later, `tsc` build, `node --test` tests, `@playwright/test` pinned to 1.60.0 (same as qa-core-heal), `node:util parseArgs` for the CLI, one XML dependency (`fast-xml-parser`) added in PR 2. MIT LICENSE file in a private repo (decided). Private until v0.1 review. State folder `.qa-core/flaky/` next to qa-core-heal's `.qa-core/`.

### Reuse Of qa-core-heal
- Reuse the idea and the evidence rules: qa-core-heal already classifies failures as locator or non-locator from Playwright error text and call logs, and says "not a locator problem, healing won't fix this" for the rest.
- Integrate, do not fork: for a Selectors cause, P3 calls `npx qa-core-heal <spec> --dry-run --json` (documented flags, `schemaVersion 1` JSON with `verdicts[]`) and attaches the proposed diff or the refusal reason to the report. P3 never passes `--yes` and never applies a heal.
- Limits to respect: qa-core-heal fixes broken locators; it does not fix timing, data or environment flakes, and its own do-not-claim list bans "Fixes all flaky tests". A selector that matches several elements intermittently is a refusal case in qa-core-heal ("cannot be recovered safely"), so P3 must also offer its own scoped-locator suggestion.
- Open question: should P3 import qa-core-heal as a library instead of a CLI call? CLI first, because the JSON contract is documented and stable.

## 7. Milestones (One Cloud Agent PR Each)

MVP is PRs 1 to 6: read JSON or JUnit with retries, rerun, classify, report, and a SauceDemo demo. Each PR has a full brief in BUILD-PROMPT-NN.md.

| PR | Title | Goal | Acceptance Criteria (Short) |
| --- | --- | --- | --- |
| 1 | Scaffold And Playwright JSON Parser | Repo scaffold, CI, normalized model, JSON parser, `parse` command | `npm test` green offline; golden fixtures produced by a real local Playwright run; flaky, failed, passed, skipped, timedOut mapped correctly |
| 2 | JUnit XML Parser | Parse Playwright JUnit into the same model | Same fixture suite parsed from JUnit matches JSON on ids and outcomes; known JUnit gaps documented |
| 3 | Deterministic Cause Rules | Selectors, Timing, Test Data, Environment, Unknown with quoted evidence | Every rule has a fixture test; Unknown returned when nothing matches; no rule guesses |
| 4 | Verdict Engine And Triage Report | Verdicts, confidence, fix templates, `triage` command, JSON and Markdown | Schema v1 documented; exit codes 0, 1, 2; byte-stable output on two runs |
| 5 | SauceDemo Flaky Demo Suite | Deliberately flaky tests per cause plus one real defect, seeded | Expected verdict file; triage on recorded demo reports matches it; live run optional and polite |
| 6 | Rerun Command | `rerun` with repeat, isolation and order checks | Order-dependent fixture detected; reruns merged by commit; never reports "stable" |
| 7 | Local History And Same-Commit Flips | Folder of past reports, flip detection, first failing commit | Flip across two runs on one SHA gives Flaky; consistent failure since a SHA is named |
| 8 | GitHub Actions History Fetcher | Read-only fetch of Playwright report artifacts | Private repo needs a read-only fine-grained token (actions:read, contents:read) by env var; recorded fixtures only in tests; token never logged or committed; GET only |
| 9 | qa-core-heal Integration | Attach heal dry-run diff or refusal for Selectors causes | Never runs without `--dry-run`; works when heal is absent (clear message) |
| 10 | Optional LLM Explainer (Blocked) | `--explain` with redaction and labels | Blocked until Muhammad decides on the LLM step; off by default; mock provider in tests; verdict unchanged with or without it |
| 11 | Eval Harness, Docs And Release Readiness | `npm run evals`, README with measured results only, demo CI workflow | Evals reproducible; README numbers come from the harness; repo stays private until v0.1 review; no npm publish |

## 8. SauceDemo Demo Plan

Site: https://www.saucedemo.com, public practice app by Sauce Labs. Users in the bundle (checked Oct 23, 2026): standard_user, locked_out_user, problem_user, performance_glitch_user, error_user, visual_user; password secret_sauce; elements carry `data-test` attributes.

Flakes are injected in the test code, not found by luck, so the demo is reproducible. A `FLAKE_SEED` environment variable drives a small seeded random generator, and `FLAKE_RATE` sets the chance. With a fixed seed the same attempts fail every time.

| Cause | How We Create It On SauceDemo | Expected Verdict |
| --- | --- | --- |
| Timing | `page.route` adds a seeded random delay to the inventory image requests, and the test asserts the image is visible with a short timeout. A second variant uses `waitForTimeout` before a click instead of a web-first assertion. Optional third variant: performance_glitch_user login (its exact delay is an assumption to measure in PR 5). | Flaky, cause Timing |
| Selectors | The test adds a seeded random number of items (1 or 2) to the cart, then clicks `getByRole('button', { name: 'Remove' })` without scoping, which is a strict mode violation only when 2 items were added. | Flaky, cause Selectors, heal refusal shown |
| Selectors (broken, not flaky) | A typo locator such as `#add-to-cart-sauce-labs-bakpack`. Fails every time. | Broken Test, cause Selectors, heal proposal shown |
| Test Data | Two tests share one page in serial mode. Test B expects the cart badge to read "1" because test A added an item. Passes in file order, fails when run alone or with `--repeat-each`. | Flaky, cause Test Data (order dependency) |
| Environment | `page.route` aborts the main document request with a seeded probability, which gives a `net::ERR_` error on `page.goto`. | Flaky, cause Environment |
| Real bug | A test for a behavior that SauceDemo's problem_user or error_user breaks on purpose, for example sorting or checkout. Which behavior breaks is an assumption to confirm in PR 5 before it goes in the expected file. | Likely Real Bug |

Polite use: one worker against the live site, small repeat counts, no load testing. CI tests in the repo use recorded reports from the demo, so CI never depends on SauceDemo being up.

## 9. Risks

- Misclassification erodes trust. Mitigation: evidence quoted for every cause, Unknown allowed, human review status on every finding, eval harness with pinned fixtures.
- A flaky label can hide a real race condition in the app (Google 2016 warns quarantine can mask real bugs). Mitigation: the report states that a flaky test can still point to an app defect, and Timing causes suggest checking the app too.
- Reruns cost CI time and can never prove stability (FlakeFlagger). Mitigation: rerun counts are explicit flags, defaults small, wording "no flake observed in N runs".
- Playwright JSON or JUnit format changes. Mitigation: pin Playwright 1.60.0 in fixtures, version-tagged golden files.
- Live SauceDemo can change or go down. Mitigation: recorded reports in CI, live run optional.
- Secrets in CI artifacts or LLM prompts. Mitigation: read-only fine-grained token (actions:read, contents:read) by env var only, redaction layer, no secrets in logs, fixtures or commits.
- Competing tools are mature. Mitigation: position P3 as the explain-and-suggest step that works with Playwright output and qa-core-heal, not as a dashboard.

## 10. Open Questions For Muhammad

Decided (Oct 23, 2026, PKT): repo `github.com/sprintsynergyhq/qa-core-flaky`, private until v0.1 passes review, with an MIT LICENSE file. Muhammad creates the empty repo. Chotu cannot start PR 1 until it exists.

Still open:
1. LLM step: keep it (PR 10, Blocked) and, if so, which provider and who pays for the key? Or stay fully deterministic like qa-core-heal and drop PR 10? The MVP is rule-based either way.
2. npm: publish later as `qa-core-flaky` after v0.1 review, or keep it as a repo only? Until decided, the package stays `"private": true`.
3. GitHub history demo: use the private qa-core-flaky repo's own demo workflow (suggested default)? Needs a read-only fine-grained token.
4. Positioning: is it fine to say in the README that Trunk, BuildPulse, Datadog and Currents detect flakes and that P3 focuses on cause and fix suggestions?
