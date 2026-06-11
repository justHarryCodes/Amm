import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { query } from '@/lib/db/client';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { priceMonitor } from '@/lib/services/priceMonitor';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { settings } = pegMaintainer;
    const { chain, tokenAddress, stableAddress, pairAddress, cooldownSeconds, maxDailySpendUsd } = settings;
    const { targetPeg, upperBand, lowerBand } = settings;

    // ── 1. On-chain snapshot ──────────────────────────────────────────────────
    // Bot RUNNING → live in-memory snapshot (refreshed every 15 s by the monitor)
    // Bot STOPPED → fresh on-chain read every request — never show a stale price
    const botRunning = pegMaintainer.state !== 'STOPPED';
    let snap = botRunning ? priceMonitor.getLastSnapshot() : null;
    if (!snap && pairAddress && tokenAddress && stableAddress && chain !== 'solana') {
      try { snap = await priceMonitor.getOnChainPrice({ chain, tokenAddress, stableAddress, pairAddress }); }
      catch { /* pair may not exist */ }
    }

    // ── 2. All DB analytics + wallet balances in parallel ──────────────────────
    const ERC20 = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
    ];

    const [
      priceStats, tradeStats, trendRows, priceSeries, recentTradeRows, hourlyRows,
      walletResult,
    ] = await Promise.all([
      // 24h price statistics
      query<{ min_p: string; max_p: string; avg_p: string; stddev_p: string | null; in_range: string; readings: string }>(`
        SELECT
          MIN(price)::text                                                        AS min_p,
          MAX(price)::text                                                        AS max_p,
          AVG(price)::text                                                        AS avg_p,
          STDDEV(price)::text                                                     AS stddev_p,
          (COUNT(*) FILTER (WHERE ABS(price - $1) / NULLIF($1,0) <= $2)
           * 100.0 / NULLIF(COUNT(*),0))::text                                   AS in_range,
          COUNT(*)::text                                                          AS readings
        FROM price_history
        WHERE timestamp > NOW() - INTERVAL '24 hours'
      `, [targetPeg, upperBand]),

      // 7-day trade statistics
      query<{
        total: string; ok: string; buys: string; sells: string;
        bought_usd: string; sold_tok: string; avg_impact: string | null;
      }>(`
        SELECT
          COUNT(*)::text                                                          AS total,
          COUNT(*) FILTER (WHERE status='SUCCESS')::text                         AS ok,
          COUNT(*) FILTER (WHERE action='BUY')::text                             AS buys,
          COUNT(*) FILTER (WHERE action='SELL')::text                            AS sells,
          COALESCE(SUM(CASE WHEN action='BUY'  THEN stable_amount END),0)::text  AS bought_usd,
          COALESCE(SUM(CASE WHEN action='SELL' THEN token_amount  END),0)::text  AS sold_tok,
          AVG(CASE WHEN price_after IS NOT NULL AND price_before>0
              THEN ABS(price_after-price_before)/price_before*100 END)::text     AS avg_impact
        FROM peg_trades WHERE timestamp > NOW() - INTERVAL '7 days'
      `),

      // Trend: last 2h avg vs previous 2h avg
      query<{ recent: string | null; prev: string | null }>(`
        SELECT
          AVG(CASE WHEN timestamp > NOW() - INTERVAL '2 hours' THEN price END)::text             AS recent,
          AVG(CASE WHEN timestamp BETWEEN NOW()-INTERVAL '4 hours'
                                      AND NOW()-INTERVAL '2 hours' THEN price END)::text          AS prev
        FROM price_history WHERE timestamp > NOW() - INTERVAL '4 hours'
      `),

      // 24h price series for chart (≤200 points)
      query<{ timestamp: string; price: string; liquidity_usd: string | null }>(`
        SELECT timestamp, price::text, liquidity_usd::text
        FROM price_history
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp ASC LIMIT 200
      `),

      // 24h recent trades for feed + chart markers
      query<{
        id: string; timestamp: string; action: string;
        token_amount: string; stable_amount: string;
        price_before: string; price_after: string | null;
        tx_hash: string | null; status: string; error_message: string | null;
      }>(`
        SELECT id, timestamp, action, token_amount::text, stable_amount::text,
               price_before::text, price_after::text, tx_hash, status, error_message
        FROM peg_trades WHERE timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp DESC LIMIT 20
      `),

      // Hourly buy/sell counts for activity bar chart
      query<{ hour: string; buys: string; sells: string }>(`
        SELECT date_trunc('hour', timestamp) AS hour,
               COUNT(*) FILTER (WHERE action='BUY')::text  AS buys,
               COUNT(*) FILTER (WHERE action='SELL')::text AS sells
        FROM peg_trades
        WHERE timestamp > NOW() - INTERVAL '24 hours' AND status='SUCCESS'
        GROUP BY 1 ORDER BY 1
      `),

      // Bot wallet balances (EVM only)
      (async () => {
        if ((chain !== 'bsc' && chain !== 'ethereum') || !tokenAddress || !stableAddress) {
          return { token: null, stable: null, native: null, tokenSym: '', stableSym: '' };
        }
        try {
          const provider = getChainProvider(chain);
          const signer   = getChainSigner(chain);
          const [tokBal, stbBal, natBal, tokDec, stbDec, tokSym, stbSym] = await Promise.all([
            new ethers.Contract(tokenAddress,  ERC20, provider).balanceOf(signer.address).catch(() => 0n),
            new ethers.Contract(stableAddress, ERC20, provider).balanceOf(signer.address).catch(() => 0n),
            provider.getBalance(signer.address).catch(() => 0n),
            new ethers.Contract(tokenAddress,  ERC20, provider).decimals().catch(() => 18n),
            new ethers.Contract(stableAddress, ERC20, provider).decimals().catch(() => 18n),
            snap?.tokenSymbol  || new ethers.Contract(tokenAddress,  ERC20, provider).symbol().catch(() => ''),
            snap?.stableSymbol || new ethers.Contract(stableAddress, ERC20, provider).symbol().catch(() => ''),
          ]);
          return {
            token:     parseFloat(ethers.formatUnits(tokBal as bigint, Number(tokDec))),
            stable:    parseFloat(ethers.formatUnits(stbBal as bigint, Number(stbDec))),
            native:    parseFloat(ethers.formatEther(natBal as bigint)),
            tokenSym:  tokSym as string,
            stableSym: stbSym as string,
          };
        } catch { return { token: null, stable: null, native: null, tokenSym: '', stableSym: '' }; }
      })(),
    ]);

    // ── 3. Derive analytics ────────────────────────────────────────────────────

    const ps  = priceStats[0];
    const ts  = tradeStats[0];
    const tr  = trendRows[0];
    const wal = walletResult;

    const tokenSymbol  = snap?.tokenSymbol  || wal.tokenSym  || '';
    const stableSymbol = snap?.stableSymbol || wal.stableSym || '';

    // Price stats
    const minP     = parseFloat(ps?.min_p    ?? '0') || 0;
    const maxP     = parseFloat(ps?.max_p    ?? '0') || 0;
    const avgP     = parseFloat(ps?.avg_p    ?? '0') || 0;
    const stddevP  = parseFloat(ps?.stddev_p ?? '0') || 0;
    const inRange  = parseFloat(ps?.in_range ?? '100') || 100;
    const readings = parseInt(ps?.readings  ?? '0');

    // Trade stats
    const totalTrades = parseInt(ts?.total ?? '0');
    const successCount = parseInt(ts?.ok   ?? '0');
    const buyCount     = parseInt(ts?.buys  ?? '0');
    const sellCount    = parseInt(ts?.sells ?? '0');
    const boughtUsd    = parseFloat(ts?.bought_usd ?? '0') || 0;
    const soldTok      = parseFloat(ts?.sold_tok   ?? '0') || 0;
    const avgImpact    = ts?.avg_impact ? parseFloat(ts.avg_impact) : null;
    const successRate  = totalTrades > 0 ? (successCount / totalTrades) * 100 : 100;

    // Trend direction
    const recentAvg = parseFloat(tr?.recent ?? '0') || 0;
    const prevAvg   = parseFloat(tr?.prev   ?? '0') || 0;
    let trend: 'RISING' | 'FALLING' | 'STABLE' = 'STABLE';
    if (recentAvg > 0 && prevAvg > 0) {
      const trendPct = ((recentAvg - prevAvg) / prevAvg) * 100;
      if (trendPct > 0.01) trend = 'RISING';
      else if (trendPct < -0.01) trend = 'FALLING';
    }

    // Volatility relative to band width
    const bandWidth   = targetPeg * upperBand;
    const volRelative = bandWidth > 0 ? stddevP / bandWidth : 0;
    const volatilityLabel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' =
      volRelative > 0.8 ? 'EXTREME' : volRelative > 0.4 ? 'HIGH' : volRelative > 0.15 ? 'MEDIUM' : 'LOW';

    // Health score (0-100)
    const currentDev = snap?.price != null
      ? Math.abs(snap.price - targetPeg) / Math.max(targetPeg, 1e-9)
      : 0;
    const devScore     = readings > 0 ? Math.max(0, 20 - (currentDev / Math.max(upperBand, 1e-9)) * 20) : 0;
    const volScore     = readings > 0 ? Math.max(0, 25 * (1 - Math.min(volRelative, 1))) : 0;
    const rangeScore   = readings > 0 ? inRange * 0.40 : 0;
    const tradeScore   = successRate * 0.15;
    const healthScore  = readings > 0
      ? Math.round(Math.min(100, rangeScore + volScore + devScore + tradeScore))
      : null;

    // Pool depth: $ needed to move price ±1% on a Uniswap V2 pool
    // delta_stable = stableReserve * (sqrt(1.01) - 1) / 0.9975 ≈ stableR * 0.01003
    const poolDepth1pct = snap?.stableReserve != null
      ? Math.round(snap.stableReserve * (Math.sqrt(1.01) - 1) / 0.9975)
      : null;

    // Budget burn rate (7d average → $ per day)
    const burnRatePerDay = boughtUsd / 7;

    // Estimated hours of buying capacity left today
    const remainingBudget = maxDailySpendUsd - pegMaintainer.dailySpendUsd;
    const hoursLeft = burnRatePerDay > 0 ? (remainingBudget / (burnRatePerDay / 24)) : null;

    // Cooldown
    const cooldownRemaining = pegMaintainer.lastTradeAt
      ? Math.max(0, cooldownSeconds - (Date.now() - pegMaintainer.lastTradeAt.getTime()) / 1000)
      : 0;

    // ── 4. Build response ──────────────────────────────────────────────────────
    return NextResponse.json({
      // State
      state: pegMaintainer.state,
      chain,
      currentPrice:  snap?.price       ?? null,
      targetPeg,
      upperBound:    targetPeg * (1 + upperBand),
      lowerBound:    targetPeg * (1 - lowerBand),
      tokenSymbol, stableSymbol,
      blockNumber:   snap?.blockNumber  ?? null,
      lastUpdated:   snap?.timestamp    ?? null,
      pairAddress,

      // CoinGecko market data
      marketPriceUsd: snap?.marketPriceUsd ?? null,
      cgChange24h:    snap?.cgChange24h    ?? null,
      cgVolume24h:    snap?.cgVolume24h    ?? null,
      cgMarketCap:    snap?.cgMarketCap    ?? null,

      // Pool
      tokenReserve:  snap?.tokenReserve  ?? null,
      stableReserve: snap?.stableReserve ?? null,
      liquidityUsd:  snap?.liquidityUsd  ?? null,
      poolDepth1pct,

      // Wallet
      botTokenBalance:  wal.token,
      botStableBalance: wal.stable,
      botNativeBalance: wal.native,
      nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',
      dailySpendUsd:    pegMaintainer.dailySpendUsd,
      maxDailySpendUsd,
      cooldownRemaining,
      burnRatePerDay,
      hoursLeft,

      // Analytics
      healthScore,
      trend,
      volatilityLabel,
      volatilityValue: stddevP,
      timeInRangePct:  inRange,

      priceStats24h: readings > 0 ? {
        min: minP, max: maxP, avg: avgP,
        range: maxP - minP, stddev: stddevP, readings,
      } : null,

      tradeStats7d: {
        totalTrades, successCount, successRate,
        buyCount, sellCount,
        totalBoughtUsd: boughtUsd, totalSoldTokens: soldTok,
        avgImpactPct: avgImpact,
        netDirection: buyCount > sellCount ? 'BUYING' : sellCount > buyCount ? 'SELLING' : 'BALANCED',
      },

      // Chart series
      priceSeries: priceSeries.map(r => ({
        timestamp:    r.timestamp,
        price:        parseFloat(r.price),
        liquidityUsd: r.liquidity_usd ? parseFloat(r.liquidity_usd) : null,
      })),
      recentTrades: recentTradeRows.map(r => ({
        id:          parseInt(r.id),
        timestamp:   r.timestamp,
        action:      r.action,
        tokenAmount: parseFloat(r.token_amount),
        stableAmount: parseFloat(r.stable_amount),
        priceBefore: parseFloat(r.price_before),
        priceAfter:  r.price_after ? parseFloat(r.price_after) : null,
        txHash:      r.tx_hash,
        status:      r.status,
        errorMessage: r.error_message,
      })),
      hourlyActivity: hourlyRows.map(r => ({
        hour:  r.hour,
        buys:  parseInt(r.buys),
        sells: parseInt(r.sells),
      })),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
