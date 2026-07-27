const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 3000),

  // Ethereum mainnet RPC. Needs archive `eth_call` (Alchemy free tier is fine).
  rpcUrl: required('RPC_URL'),

  // Etherscan API key — used to list the holder's aToken transfers, which is how
  // we discover the blocks where the position actually changed. The RPC is not
  // used for this because free RPC tiers cap `eth_getLogs` to a tiny block range.
  etherscanApiKey: required('ETHERSCAN_API_KEY'),
  etherscanBaseUrl: process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/v2/api',
  chainId: Number(process.env.CHAIN_ID || 1),

  // Osero ALM Proxy
  holder: (process.env.HOLDER_ADDRESS || '0x6d370e359e9cbd0fd35bb38faf705d84238cb884').toLowerCase(),

  // SparkLend spUSDS (Aave v3 style aToken, 18 decimals)
  aToken: (process.env.ATOKEN_ADDRESS || '0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359').toLowerCase(),

  // Sky Savings Rate source. `ssr()` returns a per-second rate in RAY; the
  // base rate Sky charges a prime agent is SSR + a spread.
  susds: (process.env.SUSDS_ADDRESS || '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd').toLowerCase(),

  // Spread over SSR, in basis points, keyed by the UTC date it took effect.
  // Sky moved the base-rate spread 30bps → 20bps on 2026-07-23, so a single
  // constant would misprice any window spanning that date. Override with
  // BASE_RATE_SPREAD_SCHEDULE as JSON, e.g. '[{"from":"2026-07-23","bps":20}]'.
  spreadSchedule: parseSchedule(process.env.BASE_RATE_SPREAD_SCHEDULE) ?? [
    { from: '1970-01-01', bps: 30 },
    { from: '2026-07-23', bps: 20 },
  ],

  // Cache TTLs (seconds)
  liveCacheTtl: Number(process.env.LIVE_CACHE_TTL || 30),
};

function parseSchedule(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BASE_RATE_SPREAD_SCHEDULE must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('BASE_RATE_SPREAD_SCHEDULE must be a non-empty array.');
  }
  for (const e of parsed) {
    if (!e || typeof e.from !== 'string' || Number.isNaN(Date.parse(e.from))) {
      throw new Error(`BASE_RATE_SPREAD_SCHEDULE entry needs a valid "from" date: ${JSON.stringify(e)}`);
    }
    if (typeof e.bps !== 'number' || !Number.isFinite(e.bps) || e.bps < 0) {
      throw new Error(`BASE_RATE_SPREAD_SCHEDULE entry needs a non-negative "bps": ${JSON.stringify(e)}`);
    }
  }
  return [...parsed].sort((a, b) => (a.from < b.from ? -1 : 1));
}
