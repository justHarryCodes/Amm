'use client';
import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  getPegStatus, getPegConfig, updatePegConfig,
  startBot, stopBot, pauseBot, resumeBot, getTradeHistory,
  findPegPair, initPool,
} from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import {
  Play, Square, Pause, RotateCcw, CheckCircle, XCircle,
  Clock, ExternalLink, ChevronDown, ChevronUp, Search, Droplets,
} from 'lucide-react';
import clsx from 'clsx';

type PegChain = 'bsc' | 'ethereum' | 'solana';

interface PegStatus {
  state: string; chain: PegChain; currentPrice: number | null; targetPeg: number;
  upperBound: number; lowerBound: number; liquidityUsd: number | null;
  lastUpdated: string | null;
  dailyStats: { totalTrades: number; totalBuyUsd: number; totalSellTokens: number };
}
interface PegSettings {
  chain: PegChain; tokenAddress: string; stableAddress: string; pairAddress: string; routerAddress: string;
  targetPeg: number; upperBand: number; lowerBand: number; maxTradeSizeTokens: number;
  maxDailySpendUsd: number; minLiquidityUsd: number; cooldownSeconds: number; slippageTolerance: number;
}
interface Trade {
  id: number; timestamp: string; action: string; token_amount: number; stable_amount: number;
  price_before: number; price_after: number | null; tx_hash: string | null; status: string; error_message?: string;
}

const EXPLORER: Record<PegChain, (tx: string) => string> = {
  bsc:      tx => `https://bscscan.com/tx/${tx}`,
  ethereum: tx => `https://etherscan.io/tx/${tx}`,
  solana:   tx => `https://solscan.io/tx/${tx}`,
};

const DEX_NAME: Record<PegChain, string> = {
  bsc: 'PancakeSwap V2', ethereum: 'Uniswap V2', solana: 'Raydium CPMM',
};

const STATE_DOT: Record<string, string> = {
  STOPPED: 'bg-zinc-500',
  MONITOR_ONLY: 'bg-amber-400 animate-pulse',
  AUTO_TRADE: 'bg-brand-400 animate-pulse',
  PAUSED: 'bg-red-400',
};

const CHAIN_COLORS: Record<PegChain, string> = {
  bsc: 'badge-yellow', ethereum: 'badge-blue', solana: 'badge-purple',
};

const DEFAULT_ROUTERS: Record<PegChain, string> = {
  bsc:      '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  ethereum: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  solana:   '',
};

