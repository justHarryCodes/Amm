'use client';
import { useEffect, useState, useCallback } from 'react';
import { TrendingUp, TrendingDown, Activity, Droplets, RefreshCw, ArrowRight } from 'lucide-react';
import { getPegStatus, getBotBalance, getPriceHistory, getTradeHistory } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import Link from 'next/link';
import clsx from 'clsx';

interface PegStatus {
  state: string; currentPrice: number | null; targetPeg: number;
  upperBound: number; lowerBound: number; liquidityUsd: number | null;
  lastUpdated: string | null;
  dailyStats: { totalTrades: number; totalBuyUsd: number; totalSellTokens: number };
}
interface PricePoint { timestamp: string; price: number }
interface Trade { id: number; timestamp: string; action: string; token_amount: number; stable_amount: number; tx_hash: string | null; status: string }

const STATE_DOT: Record<string, string> = {
  STOPPED: 'bg-zinc-500', MONITOR_ONLY: 'bg-amber-400 animate-pulse', AUTO_TRADE: 'bg-brand-400 animate-pulse', PAUSED: 'bg-red-400',
};

export default function Dashboard() {
  const [status, setStatus] = useState<PegStatus | null>(null);
  const [prices,  setPrices]  = useState<PricePoint[]>([]);
  const [trades,  setTrades]  = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const { on } = useSSE();

  const refresh = useCallback(async () => {
    try {
      const [s, , p, t] = await Promise.all([getPegStatus(), getBotBalance(), getPriceHistory(24), getTradeHistory(8)]);
      setStatus(s); setPrices(p); setTrades(t);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 30_000); return () => clearInterval(iv); }, [refresh]);

  useEffect(() => {
    const o1 = on('PRICE_UPDATE', (d: unknown) => {
      const s = d as { price: number; liquidityUsd: number };
      setStatus(p => p ? { ...p, currentPrice: s.price, liquidityUsd: s.liquidityUsd } : p);
    });
    const o2 = on('BOT_STATE', (d: unknown) => setStatus(p => p ? { ...p, state: (d as { state: string }).state } : p));
    const o3 = on('TRADE', () => refresh());
    return () => { o1(); o2(); o3(); };
  }, [on, refresh]);

  const dev = status?.currentPrice != null && status.targetPeg > 0
    ? ((status.currentPrice - status.targetPeg) / status.targetPeg) * 100 : null;
  const inRange = dev != null && Math.abs(dev) <= 2;

  return (
    <div className="page-wide">

      {/* ── Hero ─────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Live Price</p>
            {loading
              ? <div className="h-9 w-36 bg-zinc-800 rounded-xl animate-pulse" />
              : <p className="text-4xl font-bold font-mono tracking-tight text-zinc-50">
                  {status?.currentPrice != null ? `$${status.currentPrice.toFixed(6)}` : '—'}
                </p>}
            {dev != null && (
              <p className={clsx('text-sm mt-1 font-medium', inRange ? 'text-brand-400' : 'text-amber-400')}>
                {dev >= 0 ? '▲' : '▼'} {Math.abs(dev).toFixed(3)}% from peg
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <span className={clsx('h-2 w-2 rounded-full', STATE_DOT[status?.state ?? 'STOPPED'])} />
              <span className="text-sm font-medium text-zinc-300">{status?.state ?? 'STOPPED'}</span>
            </div>
            <button onClick={refresh} className="btn-icon !p-2">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mini peg bar */}
        {status && dev != null && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-zinc-600 mb-1.5">
              <span>${status.lowerBound.toFixed(5)}</span>
              <span className="text-zinc-400">${status.targetPeg.toFixed(5)} target</span>
              <span>${status.upperBound.toFixed(5)}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full relative overflow-hidden">
              <div className="absolute inset-y-0 left-[30%] right-[30%] bg-brand-500/20 rounded-full" />
              <div
                className={clsx('absolute top-0 bottom-0 w-1.5 rounded-full transition-all', inRange ? 'bg-brand-400' : 'bg-amber-400')}
                style={{ left: `${Math.max(2, Math.min(96, ((status.currentPrice! - status.lowerBound) / (status.upperBound - status.lowerBound)) * 100))}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Stats ────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Liquidity', value: status?.liquidityUsd ? `$${(status.liquidityUsd / 1000).toFixed(1)}k` : '—', icon: Droplets, color: 'text-blue-400' },
          { label: '24h Trades', value: String(status?.dailyStats.totalTrades ?? '—'), icon: Activity, color: 'text-purple-400' },
          { label: 'Target', value: status ? `$${status.targetPeg.toFixed(4)}` : '—', icon: TrendingUp, color: 'text-brand-400' },
          { label: 'Bought (24h)', value: status?.dailyStats.totalBuyUsd ? `$${status.dailyStats.totalBuyUsd.toFixed(0)}` : '—', icon: TrendingUp, color: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="stat-tile">
            <div className="flex items-center gap-1 stat-label">
              <Icon className={clsx('h-3 w-3', color)} />{label}
            </div>
            {loading
              ? <div className="h-6 w-16 bg-zinc-700 rounded-lg animate-pulse mt-1" />
              : <p className="stat-value">{value}</p>}
          </div>
        ))}
      </div>

      {/* ── Chart + trades ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-zinc-100 mb-4">Price History (24h)</h2>
          {prices.length === 0 ? (
            <div className="h-44 flex items-center justify-center text-zinc-600 text-sm">
              Start the bot to begin tracking
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={prices} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp"
                  tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  tick={{ fill: '#52525b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis domain={['auto', 'auto']} tick={{ fill: '#52525b', fontSize: 10 }}
                  tickFormatter={v => `$${(v as number).toFixed(4)}`} width={66} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, fontSize: 12 }}
                  formatter={(v: number) => [`$${v.toFixed(6)}`, 'Price']}
                  labelFormatter={l => new Date(l).toLocaleString()} />
                {status && <ReferenceLine y={status.targetPeg} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.5} />}
                {status && <ReferenceLine y={status.upperBound} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.35} />}
                {status && <ReferenceLine y={status.lowerBound} stroke="#3b82f6" strokeDasharray="3 3" strokeOpacity={0.35} />}
                <Area type="monotone" dataKey="price" stroke="#10b981" fill="url(#pg)" dot={false} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-zinc-100">Trades</h2>
            <Link href="/peg" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">See all</Link>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-zinc-800 rounded-xl animate-pulse" />)}
            </div>
          ) : trades.length === 0 ? (
            <div className="h-32 flex flex-col items-center justify-center gap-2 text-zinc-600 text-sm">
              <Activity className="h-7 w-7 opacity-25" />
              No trades yet
            </div>
          ) : (
            <div className="space-y-2">
              {trades.map(t => (
                <div key={t.id} className="flex items-center gap-3 surface">
                  {t.action === 'BUY'
                    ? <TrendingUp className="h-3.5 w-3.5 text-brand-400 shrink-0" />
                    : <TrendingDown className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">
                      <span className={t.action === 'BUY' ? 'text-brand-400' : 'text-red-400'}>{t.action}</span>
                      {' '}<span className="text-zinc-300">{Number(t.token_amount).toFixed(2)}</span>
                    </p>
                    <p className="text-xs text-zinc-600">{new Date(t.timestamp).toLocaleTimeString()}</p>
                  </div>
                  <span className={clsx('text-xs font-bold', t.status === 'SUCCESS' ? 'text-brand-400' : 'text-red-400')}>
                    {t.status === 'SUCCESS' ? '✓' : '✗'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Link href="/peg" className="btn-primary w-full sm:hidden">
        Open Peg Bot <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
