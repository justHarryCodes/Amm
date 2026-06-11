// CoinGecko free-API price fetcher with 60-second in-process cache.
// Used for accurate USD liquidity values and market price cross-reference.

const CG_BASE = 'https://api.coingecko.com/api/v3';
const PLATFORMS: Record<string, string> = {
  bsc:      'binance-smart-chain',
  ethereum: 'ethereum',
};

export interface CgPrice {
  usd:            number;
  usd_24h_change: number | null;
  usd_24h_vol:    number | null;
  usd_market_cap: number | null;
}

export type CgMap = Record<string, CgPrice | null>;

// In-process cache — cheap to rebuild on restart
const _cache = new Map<string, { data: CgMap; at: number }>();
const TTL_MS = 60_000;

export async function fetchCgPrices(
  chain: 'bsc' | 'ethereum',
  addresses: string[],
): Promise<CgMap> {
  if (!addresses.length) return {};

  const normed = addresses.map(a => a.toLowerCase());
  const key = `${chain}:${[...normed].sort().join(',')}`;
  const now = Date.now();

  const hit = _cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  const out: CgMap = {};
  for (const a of normed) out[a] = null;

  const platform = PLATFORMS[chain];
  if (!platform) return out;

  try {
    const params = new URLSearchParams({
      contract_addresses:    normed.join(','),
      vs_currencies:         'usd',
      include_24hr_change:   'true',
      include_24hr_vol:      'true',
      include_market_cap:    'true',
    });
    const res = await fetch(`${CG_BASE}/simple/token_price/${platform}?${params}`, {
      signal:  AbortSignal.timeout(6_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as Record<string, {
      usd?: number; usd_24h_change?: number; usd_24h_vol?: number; usd_market_cap?: number;
    }>;

    for (const [addr, d] of Object.entries(json)) {
      if (d?.usd != null) {
        out[addr.toLowerCase()] = {
          usd:            d.usd,
          usd_24h_change: d.usd_24h_change ?? null,
          usd_24h_vol:    d.usd_24h_vol    ?? null,
          usd_market_cap: d.usd_market_cap ?? null,
        };
      }
    }
  } catch {
    // Rate-limited, network error, or token not listed — null entries stay in out
  }

  _cache.set(key, { data: out, at: now });
  return out;
}
