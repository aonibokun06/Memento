// Context-window math. Pure functions, no DOM, no network.
//
// VERIFY THESE before demoing — context windows and prices change, and stale
// numbers here silently make every readout wrong.
// Prices are USD per 1M tokens.

const MODELS = [
  // matched by substring against the model label scraped off the page
  [/opus/i,        { context: 1_000_000, in: 5.00,  out: 25.00 }],
  [/sonnet\s*5/i,  { context: 1_000_000, in: 3.00,  out: 15.00 }],
  [/sonnet/i,      { context: 1_000_000, in: 3.00,  out: 15.00 }],
  [/haiku/i,       { context: 200_000,   in: 1.00,  out: 5.00  }],
  [/gpt-4\.1/i,    { context: 1_000_000, in: 2.00,  out: 8.00  }],
  [/gpt-4o/i,      { context: 128_000,   in: 2.50,  out: 10.00 }],
  [/gpt-5/i,       { context: 400_000,   in: 1.25,  out: 10.00 }],
];

// Used when the model can't be read off the page. Deliberately conservative:
// a small assumed window warns early, which is the safe direction to be wrong.
const DEFAULT_MODEL = { context: 128_000, in: 3.00, out: 15.00 };

export function modelInfo(label) {
  if (!label) return DEFAULT_MODEL;
  for (const [re, info] of MODELS) if (re.test(label)) return info;
  return DEFAULT_MODEL;
}

export const THRESHOLDS = { notice: 0.6, urgent: 0.8 };

/**
 * Turn a raw meter reading into everything the UI needs.
 * @returns {{tokens, context, ratio, level, cost, perTurn, turnsLeft}}
 */
export function analyze(meter) {
  const info = modelInfo(meter?.model);
  const tokens = meter?.tokens ?? 0;
  const ratio = Math.min(tokens / info.context, 1);

  // Every turn re-sends the whole conversation, so cost grows roughly with the
  // square of length. This approximates that rather than pricing tokens once.
  const turns = Math.max(meter?.messages ?? 0, 1);
  const cost = ((tokens * turns) / 2 / 1_000_000) * info.in;

  const recent = meter?.recentTurnTokens ?? [];
  const perTurn = recent.length
    ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
    : 0;

  // Pace beats level: 55% while adding 8k a turn is worse than 75% adding 500.
  const turnsLeft =
    perTurn > 0 ? Math.max(Math.floor((info.context - tokens) / perTurn), 0) : null;

  return {
    tokens,
    context: info.context,
    ratio,
    level:
      ratio >= THRESHOLDS.urgent
        ? "urgent"
        : ratio >= THRESHOLDS.notice
          ? "notice"
          : "calm",
    cost,
    perTurn,
    turnsLeft,
  };
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
