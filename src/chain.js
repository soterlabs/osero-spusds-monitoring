import { createPublicClient, http, erc20Abi, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { config } from './config.js';
import { cached, forever } from './cache.js';
import { withLimit } from './limiter.js';
import { RAY, deployedFrom, lendingIdleFrom } from './math.js';

export { RAY };

export const client = createPublicClient({
  chain: mainnet,
  // Retries are owned by the limiter, which backs the whole pipeline off on a
  // 429 instead of letting each request retry into the same wall independently.
  transport: http(config.rpcUrl, { batch: { wait: 10 }, retryCount: 0, timeout: 30_000 }),
});

const aTokenAbi = parseAbi([
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function balanceOf(address user) view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
]);

const poolAbi = parseAbi([
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

/** Static metadata about the aToken, its underlying asset and its lending pool. */
export const getMarket = () =>
  cached('market', forever, async () => {
    const aToken = config.aToken;
    const read = (address, abi, functionName) =>
      withLimit(() => client.readContract({ address, abi, functionName }));
    const [symbol, name, decimals, underlying, pool] = await Promise.all([
      read(aToken, erc20Abi, 'symbol'),
      read(aToken, erc20Abi, 'name'),
      read(aToken, erc20Abi, 'decimals'),
      read(aToken, aTokenAbi, 'UNDERLYING_ASSET_ADDRESS'),
      read(aToken, aTokenAbi, 'POOL'),
    ]);
    const [underlyingSymbol, underlyingDecimals] = await Promise.all([
      read(underlying, erc20Abi, 'symbol'),
      read(underlying, erc20Abi, 'decimals'),
    ]);
    return {
      aToken: { address: aToken, name, symbol, decimals },
      underlying: { address: underlying.toLowerCase(), symbol: underlyingSymbol, decimals: underlyingDecimals },
      pool: pool.toLowerCase(),
    };
  });

const atBlock = (blockNumber) => (blockNumber == null ? {} : { blockNumber });

/**
 * Scaled (index-normalised) aToken balance. This only moves when principal moves —
 * interest accrual leaves it untouched — which is what makes it the right basis
 * for separating deposits/withdrawals from yield.
 */
export async function scaledBalanceOf(holder, blockNumber) {
  const key = `scaled:${holder}:${blockNumber ?? 'latest'}`;
  return cached(key, blockNumber == null ? config.liveCacheTtl : forever, () =>
    withLimit(() =>
      client.readContract({
        address: config.aToken,
        abi: aTokenAbi,
        functionName: 'scaledBalanceOf',
        args: [holder],
        ...atBlock(blockNumber),
      })
    )
  );
}

/**
 * The reserve's normalised income (RAY). balance = scaledBalance * index / RAY,
 * so this index is the per-unit growth factor of every supplied token.
 */
export async function liquidityIndexAt(blockNumber) {
  const key = `index:${blockNumber ?? 'latest'}`;
  return cached(key, blockNumber == null ? config.liveCacheTtl : forever, async () => {
    const { underlying, pool } = await getMarket();
    return withLimit(() =>
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'getReserveNormalizedIncome',
        args: [underlying.address],
        ...atBlock(blockNumber),
      })
    );
  });
}

/** Current supply-side interest rate of the reserve (RAY, per year). */
export async function currentLiquidityRate() {
  return cached('liquidityRate', config.liveCacheTtl, async () => {
    const { underlying, pool } = await getMarket();
    const data = await withLimit(() =>
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'getReserveData',
        args: [underlying.address],
      })
    );
    return data.currentLiquidityRate;
  });
}

/**
 * Scaled balance and reserve index at the same historical block, in one
 * multicall. Halves the RPC cost of reconstructing a position's flow history.
 */
