import { NextRequest, NextResponse } from 'next/server';
import {
  Transaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { getSolanaConnection, getSolanaKeypair } from '@/lib/solana/connection';

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    asset: 'sol' | string; // 'sol' or SPL token mint address
    amount: string;
    toAddress: string;
  };

  const { asset, amount, toAddress } = body;

  if (!asset || !amount || !toAddress) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  try {
    new PublicKey(toAddress); // validate
  } catch {
    return NextResponse.json({ error: 'Invalid toAddress' }, { status: 400 });
  }

  try {
    const connection = getSolanaConnection();
    const keypair = getSolanaKeypair();
    const toPubkey = new PublicKey(toAddress);

    const tx = new Transaction();

    if (asset === 'sol') {
      const lamports = Math.round(parsed * LAMPORTS_PER_SOL);
      tx.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey,
          lamports: BigInt(lamports),
        })
      );
    } else {
      // SPL token
      const mintPubkey = new PublicKey(asset);
      const mintInfo = await getMint(connection, mintPubkey, 'confirmed');
      const decimals = mintInfo.decimals;
      const rawAmount = BigInt(Math.round(parsed * 10 ** decimals));

      const fromATA = getAssociatedTokenAddressSync(mintPubkey, keypair.publicKey);
      const toATA = getAssociatedTokenAddressSync(mintPubkey, toPubkey);

      // Idempotent: creates ATA only if it doesn't exist
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          toATA,
          toPubkey,
          mintPubkey
        )
      );
      tx.add(
        createTransferCheckedInstruction(
          fromATA,
          mintPubkey,
          toATA,
          keypair.publicKey,
          rawAmount,
          decimals
        )
      );
    }

    const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
    return NextResponse.json({ txSignature: sig, asset, amount, toAddress });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
