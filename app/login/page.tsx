'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage } from 'wagmi';
import { Zap, Shield } from 'lucide-react';

export default function LoginPage() {
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const { address, isConnected } = useAccount();
  const { signMessageAsync }     = useSignMessage();

  async function handleSignIn() {
    if (!isConnected || !address) return;
    setError('');
    setLoading(true);

    try {
      const timestamp = Date.now();
      const message   = `Sign in to PegBot\n\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ message });

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, signature, timestamp }),
      });

      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Sign-in failed');
      } else {
        router.replace('/');
      }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? '';
      if (msg.includes('rejected') || msg.includes('denied')) {
        setError('Signature rejected in wallet');
      } else {
        setError(msg || 'Sign-in failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-6">

        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-2xl font-bold text-zinc-100">
            <Zap className="h-6 w-6 text-brand-400" />
            PegBot
          </div>
          <p className="text-sm text-zinc-500">Connect your admin wallet to continue</p>
        </div>

        <div className="card space-y-5">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Shield className="h-3.5 w-3.5 shrink-0" />
            You&apos;ll sign a message — no gas fee, no transaction.
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-2">Your wallet</p>
            <ConnectButton />
          </div>

          {isConnected && (
            <button
              onClick={handleSignIn}
              disabled={loading}
              className="btn-primary w-full disabled:opacity-50"
            >
              {loading ? 'Waiting for signature…' : 'Sign In'}
            </button>
          )}

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <p className="text-center text-xs text-zinc-700">
          Access restricted to the address set in{' '}
          <code className="text-zinc-500">ADMIN_ADDRESS</code>
        </p>
      </div>
    </div>
  );
}
