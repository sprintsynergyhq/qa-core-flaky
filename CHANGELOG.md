# Changelog

## 0.1.2 - 2026-10-30

Windows fixes for `--heal`.

- **Fixed:** `triage --heal` now finds qa-core-heal on Windows. It used to print `qa-core-heal is not installed. No proposal was made.` even when qa-core-heal was installed, because Windows cannot start `npx` without a shell. The tool now looks for `node_modules/qa-core-heal` in the folder where you run it and in each parent folder, and starts heal's own script with Node on every OS. On macOS and Linux, `npx --no-install qa-core-heal` is still the fallback when heal is not installed there. Reported by Abdul Rafay.
- **Changed:** The default wait for the heal step is now 180 seconds instead of 60 seconds. On Windows one locator finding took about 57 seconds with qa-core-heal 0.7.2, so `triage --heal` sometimes refused it with `timeout` and `The re-run in the copy timed out.` `QA_CORE_HEAL_TIMEOUT_MS` can now set up to 600000 (10 minutes) instead of 120000. Reported by Abdul Rafay.
- **Changed:** Heal's `--run-timeout` now keeps back 10 percent of the time left, at least 1 second and at most 15 seconds, instead of 1 second. This gives heal time to stop its last run and write its results before flaky stops it. With the default wait, heal gets about 165 seconds.
- **Docs:** The README and the heal contract explain how heal is found and started, and what happens on Windows when it is not installed. The README now documents `QA_CORE_HEAL_TIMEOUT_MS`, with a Windows example.
- **Tests:** New tests cover the heal lookup, parent folders, the `bin` field, a `bin` that leaves the package folder, the Windows fallback, and a full `triage --heal` run that finds heal in `node_modules`. New tests cover the 180 second default, the 10 minute limit, the `--run-timeout` reserve, and the value sent to heal when `QA_CORE_HEAL_TIMEOUT_MS` is not set. The HTML example now shows version 0.1.2.

## 0.1.1 - 2026-10-30

A Windows fix for `rerun`, plus package details and docs.

- **Fixed:** `rerun` now works on Windows. It used to stop with `spawn ... node_modules/.bin/playwright ENOENT`, because Windows cannot start that file. The tool now starts Playwright's own `cli.js` with Node on every OS. On Windows the child processes are no longer detached, so no console windows open during a rerun or a heal call, and cleanup stops the whole process tree with `taskkill /T`. The file filter on Windows now matches a backslash or a forward slash in the path, and the printed command shows that filter correctly. Reported by Abdul Rafay.
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
