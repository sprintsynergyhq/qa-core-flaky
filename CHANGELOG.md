# Changelog

## 0.1.0 - 2026-10-28

First public release.

- Normalize a Playwright JSON report into one record per test, and keep every retry attempt.
- Parse a JUnit XML report. The format is detected from the file contents.
- Name a likely cause for each failed or flaky test, with evidence quoted from the error text.
- Write a triage report as JSON and Markdown. Each row has a verdict, a suggested fix, and a next step.
- Rerun failing tests with Playwright in `repeat`, `isolated`, and `in-order` modes, then merge the new attempts. This needs `@playwright/test` in the project under test.
- Write a self-contained HTML report with `--html`.
- Write a heal findings file with `--heal-findings`.
- Ask qa-core-heal for a dry run with `--heal` and store the proposal. qa-core-heal 0.4.0 or later can return a re-run-verified fix. qa-core-heal 0.3.x uses the older dry-run mode.
- Include a seeded SauceDemo demo in the repository.