export default function PegPage() {
  const [status,   setStatus]   = useState<PegStatus | null>(null);
  const [settings, setSettings] = useState<PegSettings | null>(null);
  const [trades,   setTrades]   = useState<Trade[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);

  // accordion state
  const [setupOpen,  setSetupOpen]  = useState(false);
  const [poolOpen,   setPoolOpen]   = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);

  const { on } = useSSE();

  const refresh = useCallback(async () => {
    // Fetch independently — a DB failure on status/trades must not hide the config form
    const [s, cfg, t] = await Promise.allSettled([
      getPegStatus(), getPegConfig(), getTradeHistory(20),
    ]);
    if (cfg.status === 'fulfilled') setSettings(cfg.value as PegSettings);
    if (s.status   === 'fulfilled') setStatus(s.value as PegStatus);
    if (t.status   === 'fulfilled') setTrades(t.value as Trade[]);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 20_000); return () => clearInterval(iv); }, [refresh]);

  useEffect(() => {
    const o1 = on('PRICE_UPDATE', (d: unknown) => {
      const snap = d as { price: number; liquidityUsd: number; timestamp: string };
      setStatus(p => p ? { ...p, currentPrice: snap.price, liquidityUsd: snap.liquidityUsd, lastUpdated: snap.timestamp } : p);
    });
    const o2 = on('BOT_STATE', (d: unknown) => {
      const s = d as { state: string; settings: PegSettings };
      setStatus(p => p ? { ...p, state: s.state, chain: s.settings.chain } : p);
      setSettings(s.settings);
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

  const state   = status?.state ?? 'STOPPED';
  const chain   = (settings?.chain ?? status?.chain ?? 'bsc') as PegChain;
  const price   = status?.currentPrice;
  const target  = status?.targetPeg ?? settings?.targetPeg ?? 1;
  const dev     = price != null && target > 0 ? ((price - target) / target) * 100 : null;
  const inRange = dev != null && Math.abs(dev) <= (settings?.upperBand ?? 0.02) * 100;

  const missingConfig = settings && (
    !settings.tokenAddress ||
    !settings.stableAddress ||
    ((chain === 'bsc' || chain === 'ethereum') && !settings.pairAddress)
  );

  async function saveSettings(s: PegSettings) {
    try {
      await updatePegConfig(s as unknown as Record<string, number | string>);
      setSettings(s);
      toast.success('Settings saved');
      setSetupOpen(false);
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
  }

  return (
    <div className="page">

      {/* ── 1. STATUS CARD ── always visible ──────────── */}
      <div className="card">

        {/* Header row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={clsx('h-2.5 w-2.5 rounded-full shrink-0', STATE_DOT[state])} />
            <span className="font-semibold text-zinc-100 text-sm">{state.replace('_', ' ')}</span>
            <span className={clsx('badge', CHAIN_COLORS[chain])}>{chain.toUpperCase()}</span>
          </div>
          {price != null ? (
            <div className="text-right">
              <p className="text-2xl font-bold font-mono text-zinc-50 leading-none">${price.toFixed(6)}</p>
              {dev != null && (
                <p className={clsx('text-xs mt-0.5', inRange ? 'text-brand-400' : 'text-amber-400')}>
                  {dev >= 0 ? '▲' : '▼'} {Math.abs(dev).toFixed(3)}% from peg
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No price yet</p>
          )}
        </div>

        {/* Peg bar */}
        {status && price != null && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-zinc-600 mb-1">
              <span>${status.lowerBound.toFixed(5)}</span>
              <span className="text-zinc-500">target ${target.toFixed(5)}</span>
              <span>${status.upperBound.toFixed(5)}</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full relative overflow-hidden">
              <div className="absolute inset-y-0 left-[28%] right-[28%] bg-brand-500/15 rounded-full" />
              <div
                className={clsx('absolute top-0.5 bottom-0.5 w-2.5 rounded-full transition-all duration-500',
                  inRange ? 'bg-brand-400' : 'bg-amber-400')}
                style={{ left: `${Math.max(2, Math.min(94, ((price - status.lowerBound) / (status.upperBound - status.lowerBound)) * 100))}%` }}
              />
            </div>
          </div>
        )}

        {/* Controls */}
        {missingConfig && state === 'STOPPED' && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
            {!settings?.tokenAddress || !settings?.stableAddress
              ? 'Set token & stablecoin addresses in Setup before starting.'
              : 'Set a pair address in Setup (or use Pool Liquidity → Find Existing Pair) before starting.'}
          </div>
        )}
        <div className="flex gap-2">
          {state === 'STOPPED' && (
            <>
              <button disabled={busy || !!missingConfig} onClick={() => act(() => startBot('MONITOR_ONLY'), 'Monitoring started')}
                className="btn-ghost flex-1 text-sm disabled:opacity-40">
                <Play className="h-4 w-4 text-amber-400" /> Monitor
              </button>
              <button disabled={busy || !!missingConfig} onClick={() => act(() => startBot('AUTO_TRADE'), 'Auto-trade started')}
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
              <button disabled={busy} onClick={() => act(pauseBot, 'Bot paused')} className="btn-danger flex-1 text-sm">
                <Pause className="h-4 w-4" /> Pause
              </button>
            </>
          )}
          {state === 'PAUSED' && (
            <>
              <button disabled={busy} onClick={() => act(resumeBot, 'Bot resumed')} className="btn-primary flex-1 text-sm">
                <RotateCcw className="h-4 w-4" /> Resume
              </button>
              <button disabled={busy} onClick={() => act(stopBot, 'Bot stopped')} className="btn-ghost flex-1 text-sm">
                <Square className="h-4 w-4" /> Stop
              </button>
            </>
          )}
        </div>

        {/* Mini stats */}
        {status && (
          <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-zinc-800/60 text-center">
            {[
              ['Liquidity',  status.liquidityUsd ? `$${(status.liquidityUsd / 1000).toFixed(1)}k` : '—'],
              ['24h Trades', status.dailyStats.totalTrades],
              ['Last check', status.lastUpdated ? new Date(status.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'],
            ].map(([label, value]) => (
              <div key={label as string}>
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="text-sm font-semibold text-zinc-200 mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 2. SETUP (accordion) ──────────────────────── */}
      {settings && (
        <div className="card">
          <button onClick={() => setSetupOpen(v => !v)}
            className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-zinc-100 text-sm">Setup</span>
              {(!settings.tokenAddress || (!settings.pairAddress && chain !== 'solana')) && (
                <span className="badge badge-yellow text-xs">Incomplete</span>
              )}
            </div>
            {setupOpen ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
          </button>

          {/* Summary row when collapsed */}
          {!setupOpen && settings.tokenAddress && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>Token: <span className="font-mono text-zinc-400">{settings.tokenAddress.slice(0, 8)}…</span></span>
              <span>Target: <span className="text-zinc-300">${settings.targetPeg}</span></span>
              <span>Band: <span className="text-zinc-300">±{(settings.upperBand * 100).toFixed(1)}%</span></span>
            </div>
          )}

          {setupOpen && (
            <SetupForm
              settings={settings}
              onSave={saveSettings}
              limitsOpen={limitsOpen}
              onToggleLimits={() => setLimitsOpen(v => !v)}
            />
          )}
        </div>
      )}

      {/* ── 3. POOL LIQUIDITY (accordion) ────────────── */}
      {settings && (
        <div className="card">
          <button onClick={() => setPoolOpen(v => !v)}
            className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Droplets className="h-4 w-4 text-blue-400" />
              <span className="font-semibold text-zinc-100 text-sm">Pool Liquidity</span>
              <span className="text-xs text-zinc-600">({DEX_NAME[chain]})</span>
            </div>
            {poolOpen ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
          </button>

          {!poolOpen && (
            <p className="mt-2 text-xs text-zinc-500">
              {settings.pairAddress
                ? `Pair: ${settings.pairAddress.slice(0, 10)}…`
                : chain === 'solana' ? 'No pool found yet' : 'No pair set'}
            </p>
          )}

          {poolOpen && (
            <PoolSection
              settings={settings}
              onChainChanged={async (c) => {
                const updated = { ...settings, chain: c, pairAddress: '', tokenAddress: '', stableAddress: c === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '', routerAddress: DEFAULT_ROUTERS[c] };
                try { await updatePegConfig(updated as unknown as Record<string, number | string>); setSettings(updated); } catch { /* ignore */ }
              }}
              onPairUpdated={pair => setSettings(s => s ? { ...s, pairAddress: pair } : s)}
            />
          )}
        </div>
      )}

      {/* ── 4. RECENT ACTIVITY ───────────────────────── */}
      <div className="card">
        <p className="font-semibold text-zinc-100 text-sm mb-3">Recent Activity</p>
        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-12 bg-zinc-800 rounded-xl animate-pulse" />)}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-center text-zinc-600 text-sm py-8">No trades yet — start the bot to begin</p>
        ) : (
          <div className="space-y-2">
            {trades.map(t => (
              <div key={t.id} className="surface flex items-center gap-3">
                <div className={clsx('h-8 w-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold',
                  t.action === 'BUY' ? 'bg-brand-500/10 text-brand-400' : 'bg-red-500/10 text-red-400')}>
                  {t.action === 'BUY' ? 'B' : 'S'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-200 font-medium">{Number(t.token_amount).toFixed(2)} tokens</span>
                    <span className="text-zinc-600">${Number(t.stable_amount).toFixed(4)}</span>
                    {t.price_after && <span className="text-zinc-600">→ ${t.price_after.toFixed(6)}</span>}
                  </div>
                  <p className="text-xs text-zinc-600 mt-0.5">{new Date(t.timestamp).toLocaleString()}</p>
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
    </div>
  );
}

// ── Setup form ────────────────────────────────────────────────────────────────

function SetupForm({
  settings, onSave, limitsOpen, onToggleLimits,
}: {
  settings: PegSettings;
  onSave: (s: PegSettings) => void;
  limitsOpen: boolean;
  onToggleLimits: () => void;
}) {
  const [s, setS] = useState(settings);

  const str = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS(p => ({ ...p, [k]: e.target.value }));
  const num = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }));

  function switchChain(c: PegChain) {
    setS(p => ({
      ...p, chain: c,
      tokenAddress: '', pairAddress: '',
      stableAddress: c === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '',
      routerAddress: DEFAULT_ROUTERS[c],
    }));
  }

  const isEvm = s.chain === 'bsc' || s.chain === 'ethereum';

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(s); }} className="mt-4 space-y-4">

      {/* Chain selector */}
      <div>
        <p className="text-xs text-zinc-500 mb-2">Chain</p>
        <div className="flex gap-2">
          {(['bsc', 'ethereum', 'solana'] as PegChain[]).map(c => (
            <button key={c} type="button" onClick={() => switchChain(c)}
              className={clsx('flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors',
                s.chain === c
                  ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                  : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
              {c === 'bsc' ? 'BSC' : c === 'ethereum' ? 'ETH' : 'Solana'}
            </button>
          ))}
        </div>
      </div>

      {/* Token addresses */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">
            {s.chain === 'solana' ? 'Token Mint' : 'Token Contract'}
          </label>
          <input className="input font-mono text-xs" placeholder={s.chain === 'solana' ? 'base58…' : '0x…'}
            value={s.tokenAddress} onChange={str('tokenAddress')} />
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">
            {s.chain === 'solana' ? 'Stable Mint' : 'Stablecoin Contract'}
          </label>
          {s.chain === 'solana' ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                {[['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
                  ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']].map(([l, m]) => (
                  <button key={l} type="button" onClick={() => setS(p => ({ ...p, stableAddress: m }))}
                    className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      s.stableAddress === m
                        ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                        : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
                    {l}
                  </button>
                ))}
              </div>
              <input className="input font-mono text-xs" placeholder="EPjF…"
                value={s.stableAddress} onChange={str('stableAddress')} />
            </div>
          ) : (
            <input className="input font-mono text-xs" placeholder="0x…"
              value={s.stableAddress} onChange={str('stableAddress')} />
          )}
        </div>

        {isEvm && (
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              DEX Pair Address
              <span className="text-zinc-600 ml-1">(auto-filled via Pool section)</span>
            </label>
            <input className="input font-mono text-xs" placeholder="0x…"
              value={s.pairAddress} onChange={str('pairAddress')} />
          </div>
        )}
      </div>

      {/* Safety limits — collapsible */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button type="button" onClick={onToggleLimits}
          className="flex items-center justify-between w-full px-4 py-3 text-xs text-zinc-500 font-medium">
          Safety Limits
          {limitsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {limitsOpen && (
          <div className="px-4 pb-4 grid grid-cols-2 gap-3 border-t border-zinc-800">
            {([
              ['Target ($)',        'targetPeg',          '0.0001'],
              ['Upper band',        'upperBand',          '0.001'],
              ['Lower band',        'lowerBand',          '0.001'],
              ['Max trade (tokens)','maxTradeSizeTokens', '1'],
              ['Daily limit ($)',   'maxDailySpendUsd',   '1'],
              ['Min liquidity ($)', 'minLiquidityUsd',    '100'],
              ['Cooldown (s)',      'cooldownSeconds',    '1'],
              ['Slippage',          'slippageTolerance',  '0.001'],
            ] as [string, keyof PegSettings, string][]).map(([label, key, step]) => (
              <div key={key} className="pt-3">
                <label className="block text-xs text-zinc-500 mb-1">{label}</label>
                <input type="number" step={step} value={s[key] as number}
                  onChange={num(key)} className="input" />
              </div>
            ))}
          </div>
        )}
      </div>

      <button type="submit" className="btn-primary w-full">Save Settings</button>
    </form>
  );
}

// ── Pool section ──────────────────────────────────────────────────────────────

function PoolSection({
  settings, onChainChanged, onPairUpdated,
}: {
  settings: PegSettings;
  onChainChanged: (chain: PegChain) => Promise<void>;
  onPairUpdated: (pair: string) => void;
}) {
  const [busy,       setBusy]       = useState(false);
  const [tokenAmt,   setTokenAmt]   = useState('');
  const [stableAmt,  setStableAmt]  = useState('');
  const [poolId,     setPoolId]     = useState(settings.pairAddress ?? '');
  const [result,     setResult]     = useState<{ pairAddress: string; isNewPair: boolean; liquidityTxHash: string } | null>(null);

  const chain = settings.chain;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  const openingPrice = parseFloat(tokenAmt) > 0 && parseFloat(stableAmt) > 0
    ? (parseFloat(stableAmt) / parseFloat(tokenAmt)).toFixed(8) : null;

  async function handleFind() {
    setBusy(true);
    try {
      const res = await findPegPair();
      if (res.found) {
        const id = res.pairAddress === 'FOUND_VIA_JUPITER' ? 'Found via Jupiter' : res.pairAddress;
        onPairUpdated(res.pairAddress);
        setPoolId(id);
        toast.success(chain === 'solana' ? 'Pool found on Jupiter/Raydium' : `Pair found: ${id.slice(0, 10)}…`);
      } else {
        toast('No existing pool found — create one below', { icon: 'ℹ️' });
      }
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Error'); }
    setBusy(false);
  }

  async function handleInit() {
    const ta = parseFloat(tokenAmt), sa = parseFloat(stableAmt);
    if (!ta || !sa) { toast.error('Enter both amounts'); return; }
    setBusy(true);
    try {
      const res = await initPool(ta, sa);
      onPairUpdated(res.pairAddress);
      setPoolId(res.pairAddress);
      setResult(res);
      toast.success(res.isNewPair ? 'Pool created & liquidity added!' : 'Liquidity added!');
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
    setBusy(false);
  }

  const canCreate = settings.tokenAddress && settings.stableAddress
    && (isEvm ? !!settings.routerAddress : true);

  return (
    <div className="mt-4 space-y-4">

      {/* Chain / DEX selector */}
      <div className="flex gap-2">
        {([
          ['bsc',      'PancakeSwap V2'],
          ['ethereum', 'Uniswap V2'],
          ['solana',   'Raydium CPMM'],
        ] as [PegChain, string][]).map(([c, label]) => (
          <button key={c} type="button"
            onClick={async () => { if (c !== chain) { setBusy(true); await onChainChanged(c); setPoolId(''); setResult(null); setBusy(false); } }}
            className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
              chain === c
                ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
            {label}
          </button>
        ))}
      </div>

      {/* DEX info badge */}
      <div className="surface flex items-center justify-between">
        <div className="text-xs">
          <p className="text-zinc-500">DEX</p>
          <p className="text-zinc-200 font-medium mt-0.5">{DEX_NAME[chain]}</p>
        </div>
        <div className="text-xs text-right">
          <p className="text-zinc-500">Pool / Pair</p>
          {poolId && poolId !== 'FOUND_VIA_JUPITER' ? (
            <p className="font-mono text-brand-400 mt-0.5">{poolId.slice(0, 12)}…</p>
          ) : (
            <p className="text-amber-400 mt-0.5">{poolId === 'FOUND_VIA_JUPITER' ? '✓ Found' : 'Not set'}</p>
          )}
        </div>
      </div>

      {/* Solana note */}
      {chain === 'solana' && (
        <div className="surface text-xs text-zinc-400 space-y-1">
          <p className="font-medium text-zinc-200">Raydium CPMM (Jupiter-routed)</p>
          <p className="text-zinc-500">Creates a Raydium Constant Product pool. Jupiter automatically routes swaps through it once seeded.</p>
        </div>
      )}

      {/* Find existing */}
      <button onClick={handleFind}
        disabled={busy || !settings.tokenAddress || !settings.stableAddress}
        className="btn-ghost w-full text-sm disabled:opacity-40">
        <Search className="h-4 w-4" />
        {busy ? 'Searching…' : chain === 'solana' ? 'Check if pool exists on Jupiter' : 'Find existing pair on-chain'}
      </button>

      {/* Add liquidity form */}
      <div className="space-y-3">
        <p className="text-xs text-zinc-500 font-medium">
          {settings.pairAddress && settings.pairAddress !== 'FOUND_VIA_JUPITER'
            ? 'Add more liquidity'
            : chain === 'solana' ? 'Create Raydium CPMM pool' : `Create ${DEX_NAME[chain]} pair`}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Token amount</label>
            <input type="number" min="0" step="any" placeholder="e.g. 1 000 000"
              value={tokenAmt} onChange={e => setTokenAmt(e.target.value)} className="input" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Stable amount</label>
            <input type="number" min="0" step="any" placeholder="e.g. 1 000"
              value={stableAmt} onChange={e => setStableAmt(e.target.value)} className="input" />
          </div>
        </div>

        {openingPrice && (
          <div className="surface flex items-center justify-between">
            <span className="text-xs text-zinc-500">Opening price</span>
            <span className="text-sm font-bold font-mono text-brand-400">${openingPrice} / token</span>
          </div>
        )}

        <button onClick={handleInit} disabled={busy || !canCreate || !tokenAmt || !stableAmt}
          className="btn-primary w-full disabled:opacity-40">
          {busy ? 'Sending transactions…'
            : settings.pairAddress ? 'Add Liquidity'
            : chain === 'solana' ? 'Create Raydium Pool & Add Liquidity'
            : `Create ${DEX_NAME[chain]} Pair & Add Liquidity`}
        </button>

        {!canCreate && (
          <p className="text-xs text-center text-amber-400">
            {isEvm ? 'Set token, stable, and router addresses in Setup first'
                   : 'Set token and stable mint addresses in Setup first'}
          </p>
        )}
      </div>

      {/* Result */}
      {result && (
        <div className="surface space-y-2 text-xs border border-brand-500/20">
          <p className="text-brand-400 font-medium">
            {result.isNewPair ? '✓ Pool created & liquidity added' : '✓ Liquidity added'}
          </p>
          <p className="font-mono text-zinc-400 break-all">{result.pairAddress}</p>
          {result.liquidityTxHash && result.pairAddress !== result.liquidityTxHash && (
            <a href={EXPLORER[chain](result.liquidityTxHash)} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-zinc-500 hover:text-zinc-200">
              View transaction <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
