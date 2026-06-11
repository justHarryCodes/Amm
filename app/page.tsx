'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Activity, Droplets, RefreshCw,
  ArrowRight, CheckCircle, AlertCircle, Zap, ShieldCheck,
  Clock, ArrowUpRight, ArrowDownRight, Minus,
} from 'lucide-react';
import { getDashboard } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid,
} from 'recharts';
import Link from 'next/link';
import clsx from 'clsx';

// ── Types ─────────────────────────────────────────────────────────────────────
interface DashboardData {
  state: string; chain: string;
  currentPrice: number | null; targetPeg: number;
  upperBound: number; lowerBound: number;
  tokenSymbol: string; stableSymbol: string;
  blockNumber: number | null; lastUpdated: string | null;
  pairAddress: string | null;
  tokenReserve: number | null; stableReserve: number | null;
  liquidityUsd: number | null; poolDepth1pct: number | null;
  botTokenBalance: number | null; botStableBalance: number | null;
  botNativeBalance: number | null; nativeSymbol: string;
  dailySpendUsd: number; maxDailySpendUsd: number;
  cooldownRemaining: number; burnRatePerDay: number; hoursLeft: number | null;
  healthScore: number | null;
  trend: 'RISING' | 'FALLING' | 'STABLE';
  volatilityLabel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  volatilityValue: number;
  timeInRangePct: number;
  // CoinGecko market data
  marketPriceUsd: number | null;
  cgChange24h:    number | null;
  cgVolume24h:    number | null;
  cgMarketCap:    number | null;
  priceStats24h: { min: number; max: number; avg: number; range: number; stddev: number; readings: number } | null;
  tradeStats7d: {
    totalTrades: number; successCount: number; successRate: number;
    buyCount: number; sellCount: number;
    totalBoughtUsd: number; totalSoldTokens: number;
    avgImpactPct: number | null; netDirection: string;
  };
  priceSeries:    Array<{ timestamp: string; price: number; liquidityUsd: number | null }>;
  recentTrades:   Array<{
    id: number; timestamp: string; action: string;
    tokenAmount: number; stableAmount: number;
    priceBefore: number; priceAfter: number | null;
    txHash: string | null; status: string; errorMessage: string | null;
  }>;
  hourlyActivity: Array<{ hour: string; buys: number; sells: number }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STATE_DOT: Record<string, string> = {
  STOPPED: 'bg-zinc-500', MONITOR_ONLY: 'bg-amber-400 animate-pulse',
  AUTO_TRADE: 'bg-brand-400 animate-pulse', PAUSED: 'bg-red-400',
};
const HEALTH_COLOR = (s: number | null) =>
  s == null ? 'text-zinc-600'
  : s >= 80 ? 'text-brand-400'
  : s >= 60 ? 'text-yellow-400'
  : s >= 40 ? 'text-orange-400'
  : 'text-red-400';
const HEALTH_LABEL = (s: number | null) =>
  s == null ? 'No data' : s >= 80 ? 'Excellent' : s >= 60 ? 'Good' : s >= 40 ? 'Fair' : 'Poor';
const HEALTH_BG = (s: number | null) =>
  s == null ? 'bg-zinc-700'
  : s >= 80 ? 'bg-brand-500'
  : s >= 60 ? 'bg-yellow-500'
  : s >= 40 ? 'bg-orange-500'
  : 'bg-red-500';

const CHAIN_LABELS: Record<string, string> = { bsc: 'BSC', ethereum: 'ETH', solana: 'SOL' };
const DEX_LABELS:   Record<string, string> = { bsc: 'PancakeSwap', ethereum: 'Uniswap', solana: 'Raydium' };

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtUsd(n: number, decimals = 2) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtNum(n: number | null, dec = 2) {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: dec });
}
function timeAgo(ts: string) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function fmtDuration(sec: number) {
  if (sec <= 0) return 'ready';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}

