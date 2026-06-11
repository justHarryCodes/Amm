import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { priceMonitor } from '@/lib/services/priceMonitor';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { chain, tokenAddress, stableAddress, pairAddress, cooldownSeconds, maxDailySpendUsd } = pegMaintainer.settings;
    const { targetPeg, upperBand, lowerBand } = pegMaintainer.settings;

    // 1. Price snapshot
    // • Bot RUNNING  → use the live in-memory snapshot (refreshed every 15 s by the monitor)
    // • Bot STOPPED  → always do a fresh on-chain read so we never show a stale price
    const botRunning = pegMaintainer.state !== 'STOPPED';
    let snap = botRunning ? priceMonitor.getLastSnapshot() : null;
    if (!snap && pairAddress && tokenAddress && stableAddress && chain !== 'solana') {
      try {
        snap = await priceMonitor.getOnChainPrice({ chain, tokenAddress, stableAddress, pairAddress });
      } catch { /* non-fatal — pair may not exist yet */ }
    }

    // 2. Bot wallet balances
    let botTokenBalance:  number | null = null;
    let botStableBalance: number | null = null;
    let botNativeBalance: number | null = null;
    let tokenSymbol  = snap?.tokenSymbol  ?? '';
    let stableSymbol = snap?.stableSymbol ?? '';

    if ((chain === 'bsc' || chain === 'ethereum') && tokenAddress && stableAddress) {
      try {
        const provider = getChainProvider(chain);
        const signer   = getChainSigner(chain);
        const ERC20 = [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
        ];
        const [tokenBal, stableBal, nativeBal, tokenDec, stableDec, tSym, sSym] = await Promise.all([
          new ethers.Contract(tokenAddress,  ERC20, provider).balanceOf(signer.address).catch(() => 0n),
          new ethers.Contract(stableAddress, ERC20, provider).balanceOf(signer.address).catch(() => 0n),
          provider.getBalance(signer.address).catch(() => 0n),
          new ethers.Contract(tokenAddress,  ERC20, provider).decimals().catch(() => 18n),
          new ethers.Contract(stableAddress, ERC20, provider).decimals().catch(() => 18n),
          tokenSymbol  ? Promise.resolve(tokenSymbol)  : new ethers.Contract(tokenAddress,  ERC20, provider).symbol().catch(() => ''),
          stableSymbol ? Promise.resolve(stableSymbol) : new ethers.Contract(stableAddress, ERC20, provider).symbol().catch(() => ''),
        ]);
        botTokenBalance  = parseFloat(ethers.formatUnits(tokenBal  as bigint, Number(tokenDec)));
        botStableBalance = parseFloat(ethers.formatUnits(stableBal as bigint, Number(stableDec)));
        botNativeBalance = parseFloat(ethers.formatEther(nativeBal as bigint));
        if (!tokenSymbol  && tSym) tokenSymbol  = tSym as string;
        if (!stableSymbol && sSym) stableSymbol = sSym as string;
      } catch { /* non-fatal */ }
    }

    // 3. Cooldown remaining
    const lastTrade = pegMaintainer.lastTradeAt;
    const cooldownRemaining = lastTrade
      ? Math.max(0, cooldownSeconds - (Date.now() - lastTrade.getTime()) / 1000)
      : 0;

    // 4. Daily stats
    const stats = await pegMaintainer.getDailyStats().catch(() => ({
      totalTrades: 0, totalBuyUsd: 0, totalSellTokens: 0,
    }));

    return NextResponse.json({
      state:         pegMaintainer.state,
      chain,

      // Price data (all from on-chain pair contract)
      currentPrice:  snap?.price        ?? null,
      targetPeg,
      upperBound:    targetPeg * (1 + upperBand),
      lowerBound:    targetPeg * (1 - lowerBand),

      // Pool reserves (on-chain)
      tokenReserve:  snap?.tokenReserve  ?? null,
      stableReserve: snap?.stableReserve ?? null,
      liquidityUsd:  snap?.liquidityUsd  ?? null,
      tokenSymbol,
      stableSymbol,
      blockNumber:   snap?.blockNumber   ?? null,
      lastUpdated:   snap?.timestamp     ?? null,

      // Bot wallet balances
      botTokenBalance,
      botStableBalance,
      botNativeBalance,
      nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',

      // Trading state
      dailySpendUsd:    pegMaintainer.dailySpendUsd,
      maxDailySpendUsd,
      cooldownRemaining,
      lastTradeAt: pegMaintainer.lastTradeAt,
      dailyStats:  stats,

      // CoinGecko market data
      marketPriceUsd: snap?.marketPriceUsd ?? null,
      cgChange24h:    snap?.cgChange24h    ?? null,
      cgVolume24h:    snap?.cgVolume24h    ?? null,
      cgMarketCap:    snap?.cgMarketCap    ?? null,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
