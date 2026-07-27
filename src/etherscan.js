import { config } from './config.js';

const PAGE_SIZE = 1000;

async function call(params) {
  const url = new URL(config.etherscanBaseUrl);
  url.searchParams.set('chainid', String(config.chainId));
  url.searchParams.set('apikey', config.etherscanApiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);
  const body = await res.json();

  // Etherscan signals "no rows" with status "0" and a NOTOK-ish message; that is
  // a legitimate empty result, not a failure.
  if (body.status === '0') {
    if (/no transactions found/i.test(body.message || '') || Array.isArray(body.result)) return [];
    throw new Error(`Etherscan error: ${body.message} — ${body.result}`);
  }
  return body.result;
}

/**
 * Every aToken transfer touching the holder, oldest first. Used only to discover
 * the blocks at which the position changed — the amounts reported here are not
 * trusted for accounting, because Aave folds accrued interest into the Transfer
 * value on mint/burn. Principal is recomputed from scaled balances instead.
 */
export async function getTokenTransfers() {
  const all = [];
  for (let page = 1; ; page++) {
    const rows = await call({
      module: 'account',
      action: 'tokentx',
      contractaddress: config.aToken,
      address: config.holder,
      page,
      offset: PAGE_SIZE,
      sort: 'asc',
    });
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all.map((t) => ({
    blockNumber: BigInt(t.blockNumber),
    timestamp: Number(t.timeStamp),
    hash: t.hash,
    from: t.from.toLowerCase(),
    to: t.to.toLowerCase(),
    value: BigInt(t.value),
  }));
}
