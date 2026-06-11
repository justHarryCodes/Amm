'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  getPegStatus, getPegConfig, updatePegConfig,
  startBot, stopBot, pauseBot, resumeBot, getTradeHistory,
  findPegPair, initPool, approvePegTokens,
} from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import {
  Play, Square, Pause, RotateCcw, CheckCircle, XCircle,
  Clock, ExternalLink, Search, Droplets, Copy, Check,
  ChevronDown, ChevronUp, AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { CHAIN_TOKENS } from '@/lib/tokens';

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

const DEX: Record<PegChain, string> = {
  bsc: CHAIN_TOKENS.bsc.dex,
  ethereum: CHAIN_TOKENS.ethereum.dex,
  solana: CHAIN_TOKENS.solana.dex,
};

const DEFAULT_ROUTER: Record<PegChain, string> = {
  bsc: CHAIN_TOKENS.bsc.router,
  ethereum: CHAIN_TOKENS.ethereum.router,
  solana: '',
};

const STATE_COLOR: Record<string, string> = {
  STOPPED:      'bg-zinc-500',
  MONITOR_ONLY: 'bg-amber-400 animate-pulse',
  AUTO_TRADE:   'bg-brand-400 animate-pulse',
  PAUSED:       'bg-red-400',
};

const CHAIN_BADGE: Record<PegChain, string> = {
  bsc: 'badge-yellow', ethereum: 'badge-blue', solana: 'badge-purple',
};

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}
      className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
      {ok ? <Check className="h-3.5 w-3.5 text-brand-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── Token balance hook ────────────────────────────────────────────────────────

interface TokenInfo { botAddress: string; balance: string; symbol: string; }

function useTokenBalance(tokenAddress: string, chain: PegChain) {
  const [info, setInfo]     = useState<TokenInfo | null>(null);
  const [checking, setCheck] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isEvm = chain === 'bsc' || chain === 'ethereum';
    const valid  = isEvm
      ? tokenAddress.startsWith('0x') && tokenAddress.length === 42
      : tokenAddress.length >= 32;

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PegPage() {
  const [status,   setStatus]   = useState<PegStatus | null>(null);
  const [settings, setSettings] = useState<PegSettings | null>(null);
  const [trades,   setTrades]   = useState<Trade[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);

  const { on } = useSSE();

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

  const state  = status?.state ?? 'STOPPED';
  const chain  = (settings?.chain ?? status?.chain ?? 'bsc') as PegChain;
  const price  = status?.currentPrice;
  const target = status?.targetPeg ?? settings?.targetPeg ?? 1;
  const dev    = price != null && target > 0 ? ((price - target) / target) * 100 : null;
  const inRange = dev != null && Math.abs(dev) <= (settings?.upperBand ?? 0.02) * 100;

  const readyToRun = settings && settings.tokenAddress && settings.stableAddress
    && (chain === 'solana' || !!settings.pairAddress);

  async function saveSettings(s: PegSettings) {
    try {
      await updatePegConfig(s as unknown as Record<string, number | string>);
      setSettings(s);
      toast.success('Saved');
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
  }

  if (loading) {
    return (
      <div className="page space-y-3">
        {[...Array(3)].map((_, i) => <div key={i} className="h-32 bg-zinc-800 rounded-2xl animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="page">

      {/* ── 1. STATUS ──────────────────────────────────── */}
      <div className="card">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className={clsx('h-2.5 w-2.5 rounded-full shrink-0 mt-0.5', STATE_COLOR[state])} />
            <div>
              <p className="text-sm font-semibold text-zinc-100">{state.replace('_', ' ')}</p>
              <span className={clsx('badge text-xs', CHAIN_BADGE[chain])}>{chain.toUpperCase()} · {DEX[chain]}</span>
            </div>
          </div>
          {price != null ? (
            <div className="text-right">
              <p className="text-2xl font-bold font-mono text-zinc-50 leading-none">${price.toFixed(6)}</p>
              <p className={clsx('text-xs mt-0.5', inRange ? 'text-brand-400' : 'text-amber-400')}>
                {dev != null ? `${dev >= 0 ? '▲' : '▼'} ${Math.abs(dev).toFixed(3)}% from peg` : ''}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No price data</p>
          )}
        </div>

        {/* Peg bar */}
        {status && price != null && (
          <div className="mt-3">
            <div className="h-1.5 bg-zinc-800 rounded-full relative overflow-hidden">
              <div className="absolute inset-y-0 left-[25%] right-[25%] bg-brand-500/15 rounded-full" />
              <div
                className={clsx('absolute top-0 bottom-0 w-2 rounded-full transition-all duration-500',
                  inRange ? 'bg-brand-400' : 'bg-amber-400')}
                style={{ left: `${Math.max(2, Math.min(93, ((price - status.lowerBound) / Math.max(status.upperBound - status.lowerBound, 0.000001)) * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-zinc-700 mt-1">
              <span>${status.lowerBound.toFixed(5)}</span>
              <span className="text-zinc-600">target ${target.toFixed(5)}</span>
              <span>${status.upperBound.toFixed(5)}</span>
            </div>
          </div>
        )}

        {/* Mini stats */}
        {status && (
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-zinc-800/60 text-center">
            <div>
              <p className="text-xs text-zinc-600">Liquidity</p>
              <p className="text-sm font-semibold text-zinc-200 mt-0.5">
                {status.liquidityUsd ? `$${(status.liquidityUsd / 1000).toFixed(1)}k` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-600">24h Trades</p>
              <p className="text-sm font-semibold text-zinc-200 mt-0.5">{status.dailyStats.totalTrades}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-600">Last check</p>
              <p className="text-sm font-semibold text-zinc-200 mt-0.5">
                {status.lastUpdated ? new Date(status.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
              </p>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2 mt-4">
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
          <p className="mt-2 text-center text-xs text-zinc-600">
            Complete setup below to enable trading
          </p>
        )}
      </div>

      {/* ── 2. SETUP ───────────────────────────────────── */}
      {settings && (
        <SetupCard
          settings={settings}
          onSave={saveSettings}
          onPoolNeeded={() => setPoolOpen(true)}
        />
      )}

      {/* ── 3. POOL / LIQUIDITY ────────────────────────── */}
      {settings && (
        <div className="card">
          <button onClick={() => setPoolOpen(v => !v)} className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Droplets className="h-4 w-4 text-blue-400" />
              <span className="font-semibold text-zinc-100 text-sm">Pool Liquidity</span>
              {settings.pairAddress
                ? <span className="text-xs text-brand-400">✓ Pair set</span>
                : <span className="badge badge-yellow text-xs">Not set</span>
              }
            </div>
            {poolOpen ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
          </button>

          {!poolOpen && settings.pairAddress && settings.pairAddress !== 'FOUND_VIA_JUPITER' && (
            <p className="mt-1.5 text-xs font-mono text-zinc-600">{settings.pairAddress.slice(0, 14)}…</p>
          )}

          {poolOpen && (
            <PoolSection
              settings={settings}
              onChainChanged={async (c) => {
                const updated = { ...settings, chain: c, pairAddress: '', tokenAddress: '', stableAddress: c === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '', routerAddress: DEFAULT_ROUTER[c] };
                try { await updatePegConfig(updated as unknown as Record<string, number | string>); setSettings(updated); } catch { /* ignore */ }
              }}
              onPairUpdated={pair => setSettings(s => s ? { ...s, pairAddress: pair } : s)}
            />
          )}
        </div>
      )}

      {/* ── 4. RECENT TRADES ───────────────────────────── */}
      <div className="card">
        <p className="font-semibold text-zinc-100 text-sm mb-3">Recent Trades</p>
        {trades.length === 0 ? (
          <p className="text-center text-zinc-600 text-sm py-6">No trades yet</p>
        ) : (
          <div className="space-y-2">
            {trades.map(t => (
              <div key={t.id} className="surface flex items-center gap-3">
                <div className={clsx(
                  'h-8 w-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold',
                  t.action === 'BUY' ? 'bg-brand-500/10 text-brand-400' : 'bg-red-500/10 text-red-400'
                )}>
                  {t.action === 'BUY' ? 'B' : 'S'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-200 font-medium">{Number(t.token_amount).toFixed(2)} tokens</span>
                    <span className="text-zinc-600">${Number(t.stable_amount).toFixed(4)}</span>
                    {t.price_after != null && <span className="text-zinc-600">→ ${t.price_after.toFixed(6)}</span>}
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

// ── Setup card ────────────────────────────────────────────────────────────────

function SetupCard({
  settings, onSave, onPoolNeeded,
}: {
  settings: PegSettings;
  onSave: (s: PegSettings) => void;
  onPoolNeeded: () => void;
}) {
  const [s, setS]           = useState(settings);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [approving, setApproving]   = useState(false);
  const dirty = useRef(false);

  // Only sync from parent when user hasn't made unsaved edits
  useEffect(() => { if (!dirty.current) setS(settings); }, [settings]);

  const { info: tokenInfo, checking } = useTokenBalance(s.tokenAddress, s.chain);
  const hasNoTokenBalance = tokenInfo && parseFloat(tokenInfo.balance) === 0;

  const isEvm = s.chain === 'bsc' || s.chain === 'ethereum';

  const str = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    dirty.current = true;
    setS(p => ({ ...p, [k]: e.target.value }));
  };
  const num = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    dirty.current = true;
    setS(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }));
  };

  function switchChain(c: PegChain) {
    dirty.current = false;
    setS(p => ({
      ...p, chain: c,
      tokenAddress: '', pairAddress: '',
      stableAddress: c === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '',
      routerAddress: DEFAULT_ROUTER[c],
    }));
  }

  async function handleApprove() {
    setApproving(true);
    try {
      const res = await approvePegTokens() as { alreadyApproved: boolean };
      toast.success(res.alreadyApproved ? 'Already approved' : 'Tokens approved ✓');
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Approval failed');
    }
    setApproving(false);
  }

  const stables = [
    ['USDC', CHAIN_TOKENS[s.chain].usdc.address],
    ['USDT', CHAIN_TOKENS[s.chain].usdt.address],
    [CHAIN_TOKENS[s.chain].wNative.symbol, CHAIN_TOKENS[s.chain].wNative.address],
  ] as [string, string][];

  return (
    <form onSubmit={e => { e.preventDefault(); dirty.current = false; onSave(s); }} className="card space-y-4">
      <p className="font-semibold text-zinc-100 text-sm">Setup</p>

      {/* Chain */}
      <div className="flex gap-2">
        {(['bsc', 'ethereum', 'solana'] as PegChain[]).map(c => (
          <button key={c} type="button" onClick={() => switchChain(c)}
            className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
              s.chain === c
                ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
            {c === 'bsc' ? 'BSC' : c === 'ethereum' ? 'ETH' : 'Solana'}
          </button>
        ))}
      </div>

      {/* Token address + live balance check */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">
          {s.chain === 'solana' ? 'Token Mint' : 'Token Contract'}
        </label>
        <input className="input font-mono text-xs"
          placeholder={s.chain === 'solana' ? 'base58 mint address…' : '0x token contract…'}
          value={s.tokenAddress} onChange={str('tokenAddress')} />

        {/* Checking indicator */}
        {checking && (
          <p className="mt-1.5 text-xs text-zinc-500">Checking bot balance…</p>
        )}

        {/* Balance found */}
        {!checking && tokenInfo && !hasNoTokenBalance && (
          <p className="mt-1.5 text-xs text-brand-400">
            Bot holds: {parseFloat(tokenInfo.balance).toLocaleString()} {tokenInfo.symbol}
          </p>
        )}

        {/* Insufficient balance warning */}
        {!checking && hasNoTokenBalance && tokenInfo && (
          <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-amber-300">
                  Bot has no {tokenInfo.symbol} — send tokens to proceed
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  The bot needs {tokenInfo.symbol} in its wallet to create the liquidity pool and trade.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-2.5 py-2">
              <span className="text-xs font-mono text-zinc-300 flex-1 break-all">{tokenInfo.botAddress}</span>
              <CopyBtn text={tokenInfo.botAddress} />
            </div>
            <p className="text-xs text-zinc-600">
              After sending, wait for confirmation then proceed.
            </p>
          </div>
        )}
      </div>

      {/* Stable / pair token */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">Paired With</label>
        <div className="flex gap-2 flex-wrap mb-2">
          {stables.map(([label, addr]) => (
            <button key={label} type="button" onClick={() => setS(p => ({ ...p, stableAddress: addr }))}
              className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                s.stableAddress === addr
                  ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                  : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
              {label}
            </button>
          ))}
        </div>
        <input className="input font-mono text-xs"
          placeholder={s.chain === 'solana' ? 'Any mint address…' : 'Any ERC-20 address…'}
          value={s.stableAddress} onChange={str('stableAddress')} />
      </div>

      {/* Pair address (EVM) */}
      {isEvm && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-zinc-400">Pair Address</label>
            {!s.pairAddress && (
              <button type="button" onClick={onPoolNeeded}
                className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
                Set up pool ↓
              </button>
            )}
          </div>
          <input className="input font-mono text-xs" placeholder="0x… (set via Pool section below)"
            value={s.pairAddress} onChange={str('pairAddress')} />
        </div>
      )}

      {/* Target price */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Target Price ($)</label>
          <input type="number" step="0.000001" className="input"
            value={s.targetPeg} onChange={num('targetPeg')} />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Band (±%)</label>
          <input type="number" step="0.001" className="input"
            value={s.upperBand} onChange={num('upperBand')} />
        </div>
      </div>

      {/* Approve tokens (EVM only, shown when pair is set) */}
      {isEvm && s.tokenAddress && s.stableAddress && (
        <button type="button" onClick={handleApprove} disabled={approving}
          className="btn-ghost w-full text-sm disabled:opacity-40">
          {approving ? 'Approving…' : 'Approve Tokens for Router'}
        </button>
      )}

      {/* Advanced limits (collapsed) */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button type="button" onClick={() => setLimitsOpen(v => !v)}
          className="flex items-center justify-between w-full px-4 py-3 text-xs text-zinc-500 font-medium">
          Advanced Limits
          {limitsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {limitsOpen && (
          <div className="px-4 pb-4 grid grid-cols-2 gap-3 border-t border-zinc-800">
            {([
              ['Max trade (tokens)',  'maxTradeSizeTokens',  '1'],
              ['Daily limit ($)',     'maxDailySpendUsd',    '1'],
              ['Min liquidity ($)',   'minLiquidityUsd',     '100'],
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
        )}
      </div>

      <button type="submit" className="btn-primary w-full">Save</button>
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
  const [busy,      setBusy]      = useState(false);
  const [tokenAmt,  setTokenAmt]  = useState('');
  const [stableAmt, setStableAmt] = useState('');
  const [poolId,    setPoolId]    = useState(settings.pairAddress ?? '');
  const [result,    setResult]    = useState<{ pairAddress: string; isNewPair: boolean; liquidityTxHash: string } | null>(null);

  const chain = settings.chain;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  const openingPrice = parseFloat(tokenAmt) > 0 && parseFloat(stableAmt) > 0
    ? (parseFloat(stableAmt) / parseFloat(tokenAmt)).toFixed(8) : null;

  const canCreate = !!(settings.tokenAddress && settings.stableAddress && (isEvm ? settings.routerAddress : true));

  async function handleFind() {
    setBusy(true);
    try {
      const res = await findPegPair() as { found: boolean; pairAddress: string };
      if (res.found) {
        onPairUpdated(res.pairAddress);
        setPoolId(res.pairAddress);
        toast.success(chain === 'solana' ? 'Pool found on Raydium' : `Pair found`);
      } else {
        toast('No existing pool — create one below', { icon: 'ℹ️' });
      }
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Error'); }
    setBusy(false);
  }

  async function handleInit() {
    const ta = parseFloat(tokenAmt), sa = parseFloat(stableAmt);
    if (!ta || !sa) { toast.error('Enter both amounts'); return; }
    setBusy(true);
    try {
      const res = await initPool(ta, sa) as typeof result;
      onPairUpdated(res!.pairAddress);
      setPoolId(res!.pairAddress);
      setResult(res);
      toast.success(res!.isNewPair ? 'Pool created & liquidity added!' : 'Liquidity added!');
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
    setBusy(false);
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Chain tabs */}
      <div className="flex gap-2">
        {([['bsc', 'PancakeSwap'], ['ethereum', 'Uniswap V2'], ['solana', 'Raydium']] as [PegChain, string][]).map(([c, label]) => (
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

      {/* Pool info */}
      {(poolId && poolId !== 'FOUND_VIA_JUPITER') ? (
        <div className="surface flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-brand-400 shrink-0" />
          <span className="text-xs text-zinc-400 font-mono flex-1 break-all">{poolId}</span>
          <CopyBtn text={poolId} />
        </div>
      ) : (
        <button onClick={handleFind} disabled={busy || !settings.tokenAddress || !settings.stableAddress}
          className="btn-ghost w-full text-sm disabled:opacity-40">
          <Search className="h-4 w-4" />
          {busy ? 'Searching…' : chain === 'solana' ? 'Find pool on Raydium' : 'Find existing pair'}
        </button>
      )}

      {/* Add / Create liquidity */}
      <div className="space-y-3">
        <p className="text-xs text-zinc-500 font-medium">
          {poolId ? 'Add more liquidity' : `Create ${chain === 'solana' ? 'Raydium pool' : `${DEX[chain]} pair`}`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Token amount</label>
            <input type="number" min="0" step="any" placeholder="e.g. 1000000"
              value={tokenAmt} onChange={e => setTokenAmt(e.target.value)} className="input" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Stable amount</label>
            <input type="number" min="0" step="any" placeholder="e.g. 1000"
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
          {busy ? 'Sending…' : poolId ? 'Add Liquidity' : 'Create Pool & Add Liquidity'}
        </button>

        {!canCreate && (
          <p className="text-xs text-center text-amber-400">Complete Setup (token + stable) first</p>
        )}
      </div>

      {/* Tx result */}
      {result && (
        <div className="surface border border-brand-500/20 space-y-1.5">
          <p className="text-xs text-brand-400 font-medium">
            {result.isNewPair ? '✓ Pool created & liquidity added' : '✓ Liquidity added'}
          </p>
          <p className="text-xs font-mono text-zinc-500 break-all">{result.pairAddress}</p>
          {result.liquidityTxHash && result.liquidityTxHash !== result.pairAddress && (
            <a href={EXPLORER[chain](result.liquidityTxHash)} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
              View transaction <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
