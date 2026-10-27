/**
 * One suggestion per cause rule id.
 * None of these tell the reader to only raise a timeout, to loosen an
 * assertion, or to wait on an internal API call.
 */
const TEMPLATES: Readonly<Record<string, string>> = {
  'SEL-STRICT':
    'Scope the locator to its row or container, or use a distinguishing attribute such as data-test.',
  'SEL-NOTFOUND':
    'Check whether the app changed or the locator is wrong. This is a candidate for qa-core-heal.',
  'SEL-UNRESOLVED':
    'The locator never resolved. Check whether the element is missing or the locator is wrong. This is a candidate for qa-core-heal.',
  'SEL-ZERO':
    'The assertion saw zero elements. Scope the locator to the container that should hold the element, or confirm the element is rendered.',
  'ENV-NET': 'Check the network and the base URL. Keep retries only for infrastructure errors.',
  'ENV-HTTP5XX':
    'The server returned a 5xx status. Check the service and the base URL. Keep retries only for infrastructure errors.',
  'ENV-BROWSER':
    'The browser failed to launch or the page closed. Check the browser install and whether the test closed the page early.',
  'TIM-EXPECT-TIMEOUT':
    'Replace fixed waits with web-first assertions on what the user sees, and check whether the app itself is slow.',
  'TIM-SLOW-LOAD':
    'The page was still loading or navigation was slow, so the element was not there yet. Wait for the page to finish loading, then assert what the user sees, and check whether the app itself is slow.',
  'TIM-TEST-TIMEOUT':
    'The test hit its time limit while waiting. Wait for what the user sees with a web-first assertion, and check whether the app itself is slow.',
  'TIM-INTERCEPT': 'Wait for the overlay to disappear and check whether real users are blocked.',
  'TIM-NEAR-TIMEOUT':
    'The attempt used most of the time limit. Check whether the app itself is slow, and wait for what the user sees instead of a fixed pause.',
  'DATA-VALUE-DRIFT': 'Give each test its own data and reset state in beforeEach.',
  'DATA-ALREADY-EXISTS': 'The data was already present. Give this test its own data and reset state in beforeEach.',
  'DATA-ORDER':
    'The failure depends on test order. Reset shared state in beforeEach and do not rely on another test to set it up.',
  'UNK-NONE':
    'The rules did not name a cause. Compare the quoted expected and received values with what the user sees. Do not loosen the assertion to make it pass.',
  'UNK-EMPTY':
    'The failure has no error text. Rerun the test so the next report includes the error, then read that evidence.',
};

/** Every rule id that has suggestion text. */
export function fixTemplates(): Readonly<Record<string, string>> {
  return TEMPLATES;
}

/**
 * Suggestion for the first rule id that has a template.
 * An unknown id uses the `UNK-NONE` text.
 */
export function suggestFix(ruleIds: readonly string[]): string {
  for (const ruleId of ruleIds) {
    const text = TEMPLATES[ruleId];
    if (text) return text;
  }
  return TEMPLATES['UNK-NONE'] ?? '';
}
