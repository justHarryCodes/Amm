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
  Clock, ExternalLink, Copy, Check, AlertCircle, Loader2,
  ChevronDown, ChevronUp, Search, Droplets,
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
  bsc: CHAIN_TOKENS.bsc.dex, ethereum: CHAIN_TOKENS.ethereum.dex, solana: CHAIN_TOKENS.solana.dex,
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

  async function saveSettings(s: PegSettings) {
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

  return (
    <div className="page">

      {/* ── BOT STATUS ─────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={clsx('h-2 w-2 rounded-full shrink-0', STATE_DOT[state])} />
            <span className="text-sm font-semibold text-zinc-200">{state.replace(/_/g, ' ')}</span>
            <span className={clsx('badge text-xs', CHAIN_BADGE[chain])}>
              {chain === 'bsc' ? 'BSC' : chain === 'ethereum' ? 'ETH' : 'SOL'} · {DEX[chain]}
            </span>
          </div>
          {price != null ? (
            <div className="text-right">
              <p className="text-xl font-bold font-mono text-zinc-50 leading-none">${price.toFixed(6)}</p>
              <p className={clsx('text-xs mt-0.5 font-medium', inRange ? 'text-brand-400' : 'text-amber-400')}>
                {dev != null ? `${dev >= 0 ? '▲' : '▼'} ${Math.abs(dev).toFixed(3)}% from peg` : ''}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No price data</p>
          )}
        </div>

        {/* Range bar */}
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
              <span>target ${target.toFixed(5)}</span>
              <span>${status.upperBound.toFixed(5)}</span>
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
          <p className="mt-2 text-center text-xs text-zinc-600">Complete setup below to enable trading</p>
        )}
        {/* Mini stats when running */}
        {status && state !== 'STOPPED' && (
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
      </div>

      {/* ── PAIR SETUP ─────────────────────────────────── */}
      {settings && (
        <PairCard settings={settings} onSave={saveSettings} />
      )}

      {/* ── POOL / LIQUIDITY ───────────────────────────── */}
      {settings && (
        <PoolCard settings={settings} onPairUpdated={pair => setSettings(s => s ? { ...s, pairAddress: pair } : s)} />
      )}

      {/* ── RECENT TRADES ──────────────────────────────── */}
      <TradeHistory trades={trades} chain={chain} />
    </div>
  );
}

