'use client';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { getAppSettings, updateAppSettings } from '@/lib/api';
import clsx from 'clsx';

interface AppSettings {
  evmNetwork:    'mainnet' | 'testnet';
  solanaNetwork: 'mainnet-beta' | 'devnet';
}

export default function SettingsPage() {
  const [settings, setSetting] = useState<AppSettings | null>(null);
  const [saving,   setSaving]  = useState(false);

  useEffect(() => { getAppSettings().then(setSetting).catch(() => {}); }, []);

  async function toggle(key: keyof AppSettings, value: string) {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await updateAppSettings({ [key]: value });
      setSetting(updated);
    } catch (e: unknown) { toast.error((e as Error).message); }
    setSaving(false);
  }

  if (!settings) return (
    <div className="page">
      <div className="card flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      </div>
    </div>
  );

  const anyTestnet = settings.evmNetwork === 'testnet' || settings.solanaNetwork === 'devnet';

  return (
    <div className="page">

      <h1 className="text-xl font-bold text-zinc-50">Network</h1>

      {anyTestnet && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Testnet active — real transactions disabled
        </div>
      )}

      <div className="card space-y-4">
        {/* EVM */}
        <div>
          <p className="text-xs text-zinc-500 mb-2">BSC & Ethereum</p>
          <div className="flex gap-2">
            {(['mainnet', 'testnet'] as const).map(v => (
              <button key={v} disabled={saving} onClick={() => toggle('evmNetwork', v)}
                className={clsx('flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors',
                  settings.evmNetwork === v
                    ? v === 'mainnet' ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                                     : 'border-amber-500 bg-amber-500/10 text-amber-300'
                    : 'border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200')}>
                {v === 'mainnet' ? 'Mainnet' : 'Testnet'}
              </button>
            ))}
          </div>
        </div>

        {/* Solana */}
        <div>
          <p className="text-xs text-zinc-500 mb-2">Solana</p>
          <div className="flex gap-2">
            {([['mainnet-beta', 'Mainnet'], ['devnet', 'Devnet']] as const).map(([v, label]) => (
              <button key={v} disabled={saving} onClick={() => toggle('solanaNetwork', v)}
                className={clsx('flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors',
                  settings.solanaNetwork === v
                    ? v === 'mainnet-beta' ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                                          : 'border-amber-500 bg-amber-500/10 text-amber-300'
                    : 'border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200')}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
