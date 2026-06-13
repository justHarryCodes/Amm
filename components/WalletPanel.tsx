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
import { X, Wallet, ArrowDownToLine, ArrowUpFromLine, Copy, Check, Loader2, AlertCircle, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { CHAIN_TOKENS } from '@/lib/tokens';

const CUSTOM_STABLE_ADDR = '0xbDFA0F1B0C42B2C43B31a2C5F1584B1759D48888';


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
    tokenSymbol: string;
    stableSymbol: string;
    bscUsdc: string;
    bscUsdt: string;
    bscWbnb: string;
    ethUsdc: string;
    ethUsdt: string;
    ethWeth: string;
    customStable: string;
    customStableSymbol: string;
    activeChain: string;
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
    wsolBalance: string;
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

// ── Token wallet helpers ───────────────────────────────────────────────────────

const KNOWN_TOKEN_COLORS: Record<string, string> = {
  BNB:  'bg-amber-500',  WBNB: 'bg-amber-700',
  ETH:  'bg-indigo-500', WETH: 'bg-indigo-700',
  USDC: 'bg-blue-600',   USDT: 'bg-emerald-600',
  SOL:  'bg-purple-600', wSOL: 'bg-purple-700',
};
const COLOR_PALETTE = [
  'bg-sky-600','bg-pink-600','bg-cyan-600','bg-orange-600',
  'bg-teal-600','bg-rose-600','bg-violet-600','bg-lime-600',
];
function tokenAvatarColor(sym: string): string {
  if (KNOWN_TOKEN_COLORS[sym]) return KNOWN_TOKEN_COLORS[sym];
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % COLOR_PALETTE.length;
  return COLOR_PALETTE[h];
}

function TokenRow({
  symbol, name, balance, badge, isLowBal = false,
}: {
  symbol: string; name: string; balance: string; badge?: string; isLowBal?: boolean;
}) {
  const bal    = parseFloat(balance || '0');
  const isZero = bal === 0;
  const fmt    = bal === 0
    ? '0'
    : bal >= 10_000
      ? bal.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : bal >= 1
        ? bal.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : bal.toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <div className="flex items-center gap-3 py-3 px-1">
      <div className={clsx(
        'h-9 w-9 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0',
        tokenAvatarColor(symbol),
        isZero && 'opacity-35',
      )}>
        {symbol.slice(0, 3).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={clsx('text-sm font-semibold leading-none',
            isZero ? 'text-zinc-600' : isLowBal ? 'text-amber-300' : 'text-zinc-100')}>
            {symbol}
          </span>
          {badge && (
            <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-bold leading-none uppercase tracking-wide',
              badge === 'GAS'    ? 'bg-amber-500/15 text-amber-400' :
              badge === 'PEG'    ? 'bg-brand-500/15 text-brand-400' :
              badge === 'STABLE' ? 'bg-emerald-500/15 text-emerald-400' :
              'bg-zinc-800 text-zinc-500')}>
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-600 mt-0.5 truncate">{name}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={clsx('text-sm font-mono leading-none font-medium',
          isZero ? 'text-zinc-700' : isLowBal ? 'text-red-400' : 'text-zinc-100')}>
          {fmt}
        </p>
        <p className="text-[11px] text-zinc-600 mt-0.5">{symbol}</p>
      </div>
    </div>
  );
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
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
            <div className="flex items-center gap-2.5">
              <div className={clsx(
                'h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
                activeChain === 'bsc'
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-indigo-500/20 text-indigo-400',
              )}>
                {activeChain === 'bsc' ? 'B' : 'E'}
              </div>
              <div>
                <p className="text-xs font-semibold text-zinc-300 leading-none">Bot Wallet</p>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-[11px] text-zinc-500 font-mono">{shortAddr(botInfo.evm.address)}</span>
                  <CopyButton text={botInfo.evm.address} />
                </div>
              </div>
            </div>
            <span className={clsx('text-xs font-semibold px-2.5 py-1 rounded-lg',
              activeChain === 'bsc'
                ? 'bg-amber-500/10 text-amber-400'
                : 'bg-indigo-500/10 text-indigo-400')}>
              {activeChain === 'bsc' ? 'BSC' : 'ETH'}
            </span>
          </div>

          {/* Token list */}
          <div className="divide-y divide-zinc-800/50 px-3">
            {activeChain === 'bsc' ? (
              <>
                <TokenRow symbol="BNB"  name="Binance Coin"  balance={botInfo.evm.bsc}  badge="GAS"
                  isLowBal={parseFloat(botInfo.evm.bsc) < 0.005} />
                <TokenRow symbol="WBNB" name="Wrapped BNB"  balance={botInfo.evm.bscWbnb ?? '0'} />
                {botInfo.evm.tokenAddress && botInfo.evm.activeChain === 'bsc' && (
                  <TokenRow
                    symbol={botInfo.evm.tokenSymbol || botInfo.evm.tokenAddress.slice(0, 6)}
                    name="Peg Token"
                    balance={botInfo.evm.tokenBalance}
                    badge="PEG"
                  />
                )}
                <TokenRow
                  symbol={botInfo.evm.customStableSymbol || 'MYUSD'}
                  name="Custom Stable"
                  balance={botInfo.evm.customStable ?? '0'}
                  badge="STABLE"
                />
                <TokenRow symbol="USDC" name="USD Coin"   balance={botInfo.evm.bscUsdc} />
                <TokenRow symbol="USDT" name="Tether USD" balance={botInfo.evm.bscUsdt} />
              </>
            ) : (
              <>
                <TokenRow symbol="ETH"  name="Ethereum"    balance={botInfo.evm.ethereum}  badge="GAS"
                  isLowBal={parseFloat(botInfo.evm.ethereum) < 0.002} />
                <TokenRow symbol="WETH" name="Wrapped ETH" balance={botInfo.evm.ethWeth ?? '0'} />
                {botInfo.evm.tokenAddress && botInfo.evm.activeChain === 'ethereum' && (
                  <TokenRow
                    symbol={botInfo.evm.tokenSymbol || botInfo.evm.tokenAddress.slice(0, 6)}
                    name="Peg Token"
                    balance={botInfo.evm.tokenBalance}
                    badge="PEG"
                  />
                )}
                <TokenRow symbol="USDC" name="USD Coin"   balance={botInfo.evm.ethUsdc} />
                <TokenRow symbol="USDT" name="Tether USD" balance={botInfo.evm.ethUsdt} />
              </>
            )}
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
              <div className="flex gap-1.5 flex-wrap">
                {(activeChain === 'bsc' ? [
                  { label: 'WBNB',  addr: CHAIN_TOKENS.bsc.wNative.address },
                  ...(botInfo?.evm?.tokenAddress && botInfo.evm.activeChain === 'bsc' ? [{ label: botInfo.evm.tokenSymbol || 'PEG', addr: botInfo.evm.tokenAddress }] : []),
                  { label: botInfo?.evm?.customStableSymbol || 'MYUSD', addr: CUSTOM_STABLE_ADDR },
                  { label: 'USDC',  addr: CHAIN_TOKENS.bsc.usdc.address },
                  { label: 'USDT',  addr: CHAIN_TOKENS.bsc.usdt.address },
                ] : [
                  { label: 'WETH',  addr: CHAIN_TOKENS.ethereum.wNative.address },
                  ...(botInfo?.evm?.tokenAddress && botInfo.evm.activeChain === 'ethereum' ? [{ label: botInfo.evm.tokenSymbol || 'PEG', addr: botInfo.evm.tokenAddress }] : []),
                  { label: 'USDC',  addr: CHAIN_TOKENS.ethereum.usdc.address },
                  { label: 'USDT',  addr: CHAIN_TOKENS.ethereum.usdt.address },
                ]).map(({ label, addr }) => (
                  <button key={addr} type="button" onClick={() => setFundToken(addr)}
                    className={clsx('px-2 py-1 rounded-lg text-xs transition-colors',
                      fundToken === addr
                        ? 'bg-brand-500/10 text-brand-400 border border-brand-500/30'
                        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-100')}>
                    {label}
                  </button>
                ))}
              </div>
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
        {!isConnected && (
          <p className="text-xs text-zinc-500">Connect your wallet above to set the destination address.</p>
        )}

        {/* Token picker — all wallet tokens for the active chain */}
        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-600 uppercase tracking-wide font-medium">Choose token</p>
          <div className="grid grid-cols-3 gap-1.5">
            {(activeChain === 'bsc' ? [
              { symbol: nativeSymbol,  address: null,                balance: botInfo?.evm?.bsc ?? '0' },
              { symbol: 'WBNB',        address: CHAIN_TOKENS.bsc.wNative.address, balance: botInfo?.evm?.bscWbnb ?? '0' },
              ...(botInfo?.evm?.tokenAddress && botInfo.evm.activeChain === 'bsc'
                ? [{ symbol: botInfo.evm.tokenSymbol || 'TOKEN', address: botInfo.evm.tokenAddress, balance: botInfo.evm.tokenBalance }]
                : []),
              { symbol: botInfo?.evm?.customStableSymbol || 'MYUSD', address: CUSTOM_STABLE_ADDR, balance: botInfo?.evm?.customStable ?? '0' },
              { symbol: 'USDC',        address: CHAIN_TOKENS.bsc.usdc.address,    balance: botInfo?.evm?.bscUsdc ?? '0' },
              { symbol: 'USDT',        address: CHAIN_TOKENS.bsc.usdt.address,    balance: botInfo?.evm?.bscUsdt ?? '0' },
            ] : [
              { symbol: nativeSymbol,  address: null,                balance: botInfo?.evm?.ethereum ?? '0' },
              { symbol: 'WETH',        address: CHAIN_TOKENS.ethereum.wNative.address, balance: botInfo?.evm?.ethWeth ?? '0' },
              ...(botInfo?.evm?.tokenAddress && botInfo.evm.activeChain === 'ethereum'
                ? [{ symbol: botInfo.evm.tokenSymbol || 'TOKEN', address: botInfo.evm.tokenAddress, balance: botInfo.evm.tokenBalance }]
                : []),
              { symbol: 'USDC',        address: CHAIN_TOKENS.ethereum.usdc.address, balance: botInfo?.evm?.ethUsdc ?? '0' },
              { symbol: 'USDT',        address: CHAIN_TOKENS.ethereum.usdt.address, balance: botInfo?.evm?.ethUsdt ?? '0' },
            ]).map(({ symbol, address, balance }) => {
              const isSelected = address === null
                ? withdrawAsset === 'native'
                : withdrawAsset === 'token' && withdrawToken.toLowerCase() === address.toLowerCase();
              const bal = parseFloat(balance || '0');
              return (
                <button
                  key={symbol}
                  type="button"
                  onClick={() => {
                    setWithdrawAsset(address === null ? 'native' : 'token');
                    setWithdrawToken(address ?? '');
                    setWithdrawAmount('');
                  }}
                  className={clsx(
                    'flex flex-col items-start px-2.5 py-2 rounded-xl text-xs border transition-colors',
                    isSelected
                      ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                      : 'border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
                  )}
                >
                  <span className="font-semibold">{symbol}</span>
                  <span className={clsx('text-[11px] mt-0.5 font-mono',
                    bal > 0 ? 'text-zinc-400' : 'text-zinc-700')}>
                    {bal >= 1
                      ? bal.toLocaleString(undefined, { maximumFractionDigits: 4 })
                      : bal.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom token address override */}
        {withdrawAsset === 'token' && (
          <input
            placeholder="Or paste any ERC-20 address"
            value={withdrawToken}
            onChange={e => { setWithdrawToken(e.target.value); setWithdrawAmount(''); }}
            className="input font-mono text-xs"
          />
        )}

        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Amount"
            value={withdrawAmount}
            onChange={e => setWithdrawAmount(e.target.value)}
            className="input flex-1"
          />
          <button
            onClick={handleWithdraw}
            disabled={withdrawing || !withdrawAmount || (!isConnected)}
            className="btn-primary px-4 text-sm disabled:opacity-40"
          >
            {withdrawing ? 'Sending…' : 'Withdraw'}
          </button>
        </div>

        {isConnected && connectedAddress && (
          <p className="text-xs text-zinc-600">
            → to: <span className="font-mono text-zinc-400">{shortAddr(connectedAddress)}</span>
          </p>
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
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 bg-purple-500/20 text-purple-400">
                S
              </div>
              <div>
                <p className="text-xs font-semibold text-zinc-300 leading-none">Bot Wallet</p>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-[11px] text-zinc-500 font-mono">{shortAddr(botInfo.solana.address)}</span>
                  <CopyButton text={botInfo.solana.address} />
                </div>
              </div>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-purple-500/10 text-purple-400">SOL</span>
          </div>

          {/* Token list */}
          <div className="divide-y divide-zinc-800/50 px-3">
            <TokenRow symbol="SOL"  name="Solana"      balance={botInfo.solana.sol} badge="GAS"
              isLowBal={parseFloat(botInfo.solana.sol) < 0.01} />
            <TokenRow symbol="wSOL" name="Wrapped SOL" balance={botInfo.solana.wsolBalance ?? '0'} />
            {botInfo.solana.tokenMint && (
              <TokenRow symbol="TOKEN" name="Peg Token" balance={botInfo.solana.tokenBalance} badge="PEG" />
            )}
            <TokenRow symbol="USDC" name="USD Coin"   balance={botInfo.solana.usdcBalance} />
            <TokenRow symbol="USDT" name="Tether USD" balance={botInfo.solana.usdtBalance} />
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
        {!connected && (
          <p className="text-xs text-zinc-500">Connect your wallet above to set the destination address.</p>
        )}

        {/* Token picker */}
        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-600 uppercase tracking-wide font-medium">Choose token</p>
          <div className="grid grid-cols-3 gap-1.5">
            {([
              { symbol: 'SOL',  mint: null,  balance: botInfo?.solana?.sol ?? '0' },
              { symbol: 'wSOL', mint: WSOL,  balance: botInfo?.solana?.wsolBalance ?? '0' },
              ...(botInfo?.solana?.tokenMint
                ? [{ symbol: 'TOKEN', mint: botInfo.solana.tokenMint, balance: botInfo.solana.tokenBalance }]
                : []),
              { symbol: 'USDC', mint: USDC,  balance: botInfo?.solana?.usdcBalance ?? '0' },
              { symbol: 'USDT', mint: USDT,  balance: botInfo?.solana?.usdtBalance ?? '0' },
            ] as { symbol: string; mint: string | null; balance: string }[]).map(({ symbol, mint, balance }) => {
              const isSelected = mint === null
                ? withdrawAsset === 'sol'
                : withdrawAsset === 'spl' && withdrawMint === mint;
              const bal = parseFloat(balance || '0');
              return (
                <button
                  key={symbol}
                  type="button"
                  onClick={() => {
                    setWithdrawAsset(mint === null ? 'sol' : 'spl');
                    setWithdrawMint(mint ?? '');
                    setWithdrawAmount('');
                  }}
                  className={clsx(
                    'flex flex-col items-start px-2.5 py-2 rounded-xl text-xs border transition-colors',
                    isSelected
                      ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                      : 'border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
                  )}
                >
                  <span className="font-semibold">{symbol}</span>
                  <span className={clsx('text-[11px] mt-0.5 font-mono', bal > 0 ? 'text-zinc-400' : 'text-zinc-700')}>
                    {bal >= 1
                      ? bal.toLocaleString(undefined, { maximumFractionDigits: 4 })
                      : bal.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom mint override */}
        {withdrawAsset === 'spl' && (
          <input
            placeholder="Or paste any SPL mint address"
            value={withdrawMint}
            onChange={e => { setWithdrawMint(e.target.value); setWithdrawAmount(''); }}
            className="input font-mono text-xs"
          />
        )}

        <div className="flex gap-2">
          <input type="number" placeholder="Amount" value={withdrawAmount}
            onChange={e => setWithdrawAmount(e.target.value)} className="input flex-1" />
          <button onClick={handleWithdraw} disabled={withdrawing || !withdrawAmount || !connected}
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
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const fetchBotInfo = useCallback(async () => {
    setLoading(true);
    setFetchError('');
    try {
      const res = await fetch('/api/wallet/bot-balances');
      if (res.ok) {
        setBotInfo(await res.json() as BotBalances);
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setFetchError(`Error ${res.status}: ${body.error ?? 'Failed to load balances'}`);
      }
    } catch (e: unknown) {
      setFetchError((e as Error).message ?? 'Network error');
    } finally {
      setLoading(false);
    }
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
            {loading
              ? <Loader2 className="h-4 w-4 text-zinc-500 animate-spin" />
              : <button onClick={fetchBotInfo} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Refresh</button>
            }
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
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Fetch-level error (auth failure, network down, etc.) */}
          {fetchError && (
            <div className="flex items-start gap-2 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{fetchError}</p>
            </div>
          )}

          {/* Loading skeleton while first fetch runs */}
          {loading && !botInfo && (
            <div className="space-y-3 animate-pulse">
              <div className="h-24 rounded-xl bg-zinc-800/60" />
              <div className="h-32 rounded-xl bg-zinc-800/60" />
              <div className="h-20 rounded-xl bg-zinc-800/60" />
            </div>
          )}

          {(!loading || botInfo) && (
            tab === 'evm' ? (
              <EvmSection botInfo={botInfo} />
            ) : (
              <SolanaSection botInfo={botInfo} />
            )
          )}
        </div>
      </div>
    </>
  );
}