// ── Insight generation ────────────────────────────────────────────────────────
function buildInsights(d: DashboardData) {
  const items: { icon: React.ReactNode; text: string; color: string }[] = [];

  // Peg stability
  if (d.priceStats24h && d.priceStats24h.readings > 5) {
    const t = d.timeInRangePct;
    const c = t >= 90 ? 'text-brand-400' : t >= 70 ? 'text-amber-400' : 'text-red-400';
    items.push({ icon: <CheckCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: c,
      text: t >= 90
        ? `Price held within the ±${(d.targetPeg * (d.upperBound / d.targetPeg - 1) * 100).toFixed(1)}% band ${t.toFixed(1)}% of the last 24h — excellent stability`
        : `Price was in range only ${t.toFixed(1)}% of last 24h — ${(100 - t).toFixed(1)}% of readings needed intervention`,
    });
  }

  // Volatility
  if (d.priceStats24h) {
    const r = d.priceStats24h.range;
    const rPct = d.targetPeg > 0 ? r / d.targetPeg * 100 : 0;
    const c = d.volatilityLabel === 'LOW' ? 'text-zinc-400' : d.volatilityLabel === 'MEDIUM' ? 'text-amber-400' : 'text-red-400';
    items.push({ icon: <Activity className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: c,
      text: `${d.volatilityLabel} volatility — 24h price swung ${fmtUsd(d.priceStats24h.min, 6)} → ${fmtUsd(d.priceStats24h.max, 6)} (${rPct.toFixed(3)}% range)`,
    });
  }

  // Pool depth
  if (d.poolDepth1pct != null) {
    const depth = d.poolDepth1pct;
    const label = depth > 10_000 ? 'Deep' : depth > 2_000 ? 'Moderate' : 'Shallow';
    const c = depth > 10_000 ? 'text-zinc-400' : depth > 2_000 ? 'text-amber-400' : 'text-red-400';
    items.push({ icon: <Droplets className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: c,
      text: `${label} pool — a ${fmtUsd(depth, 0)} trade moves price ±1%${depth < 2_000 ? ' — consider adding more liquidity' : ''}`,
    });
  }

  // Bot trading activity
  const ts = d.tradeStats7d;
  if (ts.totalTrades > 0) {
    const dirText =
      ts.netDirection === 'BUYING'   ? `buying more (${ts.buyCount}B / ${ts.sellCount}S) — price has been below peg` :
      ts.netDirection === 'SELLING'  ? `selling more (${ts.buyCount}B / ${ts.sellCount}S) — price has been above peg` :
      `balanced (${ts.buyCount}B / ${ts.sellCount}S)`;
    const c = ts.successRate >= 95 ? 'text-brand-400' : ts.successRate >= 80 ? 'text-amber-400' : 'text-red-400';
    items.push({ icon: <Zap className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: c,
      text: `${ts.totalTrades} intervention${ts.totalTrades !== 1 ? 's' : ''} in 7d with ${ts.successRate.toFixed(0)}% success — ${dirText}`,
    });
    if (ts.avgImpactPct != null) {
      items.push({ icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: 'text-zinc-400',
        text: `Average trade impact: ${ts.avgImpactPct.toFixed(4)}% price shift — ${ts.avgImpactPct < 0.1 ? 'bot trades efficiently with minimal slippage' : 'trades are moving price significantly'}`,
      });
    }
  } else {
    items.push({ icon: <Zap className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: 'text-zinc-600',
      text: 'No trades recorded yet — start the bot in AUTO_TRADE mode to begin peg maintenance',
    });
  }

  // Trend
  if (d.trend !== 'STABLE') {
    const isUp = d.trend === 'RISING';
    items.push({ icon: isUp ? <TrendingUp className="h-3.5 w-3.5 shrink-0 mt-0.5" /> : <TrendingDown className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: 'text-amber-400',
      text: `Price trending ${isUp ? 'above' : 'below'} peg over the last 2h — ${d.state === 'AUTO_TRADE' ? 'bot is actively correcting' : 'switch to AUTO_TRADE to auto-correct'}`,
    });
  }

  // Budget warning
  if (d.hoursLeft != null && d.hoursLeft < 8 && d.burnRatePerDay > 0) {
    items.push({ icon: <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: 'text-red-400',
      text: `Daily buying budget runs out in ~${d.hoursLeft.toFixed(0)}h at current rate ($${d.burnRatePerDay.toFixed(2)}/day)`,
    });
  }

  // Low gas
  if (d.botNativeBalance != null && d.botNativeBalance < 0.01) {
    items.push({ icon: <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />, color: 'text-red-400',
      text: `Low ${d.nativeSymbol} balance (${d.botNativeBalance.toFixed(4)}) — bot may not have enough gas to execute trades`,
    });
  }

  return items;
}

