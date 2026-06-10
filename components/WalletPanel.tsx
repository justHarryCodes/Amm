'use client';
import { useState, useEffect, useCallback } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useSendTransaction,
  useWriteContract,
  useReadContract,
  useChainId,
  useSwitchChain,
} from 'wagmi';
import { parseEther, parseUnits, isAddress } from 'viem';
import { bsc, mainnet } from 'viem/chains';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  Transaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { X, Wallet, ArrowDownToLine, ArrowUpFromLine, Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { CHAIN_TOKENS } from '@/lib/tokens';


const ERC20_DECIMALS_ABI = [
  {
    name: 'decimals',
    type: 'function' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view' as const,
  },
];

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function' as const,
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable' as const,
  },
] as const;

interface BotBalances {
  evm?: {
    address: string;
    bsc: string;
    ethereum: string;
    tokenBalance: string;
    stableBalance: string;
    tokenAddress: string;
    stableAddress: string;
    bscUsdc: string;
    bscUsdt: string;
    ethUsdc: string;
    ethUsdt: string;
  };
  solana?: {
    address: string;
    sol: string;
    tokenBalance: string;
    stableBalance: string;
    tokenMint: string;
    stableMint: string;
    usdcBalance: string;
    usdtBalance: string;
  };
  errors: Record<string, string>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-brand-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function shortAddr(addr: string) {
  if (!addr) return '';
  return addr.length > 20 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

// ── EVM Section ────────────────────────────────────────────────────────────────

function EvmSection({ botInfo }: { botInfo: BotBalances | null }) {
  const { address: connectedAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const [activeChain, setActiveChain] = useState<'bsc' | 'ethereum'>('bsc');
  const [fundAsset, setFundAsset] = useState<'native' | 'token'>('native');
  const [fundToken, setFundToken] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [withdrawAsset, setWithdrawAsset] = useState<'native' | 'token'>('native');
  const [withdrawToken, setWithdrawToken] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  const targetChainId = activeChain === 'bsc' ? bsc.id : mainnet.id;
  const nativeSymbol = activeChain === 'bsc' ? 'BNB' : 'ETH';
  const botAddress = botInfo?.evm?.address ?? '';

  // Read ERC20 decimals for fund token
  const { data: fundDecimals } = useReadContract({
    address: (isAddress(fundToken) ? fundToken : undefined) as `0x${string}` | undefined,
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
    query: { enabled: isAddress(fundToken) },
  });

  const { sendTransaction, isPending: isSendingNative } = useSendTransaction({
    mutation: {
      onSuccess: (hash) => {
        toast.success(`Fund tx sent: ${hash.slice(0, 10)}…`);
        setFundAmount('');
      },
      onError: (e) => toast.error(e.message),
    },
  });

  const { writeContract, isPending: isSendingToken } = useWriteContract({
    mutation: {
      onSuccess: (hash) => {
        toast.success(`Fund tx sent: ${hash.slice(0, 10)}…`);
        setFundAmount('');
      },
      onError: (e) => toast.error(e.message),
    },
  });

  function ensureChain() {
    if (chainId !== targetChainId) {
      switchChain({ chainId: targetChainId });
      return false;
    }
    return true;
  }

  function handleFund() {
    if (!isConnected || !botAddress) return;
    if (!ensureChain()) return;
    const amt = parseFloat(fundAmount);
    if (isNaN(amt) || amt <= 0) return toast.error('Enter a valid amount');

    if (fundAsset === 'native') {
      sendTransaction({ to: botAddress as `0x${string}`, value: parseEther(fundAmount) });
    } else {
      if (!isAddress(fundToken)) return toast.error('Enter a valid token address');
      const dec = Number(fundDecimals ?? 18);
      writeContract({
        address: fundToken as `0x${string}`,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [botAddress as `0x${string}`, parseUnits(fundAmount, dec)],
      });
    }
  }

  async function handleWithdraw() {
    if (!isConnected || !connectedAddress) return toast.error('Connect your wallet first');
    if (isNaN(parseFloat(withdrawAmount)) || parseFloat(withdrawAmount) <= 0) {
      return toast.error('Enter a valid amount');
    }
    if (withdrawAsset === 'token' && !isAddress(withdrawToken)) {
      return toast.error('Enter a valid token address');
    }

    setWithdrawing(true);
    try {
      const res = await fetch('/api/wallet/withdraw/evm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain: activeChain,
          asset: withdrawAsset === 'native' ? 'native' : withdrawToken,
          amount: withdrawAmount,
          toAddress: connectedAddress,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Withdrawal sent: ${(data.txHash as string).slice(0, 10)}…`);
      setWithdrawAmount('');
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Connect */}
      <div className="card-sm">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-3">Your EVM Wallet</p>
        <ConnectButton />
        {isConnected && connectedAddress && (
          <p className="mt-2 text-xs text-zinc-500 font-mono">{connectedAddress}</p>
        )}
      </div>

      {/* Bot wallet info */}
      {botInfo?.evm && (
        <div className="card-sm">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-3">Bot EVM Wallet</p>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-zinc-400 font-mono">{shortAddr(botInfo.evm.address)}</span>
            <CopyButton text={botInfo.evm.address} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['BSC (BNB)', parseFloat(botInfo.evm.bsc).toFixed(4)],
              ['Ethereum (ETH)', parseFloat(botInfo.evm.ethereum).toFixed(4)],
              ...(botInfo.evm.tokenAddress ? [['Peg Token', parseFloat(botInfo.evm.tokenBalance).toFixed(4)]] : []),
              ...(botInfo.evm.stableAddress ? [['Stablecoin', parseFloat(botInfo.evm.stableBalance).toFixed(4)]] : []),
              // USDC/USDT shown for the active chain
              [`USDC (${activeChain === 'bsc' ? 'BSC' : 'ETH'})`,
                parseFloat(activeChain === 'bsc' ? botInfo.evm.bscUsdc : botInfo.evm.ethUsdc).toFixed(2)],
              [`USDT (${activeChain === 'bsc' ? 'BSC' : 'ETH'})`,
                parseFloat(activeChain === 'bsc' ? botInfo.evm.bscUsdt : botInfo.evm.ethUsdt).toFixed(2)],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="surface">
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="text-sm font-mono text-zinc-100 mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {botInfo?.errors?.evm && <p className="text-xs text-red-400">{botInfo.errors.evm}</p>}

      {/* Chain selector */}
      <div className="flex gap-2">
        {(['bsc', 'ethereum'] as const).map((c) => (
          <button key={c} onClick={() => setActiveChain(c)}
            className={clsx(
              'flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors',
              activeChain === c
                ? c === 'bsc' ? 'border-amber-500 bg-amber-500/10 text-amber-400' : 'border-blue-500 bg-blue-500/10 text-blue-400'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-200'
            )}>
            {c === 'bsc' ? 'BSC' : 'Ethereum'}
          </button>
        ))}
      </div>

      {/* Fund Bot */}
      {isConnected && (
        <div className="card-sm space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium flex items-center gap-2">
            <ArrowDownToLine className="h-3.5 w-3.5 text-brand-400" /> Fund Bot
          </p>
          <div className="flex gap-2">
            {(['native', 'token'] as const).map((a) => (
              <button key={a} onClick={() => setFundAsset(a)}
                className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
                  fundAsset === a ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
                {a === 'native' ? nativeSymbol : 'ERC-20'}
              </button>
            ))}
          </div>
          {fundAsset === 'token' && (
            <div className="space-y-2">
              {(botInfo?.evm?.tokenAddress || botInfo?.evm?.stableAddress) && (
                <div className="flex gap-1.5">
                  {botInfo?.evm?.tokenAddress && (
                    <button type="button" onClick={() => setFundToken(botInfo.evm!.tokenAddress)}
                      className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">
                      Peg Token
                    </button>
                  )}
                  {botInfo?.evm?.stableAddress && (
                    <button type="button" onClick={() => setFundToken(botInfo.evm!.stableAddress)}
                      className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">
                      Stable
                    </button>
                  )}
                </div>
              )}
              <input placeholder="Token contract address" value={fundToken}
                onChange={(e) => setFundToken(e.target.value)} className="input font-mono text-xs" />
            </div>
          )}
          <div className="flex gap-2">
            <input type="number" placeholder="Amount" value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)} className="input flex-1" />
            <button onClick={handleFund} disabled={isSendingNative || isSendingToken || !fundAmount}
              className="btn-primary px-4 text-sm disabled:opacity-40">
              {isSendingNative || isSendingToken ? 'Sending…' : 'Fund'}
            </button>
          </div>
        </div>
      )}

      {/* Withdraw from Bot */}
      <div className="card-sm space-y-3">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium flex items-center gap-2">
          <ArrowUpFromLine className="h-3.5 w-3.5 text-blue-400" /> Withdraw from Bot
        </p>
        {!isConnected && <p className="text-xs text-zinc-500">Connect your wallet to set the destination.</p>}
        <div className="flex gap-2">
          {(['native', 'token'] as const).map((a) => (
            <button key={a} onClick={() => setWithdrawAsset(a)}
              className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
                withdrawAsset === a ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
              {a === 'native' ? nativeSymbol : 'ERC-20'}
            </button>
          ))}
        </div>
        {withdrawAsset === 'token' && (
          <div className="space-y-2">
            {(botInfo?.evm?.tokenAddress || botInfo?.evm?.stableAddress) && (
              <div className="flex gap-1.5">
                {botInfo?.evm?.tokenAddress && (
                  <button type="button" onClick={() => setWithdrawToken(botInfo.evm!.tokenAddress)}
                    className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">
                    Peg Token
                  </button>
                )}
                {botInfo?.evm?.stableAddress && (
                  <button type="button" onClick={() => setWithdrawToken(botInfo.evm!.stableAddress)}
                    className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">
                    Stable
                  </button>
                )}
              </div>
            )}
            <input placeholder="Token contract address" value={withdrawToken}
              onChange={(e) => setWithdrawToken(e.target.value)} className="input font-mono text-xs" />
          </div>
        )}
        <div className="flex gap-2">
          <input type="number" placeholder="Amount" value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)} className="input flex-1" />
          <button onClick={handleWithdraw} disabled={withdrawing || !withdrawAmount}
            className="btn-primary px-4 text-sm disabled:opacity-40">
            {withdrawing ? 'Sending…' : 'Withdraw'}
          </button>
        </div>
        {isConnected && connectedAddress && (
          <p className="text-xs text-zinc-600">→ to: <span className="font-mono text-zinc-400">{shortAddr(connectedAddress)}</span></p>
        )}
      </div>
    </div>
  );
}

// ── Solana Section ─────────────────────────────────────────────────────────────

function SolanaSection({ botInfo }: { botInfo: BotBalances | null }) {
  const { publicKey, sendTransaction: sendWalletTx, connected } = useWallet();
  const { connection } = useConnection();

  const [fundAsset, setFundAsset] = useState<'sol' | 'spl'>('sol');
  const [fundMint, setFundMint] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [withdrawAsset, setWithdrawAsset] = useState<'sol' | 'spl'>('sol');
  const [withdrawMint, setWithdrawMint] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [funding, setFunding] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const botAddress = botInfo?.solana?.address ?? '';

  const USDC = CHAIN_TOKENS.solana.usdc.address;
  const USDT = CHAIN_TOKENS.solana.usdt.address;
  const WSOL = CHAIN_TOKENS.solana.wNative.address;

  async function handleFundSol() {
    if (!publicKey || !botAddress) return;
    const amt = parseFloat(fundAmount);
    if (isNaN(amt) || amt <= 0) return toast.error('Enter a valid amount');

    setFunding(true);
    try {
      const botPubkey = new PublicKey(botAddress);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: botPubkey,
          lamports: BigInt(Math.round(amt * LAMPORTS_PER_SOL)),
        })
      );
      const sig = await sendWalletTx(tx, connection);
      toast.success(`Funded! ${sig.slice(0, 10)}…`);
      setFundAmount('');
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setFunding(false);
    }
  }

  async function handleFundSpl() {
    if (!publicKey || !botAddress) return;
    const amt = parseFloat(fundAmount);
    if (isNaN(amt) || amt <= 0) return toast.error('Enter a valid amount');

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(fundMint);
    } catch {
      return toast.error('Invalid token mint address');
    }

    setFunding(true);
    try {
      const botPubkey = new PublicKey(botAddress);
      const mintInfo = await getMint(connection, mintPubkey, 'confirmed');
      const decimals = mintInfo.decimals;
      const rawAmount = BigInt(Math.round(amt * 10 ** decimals));

      const fromATA = getAssociatedTokenAddressSync(mintPubkey, publicKey);
      const toATA = getAssociatedTokenAddressSync(mintPubkey, botPubkey);

      const tx = new Transaction();
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          toATA,
          botPubkey,
          mintPubkey
        )
      );
      tx.add(
        createTransferCheckedInstruction(
          fromATA,
          mintPubkey,
          toATA,
          publicKey,
          rawAmount,
          decimals
        )
      );

      const sig = await sendWalletTx(tx, connection);
      toast.success(`Funded! ${sig.slice(0, 10)}…`);
      setFundAmount('');
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setFunding(false);
    }
  }

  async function handleWithdraw() {
    if (!connected || !publicKey) return toast.error('Connect your Solana wallet first');
    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0) return toast.error('Enter a valid amount');

    setWithdrawing(true);
    try {
      const res = await fetch('/api/wallet/withdraw/solana', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          asset: withdrawAsset === 'sol' ? 'sol' : withdrawMint,
          amount: withdrawAmount,
          toAddress: publicKey.toBase58(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Withdrawal sent: ${(data.txSignature as string).slice(0, 10)}…`);
      setWithdrawAmount('');
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Connect */}
      <div className="card-sm">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-3">Your Solana Wallet</p>
        <WalletMultiButton style={{ fontSize: '13px', height: '36px', borderRadius: '12px' }} />
        {connected && publicKey && (
          <p className="mt-2 text-xs text-zinc-500 font-mono">{publicKey.toBase58()}</p>
        )}
      </div>

      {/* Bot wallet info */}
      {botInfo?.solana && (
        <div className="card-sm">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-3">Bot Solana Wallet</p>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-zinc-400 font-mono">{shortAddr(botInfo.solana.address)}</span>
            <CopyButton text={botInfo.solana.address} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['SOL Balance', botInfo.solana.sol + ' SOL'],
              ...(botInfo.solana.tokenMint ? [['Peg Token', parseFloat(botInfo.solana.tokenBalance).toFixed(4)]] : []),
              ...(botInfo.solana.stableMint ? [['Stablecoin', parseFloat(botInfo.solana.stableBalance).toFixed(4)]] : []),
              ['USDC', parseFloat(botInfo.solana.usdcBalance).toFixed(2)],
              ['USDT', parseFloat(botInfo.solana.usdtBalance).toFixed(2)],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="surface">
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="text-sm font-mono text-zinc-100 mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {botInfo?.errors?.solana && <p className="text-xs text-red-400">{botInfo.errors.solana}</p>}

      {/* Fund Bot */}
      {connected && (
        <div className="card-sm space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium flex items-center gap-2">
            <ArrowDownToLine className="h-3.5 w-3.5 text-brand-400" /> Fund Bot
          </p>
          <div className="flex gap-2">
            {(['sol', 'spl'] as const).map((a) => (
              <button key={a} onClick={() => setFundAsset(a)}
                className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
                  fundAsset === a ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
                {a === 'sol' ? 'SOL' : 'SPL Token'}
              </button>
            ))}
          </div>
          {fundAsset === 'spl' && (
            <div className="space-y-2">
              <div className="flex gap-1.5 flex-wrap">
                {[['USDC', USDC], ['USDT', USDT], ['wSOL', WSOL]].map(([l, m]) => (
                  <button key={l} onClick={() => setFundMint(m)}
                    className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">{l}</button>
                ))}
                {botInfo?.solana?.tokenMint && (
                  <button onClick={() => setFundMint(botInfo.solana!.tokenMint)}
                    className="px-2 py-1 rounded-lg text-xs bg-brand-500/10 text-brand-400 hover:text-brand-300 transition-colors">
                    Peg Token
                  </button>
                )}
              </div>
              <input placeholder="Token mint address" value={fundMint}
                onChange={(e) => setFundMint(e.target.value)} className="input font-mono text-xs" />
            </div>
          )}
          <div className="flex gap-2">
            <input type="number" placeholder="Amount" value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)} className="input flex-1" />
            <button onClick={fundAsset === 'sol' ? handleFundSol : handleFundSpl}
              disabled={funding || !fundAmount} className="btn-primary px-4 text-sm disabled:opacity-40">
              {funding ? 'Sending…' : 'Fund'}
            </button>
          </div>
        </div>
      )}

      {/* Withdraw from Bot */}
      <div className="card-sm space-y-3">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium flex items-center gap-2">
          <ArrowUpFromLine className="h-3.5 w-3.5 text-blue-400" /> Withdraw from Bot
        </p>
        {!connected && <p className="text-xs text-zinc-500">Connect your wallet to set the destination.</p>}
        <div className="flex gap-2">
          {(['sol', 'spl'] as const).map((a) => (
            <button key={a} onClick={() => setWithdrawAsset(a)}
              className={clsx('flex-1 py-2 rounded-xl text-xs font-medium border transition-colors',
                withdrawAsset === a ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200')}>
              {a === 'sol' ? 'SOL' : 'SPL Token'}
            </button>
          ))}
        </div>
        {withdrawAsset === 'spl' && (
          <div className="space-y-2">
            <div className="flex gap-1.5 flex-wrap">
              {[['USDC', USDC], ['USDT', USDT], ['wSOL', WSOL]].map(([l, m]) => (
                <button key={l} onClick={() => setWithdrawMint(m)}
                  className="px-2 py-1 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors">{l}</button>
              ))}
              {botInfo?.solana?.tokenMint && (
                <button onClick={() => setWithdrawMint(botInfo.solana!.tokenMint)}
                  className="px-2 py-1 rounded-lg text-xs bg-brand-500/10 text-brand-400 hover:text-brand-300 transition-colors">
                  Peg Token
                </button>
              )}
            </div>
            <input placeholder="Token mint address" value={withdrawMint}
              onChange={(e) => setWithdrawMint(e.target.value)} className="input font-mono text-xs" />
          </div>
        )}
        <div className="flex gap-2">
          <input type="number" placeholder="Amount" value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)} className="input flex-1" />
          <button onClick={handleWithdraw} disabled={withdrawing || !withdrawAmount}
            className="btn-primary px-4 text-sm disabled:opacity-40">
            {withdrawing ? 'Sending…' : 'Withdraw'}
          </button>
        </div>
        {connected && publicKey && (
          <p className="text-xs text-zinc-600">→ to: <span className="font-mono text-zinc-400">{shortAddr(publicKey.toBase58())}</span></p>
        )}
      </div>
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

interface WalletPanelProps {
  open: boolean;
  onClose: () => void;
}

export function WalletPanel({ open, onClose }: WalletPanelProps) {
  const [tab, setTab] = useState<'evm' | 'solana'>('evm');
  const [botInfo, setBotInfo] = useState<BotBalances | null>(null);

  const fetchBotInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/wallet/bot-balances');
      if (res.ok) setBotInfo(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (open) fetchBotInfo();
  }, [open, fetchBotInfo]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={clsx(
          'fixed top-0 right-0 h-full w-full max-w-md z-50',
          'bg-zinc-950 border-l border-zinc-800',
          'flex flex-col overflow-hidden',
          'transition-transform duration-300',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-brand-400" />
            <h2 className="font-semibold text-zinc-100">Wallets &amp; Balances</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchBotInfo} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              Refresh
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-2 border-b border-zinc-800">
          {(['evm', 'solana'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={clsx(
                'flex-1 py-2 rounded-xl text-sm font-medium transition-colors',
                tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              )}>
              {t === 'evm' ? 'EVM (BSC / ETH)' : 'Solana'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'evm' ? (
            <EvmSection botInfo={botInfo} />
          ) : (
            <SolanaSection botInfo={botInfo} />
          )}
        </div>
      </div>
    </>
  );
}
