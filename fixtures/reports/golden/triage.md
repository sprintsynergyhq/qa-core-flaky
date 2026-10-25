# Triage Report

## Summary

| Test | Verdict | Cause | Confidence |
| --- | --- | --- | --- |
| tests/outcomes.spec.ts::chromium::always fails | likely-real-bug | unknown | medium |
| tests/outcomes.spec.ts::chromium::flaky by retry | flaky | unknown | low |
| tests/outcomes.spec.ts::chromium::times out | needs-more-runs | selectors | medium |

## tests/outcomes.spec.ts::chromium::always fails

Verdict: likely-real-bug
Confidence: medium

### Causes

- unknown (low). Rules: UNK-NONE

### Evidence

> Expected: "a different heading"
> Received: "Ready"

### Attempts

Total 3, failed 3, passed 0. Same code for a pass and a fail: no.

### Signals

- consistent-failure: All attempts on this code failed with one error signature.

### Suggested Fix

The rules did not name a cause. Compare the quoted expected and received values with what the user sees. Do not loosen the assertion to make it pass.

### Next Step

Review the suggested fix. To see the test again, run: `qa-core-flaky rerun --from 'fixtures/reports/pw-1.60.0-outcomes.json' --only 'tests/outcomes.spec.ts::chromium::always fails'`

Review status: Needs Review.

## tests/outcomes.spec.ts::chromium::flaky by retry

Verdict: flaky
Confidence: low
A flaky test can still point to a real app defect. Check the app behavior too.

### Causes

- unknown (low). Rules: UNK-NONE

### Evidence

> Expected: "not ready"
> Received: "Ready"

### Attempts

Total 2, failed 1, passed 1. Same code for a pass and a fail: yes.

### Signals

- same-code-flip: At least one pass and one fail share the same code.

### Suggested Fix

The rules did not name a cause. Compare the quoted expected and received values with what the user sees. Do not loosen the assertion to make it pass.

### Next Step

Review the suggested fix. To see the test again, run: `qa-core-flaky rerun --from 'fixtures/reports/pw-1.60.0-outcomes.json' --only 'tests/outcomes.spec.ts::chromium::flaky by retry'`

Review status: Needs Review.

## tests/outcomes.spec.ts::chromium::times out

Verdict: needs-more-runs
Confidence: medium

### Causes

- selectors (high). Rules: SEL-UNRESOLVED
- timing (high). Rules: TIM-TEST-TIMEOUT

### Evidence

>   - waiting for getByRole('button', { name: 'Never Appears' }) to be visible
> Test timeout of 1000ms exceeded.
> Error: locator.waitFor: Test timeout of 1000ms exceeded.

### Attempts

Total 3, failed 3, passed 0. Same code for a pass and a fail: no.

### Signals

- consistent-failure: All attempts on this code failed with one error signature. The primary cause is selectors (SEL-UNRESOLVED), which is not a broken test, an environment issue, or a likely real bug.

### Suggested Fix

The locator never resolved. Check whether the element is missing or the locator is wrong. This is a candidate for qa-core-heal (PR 9).

### Next Step

Review the suggested fix. To see the test again, run: `qa-core-flaky rerun --from 'fixtures/reports/pw-1.60.0-outcomes.json' --only 'tests/outcomes.spec.ts::chromium::times out'`

Review status: Needs Review.