// ── Custom chart dot (renders trade markers) ──────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TradeDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload?.tradeAction) return null;
  const fill = payload.tradeAction === 'BUY' ? '#10b981' : '#ef4444';
  return <circle cx={cx} cy={cy} r={5} fill={fill} stroke="#09090b" strokeWidth={2} />;
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data,    setData]    = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const { on } = useSSE();

  const refresh = useCallback(async () => {
    try { setData(await getDashboard()); }
    catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 30_000); return () => clearInterval(iv); }, [refresh]);

  useEffect(() => {
    const o1 = on('PRICE_UPDATE', (d: unknown) => {
      const s = d as {
        price: number; liquidityUsd: number; tokenReserve: number; stableReserve: number;
        marketPriceUsd: number | null; cgChange24h: number | null;
        cgVolume24h: number | null; cgMarketCap: number | null;
      };
      setData(p => p ? {
        ...p,
        currentPrice:   s.price,
        liquidityUsd:   s.liquidityUsd,
        tokenReserve:   s.tokenReserve,
        stableReserve:  s.stableReserve,
        marketPriceUsd: s.marketPriceUsd,
        cgChange24h:    s.cgChange24h,
        cgVolume24h:    s.cgVolume24h,
        cgMarketCap:    s.cgMarketCap,
      } : p);
    });
    const o2 = on('BOT_STATE', (d: unknown) => {
      setData(p => p ? { ...p, state: (d as { state: string }).state } : p);
    });
    const o3 = on('TRADE', () => refresh());
    return () => { o1(); o2(); o3(); };
  }, [on, refresh]);

  // Merge trade markers into price series
  const chartData = useMemo(() => {
    if (!data) return [];
    const bucketMs = 15 * 60 * 1000;
    const tradeMap = new Map<number, string>();
    data.recentTrades.filter(t => t.status === 'SUCCESS').forEach(t => {
      const b = Math.round(new Date(t.timestamp).getTime() / bucketMs);
      tradeMap.set(b, t.action);
    });
    return data.priceSeries.map(p => ({
      ...p,
      tradeAction: tradeMap.get(Math.round(new Date(p.timestamp).getTime() / bucketMs)) ?? null,
    }));
  }, [data]);

  const dev = data?.currentPrice != null && data.targetPeg > 0
    ? ((data.currentPrice - data.targetPeg) / data.targetPeg) * 100 : null;
  const inRange = dev != null && Math.abs(dev) <= ((data!.upperBound - data!.targetPeg) / data!.targetPeg * 100);

  const tokSym = data?.tokenSymbol  || 'Token';
  const stbSym = data?.stableSymbol || 'Stable';
  const dailyPct = data && data.maxDailySpendUsd > 0
    ? Math.min(100, (data.dailySpendUsd / data.maxDailySpendUsd) * 100) : 0;

  const insights = data ? buildInsights(data) : [];

  if (loading) {
    return (
      <div className="page-wide space-y-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-32 bg-zinc-800 rounded-2xl animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="page-wide space-y-4">

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          {/* Price + state */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className={clsx('h-2 w-2 rounded-full shrink-0', STATE_DOT[data?.state ?? 'STOPPED'])} />
              <span className="text-xs font-medium text-zinc-400">{data?.state?.replace(/_/g, ' ') ?? 'STOPPED'}</span>
              {data && (
                <span className="text-xs text-zinc-600">
                  {CHAIN_LABELS[data.chain] ?? data.chain} · {DEX_LABELS[data.chain] ?? data.chain}
                </span>
              )}
              {data?.blockNumber && (
                <span className="text-xs text-zinc-700 font-mono ml-auto">#{data.blockNumber.toLocaleString()}</span>
              )}
            </div>

            {/* DEX price (primary — what the bot actually trades at) */}
            <p className="text-xs text-zinc-600 mb-0.5">DEX Price</p>
            <p className="text-4xl font-bold font-mono tracking-tight text-zinc-50">
              {data?.currentPrice != null ? `$${data.currentPrice.toFixed(6)}` : '—'}
            </p>
            {dev != null && (
              <p className={clsx('text-sm mt-1.5 font-medium flex items-center gap-1', inRange ? 'text-brand-400' : 'text-amber-400')}>
                {dev >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                {Math.abs(dev).toFixed(4)}% {dev >= 0 ? 'above' : 'below'} peg
                {data?.lastUpdated && <span className="text-zinc-600 font-normal ml-2">{timeAgo(data.lastUpdated)}</span>}
              </p>
            )}
            {dev == null && data?.targetPeg && (
              <p className="text-sm text-zinc-600 mt-1">
                Target ${data.targetPeg.toFixed(6)} · configure pair address to see live price
              </p>
            )}

            {/* CoinGecko market price row */}
            {data?.marketPriceUsd != null && (
              <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-zinc-800/60">
                <div>
                  <p className="text-xs text-zinc-600">Market Price</p>
                  <p className="text-sm font-mono font-semibold text-zinc-300">
                    ${data.marketPriceUsd.toFixed(6)}
                  </p>
                </div>
                {data.cgChange24h != null && (
                  <div>
                    <p className="text-xs text-zinc-600">24h</p>
                    <p className={clsx('text-sm font-mono font-semibold',
                      data.cgChange24h >= 0 ? 'text-brand-400' : 'text-red-400')}>
                      {data.cgChange24h >= 0 ? '+' : ''}{data.cgChange24h.toFixed(2)}%
                    </p>
                  </div>
                )}
                {data.currentPrice != null && data.marketPriceUsd > 0 && (
                  <div>
                    <p className="text-xs text-zinc-600">DEX spread</p>
                    <p className={clsx('text-sm font-mono font-semibold',
                      Math.abs(data.currentPrice - data.marketPriceUsd) / data.marketPriceUsd > 0.005
                        ? 'text-amber-400' : 'text-zinc-400')}>
                      {(((data.currentPrice - data.marketPriceUsd) / data.marketPriceUsd) * 100).toFixed(3)}%
                    </p>
                  </div>
                )}
                {data.cgMarketCap != null && (
                  <div className="ml-auto">
                    <p className="text-xs text-zinc-600">Mkt Cap</p>
                    <p className="text-sm font-mono text-zinc-400">
                      {data.cgMarketCap >= 1_000_000
                        ? `$${(data.cgMarketCap / 1_000_000).toFixed(1)}M`
                        : `$${(data.cgMarketCap / 1_000).toFixed(0)}k`}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Health score */}
          <div className="text-center shrink-0">
            <p className="text-xs text-zinc-600 mb-1">Peg Health</p>
            <p className={clsx('text-3xl font-bold font-mono leading-none', HEALTH_COLOR(data?.healthScore ?? null))}>
              {data?.healthScore != null ? data.healthScore : '—'}
            </p>
            <p className={clsx('text-xs font-medium mt-0.5', HEALTH_COLOR(data?.healthScore ?? null))}>
              {HEALTH_LABEL(data?.healthScore ?? null)}
            </p>
            {data?.healthScore != null && (
              <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-2">
                <div className={clsx('h-full rounded-full', HEALTH_BG(data.healthScore))}
                  style={{ width: `${data.healthScore}%` }} />
              </div>
            )}
          </div>
        </div>

        {/* Peg band bar */}
        {data?.currentPrice != null && dev != null && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-zinc-700 mb-1.5">
              <span>${data.lowerBound.toFixed(5)}</span>
              <span className="text-zinc-500">${data.targetPeg.toFixed(5)} target</span>
              <span>${data.upperBound.toFixed(5)}</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full relative overflow-hidden">
              <div className="absolute inset-y-0 left-[20%] right-[20%] bg-brand-500/15 rounded-full" />
              <div
                className={clsx('absolute top-0 bottom-0 w-2.5 rounded-full transition-all duration-700',
                  inRange ? 'bg-brand-400' : 'bg-amber-400')}
                style={{ left: `${Math.max(2, Math.min(94, ((data.currentPrice - data.lowerBound) / Math.max(data.upperBound - data.lowerBound, 1e-9)) * 100))}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── STAT TILES ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Time In Range',
            value: data?.priceStats24h ? `${data.timeInRangePct.toFixed(1)}%` : '—',
            sub:   data?.priceStats24h ? `${data.priceStats24h.readings} readings` : 'no data',
            icon: <CheckCircle className="h-3.5 w-3.5 text-brand-400" />,
            color: (data?.timeInRangePct ?? 100) >= 90 ? 'text-brand-400' : 'text-amber-400',
          },
          {
            label: '24h Trades',
            value: String(data?.recentTrades?.length ?? '—'),
            sub:   data?.tradeStats7d ? `${data.tradeStats7d.successRate.toFixed(0)}% success (7d)` : '',
            icon: <Activity className="h-3.5 w-3.5 text-purple-400" />,
            color: 'text-zinc-200',
          },
          {
            label: 'Volatility',
            value: data?.volatilityLabel ?? '—',
            sub:   data?.priceStats24h ? `±${(data.volatilityValue / Math.max(data.targetPeg, 1e-9) * 100).toFixed(4)}%` : '',
            icon: <Activity className="h-3.5 w-3.5 text-blue-400" />,
            color: data?.volatilityLabel === 'LOW' ? 'text-brand-400'
              : data?.volatilityLabel === 'MEDIUM' ? 'text-amber-400' : 'text-red-400',
          },
          {
            label: 'Liquidity',
            value: data?.liquidityUsd ? (data.liquidityUsd >= 1_000_000
              ? `$${(data.liquidityUsd / 1_000_000).toFixed(2)}M`
              : data.liquidityUsd >= 1_000
                ? `$${(data.liquidityUsd / 1_000).toFixed(1)}k`
                : fmtUsd(data.liquidityUsd, 0)) : '—',
            sub:   data?.poolDepth1pct ? `1% depth: ${fmtUsd(data.poolDepth1pct, 0)}` : '',
            icon: <Droplets className="h-3.5 w-3.5 text-sky-400" />,
            color: 'text-zinc-200',
          },
        ].map(({ label, value, sub, icon, color }) => (
          <div key={label} className="stat-tile">
            <div className="flex items-center gap-1.5 stat-label mb-1">{icon}{label}</div>
            <p className={clsx('stat-value', color)}>{value}</p>
            {sub && <p className="text-xs text-zinc-600 mt-0.5">{sub}</p>}
          </div>
        ))}
      </div>

      {/* ── PRICE CHART ────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-zinc-100">Price (24h)</h2>
            {data?.priceStats24h && (
              <p className="text-xs text-zinc-600 mt-0.5">
                Low {fmtUsd(data.priceStats24h.min, 6)} &nbsp;·&nbsp; High {fmtUsd(data.priceStats24h.max, 6)}
                &nbsp;·&nbsp; Avg {fmtUsd(data.priceStats24h.avg, 6)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-600">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-400 inline-block" />Buy</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" />Sell</span>
          </div>
        </div>

        {chartData.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center gap-2 text-zinc-600 text-sm">
            <Activity className="h-8 w-8 opacity-20" />
            Start the bot to begin tracking price history
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="timestamp"
                tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                tick={{ fill: '#52525b', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis domain={['auto', 'auto']}
                tick={{ fill: '#52525b', fontSize: 10 }}
                tickFormatter={v => `$${(v as number).toFixed(4)}`}
                width={68} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, fontSize: 12 }}
                formatter={(v: number) => [`$${v.toFixed(6)}`, 'Price']}
                labelFormatter={l => new Date(l).toLocaleString()} />
              {data && <ReferenceLine y={data.targetPeg}  stroke="#10b981" strokeDasharray="5 5" strokeOpacity={0.6} />}
              {data && <ReferenceLine y={data.upperBound} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.3} />}
              {data && <ReferenceLine y={data.lowerBound} stroke="#3b82f6" strokeDasharray="3 3" strokeOpacity={0.3} />}
              <Area type="monotone" dataKey="price"
                stroke="#10b981" fill="url(#priceGrad)"
                strokeWidth={2} dot={<TradeDot />} activeDot={{ r: 4, stroke: '#10b981' }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        <p className="text-xs text-zinc-700 mt-2">
          Green dashes = peg target &nbsp;·&nbsp; Red dashes = upper band &nbsp;·&nbsp; Blue dashes = lower band
          &nbsp;·&nbsp; Dots = bot interventions
        </p>
      </div>

      {/* ── BOT INSIGHTS ───────────────────────────────────────────────────── */}
      {insights.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-zinc-100 mb-3">Bot Intelligence</h2>
          <div className="space-y-2.5">
            {insights.map((ins, i) => (
              <div key={i} className={clsx('flex items-start gap-2.5', ins.color)}>
                {ins.icon}
                <p className="text-xs leading-relaxed text-zinc-300">{ins.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── POOL + WALLET GRID ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Pool */}
        <div className="card">
          <h2 className="font-semibold text-zinc-100 mb-3 flex items-center gap-2">
            <Droplets className="h-4 w-4 text-sky-400" /> Pool Reserves
          </h2>
          <div className="space-y-2.5">
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">{tokSym}</span>
              <span className="text-sm font-mono font-semibold text-zinc-100">
                {fmtNum(data?.tokenReserve ?? null)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">{stbSym}</span>
              <span className="text-sm font-mono font-semibold text-zinc-100">
                {fmtNum(data?.stableReserve ?? null)}
              </span>
            </div>
            <div className="border-t border-zinc-800/60 pt-2.5 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600">Total liquidity</span>
                <span className="text-zinc-300 font-medium">
                  {data?.liquidityUsd != null ? fmtUsd(data.liquidityUsd, 0) : '—'}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600">1% price impact</span>
                <span className="text-zinc-300 font-medium">
                  {data?.poolDepth1pct != null ? fmtUsd(data.poolDepth1pct, 0) : '—'}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600">Trend (2h)</span>
                <span className={clsx('font-medium flex items-center gap-1',
                  data?.trend === 'RISING' ? 'text-amber-400' : data?.trend === 'FALLING' ? 'text-brand-400' : 'text-zinc-500')}>
                  {data?.trend === 'RISING'  ? <><ArrowUpRight   className="h-3 w-3" />Rising</>  :
                   data?.trend === 'FALLING' ? <><ArrowDownRight className="h-3 w-3" />Falling</> :
                   <><Minus className="h-3 w-3" />Stable</>}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Wallet */}
        <div className="card">
          <h2 className="font-semibold text-zinc-100 mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand-400" /> Bot Wallet
          </h2>
          <div className="space-y-2.5">
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">{tokSym} (sell reserve)</span>
              <span className={clsx('text-sm font-mono font-semibold',
                (data?.botTokenBalance ?? 0) > 0 ? 'text-zinc-100' : 'text-amber-400')}>
                {fmtNum(data?.botTokenBalance ?? null)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">{stbSym} (buy reserve)</span>
              <span className={clsx('text-sm font-mono font-semibold',
                (data?.botStableBalance ?? 0) > 0 ? 'text-zinc-100' : 'text-amber-400')}>
                {fmtNum(data?.botStableBalance ?? null)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">{data?.nativeSymbol ?? 'Gas'} (fees)</span>
              <span className={clsx('text-sm font-mono font-semibold',
                (data?.botNativeBalance ?? 0) > 0.002 ? 'text-zinc-100' : 'text-red-400')}>
                {data?.botNativeBalance != null ? data.botNativeBalance.toFixed(4) : '—'}
              </span>
            </div>

            {/* Daily budget */}
            {(data?.maxDailySpendUsd ?? 0) > 0 && (
              <div className="border-t border-zinc-800/60 pt-2.5">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-zinc-600">Daily buy budget</span>
                  <span className="text-zinc-400">
                    {fmtUsd(data?.dailySpendUsd ?? 0)} / {fmtUsd(data?.maxDailySpendUsd ?? 0, 0)}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all', dailyPct > 80 ? 'bg-amber-400' : 'bg-brand-500')}
                    style={{ width: `${dailyPct}%` }} />
                </div>
                {data?.burnRatePerDay != null && data.burnRatePerDay > 0 && (
                  <p className="text-xs text-zinc-600 mt-1.5">
                    ~{fmtUsd(data.burnRatePerDay)}/day burn rate
                    {data.hoursLeft != null ? ` · ${data.hoursLeft.toFixed(0)}h left today` : ''}
                  </p>
                )}
              </div>
            )}

            {/* Cooldown */}
            {(data?.cooldownRemaining ?? 0) > 0 && (
              <p className="text-xs text-amber-400 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> Next trade in {fmtDuration(data!.cooldownRemaining)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── RECENT TRADES ──────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-zinc-100">Recent Trades</h2>
          <Link href="/peg" className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5 transition-colors">
            All trades <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {data?.recentTrades?.length === 0 ? (
          <div className="h-24 flex flex-col items-center justify-center gap-1.5 text-zinc-600 text-sm">
            <Activity className="h-6 w-6 opacity-20" />
            No trades yet
          </div>
        ) : (
          <div className="space-y-2">
            {(data?.recentTrades ?? []).slice(0, 8).map(t => {
              const impact = t.priceAfter != null
                ? ((t.priceAfter - t.priceBefore) / Math.max(t.priceBefore, 1e-9)) * 100 : null;
              const priceMovedTowardPeg =
                t.priceAfter != null && data &&
                Math.abs(t.priceAfter - data.targetPeg) < Math.abs(t.priceBefore - data.targetPeg);
              return (
                <div key={t.id} className="surface flex items-center gap-3">
                  <div className={clsx(
                    'h-8 w-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold',
                    t.action === 'BUY' ? 'bg-brand-500/10 text-brand-400' : 'bg-red-500/10 text-red-400',
                  )}>
                    {t.action === 'BUY' ? 'B' : 'S'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="font-medium text-zinc-200">
                        {t.tokenAmount.toFixed(2)} {tokSym}
                      </span>
                      <span className="text-zinc-600">≈ {fmtUsd(t.stableAmount, 4)}</span>
                      {t.priceAfter != null && (
                        <span className={clsx('flex items-center gap-0.5', priceMovedTowardPeg ? 'text-brand-400' : 'text-amber-400')}>
                          {fmtUsd(t.priceBefore, 6)} → {fmtUsd(t.priceAfter, 6)}
                          {impact != null && (
                            <span className="text-zinc-600 ml-1">
                              ({impact >= 0 ? '+' : ''}{impact.toFixed(4)}%)
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-xs text-zinc-600">{timeAgo(t.timestamp)}</p>
                      {t.errorMessage && <p className="text-xs text-red-400 truncate">{t.errorMessage}</p>}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {t.status === 'SUCCESS'
                      ? <CheckCircle className="h-3.5 w-3.5 text-brand-400" />
                      : <AlertCircle className="h-3.5 w-3.5 text-red-400" />}
                    {t.txHash && (
                      <a href={`https://bscscan.com/tx/${t.txHash}`} target="_blank" rel="noreferrer"
                        className="text-zinc-600 hover:text-zinc-300 text-xs">↗</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Mobile CTA */}
      <Link href="/peg" className="btn-primary w-full sm:hidden">
        Open Peg Bot <ArrowRight className="h-4 w-4" />
      </Link>

      {/* Footer refresh hint */}
      <div className="flex items-center justify-center gap-1.5 text-xs text-zinc-700 pb-2">
        <RefreshCw className="h-3 w-3" />
        Auto-refreshes every 30s · live via SSE
      </div>
    </div>
  );
}
