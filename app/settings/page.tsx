'use client';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, Loader2, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { getAppSettings, updateAppSettings, getAdminWallets, addAdminWallet, removeAdminWallet } from '@/lib/api';
import clsx from 'clsx';

interface AppSettings {
  evmNetwork:    'mainnet' | 'testnet';
  solanaNetwork: 'mainnet-beta' | 'devnet';
}

interface AdminWallet { address: string; addedAt: string }
interface AdminWalletsData { root: string; wallets: AdminWallet[] }

export default function SettingsPage() {
  const [settings, setSetting]   = useState<AppSettings | null>(null);
  const [saving,   setSaving]    = useState(false);

  const [admins,       setAdmins]      = useState<AdminWalletsData | null>(null);
  const [newAddr,      setNewAddr]     = useState('');
  const [addingAdmin,  setAddingAdmin] = useState(false);
  const [removingAddr, setRemoving]    = useState<string | null>(null);

  useEffect(() => {
    getAppSettings().then(setSetting).catch(() => {});
    getAdminWallets().then(setAdmins).catch(() => {});
  }, []);

  async function toggle(key: keyof AppSettings, value: string) {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await updateAppSettings({ [key]: value });
      setSetting(updated);
    } catch (e: unknown) { toast.error((e as Error).message); }
    setSaving(false);
  }

  async function handleAddAdmin() {
    const addr = newAddr.trim();
    if (!addr) return;
    setAddingAdmin(true);
    try {
      await addAdminWallet(addr);
      setAdmins(await getAdminWallets());
      setNewAddr('');
      toast.success('Admin wallet added');
    } catch (e: unknown) { toast.error((e as Error).message); }
    setAddingAdmin(false);
  }

  async function handleRemoveAdmin(address: string) {
    setRemoving(address);
    try {
      await removeAdminWallet(address);
      setAdmins(await getAdminWallets());
      toast.success('Admin wallet removed');
    } catch (e: unknown) { toast.error((e as Error).message); }
    setRemoving(null);
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

      {/* ── Admin Wallets ─────────────────────────────────── */}
      <h1 className="text-xl font-bold text-zinc-50 pt-2">Admin Wallets</h1>
      <p className="text-xs text-zinc-500 -mt-2">
        Additional wallets that can log in and control the bot. The root admin
        (<code className="text-zinc-400 font-mono">ADMIN_ADDRESS</code> env var) is always allowed and cannot be removed.
      </p>

      <div className="card space-y-3">
        {/* Root admin */}
        {admins?.root && (
          <div className="flex items-center gap-3 rounded-xl bg-brand-500/5 border border-brand-500/20 px-3 py-2.5">
            <ShieldCheck className="h-4 w-4 text-brand-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-brand-400 font-medium">Root Admin</p>
              <p className="text-xs font-mono text-zinc-300 truncate">{admins.root}</p>
            </div>
            <span className="text-xs text-zinc-600 shrink-0">permanent</span>
          </div>
        )}

        {admins === null && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
          </div>
        )}

        {admins?.wallets.length === 0 && (
          <p className="text-xs text-zinc-600 text-center py-2">No additional admins added yet</p>
        )}

        {admins?.wallets.map(w => (
          <div key={w.address} className="flex items-center gap-3 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-zinc-200 truncate">{w.address}</p>
              <p className="text-xs text-zinc-600 mt-0.5">Added {new Date(w.addedAt).toLocaleDateString()}</p>
            </div>
            <button
              onClick={() => void handleRemoveAdmin(w.address)}
              disabled={removingAddr === w.address}
              className="text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-40 p-1">
              {removingAddr === w.address
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}

        {/* Add new admin */}
        <div className="flex gap-2 pt-1 border-t border-zinc-800/60">
          <input
            className="input flex-1 font-mono text-xs"
            placeholder="0x… EVM wallet address"
            value={newAddr}
            onChange={e => setNewAddr(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleAddAdmin(); }}
          />
          <button
            onClick={() => void handleAddAdmin()}
            disabled={addingAdmin || !newAddr.trim()}
            className="btn-primary px-3 disabled:opacity-40 flex items-center gap-1.5 text-sm">
            {addingAdmin ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </button>
        </div>
      </div>

    </div>
  );
}
