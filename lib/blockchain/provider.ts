import { ethers } from 'ethers';
import { config } from '../config';
import { getSettings } from '../serverSettings';
import { logger } from '../utils/logger';

declare global {
  var __provider: ethers.AbstractProvider | undefined;
  var __signer: ethers.Wallet | undefined;
  var __evmProviders: Map<string, ethers.AbstractProvider> | undefined;
  var __evmSigners: Map<string, ethers.Wallet> | undefined;
}

// Chain IDs for static network — avoids eth_chainId detection on every startup.
const CHAIN_IDS: Record<'bsc' | 'ethereum', Record<string, number>> = {
  bsc:      { mainnet: 56,  testnet: 97 },
  ethereum: { mainnet: 1,   testnet: 11155111 }, // sepolia testnet
};

// Build a provider for one EVM chain.
// Passing Network as staticNetwork skips initial network-detection entirely (ethers v6 behaviour).
function buildProvider(chain: 'bsc' | 'ethereum'): ethers.AbstractProvider {
  const netMode = getSettings().evmNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  const chainId = CHAIN_IDS[chain][netMode];
  const staticNet = ethers.Network.from(chainId);

  let publicUrl: string;
  if (chain === 'bsc') {
    publicUrl = netMode === 'mainnet'
      ? config.pegChains.bsc.rpcMainnet
      : config.pegChains.bsc.rpcTestnet;
  } else {
    publicUrl = config.pegChains.ethereum.rpcUrl;
  }

  if (!publicUrl) {
    throw new Error(`No RPC URL configured for ${chain} ${netMode}`);
  }

  const primary = new ethers.JsonRpcProvider(publicUrl, staticNet, { staticNetwork: staticNet });

  const key = config.alchemy.apiKey;
  if (!key) return primary;

  const alchemyUrl = chain === 'bsc'
    ? `https://bnb-${netMode}.g.alchemy.com/v2/${key}`
    : `https://eth-mainnet.g.alchemy.com/v2/${key}`;

  const alchemy = new ethers.JsonRpcProvider(alchemyUrl, staticNet, { staticNetwork: staticNet });

  return new ethers.FallbackProvider([
    { provider: primary, priority: 1, weight: 1, stallTimeout: 2000 },
    { provider: alchemy,  priority: 2, weight: 1, stallTimeout: 4000 },
  ]);
}

// ── BSC default (used by bulk sender) ──────────────────────────────────────

export function getProvider(): ethers.AbstractProvider {
  return getChainProvider('bsc');
}

export function getSigner(): ethers.Wallet {
  return getChainSigner('bsc');
}

// ── Multi-chain EVM ─────────────────────────────────────────────────────────
// BOT_PRIVATE_KEY works on both BSC and Ethereum: same secp256k1 key → same address

export function getChainProvider(chain: 'bsc' | 'ethereum'): ethers.AbstractProvider {
  if (!global.__evmProviders) global.__evmProviders = new Map();
  if (!global.__evmProviders.has(chain)) {
    const p = buildProvider(chain);
    global.__evmProviders.set(chain, p);
    logger.info('EVM provider ready', {
      chain,
      alchemy: !!config.alchemy.apiKey,
      mode: config.alchemy.apiKey ? 'fallback(public+alchemy)' : 'public-only',
    });
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
  const fee = await getChainProvider(chain).getFeeData();
  const base = fee.gasPrice ?? ethers.parseUnits('5', 'gwei');
  return (base * 110n) / 100n;
}

// Call this after changing evmNetwork so providers rebuild with the new RPC.
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
