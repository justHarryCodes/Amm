'use client';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Shield, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { getAppSettings, updateAppSettings } from '@/lib/api';
import clsx from 'clsx';

interface AppSettings {
  evmNetwork:    'mainnet' | 'testnet';
  solanaNetwork: 'mainnet-beta' | 'devnet';
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    getAppSettings().then(setSettings).catch(() => {});
  }, []);

  async function setEvmNetwork(value: 'mainnet' | 'testnet') {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await updateAppSettings({ evmNetwork: value });
      setSettings(updated);
      toast.success(`EVM switched to ${value}`);
    } catch (e: unknown) { toast.error((e as Error).message); }
    setSaving(false);
  }

  async function setSolanaNetwork(value: 'mainnet-beta' | 'devnet') {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await updateAppSettings({ solanaNetwork: value });
      setSettings(updated);
      toast.success(`Solana switched to ${value}`);
    } catch (e: unknown) { toast.error((e as Error).message); }
    setSaving(false);
  }

  const evmTestnet     = settings?.evmNetwork === 'testnet';
  const solanaTestnet  = settings?.solanaNetwork === 'devnet';
  const anyTestnet     = evmTestnet || solanaTestnet;

  return (
    <div className="page">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="h-5 w-5 text-brand-400" />
        <div>
          <h1 className="text-xl font-bold text-zinc-50">Settings</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Network and environment configuration</p>
        </div>
      </div>

      {/* Testnet warning banner */}
      {anyTestnet && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-300 space-y-0.5">
            <p className="font-semibold">Testnet mode active</p>
            <p className="text-amber-400/80">
              {evmTestnet && 'BSC and Ethereum are on testnet (BSC Testnet / Sepolia). '}
              {solanaTestnet && 'Solana is on devnet. '}
              Real transactions will not be executed. Switch to Mainnet before going live.
            </p>
          </div>
        </div>
      )}

      {!settings ? (
        <div className="card flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
        </div>
      ) : (
        <>
          {/* EVM (BSC + Ethereum) */}
          <div className="card space-y-4">
            <div>
              <p className="font-semibold text-zinc-100 text-sm">EVM — BSC & Ethereum</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Affects BSC (PancakeSwap V2) and Ethereum (Uniswap V2) connections.
              </p>
            </div>

            <div className="flex gap-2">
              <NetworkButton
                label="Mainnet"
                description="BSC Mainnet · Ethereum Mainnet"
                active={settings.evmNetwork === 'mainnet'}
                variant="mainnet"
                disabled={saving}
                onClick={() => setEvmNetwork('mainnet')}
              />
              <NetworkButton
                label="Testnet"
                description="BSC Testnet (97) · Sepolia (11155111)"
                active={settings.evmNetwork === 'testnet'}
                variant="testnet"
                disabled={saving}
                onClick={() => setEvmNetwork('testnet')}
              />
            </div>

            <div className="surface text-xs text-zinc-500 space-y-1">
              <p className="font-medium text-zinc-400">Active RPC endpoints</p>
              {settings.evmNetwork === 'mainnet' ? (
                <>
                  <p>BSC: <span className="font-mono text-zinc-300">bsc-dataseed.binance.org</span></p>
                  <p>ETH: <span className="font-mono text-zinc-300">eth.llamarpc.com</span></p>
                </>
              ) : (
                <>
                  <p>BSC: <span className="font-mono text-zinc-300">data-seed-prebsc-1-s1.binance.org:8545</span></p>
                  <p>ETH: <span className="font-mono text-zinc-300">Sepolia (11155111)</span></p>
                </>
              )}
            </div>
          </div>

          {/* Solana */}
          <div className="card space-y-4">
            <div>
              <p className="font-semibold text-zinc-100 text-sm">Solana</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Affects Raydium CPMM pool, Jupiter swaps, and bulk sender.
              </p>
            </div>

            <div className="flex gap-2">
              <NetworkButton
                label="Mainnet"
                description="mainnet-beta · Raydium live pools"
                active={settings.solanaNetwork === 'mainnet-beta'}
                variant="mainnet"
                disabled={saving}
                onClick={() => setSolanaNetwork('mainnet-beta')}
              />
              <NetworkButton
                label="Devnet"
                description="devnet · test tokens only"
                active={settings.solanaNetwork === 'devnet'}
                variant="testnet"
                disabled={saving}
                onClick={() => setSolanaNetwork('devnet')}
              />
            </div>

            <div className="surface text-xs text-zinc-500 space-y-1">
              <p className="font-medium text-zinc-400">Active RPC</p>
              {settings.solanaNetwork === 'mainnet-beta' ? (
                <p className="font-mono text-zinc-300">api.mainnet-beta.solana.com (or Alchemy if key set)</p>
              ) : (
                <p className="font-mono text-zinc-300">api.devnet.solana.com (or Alchemy devnet if key set)</p>
              )}
            </div>
          </div>

          {/* Status summary */}
          <div className="card">
            <p className="font-semibold text-zinc-100 text-sm mb-3">Current Status</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['BSC / ETH', settings.evmNetwork],
                ['Solana',    settings.solanaNetwork],
              ].map(([label, val]) => (
                <div key={label} className="surface flex items-center gap-2">
                  {val === 'mainnet' || val === 'mainnet-beta'
                    ? <CheckCircle  className="h-4 w-4 text-brand-400 shrink-0" />
                    : <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />}
                  <div>
                    <p className="text-xs text-zinc-500">{label}</p>
                    <p className={clsx('text-xs font-semibold mt-0.5',
                      val === 'mainnet' || val === 'mainnet-beta' ? 'text-brand-400' : 'text-amber-400')}>
                      {val}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </>
      )}
    </div>
  );
}

function NetworkButton({
  label, description, active, variant, disabled, onClick,
}: {
  label: string; description: string; active: boolean;
  variant: 'mainnet' | 'testnet'; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || active}
      className={clsx(
        'flex-1 text-left px-4 py-3 rounded-xl border transition-colors',
        active && variant === 'mainnet' && 'border-brand-500 bg-brand-500/10',
        active && variant === 'testnet' && 'border-amber-500 bg-amber-500/10',
        !active && 'border-zinc-800 bg-zinc-900 hover:border-zinc-600',
        disabled && 'opacity-50 cursor-not-allowed',
      )}>
      <p className={clsx('text-sm font-semibold',
        active && variant === 'mainnet' ? 'text-brand-300' :
        active && variant === 'testnet' ? 'text-amber-300' : 'text-zinc-300')}>
        {label}
      </p>
      <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
    </button>
  );
}
