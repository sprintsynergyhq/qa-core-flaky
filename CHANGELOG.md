# Changelog

## 0.1.1 - 2026-10-30

A Windows fix for `rerun`, plus package details and docs.

- **Fixed:** `rerun` now works on Windows. It used to stop with `spawn ... node_modules/.bin/playwright ENOENT`, because Windows cannot start that file. The tool now starts Playwright's own `cli.js` with Node on every OS, and no console window opens on Windows. The file filter on Windows now matches a backslash or a forward slash in the path, and the printed command shows that filter correctly. Reported by Abdul Rafay.
- **Changed:** The package author is now SprintSynergy (https://sprintsynergy.com), and Muhammad Usman is listed as a contributor.
- **Changed:** The printed rerun command now starts with `npx playwright test` when Playwright is installed in the folder where you run it.
- **Docs:** The README now shows version 0.1.1 and ends with a line saying who builds and maintains the project. The rerun docs explain how Playwright is found and started.
- **Tests:** New tests cover Windows file filters, the Playwright lookup, and how the rerun starts Playwright. The HTML example now shows version 0.1.1.

## 0.1.0 - 2026-10-29

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
- Import the parsers, cause rules, and report builders from `qa-core-flaky` in Node. The package sets `main` and `types` for this.
