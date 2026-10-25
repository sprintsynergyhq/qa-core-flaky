/**
 * Seeded yes-or-no for one demo test attempt.
 *
 * `FLAKE_SEED` picks the sequence. `FLAKE_RATE` is the chance, default 0.5.
 * The same seed, test id, and retry always return the same boolean.
 * Playwright tests call `shouldFlake`. Unit tests pass an env object so they
 * do not read the process environment.
 */

const DEFAULT_SEED = 1;
const DEFAULT_RATE = 0.5;

export function readSeed(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.FLAKE_SEED ?? String(DEFAULT_SEED));
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_SEED;
  return parsed;
}

export function readRate(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.FLAKE_RATE ?? String(DEFAULT_RATE));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_RATE;
  return parsed;
}

/** A number in [0, 1) from the seed, the test id, and the retry index. */
export function flakeUnit(testId: string, retry: number, seed: number): number {
  let hash = seed >>> 0;
  const input = `${testId}\n${retry}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x5bd1e995);
    hash = (hash ^ (hash >>> 13)) >>> 0;
  }
  let state = (hash + 0x6d2b79f5) | 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
}

export function shouldFlake(
  testId: string,
  retry: number,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return flakeUnit(testId, retry, readSeed(env)) < readRate(env);
}
