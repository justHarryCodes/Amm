'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  getPegStatus, getPegConfig, updatePegConfig,
  startBot, stopBot, pauseBot, resumeBot, getTradeHistory,
} from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import {
  Play, Square, Pause, RotateCcw, CheckCircle, XCircle,
  Clock, ExternalLink, Copy, Check, AlertCircle, Loader2,
  ChevronDown, ChevronUp, ArrowLeftRight, RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';
import { CHAIN_TOKENS } from '@/lib/tokens';

type PegChain = 'bsc' | 'ethereum' | 'solana';

interface PegStatus {
  state: string; chain: PegChain; currentPrice: number | null; targetPeg: number;
  upperBound: number; lowerBound: number; liquidityUsd: number | null;
  lastUpdated: string | null;
  // Pool reserves (on-chain from pair contract)
  tokenReserve:  number | null;
  stableReserve: number | null;
  tokenSymbol:   string | null;
  stableSymbol:  string | null;
  blockNumber:   number | null;
  // Bot wallet
  botTokenBalance:  number | null;
  botStableBalance: number | null;
  botNativeBalance: number | null;
  nativeSymbol: string | null;
  // Trading state
  dailySpendUsd:    number;
  maxDailySpendUsd: number;
  cooldownRemaining: number;
  lastTradeAt: string | null;
  dailyStats: { totalTrades: number; totalBuyUsd: number; totalSellTokens: number; volumeTrades: number; volumeUsd: number };
  // CoinGecko market data
  marketPriceUsd: number | null;
  cgChange24h:    number | null;
  cgVolume24h:    number | null;
  cgMarketCap:    number | null;
  // Pool info
  dexVersion:    string | null;
  poolFeeTier:   number | null;
  volumeEnabled:         boolean;
  volumeIntervalSeconds: number;
}
interface PegSettings {
  chain: PegChain; tokenAddress: string; stableAddress: string; pairAddress: string; routerAddress: string;
  poolFeeTier: number;
  targetPeg: number; upperBand: number; lowerBand: number; maxTradeSizeTokens: number;
  maxDailySpendUsd: number; minLiquidityUsd: number; cooldownSeconds: number; slippageTolerance: number;
  volumeEnabled: boolean; volumeIntervalSeconds: number; volumeSwapSizeUsd: number;
}
interface Trade {
  id: number; timestamp: string; action: string; token_amount: number; stable_amount: number;
  price_before: number; price_after: number | null; tx_hash: string | null; status: string;
  error_message?: string; is_volume_trade?: boolean;
}

const EXPLORER: Record<PegChain, (tx: string) => string> = {
  bsc:      tx => `https://bscscan.com/tx/${tx}`,
  ethereum: tx => `https://etherscan.io/tx/${tx}`,
  solana:   tx => `https://solscan.io/tx/${tx}`,
};
const DEX: Record<PegChain, string> = {
  bsc:      CHAIN_TOKENS.bsc.dex,
  ethereum: CHAIN_TOKENS.ethereum.dex,
  solana:   CHAIN_TOKENS.solana.dex,
};
const DEFAULT_ROUTER: Record<PegChain, string> = {
  bsc: CHAIN_TOKENS.bsc.router, ethereum: CHAIN_TOKENS.ethereum.router, solana: '',
};
const STATE_DOT: Record<string, string> = {
  STOPPED: 'bg-zinc-500', MONITOR_ONLY: 'bg-amber-400 animate-pulse',
  AUTO_TRADE: 'bg-brand-400 animate-pulse', PAUSED: 'bg-red-400',
};
const CHAIN_BADGE: Record<PegChain, string> = {
  bsc: 'badge-yellow', ethereum: 'badge-blue', solana: 'badge-purple',
};

function timeAgo(ts: string): string {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 5)   return 'just now';
  if (sec < 60)  return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
function fmtDuration(sec: number): string {
  if (sec <= 0)  return 'ready';
  if (sec < 60)  return `${Math.ceil(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}
function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}
      className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
      {ok ? <Check className="h-3.5 w-3.5 text-brand-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

interface TokenInfo { botAddress: string; balance: string; symbol: string; }

function useTokenBalance(tokenAddress: string, chain: PegChain) {
  const [info, setInfo]      = useState<TokenInfo | null>(null);
  const [checking, setCheck] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isEvm = chain !== 'solana';
    const valid = isEvm ? tokenAddress.startsWith('0x') && tokenAddress.length === 42 : tokenAddress.length >= 32;
    setInfo(null);
    if (timer.current) clearTimeout(timer.current);
    if (!valid) return;
    timer.current = setTimeout(async () => {
      setCheck(true);
      try {
        const res = await fetch(`/api/peg/token-balance?tokenAddress=${encodeURIComponent(tokenAddress)}`);
        if (res.ok) setInfo(await res.json() as TokenInfo);
      } catch { /* ignore */ }
      setCheck(false);
    }, 600);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [tokenAddress, chain]);
  return { info, checking };
}

// ── Token box (Uniswap-style input with inline balance) ───────────────────────
function TokenBox({
  label, value, placeholder, onChange, chain, showBalance = true,
}: {
  label: string; value: string; placeholder: string;
  onChange: (v: string) => void; chain: PegChain; showBalance?: boolean;
}) {
  const { info, checking } = useTokenBalance(showBalance ? value : '', chain);
  const noBalance = info && parseFloat(info.balance) === 0;
  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
      <p className="text-xs text-zinc-500 mb-2 font-medium">{label}</p>
      <input
        className="w-full bg-transparent text-sm text-zinc-100 placeholder-zinc-700 outline-none font-mono"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <div className="mt-2 min-h-[18px]">
        {checking && (
          <span className="flex items-center gap-1 text-xs text-zinc-600">
            <Loader2 className="h-3 w-3 animate-spin" /> checking…
          </span>
        )}
        {!checking && info && !noBalance && (
          <span className="text-xs text-brand-400 font-medium">
            Bot: {parseFloat(info.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })} {info.symbol}
          </span>
        )}
        {!checking && noBalance && info && (
          <div className="space-y-1.5">
            <span className="flex items-center gap-1 text-xs text-amber-400">
              <AlertCircle className="h-3.5 w-3.5" />
              Bot has no {info.symbol} — send tokens first
            </span>
            <div className="flex items-center gap-1 bg-zinc-800 rounded-lg px-2 py-1">
              <span className="text-xs font-mono text-zinc-400 flex-1 truncate">{info.botAddress}</span>
              <CopyBtn text={info.botAddress} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chain tabs ────────────────────────────────────────────────────────────────
function ChainTabs({ value, onChange }: { value: PegChain; onChange: (c: PegChain) => void }) {
  return (
    <div className="flex gap-1 p-1 bg-zinc-900 rounded-xl">
      {(['bsc', 'ethereum', 'solana'] as PegChain[]).map(c => (
        <button key={c} type="button" onClick={() => onChange(c)}
          className={clsx('flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors',
            value === c ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
          {c === 'bsc' ? 'BSC' : c === 'ethereum' ? 'ETH' : 'Solana'}
        </button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PegPage() {
  const [status,   setStatus]   = useState<PegStatus | null>(null);
  const [settings, setSettings] = useState<PegSettings | null>(null);
  const [trades,   setTrades]   = useState<Trade[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const { on } = useSSE();

  // Cooldown countdown — ticks every second when cooldownRemaining > 0
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!status?.cooldownRemaining) { setCooldown(0); return; }
    setCooldown(status.cooldownRemaining);
    const iv = setInterval(() => setCooldown(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(iv);
  }, [status?.cooldownRemaining]);

  const refresh = useCallback(async () => {
    const [s, cfg, t] = await Promise.allSettled([getPegStatus(), getPegConfig(), getTradeHistory(20)]);
    if (cfg.status === 'fulfilled') setSettings(cfg.value as PegSettings);
    if (s.status   === 'fulfilled') setStatus(s.value as PegStatus);
    if (t.status   === 'fulfilled') setTrades(t.value as Trade[]);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 20_000); return () => clearInterval(iv); }, [refresh]);

  useEffect(() => {
    const o1 = on('PRICE_UPDATE', (d: unknown) => {
      const snap = d as {
        price: number; liquidityUsd: number; timestamp: string;
        tokenReserve: number; stableReserve: number;
        tokenSymbol: string; stableSymbol: string; blockNumber: number;
        marketPriceUsd: number | null; cgChange24h: number | null;
        cgVolume24h: number | null; cgMarketCap: number | null;
      };
      setStatus(p => p ? {
        ...p,
        currentPrice:   snap.price,
        liquidityUsd:   snap.liquidityUsd,
        lastUpdated:    snap.timestamp,
        tokenReserve:   snap.tokenReserve,
        stableReserve:  snap.stableReserve,
        tokenSymbol:    snap.tokenSymbol  || p.tokenSymbol,
        stableSymbol:   snap.stableSymbol || p.stableSymbol,
        blockNumber:    snap.blockNumber,
        marketPriceUsd: snap.marketPriceUsd,
        cgChange24h:    snap.cgChange24h,
        cgVolume24h:    snap.cgVolume24h,
        cgMarketCap:    snap.cgMarketCap,
      } : p);
    });
    const o2 = on('BOT_STATE', (d: unknown) => {
      const s = d as { state: string; settings: PegSettings };
      // Only update bot state/chain — never overwrite settings from SSE while the form may be dirty.
      // The save flow calls setSettings() directly after updatePegConfig() resolves.
      setStatus(p => p ? { ...p, state: s.state, chain: s.settings.chain } : p);
    });
    const o3 = on('TRADE', (d: unknown) => { setTrades(p => [d as Trade, ...p].slice(0, 20)); refresh(); });
    return () => { o1(); o2(); o3(); };
  }, [on, refresh]);

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try { await fn(); toast.success(msg); await refresh(); }
    catch (e: unknown) { toast.error((e as Error).message ?? 'Error'); }
    setBusy(false);
  }

  async function saveSettings(s: PegSettings): Promise<void> {
    try { await updatePegConfig(s as unknown as Record<string, number | string>); setSettings(s); toast.success('Saved'); }
    catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
  }

  const state   = status?.state ?? 'STOPPED';
  const chain   = (settings?.chain ?? status?.chain ?? 'bsc') as PegChain;
  const price   = status?.currentPrice;
  const target  = status?.targetPeg ?? settings?.targetPeg ?? 1;
  const dev     = price != null && target > 0 ? ((price - target) / target) * 100 : null;
  const inRange = dev != null && Math.abs(dev) <= (settings?.upperBand ?? 0.02) * 100;
  const readyToRun = settings && settings.tokenAddress && settings.stableAddress
    && (chain === 'solana' || !!settings.pairAddress);

  if (loading) {
    return (
      <div className="page space-y-3">
        {[...Array(3)].map((_, i) => <div key={i} className="h-36 bg-zinc-800 rounded-2xl animate-pulse" />)}
      </div>
    );
  }

  const tokSym  = status?.tokenSymbol  || settings?.tokenAddress?.slice(0, 6) || 'Token';
  const stbSym  = status?.stableSymbol || settings?.stableAddress?.slice(0, 6) || 'Stable';
  const natSym  = status?.nativeSymbol ?? (chain === 'bsc' ? 'BNB' : 'ETH');

  // Budget percentage
  const dailyPct = status && status.maxDailySpendUsd > 0
    ? Math.min(100, (status.dailySpendUsd / status.maxDailySpendUsd) * 100)
    : 0;

  // What would bot do right now?
  let botAction: { label: string; color: string } | null = null;
  if (price != null && status) {
    if (price > status.upperBound) botAction = { label: `Price HIGH — would sell ${tokSym}`, color: 'text-red-400' };
    else if (price < status.lowerBound) botAction = { label: `Price LOW — would buy ${tokSym}`, color: 'text-brand-400' };
    else botAction = { label: 'Price in range — holding', color: 'text-zinc-500' };
  }

  return (
    <div className="page">

      {/* ── BOT STATUS ─────────────────────────────────── */}
      <div className="card space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx('h-2 w-2 rounded-full shrink-0', STATE_DOT[state])} />
            <span className="text-sm font-semibold text-zinc-200">{state.replace(/_/g, ' ')}</span>
            <span className={clsx('badge text-xs', CHAIN_BADGE[chain])}>
              {chain === 'bsc' ? 'BSC' : chain === 'ethereum' ? 'ETH' : 'SOL'} · {DEX[chain]}
            </span>
            {status?.poolFeeTier ? (
              <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-lg font-mono">
                {({ 100: '0.01%', 500: '0.05%', 2500: '0.25%', 3000: '0.3%', 10000: '1%' } as Record<number,string>)[status.poolFeeTier] ?? `${status.poolFeeTier/10000}%`}
              </span>
            ) : null}
            {status?.volumeEnabled && state === 'AUTO_TRADE' && (
              <span className="text-xs bg-brand-500/10 text-brand-400 border border-brand-500/20 px-2 py-0.5 rounded-lg">
                vol
              </span>
            )}
          </div>
          {status?.blockNumber ? (
            <span className="text-xs text-zinc-600 font-mono">#{status.blockNumber.toLocaleString()}</span>
          ) : null}
        </div>

        {/* Price + deviation */}
        {price != null ? (
          <div>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-zinc-600 mb-1">DEX Price (pair contract)</p>
                <p className="text-3xl font-bold font-mono text-zinc-50 leading-none">${price.toFixed(6)}</p>
                <p className={clsx('text-xs mt-1.5 font-medium flex items-center gap-1.5',
                  inRange ? 'text-brand-400' : 'text-amber-400')}>
                  {dev != null && (
                    <>{dev >= 0 ? '▲' : '▼'} {Math.abs(dev).toFixed(3)}% {dev >= 0 ? 'above' : 'below'} peg</>
                  )}
                </p>
                {botAction && state !== 'STOPPED' && (
                  <p className={clsx('text-xs mt-0.5', botAction.color)}>{botAction.label}</p>
                )}
              </div>
              <div className="text-right text-xs text-zinc-600">
                <p>target ${target.toFixed(6)}</p>
                {status?.lastUpdated && <p>{timeAgo(status.lastUpdated)}</p>}
              </div>
            </div>

            {/* CoinGecko market data row */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2.5">
                <p className="text-xs text-zinc-600 mb-0.5">Market Price (CoinGecko)</p>
                {status?.marketPriceUsd != null ? (
                  <p className="text-sm font-mono font-semibold text-zinc-100">
                    ${status.marketPriceUsd.toFixed(6)}
                  </p>
                ) : (
                  <p className="text-sm text-zinc-600">Not listed</p>
                )}
                {status?.marketPriceUsd != null && price > 0 && (
                  <p className={clsx('text-xs mt-0.5',
                    status.marketPriceUsd > price ? 'text-amber-400' : 'text-brand-400')}>
                    {(((price - status.marketPriceUsd) / status.marketPriceUsd) * 100).toFixed(3)}% vs market
                  </p>
                )}
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2.5">
                <p className="text-xs text-zinc-600 mb-0.5">24h Change</p>
                {status?.cgChange24h != null ? (
                  <p className={clsx('text-sm font-mono font-semibold',
                    status.cgChange24h >= 0 ? 'text-brand-400' : 'text-red-400')}>
                    {status.cgChange24h >= 0 ? '+' : ''}{status.cgChange24h.toFixed(2)}%
                  </p>
                ) : (
                  <p className="text-sm text-zinc-600">—</p>
                )}
                {status?.cgVolume24h != null && (
                  <p className="text-xs text-zinc-600 mt-0.5">
                    Vol: ${(status.cgVolume24h / 1000).toFixed(0)}k
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-600">
            {readyToRun ? 'Fetching on-chain price…' : 'Configure pair address to see live price'}
          </p>
        )}

        {/* Range bar */}
        {price != null && status && (
          <div>
            <div className="h-1.5 bg-zinc-800 rounded-full relative overflow-hidden">
              <div className="absolute inset-y-0 left-[20%] right-[20%] bg-brand-500/15 rounded-full" />
              <div
                className={clsx('absolute top-0 bottom-0 w-2 rounded-full transition-all duration-500',
                  inRange ? 'bg-brand-400' : 'bg-amber-400')}
                style={{ left: `${Math.max(2, Math.min(93, ((price - status.lowerBound) / Math.max(status.upperBound - status.lowerBound, 0.000001)) * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-zinc-700 mt-1">
              <span>${status.lowerBound.toFixed(5)}</span>
              <span>target ${target.toFixed(5)}</span>
              <span>${status.upperBound.toFixed(5)}</span>
            </div>
          </div>
        )}

        {/* Pool reserves / balances */}
        {(status?.tokenReserve != null || status?.stableReserve != null) && (
          <div className="pt-3 border-t border-zinc-800/60">
            <p className="text-xs text-zinc-600 font-medium mb-2 uppercase tracking-wide">
              {status?.dexVersion === 'v3' ? 'Pool Balances (V3)' : 'Pool Reserves'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2.5">
                <p className="text-xs text-zinc-500 mb-0.5">{tokSym}</p>
                <p className="text-sm font-mono font-semibold text-zinc-100">
                  {fmtNum(status.tokenReserve)}
                </p>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2.5">
                <p className="text-xs text-zinc-500 mb-0.5">{stbSym}</p>
                <p className="text-sm font-mono font-semibold text-zinc-100">
                  {fmtNum(status.stableReserve)}
                </p>
              </div>
            </div>
            {status.liquidityUsd != null && (
              <div className="flex items-center justify-between mt-2 px-1">
                <span className="text-xs text-zinc-600">Total liquidity</span>
                <span className="text-xs font-semibold text-zinc-300">
                  ${status.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Bot wallet */}
        {(status?.botTokenBalance != null || status?.botStableBalance != null || status?.botNativeBalance != null) && (
          <div className="pt-3 border-t border-zinc-800/60">
            <p className="text-xs text-zinc-600 font-medium mb-2 uppercase tracking-wide">Bot Wallet</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-2 py-2.5">
                <p className="text-xs text-zinc-500 mb-0.5">{tokSym}</p>
                <p className={clsx('text-sm font-semibold font-mono',
                  (status.botTokenBalance ?? 0) > 0 ? 'text-zinc-100' : 'text-amber-400')}>
                  {fmtNum(status.botTokenBalance)}
                </p>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-2 py-2.5">
                <p className="text-xs text-zinc-500 mb-0.5">{stbSym}</p>
                <p className={clsx('text-sm font-semibold font-mono',
                  (status.botStableBalance ?? 0) > 0 ? 'text-zinc-100' : 'text-amber-400')}>
                  {fmtNum(status.botStableBalance)}
                </p>
              </div>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-2 py-2.5">
                <p className="text-xs text-zinc-500 mb-0.5">{natSym} (gas)</p>
                <p className={clsx('text-sm font-semibold font-mono',
                  (status.botNativeBalance ?? 0) > 0.001 ? 'text-zinc-100' : 'text-red-400')}>
                  {status.botNativeBalance != null ? status.botNativeBalance.toFixed(4) : '—'}
                </p>
              </div>
            </div>

            {/* Daily budget bar */}
            {(status.maxDailySpendUsd ?? 0) > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-zinc-600 mb-1.5">
                  <span>Daily budget</span>
                  <span>${fmtNum(status.dailySpendUsd)} / ${fmtNum(status.maxDailySpendUsd, 0)} used</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full transition-all',
                      dailyPct > 80 ? 'bg-amber-400' : 'bg-brand-500')}
                    style={{ width: `${dailyPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Cooldown */}
            {cooldown > 0 ? (
              <p className="text-xs text-amber-400 mt-2 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Next trade in {fmtDuration(cooldown)}
              </p>
            ) : state === 'AUTO_TRADE' ? (
              <p className="text-xs text-brand-400 mt-2 flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5" /> Ready to trade
              </p>
            ) : null}
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2 pt-1">
          {state === 'STOPPED' && (
            <>
              <button disabled={busy || !readyToRun} onClick={() => act(() => startBot('MONITOR_ONLY'), 'Monitoring started')}
                className="btn-ghost flex-1 text-sm disabled:opacity-40">
                <Play className="h-4 w-4 text-amber-400" /> Monitor
              </button>
              <button disabled={busy || !readyToRun} onClick={() => act(() => startBot('AUTO_TRADE'), 'Auto-trade started')}
                className="btn-primary flex-1 text-sm disabled:opacity-40">
                <Play className="h-4 w-4" /> Auto Trade
              </button>
            </>
          )}
          {(state === 'MONITOR_ONLY' || state === 'AUTO_TRADE') && (
            <>
              <button disabled={busy} onClick={() => act(stopBot, 'Bot stopped')} className="btn-ghost flex-1 text-sm">
                <Square className="h-4 w-4" /> Stop
              </button>
              <button disabled={busy} onClick={() => act(pauseBot, 'Paused')} className="btn-danger flex-1 text-sm">
                <Pause className="h-4 w-4" /> Pause
              </button>
            </>
          )}
          {state === 'PAUSED' && (
            <>
              <button disabled={busy} onClick={() => act(resumeBot, 'Resumed')} className="btn-primary flex-1 text-sm">
                <RotateCcw className="h-4 w-4" /> Resume
              </button>
              <button disabled={busy} onClick={() => act(stopBot, 'Stopped')} className="btn-ghost flex-1 text-sm">
                <Square className="h-4 w-4" /> Stop
              </button>
            </>
          )}
        </div>

        {!readyToRun && state === 'STOPPED' && (
          <p className="text-center text-xs text-zinc-600">Complete setup below to enable trading</p>
        )}

        {/* 24h summary when running */}
        {status && state !== 'STOPPED' && (
          <div className="pt-3 border-t border-zinc-800/60 space-y-2">
            {/* Peg correction row */}
            <p className="text-xs text-zinc-600 font-medium uppercase tracking-wide">24h Peg Correction</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xs text-zinc-600">Trades</p>
                <p className="text-sm font-semibold text-zinc-200 mt-0.5">
                  {status.dailyStats.totalTrades - (status.dailyStats.volumeTrades ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Bought</p>
                <p className="text-sm font-semibold text-zinc-200 mt-0.5">${fmtNum(status.dailyStats.totalBuyUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Sold</p>
                <p className="text-sm font-semibold text-zinc-200 mt-0.5">{fmtNum(status.dailyStats.totalSellTokens)} {tokSym}</p>
              </div>
            </div>

            {/* Volume generation row */}
            {status.volumeEnabled && (
              <>
                <p className="text-xs text-zinc-600 font-medium uppercase tracking-wide pt-1">24h Volume Swaps</p>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2">
                    <p className="text-xs text-zinc-600">Swap count</p>
                    <p className="text-sm font-semibold text-brand-400 mt-0.5">
                      {status.dailyStats.volumeTrades ?? 0}
                    </p>
                  </div>
                  <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 px-3 py-2">
                    <p className="text-xs text-zinc-600">Volume generated</p>
                    <p className="text-sm font-semibold text-brand-400 mt-0.5">
                      ${fmtNum(status.dailyStats.volumeUsd ?? 0)}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-zinc-600 text-center">
                  every {status.volumeIntervalSeconds}s · alternating BUY/SELL
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── PAIR SETUP ─────────────────────────────────── */}
      {settings && (
        <PairCard settings={settings} onSave={saveSettings} />
      )}

      {/* ── RECENT TRADES ──────────────────────────────── */}
      <TradeHistory trades={trades} chain={chain} />
    </div>
  );
}

// ── Resolved token info ───────────────────────────────────────────────────────
interface ResolvedToken {
  address: string; symbol: string; name: string; decimals: number; botBalance: number;
}
interface ResolvedPool {
  token0: ResolvedToken; token1: ResolvedToken;
  fee: number; dexVersion: string;
  suggestedPeg: 'token0' | 'token1';
  botAddress: string;
}

const FEE_LABELS: Record<number, string> = { 100: '0.01%', 500: '0.05%', 2500: '0.25%', 3000: '0.3%', 10000: '1%' };

function fmtBalance(n: number, sym: string) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym}`;
}

// ── Pair Setup Card ───────────────────────────────────────────────────────────
function PairCard({ settings, onSave }: { settings: PegSettings; onSave: (s: PegSettings) => Promise<void> }) {
  const [s, setS]         = useState(settings);
  const [open, setOpen]   = useState(false);
  const [resolving, setResolving] = useState(false);
  const [pool, setPool]   = useState<ResolvedPool | null>(null);
  // which of token0/token1 is the "peg token" (the other is stable)
  const [pegSlot, setPegSlot] = useState<'token0' | 'token1'>('token0');
  const dirty       = useRef(false);
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from parent only when user hasn't made edits
  useEffect(() => { if (!dirty.current) setS(settings); }, [settings]);

  // Auto-resolve whenever pairAddress or chain changes (debounced 600 ms)
  useEffect(() => {
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    const isEvm    = s.chain === 'bsc' || s.chain === 'ethereum';
    const isSolana = s.chain === 'solana';
    const validEvm     = isEvm    && s.pairAddress.startsWith('0x') && s.pairAddress.length === 42;
    const validSolana  = isSolana && s.pairAddress.length >= 32 && s.pairAddress.length <= 44 && !s.pairAddress.startsWith('0x');
    if (!validEvm && !validSolana) { setPool(null); return; }
    resolveTimer.current = setTimeout(() => void runResolve(s.pairAddress, s.chain), 600);
    return () => { if (resolveTimer.current) clearTimeout(resolveTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.pairAddress, s.chain]);

  async function runResolve(pairAddr: string, chain: PegChain) {
    setResolving(true);
    try {
      const res = await fetch(`/api/peg/resolve-pair?pairAddress=${encodeURIComponent(pairAddr)}&chain=${chain}`);
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      const data = await res.json() as ResolvedPool;
      setPool(data);
      applyPegSlot(data, data.suggestedPeg);
    } catch (e: unknown) {
      toast.error(`Pool not found: ${(e as Error).message}`);
      setPool(null);
    }
    setResolving(false);
  }

  function applyPegSlot(p: ResolvedPool, slot: 'token0' | 'token1') {
    const peg    = p[slot];
    const stable = slot === 'token0' ? p.token1 : p.token0;
    dirty.current = true;
    setPegSlot(slot);
    setS(prev => ({ ...prev, tokenAddress: peg.address, stableAddress: stable.address, poolFeeTier: p.fee }));
  }

  function swapRoles() {
    if (!pool) return;
    applyPegSlot(pool, pegSlot === 'token0' ? 'token1' : 'token0');
  }

  const num = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    dirty.current = true; setS(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }));
  };

  function switchChain(c: PegChain) {
    dirty.current = false;
    setPool(null);
    setS(p => ({ ...p, chain: c, tokenAddress: '', stableAddress: '', pairAddress: '',
      routerAddress: DEFAULT_ROUTER[c] }));
  }

  // Solana still uses manual mint inputs
  const str = (k: keyof PegSettings) => (v: string) => {
    dirty.current = true;
    setS(p => ({ ...p, [k]: v }));
  };

  const isEvm    = s.chain === 'bsc' || s.chain === 'ethereum';
  const isSolana = s.chain === 'solana';
  const pairOk   = isEvm
    ? (s.pairAddress.startsWith('0x') && s.pairAddress.length === 42)
    : isSolana
    ? (s.pairAddress.length >= 32 && s.pairAddress.length <= 44)
    : false;

  const poolPlaceholder = isEvm
    ? `Paste pool contract address (0x…)`
    : `Paste Raydium pool address…`;
  const poolHint = isEvm
    ? `Create your pool on ${DEX[s.chain]}, then paste the pool address — token details will auto-fill.`
    : `Create your pool on Raydium, then paste the pool address — token details will auto-fill.`;

  return (
    <form onSubmit={async (e) => { e.preventDefault(); await onSave(s); dirty.current = false; }} className="card space-y-4">
      <p className="font-semibold text-zinc-100 text-sm">Bot Setup</p>

      <ChainTabs value={s.chain} onChange={switchChain} />

      {/* ── Pool address input (EVM + Solana) ── */}
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-zinc-500 font-medium">
              {DEX[s.chain]} Pool Address <span className="text-red-400">*</span>
            </p>
            {pool && (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500 font-mono">
                <span className={clsx('px-1.5 py-0.5 rounded text-xs font-medium',
                  pool.dexVersion === 'v3' || pool.dexVersion === 'clmm'
                    ? 'bg-brand-500/10 text-brand-400'
                    : isSolana
                    ? 'bg-purple-500/10 text-purple-400'
                    : 'bg-zinc-800 text-zinc-400')}>
                  {pool.dexVersion.toUpperCase()}
                </span>
                {isEvm && (FEE_LABELS[pool.fee] ?? `${pool.fee / 10000}%`)}
              </span>
            )}
          </div>
          <div className="relative">
            <input
              className={clsx('input font-mono text-xs pr-8',
                !pairOk && s.pairAddress ? 'border-red-500/50' : '')}
              placeholder={poolPlaceholder}
              value={s.pairAddress}
              onChange={e => { dirty.current = true; setS(p => ({ ...p, pairAddress: e.target.value })); }}
            />
            {resolving && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-zinc-500" />
            )}
          </div>
          {!pool && !resolving && (
            <p className="mt-1.5 text-xs text-zinc-600">{poolHint}</p>
          )}
        </div>

        {/* Resolved token cards */}
        {resolving && !pool && (
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500 shrink-0" />
            <p className="text-sm text-zinc-500">Reading pool{isSolana ? '' : ' contract'}…</p>
          </div>
        )}

        {pool && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {(['token0', 'token1'] as const).map(slot => {
                const tk        = pool[slot];
                const isPeg     = pegSlot === slot;
                const roleLabel = isPeg ? 'Peg Token' : 'Stable';
                return (
                  <div key={slot}
                    className={clsx('rounded-2xl border p-3 space-y-2.5 transition-all',
                      isPeg ? 'border-brand-500/50 bg-brand-500/5' : 'border-zinc-800 bg-zinc-900'
                    )}>
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <p className="text-base font-bold text-zinc-100 leading-tight truncate">{tk.symbol}</p>
                        <p className="text-xs text-zinc-500 truncate">{tk.name}</p>
                      </div>
                      <span className={clsx('shrink-0 text-xs px-2 py-0.5 rounded-lg font-medium whitespace-nowrap',
                        isPeg ? 'bg-brand-500/20 text-brand-400' : 'bg-zinc-800 text-zinc-400')}>
                        {roleLabel}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 bg-zinc-800/60 rounded-xl px-2 py-1.5">
                      <span className="text-xs font-mono text-zinc-500 flex-1 min-w-0 truncate">
                        {tk.address.slice(0, 6)}…{tk.address.slice(-4)}
                      </span>
                      <CopyBtn text={tk.address} />
                    </div>

                    <p className="text-xs text-zinc-600">{tk.decimals} decimals</p>

                    <div className={clsx('rounded-xl px-2.5 py-1.5 text-xs font-medium',
                      tk.botBalance > 0 ? 'bg-brand-500/10 text-brand-400' : 'bg-amber-500/10 text-amber-400')}>
                      {tk.botBalance > 0
                        ? `Bot: ${fmtBalance(tk.botBalance, tk.symbol)}`
                        : `Bot has no ${tk.symbol}`}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Swap roles + refresh */}
            <div className="flex gap-2">
              <button type="button" onClick={swapRoles}
                className="flex-1 btn-ghost text-xs py-2 flex items-center justify-center gap-1.5">
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Swap Roles
              </button>
              <button type="button"
                onClick={() => void runResolve(s.pairAddress, s.chain)}
                disabled={resolving}
                className="btn-ghost text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-40">
                <RefreshCw className={clsx('h-3.5 w-3.5', resolving && 'animate-spin')} />
                Refresh
              </button>
            </div>

            {pool.botAddress && (
              <div className="flex items-center gap-1.5 px-1">
                <p className="text-xs text-zinc-600">Bot wallet:</p>
                <span className="text-xs font-mono text-zinc-500">{pool.botAddress.slice(0, 8)}…{pool.botAddress.slice(-6)}</span>
                <CopyBtn text={pool.botAddress} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Target price + band */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Target Price ($)</label>
          <input type="number" step="0.000001" className="input" value={s.targetPeg} onChange={num('targetPeg')} />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Band (±%)</label>
          <input type="number" step="0.001" className="input" value={s.upperBand} onChange={num('upperBand')} />
        </div>
      </div>

      {/* Advanced limits + volume */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button type="button" onClick={() => setOpen(v => !v)}
          className="flex items-center justify-between w-full px-4 py-3 text-xs text-zinc-500 font-medium">
          Advanced Limits &amp; Volume
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {open && (
          <div className="px-4 pb-4 border-t border-zinc-800 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {([
                ['Max trade (tokens)',  'maxTradeSizeTokens',  '1'],
                ['Daily limit ($)',     'maxDailySpendUsd',    '1'],
                ['Min liquidity ($)',   'minLiquidityUsd',     '1'],
                ['Cooldown (s)',        'cooldownSeconds',     '1'],
                ['Slippage',           'slippageTolerance',   '0.001'],
                ['Lower band',         'lowerBand',           '0.001'],
              ] as [string, keyof PegSettings, string][]).map(([label, key, step]) => (
                <div key={key} className="pt-3">
                  <label className="block text-xs text-zinc-500 mb-1">{label}</label>
                  <input type="number" step={step} value={s[key] as number} onChange={num(key)} className="input" />
                </div>
              ))}
            </div>

            {/* Volume generation */}
            <div className="pt-3 border-t border-zinc-800/60">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-medium text-zinc-300">Volume Generation</p>
                  <p className="text-xs text-zinc-600 mt-0.5">Alternating buy/sell to create organic-looking volume</p>
                </div>
                <button type="button"
                  onClick={() => { dirty.current = true; setS(p => ({ ...p, volumeEnabled: !p.volumeEnabled })); }}
                  className={clsx('relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
                    s.volumeEnabled ? 'bg-brand-500' : 'bg-zinc-700')}>
                  <span className={clsx('pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                    s.volumeEnabled ? 'translate-x-4' : 'translate-x-0')} />
                </button>
              </div>
              {s.volumeEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Swap size ($)</label>
                    <input type="number" step="1" min="1" value={s.volumeSwapSizeUsd} onChange={num('volumeSwapSizeUsd')} className="input" />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Interval (s)</label>
                    <input type="number" step="10" min="30" value={s.volumeIntervalSeconds} onChange={num('volumeIntervalSeconds')} className="input" />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <button type="submit" className="btn-primary w-full">Save Settings</button>
    </form>
  );
}

// ── Trade History ─────────────────────────────────────────────────────────────
function TradeHistory({ trades, chain }: { trades: Trade[]; chain: PegChain }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full">
        <p className="font-semibold text-zinc-100 text-sm">Recent Trades</p>
        {open ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
      </button>
      {open && (
        <div className="mt-3">
          {trades.length === 0 ? (
            <p className="text-center text-zinc-600 text-sm py-6">No trades yet</p>
          ) : (
            <div className="space-y-2">
              {trades.map(t => (
                <div key={t.id} className="surface flex items-center gap-3">
                  <div className={clsx(
                    'h-8 w-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold',
                    t.is_volume_trade
                      ? 'bg-purple-500/10 text-purple-400'
                      : t.action === 'BUY' ? 'bg-brand-500/10 text-brand-400' : 'bg-red-500/10 text-red-400',
                  )}>
                    {t.is_volume_trade ? 'V' : t.action === 'BUY' ? 'B' : 'S'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      {t.is_volume_trade && (
                        <span className="text-xs bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded font-medium">VOL</span>
                      )}
                      <span className="text-zinc-200 font-medium">{Number(t.token_amount).toFixed(2)} tokens</span>
                      <span className="text-zinc-600">${Number(t.stable_amount).toFixed(4)}</span>
                      {t.price_after != null && (
                        <span className="text-zinc-600">→ ${Number(t.price_after).toFixed(6)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-xs text-zinc-600">{new Date(t.timestamp).toLocaleString()}</p>
                      {t.error_message && (
                        <p className="text-xs text-red-400 truncate">{t.error_message}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {t.status === 'SUCCESS' && <CheckCircle className="h-3.5 w-3.5 text-brand-400" />}
                    {t.status === 'FAILED'  && <XCircle    className="h-3.5 w-3.5 text-red-400" />}
                    {t.status === 'PENDING' && <Clock      className="h-3.5 w-3.5 text-amber-400" />}
                    {t.tx_hash && (
                      <a href={EXPLORER[chain](t.tx_hash)} target="_blank" rel="noreferrer"
                        className="text-zinc-600 hover:text-zinc-300">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
