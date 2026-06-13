import { ethers } from 'ethers';
import { getProvider, getSigner, getChainProvider, getChainSigner, getGasPrice } from './provider';
import { config } from '../config';
import { logger } from '../utils/logger';

import ERC20_ABI       from '../abi/ERC20.json';
import PAIR_ABI        from '../abi/PancakeV2Pair.json';
import ROUTER_ABI      from '../abi/PancakeV2Router.json';
import MULTISENDER_ABI from '../abi/MultiSender.json';

type EvmChain = 'bsc' | 'ethereum';

export const getTokenContract    = (addr?: string) =>
  new ethers.Contract(addr ?? config.tokens.token, ERC20_ABI, getSigner());

export const getStablecoinContract = () =>
  new ethers.Contract(config.tokens.usdc || config.tokens.usdt, ERC20_ABI, getSigner());

export const getPairContract = () =>
  new ethers.Contract(config.tokens.pair, PAIR_ABI, getProvider());

export const getRouterContract = () =>
  new ethers.Contract(config.pancake.router, ROUTER_ABI, getSigner());

export const getMultiSenderContract = (address: string, chain: EvmChain = 'bsc') =>
  new ethers.Contract(address, MULTISENDER_ABI, getChainSigner(chain));

export async function getTokenDecimals(address: string, chain: EvmChain = 'bsc'): Promise<number> {
  const c = new ethers.Contract(address, ERC20_ABI, getChainProvider(chain));
  return Number(await c.decimals());
}

export async function getTokenBalance(tokenAddress: string, walletAddress: string, chain: EvmChain = 'bsc'): Promise<bigint> {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, getChainProvider(chain));
  return await c.balanceOf(walletAddress);
}

// BSC uses legacy (type 0) transactions — no EIP-1559. Build overrides accordingly.
export async function txOverrides(chain: EvmChain): Promise<{ type: number; gasPrice?: bigint }> {
  if (chain === 'bsc') {
    return { type: 0, gasPrice: await getGasPrice('bsc') };
  }
  return { type: 2 };
}

export async function ensureApproval(
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
  chain: EvmChain = 'bsc',
): Promise<string | null> {
  const signer = getChainSigner(chain);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const allowance: bigint = await c.allowance(signer.address, spenderAddress);
  logger.info('Approval check', { token: tokenAddress, spender: spenderAddress, allowance: allowance.toString(), needed: amount.toString() });
  if (allowance >= amount) return null;
  logger.info('Approving token for spender...', { token: tokenAddress, spender: spenderAddress });
  const overrides = await txOverrides(chain);
  const tx = await c.approve(spenderAddress, ethers.MaxUint256, overrides);
  await tx.wait();
  const after: bigint = await c.allowance(signer.address, spenderAddress);
  logger.info('Approval confirmed', { token: tokenAddress, spender: spenderAddress, allowance: after.toString(), txHash: tx.hash });
  return tx.hash as string;
}
