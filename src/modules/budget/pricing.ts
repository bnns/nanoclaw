/**
 * Anthropic first-party API list prices, USD per million tokens.
 * Cache writes: 5-minute TTL = 1.25x input, 1-hour TTL = 2x input.
 *
 * Update this table when the agent's model changes — an unknown model is
 * priced at the most expensive rates below (and logged), so a missing entry
 * over-counts rather than letting spend through uncounted.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const rates = (input: number, output: number, cacheRead: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

// Keys are model-id prefixes; the longest matching prefix wins, so dated
// ids like claude-haiku-4-5-20251001 resolve to their family.
const PRICES: Record<string, Rates> = {
  'claude-fable-5-1': rates(10, 50, 0.25),
  'claude-fable-5': rates(10, 50, 1),
  'claude-opus-5-5': rates(4, 20, 0.2),
  'claude-opus-5': rates(5, 25, 0.5),
  'claude-opus-4-8': rates(5, 25, 0.5),
  'claude-opus-4-7': rates(5, 25, 0.5),
  'claude-opus-4-6': rates(5, 25, 0.5),
  'claude-sonnet-5': rates(2, 10, 0.2),
  'claude-sonnet-4-6': rates(3, 15, 0.3),
  'claude-haiku-4-5': rates(1, 5, 0.1),
};

export const FALLBACK_RATES: Rates = PRICES['claude-fable-5-1'];

/** Rates for a model id, or null when no prefix matches. */
export function ratesFor(model: string): Rates | null {
  let best: string | null = null;
  for (const prefix of Object.keys(PRICES)) {
    if ((model === prefix || model.startsWith(prefix + '-')) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? PRICES[best] : null;
}
