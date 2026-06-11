import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getChainSigner } from '@/lib/blockchain/provider';
import { txOverrides } from '@/lib/blockchain/contracts';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    chain: 'bsc' | 'ethereum';
    asset: 'native' | string; // 'native' or token contract address
    amount: string;
    toAddress: string;
  };

  const { chain, asset, amount, toAddress } = body;

  if (!chain || !asset || !amount || !toAddress) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (!ethers.isAddress(toAddress)) {
    return NextResponse.json({ error: 'Invalid toAddress' }, { status: 400 });
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  try {
    const signer = getChainSigner(chain);
    const gas = await txOverrides(chain);

    if (asset === 'native') {
      const value = ethers.parseEther(amount);
      const tx = await signer.sendTransaction({ to: toAddress, value, ...gas });
      await tx.wait();
      return NextResponse.json({ txHash: tx.hash, chain, asset: 'native', amount, toAddress });
    }

    // ERC20
    if (!ethers.isAddress(asset)) {
      return NextResponse.json({ error: 'Invalid token address' }, { status: 400 });
    }
    const token = new ethers.Contract(asset, ERC20_ABI, signer);
    const decimals = Number(await token.decimals());
    const rawAmount = ethers.parseUnits(amount, decimals);

    const tx = await token.transfer(toAddress, rawAmount, gas);
    await tx.wait();
    return NextResponse.json({ txHash: tx.hash, chain, asset, amount, toAddress });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