export async function scaledBalanceAndIndexAt(holder, blockNumber) {
  return cached(`pair:${holder}:${blockNumber}`, forever, async () => {
    const { underlying, pool } = await getMarket();
    const [scaled, index] = await withLimit(() =>
      client.multicall({
        blockNumber,
        allowFailure: false,
        contracts: [
          { address: config.aToken, abi: aTokenAbi, functionName: 'scaledBalanceOf', args: [holder] },
          { address: pool, abi: poolAbi, functionName: 'getReserveNormalizedIncome', args: [underlying.address] },
        ],
      })
    );
    return { scaled, index };
  });
}

const susdsAbi = parseAbi(['function ssr() view returns (uint256)']);

/**
 * Every input the cost-of-funds calculation needs at one historical block, in
 * a single multicall:
 *
 *   position     = scaledBalance × index / RAY          (holder's rebased balance)
 *   poolIdle     = underlying sitting in the aToken     (unborrowed liquidity)
 *   lendingIdle  = position × poolIdle / totalSupply    (holder's share of it)
 *   deployed     = position − lendingIdle               ( ≡ position × utilization )
 *   ssr          = Sky Savings Rate, per-second in RAY
 *
 * `lendingIdle` mirrors settlement-cycle's `lending_idle_usds` deduction
 * (`_aggregate_lending_idle_usds`): the prime pays the base rate only on the
 * borrowed share of what it supplied. Both balances are rebased, so their
 * ratio equals the scaled ratio — no scaledTotalSupply call needed.
 */
export async function dailyStateAt(holder, blockNumber) {
  return cached(`daily:${holder}:${blockNumber}`, forever, async () => {
    const { underlying, pool } = await getMarket();
    const [scaled, index, totalSupply, poolIdle, ssr] = await withLimit(() =>
      client.multicall({
        blockNumber,
        allowFailure: false,
        contracts: [
          { address: config.aToken, abi: aTokenAbi, functionName: 'scaledBalanceOf', args: [holder] },
          { address: pool, abi: poolAbi, functionName: 'getReserveNormalizedIncome', args: [underlying.address] },
          { address: config.aToken, abi: erc20Abi, functionName: 'totalSupply' },
          { address: underlying.address, abi: erc20Abi, functionName: 'balanceOf', args: [config.aToken] },
          { address: config.susds, abi: susdsAbi, functionName: 'ssr' },
        ],
      })
    );

    const position = (scaled * index) / RAY;
    return {
      scaled,
      index,
      totalSupply,
      poolIdle,
      ssr,
      position,
      lendingIdle: lendingIdleFrom(position, poolIdle, totalSupply),
      deployed: deployedFrom(position, poolIdle, totalSupply),
    };
  });
}

export async function getBlock(blockNumber) {
  const key = `block:${blockNumber ?? 'latest'}`;
  return cached(key, blockNumber == null ? config.liveCacheTtl : forever, async () => {
    const b = await withLimit(() =>
      client.getBlock(blockNumber == null ? { blockTag: 'latest' } : { blockNumber })
    );
    return { number: b.number, timestamp: Number(b.timestamp) };
  });
}

/**
 * Highest block whose timestamp is <= ts, found by interpolation search.
 * Converges in a handful of calls and every probe is cached, so building a long
 * history series stays cheap.
 */
export async function blockAtTimestamp(ts) {
  return cached(`blockAt:${ts}`, forever, async () => {
    const latest = await getBlock();
    if (ts >= latest.timestamp) return latest.number;

    // The Merge block — nothing this service cares about predates it.
    let lo = { number: 15537394n, timestamp: 1663224162 };
    if (ts <= lo.timestamp) return lo.number;
    let hi = latest;

    for (let i = 0; i < 32 && hi.number - lo.number > 1n; i++) {
      const span = Number(hi.number - lo.number);
      const frac = (ts - lo.timestamp) / (hi.timestamp - lo.timestamp);
      const step = Math.min(span - 1, Math.max(1, Math.round(frac * span)));
      const probe = await getBlock(lo.number + BigInt(step));
      if (probe.timestamp <= ts) lo = probe;
      else hi = probe;
    }
    return lo.number;
  });
}