// ── Pair Setup Card ───────────────────────────────────────────────────────────
function PairCard({ settings, onSave }: { settings: PegSettings; onSave: (s: PegSettings) => void }) {
  const [s, setS]           = useState(settings);
  const [open, setOpen]     = useState(false);
  const dirty = useRef(false);

  useEffect(() => { if (!dirty.current) setS(settings); }, [settings]);

  const str = (k: keyof PegSettings) => (v: string) => { dirty.current = true; setS(p => ({ ...p, [k]: v })); };
  const num = (k: keyof PegSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    dirty.current = true; setS(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }));
  };

  function switchChain(c: PegChain) {
    dirty.current = false;
    setS(p => ({ ...p, chain: c, tokenAddress: '', pairAddress: '',
      stableAddress: c === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '',
      routerAddress: DEFAULT_ROUTER[c] }));
  }

  const stables = [
    ['USDC', CHAIN_TOKENS[s.chain].usdc.address],
    ['USDT', CHAIN_TOKENS[s.chain].usdt.address],
    [CHAIN_TOKENS[s.chain].wNative.symbol, CHAIN_TOKENS[s.chain].wNative.address],
  ] as [string, string][];

  return (
    <form onSubmit={e => { e.preventDefault(); dirty.current = false; onSave(s); }} className="card space-y-4">
      <p className="font-semibold text-zinc-100 text-sm">Pair Setup</p>

      <ChainTabs value={s.chain} onChange={switchChain} />

      <TokenBox
        label="Token to Peg"
        value={s.tokenAddress}
        placeholder={s.chain === 'solana' ? 'Token mint address…' : '0x token contract…'}
        onChange={str('tokenAddress')}
        chain={s.chain}
      />

      {/* Stable picker */}
      <div>
        <p className="text-xs text-zinc-500 mb-2 font-medium">Paired With</p>
        <div className="flex gap-2 mb-2">
          {stables.map(([label, addr]) => (
            <button key={label} type="button" onClick={() => { dirty.current = true; setS(p => ({ ...p, stableAddress: addr })); }}
              className={clsx('flex-1 py-1.5 rounded-xl text-xs font-semibold border transition-colors',
                s.stableAddress === addr
                  ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                  : 'border-zinc-800 text-zinc-500 hover:text-zinc-300')}>
              {label}
            </button>
          ))}
        </div>
        <TokenBox
          label="Stable Address"
          value={s.stableAddress}
          placeholder={s.chain === 'solana' ? 'Stable mint…' : '0x stable contract…'}
          onChange={str('stableAddress')}
          chain={s.chain}
        />
      </div>

      {/* Pair address (EVM) */}
      {(s.chain === 'bsc' || s.chain === 'ethereum') && (
        <div>
          <p className="text-xs text-zinc-500 mb-2 font-medium">Pair Address</p>
          <input className="input font-mono text-xs"
            placeholder="0x… (set via Pool section below)"
            value={s.pairAddress} onChange={e => { dirty.current = true; setS(p => ({ ...p, pairAddress: e.target.value })); }} />
        </div>
      )}

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

      {/* Advanced limits */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button type="button" onClick={() => setOpen(v => !v)}
          className="flex items-center justify-between w-full px-4 py-3 text-xs text-zinc-500 font-medium">
          Advanced Limits
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {open && (
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

      <button type="submit" className="btn-primary w-full">Save Settings</button>
    </form>
  );
}

// ── Pool Card ─────────────────────────────────────────────────────────────────
function PoolCard({
  settings, onPairUpdated,
}: {
  settings: PegSettings;
  onPairUpdated: (pair: string) => void;
}) {
  const [open,      setOpen]      = useState(!settings.pairAddress);
  const [busy,      setBusy]      = useState(false);
  const [approving, setApproving] = useState(false);
  const [tokenAmt,  setTokenAmt]  = useState('');
  const [stableAmt, setStableAmt] = useState('');

  const chain = settings.chain;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  // Live balance checks for pre-flight
  const { info: tokenInfo }  = useTokenBalance(settings.tokenAddress, chain);
  const { info: stableInfo } = useTokenBalance(settings.stableAddress, chain);

  const tokenNeed  = parseFloat(tokenAmt)  || 0;
  const stableNeed = parseFloat(stableAmt) || 0;
  const tokenBal   = parseFloat(tokenInfo?.balance  ?? '0');
  const stableBal  = parseFloat(stableInfo?.balance ?? '0');

  const tokenShort  = tokenNeed  > 0 && tokenBal  < tokenNeed;
  const stableShort = stableNeed > 0 && stableBal < stableNeed;
  const hasShortfall = tokenShort || stableShort;

  const openingPrice = tokenNeed > 0 && stableNeed > 0
    ? (stableNeed / tokenNeed).toFixed(8) : null;

  const canCreate = !!(settings.tokenAddress && settings.stableAddress && (isEvm || chain === 'solana'));

  async function handleFind() {
    setBusy(true);
    try {
      const res = await findPegPair() as { found: boolean; pairAddress: string };
      if (res.found) { onPairUpdated(res.pairAddress); toast.success('Pair found!'); }
      else toast('No existing pool found — create one below', { icon: 'ℹ️' });
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Error'); }
    setBusy(false);
  }

  async function handleApprove() {
    setApproving(true);
    try {
      const res = await approvePegTokens() as { alreadyApproved: boolean };
      toast.success(res.alreadyApproved ? 'Already approved' : 'Tokens approved ✓');
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Approval failed'); }
    setApproving(false);
  }

  async function handleInit() {
    if (!tokenNeed || !stableNeed) { toast.error('Enter both amounts'); return; }
    if (hasShortfall) { toast.error('Insufficient bot balance — send tokens first'); return; }
    setBusy(true);
    try {
      const res = await initPool(tokenNeed, stableNeed) as { pairAddress: string; isNewPair: boolean; liquidityTxHash: string };
      onPairUpdated(res.pairAddress);
      toast.success(res.isNewPair ? 'Pool created & liquidity added!' : 'Liquidity added!');
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
    setBusy(false);
  }

  return (
    <div className="card">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          <Droplets className="h-4 w-4 text-blue-400" />
          <span className="font-semibold text-zinc-100 text-sm">Pool Liquidity</span>
          {settings.pairAddress
            ? <span className="text-xs text-brand-400 font-medium">✓ Pair set</span>
            : <span className="badge badge-yellow text-xs">Not set</span>}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-zinc-500" /> : <ChevronDown className="h-4 w-4 text-zinc-500" />}
      </button>

      {!open && settings.pairAddress && settings.pairAddress !== 'FOUND_VIA_JUPITER' && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs font-mono text-zinc-600 flex-1 truncate">{settings.pairAddress}</span>
          <CopyBtn text={settings.pairAddress} />
        </div>
      )}

      {open && (
        <div className="mt-4 space-y-4">
          {/* Find pair */}
          {!settings.pairAddress && (
            <button onClick={handleFind} disabled={busy || !settings.tokenAddress || !settings.stableAddress}
              className="btn-ghost w-full text-sm disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {busy ? 'Searching…' : chain === 'solana' ? 'Find pool on Raydium' : 'Find existing pair'}
            </button>
          )}

          {settings.pairAddress && settings.pairAddress !== 'FOUND_VIA_JUPITER' && (
            <div className="surface flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-brand-400 shrink-0" />
              <span className="text-xs font-mono text-zinc-400 flex-1 break-all">{settings.pairAddress}</span>
              <CopyBtn text={settings.pairAddress} />
            </div>
          )}

          {/* Liquidity amounts */}
          <div>
            <p className="text-xs text-zinc-500 font-medium mb-3">
              {settings.pairAddress ? 'Add more liquidity' : `Create ${chain === 'solana' ? 'Raydium pool' : `${DEX[chain]} pair`}`}
            </p>

            {/* Token amount row */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 mb-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-500">Token amount</span>
                {tokenInfo && (
                  <span className={clsx('text-xs font-medium', tokenShort ? 'text-amber-400' : 'text-zinc-500')}>
                    Bal: {parseFloat(tokenInfo.balance).toLocaleString()} {tokenInfo.symbol}
                  </span>
                )}
              </div>
              <input type="number" min="0" step="any" placeholder="0.0"
                value={tokenAmt} onChange={e => setTokenAmt(e.target.value)}
                className="w-full bg-transparent text-xl font-bold text-zinc-100 placeholder-zinc-700 outline-none" />
              {tokenShort && tokenInfo && (
                <p className="mt-1 text-xs text-amber-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Need {(tokenNeed - tokenBal).toLocaleString()} more {tokenInfo.symbol}
                </p>
              )}
            </div>

            {/* Stable amount row */}
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-500">Stable amount</span>
                {stableInfo && (
                  <span className={clsx('text-xs font-medium', stableShort ? 'text-amber-400' : 'text-zinc-500')}>
                    Bal: {parseFloat(stableInfo.balance).toLocaleString()} {stableInfo.symbol}
                  </span>
                )}
              </div>
              <input type="number" min="0" step="any" placeholder="0.0"
                value={stableAmt} onChange={e => setStableAmt(e.target.value)}
                className="w-full bg-transparent text-xl font-bold text-zinc-100 placeholder-zinc-700 outline-none" />
              {stableShort && stableInfo && (
                <p className="mt-1 text-xs text-amber-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Need {(stableNeed - stableBal).toLocaleString()} more {stableInfo.symbol}
                </p>
              )}
            </div>

            {openingPrice && (
              <div className="flex items-center justify-between mt-3 px-1">
                <span className="text-xs text-zinc-600">Opening price</span>
                <span className="text-sm font-bold font-mono text-brand-400">${openingPrice} / token</span>
              </div>
            )}
          </div>

          {/* Shortfall warning */}
          {hasShortfall && (tokenInfo || stableInfo) && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 space-y-1.5">
              <p className="text-xs text-amber-300 font-medium flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4" /> Insufficient bot balance
              </p>
              <p className="text-xs text-zinc-500">
                Send the required tokens to the bot wallet before creating the pool.
              </p>
              {(tokenInfo || stableInfo) && (
                <div className="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-2.5 py-2">
                  <span className="text-xs font-mono text-zinc-400 flex-1 break-all">
                    {tokenInfo?.botAddress ?? stableInfo?.botAddress}
                  </span>
                  <CopyBtn text={tokenInfo?.botAddress ?? stableInfo?.botAddress ?? ''} />
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {isEvm && settings.tokenAddress && settings.stableAddress && (
              <button type="button" onClick={handleApprove} disabled={approving || busy}
                className="btn-ghost flex-1 text-sm disabled:opacity-40">
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 text-brand-400" />}
                {approving ? 'Approving…' : 'Approve'}
              </button>
            )}
            <button onClick={handleInit}
              disabled={busy || !canCreate || !tokenAmt || !stableAmt || hasShortfall}
              className="btn-primary flex-1 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Droplets className="h-4 w-4" />}
              {busy ? 'Sending…' : settings.pairAddress ? 'Add Liquidity' : 'Create Pool'}
            </button>
          </div>
          {!canCreate && (
            <p className="text-xs text-center text-amber-400">Set token + stable in Pair Setup first</p>
          )}
        </div>
      )}
    </div>
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
                    t.action === 'BUY' ? 'bg-brand-500/10 text-brand-400' : 'bg-red-500/10 text-red-400',
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
      )}
    </div>
  );
}
