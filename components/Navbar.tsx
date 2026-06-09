'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getAppSettings } from '@/lib/api';
import { LayoutDashboard, Activity, Send, Coins, Wallet, Zap, Settings } from 'lucide-react';
import clsx from 'clsx';
import { useSSE } from '@/hooks/useSSE';
import { WalletPanel } from './WalletPanel';

const NAV = [
  { href: '/',       label: 'Home',   icon: LayoutDashboard },
  { href: '/peg',    label: 'Peg',    icon: Activity },
  { href: '/bulk',   label: 'BNB',    icon: Send },
  { href: '/solana', label: 'Solana', icon: Coins },
];

export default function Navbar() {
  const path = usePathname();
  const { connected } = useSSE();
  const [walletOpen, setWalletOpen] = useState(false);
  const [testnet, setTestnet] = useState(false);

  useEffect(() => {
    getAppSettings()
      .then((s: { evmNetwork: string; solanaNetwork: string }) => {
        setTestnet(s.evmNetwork === 'testnet' || s.solanaNetwork === 'devnet');
      })
      .catch(() => {});
  }, [path]);

  return (
    <>
      {/* ── Desktop top bar ─────────────────────────────── */}
      <header className="hidden md:flex sticky top-0 z-40 h-14 items-center border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-xl px-6 gap-4">
        <div className="flex items-center gap-2 font-bold text-zinc-100 mr-2">
          <Zap className="h-5 w-5 text-brand-400" />
          PegBot
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                path === href ? 'bg-brand-500/10 text-brand-400' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
              )}>
              <Icon className="h-4 w-4" />{label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {testnet && (
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
              TESTNET
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-zinc-600">
            <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-brand-400' : 'bg-zinc-600')} />
            {connected ? 'Live' : 'Offline'}
          </span>
          <Link href="/settings"
            className={clsx(
              'p-2 rounded-lg transition-colors',
              path === '/settings' ? 'bg-brand-500/10 text-brand-400' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            )}>
            <Settings className="h-4 w-4" />
          </Link>
          <button onClick={() => setWalletOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors">
            <Wallet className="h-4 w-4 text-brand-400" />Wallet
          </button>
        </div>
      </header>

      {/* ── Mobile top bar ───────────────────────────────── */}
      <header className="md:hidden flex sticky top-0 z-40 h-14 items-center justify-between border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-xl px-4">
        <div className="flex items-center gap-2 font-bold text-zinc-100">
          <Zap className="h-5 w-5 text-brand-400" />PegBot
        </div>
        <div className="flex items-center gap-2">
          {testnet && (
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
              TESTNET
            </span>
          )}
          <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-brand-400' : 'bg-zinc-600')} />
          <Link href="/settings"
            className={clsx(
              'p-2 rounded-lg transition-colors',
              path === '/settings' ? 'text-brand-400' : 'text-zinc-400'
            )}>
            <Settings className="h-4 w-4" />
          </Link>
          <button onClick={() => setWalletOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium bg-zinc-800 text-zinc-200">
            <Wallet className="h-4 w-4 text-brand-400" />Wallet
          </button>
        </div>
      </header>

      {/* ── Mobile bottom tab bar (no Wallet, no Settings) ── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-zinc-900/95 backdrop-blur-xl border-t border-zinc-800 flex">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}
            className={clsx(
              'flex flex-col items-center justify-center gap-1 flex-1 py-3 text-xs font-medium transition-colors',
              path === href ? 'text-brand-400' : 'text-zinc-500'
            )}>
            <Icon className="h-5 w-5" />{label}
          </Link>
        ))}
      </nav>

      <WalletPanel open={walletOpen} onClose={() => setWalletOpen(false)} />
    </>
  );
}
