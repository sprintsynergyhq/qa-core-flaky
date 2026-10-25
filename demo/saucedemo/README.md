# SauceDemo Demo

A small Playwright suite against the public practice app at https://www.saucedemo.com. Some tests fail on purpose. A seeded helper decides which attempts fail, so the same seed repeats the same pattern. This repository is private until v0.1 review.

Unit tests and CI read the recorded reports. They do not open the live site.

## How To Run

From the repository root, with the Playwright Chromium browser installed:

```sh
npm run demo:live
npm run demo:record -- --seed 443
npm run demo:triage
```

`demo:live` runs the suite once. `demo:record` runs it with the given seed, then writes normalized reports. `demo:triage` triages the committed JSON report. One worker. Two retries. No trace, screenshot, or video.

`FLAKE_RATE` defaults to 0.5. `demo:record` sets it to 0.5 for that run. The only password in the suite is the public demo password `secret_sauce`.

## Seed 443

`FLAKE_SEED=443` and `FLAKE_RATE=0.5` make each flaky test fail on attempt 0 and pass on a later retry:

| Test id used by the helper | Attempt 0 | Attempt 1 | Attempt 2 |
| --- | --- | --- | --- |
| timing-image | fail | pass | |
| timing-wait | fail | pass | |
| selectors-remove | fail | pass | |
| environment-net | fail | pass | |
| testdata-badge | fail | fail | pass |

The recorded report from `npm run demo:record -- --seed 443` on 25 Oct 2026 (UTC) shows that pattern. The command used one worker and two retries.

## Tests

`timing.spec.ts` has two timing cases. The image test routes `**/assets/**/*.jpg` and delays those responses by 3 seconds when the seed says so, then expects the first product image to be visible within 1 second. On 25 Oct 2026 (UTC) the live product images were `/assets/*.jpg`, and a delayed image stayed hidden, so that check failed. The older `/static/media/` path was not what the site served, so the route uses the path that was observed. The second test calls `page.waitForTimeout` before adding the backpack. That wait is the antipattern being demonstrated. When the seed says so, the wait is longer than the test timeout.

`selectors.spec.ts` adds one item, or two when the seed says so, then clicks `getByRole('button', { name: 'Remove' })` with no filter. Two Remove buttons are a strict mode violation. One Remove button clicks and the badge goes away.

`broken.spec.ts` expects `#add-to-cart-sauce-labs-bakpack` to be visible. The id is a typo. Every attempt fails with element not found.

`environment.spec.ts` aborts the main document with `route.abort('internetdisconnected')` when the seed says so. `page.goto` then fails with `net::ERR_INTERNET_DISCONNECTED`. The next attempt does not abort, and the login page loads.

`test-data.spec.ts` keeps one page for two tests. `beforeAll` logs in and does not add an item. Test A adds the backpack and expects the badge `1`. Test B expects that same badge. The describe uses the default mode, so a retry runs test B again and does not restart test A. Serial mode is not used, because a serial retry would restart the whole group. When the seed says so, test B sets the cart to 2 items on attempt 0 and 3 items on attempt 1, so the two failures have different `Received:` lines. The passing attempt puts one item back.

`real-bug.spec.ts` logs in as `problem_user` and expects the first product image src to contain `sauce-backpack`. See the observation below. The report calls this a likely real bug.

`healthy.spec.ts` checks that the inventory has six products, and that adding the backpack shows a badge of `1`. Both passed in the recorded run.

## Shared Cart Observations

These runs were on 25 Oct 2026 (UTC), one worker, seed 443, rate 0.5, unless a line says otherwise.

In file order, test A passed. Test B failed attempt 0 with `Received: "2"`, failed attempt 1 with `Received: "3"`, and passed attempt 2. That file-order run is the recorded report.

`--repeat-each 2` on `test-data.spec.ts` ran A, then B, then A again, then B again. Both copies of A passed. Both copies of B failed with received 2, failed with received 3, and then passed.

`-g "B expects"` still ran `beforeAll`, which only logs in. Test A did not run. Attempt 0 received 2, attempt 1 received 3, and attempt 2 passed, because the passing path puts one item back. Under this seed, B alone still flips.

A separate run with `FLAKE_RATE=0` and `--retries 0`, still using `-g "B expects"`, failed once. The badge was not on the page (`element(s) not found`). A had not added it.

## Observed User Behavior

Observed on 25 Oct 2026 (UTC) against https://www.saucedemo.com. This is what those runs did. It is not a guarantee about a later visit.

`standard_user` reached the inventory in 308 ms, 245 ms, and 255 ms. Six products were listed. The backpack image src was `/assets/sauce-backpack-1200x1500-CjRW-Djj.jpg`. The remove control's accessible name was `Remove`.

`locked_out_user`, one login, stayed on `/` and showed `Epic sadface: Sorry, this user has been locked out.`

`problem_user`, three logins, gave every product image the src `/assets/sl-404-Cq1a9k9X.jpg`. The recorded test failed the same way on all three attempts. No flake was observed in those runs. One extra check selected name Z to A. The control stayed on `az`, and the names stayed in the same order. The image mismatch is the assertion this suite keeps.

`performance_glitch_user` reached the inventory in 5319 ms, 5324 ms, and 5318 ms. The delay was present on all three logins, so it cannot fail one attempt and pass the next. It is not in the suite.

`error_user`, one login, set the cart badge to `1` after Add. A Remove click left the badge at `1`. The checkout fields on that page used `data-test` values `firstName`, `lastName`, and `postalCode`. That was one login, not a repeated check.

`visual_user`, one login, served `/assets/sl-404-Cq1a9k9X.jpg` for the first product and the usual product images for the other five.

## Recorded Reports

`reports/recorded-seed-443.json` and `reports/recorded-seed-443.junit.xml` come from the live command above. Volatile fields are normalized the same way as `scripts/make-fixtures.mjs`. `expected-verdicts.json` is the verdict and primary cause each JSON test should get.

The JUnit file keeps one attempt per test. A test that passed on retry has no failure element, so triage does not list it. The broken test is still a broken test, with low confidence because there is one attempt. The likely real bug needs two failed attempts, so the single JUnit attempt is `needs-more-runs` with cause `unknown` and low confidence. `tests/demo.test.mjs` asserts those gaps. It does not call the network.
