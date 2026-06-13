import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERC20_META = [
  'function symbol()   view returns (string)',
  'function name()     view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

// Known stable addresses (lowercase) — used to auto-suggest which token is the peg vs stable
const KNOWN_STABLES = new Set([
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC BSC
  '0x55d398326f99059ff775485246999027b3197955', // USDT BSC
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB BSC
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC ETH
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT ETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH ETH
  '0xbdfa0f1b0c42b2c43b31a2c5f1584b1759d48888', // Custom stable
]);

// GET /api/peg/resolve-pair?pairAddress=0x...&chain=bsc
// Returns full token info for both tokens in the pool — no manual token input needed.
export async function GET(req: NextRequest) {
  const pairAddress = req.nextUrl.searchParams.get('pairAddress') ?? '';
  const chain       = (req.nextUrl.searchParams.get('chain') ?? 'bsc') as 'bsc' | 'ethereum';

  if (!ethers.isAddress(pairAddress)) {
    return NextResponse.json({ error: 'Invalid pair address' }, { status: 400 });
  }
  if (chain !== 'bsc' && chain !== 'ethereum') {
    return NextResponse.json({ error: 'Chain must be bsc or ethereum' }, { status: 400 });
  }

  try {
    // 1. Read token0, token1, fee, dexVersion from the pool contract
    const { token0, token1, fee, dexVersion } = await pegMaintainer.resolveFromPair(pairAddress, chain);

    // 2. Fetch ERC20 metadata + bot balance for both tokens in parallel
    const provider   = getChainProvider(chain);
    const signer     = getChainSigner(chain);
    const botAddress = signer.address;

    async function tokenInfo(address: string) {
      const c = new ethers.Contract(address, ERC20_META, provider);
      const [symR, nameR, decR, balR] = await Promise.allSettled([
        c.symbol(),
        c.name(),
        c.decimals(),
        c.balanceOf(botAddress),
      ]);
      const symbol   = symR.status  === 'fulfilled' ? String(symR.value)                               : 'UNKNOWN';
      const name     = nameR.status === 'fulfilled' ? String(nameR.value)                              : symbol;
      const decimals = decR.status  === 'fulfilled' ? Number(decR.value)                               : 18;
      const botBalance = balR.status === 'fulfilled'
        ? parseFloat(ethers.formatUnits(balR.value as bigint, decimals))
        : 0;
      return { address, symbol, name, decimals, botBalance };
    }

    const [t0, t1] = await Promise.all([tokenInfo(token0), tokenInfo(token1)]);

    // 3. Suggest roles: stable addresses → stable, other → peg
    const t0stable = KNOWN_STABLES.has(token0.toLowerCase());
    const suggestedPeg    = t0stable ? 'token1' : 'token0';
    const suggestedStable = t0stable ? 'token0' : 'token1';

    return NextResponse.json({
      token0: t0,
      token1: t1,
      fee,
      dexVersion,
      suggestedPeg,
      suggestedStable,
      botAddress,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
