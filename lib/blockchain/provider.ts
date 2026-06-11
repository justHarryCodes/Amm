import { ethers } from 'ethers';
import { config } from '../config';
import { getSettings } from '../serverSettings';
import { logger } from '../utils/logger';

declare global {
  var __evmProviders: Map<string, ethers.AbstractProvider> | undefined;
  var __evmSigners:   Map<string, ethers.Wallet>           | undefined;
}

// Chain IDs for staticNetwork — avoids eth_chainId detection on every startup
const CHAIN_IDS: Record<'bsc' | 'ethereum', Record<string, number>> = {
  bsc:      { mainnet: 56,  testnet: 97 },
  ethereum: { mainnet: 1,   testnet: 11155111 }, // Sepolia
};

function alchemyUrl(chain: 'bsc' | 'ethereum', netMode: 'mainnet' | 'testnet', key: string): string {
  if (chain === 'bsc') {
    return netMode === 'mainnet'
      ? `https://bnb-mainnet.g.alchemy.com/v2/${key}`
      : `https://bnb-testnet.g.alchemy.com/v2/${key}`;
  }
  return netMode === 'mainnet'
    ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
    : `https://eth-sepolia.g.alchemy.com/v2/${key}`;
}

function buildProvider(chain: 'bsc' | 'ethereum'): ethers.AbstractProvider {
  const key = config.alchemy.apiKey;
  if (!key) throw new Error('ALCHEMY_API_KEY is not configured — all RPC calls go through Alchemy');

  const netMode = getSettings().evmNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  const chainId  = CHAIN_IDS[chain][netMode];
  const staticNet = ethers.Network.from(chainId);
  const url = alchemyUrl(chain, netMode, key);

  return new ethers.JsonRpcProvider(url, staticNet, { staticNetwork: staticNet });
}

// ── Default exports (BSC) — used by bulk sender ─────────────────────────────

export function getProvider(): ethers.AbstractProvider {
  return getChainProvider('bsc');
}

export function getSigner(): ethers.Wallet {
  return getChainSigner('bsc');
}

// ── Multi-chain ──────────────────────────────────────────────────────────────

export function getChainProvider(chain: 'bsc' | 'ethereum'): ethers.AbstractProvider {
  if (!global.__evmProviders) global.__evmProviders = new Map();
  if (!global.__evmProviders.has(chain)) {
    const p = buildProvider(chain);
    global.__evmProviders.set(chain, p);
    logger.info('EVM provider ready (Alchemy)', { chain, network: getSettings().evmNetwork });
  }
  return global.__evmProviders.get(chain)!;
}

export function getChainSigner(chain: 'bsc' | 'ethereum'): ethers.Wallet {
  if (!global.__evmSigners) global.__evmSigners = new Map();
  if (!global.__evmSigners.has(chain)) {
    if (!config.wallet.privateKey) throw new Error('BOT_PRIVATE_KEY is not configured');
    const w = new ethers.Wallet(config.wallet.privateKey, getChainProvider(chain));
    global.__evmSigners.set(chain, w);
    logger.info('EVM signer ready', { chain, address: w.address });
  }
  return global.__evmSigners.get(chain)!;
}

export async function getGasPrice(chain: 'bsc' | 'ethereum' = 'bsc'): Promise<bigint> {
  const fee  = await getChainProvider(chain).getFeeData();
  const base = fee.gasPrice ?? ethers.parseUnits('5', 'gwei');
  return (base * 110n) / 100n;
}

export function clearEvmCaches(): void {
  global.__evmProviders = undefined;
  global.__evmSigners   = undefined;
}

export async function getBotBalance(chain: 'bsc' | 'ethereum' = 'bsc') {
  const prov = getChainProvider(chain);
  const sign = getChainSigner(chain);
  const nativeBal = await prov.getBalance(sign.address);

  const chainCfg = chain === 'bsc' ? config.pegChains.bsc : config.pegChains.ethereum;
  const erc20ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
  let tokenBal = '0', stableBal = '0';

  if (chainCfg.tokenAddress) {
    const c = new ethers.Contract(chainCfg.tokenAddress, erc20ABI, prov);
    const [b, d] = await Promise.all([c.balanceOf(sign.address), c.decimals()]);
    tokenBal = ethers.formatUnits(b, d);
  }
  if (chainCfg.stableAddress) {
    const c = new ethers.Contract(chainCfg.stableAddress, erc20ABI, prov);
    const [b, d] = await Promise.all([c.balanceOf(sign.address), c.decimals()]);
    stableBal = ethers.formatUnits(b, d);
  }

  const nativeLabel = chain === 'bsc' ? 'bnb' : 'eth';
  return { [nativeLabel]: ethers.formatEther(nativeBal), token: tokenBal, stablecoin: stableBal };
}
