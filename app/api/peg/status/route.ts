import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getPegSlot } from '@/lib/services/pegMaintainer';
import { getPriceMonitorSlot } from '@/lib/services/priceMonitor';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? 0)));
  const peg  = getPegSlot(slot);
  const mon  = getPriceMonitorSlot(slot);

  try {
    const { chain, tokenAddress, stableAddress, pairAddress, cooldownSeconds, maxDailySpendUsd } = peg.settings;
    const { targetPeg, upperBand, lowerBand } = peg.settings;

    const botRunning = peg.state !== 'STOPPED';
    let snap = botRunning ? mon.getLastSnapshot() : null;
    if (!snap && pairAddress && tokenAddress && stableAddress && chain !== 'solana') {
      try {
        snap = await mon.getOnChainPrice({ chain, tokenAddress, stableAddress, pairAddress });
      } catch { /* non-fatal */ }
    }

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

    const lastTrade = peg.lastTradeAt;
    const cooldownRemaining = lastTrade
      ? Math.max(0, cooldownSeconds - (Date.now() - lastTrade.getTime()) / 1000)
      : 0;

    const stats = await peg.getDailyStats().catch(() => ({
      totalTrades: 0, totalBuyUsd: 0, totalSellTokens: 0, volumeTrades: 0, volumeUsd: 0,
    }));

    return NextResponse.json({
      slot,
      state:         peg.state,
      chain,
      currentPrice:  snap?.price        ?? null,
      targetPeg,
      upperBound:    targetPeg * (1 + upperBand),
      lowerBound:    targetPeg * (1 - lowerBand),
      tokenReserve:  snap?.tokenReserve  ?? null,
      stableReserve: snap?.stableReserve ?? null,
      liquidityUsd:  snap?.liquidityUsd  ?? null,
      tokenSymbol,
      stableSymbol,
      blockNumber:   snap?.blockNumber   ?? null,
      lastUpdated:   snap?.timestamp     ?? null,
      botTokenBalance,
      botStableBalance,
      botNativeBalance,
      nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',
      dailySpendUsd:    peg.dailySpendUsd,
      maxDailySpendUsd,
      cooldownRemaining,
      lastTradeAt: peg.lastTradeAt,
      dailyStats:  stats,
      marketPriceUsd: snap?.marketPriceUsd ?? null,
      cgChange24h:    snap?.cgChange24h    ?? null,
      cgVolume24h:    snap?.cgVolume24h    ?? null,
      cgMarketCap:    snap?.cgMarketCap    ?? null,
      dexVersion:  snap?.dexVersion ?? 'unknown',
      poolFeeTier: peg.settings.poolFeeTier ?? 0,
      volumeEnabled:         peg.settings.volumeEnabled,
      volumeIntervalSeconds: peg.settings.volumeIntervalSeconds,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
