import type { RuleMatch } from './types.js';
import { lineContaining } from './text.js';

const ALREADY = /already exists|duplicate|unique constraint/i;

/** `already exists`, `duplicate`, or `unique constraint`. */
export function alreadyExistsMatch(text: string): RuleMatch | undefined {
  const evidence = lineContaining(text, ALREADY);
  if (!evidence) return undefined;
  return { ruleId: 'DATA-ALREADY-EXISTS', evidence: [evidence] };
}

export type ReceivedSample = {
  /** Matcher, locator line, and expected line. Samples with the same key are one assertion. */
  key: string;
  /** The `Received:` line, kept as written. */
  receivedLine: string;
};

/**
 * Read the assertion identity and the received line.
 * Returns undefined when the text has no received value.
 */
export function readReceived(text: string): ReceivedSample | undefined {
  const receivedLine = lineContaining(text, /^Received:\s*.+$/);
  const expectedLine = lineContaining(text, /^Expected:\s*.+$/);
  if (!receivedLine || !expectedLine) return undefined;
  const matcher =
    /expect\(locator\)\.(\w+)\(/.exec(text)?.[1] ?? /Expect "(\w+)"/.exec(text)?.[1] ?? '';
  if (!matcher) return undefined;
  const locatorLine = lineContaining(text, /^Locator:\s*.+$/) ?? '';
  return {
    key: `${matcher}\n${locatorLine}\n${expectedLine}`,
    receivedLine,
  };
}
