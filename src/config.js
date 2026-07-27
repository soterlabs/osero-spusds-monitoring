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

  // Cache TTLs (seconds)
  liveCacheTtl: Number(process.env.LIVE_CACHE_TTL || 30),
};
